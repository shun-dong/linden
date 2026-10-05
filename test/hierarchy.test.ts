import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { ChildParticipantRuntime, PiCoordinator } from "../src/pi/runtime.js";

test("&>> grants ancestor listen/send/steer/stop/log while rewind and siblings stay restricted", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-hierarchy-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "hierarchy", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:child";
		const sibling = "agent:sibling";
		const grandchild = "agent:grandchild";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "child" }));
		await manager.spawnWith(parent, sibling, "sibling", [], async () => ({ piSessionId: "sibling" }));
		await manager.spawnWith(child, grandchild, "grandchild", [], async () => ({ piSessionId: "grandchild" }));
		assert.throws(() => manager.requireListen(child, parent), /ROLE_MISMATCH/, "a child pointer does not grant reverse ancestor observation");
		assert.doesNotThrow(() => manager.requireListen(child, grandchild));
		assert.doesNotThrow(() => manager.requireListen(parent, grandchild));
		assert.doesNotThrow(() => manager.requireSteer(parent, grandchild));
		assert.doesNotThrow(() => manager.requireStop(parent, grandchild));
		assert.throws(() => manager.requireSteer(sibling, grandchild), /ROLE_MISMATCH/);
		assert.throws(() => manager.requireStop(sibling, grandchild), /ROLE_MISMATCH/);
		const message = await manager.sendWithPayload(parent, grandchild, async (id) => `entry:${id}`);
		assert.equal(manager.pendingMessages(grandchild)[0]?.id, message.id);
		await assert.rejects(manager.receiveMessages(grandchild, [message.id], parent), /ROLE_FORGERY/, "a transitive descendant role is not an ordinary sender filter");
		assert.deepEqual((await manager.receiveMessages(grandchild, [message.id])).map((record) => record.id), [message.id], "unfiltered receive consumes the Message held by the recipient");
		assert.throws(() => manager.requireListen(sibling, child), /ROLE_MISMATCH/);
		assert.doesNotThrow(() => manager.requireLogAgent(parent, parent), "an Agent may inspect its own log");
		assert.doesNotThrow(() => manager.requireLogAgent(parent, grandchild), "an ancestor may inspect an Agent descendant at any depth");
		assert.throws(() => manager.requireLogAgent(grandchild, parent), /ROLE_MISMATCH/, "a descendant cannot inspect an ancestor log");
		assert.throws(() => manager.requireLogAgent(sibling, child), /ROLE_MISMATCH/, "a sibling cannot inspect an unrelated Agent log");
		const grandterm = "term:grandterm";
		await manager.spawnWith(child, grandterm, "grandterm", [], async () => ({}), { participantKind: "term" });
		assert.doesNotThrow(() => manager.requireLogTerm(parent, grandterm), "an ancestor may inspect a Term descendant at any depth");
		assert.doesNotThrow(() => manager.requireLogParticipant(parent, grandterm), "the generic participant-log gate follows the target kind");
		assert.throws(() => manager.requireLogTerm(grandterm, grandterm), /ROLE_MISMATCH/, "Term has no self-log tool entry");
		assert.throws(() => manager.requireLogTerm(sibling, grandterm), /ROLE_MISMATCH/, "an unrelated participant cannot inspect a Term log");
		assert.throws(() => manager.requireLogAgent(parent, grandterm), /PARTICIPANT_KIND_MISMATCH/, "the Agent compatibility entry point remains kind-specific");
		const node = await manager.recordCheckpoint(manager.checkpointEnvelope(grandchild), "pi-grandchild");
		assert.throws(() => manager.requireRewind(parent, grandchild, node.id), /ROLE_MISMATCH/);
		assert.doesNotThrow(() => manager.requireRewind(child, grandchild, node.id));
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("stop waits for the active tool, cuts off later tools once, and then permits restart", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-stop-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "stop", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:stop-child";
		await manager.spawnWith(parent, child, "stop-child", [], async () => ({ piSessionId: "stop-child" }));
		const Coordinator = PiCoordinator as any;
		const coordinator: PiCoordinator = new Coordinator({}, manager, {});
		let aborts = 0;
		coordinator.runtimes.set(child, { participantId: child, isRunning() { return false; }, async abort() { aborts += 1; } } as any);

		coordinator.beginTool(child);
		const stopping = coordinator.stop(parent, child);
		const pendingDeadline = Date.now() + 2_000;
		while (!(coordinator as any).stopRequests.has(child)) {
			if (Date.now() >= pendingDeadline) throw new Error("stop request was not registered");
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		assert.equal(aborts, 0, "the active tool must not be killed");
		assert.throws(() => coordinator.beginTool(child), /stop is pending/);
		coordinator.endTool(child);
		await stopping;
		assert.equal(aborts, 1);
		coordinator.beginTool(child);
		coordinator.endTool(child);
		assert.equal(aborts, 1, "the cleared one-shot stop must not affect a later turn");
		await coordinator.dispose();
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("get preserves a running child loop and delivers the committed authority change", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-get-continue-"));
	let coordinator: PiCoordinator | undefined;
	let finishContinuedTurn: (() => void) | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "get-continue", stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = manager.sessionParticipantId;
		const child = "agent:get-child";
		await manager.spawnWith(parent, child, "get-child", [], async () => ({ piSessionId: "get-child" }));
		const owned = await manager.writeFile(human, "owned.txt", "owned");
		await manager.give(human, parent, owned.resourceId);
		await manager.give(parent, child, owned.resourceId);
		for (const event of manager.snapshot().runtimeEvents ?? []) await manager.acknowledgeRuntimeEvent(event.id);
		coordinator = PiCoordinator.createStandalone(manager);
		let aborts = 0;
		const notices: string[] = [];
		const continuedTurn = new Promise<void>((resolvePromise) => { finishContinuedTurn = resolvePromise; });
		coordinator.runtimes.set(child, {
			participantId: child,
			isRunning: () => true,
			abort: async () => { aborts += 1; },
			summary: () => child,
			appendRuntimeNotice: async (text: string, options?: { continueLoop?: boolean; kind?: "rewind" | "authority-change" }) => {
				assert.equal(options?.continueLoop, false);
				assert.equal(options?.kind, "authority-change");
				notices.push(text);
				await continuedTurn;
				return "notice:get-child";
			},
		} as any);

		coordinator.beginTool(child);
		const getting = coordinator.getOwnedResource(parent, child, owned.resourceId);
		const pendingDeadline = Date.now() + 2_000;
		while (!(coordinator as any).authorityTransferBlocks.has(child)) {
			if (Date.now() >= pendingDeadline) throw new Error("get authority-transfer block was not registered");
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		assert.equal(aborts, 0, "get must not abort the child foreground");
		assert.throws(() => coordinator!.beginTool(child), /authority transfer is pending/);
		coordinator.endTool(child);
		assert.deepEqual(await getting, [owned.resourceId], "get returns after committing, not after the resumed Agent turn ends");
		assert.equal(manager.resource(owned.resourceId)?.ownerId, parent);
		assert.equal(aborts, 0);
		const noticeDeadline = Date.now() + 2000;
		while (!notices.length && Date.now() < noticeDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(notices.length, 1);
		assert.match(notices[0], /authority update/);
		assert.ok(notices[0].includes(owned.resourceId));
		assert.equal((coordinator as any).authorityTransferBlocks.has(child), false);
		coordinator.beginTool(child);
		coordinator.endTool(child);
	} finally {
		finishContinuedTurn?.();
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("get appends an authority update to an idle child without starting another turn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-get-idle-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "get-idle", stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = manager.sessionParticipantId;
		const child = "agent:get-idle-child";
		await manager.spawnWith(parent, child, "get-idle-child", [], async () => ({ piSessionId: "get-idle-child" }));
		const owned = await manager.writeFile(human, "idle-owned.txt", "owned");
		await manager.give(human, parent, owned.resourceId);
		await manager.give(parent, child, owned.resourceId);
		for (const event of manager.snapshot().runtimeEvents ?? []) await manager.acknowledgeRuntimeEvent(event.id);
		coordinator = PiCoordinator.createStandalone(manager);
		let aborts = 0;
		const notices: Array<{ text: string; options: any }> = [];
		coordinator.runtimes.set(child, {
			participantId: child,
			isRunning: () => false,
			abort: async () => { aborts += 1; },
			summary: () => child,
			appendRuntimeNotice: async (text: string, options: any) => {
				notices.push({ text, options });
				return "notice:get-idle-child";
			},
		} as any);

		assert.deepEqual(await coordinator.getOwnedResource(parent, child, owned.resourceId), [owned.resourceId]);
		assert.equal(manager.resource(owned.resourceId)?.ownerId, parent);
		assert.equal(aborts, 0);
		assert.equal(notices.length, 1);
		assert.match(notices[0].text, /authority update/);
		assert.equal(notices[0].options.continueLoop, false);
		assert.equal(notices[0].options.kind, "authority-change");
		assert.match(notices[0].options.eventId, /^runtime:/);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("rewind lets the active tool finish, blocks later tools, then stops the old loop without starting a new one", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-rewind-running-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "rewind-running", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:rewind-running-child";
		await manager.spawnWith(parent, child, "rewind-running-child", [], async () => ({ piSessionId: "rewind-running-child" }));
		const checkpoint = await manager.recordCheckpoint(manager.checkpointEnvelope(child), "pi:before-running-tool");
		coordinator = PiCoordinator.createStandalone(manager);
		let running = true;
		let sequence = 0;
		const events: string[] = [];
		const noticeOptions: unknown[] = [];
		coordinator.runtimes.set(child, {
			participantId: child,
			isRunning: () => running,
			abort: async () => { events.push("abort"); running = false; },
			summary: () => child,
			entries: () => [],
			leafId: () => null,
			appendEntry: async () => `entry:${++sequence}`,
			readPayload: () => undefined,
			deliverBatch: async () => undefined,
			setLabel: () => undefined,
			navigate: async (entryId: string) => {
				assert.equal(running, false, "Pi navigation must not overlap the old Agent loop");
				assert.equal(entryId, checkpoint.piEntryId);
				events.push("navigate");
			},
			appendRuntimeNotice: async (_text: string, options: unknown) => {
				events.push("notice");
				noticeOptions.push(options);
				return `notice:${++sequence}`;
			},
		} as any);

		coordinator.beginTool(child);
		const rewinding = coordinator.rewind(parent, child, checkpoint.id);
		const pendingDeadline = Date.now() + 2_000;
		while (!(coordinator as any).contextNavigationBlocks.has(child)) {
			if (Date.now() >= pendingDeadline) throw new Error("rewind barrier was not registered");
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		assert.deepEqual(events, [], "the current tool must not be aborted or navigated underneath");
		assert.throws(() => coordinator!.beginTool(child), /context rewind is pending/);
		coordinator.endTool(child);
		await rewinding;
		assert.deepEqual(events, ["abort", "navigate", "notice"]);
		assert.deepEqual(noticeOptions, [{ continueLoop: false, kind: "rewind" }], "rewind notice is context-only and starts no model turn");
		assert.equal((coordinator as any).contextNavigationBlocks.has(child), false);
		coordinator.beginTool(child);
		coordinator.endTool(child);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("idle rewind leaves an already-pending mailbox dormant", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-rewind-idle-mailbox-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "rewind-idle-mailbox", stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = manager.sessionParticipantId;
		const child = "agent:rewind-idle-mailbox-child";
		await manager.spawnWith(parent, child, "rewind-idle-mailbox-child", [], async () => ({ piSessionId: "rewind-idle-mailbox-child" }));
		const checkpoint = await manager.recordCheckpoint(manager.checkpointEnvelope(child), "pi:idle-mailbox-target");
		await manager.sendWithPayload(human, child, async (messageId) => manager.store.writePrivatePayload(`test:${messageId}`, { messageId, senderId: human, payload: "remain dormant" }));
		for (const event of manager.snapshot().runtimeEvents ?? []) await manager.acknowledgeRuntimeEvent(event.id);
		coordinator = PiCoordinator.createStandalone(manager);
		let aborts = 0;
		let deliveries = 0;
		let sequence = 0;
		coordinator.runtimes.set(child, {
			participantId: child,
			isRunning: () => false,
			abort: async () => { aborts += 1; },
			summary: () => child,
			entries: () => [],
			leafId: () => null,
			appendEntry: async () => `entry:${++sequence}`,
			readPayload: () => undefined,
			deliverBatch: async () => { deliveries += 1; },
			setLabel: () => undefined,
			navigate: async () => undefined,
			appendRuntimeNotice: async (_text: string, options: unknown) => {
				assert.deepEqual(options, { continueLoop: false, kind: "rewind" });
				return `notice:${++sequence}`;
			},
		} as any);

		await coordinator.rewind(parent, child, checkpoint.id);
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		assert.equal(aborts, 0, "idle rewind does not synthesize an interrupt");
		assert.equal(deliveries, 0, "rewind itself must not activate pre-existing mail or start a model turn");
		assert.equal(manager.pendingMessages(child).length, 1);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("child Pi navigation refuses to hide a running-loop abort inside the adapter", async () => {
	let aborts = 0;
	let navigations = 0;
	const runtime = new ChildParticipantRuntime("agent:running-navigation", {
		sessionId: "running-navigation",
		sessionFile: undefined,
		isStreaming: true,
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: () => [],
			getLeafId: () => null,
			getLeafEntry: () => undefined,
		},
		abort: async () => { aborts += 1; },
		navigateTree: async () => { navigations += 1; return { cancelled: false }; },
	} as any);
	await assert.rejects(runtime.navigate("pi:target"), /PI_NAVIGATION_WHILE_RUNNING/);
	assert.equal(aborts, 0);
	assert.equal(navigations, 0);
});

test("child runtime steers a running authority update but only appends one for an idle Agent", async () => {
	const deliveries: Array<{ message: any; options: any }> = [];
	const session = {
		sessionId: "runtime-notice-child",
		sessionFile: undefined,
		isStreaming: true,
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: () => [],
			getLeafId: () => "leaf:runtime-notice",
			getLeafEntry: () => undefined,
		},
		sendCustomMessage: async (message: any, options: any) => { deliveries.push({ message, options }); },
	};
	const runtime = new ChildParticipantRuntime("agent:runtime-notice", session as any);

	await runtime.appendRuntimeNotice("running update", { continueLoop: true, kind: "authority-change" });
	assert.equal(deliveries[0].message.customType, "linden-runtime-notice");
	assert.equal(deliveries[0].message.details.kind, "authority-change");
	assert.deepEqual(deliveries[0].options, { triggerTurn: true, deliverAs: "steer" });

	session.isStreaming = false;
	await runtime.appendRuntimeNotice("idle update", { continueLoop: false, kind: "authority-change" });
	assert.equal(deliveries[1].message.details.kind, "authority-change");
	assert.deepEqual(deliveries[1].options, { triggerTurn: false });
});

test("suspended child mailbox clears queued turns and persists later mail without waking", async () => {
	const deliveries: Array<{ message: any; options: any }> = [];
	let queueClears = 0;
	const session = {
		sessionId: "terminal-mailbox-child",
		sessionFile: undefined,
		isStreaming: true,
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: () => [],
			getLeafId: () => null,
			getLeafEntry: () => undefined,
		},
		clearQueue: () => { queueClears += 1; },
		sendCustomMessage: async (message: any, options: any) => { deliveries.push({ message, options }); },
	};
	const runtime = new ChildParticipantRuntime("agent:terminal-mailbox", session as any);
	runtime.suspendMailboxWake();
	await runtime.deliverBatch({ batchId: "batch:terminal", kind: "follow_up", messages: [{ id: "message:1", senderId: "agent:peer", payload: "late mail" }] });

	assert.equal(queueClears, 1);
	assert.equal(deliveries.length, 1);
	assert.deepEqual(deliveries[0].options, { triggerTurn: false });
});
