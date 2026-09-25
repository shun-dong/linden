import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCoordinator, TermParticipantRuntime, type ParticipantRuntime } from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import type { ParticipantId } from "../src/runtime/model.js";
import type { TermSnapshot } from "../src/runtime/term.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

function fakeAgentRuntime(participantId: ParticipantId, options: { running?: () => boolean; checkpointGate?: ReturnType<typeof deferred> } = {}): ParticipantRuntime {
	return {
		participantId,
		entries: () => [],
		leafId: () => null,
		isRunning: () => options.running?.() ?? false,
		abort: async () => undefined,
		appendEntry: async () => {
			if (options.checkpointGate) await options.checkpointGate.promise;
			return `checkpoint:${participantId}`;
		},
		setLabel: () => undefined,
		readPayload: () => undefined,
		deliverBatch: async () => undefined,
		summary: () => participantId,
	};
}

async function spawnAgent(manager: SessionAuthorityManager, parentId: ParticipantId, sessionId: string): Promise<ParticipantId> {
	const id = `agent:${sessionId}`;
	await manager.spawnWith(parentId, id, sessionId, [], async () => ({ piSessionId: sessionId }));
	return id;
}

test("agent_end remains ready during final checkpoint work, then respects descendant activity", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-agent-end-lifecycle-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);

		const loneAgent = await spawnAgent(manager, human, "tail-lone");
		const loneCheckpoint = deferred();
		coordinator.runtimes.set(loneAgent, fakeAgentRuntime(loneAgent, { checkpointGate: loneCheckpoint }));
		const loneEnd = coordinator.handleAgentEnd(loneAgent);
		while (manager.participant(loneAgent)?.status !== "ready") await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(manager.participant(loneAgent)?.status, "ready", "checkpoint tail work is still participant work");
		loneCheckpoint.resolve();
		await loneEnd;
		assert.equal(manager.participant(loneAgent)?.status, "stopped", "an idle Agent with no active descendants becomes stopped");

		const parent = await spawnAgent(manager, human, "tail-parent");
		const child = await spawnAgent(manager, parent, "tail-child");
		let childRunning = true;
		const parentCheckpoint = deferred();
		coordinator.runtimes.set(parent, fakeAgentRuntime(parent, { checkpointGate: parentCheckpoint }));
		coordinator.runtimes.set(child, fakeAgentRuntime(child, { running: () => childRunning }));
		const parentEnd = coordinator.handleAgentEnd(parent);
		while (manager.participant(parent)?.status !== "ready") await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		parentCheckpoint.resolve();
		await parentEnd;
		assert.equal(manager.participant(child)?.status, "running");
		assert.equal(manager.participant(parent)?.status, "ready", "an idle ancestor remains ready while a descendant runs");
		childRunning = false;
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term wait propagates a supervisor failure", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-wait-failure-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const term = "term:failed-wait";
		await manager.spawnWith(human, term, "failed-wait", [], async () => ({}), { participantKind: "term" });
		coordinator = PiCoordinator.createStandalone(manager);
		const snapshot: TermSnapshot = {
			id: term,
			lifecycle: "stopped",
			ready: true,
			reconciling: false,
			backgroundPids: [],
			outputCursor: 0,
			error: "terminal supervisor lost",
		};
		const fakeTerm = {
			lifecycle: () => snapshot,
			waitFor: async () => { throw new Error(snapshot.error); },
			dispose: async () => undefined,
		};
		coordinator.runtimes.set(term, new TermParticipantRuntime(term, fakeTerm as any, "failed-wait"));

		const beforeWaitEffects = manager.snapshot().effects.filter((effect) => effect.kind === "wait").length;
		await assert.rejects(coordinator.waitParticipant(human, term, "stopped"), /terminal supervisor lost/);
		assert.equal(
			manager.snapshot().effects.filter((effect) => effect.kind === "wait").length,
			beforeWaitEffects,
			"a failed wait must not be recorded as a successful observation",
		);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
