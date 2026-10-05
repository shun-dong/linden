import assert from "node:assert/strict";
import test from "node:test";
import { StandalonePiHost } from "../src/pi/host.js";
import type { ParticipantRecord } from "../src/runtime/model.js";

test("standalone top-level Agent receives the complete birth topology on its first model turn", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: any[] = [{ type: "message", message: { role: "user", content: "start" } }];
	let tree = "tree before initial topology finished";
	const coordinator = {
		describeAuthority: () => "participant: agent:top-level",
		formatParticipantTreeBirthSnapshot: async () => `[Linden participant tree at Agent birth]\n${tree}`,
		isAgentSpawnEnabled: () => true,
	};
	const host = Object.assign(Object.create(StandalonePiHost.prototype), { coordinator }) as StandalonePiHost;
	const extension = (host as any).lindenExtension("agent:top-level", { getEntries: () => entries });
	extension({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } });
	tree = "root(human:root) | parent | stopped | none\n├── lead(agent:top-level) | self | stopped | none\n└── peer(agent:peer) | stopped | none";

	const first = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })).systemPrompt as string;
	assert.match(first, /Linden participant tree at Agent birth/);
	assert.match(first, /peer\(agent:peer\)/, "the snapshot is taken after the runner has finished constructing birth topology");
	assert.match(first, /Term participants do not consume Agent depth/);

	entries.push({ type: "message", message: { role: "assistant", content: [] } });
	const later = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })).systemPrompt as string;
	assert.doesNotMatch(later, /Linden participant tree at Agent birth/);
});

test("standalone host forwards Human control through the generic participant API", async () => {
	const calls: Array<{ name: string; arguments: unknown[] }> = [];
	const participants = new Map<string, ParticipantRecord>([
		["human:root", { id: "human:root", name: "root", kind: "human", status: "stopped", childIds: [], createdAt: 1 }],
	]);
	let activeWork = false;
	let saved: string[] = [];
	const coordinator = {
		runtimes: new Map(),
		spawnParticipant: async (...arguments_: unknown[]) => { calls.push({ name: "spawn", arguments: arguments_ }); return "term:shell"; },
		listenParticipant: async (...arguments_: unknown[]) => { calls.push({ name: "listen", arguments: arguments_ }); return "output"; },
		waitParticipant: async (...arguments_: unknown[]) => { calls.push({ name: "wait", arguments: arguments_ }); },
		interrupt: async (...arguments_: unknown[]) => { calls.push({ name: "interrupt", arguments: arguments_ }); },
		stop: async (...arguments_: unknown[]) => { calls.push({ name: "stop", arguments: arguments_ }); },
		archive: async (...arguments_: unknown[]) => { calls.push({ name: "archive", arguments: arguments_ }); },
		termExec: async (...arguments_: unknown[]) => { calls.push({ name: "exec", arguments: arguments_ }); },
		termInput: async (...arguments_: unknown[]) => { calls.push({ name: "input", arguments: arguments_ }); },
		resolveParticipantRef: (reference: string) => reference,
		hasActiveWork: () => activeWork,
	};
	const authority = {
		rootParticipantId: "human:root",
		base: "/workspace",
		participant: (id: string) => participants.get(id),
		listParticipants: () => [...participants.values()],
		saveProcessState: (ids: string[]) => { saved = ids; },
	};
	const host = Object.assign(Object.create(StandalonePiHost.prototype), {
		authority,
		coordinator,
		attachedParticipantId: undefined,
	}) as StandalonePiHost;

	assert.equal(await host.spawnParticipant({ kind: "term", name: "shell", grants: ["file:./"], cwd: "/workspace" }), "term:shell");
	assert.deepEqual(calls.shift(), {
		name: "spawn",
		arguments: ["human:root", {
			kind: "term",
			name: "shell",
			prompt: undefined,
			resources: ["file:./"],
			inheritRead: true,
			cwd: "/workspace",
			agentSpawnEnabled: true,
			origin: "runner",
		}],
	});
	assert.deepEqual(saved, []);
	assert.equal(await host.listenParticipant("term:shell"), "output");
	await host.waitParticipant("term:shell", "stopped");
	await host.interruptParticipant("term:shell");
	await host.stopParticipant("term:shell");
	await host.execTerm("term:shell", "pwd");
	await host.inputTerm("term:shell", "yes\n");
	await host.archiveParticipant("term:shell");
	assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [
		["listen", ["human:root", "term:shell"]],
		["wait", ["human:root", "term:shell", "stopped"]],
		["interrupt", ["human:root", "term:shell"]],
		["stop", ["human:root", "term:shell"]],
		["exec", ["human:root", "term:shell", "pwd"]],
		["input", ["human:root", "term:shell", "yes\n"]],
		["archive", ["human:root", "term:shell"]],
	]);

	assert.equal(host.isIdle(), true);
	participants.set("term:shell", { id: "term:shell", name: "shell", kind: "term", status: "ready", parentId: "human:root", childIds: [], createdAt: 2 });
	assert.equal(host.isIdle(), false, "ready can still retain background work");
	participants.get("term:shell")!.status = "stopped";
	activeWork = true;
	assert.equal(host.isIdle(), false, "the live runtime view closes lifecycle update races");
});

test("standalone attach restoration remains Agent-only", async () => {
	const coordinator = {
		runtimes: new Map(),
		resolveParticipantRef: (reference: string) => reference,
		restoreParticipant: async () => { throw new Error("must not restore a Term as Pi"); },
	};
	const authority = {
		participant: () => ({ id: "term:shell", name: "shell", kind: "term", status: "stopped", childIds: [], createdAt: 1 }),
	};
	const host = Object.assign(Object.create(StandalonePiHost.prototype), { authority, coordinator }) as StandalonePiHost;
	await assert.rejects(() => host.ensureRuntime("term:shell"), /no restorable Pi session/);
});
