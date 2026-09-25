import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/authority/manager.js";
import { StandalonePiHost } from "../src/pi/host.js";

test("typed Agent checkpoints are scoped and rewind never restores transferred ownership", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-rewind-"));
	const stateDir = join(workspace, ".linden-test");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "rewind", stateDir });
		const parent = manager.sessionParticipantId;
		await manager.give(manager.rootParticipantId, parent, manager.baseResourceId());
		const file = await manager.writeFile(parent, "state.txt", "v1");
		const child = "agent:rewind-child";
		await manager.spawnWith(parent, child, "child", [{ resourceId: file.resourceId, mode: "read" }], async () => ({ piSessionId: "rewind-child" }));
		const envelope = manager.checkpointEnvelope(child);
		const node = await manager.recordCheckpoint(envelope, "pi-entry-before-transfer");
		const laterEnvelope = manager.checkpointEnvelope(child);
		const later = await manager.recordCheckpoint(laterEnvelope, "pi-entry-after-raw", "pi-entry-not-typed", node.id);
		assert.equal(later.parentId, node.id);
		await manager.give(parent, child, file.resourceId);
		const web = manager.materializeWeb(manager.rootParticipantId, "web:api.example.com/");
		await manager.give(manager.rootParticipantId, parent, web);
		await manager.give(parent, child, web);
		const grandchild = "agent:rewind-grandchild";
		await manager.spawnWith(child, grandchild, "grandchild", [{ resourceId: web, mode: "read" }], async () => ({ piSessionId: "rewind-grandchild" }));
		await manager.bash(manager.rootParticipantId, "true", { timeout: 5 });
		manager.requireRewind(parent, child, node.id);
		const beforeRewind = manager.snapshot();
		const rewindEffect = await manager.commitRewind(parent, child, node.id);
		const rewound = manager.snapshot();
		assert.equal(rewound.currentAgentStateIds[child], node.id);
		assert.equal(rewound.contexts[child].delta.completeValues.find((value) => value.identity === child)?.stateId, node.id);
		const notice = manager.rewindNotice(child, node.id, rewindEffect.sequence);
		assert.match(notice, /Effects not reverted:/);
		assert.match(notice, /give:/);
		assert.match(notice, /get:/);
		assert.match(notice, /spawn:/);
		assert.match(notice, /target=agent:rewind-grandchild/);
		assert.match(notice, /current Web authority=web:api\.example\.com\//);
		assert.match(notice, /Web\/network authority transfer remains committed/);
		assert.match(notice, /possible network side effects may remain/);
		assert.match(notice, /cannot observe exact remote mutations/);
		for (const effect of beforeRewind.effects.filter((candidate) => candidate.sequence > envelope.ledgerSequence)) {
			assert.ok(notice.includes(effect.id), `rewind notice omitted intermediate effect ${effect.id}`);
		}
		assert.ok(!notice.includes(rewindEffect.id), "the rewind operation itself is the exclusive upper boundary, not an unreverted intermediate effect");
		assert.equal(manager.resource(file.resourceId)?.ownerId, child);
		await assert.rejects(manager.writeFile(parent, "state.txt", "resurrected"), /UNAUTHORIZED_WRITE/);

		const reopened = await SessionAuthorityManager.open({ workspace, sessionId: "rewind", lindenSessionId: manager.sessionId, stateDir });
		assert.equal(reopened.snapshot().currentAgentStateIds[child], node.id);
		assert.equal(reopened.requireRewind(parent, child, node.id).checkpointId, node.checkpointId);
		assert.equal(reopened.resource(file.resourceId)?.ownerId, child);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a fresh StandalonePiHost grants file:./ to a real top-level Pi runtime", async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-host-base-grant-"));
	const base = join(container, "task");
	const stateRoot = join(container, "state");
	const piAgentDir = join(container, "pi-agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let host: StandalonePiHost | undefined;
	try {
		mkdirSync(base);
		mkdirSync(piAgentDir);
		writeFileSync(join(base, "seed.txt"), "seed");
		process.env.PI_CODING_AGENT_DIR = piAgentDir;
		host = await StandalonePiHost.open({ base, stateRoot });

		// Deliberately do not pre-materialize baseResourceId(): this is the cold
		// public path that previously attempted subpath(base, base).
		const child = await host.spawnTopLevel({ name: "worker", grants: ["file:./"], inheritWorkspaceRead: true, cwd: base });
		const baseResource = host.authority.baseResourceId();
		const participant = host.authority.participant(child);
		const session = host.coordinator.hostedRuntime(child).runtimeHost.session;
		assert.equal(participant?.parentId, host.authority.rootParticipantId);
		assert.equal(participant?.piSessionId, session.sessionId);
		assert.ok(session.sessionFile && existsSync(session.sessionFile));
		assert.equal(host.authority.resource(baseResource)?.ownerId, child);
		assert.ok(host.authority.authoritySnapshot(child).owned.includes(baseResource));
		assert.ok(host.authority.effectiveAuthority(child).writePaths.includes(base));
		assert.ok(!host.authority.authoritySnapshot(host.authority.rootParticipantId).owned.includes(baseResource));

		await assert.rejects(host.authority.writeFile(host.authority.rootParticipantId, "human-denied.txt", "no"), /UNAUTHORIZED_WRITE/);
		assert.equal(existsSync(join(base, "human-denied.txt")), false);
		const write = session.getToolDefinition("write");
		assert.ok(write);
		await write.execute("integration-write", { path: "agent.txt", content: "owned" }, undefined, undefined, undefined as never);
		assert.equal(readFileSync(join(base, "agent.txt"), "utf8"), "owned");
		assert.ok(host.authority.snapshot().currentAgentStateIds[child]);
	} finally {
		await host?.dispose();
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(container, { recursive: true, force: true });
	}
});
