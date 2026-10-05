import type {
	Judgment as CompilerJudgment,
	JudgmentDiagnostic,
	JudgmentResult,
	ParticipantContext,
	PathExpression,
} from "../compiler/judgment.js";

export type ParticipantId = string;
export type ResourceId = string;
export type VersionId = string;
export type MessageId = string;
export type EffectId = string;
export type CheckpointId = string;
export type MessageKind = "follow_up" | "steering";

export type ParticipantKind = "human" | "agent" | "term";
export type ParticipantStatus = "running" | "ready" | "stopped";

export interface ParticipantRecord {
	id: ParticipantId;
	name: string;
	kind: ParticipantKind;
	parentId?: ParticipantId;
	childIds: ParticipantId[];
	piSessionId?: string;
	sessionFile?: string;
	status: ParticipantStatus;
	createdAt: number;
	rootDir?: string;
	permissionMode?: "manual" | "all-of-mine";
}

/**
 * Immutable audit identity for a destructively archived participant. A
 * tombstone is not a live participant, carries no authority, and can never be
 * resolved or reintroduced into the participant tree.
 */
export interface ParticipantTombstone extends ParticipantRecord {
	archivedAt: number;
	archivedBy: ParticipantId;
	archiveEffectId: EffectId;
}

export interface SnapshotRef {
	exists: boolean;
	hash: string;
	blobHash?: string;
	mode?: number;
	size?: number;
}

/** One raw foreground command record stored only inside a content-addressed Term trace blob. */
export interface TermEpochTraceCommand {
	id: string;
	command: string;
	startedAt: string;
	endedAt: string;
	exitCode: number;
	outputStart: number;
	outputEnd: number;
}

/** The bounded output interval retained for one Term epoch. Cursor units are UTF-8 bytes. */
export interface TermEpochTraceOutput {
	start: number;
	end: number;
	data: string;
	truncatedBefore: boolean;
}

/** Private blob payload. Commands and output never appear directly in the typed ledger. */
export interface TermEpochTrace {
	version: 1;
	/** False explicitly denotes a recovery or compatibility gap rather than an empty complete trace. */
	complete: boolean;
	commands: TermEpochTraceCommand[];
	output: TermEpochTraceOutput;
	error?: string;
	missingReason?: "process-recovery" | "trace-unavailable";
}

/** Typed-ledger metadata for a completed or recovered Term epoch. */
export interface TermEpochRecord {
	id: string;
	termId: ParticipantId;
	effectId: EffectId;
	startedAt: number;
	endedAt: number;
	forced: boolean;
	recovered: boolean;
	status: "committed" | "diverged";
	/** Content-addressed reference to the private JSON TermEpochTrace blob. */
	trace: SnapshotRef;
}

/** Fully verified view returned by SessionAuthorityManager.termEpochLog(). */
export interface TermEpochLogEntry {
	epoch: TermEpochRecord;
	trace: TermEpochTrace;
}

export interface VersionNode {
	id: VersionId;
	parentId?: VersionId;
	snapshot: SnapshotRef;
	participantId: ParticipantId;
	operation: "initial" | "write" | "edit" | "bash" | "term" | "recovery" | "save";
	createdAt: number;
	piEntryId?: string;
}

interface ResourceBase {
	id: ResourceId;
	createdAt: number;
}

export interface FileResource extends ResourceBase {
	kind: "file";
	path: string;
	derivedFrom?: ResourceId;
	versioned: boolean;
	versions: VersionNode[];
	currentVersionId: VersionId;
	divergence?: { expectedHash: string; actualHash: string; detectedAt: number };
}

/** A canonical File authority region (`file:<absolute-path>/`). */
export interface FileRegionResource extends ResourceBase {
	kind: "file-region";
	path: string;
	derivedFrom?: ResourceId;
}

export interface WebResource extends ResourceBase {
	kind: "web";
	domains: string[];
	derivedFrom?: ResourceId;
}

export interface NetResource extends ResourceBase {
	kind: "net";
	host: string;
	port: number;
	dns: boolean;
	public: boolean;
	derivedFrom?: ResourceId;
}

export type ResourceRecord = FileResource | FileRegionResource | WebResource | NetResource;

export interface MessageRecord {
	id: MessageId;
	sequence: number;
	kind: MessageKind;
	senderId: ParticipantId;
	targetId: ParticipantId;
	payloadEntryId: string;
	sentAt: number;
	deliveryBatchId?: string;
	queuedAt?: number;
	deliveredAt?: number;
	consumedAt?: number;
	consumedBy?: ParticipantId;
	origin?: "explicit" | "assistant_final";
	sourceEntryId?: string;
	/** Retained unread mail after archive; explicit receive remains available. */
	deferred?: boolean;
}

export type EffectKind = "participants" | "spawn" | "subpath" | "file" | "send" | "steer" | "wait" | "interrupt" | "stop" | "receive" | "give" | "get" | "write" | "edit" | "bash" | "exec" | "input" | "checkout" | "rewind" | "archive" | "unarchive" | "permission" | "save" | "publish" | "unpublish";
export interface EffectRecord {
	id: EffectId;
	sequence: number;
	kind: EffectKind;
	participantId: ParticipantId;
	targetId?: string;
	resourceId?: ResourceId;
	stateId?: string;
	status: "committed" | "diverged";
	createdAt: number;
	piEntryId?: string;
}

export interface ParticipantAuthoritySnapshot {
	owned: ResourceId[];
	pointers: ResourceId[];
	children: ParticipantId[];
	parent?: ParticipantId;
}

export interface TypedCheckpoint {
	id: CheckpointId;
	participantId: ParticipantId;
	piEntryId: string;
	ledgerSequence: number;
	authority: ParticipantAuthoritySnapshot;
	createdAt: number;
}

export interface AgentStateNode {
	id: VersionId;
	participantId: ParticipantId;
	piEntryId: string;
	parentId?: VersionId;
	checkpointId: CheckpointId;
	createdAt: number;
}

export interface AgentBranches {
	current: string;
	heads: Record<string, VersionId>;
}

export interface ArchiveTemplate {
	participants: Record<ParticipantId, ParticipantRecord>;
	contexts: AuthorityState["contexts"];
	checkpoints: AuthorityState["checkpoints"];
	agentStates: AuthorityState["agentStates"];
	currentAgentStateIds: AuthorityState["currentAgentStateIds"];
	agentBranches?: AuthorityState["agentBranches"];
	messages: AuthorityState["messages"];
	files: Record<string, SnapshotRef>;
}

export interface RuntimeEvent {
	id: string;
	participantId: ParticipantId;
	text: string;
	kind: string;
	delivered?: boolean;
}

export interface AuthorityState {
	schemaVersion: 6 | 7 | 8;
	sessionId: string;
	base: string;
	explicitAuthority?: boolean;
	initialPermissions?: string[];
	archived?: boolean;
	archives?: Record<ParticipantId, ArchiveTemplate>;
	workspaceContexts?: AuthorityState["contexts"];
	workspaceFiles?: Record<string, SnapshotRef>;
	saveBaseline?: Record<string, SnapshotRef>;
	runtimeEvents?: RuntimeEvent[];
	/** Maximum number of Agent nodes on a root-to-participant path; absent means unlimited. */
	maxAgentDepth?: number;
	createdAt: number;
	lastOpenedAt: number;
	sequence: number;
	rootParticipantId: ParticipantId;
	/** Runtime index reconstructed from the persisted Delta/Gamma normal form. */
	contexts: Record<ParticipantId, ParticipantContext>;
	participants: Record<ParticipantId, ParticipantRecord>;
	participantTombstones: Record<ParticipantId, ParticipantTombstone>;
	resources: Record<ResourceId, ResourceRecord>;
	messages: Record<MessageId, MessageRecord>;
	effects: EffectRecord[];
	checkpoints: Record<CheckpointId, TypedCheckpoint>;
	agentStates: Record<VersionId, AgentStateNode>;
	currentAgentStateIds: Record<ParticipantId, VersionId>;
	/** Branch references; currentAgentStateIds is the derived current-head index. */
	agentBranches?: Record<ParticipantId, AgentBranches>;
	/** Durable Term history reconstructed from optional v6 runtime metadata. */
	termEpochs: Record<string, TermEpochRecord>;
}

/** Runtime-only projection for display and compatibility callers. */
export type ResourceView = ResourceRecord & {
	ownerId?: ParticipantId;
	pointers: ParticipantId[];
};

export type AuthorityOperation = CompilerJudgment;
export type AuthorityDiagnostic = JudgmentDiagnostic;
export type AuthorityCheckResult = JudgmentResult;

export interface EffectiveAuthority {
	readExpressions: PathExpression[];
	writeExpressions: PathExpression[];
	readPaths: string[];
	writePaths: string[];
	denyReadPaths: string[];
	denyWritePaths: string[];
	absentWriteFileExclusions: string[];
	unsafeAbsentWriteExclusions: string[];
	webDomains: string[];
	netEndpoints?: string[];
	netExclusions?: string[];
}
