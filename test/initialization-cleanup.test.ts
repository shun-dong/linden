import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StandalonePiHost } from "../src/pi/host.js";
import { HostedParticipantRuntime, PiCoordinator } from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { SessionRegistry } from "../src/runtime/sessions.js";

test("hosted runtime disposal drops queued turns before and after abort settlement", async () => {
	const calls: string[] = [];
	let queued = true;
	const session: any = {
		sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		sessionFile: "/tmp/hosted-dispose.jsonl",
		sessionManager: { getCwd: () => "/tmp", getLeafId: () => null, getEntries: () => [] },
		sessionName: "hosted dispose",
		isStreaming: true,
		clearQueue() {
			calls.push("clear");
			queued = false;
		},
		async abort() {
			calls.push("abort");
			assert.equal(queued, false, "queued follow-ups must be removed before abort can settle");
			queued = true; // Simulate a delivery already in flight at shutdown entry.
		},
	};
	const runtimeHost: any = {
		session,
		async dispose() {
			calls.push("dispose");
			assert.equal(queued, false, "an in-flight delivery must be removed before final disposal");
		},
	};

	await new HostedParticipantRuntime("agent:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", runtimeHost).dispose();
	assert.deepEqual(calls, ["clear", "abort", "clear", "dispose"]);
});

test("Pi coordinator initialization releases its lease when a workspace restore fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-init-cleanup-"));
	const stateRoot = join(workspace, ".linden-state");
	const registry = new SessionRegistry(stateRoot);
	const piSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const originalGive = SessionAuthorityManager.prototype.unarchiveWorkspace;
	SessionAuthorityManager.prototype.unarchiveWorkspace = async function () {
		throw new Error("injected restore failure");
	};
	try {
		const context: any = {
			cwd: workspace,
			sessionManager: {
				getSessionId: () => piSessionId,
				getSessionName: () => "initialization cleanup",
				getSessionFile: () => join(workspace, "root-session.jsonl"),
			},
			ui: { notify() {} },
		};

		await assert.rejects(
			PiCoordinator.create({} as any, context, ["net:tcp/public"], registry),
			/injected restore failure/,
		);

		const manifest = registry.resolve(`session:${piSessionId}`);
		const retryLease = registry.acquire(manifest);
		retryLease.release();
	} finally {
		SessionAuthorityManager.prototype.unarchiveWorkspace = originalGive;
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("standalone host initialization disposes partial state and releases its lease when restore fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-host-init-cleanup-"));
	const stateRoot = join(workspace, ".linden-state");
	const originalRestore = PiCoordinator.prototype.restoreChildren;
	PiCoordinator.prototype.restoreChildren = async function () {
		throw new Error("injected restore failure");
	};
	try {
		await assert.rejects(
			StandalonePiHost.open({ base: workspace, stateRoot }),
			/injected restore failure/,
		);

		const registry = new SessionRegistry(stateRoot);
		const [manifest] = registry.list();
		assert.ok(manifest);
		const retryLease = registry.acquire(manifest);
		retryLease.release();
	} finally {
		PiCoordinator.prototype.restoreChildren = originalRestore;
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("coordinator disposal keeps the lease until an accepted model turn and its authority callback settle", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-background-drain-"));
	const stateRoot = join(workspace, ".linden-state");
	const registry = new SessionRegistry(stateRoot);
	const piSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	let coordinator: PiCoordinator | undefined;
	let rejectTurn!: (error: Error) => void;
	let closing: Promise<void> | undefined;
	let releaseStatus!: () => void;
	try {
		const context: any = {
			cwd: workspace,
			isIdle: () => true,
			sessionManager: {
				getSessionId: () => piSessionId,
				getSessionName: () => "background drain",
				getSessionFile: () => join(workspace, "root-session.jsonl"),
			},
			ui: { notify() {} },
		};
		coordinator = await PiCoordinator.create({} as any, context, [], registry);
		coordinator.setToolFactory(() => []);
		let statusCalls = 0;
		let resolveStatusEntered!: () => void;
		const statusEntered = new Promise<void>((resolvePromise) => { resolveStatusEntered = resolvePromise; });
		const statusGate = new Promise<void>((resolvePromise) => { releaseStatus = resolvePromise; });
		const originalSetStatuses = coordinator.authority.setParticipantStatuses.bind(coordinator.authority);
		(coordinator.authority as any).setParticipantStatuses = async (...args: Parameters<typeof originalSetStatuses>) => {
			statusCalls += 1;
			resolveStatusEntered();
			await statusGate;
			return originalSetStatuses(...args);
		};
		const turn = new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => {
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "accepted turn",
				isStreaming: false,
				subscribe() { return () => undefined; },
				prompt(_text: string, options: any) {
					options.preflightResult(true);
					return turn;
				},
			};
			return { session, async dispose() {} } as any;
		});

		const child = await coordinator.spawn(
			coordinator.authority.sessionParticipantId,
			"background drain",
			"synthetic accepted prompt",
			[],
			false,
			workspace,
		);
		assert.equal(coordinator.spawnOutcome(child)?.turnPending, true);

		let closeSettled = false;
		closing = coordinator.dispose().then(() => { closeSettled = true; });
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(closeSettled, false, "runtime disposal alone must not release the lease ahead of the turn callback");
		const manifest = registry.resolve(`session:${piSessionId}`);
		assert.throws(() => registry.acquire(manifest), /ACTIVE_WRITE_CONFLICT/);

		rejectTurn(new Error("synthetic shutdown abort"));
		await Promise.race([
			statusEntered,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("authority status callback was not scheduled")), 1_000)),
		]);
		assert.equal(statusCalls, 1, "the rejected turn must schedule its authority status callback");
		assert.equal(closeSettled, false, "dispose must drain the asynchronous authority callback, not only the model Promise");
		assert.throws(() => registry.acquire(manifest), /ACTIVE_WRITE_CONFLICT/);
		releaseStatus();
		await closing;
		const retryLease = registry.acquire(manifest);
		retryLease.release();
	} finally {
		rejectTurn?.(new Error("test cleanup"));
		releaseStatus?.();
		await closing?.catch(() => undefined);
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("coordinator disposal drains an active Linden tool before releasing its lease", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-tool-drain-"));
	const registry = new SessionRegistry(join(workspace, ".linden-state"));
	const piSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	let coordinator: PiCoordinator | undefined;
	let toolActive = false;
	let closing: Promise<void> | undefined;
	try {
		const context: any = {
			cwd: workspace,
			sessionManager: {
				getSessionId: () => piSessionId,
				getSessionName: () => "tool drain",
				getSessionFile: () => join(workspace, "root-session.jsonl"),
			},
			ui: { notify() {} },
		};
		coordinator = await PiCoordinator.create({} as any, context, [], registry);
		coordinator.beginTool(coordinator.authority.sessionParticipantId);
		toolActive = true;
		let closeSettled = false;
		closing = coordinator.dispose().then(() => { closeSettled = true; });
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(closeSettled, false);
		const manifest = registry.resolve(`session:${piSessionId}`);
		assert.throws(() => registry.acquire(manifest), /ACTIVE_WRITE_CONFLICT/);
		coordinator.endTool(coordinator.authority.sessionParticipantId);
		toolActive = false;
		await closing;
		const retryLease = registry.acquire(manifest);
		retryLease.release();
	} finally {
		if (toolActive && coordinator) coordinator.endTool(coordinator.authority.sessionParticipantId);
		await closing?.catch(() => undefined);
		await coordinator?.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a hosted runtime disposal failure retains the coordinator lease", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-dispose-failure-"));
	const registry = new SessionRegistry(join(workspace, ".linden-state"));
	const piSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
	let coordinator: PiCoordinator | undefined;
	let heldLease: { release(): void } | undefined;
	try {
		const context: any = {
			cwd: workspace,
			sessionManager: {
				getSessionId: () => piSessionId,
				getSessionName: () => "dispose failure",
				getSessionFile: () => join(workspace, "root-session.jsonl"),
			},
			ui: { notify() {} },
		};
		coordinator = await PiCoordinator.create({} as any, context, [], registry);
		heldLease = (coordinator as any).sessionLease;
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_participantId, sessionManager) => ({
			session: {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "dispose failure",
				isStreaming: false,
				subscribe() { return () => undefined; },
			},
			async dispose() { throw new Error("injected runtime disposal failure"); },
		} as any));
		await coordinator.spawn(coordinator.authority.sessionParticipantId, "dispose failure", undefined, [], false, workspace);

		await assert.rejects(coordinator.dispose(), /Pi coordinator did not dispose cleanly/);
		const manifest = registry.resolve(`session:${piSessionId}`);
		assert.throws(() => registry.acquire(manifest), /ACTIVE_WRITE_CONFLICT/);
	} finally {
		heldLease?.release();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("standalone host retains its lease when coordinator cleanup fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-host-dispose-failure-"));
	const stateRoot = join(workspace, ".linden-state");
	let host: StandalonePiHost | undefined;
	let heldLease: { release(): void } | undefined;
	try {
		host = await StandalonePiHost.open({ base: workspace, stateRoot });
		const activeHost = host;
		heldLease = (activeHost as any).lease;
		(activeHost.coordinator as any).dispose = async () => { throw new Error("injected coordinator cleanup failure"); };
		await assert.rejects(activeHost.dispose(), /Standalone Linden host did not dispose cleanly/);
		const manifest = activeHost.registry.resolve(activeHost.manifest.id);
		assert.throws(() => activeHost.registry.acquire(manifest), /ACTIVE_WRITE_CONFLICT/);
	} finally {
		heldLease?.release();
		rmSync(workspace, { recursive: true, force: true });
	}
});
