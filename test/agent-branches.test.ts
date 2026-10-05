import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { decodeLedger, encodeLedger } from "../src/runtime/store.js";
import { PiCoordinator, RUNTIME_NOTICE } from "../src/pi/runtime.js";
import { StandalonePiHost } from "../src/pi/host.js";
import { buildTools } from "../src/pi/tools.js";

async function fixture() {
	const base = mkdtempSync("/tmp/linden-agent-branches-");
	const options = { base, stateDir: join(base, ".state"), rootParticipantId: "human:branches", lindenSessionId: "session:branches" };
	const manager = await SessionAuthorityManager.open(options);
	const human = manager.rootParticipantId;
	const session = SessionManager.inMemory(base);
	const child = `agent:${session.getSessionId()}`;
	await manager.spawnWith(human, child, "worker", [], async () => ({ piSessionId: session.getSessionId() }), { inheritWorkspaceRead: false });
	const coordinator = PiCoordinator.createStandalone(manager);
	let running = false;
	let aborts = 0;
	let navigations = 0;
	coordinator.runtimes.set(child, {
		participantId: child, piSessionId: session.getSessionId(), entries: () => session.getEntries(), leafId: () => session.getLeafId(),
		isRunning: () => running, abort: async () => { aborts += 1; running = false; }, summary: () => child,
		appendEntry: async (type, data) => session.appendCustomEntry(type, data),
		setLabel: (id, label) => { session.appendLabelChange(id, label); },
		readPayload: () => undefined, deliverBatch: async () => {},
		navigate: async (id) => { navigations += 1; session.branch(id); },
		appendRuntimeNotice: async (text, options) => { assert.equal(options?.continueLoop, false); return session.appendCustomMessageEntry(RUNTIME_NOTICE, text, true); },
	});
	const initial = (await coordinator.appendCheckpoint(child, "birth"))!;
	return { base, options, manager, human, child, coordinator, session, initial,
		get aborts() { return aborts; }, get navigations() { return navigations; }, run: () => { running = true; },
		close: async () => { await coordinator.dispose(); rmSync(base, { recursive: true, force: true }); } };
}

function branchHeads(f: Awaited<ReturnType<typeof fixture>>) { return f.manager.agentBranches(f.child); }

test("branch creation preserves the old tip and its notice advances only the new branch", async () => {
	const f = await fixture();
	try {
		f.session.appendCustomMessageEntry("test", "old progress", true);
		const oldTip = (await f.coordinator.appendCheckpoint(f.child, "progress"))!;
		await f.coordinator.branch(f.human, f.child, "experiment", f.initial.id);
		const refs = branchHeads(f);
		assert.equal(refs.current, "experiment");
		assert.equal(refs.heads.main, oldTip.id);
		const notice = f.manager.snapshot().agentStates[refs.heads.experiment];
		assert.equal(notice.parentId, f.initial.id);
		assert.equal(f.session.getEntry(notice.piEntryId)?.type, "custom_message");
		assert.ok(f.manager.snapshot().agentStates[oldTip.id]);
		assert.equal(f.aborts, 0);
		assert.match(await f.coordinator.formatAgentLog(f.human, f.child), /experiment \(current\)/);
		const reopened = await SessionAuthorityManager.open(f.options);
		assert.deepEqual(reopened.agentBranches(f.child), refs);
	} finally { await f.close(); }
});

test("branch from current seals recent messages and switching restores them without moving other refs", async () => {
	const f = await fixture();
	try {
		const message = f.session.appendCustomMessageEntry("test", "recent uncheckpointed message", true);
		await f.coordinator.branch(f.human, f.child, "work");
		const mainHead = branchHeads(f).heads.main;
		const mainEntry = f.manager.snapshot().agentStates[mainHead].piEntryId;
		assert.equal(f.session.getEntry(mainEntry)?.parentId, message);
		const workHead = branchHeads(f).heads.work;
		await f.coordinator.switchBranch(f.human, f.child, "main");
		const refs = branchHeads(f);
		assert.equal(refs.current, "main");
		assert.equal(refs.heads.work, workHead);
		assert.equal(f.manager.snapshot().agentStates[refs.heads.main].parentId, mainHead);
		assert.ok(f.session.getBranch().some((entry) => entry.id === message));
		const count = f.session.getEntries().length;
		await f.coordinator.switchBranch(f.human, f.child, "main");
		assert.equal(f.session.getEntries().length, count, "switching to the current branch is a no-op");
	} finally { await f.close(); }
});

test("rewind moves the current branch, retains suffix nodes and leaves ownership/disk untouched", async () => {
	const f = await fixture();
	try {
		await f.coordinator.branch(f.human, f.child, "work");
		const mainHead = branchHeads(f).heads.main;
		f.session.appendCustomMessageEntry("test", "discard this continuation", true);
		const suffix = (await f.coordinator.appendCheckpoint(f.child, "suffix"))!;
		const file = await f.manager.writeFile(f.human, "effect.txt", "real effect");
		await f.manager.give(f.human, f.child, file.resourceId);
		await f.coordinator.rewind(f.human, f.child, f.initial.id);
		const refs = branchHeads(f);
		assert.equal(refs.current, "work");
		assert.equal(refs.heads.main, mainHead);
		assert.equal(f.manager.snapshot().agentStates[refs.heads.work].parentId, f.initial.id);
		assert.ok(f.manager.snapshot().agentStates[suffix.id]);
		assert.equal(f.manager.ownerOf(file.resourceId), f.child);
		assert.equal(readFileSync(join(f.base, "effect.txt"), "utf8"), "real effect");
		const entry = f.session.getEntry(f.manager.snapshot().agentStates[refs.heads.work].piEntryId);
		assert.ok(entry?.type === "custom_message" && String(entry.content).includes(file.resourceId));
	} finally { await f.close(); }
});

test("invalid names, missing branches and cross-Agent targets never navigate or change refs", async () => {
	const f = await fixture();
	try {
		const before = f.manager.snapshot();
		await assert.rejects(f.coordinator.branch(f.human, f.child, "main"), /BRANCH_EXISTS/);
		await assert.rejects(f.coordinator.branch(f.human, f.child, "bad name"), /BRANCH_NAME/);
		await assert.rejects(f.coordinator.switchBranch(f.human, f.child, "missing"), /UNKNOWN_AGENT_BRANCH/);
		await assert.rejects(f.coordinator.branch(f.child, f.child, "self"), /ROLE_MISMATCH/);
		await assert.rejects(f.coordinator.rewind(f.human, f.child, "agent-state:foreign"), /STATE_SCOPE_MISMATCH/);
		assert.equal(f.navigations, 0);
		assert.deepEqual(f.manager.snapshot(), before);
	} finally { await f.close(); }
});

test("running navigation waits for a started tool and prevents later tools until completion", async () => {
	const f = await fixture();
	try {
		f.coordinator.beginTool(f.child);
		f.run();
		const operation = f.coordinator.branch(f.human, f.child, "after-tool");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.navigations, 0);
		assert.throws(() => f.coordinator.beginTool(f.child), /context rewind is pending/);
		await assert.rejects(f.coordinator.switchBranch(f.human, f.child, "main"), /navigation is already pending/);
		f.coordinator.endTool(f.child);
		await operation;
		assert.equal(f.aborts, 1);
		assert.equal(branchHeads(f).current, "after-tool");
		assert.equal(f.coordinator.isHistoryNavigationPending(f.child), false);
	} finally { await f.close(); }
});

test("failed navigation commit restores Pi context and leaves branch references unchanged", async () => {
	const f = await fixture();
	try {
		f.session.appendCustomMessageEntry("test", "source", true);
		const source = (await f.coordinator.appendCheckpoint(f.child, "source"))!;
		const before = branchHeads(f);
		const original = f.manager.commitAgentNavigation;
		f.manager.commitAgentNavigation = async () => { throw new Error("commit failed"); };
		try { await assert.rejects(f.coordinator.branch(f.human, f.child, "failed", f.initial.id), /commit failed/); }
		finally { f.manager.commitAgentNavigation = original; }
		assert.deepEqual(branchHeads(f), before);
		assert.equal(f.session.getLeafId(), source.piEntryId);
		assert.equal(f.coordinator.isHistoryNavigationPending(f.child), false);
	} finally { await f.close(); }
});

test("old current pointers migrate to main and branch corruption fails closed", async () => {
	const f = await fixture();
	try {
		const ledger = encodeLedger(f.manager.snapshot());
		const agent = ledger.Delta.find((entry) => entry.variable === f.child) as any;
		const refs = agent.state.branches;
		assert.equal(agent.state.current, undefined, "the new ledger stores a single source of branch truth");
		ledger.schemaVersion = 7;
		delete agent.state.branches;
		agent.state.current = f.initial.id;
		const migrated = decodeLedger(ledger, f.base, f.manager.stateDir);
		assert.deepEqual(migrated.agentBranches?.[f.child], { current: "main", heads: { main: f.initial.id } });
		delete agent.state.current;
		agent.state.branches = refs;
		for (const invalid of [ { current: "missing", heads: refs.heads }, { current: "main", heads: { main: "unknown" } }, { current: "bad name", heads: {} } ]) {
			agent.state.branches = invalid;
			assert.throws(() => decodeLedger(ledger, f.base, f.manager.stateDir), /INVALID_AGENT_/);
		}
	} finally { await f.close(); }
});

test("subtree archive and restore preserve all branch heads and the selected branch", async () => {
	const f = await fixture();
	try {
		await f.coordinator.branch(f.human, f.child, "work");
		const refs = branchHeads(f);
		await f.manager.setParticipantStatus(f.child, "stopped");
		await f.manager.archiveParticipant(f.human, f.child, () => true);
		assert.equal(f.manager.snapshot().agentBranches?.[f.child], undefined);
		const reopened = await SessionAuthorityManager.open(f.options);
		await reopened.unarchiveParticipant(f.human, f.child);
		assert.deepEqual(reopened.agentBranches(f.child), refs);
	} finally { await f.close(); }
});

test("tree restores raw user/custom messages exactly and advances the current branch to the notice", async () => {
	const f = await fixture();
	try {
		const user = f.session.appendMessage({ role: "user", content: "selected user message", timestamp: Date.now() });
		f.session.appendCustomMessageEntry("test", "later message", true);
		await f.coordinator.rewindPiEntry(f.human, f.child, user, f.session);
		assert.ok(f.session.getBranch().some((entry) => entry.id === user));
		assert.ok(!f.session.getBranch().some((entry) => entry.type === "custom_message" && entry.content === "later message"));
		const refs = branchHeads(f);
		assert.equal(refs.current, "main");
		const head = f.manager.snapshot().agentStates[refs.heads.main];
		assert.equal(f.session.getEntry(head.piEntryId)?.type, "custom_message");
		const anchor = f.manager.snapshot().agentStates[head.parentId!];
		assert.equal(f.session.getEntry(anchor.piEntryId)?.parentId, user);
	} finally { await f.close(); }
});

test("branch/switch model tools share coordinator navigation and checkpoint the caller", async () => {
	const f = await fixture();
	try {
		const tools = buildTools(f.coordinator, f.human);
		await (tools.find((tool) => tool.name === "branch")!.execute as any)("branch-call", { participant: f.child, name: "tools" });
		assert.equal(branchHeads(f).current, "tools");
		await (tools.find((tool) => tool.name === "switch")!.execute as any)("switch-call", { participant: f.child, name: "main" });
		assert.equal(branchHeads(f).current, "main");
	} finally { await f.close(); }
});

test("real hosted Pi tree uses Linden rewind and preserves the user's summary choice", async () => {
	const base = mkdtempSync("/tmp/linden-tree-host-");
	let host: StandalonePiHost | undefined;
	try {
		host = await StandalonePiHost.open({ base, stateRoot: join(base, ".state") });
		const child = await host.spawnTopLevel({ name: "tree-test", inheritWorkspaceRead: false });
		const session = host.coordinator.hostedRuntime(child).runtimeHost.session;
		const user = session.sessionManager.appendMessage({ role: "user", content: "selected context", timestamp: Date.now() });
		session.sessionManager.appendCustomMessageEntry("test", "later context", true);
		const original = session.navigateTree;
		let summaryRequested: boolean | undefined;
		session.navigateTree = async (id, options) => {
			summaryRequested = options?.summarize;
			if (options?.summarize) {
				// Produce a native Pi summary entry without sending a model request.
				session.sessionManager.branchWithSummary(id, "user-selected summary");
				return { cancelled: false };
			}
			return original.call(session, id, options);
		};
		const undo = host.routeAttachedTree(child);
		try {
			const flatten = (nodes: ReturnType<typeof session.sessionManager.getTree>): typeof nodes => nodes.flatMap((node) => [node, ...flatten(node.children)]);
			assert.ok(flatten(session.sessionManager.getTree()).some((node) => node.label?.includes("main (current)") && node.entry.type === "custom_message"));
			assert.equal((await session.navigateTree(user, { summarize: true })).cancelled, false);
			assert.equal(summaryRequested, true);
			assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "branch_summary" && entry.summary === "user-selected summary"));
			const refs = host.authority.agentBranches(child);
			const head = host.authority.snapshot().agentStates[refs.heads[refs.current]];
			assert.equal(session.sessionManager.getEntry(head.piEntryId)?.type, "custom_message");
			assert.ok(session.sessionManager.getBranch().some((entry) => entry.id === user));
			assert.ok(!session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.content === "later context"));
		} finally { undo(); session.navigateTree = original; }
		const restore = host.routeAttachedTree(child);
		try {
			await session.navigateTree(user, { summarize: false });
			assert.ok(session.agent.state.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("selected context")));
		} finally { restore(); }
		const refs = host.authority.agentBranches(child);
		const ledgerFile = host.authority.store.ledgerPath;
		const persisted = JSON.parse(readFileSync(ledgerFile, "utf8"));
		assert.deepEqual(persisted.Delta.find((entry: any) => entry.variable === child).state.branches, refs);
	} finally { await host?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("opening a v7 workspace saves a v8 main reference and keeps the original ledger backup", async () => {
	const f = await fixture();
	try {
		const ledger = encodeLedger(f.manager.snapshot());
		ledger.schemaVersion = 7;
		for (const entry of ledger.Delta) if (entry.type === "Agent") {
			const state = entry.state as any;
			state.current = state.branches.heads[state.branches.current];
			delete state.branches;
		}
		const original = JSON.stringify(ledger);
		writeFileSync(f.manager.store.ledgerPath, original);
		const reopened = await SessionAuthorityManager.open(f.options);
		assert.equal(reopened.snapshot().schemaVersion, 8);
		assert.deepEqual(reopened.agentBranches(f.child), { current: "main", heads: { main: f.initial.id } });
		assert.deepEqual(JSON.parse(readFileSync(join(f.manager.stateDir, "ledger.v7.backup.json"), "utf8")), JSON.parse(original));
		assert.equal(JSON.parse(readFileSync(f.manager.store.ledgerPath, "utf8")).schemaVersion, 8);
	} finally { await f.close(); }
});

test("real Pi branch switching restores the full notice tip and reopening retains the selected branch", async () => {
	const base = mkdtempSync("/tmp/linden-branch-reopen-");
	const stateRoot = join(base, ".state");
	let host: StandalonePiHost | undefined;
	try {
		host = await StandalonePiHost.open({ base, stateRoot });
		const child = await host.spawnTopLevel({ name: "switch-test", inheritWorkspaceRead: false });
		const human = host.authority.rootParticipantId;
		const session = host.coordinator.hostedRuntime(child).runtimeHost.session;
		await host.coordinator.branch(human, child, "work");
		const workHead = host.authority.agentBranches(child).heads.work;
		const workEntry = host.authority.snapshot().agentStates[workHead].piEntryId;
		await host.coordinator.switchBranch(human, child, "main");
		await host.coordinator.switchBranch(human, child, "work");
		assert.ok(session.sessionManager.getBranch().some((entry) => entry.id === workEntry), "native custom-message navigation must retain the selected notice");
		const refs = host.authority.agentBranches(child);
		const workspaceId = host.authority.sessionId;
		await host.dispose();
		host = await StandalonePiHost.open({ session: workspaceId, stateRoot });
		assert.deepEqual(host.authority.agentBranches(child), refs);
		await host.ensureRuntime(child);
		const restored = host.coordinator.hostedRuntime(child).runtimeHost.session.sessionManager;
		assert.ok(restored.getBranch().some((entry) => entry.id === host!.authority.snapshot().agentStates[refs.heads.work].piEntryId));
		assert.equal(host.authority.participant(child)?.status, "stopped");
	} finally { await host?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("cancelled native summary leaves the source branch selected without a rewind effect", async () => {
	const base = mkdtempSync("/tmp/linden-tree-cancel-");
	let host: StandalonePiHost | undefined;
	try {
		host = await StandalonePiHost.open({ base, stateRoot: join(base, ".state") });
		const child = await host.spawnTopLevel({ name: "cancel-test", inheritWorkspaceRead: false });
		const session = host.coordinator.hostedRuntime(child).runtimeHost.session;
		const target = session.sessionManager.getLeafId()!;
		session.sessionManager.appendCustomMessageEntry("test", "source context", true);
		const source = (await host.coordinator.appendCheckpoint(child, "source"))!;
		const refs = host.authority.agentBranches(child);
		const effects = host.authority.snapshot().effects.length;
		const original = session.navigateTree;
		session.navigateTree = async (_id, options) => options?.summarize ? { cancelled: true, aborted: true } : original.call(session, _id, options);
		const restore = host.routeAttachedTree(child);
		try {
			assert.equal((await session.navigateTree(target, { summarize: true })).aborted, true);
			assert.deepEqual(host.authority.agentBranches(child), refs);
			assert.equal(host.authority.snapshot().effects.length, effects);
			assert.equal(session.sessionManager.getLeafId(), source.piEntryId);
		} finally { restore(); session.navigateTree = original; }
	} finally { await host?.dispose(); rmSync(base, { recursive: true, force: true }); }
});
