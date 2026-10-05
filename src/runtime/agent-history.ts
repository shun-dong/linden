import type { AgentBranches, AgentStateNode, ParticipantId, VersionId } from "./model.js";

export function validAgentBranchName(name: string): boolean {
	return name.length > 0 && name.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(name);
}

export function legacyAgentBranches(current?: VersionId): AgentBranches {
	return { current: "main", heads: current === undefined ? {} : { main: current } };
}

export function validateAgentBranches(
	value: AgentBranches,
	participantId: ParticipantId,
	nodes: Record<VersionId, AgentStateNode>,
	current?: VersionId,
): void {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| typeof value.current !== "string" || !validAgentBranchName(value.current)
		|| !value.heads || typeof value.heads !== "object" || Array.isArray(value.heads)
		|| Object.keys(value).some((key) => key !== "current" && key !== "heads")) throw new Error(`INVALID_AGENT_BRANCHES: ${participantId}`);
	for (const [name, stateId] of Object.entries(value.heads)) {
		if (!validAgentBranchName(name) || typeof stateId !== "string" || nodes[stateId]?.participantId !== participantId) throw new Error(`INVALID_AGENT_BRANCH_HEAD: ${participantId} ${name}`);
	}
	const head = Object.hasOwn(value.heads, value.current) ? value.heads[value.current] : undefined;
	if (head !== current || (Object.keys(value.heads).length > 0 && head === undefined)
		|| (head === undefined && Object.values(nodes).some((node) => node.participantId === participantId))) throw new Error(`INVALID_AGENT_CURRENT_BRANCH: ${participantId}`);
}
