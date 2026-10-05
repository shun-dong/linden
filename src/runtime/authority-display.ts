import { canObserveResource, ownerOf, pathExpressions } from "../compiler/judgment.js";
import { fileResourceId, isInside, pathExpressionContains, type PathExpression } from "./paths.js";
import type { AuthorityState } from "./model.js";

function union(expressions: PathExpression[]): PathExpression[] {
	return expressions.map((expression) => ({ ...expression, exclude: expression.exclude.filter((excluded) => !expressions.some((other) => pathExpressionContains(other, excluded))) }))
		.filter((expression, index, all) => !all.some((other, otherIndex) => otherIndex !== index && (other.include !== expression.include || otherIndex < index) && pathExpressionContains(other, expression.include) && !other.exclude.some((excluded) => isInside(excluded, expression.include))));
}

export function authoritySummary(state: AuthorityState, holders: readonly string[]): string {
	if (state.archived) return "none (workspace archived)";
	const ids = new Set(holders);
	const writes = union(holders.flatMap((id) => pathExpressions(state, id, true)));
	const reads = union(holders.flatMap((id) => pathExpressions(state, id, false)));
	const format = (expression: PathExpression, read: boolean) => `${read ? "&" : ""}${fileResourceId(expression.include, true)}${expression.exclude.length ? ` − {${expression.exclude.join(", ")}}` : ""}`;
	const pieces = writes.map((expression) => format(expression, false));
	for (const expression of reads) if (!writes.some((write) => write.include === expression.include && write.exclude.every((excluded) => expression.exclude.includes(excluded)))) pieces.push(format(expression, true));
	for (const resource of Object.values(state.resources)) {
		const owner = ownerOf(state, resource.id);
		const owned = !!owner && ids.has(owner);
		const observed = holders.some((id) => canObserveResource(state, id, resource.id));
		if (!owned && !observed) continue;
		if (resource.kind === "file-region") continue;
		if (resource.kind === "file") {
			if ((owned ? writes : reads).some((expression) => pathExpressionContains(expression, resource.path))) continue;
			pieces.push(`${owned ? "" : "&"}${resource.id}`);
		} else if (resource.kind === "net" && resource.public) {
			const exclusions = Object.values(state.resources).filter((child) => child.kind === "net" && !child.public && child.derivedFrom === resource.id && !holders.some((holder) => canObserveResource(state, holder, child.id))).map((child) => child.id);
			pieces.push(`${owned ? "" : "&"}${resource.id}${exclusions.length ? ` − {${exclusions.join(", ")}}` : ""}`);
		} else pieces.push(`${owned ? "" : "&"}${resource.id}`);
	}
	return [...new Set(pieces)].join("; ") || "none";
}

export function managedParticipants(state: AuthorityState, participantId: string): string[] {
	const result: string[] = [];
	const visit = (id: string) => {
		if (result.includes(id) || !state.participants[id]) return;
		result.push(id);
		state.participants[id].childIds.forEach(visit);
	};
	visit(participantId);
	return result;
}
