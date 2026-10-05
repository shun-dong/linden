/**
 * Pure algorithmic realization of the Linden authority judgments.
 *
 * This module deliberately imports neither the runtime nor the persisted
 * authority model. Runtime records may structurally contain more fields, but
 * only the Γ/Δ projection and the abstract Σ view below participate in a
 * derivation.
 */

export type ParticipantId = string;
export type ResourceId = string;
export type ParticipantKind = "human" | "agent" | "term";
export type ParticipantStatus = "running" | "ready" | "stopped";
export type WaitTarget = "ready" | "stopped";

export type ParticipantRole = "parent" | "ancestor" | "child";
/** @deprecated Use ParticipantRole. */
export type AgentRole = ParticipantRole;

export interface GammaContext {
	/** Unrestricted ordinary resource pointers (&A). */
	resourcePointers: ResourceId[];
	/** Erased ordinary participant pointers. Kept under the legacy field name for wire compatibility. */
	agentPointers: ParticipantId[];
	/** Runtime-introduced role pointers. */
	roles: Array<{ targetId: ParticipantId; role: ParticipantRole }>;
}

export interface DeltaContext {
	/** Complete linear ADT values. Resource and participant identities share one namespace. */
	completeValues: CompleteValue[];
}

export interface CompleteValue {
	identity: string;
	type: "File" | "FileRegion" | "Web" | "Net" | "Human" | "Agent" | "Term" | "Message";
	/** Current node of the corresponding versioned ADT, when versioned. */
	stateId?: string;
}

export interface ParticipantContext {
	gamma: GammaContext;
	delta: DeltaContext;
}

export interface PathExpression {
	include: string;
	exclude: string[];
}

export interface JudgmentParticipant {
	id: ParticipantId;
	kind: ParticipantKind;
	status: ParticipantStatus;
	parentId?: ParticipantId;
	childIds: ParticipantId[];
}

export interface JudgmentResource {
	id: ResourceId;
	kind: "file" | "file-region" | "web" | "net";
	public?: boolean;
	path?: string;
	domains?: string[];
	derivedFrom?: ResourceId;
	versioned?: boolean;
	versions?: Array<{ id: string }>;
	currentVersionId?: string;
	divergence?: unknown;
}

export interface JudgmentMessage {
	id: string;
	sequence: number;
	kind: "follow_up" | "steering";
	senderId: ParticipantId;
	targetId: ParticipantId;
	sentAt: number;
	consumedAt?: number;
}

export interface JudgmentAgentState {
	participantId: ParticipantId;
}

export interface JudgmentState {
	base: string;
	explicitAuthority?: boolean;
	archived?: boolean;
	rootParticipantId: ParticipantId;
	contexts: Record<ParticipantId, ParticipantContext>;
	participants: Record<ParticipantId, JudgmentParticipant>;
	participantTombstones?: Record<ParticipantId, Pick<JudgmentParticipant, "id" | "kind">>;
	resources: Record<ResourceId, JudgmentResource>;
	messages: Record<string, JudgmentMessage>;
	agentStates: Record<string, JudgmentAgentState>;
	currentAgentStateIds?: Record<ParticipantId, string>;
}

export type Judgment =
	| { kind: "connect" | "net-refine"; participantId: ParticipantId; resourceId: ResourceId }
	| { kind: "publish" | "unpublish"; participantId: ParticipantId; resourceId: ResourceId; targetId: ParticipantId }
	| { kind: "participants"; participantId: ParticipantId }
	| { kind: "read"; participantId: ParticipantId; path: string }
	| { kind: "write" | "edit"; participantId: ParticipantId; path: string }
	| { kind: "bash"; participantId: ParticipantId }
	| { kind: "spawn"; participantId: ParticipantId; childId: ParticipantId; participantKind: ParticipantKind; grants: Array<{ resourceId: ResourceId; mode: "move" | "read" }> }
	| { kind: "stat"; participantId: ParticipantId; path: string }
	| { kind: "send" | "attach" | "steer" | "stop" | "interrupt" | "listen"; participantId: ParticipantId; targetId: ParticipantId }
	| { kind: "wait"; participantId: ParticipantId; targetId: ParticipantId; until: WaitTarget }
	| { kind: "exec" | "input"; participantId: ParticipantId; targetId: ParticipantId }
	| { kind: "receive"; participantId: ParticipantId; senderId: ParticipantId; messageId: string; filtered: boolean }
	| { kind: "give"; participantId: ParticipantId; peerId: ParticipantId; resourceId: ResourceId; mode: "move" | "read" }
	| { kind: "get"; participantId: ParticipantId; peerId: ParticipantId; resourceId: ResourceId }
	| { kind: "archive"; participantId: ParticipantId; targetId: ParticipantId }
	| { kind: "checkout"; participantId: ParticipantId; resourceId: ResourceId; stateId: string }
	| { kind: "rewind"; participantId: ParticipantId; targetId: ParticipantId; stateId: string }
	| { kind: "log-resource"; participantId: ParticipantId; resourceId: ResourceId }
	| { kind: "log-participant"; participantId: ParticipantId; targetId: ParticipantId }
	| { kind: "log-agent" | "log-term"; participantId: ParticipantId; targetId: ParticipantId };

export type JudgmentDiagnosticCode =
	| "UNKNOWN_PARTICIPANT"
	| "UNKNOWN_RESOURCE"
	| "UNAUTHORIZED_READ"
	| "UNAUTHORIZED_WRITE"
	| "RESOURCE_DIVERGED"
	| "ROLE_MISMATCH"
	| "ROLE_FORGERY"
	| "MESSAGE_NOT_AVAILABLE"
	| "MESSAGE_ALREADY_CONSUMED"
	| "MESSAGE_OUT_OF_ORDER"
	| "STATE_SCOPE_MISMATCH"
	| "STATE_NOT_AVAILABLE"
	| "PARTICIPANT_KIND_MISMATCH"
	| "PARTICIPANT_STATUS_MISMATCH"
	| "PARTICIPANT_EXISTS";

export interface JudgmentDiagnostic {
	code: JudgmentDiagnosticCode;
	message: string;
	participantId?: ParticipantId;
	resourceId?: ResourceId;
	targetId?: string;
}

export interface JudgmentDerivation {
	judgment: Judgment["kind"];
	participantId: ParticipantId;
	resultType: string;
	effect: "Share" | "IO";
	/** The actual Γ′/Δ′ postcondition. */
	contexts: Record<ParticipantId, ParticipantContext>;
	affectedResources: ResourceId[];
	targetId?: ParticipantId;
	stateId?: string;
}

export type JudgmentResult =
	| { accepted: true; derivation: JudgmentDerivation }
	| { accepted: false; error: JudgmentDiagnostic };

export interface RefinementJudgment {
	participantId: ParticipantId;
	parentResourceId: ResourceId;
	resourceId: ResourceId;
	path: string;
	mode: "read" | "write";
	resourceType: CompleteValue["type"];
	stateId?: string;
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

const completeParticipantType = (kind: ParticipantKind): "Human" | "Agent" | "Term" =>
	kind === "human" ? "Human" : kind === "term" ? "Term" : "Agent";

export function emptyContext(selfId?: ParticipantId, kind: ParticipantKind = "agent"): ParticipantContext {
	return {
		gamma: { resourcePointers: [], agentPointers: selfId ? [selfId] : [], roles: [] },
		delta: { completeValues: selfId ? [{ identity: selfId, type: completeParticipantType(kind) }] : [] },
	};
}

function cloneContexts(contexts: Record<ParticipantId, ParticipantContext>): Record<ParticipantId, ParticipantContext> {
	return structuredClone(contexts);
}

function normalizedPath(path: string): string {
	const slash = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return slash || "/";
}

export function pathInside(candidate: string, root: string): boolean {
	const value = normalizedPath(candidate);
	const parent = normalizedPath(root);
	return value === parent || value.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** True when every host selected by `child` is selected by `parent` (legacy Web selectors). */
export function hostSelectorContains(parent: string, child: string): boolean {
	const broad = parent.toLowerCase().replace(/\.$/, "");
	const narrow = child.toLowerCase().replace(/\.$/, "");
	if (broad === "*" || broad === narrow) return true;
	if (!broad.startsWith("*.")) return false;
	const suffix = broad.slice(1);
	if (narrow.startsWith("*.")) return narrow.slice(1).endsWith(suffix) && narrow.length > broad.length;
	return narrow.endsWith(suffix) && narrow !== broad.slice(2);
}

export function normalizePathExpression(include: string, exclusions: Iterable<string> = []): PathExpression {
	const exclude = unique(exclusions)
		.filter((candidate) => candidate !== include && pathInside(candidate, include))
		.sort((left, right) => left.length - right.length)
		.filter((candidate, index, all) => !all.slice(0, index).some((parent) => pathInside(candidate, parent)));
	return { include, exclude };
}

export function subtractPath(expression: PathExpression, exclusion: string): PathExpression {
	if (!pathInside(exclusion, expression.include)) throw new Error(`${exclusion} is outside ${expression.include}`);
	if (normalizedPath(exclusion) === normalizedPath(expression.include)) return { include: expression.include, exclude: [expression.include] };
	return normalizePathExpression(expression.include, [...expression.exclude, exclusion]);
}

export function pathExpressionContains(expression: PathExpression, candidate: string): boolean {
	return pathInside(candidate, expression.include) && !expression.exclude.some((excluded) => pathInside(candidate, excluded));
}

export function intersectPath(expression: PathExpression, region: string): PathExpression | undefined {
	if (!pathInside(region, expression.include) || !pathExpressionContains(expression, region)) return undefined;
	return normalizePathExpression(region, expression.exclude.filter((excluded) => pathInside(excluded, region)));
}

export function formatPathExpression(expression: PathExpression): string {
	return expression.exclude.length ? `${expression.include} - ${expression.exclude.join(" - ")}` : expression.include;
}

/** Resolve a source-level logical File address without consulting the host filesystem. */
export function resolveLogicalPath(base: string, input: string): string {
	const value = input.replace(/\\/g, "/");
	const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
	const combined = absolute ? value : `${normalizedPath(base)}/${value}`;
	const drive = combined.match(/^[A-Za-z]:\//)?.[0];
	// A UNC share is a root in its own right. Treating //server/share as the
	// ordinary POSIX root would collapse it to /server/share and, when Windows
	// separators are restored, silently turn \\server into \server.
	const unc = combined.match(/^\/\/[^/]+\/[^/]+/)?.[0];
	const root = drive ?? unc ?? (combined.startsWith("/") ? "/" : "");
	const body = drive ? combined.slice(drive.length) : combined.slice(root.length);
	const segments: string[] = [];
	for (const segment of body.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	const separator = root && !root.endsWith("/") && segments.length ? "/" : "";
	const resolved = `${root}${separator}${segments.join("/")}` || ".";
	return base.includes("\\") ? resolved.replace(/\//g, "\\") : resolved;
}

export function ownerOf(state: JudgmentState, resourceId: ResourceId): ParticipantId | undefined {
	return Object.entries(state.contexts).find(([, context]) => context.delta.completeValues.some((value) => value.identity === resourceId))?.[0];
}

export function pointersTo(state: JudgmentState, resourceId: ResourceId): ParticipantId[] {
	return Object.entries(state.contexts)
		.filter(([, context]) => context.gamma.resourcePointers.includes(resourceId))
		.map(([participantId]) => participantId);
}

function directlyObservesResource(state: JudgmentState, participantId: ParticipantId, resourceId: ResourceId): boolean {
	const context = state.contexts[participantId];
	return Boolean(context && (context.delta.completeValues.some((value) => value.identity === resourceId) || context.gamma.resourcePointers.includes(resourceId)));
}

export function canObserveResource(state: JudgmentState, participantId: ParticipantId, resourceId: ResourceId): boolean {
	if (directlyObservesResource(state, participantId, resourceId)) return true;
	const target = state.resources[resourceId];
	if (!target || (target.kind !== "file" && target.kind !== "file-region") || !target.path) return false;
	return Object.values(state.resources).some((candidate) =>
		candidate.kind === "file-region"
		&& Boolean(candidate.path && pathInside(target.path!, candidate.path))
		&& directlyObservesResource(state, participantId, candidate.id));
}

function resolveFile(state: JudgmentState, path: string): JudgmentResource | undefined {
	return Object.values(state.resources).find((resource) => resource.kind === "file" && resource.path === path);
}

export function canReadPath(state: JudgmentState, participantId: ParticipantId, path: string): boolean {
	const exact = resolveFile(state, path);
	if (exact && canObserveResource(state, participantId, exact.id)) return true;
	const matching = Object.values(state.resources)
		.filter((resource) => resource.kind === "file-region" && resource.path && pathInside(path, resource.path));
	if (matching.some((resource) => canObserveResource(state, participantId, resource.id))) return true;
	return !state.explicitAuthority && !state.archived && participantId === state.rootParticipantId && pathInside(path, state.base);
}

export function canWritePath(state: JudgmentState, participantId: ParticipantId, path: string): boolean {
	const fileBoundary = Object.values(state.resources)
		.filter((resource) => resource.kind === "file" && resource.path && pathInside(path, resource.path))
		.sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
	if (fileBoundary) {
		return fileBoundary.path === path
			&& ownerOf(state, fileBoundary.id) === participantId
			&& !fileBoundary.divergence;
	}
	const matching = Object.values(state.resources)
		.filter((resource) => resource.kind === "file-region" && resource.path && pathInside(path, resource.path))
		.sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0));
	const mostSpecificLength = matching[0]?.path?.length;
	if (mostSpecificLength !== undefined) return matching.some((resource) => resource.path?.length === mostSpecificLength && ownerOf(state, resource.id) === participantId);
	return !state.explicitAuthority && !state.archived && participantId === state.rootParticipantId && pathInside(path, state.base);
}

function hasParticipantPointer(state: JudgmentState, participantId: ParticipantId, targetId: ParticipantId): boolean {
	const context = state.contexts[participantId];
	return participantId === targetId || Boolean(context && (
		context.gamma.agentPointers.includes(targetId)
		|| context.gamma.roles.some((role) => role.targetId === targetId)
	));
}

/** Whether a participant holds an erased, ordinary pointer to another participant. */
export function hasOrdinaryParticipantPointer(state: JudgmentState, participantId: ParticipantId, targetId: ParticipantId): boolean {
	return participantId === targetId || Boolean(state.contexts[participantId]?.gamma.agentPointers.includes(targetId));
}

function isStrictAncestor(state: JudgmentState, ancestorId: ParticipantId, targetId: ParticipantId): boolean {
	let cursor = state.participants[targetId]?.parentId;
	const seen = new Set<ParticipantId>();
	while (cursor && !seen.has(cursor)) {
		if (cursor === ancestorId) return true;
		seen.add(cursor);
		cursor = state.participants[cursor]?.parentId;
	}
	return false;
}

function directEdge(state: JudgmentState, left: ParticipantId, right: ParticipantId): { parentId: ParticipantId; childId: ParticipantId } | undefined {
	if (state.participants[right]?.parentId === left) return { parentId: left, childId: right };
	if (state.participants[left]?.parentId === right) return { parentId: right, childId: left };
	return undefined;
}

function containedMoveSet(state: JudgmentState, resource: JudgmentResource, ownerId: ParticipantId): ResourceId[] {
	if (resource.kind === "net" && resource.public) return [resource.id, ...Object.values(state.resources).filter((candidate) => candidate.kind === "net" && !candidate.public && candidate.derivedFrom === resource.id && ownerOf(state, candidate.id) === ownerId).map((candidate) => candidate.id)];
	if (resource.kind === "web") {
		const selector = resource.domains?.[0] ?? "";
		return [resource.id, ...Object.values(state.resources)
			.filter((candidate) => candidate.id !== resource.id && candidate.kind === "web" && ownerOf(state, candidate.id) === ownerId && hostSelectorContains(selector, candidate.domains?.[0] ?? ""))
			.map((candidate) => candidate.id)];
	}
	if (resource.kind !== "file-region") return [resource.id];
	return [resource.id, ...Object.values(state.resources)
		.filter((candidate) => candidate.id !== resource.id && (candidate.kind === "file" || candidate.kind === "file-region") && ownerOf(state, candidate.id) === ownerId && Boolean(resource.path && candidate.path && pathInside(candidate.path, resource.path)))
		.map((candidate) => candidate.id)];
}

function moveComplete(contexts: Record<ParticipantId, ParticipantContext>, resourceIds: ResourceId[], from: ParticipantId, to: ParticipantId): void {
	const source = contexts[from];
	const target = contexts[to];
	for (const resourceId of resourceIds) {
		const complete = source.delta.completeValues.find((value) => value.identity === resourceId);
		if (!complete) throw new Error(`Δ(${from}) does not contain ${resourceId}`);
		source.delta.completeValues = source.delta.completeValues.filter((value) => value.identity !== resourceId);
		target.delta.completeValues = [...target.delta.completeValues.filter((value) => value.identity !== resourceId), complete];
		source.gamma.resourcePointers = unique([...source.gamma.resourcePointers, resourceId]);
		target.gamma.resourcePointers = unique([...target.gamma.resourcePointers, resourceId]);
	}
}

function addPointer(contexts: Record<ParticipantId, ParticipantContext>, participantId: ParticipantId, resourceId: ResourceId): void {
	contexts[participantId].gamma.resourcePointers = unique([...contexts[participantId].gamma.resourcePointers, resourceId]);
}

function result(
	operation: Judgment,
	contexts: Record<ParticipantId, ParticipantContext>,
	options: Partial<Pick<JudgmentDerivation, "resultType" | "effect" | "affectedResources" | "targetId" | "stateId">> = {},
): JudgmentResult {
	return {
		accepted: true,
		derivation: {
			judgment: operation.kind,
			participantId: operation.participantId,
			resultType: options.resultType ?? "Unit",
			effect: options.effect ?? (operation.kind === "bash" ? "IO" : "Share"),
			contexts,
			affectedResources: options.affectedResources ?? [],
			targetId: options.targetId,
			stateId: options.stateId,
		},
	};
}

function reject(operation: Judgment, code: JudgmentDiagnosticCode, message: string, resourceId?: string, targetId?: string): JudgmentResult {
	return { accepted: false, error: { code, message, participantId: operation.participantId, resourceId, targetId } };
}

export type ReceiveJudgment = Extract<Judgment, { kind: "receive" }>;

interface ReceiveIndex {
	live: Set<string>;
	queues: Map<string, JudgmentMessage[]>;
	cursors: Map<string, number>;
	consumed: Set<string>;
}

function receiveQueueKey(senderId: ParticipantId, kind: JudgmentMessage["kind"]): string { return `${senderId}\0${kind}`; }

function buildReceiveIndex(state: JudgmentState, participantId: ParticipantId, contexts: Record<ParticipantId, ParticipantContext>): ReceiveIndex {
	const live = new Set(contexts[participantId].delta.completeValues.filter((value) => value.type === "Message").map((value) => value.identity));
	const queues = new Map<string, JudgmentMessage[]>();
	for (const messageId of live) {
		const message = state.messages[messageId];
		if (!message || message.targetId !== participantId || message.consumedAt) continue;
		const key = receiveQueueKey(message.senderId, message.kind);
		const queue = queues.get(key) ?? [];
		queue.push(message);
		queues.set(key, queue);
	}
	for (const queue of queues.values()) queue.sort((left, right) => left.sequence - right.sequence || left.sentAt - right.sentAt || left.id.localeCompare(right.id));
	return { live, queues, cursors: new Map(), consumed: new Set() };
}

function applyReceiveJudgment(state: JudgmentState, operation: ReceiveJudgment, index: ReceiveIndex): JudgmentResult | undefined {
	const participant = state.participants[operation.participantId];
	if (!participant || !state.contexts[operation.participantId]) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.participantId}`);
	const sender = state.participants[operation.senderId] ?? state.participantTombstones?.[operation.senderId];
	if (!sender) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.senderId}`, undefined, operation.senderId);
	if ((participant.kind !== "human" && participant.kind !== "agent") || (sender.kind !== "human" && sender.kind !== "agent")) return reject(operation, "PARTICIPANT_KIND_MISMATCH", "receive is only defined between Human and Agent participants", undefined, operation.senderId);
	if (operation.filtered && !hasOrdinaryParticipantPointer(state, participant.id, operation.senderId)) return reject(operation, "ROLE_FORGERY", `${participant.id} has no ordinary participant pointer to ${operation.senderId}`, undefined, operation.senderId);
	const message = state.messages[operation.messageId];
	if (!message || message.senderId !== operation.senderId || message.targetId !== participant.id) return reject(operation, "MESSAGE_NOT_AVAILABLE", `Message ${operation.messageId} is not available from ${operation.senderId}`, undefined, operation.senderId);
	if (message.consumedAt) return reject(operation, "MESSAGE_ALREADY_CONSUMED", `Message ${message.id} was already consumed`);
	if (!index.live.has(message.id)) return reject(operation, "MESSAGE_NOT_AVAILABLE", `Message ${message.id} has no live value in Δ`, undefined, operation.senderId);
	const key = receiveQueueKey(message.senderId, message.kind);
	const queue = index.queues.get(key) ?? [];
	const cursor = index.cursors.get(key) ?? 0;
	if (queue[cursor]?.id !== message.id) return reject(operation, "MESSAGE_OUT_OF_ORDER", `Message ${message.id} is not the next Message from ${operation.senderId}`, undefined, operation.senderId);
	index.cursors.set(key, cursor + 1);
	index.live.delete(message.id);
	index.consumed.add(message.id);
	return undefined;
}

/** Thread a sequence of receive judgments through one Γ/Δ clone. */
export function deriveReceiveJudgments(state: JudgmentState, operations: readonly ReceiveJudgment[]): JudgmentResult {
	if (state.archived && operations.length) return reject(operations[0], "PARTICIPANT_STATUS_MISMATCH", "Workspace is archived");
	if (!operations.length) throw new Error("deriveReceiveJudgments requires at least one Judgment");
	const participantId = operations[0].participantId;
	const participant = state.participants[participantId];
	if (!participant || !state.contexts[participantId]) return reject(operations[0], "UNKNOWN_PARTICIPANT", `Unknown participant ${participantId}`);
	const contexts = cloneContexts(state.contexts);
	const index = buildReceiveIndex(state, participantId, contexts);
	for (const operation of operations) {
		if (operation.participantId !== participantId) return reject(operation, "UNKNOWN_PARTICIPANT", "A receive sequence must have one recipient");
		const rejected = applyReceiveJudgment(state, operation, index);
		if (rejected) return rejected;
	}
	contexts[participantId].delta.completeValues = contexts[participantId].delta.completeValues.filter((value) => !index.consumed.has(value.identity));
	return result(operations[operations.length - 1], contexts, { resultType: "String", targetId: operations[operations.length - 1].senderId });
}

export function deriveJudgment(state: JudgmentState, operation: Judgment): JudgmentResult {
	if (state.archived) return reject(operation, "PARTICIPANT_STATUS_MISMATCH", "Workspace is archived");
	const participant = state.participants[operation.participantId];
	if (!participant || !state.contexts[operation.participantId]) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.participantId}`);
	// Most judgments inspect Γ/Δ without changing them. Preserve the existing
	// post-context in those cases and clone operations that introduce or move bindings.
	const contexts = operation.kind === "participants" || operation.kind === "spawn" || operation.kind === "give" || operation.kind === "get"
		? cloneContexts(state.contexts)
		: state.contexts;

	switch (operation.kind) {
		case "connect":
		case "net-refine":
		case "publish":
		case "unpublish": {
			const resource = state.resources[operation.resourceId];
			if (!resource || resource.kind !== "net") return reject(operation, "UNKNOWN_RESOURCE", "Expected a Net resource", operation.resourceId);
			if (operation.kind === "connect" ? !canObserveResource(state, participant.id, resource.id) : ownerOf(state, resource.id) !== participant.id) return reject(operation, "UNAUTHORIZED_WRITE", `${operation.kind} requires ${operation.kind === "connect" ? "Net or &Net" : "complete Net"}`, resource.id);
			if (operation.kind === "publish" || operation.kind === "unpublish") {
				if (state.participants[operation.targetId]?.kind !== "term" || !isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", "Publication requires control of a descendant Term", resource.id, operation.targetId);
			}
			return result(operation, contexts, { effect: "IO", affectedResources: [resource.id] });
		}
		case "read":
		case "stat": {
			const resource = resolveFile(state, operation.path);
			if (!canReadPath(state, participant.id, operation.path)) return reject(operation, "UNAUTHORIZED_READ", `${participant.id} cannot ${operation.kind} ${operation.path}`, resource?.id);
			if (resource?.divergence) return reject(operation, "RESOURCE_DIVERGED", `File ${resource.id} is marked divergent`, resource.id);
			return result(operation, contexts, { resultType: operation.kind === "read" ? "State_File" : "FileStatus", affectedResources: resource ? [resource.id] : [] });
		}
		case "write":
		case "edit": {
			const resource = resolveFile(state, operation.path);
			if (resource?.divergence) return reject(operation, "RESOURCE_DIVERGED", `File ${resource.id} is marked divergent`, resource.id);
			if (!canWritePath(state, participant.id, operation.path)) return reject(operation, "UNAUTHORIZED_WRITE", `${participant.id} cannot ${operation.kind} ${operation.path}`, resource?.id);
			return result(operation, contexts, { resultType: "File", affectedResources: resource ? [resource.id] : [] });
		}
		case "bash":
			return result(operation, contexts, { resultType: "ProcessResult", effect: "IO", affectedResources: contexts[participant.id].delta.completeValues.map((value) => value.identity).filter((id) => Boolean(state.resources[id])) });
		case "spawn": {
			if (state.participants[operation.childId] || contexts[operation.childId]) return reject(operation, "PARTICIPANT_EXISTS", `Participant ${operation.childId} already exists`, undefined, operation.childId);
			const prefix = `${operation.participantKind}:`;
			if (!operation.childId.startsWith(prefix) || operation.childId.length === prefix.length) return reject(operation, "PARTICIPANT_KIND_MISMATCH", `${operation.childId} is not a canonical ${operation.participantKind} participant ID`, undefined, operation.childId);
			contexts[operation.childId] = emptyContext(operation.childId, operation.participantKind);
			contexts[operation.childId].gamma.agentPointers = unique([...contexts[operation.childId].gamma.agentPointers, participant.id]);
			contexts[operation.childId].gamma.roles.push({ targetId: participant.id, role: "child" });
			contexts[participant.id].gamma.agentPointers = unique([...contexts[participant.id].gamma.agentPointers, operation.childId]);
			contexts[participant.id].gamma.roles.push({ targetId: operation.childId, role: "parent" });
			const affected: ResourceId[] = [];
			for (const grant of operation.grants) {
				const resource = state.resources[grant.resourceId];
				if (!resource) return reject(operation, "UNKNOWN_RESOURCE", `Unknown resource ${grant.resourceId}`, grant.resourceId);
				if (grant.mode === "read") {
					if ((resource.kind === "net" && ownerOf(state, resource.id) !== participant.id) || !canObserveResource(state, participant.id, resource.id)) return reject(operation, "UNAUTHORIZED_READ", `${participant.id} cannot share pointer ${resource.id}`, resource.id);
					addPointer(contexts, operation.childId, resource.id);
				} else {
					if (ownerOf(state, resource.id) !== participant.id) return reject(operation, "UNAUTHORIZED_WRITE", `${participant.id} does not hold ${resource.id}`, resource.id);
					const moved = containedMoveSet(state, resource, participant.id);
					moveComplete(contexts, moved, participant.id, operation.childId);
					if (resource.kind === "net") contexts[participant.id].gamma.resourcePointers = contexts[participant.id].gamma.resourcePointers.filter((id) => !moved.includes(id));
					affected.push(...moved);
				}
			}
			return result(operation, contexts, { resultType: completeParticipantType(operation.participantKind), affectedResources: unique(affected), targetId: operation.childId });
		}
		case "stop":
		case "interrupt": {
			if (!isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not an ancestor of ${operation.targetId}`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId });
		}
		case "listen": {
			if (!isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not an ancestor of ${operation.targetId}`, undefined, operation.targetId);
			return result(operation, contexts, { resultType: "String", targetId: operation.targetId });
		}
		case "wait": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}`, undefined, operation.targetId);
			if (!isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not an ancestor of ${operation.targetId}`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId });
		}
		case "exec":
		case "input": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}`, undefined, operation.targetId);
			if (!isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not an ancestor of ${operation.targetId}`, undefined, operation.targetId);
			if (target.kind !== "term") return reject(operation, "PARTICIPANT_KIND_MISMATCH", `${operation.kind} requires a Term target`, undefined, operation.targetId);
			const satisfied = operation.kind === "exec" ? target.status === "ready" || target.status === "stopped" : target.status === "running";
			if (!satisfied) return reject(operation, "PARTICIPANT_STATUS_MISMATCH", `${operation.kind} is not available while ${operation.targetId} is ${target.status}`, undefined, operation.targetId);
			return result(operation, contexts, { resultType: "Unit", effect: "IO", targetId: operation.targetId });
		}
		case "steer":
		case "attach": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}`, undefined, operation.targetId);
			if (target.kind !== "agent") return reject(operation, "PARTICIPANT_KIND_MISMATCH", `${operation.kind} requires an Agent target`, undefined, operation.targetId);
			if (!isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not an ancestor of ${operation.targetId}`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId });
		}
		case "participants": {
			// Discovery is a trusted gateway: callers supply no target IDs.
			// It introduces ordinary pointers only, never lineage roles or resources.
			contexts[participant.id].gamma.agentPointers = unique([
				...contexts[participant.id].gamma.agentPointers,
				...Object.keys(state.participants),
			]);
			return result(operation, contexts, { resultType: "Participant[]" });
		}
		case "send": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}; call participants to discover current IDs and obtain ordinary participant pointers before retrying send`, undefined, operation.targetId);
			if ((participant.kind !== "agent" && participant.kind !== "human") || (target.kind !== "agent" && target.kind !== "human")) return reject(operation, "PARTICIPANT_KIND_MISMATCH", "send is only defined between Human and Agent participants", undefined, operation.targetId);
			if (!hasParticipantPointer(state, participant.id, operation.targetId) && !isStrictAncestor(state, participant.id, operation.targetId)) return reject(operation, "ROLE_FORGERY", `${participant.id} has no participant pointer to ${operation.targetId}; call participants to discover current IDs and obtain ordinary participant pointers before retrying send`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId });
		}
		case "receive": {
			return deriveReceiveJudgments(state, [operation]);
		}
		case "give": {
			const edge = directEdge(state, participant.id, operation.peerId);
			if (!edge) return reject(operation, "ROLE_MISMATCH", `${operation.peerId} is not a parent or child of ${participant.id}`, operation.resourceId, operation.peerId);
			const resource = state.resources[operation.resourceId];
			if (!resource) return reject(operation, "UNKNOWN_RESOURCE", `Unknown resource ${operation.resourceId}`, operation.resourceId);
			if (operation.mode === "read") {
				if ((resource.kind === "net" && ownerOf(state, resource.id) !== participant.id) || !canObserveResource(state, participant.id, resource.id)) return reject(operation, "UNAUTHORIZED_READ", `${participant.id} has no pointer to ${resource.id}`, resource.id);
				addPointer(contexts, operation.peerId, resource.id);
				return result(operation, contexts, { affectedResources: [resource.id], targetId: operation.peerId });
			}
			if (ownerOf(state, resource.id) !== participant.id) return reject(operation, "UNAUTHORIZED_WRITE", `${participant.id} does not own ${resource.id}`, resource.id);
			const moved = containedMoveSet(state, resource, participant.id);
			moveComplete(contexts, moved, participant.id, operation.peerId);
			if (resource.kind === "net") contexts[participant.id].gamma.resourcePointers = contexts[participant.id].gamma.resourcePointers.filter((id) => !moved.includes(id));
			return result(operation, contexts, { affectedResources: moved, targetId: operation.peerId });
		}
		case "get": {
			if (state.participants[operation.peerId]?.parentId !== participant.id) return reject(operation, "ROLE_MISMATCH", `${operation.peerId} is not a direct child of ${participant.id}`, operation.resourceId, operation.peerId);
			const resource = state.resources[operation.resourceId];
			if (!resource) return reject(operation, "UNKNOWN_RESOURCE", `Unknown resource ${operation.resourceId}`, operation.resourceId);
			if (ownerOf(state, resource.id) !== operation.peerId) return reject(operation, "ROLE_MISMATCH", `${operation.peerId} does not own ${resource.id}`, resource.id, operation.peerId);
			const moved = containedMoveSet(state, resource, operation.peerId);
			moveComplete(contexts, moved, operation.peerId, participant.id);
			if (resource.kind === "net") contexts[operation.peerId].gamma.resourcePointers = contexts[operation.peerId].gamma.resourcePointers.filter((id) => !moved.includes(id));
			return result(operation, contexts, { resultType: "Resource", affectedResources: moved, targetId: operation.peerId });
		}
		case "archive": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}`, undefined, operation.targetId);
			if (target.parentId !== participant.id) return reject(operation, "ROLE_MISMATCH", `${operation.targetId} is not a direct child of ${participant.id}`, undefined, operation.targetId);
			if (target.status !== "stopped") return reject(operation, "PARTICIPANT_STATUS_MISMATCH", `${operation.targetId} must be stopped before archive`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId });
		}
		case "checkout": {
			const resource = state.resources[operation.resourceId];
			if (!resource) return reject(operation, "UNKNOWN_RESOURCE", `Unknown resource ${operation.resourceId}`, operation.resourceId);
			if (resource.kind !== "file" || !resource.versioned) return reject(operation, "STATE_NOT_AVAILABLE", `${resource.id} does not support checkout`, resource.id);
			if (ownerOf(state, resource.id) !== participant.id) return reject(operation, "UNAUTHORIZED_WRITE", `${participant.id} does not hold ${resource.id}`, resource.id);
			if (resource.divergence) return reject(operation, "RESOURCE_DIVERGED", `${resource.id} is divergent`, resource.id);
			if (!resource.versions?.some((node) => node.id === operation.stateId)) return reject(operation, "STATE_SCOPE_MISMATCH", `State ${operation.stateId} does not belong to ${resource.id}`, resource.id);
			return result(operation, contexts, { resultType: "File", affectedResources: [resource.id], stateId: operation.stateId });
		}
		case "rewind": {
			const target = state.participants[operation.targetId];
			if (target?.kind !== "agent") return reject(operation, "PARTICIPANT_KIND_MISMATCH", "rewind requires an Agent target", undefined, operation.targetId);
			if (target.parentId !== participant.id) return reject(operation, "ROLE_MISMATCH", `${participant.id} is not the parent of ${operation.targetId}`, undefined, operation.targetId);
			const node = state.agentStates[operation.stateId];
			if (!node || node.participantId !== operation.targetId) return reject(operation, "STATE_SCOPE_MISMATCH", `Agent state ${operation.stateId} does not belong to ${operation.targetId}`, undefined, operation.targetId);
			return result(operation, contexts, { targetId: operation.targetId, stateId: operation.stateId });
		}
		case "log-resource": {
			const resource = state.resources[operation.resourceId];
			if (!resource) return reject(operation, "UNKNOWN_RESOURCE", `Unknown resource ${operation.resourceId}`, operation.resourceId);
			if (!canObserveResource(state, participant.id, resource.id)) return reject(operation, "UNAUTHORIZED_READ", `${participant.id} cannot inspect ${resource.id}`, resource.id);
			return result(operation, contexts, { affectedResources: [resource.id] });
		}
		case "log-participant":
		case "log-agent":
		case "log-term": {
			const target = state.participants[operation.targetId];
			if (!target) return reject(operation, "UNKNOWN_PARTICIPANT", `Unknown participant ${operation.targetId}`, undefined, operation.targetId);
			const expectedKind = operation.kind === "log-agent" ? "agent" : operation.kind === "log-term" ? "term" : undefined;
			if (expectedKind && target.kind !== expectedKind) return reject(operation, "PARTICIPANT_KIND_MISMATCH", `${operation.kind} requires a ${expectedKind === "agent" ? "Agent" : "Term"} target`, undefined, operation.targetId);
			if (target.kind !== "agent" && target.kind !== "term") return reject(operation, "PARTICIPANT_KIND_MISMATCH", "participant log is only defined for Agent and Term participants", undefined, operation.targetId);
			const selfAgent = target.kind === "agent" && target.id === participant.id;
			if (!selfAgent && !isStrictAncestor(state, participant.id, target.id)) {
				const requiredRelation = target.kind === "agent" ? "the target Agent itself or its ancestor" : "an ancestor of the target Term";
				return reject(operation, "ROLE_MISMATCH", `${participant.id} cannot log ${target.id}: the caller must be ${requiredRelation}`, undefined, operation.targetId);
			}
			return result(operation, contexts, { targetId: operation.targetId });
		}
	}
}

export class AuthorityViolation extends Error {
	constructor(readonly diagnostic: JudgmentDiagnostic) { super(`${diagnostic.code}: ${diagnostic.message}`); }
}

export function requireJudgment(state: JudgmentState, operation: Judgment): JudgmentDerivation {
	const checked = deriveJudgment(state, operation);
	if (!checked.accepted) throw new AuthorityViolation(checked.error);
	return checked.derivation;
}

export function requireReceiveJudgments(state: JudgmentState, operations: readonly ReceiveJudgment[]): JudgmentDerivation {
	const checked = deriveReceiveJudgments(state, operations);
	if (!checked.accepted) throw new AuthorityViolation(checked.error);
	return checked.derivation;
}

/** Automatic set refinement; this is bookkeeping, not a calculus primitive. */
export function deriveRefinement(state: JudgmentState, refinement: RefinementJudgment): Record<ParticipantId, ParticipantContext> {
	const parent = state.resources[refinement.parentResourceId];
	if (!parent || parent.kind !== "file-region" || !parent.path) throw new Error(`${refinement.parentResourceId} is not a File region`);
	if (refinement.path === parent.path || !pathInside(refinement.path, parent.path)) throw new Error(`${refinement.path} is not a strict refinement of ${parent.path}`);
	assertFileLeafRefinement(state, refinement);
	const mostSpecificParent = Object.values(state.resources)
		.filter((resource) => resource.id !== refinement.resourceId && resource.kind === "file-region" && resource.path && pathInside(refinement.path, resource.path))
		.sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
	if (mostSpecificParent && mostSpecificParent.id !== parent.id) {
		throw new Error(`RESOURCE_REFINEMENT_PARENT_MISMATCH: ${refinement.path} must refine ${mostSpecificParent.id}, not ${parent.id}`);
	}
	const owner = ownerOf(state, parent.id);
	if (!owner) throw new Error(`${parent.id} has no complete value in Δ`);
	if (refinement.mode === "write" && (owner !== refinement.participantId || !canWritePath(state, refinement.participantId, refinement.path))) {
		throw new Error(`UNAUTHORIZED_WRITE: ${refinement.participantId} cannot refine ${parent.id} at ${refinement.path}`);
	}
	if (refinement.mode === "read" && !canObserveResource(state, refinement.participantId, parent.id)) throw new Error(`UNAUTHORIZED_READ: ${refinement.participantId} cannot refine ${parent.id}`);
	const contexts = cloneContexts(state.contexts);
	contexts[owner].delta.completeValues = [
		...contexts[owner].delta.completeValues.filter((value) => value.identity !== refinement.resourceId),
		{ identity: refinement.resourceId, type: refinement.resourceType, stateId: refinement.stateId },
	];
	// A readable FileRegion pointer denotes the whole region as a set.  Keep the
	// direct pointer projection canonical instead of backfilling every holder
	// with redundant pointers as descendants are materialized.
	addPointer(contexts, owner, refinement.resourceId);
	return contexts;
}

function assertFileLeafRefinement(state: JudgmentState, refinement: RefinementJudgment): void {
	if (refinement.resourceType !== "File" && refinement.resourceType !== "FileRegion") return;
	const pathResources = Object.values(state.resources)
		.filter((resource) => (resource.kind === "file" || resource.kind === "file-region") && resource.path && resource.id !== refinement.resourceId);
	const ancestorFile = pathResources
		.filter((resource) => resource.kind === "file" && pathInside(refinement.path, resource.path!))
		.sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
	if (ancestorFile) {
		const code = ancestorFile.path === refinement.path ? "FILE_RESOURCE_KIND_MISMATCH" : "FILE_RESOURCE_BOUNDARY";
		throw new Error(`${code}: ${refinement.path} is at or below exact File ${ancestorFile.id}`);
	}
	if (refinement.resourceType === "File") {
		const descendant = pathResources.find((resource) => pathInside(resource.path!, refinement.path));
		if (descendant) throw new Error(`FILE_RESOURCE_BOUNDARY: exact File ${refinement.resourceId} would contain ${descendant.id}`);
	}
}

export function authoritySnapshot(state: JudgmentState, participantId: ParticipantId): { owned: ResourceId[]; pointers: ResourceId[]; children: ParticipantId[]; parent?: ParticipantId } {
	const context = state.contexts[participantId] ?? emptyContext();
	return {
		owned: context.delta.completeValues.map((value) => value.identity).filter((id) => Boolean(state.resources[id])).sort(),
		pointers: context.gamma.resourcePointers.filter((id) => Boolean(state.resources[id])).sort(),
		children: [...(state.participants[participantId]?.childIds ?? [])].sort(),
		parent: state.participants[participantId]?.parentId,
	};
}

export function pathExpressions(state: JudgmentState, participantId: ParticipantId, writable: boolean): PathExpression[] {
	const resources = Object.values(state.resources).filter((resource) => resource.kind === "file" || resource.kind === "file-region");
	const regions = resources.filter((resource) => resource.kind === "file-region" && resource.path);
	const accessible = (resource: JudgmentResource): boolean => writable ? ownerOf(state, resource.id) === participantId : directlyObservesResource(state, participantId, resource.id);
	const expressions = regions.filter(accessible).map((region) => normalizePathExpression(region.path!, resources
		.filter((candidate) => candidate.path !== region.path && candidate.path && pathInside(candidate.path, region.path!))
		.filter((candidate) => !(writable ? canWritePath(state, participantId, candidate.path!) : canReadPath(state, participantId, candidate.path!)))
		.map((candidate) => candidate.path!)));
	if (!state.explicitAuthority && !state.archived && participantId === state.rootParticipantId && !expressions.some((expression) => expression.include === state.base)) {
		expressions.unshift(normalizePathExpression(state.base, resources
			.filter((resource) => resource.path && !(writable ? ownerOf(state, resource.id) === participantId : canObserveResource(state, participantId, resource.id)))
			.map((resource) => resource.path!)));
	}
	return expressions;
}

export function assertWellFormedContexts(state: JudgmentState): void {
	for (const file of Object.values(state.resources).filter((resource) => resource.kind === "file" && resource.path)) {
		const conflict = Object.values(state.resources).find((resource) =>
			resource.id !== file.id
			&& (resource.kind === "file" || resource.kind === "file-region")
			&& Boolean(resource.path && pathInside(resource.path, file.path!)));
		if (conflict) throw new Error(`INVALID_RESOURCE_TREE: exact File ${file.id} cannot contain ${conflict.id}`);
	}
	const owners = new Map<string, ParticipantId>();
	const values = new Map<string, CompleteValue>();
	for (const [participantId, context] of Object.entries(state.contexts)) {
		const participant = state.participants[participantId];
		if (!participant && participantId !== "environment") throw new Error(`Context exists for unknown participant ${participantId}`);
		if (participantId === "environment" && (context.gamma.roles.length || context.gamma.agentPointers.length || context.gamma.resourcePointers.length)) throw new Error("Environment cannot hold participant capabilities");
		if (unique(context.delta.completeValues.map((value) => value.identity)).length !== context.delta.completeValues.length) throw new Error(`Δ for ${participantId} contains duplicate complete values`);
		const roleKeys = context.gamma.roles.map((role) => `${role.role}\0${role.targetId}`);
		if (unique(roleKeys).length !== roleKeys.length) throw new Error(`Γ for ${participantId} contains duplicate participant roles`);
		for (const targetId of context.gamma.agentPointers) {
			if (!state.participants[targetId] && !state.participantTombstones?.[targetId]) throw new Error(`Γ(${participantId}) points to unknown participant ${targetId}`);
		}
		for (const value of context.delta.completeValues) {
			const identity = value.identity;
			const previous = owners.get(identity);
			if (previous && previous !== participantId) throw new Error(`Complete identity ${identity} appears in both Δ(${previous}) and Δ(${participantId})`);
			owners.set(identity, participantId);
			values.set(identity, value);
		}
		if (!participant) continue;
		const self = values.get(participantId);
		const expectedSelfType = completeParticipantType(participant.kind);
		if (!self || self.type !== expectedSelfType || owners.get(participantId) !== participantId) throw new Error(`Participant ${participantId} must self-hold a complete ${expectedSelfType}`);
		for (const role of context.gamma.roles) {
			if (role.role === "ancestor") throw new Error(`Γ(${participantId}) materializes derived ancestor role for ${role.targetId}`);
			const authentic = role.role === "parent"
				? state.participants[role.targetId]?.parentId === participantId
				: state.participants[participantId]?.parentId === role.targetId;
			if (!authentic) throw new Error(`Forged ${role.role} role in Γ(${participantId}) for ${role.targetId}`);
		}
	}
	const root = state.participants[state.rootParticipantId];
	if (!root || root.parentId !== undefined) throw new Error(`Invalid root participant ${state.rootParticipantId}`);
	const childSets = new Map<ParticipantId, Set<ParticipantId>>();
	for (const participant of Object.values(state.participants)) {
		const children = new Set(participant.childIds);
		if (children.size !== participant.childIds.length) throw new Error(`Participant ${participant.id} contains duplicate child edges`);
		childSets.set(participant.id, children);
		for (const childId of children) {
			if (state.participants[childId]?.parentId !== participant.id) throw new Error(`Participant edge ${participant.id} -> ${childId} is not reciprocal`);
		}
	}
	for (const participant of Object.values(state.participants)) {
		if (participant.id === state.rootParticipantId) continue;
		if (!participant.parentId || !childSets.get(participant.parentId)?.has(participant.id)) throw new Error(`Participant ${participant.id} has no valid parent edge`);
	}
	for (const participant of Object.values(state.participants)) {
		const context = state.contexts[participant.id];
		if (!context) throw new Error(`Participant ${participant.id} has no context`);
		const expectedRoles = new Set<string>();
		if (participant.parentId) expectedRoles.add(`child\0${participant.parentId}`);
		for (const childId of participant.childIds) expectedRoles.add(`parent\0${childId}`);
		const actualRoles = new Set(context.gamma.roles.map((role) => `${role.role}\0${role.targetId}`));
		if (actualRoles.size !== expectedRoles.size || [...expectedRoles].some((role) => !actualRoles.has(role))) throw new Error(`Γ(${participant.id}) disagrees with the direct participant tree`);
		const directPointers = [participant.id, participant.parentId, ...participant.childIds].filter((id): id is ParticipantId => Boolean(id));
		if (directPointers.some((targetId) => !context.gamma.agentPointers.includes(targetId))) throw new Error(`Γ(${participant.id}) is missing a derived direct participant pointer`);
	}
	const treeMarks = new Map<ParticipantId, 1 | 2>();
	for (const start of Object.values(state.participants)) {
		if (treeMarks.get(start.id) === 2) continue;
		const chain: ParticipantId[] = [];
		let cursor: JudgmentParticipant | undefined = start;
		while (cursor) {
			const mark = treeMarks.get(cursor.id);
			if (mark === 1) throw new Error(`Participant tree contains a cycle at ${cursor.id}`);
			if (mark === 2) break;
			treeMarks.set(cursor.id, 1);
			chain.push(cursor.id);
			cursor = cursor.parentId ? state.participants[cursor.parentId] : undefined;
		}
		for (const participantId of chain) treeMarks.set(participantId, 2);
	}
	for (const resourceId of Object.keys(state.resources)) if (!owners.has(resourceId)) throw new Error(`Resource ${resourceId} has no complete value in any Δ`);
	for (const participantId of Object.keys(state.participants)) if (!owners.has(participantId)) throw new Error(`Participant ${participantId} has no complete value in any Δ`);
	for (const message of Object.values(state.messages)) {
		const sender = state.participants[message.senderId] ?? state.participantTombstones?.[message.senderId];
		const target = state.participants[message.targetId] ?? state.participantTombstones?.[message.targetId];
		if (!sender || !target || (!message.consumedAt && !state.participants[message.targetId])) throw new Error(`Message ${message.id} names an unknown participant`);
		if (!Number.isFinite(message.sequence) || !Number.isFinite(message.sentAt)) throw new Error(`Message ${message.id} has invalid ordering metadata`);
		const owner = owners.get(message.id);
		if (message.consumedAt) {
			if (owner) throw new Error(`Consumed Message ${message.id} remains live in Δ(${owner})`);
			continue;
		}
		const value = values.get(message.id);
		if (owner !== message.targetId || value?.type !== "Message") throw new Error(`Live Message ${message.id} is not held by ${message.targetId}`);
	}
	for (const [identity] of owners) {
		const value = values.get(identity)!;
		if (value.type === "Message" && !state.messages[identity]) throw new Error(`Message value ${identity} has no runtime payload state`);
	}
	for (const resource of Object.values(state.resources)) {
		const value = values.get(resource.id)!;
		const expectedType = resource.kind === "file" ? "File" : resource.kind === "file-region" ? "FileRegion" : resource.kind === "net" ? "Net" : "Web";
		if (value.type !== expectedType) throw new Error(`Complete ${resource.id} has type ${value.type}, expected ${expectedType}`);
		if (resource.kind === "file" && value.stateId !== resource.currentVersionId) throw new Error(`Δ/Σ disagreement for ${resource.id}: ${String(value.stateId)} != ${String(resource.currentVersionId)}`);
	}
	for (const [participantId, stateId] of Object.entries(state.currentAgentStateIds ?? {})) {
		const value = values.get(participantId);
		if (state.participants[participantId]?.kind !== "agent" || !value || value.type !== "Agent" || value.stateId !== stateId) throw new Error(`Δ/Σ disagreement for Agent ${participantId}`);
		if (state.agentStates[stateId]?.participantId !== participantId) throw new Error(`Current Agent state ${stateId} is outside ${participantId}`);
	}
}
