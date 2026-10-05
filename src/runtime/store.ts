import { legacyAgentBranches, validateAgentBranches } from "./agent-history.js";
import { netReference } from "./net.js";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
	AgentStateNode,
	AuthorityState,
	FileResource,
	MessageRecord,
	ParticipantId,
	ParticipantKind,
	ParticipantRecord,
	ParticipantTombstone,
	ResourceId,
	SnapshotRef,
	TermEpochRecord,
	TypedCheckpoint,
	VersionId,
	VersionNode,
} from "./model.js";
import { canonicalBase, canonicalCandidate, fileResourceId, isInside, parseFileResourceReference } from "./paths.js";
import { resolveWebResourceReference } from "./compat/network.js";
import { assertWellFormedContexts } from "../compiler/judgment.js";
import { normalizeMaxAgentDepth } from "./agent-depth.js";

const ABSENT_HASH = createHash("sha256").update("linden:absent:v1").digest("hex");
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_FIELDS = new Set(["exists", "hash", "blobHash", "mode", "size"]);
const PARTICIPANT_FIELDS = new Set(["name", "kind", "piSessionId", "sessionFile", "status", "createdAt", "rootDir", "permissionMode"]);
const FILE_OPERATIONS = new Set(["initial", "write", "edit", "bash", "term", "recovery", "save"]);
const EFFECT_KINDS = new Set(["participants", "spawn", "subpath", "file", "send", "steer", "wait", "interrupt", "stop", "receive", "give", "get", "write", "edit", "bash", "exec", "input", "checkout", "rewind", "archive", "unarchive", "permission", "save", "publish", "unpublish"]);
export const hashBuffer = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

function assertSnapshotRef(value: unknown, label: string, prefix = "INVALID_LEDGER_V6"): asserts value is SnapshotRef {
	if (!isRecord(value) || typeof value.exists !== "boolean" || typeof value.hash !== "string" || !SHA256_HEX.test(value.hash)) {
		throw new Error(`${prefix}: malformed snapshot ${label}`);
	}
	if (Object.keys(value).some((key) => !SNAPSHOT_FIELDS.has(key))) throw new Error(`${prefix}: unexpected snapshot field in ${label}`);
	if (!value.exists) {
		if (value.hash !== ABSENT_HASH || value.blobHash !== undefined || value.mode !== undefined || value.size !== undefined) throw new Error(`${prefix}: malformed absent snapshot ${label}`);
		return;
	}
	if (typeof value.blobHash !== "string" || value.blobHash !== value.hash || !SHA256_HEX.test(value.blobHash)
		|| !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777
		|| !Number.isSafeInteger(value.size) || value.size < 0) throw new Error(`${prefix}: malformed present snapshot ${label}`);
}

function safeBlobPath(blobDir: string, blobHash: string): string {
	if (!SHA256_HEX.test(blobHash)) throw new Error(`INVALID_SNAPSHOT: invalid blob hash ${blobHash}`);
	const path = resolve(blobDir, blobHash);
	if (!isInside(path, blobDir)) throw new Error(`INVALID_SNAPSHOT: blob path escapes ${blobDir}`);
	return path;
}

export interface FileJournal {
	version: 1;
	type: "file";
	id: string;
	operation: "write" | "edit" | "checkout";
	participantId: ParticipantId;
	resourceId: ResourceId;
	path: string;
	before: SnapshotRef;
	after: SnapshotRef;
	stateNodeId: VersionId;
	targetStateId?: VersionId;
	createdAt: number;
}

export interface BashPlaceholderIdentity {
	device: string;
	inode: string;
	ctimeNs: string;
	mode: number;
	links: string;
}

export interface BashPlaceholderJournal {
	path: string;
	identity?: BashPlaceholderIdentity;
}

export interface BashJournal {
	version: 1;
	type: "bash";
	/** Distinguishes a one-shot Bash transaction from a persistent Term epoch. */
	operation?: "bash" | "term" | "save";
	/** Stable identity reserved before physical execution for idempotent replay. */
	effectId?: string;
	/** Stable Term epoch identity; optional for journals written by early v6 runtimes. */
	termEpochId?: string;
	id: string;
	participantId: ParticipantId;
	roots: string[];
	before: Record<string, SnapshotRef>;
	/** Physical post-state captured after sandbox teardown and placeholder cleanup. */
	after?: Record<string, SnapshotRef>;
	exclusions?: string[];
	placeholders?: BashPlaceholderJournal[];
	createdAt: number;
}

export type JournalRecord = FileJournal | BashJournal;

interface PersistedFileStateV5 {
	versions: VersionNode[];
	current: VersionId;
	divergence?: FileResource["divergence"];
}

interface PersistedParticipantStateV5 {
	name: string;
	kind: "human" | "agent";
	piSessionId?: string;
	sessionFile?: string;
	status: "idle" | "running" | "stopped";
	createdAt: number;
	archived?: boolean;
}
type PersistedParticipantStateV6 = Omit<ParticipantRecord, "id" | "parentId" | "childIds">;
type PersistedAgentNodeV5 = Omit<AgentStateNode, "participantId">;
type PersistedCheckpointV5 = Omit<TypedCheckpoint, "participantId">;

interface PersistedAgentStateV5 {
	participant: PersistedParticipantStateV5;
	history: PersistedAgentNodeV5[];
	checkpoints: PersistedCheckpointV5[];
	current?: VersionId;
}

interface PersistedParticipantEnvelopeV6 {
	branches?: import("./model.js").AgentBranches;
	participant: PersistedParticipantStateV6;
	history: PersistedAgentNodeV5[];
	checkpoints: PersistedCheckpointV5[];
	current?: VersionId;
}

type PersistedMessageStateV5 = Omit<MessageRecord, "id" | "targetId">;

export type PersistedDeltaEntryV5 =
	| { variable: string; state: PersistedFileStateV5; type: "File"; owner: ParticipantId }
	| { variable: string; state: null; type: "FileRegion"; owner: ParticipantId }
	| { variable: string; state: null; type: "Web" | "Net"; owner: ParticipantId }
	| { variable: ParticipantId; state: PersistedAgentStateV5; type: "Agent"; owner: ParticipantId }
	| { variable: string; state: PersistedMessageStateV5; type: "Message"; owner: ParticipantId };

export type PersistedGammaEntryV5 = {
	variable: string;
	type: "&File" | "&FileRegion" | "&Web" | "&Net" | "&Agent" | "&>Agent";
	owners: ParticipantId[];
};

interface PersistedRuntimeMetadataV5 {
	sessionId: string;
	base: string;
	maxAgentDepth?: number;
	createdAt: number;
	lastOpenedAt: number;
	sequence: number;
	rootParticipantId: ParticipantId;
	effects: Array<Omit<AuthorityState["effects"][number], "kind"> & { kind: AuthorityState["effects"][number]["kind"] | "unarchive" }>;
	/** Consumed Message receipts are history, not live Delta bindings. */
	messageReceipts: MessageRecord[];
}

export interface PersistedLedgerV5 {
	schemaVersion: 5;
	Delta: PersistedDeltaEntryV5[];
	Gamma: PersistedGammaEntryV5[];
	runtimeMetadata: PersistedRuntimeMetadataV5;
}

export type PersistedDeltaEntryV6 =
	| { variable: string; state: PersistedFileStateV5; type: "File"; owner: ParticipantId }
	| { variable: string; state: null; type: "FileRegion"; owner: ParticipantId }
	| { variable: string; state: null; type: "Web"; owner: ParticipantId }
	| { variable: string; state: { derivedFrom?: string }; type: "Net"; owner: ParticipantId }
	| { variable: ParticipantId; state: PersistedParticipantEnvelopeV6; type: "Human" | "Agent" | "Term"; owner: ParticipantId }
	| { variable: string; state: PersistedMessageStateV5; type: "Message"; owner: ParticipantId };

export type PersistedGammaEntryV6 = {
	variable: string;
	type: "&File" | "&FileRegion" | "&Web" | "&Net" | "&Human" | "&Agent" | "&Term" | "&>Human" | "&>Agent" | "&>Term";
	owners: ParticipantId[];
};

interface PersistedRuntimeMetadataV6 extends Omit<PersistedRuntimeMetadataV5, "effects"> {
	effects: AuthorityState["effects"];
	explicitAuthority?: boolean;
	initialPermissions?: string[];
	archived?: boolean;
	archives?: AuthorityState["archives"];
	workspaceContexts?: AuthorityState["contexts"];
	workspaceFiles?: AuthorityState["workspaceFiles"];
	saveBaseline?: AuthorityState["saveBaseline"];
	runtimeEvents?: AuthorityState["runtimeEvents"];
	/** Optional for compatibility with v6 ledgers written before tombstones. */
	participantTombstones?: ParticipantTombstone[];
	/** Optional for compatibility with v6 ledgers written before durable Term logs. */
	termEpochs?: TermEpochRecord[];
}

export interface PersistedLedgerV6 {
	schemaVersion: 6 | 7 | 8;
	Delta: PersistedDeltaEntryV6[];
	Gamma: PersistedGammaEntryV6[];
	runtimeMetadata: PersistedRuntimeMetadataV6;
}

export interface LedgerV5MigrationOptions {
	/** Restore every legacy archived participant as a live participant. Required if archived=true occurs. */
	restoreArchived?: boolean;
}

const persistedType = (kind: "file" | "file-region" | "web" | "net"): "File" | "FileRegion" | "Web" | "Net" =>
	kind === "file" ? "File" : kind === "file-region" ? "FileRegion" : kind === "net" ? "Net" : "Web";

const pointerType = (kind: "file" | "file-region" | "web" | "net"): "&File" | "&FileRegion" | "&Web" | "&Net" =>
	kind === "file" ? "&File" : kind === "file-region" ? "&FileRegion" : kind === "net" ? "&Net" : "&Web";

const persistedParticipantType = (kind: ParticipantKind): "Human" | "Agent" | "Term" =>
	kind === "human" ? "Human" : kind === "term" ? "Term" : "Agent";

const comparePersistedString = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const comparePersistedBinding = (left: { variable: string; type: string }, right: { variable: string; type: string }): number =>
	comparePersistedString(left.variable, right.variable) || comparePersistedString(left.type, right.type);
const compareTermEpoch = (left: TermEpochRecord, right: TermEpochRecord): number =>
	left.startedAt - right.startedAt || comparePersistedString(left.id, right.id);
const TERM_EPOCH_FIELDS = new Set(["id", "termId", "effectId", "startedAt", "endedAt", "forced", "recovered", "status", "trace"]);

function encodeTermEpochs(state: AuthorityState): TermEpochRecord[] {
	const effects = new Map(state.effects.map((effect) => [effect.id, effect]));
	const effectIds = new Set<string>();
	const records = Object.entries(state.termEpochs).map(([id, record]) => {
		if (!isRecord(record) || Object.keys(record).some((key) => !TERM_EPOCH_FIELDS.has(key))
			|| record.id !== id || !id || typeof record.termId !== "string" || !record.termId
			|| typeof record.effectId !== "string" || !record.effectId || effectIds.has(record.effectId)
			|| typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)
			|| typeof record.endedAt !== "number" || !Number.isFinite(record.endedAt) || record.endedAt < record.startedAt
			|| typeof record.forced !== "boolean" || typeof record.recovered !== "boolean"
			|| (record.status !== "committed" && record.status !== "diverged")) throw new Error(`INVALID_RUNTIME_STATE: malformed Term epoch ${id}`);
		const participant = state.participants[record.termId] ?? state.participantTombstones[record.termId];
		if (participant?.kind !== "term") throw new Error(`INVALID_RUNTIME_STATE: Term epoch ${id} names non-Term ${record.termId}`);
		const effect = effects.get(record.effectId);
		if (!effect || effect.kind !== "exec" || effect.participantId !== record.termId || effect.targetId !== record.termId || effect.status !== record.status) {
			throw new Error(`INVALID_RUNTIME_STATE: Term epoch ${id} has no matching exec effect`);
		}
		assertSnapshotRef(record.trace, `Term epoch ${id}`, "INVALID_RUNTIME_STATE");
		if (!record.trace.exists) throw new Error(`INVALID_RUNTIME_STATE: Term epoch ${id} has no trace blob`);
		effectIds.add(record.effectId);
		return { ...record, trace: { ...record.trace } };
	});
	return records.sort(compareTermEpoch);
}

function nativeFilePath(variable: string, region: boolean, base: string, privateRoots: string | string[], enforceBase = true): string {
	try {
		const parsed = parseFileResourceReference(variable);
		const lexicalPath = resolve(base, parsed.address);
		if (enforceBase && !isInside(lexicalPath, base)) throw new Error("identity is lexically outside the session base");
		const boundaries = Array.isArray(privateRoots) ? privateRoots : [privateRoots];
		if (boundaries.some((privateRoot) => isInside(lexicalPath, resolve(privateRoot)))) throw new Error("identity is lexically inside Linden runtime state");
		const path = canonicalCandidate(parsed.address, base);
		if (enforceBase && !isInside(path, base)) throw new Error("identity resolves outside the session base");
		if (boundaries.some((privateRoot) => isInside(path, resolve(privateRoot)))) throw new Error("identity resolves inside Linden runtime state");
		if (fileResourceId(path, parsed.region) !== variable || parsed.region !== region) throw new Error("identity is not canonical for its declared type");
		return path;
	} catch (error) {
		throw new Error(`INVALID_LEDGER_V6: invalid ${region ? "FileRegion" : "File"} variable ${variable}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertAcyclicParentLinks<T extends { id: string; parentId?: string }>(nodes: ReadonlyMap<string, T>, label: string): void {
	const marks = new Map<string, 1 | 2>();
	for (const start of nodes.values()) {
		if (marks.get(start.id) === 2) continue;
		const chain: string[] = [];
		let cursor: T | undefined = start;
		while (cursor) {
			const mark = marks.get(cursor.id);
				if (mark === 1) throw new Error(`INVALID_LEDGER_V6: cycle in ${label} at ${cursor.id}`);
			if (mark === 2) break;
			marks.set(cursor.id, 1);
			chain.push(cursor.id);
			cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
		}
		for (const id of chain) marks.set(id, 2);
	}
}

function webSelector(variable: string): string {
	try {
		const resolved = resolveWebResourceReference(variable);
		if (resolved.id !== variable) throw new Error("identity is not canonical");
		return resolved.selector;
	} catch (error) {
		throw new Error(`INVALID_LEDGER_V6: invalid Web variable ${variable}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const messageStateFields = new Set([
	"sequence", "kind", "senderId", "payloadEntryId", "sentAt", "deliveryBatchId", "queuedAt",
	"deliveredAt", "consumedAt", "consumedBy", "origin", "sourceEntryId", "deferred",
]);

function assertMessageState(value: unknown, label: string, extraFields: string[] = []): asserts value is Record<string, any> {
	if (!isRecord(value) || Object.keys(value).some((key) => !messageStateFields.has(key) && !extraFields.includes(key))
		|| !Number.isSafeInteger(value.sequence) || value.sequence < 0
		|| (value.kind !== "follow_up" && value.kind !== "steering")
		|| typeof value.senderId !== "string" || typeof value.payloadEntryId !== "string" || value.payloadEntryId.length === 0
		|| typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)
		|| (value.deliveryBatchId !== undefined && (typeof value.deliveryBatchId !== "string" || value.deliveryBatchId.length === 0))
		|| (value.queuedAt !== undefined && (typeof value.queuedAt !== "number" || !Number.isFinite(value.queuedAt)))
		|| ((value.deliveryBatchId === undefined) !== (value.queuedAt === undefined))
		|| (value.deliveredAt !== undefined && (typeof value.deliveredAt !== "number" || !Number.isFinite(value.deliveredAt)))
		|| (value.consumedAt !== undefined && (typeof value.consumedAt !== "number" || !Number.isFinite(value.consumedAt)))
		|| (value.consumedBy !== undefined && typeof value.consumedBy !== "string")
		|| (value.origin !== undefined && value.origin !== "explicit" && value.origin !== "assistant_final")
		|| (value.deferred !== undefined && typeof value.deferred !== "boolean")
		|| (value.sourceEntryId !== undefined && typeof value.sourceEntryId !== "string")) throw new Error(`INVALID_LEDGER_V6: malformed Message ${label}`);
}

function addGroupedGamma(
	groups: Map<string, Omit<PersistedGammaEntryV6, "owners"> & { owners: Set<ParticipantId> }>,
	variable: string,
	type: PersistedGammaEntryV6["type"],
	owner: ParticipantId,
): void {
	const key = `${type}\0${variable}`;
	const entry = groups.get(key) ?? { variable, type, owners: new Set<ParticipantId>() };
	entry.owners.add(owner);
	groups.set(key, entry);
}

/** Encode the shared typed-ledger layout; v8 persists Agent branch references. */
export function encodeLedger(state: AuthorityState): PersistedLedgerV6 {
	for (const [id, branches] of Object.entries(state.agentBranches ?? {})) {
		if (state.participants[id]?.kind !== "agent") throw new Error(`INVALID_AGENT_BRANCHES: unknown Agent ${id}`);
		validateAgentBranches(branches, id, state.agentStates, state.currentAgentStateIds[id]);
	}
	if (state.schemaVersion !== 6 && state.schemaVersion !== 7 && state.schemaVersion !== 8) throw new Error(`INVALID_RUNTIME_STATE: expected schemaVersion 6, 7 or 8, received ${String(state.schemaVersion)}`);
	const Delta: PersistedDeltaEntryV6[] = [];
	const owners = new Map<string, ParticipantId>();
	const historyByParticipant = new Map<ParticipantId, PersistedAgentNodeV5[]>();
	for (const { participantId, ...node } of Object.values(state.agentStates)) {
		const history = historyByParticipant.get(participantId) ?? [];
		history.push(node);
		historyByParticipant.set(participantId, history);
	}
	for (const history of historyByParticipant.values()) history.sort((left, right) => left.createdAt - right.createdAt || comparePersistedString(left.id, right.id));
	const checkpointsByParticipant = new Map<ParticipantId, PersistedCheckpointV5[]>();
	for (const { participantId, ...checkpoint } of Object.values(state.checkpoints)) {
		const checkpoints = checkpointsByParticipant.get(participantId) ?? [];
		checkpoints.push(checkpoint);
		checkpointsByParticipant.set(participantId, checkpoints);
	}
	for (const checkpoints of checkpointsByParticipant.values()) checkpoints.sort((left, right) => left.createdAt - right.createdAt || comparePersistedString(left.id, right.id));
	for (const [owner, context] of Object.entries(state.contexts)) {
		for (const value of context.delta.completeValues) {
			if (owners.has(value.identity)) throw new Error(`INVALID_RUNTIME_STATE: duplicate Delta variable ${value.identity}`);
			owners.set(value.identity, owner);
			switch (value.type) {
				case "File": {
					const resource = state.resources[value.identity];
					if (resource?.kind !== "file") throw new Error(`INVALID_RUNTIME_STATE: ${value.identity} is not a File`);
					Delta.push({
						variable: value.identity,
						state: { versions: resource.versions, current: resource.currentVersionId, divergence: resource.divergence },
						type: "File",
						owner,
					});
					break;
				}
				case "FileRegion":
				case "Web": {
					const resource = state.resources[value.identity];
					if (!resource || persistedType(resource.kind) !== value.type) throw new Error(`INVALID_RUNTIME_STATE: ${value.identity} is not a ${value.type}`);
					Delta.push({ variable: value.identity, state: null, type: value.type, owner });
					break;
				}
				case "Net": {
					const resource = state.resources[value.identity];
					if (resource?.kind !== "net") throw new Error("INVALID_RUNTIME_NET");
					Delta.push({ variable: value.identity, state: { derivedFrom: resource.derivedFrom }, type: "Net", owner });
					break;
				}
				case "Human":
				case "Agent":
				case "Term": {
					const record = state.participants[value.identity];
					if (!record) throw new Error(`INVALID_RUNTIME_STATE: unknown participant ${value.identity}`);
					if (persistedParticipantType(record.kind) !== value.type) throw new Error(`INVALID_RUNTIME_STATE: ${value.identity} has ${value.type}, expected ${persistedParticipantType(record.kind)}`);
					if (owner !== value.identity) throw new Error(`INVALID_RUNTIME_STATE: participant ${value.identity} is not self-held`);
					const { id: _id, parentId: _parentId, childIds: _childIds, ...participant } = record;
					Delta.push({
						variable: value.identity,
						state: {
							participant,
							history: record.kind === "agent" ? historyByParticipant.get(value.identity) ?? [] : [],
							checkpoints: record.kind === "agent" ? checkpointsByParticipant.get(value.identity) ?? [] : [],
							...(record.kind === "agent" ? state.schemaVersion >= 8
								? { branches: state.agentBranches?.[value.identity] ?? legacyAgentBranches(state.currentAgentStateIds[value.identity]) }
								: { current: state.currentAgentStateIds[value.identity] } : {}),
						},
						type: persistedParticipantType(record.kind),
						owner,
					});
					break;
				}
				case "Message": {
					const message = state.messages[value.identity];
					if (!message || message.consumedAt) throw new Error(`INVALID_RUNTIME_STATE: ${value.identity} is not a live Message`);
					if (message.targetId !== owner) throw new Error(`INVALID_RUNTIME_STATE: Message ${value.identity} is not held by its target`);
					// Delivery reservations are process-local coordination. A crash must
					// reopen the Message as pending, so they deliberately never enter the
					// durable Delta representation.
					const { id: _id, targetId: _targetId, deliveryBatchId: _deliveryBatchId, queuedAt: _queuedAt, ...messageState } = message;
					Delta.push({ variable: value.identity, state: messageState, type: "Message", owner });
					break;
				}
			}
		}
	}

	for (const id of [...Object.keys(state.participants), ...Object.keys(state.resources)]) {
		if (!owners.has(id)) throw new Error(`INVALID_RUNTIME_STATE: ${id} has no live Delta variable`);
	}
	for (const message of Object.values(state.messages)) {
		if (!message.consumedAt && !owners.has(message.id)) throw new Error(`INVALID_RUNTIME_STATE: live Message ${message.id} has no Delta variable`);
	}

	const gammaGroups = new Map<string, Omit<PersistedGammaEntryV6, "owners"> & { owners: Set<ParticipantId> }>();
	for (const participant of Object.values(state.participants)) {
		if (participant.parentId) addGroupedGamma(gammaGroups, `&>${participant.id}`, `&>${persistedParticipantType(participant.kind)}`, participant.parentId);
	}
	for (const [holder, context] of Object.entries(state.contexts)) {
		const participant = state.participants[holder];
		if (!participant && holder === "environment") continue;
		if (!participant) throw new Error(`INVALID_RUNTIME_STATE: context exists for unknown participant ${holder}`);
		for (const resourceId of context.gamma.resourcePointers) {
			const resource = state.resources[resourceId];
			if (!resource) throw new Error(`INVALID_RUNTIME_STATE: pointer targets unknown resource ${resourceId}`);
			if (owners.get(resourceId) !== holder) addGroupedGamma(gammaGroups, `&${resourceId}`, pointerType(resource.kind), holder);
		}
		const derivedAgentPointers = new Set([holder, participant.parentId, ...participant.childIds].filter((id): id is string => Boolean(id)));
		for (const targetId of context.gamma.agentPointers) {
			const target = state.participants[targetId] ?? state.participantTombstones[targetId];
			if (!target) throw new Error(`INVALID_RUNTIME_STATE: pointer targets unknown participant ${targetId}`);
			if (!derivedAgentPointers.has(targetId)) addGroupedGamma(gammaGroups, `&${targetId}`, `&${persistedParticipantType(target.kind)}`, holder);
		}
	}

	Delta.sort(comparePersistedBinding);
	const Gamma = [...gammaGroups.values()]
		.map(({ owners: groupOwners, ...entry }) => ({ ...entry, owners: [...groupOwners].sort(comparePersistedString) }))
		.sort(comparePersistedBinding);
	const messageReceipts = Object.values(state.messages)
		.filter((message) => Boolean(message.consumedAt))
		.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
		.map(({ deliveryBatchId: _deliveryBatchId, queuedAt: _queuedAt, ...receipt }) => receipt);
	const termEpochs = encodeTermEpochs(state);
	return {
		schemaVersion: state.schemaVersion,
		Delta,
		Gamma,
			runtimeMetadata: {
			sessionId: state.sessionId,
			explicitAuthority: state.explicitAuthority,
			initialPermissions: state.initialPermissions,
			archived: state.archived,
			archives: state.archives,
			workspaceContexts: state.workspaceContexts,
			workspaceFiles: state.workspaceFiles,
			saveBaseline: state.saveBaseline,
			runtimeEvents: state.runtimeEvents,
			base: state.base,
			...(state.maxAgentDepth === undefined ? {} : { maxAgentDepth: state.maxAgentDepth }),
			createdAt: state.createdAt,
			lastOpenedAt: state.lastOpenedAt,
			sequence: state.sequence,
			rootParticipantId: state.rootParticipantId,
				effects: state.effects,
				messageReceipts,
				participantTombstones: Object.values(state.participantTombstones)
					.map((tombstone) => ({ ...tombstone, childIds: [...tombstone.childIds].sort(comparePersistedString) }))
					.sort((left, right) => comparePersistedString(left.id, right.id)),
				termEpochs,
			},
	};
}

const deltaTypesV6 = new Set(["File", "FileRegion", "Web", "Net", "Human", "Agent", "Term", "Message"]);
const gammaTypesV6 = new Set(["&File", "&FileRegion", "&Web", "&Net", "&Human", "&Agent", "&Term", "&>Human", "&>Agent", "&>Term"]);

/** Decode v6/v7, retaining historical validation rules and diagnostics. */
export function decodeLedger(ledger: PersistedLedgerV6, expectedBase?: string, privateRoots: string | string[] = []): AuthorityState {
	if ((ledger.schemaVersion !== 6 && ledger.schemaVersion < 7 && ledger.schemaVersion !== 8) || !Array.isArray(ledger.Delta) || !Array.isArray(ledger.Gamma) || !isRecord(ledger.runtimeMetadata)) {
		throw new Error("INVALID_LEDGER_V6: expected Delta, Gamma, and runtimeMetadata");
	}
	const metadata = ledger.runtimeMetadata;
	if (ledger.schemaVersion >= 7 && (metadata.explicitAuthority !== true || !Array.isArray(metadata.initialPermissions) || metadata.initialPermissions.some((value) => typeof value !== "string" || !/^&?(file:|net:)/.test(value)) || (metadata.archived !== undefined && typeof metadata.archived !== "boolean"))) throw new Error("INVALID_LEDGER_V7: explicit authority metadata required");
	if (typeof metadata.sessionId !== "string" || typeof metadata.base !== "string" || typeof metadata.rootParticipantId !== "string"
		|| !Number.isFinite(metadata.createdAt) || !Number.isFinite(metadata.lastOpenedAt) || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 0
		|| !Array.isArray(metadata.effects) || !Array.isArray(metadata.messageReceipts)) {
		throw new Error("INVALID_LEDGER_V6: malformed runtimeMetadata");
	}
	try { normalizeMaxAgentDepth(metadata.maxAgentDepth, "persisted maxAgentDepth"); }
	catch (error) { throw new Error(`INVALID_LEDGER_V6: ${error instanceof Error ? error.message : String(error)}`); }
	if (expectedBase !== undefined && metadata.base !== expectedBase) throw new Error(`INVALID_LEDGER_V6: session base ${metadata.base} does not match ${expectedBase}`);
	let ledgerBase = expectedBase;
	if (ledgerBase === undefined) {
		try { ledgerBase = canonicalBase(metadata.base); }
		catch (error) { throw new Error(`INVALID_LEDGER_V6: invalid session base ${metadata.base}: ${error instanceof Error ? error.message : String(error)}`); }
		if (ledgerBase !== metadata.base) throw new Error(`INVALID_LEDGER_V6: non-canonical session base ${metadata.base}`);
	}

	const contexts = Object.create(null) as AuthorityState["contexts"];
	const participants = Object.create(null) as AuthorityState["participants"];
	const resources = Object.create(null) as AuthorityState["resources"];
	const messages = Object.create(null) as AuthorityState["messages"];
	const checkpoints = Object.create(null) as AuthorityState["checkpoints"];
	const agentStates = Object.create(null) as AuthorityState["agentStates"];
	const currentAgentStateIds = Object.create(null) as AuthorityState["currentAgentStateIds"];
	const agentBranches: NonNullable<AuthorityState["agentBranches"]> = Object.create(null);
	const participantTombstones = Object.create(null) as AuthorityState["participantTombstones"];
	const termEpochs = Object.create(null) as AuthorityState["termEpochs"];
	const deltaTypes = new Map<string, PersistedDeltaEntryV6["type"]>();
	const deltaOwners = new Map<string, ParticipantId>();
	let previousDeltaEntry: { variable: string; type: string } | undefined;
	const messageSequences = new Set<number>();
	const piSessionOwners = new Map<string, ParticipantId>();
	const sessionFileOwners = new Map<string, ParticipantId>();

	for (const entry of ledger.Delta) {
		if (!isRecord(entry) || typeof entry.variable !== "string" || typeof entry.type !== "string" || typeof entry.owner !== "string") {
			throw new Error("INVALID_LEDGER_V6: malformed Delta entry");
		}
		if (!deltaTypesV6.has(entry.type)) throw new Error(`INVALID_LEDGER_V6: unknown Delta type ${entry.type}`);
		if (previousDeltaEntry !== undefined && comparePersistedBinding(previousDeltaEntry, entry) > 0) throw new Error("INVALID_LEDGER_V6: Delta is not in canonical order");
		previousDeltaEntry = entry;
		if (deltaTypes.has(entry.variable)) throw new Error(`INVALID_LEDGER_V6: duplicate Delta variable ${entry.variable}`);
		deltaTypes.set(entry.variable, entry.type);
		deltaOwners.set(entry.variable, entry.owner);
		if (entry.owner === "environment" && (ledger.schemaVersion < 7 || !["File", "FileRegion", "Net", "Web"].includes(entry.type))) throw new Error("INVALID_ENVIRONMENT_BINDING");
		if (entry.type !== "Human" && entry.type !== "Agent" && entry.type !== "Term") continue;
		if (entry.owner !== entry.variable) throw new Error(`INVALID_LEDGER_V6: participant ${entry.variable} is not self-held`);
		if (!isRecord(entry.state) || !isRecord(entry.state.participant) || !Array.isArray(entry.state.history) || !Array.isArray(entry.state.checkpoints)) {
			throw new Error(`INVALID_LEDGER_V6: malformed participant state ${entry.variable}`);
		}
		const { id: _id, parentId: _parentId, childIds: _childIds, ...participantState } = entry.state.participant as PersistedParticipantStateV6 & Record<string, unknown>;
		if (typeof participantState.name !== "string" || (participantState.kind !== "human" && participantState.kind !== "agent" && participantState.kind !== "term")
			|| (participantState.status !== "ready" && participantState.status !== "running" && participantState.status !== "stopped")
			|| typeof participantState.createdAt !== "number" || !Number.isFinite(participantState.createdAt)
			|| (participantState.piSessionId !== undefined && (typeof participantState.piSessionId !== "string" || participantState.piSessionId.length === 0))
			|| (participantState.sessionFile !== undefined && (typeof participantState.sessionFile !== "string" || participantState.sessionFile.length === 0))
			|| (participantState.sessionFile !== undefined && participantState.piSessionId === undefined)
			|| Object.keys(participantState).some((key) => !PARTICIPANT_FIELDS.has(key))) throw new Error(`INVALID_LEDGER_V6: malformed participant state ${entry.variable}`);
		if (!entry.variable.startsWith(`${participantState.kind}:`) || entry.variable.endsWith(":") || persistedParticipantType(participantState.kind as ParticipantKind) !== entry.type) throw new Error(`INVALID_LEDGER_V6: participant variable ${entry.variable} does not match ${entry.type}`);
		if (participantState.kind !== "agent" && (participantState.piSessionId !== undefined || participantState.sessionFile !== undefined)) throw new Error(`INVALID_LEDGER_V6: only Agent may bind a Pi session (${entry.variable})`);
		if (participantState.kind !== "agent" && (entry.state.history.length > 0 || entry.state.checkpoints.length > 0 || entry.state.current !== undefined || entry.state.branches !== undefined)) throw new Error(`INVALID_LEDGER_V6: ${entry.type} ${entry.variable} cannot carry Agent history`);
		if (participantState.piSessionId !== undefined) {
			const previous = piSessionOwners.get(participantState.piSessionId);
			if (previous) throw new Error(`INVALID_LEDGER_V6: Pi session ${participantState.piSessionId} is shared by ${previous} and ${entry.variable}`);
			piSessionOwners.set(participantState.piSessionId, entry.variable);
		}
		if (participantState.sessionFile !== undefined) {
			const previous = sessionFileOwners.get(participantState.sessionFile);
			if (previous) throw new Error(`INVALID_LEDGER_V6: Pi session file ${participantState.sessionFile} is shared by ${previous} and ${entry.variable}`);
			sessionFileOwners.set(participantState.sessionFile, entry.variable);
		}
		participants[entry.variable] = { ...participantState, id: entry.variable, childIds: [] } as ParticipantRecord;
		contexts[entry.variable] = { gamma: { resourcePointers: [], agentPointers: [entry.variable], roles: [] }, delta: { completeValues: [] } };
		for (const persisted of entry.state.history) {
			if (!isRecord(persisted) || typeof persisted.id !== "string" || typeof persisted.checkpointId !== "string" || typeof persisted.piEntryId !== "string" || typeof persisted.createdAt !== "number" || !Number.isFinite(persisted.createdAt)
				|| (persisted.parentId !== undefined && typeof persisted.parentId !== "string")) throw new Error(`INVALID_LEDGER_V6: malformed Agent history for ${entry.variable}`);
			if (agentStates[persisted.id]) throw new Error(`INVALID_LEDGER_V6: duplicate Agent state ${persisted.id}`);
			agentStates[persisted.id] = { ...(persisted as PersistedAgentNodeV5), participantId: entry.variable };
		}
		for (const persisted of entry.state.checkpoints) {
			if (!isRecord(persisted) || typeof persisted.id !== "string" || typeof persisted.piEntryId !== "string" || !Number.isSafeInteger(persisted.ledgerSequence) || persisted.ledgerSequence < 0 || persisted.ledgerSequence > metadata.sequence
				|| typeof persisted.createdAt !== "number" || !Number.isFinite(persisted.createdAt) || !isRecord(persisted.authority)) throw new Error(`INVALID_LEDGER_V6: malformed checkpoint for ${entry.variable}`);
			const authority = persisted.authority;
			if (!Array.isArray(authority.owned) || !Array.isArray(authority.pointers) || !Array.isArray(authority.children)
				|| [...authority.owned, ...authority.pointers, ...authority.children].some((item) => typeof item !== "string")
				|| (authority.parent !== undefined && typeof authority.parent !== "string")) throw new Error(`INVALID_LEDGER_V6: malformed checkpoint authority for ${entry.variable}`);
			if (checkpoints[persisted.id]) throw new Error(`INVALID_LEDGER_V6: duplicate checkpoint ${persisted.id}`);
			checkpoints[persisted.id] = { ...(persisted as PersistedCheckpointV5), participantId: entry.variable };
		}
		if (entry.state.current !== undefined) {
			if (typeof entry.state.current !== "string" || agentStates[entry.state.current]?.participantId !== entry.variable) throw new Error(`INVALID_LEDGER_V6: Agent ${entry.variable} has an invalid current state`);
			currentAgentStateIds[entry.variable] = entry.state.current;
		}
		if (participantState.kind === "agent") {
			if (ledger.schemaVersion >= 8 && (entry.state.branches === undefined || entry.state.current !== undefined)) throw new Error(`INVALID_LEDGER_V8: Agent ${entry.variable} requires branch references instead of current`);
			const branches = entry.state.branches ?? legacyAgentBranches(entry.state.current);
			const head = branches?.heads && Object.hasOwn(branches.heads, branches.current) ? branches.heads[branches.current] : undefined;
			validateAgentBranches(branches, entry.variable, agentStates, head);
			if (entry.state.current !== undefined && entry.state.current !== head) throw new Error(`INVALID_AGENT_CURRENT_BRANCH: ${entry.variable}`);
			agentBranches[entry.variable] = structuredClone(branches);
			if (head !== undefined) currentAgentStateIds[entry.variable] = head;
		}
	}
	for (const node of Object.values(agentStates)) {
		if (checkpoints[node.checkpointId]?.participantId !== node.participantId) throw new Error(`INVALID_LEDGER_V6: Agent state ${node.id} has an out-of-scope checkpoint`);
		if (node.parentId !== undefined && agentStates[node.parentId]?.participantId !== node.participantId) throw new Error(`INVALID_LEDGER_V6: Agent state ${node.id} has an out-of-scope parent`);
	}
	assertAcyclicParentLinks(new Map(Object.values(agentStates).map((node) => [node.id, node])), "Agent history");

	const tombstoneValues = metadata.participantTombstones ?? [];
	if (!Array.isArray(tombstoneValues)) throw new Error("INVALID_LEDGER_V6: participantTombstones must be an array");
	const tombstoneFields = new Set([
		"id", "name", "kind", "parentId", "childIds", "piSessionId", "sessionFile", "status", "createdAt",
		"archivedAt", "archivedBy", "archiveEffectId", "rootDir", "permissionMode",
	]);
	let previousTombstoneId: string | undefined;
	for (const candidate of tombstoneValues) {
		if (!isRecord(candidate) || Object.keys(candidate).some((key) => !tombstoneFields.has(key))
			|| typeof candidate.id !== "string" || typeof candidate.name !== "string"
			|| (candidate.kind !== "human" && candidate.kind !== "agent" && candidate.kind !== "term")
			|| candidate.status !== "stopped" || !Array.isArray(candidate.childIds)
			|| candidate.childIds.some((id: unknown) => typeof id !== "string") || new Set(candidate.childIds).size !== candidate.childIds.length
			|| (candidate.parentId !== undefined && typeof candidate.parentId !== "string")
			|| typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)
			|| typeof candidate.archivedAt !== "number" || !Number.isFinite(candidate.archivedAt) || candidate.archivedAt < candidate.createdAt
			|| typeof candidate.archivedBy !== "string" || typeof candidate.archiveEffectId !== "string"
			|| (candidate.piSessionId !== undefined && (typeof candidate.piSessionId !== "string" || candidate.piSessionId.length === 0))
			|| (candidate.sessionFile !== undefined && (typeof candidate.sessionFile !== "string" || candidate.sessionFile.length === 0))
			|| (candidate.sessionFile !== undefined && candidate.piSessionId === undefined)
			|| !candidate.id.startsWith(`${candidate.kind}:`) || candidate.id.endsWith(":")) {
			throw new Error("INVALID_LEDGER_V6: malformed participant tombstone");
		}
		if (previousTombstoneId !== undefined && comparePersistedString(previousTombstoneId, candidate.id) >= 0) throw new Error("INVALID_LEDGER_V6: participantTombstones are not in canonical order");
		if (candidate.childIds.some((id: string, index: number) => index > 0 && comparePersistedString(candidate.childIds[index - 1], id) >= 0)) throw new Error(`INVALID_LEDGER_V6: retired participant ${candidate.id} childIds are not canonical`);
		previousTombstoneId = candidate.id;
		if (candidate.kind !== "agent" && (candidate.piSessionId !== undefined || candidate.sessionFile !== undefined)) throw new Error(`INVALID_LEDGER_V6: only Agent tombstones may retain a Pi binding (${candidate.id})`);
		if (participants[candidate.id] || participantTombstones[candidate.id]) throw new Error(`INVALID_LEDGER_V6: duplicate live or retired participant ${candidate.id}`);
		if (candidate.piSessionId !== undefined) {
			const previous = piSessionOwners.get(candidate.piSessionId);
			if (previous) throw new Error(`INVALID_LEDGER_V6: Pi session ${candidate.piSessionId} is shared by ${previous} and retired ${candidate.id}`);
			piSessionOwners.set(candidate.piSessionId, candidate.id);
		}
		if (candidate.sessionFile !== undefined) {
			const previous = sessionFileOwners.get(candidate.sessionFile);
			if (previous) throw new Error(`INVALID_LEDGER_V6: Pi session file ${candidate.sessionFile} is shared by ${previous} and retired ${candidate.id}`);
			sessionFileOwners.set(candidate.sessionFile, candidate.id);
		}
		participantTombstones[candidate.id] = candidate as ParticipantTombstone;
	}
	const knownParticipant = (id: string): boolean => Boolean(participants[id] || participantTombstones[id]);

	if (!participants[metadata.rootParticipantId]) throw new Error(`INVALID_LEDGER_V6: unknown root participant ${metadata.rootParticipantId}`);
	const effectIds = new Set<string>();
	const effectsById = new Map<string, AuthorityState["effects"][number]>();
	for (const effect of metadata.effects) {
		if (!isRecord(effect) || typeof effect.id !== "string" || effectIds.has(effect.id) || !Number.isSafeInteger(effect.sequence) || effect.sequence < 0 || effect.sequence > metadata.sequence
			|| !EFFECT_KINDS.has(effect.kind) || typeof effect.participantId !== "string" || !knownParticipant(effect.participantId)
			|| (effect.status !== "committed" && effect.status !== "diverged") || typeof effect.createdAt !== "number" || !Number.isFinite(effect.createdAt)
			|| (effect.targetId !== undefined && (typeof effect.targetId !== "string" || !knownParticipant(effect.targetId))) || (effect.resourceId !== undefined && typeof effect.resourceId !== "string")
			|| (effect.stateId !== undefined && typeof effect.stateId !== "string") || (effect.piEntryId !== undefined && typeof effect.piEntryId !== "string")) throw new Error("INVALID_LEDGER_V6: malformed effect");
		effectIds.add(effect.id);
		effectsById.set(effect.id, effect as AuthorityState["effects"][number]);
	}
	const termEpochValues = metadata.termEpochs ?? [];
	if (!Array.isArray(termEpochValues)) throw new Error("INVALID_LEDGER_V6: termEpochs must be an array");
	let previousTermEpoch: TermEpochRecord | undefined;
	const termEpochEffectIds = new Set<string>();
	for (const candidate of termEpochValues) {
		if (!isRecord(candidate) || Object.keys(candidate).some((key) => !TERM_EPOCH_FIELDS.has(key))
			|| typeof candidate.id !== "string" || candidate.id.length === 0 || termEpochs[candidate.id]
			|| typeof candidate.termId !== "string" || candidate.termId.length === 0
			|| typeof candidate.effectId !== "string" || candidate.effectId.length === 0 || termEpochEffectIds.has(candidate.effectId)
			|| typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt)
			|| typeof candidate.endedAt !== "number" || !Number.isFinite(candidate.endedAt) || candidate.endedAt < candidate.startedAt
			|| typeof candidate.forced !== "boolean" || typeof candidate.recovered !== "boolean"
			|| (candidate.status !== "committed" && candidate.status !== "diverged")) throw new Error("INVALID_LEDGER_V6: malformed Term epoch");
		const record = candidate as TermEpochRecord;
		if (previousTermEpoch && compareTermEpoch(previousTermEpoch, record) >= 0) throw new Error("INVALID_LEDGER_V6: termEpochs are not in canonical order");
		const term = participants[record.termId] ?? participantTombstones[record.termId];
		if (term?.kind !== "term") throw new Error(`INVALID_LEDGER_V6: Term epoch ${record.id} names non-Term ${record.termId}`);
		const effect = effectsById.get(record.effectId);
		if (!effect || effect.kind !== "exec" || effect.participantId !== record.termId || effect.targetId !== record.termId || effect.status !== record.status) {
			throw new Error(`INVALID_LEDGER_V6: Term epoch ${record.id} has no matching exec effect`);
		}
		assertSnapshotRef(record.trace, `Term epoch ${record.id}`);
		if (!record.trace.exists) throw new Error(`INVALID_LEDGER_V6: Term epoch ${record.id} has no trace blob`);
		termEpochs[record.id] = { ...record, trace: { ...record.trace } };
		termEpochEffectIds.add(record.effectId);
		previousTermEpoch = record;
	}
	for (const tombstone of Object.values(participantTombstones)) {
		const effect = effectsById.get(tombstone.archiveEffectId);
		if (!effect || effect.kind !== "archive" || effect.participantId !== tombstone.archivedBy || effect.createdAt !== tombstone.archivedAt
			|| effect.targetId === undefined || participantTombstones[effect.targetId]?.archiveEffectId !== effect.id) {
			throw new Error(`INVALID_LEDGER_V6: retired participant ${tombstone.id} has no matching archive effect`);
		}
		if (!knownParticipant(tombstone.archivedBy)
			|| (tombstone.parentId !== undefined && !knownParticipant(tombstone.parentId))
			|| tombstone.childIds.some((id) => !knownParticipant(id))) throw new Error(`INVALID_LEDGER_V6: retired participant ${tombstone.id} has an unknown historical relation`);
	}
	for (const effect of metadata.effects) {
		if (effect.kind !== "archive") continue;
		if (ledger.schemaVersion >= 7 && (effect.targetId === metadata.rootParticipantId || metadata.effects.some((later) => later.kind === "unarchive" && later.targetId === effect.targetId && later.sequence > effect.sequence))) continue;
		const root = effect.targetId === undefined ? undefined : participantTombstones[effect.targetId];
		if (!root || root.archiveEffectId !== effect.id || root.parentId !== effect.participantId) {
			throw new Error(`INVALID_LEDGER_V6: archive effect ${effect.id} does not identify its retired direct-child root`);
		}
		const group = new Set(Object.values(participantTombstones)
			.filter((tombstone) => tombstone.archiveEffectId === effect.id)
			.map((tombstone) => tombstone.id));
		const visited = new Set<ParticipantId>();
		const visit = (id: ParticipantId): void => {
			if (visited.has(id)) throw new Error(`INVALID_LEDGER_V6: archive effect ${effect.id} contains a participant cycle`);
			const tombstone = participantTombstones[id];
			if (!tombstone || tombstone.archiveEffectId !== effect.id) throw new Error(`INVALID_LEDGER_V6: archive effect ${effect.id} crosses retired subtrees at ${id}`);
			visited.add(id);
			for (const childId of tombstone.childIds) {
				if (participantTombstones[childId]?.parentId !== id) throw new Error(`INVALID_LEDGER_V6: retired edge ${id} -> ${childId} is not reciprocal`);
				visit(childId);
			}
		};
		visit(root.id);
		if (visited.size !== group.size || [...group].some((id) => !visited.has(id))) {
			throw new Error(`INVALID_LEDGER_V6: archive effect ${effect.id} does not form one complete retired subtree`);
		}
	}
	for (const checkpoint of Object.values(checkpoints)) {
		if ((checkpoint.authority.parent !== undefined && !knownParticipant(checkpoint.authority.parent))
			|| checkpoint.authority.children.some((id) => !knownParticipant(id))) throw new Error(`INVALID_LEDGER_V6: checkpoint ${checkpoint.id} names an unknown historical participant`);
	}
	if (ledger.schemaVersion >= 7 && ledger.Delta.some((entry) => entry.owner === "environment")) contexts.environment = { delta: { completeValues: [] }, gamma: { resourcePointers: [], agentPointers: [], roles: [] } };
	for (const entry of ledger.Delta) {
		const context = contexts[entry.owner];
		if (!context) throw new Error(`INVALID_LEDGER_V6: Delta owner ${entry.owner} is not a participant`);
			switch (entry.type) {
			case "File": {
				if (!isRecord(entry.state) || !Array.isArray(entry.state.versions) || typeof entry.state.current !== "string") throw new Error(`INVALID_LEDGER_V6: malformed File state ${entry.variable}`);
				const versions = entry.state.versions as unknown[];
				const versionIds = new Set<string>();
				const versionById = new Map<string, VersionNode>();
				let root: VersionNode | undefined;
				for (const candidate of versions) {
					if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0 || versionIds.has(candidate.id)
						|| typeof candidate.participantId !== "string" || !knownParticipant(candidate.participantId)
						|| typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)
						|| !FILE_OPERATIONS.has(candidate.operation)
						|| (candidate.parentId !== undefined && typeof candidate.parentId !== "string")
						|| (candidate.piEntryId !== undefined && typeof candidate.piEntryId !== "string")) throw new Error(`INVALID_LEDGER_V6: malformed File history ${entry.variable}`);
					assertSnapshotRef(candidate.snapshot, `${entry.variable}:${candidate.id}`);
					versionIds.add(candidate.id);
					versionById.set(candidate.id, candidate as VersionNode);
					if (candidate.parentId === undefined) {
						if (root) throw new Error(`INVALID_LEDGER_V6: File ${entry.variable} history must have one initial root`);
						root = candidate as VersionNode;
					}
				}
				if (versions.length === 0 || !versionIds.has(entry.state.current)) throw new Error(`INVALID_LEDGER_V6: File ${entry.variable} current state is outside its history`);
				if (!root || root.operation !== "initial") throw new Error(`INVALID_LEDGER_V6: File ${entry.variable} history must have one initial root`);
				for (const candidate of versions) {
					if (!isRecord(candidate)) continue;
					if (candidate.parentId !== undefined && (!versionIds.has(candidate.parentId) || candidate.operation === "initial")) throw new Error(`INVALID_LEDGER_V6: invalid parent in File history ${entry.variable}`);
				}
				assertAcyclicParentLinks(versionById, `File history ${entry.variable}`);
				if (entry.state.divergence !== undefined && (!isRecord(entry.state.divergence)
					|| typeof entry.state.divergence.expectedHash !== "string" || !SHA256_HEX.test(entry.state.divergence.expectedHash)
					|| typeof entry.state.divergence.actualHash !== "string" || !SHA256_HEX.test(entry.state.divergence.actualHash)
					|| typeof entry.state.divergence.detectedAt !== "number" || !Number.isFinite(entry.state.divergence.detectedAt))) throw new Error(`INVALID_LEDGER_V6: malformed divergence for ${entry.variable}`);
				resources[entry.variable] = {
					id: entry.variable,
					kind: "file",
					path: nativeFilePath(entry.variable, false, ledgerBase, privateRoots, ledger.schemaVersion === 6),
					versioned: true,
					versions: entry.state.versions,
					currentVersionId: entry.state.current,
					divergence: entry.state.divergence,
					createdAt: entry.state.versions[0]?.createdAt ?? metadata.createdAt,
				};
				context.delta.completeValues.push({ identity: entry.variable, type: "File", stateId: entry.state.current });
				if (entry.owner !== "environment") context.gamma.resourcePointers.push(entry.variable);
				break;
			}
			case "FileRegion": {
				const variable = entry.variable;
				if (entry.state !== null) throw new Error(`INVALID_LEDGER_V6: FileRegion ${variable} state must be null`);
				resources[entry.variable] = { id: entry.variable, kind: "file-region", path: nativeFilePath(entry.variable, true, ledgerBase, privateRoots, ledger.schemaVersion === 6), createdAt: metadata.createdAt };
				context.delta.completeValues.push({ identity: entry.variable, type: "FileRegion" });
				if (entry.owner !== "environment") context.gamma.resourcePointers.push(entry.variable);
				break;
			}
			case "Net": {
				if (ledger.schemaVersion < 7 || !isRecord(entry.state) || Object.keys(entry.state).some((key) => key !== "derivedFrom") || (entry.state.derivedFrom !== undefined && entry.state.derivedFrom !== "net:tcp/public")) throw new Error("INVALID_NET_BINDING");
				const endpoint = netReference(entry.variable);
				if (endpoint.id !== entry.variable) throw new Error("NON_CANONICAL_NET");
				resources[entry.variable] = { ...endpoint, kind: "net", derivedFrom: entry.state.derivedFrom, createdAt: metadata.createdAt };
				context.delta.completeValues.push({ identity: entry.variable, type: "Net" });
				if (entry.owner !== "environment") context.gamma.resourcePointers.push(entry.variable);
				break;
			}
			case "Web": {
				const variable = entry.variable;
				if (entry.state !== null) throw new Error(`INVALID_LEDGER_V6: Web ${variable} state must be null`);
				resources[entry.variable] = { id: entry.variable, kind: "web", domains: [webSelector(entry.variable)], createdAt: metadata.createdAt };
				context.delta.completeValues.push({ identity: entry.variable, type: "Web" });
				if (entry.owner !== "environment") context.gamma.resourcePointers.push(entry.variable);
				break;
			}
			case "Human":
			case "Agent":
			case "Term":
				context.delta.completeValues.push({ identity: entry.variable, type: entry.type, stateId: entry.type === "Agent" ? currentAgentStateIds[entry.variable] : undefined });
				break;
			case "Message": {
				assertMessageState(entry.state, entry.variable);
				if (entry.state.consumedAt !== undefined || entry.state.consumedBy !== undefined || entry.state.deliveredAt !== undefined) throw new Error(`INVALID_LEDGER_V6: ${entry.variable} is not a live Message`);
				if (entry.state.sequence > metadata.sequence || messageSequences.has(entry.state.sequence)) throw new Error(`INVALID_LEDGER_V6: Message ${entry.variable} has an invalid sequence`);
				messageSequences.add(entry.state.sequence);
				if (!entry.variable.startsWith("msg:")) throw new Error(`INVALID_LEDGER_V6: Message variable ${entry.variable} must start with msg:`);
				if (!knownParticipant(entry.state.senderId)) throw new Error(`INVALID_LEDGER_V6: Message ${entry.variable} has unknown sender ${entry.state.senderId}`);
				const liveSender = participants[entry.state.senderId] ?? participantTombstones[entry.state.senderId];
				if (liveSender.kind === "human" && !/^private:[0-9a-f]{64}$/.test(entry.state.payloadEntryId)) throw new Error(`INVALID_LEDGER_V6: Message ${entry.variable} has an invalid private payload reference`);
				messages[entry.variable] = { ...(entry.state as PersistedMessageStateV5), id: entry.variable, targetId: entry.owner };
				context.delta.completeValues.push({ identity: entry.variable, type: "Message" });
				break;
			}
		}
	}

	for (const receipt of metadata.messageReceipts) {
		assertMessageState(receipt, "receipt", ["id", "targetId"]);
		if (typeof receipt.id !== "string" || !receipt.id.startsWith("msg:") || typeof receipt.targetId !== "string"
			|| !knownParticipant(receipt.senderId) || !knownParticipant(receipt.targetId)
			|| receipt.consumedAt === undefined || receipt.deliveredAt === undefined || receipt.consumedBy !== receipt.targetId) throw new Error("INVALID_LEDGER_V6: malformed Message receipt");
		const historicalSender = participants[receipt.senderId] ?? participantTombstones[receipt.senderId];
		if (historicalSender.kind === "human" && !/^private:[0-9a-f]{64}$/.test(receipt.payloadEntryId)) throw new Error(`INVALID_LEDGER_V6: Message ${receipt.id} has an invalid private payload reference`);
		if (receipt.sequence > metadata.sequence || messageSequences.has(receipt.sequence)) throw new Error(`INVALID_LEDGER_V6: Message ${receipt.id} has an invalid sequence`);
		messageSequences.add(receipt.sequence);
		if (deltaTypes.has(receipt.id)) throw new Error(`INVALID_LEDGER_V6: consumed Message ${receipt.id} collides with a live Delta variable`);
		if (messages[receipt.id]) throw new Error(`INVALID_LEDGER_V6: Message ${receipt.id} is both live and consumed`);
		messages[receipt.id] = receipt;
	}

	const gammaKeys = new Set<string>();
	const parentByChild = new Map<ParticipantId, ParticipantId>();
	let previousGammaEntry: { variable: string; type: string } | undefined;
	for (const entry of ledger.Gamma) {
		if (!isRecord(entry) || typeof entry.variable !== "string" || typeof entry.type !== "string" || !Array.isArray(entry.owners)
			|| entry.owners.length === 0 || entry.owners.some((owner) => typeof owner !== "string") || new Set(entry.owners).size !== entry.owners.length
			|| entry.owners.some((owner, index) => index > 0 && comparePersistedString(entry.owners[index - 1], owner) > 0)) {
			throw new Error("INVALID_LEDGER_V6: malformed Gamma entry");
		}
		if (!gammaTypesV6.has(entry.type)) throw new Error(`INVALID_LEDGER_V6: unknown Gamma type ${entry.type}`);
		const key = `${entry.type}\0${entry.variable}`;
		if (previousGammaEntry !== undefined && comparePersistedBinding(previousGammaEntry, entry) > 0) throw new Error("INVALID_LEDGER_V6: Gamma is not in canonical order");
		previousGammaEntry = entry;
		if (gammaKeys.has(key)) throw new Error(`INVALID_LEDGER_V6: duplicate Gamma variable ${entry.variable} : ${entry.type}`);
		gammaKeys.add(key);
		for (const owner of entry.owners) if (!participants[owner]) throw new Error(`INVALID_LEDGER_V6: Gamma owner ${owner} is not a participant`);
		if (entry.type !== "&>Human" && entry.type !== "&>Agent" && entry.type !== "&>Term") continue;
		if (!entry.variable.startsWith("&>")) throw new Error(`INVALID_LEDGER_V6: malformed parent role ${entry.variable}`);
		const child = entry.variable.slice(2);
		if (!participants[child]) throw new Error(`INVALID_LEDGER_V6: parent role targets unknown participant ${child}`);
		if (entry.type !== `&>${persistedParticipantType(participants[child].kind)}`) throw new Error(`INVALID_LEDGER_V6: parent role ${entry.variable} has the wrong participant type`);
		for (const parent of entry.owners) {
			const previous = parentByChild.get(child);
			if (previous && previous !== parent) throw new Error(`INVALID_LEDGER_V6: participant ${child} has multiple parents`);
			if (parent === child) throw new Error(`INVALID_LEDGER_V6: participant ${child} is its own parent`);
			parentByChild.set(child, parent);
		}
	}
	if (parentByChild.has(metadata.rootParticipantId)) throw new Error("INVALID_LEDGER_V6: root participant has a parent");
	for (const id of Object.keys(participants)) if (id !== metadata.rootParticipantId && !parentByChild.has(id)) throw new Error(`INVALID_LEDGER_V6: participant ${id} has no parent role`);
	assertAcyclicParentLinks(new Map(Object.keys(participants).map((id) => [id, { id, parentId: parentByChild.get(id) }])), "participant tree");
	for (const [child, parent] of parentByChild) {
		participants[child].parentId = parent;
		participants[parent].childIds.push(child);
		contexts[parent].gamma.agentPointers.push(child);
		contexts[parent].gamma.roles.push({ targetId: child, role: "parent" });
		contexts[child].gamma.agentPointers.push(parent);
		contexts[child].gamma.roles.push({ targetId: parent, role: "child" });
	}
	for (const participant of Object.values(participants)) participant.childIds.sort();
	for (const participant of Object.values(participants)) {
		if (participant.status === "stopped" && participant.childIds.some((childId) => participants[childId]?.status !== "stopped")) {
			throw new Error(`INVALID_LEDGER_V6: stopped participant ${participant.id} has a non-stopped child`);
		}
	}

	for (const entry of ledger.Gamma) {
		if (entry.type === "&>Human" || entry.type === "&>Agent" || entry.type === "&>Term") continue;
		if (!entry.variable.startsWith("&")) throw new Error(`INVALID_LEDGER_V6: malformed pointer ${entry.variable}`);
		const target = entry.variable.slice(1);
		const expected = entry.type.slice(1);
		const participantPointer = entry.type === "&Human" || entry.type === "&Agent" || entry.type === "&Term";
		const targetParticipant = participantPointer ? participants[target] ?? participantTombstones[target] : undefined;
		if (participantPointer) {
			if (!targetParticipant || expected !== persistedParticipantType(targetParticipant.kind)) throw new Error(`INVALID_LEDGER_V6: ${entry.variable} has type ${entry.type}, target is ${targetParticipant ? persistedParticipantType(targetParticipant.kind) : "unknown"}`);
		} else if (deltaTypes.get(target) !== expected) {
			throw new Error(`INVALID_LEDGER_V6: ${entry.variable} has type ${entry.type}, target is ${String(deltaTypes.get(target))}`);
		}
		for (const owner of entry.owners) {
			if (participantPointer) {
				const liveTarget = participants[target];
				if (liveTarget && (owner === target || participants[owner].parentId === target || liveTarget.parentId === owner)) throw new Error(`INVALID_LEDGER_V6: ${entry.variable} is a derived participant pointer for ${owner}`);
				contexts[owner].gamma.agentPointers.push(target);
			} else {
				if (deltaOwners.get(target) === owner) throw new Error(`INVALID_LEDGER_V6: ${entry.variable} is the owner's derived resource pointer`);
				contexts[owner].gamma.resourcePointers.push(target);
			}
		}
	}
	for (const context of Object.values(contexts)) {
		context.gamma.agentPointers = [...new Set(context.gamma.agentPointers)];
		context.gamma.resourcePointers = [...new Set(context.gamma.resourcePointers)];
	}

	const state: AuthorityState = {
		schemaVersion: ledger.schemaVersion,
		explicitAuthority: metadata.explicitAuthority,
		initialPermissions: metadata.initialPermissions,
		archived: metadata.archived,
		archives: metadata.archives,
		workspaceContexts: metadata.workspaceContexts,
		workspaceFiles: metadata.workspaceFiles,
		saveBaseline: metadata.saveBaseline,
		runtimeEvents: metadata.runtimeEvents,
		sessionId: metadata.sessionId,
		base: metadata.base,
		...(metadata.maxAgentDepth === undefined ? {} : { maxAgentDepth: metadata.maxAgentDepth }),
		createdAt: metadata.createdAt,
		lastOpenedAt: metadata.lastOpenedAt,
		sequence: metadata.sequence,
		rootParticipantId: metadata.rootParticipantId,
		contexts,
		participants,
		participantTombstones,
		resources,
		messages,
		effects: metadata.effects,
		checkpoints,
		agentStates,
		currentAgentStateIds,
		agentBranches,
		termEpochs,
	};
	if (ledger.schemaVersion >= 7) validateRecoveryMetadata(state, privateRoots);
	return state;
}

/** @deprecated Use encodeLedger; this alias also supports schemaVersion 7 and 8. */
export const encodeLedgerV6 = encodeLedger;
/** @deprecated Use decodeLedger; this alias also supports schemaVersion 7 and 8. */
export const decodeLedgerV6 = decodeLedger;

function validateRecoveryMetadata(state: AuthorityState, privateRoots: string | string[]): void {
	const fail = (message: string): never => { throw new Error(`INVALID_LEDGER_V7: ${message}`); };
	const snapshots = (items: unknown): void => {
		if (!isRecord(items)) fail("snapshot collection must be a record");
		for (const [path, snapshot] of Object.entries(items as Record<string, unknown>)) {
			nativeFilePath(fileResourceId(path), false, state.base, privateRoots, false);
			assertSnapshotRef(snapshot, path, "INVALID_LEDGER_V7");
		}
	};
	for (const participant of [...Object.values(state.participants), ...Object.values(state.participantTombstones)]) {
		if (participant.rootDir !== undefined && (typeof participant.rootDir !== "string" || !isAbsolute(participant.rootDir) || canonicalCandidate(participant.rootDir, state.base) !== participant.rootDir)) fail("invalid participant root");
		if (participant.permissionMode !== undefined && participant.permissionMode !== "manual" && participant.permissionMode !== "all-of-mine") fail("invalid permission policy");
	}
	if (state.saveBaseline !== undefined) snapshots(state.saveBaseline);
	if (state.workspaceFiles !== undefined) snapshots(state.workspaceFiles);
	if (state.archived) {
		if (!isRecord(state.workspaceContexts) || !isRecord(state.workspaceFiles)) fail("archived workspace has no recovery template");
		const restored = { ...state, contexts: state.workspaceContexts!, archived: false };
		assertWellFormedContexts(restored);
		for (const context of Object.values(state.contexts)) if (context !== state.contexts.environment && (context.gamma.resourcePointers.length || context.delta.completeValues.some((value) => !!state.resources[value.identity]))) fail("archived workspace still grants resource authority");
	} else if (state.workspaceContexts !== undefined || state.workspaceFiles !== undefined) fail("active workspace has an archive template");
	const eventIds = new Set<string>();
	if (state.runtimeEvents !== undefined && !Array.isArray(state.runtimeEvents)) fail("runtime events must be an array");
	for (const event of state.runtimeEvents ?? []) {
		if (!isRecord(event) || typeof event.id !== "string" || !event.id.startsWith("runtime:") || eventIds.has(event.id) || typeof event.text !== "string" || !["restore", "authority-change", "fork", "rewind"].includes(event.kind) || (!state.participants[event.participantId] && !state.participantTombstones[event.participantId]) || (event.delivered !== undefined && typeof event.delivered !== "boolean")) fail("malformed runtime event");
		eventIds.add(event.id);
	}
	if (state.archives !== undefined && !isRecord(state.archives)) fail("archives must be a record");
	for (const [rootId, template] of Object.entries(state.archives ?? {})) {
		if (!isRecord(template) || ["participants", "contexts", "checkpoints", "agentStates", "currentAgentStateIds", "messages", "files"].some((key) => !isRecord((template as any)[key]))) fail("malformed subtree recovery template");
		snapshots(template.files);
		const root = template.participants[rootId];
		if (!root || !root.parentId || !state.participantTombstones[rootId] || JSON.stringify(root.childIds) !== JSON.stringify(state.participantTombstones[rootId].childIds)) fail("archive root has no matching retained subtree");
		const restored = structuredClone(state);
		const ids = Object.keys(template.participants);
		for (const id of ids) {
			const tombstone = state.participantTombstones[id];
			const participant = template.participants[id];
			if (!tombstone || state.participants[id] || participant.id !== id || participant.kind !== tombstone.kind || participant.parentId !== tombstone.parentId || participant.sessionFile !== tombstone.sessionFile || !template.contexts[id]) fail("template disagrees with its tombstones");
			restored.participants[id] = participant;
			delete restored.participantTombstones[id];
		}
		const transferred = new Set(Object.values(template.contexts).flatMap((context) => context.delta.completeValues.map((value) => value.identity)));
		for (const context of Object.values(restored.contexts)) context.delta.completeValues = context.delta.completeValues.filter((value) => !transferred.has(value.identity));
		Object.assign(restored.contexts, structuredClone(template.contexts));
		for (const id of ids) for (const value of restored.contexts[id].delta.completeValues) {
			const resource = state.resources[value.identity];
			if (resource?.kind === "file") value.stateId = resource.currentVersionId;
		}
		Object.assign(restored.messages, template.messages);
		Object.assign(restored.agentStates, template.agentStates);
		Object.assign(restored.checkpoints, template.checkpoints);
		Object.assign(restored.currentAgentStateIds, template.currentAgentStateIds);
		if (template.agentBranches !== undefined && !isRecord(template.agentBranches)) fail("malformed archived Agent branches");
		for (const [id, participant] of Object.entries(template.participants)) {
			if (participant.kind !== "agent") continue;
			const branches = template.agentBranches?.[id] ?? legacyAgentBranches(template.currentAgentStateIds[id]);
			validateAgentBranches(branches, id, template.agentStates, template.currentAgentStateIds[id]);
			(restored.agentBranches ??= {})[id] = branches;
		}
		for (const id of Object.keys(template.agentBranches ?? {})) if (template.participants[id]?.kind !== "agent") fail("archived branch belongs to a non-Agent");
		const parent = restored.participants[root.parentId!];
		// A parent may itself have been archived subsequently. Its enclosing
		// template will be checked when it is restored; no live edge is forged.
		if (parent) {
			parent.childIds.push(rootId);
			restored.contexts[parent.id].gamma.roles.push({ targetId: rootId, role: "parent" });
			assertWellFormedContexts(restored);
		}
	}
}

/**
 * Explicit, pure v5 -> v6 migration. Calling this function is the migration
 * decision: ordinary load() never maps legacy `idle` to `ready` implicitly.
 */
export function migrateLedgerV5ToV6(ledger: PersistedLedgerV5, options: LedgerV5MigrationOptions = {}): PersistedLedgerV6 {
	if (!isRecord(ledger) || ledger.schemaVersion !== 5 || !Array.isArray(ledger.Delta) || !Array.isArray(ledger.Gamma) || !isRecord(ledger.runtimeMetadata)) {
		throw new Error("INVALID_LEDGER_V5: expected a schemaVersion 5 ledger");
	}
	if (!Array.isArray(ledger.runtimeMetadata.effects)) throw new Error("INVALID_LEDGER_V5: malformed effects");
	if (ledger.runtimeMetadata.effects.some((effect) => isRecord(effect) && effect.kind === "unarchive")) {
		throw new Error("MIGRATION_V5_UNARCHIVE_HISTORY_UNSUPPORTED: v6 has no unarchive effect");
	}
	if (ledger.runtimeMetadata.effects.some((effect) => isRecord(effect) && effect.kind === "archive")) {
		// v5 archive was reversible and did not preserve the immutable subtree
		// tombstones required to justify a v6 destructive archive effect. Silently
		// retaining or dropping that history would forge v6 provenance.
		throw new Error("MIGRATION_V5_ARCHIVE_HISTORY_UNSUPPORTED: v5 archive effects cannot be represented without explicit retired-subtree tombstones");
	}

	const migrated = structuredClone(ledger) as unknown as PersistedLedgerV6;
	(migrated as { schemaVersion: number }).schemaVersion = 6;
	migrated.runtimeMetadata.participantTombstones = [];
	const participantTypes = new Map<string, "Human" | "Agent">();
	for (const entry of migrated.Delta) {
		if (entry.type !== "Agent") continue;
		if (!isRecord(entry.state) || !isRecord(entry.state.participant)) throw new Error(`INVALID_LEDGER_V5: malformed participant ${entry.variable}`);
		const participant = entry.state.participant as unknown as PersistedParticipantStateV5;
		if (participant.kind !== "human" && participant.kind !== "agent") throw new Error(`INVALID_LEDGER_V5: invalid participant kind for ${entry.variable}`);
		if (participant.archived === true && !options.restoreArchived) {
			throw new Error(`MIGRATION_V5_ARCHIVED_PARTICIPANT: ${entry.variable} requires restoreArchived=true or an explicit external archive decision`);
		}
		const participantV6 = participant as unknown as Record<string, unknown>;
		participantV6.status = participant.status === "idle" ? "ready" : participant.status;
		delete participantV6.archived;
		const type = participant.kind === "human" ? "Human" : "Agent";
		(entry as { type: string }).type = type;
		participantTypes.set(entry.variable, type);
	}

	for (const entry of migrated.Gamma) {
		if (entry.type === "&>Agent") {
			const target = entry.variable.startsWith("&>") ? entry.variable.slice(2) : "";
			const type = participantTypes.get(target);
			if (!type) throw new Error(`INVALID_LEDGER_V5: parent role targets unknown participant ${target}`);
			(entry as { type: string }).type = `&>${type}`;
		} else if (entry.type === "&Agent") {
			const target = entry.variable.startsWith("&") ? entry.variable.slice(1) : "";
			const type = participantTypes.get(target);
			if (!type) throw new Error(`INVALID_LEDGER_V5: participant pointer targets unknown participant ${target}`);
			(entry as { type: string }).type = `&${type}`;
		}
	}
	migrated.Delta.sort(comparePersistedBinding);
	migrated.Gamma.sort(comparePersistedBinding);
	return migrated;
}

export function atomicJson(path: string, value: unknown, pretty = true): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
		fsyncSync(descriptor);
	} finally { closeSync(descriptor); }
	renameSync(temporary, path);
}

export class AuthorityStore {
	appendNetworkAudit(record: { at: number; participantId: string; endpoint: string; address: string }): void {
		appendFileSync(join(this.stateDir, "network-audit.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600, flush: true });
	}

	readonly ledgerPath: string;
	readonly blobDir: string;
	readonly journalDir: string;
	readonly payloadDir: string;

	constructor(readonly stateDir: string) {
		this.ledgerPath = join(stateDir, "ledger.json");
		this.blobDir = join(stateDir, "blobs");
		this.journalDir = join(stateDir, "journal");
		this.payloadDir = join(stateDir, "mail-payloads");
		mkdirSync(this.blobDir, { recursive: true });
		mkdirSync(this.journalDir, { recursive: true });
		mkdirSync(this.payloadDir, { recursive: true });
	}

	load(expectedBase?: string, privateRoots: string | string[] = []): AuthorityState | undefined {
		if (!existsSync(this.ledgerPath)) return undefined;
		const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as { schemaVersion?: unknown };
		if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2 || parsed.schemaVersion === 3 || parsed.schemaVersion === 4) {
			throw new Error(`UNSUPPORTED_LEDGER_V${String(parsed.schemaVersion)}: pre-v5 Linden ledgers are not migrated; create a new session`);
		}
		if (parsed.schemaVersion === 5) throw new Error("LEDGER_V5_REQUIRES_EXPLICIT_MIGRATION: call AuthorityStore.migrateV5() before opening this session");
		if (parsed.schemaVersion !== 6 && parsed.schemaVersion !== 7 && parsed.schemaVersion !== 8) throw new Error(`Unsupported Linden ledger version ${String(parsed.schemaVersion)}`);
		return decodeLedger(parsed as PersistedLedgerV6, expectedBase, privateRoots);
	}

	save(state: AuthorityState): void {
		atomicJson(this.ledgerPath, encodeLedger(state), false);
	}

	migrateV5(options: LedgerV5MigrationOptions = {}, expectedBase?: string, privateRoots: string | string[] = []): AuthorityState {
		if (!existsSync(this.ledgerPath)) throw new Error("LEDGER_NOT_FOUND: no ledger exists to migrate");
		const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as { schemaVersion?: unknown };
		if (parsed.schemaVersion !== 5) throw new Error(`MIGRATION_REQUIRES_LEDGER_V5: found ${String(parsed.schemaVersion)}`);
		const ledger = migrateLedgerV5ToV6(parsed as PersistedLedgerV5, options);
		const state = decodeLedger(ledger, expectedBase, privateRoots);
		atomicJson(this.ledgerPath, ledger, false);
		return state;
	}

	captureWithContent(path: string, archive = true, rejectHardlinks = false): { snapshot: SnapshotRef; content?: Buffer } {
		let stat;
		try { stat = lstatSync(path); }
		catch (error: any) {
			if (error?.code === "ENOENT") return { snapshot: { exists: false, hash: ABSENT_HASH } };
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`Symlink states are outside the versioned File namespace: ${path}`);
		if (!stat.isFile()) throw new Error(`Only regular files can be versioned: ${path}`);
		if (rejectHardlinks && stat.nlink > 1) throw new Error(`HARDLINK_UNSUPPORTED: ${path}`);
		const content = readFileSync(path);
		const hash = hashBuffer(content);
		if (archive) this.archive(hash, content);
		return { snapshot: { exists: true, hash, blobHash: hash, mode: stat.mode & 0o777, size: content.length }, content };
	}

	capture(path: string, archive = true, rejectHardlinks = false): SnapshotRef { return this.captureWithContent(path, archive, rejectHardlinks).snapshot; }

	captureBuffer(content: Buffer, mode = 0o644): SnapshotRef {
		const hash = hashBuffer(content);
		this.archive(hash, content);
		return { exists: true, hash, blobHash: hash, mode, size: content.length };
	}

	readSnapshot(snapshot: SnapshotRef): Buffer | undefined {
		assertSnapshotRef(snapshot, "runtime read", "INVALID_SNAPSHOT");
		if (!snapshot.exists) return undefined;
		if (!snapshot.blobHash) throw new Error(`Snapshot ${snapshot.hash} has no blob`);
		const blob = safeBlobPath(this.blobDir, snapshot.blobHash);
		if (!existsSync(blob)) throw new Error(`Missing Linden blob ${snapshot.blobHash}`);
		const content = readFileSync(blob);
		if (hashBuffer(content) !== snapshot.hash || content.length !== snapshot.size) throw new Error(`SNAPSHOT_INTEGRITY: blob ${snapshot.blobHash} does not match its snapshot`);
		return content;
	}

	writeSnapshot(path: string, snapshot: SnapshotRef): void {
		assertSnapshotRef(snapshot, "runtime write", "INVALID_SNAPSHOT");
		if (!snapshot.exists) { rmSync(path, { force: true }); return; }
		const content = this.readSnapshot(snapshot);
		if (!content) throw new Error(`Snapshot ${snapshot.hash} has no content`);
		this.atomicWrite(path, content, snapshot.mode ?? 0o644);
	}

	atomicWrite(path: string, content: Buffer, mode = 0o644): void {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path)) {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`Refusing to replace symlink ${path}`);
			if (!stat.isFile()) throw new Error(`Refusing to replace non-file ${path}`);
			if (stat.nlink > 1) throw new Error(`Hard-linked files are outside the versioned File namespace: ${path}`);
		}
		const temporary = join(dirname(path), `.linden-write-${randomUUID()}`);
		const descriptor = openSync(temporary, "wx", mode);
		try {
			writeFileSync(descriptor, content);
			fsyncSync(descriptor);
		} finally { closeSync(descriptor); }
		renameSync(temporary, path);
	}

	writeJournal(record: JournalRecord): void { atomicJson(join(this.journalDir, `${record.id}.json`), record, false); }

	readJournals(): JournalRecord[] {
		if (!existsSync(this.journalDir)) return [];
		return readdirSync(this.journalDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(this.journalDir, name), "utf8")) as JournalRecord)
			.sort((left, right) => left.createdAt - right.createdAt);
	}


	writePrivatePayload<T>(key: string, value: T): string {
		const id = `private:${hashBuffer(key)}`;
		atomicJson(join(this.payloadDir, `${id.slice("private:".length)}.json`), value, false);
		return id;
	}

	readPrivatePayload<T>(id: string): T | undefined {
		if (!/^private:[0-9a-f]{64}$/.test(id)) return undefined;
		const path = resolve(this.payloadDir, `${id.slice("private:".length)}.json`);
		if (!isInside(path, this.payloadDir)) throw new Error(`INVALID_PRIVATE_PAYLOAD: ${id}`);
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
	}
	removeJournal(id: string): void { rmSync(join(this.journalDir, `${id}.json`), { force: true }); }

	private archive(hash: string, content: Buffer): void {
		const path = safeBlobPath(this.blobDir, hash);
		if (existsSync(path)) return;
		const temporary = join(this.blobDir, `.${randomUUID()}.tmp`);
		writeFileSync(temporary, content, { mode: 0o600 });
		renameSync(temporary, path);
	}
}

export function lindenStateRoot(): string { return resolve(homedir(), ".linden"); }

export function stateDirectory(sessionId: string, root = lindenStateRoot()): string {
	const safe = sessionId.replace(/^session:/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
	return resolve(root, "sessions", safe);
}
