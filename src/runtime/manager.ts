import { legacyAgentBranches, validAgentBranchName } from "./agent-history.js";
import { NetGuard } from "./net-guard.js";
import type { NetworkBridge } from "./network-bridge.js";
import { initialPermissions, filePermission, type WriteReservation } from "./permissions.js";
import { netReference, privateAddress } from "./net.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	assertWellFormedContexts,
	authoritySnapshot,
	canObserveResource,
	canReadPath,
	canWritePath,
	deriveRefinement,
	emptyContext,
	hasOrdinaryParticipantPointer,
	hostSelectorContains,
	ownerOf,
	pathExpressions,
	pointersTo,
	requireJudgment,
	requireReceiveJudgments,
	type JudgmentDerivation,
	type CompleteValue,
} from "../compiler/judgment.js";
import type {
	AgentStateNode,
	AgentBranches,
	AuthorityOperation,
	AuthorityState,
	CheckpointId,
	EffectiveAuthority,
	EffectRecord,
	EffectKind,
	FileResource,
	MessageRecord,
	MessageKind,
	ParticipantAuthoritySnapshot,
	ParticipantId,
	ParticipantKind,
	ParticipantRecord,
	FileRegionResource,
	ResourceId,
	ResourceView,
	SnapshotRef,
	TypedCheckpoint,
	TermEpochLogEntry,
	TermEpochRecord,
	TermEpochTrace,
	TermEpochTraceCommand,
	TermEpochTraceOutput,
	VersionId,
	VersionNode,
	WebResource,
} from "./model.js";
import { canonicalBase, canonicalCandidate, fileResourceId, isInside, pathExpressionContains, resolvePublicPath } from "./paths.js";
import { AuthorityStore, atomicJson, hashBuffer, lindenStateRoot, stateDirectory, type BashJournal, type FileJournal } from "./store.js";
import { cleanupAbsentWritePlaceholders, DynamicSandbox, type PlaceholderCleanupResult, type SandboxRunOptions } from "./sandbox.js";
import { resolveWebResourceReference } from "./compat/network.js";
import { normalizeMaxAgentDepth } from "./agent-depth.js";

export interface ManagerOptions {
	base?: string;
	/** Deprecated input alias retained for direct library callers. */
	workspace?: string;
	lindenSessionId?: string;
	/** Pi session ID for an optional primary top-level Agent. */
	sessionId?: string;
	sessionName?: string;
	rootParticipantId?: ParticipantId;
	sessionParticipantId?: ParticipantId;
	sessionFile?: string;
	permissions?: readonly string[];
	noDefaultPermissions?: boolean;
	/** Maximum Agent edge depth below the human root; absent means unlimited. */
	maxAgentDepth?: number;
	stateDir?: string;
	stateRoot?: string;
	/** Optional evaluator-visible directory mounted as the sandbox /tmp. */
	sandboxTmpPath?: string;
}

export interface FileMutationResult {
	resourceId: ResourceId;
	stateId: VersionId;
	path: string;
	hash: string;
	size: number;
}

export interface FileTransferUpdate {
	resourceId: ResourceId;
	stateId: VersionId;
	change: "saved" | "verified";
}

export interface AuthorityTransferReceipt {
	resources: ResourceId[];
	fileUpdates: FileTransferUpdate[];
}

export interface BashExecutionResult {
	exitCode: number | null;
	changedResources: ResourceId[];
	output: string;
	notices: string[];
	ledgerSequence: number;
}

export interface BashManagerOptions extends SandboxRunOptions {
	cwd?: string;
}

export interface CheckpointEnvelope {
	id: CheckpointId;
	participantId: ParticipantId;
	ledgerSequence: number;
	authority: ParticipantAuthoritySnapshot;
	createdAt: number;
}

export interface TermEpochStart {
	termId: ParticipantId;
	epochId: string;
	startedAt: number;
}

export interface TermEpochFinish extends TermEpochStart {
	endedAt: number;
	forced: boolean;
	cleanup?: PlaceholderCleanupResult;
	/** Raw command records plus bounded retained output supplied by Term.onEpochEnd. */
	trace?: {
		commands: readonly TermEpochTraceCommand[];
		output: TermEpochTraceOutput;
		error?: string;
	};
}

export interface TermEpochCommitResult {
	changedResources: ResourceId[];
	notices: string[];
	ledgerSequence: number;
}

interface ActiveTermEpoch {
	termId: ParticipantId;
	epochId: string;
	journal: BashJournal;
	authority: EffectiveAuthority;
}

class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T> | T): Promise<T> {
		let release!: () => void;
		const previous = this.tail;
		this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try { return await operation(); } finally { release(); }
	}
}

const now = () => Date.now();
const pathResourceId = (path: string): ResourceId => fileResourceId(path, true);
const versionId = (resourceId: ResourceId): VersionId => `state:${resourceId}:${randomUUID()}`;
const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];
const compareMessages = (left: MessageRecord, right: MessageRecord): number =>
	Number(right.kind === "steering") - Number(left.kind === "steering")
	|| left.sequence - right.sequence
	|| left.sentAt - right.sentAt
	|| left.id.localeCompare(right.id);
const TERM_TRACE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const TERM_TRACE_FIELDS = new Set(["version", "complete", "commands", "output", "error", "missingReason"]);
const TERM_TRACE_COMMAND_FIELDS = new Set(["id", "command", "startedAt", "endedAt", "exitCode", "outputStart", "outputEnd"]);
const TERM_TRACE_OUTPUT_FIELDS = new Set(["start", "end", "data", "truncatedBefore"]);

function traceCommand(value: unknown, label: string): TermEpochTraceCommand {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`INVALID_TERM_TRACE: malformed command ${label}`);
	const command = value as Record<string, unknown>;
	if (Object.keys(command).some((key) => !TERM_TRACE_COMMAND_FIELDS.has(key))
		|| typeof command.id !== "string" || command.id.length === 0
		|| typeof command.command !== "string"
		|| typeof command.startedAt !== "string" || !Number.isFinite(Date.parse(command.startedAt))
		|| typeof command.endedAt !== "string" || !Number.isFinite(Date.parse(command.endedAt)) || Date.parse(command.endedAt) < Date.parse(command.startedAt)
		|| !Number.isSafeInteger(command.exitCode)
		|| !Number.isSafeInteger(command.outputStart) || (command.outputStart as number) < 0
		|| !Number.isSafeInteger(command.outputEnd) || (command.outputEnd as number) < (command.outputStart as number)) {
		throw new Error(`INVALID_TERM_TRACE: malformed command ${label}`);
	}
	return {
		id: command.id,
		command: command.command,
		startedAt: command.startedAt,
		endedAt: command.endedAt,
		exitCode: command.exitCode as number,
		outputStart: command.outputStart as number,
		outputEnd: command.outputEnd as number,
	};
}

function traceOutput(value: unknown, bound: boolean): TermEpochTraceOutput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_TERM_TRACE: malformed output");
	const output = value as Record<string, unknown>;
	if (Object.keys(output).some((key) => !TERM_TRACE_OUTPUT_FIELDS.has(key))
		|| !Number.isSafeInteger(output.start) || (output.start as number) < 0
		|| !Number.isSafeInteger(output.end) || (output.end as number) < (output.start as number)
		|| typeof output.data !== "string" || typeof output.truncatedBefore !== "boolean") throw new Error("INVALID_TERM_TRACE: malformed output");
	let data = output.data;
	let start = output.start as number;
	let truncatedBefore = output.truncatedBefore;
	const bytes = Buffer.from(data, "utf8");
	if (bytes.length !== (output.end as number) - start) throw new Error("INVALID_TERM_TRACE: output data length does not match its cursor range");
	if (bytes.length > TERM_TRACE_OUTPUT_LIMIT_BYTES) {
		if (!bound) throw new Error(`INVALID_TERM_TRACE: output exceeds ${TERM_TRACE_OUTPUT_LIMIT_BYTES} bytes`);
		let offset = bytes.length - TERM_TRACE_OUTPUT_LIMIT_BYTES;
		while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
		data = bytes.subarray(offset).toString("utf8");
		start = (output.end as number) - Buffer.byteLength(data);
		truncatedBefore = true;
	}
	return { start, end: output.end as number, data, truncatedBefore };
}

function traceCommands(values: readonly unknown[], outputEnd: number): TermEpochTraceCommand[] {
	const ids = new Set<string>();
	return values.map((value, index) => {
		const command = traceCommand(value, String(index));
		if (ids.has(command.id)) throw new Error(`INVALID_TERM_TRACE: duplicate command id ${command.id}`);
		if (command.outputEnd > outputEnd) throw new Error(`INVALID_TERM_TRACE: command ${command.id} output range exceeds the epoch output range`);
		ids.add(command.id);
		return command;
	});
}

function missingTermTrace(reason: "process-recovery" | "trace-unavailable"): TermEpochTrace {
	return {
		version: 1,
		complete: false,
		commands: [],
		output: { start: 0, end: 0, data: "", truncatedBefore: false },
		error: reason === "process-recovery"
			? "Term trace is unavailable because this epoch was recovered after process exit."
			: "Term trace was not supplied by this compatibility caller.",
		missingReason: reason,
	};
}

function completeTermTrace(input: NonNullable<TermEpochFinish["trace"]>): TermEpochTrace {
	const output = traceOutput(input.output, true);
	return {
		version: 1,
		complete: true,
		commands: traceCommands(input.commands, output.end),
		output,
		...(input.error === undefined ? {} : { error: input.error }),
	};
}

function decodeTermTrace(content: Buffer): TermEpochTrace {
	let parsed: unknown;
	try { parsed = JSON.parse(content.toString("utf8")); }
	catch (error) { throw new Error("INVALID_TERM_TRACE: trace blob is not JSON", { cause: error }); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_TERM_TRACE: malformed trace blob");
	const trace = parsed as Record<string, unknown>;
	if (Object.keys(trace).some((key) => !TERM_TRACE_FIELDS.has(key)) || trace.version !== 1 || typeof trace.complete !== "boolean"
		|| !Array.isArray(trace.commands) || typeof trace.output !== "object" || trace.output === null
		|| (trace.error !== undefined && typeof trace.error !== "string")
		|| (trace.missingReason !== undefined && trace.missingReason !== "process-recovery" && trace.missingReason !== "trace-unavailable")) {
		throw new Error("INVALID_TERM_TRACE: malformed trace blob");
	}
	const output = traceOutput(trace.output, false);
	const commands = traceCommands(trace.commands, output.end);
	if (trace.complete === (trace.missingReason !== undefined)) throw new Error("INVALID_TERM_TRACE: completion and missingReason disagree");
	if (!trace.complete && (commands.length > 0 || output.start !== 0 || output.end !== 0 || output.data !== "" || output.truncatedBefore)) {
		throw new Error("INVALID_TERM_TRACE: an incomplete trace must explicitly contain no synthesized command or output data");
	}
	return {
		version: 1,
		complete: trace.complete,
		commands,
		output,
		...(trace.error === undefined ? {} : { error: trace.error as string }),
		...(trace.missingReason === undefined ? {} : { missingReason: trace.missingReason as TermEpochTrace["missingReason"] }),
	};
}

export function defaultHumanParticipantId(): ParticipantId {
	const username = userInfo().username.trim();
	if (!username) throw new Error("The operating-system username is empty");
	return `human:${username}`;
}

function requireParticipantId(id: ParticipantId, kind: ParticipantKind): void {
	const prefix = `${kind}:`;
	if (!id.startsWith(prefix) || id.length === prefix.length) throw new Error(`INVALID_PARTICIPANT_ID: ${kind} participant IDs must use ${prefix}<id>`);
}

function makeInitialState(options: { base: string; sessionId: string; rootParticipantId: ParticipantId; maxAgentDepth?: number }): AuthorityState {
	const createdAt = now();
	const username = options.rootParticipantId.slice("human:".length) || options.rootParticipantId;
	const human: ParticipantRecord = {
		id: options.rootParticipantId,
		name: username,
		kind: "human",
		rootDir: options.base,
		permissionMode: "manual",
		childIds: [],
		status: "stopped",
		createdAt,
	};
	return {
		schemaVersion: 8,
		explicitAuthority: true,
		archives: {},
		runtimeEvents: [],
		sessionId: options.sessionId,
		base: options.base,
		...(options.maxAgentDepth === undefined ? {} : { maxAgentDepth: options.maxAgentDepth }),
		createdAt,
		lastOpenedAt: createdAt,
		sequence: 0,
		rootParticipantId: options.rootParticipantId,
		contexts: { [human.id]: emptyContext(human.id, "human") },
		participants: { [human.id]: human },
		participantTombstones: {},
		resources: {},
		messages: {},
		effects: [],
		checkpoints: {},
		agentStates: {},
		currentAgentStateIds: {},
		agentBranches: {},
		termEpochs: {},
	};
}

export class SessionAuthorityManager {
	readonly base: string;
	/** Compatibility alias for Pi APIs whose cwd is the immutable base. */
	readonly workspace: string;
	readonly sessionId: string;
	readonly maxAgentDepth?: number;
	readonly stateDir: string;
	readonly privateRoots: string[];
	readonly sandboxTmpPath?: string;
	readonly store: AuthorityStore;
	private readonly networkBridges = new Map<string, Set<NetworkBridge>>();
	readonly publications = new Map<string, { ownerId: string; termId: string; internalPort: number; socketPath: string; state: "starting" | "ready" | "failed" }>();
	private readonly commitMutex = new AsyncMutex();
	private readonly resourceWriterGate = new AsyncMutex();
	private readonly payloadMutexes = new Map<ParticipantId, AsyncMutex>();
	private readonly staleRunningParticipants = new Set<ParticipantId>();
	private state: AuthorityState;
	private readonly activeReadViews = new Map<string, ActiveReadView>();
	private readonly activeTermEpochs = new Map<ParticipantId, ActiveTermEpoch>();
	private primarySessionParticipantId?: ParticipantId;
	private readonly ignoredNames = new Set([".git", ".linden", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__", "target", "dist", "build", ".cache"]);

	private constructor(options: ManagerOptions) {
		this.base = canonicalBase(options.base ?? options.workspace ?? process.cwd());
		this.workspace = this.base;
		this.sessionId = options.lindenSessionId ?? `session:${randomUUID()}`;
		const requestedMaxAgentDepth = normalizeMaxAgentDepth(options.maxAgentDepth);
		const rootParticipantId = options.rootParticipantId ?? defaultHumanParticipantId();
		requireParticipantId(rootParticipantId, "human");
		this.stateDir = options.stateDir ?? stateDirectory(this.sessionId, options.stateRoot);
		const globalPrivateRoot = options.stateRoot ?? lindenStateRoot();
		const legacyPrivateRoot = join(this.base, ".linden");
		const privateRoots = [globalPrivateRoot, legacyPrivateRoot, this.stateDir];
		const stateDirLexical = resolve(this.stateDir);
		this.store = new AuthorityStore(this.stateDir);
		// Keep both lexical aliases and physical targets. The former rejects a
		// private symlink before following it; the latter rejects another public
		// alias that resolves to the same private directory. Unrelated inaccessible
		// roots outside the base retain their lexical boundary without making this
		// session's open depend on another private filesystem subtree.
		this.privateRoots = unique(privateRoots.flatMap((root) => {
			const lexical = resolve(root);
			try { return [lexical, canonicalCandidate(lexical, process.cwd())]; }
			catch (error) {
				if (isInside(lexical, this.base) || isInside(stateDirLexical, lexical)) throw error;
				return [lexical];
			}
		}));
		if (options.sandboxTmpPath !== undefined) {
			const candidate = resolvePublicPath(options.sandboxTmpPath, this.base, this.base, this.privateRoots);
			if (candidate === this.base || !existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
				throw new Error(`sandboxTmpPath must be an existing public directory strictly inside Linden base: ${options.sandboxTmpPath}`);
			}
			this.sandboxTmpPath = candidate;
		}
		let loaded = this.store.load(this.base, this.privateRoots);
		if (loaded) normalizeMaxAgentDepth(loaded.maxAgentDepth, "persisted maxAgentDepth");
		if (loaded && requestedMaxAgentDepth !== undefined && loaded.maxAgentDepth !== requestedMaxAgentDepth) {
			throw new Error(`Linden session maxAgentDepth is ${loaded.maxAgentDepth ?? "unlimited"}, not ${requestedMaxAgentDepth}`);
		}
		this.maxAgentDepth = loaded?.maxAgentDepth ?? requestedMaxAgentDepth;
		this.state = loaded ?? makeInitialState({
			base: this.base,
			sessionId: this.sessionId,
			rootParticipantId,
			maxAgentDepth: this.maxAgentDepth,
		});
		if (this.state.base !== this.base) throw new Error(`Linden session ${this.sessionId} belongs to base ${this.state.base}, not ${this.base}`);
		if (this.state.sessionId !== this.sessionId) throw new Error(`Linden ledger belongs to ${this.state.sessionId}, not ${this.sessionId}`);
		if (this.state.rootParticipantId !== rootParticipantId) throw new Error("Linden ledger belongs to a different human participant");
		if (!loaded) this.initializePermissions(initialPermissions(options.permissions ?? [], this.base, options.noDefaultPermissions));
		else if (loaded.schemaVersion === 6) {
			// Keep an immutable original before materializing formerly implicit rights.
			if (!existsSync(join(this.stateDir, "ledger.v6.backup.json"))) atomicJson(join(this.stateDir, "ledger.v6.backup.json"), JSON.parse(readFileSync(this.store.ledgerPath, "utf8")));
			this.materializeBaseRegion(false);
			this.initializePermissions(["net:tcp/public"]);
			this.state.schemaVersion = 7;
			this.state.explicitAuthority = true;
			this.state.initialPermissions = [`file:${this.base}/`, "net:tcp/public"];
			this.state.archives = {};
			this.state.runtimeEvents = [];
			for (const participant of Object.values(this.state.participants)) participant.rootDir ??= this.base;
			this.persist();
		}
		if (this.state.schemaVersion !== 8) {
			if (loaded?.schemaVersion === 7 && !existsSync(join(this.stateDir, "ledger.v7.backup.json"))) atomicJson(join(this.stateDir, "ledger.v7.backup.json"), JSON.parse(readFileSync(this.store.ledgerPath, "utf8")));
			this.state.schemaVersion = 8;
			this.persist();
		}
		const normalizedMessages = this.normalizeMessages();
		const normalizedParticipants = this.normalizeParticipantStatuses();
		assertWellFormedContexts(this.state);
		if (!loaded) this.state.saveBaseline = this.scan(this.effectiveAuthority(this.rootParticipantId).writePaths, [], true);
		this.state.lastOpenedAt = now();
		if (!loaded || normalizedMessages || normalizedParticipants) this.store.save(this.state);
	}

	static async open(options: ManagerOptions): Promise<SessionAuthorityManager> {
		const manager = new SessionAuthorityManager(options);
		await manager.recover();
		if (options.sessionId) await manager.ensureTopLevelSession(options);
		return manager;
	}

	private initializePermissions(inputs: readonly string[]): void {
		this.state.initialPermissions ??= [...inputs];
		const identities = new Set<string>();
		for (const input of inputs) {
			const key = input.startsWith("&") ? input.slice(1) : input;
			if (identities.has(key)) throw new Error(`Duplicate initial permission ${key}`);
			identities.add(key);
			const read = input.startsWith("&");
			const typed = read ? input.slice(1) : input;
			if (typed.startsWith("net:")) {
				const endpoint = netReference(typed);
				if (!this.state.resources[endpoint.id]) {
					this.state.resources[endpoint.id] = { ...endpoint, kind: "net", createdAt: now() };
					this.installComplete(this.rootParticipantId, endpoint.id);
				}
				if (read) this.moveToEnvironment(endpoint.id);
				continue;
			}
			const permission = filePermission(input, this.base);
			resolvePublicPath(permission.path, this.base, this.base, this.privateRoots);
			if (!permission.region) {
				const snapshot = this.store.capture(permission.path, true, true);
				const id = versionId(permission.id);
				this.state.resources[permission.id] = { id: permission.id, kind: "file", path: permission.path, versioned: true, versions: [{ id, snapshot, participantId: this.rootParticipantId, operation: "initial", createdAt: now() }], currentVersionId: id, createdAt: now() };
			} else this.state.resources[permission.id] ??= { id: permission.id, kind: "file-region", path: permission.path, createdAt: now() };
			this.installComplete(this.rootParticipantId, permission.id);
			if (read) this.moveToEnvironment(permission.id);
		}
	}

	private moveToEnvironment(resourceId: string): void {
		const root = this.state.contexts[this.rootParticipantId];
		const value = root.delta.completeValues.find((item) => item.identity === resourceId)!;
		root.delta.completeValues = root.delta.completeValues.filter((item) => item.identity !== resourceId);
		this.state.contexts.environment ??= { delta: { completeValues: [] }, gamma: { resourcePointers: [], agentPointers: [], roles: [] } };
		this.state.contexts.environment.delta.completeValues.push(value);
	}

	workspaceWrites(): WriteReservation[] {
		return Object.values(this.state.resources).filter((resource) => (resource.kind === "file" || resource.kind === "file-region") && !!this.ownerOf(resource.id) && this.ownerOf(resource.id) !== "environment").map((resource) => ({ include: (resource as FileResource | FileRegionResource).path, region: resource.kind === "file-region", exclude: [] }));
	}

	participantRoot(participantId: string): string {
		const participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		return participant.rootDir ?? this.base;
	}

	async setPermissionMode(participantId: string, mode: "manual" | "all-of-mine"): Promise<void> {
		if (mode !== "manual" && mode !== "all-of-mine") throw new Error("permission mode must be manual or all-of-mine");
		await this.commitMutex.run(() => this.persistStaged(() => {
			const participant = this.state.participants[participantId];
			if (!participant || participant.kind === "term") throw new Error("Only a live Human or Agent may set permission policy");
			participant.permissionMode = mode;
			this.commitEffect("permission", participantId);
		}));
	}

	queueRuntimeEvent(participantId: string, text: string, kind = "authority-change"): string {
		const id = `runtime:${randomUUID()}`;
		(this.state.runtimeEvents ??= []).push({ id, participantId, text, kind });
		return id;
	}

	async acknowledgeRuntimeEvent(id: string): Promise<void> {
		await this.commitMutex.run(() => this.persistStaged(() => {
			const event = this.state.runtimeEvents?.find((candidate) => candidate.id === id);
			if (event) event.delivered = true;
		}));
	}

	/** Restore a retained subtree only when every complete value is available. */
	async unarchiveParticipant(participantId: string, targetId: string): Promise<string[]> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => this.persistStaged(() => {
			if (this.state.archived) throw new Error("WORKSPACE_ARCHIVED");
			const template = this.state.archives?.[targetId];
			if (!template || template.participants[targetId]?.parentId !== participantId || !this.state.participants[participantId]) throw new Error("UNARCHIVE_REQUIRES_RETAINED_DIRECT_CHILD");
			this.assertNoOpenTermEpoch(participantId, "restore a child");
			const resourceIds = Object.values(template.contexts).flatMap((context) => context.delta.completeValues.filter((value) => !!this.state.resources[value.identity]).map((value) => value.identity));
			for (const id of resourceIds) if (this.ownerOf(id) !== participantId) throw new Error(`UNARCHIVE_AUTHORITY_CONFLICT: ${id} is no longer held by ${participantId}`);
			for (const context of Object.values(template.contexts)) for (const id of context.gamma.resourcePointers) {
				if (!resourceIds.includes(id) && (this.state.resources[id]?.kind === "net" ? this.ownerOf(id) !== participantId : !canObserveResource(this.state, participantId, id))) throw new Error(`UNARCHIVE_AUTHORITY_CONFLICT: cannot restore projection ${id}`);
			}
			for (const id of Object.keys(template.participants)) {
				if (this.state.participants[id]) throw new Error(`UNARCHIVE_ID_CONFLICT: ${id}`);
				this.state.participants[id] = { ...structuredClone(template.participants[id]), status: "stopped" };
				this.state.contexts[id] = structuredClone(template.contexts[id]);
				delete this.state.participantTombstones[id];
			}
			const parent = this.state.participants[participantId];
			parent.childIds.push(targetId);
			const parentContext = this.state.contexts[participantId];
			parentContext.delta.completeValues = parentContext.delta.completeValues.filter((value) => !resourceIds.includes(value.identity));
			parentContext.gamma.roles.push({ targetId, role: "parent" });
			parentContext.gamma.agentPointers = unique([...parentContext.gamma.agentPointers, targetId]);
			// Net is a use capability, so the old complete holder loses its use.
			parentContext.gamma.resourcePointers = parentContext.gamma.resourcePointers.filter((id) => !resourceIds.includes(id) || this.state.resources[id].kind !== "net");
			Object.assign(this.state.checkpoints, structuredClone(template.checkpoints));
			Object.assign(this.state.agentStates, structuredClone(template.agentStates));
			Object.assign(this.state.currentAgentStateIds, structuredClone(template.currentAgentStateIds));
			for (const [id, participant] of Object.entries(template.participants)) if (participant.kind === "agent") {
				(this.state.agentBranches ??= {})[id] = structuredClone(template.agentBranches?.[id] ?? legacyAgentBranches(template.currentAgentStateIds[id]));
			}
			for (const [id, context] of Object.entries(template.contexts)) {
				// Archived unread mail is retained for audit/explicit consumption,
				// but does not silently activate an old task after restoration.
				this.state.contexts[id].delta.completeValues = context.delta.completeValues.map((value) => this.state.resources[value.identity] ? this.completeValue(value.identity) : value);
			}
			for (const message of Object.values(template.messages)) this.state.messages[message.id] = { ...message, deferred: !message.consumedAt, deliveryBatchId: undefined, queuedAt: undefined };
			this.reconcileRestoredFiles(template.files, Object.keys(template.participants));
			this.commitEffect("unarchive", participantId, undefined, undefined, targetId);
			delete this.state.archives![targetId];
			return Object.keys(template.participants);
		})));
	}

	private reconcileRestoredFiles(before: Record<string, SnapshotRef>, participantIds: string[]): void {
		const observed = unique(participantIds.flatMap((id) => this.effectiveAuthority(id).readPaths));
		const after = this.scan(observed);
		const absent: SnapshotRef = { exists: false, hash: hashBuffer("linden:absent:v1") };
		const changed = unique([...Object.keys(before), ...Object.keys(after)]).filter((path) => (before[path]?.hash ?? absent.hash) !== (after[path]?.hash ?? absent.hash) || before[path]?.mode !== after[path]?.mode);
		for (const path of changed) {
			let resource = this.fileAt(path);
			const owner = resource ? this.ownerOf(resource.id) : participantIds.find((id) => canWritePath(this.state, id, path));
			if (!owner || owner === "environment") continue;
			resource ??= this.materializeFile(path, owner, before[path] ?? absent, undefined, "write", false);
			this.appendVersion(resource, versionId(resource.id), after[path] ?? absent, owner, "save");
			delete resource.divergence;
		}
		for (const id of participantIds) if (this.state.participants[id]?.kind === "agent") {
			const files = changed.filter((path) => canReadPath(this.state, id, path));
			const nets = this.effectiveAuthority(id).netEndpoints ?? [];
			if (files.length || nets.length) this.queueRuntimeEvent(id, `[Linden restoration update]\n${files.length ? `Files changed while archived: ${files.join(", ")}.\n` : ""}${nets.length ? `Net authority restored: ${nets.join(", ")}. Connections and publication bridges were not restored; verify service state before use.` : ""}`, "restore");
		}
	}

	async archiveWorkspace(): Promise<void> {
		await this.resourceWriterGate.run(() => this.commitMutex.run(() => this.persistStaged(() => {
			if (this.state.archived) return;
			if (this.activeTermEpochs.size || Object.values(this.state.participants).some((participant) => participant.status !== "stopped")) throw new Error("WORKSPACE_ARCHIVE_REQUIRES_STOPPED_TREE");
			this.state.workspaceFiles = this.scan(unique(Object.keys(this.state.participants).flatMap((id) => this.effectiveAuthority(id).readPaths)));
			this.state.workspaceContexts = structuredClone(this.state.contexts);
			this.state.contexts.environment ??= { delta: { completeValues: [] }, gamma: { resourcePointers: [], agentPointers: [], roles: [] } };
			for (const [id, context] of Object.entries(this.state.contexts)) {
				if (id === "environment") continue;
				this.state.contexts.environment.delta.completeValues.push(...context.delta.completeValues.filter((value) => !!this.state.resources[value.identity]));
				context.delta.completeValues = context.delta.completeValues.filter((value) => !this.state.resources[value.identity]);
				context.gamma.resourcePointers = [];
			}
			for (const message of Object.values(this.state.messages)) if (!message.consumedAt) { message.deferred = true; delete message.deliveryBatchId; delete message.queuedAt; }
			this.state.archived = true;
			this.commitEffect("archive", this.rootParticipantId, undefined, undefined, this.rootParticipantId);
		})));
	}

	async unarchiveWorkspace(): Promise<void> {
		await this.resourceWriterGate.run(() => this.commitMutex.run(() => this.persistStaged(() => {
			if (!this.state.archived) return;
			if (!this.state.workspaceContexts) throw new Error("WORKSPACE_RESTORE_TEMPLATE_MISSING");
			this.state.contexts = structuredClone(this.state.workspaceContexts);
			this.state.archived = false;
			this.reconcileRestoredFiles(this.state.workspaceFiles ?? {}, Object.keys(this.state.participants));
			this.commitEffect("unarchive", this.rootParticipantId, undefined, undefined, this.rootParticipantId);
			delete this.state.workspaceContexts;
			delete this.state.workspaceFiles;
		})));
	}

	async saveExternalChanges(participantId: string): Promise<string[]> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => {
			if (participantId !== this.rootParticipantId || this.state.archived) throw new Error("SAVE_REQUIRES_ACTIVE_HUMAN");
			const authority = this.effectiveAuthority(participantId);
			this.assertNoTermWriteOverlap(authority.writePaths, "save external changes");
			const exclusions = unique([...authority.denyWritePaths, ...authority.absentWriteFileExclusions, ...authority.unsafeAbsentWriteExclusions]);
			const before = Object.fromEntries(Object.entries(this.state.saveBaseline ?? {}).filter(([path]) => canWritePath(this.state, participantId, path)));
			for (const resource of Object.values(this.state.resources)) if (resource.kind === "file" && canWritePath(this.state, participantId, resource.path)) before[resource.path] = this.versionNode(resource, resource.currentVersionId)!.snapshot;
			const after = this.scan(authority.writePaths, exclusions, true);
			const verification = this.scan(authority.writePaths, exclusions, true);
			if (JSON.stringify(after) !== JSON.stringify(verification)) throw new Error("SAVE_UNSTABLE_FILES: retry when external writes finish");
			const journal: BashJournal = { version: 1, type: "bash", operation: "save", id: randomUUID(), effectId: `effect:${randomUUID()}`, participantId, roots: authority.writePaths, exclusions, before, after, createdAt: now() };
			this.store.writeJournal(journal);
			const changed = this.commitBashJournal(journal, "save", "save", undefined, "committed");
			this.removeCommittedJournal(journal.id);
			return changed;
		}));
	}

	private authorityEvents(participantIds: string[], resourceIds: string[], fileUpdates: FileTransferUpdate[] = []): void {
		const details = fileUpdates.map((update) => update.change === "saved"
			? `External disk changes saved as a new File version: ${update.resourceId} -> ${update.stateId}.`
			: `Disk verified against the current File version: ${update.resourceId} -> ${update.stateId}; divergence cleared.`);
		for (const id of new Set(participantIds)) if (this.state.participants[id]?.kind === "agent") this.queueRuntimeEvent(id, [`[Linden authority update] ${resourceIds.join(", ")} changed. Consult authority for current permissions.`, ...details].join("\n"));
	}

	registerNetworkBridge(participantId: string, bridge: NetworkBridge): void {
		const bridges = this.networkBridges.get(participantId) ?? new Set<NetworkBridge>();
		bridges.add(bridge);
		this.networkBridges.set(participantId, bridges);
	}

	networkGuard(participantId: string): NetGuard {
		return new NetGuard(() => {
			if (this.state.archived || !this.state.participants[participantId]) return { endpoints: [], exclusions: [] };
			const authority = this.effectiveAuthority(participantId);
			return { endpoints: authority.netEndpoints ?? [], exclusions: authority.netExclusions ?? [] };
		}, (id) => {
			const publication = this.publications.get(id);
			if (!publication) return undefined;
			publication.state = existsSync(publication.socketPath) ? "ready" : "starting";
			return publication.socketPath;
		}, (id, address) => {
			this.store.appendNetworkAudit({ at: now(), participantId, endpoint: id, address });
		});
	}

	closeNetworkConnections(participantId: string): void {
		for (const bridge of this.networkBridges.get(participantId) ?? []) bridge.closeConnections();
	}

	async publishNet(participantId: string, resourceId: string, termId: string, internalPort: number, start: () => Promise<string>, stop: () => Promise<void>): Promise<string> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(async () => {
			this.require({ kind: "publish", participantId, resourceId, targetId: termId });
			const resource = this.state.resources[resourceId];
			if (resource.kind !== "net" || resource.public) throw new Error("Publication requires an exact Net endpoint");
			if (this.publications.has(resourceId)) throw new Error("NET_ALREADY_PUBLISHED");
			const socketPath = await start();
			try {
				this.persistStaged(() => this.commitEffect("publish", participantId, resourceId, undefined, termId));
				this.publications.set(resourceId, { ownerId: participantId, termId, internalPort, socketPath, state: "starting" });
				// A newly published route replaces external connections to this name.
				for (const id of this.networkBridges.keys()) this.closeNetworkConnections(id);
				return resourceId;
			} catch (error) { await stop(); throw error; }
		}));
	}

	async unpublishNet(participantId: string, resourceId: string, stop: (termId: string) => Promise<void>): Promise<void> {
		await this.resourceWriterGate.run(() => this.commitMutex.run(async () => {
			const publication = this.publications.get(resourceId);
			if (!publication) throw new Error("NET_NOT_PUBLISHED");
			this.require({ kind: "unpublish", participantId, resourceId, targetId: publication.termId });
			// Persist authorization before removing a process-local route. A crash
			// also destroys the bridge; it never recreates a published service.
			this.persistStaged(() => this.commitEffect("unpublish", participantId, resourceId, undefined, publication.termId));
			this.publications.delete(resourceId);
			for (const id of this.networkBridges.keys()) this.closeNetworkConnections(id);
			await stop(publication.termId);
		}));
	}

	forgetTermPublications(termId: string): void {
		let removed = false;
		for (const [id, publication] of this.publications) if (publication.termId === termId) { this.publications.delete(id); removed = true; }
		if (removed) for (const id of this.networkBridges.keys()) this.closeNetworkConnections(id);
	}

	private assertNetTransfer(resourceIds: string[]): void {
		if (resourceIds.some((id) => this.publications.has(id))) throw new Error("NET_PUBLISHED: unpublish before transferring complete authority");
	}

	async materializeNet(participantId: string, input: string): Promise<string> {
		const endpoint = netReference(input);
		return this.commitMutex.run(() => this.persistStaged(() => {
			const known = this.state.resources[endpoint.id];
			if (known) return known.id;
			const broad = this.state.resources["net:tcp/public"];
			this.require({ kind: "net-refine", participantId, resourceId: "net:tcp/public" });
			if (endpoint.public || !broad || this.ownerOf(broad.id) !== participantId) throw new Error(`UNAUTHORIZED_NET_REFINEMENT: ${participantId} does not own a covering Net`);
			// DNS names are guarded on every connection; private literal IPs are
			// never children of the public endpoint set.
			if (!endpoint.dns && privateAddress(endpoint.host)) throw new Error("Private IP is not contained in net:tcp/public");
			this.state.resources[endpoint.id] = { ...endpoint, kind: "net", derivedFrom: broad.id, createdAt: now() };
			this.installComplete(participantId, endpoint.id);
			return endpoint.id;
		}));
	}

	get rootParticipantId(): ParticipantId { return this.state.rootParticipantId; }
	get sessionParticipantId(): ParticipantId {
		if (!this.primarySessionParticipantId) throw new Error("This human-scoped manager has no primary Pi session");
		return this.primarySessionParticipantId;
	}

	snapshot(): AuthorityState { return structuredClone(this.state); }

	participant(id: ParticipantId): ParticipantRecord | undefined { return this.state.participants[id] ? structuredClone(this.state.participants[id]) : undefined; }
	participantTombstone(id: ParticipantId) { return this.state.participantTombstones[id] ? structuredClone(this.state.participantTombstones[id]) : undefined; }

	resource(id: ResourceId): ResourceView | undefined {
		const resource = this.state.resources[id];
		return resource ? { ...structuredClone(resource), ownerId: this.ownerOf(id), pointers: this.pointersTo(id) } as ResourceView : undefined;
	}

	listParticipants(): ParticipantRecord[] { return Object.values(this.state.participants).map((participant) => structuredClone(participant)); }

	/** Acquire ordinary pointers to exactly the live participants in the returned snapshot. */
	async discoverParticipants(participantId: ParticipantId): Promise<AuthorityState> {
		return this.commitMutex.run(() => {
			const derivation = this.require({ kind: "participants", participantId });
			const current = this.state.contexts[participantId].gamma.agentPointers;
			if (derivation.contexts[participantId].gamma.agentPointers.length === current.length) return this.snapshot();
			return this.persistStaged(() => {
				this.state.contexts = derivation.contexts;
				this.commitEffect("participants", participantId);
				return this.snapshot();
			});
		});
	}

	participantDepth(participantId: ParticipantId): number {
		let participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		let depth = 0;
		const seen = new Set<ParticipantId>();
		while (participant.parentId) {
			if (seen.has(participant.id)) throw new Error(`INVALID_RUNTIME_STATE: participant cycle at ${participant.id}`);
			seen.add(participant.id);
			depth++;
			const parent = this.state.participants[participant.parentId];
			if (!parent) throw new Error(`INVALID_RUNTIME_STATE: ${participant.id} has missing parent ${participant.parentId}`);
			participant = parent;
		}
		if (participant.id !== this.state.rootParticipantId) throw new Error(`INVALID_RUNTIME_STATE: ${participantId} is not rooted at ${this.state.rootParticipantId}`);
		return depth;
	}

	agentDepth(participantId: ParticipantId): number {
		let participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		let depth = participant.kind === "agent" ? 1 : 0;
		const seen = new Set<ParticipantId>();
		while (participant.parentId) {
			if (seen.has(participant.id)) throw new Error(`INVALID_RUNTIME_STATE: participant cycle at ${participant.id}`);
			seen.add(participant.id);
			participant = this.state.participants[participant.parentId];
			if (!participant) throw new Error(`INVALID_RUNTIME_STATE: missing participant ancestor`);
			if (participant.kind === "agent") depth += 1;
		}
		return depth;
	}

	listResources(): ResourceView[] { return Object.values(this.state.resources).map((resource) => ({ ...structuredClone(resource), ownerId: this.ownerOf(resource.id), pointers: this.pointersTo(resource.id) } as ResourceView)); }

	ownerOf(resourceId: ResourceId): ParticipantId | undefined { return ownerOf(this.state, resourceId); }

	pointersTo(resourceId: ResourceId): ParticipantId[] { return pointersTo(this.state, resourceId); }

	authoritySnapshot(participantId: ParticipantId): ParticipantAuthoritySnapshot { return authoritySnapshot(this.state, participantId); }

	requireRead(participantId: ParticipantId, path: string): void {
		this.require({ kind: "read", participantId, path });
	}

	private require(operation: AuthorityOperation): JudgmentDerivation {
		if (this.state.archived) throw new Error("WORKSPACE_ARCHIVED: restore permissions before performing operations");
		return requireJudgment(this.state, operation);
	}

	private applyDerivation(derivation: JudgmentDerivation): void { this.state.contexts = derivation.contexts; }

	private installComplete(participantId: ParticipantId, resourceId: ResourceId): void {
		const context = this.state.contexts[participantId];
		if (!context) throw new Error(`Unknown participant context ${participantId}`);
		for (const other of Object.values(this.state.contexts)) other.delta.completeValues = other.delta.completeValues.filter((value) => value.identity !== resourceId);
		context.delta.completeValues.push(this.completeValue(resourceId));
		context.gamma.resourcePointers = unique([...context.gamma.resourcePointers, resourceId]);
	}

	private completeValue(identity: string): CompleteValue {
		const resource = this.state.resources[identity];
		if (!resource) {
			const participant = this.state.participants[identity];
			const type = participant?.kind === "human" ? "Human" : participant?.kind === "term" ? "Term" : "Agent";
			return { identity, type, ...(type === "Agent" ? { stateId: this.state.currentAgentStateIds[identity] } : {}) };
		}
		if (resource.kind === "file") return { identity, type: "File", stateId: resource.currentVersionId };
		if (resource.kind === "file-region") return { identity, type: "FileRegion" };
		return { identity, type: resource.kind === "net" ? "Net" : "Web" };
	}

	private updateCompleteState(identity: string, stateId: string): void {
		const owner = this.ownerOf(identity);
		const value = owner ? this.state.contexts[owner].delta.completeValues.find((candidate) => candidate.identity === identity) : undefined;
		if (!value) throw new Error(`Complete identity ${identity} has no value in Δ`);
		value.stateId = stateId;
	}

	private installPointer(participantId: ParticipantId, resourceId: ResourceId): void {
		const context = this.state.contexts[participantId];
		if (!context) throw new Error(`Unknown participant context ${participantId}`);
		context.gamma.resourcePointers = unique([...context.gamma.resourcePointers, resourceId]);
	}

	private installMessage(participantId: ParticipantId, messageId: string): void {
		const context = this.state.contexts[participantId];
		if (!context) throw new Error(`Unknown participant context ${participantId}`);
		context.delta.completeValues = [
			...context.delta.completeValues.filter((value) => value.identity !== messageId),
			{ identity: messageId, type: "Message" },
		];
	}

	materializeWeb(participantId: ParticipantId, input: string): ResourceId {
		if (this.state.explicitAuthority) throw new Error("Web is historical; new workspaces use typed Net resources");
		const { id, selector } = resolveWebResourceReference(input);
		const existing = this.state.resources[id];
		if (existing) {
			if (existing.kind !== "web") throw new Error(`${id} is not a Web resource`);
			return id;
		}
		const covering = Object.values(this.state.resources)
			.filter((resource): resource is WebResource => resource.kind === "web" && hostSelectorContains(resource.domains[0], selector))
			.sort((left, right) => right.domains[0].length - left.domains[0].length);
		const mostSpecific = covering[0];
		if (mostSpecific && this.ownerOf(mostSpecific.id) !== participantId) throw new Error(`${participantId} does not own the most-specific Web selector ${mostSpecific.id} covering ${selector}`);
		const parent = mostSpecific && this.ownerOf(mostSpecific.id) === participantId ? mostSpecific : undefined;
		if (!parent && participantId !== this.rootParticipantId) throw new Error(`${participantId} does not own a Web selector covering ${selector}`);
		const resource: WebResource = { id, kind: "web", domains: [selector], derivedFrom: parent?.id, createdAt: now() };
		this.state.resources[id] = resource;
		this.installComplete(participantId, id);
		for (const pointerHolder of parent ? this.pointersTo(parent.id) : []) this.installPointer(pointerHolder, id);
		this.persist();
		return id;
	}

	resolveParticipantRef(input: string): ParticipantId {
		const reference = input.trim();
		if (reference.length === 0) throw new Error("Participant reference must not be empty");
		if (this.state.participants[reference]) return reference;
		// A typed participant reference denotes exactly that participant. Do not
		// erase its kind and accidentally resolve (for example) a missing Term to
		// an Agent whose Pi session happens to share the same suffix.
		if (/^(?:human|agent|term):/.test(reference)) throw new Error(`Unknown participant ${input}`);
		const suffix = reference;
		if (suffix.length === 0) throw new Error(`Unknown participant ${input}`);
		const agents = Object.values(this.state.participants).filter((participant) => participant.kind === "agent");
		const exactSession = agents.filter((participant) => participant.piSessionId === suffix);
		if (exactSession.length === 1) return exactSession[0].id;
		if (exactSession.length > 1) {
			throw new Error(`Ambiguous participant reference ${input}: ${exactSession.map((participant) => participant.id).join(", ")}`);
		}
		const participants = Object.values(this.state.participants);
		const matches = participants.filter((participant) =>
			participant.id.endsWith(suffix) || (participant.kind === "agent" && participant.piSessionId?.endsWith(suffix)),
		);
		const ids = unique(matches.map((participant) => participant.id));
		if (ids.length === 1) return ids[0];
		if (ids.length > 1) {
			const candidates = ids.map((id) => {
				const sessionId = this.state.participants[id]?.piSessionId;
				return sessionId && id !== `agent:${sessionId}` ? `${id} (pi=${sessionId})` : id;
			});
			throw new Error(`Ambiguous participant suffix ${input}: ${candidates.join(", ")}`);
		}
		throw new Error(`Unknown participant ${input}; use a full participant ID or a unique participant/Pi session suffix`);
	}

	private async ensureTopLevelSession(options: ManagerOptions): Promise<void> {
		const sessionId = options.sessionId!;
		const requestedId = options.sessionParticipantId ?? `agent:${sessionId}`;
		const matches = Object.values(this.state.participants).filter((participant) => participant.kind === "agent" && participant.piSessionId === sessionId);
		if (matches.length > 1) throw new Error(`Multiple participants claim Pi session ${sessionId}`);
		const existing = matches[0] ?? this.state.participants[requestedId];
		if (existing) {
			if (existing.kind !== "agent" || existing.parentId !== this.rootParticipantId) throw new Error(`Pi session ${sessionId} is not a top-level Agent of ${this.rootParticipantId}`);
			const sessionFile = options.sessionFile ?? existing.sessionFile;
			const name = options.sessionName?.trim() || existing.name;
			this.assertParticipantRuntimeBinding(existing.id, sessionId, sessionFile);
			if (existing.name !== name || existing.piSessionId !== sessionId || existing.sessionFile !== sessionFile) {
				await this.commitMutex.run(() => {
					existing.name = name;
					existing.piSessionId = sessionId;
					existing.sessionFile = sessionFile;
					this.persist();
				});
			}
			this.primarySessionParticipantId = existing.id;
			return;
		}
		await this.spawnWith(
			this.rootParticipantId,
			requestedId,
			options.sessionName?.trim() || sessionId.slice(-8),
			[],
			async () => ({ piSessionId: sessionId, sessionFile: options.sessionFile }),
		);
		this.primarySessionParticipantId = requestedId;
	}

	private normalizeMessages(): boolean {
		let changed = false;
		for (const message of Object.values(this.state.messages)) {
			// Pi's in-memory steering/follow-up queues are not durable. An
			// unacknowledged claim is therefore made available again on restore.
			if (message.deliveryBatchId && !message.consumedAt) {
				message.deliveryBatchId = undefined;
				message.queuedAt = undefined;
				changed = true;
			}
		}
		return changed;
	}

	private normalizeParticipantStatuses(): boolean {
		let changed = false;
		for (const participant of Object.values(this.state.participants)) {
			if (participant.status !== "running" && participant.status !== "ready") continue;
			if (participant.kind === "agent" && participant.status === "running") this.staleRunningParticipants.add(participant.id);
			// No participant workload survives process recovery. Pi runtimes may be
			// restored lazily, and Term epochs are reconciled from their journals.
			participant.status = "stopped";
			changed = true;
		}
		return changed;
	}

	wasParticipantRunningAtOpen(participantId: ParticipantId): boolean {
		return this.staleRunningParticipants.has(participantId);
	}

	private assertParticipantRuntimeBinding(participantId: ParticipantId, piSessionId?: string, sessionFile?: string): void {
		if ((piSessionId !== undefined && (typeof piSessionId !== "string" || piSessionId.length === 0))
			|| (sessionFile !== undefined && (typeof sessionFile !== "string" || sessionFile.length === 0))
			|| (sessionFile !== undefined && piSessionId === undefined)) throw new Error(`INVALID_PARTICIPANT_STATE: runtime metadata for ${participantId} is malformed`);
		const duplicate = [...Object.values(this.state.participants), ...Object.values(this.state.participantTombstones)].find((candidate) => candidate.id !== participantId && (
			(piSessionId !== undefined && candidate.piSessionId === piSessionId)
			|| (sessionFile !== undefined && candidate.sessionFile === sessionFile)));
		if (duplicate) throw new Error(`INVALID_PARTICIPANT_STATE: runtime metadata for ${participantId} is already bound to ${duplicate.id}`);
	}

	/**
	 * In-transit ownership no longer exists: any transfer left behind by an
	 * older process completes automatically to its intended recipient at load.
	 */
	effectiveAuthority(participantId: ParticipantId): EffectiveAuthority {
		const readExpressions = pathExpressions(this.state, participantId, false);
		const writeExpressions = pathExpressions(this.state, participantId, true);
		const writeExclusions = unique(writeExpressions.flatMap((expression) => expression.exclude));
		const absent = writeExclusions.filter((path) => !existsSync(path));
		const exactFiles = new Set(Object.values(this.state.resources).filter((resource): resource is FileResource => resource.kind === "file").map((resource) => resource.path));
		const webDomains: string[] = [];
		const netEndpoints: string[] = [];
		const netExclusions: string[] = [];
		for (const resource of Object.values(this.state.resources)) if (resource.kind === "net") {
			if (canObserveResource(this.state, participantId, resource.id)) netEndpoints.push(resource.id);
			else if (!resource.public) netExclusions.push(resource.id);
		}
		for (const resource of Object.values(this.state.resources)) if (!this.state.explicitAuthority && resource.kind === "web" && canObserveResource(this.state, participantId, resource.id)) webDomains.push(...resource.domains);
		return {
			readExpressions,
			writeExpressions,
			readPaths: unique([...readExpressions.map((expression) => expression.include), ...Object.values(this.state.resources).filter((resource): resource is FileResource => resource.kind === "file" && canReadPath(this.state, participantId, resource.path) && !readExpressions.some((expression) => pathExpressionContains(expression, resource.path))).map((resource) => resource.path)]),
			writePaths: unique([...writeExpressions.map((expression) => expression.include), ...Object.values(this.state.resources).filter((resource): resource is FileResource => resource.kind === "file" && canWritePath(this.state, participantId, resource.path) && !writeExpressions.some((expression) => pathExpressionContains(expression, resource.path))).map((resource) => resource.path)]),
			denyReadPaths: unique(readExpressions.flatMap((expression) => expression.exclude)),
			denyWritePaths: writeExclusions.filter((path) => existsSync(path)),
			absentWriteFileExclusions: absent.filter((path) => exactFiles.has(path)),
			unsafeAbsentWriteExclusions: absent.filter((path) => !exactFiles.has(path)),
			webDomains: unique(webDomains),
			netEndpoints,
			netExclusions,
		};
	}

	/** Materialize and return the canonical base File-region identity. */
	baseResourceId(): ResourceId {
		if (this.state.explicitAuthority && !this.state.resources[pathResourceId(this.base)]) throw new Error("Root is a position, not implicit File authority");
		return this.materializeBaseRegion().id;
	}

	/**
	 * read returns the FileState of an authorized File location: Absent is a
	 * first-class result, not an error. NOT_A_FILE is still an error because a
	 * directory has no String content to read.
	 */
	async readFile(participantId: ParticipantId, input: string): Promise<FileReadResult> {
		const result = await this.readFileBytes(participantId, input);
		return { ...result, content: result.content.toString("utf8") };
	}

	/** A single authorized published view, shared by text and image gateways. */
	async readFileBytes(participantId: ParticipantId, input: string): Promise<Omit<FileReadResult, "content"> & { content: Buffer }> {
		const path = resolvePublicPath(input, this.base, this.base, this.privateRoots);
		this.require({ kind: "read", participantId, path });
		const resource = this.fileAt(path);
		const view = this.snapshotForActiveRead(path);
		if (view) {
			const content = this.store.readSnapshot(view.snapshot);
			if (content === undefined) return { path, state: "Absent", content: Buffer.alloc(0), resourceId: resource?.id, stale: true, ledgerSequence: view.ledgerSequence };
			return { path, state: "Present", content, resourceId: resource?.id, stale: true, ledgerSequence: view.ledgerSequence };
		}
		if (!resource) {
			if (!existsSync(path)) return { path, state: "Absent", content: Buffer.alloc(0), stale: false, ledgerSequence: this.state.sequence };
			this.assertSafePhysicalFile(path, input);
			return { path, state: "Present", content: readFileSync(path), stale: false, ledgerSequence: this.state.sequence };
		}
		const captured = this.store.captureWithContent(path, false, true);
		this.assertPhysicalSnapshot(resource, captured.snapshot);
		return captured.content === undefined
			? { path, state: "Absent", content: Buffer.alloc(0), resourceId: resource.id, stale: false, ledgerSequence: this.state.sequence }
			: { path, state: "Present", content: captured.content, resourceId: resource.id, stale: false, ledgerSequence: this.state.sequence };
	}

	async writeFile(participantId: ParticipantId, input: string, content: string): Promise<FileMutationResult> {
		return this.mutateFile(participantId, input, "write", () => Buffer.from(content));
	}

	async editFile(participantId: ParticipantId, input: string, edits: readonly FileEdit[]): Promise<FileMutationResult>;
	async editFile(participantId: ParticipantId, input: string, oldText: string, newText: string): Promise<FileMutationResult>;
	async editFile(participantId: ParticipantId, input: string, editsOrOldText: readonly FileEdit[] | string, newText?: string): Promise<FileMutationResult> {
		const edits = typeof editsOrOldText === "string"
			? [{ oldText: editsOrOldText, newText: newText ?? "" }]
			: [...editsOrOldText];
		if (!edits.length) throw new Error("Edit requires at least one replacement");
		return this.mutateFile(participantId, input, "edit", (before) => {
			const source = before.toString("utf8");
			const matches = edits.map((edit, index) => {
				if (!edit.oldText.length) throw new Error(`Edit ${index + 1} oldText must not be empty`);
				const start = source.indexOf(edit.oldText);
				if (start < 0) throw new Error(`Edit match was not found${edits.length > 1 ? ` for replacement ${index + 1}` : ""}`);
				if (source.indexOf(edit.oldText, start + edit.oldText.length) >= 0) throw new Error(`Edit match is not unique${edits.length > 1 ? ` for replacement ${index + 1}` : ""}`);
				return { ...edit, start, end: start + edit.oldText.length, index };
			}).sort((left, right) => left.start - right.start || left.index - right.index);
			let cursor = 0;
			const output: string[] = [];
			for (const match of matches) {
				if (match.start < cursor) throw new Error(`Edit replacements overlap at replacement ${match.index + 1}`);
				output.push(source.slice(cursor, match.start), match.newText);
				cursor = match.end;
			}
			output.push(source.slice(cursor));
			return Buffer.from(output.join(""));
		});
	}

	async subpath(participantId: ParticipantId, parentResourceId: ResourceId, input: string, mode: "read" | "write" = "read"): Promise<PathRefinementResult> {
		return this.resourceWriterGate.run(() => {
			const parent = this.state.resources[parentResourceId];
			if (!parent || parent.kind !== "file-region") throw new Error(`${parentResourceId} is not a File region`);
			const path = resolvePublicPath(input, parent.path, this.base, this.privateRoots);
			const id = pathResourceId(path);
			const existing = Object.values(this.state.resources).find((resource): resource is FileRegionResource => resource.kind === "file-region" && resource.path === path);
			if (existing) {
				if (path === parent.path || !isInside(path, parent.path)) throw new Error(`${path} is not a strict refinement of ${parent.path}`);
				const allowed = mode === "write" ? this.ownerOf(existing.id) === participantId : canObserveResource(this.state, participantId, existing.id);
				if (!allowed) throw new Error(`UNAUTHORIZED_${mode.toUpperCase()}: ${participantId} cannot use ${existing.id}`);
				return { resourceId: existing.id, path, kind: "file-region", mode };
			}
			const contexts = deriveRefinement(this.state, { participantId, parentResourceId, resourceId: id, path, mode, resourceType: "FileRegion" });
			const resource: FileRegionResource = { id, kind: "file-region", path, derivedFrom: parent.id, createdAt: now() };
			this.state.resources[id] = resource;
			this.state.contexts = contexts;
			this.commitEffect("subpath", participantId, id);
			this.persist();
			return { resourceId: id, path, kind: "file-region", mode };
		});
	}

	async file(participantId: ParticipantId, parentResourceId: ResourceId, input: string, mode: "read" | "write" = "read"): Promise<PathRefinementResult> {
		return this.resourceWriterGate.run(() => {
			const parent = this.state.resources[parentResourceId];
			if (!parent || parent.kind !== "file-region") throw new Error(`${parentResourceId} is not a File region`);
			const path = resolvePublicPath(input, parent.path, this.base, this.privateRoots);
			const existing = this.fileAt(path);
			if (existing) {
				if (path === parent.path || !isInside(path, parent.path)) throw new Error(`${path} is not a strict refinement of ${parent.path}`);
				const allowed = mode === "write" ? canWritePath(this.state, participantId, path) : canObserveResource(this.state, participantId, existing.id);
				if (!allowed) throw new Error(`UNAUTHORIZED_${mode.toUpperCase()}: ${participantId} cannot use ${existing.id}`);
				return { resourceId: existing.id, path, kind: "file", mode };
			}
			const resource = this.materializeFile(path, participantId, undefined, parent, mode, false);
			this.commitEffect("file", participantId, resource.id);
			this.persist();
			return { resourceId: resource.id, path, kind: "file", mode };
		});
	}

	/**
	 * Locate the resource that covers a path input for refinement or grants.
	 * Relative inputs resolve against the supplied cwd/base. Returns an exact
	 * region resource when the input is one, otherwise
	 * the most specific held Path strictly containing it (refined=true means
	 * the caller should refine).
	 */
	locateCoveringPath(participantId: ParticipantId, input: string, mode: "read" | "write", cwd = this.base, durable = true): { parentResourceId: ResourceId; path: string; refined: boolean } {
		const path = resolvePublicPath(input, cwd, this.base, this.privateRoots);
		const fileBoundary = this.fileBoundaryAtOrAbove(path);
		if (fileBoundary) {
			const code = fileBoundary.path === path ? "FILE_RESOURCE_KIND_MISMATCH" : "FILE_RESOURCE_BOUNDARY";
			throw new Error(`${code}: ${path} is at or below exact File ${fileBoundary.id}`);
		}
		const usable = (resource: FileRegionResource): boolean => mode === "write"
			? canWritePath(this.state, participantId, resource.path)
			: canReadPath(this.state, participantId, resource.path);
		const exact = Object.values(this.state.resources).find((resource): resource is FileRegionResource => resource.kind === "file-region" && resource.path === path);
		if (exact) {
			if (!usable(exact)) throw new Error(`No ${mode === "write" ? "owned" : "held"} File region covers ${input}; acquire the containing region first or pass an explicit resource ID`);
			return { parentResourceId: exact.id, path, refined: false };
		}
		const candidates = Object.values(this.state.resources)
			.filter((resource): resource is FileRegionResource => resource.kind === "file-region" && isInside(path, resource.path))
			.sort((left, right) => right.path.length - left.path.length);
		let parent = candidates[0];
		if (!parent && !this.state.explicitAuthority && participantId === this.rootParticipantId) {
			parent = this.materializeBaseRegion(durable);
		}
		if (!parent || !usable(parent)) throw new Error(`No ${mode === "write" ? "owned" : "held"} File region covers ${input}; acquire the containing region first or pass an explicit resource ID`);
		return { parentResourceId: parent.id, path, refined: parent.path !== path };
	}

	async statFile(participantId: ParticipantId, input: string): Promise<FileStatusResult> {
		const path = resolvePublicPath(input, this.base, this.base, this.privateRoots);
		this.require({ kind: "stat", participantId, path });
		const resource = this.fileAt(path);
		const view = this.snapshotForActiveRead(path);
		if (view) return view.snapshot.exists
			? { resourceId: resource?.id, path, state: "Present", size: view.snapshot.size, stale: true, ledgerSequence: view.ledgerSequence }
			: { resourceId: resource?.id, path, state: "Absent", stale: true, ledgerSequence: view.ledgerSequence };
		if (!resource) {
			if (!existsSync(path)) return { path, state: "Absent", stale: false, ledgerSequence: this.state.sequence };
			const physical = lstatSync(path);
			if (physical.isFile() && physical.nlink > 1) throw new Error(`HARDLINK_UNSUPPORTED: ${input}`);
			if (!physical.isFile()) throw new Error(`NOT_A_FILE: ${input}`);
			return { path, state: "Present", size: physical.size, stale: false, ledgerSequence: this.state.sequence };
		}
		const snapshot = this.store.capture(path, false, true);
		this.assertPhysicalSnapshot(resource, snapshot);
		return snapshot.exists
			? { resourceId: resource.id, path, state: "Present", size: snapshot.size, stale: false, ledgerSequence: this.state.sequence }
			: { resourceId: resource.id, path, state: "Absent", stale: false, ledgerSequence: this.state.sequence };
	}

	async checkout(participantId: ParticipantId, resourceId: ResourceId, stateId: VersionId): Promise<FileMutationResult> {
		return this.resourceWriterGate.run(async () => {
			this.require({ kind: "checkout", participantId, resourceId, stateId });
			const resource = this.state.resources[resourceId] as FileResource;
			this.assertNoTermWriteOverlap([resource.path], `checkout ${resource.id}`);
			const target = this.versionNode(resource, stateId)!;
			const captured = this.store.captureWithContent(resource.path, false, true);
			this.assertPhysicalSnapshot(resource, captured.snapshot);
			// Archive only a state that matched the ledger. A divergent replacement
			// must not be copied into the private blob store before it is rejected.
			const before = captured.content
				? this.store.captureBuffer(captured.content, captured.snapshot.mode)
				: captured.snapshot;
			const journal: FileJournal = {
				version: 1,
				type: "file",
				id: randomUUID(),
				operation: "checkout",
				participantId,
				resourceId,
				path: resource.path,
				before,
				after: target.snapshot,
				stateNodeId: stateId,
				targetStateId: stateId,
				createdAt: now(),
			};
			this.store.writeJournal(journal);
			const previousStateId = resource.currentVersionId;
			const previousSequence = this.state.sequence;
			const previousEffects = this.state.effects.length;
			let mutated = false;
			try {
				this.store.writeSnapshot(resource.path, target.snapshot); mutated = true;
				resource.currentVersionId = stateId;
				this.updateCompleteState(resource.id, stateId);
				this.commitEffect("checkout", participantId, resourceId, stateId);
				this.persist();
				this.store.removeJournal(journal.id);
				return { resourceId, stateId, path: resource.path, hash: target.snapshot.hash, size: target.snapshot.size ?? 0 };
			} catch (error) {
				resource.currentVersionId = previousStateId;
				this.updateCompleteState(resource.id, previousStateId);
				this.state.sequence = previousSequence;
				this.state.effects.length = previousEffects;
				if (mutated) this.compensateOrDiverge(resourceId, resource.path, before, journal.id);
				else this.store.removeJournal(journal.id);
				throw error;
			}
		});
	}

	async bash(participantId: ParticipantId, command: string, options: BashManagerOptions = {}): Promise<BashExecutionResult> {
		return this.resourceWriterGate.run(async () => {
			const { cwd: cwdInput, ...runOptions } = options;
			const cwd = resolvePublicPath(cwdInput ?? this.participantRoot(participantId), this.participantRoot(participantId), this.base, this.privateRoots);
			const prepared = await this.commitMutex.run(() => {
				this.require({ kind: "bash", participantId });
				const authority = this.effectiveAuthority(participantId);
				this.assertNoTermWriteOverlap(authority.writePaths, `run Bash as ${participantId}`);
				const exclusions = unique([
					...authority.denyWritePaths,
					...authority.absentWriteFileExclusions,
					...authority.unsafeAbsentWriteExclusions,
				]);
				const before = this.scan(authority.writePaths, exclusions, true);
				const journal: BashJournal = {
					version: 1,
					type: "bash",
					operation: "bash",
					effectId: `effect:${randomUUID()}`,
					id: randomUUID(),
					participantId,
					roots: authority.writePaths,
					exclusions,
					placeholders: authority.absentWriteFileExclusions.map((path) => ({ path })),
					before,
					createdAt: now(),
				};
				this.store.writeJournal(journal);
				this.activeReadViews.set(`bash:${journal.id}`, {
					participantId,
					ledgerSequence: this.state.sequence,
					roots: [...authority.writePaths],
					exclusions: [...exclusions],
					shadowPaths: [...authority.absentWriteFileExclusions],
					before,
				});
				return { authority, journal };
			});
			const { authority, journal } = prepared;
			const sandbox = new DynamicSandbox(cwd, authority, this.privateRoots, [], undefined, this.sandboxTmpPath, this.networkGuard(participantId), (bridge) => this.registerNetworkBridge(participantId, bridge));
			const chunks: Buffer[] = [];
			let runError: unknown;
			let initialized = false;
			let exitCode: number | null = null;
			let cleanup: PlaceholderCleanupResult = { removed: [], violations: [] };
			try {
				await sandbox.initialize();
				initialized = true;
				journal.placeholders = sandbox.placeholderJournal();
				// The initial journal is already complete when no Absent placeholder
				// was created. Only identities learned during initialization require a
				// second durable journal write.
				if (journal.placeholders.length) this.store.writeJournal(journal);
				const result = await sandbox.exec(command, cwd, { ...runOptions, onData: (data) => { chunks.push(data); runOptions.onData?.(data); } });
				exitCode = result.exitCode;
			} catch (error) {
				runError = error;
			} finally {
				try { await sandbox.shutdown(); }
				catch (error) { runError ??= error; }
				cleanup = sandbox.cleanupPlaceholders();
			}
			let changedResources: ResourceId[] = [];
			await this.commitMutex.run(() => {
				let releaseReadView = false;
				try {
					if (!initialized) {
						if (cleanup.violations.length) {
							const liveState = this.state;
							this.state = structuredClone(liveState);
							try {
								for (const violation of cleanup.violations) this.markPlaceholderDivergence(violation.path);
								this.persist();
							} catch (error) {
								this.state = liveState;
								throw error;
							}
						}
						this.store.removeJournal(journal.id);
						releaseReadView = true;
						return;
					}
					this.prepareBashJournalPost(journal);
					changedResources = this.commitBashJournal(journal, "bash", "bash", undefined, cleanup.violations.length ? "diverged" : "committed", cleanup.violations.map((violation) => violation.path));
					releaseReadView = true;
					this.removeCommittedJournal(journal.id);
				} finally {
					if (releaseReadView) this.activeReadViews.delete(`bash:${journal.id}`);
				}
			});
			if (!initialized) {
				if (cleanup.violations.length) throw this.placeholderViolationError(cleanup, runError);
				if (runError) throw runError;
				throw new Error("Bash sandbox initialization failed");
			}
			if (cleanup.violations.length) throw this.placeholderViolationError(cleanup, runError);
			if (runError) throw runError;
			const notices = cleanup.removed.map((path) => `Absent denied File was exposed to Bash as an empty read-only placeholder and restored to Absent: ${path}`);
			return { exitCode, changedResources, output: Buffer.concat(chunks).toString("utf8"), notices, ledgerSequence: this.state.sequence };
		});
	}

	async beginTermEpoch(start: TermEpochStart): Promise<EffectiveAuthority> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => {
			if (this.state.archived) throw new Error("WORKSPACE_ARCHIVED");
			const participant = this.state.participants[start.termId];
			if (!participant || participant.kind !== "term") throw new Error(`PARTICIPANT_KIND_MISMATCH: ${start.termId} is not a Term`);
			if (this.activeTermEpochs.has(start.termId)) throw new Error(`TERM_EPOCH_OPEN: ${start.termId} already has an open epoch`);
			const authority = this.effectiveAuthority(start.termId);
			this.assertNoTermWriteOverlap(authority.writePaths, `open epoch ${start.epochId}`, start.termId);
			const exclusions = unique([
				...authority.denyWritePaths,
				...authority.absentWriteFileExclusions,
				...authority.unsafeAbsentWriteExclusions,
			]);
			const before = this.scan(authority.writePaths, exclusions, true);
			const journal: BashJournal = {
				version: 1,
				type: "bash",
				operation: "term",
				effectId: `effect:${randomUUID()}`,
				termEpochId: start.epochId,
				id: `term-${hashBuffer(`${start.termId}\0${start.epochId}`)}`,
				participantId: start.termId,
				roots: [...authority.writePaths],
				exclusions,
				placeholders: authority.absentWriteFileExclusions.map((path) => ({ path })),
				before,
				createdAt: start.startedAt,
			};
			this.store.writeJournal(journal);
			const liveState = this.state;
			this.state = structuredClone(liveState);
			this.state.participants[start.termId].status = "running";
			let ancestorId = this.state.participants[start.termId].parentId;
			while (ancestorId) {
				const ancestor = this.state.participants[ancestorId];
				if (!ancestor) throw new Error(`INVALID_RUNTIME_STATE: ${start.termId} has missing ancestor ${ancestorId}`);
				if (ancestor.status === "stopped") ancestor.status = "ready";
				ancestorId = ancestor.parentId;
			}
			try {
				this.persist();
			} catch (error) {
				// No sandbox process has been released yet. Roll back every in-memory
				// lease/read-view/status change and remove the unarmed journal so this
				// manager remains usable after a definite ledger-save failure.
				this.state = liveState;
				try { this.store.removeJournal(journal.id); }
				catch (cleanupError) {
					throw new AggregateError([error, cleanupError], `Term epoch ${start.termId}/${start.epochId} did not start and its journal cleanup failed`, { cause: error });
				}
				throw error;
			}
			this.activeTermEpochs.set(start.termId, { termId: start.termId, epochId: start.epochId, journal, authority });
			this.activeReadViews.set(`term:${start.termId}`, {
				participantId: start.termId,
				ledgerSequence: this.state.sequence,
				roots: [...authority.writePaths],
				exclusions: [...exclusions],
				shadowPaths: [...authority.absentWriteFileExclusions],
				before,
			});
			return structuredClone(authority);
		}));
	}

	async prepareTermEpoch(termId: ParticipantId, epochId: string, placeholders: BashJournal["placeholders"]): Promise<void> {
		await this.commitMutex.run(() => {
			const epoch = this.activeTermEpochs.get(termId);
			if (!epoch || epoch.epochId !== epochId) throw new Error(`TERM_EPOCH_MISMATCH: ${termId}/${epochId}`);
			epoch.journal.placeholders = structuredClone(placeholders ?? []);
			this.store.writeJournal(epoch.journal);
		});
	}

	async finishTermEpoch(finish: TermEpochFinish): Promise<TermEpochCommitResult> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => {
			const epoch = this.activeTermEpochs.get(finish.termId);
			if (!epoch || epoch.epochId !== finish.epochId) throw new Error(`TERM_EPOCH_MISMATCH: ${finish.termId}/${finish.epochId}`);
			if (finish.startedAt !== epoch.journal.createdAt || !Number.isFinite(finish.endedAt) || finish.endedAt < finish.startedAt) throw new Error(`TERM_EPOCH_MISMATCH: invalid timestamps for ${finish.termId}/${finish.epochId}`);
			const cleanup = finish.cleanup ?? { removed: [], violations: [] };
			this.prepareBashJournalPost(epoch.journal);
			const status = cleanup.violations.length ? "diverged" : "committed";
			const trace = finish.trace ? completeTermTrace(finish.trace) : missingTermTrace("trace-unavailable");
			const traceSnapshot = this.store.captureBuffer(Buffer.from(JSON.stringify(trace)), 0o600);
			const record: TermEpochRecord = {
				id: finish.epochId,
				termId: finish.termId,
				effectId: epoch.journal.effectId!,
				startedAt: finish.startedAt,
				endedAt: finish.endedAt,
				forced: finish.forced,
				recovered: false,
				status,
				trace: traceSnapshot,
			};
			const changedResources = this.commitBashJournal(epoch.journal, "term", "exec", finish.termId, status, cleanup.violations.map((violation) => violation.path), finish.termId, record);
			// The semantic commit is durable before journal deletion. Once it has
			// succeeded, release the live epoch even if best-effort cleanup cannot
			// remove the replay record; recovery recognizes the stable effectId.
			this.activeTermEpochs.delete(finish.termId);
			this.activeReadViews.delete(`term:${finish.termId}`);
			this.removeCommittedJournal(epoch.journal.id);
			if (cleanup.violations.length) throw this.placeholderViolationError(cleanup);
			return {
				changedResources,
				notices: cleanup.removed.map((path) => `Absent denied File was exposed to Term as an empty read-only placeholder and restored to Absent: ${path}`),
				ledgerSequence: this.state.sequence,
			};
		}));
	}

	hasOpenTermEpoch(participantId: ParticipantId): boolean { return this.activeTermEpochs.has(participantId); }

	async spawnWith<T extends { piSessionId?: string; sessionFile?: string }>(
		participantId: ParticipantId,
		childId: ParticipantId,
		name: string,
		grants: Array<{ resourceId: ResourceId; mode: "move" | "read" }>,
		createRuntime: () => Promise<T>,
		options: { inheritWorkspaceRead?: boolean; defaultReadRoot?: string; participantKind?: ParticipantKind; rootDir?: string } = {},
	): Promise<T> {
		return this.resourceWriterGate.run(async () => {
			const participantKind = options.participantKind ?? "agent";
			requireParticipantId(childId, participantKind);
			this.assertNoOpenTermEpoch(participantId, "spawn a child or change inherited authority");
			// Validate against a staged authority tree. Default read-root refinement
			// must not leak into the live manager if runtime creation fails.
			this.stageSpawn(participantId, childId, grants, options);
			const runtime = await createRuntime();
			return this.commitMutex.run(() => {
				if (participantKind === "agent") this.assertParticipantRuntimeBinding(childId, runtime.piSessionId, runtime.sessionFile);
				else if (runtime.piSessionId !== undefined || runtime.sessionFile !== undefined) throw new Error(`${participantKind} participant ${childId} cannot bind a Pi session`);
				// Runtime creation may await Pi I/O while mailbox commits continue. Re-
				// derive inside the commit lock so spawn cannot replace bindings committed
				// during that wait.
				const liveState = this.state;
				const staged = this.stageSpawn(participantId, childId, grants, options);
				this.state = staged.state;
				try {
					const participant: ParticipantRecord = {
						id: childId,
						name,
						rootDir: resolvePublicPath(options.rootDir ?? this.state.participants[participantId].rootDir ?? this.base, this.base, this.base, this.privateRoots),
						permissionMode: "manual",
						kind: participantKind,
						parentId: participantId,
						childIds: [],
						piSessionId: runtime.piSessionId,
						sessionFile: runtime.sessionFile,
						status: "stopped",
						createdAt: now(),
					};
					this.state.participants[childId] = participant;
					const parent = this.state.participants[participantId];
					parent.childIds.push(childId);
					this.applyDerivation(staged.derivation);
					this.commitEffect("spawn", participantId, undefined, undefined, childId);
					this.persist();
					return runtime;
				} catch (error) {
					this.state = liveState;
					throw error;
				}
			});
		});
	}

	async give(participantId: ParticipantId, peerId: ParticipantId, resourceId: ResourceId, mode: "move" | "read" = "move"): Promise<ResourceId[]> {
		return (await this.giveWithReceipt(participantId, peerId, resourceId, mode)).resources;
	}

	async giveWithReceipt(participantId: ParticipantId, peerId: ParticipantId, resourceId: ResourceId, mode: "move" | "read" = "move"): Promise<AuthorityTransferReceipt> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => this.persistStaged(() => {
			this.assertNoOpenTermEpoch(participantId, "change its authority");
			this.assertNoOpenTermEpoch(peerId, "change its authority");
			const derivation = this.require({ kind: "give", participantId, peerId, resourceId, mode });
			if (mode === "move") this.assertNetTransfer(derivation.affectedResources);
			this.applyDerivation(derivation);
			const fileUpdates = mode === "move" ? this.saveTransferredFiles(participantId, derivation.affectedResources) : [];
			if (derivation.affectedResources.some((id) => this.state.resources[id]?.kind === "net") && mode === "move") this.closeNetworkConnections(participantId);
			this.authorityEvents([participantId, peerId], derivation.affectedResources, fileUpdates);
			if (mode === "read") {
				this.commitEffect("give", participantId, resourceId, undefined, peerId);
				return { resources: [resourceId], fileUpdates };
			}
			// give A is one atomic transfer: the runtime executes the giver's give!
			// together with the matching recipient-side get! inside a single
			// transition, so ownership arrives immediately with no observable
			// in-transit state and no notification or claim is needed. The pair is
			// still recorded as two effects for conservation audits and rewind.
			this.commitEffect("give", participantId, resourceId, undefined, peerId);
			this.commitEffect("get", peerId, resourceId, undefined, participantId);
			return { resources: [...derivation.affectedResources], fileUpdates };
		})));
	}

	async get(participantId: ParticipantId, peerId: ParticipantId, resourceId: ResourceId): Promise<ResourceId[]> {
		return (await this.getWithReceipt(participantId, peerId, resourceId)).resources;
	}

	async getWithReceipt(participantId: ParticipantId, peerId: ParticipantId, resourceId: ResourceId): Promise<AuthorityTransferReceipt> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => this.persistStaged(() => {
			this.assertNoOpenTermEpoch(participantId, "change its authority");
			this.assertNoOpenTermEpoch(peerId, "change its authority");
			const derivation = this.require({ kind: "get", participantId, peerId, resourceId });
			this.assertNetTransfer(derivation.affectedResources);
			this.applyDerivation(derivation);
			const fileUpdates = this.saveTransferredFiles(participantId, derivation.affectedResources);
			if (derivation.affectedResources.some((id) => this.state.resources[id]?.kind === "net")) this.closeNetworkConnections(peerId);
			this.authorityEvents([participantId, peerId], derivation.affectedResources, fileUpdates);
			// The direct-edge policy lets a parent take what its own child owns:
			// the runtime executes the child-side give! and parent-side get!
			// atomically, so ownership moves immediately.
			this.commitEffect("give", peerId, resourceId, undefined, participantId);
			this.commitEffect("get", participantId, resourceId, undefined, peerId);
			return { resources: [...derivation.affectedResources], fileUpdates };
		})));
	}

	/** Keep physical bytes and import drift at the tip of each transferred File's current branch. */
	private saveTransferredFiles(participantId: ParticipantId, resourceIds: ResourceId[]): FileTransferUpdate[] {
		const files = resourceIds.map((id) => this.state.resources[id]).filter((resource): resource is FileResource => resource?.kind === "file");
		this.assertNoTermWriteOverlap(files.map((file) => file.path), "save Files during authority transfer");
		const captured = files.map((file) => ({ file, snapshot: this.store.capture(file.path, true, true) }));
		for (const { file, snapshot } of captured) {
			const verification = this.store.capture(file.path, false, true);
			if (snapshot.hash !== verification.hash || snapshot.mode !== verification.mode) throw new Error(`TRANSFER_UNSTABLE_FILE: retry when external writes finish: ${file.path}`);
		}
		const updates: FileTransferUpdate[] = [];
		for (const { file, snapshot } of captured) {
			const current = this.versionNode(file, file.currentVersionId);
			if (!current) throw new Error(`File ${file.id} has no current state`);
			if (current.snapshot.hash !== snapshot.hash || current.snapshot.mode !== snapshot.mode) {
				const stateId = versionId(file.id);
				this.appendVersion(file, stateId, snapshot, participantId, "save");
				this.commitEffect("save", participantId, file.id, stateId);
				updates.push({ resourceId: file.id, stateId, change: "saved" });
			} else if (file.divergence) updates.push({ resourceId: file.id, stateId: current.id, change: "verified" });
			delete file.divergence;
		}
		return updates;
	}

	descendantIds(participantId: ParticipantId): ParticipantId[] {
		const result: ParticipantId[] = [];
		const visit = (cursor: ParticipantId): void => {
			for (const childId of this.state.participants[cursor]?.childIds ?? []) { result.push(childId); visit(childId); }
		};
		visit(participantId);
		return result;
	}

	async archiveParticipant(
		participantId: ParticipantId,
		targetId: ParticipantId,
		isRuntimeSubtreeStopped: (participantIds: readonly ParticipantId[]) => boolean,
	): Promise<ParticipantId[]> {
		return this.resourceWriterGate.run(() => this.commitMutex.run(() => {
			const liveState = this.state;
			this.state = structuredClone(liveState);
			try {
			this.require({ kind: "archive", participantId, targetId });
			const target = this.state.participants[targetId];
			if (!target || target.parentId !== participantId) throw new Error(`ROLE_MISMATCH: ${targetId} is not a direct child of ${participantId}`);
			const subtree = new Set<ParticipantId>([targetId, ...this.descendantIds(targetId)]);
			const unsettled = [...subtree].filter((id) => this.state.participants[id]?.status !== "stopped" || this.activeTermEpochs.has(id));
			if (unsettled.length) throw new Error(`PARTICIPANT_STATUS_MISMATCH: archive requires a stopped subtree; unsettled: ${unsettled.join(", ")}`);
			if (!isRuntimeSubtreeStopped([...subtree])) throw new Error(`PARTICIPANT_STATUS_MISMATCH: archive requires a stopped runtime subtree rooted at ${targetId}`);
			const delivering = Object.values(this.state.messages).filter((message) => subtree.has(message.targetId) && message.deliveryBatchId);
			if (delivering.length) throw new Error(`Cannot archive ${targetId} while mailbox delivery is active: ${delivering.map((message) => message.id).join(", ")}`);

			const select = <T>(values: Record<string, T>, include: (value: T, id: string) => boolean): Record<string, T> => Object.fromEntries(Object.entries(values).filter(([id, value]) => include(value, id)));
			const readable = [...subtree].flatMap((id) => this.effectiveAuthority(id).readPaths);
			(this.state.archives ??= {})[targetId] = {
				participants: select(this.state.participants, (_value, id) => subtree.has(id)),
				contexts: select(this.state.contexts, (_value, id) => subtree.has(id)),
				checkpoints: select(this.state.checkpoints, (value) => subtree.has(value.participantId)),
				agentStates: select(this.state.agentStates, (value) => subtree.has(value.participantId)),
				currentAgentStateIds: select(this.state.currentAgentStateIds, (_value, id) => subtree.has(id)),
				agentBranches: select(this.state.agentBranches ?? {}, (_value, id) => subtree.has(id)),
				messages: select(this.state.messages, (value) => subtree.has(value.targetId)),
				files: this.scan(readable),
			};
			this.state.archives[targetId] = structuredClone(this.state.archives[targetId]);
			const parentContext = this.state.contexts[participantId];
			if (!parentContext) throw new Error(`Unknown participant context ${participantId}`);
			const resourceIds = new Set(Object.keys(this.state.resources));
			const projectedPointers = new Set<ResourceId>();
			for (const id of subtree) {
				for (const resourceId of this.state.contexts[id]?.gamma.resourcePointers ?? []) {
					if (!resourceIds.has(resourceId)) continue;
					const heldOutside = Object.entries(this.state.contexts).some(([holder, context]) => !subtree.has(holder) && context.gamma.resourcePointers.includes(resourceId));
					if (!heldOutside) projectedPointers.add(resourceId);
				}
			}
			for (const resourceId of resourceIds) {
				const owner = ownerOf(this.state, resourceId);
				if (!owner || !subtree.has(owner)) continue;
				const value = this.state.contexts[owner].delta.completeValues.find((candidate) => candidate.identity === resourceId);
				if (!value) throw new Error(`INVALID_RUNTIME_STATE: ${owner} does not hold ${resourceId}`);
				parentContext.delta.completeValues = [...parentContext.delta.completeValues.filter((candidate) => candidate.identity !== resourceId), value];
				parentContext.gamma.resourcePointers = unique([...parentContext.gamma.resourcePointers, resourceId]);
			}
			parentContext.gamma.resourcePointers = unique([...parentContext.gamma.resourcePointers, ...projectedPointers]);

			const removedMessages = new Set(Object.values(this.state.messages)
				.filter((message) => !message.consumedAt && subtree.has(message.targetId))
				.map((message) => message.id));
			for (const context of Object.values(this.state.contexts)) {
				context.delta.completeValues = context.delta.completeValues.filter((value) => !subtree.has(value.identity) && !removedMessages.has(value.identity));
				context.gamma.roles = context.gamma.roles.filter((role) => !subtree.has(role.targetId));
			}
			for (const messageId of removedMessages) delete this.state.messages[messageId];
			for (const [id, checkpoint] of Object.entries(this.state.checkpoints)) if (subtree.has(checkpoint.participantId)) delete this.state.checkpoints[id];
			for (const [id, node] of Object.entries(this.state.agentStates)) if (subtree.has(node.participantId)) delete this.state.agentStates[id];
			const retired = [...subtree].map((id) => structuredClone(this.state.participants[id]));
			for (const id of subtree) {
				delete this.state.currentAgentStateIds[id];
				delete this.state.agentBranches?.[id];
				delete this.state.contexts[id];
				delete this.state.participants[id];
			}
			this.state.participants[participantId].childIds = this.state.participants[participantId].childIds.filter((id) => id !== targetId);
			this.authorityEvents([participantId], [...resourceIds]);
			const effect = this.commitEffect("archive", participantId, undefined, undefined, targetId);
			for (const record of retired) this.state.participantTombstones[record.id] = {
				...record,
				status: "stopped",
				archivedAt: effect.createdAt,
				archivedBy: participantId,
				archiveEffectId: effect.id,
			};
			this.persist();
			return [...subtree];
			} catch (error) {
				this.state = liveState;
				throw error;
			}
		}));
	}

	get processStatePath(): string { return join(this.stateDir, "process-state.json"); }

	/** Persist the set of agents a Linden process wants restored on its next start. */
	saveProcessState(activeAgentIds: readonly ParticipantId[]): void {
		const payload = { savedAt: now(), activeAgents: [...new Set(activeAgentIds)] };
		atomicJson(this.processStatePath, payload);
	}

	loadProcessState(): { savedAt: number; activeAgents: ParticipantId[] } | undefined {
		try {
			const parsed = JSON.parse(readFileSync(this.processStatePath, "utf8")) as { savedAt?: unknown; activeAgents?: unknown };
			if (typeof parsed.savedAt !== "number" || !Array.isArray(parsed.activeAgents)) return undefined;
			return { savedAt: parsed.savedAt, activeAgents: parsed.activeAgents.filter((id): id is ParticipantId => typeof id === "string") };
		} catch {
			return undefined;
		}
	}

	async sendWithPayload(participantId: ParticipantId, targetId: ParticipantId, appendPayload: (messageId: string) => Promise<string>, kind: MessageKind = "follow_up"): Promise<MessageRecord> {
		return this.payloadMutex(participantId).run(async () => {
			const operationKind = kind === "steering" ? "steer" : "send";
			const id = await this.commitMutex.run(() => {
				this.require({ kind: operationKind, participantId, targetId });
				return `msg:${randomUUID()}`;
			});
			const payloadEntryId = await appendPayload(id);
			return this.commitMutex.run(() => this.persistStaged(() => {
				// Authority and lifecycle may have changed while Pi stored the payload.
				// Only this short, revalidated transition needs the global commit lock.
				this.require({ kind: operationKind, participantId, targetId });
				if (typeof payloadEntryId !== "string" || payloadEntryId.length === 0 || (this.state.participants[participantId].kind === "human" && !/^private:[0-9a-f]{64}$/.test(payloadEntryId))) throw new Error(`INVALID_MESSAGE_PAYLOAD: ${participantId} returned a non-canonical payload reference`);
				const message: MessageRecord = { id, sequence: this.state.sequence + 1, kind, senderId: participantId, targetId, payloadEntryId, sentAt: now(), origin: "explicit" };
				this.state.messages[id] = message;
				this.installMessage(targetId, id);
				this.commitEffect(operationKind, participantId, undefined, undefined, targetId);
				return structuredClone(message);
			}));
		});
	}

	async sendFinalWithPayload(participantId: ParticipantId, sourceEntryId: string, appendPayload: (messageId: string) => Promise<string>): Promise<MessageRecord> {
		return this.payloadMutex(participantId).run(async () => {
			const prepared = await this.commitMutex.run(() => {
				const parentId = this.state.participants[participantId]?.parentId;
				if (!parentId) throw new Error(`Participant ${participantId} has no parent for final delivery`);
				const existing = this.finalMessage(participantId, sourceEntryId);
				if (existing) return { existing: structuredClone(existing) };
				this.require({ kind: "send", participantId, targetId: parentId });
				return { parentId, id: `msg:${randomUUID()}` };
			});
			if (prepared.existing) return prepared.existing;
			const { parentId, id } = prepared;
			const payloadEntryId = await appendPayload(id);
			return this.commitMutex.run(() => {
				const existing = this.finalMessage(participantId, sourceEntryId);
				if (existing) return structuredClone(existing);
				return this.persistStaged(() => {
					if (this.state.participants[participantId]?.parentId !== parentId) throw new Error(`Participant ${participantId} changed parent during final delivery`);
					this.require({ kind: "send", participantId, targetId: parentId });
					if (typeof payloadEntryId !== "string" || payloadEntryId.length === 0) throw new Error(`INVALID_MESSAGE_PAYLOAD: ${participantId} returned an invalid payload reference`);
					const message: MessageRecord = { id, sequence: this.state.sequence + 1, kind: "follow_up", senderId: participantId, targetId: parentId, payloadEntryId, sentAt: now(), origin: "assistant_final", sourceEntryId };
					this.state.messages[id] = message;
					this.installMessage(parentId, id);
					this.commitEffect("send", participantId, undefined, undefined, parentId);
					return structuredClone(message);
				});
			});
		});
	}

	pendingMessages(participantId: ParticipantId, senderId?: ParticipantId, kind?: MessageKind): MessageRecord[] {
		const participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		if (senderId) {
			const sender = this.state.participants[senderId] ?? this.state.participantTombstones[senderId];
			if (!sender) throw new Error(`UNKNOWN_PARTICIPANT: Unknown participant ${senderId}`);
			if ((participant.kind !== "human" && participant.kind !== "agent") || (sender.kind !== "human" && sender.kind !== "agent")) throw new Error("PARTICIPANT_KIND_MISMATCH: receive is only defined between Human and Agent participants");
			if (!hasOrdinaryParticipantPointer(this.state, participantId, senderId)) throw new Error(`ROLE_FORGERY: ${participantId} has no ordinary participant pointer to ${senderId}`);
		}
		return this.liveMessages(participantId).filter((message) => (!senderId || message.senderId === senderId) && (!kind || (message.kind === kind && !message.deferred)) && !message.deliveryBatchId).sort(compareMessages).map((message) => structuredClone(message));
	}

	async receive(participantId: ParticipantId, senderId: ParticipantId, messageId: string): Promise<MessageRecord> {
		const candidate = this.state.messages[messageId];
		if (!candidate || candidate.senderId !== senderId || candidate.targetId !== participantId) throw new Error(`Message ${messageId} is not available from ${senderId}`);
		const [message] = await this.receiveMessages(participantId, [messageId], senderId);
		if (!message) throw new Error(`Message ${messageId} is not available`);
		return message;
	}

	async receiveMessages(participantId: ParticipantId, messageIds: string[], filteredSenderId?: ParticipantId): Promise<MessageRecord[]> {
		return this.commitMutex.run(() => this.persistStaged(() => {
			const participant = this.state.participants[participantId];
			if (!participant) throw new Error(`UNKNOWN_PARTICIPANT: Unknown participant ${participantId}`);
			if (participant.kind !== "human" && participant.kind !== "agent") throw new Error("PARTICIPANT_KIND_MISMATCH: receive is only defined between Human and Agent participants");
			if (filteredSenderId) {
				const sender = this.state.participants[filteredSenderId] ?? this.state.participantTombstones[filteredSenderId];
				if (!sender) throw new Error(`UNKNOWN_PARTICIPANT: Unknown participant ${filteredSenderId}`);
				if (sender.kind !== "human" && sender.kind !== "agent") throw new Error("PARTICIPANT_KIND_MISMATCH: receive is only defined between Human and Agent participants");
				if (!hasOrdinaryParticipantPointer(this.state, participantId, filteredSenderId)) throw new Error(`ROLE_FORGERY: ${participantId} has no ordinary participant pointer to ${filteredSenderId}`);
			}
			const messages = unique(messageIds).map((messageId) => {
				const message = this.state.messages[messageId];
				if (!message) throw new Error(`Unknown message ${messageId}`);
				if (message.deliveryBatchId) throw new Error(`Message ${messageId} is already queued for delivery`);
				return message;
			}).sort(compareMessages);
			if (filteredSenderId && messages.some((message) => message.senderId !== filteredSenderId)) throw new Error(`Message batch is not restricted to ${filteredSenderId}`);
			if (!messages.length) return [];
			const enforcePointerFilter = Boolean(filteredSenderId);
			this.state.contexts = requireReceiveJudgments(this.state, messages.map((message) => ({ kind: "receive", participantId, senderId: message.senderId, messageId: message.id, filtered: enforcePointerFilter }))).contexts;
			const consumedAt = now();
			for (const message of messages) {
				message.deliveredAt ??= consumedAt;
				message.consumedAt = consumedAt;
				message.consumedBy = participantId;
				this.commitEffect("receive", participantId, undefined, undefined, message.senderId);
			}
			return messages.map((message) => structuredClone(message));
		}, (messages) => messages.length > 0));
	}

	async claimPendingMessages(participantId: ParticipantId, kind: MessageKind, batchId: string): Promise<MessageRecord[]> {
		return this.commitMutex.run(() => {
			if (!this.state.participants[participantId]) throw new Error(`Unknown participant ${participantId}`);
			const messages = this.liveMessages(participantId).filter((message) => message.kind === kind && !message.deferred && !message.deliveryBatchId).sort(compareMessages);
			if (!messages.length) return [];
			requireReceiveJudgments(this.state, messages.map((message) => ({ kind: "receive", participantId, senderId: message.senderId, messageId: message.id, filtered: false })));
			const queuedAt = now();
			for (const message of messages) {
				message.deliveryBatchId = batchId;
				message.queuedAt = queuedAt;
			}
			return messages.map((message) => structuredClone(message));
		});
	}

	async acknowledgeDelivery(participantId: ParticipantId, batchId: string): Promise<MessageRecord[]> {
		return this.commitMutex.run(() => this.persistStaged(() => {
			const messages = this.liveMessages(participantId).filter((message) => message.deliveryBatchId === batchId).sort(compareMessages);
			if (!messages.length) return [];
			this.state.contexts = requireReceiveJudgments(this.state, messages.map((message) => ({ kind: "receive", participantId, senderId: message.senderId, messageId: message.id, filtered: false }))).contexts;
			const deliveredAt = now();
			for (const message of messages) {
				message.deliveredAt = deliveredAt;
				message.consumedAt = deliveredAt;
				message.consumedBy = participantId;
				message.deliveryBatchId = undefined;
				message.queuedAt = undefined;
				this.commitEffect("receive", participantId, undefined, undefined, message.senderId);
			}
			return messages.map((message) => structuredClone(message));
		}, (messages) => messages.length > 0));
	}

	async releaseDelivery(participantId: ParticipantId, batchId: string): Promise<void> {
		await this.commitMutex.run(() => {
			const messages = this.liveMessages(participantId).filter((message) => message.deliveryBatchId === batchId);
			for (const message of messages) {
				message.deliveryBatchId = undefined;
				message.queuedAt = undefined;
			}
		});
	}

	requireListen(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "listen", participantId, targetId }); }
	requireSend(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "send", participantId, targetId }); }
	requireAttach(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "attach", participantId, targetId }); }
	requireSteer(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "steer", participantId, targetId }); }
	requireWait(participantId: ParticipantId, targetId: ParticipantId, until: "ready" | "stopped"): void { this.require({ kind: "wait", participantId, targetId, until }); }
	requireInterrupt(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "interrupt", participantId, targetId }); }
	requireStop(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "stop", participantId, targetId }); }
	requireTermExec(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "exec", participantId, targetId }); }
	requireTermInput(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "input", participantId, targetId }); }
	requireGiveParticipant(participantId: ParticipantId, targetId: ParticipantId): void {
		const participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		const target = this.state.participants[targetId];
		if (!target) throw new Error(`Unknown participant ${targetId}`);
		if (target.parentId !== participant.id && participant.parentId !== target.id) {
			throw new Error(`ROLE_MISMATCH: ${target.id} is not a direct parent or child of ${participant.id}`);
		}
	}
	/**
	 * Side-effect-free preflight used before a typed resource reference may be
	 * refined/materialized for get. The eventual get judgment revalidates this
	 * edge and ownership atomically under the commit lock.
	 */
	requireGetParticipant(participantId: ParticipantId, targetId: ParticipantId): void {
		const participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		const target = this.state.participants[targetId];
		if (!target) throw new Error(`Unknown participant ${targetId}`);
		if (target.parentId !== participant.id) throw new Error(`ROLE_MISMATCH: ${target.id} is not a direct child of ${participant.id}`);
	}

	async commitWait(
		participantId: ParticipantId,
		targetId: ParticipantId,
		until: "ready" | "stopped",
		isRuntimeSatisfied: () => boolean,
	): Promise<boolean> {
		return this.commitMutex.run(() => this.persistStaged(() => {
			this.require({ kind: "wait", participantId, targetId, until });
			const status = this.state.participants[targetId].status;
			const satisfied = until === "ready" ? status !== "running" : status === "stopped";
			if (!satisfied || !isRuntimeSatisfied()) return false;
			this.commitEffect("wait", participantId, undefined, undefined, targetId);
			return true;
		}, (committed) => committed));
	}

	async commitInterrupt(participantId: ParticipantId, targetId: ParticipantId, status: "ready" | "stopped"): Promise<void> {
		await this.commitMutex.run(() => this.persistStaged(() => {
			this.require({ kind: "interrupt", participantId, targetId });
			const descendantActive = this.descendantIds(targetId).some((id) => this.state.participants[id]?.status !== "stopped");
			this.state.participants[targetId].status = status === "stopped" && descendantActive ? "ready" : status;
			this.commitEffect("interrupt", participantId, undefined, undefined, targetId);
		}));
	}

	/**
	 * Atomically order Term stdin against lifecycle and archive transitions. The
	 * adapter callback must complete the PTY Writable callback (and may await it),
	 * but must not re-enter the authority manager.
	 */
	async commitInputWith(
		participantId: ParticipantId,
		targetId: ParticipantId,
		deliver: () => void | Promise<void>,
		preflight?: () => void,
	): Promise<void> {
		await this.commitMutex.run(async () => {
			this.require({ kind: "input", participantId, targetId });
			// A synchronous adapter preflight runs under the same lifecycle/archive
			// ordering lock but before the durable intent. A known not-ready state is
			// therefore an ordinary rejected operation, never a false divergence.
			preflight?.();
			// A successful PTY write cannot be rolled back. Persist a single
			// `diverged` effect first as a durable delivery intent, then upgrade it
			// to committed only after the Writable confirms the write. A crash or
			// final save failure therefore records an explicit uncertain delivery
			// instead of silently losing the physical side effect or inviting an
			// automatic duplicate retry.
			const liveState = this.state;
			this.state = structuredClone(liveState);
			let effect: AuthorityState["effects"][number];
			try {
				effect = this.commitEffect("input", participantId, undefined, undefined, targetId, "diverged");
				this.persist();
			} catch (error) {
				this.state = liveState;
				throw error;
			}
			const preparedState = this.state;
			try { await deliver(); }
			catch (error) {
				throw new Error(`TERM_INPUT_DELIVERY_FAILED: ${effect.id} was durably recorded as diverged and was not confirmed by the PTY`, { cause: error });
			}
			this.state = structuredClone(preparedState);
			const committed = this.state.effects.find((candidate) => candidate.id === effect.id);
			if (!committed) {
				this.state = preparedState;
				throw new Error(`TERM_INPUT_EFFECT_MISSING: ${effect.id}`);
			}
			committed.status = "committed";
			try { this.persist(); }
			catch (error) {
				this.state = preparedState;
				throw new Error(`TERM_INPUT_COMMIT_UNCERTAIN: stdin may have been delivered; ${effect.id} remains durably diverged and must not be retried automatically`, { cause: error });
			}
		});
	}

	async commitStop(participantId: ParticipantId, targetId: ParticipantId): Promise<void> {
		await this.commitMutex.run(() => this.persistStaged(() => {
			this.require({ kind: "stop", participantId, targetId });
			this.state.participants[targetId].status = this.descendantIds(targetId).some((id) => this.state.participants[id]?.status !== "stopped") ? "ready" : "stopped";
			this.commitEffect("stop", participantId, undefined, undefined, targetId);
		}));
	}
	requireLogParticipant(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "log-participant", participantId, targetId }); }
	/** Compatibility entry point for Agent history callers. */
	requireLogAgent(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "log-agent", participantId, targetId }); }
	requireLogTerm(participantId: ParticipantId, targetId: ParticipantId): void { this.require({ kind: "log-term", participantId, targetId }); }
	requireLogResource(participantId: ParticipantId, resourceId: ResourceId): void { this.require({ kind: "log-resource", participantId, resourceId }); }
	requireRewind(participantId: ParticipantId, targetId: ParticipantId, stateId: VersionId): AgentStateNode {
		this.require({ kind: "rewind", participantId, targetId, stateId });
		return structuredClone(this.state.agentStates[stateId]);
	}

	agentBranches(targetId: ParticipantId): AgentBranches {
		if (this.state.participants[targetId]?.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: branches require an Agent (${targetId})`);
		return structuredClone(this.state.agentBranches?.[targetId] ?? legacyAgentBranches(this.state.currentAgentStateIds[targetId]));
	}

	requireNewAgentBranch(targetId: ParticipantId, name: string): void {
		if (!validAgentBranchName(name)) throw new Error("INVALID_AGENT_BRANCH_NAME: use 1–128 characters without whitespace or control characters");
		if (Object.hasOwn(this.agentBranches(targetId).heads, name)) throw new Error(`AGENT_BRANCH_EXISTS: ${name}`);
	}

	agentBranchHead(targetId: ParticipantId, name: string): VersionId {
		const branches = this.agentBranches(targetId);
		if (!Object.hasOwn(branches.heads, name)) throw new Error(`UNKNOWN_AGENT_BRANCH: ${name}`);
		return branches.heads[name];
	}

	async commitRewind(participantId: ParticipantId, targetId: ParticipantId, stateId: VersionId): Promise<EffectRecord> {
		return this.commitAgentNavigation(participantId, targetId, stateId);
	}

	/** Branches are context references; the existing rewind judgment/effect governs navigation. */
	async commitAgentNavigation(participantId: ParticipantId, targetId: ParticipantId, stateId: VersionId, branch?: { name: string; create: boolean }): Promise<EffectRecord> {
		return this.commitMutex.run(() => this.persistStaged(() => {
			this.requireRewind(participantId, targetId, stateId);
			const branches = this.agentBranches(targetId);
			if (branch) {
				if (branch.create) this.requireNewAgentBranch(targetId, branch.name);
				else if (this.agentBranchHead(targetId, branch.name) !== stateId) throw new Error(`AGENT_BRANCH_CHANGED: ${branch.name}`);
				branches.current = branch.name;
			}
			branches.heads = { ...branches.heads, [branches.current]: stateId };
			(this.state.agentBranches ??= {})[targetId] = branches;
			this.state.currentAgentStateIds[targetId] = stateId;
			this.updateCompleteState(targetId, stateId);
			return this.commitEffect("rewind", participantId, undefined, stateId, targetId);
		}));
	}

	checkpointEnvelope(participantId: ParticipantId): CheckpointEnvelope {
		const participant = this.state.participants[participantId];
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		if (participant.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: typed Pi checkpoints belong only to Agent participants (${participantId})`);
		return {
			id: `checkpoint:${randomUUID()}`,
			participantId,
			ledgerSequence: this.state.sequence,
			authority: this.authoritySnapshot(participantId),
			createdAt: now(),
		};
	}

	async recordCheckpoint(envelope: CheckpointEnvelope, piEntryId: string, parentPiEntryId?: string, parentStateId?: VersionId, advanceCurrent = true): Promise<AgentStateNode> {
		return this.commitMutex.run(() => this.persistStaged(() => {
			if (this.state.participants[envelope.participantId]?.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: typed Pi checkpoints belong only to Agent participants (${envelope.participantId})`);
			const checkpoint: TypedCheckpoint = { ...envelope, piEntryId };
			this.state.checkpoints[checkpoint.id] = checkpoint;
			const explicitParent = parentStateId ? this.state.agentStates[parentStateId] : undefined;
			if (parentStateId && explicitParent?.participantId !== envelope.participantId) throw new Error(`Agent state ${parentStateId} does not belong to ${envelope.participantId}`);
			const parent = explicitParent ?? (parentPiEntryId ? Object.values(this.state.agentStates).find((node) => node.participantId === envelope.participantId && node.piEntryId === parentPiEntryId) : this.latestAgentState(envelope.participantId));
			const node: AgentStateNode = {
				id: `agent-state:${envelope.participantId}:${piEntryId}`,
				participantId: envelope.participantId,
				piEntryId,
				parentId: parent?.id,
				checkpointId: checkpoint.id,
				createdAt: now(),
			};
			this.state.agentStates[node.id] = node;
			if (advanceCurrent) {
				const branches = this.agentBranches(envelope.participantId);
				branches.heads = { ...branches.heads, [branches.current]: node.id };
				(this.state.agentBranches ??= {})[envelope.participantId] = branches;
				this.state.currentAgentStateIds[envelope.participantId] = node.id;
				this.updateCompleteState(envelope.participantId, node.id);
			}
			return structuredClone(node);
		}));
	}

	async setParticipantStatus(participantId: ParticipantId, status: ParticipantRecord["status"]): Promise<void> {
		await this.setParticipantStatuses([[participantId, status]]);
	}

	/** Apply one coordinator lifecycle projection atomically in a single ledger save. */
	async setParticipantStatuses(updates: Iterable<readonly [ParticipantId, ParticipantRecord["status"]]>): Promise<void> {
		await this.commitMutex.run(() => this.persistStaged(() => {
			let changed = false;
			for (const [participantId, status] of updates) {
				const participant = this.state.participants[participantId];
				if (!participant || participant.status === status) continue;
				participant.status = status;
				changed = true;
			}
			// stopped is the fully quiescent ready substate. A partial update may
			// arrive before its ancestor projection, so fail closed to ready rather
			// than persist a stopped node above live descendant work.
			for (const participant of Object.values(this.state.participants)) {
				if (participant.status !== "stopped") continue;
				if (this.descendantIds(participant.id).some((id) => this.state.participants[id]?.status !== "stopped")) {
					participant.status = "ready";
					changed = true;
				}
			}
			return changed;
		}, (changed) => changed));
	}

	resourceLog(participantId: ParticipantId, resourceId: ResourceId): Array<{ id: string; parent?: string; summary: string; current: boolean }> {
		this.requireLogResource(participantId, resourceId);
		const resource = this.state.resources[resourceId];
		if (resource.kind !== "file") return [{ id: resource.id, summary: `${resource.kind}:${resource.kind === "file-region" ? resource.path : resource.kind === "net" ? resource.id : resource.domains.join(",")}`, current: true }];
		return resource.versions.map((node) => ({ id: node.id, parent: node.parentId, summary: `${node.operation} ${node.snapshot.exists ? node.snapshot.hash.slice(0, 12) : "absent"}`, current: node.id === resource.currentVersionId }));
	}

	agentStateLog(participantId: ParticipantId, targetId: ParticipantId): AgentStateNode[] {
		this.requireLogAgent(participantId, targetId);
		return Object.values(this.state.agentStates).filter((node) => node.participantId === targetId).map((node) => structuredClone(node));
	}

	termEpochLog(participantId: ParticipantId, targetId: ParticipantId): TermEpochLogEntry[] {
		this.requireLogTerm(participantId, targetId);
		return Object.values(this.state.termEpochs)
			.filter((epoch) => epoch.termId === targetId)
			.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
			.map((epoch) => {
				const content = this.store.readSnapshot(epoch.trace);
				if (!content) throw new Error(`TERM_EPOCH_TRACE_MISSING: ${epoch.id}`);
				return { epoch: structuredClone(epoch), trace: decodeTermTrace(content) };
			});
	}

	rewindNotice(targetId: ParticipantId, stateId: VersionId, rewindEffectSequence: number): string {
		const node = this.state.agentStates[stateId];
		if (!node || node.participantId !== targetId) throw new Error(`Unknown scoped Agent state ${stateId}`);
		const checkpoint = this.state.checkpoints[node.checkpointId];
		const rewindEffect = this.state.effects.find((effect) => effect.sequence === rewindEffectSequence);
		if (!rewindEffect || rewindEffect.kind !== "rewind" || rewindEffect.targetId !== targetId || rewindEffect.stateId !== stateId) {
			throw new Error(`Unknown matching rewind effect at sequence ${rewindEffectSequence}`);
		}
		const current = this.authoritySnapshot(targetId);
		const later = this.state.effects.filter((effect) => effect.sequence > checkpoint.ledgerSequence && effect.sequence < rewindEffectSequence);
		const unavailable = checkpoint.authority.owned.filter((resource) => !current.owned.includes(resource));
		const lines = [
			"[Runtime rewind notice]",
			"",
			`Context was moved to ${stateId} on branch ${this.agentBranches(targetId).current}; only Agent context changed.`,
			`The complete ledger interval after checkpoint sequence ${checkpoint.ledgerSequence} and before rewind sequence ${rewindEffectSequence} follows.`,
			"",
			"Effects not reverted:",
		];
		if (!later.length) lines.push("- none");
		else for (const effect of later) lines.push(this.describeUnrevertedEffect(effect));
		lines.push("", "Current authority:", `- own/write: ${current.owned.join(", ") || "none"}`, `- read: ${current.pointers.join(", ") || "none"}`, `- unavailable: ${unavailable.join(", ") || "none"}`);
		for (const resource of Object.values(this.state.resources)) if (resource.kind === "file") lines.push(`- ${resource.id} remains at ${resource.currentVersionId}`);
		return lines.join("\n");
	}

	private describeUnrevertedEffect(effect: EffectRecord): string {
		const fields = [`sequence=${effect.sequence}`, `status=${effect.status}`, `actor=${effect.participantId}`];
		if (effect.targetId) fields.push(`target=${effect.targetId}`);
		if (effect.resourceId) fields.push(`resource=${effect.resourceId}`);
		if (effect.stateId) fields.push(`state=${effect.stateId}`);
		let consequence = "runtime state transition remains committed";
		switch (effect.kind) {
			case "participants":
				consequence = "discovered ordinary participant pointers remain available; no resource or lineage authority was granted";
				break;
			case "spawn": {
				const spawned = effect.targetId ? this.state.participants[effect.targetId] : undefined;
				const retired = effect.targetId ? this.state.participantTombstones[effect.targetId] : undefined;
				if (spawned) {
					const authority = this.authoritySnapshot(spawned.id);
					const web = [...authority.owned, ...authority.pointers]
						.filter((resourceId, index, all) => all.indexOf(resourceId) === index && (this.state.resources[resourceId]?.kind === "web" || this.state.resources[resourceId]?.kind === "net"));
					consequence = `spawned ${spawned.kind} remains live (${spawned.status}); current own/write=${authority.owned.join(",") || "none"}; current read=${authority.pointers.join(",") || "none"}; current Net authority=${web.join(",") || "none"}`;
				} else if (retired) consequence = `spawned ${retired.kind} remains archived; the later archive effect is not undone`;
				else consequence = "spawned participant remains part of durable history; its creation is not undone";
				break;
			}
			case "give":
			case "get":
				consequence = effect.resourceId && (this.state.resources[effect.resourceId]?.kind === "web" || this.state.resources[effect.resourceId]?.kind === "net")
					? "Net/network authority transfer remains committed; this records permission topology, not whether a request occurred"
					: "resource authority transfer remains committed";
				break;
			case "send":
			case "steer":
				consequence = "information remains sent in the durable mailbox";
				break;
			case "receive":
				consequence = "mailbox consumption remains committed";
				break;
			case "write":
			case "edit":
			case "checkout":
				consequence = "filesystem mutation/current File version remains";
				break;
			case "bash":
			case "exec":
				consequence = "filesystem, process, and possible network side effects may remain; Linden records the enclosing effect but cannot observe exact remote mutations";
				break;
			case "input":
				consequence = "stdin bytes were already delivered; resulting process, filesystem, or network side effects may remain";
				break;
			case "interrupt":
			case "stop":
				consequence = "participant lifecycle control was already applied";
				break;
			case "archive":
				consequence = "participant subtree remains archived and cannot be restored by context rewind";
				break;
			case "subpath":
			case "file":
				consequence = "resource refinement/materialization remains in the ledger";
				break;
			case "wait":
				consequence = "completed lifecycle observation remains in the ledger";
				break;
			case "rewind":
				consequence = "earlier context navigation remains in durable history and did not undo real effects";
				break;
		}
		return `- ${effect.kind}:${effect.id} ${fields.join(" ")}; not-reverted=${consequence}`;
	}

	private async mutateFile(participantId: ParticipantId, input: string, operation: "write" | "edit", transform: (before: Buffer) => Buffer): Promise<FileMutationResult> {
		return this.resourceWriterGate.run(() => {
			const path = resolvePublicPath(input, this.base, this.base, this.privateRoots);
			this.assertNoTermWriteOverlap([path], `${operation} ${path}`);
			this.require({ kind: operation, participantId, path });
			const existing = this.fileAt(path);
			const captured = this.store.captureWithContent(path, !existing, true);
			const resource = existing ?? this.materializeFile(path, participantId, captured.snapshot);
			this.require({ kind: operation, participantId, path });
			this.assertPhysicalSnapshot(resource, captured.snapshot);
			const before = captured.snapshot;
			const beforeContent = captured.content ?? Buffer.alloc(0);
			const afterContent = transform(beforeContent);
			const after = this.store.captureBuffer(afterContent, before.exists ? before.mode : 0o644);
			const stateNodeId = versionId(resource.id);
			const journal: FileJournal = { version: 1, type: "file", id: randomUUID(), operation, participantId, resourceId: resource.id, path, before, after, stateNodeId, createdAt: now() };
			this.store.writeJournal(journal);
			const previousVersionCount = resource.versions.length;
			const previousStateId = resource.currentVersionId;
			const previousSequence = this.state.sequence;
			const previousEffects = this.state.effects.length;
			let mutated = false;
			try {
				this.store.atomicWrite(path, afterContent, after.mode); mutated = true;
				this.appendVersion(resource, stateNodeId, after, participantId, operation);
				this.commitEffect(operation, participantId, resource.id, stateNodeId);
				this.persist();
				this.store.removeJournal(journal.id);
				return { resourceId: resource.id, stateId: stateNodeId, path, hash: after.hash, size: after.size ?? 0 };
			} catch (error) {
				resource.versions.length = previousVersionCount;
				resource.currentVersionId = previousStateId;
				this.updateCompleteState(resource.id, previousStateId);
				this.state.sequence = previousSequence;
				this.state.effects.length = previousEffects;
				if (mutated) this.compensateOrDiverge(resource.id, path, before, journal.id);
				else this.store.removeJournal(journal.id);
				throw error;
			}
		});
	}

	private materializeFile(path: string, participantId: ParticipantId, initialSnapshot?: SnapshotRef, parentResource?: FileRegionResource, mode: "read" | "write" = "write", durable = true): FileResource {
		const existing = this.fileAt(path); if (existing) return existing;
		let parent = parentResource ?? Object.values(this.state.resources)
			.filter((resource): resource is FileRegionResource => resource.kind === "file-region" && isInside(path, resource.path) && this.ownerOf(resource.id) === participantId)
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (!parent && !this.state.explicitAuthority && participantId === this.rootParticipantId && isInside(path, this.base)) parent = this.materializeBaseRegion(false);
		if (!parent || !this.ownerOf(parent.id)) throw new Error(`Cannot materialize ${path} without a held File region`);
		const id = fileResourceId(path, false);
		const snapshot = initialSnapshot ?? this.store.capture(path, true);
		const initialId = versionId(id);
		const contexts = deriveRefinement(this.state, { participantId, parentResourceId: parent.id, resourceId: id, path, mode, resourceType: "File", stateId: initialId });
		const resource: FileResource = {
			id,
			kind: "file",
			path,
			derivedFrom: parent.id,
			versioned: true,
			versions: [{ id: initialId, snapshot, participantId, operation: "initial", createdAt: now() }],
			currentVersionId: initialId,
			createdAt: now(),
		};
		this.state.resources[id] = resource;
		this.state.contexts = contexts;
		if (durable) this.persist();
		return resource;
	}

	private materializeBaseRegion(durable = true): FileRegionResource {
		const id = pathResourceId(this.base);
		const existing = this.state.resources[id];
		if (existing) {
			if (existing.kind !== "file-region") throw new Error(`Base identity ${id} is not a File region`);
			return existing;
		}
		const resource: FileRegionResource = {
			id,
			kind: "file-region",
			path: this.base,
			createdAt: now(),
		};
		this.state.resources[id] = resource;
		this.installComplete(this.rootParticipantId, id);
		if (durable) this.persist();
		return resource;
	}

	private appendVersion(resource: FileResource, id: VersionId, snapshot: SnapshotRef, participantId: ParticipantId, operation: VersionNode["operation"]): void {
		resource.versions.push({ id, parentId: resource.currentVersionId, snapshot, participantId, operation, createdAt: now() });
		resource.currentVersionId = id;
		this.updateCompleteState(resource.id, id);
	}

	private assertPhysicalSnapshot(resource: FileResource, actual: SnapshotRef): void {
		const expected = this.versionNode(resource, resource.currentVersionId)?.snapshot;
		if (!expected) throw new Error(`File ${resource.id} has no current state`);
		if (actual.hash === expected.hash) return;
		resource.divergence = { expectedHash: expected.hash, actualHash: actual.hash, detectedAt: now() };
		this.persist();
		throw new Error(`RESOURCE_DIVERGED: ${resource.path} expected ${expected.hash}, got ${actual.hash}`);
	}

	private compensateOrDiverge(resourceId: ResourceId, path: string, before: SnapshotRef, journalId: string): void {
		try {
			this.store.writeSnapshot(path, before);
			this.persist();
			this.store.removeJournal(journalId);
		} catch {
			const resource = this.state.resources[resourceId];
			if (resource?.kind === "file") resource.divergence = { expectedHash: before.hash, actualHash: this.store.capture(path, false).hash, detectedAt: now() };
			try { this.persist(); } catch { /* journal remains for restart recovery */ }
		}
	}

	private placeholderViolationError(cleanup: PlaceholderCleanupResult, cause?: unknown): Error {
		const details = cleanup.violations.map((violation) => `${violation.path}: ${violation.reason}`).join("; ");
		return new Error(`BASH_SANDBOX_INTEGRITY: ${details}`, cause === undefined ? undefined : { cause });
	}

	private markPlaceholderDivergence(path: string): void {
		const resource = this.fileAt(path);
		if (!resource) return;
		const expected = resource.versions.find((node) => node.id === resource.currentVersionId)?.snapshot;
		if (!expected) return;
		let actualHash: string;
		try { actualHash = this.store.capture(path, false).hash; }
		catch (error) { actualHash = hashBuffer(`unsupported physical state: ${String(error)}`); }
		if (actualHash !== expected.hash) resource.divergence = { expectedHash: expected.hash, actualHash, detectedAt: now() };
	}
	private prepareBashJournalPost(journal: BashJournal): void {
		journal.effectId ??= `effect:${randomUUID()}`;
		if (journal.operation === "term") journal.termEpochId ??= `epoch:recovered:${journal.id}`;
		journal.after ??= this.scan(journal.roots, journal.exclusions ?? [], true);
		this.store.writeJournal(journal);
	}

	private removeCommittedJournal(journalId: string): void {
		try { this.store.removeJournal(journalId); }
		catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			process.emitWarning(`Committed Linden journal ${journalId} could not be removed; restart recovery will verify and retry cleanup (${detail})`, {
				type: "LindenRuntimeWarning",
				code: "LINDEN_COMMITTED_JOURNAL_CLEANUP_FAILED",
			});
		}
	}

	private verifyCommittedBashJournal(journal: BashJournal): void {
		if (!journal.after) throw new Error(`JOURNAL_POST_STATE_MISSING: ${journal.id}`);
		const absentHash = hashBuffer("linden:absent:v1");
		const actual = this.scan(journal.roots, journal.exclusions ?? [], true);
		const changedPaths = unique([...Object.keys(journal.before), ...Object.keys(journal.after)])
			.filter((path) => (journal.before[path]?.hash ?? absentHash) !== (journal.after![path]?.hash ?? absentHash))
			.sort();
		for (const path of changedPaths) {
			const expectedPostHash = journal.after[path]?.hash ?? absentHash;
			const resource = this.fileAt(path);
			const allowedOperations = journal.operation === "term" ? new Set(["term"]) : new Set(["bash", "recovery", "save"]);
			const recorded = resource?.versions.some((version) => version.snapshot.hash === expectedPostHash
				&& version.participantId === journal.participantId
				&& allowedOperations.has(version.operation));
			if (!resource || !recorded) throw new Error(`JOURNAL_LEDGER_POST_STATE_MISSING: ${journal.id} has no committed File version for ${path}`);
			const current = this.versionNode(resource, resource.currentVersionId)?.snapshot;
			if (!current) throw new Error(`JOURNAL_CURRENT_STATE_MISSING: ${journal.id} File ${path} has no current ledger state`);
			const physicalHash = actual[path]?.hash ?? absentHash;
			if (physicalHash !== current.hash) throw new Error(`JOURNAL_CURRENT_STATE_MISMATCH: ${journal.id} File ${path} differs from its current ledger state`);
		}
		// The old post-image may legitimately drift after the committed effect,
		// but every such drift must itself be represented by the current File
		// ledger. This accepts later Linden writes without turning stale-journal
		// cleanup into a blanket pass for unrelated out-of-band mutations.
		const laterDrift = unique([...Object.keys(journal.after), ...Object.keys(actual)])
			.filter((path) => (journal.after![path]?.hash ?? absentHash) !== (actual[path]?.hash ?? absentHash));
		for (const path of laterDrift) {
			const resource = this.fileAt(path);
			const current = resource && this.versionNode(resource, resource.currentVersionId)?.snapshot;
			if (!current || current.hash !== (actual[path]?.hash ?? absentHash)) {
				throw new Error(`JOURNAL_UNRECORDED_LATER_DRIFT: ${journal.id} no longer safely accounts for ${path}`);
			}
		}
	}

	private commitBashJournal(
		journal: BashJournal,
		versionOperation: "bash" | "term" | "recovery" | "save",
		effectKind: "bash" | "exec" | "save",
		targetId: ParticipantId | undefined,
		status: "committed" | "diverged",
		divergencePaths: readonly string[] = [],
		stoppedParticipantId?: ParticipantId,
		termEpochRecord?: TermEpochRecord,
	): ResourceId[] {
		if (!journal.effectId || !journal.after) throw new Error(`JOURNAL_NOT_PREPARED: ${journal.id}`);
		if (journal.operation === "term") {
			if (!termEpochRecord || !journal.termEpochId) throw new Error(`TERM_EPOCH_LOG_MISSING: ${journal.id}`);
			if (termEpochRecord.id !== journal.termEpochId || termEpochRecord.termId !== journal.participantId || termEpochRecord.effectId !== journal.effectId) throw new Error(`TERM_EPOCH_LOG_MISMATCH: ${journal.id}`);
		} else if (termEpochRecord) throw new Error(`TERM_EPOCH_LOG_UNEXPECTED: ${journal.id}`);
		const existing = this.state.effects.find((effect) => effect.id === journal.effectId);
		if (existing) {
			if (existing.kind !== effectKind || existing.participantId !== journal.participantId || existing.targetId !== targetId) throw new Error(`JOURNAL_EFFECT_MISMATCH: ${journal.id}`);
			this.verifyCommittedBashJournal(journal);
			if (termEpochRecord) {
				const recorded = this.state.termEpochs[termEpochRecord.id];
				if (recorded) {
					if (recorded.effectId !== existing.id || recorded.termId !== termEpochRecord.termId || recorded.status !== existing.status) throw new Error(`TERM_EPOCH_LOG_MISMATCH: ${journal.id}`);
				} else {
					if (Object.values(this.state.termEpochs).some((epoch) => epoch.effectId === existing.id)) throw new Error(`TERM_EPOCH_EFFECT_DUPLICATE: ${journal.id}`);
					const liveState = this.state;
					this.state = structuredClone(liveState);
					try {
						this.state.termEpochs[termEpochRecord.id] = { ...structuredClone(termEpochRecord), status: existing.status };
						if (stoppedParticipantId && this.state.participants[stoppedParticipantId]) this.state.participants[stoppedParticipantId].status = "stopped";
						this.persist();
					} catch (error) {
						this.state = liveState;
						throw error;
					}
				}
			}
			return [];
		}
		const liveState = this.state;
		this.state = structuredClone(liveState);
		try {
			for (const path of divergencePaths) this.markPlaceholderDivergence(path);
			const changed = this.reconcileBash(journal, versionOperation);
			this.commitEffect(effectKind, journal.participantId, undefined, undefined, targetId, status, journal.effectId);
			if (journal.operation === "save") this.state.saveBaseline = { ...this.state.saveBaseline, ...journal.after };
			if (termEpochRecord) {
				if (this.state.termEpochs[termEpochRecord.id] || Object.values(this.state.termEpochs).some((epoch) => epoch.effectId === termEpochRecord.effectId)) throw new Error(`TERM_EPOCH_LOG_DUPLICATE: ${journal.id}`);
				this.state.termEpochs[termEpochRecord.id] = structuredClone(termEpochRecord);
			}
			if (stoppedParticipantId && this.state.participants[stoppedParticipantId]) this.state.participants[stoppedParticipantId].status = "stopped";
			this.persist();
			return changed;
		} catch (error) {
			this.state = liveState;
			throw error;
		}
	}

	private reconcileBash(journal: BashJournal, operation: "bash" | "term" | "recovery" | "save"): ResourceId[] {
		const after = journal.after ?? this.scan(journal.roots, journal.exclusions ?? [], true);
		const changed: ResourceId[] = [];
		for (const path of unique([...Object.keys(journal.before), ...Object.keys(after)]).sort()) {
			const before = journal.before[path] ?? { exists: false, hash: hashBuffer("linden:absent:v1") };
			const next = after[path] ?? { exists: false, hash: hashBuffer("linden:absent:v1") };
			if (before.hash === next.hash && before.mode === next.mode) continue;
			const resource = this.fileAt(path) ?? this.materializeFile(path, journal.participantId, before, undefined, "write", false);
			const current = this.versionNode(resource, resource.currentVersionId)?.snapshot;
			if (current && current.hash !== before.hash) {
				resource.divergence = { expectedHash: current.hash, actualHash: next.hash, detectedAt: now() };
				continue;
			}
			const id = versionId(resource.id);
			this.appendVersion(resource, id, next, journal.participantId, operation);
			changed.push(resource.id);
		}
		return unique(changed);
	}

	private scan(roots: string[], exclusions: string[] = [], rejectHardlinks = false): Record<string, SnapshotRef> {
		const result: Record<string, SnapshotRef> = {};
		const files = new Map<string, { inodeKey: string; links: number }>();
		const visited = new Set<string>();
		const visit = (path: string, explicit = false) => {
			if (visited.has(path)) return;
			visited.add(path);
			if (exclusions.some((excluded) => path === excluded || isInside(path, excluded))) return;
			if (this.privateRoots.some((root) => isInside(path, root)) || (!explicit && this.ignoredNames.has(basename(path)))) return;
			if (!existsSync(path)) return;
			const stat = lstatSync(path, { bigint: true });
			if (stat.isSymbolicLink()) return;
			if (stat.isFile()) { files.set(path, { inodeKey: `${stat.dev}:${stat.ino}`, links: Number(stat.nlink) }); return; }
			if (!stat.isDirectory()) return;
			for (const name of readdirSync(path)) visit(join(path, name));
		};
		for (const root of unique(roots)) visit(root, true);
		// Cache directories are omitted from discovery, but never hide an already
		// registered File that falls within this operation's authority.
		for (const resource of Object.values(this.state.resources)) {
			if (resource.kind === "file" && roots.some((root) => resource.path === root || isInside(resource.path, root))) {
				visited.delete(resource.path);
				visit(resource.path, true);
			}
		}
		if (rejectHardlinks) {
			const groups = new Map<string, { links: number; paths: string[] }>();
			for (const [path, file] of files) {
				if (file.links <= 1) continue;
				const group = groups.get(file.inodeKey) ?? { links: file.links, paths: [] };
				group.paths.push(path);
				groups.set(file.inodeKey, group);
			}
			for (const group of groups.values()) {
				if (group.paths.length !== group.links) {
					throw new Error(`HARDLINK_ALIAS_OUTSIDE_WRITE_AUTHORITY: found ${group.paths.length} of ${group.links} aliases for ${group.paths.join(", ")}`);
				}
			}
		}
		for (const path of [...files.keys()].sort()) result[path] = this.store.capture(path, true);
		return result;
	}

	private assertSafePhysicalFile(path: string, input: string): void {
		const physical = lstatSync(path);
		if (!physical.isFile()) throw new Error(`NOT_A_FILE: ${input}`);
		if (physical.nlink > 1) throw new Error(`HARDLINK_UNSUPPORTED: ${input}`);
	}

	private async recover(): Promise<void> {
		await this.resourceWriterGate.run(() => {
			for (const journal of this.store.readJournals()) {
				if (journal.type === "bash") {
					const cleanup = cleanupAbsentWritePlaceholders(journal.placeholders ?? []);
					this.prepareBashJournalPost(journal);
					const term = journal.operation === "term";
					const status = cleanup.violations.length ? "diverged" : "committed";
					let termEpochRecord: TermEpochRecord | undefined;
					if (term) {
						const trace = missingTermTrace("process-recovery");
						termEpochRecord = {
							id: journal.termEpochId!,
							termId: journal.participantId,
							effectId: journal.effectId!,
							startedAt: journal.createdAt,
							endedAt: now(),
							forced: true,
							recovered: true,
							status,
							trace: this.store.captureBuffer(Buffer.from(JSON.stringify(trace)), 0o600),
						};
					}
					this.commitBashJournal(journal, term ? "term" : journal.operation === "save" ? "save" : "recovery", term ? "exec" : journal.operation === "save" ? "save" : "bash", term ? journal.participantId : undefined, status, cleanup.violations.map((violation) => violation.path), term ? journal.participantId : undefined, termEpochRecord);
					this.removeCommittedJournal(journal.id); continue;
				}
				const resource = this.state.resources[journal.resourceId];
				if (!resource || resource.kind !== "file") { this.store.removeJournal(journal.id); continue; }
				const actual = this.store.capture(journal.path, false);
				if (actual.hash === journal.before.hash) { this.store.removeJournal(journal.id); continue; }
				if (actual.hash === journal.after.hash) {
					if (journal.operation === "checkout") {
						resource.currentVersionId = journal.targetStateId!;
						this.updateCompleteState(resource.id, journal.targetStateId!);
					}
					else if (!resource.versions.some((node) => node.id === journal.stateNodeId)) this.appendVersion(resource, journal.stateNodeId, journal.after, journal.participantId, "recovery");
					this.commitEffect(journal.operation, journal.participantId, resource.id, journal.stateNodeId);
					this.persist(); this.store.removeJournal(journal.id); continue;
				}
				resource.divergence = { expectedHash: journal.after.hash, actualHash: actual.hash, detectedAt: now() };
				this.commitEffect(journal.operation, journal.participantId, resource.id, journal.stateNodeId, undefined, "diverged");
				this.persist();
			}
		});
	}

	private spawnGrants(participantId: ParticipantId, explicit: Array<{ resourceId: ResourceId; mode: "move" | "read" }>, inheritRead: boolean, defaultReadRoot?: string): Array<{ resourceId: ResourceId; mode: "move" | "read" }> {
		const byResource = new Map<ResourceId, "move" | "read">();
		if (inheritRead) {
			if (participantId === this.rootParticipantId && canReadPath(this.state, participantId, defaultReadRoot ?? this.base)) {
				const root = resolvePublicPath(defaultReadRoot ?? this.base, this.base, this.base, this.privateRoots);
				let region = Object.values(this.state.resources).find((resource): resource is FileRegionResource => resource.kind === "file-region" && resource.path === root);
				if (!region) {
					const parent = this.locateCoveringPath(participantId, root, "read", this.base, false);
					region = !parent.refined ? this.state.resources[parent.parentResourceId] as FileRegionResource : undefined;
					if (!region) {
						const id = pathResourceId(root);
						region = { id, kind: "file-region", path: root, derivedFrom: parent.parentResourceId, createdAt: now() };
						this.state.contexts = deriveRefinement(this.state, { participantId, parentResourceId: parent.parentResourceId, resourceId: id, path: root, mode: "read", resourceType: "FileRegion" });
						this.state.resources[id] = region;
					}
				}
				byResource.set(region.id, "read");
			} else {
				for (const resource of Object.values(this.state.resources)) {
					if ((resource.kind === "file" || resource.kind === "file-region") && (participantId !== this.rootParticipantId || isInside(resource.path, defaultReadRoot ?? this.base)) && canReadPath(this.state, participantId, resource.path)) {
						byResource.set(resource.id, "read");
					}
				}
			}
		}
		for (const grant of explicit) byResource.set(grant.resourceId, grant.mode);
		return [...byResource].map(([resourceId, mode]) => ({ resourceId, mode }));
	}

	private stageSpawn(
		participantId: ParticipantId,
		childId: ParticipantId,
		explicit: Array<{ resourceId: ResourceId; mode: "move" | "read" }>,
		options: { inheritWorkspaceRead?: boolean; defaultReadRoot?: string; participantKind?: ParticipantKind },
	): { state: AuthorityState; derivation: JudgmentDerivation } {
		const participantKind = options.participantKind ?? "agent";
		if (this.state.participantTombstones[childId]) throw new Error(`PARTICIPANT_ID_RETIRED: ${childId} was destructively archived and cannot be reused`);
		const childDepth = this.agentDepth(participantId) + (participantKind === "agent" ? 1 : 0);
		if (this.maxAgentDepth !== undefined && childDepth > this.maxAgentDepth) {
			throw new Error(`MAX_AGENT_DEPTH_EXCEEDED: spawning from ${participantId} would create Agent depth ${childDepth}, above maxAgentDepth ${this.maxAgentDepth}`);
		}
		const liveState = this.state;
		this.state = structuredClone(liveState);
		try {
			const provisionedGrants = this.spawnGrants(participantId, explicit, options.inheritWorkspaceRead !== false, options.defaultReadRoot);
			const operation: AuthorityOperation = { kind: "spawn", participantId, childId, participantKind, grants: provisionedGrants };
			const derivation = this.require(operation);
			return { state: this.state, derivation };
		} finally {
			this.state = liveState;
		}
	}

	/**
	 * Run one synchronous ledger-only transition against a private state clone.
	 * The caller must already hold the operation's normal serialization gate.
	 * Physical filesystem/PTY transactions use their dedicated journals instead.
	 */
	private persistStaged<T>(transition: () => T, shouldPersist: (result: T) => boolean = () => true): T {
		const liveState = this.state;
		this.state = structuredClone(liveState);
		try {
			const result = transition();
			if (!shouldPersist(result)) {
				this.state = liveState;
				return result;
			}
			this.persist();
			return result;
		} catch (error) {
			this.state = liveState;
			throw error;
		}
	}

	private commitEffect(kind: EffectKind, participantId: ParticipantId, resourceId?: ResourceId, stateId?: string, targetId?: string, status: "committed" | "diverged" = "committed", effectId = `effect:${randomUUID()}`): AuthorityState["effects"][number] {
		this.state.sequence++;
		if (this.state.effects.some((effect) => effect.id === effectId)) throw new Error(`DUPLICATE_EFFECT_ID: ${effectId}`);
		const effect = { id: effectId, sequence: this.state.sequence, kind, participantId, resourceId, stateId, targetId, status, createdAt: now() };
		this.state.effects.push(effect);
		return effect;
	}

	/** Live mailbox projection; Δ remains the sole source of liveness. */
	private liveMessages(participantId: ParticipantId): MessageRecord[] {
		const context = this.state.contexts[participantId];
		if (!context) throw new Error(`Unknown participant ${participantId}`);
		const messages: MessageRecord[] = [];
		for (const value of context.delta.completeValues) {
			if (value.type !== "Message") continue;
			const message = this.state.messages[value.identity];
			if (!message || message.consumedAt || message.targetId !== participantId) throw new Error(`INVALID_RUNTIME_STATE: ${value.identity} is not a live Message of ${participantId}`);
			messages.push(message);
		}
		return messages;
	}

	private finalMessage(participantId: ParticipantId, sourceEntryId: string): MessageRecord | undefined {
		return Object.values(this.state.messages).find((message) => message.senderId === participantId && message.origin === "assistant_final" && message.sourceEntryId === sourceEntryId);
	}

	private payloadMutex(participantId: ParticipantId): AsyncMutex {
		let mutex = this.payloadMutexes.get(participantId);
		if (!mutex) {
			mutex = new AsyncMutex();
			this.payloadMutexes.set(participantId, mutex);
		}
		return mutex;
	}

	private latestAgentState(participantId: ParticipantId): AgentStateNode | undefined {
		const current = this.state.agentStates[this.state.currentAgentStateIds[participantId]];
		return current;
	}

	private snapshotForActiveRead(path: string): { snapshot: SnapshotRef; ledgerSequence: number } | undefined {
		for (const view of this.activeReadViews.values()) {
			const writable = view.roots.some((root) => isInside(path, root)) && !view.exclusions.some((excluded) => isInside(path, excluded));
			const shadowed = view.shadowPaths.includes(path);
			if (!writable && !shadowed) continue;
			const snapshot = view.before[path] ?? { exists: false, hash: hashBuffer("linden:absent:v1") };
			return { snapshot, ledgerSequence: view.ledgerSequence };
		}
		return undefined;
	}

	private assertNoOpenTermEpoch(participantId: ParticipantId, action: string): void {
		const epoch = this.activeTermEpochs.get(participantId);
		if (epoch) throw new Error(`TERM_EPOCH_AUTHORITY_FROZEN: cannot ${action} while ${participantId} epoch ${epoch.epochId} is open`);
	}

	private assertNoTermWriteOverlap(paths: readonly string[], action: string, exceptTerm?: ParticipantId): void {
		for (const epoch of this.activeTermEpochs.values()) {
			if (epoch.termId === exceptTerm) continue;
			const overlap = paths.find((path) => epoch.authority.writePaths.some((root) => isInside(path, root) || isInside(root, path)));
			if (overlap) throw new Error(`TERM_EPOCH_WRITE_CONFLICT: cannot ${action}; ${overlap} overlaps open epoch ${epoch.epochId} of ${epoch.termId}`);
		}
	}

	private versionNode(resource: FileResource, stateId: VersionId): VersionNode | undefined {
		const latest = resource.versions[resource.versions.length - 1];
		return latest?.id === stateId ? latest : resource.versions.find((node) => node.id === stateId);
	}

	private fileAt(path: string): FileResource | undefined {
		const resource = this.state.resources[fileResourceId(path, false)];
		return resource?.kind === "file" && resource.path === path ? resource : undefined;
	}

	private fileBoundaryAtOrAbove(path: string): FileResource | undefined {
		return Object.values(this.state.resources)
			.filter((resource): resource is FileResource => resource.kind === "file" && isInside(path, resource.path))
			.sort((left, right) => right.path.length - left.path.length)[0];
	}

	private persist(): void {
		assertWellFormedContexts(this.state);
		this.store.save(this.state);
	}
}

export interface FileReadResult {
	path: string;
	state: "Absent" | "Present";
	content: string;
	resourceId?: ResourceId;
	stale: boolean;
	ledgerSequence: number;
}

export interface FileEdit {
	oldText: string;
	newText: string;
}

export interface PathRefinementResult {
	resourceId: ResourceId;
	path: string;
	kind: "file-region" | "file";
	mode: "read" | "write";
}

export interface FileStatusResult {
	resourceId?: ResourceId;
	path: string;
	state: "Absent" | "Present";
	size?: number;
	stale: boolean;
	ledgerSequence: number;
}

interface ActiveReadView {
	participantId: ParticipantId;
	ledgerSequence: number;
	roots: string[];
	exclusions: string[];
	shadowPaths: string[];
	before: Record<string, SnapshotRef>;
}
