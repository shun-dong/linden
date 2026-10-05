import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeMaxAgentDepth } from "../runtime/agent-depth.js";
import { registerLindenHooks } from "./hooks.js";
import { buildTools } from "./tools.js";
import { PiCoordinator } from "./runtime.js";

export { parseHumanSpawn, type ParsedHumanSpawn } from "./compat.js";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const parseMaxAgentDepth = (value: unknown): number | undefined => {
	const text = String(value ?? "").trim();
	return text ? normalizeMaxAgentDepth(Number(text), "--linden-max-agent-depth") : undefined;
};
const parseCommandLine = (value: string): string[] => (value.match(/(?:[^\s"' ]+|"[^"]*"|'[^']*')+/g) ?? []).map((item) => ((item.startsWith("\"") && item.endsWith("\"")) || (item.startsWith("'") && item.endsWith("'"))) ? item.slice(1, -1) : item);

export default function lindenExtension(pi: ExtensionAPI) {
	pi.registerFlag("linden-permissions", { description: "Space-separated typed initial File/Net permissions", type: "string", default: "" });
	pi.registerFlag("linden-max-agent-depth", { description: "Maximum Agent depth below the human root (default: unlimited)", type: "string", default: "" });
	let coordinator: PiCoordinator | undefined;

	for (const tool of buildDeferredTools()) pi.registerTool(tool as any);
	registerLindenHooks(pi, (context) => {
		const active = requireCoordinator(context);
		return { coordinator: active, participantId: active.authority.sessionParticipantId };
	});

	function requireCoordinator(context?: ExtensionContext): PiCoordinator {
		if (context) coordinator?.setContext(context);
		if (!coordinator) throw new Error("Linden workspace authority is not initialized");
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
		coordinator = await PiCoordinator.create(pi, context, parseCommandLine(String(pi.getFlag("linden-permissions") ?? "")), undefined, parseMaxAgentDepth(pi.getFlag("linden-max-agent-depth")));
		coordinator.setToolFactory((active, participantId, cwd) => buildTools(active, participantId, cwd));
		await coordinator.activateSessionMailbox();
		context.ui.setStatus("linden", context.ui.theme.fg("accent", "linden:authority"));
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

	pi.on("session_shutdown", async (_event, context) => {
		const active = coordinator;
		coordinator = undefined;
		try { await active?.dispose(); }
		catch (error) { context.ui.notify(`Linden shutdown warning: ${errorText(error)}`, "warning"); }
		context.ui.setStatus("linden", undefined);
	});
}
