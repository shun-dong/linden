import { canReadPath, canWritePath } from "../compiler/judgment.js";
import { authoritySummary, managedParticipants } from "../runtime/authority-display.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	CURRENT_SESSION_VERSION,
	SessionManager,
	type AgentSession,
	type AgentSessionRuntime,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionAuthorityManager, type AuthorityTransferReceipt, type CheckpointEnvelope } from "../runtime/manager.js";
import { formatMaxAgentDepth, normalizeMaxAgentDepth } from "../runtime/agent-depth.js";
import type { AgentStateNode, MessageKind, MessageRecord, ParticipantId, ResourceId, VersionId } from "../runtime/model.js";
import { netReference } from "../runtime/net.js";
import { canonicalBase, fileResourceId, isInside, resolveFileResourceReference, type PathExpression } from "../runtime/paths.js";
import { SessionLease, SessionRegistry } from "../runtime/sessions.js";
import { stateDirectory } from "../runtime/store.js";
import { formatParticipants } from "./participants.js";
import { sequentialTransfers, type BatchTransferResult, type GiveResult, type GetPermissionResult } from "./transfers.js";
import {
	PersistentTerm,
	type TermEpochEndInfo,
	type TermEpochEndOutcome,
	type TermEpochPreparedInfo,
	type TermEpochStartInfo,
} from "../runtime/term.js";
import type {
	ListenParticipantOptions,
	ParticipantCoordinatorApi,
	ParticipantSpawnAttempt,
	ParticipantWaitResult,
	SpawnParticipantOptions,
	ParticipantWaitTarget,
} from "./participant-api.js";

export const PAYLOAD_ENTRY = "linden-mail-payload";
export const CHECKPOINT_ENTRY = "linden-typed-checkpoint";
export const RUNTIME_NOTICE = "linden-runtime-notice";
export const MAIL_BATCH = "linden-mail-batch";

export const RUNTIME_GUIDANCE = [
	"Linden collaboration semantics:",
	"- Human, Agent, and Term share one workspace authority ledger and typed participant tree. Each Agent has its own Pi session. IDs and resource names are strings, not capabilities.",
	"- spawn creates a direct Agent or Term child. Its root defaults to your root (Human uses CLI cwd), rootDir overrides it, and it inherits your effective File reads unless inheritRead=false. Explicit grants use typed file: or net: references; & gives a use projection, plain gives complete ownership. Net is never automatically inherited.",
	"- root directories are positions, not permission boundaries. File authority may cover multiple external roots. Agent Bash defaults to its own root; a Term preserves cwd and exported environment. Unreadable cwd is an empty sandbox skeleton with no implicit host access.",
	"- maxAgentDepth counts only Agent edges below Human. Term participants do not consume Agent depth; Term creation remains available at the Agent depth limit.",
	"- running means own foreground active; ready means own foreground inactive but background/descendants may remain; stopped is the fully quiescent ready substate.",
	"- listen, wait, interrupt, and stop target strict descendants of any kind. listen observes without consuming mail; wait observes ready/stopped. interrupt affects one foreground; stop quiesces a subtree and its background work. log accepts your own Agent or a strict descendant Agent/Term.",
	"- exec starts a command in a ready/stopped descendant Term. input targets a running descendant Term's stdin. listen returns bounded live output; log shows durable completed/recovered epoch traces without starting a process.",
	"- participants and birth snapshots introduce ordinary read-only participant pointers. send can reach discovered Human/Agent peers across branches; strings carry information only. Refresh participants after a missing-pointer or unknown-target error.",
	"- receive explicitly FIFO-consumes pending mail, optionally filtered by an ordinary sender pointer. Agent finals become follow-ups to their direct parent; Human retains unread mail.",
	"- runtime messages, follow-ups, and steering all interrupt wait. Runtime notices add context without waking a stopped Agent or blocking tools. Follow-ups and steering can wake stopped live Agents; steering also holds tools that have not begun. Started tools finish.",
	"- typed File refinement is automatic in give/get/spawn; there are no public file/subpath tools. Trailing / denotes a File region. Native Pi read keeps text/image behavior and missing-file errors; stat and the underlying typed read represent Absent/Present.",
	"- Net is exact TCP IP/DNS+port or the predefined public endpoint set. Complete Net can connect, publish/unpublish, refine, and transfer. &Net can only connect and cannot be forwarded, inherited, refined or used to manage services. TCP is bidirectional. DNS/IP identities differ and each DNS connection is checked and audited; public/DNS grants reject private targets, explicit private IP is supported.",
	"- give operates only over a direct parent-child edge and records runtime permission notices atomically. get from your direct child reclaims complete ownership. get from your direct parent only requests: manual approval requires parent give, or parent permission all-of-mine automatically grants only its currently legal rights. No sibling reclaim or upward auto-request occurs.",
	"- An Agent's active tool finishes before child authority is reclaimed; later tools wait until commit, then its loop proceeds naturally. An open Term epoch is never stopped implicitly for transfer: explicitly stop it first if authority must move.",
	"- publish requires your complete exact Net and control of a live descendant Term. It bridges the internal TCP port through a workspace Unix socket broker, not an arbitrary host bind. Unpublish closes the bridge/connections while leaving the service alive; published Net cannot move until unpublished.",
	"- archive retains a stopped direct-child subtree while reclaiming its rights. unarchive atomically restores all original permissions or fails and leaves participants stopped. Unchanged File restoration adds no notice; changed Files and all restored Net need notices. Old unread tasks remain explicitly receivable and do not automatically replay.",
	"- fork copies one live/retained direct-child Agent branch into a fresh Agent with no resource rights, children, policy, processes, old typed checkpoints or pending work; a fork notice explains current authority.",
	"- branch creates and switches to a named history branch of a direct-child Agent (state omitted means current context); switch selects an existing branch; rewind moves the current branch to a typed Pi checkpoint. New checkpoints and navigation notices advance only the current branch. History navigation does not undo File/network/message/process effects, and records a context notice without starting a model turn. Participant targets accept full IDs; live Agent targets also accept a unique Pi-session suffix.",
].join("\n");

export const COMPACT_FIXED_TEAM_RUNTIME_GUIDANCE = [
	"Linden fixed-team collaboration semantics:",
	"- The model-Agent roster is fixed. The birth snapshot already grants read-only pointers to every listed participant, so send directly to listed Human/Agent peers; call participants only after a missing-pointer error or after creating a Term.",
	"- Additional Agent spawning is disabled. Term spawning remains available: a Term is a persistent sandboxed terminal participant whose exec/input/listen/log operations preserve cwd and exported environment between command epochs.",
	"- send carries information only and grants no authority; receive FIFO-consumes pending mail. A completed Agent final is also published to its parent.",
	"- File authority is separate from participant pointers. read/stat require readable authority. give/get/spawn accept typed file:<address> and net:tcp/... references; Linden automatically refines directory authority for exact child paths. A plain reference moves ownership and & grants a use projection (File read, Net connect). Ownership transfers only across a direct tree edge.",
	"- Use only Linden gateways for files, Bash, messages, transfers, checkout, and participants. IDs are strings, not capabilities, and never bypass ownership, pointers, kind, lifecycle, or hierarchy checks.",
	"- wait observes ready/stopped states; ordinary mail can wake a waiting Agent. interrupt affects one foreground, while stop recursively stops a subtree. archive retains a stopped direct-child subtree for atomic unarchive or history-only fork.",
].join("\n");

export type RuntimeGuidanceProfile = "full" | "compact-fixed-team";

export function needsParticipantTreeBirthSnapshot(entries: readonly SessionEntry[]): boolean {
	return !entries.some((entry) => entry.type === "message" && (entry.message as any)?.role === "assistant");
}

export function runtimeGuidanceForParticipant(agentSpawnEnabled: boolean, profile: RuntimeGuidanceProfile = "full"): string {
	if (profile === "compact-fixed-team") return COMPACT_FIXED_TEAM_RUNTIME_GUIDANCE;
	if (agentSpawnEnabled) return RUNTIME_GUIDANCE;
	return `${RUNTIME_GUIDANCE}\n- For this participant, additional Agent spawning is disabled; spawn accepts only Term.`;
}

export interface MailPayload {
	messageId: string;
	senderId: ParticipantId;
	payload: string;
}

export interface DeliveredMail {
	id: string;
	senderId: ParticipantId;
	payload: string;
}

export interface MailBatch {
	batchId: string;
	kind: MessageKind;
	messages: DeliveredMail[];
}

export interface RuntimeNoticeOptions {
	continueLoop?: boolean;
	kind?: "rewind" | "authority-change" | "restore" | "fork";
	eventId?: string;
}

export interface ParticipantRuntime {
	readonly participantId: ParticipantId;
	readonly piSessionId?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	isRunning(): boolean;
	abort(): Promise<void>;
	summary(): string;
	displayName?(): string | undefined;
	/** Agent/Pi capabilities. */
	entries?(): SessionEntry[];
	leafId?(): string | null;
	setLabel?(entryId: string, label: string): void;
	navigate?(entryId: string): Promise<void>;
	appendRuntimeNotice?(text: string, options?: RuntimeNoticeOptions): Promise<string>;
	/** Human/Agent durable-message capabilities; Term deliberately has none. */
	appendEntry?<T>(customType: string, data: T): Promise<string>;
	readPayload?(entryId: string): MailPayload | undefined;
	deliverBatch?(batch: MailBatch): Promise<void>;
	/** Persist future mailbox delivery without starting another model turn. */
	suspendMailboxWake?(): void;
	dispose?(): void | Promise<void>;
}

type MessageParticipantRuntime = ParticipantRuntime & Required<Pick<ParticipantRuntime, "appendEntry" | "readPayload" | "deliverBatch">>;
type AgentParticipantRuntime = MessageParticipantRuntime & Required<Pick<ParticipantRuntime, "entries" | "leafId" | "setLabel">>;

export interface SpawnWarning {
	code: "LINDEN_POST_COMMIT_CHECKPOINT_FAILED" | "LINDEN_POST_COMMIT_ADAPTER_FAILED" | "LINDEN_INITIAL_PROMPT_REJECTED" | "LINDEN_INITIAL_PROMPT_FAILED";
	message: string;
	detail?: string;
}

export interface SpawnOutcome {
	participantId: ParticipantId;
	promptRequested: boolean;
	promptAccepted?: boolean;
	/** True only while a preflight-accepted model turn is still in flight. */
	turnPending: boolean;
	/** False while checkpoint or prompt preflight can still add a spawn warning. */
	warningsComplete: boolean;
	warnings: SpawnWarning[];
}

function customEntry(entry: SessionEntry | undefined): MailPayload | undefined {
	if (entry?.type !== "custom" || entry.customType !== PAYLOAD_ENTRY) return undefined;
	const data = entry.data as Partial<MailPayload>;
	return typeof data.messageId === "string" && typeof data.senderId === "string" && typeof data.payload === "string" ? data as MailPayload : undefined;
}

function batchMessage(batch: MailBatch) {
	const heading = batch.kind === "steering"
		? "[Linden steering] An ancestor interrupted the remaining not-yet-started tools from the previous assistant response."
		: "[Linden follow-up batch] These ordinary messages waited until you were ready and were delivered together.";
	const items = batch.messages.map((message, index) => `[${index + 1}] from=${message.senderId} id=${message.id}\n${message.payload}`);
	return {
		customType: MAIL_BATCH,
		content: `${heading}\n\n${items.join("\n\n")}\n\nThis batch is already consumed; do not call receive for it.`,
		display: true,
		details: { kind: MAIL_BATCH, batchId: batch.batchId, messageKind: batch.kind, messageIds: batch.messages.map((message) => message.id) },
	};
}

function batchDetails(message: any): { batchId: string; messageKind: MessageKind; messageIds: string[] } | undefined {
	if (message?.role !== "custom" || message.customType !== MAIL_BATCH || message.details?.kind !== MAIL_BATCH) return undefined;
	const details = message.details;
	if (typeof details.batchId !== "string" || (details.messageKind !== "follow_up" && details.messageKind !== "steering") || !Array.isArray(details.messageIds)) return undefined;
	return { batchId: details.batchId, messageKind: details.messageKind, messageIds: details.messageIds.filter((id: unknown): id is string => typeof id === "string") };
}

function isDeliveryReservationBusy(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("MESSAGE_OUT_OF_ORDER:");
}

function entryText(entry: SessionEntry | undefined): string {
	if (!entry) return "empty session";
	if (entry.type === "custom") return `custom:${entry.customType}`;
	if (entry.type !== "message") return entry.type;
	const message = entry.message as any;
	const content = Array.isArray(message?.content) ? message.content.map((part: any) => typeof part === "string" ? part : part?.text ?? "").join(" ") : String(message?.content ?? "");
	return `${String(message?.role ?? "message")}: ${content.replace(/\s+/g, " ").slice(0, 160)}`;
}

interface AssistantFinal {
	entryId: string;
	payload: string;
}

function assistantFinal(entries: SessionEntry[]): AssistantFinal | undefined {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message as any;
		if (message?.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "length")) continue;
		const payload = (Array.isArray(message.content) ? message.content : []).filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
		if (payload) return { entryId: entry.id, payload };
	}
	return undefined;
}
export class RootParticipantRuntime implements ParticipantRuntime {
	constructor(readonly participantId: ParticipantId, private readonly pi: ExtensionAPI, private context: ExtensionContext, private wakeAgent = true) {}

	setContext(context: ExtensionContext): void { this.context = context; }
	get piSessionId(): string { return this.context.sessionManager.getSessionId(); }
	get sessionFile(): string | undefined { return this.context.sessionManager.getSessionFile(); }
	get cwd(): string { return this.context.sessionManager.getCwd(); }
	entries(): SessionEntry[] { return this.context.sessionManager.getEntries(); }
	leafId(): string | null { return this.context.sessionManager.getLeafId(); }
	isRunning(): boolean { return !this.context.isIdle(); }

	async abort(): Promise<void> {
		this.context.abort();
		const deadline = Date.now() + 10_000;
		while (!this.context.isIdle()) {
			if (Date.now() >= deadline) throw new Error(`Timed out stopping ${this.participantId}`);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		}
	}

	async appendEntry<T>(customType: string, data: T): Promise<string> {
		const before = new Set(this.entries().map((entry) => entry.id));
		this.pi.appendEntry(customType, data);
		const entry = [...this.entries()].reverse().find((candidate) => !before.has(candidate.id) && candidate.type === "custom" && candidate.customType === customType);
		if (!entry) throw new Error(`Pi did not expose appended ${customType} entry`);
		return entry.id;
	}

	setLabel(entryId: string, label: string): void { this.pi.setLabel(entryId, label); }
	readPayload(entryId: string): MailPayload | undefined { return customEntry(this.context.sessionManager.getEntry(entryId)); }

	async deliverBatch(batch: MailBatch): Promise<void> {
		if (!this.wakeAgent) this.pi.sendMessage(batchMessage(batch), { triggerTurn: false });
		else if (this.context.isIdle()) this.pi.sendMessage(batchMessage(batch), { triggerTurn: true });
		else this.pi.sendMessage(batchMessage(batch), { triggerTurn: true, deliverAs: batch.kind === "steering" ? "steer" : "followUp" });
	}
	suspendMailboxWake(): void { this.wakeAgent = false; }

	async appendRuntimeNotice(text: string, options: RuntimeNoticeOptions = {}): Promise<string> {
		const message = { customType: RUNTIME_NOTICE, content: text, display: true, details: { kind: options.kind ?? "rewind", eventId: options.eventId } };
		if (!options.continueLoop) this.pi.sendMessage(message, { triggerTurn: false });
		else if (this.context.isIdle()) this.pi.sendMessage(message, { triggerTurn: true });
		else this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		const leaf = this.leafId(); if (!leaf) throw new Error("Pi did not persist the runtime notice"); return leaf;
	}

	summary(): string { return `${this.participantId} pi-leaf=${this.leafId() ?? "none"} ${entryText(this.context.sessionManager.getLeafEntry())}`; }
	displayName(): string | undefined { return this.context.sessionManager.getSessionName(); }
}

export class HumanParticipantRuntime implements ParticipantRuntime {
	constructor(readonly participantId: ParticipantId, private readonly authority: SessionAuthorityManager) {}
	get cwd(): string { return this.authority.base; }
	isRunning(): boolean { return false; }
	async abort(): Promise<void> {}
	async appendEntry<T>(customType: string, data: T): Promise<string> {
		const messageId = typeof data === "object" && data !== null && "messageId" in data ? String((data as { messageId: unknown }).messageId) : randomId();
		return this.authority.store.writePrivatePayload(`${customType}:${messageId}`, data);
	}
	readPayload(entryId: string): MailPayload | undefined {
		const data = this.authority.store.readPrivatePayload<Partial<MailPayload>>(entryId);
		return data && typeof data.messageId === "string" && typeof data.senderId === "string" && typeof data.payload === "string"
			? data as MailPayload
			: undefined;
	}
	async deliverBatch(): Promise<void> {}
	summary(): string { return `${this.participantId} human-control-plane`; }
	displayName(): string | undefined { return this.authority.participant(this.participantId)?.name; }
}

export class TermParticipantRuntime implements ParticipantRuntime {
	constructor(readonly participantId: ParticipantId, readonly term: PersistentTerm, private readonly name?: string) {}
	isRunning(): boolean { return this.term.lifecycle().lifecycle === "running"; }
	async abort(): Promise<void> {
		if (this.term.lifecycle().lifecycle === "running") await this.term.interrupt();
	}
	summary(): string {
		const state = this.term.lifecycle();
		return `${this.participantId} term=${state.lifecycle} epoch=${state.epochId ?? "none"} foreground=${state.foreground?.id ?? "none"} background=${state.backgroundPids.join(",") || "none"} error=${state.error ?? "none"}`;
	}
	displayName(): string | undefined { return this.name; }
	dispose(): Promise<void> { return this.term.dispose(); }
}

export class ChildParticipantRuntime implements ParticipantRuntime {
	private wakeAgent = true;
	constructor(readonly participantId: ParticipantId, readonly session: AgentSession) {}
	get piSessionId(): string { return this.session.sessionId; }
	get sessionFile(): string | undefined { return this.session.sessionFile; }
	get cwd(): string { return this.session.sessionManager.getCwd(); }
	entries(): SessionEntry[] { return this.session.sessionManager.getEntries(); }
	leafId(): string | null { return this.session.sessionManager.getLeafId(); }
	isRunning(): boolean { return this.session.isStreaming; }

	async abort(): Promise<void> { await this.session.abort(); }

	async appendEntry<T>(customType: string, data: T): Promise<string> { return this.session.sessionManager.appendCustomEntry(customType, data); }
	setLabel(entryId: string, label: string): void { this.session.sessionManager.appendLabelChange(entryId, label); }
	readPayload(entryId: string): MailPayload | undefined { return customEntry(this.session.sessionManager.getEntry(entryId)); }

	async deliverBatch(batch: MailBatch): Promise<void> {
		const options = !this.wakeAgent
			? { triggerTurn: false }
			: this.session.isStreaming ? { triggerTurn: true, deliverAs: batch.kind === "steering" ? "steer" as const : "followUp" as const } : { triggerTurn: true };
		await this.session.sendCustomMessage(batchMessage(batch), options);
	}

	suspendMailboxWake(): void {
		this.wakeAgent = false;
		this.session.clearQueue?.();
	}

	summary(): string { return `${this.participantId} foreground=${this.session.isStreaming ? "running" : "ready"} pi-leaf=${this.leafId() ?? "none"} ${entryText(this.session.sessionManager.getLeafEntry())}`; }
	displayName(): string | undefined { return this.session.sessionName; }

	async navigate(entryId: string): Promise<void> {
		if (this.session.isStreaming) throw new Error(`PI_NAVIGATION_WHILE_RUNNING: ${this.participantId} must be quiescent before context navigation`);
		const manager = this.session.sessionManager;
		const entry = manager.getEntry(entryId);
		if (entry?.type === "custom_message" || (entry?.type === "message" && entry.message.role === "user")) {
			const oldLeaf = manager.getLeafId();
			manager.branch(entryId);
			entryId = manager.appendCustomEntry("linden:context-anchor", {});
			if (oldLeaf) manager.branch(oldLeaf);
		}
		const result = await this.session.navigateTree(entryId, { summarize: false });
		if (result.cancelled) throw new Error(`Pi cancelled navigation to ${entryId}`);
	}

	async appendRuntimeNotice(text: string, options: RuntimeNoticeOptions = {}): Promise<string> {
		const message = { customType: RUNTIME_NOTICE, content: text, display: true, details: { kind: options.kind ?? "rewind", eventId: options.eventId } };
		if (!options.continueLoop) {
			await this.session.sendCustomMessage(message, { triggerTurn: false });
		} else {
			const delivery = this.session.isStreaming
				? { triggerTurn: true, deliverAs: "steer" as const }
				: { triggerTurn: true };
			await this.session.sendCustomMessage(message, delivery);
		}
		const leaf = this.leafId();
		if (!leaf) throw new Error("Pi did not persist the runtime notice");
		return leaf;
	}

	dispose(): void { this.session.dispose(); }
}

export class HostedParticipantRuntime extends ChildParticipantRuntime {
	constructor(participantId: ParticipantId, readonly runtimeHost: AgentSessionRuntime) {
		super(participantId, runtimeHost.session);
	}
	override async dispose(): Promise<void> {
		// A plain Pi abort can still drain queued follow-ups by starting another
		// model turn. Shutdown must discard that queued work before waiting for the
		// active turn to settle, otherwise a benchmark deadline can be extended by
		// post-deadline Agent activity. Clear again after settlement to close the
		// narrow race with a delivery that was already in flight when disposal began.
		this.session.clearQueue?.();
		await this.session.abort?.();
		this.session.clearQueue?.();
		await this.runtimeHost.dispose();
	}
}

export type ToolFactory = (coordinator: PiCoordinator, participantId: ParticipantId, cwd: string) => ToolDefinition[];
export type HostedRuntimeFactory = (participantId: ParticipantId, sessionManager: SessionManager) => Promise<AgentSessionRuntime>;
export type HumanMessageHandler = (message: MessageRecord, payload: string) => void;
/** Returns true when the human host observed the final live and it was consumed in place. */
export type HumanFinalConsumer = (message: MessageRecord, payload: string) => Promise<boolean>;

const WAIT_INTERRUPTED_BY_MESSAGE = Symbol("WAIT_INTERRUPTED_BY_MESSAGE");
const WAIT_INTERRUPTED_BY_DISPOSE = Symbol("WAIT_INTERRUPTED_BY_DISPOSE");

interface ActiveParticipantWait {
	controller: AbortController;
	messageIds: Set<string>;
	externalSignal?: AbortSignal;
	externalAbort?: () => void;
}

export class PiCoordinator implements ParticipantCoordinatorApi {
	readonly runtimes = new Map<ParticipantId, ParticipantRuntime>();
	private toolFactory?: ToolFactory;
	private hostedRuntimeFactory?: HostedRuntimeFactory;
	private humanMessageHandler?: HumanMessageHandler;
	private humanFinalConsumer?: HumanFinalConsumer;
	private root?: RootParticipantRuntime;
	private humanRoot?: HumanParticipantRuntime;
	private readonly followUpTimers = new Map<ParticipantId, ReturnType<typeof setTimeout>>();
	private readonly followUpsWaitingForIdle = new Set<ParticipantId>();
	private readonly mailboxWakeSuspended = new Set<ParticipantId>();
	private readonly steeringRetryTimers = new Map<ParticipantId, ReturnType<typeof setTimeout>>();
	private readonly steeringRetryDelays = new Map<ParticipantId, number>();
	private readonly steeringBlocks = new Map<ParticipantId, Set<string>>();
	private readonly restoredSessionFiles = new Map<string, ParticipantId>();
	private readonly participantRestores = new Map<ParticipantId, Promise<ParticipantId>>();
	private runtimeEventFlush?: Promise<void>;
	private readonly termRuntimeCreates = new Map<ParticipantId, Promise<TermParticipantRuntime>>();
	private topologyTail: Promise<void> = Promise.resolve();
	private readonly activeTools = new Map<ParticipantId, number>();
	private readonly authorityTransferBlocks = new Map<ParticipantId, number>();
	/**
	 * A context navigation is a foreground barrier, not an interrupt. The tool
	 * already in flight may finish and commit its real effects, while every
	 * later tool and mailbox activation is held until the old loop is quiescent,
	 * Pi has navigated, and the reconciliation notice has been appended.
	 */
	private readonly contextNavigationBlocks = new Set<ParticipantId>();
	private readonly mailboxActivationDeferredByNavigation = new Set<ParticipantId>();
	private readonly activeParticipantWaits = new Map<ParticipantId, Set<ActiveParticipantWait>>();
	private readonly agentSpawnDisabled = new Set<ParticipantId>();
	private readonly participantSpawnAttempts: ParticipantSpawnAttempt[] = [];
	private readonly termListenCursors = new Map<string, number>();
	private termLoopbackPorts: number[] = [];
	private readonly agentLoops = new Set<ParticipantId>();
	private readonly participantBackendWork = new Map<ParticipantId, number>();
	private readonly stopRequests = new Map<ParticipantId, ParticipantId>();
	private readonly controlKinds = new Map<ParticipantId, "interrupt" | "stop">();
	private readonly stopFinishing = new Set<ParticipantId>();
	private readonly stopping = new Set<ParticipantId>();
	private readonly spawnOutcomes = new Map<ParticipantId, SpawnOutcome>();
	private readonly runtimeDiagnostics = new Map<ParticipantId, SpawnWarning[]>();
	private activeLifecycleOperations = 0;
	private readonly lifecycleDrainWaiters = new Set<() => void>();
	private readonly backgroundOperations = new Set<Promise<unknown>>();
	private readonly runtimeDisposals = new Map<ParticipantRuntime, Promise<void>>();
	private lifecycleRefreshTail: Promise<void> = Promise.resolve();
	private disposed = false;
	private disposePromise?: Promise<void>;
	private sessionLease?: SessionLease;

	private constructor(readonly pi: ExtensionAPI | undefined, readonly authority: SessionAuthorityManager, private context?: ExtensionContext) {}

	static async create(pi: ExtensionAPI, context: ExtensionContext, permissionInputs: string[], registry = new SessionRegistry(), maxAgentDepthInput?: number): Promise<PiCoordinator> {
		const piSessionId = context.sessionManager.getSessionId();
		const lindenSessionId = `session:${piSessionId}`;
		const requestedMaxAgentDepth = normalizeMaxAgentDepth(maxAgentDepthInput);
		let manifest;
		try { manifest = registry.resolve(lindenSessionId); }
		catch { manifest = registry.create(context.cwd, lindenSessionId, { maxAgentDepth: requestedMaxAgentDepth, permissions: permissionInputs }); }
		if (requestedMaxAgentDepth !== undefined && manifest.maxAgentDepth !== requestedMaxAgentDepth) {
			throw new Error(`Linden session maxAgentDepth is ${manifest.maxAgentDepth ?? "unlimited"}, not ${requestedMaxAgentDepth}`);
		}
		if (manifest.base !== canonicalBase(context.cwd)) throw new Error(`Pi session ${piSessionId} belongs to Linden base ${manifest.base}`);
		const lease = registry.acquire(manifest);
		let coordinator: PiCoordinator | undefined;
		try {
			manifest = registry.touch(manifest);
			const authority = await SessionAuthorityManager.open({ base: manifest.base, lindenSessionId, sessionId: piSessionId, sessionName: context.sessionManager.getSessionName(), sessionFile: context.sessionManager.getSessionFile(), permissions: manifest.permissions, maxAgentDepth: manifest.maxAgentDepth, stateRoot: registry.root, stateDir: stateDirectory(lindenSessionId, registry.root) });
			await authority.unarchiveWorkspace();
			coordinator = new PiCoordinator(pi, authority, context);
			coordinator.sessionLease = lease;
			coordinator.root = new RootParticipantRuntime(authority.sessionParticipantId, pi, context, true);
			coordinator.humanRoot = new HumanParticipantRuntime(authority.rootParticipantId, authority);
			coordinator.runtimes.set(authority.rootParticipantId, coordinator.humanRoot);
			coordinator.runtimes.set(authority.sessionParticipantId, coordinator.root);
			coordinator.humanMessageHandler = (_message, payload) => context.ui.notify(`[Linden unread] ${summarizeMessage(payload)}`, "info");
			return coordinator;
		} catch (error) {
			try {
				if (coordinator) await coordinator.dispose();
				else lease.release();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Pi coordinator initialization failed and cleanup did not complete", { cause: error });
			}
			throw error;
		}
	}

	static createStandalone(authority: SessionAuthorityManager): PiCoordinator {
		const coordinator = new PiCoordinator(undefined, authority);
		coordinator.humanRoot = new HumanParticipantRuntime(authority.rootParticipantId, authority);
		coordinator.runtimes.set(authority.rootParticipantId, coordinator.humanRoot);
		return coordinator;
	}

	setToolFactory(factory: ToolFactory): void { this.toolFactory = factory; }
	setHostedRuntimeFactory(factory: HostedRuntimeFactory): void { this.hostedRuntimeFactory = factory; }
	setHumanMessageHandler(handler: HumanMessageHandler): void { this.humanMessageHandler = handler; }
	setHumanFinalConsumer(consumer: HumanFinalConsumer | undefined): void { this.humanFinalConsumer = consumer; }
	setTermLoopbackPorts(ports: readonly number[]): void {
		if (ports.length && this.authority.snapshot().explicitAuthority) throw new Error("Use an exact Net grant and publish; implicit host loopback ports are unsupported");
		if (new Set(ports).size !== ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Term loopback ports must be unique integers in 1..65535");
		this.termLoopbackPorts = [...ports];
	}

	/**
	 * Reattach live Pi runtimes for persisted participants. activeIds limits the
	 * restore to the set saved by the previous Linden process in its process
	 * state; without it every restorable Agent is restored.
	 */
	restoreChildren(activeIds?: Iterable<ParticipantId>): Promise<void> {
		return this.runLifecycleOperation(() => this.restoreChildrenNow(activeIds));
	}

	private async restoreChildrenNow(activeIds?: Iterable<ParticipantId>): Promise<void> {
		const active = activeIds ? new Set(activeIds) : undefined;
		for (const participant of this.authority.listParticipants()) {
			if (participant.kind !== "agent" || this.runtimes.has(participant.id) || !participant.sessionFile) continue;
			if (active && !active.has(participant.id)) continue;
			const sessionFile = this.lexicalSessionFile(participant.id, participant.sessionFile);
			if (!existsSync(sessionFile)) continue;
			await this.restoreParticipantById(participant.id, sessionFile);
		}
		for (const participant of this.authority.listParticipants()) {
			if (participant.kind !== "agent") continue;
			if (!this.runtimes.has(participant.id)) continue;
			await this.activateMailbox(participant.id);
		}
	}

	/** Activate the already-mounted top-level Pi session without restoring children. */
	async activateSessionMailbox(): Promise<void> {
		await this.activateMailbox(this.authority.sessionParticipantId);
	}

	/**
	 * Attach one participant's Pi runtime on demand. Mailbox activation is kept
	 * separate so read-only listen/log and control-only stop/rewind do not wake
	 * the Agent merely because its session had to be opened.
	 */
	restoreParticipant(reference: string): Promise<ParticipantId> {
		if (this.disposed) return Promise.reject(new Error("PI_COORDINATOR_DISPOSING: no new runtime operation can start"));
		const targetId = this.resolveParticipantRef(reference);
		if (this.runtimes.has(targetId)) return Promise.resolve(targetId);
		return this.restoreParticipantById(targetId);
	}

	private restoreParticipantById(targetId: ParticipantId, knownSessionFile?: string): Promise<ParticipantId> {
		const inFlight = this.participantRestores.get(targetId);
		if (inFlight) return inFlight;
		if (this.runtimes.has(targetId)) return Promise.resolve(targetId);
		const restore = this.runLifecycleOperation(() => this.restoreParticipantNow(targetId, knownSessionFile));
		this.participantRestores.set(targetId, restore);
		void restore.finally(() => {
			if (this.participantRestores.get(targetId) === restore) this.participantRestores.delete(targetId);
		}).catch(() => undefined);
		return restore;
	}

	private async restoreParticipantNow(targetId: ParticipantId, knownSessionFile?: string): Promise<ParticipantId> {
		const participant = this.authority.participant(targetId);
		if (!participant || participant.kind !== "agent" || !participant.sessionFile) throw new Error(`Participant ${targetId} has no restorable Pi session`);
		const sessionFile = knownSessionFile ?? this.lexicalSessionFile(targetId, participant.sessionFile);
		if (!existsSync(sessionFile)) throw new Error(`Participant ${targetId} has no restorable Pi session`);
		await this.attachRestoredSession(targetId, sessionFile);
		if (!this.authority.participant(targetId)) {
			const restored = this.runtimes.get(targetId);
			this.runtimes.delete(targetId);
			if (restored) await this.disposeRuntimeOnce(restored);
			throw new Error(`Participant ${targetId} was removed while its Pi session was restoring`);
		}
		return targetId;
	}

	private async activateMailbox(targetId: ParticipantId): Promise<void> {
		if (!this.authority.participant(targetId)) return;
		if (this.mailboxWakeSuspended.has(targetId)) {
			await this.deliverPending(targetId, "steering");
			await this.deliverPending(targetId, "follow_up");
			return;
		}
		if (this.contextNavigationBlocks.has(targetId)) {
			this.mailboxActivationDeferredByNavigation.add(targetId);
			const steering = this.authority.pendingMessages(targetId, undefined, "steering");
			if (steering.length) {
				const blocked = this.steeringBlocks.get(targetId) ?? new Set<string>();
				for (const message of steering) blocked.add(message.id);
				this.steeringBlocks.set(targetId, blocked);
			}
			if (this.authority.pendingMessages(targetId, undefined, "follow_up").length) this.followUpsWaitingForIdle.add(targetId);
			return;
		}
		const steering = this.authority.pendingMessages(targetId, undefined, "steering");
		if (steering.length) {
			const blocked = this.steeringBlocks.get(targetId) ?? new Set<string>();
			for (const message of steering) blocked.add(message.id);
			this.steeringBlocks.set(targetId, blocked);
			try { await this.deliverPending(targetId, "steering"); }
			catch (error) { if (!isDeliveryReservationBusy(error)) throw error; }
		}
		this.scheduleFollowUpFlush(targetId);
	}

	private async attachRestoredSession(participantId: ParticipantId, sessionFile: string): Promise<void> {
		if (!this.toolFactory) throw new Error("Pi tool factory is not configured");
		const { manager, canonicalFile } = this.openPersistedSessionManager(participantId, sessionFile);
		const branches = this.authority.agentBranches(participantId);
		const head = branches.heads[branches.current];
		const nearest = this.nearestAgentState(participantId, manager.getLeafId() ?? undefined, manager.getEntries());
		const recoverNavigation = head !== undefined && nearest?.id !== head;
		if (recoverNavigation) manager.branch(this.authority.requireRewind(this.authority.participant(participantId)!.parentId!, participantId, head).piEntryId);
		const existingParticipant = this.restoredSessionFiles.get(canonicalFile);
		if (existingParticipant && existingParticipant !== participantId) throw new Error(`Persisted Pi session ${canonicalFile} is already bound to ${existingParticipant}`);
		this.restoredSessionFiles.set(canonicalFile, participantId);
		let runtime: ChildParticipantRuntime | undefined;
		try {
			runtime = await this.createAgentRuntime(participantId, manager);
			this.subscribeRuntime(runtime);
			await this.publishPreparedRuntime(participantId, runtime, "agent", true);
			if (recoverNavigation) {
				const effect = this.authority.snapshot().effects.filter((item) => item.kind === "rewind" && item.targetId === participantId && item.stateId === head).at(-1);
				if (effect) await this.appendRewindNoticeAfterCommit(participantId, head, manager.getLeafId()!, effect.sequence);
				else await this.appendCheckpoint(participantId, "history-restore");
			}
		} catch (error) {
			if (runtime && this.runtimes.get(participantId) === runtime) this.runtimes.delete(participantId);
			if (this.restoredSessionFiles.get(canonicalFile) === participantId) this.restoredSessionFiles.delete(canonicalFile);
			try { if (runtime) await this.disposeRuntimeOnce(runtime); } catch { /* preserve restore failure */ }
			throw error;
		}
	}

	/** Creation only: callers retain the adapter before subscribing and own rollback/publication. */
	private async createAgentRuntime(participantId: ParticipantId, sessionManager: SessionManager): Promise<ChildParticipantRuntime> {
		if (this.hostedRuntimeFactory) {
			return new HostedParticipantRuntime(participantId, await this.hostedRuntimeFactory(participantId, sessionManager));
		}
		const context = this.context;
		if (!context) throw new Error("No Pi extension context or standalone runtime factory is configured");
		const created = await createAgentSession({
			cwd: sessionManager.getCwd(),
			model: context.model,
			thinkingLevel: context.thinkingLevel,
			scopedModels: [...context.scopedModels],
			sessionManager,
			customTools: this.toolFactory!(this, participantId, sessionManager.getCwd()),
			noTools: "all",
			tools: toolNames(),
		});
		return new ChildParticipantRuntime(participantId, created.session);
	}

	private openPersistedSessionManager(participantId: ParticipantId, sessionFile: string): { manager: SessionManager; canonicalFile: string } {
		const lexicalFile = this.lexicalSessionFile(participantId, sessionFile);
		if (!existsSync(lexicalFile)) throw new Error(`Participant ${participantId} has no restorable Pi session`);
		const physical = lstatSync(lexicalFile);
		if (physical.isSymbolicLink() || !physical.isFile() || physical.nlink !== 1) throw new Error(`Persisted Pi session for ${participantId} is not a private regular file`);
		const sessionRoot = realpathSync.native(resolve(this.authority.stateDir, "pi-sessions"));
		const canonicalFile = realpathSync.native(lexicalFile);
		if (!isInside(canonicalFile, sessionRoot)) throw new Error(`Persisted Pi session for ${participantId} is outside ${sessionRoot}`);
		const manager = SessionManager.open(canonicalFile);
		const expectedSessionId = (this.authority.participant(participantId) ?? this.authority.participantTombstone(participantId))?.piSessionId;
		if (!expectedSessionId || manager.getSessionId() !== expectedSessionId) throw new Error(`Persisted Pi session ID does not match ${participantId}`);
		return { manager, canonicalFile };
	}

	private lexicalSessionFile(participantId: ParticipantId, sessionFile: string): string {
		const sessionRoot = resolve(this.authority.stateDir, "pi-sessions");
		const lexicalFile = resolve(sessionFile);
		if (!isInside(lexicalFile, sessionRoot)) throw new Error(`Persisted Pi session for ${participantId} is outside ${sessionRoot}`);
		return lexicalFile;
	}

	/**
	 * Pi only writes a session file once the first assistant message exists, so a
	 * session that never received a model response could never be restored across
	 * processes ("No runtime adapter is attached"). Pre-write the session header so the
	 * file exists and flushes every entry from the start. Relies on pi 0.84.x
	 * SessionManager.open treating a header-only file as an already-flushed session.
	 */
	private createPersistedSessionManager(directory: string, parentSession: string | undefined, cwd = this.authority.workspace): SessionManager {
		mkdirSync(directory, { recursive: true });
		const sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const sessionFile = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd, parentSession };
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		return SessionManager.open(sessionFile, directory);
	}

	setContext(context: ExtensionContext): void { this.context = context; this.root?.setContext(context); }

	runtime(participantId: ParticipantId): ParticipantRuntime {
		const resolved = this.resolveParticipantRef(participantId);
		const runtime = this.runtimes.get(resolved);
		if (!runtime) throw new Error(`No runtime adapter is attached to ${resolved}`);
		return runtime;
	}

	private messageRuntime(participantId: ParticipantId): MessageParticipantRuntime {
		const runtime = this.runtime(participantId);
		const kind = this.authority.participant(runtime.participantId)?.kind;
		if ((kind !== "human" && kind !== "agent") || !runtime.appendEntry || !runtime.readPayload || !runtime.deliverBatch) {
			throw new Error(`INVALID_RUNTIME_ADAPTER: ${runtime.participantId} does not expose Human/Agent message capabilities`);
		}
		return runtime as MessageParticipantRuntime;
	}

	private agentRuntime(participantId: ParticipantId): AgentParticipantRuntime {
		const runtime = this.messageRuntime(participantId);
		if (this.authority.participant(runtime.participantId)?.kind !== "agent" || !runtime.entries || !runtime.leafId || !runtime.setLabel) {
			throw new Error(`INVALID_RUNTIME_ADAPTER: ${runtime.participantId} does not expose Agent/Pi capabilities`);
		}
		return runtime as AgentParticipantRuntime;
	}

	resolveParticipantRef(reference: string): ParticipantId { return this.authority.resolveParticipantRef(reference); }

	private resolveMessageSenderRef(reference: string): ParticipantId {
		const exact = reference.trim();
		if (this.authority.participantTombstone(exact)) return exact;
		return this.resolveParticipantRef(reference);
	}

	spawn(participantId: ParticipantId, name: string | undefined, prompt: string | undefined, grantInputs: readonly string[], inheritRead = true, humanCwd?: string, childAgentSpawnEnabled = true): Promise<ParticipantId> {
		participantId = this.resolveParticipantRef(participantId);
		if (this.agentSpawnDisabled.has(participantId)) return Promise.reject(new Error(`AGENT_SPAWN_DISABLED: ${participantId} may still spawn Term participants`));
		return this.runLifecycleOperation(() => this.spawnNow(participantId, name, prompt, grantInputs, inheritRead, humanCwd, childAgentSpawnEnabled));
	}

	setAgentSpawnEnabled(participantId: ParticipantId, enabled: boolean): void {
		participantId = this.resolveParticipantRef(participantId);
		const participant = this.authority.participant(participantId);
		if (!participant || participant.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: ${participantId} is not an Agent`);
		if (enabled) this.agentSpawnDisabled.delete(participantId);
		else this.agentSpawnDisabled.add(participantId);
	}

	isAgentSpawnEnabled(participantId: ParticipantId): boolean {
		let resolved = participantId;
		try { resolved = this.resolveParticipantRef(participantId); } catch { /* a child may still be inside its spawn transaction */ }
		return !this.agentSpawnDisabled.has(resolved);
	}

	spawnAttemptSnapshot(): ParticipantSpawnAttempt[] {
		return structuredClone(this.participantSpawnAttempts);
	}

	async spawnParticipant(participantId: ParticipantId, options: SpawnParticipantOptions): Promise<ParticipantId> {
		const origin = options.origin ?? "model";
		const startedAt = new Date().toISOString();
		const attemptId = `spawn-attempt:${randomUUID()}`;
		let callerId = participantId;
		try { callerId = this.resolveParticipantRef(participantId); } catch { /* preserve the rejected reference in telemetry */ }
		try {
			const targetId = options.kind === "agent"
				? await this.spawn(participantId, options.name, options.prompt, options.resources ?? [], options.inheritRead ?? true, options.cwd, options.agentSpawnEnabled ?? true)
				: await this.runLifecycleOperation(() => this.spawnTermNow(participantId, options));
			this.participantSpawnAttempts.push({ id: attemptId, startedAt, finishedAt: new Date().toISOString(), callerId, kind: options.kind, origin, status: "committed", targetId });
			return targetId;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errorCode = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
			this.participantSpawnAttempts.push({ id: attemptId, startedAt, finishedAt: new Date().toISOString(), callerId, kind: options.kind, origin, status: "rejected", ...(errorCode ? { errorCode } : {}), errorMessage: message });
			throw error;
		}
	}

	private async spawnTermNow(participantId: ParticipantId, options: SpawnParticipantOptions): Promise<ParticipantId> {
		if (options.kind !== "term") throw new Error(`Unsupported participant kind ${options.kind}`);
		if (options.prompt?.trim()) throw new Error("Term spawn does not accept an Agent prompt; spawn it first, then use exec");
		const grants: Array<{ resourceId: ResourceId; mode: "move" | "read" }> = [];
		for (const input of options.resources ?? []) {
			const mode = input.startsWith("&") ? "read" : "move";
			grants.push({ resourceId: await this.resolveGrantResource(participantId, mode === "read" ? input.slice(1) : input, mode, options.cwd), mode });
		}
		const childId = `term:${randomUUID()}`;
		const name = options.name?.trim() || childId.slice(-8);
		let runtime: TermParticipantRuntime | undefined;
		await this.authority.spawnWith(participantId, childId, name, grants, async () => {
			runtime = await this.createTermRuntime(childId, name, options.cwd ?? this.authority.participantRoot(participantId));
			return {};
		}, {
			participantKind: "term",
			inheritWorkspaceRead: options.inheritRead ?? true,
			defaultReadRoot: options.cwd,
			rootDir: options.cwd ?? this.authority.participantRoot(participantId),
		});
		if (!runtime) throw new Error(`Term runtime ${childId} was not created`);
		await this.publishPreparedRuntime(childId, runtime, "term", false);
		await this.refreshLifecycleStatuses();
		return childId;
	}

	private async createTermRuntime(participantId: ParticipantId, name: string, cwd: string): Promise<TermParticipantRuntime> {
		const term = new PersistentTerm({
			id: participantId,
			cwd,
			netGuard: this.authority.networkGuard(participantId),
			onNetworkBridge: (bridge) => this.authority.registerNetworkBridge(participantId, bridge),
			privateRoots: this.authority.privateRoots,
			loopbackPorts: this.termLoopbackPorts,
			sharedTmpPath: this.authority.sandboxTmpPath,
			onEpochStart: (info: TermEpochStartInfo) => this.authority.beginTermEpoch({
				termId: participantId,
				epochId: info.epochId,
				startedAt: Date.parse(info.startedAt),
			}),
			onEpochPrepared: (info: TermEpochPreparedInfo) => this.authority.prepareTermEpoch(participantId, info.epochId, info.placeholders),
			onEpochEnd: async (info: TermEpochEndInfo): Promise<TermEpochEndOutcome> => {
				this.authority.forgetTermPublications(participantId);
				try {
					await this.authority.finishTermEpoch({
						termId: participantId,
						epochId: info.epochId,
						startedAt: Date.parse(info.startedAt),
						endedAt: Date.parse(info.endedAt),
						forced: info.forced,
						cleanup: info.cleanup,
						trace: {
							commands: info.commands,
							output: info.output,
							...(info.error === undefined ? {} : { error: info.error }),
						},
					});
					return { committed: true };
				} catch (error) {
					// finishTermEpoch removes the manager epoch only after its ledger
					// transition is durable. A later integrity exception is therefore a
					// committed-but-degraded outcome, while an open epoch is retryable.
					if (!this.authority.hasOpenTermEpoch(participantId)) return { committed: true, error: error as Error };
					throw error;
				}
			},
			onStateChange: () => {
				if (!this.authority.participant(participantId)) return;
				const update = this.refreshLifecycleStatuses().catch(() => undefined);
				this.trackBackgroundOperation(update);
			},
		});
		await term.initialize();
		return new TermParticipantRuntime(participantId, term, name);
	}

	private async ensureTermRuntime(reference: string): Promise<TermParticipantRuntime> {
		const participantId = this.resolveParticipantRef(reference);
		const participant = this.authority.participant(participantId);
		if (!participant || participant.kind !== "term") throw new Error(`PARTICIPANT_KIND_MISMATCH: ${participantId} is not a Term`);
		const current = this.runtimes.get(participantId);
		if (current instanceof TermParticipantRuntime) return current;
		if (current) throw new Error(`Participant ${participantId} has an incompatible runtime adapter`);
		const existing = this.termRuntimeCreates.get(participantId);
		if (existing) return existing;
		const creation = this.runLifecycleOperation(async () => {
			const prepared = await this.createTermRuntime(participantId, participant.name, this.authority.base);
			const published = await this.publishPreparedRuntime(participantId, prepared, "term", true);
			if (!(published instanceof TermParticipantRuntime)) throw new Error(`Participant ${participantId} has an incompatible runtime adapter`);
			return published;
		});
		this.termRuntimeCreates.set(participantId, creation);
		void creation.finally(() => {
			if (this.termRuntimeCreates.get(participantId) === creation) this.termRuntimeCreates.delete(participantId);
		}).catch(() => undefined);
		return creation;
	}

	/** A failed supervisor instance is observable through listen/wait, but a new
	 * exec is an explicit retry and receives a fresh adapter for the same Term. */
	private async ensureTermRuntimeForExec(reference: string): Promise<TermParticipantRuntime> {
		const participantId = this.resolveParticipantRef(reference);
		let runtime = await this.ensureTermRuntime(participantId);
		if (!runtime.term.lifecycle().error) return runtime;
		let retired: TermParticipantRuntime | undefined;
		await this.withTopologyLock(() => {
			if (this.runtimes.get(participantId) === runtime) {
				this.runtimes.delete(participantId);
				retired = runtime;
			}
		});
		if (retired) await this.disposeRuntimeOnce(retired);
		runtime = await this.ensureTermRuntime(participantId);
		return runtime;
	}

	private async spawnNow(participantId: ParticipantId, name: string | undefined, prompt: string | undefined, grantInputs: readonly string[], inheritRead: boolean, humanCwd?: string, childAgentSpawnEnabled = true, preparedSession?: SessionManager): Promise<ParticipantId> {
		if (!this.toolFactory) throw new Error("Pi tool factory is not configured");
		const grants: Array<{ resourceId: ResourceId; mode: "move" | "read" }> = [];
		for (const input of grantInputs) {
			const mode = input.startsWith("&") ? "read" : "move";
			grants.push({ resourceId: await this.resolveGrantResource(participantId, mode === "read" ? input.slice(1) : input, mode, humanCwd), mode });
		}
		const directory = join(this.authority.stateDir, "pi-sessions");
		const parentSession = this.runtime(participantId).sessionFile;
		const cwd = humanCwd ?? this.authority.participantRoot(participantId);
		const sessionManager = preparedSession ?? this.createPersistedSessionManager(directory, parentSession, cwd);
		const childId = `agent:${sessionManager.getSessionId()}`;
		if (!childAgentSpawnEnabled) this.agentSpawnDisabled.add(childId);
		const sessionName = name?.trim() || childId.slice(-8);
		sessionManager.appendSessionInfo(sessionName);
		let childRuntime: ChildParticipantRuntime | undefined;
		try {
			await this.authority.spawnWith(participantId, childId, sessionName, grants, async () => {
				childRuntime = await this.createAgentRuntime(childId, sessionManager);
				// Registration is deliberately delayed until the authority commit is
				// durable. A final binding or persistence failure must not leave a
				// runnable child that does not exist in the ledger.
				this.subscribeRuntime(childRuntime);
				return { piSessionId: childRuntime.piSessionId, sessionFile: childRuntime.sessionFile };
			}, { inheritWorkspaceRead: inheritRead, defaultReadRoot: humanCwd, rootDir: cwd });
		} catch (error) {
			// createRuntime may have acquired model, extension, or filesystem
			// services before authority's final validation. Dispose them before
			// reporting the original spawn failure, and never let cleanup mask it.
			if (childRuntime && this.runtimes.get(childId) === childRuntime) this.runtimes.delete(childId);
			try { await childRuntime?.dispose?.(); } catch { /* preserve the spawn error */ }
			if (!childAgentSpawnEnabled) this.agentSpawnDisabled.delete(childId);
			throw error;
		}
		if (!childRuntime) throw new Error("Pi child session was not created");
		// subscribeRuntime already succeeded before the authority commit. Publishing
		// the prepared runtime is now a non-throwing in-memory commit.
		await this.publishPreparedRuntime(childId, childRuntime, "agent", false);
		const outcome: SpawnOutcome = {
			participantId: childId,
			promptRequested: Boolean(prompt?.trim()),
			turnPending: false,
			warningsComplete: false,
			warnings: [],
		};
		this.spawnOutcomes.set(childId, outcome);
		if (this.disposed) {
			outcome.warnings.push({
				code: "LINDEN_POST_COMMIT_CHECKPOINT_FAILED",
				message: "The child was created during shutdown, so its initial typed rewind checkpoint was not recorded.",
				detail: "PI_COORDINATOR_DISPOSING",
			});
			if (prompt?.trim()) {
				outcome.promptAccepted = false;
				outcome.warnings.push({
					code: "LINDEN_INITIAL_PROMPT_REJECTED",
					message: "The child was created during shutdown without starting its initial prompt.",
					detail: "PI_COORDINATOR_DISPOSING",
				});
			}
			outcome.warningsComplete = true;
			return childId;
		}
		try {
			if (!await this.appendCheckpointAfterCommit(childId, "spawn")) {
				outcome.warnings.push({
					code: "LINDEN_POST_COMMIT_CHECKPOINT_FAILED",
					message: "The child was created, but its initial typed rewind checkpoint could not be recorded.",
				});
			}
			if (prompt?.trim()) {
				if (this.disposed) {
					outcome.promptAccepted = false;
					outcome.warnings.push({
						code: "LINDEN_INITIAL_PROMPT_REJECTED",
						message: "The child was created during shutdown without starting its initial prompt.",
						detail: "PI_COORDINATOR_DISPOSING",
					});
				} else {
					outcome.promptAccepted = await this.startInitialPrompt(childId, childRuntime.session, prompt, outcome);
				}
			}
		} finally {
			// startInitialPrompt may still be translating a rejected operation into a
			// structured warning after its preflight callback has fired.
			outcome.warningsComplete = true;
		}
		return childId;
	}

	spawnOutcome(participantId: ParticipantId): SpawnOutcome | undefined {
		const outcome = this.spawnOutcomes.get(participantId);
		return outcome ? structuredClone(outcome) : undefined;
	}

	runtimeWarnings(participantId: ParticipantId): SpawnWarning[] {
		return structuredClone(this.runtimeDiagnostics.get(participantId) ?? []);
	}

	async send(participantId: ParticipantId, targetId: ParticipantId, payload: string): Promise<string> {
		try {
			targetId = this.resolveParticipantRef(targetId);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}; call participants to discover current IDs and obtain ordinary participant pointers before retrying send`, { cause: error });
		}
		this.authority.requireSend(participantId, targetId);
		const source = this.messageRuntime(participantId);
		const target = this.authority.participant(targetId);
		if (!target) throw new Error(`Unknown participant ${targetId}`);
		if (target.kind === "agent") await this.restoreParticipant(targetId);
		const message = await this.authority.sendWithPayload(participantId, targetId, async (messageId) => source.appendEntry<MailPayload>(PAYLOAD_ENTRY, { messageId, senderId: participantId, payload }));
		this.interruptWaitsForMessage(targetId, message.id);
		try {
			if (target.kind === "agent") await this.activateMailbox(targetId);
			else if (target.kind === "human") this.humanMessageHandler?.(message, payload);
		} catch (error) {
			this.emitRuntimeWarning(
				"LINDEN_POST_COMMIT_ADAPTER_FAILED",
				`Message ${message.id} committed, but immediate delivery to ${targetId} failed; it remains in the durable mailbox`,
				error,
			);
		}
		return message.id;
	}

	/**
	 * give transfers authority across a direct edge and completes atomically:
	 * a plain resource argument moves complete ownership to the peer
	 * immediately, a leading & grants a use pointer. Runtime notices describe
	 * authority changes and any external File changes saved during ownership
	 * transfer. File resource arguments require the file: kind even
	 * when their address is relative, then auto-refine against the giver's
	 * covering File region.
	 */
	async give(participantId: ParticipantId, reference: string, resourceInput: string, cwd?: string): Promise<GiveResult> {
		const targetId = this.resolveParticipantRef(reference);
		// An invalid peer must fail before typed File auto-refinement can persist.
		this.authority.requireGiveParticipant(participantId, targetId);
		const mode = resourceInput.startsWith("&") ? "read" : "move";
		const resourceId = await this.resolveGrantResource(participantId, mode === "read" ? resourceInput.slice(1) : resourceInput, mode, cwd);
		const receipt = await this.authority.giveWithReceipt(participantId, targetId, resourceId, mode);
		await this.flushRuntimeEvents();
		return { targetId, mode, moved: receipt.resources, fileUpdates: receipt.fileUpdates };
	}

	async transferResources(participantId: ParticipantId, reference: string, resources: readonly string[], kind: "give" | "get", cwd?: string): Promise<BatchTransferResult> {
		return sequentialTransfers(resources, (resource) => kind === "give"
			? this.give(participantId, reference, resource, cwd)
			: this.getPermission(participantId, reference, resource, cwd));
	}

	/** Parent-directed get is a request. Only the parent can perform its give. */
	async getPermission(participantId: string, reference: string, input: string, cwd?: string): Promise<GetPermissionResult> {
		const targetId = this.resolveParticipantRef(reference);
		const caller = this.authority.participant(participantId);
		if (caller?.parentId === targetId) {
			const read = input.startsWith("&");
			const typed = read ? input.slice(1) : input;
			const id = typed.startsWith("net:") ? netReference(typed).id : resolveFileResourceReference(typed, cwd ?? this.authority.participantRoot(participantId), this.authority.base, this.authority.privateRoots).id;
			input = `${read ? "&" : ""}${id}`;
			const current = this.authority.authoritySnapshot(participantId);
			const state = this.authority.snapshot();
			const filePath = typed.startsWith("file:") ? resolveFileResourceReference(typed, cwd ?? this.authority.participantRoot(participantId), this.authority.base, this.authority.privateRoots).path : undefined;
			if (current.owned.includes(id) || (read && current.pointers.includes(id)) || (filePath !== undefined && (read ? canReadPath(state, participantId, filePath) : canWritePath(state, participantId, filePath)))) return { status: "granted", targetId, resources: [id] };
			if (this.authority.participant(targetId)?.permissionMode === "all-of-mine") {
				try {
					const result = await this.give(targetId, participantId, input, cwd ?? this.authority.participantRoot(participantId));
					return { status: "granted", targetId, resources: result.moved, fileUpdates: result.fileUpdates };
				} catch (error) {
					return { status: "unavailable", targetId, resources: [], reason: error instanceof Error ? error.message : String(error) };
				}
			}
			const operationId = await this.send(participantId, targetId, `[Linden permission request]\n${participantId} requests ${input}. This request grants no authority. Approve with give after checking current permissions.`);
			return { status: "pending", targetId, resources: [], operationId };
		}
		if (input.startsWith("&")) throw new Error("Parent-side get takes complete ownership; & is only accepted when requesting from parent");
		const resolved = await this.resolveOwnedChildResource(participantId, targetId, input, cwd);
		const receipt = await this.getOwnedResourceWithReceipt(participantId, targetId, resolved.resourceId);
		await this.flushRuntimeEvents();
		return { status: "granted", targetId, resources: receipt.resources, fileUpdates: receipt.fileUpdates };
	}

	async flushRuntimeEvents(): Promise<void> {
		if (this.runtimeEventFlush) return this.runtimeEventFlush;
		this.runtimeEventFlush = this.deliverRuntimeEvents().finally(() => { this.runtimeEventFlush = undefined; });
		return this.runtimeEventFlush;
	}

	private async deliverRuntimeEvents(): Promise<void> {
		const attempted = new Set<string>();
		while (!this.disposed) {
			const event = this.authority.snapshot().runtimeEvents?.find((candidate) => !candidate.delivered && !attempted.has(candidate.id) && this.authority.participant(candidate.participantId)?.kind === "agent");
			if (!event) break;
			attempted.add(event.id);
			try {
				await this.restoreParticipant(event.participantId);
				const runtime = this.runtimes.get(event.participantId);
				if (!runtime?.appendRuntimeNotice) continue;
				this.interruptWaitsForMessage(event.participantId, event.id);
				// Persist notices without starting a model turn or steering tools.
				const persisted = runtime.entries?.().some((entry) => entry.type === "custom_message" && (entry as any).details?.eventId === event.id);
				if (!persisted) await runtime.appendRuntimeNotice(event.text, { continueLoop: false, kind: event.kind as RuntimeNoticeOptions["kind"], eventId: event.id });
				await this.authority.acknowledgeRuntimeEvent(event.id);
			} catch (error) {
				this.emitRuntimeWarning("LINDEN_POST_COMMIT_ADAPTER_FAILED", `Runtime message ${event.id} remains pending`, error);
			}
		}
	}

	/**
	 * Resolve a typed give/spawn resource reference to a canonical resource ID.
	 * File references always require file:; their address may be relative to cwd
	 * or absolute. A trailing slash is the sole File-region marker. Canonical
	 * identities need not already be materialized in the ledger.
	 */
	private async resolveGrantResource(participantId: ParticipantId, input: string, mode: "move" | "read", cwd?: string): Promise<ResourceId> {
		if (input.startsWith("net:")) return this.authority.materializeNet(participantId, input);
		if (input.startsWith("web:")) throw new Error("Web is historical; use net:tcp/<endpoint>:<port>");
		const resolved = resolveFileResourceReference(input, cwd ?? this.authority.participantRoot(participantId), this.authority.base, this.authority.privateRoots);
		const known = this.authority.resource(resolved.id as ResourceId);
		if (known) return known.id;
		const exists = existsSync(resolved.path);
		const isDirectory = exists && lstatSync(resolved.path).isDirectory();
		const isFile = exists && lstatSync(resolved.path).isFile();
		if (resolved.region && isFile) throw new Error(`FILE_RESOURCE_KIND_MISMATCH: ${resolved.path} is a file; remove the trailing /`);
		if (!resolved.region && isDirectory) throw new Error(`FILE_RESOURCE_KIND_MISMATCH: ${resolved.path} is a directory; add a trailing /`);
		const located = this.authority.locateCoveringPath(participantId, resolved.path, mode === "move" ? "write" : "read", cwd);
		if (!located.refined) {
			if (!resolved.region) throw new Error(`FILE_RESOURCE_KIND_MISMATCH: ${resolved.path} is a File region; add a trailing /`);
			return located.parentResourceId;
		}
		const refineMode: "read" | "write" = mode === "move" ? "write" : "read";
		const result = resolved.region
			? await this.authority.subpath(participantId, located.parentResourceId, located.path, refineMode)
			: await this.authority.file(participantId, located.parentResourceId, located.path, refineMode);
		return result.resourceId;
	}

	async resolveOwnedResource(participantId: ParticipantId, input: string, cwd?: string): Promise<ResourceId> {
		return this.resolveGrantResource(participantId, input, "move", cwd);
	}

	/**
	 * Resolve a get target before allowing resource refinement to touch the
	 * ledger. The final get still revalidates the same edge and ownership in one
	 * atomic authority transition.
	 */
	async resolveOwnedChildResource(
		participantId: ParticipantId,
		targetReference: string,
		input: string,
		cwd?: string,
	): Promise<{ targetId: ParticipantId; resourceId: ResourceId }> {
		const targetId = this.resolveParticipantRef(targetReference);
		this.authority.requireGetParticipant(participantId, targetId);
		const resourceId = await this.resolveOwnedResource(targetId, input, cwd);
		return { targetId, resourceId };
	}

	peekMailbox(participantId: ParticipantId, senderId?: ParticipantId): DeliveredMail[] {
		if (senderId) senderId = this.resolveMessageSenderRef(senderId);
		const pending = this.authority.pendingMessages(participantId, senderId);
		const delivered: DeliveredMail[] = [];
		const coldSessions = new Map<ParticipantId, SessionManager>();
		for (const message of pending) {
			const payload = this.readMailPayload(message, coldSessions);
			if (!payload || payload.messageId !== message.id || payload.senderId !== message.senderId) throw new Error(`Mailbox payload ${message.payloadEntryId} does not match ledger message ${message.id}`);
			delivered.push({ id: message.id, senderId: message.senderId, payload: payload.payload });
		}
		return delivered;
	}

	async receive(participantId: ParticipantId, senderId?: ParticipantId): Promise<DeliveredMail[]> {
		if (senderId) senderId = this.resolveMessageSenderRef(senderId);
		const delivered = this.peekMailbox(participantId, senderId);
		if (!delivered.length) return [];
		await this.authority.receiveMessages(participantId, delivered.map((message) => message.id), senderId);
		return delivered;
	}

	async prepareAttach(participantId: ParticipantId, targetId: ParticipantId): Promise<{ targetId: ParticipantId; consumed: DeliveredMail[] }> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireAttach(participantId, targetId);
		await this.restoreParticipant(targetId);
		await this.activateMailbox(targetId);
		// Attach grants no mailbox capability. Only attempt the optional
		// sender-filtered receive when such mail actually exists; a transitive
		// descendant role alone must remain insufficient for filtered receive.
		const hasMailFromTarget = this.authority.pendingMessages(participantId).some((message) => message.senderId === targetId);
		return { targetId, consumed: hasMailFromTarget ? await this.receive(participantId, targetId) : [] };
	}

	async steer(participantId: ParticipantId, targetId: ParticipantId, payload: string): Promise<string> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireSteer(participantId, targetId);
		const source = this.messageRuntime(participantId);
		await this.restoreParticipant(targetId);
		const message = await this.authority.sendWithPayload(participantId, targetId, async (messageId) => source.appendEntry<MailPayload>(PAYLOAD_ENTRY, { messageId, senderId: participantId, payload }), "steering");
		this.interruptWaitsForMessage(targetId, message.id);
		try { await this.activateMailbox(targetId); }
		catch (error) {
			this.emitRuntimeWarning(
				"LINDEN_POST_COMMIT_ADAPTER_FAILED",
				`Steering Message ${message.id} committed, but immediate delivery to ${targetId} failed; retry remains scheduled`,
				error,
			);
		}
		return message.id;
	}

	beginTool(participantId: ParticipantId): void {
		if (this.disposed) throw new Error("PI_COORDINATOR_DISPOSING: no new tool operation can start");
		const pending = this.steeringBlocks.get(participantId);
		if (pending?.size) throw new Error(`Linden steering is pending (${[...pending].join(", ")}); this remaining tool call was interrupted before it started`);
		if (this.contextNavigationBlocks.has(participantId)) throw new Error(`Linden context rewind is pending for ${participantId}; this later tool call was held before it started`);
		if ((this.authorityTransferBlocks.get(participantId) ?? 0) > 0) throw new Error(`Linden authority transfer is pending for ${participantId}; retry this tool after applying the runtime authority update`);
		if (this.stopRequests.has(participantId) || this.stopping.has(participantId)) throw new Error(`Linden stop is pending for ${participantId}; this tool was interrupted before it started`);
		this.activeLifecycleOperations += 1;
		this.activeTools.set(participantId, (this.activeTools.get(participantId) ?? 0) + 1);
	}

	endTool(participantId: ParticipantId): void {
		const depth = this.activeTools.get(participantId) ?? 0;
		if (depth === 0) throw new Error(`LINDEN_TOOL_LIFECYCLE: ${participantId} has no active tool operation`);
		if (depth <= 1) {
			this.activeTools.delete(participantId);
			if (this.stopRequests.has(participantId)) this.scheduleBackgroundOperation(() => this.finishStop(participantId));
		} else {
			this.activeTools.set(participantId, depth - 1);
		}
		this.finishLifecycleOperation();
	}

	async interrupt(participantId: ParticipantId, targetId: ParticipantId): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireInterrupt(participantId, targetId);
		const participant = this.authority.participant(targetId)!;
		if (participant.kind === "term") {
			const runtime = await this.ensureTermRuntime(targetId);
			if (runtime.term.lifecycle().lifecycle === "running") await runtime.term.interrupt();
			await runtime.term.waitFor("ready");
			await this.refreshLifecycleStatuses();
			const status = this.authority.participant(targetId)?.status === "stopped" ? "stopped" : "ready";
			await this.authority.commitInterrupt(participantId, targetId, status);
			return;
		}
		if (participant.kind !== "agent") throw new Error(`No concrete interrupt adapter exists for ${participant.kind} ${targetId}`);
		await this.requestAgentControl(participantId, targetId, "interrupt");
	}

	async stop(participantId: ParticipantId, targetId: ParticipantId): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireStop(participantId, targetId);
		const handled = new Set<ParticipantId>();
		while (true) {
			const pass = [targetId, ...this.authority.descendantIds(targetId)]
				.filter((id) => {
					const participant = this.authority.participant(id);
					if (!participant) return false;
					const runtime = this.runtimes.get(id);
					const runtimeActive = runtime instanceof TermParticipantRuntime
						? runtime.term.lifecycle().lifecycle !== "stopped"
						: runtime?.isRunning() ?? false;
					return !handled.has(id) || participant.status === "running" || runtimeActive || (this.activeTools.get(id) ?? 0) > 0;
				})
				.reverse();
			if (pass.length === 0) break;
			for (const id of pass) {
				const participant = this.authority.participant(id);
				if (!participant) continue;
				if (participant.kind === "term") {
					const current = this.runtimes.get(id);
					if (current instanceof TermParticipantRuntime) await current.term.stopAll();
					await this.authority.commitStop(participantId, id);
				} else if (participant.kind === "agent") {
					await this.requestAgentControl(participantId, id, "stop");
				} else {
					await this.authority.commitStop(participantId, id);
				}
				handled.add(id);
			}
			await this.refreshLifecycleStatuses();
		}
		await this.refreshLifecycleStatuses();
	}

	private async requestAgentControl(participantId: ParticipantId, targetId: ParticipantId, kind: "interrupt" | "stop"): Promise<void> {
		if (this.contextNavigationBlocks.has(targetId)) throw new Error(`Linden context rewind is pending for ${targetId}; retry ${kind} after navigation completes`);
		const existing = this.stopRequests.get(targetId);
		if (existing) {
			if (kind === "stop") this.controlKinds.set(targetId, "stop");
			await this.waitForStopCompletion(targetId);
			return;
		}
		const runtime = this.runtimes.get(targetId);
		if (!runtime) {
			if (kind === "stop") await this.authority.commitStop(participantId, targetId);
			else await this.authority.commitInterrupt(participantId, targetId, "stopped");
			return;
		}
		this.stopRequests.set(targetId, participantId);
		this.controlKinds.set(targetId, kind);
		this.stopping.add(targetId);
		if ((this.activeTools.get(targetId) ?? 0) === 0) await this.finishStop(targetId);
		else await this.waitForStopCompletion(targetId);
	}

	private async finishStop(targetId: ParticipantId): Promise<void> {
		const participantId = this.stopRequests.get(targetId);
		if (!participantId || this.stopFinishing.has(targetId)) return;
		const kind = this.controlKinds.get(targetId) ?? "interrupt";
		this.stopFinishing.add(targetId);
		try {
			await this.runtime(targetId).abort();
			if (kind === "stop") await this.authority.commitStop(participantId, targetId);
			else await this.authority.commitInterrupt(participantId, targetId, "stopped");
		} finally {
			this.stopRequests.delete(targetId);
			this.controlKinds.delete(targetId);
			this.stopFinishing.delete(targetId);
			this.stopping.delete(targetId);
		}
		await this.refreshLifecycleStatuses();
	}

	/**
	 * Get a resource currently owned by the caller's own child (ownership
	 * transfer stays edge-scoped; no prior give exists anymore). If an Agent
	 * owner is mid-turn, its active tool finishes and later tools are held while
	 * ownership moves atomically. A runtime notice is then steered into an
	 * already-running Agent loop, or only appended for an already-idle Agent;
	 * get never aborts, stops, or wakes an idle Agent.
	 */
	async getOwnedResource(participantId: ParticipantId, expectedOwnerId: ParticipantId, resourceId: ResourceId): Promise<ResourceId[]> {
		return (await this.getOwnedResourceWithReceipt(participantId, expectedOwnerId, resourceId)).resources;
	}

	private async getOwnedResourceWithReceipt(participantId: ParticipantId, expectedOwnerId: ParticipantId, resourceId: ResourceId): Promise<AuthorityTransferReceipt> {
		expectedOwnerId = this.resolveParticipantRef(expectedOwnerId);
		this.authority.requireGetParticipant(participantId, expectedOwnerId);
		const resource = this.authority.resource(resourceId);
		if (!resource) throw new Error(`Unknown resource ${resourceId}`);
		if (resource.ownerId !== expectedOwnerId) throw new Error(`${expectedOwnerId} does not own ${resourceId}; current owner is ${resource.ownerId ?? "none"}`);
		if (this.authority.participant(expectedOwnerId)?.kind === "term" && this.authority.hasOpenTermEpoch(expectedOwnerId)) {
			throw new Error(`TERM_EPOCH_ACTIVE: ${expectedOwnerId} still has an open epoch; leave required background work running, or explicitly stop the Term before get`);
		}
		if (this.authority.participant(expectedOwnerId)?.kind !== "agent") {
			return this.authority.getWithReceipt(participantId, expectedOwnerId, resourceId);
		}
		if (this.contextNavigationBlocks.has(expectedOwnerId)) throw new Error(`Linden context rewind is pending for ${expectedOwnerId}; retry get after navigation completes`);

		this.beginAuthorityTransfer(expectedOwnerId);
		try {
			const runtimeBefore = this.runtimes.get(expectedOwnerId);
			const wasRunning = (runtimeBefore?.isRunning() ?? false)
				|| this.agentLoops.has(expectedOwnerId)
				|| (this.activeTools.get(expectedOwnerId) ?? 0) > 0;
			await this.waitForActiveToolCompletion(expectedOwnerId);
			const receipt = await this.authority.getWithReceipt(participantId, expectedOwnerId, resourceId);
			const runtimeAfter = this.runtimes.get(expectedOwnerId);
			const shouldContinue = wasRunning
				|| (runtimeAfter?.isRunning() ?? false)
				|| this.agentLoops.has(expectedOwnerId);
			const noticeDelivery = this.flushRuntimeEvents();
			if (!shouldContinue) await noticeDelivery;
			return receipt;
		} finally {
			this.endAuthorityTransfer(expectedOwnerId);
		}
	}

	private beginAuthorityTransfer(participantId: ParticipantId): void {
		this.authorityTransferBlocks.set(participantId, (this.authorityTransferBlocks.get(participantId) ?? 0) + 1);
	}

	private endAuthorityTransfer(participantId: ParticipantId): void {
		const count = this.authorityTransferBlocks.get(participantId) ?? 0;
		if (count <= 1) this.authorityTransferBlocks.delete(participantId);
		else this.authorityTransferBlocks.set(participantId, count - 1);
	}

	private async waitForActiveToolCompletion(participantId: ParticipantId, operation: "get" | "rewind" = "get"): Promise<void> {
		const deadline = Date.now() + 300_000;
		while ((this.activeTools.get(participantId) ?? 0) > 0) {
			if (this.disposed) throw new Error(`PI_COORDINATOR_DISPOSING: stopped waiting to ${operation} ${participantId}`);
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${participantId} to finish its current tool before ${operation}`);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
		}
	}

	private async waitForStopCompletion(participantId: ParticipantId): Promise<void> {
		const deadline = Date.now() + 300_000;
		while (!this.disposed && (this.stopRequests.has(participantId) || this.stopping.has(participantId) || (this.activeTools.get(participantId) ?? 0) > 0)) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${participantId} to finish its current tool before get`);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
		}
	}

	async handleAgentEnd(participantId: ParticipantId, willRetry = false): Promise<void> {
		this.agentLoops.delete(participantId);
		this.beginParticipantBackendWork(participantId);
		let finishPendingStop = false;
		try {
			await this.refreshLifecycleStatuses();
			if (!willRetry && !this.stopping.has(participantId) && !this.contextNavigationBlocks.has(participantId)) await this.publishFinal(participantId);
			await this.appendCheckpoint(participantId, "agent-end");
		} finally {
			if (this.contextNavigationBlocks.has(participantId)) {
				if (this.followUpsWaitingForIdle.has(participantId)) this.mailboxActivationDeferredByNavigation.add(participantId);
			} else if (this.followUpsWaitingForIdle.delete(participantId) && !this.mailboxWakeSuspended.has(participantId)) this.scheduleFollowUpFlush(participantId);
			finishPendingStop = this.stopRequests.has(participantId) && (this.activeTools.get(participantId) ?? 0) === 0;
			this.endParticipantBackendWork(participantId);
			await this.refreshLifecycleStatuses();
			if (finishPendingStop) this.scheduleBackgroundOperation(() => this.finishStop(participantId));
		}
	}

	async handleAgentStart(participantId: ParticipantId): Promise<void> {
		if (this.authority.participant(participantId)?.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: ${participantId} is not an Agent`);
		this.agentLoops.add(participantId);
		await this.refreshLifecycleStatuses();
	}

	private async publishFinal(participantId: ParticipantId): Promise<void> {
		if (this.stopping.has(participantId) || this.contextNavigationBlocks.has(participantId)) return;
		const runtime = this.agentRuntime(participantId);
		const final = assistantFinal(runtime.entries());
		if (!final) return;
		const participant = this.authority.participant(participantId);
		const parentId = participant?.parentId;
		if (!parentId) return;
		const message = await this.authority.sendFinalWithPayload(participantId, final.entryId, async (messageId) => runtime.appendEntry<MailPayload>(PAYLOAD_ENTRY, { messageId, senderId: participantId, payload: final.payload }));
		const newlyPending = !message.consumedAt;
		if (newlyPending) this.interruptWaitsForMessage(parentId, message.id);
		if (parentId === this.authority.rootParticipantId) {
			if (newlyPending) {
				const consumedLive = this.humanFinalConsumer ? await this.humanFinalConsumer(message, final.payload) : false;
				if (!consumedLive) this.humanMessageHandler?.(message, final.payload);
			}
			return;
		}
		this.scheduleFollowUpFlush(parentId);
	}

	async handleRuntimeMessage(participantId: ParticipantId, message: unknown): Promise<void> {
		const details = batchDetails(message);
		if (!details) return;
		const acknowledged = await this.authority.acknowledgeDelivery(participantId, details.batchId);
		if (details.messageKind === "steering") {
			this.clearSteering(acknowledged);
			if (this.authority.pendingMessages(participantId, undefined, "steering").length) {
				try { await this.deliverPending(participantId, "steering"); }
				catch (error) { if (!isDeliveryReservationBusy(error)) throw error; }
			}
		} else if (!this.mailboxWakeSuspended.has(participantId) && this.authority.pendingMessages(participantId, undefined, "follow_up").length) {
			this.scheduleFollowUpFlush(participantId);
		}
	}

	/** Freeze an Agent after a benchmark terminal submission while retaining later mail in its Pi tree. */
	async suspendAgentMailboxWake(participantId: ParticipantId): Promise<void> {
		const participant = this.authority.participant(participantId);
		if (!participant || participant.kind !== "agent") throw new Error(`PARTICIPANT_KIND_MISMATCH: ${participantId} is not an Agent`);
		if (this.mailboxWakeSuspended.has(participantId)) return;
		this.mailboxWakeSuspended.add(participantId);
		this.followUpsWaitingForIdle.delete(participantId);
		const followUpTimer = this.followUpTimers.get(participantId);
		if (followUpTimer) clearTimeout(followUpTimer);
		this.followUpTimers.delete(participantId);
		const steeringTimer = this.steeringRetryTimers.get(participantId);
		if (steeringTimer) clearTimeout(steeringTimer);
		this.steeringRetryTimers.delete(participantId);
		this.runtimes.get(participantId)?.suspendMailboxWake?.();

		// clearQueue drops already queued Pi follow-ups. Release their ledger
		// reservations, then redeliver them as non-waking persisted messages.
		const batches = new Set(Object.values(this.authority.snapshot().messages)
			.filter((message) => message.targetId === participantId && message.deliveryBatchId)
			.map((message) => message.deliveryBatchId!));
		for (const batchId of batches) await this.authority.releaseDelivery(participantId, batchId);
		await this.activateMailbox(participantId);
		await this.refreshLifecycleStatuses();
	}

	async listen(participantId: ParticipantId, targetId: ParticipantId, options: ListenParticipantOptions = {}): Promise<string> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireListen(participantId, targetId);
		await this.refreshLifecycleStatuses();
		this.authority.requireListen(participantId, targetId);
		let participant = this.authority.participant(targetId)!;
		if (participant.kind === "term") {
			const runtime = this.runtimes.get(targetId);
			if (!(runtime instanceof TermParticipantRuntime)) return `${targetId} kind=Term lifecycle=${participant.status}\noutput-unavailable=no-live-adapter`;
			const cursorKey = `${participantId}\0${targetId}`;
			const after = options.after ?? this.termListenCursors.get(cursorKey);
			const listened = await runtime.term.listen({ after, wait: options.wait, signal: options.signal, maxBytes: 48 * 1024 });
			this.termListenCursors.set(cursorKey, listened.cursor);
			const continuation = listened.hasMore ? "\n[More buffered Term output is available; call listen again without after to continue.]" : "";
			return `${targetId} kind=Term lifecycle=${participant.status}\n${runtime.summary()}\noutput-start=${listened.start}\noutput-cursor=${listened.cursor}\noutput-more=${listened.hasMore}\n${listened.data}${continuation}`;
		}
		if (participant.kind === "human") {
			// Only the root Human has a live adapter today, and an ancestor-only
			// listen cannot target it. Keep the fallback for a future intermediate
			// Human participant without implying that adapter is implemented now.
			const runtime = this.runtimes.get(targetId);
			return `${targetId} kind=Human lifecycle=${participant.status}\n${runtime?.summary() ?? "output-unavailable=no-live-adapter"}`;
		}
		await this.restoreParticipant(targetId);
		await this.refreshLifecycleStatuses();
		this.authority.requireListen(participantId, targetId);
		participant = this.authority.participant(targetId)!;
		const runtime = this.agentRuntime(targetId);
		const checkpoint = this.nearestAgentState(targetId, runtime.leafId() ?? undefined);
		return `${targetId} kind=Agent lifecycle=${participant.status} branch=${this.authority.agentBranches(targetId).current}\n${runtime.summary()}\nnearest-rewindable-agent-state=${checkpoint?.id ?? "none"}`;
	}

	listenParticipant(participantId: ParticipantId, targetId: string, options?: ListenParticipantOptions): Promise<string> { return this.listen(participantId, targetId, options); }

	private runtimeSatisfiesWait(targetId: ParticipantId, until: ParticipantWaitTarget): boolean {
		const ids = until === "ready"
			? [targetId]
			: [targetId, ...this.authority.descendantIds(targetId)];
		return ids.every((id) => {
			const runtime = this.runtimes.get(id);
			if (runtime?.isRunning() || this.agentLoops.has(id) || (this.activeTools.get(id) ?? 0) > 0) return false;
			if (this.contextNavigationBlocks.has(id)) return false;
			if (until === "ready") return true;
			if (runtime instanceof TermParticipantRuntime && runtime.term.lifecycle().lifecycle !== "stopped") return false;
			return (this.participantBackendWork.get(id) ?? 0) === 0
				&& !this.stopRequests.has(id)
				&& !this.stopping.has(id)
				&& !this.stopFinishing.has(id)
				&& !this.participantRestores.has(id)
				&& !this.termRuntimeCreates.has(id);
		});
	}

	private beginParticipantWait(participantId: ParticipantId, signal?: AbortSignal): ActiveParticipantWait {
		const waiter: ActiveParticipantWait = { controller: new AbortController(), messageIds: new Set(), externalSignal: signal };
		if (signal?.aborted) waiter.controller.abort(signal.reason);
		else if (signal) {
			waiter.externalAbort = () => waiter.controller.abort(signal.reason);
			signal.addEventListener("abort", waiter.externalAbort, { once: true });
		}
		const waits = this.activeParticipantWaits.get(participantId) ?? new Set<ActiveParticipantWait>();
		waits.add(waiter);
		this.activeParticipantWaits.set(participantId, waits);
		for (const message of this.authority.pendingMessages(participantId, undefined, "follow_up")) waiter.messageIds.add(message.id);
		if (waiter.messageIds.size && !waiter.controller.signal.aborted) waiter.controller.abort(WAIT_INTERRUPTED_BY_MESSAGE);
		return waiter;
	}

	private endParticipantWait(participantId: ParticipantId, waiter: ActiveParticipantWait): void {
		if (waiter.externalSignal && waiter.externalAbort) waiter.externalSignal.removeEventListener("abort", waiter.externalAbort);
		const waits = this.activeParticipantWaits.get(participantId);
		waits?.delete(waiter);
		if (waits?.size === 0) this.activeParticipantWaits.delete(participantId);
	}

	private interruptWaitsForMessage(participantId: ParticipantId, messageId: string): void {
		for (const waiter of this.activeParticipantWaits.get(participantId) ?? []) {
			waiter.messageIds.add(messageId);
			if (!waiter.controller.signal.aborted) waiter.controller.abort(WAIT_INTERRUPTED_BY_MESSAGE);
		}
	}

	private participantWaitInterruption(waiter: ActiveParticipantWait): ParticipantWaitResult | undefined {
		if (waiter.controller.signal.reason !== WAIT_INTERRUPTED_BY_MESSAGE) return undefined;
		return { status: "interrupted", reason: "message", messageIds: [...waiter.messageIds] };
	}

	private async waitPoll(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		await new Promise<void>((resolvePromise) => {
			const timer = setTimeout(finish, 25);
			function finish() {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolvePromise();
			}
			signal.addEventListener("abort", finish, { once: true });
		});
	}

	async waitParticipant(participantId: ParticipantId, targetId: string, until: ParticipantWaitTarget, signal?: AbortSignal): Promise<ParticipantWaitResult> {
		targetId = this.resolveParticipantRef(targetId);
		this.authority.requireWait(participantId, targetId, until);
		const waiter = this.beginParticipantWait(participantId, signal);
		try {
			while (true) {
				const interrupted = this.participantWaitInterruption(waiter);
				if (interrupted) return interrupted;
				if (waiter.controller.signal.aborted) throw new Error("Participant wait aborted");
				if (this.disposed) throw new Error("PI_COORDINATOR_DISPOSING: participant wait was interrupted");
				const participant = this.authority.participant(targetId);
				if (!participant) throw new Error(`Participant ${targetId} was removed while waiting`);
				if (participant.kind === "term") {
					const runtime = await this.ensureTermRuntime(targetId);
					try { await runtime.term.waitFor(until, { signal: waiter.controller.signal }); }
					catch (error) {
						const termInterrupted = this.participantWaitInterruption(waiter);
						if (termInterrupted) return termInterrupted;
						await this.refreshLifecycleStatuses();
						if (waiter.controller.signal.reason === WAIT_INTERRUPTED_BY_DISPOSE) throw new Error("PI_COORDINATOR_DISPOSING: participant wait was interrupted");
						if (waiter.controller.signal.aborted) throw new Error("Participant wait aborted");
						throw error;
					}
				} else {
					while (true) {
						const agentInterrupted = this.participantWaitInterruption(waiter);
						if (agentInterrupted) return agentInterrupted;
						if (waiter.controller.signal.aborted) throw new Error("Participant wait aborted");
						await this.refreshLifecycleStatuses();
						const status = this.authority.participant(targetId)?.status;
						if (!status) throw new Error(`Participant ${targetId} was removed while waiting`);
						if (until === "ready" ? status !== "running" : status === "stopped") break;
						await this.waitPoll(waiter.controller.signal);
					}
				}
				const beforeCommit = this.participantWaitInterruption(waiter);
				if (beforeCommit) return beforeCommit;
				await this.refreshLifecycleStatuses();
				const afterRefresh = this.participantWaitInterruption(waiter);
				if (afterRefresh) return afterRefresh;
				// Status and wait effect are checked/committed together. If the target
				// restarted between observation and commit, continue waiting.
				const committed = await this.authority.commitWait(participantId, targetId, until, () => this.runtimeSatisfiesWait(targetId, until));
				const afterCommit = this.participantWaitInterruption(waiter);
				if (afterCommit) return afterCommit;
				if (committed) return { status: "reached", state: until };
			}
		} finally {
			this.endParticipantWait(participantId, waiter);
		}
	}

	async termExec(participantId: ParticipantId, targetId: string, command: string): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		await this.refreshLifecycleStatuses();
		this.authority.requireTermExec(participantId, targetId);
		const runtime = await this.ensureTermRuntimeForExec(targetId);
		const launched = await runtime.term.startExec(command);
		const operation = launched.completion.finally(() => this.refreshLifecycleStatuses());
		this.trackBackgroundOperation(operation);
		if (runtime.term.lifecycle().error) throw new Error(runtime.term.lifecycle().error);
		await this.refreshLifecycleStatuses();
	}

	async termInput(participantId: ParticipantId, targetId: string, data: string): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		await this.refreshLifecycleStatuses();
		// Reject kind/hierarchy/lifecycle violations before creating or restoring
		// a Term adapter. commitInputWith repeats this check atomically at delivery.
		this.authority.requireTermInput(participantId, targetId);
		const runtime = await this.ensureTermRuntime(targetId);
		// Do not create a durable delivery intent while exec is still publishing
		// its foreground. This wait is event-driven by the trusted start handshake.
		await runtime.term.waitForInputReady();
		await this.withTopologyLock(async () => {
			if (!this.authority.participant(targetId) || this.runtimes.get(targetId) !== runtime) throw new Error(`Participant ${targetId} was removed before terminal input could commit`);
			await this.authority.commitInputWith(participantId, targetId, () => runtime.term.input(data), () => runtime.term.assertInputReady());
		});
	}

	async publishNet(participantId: string, reference: string, input: string, internalPort: number): Promise<string> {
		const termId = this.resolveParticipantRef(reference);
		const resourceId = await this.authority.materializeNet(participantId, input);
		this.authority.requireListen(participantId, termId);
		const runtime = await this.ensureTermRuntime(termId);
		return this.authority.publishNet(participantId, resourceId, termId, internalPort, () => runtime.term.publishPort(resourceId, internalPort), () => runtime.term.unpublishPort(resourceId));
	}

	async unpublishNet(participantId: string, input: string): Promise<void> {
		const resourceId = netReference(input).id;
		await this.authority.unpublishNet(participantId, resourceId, async (termId) => (await this.ensureTermRuntime(termId)).term.unpublishPort(resourceId));
	}

	async unarchive(participantId: string, targetId: string): Promise<string[]> {
		const restored = await this.withTopologyLock(() => this.authority.unarchiveParticipant(participantId, targetId));
		await this.flushRuntimeEvents();
		return restored;
	}

	async fork(participantId: string, sourceId: string, name?: string): Promise<string> {
		const source = this.authority.participant(sourceId) ?? this.authority.participantTombstone(sourceId);
		if (!source || source.kind !== "agent" || !source.sessionFile || source.parentId !== participantId) throw new Error("Fork requires a live or retained direct-child Agent");
		const original = this.openPersistedSessionManager(sourceId, source.sessionFile).manager;
		const session = this.createPersistedSessionManager(join(this.authority.stateDir, "pi-sessions"), source.sessionFile, this.authority.participantRoot(participantId));
		const file = session.getSessionFile()!;
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
		const branch = original.getBranch().filter((entry) => entry.type !== "label" && !(entry.type === "custom" && entry.customType.startsWith("linden-")));
		const idMap = new Map(branch.map((entry) => [entry.id, randomUUID()]));
		let parentId: string | null = null;
		const entries = branch.map((entry) => {
			const copy: any = { ...structuredClone(entry), id: idMap.get(entry.id), parentId };
			if (copy.type === "compaction" && idMap.has(copy.firstKeptEntryId)) copy.firstKeptEntryId = idMap.get(copy.firstKeptEntryId);
			parentId = copy.id;
			return copy;
		});
		writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const forked = SessionManager.open(file, join(this.authority.stateDir, "pi-sessions"));
		// The notice is part of the new history before a runtime can be published.
		forked.appendCustomMessageEntry(RUNTIME_NOTICE, `[Linden fork] Forked from ${sourceId}. This is a new Agent with no File or Net permissions, no children, no active processes, and no pending tasks. Historical IDs and permission statements are context only. Acquire current authority from your parent before working.`, true, { kind: "fork" });
		return this.runLifecycleOperation(() => this.spawnNow(participantId, name, undefined, [], false, forked.getCwd(), true, forked));
	}

	async archive(participantId: ParticipantId, targetId: string): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		await this.refreshLifecycleStatuses();
		const cleanup = await this.withTopologyLock(async () => {
			const removed = await this.authority.archiveParticipant(participantId, targetId, () => this.runtimeSatisfiesWait(targetId, "stopped"));
			const runtimes: ParticipantRuntime[] = [];
			for (const id of removed) {
				const runtime = this.runtimes.get(id);
				this.runtimes.delete(id);
				if (runtime) runtimes.push(runtime);
				this.participantRestores.delete(id);
				this.termRuntimeCreates.delete(id);
				this.stopRequests.delete(id);
				this.controlKinds.delete(id);
				this.stopFinishing.delete(id);
				this.stopping.delete(id);
				this.activeTools.delete(id);
				this.authorityTransferBlocks.delete(id);
				this.contextNavigationBlocks.delete(id);
				this.mailboxActivationDeferredByNavigation.delete(id);
				this.agentLoops.delete(id);
				this.participantBackendWork.delete(id);
				this.followUpsWaitingForIdle.delete(id);
				const followUp = this.followUpTimers.get(id);
				if (followUp) clearTimeout(followUp);
				this.followUpTimers.delete(id);
				const steeringRetry = this.steeringRetryTimers.get(id);
				if (steeringRetry) clearTimeout(steeringRetry);
				this.steeringRetryTimers.delete(id);
				this.steeringRetryDelays.delete(id);
				this.steeringBlocks.delete(id);
			}
			for (const [sessionFile, ownerId] of this.restoredSessionFiles) if (removed.includes(ownerId)) this.restoredSessionFiles.delete(sessionFile);
			return { removed, runtimes };
		});
		const failures: unknown[] = [];
		for (const runtime of cleanup.runtimes) {
			try { await this.disposeRuntimeOnce(runtime); }
			catch (error) { failures.push(error); }
		}
		if (failures.length) {
			this.emitRuntimeWarning(
				"LINDEN_POST_COMMIT_ADAPTER_FAILED",
				`Participant subtree ${targetId} was archived, but adapter cleanup did not complete; the session lease will remain held`,
				new AggregateError(failures, "archived runtime cleanup failed"),
			);
		}
	}

	private refreshLifecycleStatuses(): Promise<void> {
		const refresh = this.lifecycleRefreshTail.then(() => this.refreshLifecycleStatusesNow());
		this.lifecycleRefreshTail = refresh.catch(() => undefined);
		return refresh;
	}

	private async refreshLifecycleStatusesNow(): Promise<void> {
		const state = this.authority.snapshot();
		const memo = new Map<ParticipantId, "running" | "ready" | "stopped">();
		const visit = (id: ParticipantId): "running" | "ready" | "stopped" => {
			const known = memo.get(id);
			if (known) return known;
			const participant = state.participants[id];
			if (!participant) return "stopped";
			const runtime = this.runtimes.get(id);
			let own: "running" | "ready" | "stopped" = "stopped";
			if (runtime instanceof TermParticipantRuntime) own = runtime.term.lifecycle().lifecycle;
			else if (this.agentLoops.has(id) || (runtime?.isRunning() ?? false) || (this.activeTools.get(id) ?? 0) > 0) own = "running";
			else if ((this.participantBackendWork.get(id) ?? 0) > 0 || this.stopRequests.has(id) || this.stopping.has(id) || this.contextNavigationBlocks.has(id)) own = "ready";
			else if (participant.kind === "human" && participant.status === "running") own = "running";
			const children = participant.childIds.map(visit);
			const status = own === "running" ? "running" : own === "ready" || children.some((child) => child !== "stopped") ? "ready" : "stopped";
			memo.set(id, status);
			return status;
		};
		for (const id of Object.keys(state.participants)) visit(id);
		await this.authority.setParticipantStatuses(memo);
	}

	private beginParticipantBackendWork(participantId: ParticipantId): void {
		this.participantBackendWork.set(participantId, (this.participantBackendWork.get(participantId) ?? 0) + 1);
	}

	private endParticipantBackendWork(participantId: ParticipantId): void {
		const count = this.participantBackendWork.get(participantId) ?? 0;
		if (count <= 1) this.participantBackendWork.delete(participantId);
		else this.participantBackendWork.set(participantId, count - 1);
	}

	hasActiveWork(): boolean {
		if (this.agentLoops.size > 0 || this.participantBackendWork.size > 0 || this.authorityTransferBlocks.size > 0 || this.contextNavigationBlocks.size > 0) return true;
		for (const [id, runtime] of this.runtimes) {
			if (runtime.isRunning() || (this.activeTools.get(id) ?? 0) > 0) return true;
			if (runtime instanceof TermParticipantRuntime && runtime.term.lifecycle().lifecycle !== "stopped") return true;
		}
		return this.stopRequests.size > 0;
	}

	async branch(participantId: ParticipantId, targetId: ParticipantId, name: string, stateId?: VersionId): Promise<void> {
		await this.navigateAgentHistory(participantId, targetId, { kind: "branch", name, stateId });
	}

	async switchBranch(participantId: ParticipantId, targetId: ParticipantId, name: string): Promise<void> {
		await this.navigateAgentHistory(participantId, targetId, { kind: "switch", name });
	}

	/** Human /tree selections may point to raw Pi entries; anchor them exactly. */
	async rewindPiEntry(participantId: ParticipantId, targetId: ParticipantId, entryId: string, sessionManager: SessionManager, navigate?: (entryId: string) => Promise<void>): Promise<void> {
		await this.navigateAgentHistory(participantId, targetId, { kind: "tree", entryId, sessionManager }, navigate);
	}

	async rewind(participantId: ParticipantId, targetId: ParticipantId, stateId: VersionId, navigateOverride?: (entryId: string) => Promise<void>): Promise<void> {
		await this.navigateAgentHistory(participantId, targetId, { kind: "rewind", stateId }, navigateOverride);
	}

	isHistoryNavigationPending(participantId: ParticipantId): boolean {
		return this.contextNavigationBlocks.has(participantId);
	}

	private async navigateAgentHistory(
		participantId: ParticipantId,
		targetId: ParticipantId,
		operation: { kind: "branch"; name: string; stateId?: VersionId } | { kind: "switch"; name: string } | { kind: "rewind"; stateId: VersionId } | { kind: "tree"; entryId: string; sessionManager: SessionManager },
		navigateOverride?: (entryId: string) => Promise<void>,
	): Promise<void> {
		targetId = this.resolveParticipantRef(targetId);
		const branches = this.authority.agentBranches(targetId);
		if (operation.kind === "branch") this.authority.requireNewAgentBranch(targetId, operation.name);
		let stateId = operation.kind === "switch" ? this.authority.agentBranchHead(targetId, operation.name)
			: operation.kind === "tree" ? branches.heads[branches.current] : operation.stateId ?? branches.heads[branches.current];
		if (!stateId) throw new Error(`AGENT_HISTORY_EMPTY: ${targetId} has no typed checkpoint yet`);
		this.authority.requireRewind(participantId, targetId, stateId);
		if (this.contextNavigationBlocks.has(targetId)) throw new Error(`Linden context navigation is already pending for ${targetId}`);
		if ((this.authorityTransferBlocks.get(targetId) ?? 0) > 0) throw new Error(`Linden authority transfer is pending for ${targetId}; retry ${operation.kind} after it completes`);
		if (this.stopRequests.has(targetId) || this.stopping.has(targetId)) throw new Error(`Linden stop is pending for ${targetId}; retry ${operation.kind} after it completes`);
		if (operation.kind === "switch" && branches.current === operation.name) return;

		this.contextNavigationBlocks.add(targetId);
		try {
			await this.restoreParticipant(targetId);
			const runtime = this.runtime(targetId);
			const navigate = navigateOverride ?? (runtime.navigate ? runtime.navigate.bind(runtime) : undefined);
			if (!navigate || !runtime.appendRuntimeNotice) throw new Error(`Participant ${targetId} does not expose controllable Pi tree navigation`);
			const wasRunning = runtime.isRunning() || this.agentLoops.has(targetId) || (this.activeTools.get(targetId) ?? 0) > 0;
			await this.waitForActiveToolCompletion(targetId, "rewind");
			if (wasRunning || runtime.isRunning() || this.agentLoops.has(targetId)) {
				await runtime.abort();
				await this.waitForAgentForegroundIdle(targetId);
			}
			// Seal all persisted messages before leaving the source branch. This also
			// gives "branch from current" an exact typed anchor for Pi navigation.
			const source = await this.sealAgentContext(targetId);
			const sourceLeafId = this.agentRuntime(targetId).leafId() ?? source.piEntryId;
			const recoverNavigate = runtime.navigate?.bind(runtime) ?? navigate;
			if (operation.kind === "tree") {
				const manager = operation.sessionManager;
				if (manager.getSessionId() !== runtime.piSessionId) throw new Error("STATE_SCOPE_MISMATCH: Pi session does not belong to this Agent");
				const entry = manager.getEntry(operation.entryId);
				if (!entry) throw new Error(`Unknown Pi entry ${operation.entryId}`);
				const existing = Object.values(this.authority.snapshot().agentStates).find((node) => node.participantId === targetId && node.piEntryId === entry.id);
				if (existing && entry.type !== "custom_message" && !(entry.type === "message" && entry.message.role === "user")) stateId = existing.id;
				else {
					const parentState = this.nearestAgentState(targetId, entry.id);
					const historical = parentState ? this.authority.snapshot().checkpoints[parentState.checkpointId] : undefined;
					const envelope = this.authority.checkpointEnvelope(targetId);
					if (historical) { envelope.ledgerSequence = historical.ledgerSequence; envelope.authority = historical.authority; }
					try {
						manager.branch(entry.id);
						const anchorId = manager.appendCustomEntry(CHECKPOINT_ENTRY, { ...envelope, toolName: "tree-anchor" });
						const anchor = await this.authority.recordCheckpoint(envelope, anchorId, entry.id, parentState?.id, false);
						stateId = anchor.id;
						manager.branch(sourceLeafId);
					} catch (error) {
						await recoverNavigate(source.piEntryId);
						throw error;
					}
				}
			}
			if (operation.kind === "branch" && operation.stateId === undefined) stateId = source!.id;
			const node = this.authority.requireRewind(participantId, targetId, stateId);
			if (operation.kind === "branch") this.authority.requireNewAgentBranch(targetId, operation.name);
			let effect;
			try {
				await navigate(node.piEntryId);
				effect = await this.authority.commitAgentNavigation(participantId, targetId, stateId,
					operation.kind === "rewind" || operation.kind === "tree" ? undefined : { name: operation.name, create: operation.kind === "branch" });
			} catch (error) {
				if (source) await recoverNavigate(source.piEntryId);
				throw error;
			}
			await this.appendRewindNoticeAfterCommit(targetId, stateId, node.piEntryId, effect.sequence);
		} finally {
			const activateDeferredMailbox = this.mailboxActivationDeferredByNavigation.delete(targetId);
			this.contextNavigationBlocks.delete(targetId);
			await this.refreshLifecycleStatuses().catch(() => undefined);
			if (activateDeferredMailbox && this.authority.participant(targetId)) {
				this.trackBackgroundOperation(this.activateMailbox(targetId).catch((error) => {
					this.emitRuntimeWarning("LINDEN_POST_COMMIT_ADAPTER_FAILED", `Mailbox activation after context navigation failed for ${targetId}`, error);
				}));
			}
		}
	}

	private async sealAgentContext(participantId: ParticipantId): Promise<AgentStateNode> {
		const runtime = this.agentRuntime(participantId);
		const branches = this.authority.agentBranches(participantId);
		const head = this.authority.snapshot().agentStates[branches.heads[branches.current]];
		const entries = new Map(runtime.entries().map((entry) => [entry.id, entry]));
		let cursor = runtime.leafId();
		const seen = new Set<string>();
		while (cursor && !seen.has(cursor)) {
			if (cursor === head?.piEntryId) return head;
			seen.add(cursor);
			const entry = entries.get(cursor);
			if (entry?.type !== "label") break;
			cursor = entry.parentId;
		}
		return (await this.appendCheckpoint(participantId, "history-navigation"))!;
	}

	private async waitForAgentForegroundIdle(participantId: ParticipantId): Promise<void> {
		const deadline = Date.now() + 300_000;
		while (this.runtimes.get(participantId)?.isRunning()
			|| this.agentLoops.has(participantId)
			|| (this.activeTools.get(participantId) ?? 0) > 0
			|| (this.participantBackendWork.get(participantId) ?? 0) > 0) {
			if (this.disposed) throw new Error(`PI_COORDINATOR_DISPOSING: stopped waiting to rewind ${participantId}`);
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${participantId} to become quiescent before rewind`);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
		}
	}

	async appendRewindNoticeAfterCommit(targetId: ParticipantId, stateId: VersionId, parentPiEntryId: string, rewindEffectSequence: number): Promise<void> {
		try {
			const runtime = this.runtime(targetId);
			if (!runtime.appendRuntimeNotice) throw new Error(`Participant ${targetId} cannot append a rewind notice`);
			const noticeEntryId = await runtime.appendRuntimeNotice(this.authority.rewindNotice(targetId, stateId, rewindEffectSequence), { continueLoop: false, kind: "rewind" });
			await this.recordExistingCheckpoint(targetId, noticeEntryId, parentPiEntryId, "rewind-notice");
		} catch (error) {
			this.emitRuntimeWarning(
				"LINDEN_POST_COMMIT_ADAPTER_FAILED",
				`Rewind to ${stateId} committed for ${targetId}, but its Pi notice/checkpoint could not be recorded`,
				error,
			);
		}
	}

	async appendCheckpoint(participantId: ParticipantId, toolName: string): Promise<AgentStateNode | undefined> {
		const participant = this.authority.participant(participantId);
		if (!participant) throw new Error(`Unknown participant ${participantId}`);
		// Pi typed checkpoints are the reversible state of Agent context only.
		// Human and Term effects remain in the session ledger without fabricating
		// an Agent history for those participant kinds.
		if (participant.kind !== "agent") return undefined;
		const runtime = this.agentRuntime(participantId);
		const parentPiEntryId = runtime.leafId() ?? undefined;
		const parentState = this.nearestAgentState(participantId, parentPiEntryId);
		const envelope = this.authority.checkpointEnvelope(participantId);
		const entryId = await runtime.appendEntry(CHECKPOINT_ENTRY, { ...envelope, toolName });
		runtime.setLabel(entryId, `linden:${toolName}`);
		return this.authority.recordCheckpoint(envelope, entryId, parentPiEntryId, parentState?.id);
	}

	/**
	 * A checkpoint spans Pi's session file and Linden's ledger, so it cannot be
	 * atomic with an authority effect that has already committed. Never turn a
	 * real committed operation into an ambiguous failure: report degraded trace
	 * recording and let the caller return the committed result.
	 */
	async appendCheckpointAfterCommit(participantId: ParticipantId, toolName: string): Promise<AgentStateNode | undefined> {
		try { return await this.appendCheckpoint(participantId, toolName); }
		catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.emitRuntimeWarning(
				"LINDEN_POST_COMMIT_CHECKPOINT_FAILED",
				`${toolName} for ${participantId} committed, but its Pi checkpoint could not be recorded`,
				detail,
			);
			return undefined;
		}
	}

	private async startInitialPrompt(participantId: ParticipantId, session: AgentSession, prompt: string, outcome: SpawnOutcome): Promise<boolean> {
		let preflightStatus: boolean | undefined;
		let preflightError: unknown;
		let resolvePreflight!: (accepted: boolean) => void;
		const preflight = new Promise<boolean>((resolvePromise) => { resolvePreflight = resolvePromise; });
		let resolveOperationSettled!: () => void;
		const operationSettled = new Promise<void>((resolvePromise) => { resolveOperationSettled = resolvePromise; });
		const reportPreflight = (accepted: boolean): void => {
			if (preflightStatus !== undefined) return;
			preflightStatus = accepted;
			outcome.turnPending = accepted;
			resolvePreflight(accepted);
		};
		const rejectedWarning = (error?: unknown): SpawnWarning => ({
			code: "LINDEN_INITIAL_PROMPT_REJECTED",
			message: "The participant was created, but Pi rejected its initial prompt before starting a model turn.",
			detail: this.runtimeErrorDetail(error),
		});

		let operation: Promise<void>;
		try {
			operation = session.prompt(prompt, {
				expandPromptTemplates: false,
				source: "extension",
				preflightResult: reportPreflight,
			});
		} catch (error) {
			reportPreflight(false);
			outcome.warnings.push(rejectedWarning(error));
			this.emitRuntimeWarning("LINDEN_INITIAL_PROMPT_REJECTED", `${participantId} initial prompt failed synchronously`, error);
			this.agentLoops.delete(participantId);
			await this.refreshLifecycleStatuses().catch(() => undefined);
			return false;
		}

		// Pi's preflight callback resolves spawn as soon as the prompt is accepted;
		// this handler owns the rest of the turn and can never reject unobserved.
		const completion = operation.then(
			() => {
				if (preflightStatus === undefined) reportPreflight(true);
				outcome.turnPending = false;
				resolveOperationSettled();
			},
			async (error) => {
				if (preflightStatus === undefined) reportPreflight(false);
				if (!preflightStatus) {
					preflightError = error;
				} else {
					const warning: SpawnWarning = {
						code: "LINDEN_INITIAL_PROMPT_FAILED",
						message: "Pi accepted the initial prompt, but the model turn later failed.",
						detail: this.runtimeErrorDetail(error),
					};
					const diagnostics = this.runtimeDiagnostics.get(participantId) ?? [];
					diagnostics.push(warning);
					this.runtimeDiagnostics.set(participantId, diagnostics);
					this.emitRuntimeWarning(warning.code, `${participantId} initial model turn failed`, error);
				}
				outcome.turnPending = false;
				resolveOperationSettled();
				this.agentLoops.delete(participantId);
				await this.refreshLifecycleStatuses().catch(() => undefined);
			},
		);
		this.trackBackgroundOperation(completion);
		const accepted = await preflight;
		if (!accepted) {
			// Pi 0.84.2 calls preflightResult(false) immediately before rejecting.
			// Wait at most one event-loop turn for that cause; a third-party hosted
			// runtime that reports false but never settles must not hang spawn.
			await Promise.race([operationSettled, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0))]);
			const warning = rejectedWarning(preflightError);
			outcome.warnings.push(warning);
			this.emitRuntimeWarning(warning.code, `${participantId} was created without starting its initial prompt`, preflightError);
			this.agentLoops.delete(participantId);
			await this.refreshLifecycleStatuses().catch(() => undefined);
		}
		return accepted;
	}

	private emitRuntimeWarning(code: SpawnWarning["code"], message: string, error?: unknown): void {
		const detail = this.runtimeErrorDetail(error);
		try { process.emitWarning(message, { type: "LindenRuntimeWarning", code, detail }); }
		catch { /* warnings must never alter the committed operation */ }
	}

	private runtimeErrorDetail(error: unknown): string | undefined {
		return error === undefined ? undefined : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}

	async recordExistingCheckpoint(participantId: ParticipantId, entryId: string, parentPiEntryId: string | undefined, toolName: string): Promise<AgentStateNode> {
		const envelope: CheckpointEnvelope = this.authority.checkpointEnvelope(participantId);
		this.agentRuntime(participantId).setLabel(entryId, `linden:${toolName}`);
		const parentState = this.nearestAgentState(participantId, parentPiEntryId);
		return this.authority.recordCheckpoint(envelope, entryId, parentPiEntryId, parentState?.id);
	}

	describeAuthority(viewerId: ParticipantId, targetId: ParticipantId = viewerId): string {
		viewerId = this.resolveParticipantRef(viewerId);
		targetId = this.resolveParticipantRef(targetId);
		const state = this.authority.snapshot();
		const participant = state.participants[targetId];
		if (!participant) throw new Error(`Unknown participant ${targetId}`);
		if (targetId !== viewerId) this.authority.requireListen(viewerId, targetId);
		const snapshot = this.authority.authoritySnapshot(targetId);
		const effective = this.authority.effectiveAuthority(targetId);
		const formatFileExpression = (expression: PathExpression): string => {
			const include = Object.values(state.resources).find((resource) => (resource.kind === "file" || resource.kind === "file-region") && resource.path === expression.include)?.id ?? fileResourceId(expression.include, true);
			const exclusions = expression.exclude.map((path) => Object.values(state.resources).find((resource) => (resource.kind === "file" || resource.kind === "file-region") && resource.path === path)?.id ?? fileResourceId(path));
			return exclusions.length ? `${include} - ${exclusions.join(" - ")}` : include;
		};
		return [
			`workspace: ${state.sessionId}`,
			`root: ${state.base}`,
			`max Agent depth: ${formatMaxAgentDepth(this.authority.maxAgentDepth)}`,
			`participant depth: ${this.authority.participantDepth(targetId)}`,
			`participant: ${targetId}`,
			`parent: ${participant.parentId ?? "none"}`,
			`children: ${participant.childIds.join(", ") || "none"}`,
			`held: ${authoritySummary(state, [targetId])}`,
			`managed: ${authoritySummary(state, managedParticipants(state, targetId))}`,
			`permission: ${participant.permissionMode ?? "manual"}`,
			`owned resources: ${snapshot.owned.join(", ") || "none"}`,
			`read pointers: ${snapshot.pointers.join(", ") || "none"}`,
			`effective write regions: ${effective.writeExpressions.map(formatFileExpression).join(", ") || "none"}`,
			`effective read regions: ${effective.readExpressions.map(formatFileExpression).join(", ") || "none"}`,
			`effective Net endpoints: ${(effective.netEndpoints ?? []).join(", ") || "none"}`,
		].join("\n");
	}

	formatParticipantTree(viewerId: ParticipantId): string {
		const state = this.authority.snapshot();
		return formatParticipants(state, viewerId, (participant) => this.runtimes.get(participant.id)?.displayName?.() ?? participant.name);
	}

	async discoverParticipantTree(viewerId: ParticipantId): Promise<string> {
		const state = await this.authority.discoverParticipants(viewerId);
		return formatParticipants(state, viewerId, (participant) => this.runtimes.get(participant.id)?.displayName?.() ?? participant.name);
	}

	async formatParticipantTreeBirthSnapshot(viewerId: ParticipantId): Promise<string> {
		return [
			"[Linden participant tree at Agent birth]",
			"This point-in-time snapshot was taken immediately before this Agent's first model turn:",
			await this.discoverParticipantTree(viewerId),
			"You now hold ordinary read-only participant pointers to the nodes shown here. You can send directly to Human or Agent participants regardless of ancestry; these pointers grant no file access or lifecycle control.",
			"The topology can change after birth. Call participants to refresh the tree and acquire pointers to newly discovered participants before messaging or delegating later.",
		].join("\n");
	}

	async formatParticipantLog(participantId: ParticipantId, targetOrResource: string): Promise<string> {
		const state = this.authority.snapshot();
		if (state.resources[targetOrResource]) return this.formatResourceLog(participantId, targetOrResource);
		const targetId = this.resolveParticipantRef(targetOrResource);
		const target = this.authority.participant(targetId);
		if (!target) throw new Error(`Unknown participant ${targetId}`);
		if (target.kind === "agent") return this.formatAgentLog(participantId, targetId);
		if (target.kind === "term") return this.formatTermLog(participantId, targetId);
		throw new Error(`PARTICIPANT_KIND_MISMATCH: log history is not defined for Human participant ${targetId}`);
	}

	formatTermLog(participantId: ParticipantId, targetId: ParticipantId): string {
		targetId = this.resolveParticipantRef(targetId);
		const entries = this.authority.termEpochLog(participantId, targetId);
		if (!entries.length) return `No Term epochs for ${targetId}.`;
		const lines = [`Term ${targetId} history:`];
		for (const { epoch, trace } of entries) {
			lines.push(
				`epoch-id=${epoch.id} effect-id=${epoch.effectId} status=${epoch.status} started=${new Date(epoch.startedAt).toISOString()} ended=${new Date(epoch.endedAt).toISOString()} forced=${epoch.forced ? "yes" : "no"} recovered=${epoch.recovered ? "yes" : "no"} trace-complete=${trace.complete ? "yes" : "no"} output-range=${trace.output.start}..${trace.output.end} truncated-before=${trace.output.truncatedBefore ? "yes" : "no"}${trace.missingReason ? ` missing-reason=${trace.missingReason}` : ""}${trace.error === undefined ? "" : ` error=${JSON.stringify(trace.error)}`}`,
			);
			for (const command of trace.commands) {
				lines.push(
					`  command-id=${command.id} started=${command.startedAt} ended=${command.endedAt} exit-code=${command.exitCode} output-range=${command.outputStart}..${command.outputEnd} command=${JSON.stringify(command.command)}`,
				);
			}
			lines.push("  output:", trace.output.data || "  (empty)");
		}
		return lines.join("\n");
	}

	async formatAgentLog(participantId: ParticipantId, targetId: ParticipantId): Promise<string> {
		targetId = this.resolveParticipantRef(targetId);
		const nodes = this.authority.agentStateLog(participantId, targetId);
		await this.restoreParticipant(targetId);
		const runtime = this.agentRuntime(targetId);
		const entries = runtime.entries();
		const branches = this.authority.agentBranches(targetId);
		const nodesByEntry = new Map(nodes.map((node) => [node.piEntryId, node]));
		const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
		const nearestByEntry = new Map<string, AgentStateNode | undefined>();
		const nearestFor = (entryId: string): AgentStateNode | undefined => {
			const chain: string[] = [];
			const seen = new Set<string>();
			let cursor: string | null = entryId;
			let nearest: AgentStateNode | undefined;
			while (cursor) {
				if (nearestByEntry.has(cursor)) { nearest = nearestByEntry.get(cursor); break; }
				nearest = nodesByEntry.get(cursor);
				if (nearest || seen.has(cursor)) break;
				seen.add(cursor);
				chain.push(cursor);
				cursor = entriesById.get(cursor)?.parentId ?? null;
			}
			for (const id of chain) nearestByEntry.set(id, nearest);
			return nearest;
		};
		const tree = entries.map((entry) => {
			const typed = nodesByEntry.get(entry.id);
			const nearest = nearestFor(entry.id);
			const names = Object.entries(branches.heads).filter(([, head]) => head === typed?.id).map(([name]) => name === branches.current ? `${name} (current)` : name);
			return `${entry.id === runtime.leafId() ? "*" : " "} pi-id=${entry.id} parent-pi-id=${entry.parentId ?? "none"} rewindable=${typed ? "yes" : "no"} typed-state=${typed?.id ?? "none"} nearest-typed-state=${nearest?.id ?? "none"}${names.length ? ` branches=${names.join(",")}` : ""} summary=${entryText(entry)}`;
		}).join("\n") || "No Pi entries.";
		const refs = Object.entries(branches.heads).map(([name, id]) => `${name === branches.current ? "*" : " "} ${name} -> ${id} (pi-id=${nodes.find((node) => node.id === id)?.piEntryId ?? "none"})`);
		return `Current branch: ${branches.current}\nBranches:\n${refs.join("\n") || "none"}\n${tree}`;
	}

	private readMailPayload(record: MessageRecord, coldSessions: Map<ParticipantId, SessionManager>): MailPayload | undefined {
		const live = this.runtimes.get(record.senderId);
		if (live) return live.readPayload?.(record.payloadEntryId);
		let manager = coldSessions.get(record.senderId);
		if (!manager) {
			const participant = this.authority.participant(record.senderId) ?? this.authority.participantTombstone(record.senderId);
			if (participant?.kind === "human") return this.authority.store.readPrivatePayload<MailPayload>(record.payloadEntryId);
			if (!participant || participant.kind !== "agent" || !participant.sessionFile) return undefined;
			manager = this.openPersistedSessionManager(record.senderId, participant.sessionFile).manager;
			coldSessions.set(record.senderId, manager);
		}
		return customEntry(manager.getEntry(record.payloadEntryId));
	}

	private nearestAgentState(participantId: ParticipantId, startPiEntryId: string | undefined, persistedEntries?: SessionEntry[]): AgentStateNode | undefined {
		if (!startPiEntryId) return undefined;
		const state = this.authority.snapshot();
		const nodesByEntry = new Map(Object.values(state.agentStates).filter((node) => node.participantId === participantId).map((node) => [node.piEntryId, node]));
		const entries = new Map((persistedEntries ?? this.agentRuntime(participantId).entries()).map((entry) => [entry.id, entry]));
		let cursor: string | null = startPiEntryId;
		const seen = new Set<string>();
		while (cursor) {
			if (seen.has(cursor)) break;
			seen.add(cursor);
			const node = nodesByEntry.get(cursor);
			if (node) return structuredClone(node);
			cursor = entries.get(cursor)?.parentId ?? null;
		}
		return undefined;
	}

	formatResourceLog(participantId: ParticipantId, resourceId: ResourceId): string {
		return this.authority.resourceLog(participantId, resourceId).map((node) => `${node.current ? "*" : " "} id=${node.id} parent=${node.parent ?? "none"} summary=${node.summary}`).join("\n");
	}

	private async deliverPending(targetId: ParticipantId, kind: MessageKind): Promise<void> {
		if (!this.authority.participant(targetId)) return;
		if (this.contextNavigationBlocks.has(targetId)) {
			this.mailboxActivationDeferredByNavigation.add(targetId);
			if (kind === "follow_up") this.followUpsWaitingForIdle.add(targetId);
			return;
		}
		const batchId = `mail-batch:${randomId()}`;
		const records = await this.authority.claimPendingMessages(targetId, kind, batchId);
		if (!records.length) return;
		if (!this.authority.participant(targetId)) {
			await this.authority.releaseDelivery(targetId, batchId);
			return;
		}
		try {
				const target = this.messageRuntime(targetId);
			const coldSessions = new Map<ParticipantId, SessionManager>();
			const messages = records.map((record): DeliveredMail => {
				const payload = this.readMailPayload(record, coldSessions);
				if (!payload || payload.messageId !== record.id || payload.senderId !== record.senderId) throw new Error(`Mailbox payload ${record.payloadEntryId} does not match ledger message ${record.id}`);
				return { id: record.id, senderId: record.senderId, payload: payload.payload };
			});
			const delivery = target.deliverBatch({ batchId, kind, messages }).then(async () => {
				if (this.mailboxWakeSuspended.has(targetId)) await this.authority.acknowledgeDelivery(targetId, batchId);
			});
			const recovery = delivery.catch(async () => {
				await this.authority.releaseDelivery(targetId, batchId);
				if (kind === "steering") this.scheduleSteeringRetry(targetId);
				else this.scheduleFollowUpFlush(targetId);
			});
			this.trackBackgroundOperation(recovery);
		} catch (error) {
			await this.authority.releaseDelivery(targetId, batchId);
			if (kind === "steering") this.scheduleSteeringRetry(targetId);
			throw error;
		}
	}

	private scheduleSteeringRetry(targetId: ParticipantId): void {
		if (this.disposed || this.mailboxWakeSuspended.has(targetId) || !this.runtimes.has(targetId) || !this.authority.participant(targetId) || this.steeringRetryTimers.has(targetId)) return;
		const delay = Math.min((this.steeringRetryDelays.get(targetId) ?? 25) * 2, 1_000);
		this.steeringRetryDelays.set(targetId, delay);
		const timer = setTimeout(() => {
			this.steeringRetryTimers.delete(targetId);
			if (this.disposed || !this.runtimes.has(targetId)) return;
			this.trackBackgroundOperation(this.activateMailbox(targetId));
		}, delay);
		this.steeringRetryTimers.set(targetId, timer);
	}

	private scheduleFollowUpFlush(targetId: ParticipantId): void {
		if (targetId === this.authority.rootParticipantId || this.disposed) return;
		if (this.mailboxWakeSuspended.has(targetId)) {
			this.trackBackgroundOperation(this.deliverPending(targetId, "follow_up"));
			return;
		}
		// A cold Agent keeps its durable follow-ups until an explicit operation
		// activates its mailbox; automatic finals must not recursively restore an
		// otherwise dormant participant tree.
		if (!this.runtimes.has(targetId)) return;
		if (!this.authority.participant(targetId)) {
			this.followUpsWaitingForIdle.delete(targetId);
			return;
		}
		if (this.contextNavigationBlocks.has(targetId)) {
			this.mailboxActivationDeferredByNavigation.add(targetId);
			this.followUpsWaitingForIdle.add(targetId);
			return;
		}
		if (this.runtime(targetId).isRunning()) {
			// agent_end is the state transition that makes this deliverable. Keeping
			// one marker avoids a 25 ms timer per busy Agent.
			this.followUpsWaitingForIdle.add(targetId);
			return;
		}
		this.followUpsWaitingForIdle.delete(targetId);
		if (this.followUpTimers.has(targetId)) return;
		const flush = (): void => {
			this.followUpTimers.delete(targetId);
			if (this.disposed || !this.authority.participant(targetId) || !this.runtimes.has(targetId)) return;
			if (this.contextNavigationBlocks.has(targetId)) {
				this.mailboxActivationDeferredByNavigation.add(targetId);
				this.followUpsWaitingForIdle.add(targetId);
				return;
			}
			if (this.runtime(targetId).isRunning()) {
				this.followUpsWaitingForIdle.add(targetId);
				return;
			}
			const delivery = this.deliverPending(targetId, "follow_up").then(() => {
				if (this.authority.pendingMessages(targetId, undefined, "follow_up").length) this.scheduleFollowUpFlush(targetId);
			});
			this.trackBackgroundOperation(delivery);
		};
		const timer = setTimeout(flush, 0);
		this.followUpTimers.set(targetId, timer);
	}

	private clearSteering(records: MessageRecord[]): void {
		const blocked = this.steeringBlocks.get(records[0]?.targetId);
		if (!blocked) return;
		for (const record of records) blocked.delete(record.id);
		if (blocked.size === 0 && records[0]) {
			const targetId = records[0].targetId;
			this.steeringBlocks.delete(targetId);
			const timer = this.steeringRetryTimers.get(targetId);
			if (timer) clearTimeout(timer);
			this.steeringRetryTimers.delete(targetId);
			this.steeringRetryDelays.delete(targetId);
		}
	}

	private async withTopologyLock<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.topologyTail;
		let release!: () => void;
		this.topologyTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try { return await operation(); }
		finally { release(); }
	}

	private async publishPreparedRuntime<T extends ParticipantRuntime>(
		participantId: ParticipantId,
		prepared: T,
		expectedKind: "agent" | "term",
		allowExisting: boolean,
	): Promise<T | ParticipantRuntime> {
		let published: ParticipantRuntime | undefined;
		let failure: Error | undefined;
		await this.withTopologyLock(() => {
			const participant = this.authority.participant(participantId);
			if (!participant) {
				failure = new Error(`Participant ${participantId} was removed before its runtime could be published`);
				return;
			}
			if (participant.kind !== expectedKind) {
				failure = new Error(`PARTICIPANT_KIND_MISMATCH: ${participantId} is ${participant.kind}, expected ${expectedKind}`);
				return;
			}
			const existing = this.runtimes.get(participantId);
			if (existing && existing !== prepared) {
				if (allowExisting) published = existing;
				else failure = new Error(`Participant ${participantId} already has a published runtime adapter`);
				return;
			}
			this.runtimes.set(participantId, prepared);
			published = prepared;
		});
		if (published !== prepared) {
			try { await this.disposeRuntimeOnce(prepared); }
			catch (cleanupError) {
				if (failure) throw new AggregateError([failure, cleanupError], `Runtime ${participantId} could not be published or disposed`, { cause: failure });
				throw cleanupError;
			}
		}
		if (failure) throw failure;
		if (!published) throw new Error(`Runtime ${participantId} was not published`);
		return published;
	}

	private async runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) throw new Error("PI_COORDINATOR_DISPOSING: no new runtime operation can start");
		this.activeLifecycleOperations += 1;
		try {
			// Start in a microtask so callers can publish single-flight placeholders
			// before a hosted factory has any opportunity to re-enter the coordinator.
			return await Promise.resolve().then(operation);
		} finally {
			this.finishLifecycleOperation();
		}
	}

	private finishLifecycleOperation(): void {
		this.activeLifecycleOperations -= 1;
		if (this.activeLifecycleOperations === 0) {
			for (const resolvePromise of this.lifecycleDrainWaiters) resolvePromise();
			this.lifecycleDrainWaiters.clear();
		}
	}

	private waitForLifecycleDrain(): Promise<void> {
		if (this.activeLifecycleOperations === 0) return Promise.resolve();
		return new Promise<void>((resolvePromise) => { this.lifecycleDrainWaiters.add(resolvePromise); });
	}

	private trackBackgroundOperation(operation: Promise<unknown>): void {
		this.backgroundOperations.add(operation);
		void operation.finally(() => { this.backgroundOperations.delete(operation); }).catch(() => undefined);
	}

	private scheduleBackgroundOperation(operation: () => Promise<unknown>): void {
		if (this.disposed) return;
		const pending = new Promise<void>((resolvePromise, reject) => {
			setTimeout(() => {
				if (this.disposed) { resolvePromise(); return; }
				Promise.resolve().then(operation).then(() => resolvePromise(), reject);
			}, 0);
		});
		this.trackBackgroundOperation(pending);
	}

	private disposeRuntimeOnce(runtime: ParticipantRuntime): Promise<void> {
		const existing = this.runtimeDisposals.get(runtime);
		if (existing) return existing;
		const disposal = Promise.resolve().then(() => runtime.dispose?.());
		this.runtimeDisposals.set(runtime, disposal);
		return disposal;
	}

	private startRuntimeDisposals(): Promise<void>[] {
		for (const runtime of this.runtimes.values()) {
			if (runtime === this.root) continue;
			this.disposeRuntimeOnce(runtime);
		}
		return [...this.runtimeDisposals.values()];
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		for (const timer of this.followUpTimers.values()) clearTimeout(timer);
		this.followUpTimers.clear();
		this.followUpsWaitingForIdle.clear();
		this.mailboxActivationDeferredByNavigation.clear();
		for (const waits of this.activeParticipantWaits.values()) {
			for (const waiter of waits) if (!waiter.controller.signal.aborted) waiter.controller.abort(WAIT_INTERRUPTED_BY_DISPOSE);
		}
		for (const timer of this.steeringRetryTimers.values()) clearTimeout(timer);
		this.steeringRetryTimers.clear();
		this.steeringRetryDelays.clear();
		const lease = this.sessionLease;
		this.sessionLease = undefined;
		this.disposePromise = (async () => {
			const failures: unknown[] = [];
			// First abort every runtime already published. This lets an admitted spawn
			// or restore escape checkpoint/preflight I/O that only shutdown can settle.
			const firstWave = this.startRuntimeDisposals();
			await Promise.allSettled([this.waitForLifecycleDrain(), ...firstWave]);
			// A factory admitted before closing may publish after the first snapshot.
			// The operation drain makes this second snapshot final.
			this.startRuntimeDisposals();
			const results = await Promise.allSettled([...this.runtimeDisposals.values()]);
			for (const result of results) if (result.status === "rejected") failures.push(result.reason);
			// Runtime disposal triggers abort, but Pi does not guarantee that the
			// model-turn Promise and its authority callbacks have settled yet. Drain
			// to a fixed point because a completion handler may register one final
			// status/checkpoint operation while an earlier snapshot is settling.
			while (this.backgroundOperations.size) await Promise.allSettled([...this.backgroundOperations]);
			// A rejected runtime disposal does not prove that its listeners or model
			// turn are silent. Fail closed by retaining the active lease; the PID-based
			// registry can reclaim it only after this process exits.
			if (failures.length === 0) {
				try { lease?.release(); } catch (error) { failures.push(error); }
			}
			if (failures.length) throw new AggregateError(failures, "Pi coordinator did not dispose cleanly");
		})();
		return this.disposePromise;
	}

	private subscribeRuntime(runtime: ChildParticipantRuntime): void {
		const participantId = runtime.participantId;
		runtime.session.subscribe((event) => {
			if (event.type === "message_start") this.trackBackgroundOperation(this.handleRuntimeMessage(participantId, event.message));
			if (event.type === "agent_start") this.trackBackgroundOperation(this.handleAgentStart(participantId));
			if (event.type === "agent_end") this.trackBackgroundOperation(this.handleAgentEnd(participantId, event.willRetry));
		});
	}

	hostedRuntime(participantId: ParticipantId): HostedParticipantRuntime {
		const runtime = this.runtime(participantId);
		if (!(runtime instanceof HostedParticipantRuntime)) throw new Error(`Participant ${participantId} is not owned by the standalone Pi host`);
		return runtime;
	}
}

export function summarizeMessage(payload: string, maxCharacters = 120): string {
	const normalized = payload.replace(/\s+/g, " ").trim();
	const characters = [...normalized];
	return characters.length <= maxCharacters ? normalized : `${characters.slice(0, maxCharacters).join("")}…`;
}

function randomId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

export function toolNames(): string[] {
	return ["read", "write", "edit", "bash", "stat", "spawn", "send", "steer", "listen", "wait", "interrupt", "stop", "exec", "input", "receive", "participants", "give", "get", "checkout", "branch", "switch", "rewind", "log", "archive", "unarchive", "fork", "permission", "publish", "unpublish", "authority"];
}
