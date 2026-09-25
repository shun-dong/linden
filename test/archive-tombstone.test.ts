import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

test("destructive archive preserves subtree identities, File history, effects, and consumed Message receipts across reopen", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-audit-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:archive-audit";
	const child = "agent:archive-audit-child";
	const grandchild = "agent:archive-audit-grandchild";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		await manager.spawnWith(human, child, "archived child", [], async () => ({
			piSessionId: "pi-archive-audit-child",
			sessionFile: join(workspace, "archive-audit-child.jsonl"),
		}));
		await manager.spawnWith(child, grandchild, "archived grandchild", [], async () => ({
			piSessionId: "pi-archive-audit-grandchild",
			sessionFile: join(workspace, "archive-audit-grandchild.jsonl"),
		}));

		const initial = await manager.writeFile(human, "artifact.txt", "parent version");
		await manager.give(human, child, initial.resourceId);
		const changed = await manager.writeFile(child, "artifact.txt", "child version");
		const message = await manager.sendWithPayload(child, grandchild, async (id) => `entry:${id}`);
		await manager.receive(grandchild, child, message.id);

		assert.deepEqual(new Set(await manager.archiveParticipant(human, child, () => true)), new Set([child, grandchild]));
		assert.equal(manager.participant(child), undefined);
		assert.equal(manager.participant(grandchild), undefined);
		assert.equal(manager.ownerOf(initial.resourceId), human, "archive returns subtree-owned File authority to the parent");

		const persisted = JSON.parse(readFileSync(join(stateDir, "ledger.json"), "utf8")) as any;
		assert.deepEqual(new Set(persisted.runtimeMetadata.participantTombstones.map((entry: any) => entry.id)), new Set([child, grandchild]));
		assert.ok(persisted.runtimeMetadata.effects.some((effect: any) => effect.kind === "archive" && effect.targetId === child));
		assert.ok(persisted.runtimeMetadata.effects.some((effect: any) => effect.kind === "write" && effect.participantId === child && effect.stateId === changed.stateId));
		assert.ok(persisted.runtimeMetadata.messageReceipts.some((receipt: any) => receipt.id === message.id && receipt.senderId === child && receipt.targetId === grandchild));
		const fileEntry = persisted.Delta.find((entry: any) => entry.variable === initial.resourceId);
		assert.ok(fileEntry?.state?.versions.some((version: any) => version.id === changed.stateId && version.participantId === child));

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const state = reopened.snapshot();
		assert.equal(state.participants[child], undefined);
		assert.equal(state.participants[grandchild], undefined);
		assert.equal(state.participants[human].childIds.includes(child), false);
		assert.equal(state.participantTombstones[child]?.parentId, human);
		assert.deepEqual(state.participantTombstones[child]?.childIds, [grandchild]);
		assert.equal(state.participantTombstones[grandchild]?.parentId, child);
		const archiveEffect = state.effects.find((effect) => effect.kind === "archive" && effect.targetId === child);
		assert.ok(archiveEffect);
		assert.equal(state.participantTombstones[child]?.archiveEffectId, archiveEffect.id);
		assert.equal(state.participantTombstones[grandchild]?.archiveEffectId, archiveEffect.id);
		assert.equal(state.messages[message.id]?.consumedBy, grandchild);
		assert.ok(state.messages[message.id]?.consumedAt);
		const resource = reopened.resource(initial.resourceId);
		assert.ok(resource && resource.kind === "file");
		assert.ok(resource.versions.some((version) => version.id === changed.stateId && version.participantId === child));
		assert.equal(resource.ownerId, human);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("retired participant, Pi session, and session-file identities cannot be reused after reopen", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-identity-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:archive-identity";
	const child = "agent:retired-identity";
	const piSessionId = "pi-retired-identity";
	const sessionFile = join(workspace, "retired-identity.jsonl");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		await manager.spawnWith(human, child, "retired", [], async () => ({ piSessionId, sessionFile }));
		await manager.archiveParticipant(human, child, () => true);

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		await assert.rejects(
			reopened.spawnWith(human, child, "reused participant", [], async () => ({ piSessionId: "pi-new-for-retired-id" })),
			/PARTICIPANT_ID_RETIRED/,
		);
		await assert.rejects(
			reopened.spawnWith(human, "agent:reused-pi-session", "reused Pi session", [], async () => ({ piSessionId })),
			/already bound to agent:retired-identity/,
		);
		await assert.rejects(
			reopened.spawnWith(human, "agent:reused-session-file", "reused session file", [], async () => ({
				piSessionId: "pi-fresh-for-retired-file",
				sessionFile,
			})),
			/already bound to agent:retired-identity/,
		);
		assert.equal(reopened.participant("agent:reused-pi-session"), undefined);
		assert.equal(reopened.participant("agent:reused-session-file"), undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("tombstones are not resolvable participants and retain no live authority while ordinary pointers persist", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-authority-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:archive-authority";
	const child = "agent:retired-authority";
	const piSessionId = "pi-retired-authority";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		await manager.spawnWith(human, child, "retired authority", [], async () => ({ piSessionId }));
		await assert.rejects(
			manager.archiveParticipant(human, child, () => false),
			/PARTICIPANT_STATUS_MISMATCH/,
		);
		assert.ok(manager.participant(child), "a live-adapter preflight failure leaves the subtree intact");
		await manager.archiveParticipant(human, child, () => true);

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const state = reopened.snapshot();
		assert.ok(state.participantTombstones[child]);
		assert.equal(reopened.participant(child), undefined);
		assert.throws(() => reopened.resolveParticipantRef(child), /Unknown participant/);
		assert.throws(() => reopened.resolveParticipantRef(piSessionId), /Unknown participant/);
		assert.equal(state.contexts[child], undefined);
		for (const context of Object.values(state.contexts)) {
			assert.equal(context.delta.completeValues.some((value) => value.identity === child), false);
			assert.equal(context.gamma.roles.some((role) => role.targetId === child), false);
		}
		assert.equal(state.contexts[human].gamma.agentPointers.includes(child), true);
		assert.deepEqual(reopened.authoritySnapshot(child), { owned: [], pointers: [], children: [], parent: undefined });
		assert.deepEqual(reopened.effectiveAuthority(child), {
			readExpressions: [],
			writeExpressions: [],
			readPaths: [],
			writePaths: [],
			denyReadPaths: [],
			denyWritePaths: [],
			absentWriteFileExclusions: [],
			unsafeAbsentWriteExclusions: [],
			webDomains: [],
		});
		await assert.rejects(reopened.readFile(child, "retired.txt"), /UNKNOWN_PARTICIPANT/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("archive preserves an already-sent outbound Message until its live recipient consumes it", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-outbound-message-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:archive-outbound-message";
	const child = "agent:archive-outbound-sender";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		await manager.spawnWith(human, child, "sender", [], async () => ({ piSessionId: "archive-outbound-sender" }));
		const message = await manager.sendWithPayload(child, human, async (messageId) => `entry:${messageId}`);

		await manager.archiveParticipant(human, child, () => true);
		assert.equal(manager.participant(child), undefined);
		assert.equal(manager.participantTombstone(child)?.id, child);
		assert.deepEqual(manager.pendingMessages(human, child).map((pending) => pending.id), [message.id]);
		const persisted = JSON.parse(readFileSync(join(stateDir, "ledger.json"), "utf8")) as any;
		const archivedPointer = persisted.Gamma.find((entry: any) => entry.variable === `&${child}`);
		assert.ok(archivedPointer);
		assert.ok(archivedPointer.owners.includes(human));

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		assert.deepEqual(reopened.pendingMessages(human, child).map((pending) => pending.id), [message.id]);
		await reopened.receiveMessages(human, [message.id], child);
		assert.deepEqual(reopened.pendingMessages(human, child), []);
		assert.equal(reopened.snapshot().messages[message.id]?.consumedBy, human);

		const reopenedAgain = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		assert.equal(reopenedAgain.snapshot().messages[message.id]?.senderId, child);
		assert.equal(reopenedAgain.snapshot().messages[message.id]?.consumedBy, human);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
