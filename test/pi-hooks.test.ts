import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import lindenExtension from "../src/pi/extension.js";
import { StandalonePiHost } from "../src/pi/host.js";
import { COMPACT_FIXED_TEAM_RUNTIME_GUIDANCE, PiCoordinator, RUNTIME_GUIDANCE, toolNames, type RuntimeGuidanceProfile } from "../src/pi/runtime.js";

type Entrypoint = "extension" | "hosted";
type Handler = (event: any, context: any) => any;

async function hooks(t: TestContext, entrypoint: Entrypoint, profile: RuntimeGuidanceProfile = "full") {
	const participantId = `agent:${entrypoint}`;
	const handlers = new Map<string, Handler>();
	const notices: Array<[string, string]> = [];
	const statuses: unknown[][] = [];
	const entries: any[] = [];
	const hostedEntries: any[] = [];
	const calls: unknown[][] = [];
	const controls: { discoveryError?: unknown; shutdownError?: Error; agentSpawnEnabled: boolean } = { agentSpawnEnabled: true };
	let mode = "manual";
	const authorityText = "owned resources: file:/work/\nread pointers: &file:/shared/\neffective Net endpoints: net:tcp/public";
	const birthSnapshot = "[Linden participant tree at Agent birth]\nHuman, Agent, Term pointers; no resource or lifecycle control.";
	const coordinator: any = {
		authority: {
			sessionParticipantId: participantId,
			async setPermissionMode(id: string, value: string) { calls.push(["permission", id, value]); mode = value; },
			participant(id: string) { assert.equal(id, participantId); return { permissionMode: mode }; },
			async bash(...args: unknown[]) {
				calls.push(["bash", ...args]);
				(args[2] as any).onData(Buffer.from("streamed output"));
				return { exitCode: 7, notices: ["restricted filesystem"], output: "already streamed" };
			},
		},
		setContext(context: unknown) { calls.push(["context", context]); },
		setToolFactory() { calls.push(["tool-factory"]); },
		async activateSessionMailbox() { calls.push(["activate-mailbox"]); },
		describeAuthority(id: string) { calls.push(["authority", id]); return authorityText; },
		async formatParticipantTreeBirthSnapshot(id: string) { calls.push(["birth", id]); return birthSnapshot; },
		async discoverParticipantTree(id: string) {
			calls.push(["participants", id]);
			if (controls.discoveryError) throw controls.discoveryError;
			return "current participant tree";
		},
		isAgentSpawnEnabled() { return controls.agentSpawnEnabled; },
		async handleRuntimeMessage(...args: unknown[]) { calls.push(["message", ...args]); },
		async handleAgentStart(...args: unknown[]) { calls.push(["start", ...args]); },
		async handleAgentEnd(...args: unknown[]) { calls.push(["end", ...args]); },
		async dispose() { calls.push(["dispose"]); if (controls.shutdownError) throw controls.shutdownError; },
	};
	const context: any = {
		cwd: "/context-cwd",
		sessionManager: { getEntries: () => entries },
		ui: {
			notify(text: string, level: string) { notices.push([text, level]); },
			setStatus(...args: unknown[]) { statuses.push(args); },
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	const pi: any = {
		registerTool() {}, registerFlag() {}, getFlag: () => "",
		on(name: string, handler: Handler) {
			assert.equal(handlers.has(name), false, `${name} must be registered once`);
			handlers.set(name, handler);
		},
	};
	if (entrypoint === "extension") {
		t.mock.method(PiCoordinator, "create", async () => coordinator);
		lindenExtension(pi);
		await handlers.get("session_start")!({}, context);
	} else {
		const host = Object.assign(Object.create(StandalonePiHost.prototype), {
			coordinator, authority: coordinator.authority, runtimeGuidanceProfile: profile,
		});
		host.lindenExtension(participantId, { getEntries: () => hostedEntries })(pi);
	}
	const run = (name: string, event: any = {}) => handlers.get(name)!(event, context);
	return { run, handlers, context, participantId, calls, notices, statuses, entries, hostedEntries, controls, authorityText, birthSnapshot };
}

for (const entrypoint of ["extension", "hosted"] as const) {
	test(`${entrypoint} hooks block unmediated tools and retain the full authority/birth prompt`, async (t) => {
		const fixture = await hooks(t, entrypoint);
		for (const toolName of toolNames()) assert.equal(fixture.run("tool_call", { toolName }), undefined);
		assert.deepEqual(fixture.run("tool_call", { toolName: "ls" }), {
			block: true, reason: "Tool ls is not mediated by Linden authority",
		});
		// Hosted hooks intentionally inspect their captured SessionManager, not the
		// current extension context (which can refer to another Pi session).
		if (entrypoint === "hosted") fixture.entries.push({ type: "message", message: { role: "assistant" } });
		const heading = entrypoint === "hosted"
			? `Linden authority (the sole source of resource permissions):\nYou are participant ${fixture.participantId}.`
			: "Linden workspace authority (the sole source of resource permissions):";
		assert.deepEqual(await fixture.run("before_agent_start", { systemPrompt: "original prompt" }), {
			systemPrompt: `original prompt\n\n${heading}\n${fixture.authorityText}\nUse only the registered Linden gateways for files, Bash, messages, transfers, checkout, and child participants.\n\n${fixture.birthSnapshot}\n\n${RUNTIME_GUIDANCE}`,
		});
		(entrypoint === "hosted" ? fixture.hostedEntries : fixture.entries).push({ type: "message", message: { role: "assistant" } });
		const subsequent = await fixture.run("before_agent_start", { systemPrompt: "next prompt" });
		assert.equal(subsequent.systemPrompt.includes(fixture.birthSnapshot), false);
		assert.deepEqual(fixture.calls.filter(([kind]) => kind === "birth"), [["birth", fixture.participantId]]);
	});

	test(`${entrypoint} input hooks use Agent authority, preserve permission policy and command errors`, async (t) => {
		const fixture = await hooks(t, entrypoint);
		assert.deepEqual(await fixture.run("input", { text: "ordinary prompt" }), { action: "continue" });
		assert.deepEqual(await fixture.run("input", { text: ":authority" }), { action: "handled" });
		assert.deepEqual(fixture.notices.at(-1), [fixture.authorityText, "info"]);
		await fixture.run("input", { text: ":participants" });
		assert.deepEqual(fixture.notices.at(-1), ["current participant tree", "info"]);
		for (const mode of ["all-of-mine", "manual"]) {
			await fixture.run("input", { text: `:permission ${mode}` });
			assert.deepEqual(fixture.notices.at(-1), [mode, "info"]);
		}
		await fixture.run("input", { text: ":permission" });
		assert.deepEqual(fixture.notices.at(-1), ["manual", "info"]);
		assert.deepEqual(fixture.calls.filter(([kind]) => kind === "permission"), [
			["permission", fixture.participantId, "all-of-mine"], ["permission", fixture.participantId, "manual"],
		]);
		await fixture.run("input", { text: ":spawn worker" });
		assert.match(fixture.notices.at(-1)![0], entrypoint === "hosted" ? /\/exit detaches/ : /Human workspace commands belong to linden CLI/);
		fixture.controls.discoveryError = new Error("discovery denied");
		assert.deepEqual(await fixture.run("input", { text: ":participants" }), { action: "handled" });
		assert.deepEqual(fixture.notices.at(-1), ["discovery denied", "error"]);
		assert.equal(fixture.calls.some(([kind]) => kind === "context"), entrypoint === "extension");
	});

	test(`${entrypoint} user Bash stays mediated with its original cwd and sandbox-notice behavior`, async (t) => {
		const fixture = await hooks(t, entrypoint);
		const streamed: string[] = [];
		const signal = new AbortController().signal;
		const onData = (data: Buffer) => streamed.push(data.toString());
		const options = { onData, signal, timeout: 12, env: { TEST_ENV: "value" } };
		const operations = fixture.run("user_bash", { cwd: "/event-cwd", command: "ignored", excludeFromContext: true }).operations;
		assert.deepEqual(await operations.exec("printf output", "/operation-cwd", options), { exitCode: 7 });
		assert.deepEqual(fixture.calls.find(([kind]) => kind === "bash"), ["bash", fixture.participantId, "printf output", {
			...options, cwd: entrypoint === "hosted" ? "/operation-cwd" : fixture.context.cwd,
		}]);
		assert.deepEqual(streamed, ["streamed output"]);
		assert.deepEqual(fixture.notices, entrypoint === "hosted" ? [] : [["[Linden sandbox] restricted filesystem", "warning"]]);
	});
}

test("hosted hooks retain fixed-team guides and leave lifecycle subscriptions to the host adapter", async (t) => {
	for (const profile of ["full", "compact-fixed-team"] as const) {
		const fixture = await hooks(t, "hosted", profile);
		fixture.controls.agentSpawnEnabled = false;
		const prompt = (await fixture.run("before_agent_start", { systemPrompt: "base" })).systemPrompt;
		assert.ok(prompt.includes(profile === "full"
			? `${RUNTIME_GUIDANCE}\n- For this participant, additional Agent spawning is disabled; spawn accepts only Term.`
			: COMPACT_FIXED_TEAM_RUNTIME_GUIDANCE));
		assert.deepEqual(fixture.run("session_before_switch", { reason: "resume" }), { cancel: true });
		assert.deepEqual(fixture.run("session_before_fork"), { cancel: true });
		for (const event of ["session_start", "session_shutdown", "message_start", "agent_start", "agent_end"]) assert.equal(fixture.handlers.has(event), false);
	}
});

test("extension lifecycle stays lazy, routes runtime events and resets after shutdown failure", async (t) => {
	const fixture = await hooks(t, "extension");
	assert.deepEqual(fixture.calls, [["tool-factory"], ["activate-mailbox"]]);
	assert.deepEqual(fixture.statuses, [["linden", "linden:authority"]]);
	assert.equal(fixture.handlers.has("session_before_switch"), false);
	assert.equal(fixture.handlers.has("session_before_fork"), false);
	const message = { role: "custom", customType: "mail" };
	await fixture.run("message_start", { message });
	await fixture.run("agent_start");
	await fixture.run("agent_end");
	assert.deepEqual(fixture.calls.filter(([kind]) => ["message", "start", "end"].includes(String(kind))), [
		["message", fixture.participantId, message], ["start", fixture.participantId], ["end", fixture.participantId],
	]);
	fixture.controls.shutdownError = new Error("cleanup failed");
	await fixture.run("session_shutdown");
	assert.deepEqual(fixture.notices.at(-1), ["Linden shutdown warning: cleanup failed", "warning"]);
	assert.deepEqual(fixture.statuses.at(-1), ["linden", undefined]);
	await assert.rejects(fixture.run("input", { text: ":authority" }), /not initialized/);
	assert.throws(() => fixture.run("user_bash"), /not initialized/);
	await fixture.run("session_shutdown");
	assert.equal(fixture.calls.filter(([kind]) => kind === "dispose").length, 1);
});
