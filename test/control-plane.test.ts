import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LINDEN_CLI_HELP, parseCliOptions, parseShellWords, parseSpawn } from "../src/cli.js";
import { SessionAuthorityManager } from "../src/authority/manager.js";
import { parseHumanSpawn } from "../src/pi/extension.js";
import { parseParticipantPayloadCommand } from "../src/pi/human-command.js";
import { formatParticipants } from "../src/pi/participants.js";
import { PiCoordinator, type MailPayload } from "../src/pi/runtime.js";

test("global CLI symlink starts Linden from another directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "linden-global-cli-"));
	try {
		const entry = join(directory, "linden");
		symlinkSync(fileURLToPath(new URL("../src/cli.js", import.meta.url)), entry);
		const result = spawnSync(process.execPath, [entry, "--help"], { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Linden control plane/);
		assert.match(result.stdout, /Usage: linden/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("control-plane parsing keeps shell commands isolated and parses explicit spawn grants", () => {
	assert.match(LINDEN_CLI_HELP, /:log <resource-or-participant>/);
	assert.match(LINDEN_CLI_HELP, /:rewind <agent> <state-id>/);
	assert.match(LINDEN_CLI_HELP, /:participants\s+show Human/);
	assert.doesNotMatch(LINDEN_CLI_HELP, /:participants \[all\]/);
	assert.deepEqual(parseShellWords('spawn "review agent" --give file:C:/repo/'), ["spawn", "review agent", "--give", "file:C:/repo/"]);
	assert.deepEqual(parseSpawn(["review", "--give", "file:one", "--give", "&file:C:/repo/src/", "--no-cwd-read"]), {
		kind: "agent",
		name: "review",
		grants: ["file:one", "&file:C:/repo/src/"],
		inheritWorkspaceRead: false,
	});
	assert.deepEqual(parseSpawn(["--give", "file:./", "shell", "--kind", "term"]), {
		kind: "term",
		name: "shell",
		grants: ["file:./"],
		inheritWorkspaceRead: true,
	});
	assert.deepEqual(parseHumanSpawn(["worker", "--", "inspect", "the", "tree"]), {
		kind: "agent",
		name: "worker",
		prompt: "inspect the tree",
		grants: [],
		inheritWorkspaceRead: true,
	});
	assert.deepEqual(parseHumanSpawn(["--kind", "term", "shell", "--give", "file:./"]), {
		kind: "term",
		name: "shell",
		prompt: undefined,
		grants: ["file:./"],
		inheritWorkspaceRead: true,
	});
	assert.equal(parseCliOptions(["--workspace", "deadbeef"])?.session, "deadbeef");
	assert.equal(parseCliOptions([".", "--workspace", "deadbeef"])?.base, realpathSync.native(process.cwd()));
	assert.equal(parseCliOptions(["--max-agent-depth", "3"])?.maxAgentDepth, 3);
	assert.throws(() => parseCliOptions(["--max-agent-depth", "0"]), /positive integer/);
	assert.throws(() => parseCliOptions(["--max-agent-depth", "1.5"]), /positive integer/);
	assert.throws(() => parseShellWords('"unterminated'), /Unterminated/);
	assert.throws(() => parseSpawn(["--write", "file:C:/repo/"]), /Unknown :spawn option/);
	assert.throws(() => parseSpawn(["--kind", "human"]), /agent or term/);
	assert.throws(() => parseHumanSpawn(["--kind"]), /agent or term/);
});

test("Human participant payload commands preserve the raw tail", () => {
	assert.deepEqual(parseParticipantPayloadCommand(`exec term:one printf '%s  x' "$HOME"  `), {
		action: "exec",
		target: "term:one",
		payload: `printf '%s  x' "$HOME"  `,
		hasPayloadSeparator: true,
	});
	assert.deepEqual(parseParticipantPayloadCommand(`input term:one  leading\\n  `), {
		action: "input",
		target: "term:one",
		payload: ` leading\\n  `,
		hasPayloadSeparator: true,
	});
	assert.deepEqual(parseParticipantPayloadCommand("inputln term:one"), {
		action: "inputln",
		target: "term:one",
		payload: "",
		hasPayloadSeparator: false,
	});
});

test("participants uses one human-inclusive tree format with relative relationship labels", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-participants-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = "agent:parent-session";
		const child = "agent:child-session";
		await manager.spawnWith(human, parent, "src", [], async () => ({ piSessionId: "parent-session" }));
		await manager.spawnWith(parent, child, "ui", [], async () => ({ piSessionId: "child-session" }));
		const fromHuman = formatParticipants(manager.snapshot(), human);
		assert.match(fromHuman, new RegExp(`${human.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\) \\| self \\|`));
		assert.match(fromHuman, /src\(agent:parent-session\) \| child \|/);
		assert.match(fromHuman, /ui\(agent:child-session\) \| descendant \|/);
		const fromParent = formatParticipants(manager.snapshot(), parent);
		assert.match(fromParent, /\| parent \|/);
		assert.match(fromParent, /src\(agent:parent-session\) \| self \|/);
		assert.match(fromParent, /ui\(agent:child-session\) \| child \|/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Agent-to-Human send stays in the Human mailbox without restoring or activating an Agent", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-mailbox-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const agent = "agent:mailbox-session";
		await manager.spawnWith(human, agent, "review", [], async () => ({ piSessionId: "mailbox-session" }));
		coordinator = PiCoordinator.createStandalone(manager);
		const payloads = new Map<string, MailPayload>();
		coordinator.runtimes.set(agent, {
			participantId: agent,
			piSessionId: "mailbox-session",
			entries: () => [],
			leafId: () => null,
			isRunning: () => false,
			abort: async () => undefined,
			appendEntry: async <T>(_type: string, data: T) => {
				const payload = data as MailPayload;
				const id = `entry:${payload.messageId}`;
				payloads.set(id, payload);
				return id;
			},
			setLabel: () => undefined,
			readPayload: (id: string) => payloads.get(id),
			deliverBatch: async () => undefined,
			summary: () => agent,
			displayName: () => "review",
		});
		let restoreCalls = 0;
		let activationCalls = 0;
		const restoreParticipant = coordinator.restoreParticipant.bind(coordinator);
		const activateMailbox = (coordinator as any).activateMailbox.bind(coordinator);
		(coordinator as any).restoreParticipant = async () => { restoreCalls += 1; throw new Error("Human targets must not be restored as Agents"); };
		(coordinator as any).activateMailbox = async () => { activationCalls += 1; throw new Error("Human targets must not be activated as Agents"); };
		const messageId = await coordinator.send(agent, human, "complete report");
		assert.equal(restoreCalls, 0);
		assert.equal(activationCalls, 0);
		(coordinator as any).restoreParticipant = restoreParticipant;
		(coordinator as any).activateMailbox = activateMailbox;
		assert.equal(coordinator.peekMailbox(human)[0]?.id, messageId);
		assert.equal(coordinator.peekMailbox(human)[0]?.payload, "complete report");
		assert.equal(manager.pendingMessages(human).length, 1, "listing must not consume mail");
		const prepared = await coordinator.prepareAttach(human, agent);
		assert.deepEqual(prepared.consumed.map((message) => message.id), [messageId]);
		assert.deepEqual(manager.pendingMessages(human), []);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Human checkpoints are a no-op and never fabricate Agent history", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-human-checkpoint-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		let appendCalls = 0;
		(coordinator.runtimes.get(human) as any).appendEntry = async () => { appendCalls += 1; return "must-not-exist"; };
		const before = manager.snapshot();

		assert.equal(await coordinator.appendCheckpoint(human, "human-command"), undefined);
		assert.equal(appendCalls, 0);
		const after = manager.snapshot();
		assert.deepEqual(after.checkpoints, before.checkpoints);
		assert.deepEqual(after.agentStates, before.agentStates);
		assert.deepEqual(after.currentAgentStateIds, before.currentAgentStateIds);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("process state saves the active agent set and reloads it for the next Linden process", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-process-state-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		await manager.spawnWith(human, "agent:state-one", "one", [], async () => ({ piSessionId: "state-one" }));
		await manager.spawnWith(human, "agent:state-two", "two", [], async () => ({ piSessionId: "state-two" }));
		manager.saveProcessState(["agent:state-one", "agent:state-one"]);
		assert.deepEqual(manager.loadProcessState()?.activeAgents, ["agent:state-one"]);
		writeFileSync(manager.processStatePath, "{ not json");
		assert.equal(manager.loadProcessState(), undefined);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("archive requires a stopped subtree and permanently removes it from the participant tree", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-archive-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = "agent:archive-parent";
		const child = "agent:archive-child";
		await manager.spawnWith(human, parent, "src", [], async () => ({ piSessionId: "archive-parent" }));
		await manager.spawnWith(parent, child, "ui", [], async () => ({ piSessionId: "archive-child" }));
		await manager.setParticipantStatus(child, "running");
		await assert.rejects(() => manager.archiveParticipant(human, parent, () => true), /stopped/);
		await manager.setParticipantStatus(child, "stopped");
		await manager.setParticipantStatus(parent, "stopped");
		assert.deepEqual(new Set(await manager.archiveParticipant(human, parent, () => true)), new Set([parent, child]));
		assert.equal(manager.participant(parent), undefined);
		assert.equal(manager.participant(child), undefined);
		assert.ok(!formatParticipants(manager.snapshot(), human).includes("archive-parent"));
		await assert.rejects(() => manager.archiveParticipant(human, parent, () => true), /UNKNOWN_PARTICIPANT/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("get takes a child-owned resource back across the direct edge only", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-reclaim-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const parent = "agent:reclaim-parent";
		const child = "agent:reclaim-child";
		await manager.spawnWith(human, parent, "src", [], async () => ({ piSessionId: "reclaim-parent" }));
		await manager.spawnWith(parent, child, "ui", [], async () => ({ piSessionId: "reclaim-child" }));
		const baseResource = manager.baseResourceId();
		await manager.give(human, parent, baseResource);
		const nested = await manager.subpath(parent, baseResource, "nested", "write");
		await manager.give(parent, child, nested.resourceId);
		assert.equal(manager.resource(nested.resourceId)?.ownerId, child, "give completes the transfer immediately");
		// human is the grandparent of child: ownership transfer stays edge-scoped
		await assert.rejects(() => manager.get(human, child, nested.resourceId), /ROLE_MISMATCH/);
		const taken = await manager.get(parent, child, nested.resourceId);
		assert.ok(taken.includes(nested.resourceId));
		assert.equal(manager.resource(nested.resourceId)?.ownerId, parent);
		const recovered = await manager.get(human, parent, nested.resourceId);
		assert.ok(recovered.includes(nested.resourceId));
		assert.equal(manager.resource(nested.resourceId)?.ownerId, human);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
