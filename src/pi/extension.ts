import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeMaxAgentDepth } from "../runtime/agent-depth.js";
import { parseParticipantPayloadCommand } from "./human-command.js";
import { participantCoordinator, type SpawnParticipantKind } from "./participant-api.js";
import { buildTools } from "./tools.js";
import { PiCoordinator, RUNTIME_GUIDANCE, needsParticipantTreeBirthSnapshot, toolNames } from "./runtime.js";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const parseDomains = (value: unknown): string[] => String(value ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
const parseMaxAgentDepth = (value: unknown): number | undefined => {
	const text = String(value ?? "").trim();
	return text ? normalizeMaxAgentDepth(Number(text), "--linden-max-agent-depth") : undefined;
};
const parseCommandLine = (value: string): string[] => (value.match(/(?:[^\s"' ]+|"[^"]*"|'[^']*')+/g) ?? []).map((item) => ((item.startsWith("\"") && item.endsWith("\"")) || (item.startsWith("'") && item.endsWith("'"))) ? item.slice(1, -1) : item);

export interface ParsedHumanSpawn {
	kind: SpawnParticipantKind;
	name?: string;
	prompt?: string;
	grants: string[];
	inheritWorkspaceRead: boolean;
}

export function parseHumanSpawn(rest: string[]): ParsedHumanSpawn {
	const separator = rest.indexOf("--");
	const options = separator < 0 ? rest : rest.slice(0, separator);
	const promptParts: string[] = separator < 0 ? [] : rest.slice(separator + 1);
	const grants: string[] = [];
	let kind: SpawnParticipantKind = "agent";
	let name: string | undefined;
	let inheritWorkspaceRead = true;
	for (let index = 0; index < options.length;) {
		const flag = options[index++];
		if (flag === "--kind") {
			const value = options[index++];
			if (value !== "agent" && value !== "term") throw new Error("--kind must be agent or term");
			kind = value;
			continue;
		}
		if (flag === "--no-inherit-read" || flag === "--no-cwd-read" || flag === "--no-workspace-read") {
			inheritWorkspaceRead = false;
			continue;
		}
		if (flag === "--give") {
			const resource = options[index++];
			if (!resource) throw new Error(`Missing resource after ${flag}`);
			grants.push(resource);
			continue;
		}
		if (flag.startsWith("--")) throw new Error(`Unknown spawn option ${flag}`);
		if (name === undefined) { name = flag; continue; }
		if (separator < 0) { promptParts.push(flag, ...options.slice(index)); break; }
		throw new Error(`Unexpected spawn argument ${flag}; only one optional name is allowed before --`);
	}
	const prompt = promptParts.join(" ").trim() || undefined;
	return { kind, name, prompt, grants, inheritWorkspaceRead };
}

export default function lindenExtension(pi: ExtensionAPI) {
	pi.registerFlag("linden-web", { description: "Comma-separated Web domains initially moved to the session participant", type: "string", default: "" });
	pi.registerFlag("linden-max-agent-depth", { description: "Maximum Agent depth below the human root (default: unlimited)", type: "string", default: "" });
	let coordinator: PiCoordinator | undefined;

	for (const tool of buildDeferredTools()) pi.registerTool(tool as any);
	const allowedTools = new Set(toolNames());
	pi.on("tool_call", (event) => allowedTools.has(event.toolName) ? undefined : { block: true, reason: `Tool ${event.toolName} is not mediated by Linden authority` });

	function requireCoordinator(context?: ExtensionContext): PiCoordinator {
		if (context) coordinator?.setContext(context);
		if (!coordinator) throw new Error("Linden session authority is not initialized");
		return coordinator;
	}

	function buildDeferredTools() {
		const placeholder = { authority: { workspace: process.cwd() } } as unknown as PiCoordinator;
		return buildTools(placeholder, "deferred", process.cwd()).map((definition) => ({
			...definition,
			async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: ExtensionContext) {
				const active = requireCoordinator(context);
				const real = buildTools(active, active.authority.sessionParticipantId, context.cwd).find((candidate) => candidate.name === definition.name)!;
				return real.execute(toolCallId, params as never, signal, onUpdate as never, context);
			},
		}));
	}

	pi.on("session_start", async (_event, context) => {
		coordinator = await PiCoordinator.create(pi, context, parseDomains(pi.getFlag("linden-web")), undefined, parseMaxAgentDepth(pi.getFlag("linden-max-agent-depth")));
		coordinator.setToolFactory((active, participantId, cwd) => buildTools(active, participantId, cwd));
		await coordinator.activateSessionMailbox();
		context.ui.setStatus("linden", context.ui.theme.fg("accent", "linden:authority"));
	});

	pi.on("before_agent_start", async (event, context) => {
		const active = requireCoordinator(context);
		const participantId = active.authority.sessionParticipantId;
		const birthSnapshot = needsParticipantTreeBirthSnapshot(context.sessionManager.getEntries())
			? `\n\n${await active.formatParticipantTreeBirthSnapshot(participantId)}`
			: "";
		return { systemPrompt: `${event.systemPrompt}\n\nLinden session authority (the sole source of resource permissions):\n${active.describeAuthority(participantId)}\nUse only the registered Linden gateways for files, Bash, messages, transfers, checkout, and child participants.${birthSnapshot}\n\n${RUNTIME_GUIDANCE}` };
	});

	pi.on("message_start", async (event, context) => {
		const active = requireCoordinator(context);
		await active.handleRuntimeMessage(active.authority.sessionParticipantId, event.message);
	});

	pi.on("agent_start", async (_event, context) => {
		const active = requireCoordinator(context);
		await active.handleAgentStart(active.authority.sessionParticipantId);
	});

	pi.on("agent_end", async (_event, context) => {
		const active = requireCoordinator(context);
		await active.handleAgentEnd(active.authority.sessionParticipantId);
	});

	pi.on("user_bash", (_event, context) => {
		const active = requireCoordinator(context);
		return { operations: { exec: async (command: string, _cwd: string, options: any) => {
			const result = await active.authority.bash(active.authority.rootParticipantId, command, options);
			for (const notice of result.notices) context.ui.notify(`[Linden sandbox] ${notice}`, "warning");
			return { exitCode: result.exitCode };
		} } };
	});

	pi.on("session_shutdown", async (_event, context) => {
		const active = coordinator;
		coordinator = undefined;
		try { await active?.dispose(); }
		catch (error) { context.ui.notify(`Linden shutdown warning: ${errorText(error)}`, "warning"); }
		context.ui.setStatus("linden", undefined);
	});

	pi.registerCommand("linden", {
			description: "Inspect or operate the human-root Linden participant",
			handler: async (args, context) => {
				const active = requireCoordinator(context);
				const participantApi = participantCoordinator(active);
				try {
					const [action = "show", ...rest] = parseCommandLine(args);
					const raw = parseParticipantPayloadCommand(args);
				const human = active.authority.rootParticipantId;
				if (action === "show") context.ui.notify(active.describeAuthority(human, rest[0] ?? human), "info");
					else if (action === "read") { if (!rest[0]) throw new Error("Usage: /linden read <path>"); const result = await active.authority.readFile(human, rest[0]); context.ui.notify(result.state === "Absent" ? `Absent: ${result.path}` : result.content, "info"); }
				else if (action === "write") { if (rest.length < 2) throw new Error("Usage: /linden write <path> <content>"); const result = await active.authority.writeFile(human, rest[0], rest.slice(1).join(" ")); context.ui.notify(`Wrote ${result.path}`, "info"); }
				else if (action === "edit") { if (rest.length < 3) throw new Error("Usage: /linden edit <path> <old-text> <new-text>"); const result = await active.authority.editFile(human, rest[0], rest[1], rest[2]); context.ui.notify(`Edited ${result.path}`, "info"); }
				else if (action === "stat") { if (!rest[0]) throw new Error("Usage: /linden stat <path>"); const result = await active.authority.statFile(human, rest[0]); context.ui.notify(`${result.state}: ${result.path}${result.size === undefined ? "" : ` (${result.size} bytes)`}`, "info"); }
				else if (action === "spawn") {
					const parsed = parseHumanSpawn(rest);
					const childId = await participantApi.spawnParticipant(human, {
						kind: parsed.kind,
						name: parsed.name,
						prompt: parsed.prompt,
						resources: parsed.grants,
						inheritRead: parsed.inheritWorkspaceRead,
					});
					const outcome = parsed.kind === "agent" ? active.spawnOutcome(childId) : undefined;
					const warnings = [...(outcome?.warnings ?? [])];
					const warningText = warnings.length ? `\n${warnings.map((warning) => `${warning.code}: ${warning.message}${warning.detail ? ` (${warning.detail})` : ""}`).join("\n")}` : "";
					context.ui.notify(`Spawned ${parsed.kind} ${childId}${warningText}`, "info");
				}
				else if (action === "participants") { if (rest.length) throw new Error("Usage: /linden participants"); context.ui.notify(await active.discoverParticipantTree(human), "info"); }
				else if (action === "send") { if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: /linden send <participant> <message>"); context.ui.notify(`Sent ${await active.send(human, raw.target, raw.payload)}`, "info"); }
				else if (action === "steer") { if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: /linden steer <agent> <message>"); context.ui.notify(`Steered ${await active.steer(human, raw.target, raw.payload)}`, "info"); }
				else if (action === "interrupt") { if (rest.length !== 1) throw new Error("Usage: /linden interrupt <participant>"); await participantApi.interrupt(human, rest[0]); context.ui.notify(`Interrupted foreground activity for ${rest[0]}`, "info"); }
				else if (action === "stop") { if (rest.length !== 1) throw new Error("Usage: /linden stop <participant>"); await participantApi.stop(human, rest[0]); context.ui.notify(`Stopped participant subtree ${rest[0]}`, "info"); }
				else if (action === "wait") {
					if (!rest[0] || rest.length > 2) throw new Error("Usage: /linden wait <participant> [ready|stopped]");
					const state = rest[1] ?? "ready";
					if (state !== "ready" && state !== "stopped") throw new Error("wait state must be ready or stopped");
					const outcome = await participantApi.waitParticipant(human, rest[0], state);
					context.ui.notify(outcome.status === "interrupted"
						? `Wait for ${rest[0]} was interrupted by incoming message(s): ${outcome.messageIds.join(", ")}. Use /linden receive.`
						: `${rest[0]} is ${state}`, "info");
				}
				else if (action === "receive") { if (rest.length > 1) throw new Error("Usage: /linden receive [agent]"); const messages = await active.receive(human, rest[0]); context.ui.notify(messages.length ? messages.map((message) => `from=${message.senderId} id=${message.id}\n${message.payload}`).join("\n\n") : "Mailbox empty.", "info"); }
				else if (action === "listen") { if (rest.length !== 1) throw new Error("Usage: /linden listen <participant>"); context.ui.notify(await participantApi.listenParticipant(human, rest[0]), "info"); }
				else if (action === "exec") { if (!raw.target || !raw.hasPayloadSeparator || !raw.payload) throw new Error("Usage: /linden exec <term> <command>"); await participantApi.termExec(human, raw.target, raw.payload); context.ui.notify(`Started command in ${raw.target}`, "info"); }
				else if (action === "input") { if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: /linden input <term> <data>"); await participantApi.termInput(human, raw.target, raw.payload); context.ui.notify(`Wrote stdin to ${raw.target}`, "info"); }
				else if (action === "inputln") { if (!raw.target) throw new Error("Usage: /linden inputln <term> [data]"); await participantApi.termInput(human, raw.target, `${raw.hasPayloadSeparator ? raw.payload : ""}\n`); context.ui.notify(`Wrote stdin line to ${raw.target}`, "info"); }
				else if (action === "archive") { if (rest.length !== 1) throw new Error("Usage: /linden archive <stopped-direct-child>"); await participantApi.archive(human, rest[0]); context.ui.notify(`Archived and removed ${rest[0]}`, "info"); }
				else if (action === "give") { if (rest.length < 2) throw new Error("Usage: /linden give <participant> <resource>"); const result = await active.give(human, rest[0], rest[1]); context.ui.notify(result.mode === "read" ? `Granted read pointer on ${result.moved.join(", ")} to ${result.targetId}` : `Moved ${result.moved.join(", ")} to ${result.targetId}`, "info"); }
				else if (action === "get") {
					if (rest.length < 2) throw new Error("Usage: /linden get <participant> <resource>");
					const { targetId, resourceId } = await active.resolveOwnedChildResource(human, rest[0], rest[1]);
					context.ui.notify(`Acquired: ${(await active.getOwnedResource(human, targetId, resourceId)).join(", ")}`, "info");
				}
				else if (action === "checkout") { if (rest.length < 2) throw new Error("Usage: /linden checkout <resource> <state>"); context.ui.notify(`Checked out ${(await active.authority.checkout(human, rest[0], rest[1])).stateId}`, "info"); }
				else if (action === "log") { if (rest.length !== 1) throw new Error("Usage: /linden log <resource-or-participant>"); context.ui.notify(await active.formatParticipantLog(human, rest[0]), "info"); }
				else if (action === "rewind") await rewindFromHuman(active, rest[0], rest[1], context);
				else throw new Error(`Unknown /linden action ${action}`);
			} catch (error) { context.ui.notify(errorText(error), "error"); }
		},
	});
}

async function rewindFromHuman(
	active: PiCoordinator,
	targetOrState: string | undefined,
	maybeState: string | undefined,
	context: ExtensionCommandContext,
): Promise<void> {
	if (!targetOrState) throw new Error("Usage: /linden rewind [agent] <agent-state-id>");
	const targetId = maybeState ? targetOrState : active.authority.sessionParticipantId;
	const stateId = maybeState ?? targetOrState;
	const navigateRoot = targetId === active.authority.sessionParticipantId
		? async (entryId: string) => {
			const result = await context.navigateTree(entryId, { summarize: false });
			if (result.cancelled) throw new Error("Pi cancelled root context rewind");
		}
		: undefined;
	if (navigateRoot) await active.rewind(active.authority.rootParticipantId, targetId, stateId, navigateRoot);
	else await active.rewind(active.authority.rootParticipantId, targetId, stateId);
}
