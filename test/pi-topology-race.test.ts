import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCoordinator, TermParticipantRuntime, type ParticipantRuntime } from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

function fakeRuntime(participantId: string, options: { running?: boolean; onAbort?: () => void; onDispose?: () => void } = {}): ParticipantRuntime {
	let running = options.running ?? false;
	return {
		participantId,
		entries: () => [],
		leafId: () => null,
		isRunning: () => running,
		async abort() { running = false; options.onAbort?.(); },
		async appendEntry() { return "entry:fake"; },
		setLabel() {},
		readPayload: () => undefined,
		async deliverBatch() {},
		summary: () => participantId,
		async dispose() { options.onDispose?.(); },
	};
}

function fakeTermRuntime(participantId: string, options: { lifecycle?: "running" | "ready" | "stopped"; onInput?: (data: string) => void; onDispose?: () => void } = {}): TermParticipantRuntime {
	let lifecycle = options.lifecycle ?? "stopped";
	const term = {
		lifecycle: () => ({ lifecycle, backgroundPids: [] }),
		assertInputReady() { if (lifecycle !== "running") throw new Error("Term input requires running state"); },
		async waitForInputReady() { if (lifecycle !== "running") throw new Error("Term input requires running state"); },
		async interrupt() { lifecycle = "ready"; },
		async stopAll() { lifecycle = "stopped"; },
		input(data: string) { options.onInput?.(data); },
		async dispose() { lifecycle = "stopped"; options.onDispose?.(); },
	} as any;
	return new TermParticipantRuntime(participantId, term, participantId);
}

test("Agent cwd inheritance and Fixed Agent policy retain generic Term spawn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-agent-cwd-fixed-"));
	const taskCwd = join(workspace, "task");
	let coordinator: PiCoordinator | undefined;
	try {
		mkdirSync(taskCwd);
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		const observedCwds: string[] = [];
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			observedCwds.push(sessionManager.getCwd());
			return {
				session: {
					sessionId: sessionManager.getSessionId(),
					sessionFile: sessionManager.getSessionFile(),
					sessionManager,
					sessionName: "cwd test",
					isStreaming: false,
					subscribe() { return () => undefined; },
				},
				async dispose() {},
			} as any;
		});

		const initial = await coordinator.spawn(manager.rootParticipantId, "initial", undefined, [], false, taskCwd);
		await coordinator.spawn(initial, "nested", undefined, [], false);
		assert.deepEqual(observedCwds, [taskCwd, taskCwd], "a nested Agent inherits the parent Pi cwd when no override is supplied");

		coordinator.setAgentSpawnEnabled(initial, false);
		await assert.rejects(
			coordinator.spawn(initial, "blocked", undefined, [], false),
			/AGENT_SPAWN_DISABLED.*may still spawn Term participants/,
		);
		await assert.rejects(
			coordinator.spawnParticipant(initial, { kind: "agent", name: "blocked generic", cwd: taskCwd }),
			/AGENT_SPAWN_DISABLED/,
		);

		const internals = coordinator as any;
		internals.createTermRuntime = async (participantId: string) => fakeTermRuntime(participantId);
		const term = await coordinator.spawnParticipant(initial, { kind: "term", name: "allowed term", cwd: taskCwd });
		assert.equal(manager.participant(term)?.kind, "term", "Fixed freezes Agent topology without disabling asynchronous Term creation");
	} finally {
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Agent spawn disposes a prepared adapter when archive removes the committed child before publish", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-agent-publish-race-"));
	let coordinator: PiCoordinator | undefined;
	const publishEntered = deferred();
	const releasePublish = deferred();
	let childId: string | undefined;
	let disposeCalls = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => ({
			session: {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "publish race",
				isStreaming: false,
				subscribe() { return () => undefined; },
			},
			async dispose() { disposeCalls += 1; },
		} as any));
		const internals = coordinator as any;
		const publish = internals.publishPreparedRuntime.bind(coordinator);
		internals.publishPreparedRuntime = async (...args: any[]) => {
			childId = args[0];
			publishEntered.resolve();
			await releasePublish.promise;
			return publish(...args);
		};

		const spawning = coordinator.spawn(human, "publish race", undefined, [], false, workspace);
		await publishEntered.promise;
		assert.ok(childId && manager.participant(childId), "authority commits before coordinator publication");
		await manager.archiveParticipant(human, childId!, () => true);
		releasePublish.resolve();
		await assert.rejects(spawning, /removed before its runtime could be published/);
		assert.equal(coordinator.runtimes.has(childId!), false);
		assert.equal(disposeCalls, 1);
	} finally {
		releasePublish.resolve();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term spawn does not publish a ghost adapter after the committed child is archived", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-publish-race-"));
	let coordinator: PiCoordinator | undefined;
	const publishEntered = deferred();
	const releasePublish = deferred();
	let childId: string | undefined;
	let disposeCalls = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		const internals = coordinator as any;
		internals.createTermRuntime = async (id: string) => fakeTermRuntime(id, { onDispose: () => { disposeCalls += 1; } });
		const publish = internals.publishPreparedRuntime.bind(coordinator);
		internals.publishPreparedRuntime = async (...args: any[]) => {
			childId = args[0];
			publishEntered.resolve();
			await releasePublish.promise;
			return publish(...args);
		};

		const spawning = coordinator.spawnParticipant(human, { kind: "term", name: "publish race", cwd: workspace });
		await publishEntered.promise;
		assert.ok(childId && manager.participant(childId));
		await manager.archiveParticipant(human, childId!, () => true);
		releasePublish.resolve();
		await assert.rejects(spawning, /removed before its runtime could be published/);
		assert.equal(coordinator.runtimes.has(childId!), false);
		assert.equal(disposeCalls, 1);
	} finally {
		releasePublish.resolve();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("restore rechecks liveness before publishing a prepared Pi adapter", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-restore-publish-race-"));
	let coordinator: PiCoordinator | undefined;
	const publishEntered = deferred();
	const releasePublish = deferred();
	let disposeCalls = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		const internals = coordinator as any;
		const persisted = internals.createPersistedSessionManager(join(manager.stateDir, "pi-sessions"), undefined);
		const child = `agent:${persisted.getSessionId()}`;
		await manager.spawnWith(human, child, "restore race", [], async () => ({
			piSessionId: persisted.getSessionId(),
			sessionFile: persisted.getSessionFile(),
		}), { inheritWorkspaceRead: false });
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => ({
			session: {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "restore race",
				isStreaming: false,
				subscribe() { return () => undefined; },
			},
			async dispose() { disposeCalls += 1; },
		} as any));
		const publish = internals.publishPreparedRuntime.bind(coordinator);
		internals.publishPreparedRuntime = async (...args: any[]) => {
			publishEntered.resolve();
			await releasePublish.promise;
			return publish(...args);
		};

		const restoring = coordinator.restoreParticipant(child);
		await publishEntered.promise;
		await manager.archiveParticipant(human, child, () => true);
		releasePublish.resolve();
		await assert.rejects(restoring, /removed before its runtime could be published/);
		assert.equal(coordinator.runtimes.has(child), false);
		assert.equal(disposeCalls, 1);
	} finally {
		releasePublish.resolve();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("lazy Term creation is single-flight and cannot publish after archive", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-single-flight-race-"));
	let coordinator: PiCoordinator | undefined;
	const factoryEntered = deferred();
	const releaseFactory = deferred();
	let factoryCalls = 0;
	let disposeCalls = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const term = "term:lazy-single-flight";
		await manager.spawnWith(human, term, "lazy", [], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
		coordinator = PiCoordinator.createStandalone(manager);
		const internals = coordinator as any;
		internals.createTermRuntime = async (id: string) => {
			factoryCalls += 1;
			factoryEntered.resolve();
			await releaseFactory.promise;
			return fakeTermRuntime(id, { onDispose: () => { disposeCalls += 1; } });
		};

		const first = internals.ensureTermRuntime(term) as Promise<TermParticipantRuntime>;
		const second = internals.ensureTermRuntime(term) as Promise<TermParticipantRuntime>;
		await factoryEntered.promise;
		assert.equal(factoryCalls, 1);
		await manager.archiveParticipant(human, term, () => true);
		releaseFactory.resolve();
		const results = await Promise.allSettled([first, second]);
		assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
		for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /removed before its runtime could be published/);
		assert.equal(coordinator.runtimes.has(term), false);
		assert.equal(disposeCalls, 1);
	} finally {
		releaseFactory.resolve();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("archive cleans every adapter in the manager-returned removed set", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-returned-set-"));
	let coordinator: PiCoordinator | undefined;
	let parentDisposals = 0;
	let lateDisposals = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = "agent:archive-returned-parent";
		const late = "agent:archive-returned-late-child";
		await manager.spawnWith(human, parent, "parent", [], async () => ({ piSessionId: "archive-returned-parent" }), { inheritWorkspaceRead: false });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.runtimes.set(parent, fakeRuntime(parent, { onDispose: () => { parentDisposals += 1; } }));
		const archiveParticipant = manager.archiveParticipant.bind(manager);
		(manager as any).archiveParticipant = async (caller: string, target: string, runtimeCheck: (ids: readonly string[]) => boolean) => {
			await manager.spawnWith(parent, late, "late", [], async () => ({ piSessionId: "archive-returned-late" }), { inheritWorkspaceRead: false });
			coordinator!.runtimes.set(late, fakeRuntime(late, { onDispose: () => { lateDisposals += 1; } }));
			return archiveParticipant(caller, target, runtimeCheck);
		};

		await coordinator.archive(human, parent);
		assert.equal(manager.participant(parent), undefined);
		assert.equal(manager.participant(late), undefined);
		assert.equal(coordinator.runtimes.has(parent), false);
		assert.equal(coordinator.runtimes.has(late), false);
		assert.equal(parentDisposals, 1);
		assert.equal(lateDisposals, 1);
	} finally {
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("recursive stop rescans after an active tool spawns a new descendant", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-stop-fixed-point-"));
	let coordinator: PiCoordinator | undefined;
	let parentAborts = 0;
	let childAborts = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = "agent:stop-fixed-point-parent";
		const child = "agent:stop-fixed-point-child";
		await manager.spawnWith(human, parent, "parent", [], async () => ({ piSessionId: "stop-fixed-point-parent" }), { inheritWorkspaceRead: false });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.runtimes.set(parent, fakeRuntime(parent, { onAbort: () => { parentAborts += 1; } }));
		coordinator.beginTool(parent);
		const stopping = coordinator.stop(human, parent);
		await until(() => (coordinator as any).stopRequests.has(parent));

		await manager.spawnWith(parent, child, "spawned by current tool", [], async () => ({ piSessionId: "stop-fixed-point-child" }), { inheritWorkspaceRead: false });
		await manager.setParticipantStatus(child, "running");
		coordinator.runtimes.set(child, fakeRuntime(child, { running: true, onAbort: () => { childAborts += 1; } }));
		coordinator.endTool(parent);
		await stopping;

		assert.equal(parentAborts, 1);
		assert.equal(childAborts, 1, "the post-request descendant is included by the fixed-point rescan");
		assert.equal(manager.participant(parent)?.status, "stopped");
		assert.equal(manager.participant(child)?.status, "stopped");
		const stoppedTargets = manager.snapshot().effects.filter((effect) => effect.kind === "stop").map((effect) => effect.targetId);
		assert.ok(stoppedTargets.includes(parent));
		assert.ok(stoppedTargets.includes(child));
	} finally {
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("termInput serializes physical stdin and its ledger effect against archive", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-input-topology-"));
	let coordinator: PiCoordinator | undefined;
	const commitEntered = deferred();
	const releaseCommit = deferred();
	const inputs: string[] = [];
	let archiveEntered = false;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const term = "term:input-topology";
		await manager.spawnWith(human, term, "input", [], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
		await manager.setParticipantStatus(term, "running");
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.runtimes.set(term, fakeTermRuntime(term, { lifecycle: "running", onInput: (data) => inputs.push(data) }));
		const commitInputWith = manager.commitInputWith.bind(manager);
		(manager as any).commitInputWith = async (...args: any[]) => {
			commitEntered.resolve();
			await releaseCommit.promise;
			return commitInputWith(args[0], args[1], args[2], args[3]);
		};
		const archiveParticipant = manager.archiveParticipant.bind(manager);
		(manager as any).archiveParticipant = async (...args: any[]) => {
			archiveEntered = true;
			return archiveParticipant(args[0], args[1], args[2]);
		};

		const input = coordinator.termInput(human, term, "answer\n");
		await commitEntered.promise;
		assert.deepEqual(inputs, [], "the PTY write occurs inside the manager commit boundary");
		const archiving = coordinator.archive(human, term);
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(archiveEntered, false, "archive waits while stdin and its effect are in one topology transition");
		releaseCommit.resolve();
		await input;
		assert.deepEqual(inputs, ["answer\n"]);
		assert.ok(manager.snapshot().effects.some((effect) => effect.kind === "input" && effect.targetId === term));
		await assert.rejects(archiving, /stopped|PARTICIPANT_STATUS_MISMATCH/);
		assert.equal(archiveEntered, true);
		assert.ok(manager.participant(term));
	} finally {
		releaseCommit.resolve();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});
