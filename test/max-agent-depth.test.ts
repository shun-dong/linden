import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

async function spawn(manager: SessionAuthorityManager, parentId: string, childId: string, onCreate?: () => void): Promise<void> {
	await manager.spawnWith(parentId, childId, childId, [], async () => {
		onCreate?.();
		return { piSessionId: childId.slice("agent:".length) };
	}, { inheritWorkspaceRead: false });
}

test("maxAgentDepth rejects an over-depth spawn before runtime creation or ledger mutation", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-max-depth-"));
	try {
		const stateDir = join(workspace, ".state");
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, maxAgentDepth: 2 });
		const human = manager.rootParticipantId;
		await spawn(manager, human, "agent:depth-one");
		await spawn(manager, "agent:depth-one", "agent:depth-two");
		assert.equal(manager.participantDepth(human), 0);
		assert.equal(manager.participantDepth("agent:depth-one"), 1);
		assert.equal(manager.participantDepth("agent:depth-two"), 2);
		const before = manager.snapshot();
		let runtimeCreations = 0;
		await assert.rejects(spawn(manager, "agent:depth-two", "agent:depth-three", () => { runtimeCreations++; }), /MAX_AGENT_DEPTH_EXCEEDED.*depth 3.*maxAgentDepth 2/);
		assert.equal(runtimeCreations, 0);
		assert.deepEqual(manager.snapshot(), before);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("maxAgentDepth counts only Agents and still permits Term children at the Agent limit", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-max-depth-term-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".state"), maxAgentDepth: 1 });
		const human = manager.rootParticipantId;
		await spawn(manager, human, "agent:at-limit");
		await assert.rejects(spawn(manager, "agent:at-limit", "agent:over-limit"), /MAX_AGENT_DEPTH_EXCEEDED/);
		await manager.spawnWith("agent:at-limit", "term:still-available", "still available", [], async () => ({}), {
			participantKind: "term",
			inheritWorkspaceRead: false,
		});
		assert.equal(manager.participant("term:still-available")?.kind, "term");
		assert.equal(manager.agentDepth("term:still-available"), 1);
		assert.equal(manager.participantDepth("term:still-available"), 2);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("maxAgentDepth defaults to unlimited and is immutable when a ledger is reopened", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-max-depth-persist-"));
	try {
		const limitedState = join(workspace, ".limited-state");
		const limitedSession = "session:11111111-2222-3333-4444-555555555555";
		const limited = await SessionAuthorityManager.open({ workspace, stateDir: limitedState, lindenSessionId: limitedSession, maxAgentDepth: 2 });
		assert.equal(limited.maxAgentDepth, 2);
		const reopened = await SessionAuthorityManager.open({ workspace, stateDir: limitedState, lindenSessionId: limitedSession });
		assert.equal(reopened.maxAgentDepth, 2);
		await assert.rejects(SessionAuthorityManager.open({ workspace, stateDir: limitedState, lindenSessionId: limitedSession, maxAgentDepth: 3 }), /maxAgentDepth is 2, not 3/);

		const unlimited = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".unlimited-state"), lindenSessionId: "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
		let parent = unlimited.rootParticipantId;
		for (let depth = 1; depth <= 4; depth++) {
			const child = `agent:unlimited-${depth}`;
			await spawn(unlimited, parent, child);
			parent = child;
		}
		assert.equal(unlimited.maxAgentDepth, undefined);
		assert.equal(unlimited.participantDepth(parent), 4);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
