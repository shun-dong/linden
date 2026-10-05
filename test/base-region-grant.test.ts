import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCoordinator } from "../src/pi/runtime.js";
import { assertWellFormedContexts } from "../src/compiler/judgment.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { fileResourceId } from "../src/runtime/paths.js";

test("a fresh root lookup returns the exact canonical base region without refinement", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-base-locator-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const baseId = fileResourceId(workspace, true);
		assert.equal(manager.resource(baseId)?.kind, "file-region", "initial authority is explicit");

		const located = manager.locateCoveringPath(manager.rootParticipantId, workspace, "read");
		assert.deepEqual(located, { parentResourceId: baseId, path: workspace, refined: false });
		assert.equal(manager.ownerOf(baseId), manager.rootParticipantId);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a fresh Pi spawn can move file:./ as the exact base grant", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-base-spawn-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const baseId = fileResourceId(workspace, true);
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "worker",
				isStreaming: false,
				subscribe() {},
				async abort() {},
				dispose() {},
			};
			return { session, async dispose() {} } as any;
		});
		assert.equal(manager.ownerOf(baseId), human, "spawn begins with an explicit base grant");

		const child = await coordinator.spawn(human, "worker", undefined, ["file:./"], true, workspace);
		assert.equal(manager.ownerOf(baseId), child);
		assert.ok(manager.effectiveAuthority(child).writeExpressions.some((expression) => expression.include === workspace));
		assert.throws(
			() => manager.locateCoveringPath(human, workspace, "write"),
			/No owned File region covers/,
			"the former owner cannot reacquire the transferred base by lazy materialization",
		);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("path lookup never falls back past a delegated most-specific region", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-covering-region-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const child = "agent:nested-owner";
		const nested = await manager.subpath(human, manager.baseResourceId(), "nested", "write");
		await manager.spawnWith(
			human,
			child,
			"nested owner",
			[],
			async () => ({ piSessionId: "nested-owner" }),
			{ inheritWorkspaceRead: false },
		);
		await manager.give(human, child, nested.resourceId);

		const deeper = join(workspace, "nested", "deeper");
		const beforeExistingLookup = manager.snapshot().sequence;
		await assert.rejects(manager.subpath(human, manager.baseResourceId(), "nested", "write"), /UNAUTHORIZED_WRITE/);
		const observed = await manager.subpath(human, manager.baseResourceId(), "nested", "read");
		assert.equal(observed.resourceId, nested.resourceId);
		assert.equal(manager.ownerOf(nested.resourceId), child);
		assert.equal(manager.snapshot().sequence, beforeExistingLookup, "existing identity lookup is a non-mutating authorization check");
		assert.throws(
			() => manager.locateCoveringPath(human, deeper, "write"),
			/No owned File region covers/,
			"a broader residual region must not authorize refinement inside a delegated region",
		);
		assert.deepEqual(
			manager.locateCoveringPath(child, deeper, "write"),
			{ parentResourceId: nested.resourceId, path: deeper, refined: true },
		);
		for (const mode of ["read", "write"] as const) {
			await assert.rejects(
				manager.subpath(human, manager.baseResourceId(), deeper, mode),
				/RESOURCE_REFINEMENT_PARENT_MISMATCH/,
				"direct refinement cannot bypass the most-specific delegated region",
			);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a delegated exact File remains a leaf across locator, refinement, and native writes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-exact-file-leaf-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const child = "agent:exact-file-owner";
		const base = manager.baseResourceId();
		await manager.spawnWith(
			human,
			child,
			"exact file owner",
			[],
			async () => ({ piSessionId: "exact-file-owner" }),
			{ inheritWorkspaceRead: false },
		);
		const exact = await manager.file(human, base, "reserved.txt", "write");
		assert.equal((await manager.statFile(human, "reserved.txt")).state, "Absent");
		await manager.give(human, child, exact.resourceId);

		const before = manager.snapshot();
		await assert.rejects(manager.file(human, base, "reserved.txt", "write"), /UNAUTHORIZED_WRITE/);
		const observed = await manager.file(human, base, "reserved.txt", "read");
		assert.equal(observed.resourceId, exact.resourceId);
		assert.equal(manager.ownerOf(exact.resourceId), child);
		assert.equal(manager.snapshot().sequence, before.sequence, "existing exact File lookup must not rebind or persist the identity");
		for (const mode of ["read", "write"] as const) {
			assert.throws(
				() => manager.locateCoveringPath(human, "reserved.txt", mode),
				/FILE_RESOURCE_KIND_MISMATCH/,
			);
			assert.throws(
				() => manager.locateCoveringPath(human, join("reserved.txt", "nested"), mode),
				/FILE_RESOURCE_BOUNDARY/,
			);
			await assert.rejects(manager.subpath(human, base, "reserved.txt", mode), /FILE_RESOURCE_KIND_MISMATCH/);
			await assert.rejects(manager.subpath(human, base, join("reserved.txt", "nested"), mode), /FILE_RESOURCE_BOUNDARY/);
		}
		await assert.rejects(manager.writeFile(human, join("reserved.txt", "nested.txt"), "former owner"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(manager.writeFile(child, join("reserved.txt", "nested.txt"), "exact owner"), /UNAUTHORIZED_WRITE/);

		const afterRejected = manager.snapshot();
		assert.equal(afterRejected.sequence, before.sequence);
		assert.deepEqual(Object.keys(afterRejected.resources).sort(), Object.keys(before.resources).sort());
		assert.equal(manager.ownerOf(exact.resourceId), child);
		assert.equal(existsSync(join(workspace, "reserved.txt")), false);

		const sibling = await manager.subpath(human, base, "allowed-sibling", "write");
		assert.equal(manager.ownerOf(sibling.resourceId), human);
		const written = await manager.writeFile(child, "reserved.txt", "child-owned");
		assert.equal(written.resourceId, exact.resourceId);
		assert.equal(readFileSync(join(workspace, "reserved.txt"), "utf8"), "child-owned");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("an exact File cannot be materialized above an existing descendant resource", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-file-leaf-ancestor-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const base = manager.baseResourceId();
		const descendant = await manager.file(human, base, join("container", "child.txt"), "write");
		const before = manager.snapshot();
		const invalid = structuredClone(before);
		const conflictingPath = join(workspace, "container", "child.txt", "nested");
		const conflictingId = fileResourceId(conflictingPath, true);
		invalid.resources[conflictingId] = { id: conflictingId, kind: "file-region", path: conflictingPath, createdAt: Date.now() };
		assert.throws(() => assertWellFormedContexts(invalid), /INVALID_RESOURCE_TREE/);

		await assert.rejects(manager.file(human, base, "container", "write"), /FILE_RESOURCE_BOUNDARY/);

		const after = manager.snapshot();
		assert.equal(after.sequence, before.sequence);
		assert.deepEqual(Object.keys(after.resources).sort(), Object.keys(before.resources).sort());
		assert.equal(manager.ownerOf(descendant.resourceId), human);
		assert.equal(existsSync(join(workspace, "container")), false);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("default read inheritance can refine inside a delegated region without taking write authority", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-spawn-read-refinement-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const owner = "agent:delegated-region-owner";
		const reader = "agent:delegated-region-reader";
		const base = manager.baseResourceId();
		const delegated = await manager.subpath(human, base, "delegated", "write");
		await manager.spawnWith(human, owner, "region owner", [], async () => ({ piSessionId: "delegated-region-owner" }), { inheritWorkspaceRead: false });
		await manager.give(human, owner, delegated.resourceId);

		const readRoot = join(workspace, "delegated", "docs");
		await manager.spawnWith(
			human,
			reader,
			"region reader",
			[],
			async () => ({ piSessionId: "delegated-region-reader" }),
			{ inheritWorkspaceRead: true, defaultReadRoot: readRoot },
		);

		const readRootId = fileResourceId(readRoot, true);
		assert.equal(manager.ownerOf(readRootId), owner, "read refinement remains owned by the delegated parent-region owner");
		assert.ok(manager.authoritySnapshot(reader).pointers.includes(readRootId));
		assert.equal((await manager.statFile(reader, join(readRoot, "future.txt"))).state, "Absent");
		await assert.rejects(manager.writeFile(reader, join(readRoot, "future.txt"), "no"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(manager.writeFile(human, join(readRoot, "future.txt"), "no"), /UNAUTHORIZED_WRITE/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a failed runtime creation leaves staged spawn refinements out of memory and durable state", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-spawn-staging-"));
	const stateDir = join(workspace, ".linden-test");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir });
		const human = manager.rootParticipantId;
		const child = "agent:failed-staged-spawn";
		const stagedRoot = join(workspace, "staged-read-root");
		const stagedRootId = fileResourceId(stagedRoot, true);
		const before = manager.snapshot();

		await assert.rejects(
			manager.spawnWith(
				human,
				child,
				"failed staged spawn",
				[],
				async () => { throw new Error("runtime creation failed"); },
				{ inheritWorkspaceRead: true, defaultReadRoot: stagedRoot },
			),
			/runtime creation failed/,
		);

		assert.deepEqual(manager.snapshot(), before);
		assert.equal(manager.resource(stagedRootId), undefined);
		assert.equal(manager.participant(child), undefined);
		manager.baseResourceId();
		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId: manager.sessionId });
		assert.equal(reopened.resource(stagedRootId), undefined);
		assert.equal(reopened.participant(child), undefined);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a failed Pi spawn disposes its uncommitted host without registering a ghost runtime", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-spawn-rollback-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const before = manager.snapshot();
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		let attemptedChild: string | undefined;
		let subscribeCalls = 0;
		let disposeStarted = false;
		let disposeFinished = false;
		coordinator.setHostedRuntimeFactory(async (participantId, sessionManager) => {
			attemptedChild = participantId;
			const session: any = {
				// Empty runtime metadata is rejected only after the host has been
				// created, exercising PiCoordinator's post-creation rollback path.
				sessionId: "",
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "uncommitted",
				isStreaming: false,
				subscribe() { subscribeCalls += 1; },
				async abort() {},
				dispose() {},
			};
			return {
				session,
				async dispose() {
					disposeStarted = true;
					await Promise.resolve();
					disposeFinished = true;
				},
			} as any;
		});

		await assert.rejects(
			coordinator.spawn(manager.rootParticipantId, "uncommitted", undefined, [], false, workspace),
			/INVALID_PARTICIPANT_STATE: runtime metadata/,
		);

		assert.ok(attemptedChild);
		assert.equal(manager.participant(attemptedChild), undefined);
		assert.deepEqual(manager.snapshot(), before);
		assert.equal(coordinator.runtimes.has(attemptedChild), false);
		assert.throws(() => coordinator?.runtime(attemptedChild!), /Unknown participant|No Pi runtime/);
		assert.equal(subscribeCalls, 1, "event wiring is prepared before commit but the runtime is never published");
		assert.equal(disposeStarted, true);
		assert.equal(disposeFinished, true, "spawn rejection waits for asynchronous host disposal");
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a Pi event-subscription failure stays pre-commit and disposes the prepared host", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-subscribe-rollback-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const before = manager.snapshot();
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		let attemptedChild: string | undefined;
		let disposeFinished = false;
		coordinator.setHostedRuntimeFactory(async (participantId, sessionManager) => {
			attemptedChild = participantId;
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "subscription failure",
				isStreaming: false,
				subscribe() { throw new Error("subscription setup failed"); },
			};
			return {
				session,
				async dispose() { await Promise.resolve(); disposeFinished = true; },
			} as any;
		});

		await assert.rejects(
			coordinator.spawn(manager.rootParticipantId, "subscription failure", undefined, [], false, workspace),
			/subscription setup failed/,
		);

		assert.ok(attemptedChild);
		assert.deepEqual(manager.snapshot(), before);
		assert.equal(manager.participant(attemptedChild), undefined);
		assert.equal(coordinator.runtimes.has(attemptedChild), false);
		assert.equal(disposeFinished, true);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a post-commit checkpoint failure reports degradation without misreporting spawn failure", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-checkpoint-degraded-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		let attemptedChild: string | undefined;
		coordinator.setHostedRuntimeFactory(async (participantId, sessionManager) => {
			attemptedChild = participantId;
			const checkpointFailingManager: any = {
				getLeafId() { return null; },
				async appendCustomEntry() { throw new Error("checkpoint storage failed"); },
			};
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager: checkpointFailingManager,
				sessionName: "checkpoint degraded",
				isStreaming: false,
				subscribe() { return () => undefined; },
			};
			return { session, async dispose() {} } as any;
		});

		const child = await coordinator.spawn(
			manager.rootParticipantId,
			"checkpoint degraded",
			undefined,
			[],
			false,
			workspace,
		);

		assert.equal(child, attemptedChild);
		assert.equal(manager.participant(child)?.id, child, "the authority commit remains the operation result");
		assert.equal(coordinator.runtimes.has(child), true, "the prepared runtime is published after commit");
		assert.equal(manager.snapshot().currentAgentStateIds[child], undefined, "the failed checkpoint is not fabricated");
		assert.deepEqual(coordinator.spawnOutcome(child)?.warnings.map((warning) => warning.code), ["LINDEN_POST_COMMIT_CHECKPOINT_FAILED"]);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("spawn waits only for initial-prompt preflight and returns a structured committed rejection", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-prompt-rejected-"));
	let coordinator: PiCoordinator | undefined;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "prompt rejected",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(_text: string, options: any) {
					options.preflightResult(false);
					return Promise.reject(new Error("model credentials unavailable"));
				},
			};
			return { session, async dispose() {} } as any;
		});

		const child = await coordinator.spawn(
			manager.rootParticipantId,
			"prompt rejected",
			"Do the synthetic task",
			[],
			false,
			workspace,
		);
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

		assert.equal(manager.participant(child)?.status, "stopped");
		assert.deepEqual(coordinator.spawnOutcome(child), {
			participantId: child,
			promptRequested: true,
			promptAccepted: false,
			turnPending: false,
			warningsComplete: true,
			warnings: [{
				code: "LINDEN_INITIAL_PROMPT_REJECTED",
				message: "The participant was created, but Pi rejected its initial prompt before starting a model turn.",
				detail: "Error: model credentials unavailable",
			}],
		});
		assert.deepEqual(unhandled, [], "the detached prompt rejection is always observed");
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("spawn outcome remains incomplete until checkpoint and prompt-preflight warnings are frozen", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-outcome-linearization-"));
	let coordinator: PiCoordinator | undefined;
	let releaseCheckpoint!: () => void;
	let checkpointEntered!: () => void;
	let promptEntered!: () => void;
	let preflightOptions: any;
	let preflightSignaled = false;
	let rejectTurn!: (error: Error) => void;
	let childId: string | undefined;
	const checkpointGate = new Promise<void>((resolvePromise) => { releaseCheckpoint = resolvePromise; });
	const sawCheckpoint = new Promise<void>((resolvePromise) => { checkpointEntered = resolvePromise; });
	const sawPrompt = new Promise<void>((resolvePromise) => { promptEntered = resolvePromise; });
	const turn = new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
	let spawn: Promise<string> | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (participantId, sessionManager) => {
			childId = participantId;
			const gatedSessionManager: any = {
				getLeafId() { return null; },
				async appendCustomEntry() {
					checkpointEntered();
					await checkpointGate;
					return "synthetic-checkpoint-entry";
				},
				appendLabelChange() {},
			};
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager: gatedSessionManager,
				sessionName: "outcome linearization",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(_text: string, options: any) {
					preflightOptions = options;
					promptEntered();
					return turn;
				},
			};
			return { session, async dispose() {} } as any;
		});

		spawn = coordinator.spawn(manager.rootParticipantId, "outcome", "synthetic prompt", [], false, workspace);
		await sawCheckpoint;
		const duringCheckpoint = coordinator.spawnOutcome(childId!);

		releaseCheckpoint();
		await sawPrompt;
		const duringPreflight = coordinator.spawnOutcome(childId!);

		preflightSignaled = true;
		preflightOptions.preflightResult(false);
		rejectTurn(new Error("synthetic preflight rejection"));
		const afterCallback = coordinator.spawnOutcome(childId!);

		const returnedChild = await spawn;
		assert.equal(returnedChild, childId);
		const completed = coordinator.spawnOutcome(returnedChild);
		assert.equal(duringCheckpoint?.warningsComplete, false);
		assert.equal(duringCheckpoint?.promptAccepted, undefined);
		assert.equal(duringPreflight?.warningsComplete, false);
		assert.equal(duringPreflight?.promptAccepted, undefined);
		assert.equal(afterCallback?.warningsComplete, false, "the callback alone does not freeze rejection details");
		assert.equal(completed?.warningsComplete, true);
		assert.equal(completed?.promptAccepted, false);
		assert.deepEqual(completed?.warnings.map((warning) => warning.code), ["LINDEN_INITIAL_PROMPT_REJECTED"]);
	} finally {
		releaseCheckpoint?.();
		if (preflightOptions && !preflightSignaled) {
			preflightOptions.preflightResult(false);
			rejectTurn?.(new Error("test cleanup"));
		}
		await spawn?.catch(() => undefined);
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("shutdown after checkpoint publication never starts a prompt on the disposed runtime", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-checkpoint-shutdown-"));
	let coordinator: PiCoordinator | undefined;
	let checkpointEntered!: () => void;
	let releaseCheckpoint!: () => void;
	const sawCheckpoint = new Promise<void>((resolvePromise) => { checkpointEntered = resolvePromise; });
	const checkpointGate = new Promise<void>((resolvePromise) => { releaseCheckpoint = resolvePromise; });
	let promptCalls = 0;
	let disposeCalls = 0;
	let runtimeDisposeEntered!: () => void;
	const sawRuntimeDispose = new Promise<void>((resolvePromise) => { runtimeDisposeEntered = resolvePromise; });
	let spawn: Promise<string> | undefined;
	let closing: Promise<void> | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const gatedSessionManager: any = {
				getLeafId() { return null; },
				async appendCustomEntry() {
					checkpointEntered();
					await checkpointGate;
					return "shutdown-checkpoint-entry";
				},
				appendLabelChange() {},
			};
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager: gatedSessionManager,
				sessionName: "checkpoint shutdown",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(_text: string, options: any) {
					promptCalls += 1;
					options.preflightResult(false);
					return Promise.reject(new Error("prompt should not start"));
				},
			};
			return {
				session,
				async dispose() {
					disposeCalls += 1;
					runtimeDisposeEntered();
					releaseCheckpoint();
				},
			} as any;
		});

		spawn = coordinator.spawn(manager.rootParticipantId, "checkpoint shutdown", "must not start", [], false, workspace);
		await sawCheckpoint;
		closing = coordinator.dispose();
		let disposeDeadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				sawRuntimeDispose,
				new Promise<never>((_resolve, reject) => {
					disposeDeadline = setTimeout(() => reject(new Error("dispose did not reach the published runtime")), 1_000);
				}),
			]);
		} finally {
			if (disposeDeadline) clearTimeout(disposeDeadline);
		}
		const child = await spawn;
		await closing;

		assert.equal(disposeCalls, 1);
		assert.equal(promptCalls, 0);
		assert.equal(coordinator.spawnOutcome(child)?.promptAccepted, false);
		assert.deepEqual(coordinator.spawnOutcome(child)?.warnings.map((warning) => warning.code), ["LINDEN_INITIAL_PROMPT_REJECTED"]);
	} finally {
		releaseCheckpoint?.();
		await spawn?.catch(() => undefined);
		await closing?.catch(() => undefined);
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("dispose drains an admitted spawn before taking the final runtime snapshot", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-spawn-dispose-"));
	let coordinator: PiCoordinator | undefined;
	let releaseFactory!: () => void;
	let factoryEntered!: () => void;
	const factoryGate = new Promise<void>((resolvePromise) => { releaseFactory = resolvePromise; });
	const sawFactory = new Promise<void>((resolvePromise) => { factoryEntered = resolvePromise; });
	let runtimeDisposeCalls = 0;
	let spawn: Promise<string> | undefined;
	let closing: Promise<void> | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			factoryEntered();
			await factoryGate;
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "dispose race",
				isStreaming: false,
				subscribe() { return () => undefined; },
			};
			return { session, async dispose() { runtimeDisposeCalls += 1; } } as any;
		});

		spawn = coordinator.spawn(manager.rootParticipantId, "dispose race", undefined, [], false, workspace);
		await sawFactory;
		let closeSettled = false;
		closing = coordinator.dispose().then(() => { closeSettled = true; });
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(closeSettled, false, "dispose must not pass an unresolved admitted factory");
		const lateSpawn = coordinator.spawn(manager.rootParticipantId, "too late", undefined, [], false, workspace);
		releaseFactory();
		await assert.rejects(lateSpawn, /PI_COORDINATOR_DISPOSING/);
		const child = await spawn;
		await closing;
		assert.equal(manager.participant(child)?.id, child, "the admitted authority transaction linearizes before dispose");
		assert.equal(runtimeDisposeCalls, 1, "the late-published runtime is included in the final snapshot");
	} finally {
		releaseFactory?.();
		await spawn?.catch(() => undefined);
		await closing?.catch(() => undefined);
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("bulk and on-demand restore share one in-flight runtime and dispose it once", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-restore-single-flight-"));
	let coordinator: PiCoordinator | undefined;
	let releaseFactory!: () => void;
	let factoryEntered!: () => void;
	const factoryGate = new Promise<void>((resolvePromise) => { releaseFactory = resolvePromise; });
	const sawFactory = new Promise<void>((resolvePromise) => { factoryEntered = resolvePromise; });
	let factoryCalls = 0;
	let subscribeCalls = 0;
	let disposeCalls = 0;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		const sessionDirectory = join(manager.stateDir, "pi-sessions");
		const persisted = (coordinator as any).createPersistedSessionManager(sessionDirectory, undefined);
		const child = `agent:${persisted.getSessionId()}`;
		await manager.spawnWith(
			manager.rootParticipantId,
			child,
			"restore single flight",
			[],
			async () => ({ piSessionId: persisted.getSessionId(), sessionFile: persisted.getSessionFile() }),
			{ inheritWorkspaceRead: false },
		);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			factoryCalls += 1;
			factoryEntered();
			await factoryGate;
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "restored",
				isStreaming: false,
				subscribe() { subscribeCalls += 1; return () => undefined; },
			};
			return { session, async dispose() { disposeCalls += 1; } } as any;
		});

		const bulk = coordinator.restoreChildren([child]);
		await sawFactory;
		const onDemand = coordinator.restoreParticipant(child);
		releaseFactory();
		await Promise.all([bulk, onDemand]);
		assert.equal(factoryCalls, 1);
		assert.equal(subscribeCalls, 1);

		await coordinator.dispose();
		assert.equal(disposeCalls, 1);
	} finally {
		releaseFactory?.();
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("spawn returns after initial-prompt acceptance without awaiting the model turn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-prompt-accepted-"));
	let coordinator: PiCoordinator | undefined;
	let finishTurn!: () => void;
	const turn = new Promise<void>((resolvePromise) => { finishTurn = resolvePromise; });
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		let receivedPrompt: string | undefined;
		let receivedOptions: any;
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "prompt accepted",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(text: string, options: any) {
					receivedPrompt = text;
					receivedOptions = options;
					options.preflightResult(true);
					return turn;
				},
			};
			return { session, async dispose() {} } as any;
		});

		const spawn = coordinator.spawn(
			manager.rootParticipantId,
			"prompt accepted",
			"Run without template expansion",
			[],
			false,
			workspace,
		);
		const child = await Promise.race([
			spawn,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("spawn waited for the model turn")), 1_000)),
		]);

		assert.equal(receivedPrompt, "Run without template expansion");
		assert.equal(receivedOptions.expandPromptTemplates, false);
		assert.equal(receivedOptions.source, "extension");
		assert.deepEqual(coordinator.spawnOutcome(child), {
			participantId: child,
			promptRequested: true,
			promptAccepted: true,
			turnPending: true,
			warningsComplete: true,
			warnings: [],
		});
		finishTurn();
		await turn;
	} finally {
		finishTurn?.();
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a failure after prompt acceptance is a runtime diagnostic, not a timing-dependent spawn warning", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-prompt-late-failure-"));
	let coordinator: PiCoordinator | undefined;
	let failTurn!: (error: Error) => void;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		const turn = new Promise<void>((_resolve, reject) => { failTurn = reject; });
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "late prompt failure",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(_text: string, options: any) { options.preflightResult(true); return turn; },
			};
			return { session, async dispose() {} } as any;
		});

		const child = await coordinator.spawn(
			manager.rootParticipantId,
			"late prompt failure",
			"Start then fail",
			[],
			false,
			workspace,
		);
		assert.deepEqual(coordinator.spawnOutcome(child)?.warnings, []);
		assert.equal(coordinator.spawnOutcome(child)?.turnPending, true);

		failTurn(new Error("provider disconnected"));
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

		assert.deepEqual(coordinator.spawnOutcome(child)?.warnings, [], "spawn warnings are frozen at preflight completion");
		assert.equal(coordinator.spawnOutcome(child)?.turnPending, false);
		assert.deepEqual(coordinator.runtimeWarnings(child), [{
			code: "LINDEN_INITIAL_PROMPT_FAILED",
			message: "Pi accepted the initial prompt, but the model turn later failed.",
			detail: "Error: provider disconnected",
		}]);
	} finally {
		if (coordinator) await coordinator.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
