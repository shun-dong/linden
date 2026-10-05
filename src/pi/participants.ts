import { authoritySummary } from "../runtime/authority-display.js";
import type { AuthorityState, ParticipantId, ParticipantRecord } from "../runtime/model.js";

export type ParticipantDisplayName = (participant: ParticipantRecord) => string | undefined;

function cleanName(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim() || "unnamed";
}

function isStrictDescendant(state: AuthorityState, ancestorId: ParticipantId, targetId: ParticipantId): boolean {
	let cursor = state.participants[targetId]?.parentId;
	const seen = new Set<ParticipantId>();
	while (cursor && !seen.has(cursor)) {
		if (cursor === ancestorId) return true;
		seen.add(cursor);
		cursor = state.participants[cursor]?.parentId;
	}
	return false;
}

function relationLabels(state: AuthorityState, viewerId: ParticipantId, node: ParticipantRecord): string[] {
	const viewer = state.participants[viewerId];
	if (!viewer) return [];
	const result: string[] = [];
	if (node.id === viewerId) result.push("self");
	if (viewer.parentId === node.id) result.push("parent");
	if (node.parentId === viewerId) result.push("child");
	else if (isStrictDescendant(state, viewerId, node.id)) result.push("descendant");
	return result;
}

export function formatParticipants(
	state: AuthorityState,
	viewerId: ParticipantId,
	displayName: ParticipantDisplayName = (participant) => participant.name,
): string {
	if (!state.participants[viewerId]) throw new Error(`Unknown participant ${viewerId}`);
	const lines: string[] = [`Agent depth limit: ${state.maxAgentDepth ?? "unlimited"}`];
	const visited = new Set<ParticipantId>();
	const visit = (id: ParticipantId, prefix: string, last: boolean, root = false): void => {
		if (visited.has(id)) return;
		visited.add(id);
		const node = state.participants[id];
		if (!node) return;
		const relations = relationLabels(state, viewerId, node);
		const name = cleanName(displayName(node) ?? node.name);
		const connector = root ? "" : last ? "└── " : "├── ";
		const columns = [...relations, node.status, authoritySummary(state, [node.id])];
		lines.push(`${prefix}${connector}${name}(${node.id}) | ${columns.join(" | ")}`);
		const childPrefix = root ? "" : `${prefix}${last ? "    " : "│   "}`;
		const children = node.childIds.filter((childId) => state.participants[childId]);
		children.forEach((childId, index) => visit(childId, childPrefix, index === children.length - 1));
	};
	visit(state.rootParticipantId, "", true, true);
	const orphans = Object.values(state.participants)
		.filter((participant) => !visited.has(participant.id))
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	for (const orphan of orphans) visit(orphan.id, "", true, true);
	return lines.join("\n");
}
