import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateTail,
	type AgentToolResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ParticipantId, VersionId } from "../runtime/model.js";
import { canonicalCandidate } from "../runtime/paths.js";
import { participantCoordinator, participantReference } from "./participant-api.js";
import type { PiCoordinator } from "./runtime.js";

const participantFields = { participant: Type.Optional(Type.String()), agent: Type.Optional(Type.String()) };
const participantSchema = Type.Object(participantFields);
const listenSchema = Type.Object({ ...participantFields, after: Type.Optional(Type.Integer({ minimum: 0 })), wait: Type.Optional(Type.Boolean()) });
const sendSchema = Type.Object({ ...participantFields, message: Type.String() });
const receiveSchema = Type.Object({ participant: Type.Optional(Type.String()), agent: Type.Optional(Type.String()) });
const agentSpawnSchema = Type.Object({
	kind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("term")])),
	prompt: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	resources: Type.Optional(Type.Array(Type.String())),
	inheritRead: Type.Optional(Type.Boolean()),
	inheritWorkspaceRead: Type.Optional(Type.Boolean()),
});
const termSpawnSchema = Type.Object({
	kind: Type.Optional(Type.Literal("term")),
	name: Type.Optional(Type.String()),
	resources: Type.Optional(Type.Array(Type.String())),
	inheritRead: Type.Optional(Type.Boolean()),
	inheritWorkspaceRead: Type.Optional(Type.Boolean()),
});
const participantsSchema = Type.Object({});
const statSchema = Type.Object({ path: Type.String() });
const transferSchema = Type.Object({ ...participantFields, resource: Type.String() });
const checkoutSchema = Type.Object({ resource: Type.String(), state: Type.String() });
const rewindSchema = Type.Object({ ...participantFields, state: Type.String() });
const logSchema = Type.Object({ target: Type.String() });
const authoritySchema = Type.Object({ participant: Type.Optional(Type.String()) });
const waitSchema = Type.Object({ ...participantFields, state: Type.Union([Type.Literal("ready"), Type.Literal("stopped")]) });
const termExecSchema = Type.Object({ ...participantFields, command: Type.String() });
const termInputSchema = Type.Object({ ...participantFields, data: Type.String() });

const textResult = (text: string, details?: unknown): AgentToolResult<any> => ({ content: [{ type: "text", text }], details });

export function buildTools(coordinator: PiCoordinator, participantId: ParticipantId, sessionCwd?: string): ToolDefinition[] {
	const participantApi = participantCoordinator(coordinator);
	const cwd = sessionCwd ?? coordinator.runtimes?.get(participantId)?.cwd ?? coordinator.authority.workspace;
	const filePath = (input: string): string => canonicalCandidate(input, cwd);
	const read = createReadTool(cwd);
	const write = createWriteTool(cwd);
	const edit = createEditTool(cwd);
	const bash = createBashTool(cwd);
	const agentSpawnEnabled = coordinator.isAgentSpawnEnabled?.(participantId) ?? true;
	const spawnDefinition: ToolDefinition = {
		name: "spawn",
		label: agentSpawnEnabled ? "spawn (Linden)" : "spawn Term (Linden)",
		description: agentSpawnEnabled
			? "Spawn an Agent or Term child participant; kind defaults to agent. By default it snapshots the parent's effective File reads. resources entries must be typed references such as file:./src/ or web:example.com/: prefix & for a read grant, plain to move complete ownership. inheritRead=false opts out (inheritWorkspaceRead is a deprecated alias). prompt is used only by Agent children."
			: "Spawn a Term child participant. Agent child spawning is disabled for this participant. By default it snapshots the parent's effective File reads. resources entries must be typed references such as file:./src/ or web:example.com/: prefix & for a read grant, plain to move complete ownership. inheritRead=false opts out (inheritWorkspaceRead is a deprecated alias).",
		promptSnippet: agentSpawnEnabled ? "Spawn a typed Agent or Term child" : "Spawn a typed Term child",
		executionMode: "sequential",
		parameters: agentSpawnEnabled ? agentSpawnSchema : termSpawnSchema,
		async execute(_id, params: any) {
			const kind = agentSpawnEnabled ? params.kind ?? "agent" : "term";
			const childId = await participantApi.spawnParticipant(participantId, {
				kind,
				name: params.name,
				...(agentSpawnEnabled ? { prompt: params.prompt } : {}),
				resources: params.resources ?? [],
				inheritRead: params.inheritRead ?? params.inheritWorkspaceRead ?? true,
				cwd,
				origin: "model",
			});
			const parentCheckpoint = await coordinator.appendCheckpointAfterCommit(participantId, "spawn");
			const outcome = kind === "agent" ? coordinator.spawnOutcome(childId) : undefined;
			const warnings = [...(outcome?.warnings ?? [])];
			if (participantId.startsWith("agent:") && !parentCheckpoint) warnings.push({
				code: "LINDEN_POST_COMMIT_CHECKPOINT_FAILED" as const,
				message: "The child was created, but the parent's post-spawn checkpoint could not be recorded.",
			});
			const warningText = warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning.code}: ${warning.message}${warning.detail ? ` (${warning.detail})` : ""}`).join("\n")}` : "";
			return textResult(`Spawned ${kind} participantId="${childId}"${warningText}`, {
				participantId: childId,
				kind,
				promptRequested: outcome?.promptRequested ?? Boolean(params.prompt?.trim()),
				promptAccepted: outcome?.promptAccepted,
				warnings,
			});
		},
	};
	const tools: ToolDefinition[] = [
		{
			...read,
			label: "read (Linden authority)",
			promptGuidelines: ["All file reads are checked against the session-global Linden ledger."],
			async execute(_id, params: any) {
				const result = await coordinator.authority.readFile(participantId, filePath(params.path));
				if (result.state === "Absent") return textResult(`Absent: ${result.path} (authorized location with no content)`, { path: result.path, state: result.state, resourceId: result.resourceId });
				const lines = result.content.split("\n");
				const offset = params.offset === undefined ? 1 : params.offset;
				if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset must be a positive integer");
				const start = offset - 1;
				if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
				if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) throw new Error("limit must be a positive integer");
				const end = params.limit === undefined ? lines.length : Math.min(lines.length, start + params.limit);
				const truncation = truncateHead(lines.slice(start, end).join("\n"));
				let output = truncation.content;
				if (truncation.firstLineExceedsLimit) {
					const lineSize = formatSize(Buffer.byteLength(lines[start], "utf8"));
					output = `[Line ${offset} is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${offset}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
				} else if (truncation.truncated) {
					const shownEnd = offset + truncation.outputLines - 1;
					output += `\n\n[Showing lines ${offset}-${shownEnd} of ${lines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}. Use offset=${shownEnd + 1} to continue.]`;
				} else if (end < lines.length) {
					output += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
				}
				return textResult(output, { path: result.path, state: result.state, resourceId: result.resourceId, ...(truncation.truncated || truncation.firstLineExceedsLimit ? { truncation } : {}) });
			},
		},
		{
			...write,
			label: "write (Linden authority)",
			executionMode: "sequential",
			async execute(id, params: any) {
				const result = await coordinator.authority.writeFile(participantId, filePath(params.path), params.content);
				await coordinator.appendCheckpointAfterCommit(participantId, "write");
				return textResult(`Wrote ${result.path}`, { ...result, toolCallId: id });
			},
		},
		{
			...edit,
			label: "edit (Linden authority)",
			executionMode: "sequential",
			async execute(id, params: any) {
				const result = await coordinator.authority.editFile(participantId, filePath(params.path), params.edits);
				await coordinator.appendCheckpointAfterCommit(participantId, "edit");
				return textResult(`Edited ${result.path}`, { ...result, toolCallId: id });
			},
		},
		{
			...bash,
			label: "bash (Linden sandbox)",
			executionMode: "sequential",
			async execute(id, params: any, signal, onUpdate) {
				const result = await coordinator.authority.bash(participantId, params.command, { cwd, signal, timeout: params.timeout, onData: (data) => onUpdate?.({ content: [{ type: "text", text: data.toString("utf8") }], details: { toolCallId: id } } as any) });
				await coordinator.appendCheckpointAfterCommit(participantId, "bash");
				const notices = result.notices.length ? `\n\n[Linden sandbox]\n${result.notices.map((notice) => `- ${notice}`).join("\n")}` : "";
				const truncation = truncateTail(`${result.output || `(exit ${result.exitCode})`}${notices}`);
				let output = truncation.content;
				if (truncation.truncated) {
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					output += truncation.lastLinePartial
						? `\n\n[Showing the last ${formatSize(truncation.outputBytes)}; earlier Bash output was truncated at the ${formatSize(DEFAULT_MAX_BYTES)} tool limit.]`
						: `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}; earlier Bash output was truncated.]`;
				}
				return textResult(output, { exitCode: result.exitCode, changedResources: result.changedResources, notices: result.notices, toolCallId: id, ...(truncation.truncated ? { truncation } : {}) });
			},
		},
		{
			name: "stat", label: "stat (Linden)", description: "Observe whether an authorized File location is Absent or Present without reading its contents.", promptSnippet: "Check Absent or Present File state", parameters: statSchema,
			async execute(_id, params: Static<typeof statSchema>) { const result = await coordinator.authority.statFile(participantId, filePath(params.path)); return textResult(`${result.state}: ${result.path}${result.size === undefined ? "" : ` (${result.size} bytes)`}`, result); },
		},
		spawnDefinition,
		{
			name: "send", label: "send (Linden)", description: "Send an ordinary String follow-up directly to a discovered Human or Agent, including siblings and other branches. Call participants to obtain current IDs and ordinary participant pointers if the target or pointer is missing. participant is the target; agent is a deprecated alias. Delivery waits until the target is ready and batches with other pending follow-ups; assistant final is also delivered automatically to the direct parent. Messages grant no resource or control authority.", promptSnippet: "Send information directly to a discovered Human or Agent", executionMode: "sequential", parameters: sendSchema,
			async execute(_id, params: Static<typeof sendSchema>) { const target = participantReference(params); const messageId = await coordinator.send(participantId, target, params.message); await coordinator.appendCheckpointAfterCommit(participantId, "send"); return textResult(`Sent ${messageId}`, { messageId, participantId: target }); },
		},
		{
			name: "steer", label: "steer (Linden)", description: "Agent-only ancestor-to-descendant steering via &> or &>>. participant is the target; agent is a deprecated alias. The target's current tool may finish; remaining not-yet-started tools in that assistant response are blocked.", promptSnippet: "Steer a descendant Agent after its current tool", executionMode: "sequential", parameters: sendSchema,
			async execute(_id, params: Static<typeof sendSchema>) { const target = participantReference(params); const messageId = await coordinator.steer(participantId, target, params.message); await coordinator.appendCheckpointAfterCommit(participantId, "steer"); return textResult(`Steered ${messageId}`, { messageId, participantId: target }); },
		},
		{
			name: "interrupt", label: "interrupt (Linden)", description: "Interrupt only a descendant participant's own foreground activity; its descendants and background work continue.", promptSnippet: "Interrupt a descendant participant's foreground activity", executionMode: "sequential", parameters: participantSchema,
			async execute(_id, params: Static<typeof participantSchema>) { const target = participantReference(params); await participantApi.interrupt(participantId, target); await coordinator.appendCheckpointAfterCommit(participantId, "interrupt"); return textResult(`Interrupted foreground activity for ${target}`); },
		},
		{
			name: "stop", label: "stop (Linden)", description: "Recursively stop a descendant participant, all of its descendants, and its background work.", promptSnippet: "Stop a descendant participant subtree", executionMode: "sequential", parameters: participantSchema,
			async execute(_id, params: Static<typeof participantSchema>) { const target = participantReference(params); await participantApi.stop(participantId, target); await coordinator.appendCheckpointAfterCommit(participantId, "stop"); return textResult(`Stopped participant subtree ${target}`); },
		},
		{
			name: "wait", label: "wait (Linden)", description: "Wait until a strict descendant participant is ready (its foreground is inactive) or stopped (the participant subtree and background work are fully quiescent). An ordinary message arriving for you interrupts the wait; the message remains pending, so call receive next.", promptSnippet: "Wait for a descendant state or until an ordinary message arrives", executionMode: "sequential", parameters: waitSchema,
			async execute(_id, params: Static<typeof waitSchema>, signal) {
				const target = participantReference(params);
				const outcome = signal
					? await participantApi.waitParticipant(participantId, target, params.state, signal)
					: await participantApi.waitParticipant(participantId, target, params.state);
				if (outcome.status === "interrupted") {
					return textResult(`Wait for ${target} was interrupted by incoming ordinary message(s). The messages remain pending; call receive now.`, {
						participantId: target,
						state: params.state,
						interruptedBy: outcome.reason,
						messageIds: outcome.messageIds,
					});
				}
				return textResult(`${target} is ${params.state}`, { participantId: target, state: params.state });
			},
		},
		{
			name: "receive", label: "receive (Linden)", description: "Check and FIFO-consume every currently pending mailbox message in one call. An optional participant filters by sender; there is no separate mailbox-check tool.", promptSnippet: "Check and consume the current mailbox batch", executionMode: "sequential", parameters: receiveSchema,
			async execute(_id, params: Static<typeof receiveSchema>) {
				const sender = params.participant || params.agent ? participantReference(params) : undefined;
				const messages = await coordinator.receive(participantId, sender);
				await coordinator.appendCheckpointAfterCommit(participantId, "receive");
				const output = messages.length ? messages.map((message) => `from=${message.senderId} id=${message.id}\n${message.payload}`).join("\n\n") : "Mailbox empty.";
				return textResult(output, { messages });
			},
		},
		{
			name: "listen", label: "listen (Linden)", description: "Observe a strict descendant participant's output and lifecycle state without consuming the mailbox. Term output is paged and, unless after is supplied, continues from this observer's previous cursor. wait=true waits for new Term output or a lifecycle change. participant is the target; agent is a deprecated alias.", promptSnippet: "Observe a strict descendant participant incrementally", parameters: listenSchema,
			async execute(_id, params: Static<typeof listenSchema>, signal) {
				const target = participantReference(params);
				return textResult(await participantApi.listenParticipant(participantId, target, { after: params.after, wait: params.wait, signal }), { participantId: target });
			},
		},
		{
			name: "participants", label: "participants (Linden)", description: "Discover Human, Agent, and Term nodes in the current participant tree and acquire ordinary read-only participant pointers to those nodes. These allow direct send to Human or Agent participants regardless of ancestry, but grant no file access, ownership, or lifecycle control. Call this to refresh IDs and pointers after a missing-target or missing-pointer send error.", promptSnippet: "Discover participants and acquire ordinary participant pointers", executionMode: "sequential", parameters: participantsSchema,
			async execute(_id, _params: Static<typeof participantsSchema>) { return textResult(await coordinator.discoverParticipantTree(participantId)); },
		},
		{
			name: "give", label: "give (Linden)", description: "Transfer authority over a direct parent-child edge; completes atomically and silently. resource must be a typed file:<address> or web:<selector>/ reference: plain input moves ownership; prefix & grants a read pointer. Relative File addresses follow file:, and a trailing / is the sole File-region marker.", promptSnippet: "Move ownership or grant a read pointer to a parent or child", executionMode: "sequential", parameters: transferSchema,
			async execute(_id, params: Static<typeof transferSchema>) { const result = await coordinator.give(participantId, participantReference(params), params.resource, cwd); await coordinator.appendCheckpointAfterCommit(participantId, "give"); return textResult(result.mode === "read" ? `Granted read pointer on ${result.moved.join(", ")} to ${result.targetId}` : `Moved ${result.moved.join(", ")} to ${result.targetId}`, result); },
		},
		{
			name: "get", label: "get (Linden)", description: "Take back a resource currently owned by your own direct child; accepts only a typed file:<address> or web:<selector>/ reference and auto-refines the child's bundle. Ownership transfer stays edge-scoped, so deeper recovery propagates one direct edge at a time. If an Agent owner is mid-turn, its current tool finishes and later tools are held while ownership moves; a Linden runtime notice then updates the Agent and it continues the same loop without being interrupted or stopped. An open Term epoch is never stopped implicitly: leave the resource with a required background service, or explicitly stop the Term before get.", promptSnippet: "Take back ownership from a Term or direct Agent child", executionMode: "sequential", parameters: transferSchema,
			async execute(_id, params: Static<typeof transferSchema>) {
				const { targetId, resourceId } = await coordinator.resolveOwnedChildResource(
					participantId,
					participantReference(params),
					params.resource,
					cwd,
				);
				const resources = await coordinator.getOwnedResource(participantId, targetId, resourceId);
				await coordinator.appendCheckpointAfterCommit(participantId, "get");
				return textResult(`Got ${resources.join(", ")} back from ${targetId}`, { resources, targetId });
			},
		},
		{
			name: "checkout", label: "checkout (Linden)", description: "Move a versioned File's current marker to a scoped state and restore its exact blob.", promptSnippet: "Checkout an existing scoped File state", executionMode: "sequential", parameters: checkoutSchema,
			async execute(_id, params: Static<typeof checkoutSchema>) { const result = await coordinator.authority.checkout(participantId, params.resource, params.state as VersionId); await coordinator.appendCheckpointAfterCommit(participantId, "checkout"); return textResult(`Checked out ${result.stateId}`, result); },
		},
		{
			name: "rewind", label: "rewind (Linden)", description: "Parent-only exact Pi tree navigation for a child; branch summaries are disabled, real effects are reconciled in a notice, and no model turn starts automatically.", promptSnippet: "Rewind a direct child's Pi context without reverting global effects", executionMode: "sequential", parameters: rewindSchema,
			async execute(_id, params: Static<typeof rewindSchema>) { const target = participantReference(params); await coordinator.rewind(participantId, target, params.state as VersionId); await coordinator.appendCheckpointAfterCommit(participantId, "rewind"); return textResult(`Rewound ${target} to ${params.state}`); },
		},
		{
			name: "log", label: "log (Linden)", description: "Show a durable File version tree, Agent checkpoint tree, or Term epoch/command history with exit codes and output ranges. IDs grant no new authority.", promptSnippet: "Inspect scoped File, Agent, or Term history", parameters: logSchema,
			async execute(_id, params: Static<typeof logSchema>) {
				return textResult(await coordinator.formatParticipantLog(participantId, params.target));
			},
		},
		{
			name: "exec", label: "exec (Linden Term)", description: "Start a command in a ready Term. The Term keeps its cwd, environment, and sandbox epoch across exec calls; use listen and wait to observe it.", promptSnippet: "Execute a command in a ready Term", executionMode: "sequential", parameters: termExecSchema,
			async execute(_id, params: Static<typeof termExecSchema>) { const target = participantReference(params); await participantApi.termExec(participantId, target, params.command); return textResult(`Started command in ${target}`, { participantId: target }); },
		},
		{
			name: "input", label: "input (Linden Term)", description: "Write data to a running Term's foreground stdin.", promptSnippet: "Send stdin to a running Term", executionMode: "sequential", parameters: termInputSchema,
			async execute(_id, params: Static<typeof termInputSchema>) { const target = participantReference(params); await participantApi.termInput(participantId, target, params.data); return textResult(`Wrote stdin to ${target}`, { participantId: target }); },
		},
		{
			name: "archive", label: "archive! (Linden)", description: "Destructively archive a stopped direct child: atomically reclaim its subtree's external authority and remove that stopped subtree from the live participant tree. This cannot be undone.", promptSnippet: "Reclaim and remove a stopped direct child subtree", executionMode: "sequential", parameters: participantSchema,
			async execute(_id, params: Static<typeof participantSchema>) { const target = participantReference(params); await participantApi.archive(participantId, target); await coordinator.appendCheckpointAfterCommit(participantId, "archive"); return textResult(`Archived and removed ${target}`); },
		},
		{
			name: "authority", label: "authority (Linden)", description: "Show current session-global ownership, pointers, and participant relations.", promptSnippet: "Inspect current Linden authority", parameters: authoritySchema,
			async execute(_id, params: Static<typeof authoritySchema>) { return textResult(coordinator.describeAuthority(participantId, params.participant ?? participantId)); },
		},
	];
	return tools.map((definition) => {
		const execute = definition.execute;
		return {
			...definition,
			executionMode: "sequential",
			async execute(...args: any[]) {
				coordinator.beginTool(participantId);
				try {
					return await (execute as (...values: any[]) => any)(...args);
				} finally {
					coordinator.endTool(participantId);
				}
			},
		} as ToolDefinition;
	});
}
