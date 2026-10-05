import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { parseHumanSpawn } from "../src/pi/compat.js";
import lindenExtension, { parseHumanSpawn as legacyParseHumanSpawn, type ParsedHumanSpawn as LegacyParsedHumanSpawn } from "../src/pi/extension.js";
import { MAIL_BATCH, PiCoordinator, type MailPayload } from "../src/pi/runtime.js";
import { buildTools } from "../src/pi/tools.js";

test("the explicit Human spawn compatibility parser preserves legacy exports and syntax", () => {
	assert.equal(legacyParseHumanSpawn, parseHumanSpawn);
	const empty: LegacyParsedHumanSpawn = parseHumanSpawn([]);
	assert.deepEqual(empty, { kind: "agent", name: undefined, prompt: undefined, grants: [], inheritWorkspaceRead: true });
	for (const flag of ["--no-inherit-read", "--no-cwd-read", "--no-workspace-read"]) {
		assert.equal(parseHumanSpawn([flag, "worker"]).inheritWorkspaceRead, false);
	}
	assert.deepEqual(parseHumanSpawn(["--kind", "term", "shell", "--give", "net:tcp/dns/example.com:443", "--give", "&file:./", "--", "echo", "--literal"]), {
		kind: "term", name: "shell", prompt: "echo --literal", grants: ["net:tcp/dns/example.com:443", "&file:./"], inheritWorkspaceRead: true,
	});
	assert.deepEqual(parseHumanSpawn(["worker", "inspect", "--kind", "term"]), {
		kind: "agent", name: "worker", prompt: "inspect --kind term", grants: [], inheritWorkspaceRead: true,
	});
	assert.equal(parseHumanSpawn(["worker", "--", "  "]).prompt, undefined);
	assert.throws(() => parseHumanSpawn(["--kind"]), /agent or term/);
	assert.throws(() => parseHumanSpawn(["--kind", "human"]), /agent or term/);
	assert.throws(() => parseHumanSpawn(["--give"]), /Missing resource/);
	assert.throws(() => parseHumanSpawn(["--unknown"]), /Unknown spawn option/);
	assert.throws(() => parseHumanSpawn(["worker", "extra", "--", "prompt"]), /only one optional name/);
});

test("Pi extension overrides every native gateway and registers collaboration tools", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const flags: string[] = [];
	const events: string[] = [];
	const fake: any = {
		registerTool(tool: any) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
		registerFlag(name: string) { flags.push(name); },
		on(name: string) { events.push(name); },
	};
	lindenExtension(fake);
	assert.deepEqual(tools.sort(), ["branch", "switch", "unarchive", "fork", "permission", "publish", "unpublish", "participants", "archive", "authority", "bash", "checkout", "edit", "exec", "get", "give", "input", "interrupt", "listen", "log", "read", "receive", "rewind", "send", "spawn", "stat", "steer", "stop", "wait", "write"].sort());
	assert.equal(commands.includes("linden"), false);
	assert.ok(events.includes("input"));
	assert.ok(flags.includes("linden-permissions"));
	assert.ok(flags.includes("linden-max-agent-depth"));
	assert.ok(events.includes("user_bash"));
	assert.ok(events.includes("session_start"));
});

test("Pi extension startup leaves persisted child runtimes lazy", async () => {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const fake: any = {
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
		getFlag() { return ""; },
	};
	const originalCreate = PiCoordinator.create;
	let eagerRestoreCalls = 0;
	let sessionActivations = 0;
	(PiCoordinator as any).create = async () => ({
		authority: { sessionParticipantId: "agent:root" },
		setToolFactory() {},
		async restoreChildren() { eagerRestoreCalls += 1; },
		async activateSessionMailbox() { sessionActivations += 1; },
	});
	try {
		lindenExtension(fake);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart({}, {
			ui: {
				setStatus() {},
				theme: { fg: (_color: string, value: string) => value },
			},
		});
		assert.equal(eagerRestoreCalls, 0);
		assert.equal(sessionActivations, 1);
	} finally {
		(PiCoordinator as any).create = originalCreate;
	}
});


test("participant tools prefer participant targets, accept the agent alias, and dispatch Term controls", async () => {
	const calls: unknown[][] = [];
	const coordinator: any = {
		authority: { workspace: process.cwd() },
		beginTool() {},
		endTool() {},
		async appendCheckpoint() {},
		async appendCheckpointAfterCommit() { return {}; },
		spawnOutcome() { return undefined; },
		async spawnParticipant(...args: unknown[]) { calls.push(["spawn", ...args]); return "term:one"; },
		async listenParticipant(...args: unknown[]) { calls.push(["listen", ...args]); return "term:one ready"; },
		async formatParticipantLog(...args: unknown[]) { calls.push(["log", ...args]); return "term epoch history"; },
		async waitParticipant(...args: unknown[]) { calls.push(["wait", ...args]); return { status: "reached", state: args[2] }; },
		async interrupt(...args: unknown[]) { calls.push(["interrupt", ...args]); },
		async stop(...args: unknown[]) { calls.push(["stop", ...args]); },
		async archive(...args: unknown[]) { calls.push(["archive", ...args]); },
		async termExec(...args: unknown[]) { calls.push(["exec", ...args]); },
		async termInput(...args: unknown[]) { calls.push(["input", ...args]); },
	};
	const tool = (name: string) => {
		const definition = buildTools(coordinator, "agent:caller").find((candidate) => candidate.name === name);
		assert.ok(definition);
		return definition;
	};
	await (tool("spawn").execute as any)("spawn-call", { kind: "term", name: "shell", inheritRead: false }, undefined, undefined, {});
	await (tool("spawn").execute as any)("agent-spawn-call", { prompt: "review" }, undefined, undefined, {});
	await (tool("spawn").execute as any)("legacy-spawn-call", { kind: "term", inheritWorkspaceRead: false }, undefined, undefined, {});
	await (tool("spawn").execute as any)("precedence-spawn-call", { kind: "term", inheritRead: true, inheritWorkspaceRead: false }, undefined, undefined, {});
	assert.match(tool("spawn").description, /net:tcp\/dns\/example\.com:443/);
	assert.doesNotMatch(tool("spawn").description, /web:/);
	await (tool("listen").execute as any)("listen-call", { agent: "term:one" }, undefined, undefined, {});
	const logged = await (tool("log").execute as any)("log-call", { target: "term:one" }, undefined, undefined, {});
	assert.equal(logged.content[0]?.text, "term epoch history");
	await (tool("wait").execute as any)("wait-call", { participant: "term:one", state: "stopped" }, undefined, undefined, {});
	await (tool("interrupt").execute as any)("interrupt-call", { participant: "term:one" }, undefined, undefined, {});
	await (tool("stop").execute as any)("stop-call", { participant: "term:one" }, undefined, undefined, {});
	await (tool("exec").execute as any)("exec-call", { participant: "term:one", command: "sleep 1" }, undefined, undefined, {});
	await (tool("input").execute as any)("input-call", { participant: "term:one", data: "yes\n" }, undefined, undefined, {});
	await (tool("archive").execute as any)("archive-call", { participant: "term:one" }, undefined, undefined, {});
	assert.deepEqual(calls, [
		["spawn", "agent:caller", { kind: "term", name: "shell", prompt: undefined, resources: [], inheritRead: false, cwd: process.cwd(), origin: "model" }],
		["spawn", "agent:caller", { kind: "agent", name: undefined, prompt: "review", resources: [], inheritRead: true, cwd: process.cwd(), origin: "model" }],
		["spawn", "agent:caller", { kind: "term", name: undefined, prompt: undefined, resources: [], inheritRead: false, cwd: process.cwd(), origin: "model" }],
		["spawn", "agent:caller", { kind: "term", name: undefined, prompt: undefined, resources: [], inheritRead: true, cwd: process.cwd(), origin: "model" }],
		["listen", "agent:caller", "term:one", { after: undefined, wait: undefined, signal: undefined }],
		["log", "agent:caller", "term:one"],
		["wait", "agent:caller", "term:one", "stopped"],
		["interrupt", "agent:caller", "term:one"],
		["stop", "agent:caller", "term:one"],
		["exec", "agent:caller", "term:one", "sleep 1"],
		["input", "agent:caller", "term:one", "yes\n"],
		["archive", "agent:caller", "term:one"],
	]);
	await assert.rejects((tool("listen").execute as any)("bad", { participant: "term:one", agent: "agent:other" }, undefined, undefined, {}), /same target/);
});

test("give keeps the legacy grant mode while describing File/Net use projections", async () => {
	const calls: unknown[][] = [];
	const coordinator: any = {
		authority: { workspace: process.cwd() },
		beginTool() {}, endTool() {},
		async give(caller: string, target: string, resource: string, cwd: string) {
			calls.push([caller, target, resource, cwd]);
			return { mode: "read", targetId: target, moved: [resource.slice(1)] };
		},
		async appendCheckpointAfterCommit() { return {}; },
	};
	const give = buildTools(coordinator, "agent:caller").find((tool) => tool.name === "give")!;
	assert.match(give.description, /use projection \(File read, Net connect\)/);
	for (const resource of ["&file:./", "&net:tcp/dns/example.com:443"]) {
		const result = await (give.execute as any)("give-call", { participant: "agent:child", resource }, undefined, undefined, {});
		assert.equal(result.content[0].text, `Granted use projection on ${resource.slice(1)} to agent:child`);
		assert.deepEqual(result.details, { mode: "read", targetId: "agent:child", moved: [resource.slice(1)] });
	}
	assert.deepEqual(calls, [
		["agent:caller", "agent:child", "&file:./", process.cwd()],
		["agent:caller", "agent:child", "&net:tcp/dns/example.com:443", process.cwd()],
	]);
});

test("Fixed Agent tools advertise and dispatch only Term spawn", async () => {
	const calls: unknown[][] = [];
	const coordinator: any = {
		authority: { workspace: process.cwd() },
		isAgentSpawnEnabled: () => false,
		beginTool() {}, endTool() {},
		async appendCheckpointAfterCommit() { return {}; },
		spawnOutcome() { return undefined; },
		async spawnParticipant(...args: unknown[]) { calls.push(args); return "term:fixed"; },
	};
	const spawn = buildTools(coordinator, "agent:fixed").find((tool) => tool.name === "spawn");
	assert.ok(spawn);
	const properties = (spawn.parameters as any).properties;
	assert.deepEqual(Object.keys(properties).sort(), ["inheritRead", "inheritWorkspaceRead", "kind", "name", "resources", "rootDir"]);
	assert.equal(properties.kind.anyOf?.[0]?.const ?? properties.kind.const, "term");
	assert.match(spawn.description, /net:tcp\/dns\/example\.com:443/);
	assert.doesNotMatch(spawn.description, /web:/);
	await (spawn.execute as any)("spawn-fixed", {}, undefined, undefined, {});
	assert.deepEqual(calls, [["agent:fixed", {
		kind: "term", name: undefined, resources: [], inheritRead: true, cwd: process.cwd(), origin: "model",
	}]]);
});

test("Linden read and Bash tool results retain Pi's bounded output contract", async () => {
	const readContent = Array.from({ length: 3_000 }, (_, index) => `read-line-${index}`).join("\n");
	const bashContent = Array.from({ length: 3_000 }, (_, index) => `bash-line-${index}`).join("\n");
	const coordinator: any = {
		authority: {
			workspace: process.cwd(),
			async readFileBytes() { return { state: "Present", path: "/fixture", resourceId: "file:/fixture", content: Buffer.from(readContent) }; },
			async bash() { return { output: bashContent, exitCode: 0, changedResources: [], notices: [] }; },
		},
		isAgentSpawnEnabled: () => true,
		beginTool() {}, endTool() {},
		async appendCheckpointAfterCommit() { return {}; },
	};
	const tools = buildTools(coordinator, "agent:bounded");
	const read = tools.find((tool) => tool.name === "read")!;
	const bash = tools.find((tool) => tool.name === "bash")!;
	const readResult = await (read.execute as any)("read-bounded", { path: "/fixture" });
	const bashResult = await (bash.execute as any)("bash-bounded", { command: "fixture" }, undefined, undefined);
	assert.match(readResult.content[0].text, /Use offset=/);
	assert.match(bashResult.content[0].text, /earlier Bash output was truncated/);
	assert.ok(Buffer.byteLength(readResult.content[0].text) < 55 * 1024);
	assert.ok(Buffer.byteLength(bashResult.content[0].text) < 55 * 1024);
});

test("Pi tools resolve relative files, Bash, transfers, and children from the session cwd instead of the immutable base", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-pi-cwd-base-"));
	const cwd = join(base, "app");
	mkdirSync(cwd);
	const bashCalls: unknown[] = [];
	const spawnCalls: unknown[] = [];
	const giveCalls: unknown[] = [];
	try {
		const manager = await SessionAuthorityManager.open({ base, stateDir: join(base, ".linden-test") });
		const participantId = manager.rootParticipantId;
		await manager.writeFile(participantId, join(cwd, "relative.txt"), "cwd-content");
		const coordinator: any = {
			authority: {
				...manager,
				workspace: base,
				readFileBytes: manager.readFileBytes.bind(manager),
				bash: async (...args: unknown[]) => { bashCalls.push(args); return { output: "ok", exitCode: 0, changedResources: [], notices: [] }; },
			},
			runtimes: new Map(),
			beginTool() {}, endTool() {},
			async appendCheckpointAfterCommit() {},
			spawnOutcome() { return undefined; },
			async spawnParticipant(...args: unknown[]) { spawnCalls.push(args); return "term:cwd"; },
			async give(...args: unknown[]) { giveCalls.push(args); return { targetId: "agent:child", mode: "read", moved: ["file:cwd"] }; },
		};
		const tools = buildTools(coordinator, participantId, cwd);
		const read = tools.find((tool) => tool.name === "read")!;
		const bash = tools.find((tool) => tool.name === "bash")!;
		const spawn = tools.find((tool) => tool.name === "spawn")!;
		const give = tools.find((tool) => tool.name === "give")!;
		assert.match((await (read.execute as any)("read", { path: "relative.txt" })).content[0].text, /cwd-content/);
		await (bash.execute as any)("bash", { command: "pwd", timeout: 17 }, undefined, undefined);
		await (spawn.execute as any)("spawn", { kind: "term" });
		await (give.execute as any)("give", { participant: "agent:child", resource: "&file:relative.txt" });
		assert.equal((bashCalls[0] as any[])[2].cwd, cwd);
		assert.equal((bashCalls[0] as any[])[2].timeout, 17);
		assert.equal((spawnCalls[0] as any[])[1].cwd, cwd);
		assert.equal((giveCalls[0] as any[])[3], cwd);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("attached colon commands inspect the current Agent and expose no implicit Human controls", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands: string[] = [];
	const fake: any = { registerTool() {}, registerCommand(name: string) { commands.push(name); }, registerFlag() {}, on(name: string, handler: any) { handlers.set(name, handler); }, getFlag() { return ""; } };
	const notices: string[] = [];
	const viewers: string[] = [];
	const context: any = { ui: { notify(text: string) { notices.push(text); }, setStatus() {}, theme: { fg: (_: string, text: string) => text } } };
	const original = PiCoordinator.create;
	(PiCoordinator as any).create = async () => ({ authority: { sessionParticipantId: "agent:attached", rootParticipantId: "human:root" }, setToolFactory() {}, setContext() {}, async activateSessionMailbox() {}, describeAuthority(viewer: string) { viewers.push(viewer); return "Agent authority"; } });
	try {
		lindenExtension(fake);
		await handlers.get("session_start")!({}, context);
		assert.deepEqual(await handlers.get("input")!({ text: ":authority" }, context), { action: "handled" });
		assert.deepEqual(viewers, ["agent:attached"]);
		await handlers.get("input")!({ text: ":spawn worker" }, context);
		assert.match(notices.at(-1)!, /Human workspace commands belong to linden CLI/);
		assert.deepEqual(commands, []);
	} finally { (PiCoordinator as any).create = original; }
});

test("every Linden tool checks the interrupt gate before starting", async () => {
	const coordinator: any = {
		authority: { workspace: process.cwd() },
		beginTool() { throw new Error("steering gate"); },
		endTool() { throw new Error("tool unexpectedly started"); },
	};
	const participants = buildTools(coordinator, "agent:child").find((tool) => tool.name === "participants");
	assert.ok(participants);
	assert.deepEqual(Object.keys((participants.parameters as any).properties), []);
	await assert.rejects((participants.execute as any)("call", {}, undefined, undefined, {}), /steering gate/);
});

test("Pi edit adapter applies edits[] atomically against the original file", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-edit-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const participantId = manager.rootParticipantId;
		const initial = await manager.writeFile(participantId, "edit.txt", "alpha\nmiddle\nomega\n");
		const coordinator: any = {
			authority: manager,
			beginTool() {},
			endTool() {},
			async appendCheckpoint() {},
			async appendCheckpointAfterCommit() {},
		};
		const edit = buildTools(coordinator, participantId).find((tool) => tool.name === "edit");
		assert.ok(edit);
		await (edit.execute as any)("edit-call", {
			path: "edit.txt",
			edits: [
				{ oldText: "alpha", newText: "first" },
				{ oldText: "omega", newText: "last" },
			],
		}, undefined, undefined, {});
		assert.equal((await manager.readFile(participantId, "edit.txt")).content, "first\nmiddle\nlast\n");
		assert.equal(manager.resourceLog(participantId, initial.resourceId).length, 3, "the edits[] batch creates one File version");
		await assert.rejects((edit.execute as any)("bad-edit", {
			path: "edit.txt",
			edits: [{ oldText: "missing", newText: "never" }],
		}, undefined, undefined, {}), /Edit match was not found/);
		assert.equal((await manager.readFile(participantId, "edit.txt")).content, "first\nmiddle\nlast\n");
		assert.equal(manager.resourceLog(participantId, initial.resourceId).length, 3, "a rejected batch does not create a version");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("parent-to-child tools resolve a unique Pi session suffix before authority and runtime lookup", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-ref-"));
	let coordinator: any;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "01a009e7-root", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await manager.give(manager.rootParticipantId, parent, manager.baseResourceId());
		const childSession = "01a009e7-8e05-7a21-b336-157d1230018c";
		const child = `agent:${childSession}`;
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: childSession }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		coordinator.scheduleFollowUpFlush = () => undefined;
		const fakeRuntime = (participantId: string) => {
			let payload: unknown;
			return {
				participantId,
				entries: () => [],
				leafId: () => null,
				isRunning: () => false,
				abort: async () => undefined,
				appendEntry: async (_type: string, data: unknown) => { payload = data; return "pi:payload"; },
				setLabel: () => undefined,
				readPayload: () => payload,
				deliverBatch: async () => undefined,
				summary: () => participantId,
			};
		};
		coordinator.runtimes.set(parent, fakeRuntime(parent));
		coordinator.runtimes.set(child, fakeRuntime(child));
		coordinator.appendCheckpoint = async () => undefined;
		const suffix = "1230018c";
		const listened = await coordinator.listen(parent, suffix);
		assert.match(listened, new RegExp(child));
		assert.match(listened, /kind=Agent lifecycle=stopped/);
		assert.match(await coordinator.formatAgentLog(parent, suffix), /Current branch: main[\s\S]*No Pi entries\./);
		const messageId = await coordinator.send(parent, suffix, "hello");
		assert.equal(manager.pendingMessages(child)[0]?.id, messageId);
		const exact = await manager.file(parent, manager.baseResourceId(), "delegated.txt", "write");
		const give = buildTools(coordinator, parent).find((tool) => tool.name === "give");
		assert.ok(give);
		await (give.execute as any)("give-call", { agent: suffix, resource: exact.resourceId }, undefined, undefined, {});
		assert.equal(manager.resource(exact.resourceId)?.ownerId, child, "give completes the transfer atomically");
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a second steering Message waits for acknowledgment of the first delivery batch", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-steer-fifo-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "steer-parent", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:steer-fifo-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "steer-fifo-child" }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		const payloads = new Map<string, MailPayload>();
		const batches: Array<{ batchId: string; kind: string; messages: Array<{ id: string }> }> = [];
		const runtime = (participantId: string, deliver = false) => ({
			participantId,
			entries: () => [],
			leafId: () => null,
			isRunning: () => false,
			abort: async () => undefined,
			appendEntry: async (_type: string, data: MailPayload) => {
				const id = `entry:${data.messageId}`;
				payloads.set(id, data);
				return id;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async (batch: { batchId: string; kind: string; messages: Array<{ id: string }> }) => { if (deliver) batches.push(batch); },
			summary: () => participantId,
		});
		activeCoordinator.runtimes.set(parent, runtime(parent) as any);
		activeCoordinator.runtimes.set(child, runtime(child, true) as any);

		const first = await activeCoordinator.steer(parent, child, "first");
		const second = await activeCoordinator.steer(parent, child, "second");
		assert.equal(batches.length, 1, "the second Message remains pending while the first batch is reserved");
		assert.throws(() => activeCoordinator.beginTool(child), /steering is pending/);

		const acknowledge = async (batch: typeof batches[number]) => activeCoordinator.handleRuntimeMessage(child, {
			role: "custom",
			customType: MAIL_BATCH,
			details: { kind: MAIL_BATCH, batchId: batch.batchId, messageKind: batch.kind, messageIds: batch.messages.map((message) => message.id) },
		});
		assert.equal(batches[0].messages[0].id, first);
		await acknowledge(batches[0]);
		assert.equal(batches.length, 2, "acknowledgment triggers delivery of the waiting steering Message");
		assert.equal(batches[1].messages[0].id, second);
		await acknowledge(batches[1]);
		assert.deepEqual(manager.pendingMessages(child, undefined, "steering"), []);
		activeCoordinator.beginTool(child);
		activeCoordinator.endTool(child);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("busy follow-ups wait on agent_end without a polling timer", { timeout: 2_000 }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-followup-event-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "followup-event-parent", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:followup-event-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "followup-event-child" }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		const payloads = new Map<string, MailPayload>();
		let childRunning = true;
		let deliveries = 0;
		let resolveDelivery!: () => void;
		const delivered = new Promise<void>((resolvePromise) => { resolveDelivery = resolvePromise; });
		const runtime = (participantId: string, target = false) => ({
			participantId,
			entries: () => [],
			leafId: () => null,
			isRunning: () => target && childRunning,
			abort: async () => undefined,
			appendEntry: async (_type: string, data: any) => {
				if (data.messageId) {
					const id = `entry:${data.messageId}`;
					payloads.set(id, data);
					return id;
				}
				return `checkpoint:${participantId}:${Date.now()}`;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async () => { if (target) { deliveries += 1; resolveDelivery(); } },
			summary: () => participantId,
		});
		activeCoordinator.runtimes.set(parent, runtime(parent) as any);
		activeCoordinator.runtimes.set(child, runtime(child, true) as any);
		await manager.setParticipantStatus(child, "running");

		await activeCoordinator.send(parent, child, "deliver after this turn");
		assert.equal((activeCoordinator as any).followUpTimers.size, 0, "a busy Agent does not receive a 25 ms polling timer");
		assert.equal((activeCoordinator as any).followUpsWaitingForIdle.has(child), true);
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
		assert.equal(deliveries, 0);

		childRunning = false;
		await activeCoordinator.handleAgentEnd(child);
		await Promise.race([
			delivered,
			new Promise((_, reject) => setTimeout(() => reject(new Error("follow-up was not delivered after agent_end")), 1_000)),
		]);
		assert.equal(deliveries, 1);
		assert.equal((activeCoordinator as any).followUpsWaitingForIdle.has(child), false);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("incoming ordinary mail interrupts an Agent wait without consuming the message", { timeout: 2_000 }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-wait-message-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "wait-message-parent", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:wait-message-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "wait-message-child" }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		const payloads = new Map<string, MailPayload>();
		const runtime = (participantId: string) => ({
			participantId,
			entries: () => [],
			leafId: () => null,
			isRunning: () => true,
			abort: async () => undefined,
			appendEntry: async (_type: string, data: MailPayload) => {
				const id = `entry:${data.messageId}`;
				payloads.set(id, data);
				return id;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async () => undefined,
			summary: () => participantId,
		});
		activeCoordinator.runtimes.set(parent, runtime(parent) as any);
		activeCoordinator.runtimes.set(child, runtime(child) as any);
		await manager.setParticipantStatus(parent, "running");
		await manager.setParticipantStatus(child, "running");

		const waiting = activeCoordinator.waitParticipant(parent, child, "ready");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		const messageId = await activeCoordinator.send(child, parent, "need write authority");
		const outcome = await Promise.race([
			waiting,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("message did not interrupt wait")), 1_000)),
		]);
		assert.deepEqual(outcome, { status: "interrupted", reason: "message", messageIds: [messageId] });
		assert.deepEqual(manager.pendingMessages(parent).map((message) => message.id), [messageId], "wait must not consume mail");
		assert.equal((activeCoordinator as any).activeParticipantWaits.has(parent), false, "settled waits release their interrupt listener");

		const received = await activeCoordinator.receive(parent);
		assert.deepEqual(received.map((message) => message.payload), ["need write authority"]);

		const pendingId = await activeCoordinator.send(child, parent, "already pending");
		const alreadyPending = await activeCoordinator.waitParticipant(parent, child, "ready");
		assert.deepEqual(alreadyPending, { status: "interrupted", reason: "message", messageIds: [pendingId] });
		await activeCoordinator.receive(parent);

		const abort = new AbortController();
		const externallyAborted = activeCoordinator.waitParticipant(parent, child, "ready", abort.signal);
		abort.abort();
		await assert.rejects(externallyAborted, /Participant wait aborted/);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("wait tool tells the Agent to receive after a message interruption", async () => {
	const coordinator: any = {
		authority: { workspace: process.cwd() },
		beginTool() {}, endTool() {},
		async waitParticipant() { return { status: "interrupted", reason: "message", messageIds: ["msg:one"] }; },
	};
	const wait = buildTools(coordinator, "agent:manager").find((tool) => tool.name === "wait");
	assert.ok(wait);
	const result = await (wait.execute as any)("wait-call", { participant: "agent:worker", state: "ready" }, undefined, undefined, {});
	assert.match(result.content[0]?.text, /call receive now/);
	assert.deepEqual(result.details.messageIds, ["msg:one"]);
});

test("a rejected steering delivery keeps the tool gate closed and retries with backoff", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-steer-retry-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "steer-retry-parent", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:steer-retry-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "steer-retry-child" }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		const payloads = new Map<string, MailPayload>();
		let attempts = 0;
		let retriedBatch: any;
		let resolveRetry!: () => void;
		const retry = new Promise<void>((resolvePromise) => { resolveRetry = resolvePromise; });
		const runtime = (participantId: string, target = false) => ({
			participantId,
			entries: () => [],
			leafId: () => null,
			isRunning: () => false,
			abort: async () => undefined,
			appendEntry: async (_type: string, data: MailPayload) => {
				const id = `entry:${data.messageId}`;
				payloads.set(id, data);
				return id;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async (batch: any) => {
				if (!target) return;
				attempts += 1;
				if (attempts === 1) throw new Error("transient delivery failure");
				retriedBatch = batch;
				resolveRetry();
			},
			summary: () => participantId,
		});
		activeCoordinator.runtimes.set(parent, runtime(parent) as any);
		activeCoordinator.runtimes.set(child, runtime(child, true) as any);

		await activeCoordinator.steer(parent, child, "retry me");
		assert.throws(() => activeCoordinator.beginTool(child), /steering is pending/);
		await Promise.race([
			retry,
			new Promise((_, reject) => setTimeout(() => reject(new Error("steering delivery was not retried")), 1_000)),
		]);
		assert.equal(attempts, 2);
		await activeCoordinator.handleRuntimeMessage(child, {
			role: "custom",
			customType: MAIL_BATCH,
			details: { kind: MAIL_BATCH, batchId: retriedBatch.batchId, messageKind: retriedBatch.kind, messageIds: retriedBatch.messages.map((message: any) => message.id) },
		});
		activeCoordinator.beginTool(child);
		activeCoordinator.endTool(child);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("destructive archive cancels queued follow-up delivery and consumes subtree Messages", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-archive-mail-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "archive-mail-parent", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		const child = "agent:archive-mail-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "archive-mail-child" }));
		const activeCoordinator: PiCoordinator = new (PiCoordinator as any)({}, manager, {});
		coordinator = activeCoordinator;
		const payloads = new Map<string, MailPayload>();
		let deliveries = 0;
		const runtime = (participantId: string, target = false) => ({
			participantId,
			entries: () => [],
			leafId: () => null,
			isRunning: () => false,
			abort: async () => undefined,
			appendEntry: async (_type: string, data: MailPayload) => {
				const id = `entry:${data.messageId}`;
				payloads.set(id, data);
				return id;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async () => { if (target) deliveries += 1; },
			summary: () => participantId,
		});
		activeCoordinator.runtimes.set(parent, runtime(parent) as any);
		activeCoordinator.runtimes.set(child, runtime(child, true) as any);

		const messageId = await activeCoordinator.send(parent, child, "removed with archived subtree");
		await activeCoordinator.archive(parent, child);
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));

		assert.equal(deliveries, 0);
		assert.equal(manager.participant(child), undefined);
		assert.equal(manager.snapshot().messages[messageId], undefined);
		assert.throws(() => manager.pendingMessages(child), /Unknown participant/);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("lazy restore is single-flight and delivers pending mail from a cold sender without restoring it", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-pi-lazy-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		const sessionDirectory = join(manager.stateDir, "pi-sessions");
		const senderSession = (coordinator as any).createPersistedSessionManager(sessionDirectory, undefined);
		const sender = `agent:${senderSession.getSessionId()}`;
		await manager.spawnWith(human, sender, "sender", [], async () => ({ piSessionId: senderSession.getSessionId(), sessionFile: senderSession.getSessionFile() }));
		const targetSession = (coordinator as any).createPersistedSessionManager(sessionDirectory, senderSession.getSessionId());
		const target = `agent:${targetSession.getSessionId()}`;
		await manager.spawnWith(sender, target, "target", [], async () => ({ piSessionId: targetSession.getSessionId(), sessionFile: targetSession.getSessionFile() }));
		const pending = await manager.sendWithPayload(sender, target, async (messageId) => senderSession.appendCustomEntry("linden-mail-payload", { messageId, senderId: sender, payload: "persisted while both runtimes are cold" }));

		const restored: string[] = [];
		let delivered: any;
		let resolveDelivery!: (message: any) => void;
		const delivery = new Promise<any>((resolvePromise) => { resolveDelivery = resolvePromise; });
		coordinator.setHostedRuntimeFactory(async (participantId, sessionManager) => {
			restored.push(participantId);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
			const session: any = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				sessionManager,
				sessionName: "target",
				isStreaming: false,
				subscribe() {},
				async abort() {},
				async sendCustomMessage(message: any) { delivered = message; resolveDelivery(message); },
				async navigateTree() { return { cancelled: false }; },
				dispose() {},
			};
			return { session, async dispose() {} } as any;
		});

		await Promise.all([
			coordinator.listen(human, target),
			coordinator.formatAgentLog(sender, target),
			coordinator.restoreParticipant(target),
		]);
		assert.deepEqual(restored, [target], "concurrent first use creates one target runtime");
		assert.ok(!coordinator.runtimes.has(sender), "read-only first use does not restore the sender");
		assert.equal(manager.pendingMessages(target).length, 1, "listen/log attach without activating pending mail");

		await coordinator.prepareAttach(human, target);
		await Promise.race([
			delivery,
			new Promise((_, reject) => setTimeout(() => reject(new Error("pending mail was not delivered")), 1_000)),
		]);
		assert.deepEqual(restored, [target], "cold payload decoding does not create a sender runtime");
		assert.match(delivered.content, /persisted while both runtimes are cold/);
		assert.equal(manager.snapshot().messages[pending.id]?.consumedAt, undefined, "delivery claim is not consumption");
		await coordinator.handleRuntimeMessage(target, { role: "custom", customType: delivered.customType, details: delivered.details });
		assert.ok(manager.snapshot().messages[pending.id]?.consumedAt, "message_start acknowledgment consumes the batch once");
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
