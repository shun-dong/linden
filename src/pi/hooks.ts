import type { BashOperations, ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ParticipantId } from "../runtime/model.js";
import {
	RUNTIME_GUIDANCE,
	needsParticipantTreeBirthSnapshot,
	runtimeGuidanceForParticipant,
	toolNames,
	type PiCoordinator,
	type RuntimeGuidanceProfile,
} from "./runtime.js";

/** Only the shared gateways; startup, shutdown, subscriptions and session control stay with each entrypoint. */
export function registerLindenHooks(
	pi: ExtensionAPI,
	resolve: (context: ExtensionContext) => { coordinator: PiCoordinator; participantId: ParticipantId },
	hosted?: { sessionManager: SessionManager; runtimeGuidanceProfile: RuntimeGuidanceProfile },
): void {
	const allowed = new Set(toolNames());
	pi.on("tool_call", (event) => allowed.has(event.toolName) ? undefined : { block: true, reason: `Tool ${event.toolName} is not mediated by Linden authority` });

	pi.on("session_before_tree", (_event, context) => {
		const { coordinator, participantId } = resolve(context);
		if (coordinator.isHistoryNavigationPending(participantId)) return;
		context.ui.notify("Use Linden branch, switch or rewind from the parent to navigate Agent history.", "error");
		return { cancel: true };
	});

	pi.on("before_agent_start", async (event, context) => {
		const { coordinator, participantId } = resolve(context);
		const entries = (hosted?.sessionManager ?? context.sessionManager).getEntries();
		const birthSnapshot = needsParticipantTreeBirthSnapshot(entries)
			? `\n\n${await coordinator.formatParticipantTreeBirthSnapshot(participantId)}`
			: "";
		const heading = hosted
			? `Linden authority (the sole source of resource permissions):\nYou are participant ${participantId}.`
			: "Linden workspace authority (the sole source of resource permissions):";
		const guidance = hosted
			? runtimeGuidanceForParticipant(coordinator.isAgentSpawnEnabled(participantId), hosted.runtimeGuidanceProfile)
			: RUNTIME_GUIDANCE;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${heading}\n${coordinator.describeAuthority(participantId)}\nUse only the registered Linden gateways for files, Bash, messages, transfers, checkout, and child participants.${birthSnapshot}\n\n${guidance}`,
		};
	});

	pi.on("input", async (event, context) => {
		if (!event.text.startsWith(":")) return { action: "continue" };
		const { coordinator, participantId } = resolve(context);
		try {
			if (event.text === ":authority") context.ui.notify(coordinator.describeAuthority(participantId), "info");
			else if (event.text === ":participants") context.ui.notify(await coordinator.discoverParticipantTree(participantId), "info");
			else if (/^:permission(?: (manual|all-of-mine))?$/.test(event.text)) {
				const mode = event.text.split(" ")[1] as "manual" | "all-of-mine" | undefined;
				if (mode) await coordinator.authority.setPermissionMode(participantId, mode);
				context.ui.notify(coordinator.authority.participant(participantId)?.permissionMode ?? "manual", "info");
			} else {
				const hint = hosted ? "/exit detaches." : "Human workspace commands belong to linden CLI.";
				context.ui.notify(`Attached commands: :authority, :participants, :permission [manual|all-of-mine]. ${hint}`, "error");
			}
		} catch (error) { context.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		return { action: "handled" };
	});

	pi.on("user_bash", (_event, context) => {
		const { coordinator, participantId } = resolve(context);
		const operations: BashOperations = {
			exec: async (command, cwd, options) => {
				// The hosted runtime uses Pi's operation cwd; the standalone extension
				// retains its current context cwd and reports sandbox notices to its UI.
				const result = await coordinator.authority.bash(participantId, command, { ...options, cwd: hosted ? cwd : context.cwd });
				if (!hosted) for (const notice of result.notices) context.ui.notify(`[Linden sandbox] ${notice}`, "warning");
				return { exitCode: result.exitCode };
			},
		};
		return { operations };
	});
}
