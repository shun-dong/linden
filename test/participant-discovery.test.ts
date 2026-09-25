import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { PiCoordinator } from "../src/pi/runtime.js";
import { buildTools } from "../src/pi/tools.js";

async function fixture() {
	const workspace = mkdtempSync(join(tmpdir(), "linden-discovery-"));
	const options = { workspace, lindenSessionId: "session:discovery", sessionId: "discovery", stateDir: join(workspace, ".state") };
	const manager = await SessionAuthorityManager.open(options);
	const a = manager.sessionParticipantId;
	const b = "agent:peer";
	await manager.spawnWith(manager.rootParticipantId, b, "peer", [], async () => ({ piSessionId: "peer" }), { inheritWorkspaceRead: false });
	return { workspace, options, manager, a, b };
}

test("discovery enables durable sibling messaging without file or control authority", async () => {
	const { workspace, options, manager, a, b } = await fixture();
	try {
		assert.throws(() => manager.requireSend(a, b), /ROLE_FORGERY.*call participants/);
		manager.listParticipants();
		assert.throws(() => manager.requireSend(a, b), /ROLE_FORGERY/, "internal read-only inspection is not discovery");
		const before = manager.snapshot();
		const discovered = await manager.discoverParticipants(a);
		assert.deepEqual(new Set(discovered.contexts[a].gamma.agentPointers), new Set(Object.keys(discovered.participants)));
		assert.deepEqual(discovered.contexts[a].gamma.roles, before.contexts[a].gamma.roles);
		assert.deepEqual(discovered.contexts[a].gamma.resourcePointers, before.contexts[a].gamma.resourcePointers);
		assert.deepEqual(discovered.contexts[a].delta, before.contexts[a].delta);
		assert.deepEqual(discovered.contexts[b], before.contexts[b], "discovery is caller-scoped");
		assert.equal(discovered.effects.at(-1)?.kind, "participants");
		for (const check of ["requireListen", "requireSteer", "requireStop", "requireInterrupt", "requireGiveParticipant"] as const) {
			assert.throws(() => manager[check](a, b), /ROLE_MISMATCH/);
		}
		await assert.rejects(manager.writeFile(a, "forbidden.txt", "no"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(manager.readFile(b, "unreadable.txt"), /UNAUTHORIZED_READ/);
		const message = await manager.sendWithPayload(a, b, async () => "pi:payload");
		assert.equal(manager.pendingMessages(b)[0]?.id, message.id);
		assert.throws(() => manager.pendingMessages(b, a), /ROLE_FORGERY/);
		await manager.discoverParticipants(b);
		assert.equal(manager.pendingMessages(b, a)[0]?.id, message.id);
		await manager.sendWithPayload(b, a, async () => "pi:reply");
		const sequence = manager.snapshot().sequence;
		await manager.discoverParticipants(a);
		assert.equal(manager.snapshot().sequence, sequence, "unchanged discovery does not duplicate effects");
		const reopened = await SessionAuthorityManager.open(options);
		assert.doesNotThrow(() => reopened.requireSend(a, b));
		assert.doesNotThrow(() => reopened.requireSend(b, a));
		assert.throws(() => reopened.requireSend(a, "agent:invented"), /UNKNOWN_PARTICIPANT.*call participants/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("failed discovery persistence leaves no pointers or effects; later nodes require rediscovery", async () => {
	const { workspace, manager, a, b } = await fixture();
	try {
		const before = manager.snapshot();
		const save = manager.store.save;
		manager.store.save = () => { throw new Error("injected discovery save failure"); };
		await assert.rejects(manager.discoverParticipants(a), /injected discovery/);
		manager.store.save = save;
		assert.deepEqual(manager.snapshot(), before);
		assert.throws(() => manager.requireSend(a, b), /ROLE_FORGERY/);
		await manager.discoverParticipants(a);
		const late = "agent:late";
		await manager.spawnWith(b, late, "late", [], async () => ({ piSessionId: "late" }), { inheritWorkspaceRead: false });
		assert.throws(() => manager.requireSend(a, late), /call participants/);
		await Promise.all([manager.discoverParticipants(a), manager.discoverParticipants(a)]);
		assert.doesNotThrow(() => manager.requireSend(a, late));
		assert.throws(() => manager.requireListen(a, late), /ROLE_MISMATCH/);
		await manager.archiveParticipant(manager.rootParticipantId, b, () => true);
		const tree = await manager.discoverParticipants(a);
		assert.equal(tree.participants[b], undefined);
		assert.equal(tree.participants[late], undefined);
		assert.throws(() => manager.requireSend(a, b), /UNKNOWN_PARTICIPANT.*call participants/);
		await assert.rejects(manager.discoverParticipants("agent:invented"), /UNKNOWN_PARTICIPANT/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("birth snapshot and participants tool acquire pointers before exposing the tree", async () => {
	const { workspace, manager, a, b } = await fixture();
	const coordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
	try {
		assert.match(coordinator.formatParticipantTree(a), /agent:peer/);
		assert.throws(() => manager.requireSend(a, b), /ROLE_FORGERY/);
		const birth = await coordinator.formatParticipantTreeBirthSnapshot(a);
		assert.match(birth, /agent:peer/);
		assert.match(birth, /ordinary read-only participant pointers/);
		assert.doesNotThrow(() => manager.requireSend(a, b));
		const late = "agent:late";
		await manager.spawnWith(b, late, "late", [], async () => ({ piSessionId: "late" }));
		await assert.rejects(coordinator.send(a, late, "not yet"), /call participants/);
		const participants = buildTools(coordinator, a).find((tool) => tool.name === "participants")!;
		const output = await (participants.execute as any)("discover", {}, undefined, undefined, {});
		assert.match(JSON.stringify(output), /agent:late/);
		assert.doesNotThrow(() => manager.requireSend(a, late));
		await assert.rejects(coordinator.send(a, "invented", "no"), /call participants/);
	} finally {
		await coordinator.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("discovered peers exchange messages directly without a Human relay", async () => {
	const { workspace, manager, a, b } = await fixture();
	const coordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
	try {
		(coordinator as any).scheduleFollowUpFlush = () => undefined;
		for (const id of [a, b]) {
			const payloads = new Map<string, unknown>();
			coordinator.runtimes.set(id, {
				participantId: id,
				entries: () => [], leafId: () => null, isRunning: () => false,
				abort: async () => undefined, setLabel: () => undefined,
				appendEntry: async (_type: string, data: unknown) => {
					const entry = `pi:payload-${payloads.size}`;
					payloads.set(entry, data);
					return entry;
				},
				readPayload: (entry: string) => payloads.get(entry),
				deliverBatch: async () => undefined, summary: () => id,
			} as any);
			await coordinator.formatParticipantTreeBirthSnapshot(id);
		}
		const first = await coordinator.send(a, b, "What feature are you implementing?");
		assert.deepEqual(await coordinator.receive(b, a), [{ id: first, senderId: a, payload: "What feature are you implementing?" }]);
		const reply = await coordinator.send(b, a, "The other feature; preserve our combined changes.");
		assert.deepEqual(await coordinator.receive(a, b), [{ id: reply, senderId: b, payload: "The other feature; preserve our combined changes." }]);
		assert.equal(manager.pendingMessages(manager.rootParticipantId).length, 0);
		assert.equal(Object.values(manager.snapshot().messages).some((message) => message.targetId === manager.rootParticipantId), false);
	} finally {
		await coordinator.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
