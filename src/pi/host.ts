import {
	AgentSessionRuntime,
	InteractiveMode,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { SessionAuthorityManager } from "../runtime/manager.js";
import type { ParticipantId, ResourceId } from "../runtime/model.js";
import { SessionLease, SessionRegistry, type SessionManifest } from "../runtime/sessions.js";
import { stateDirectory } from "../runtime/store.js";
import { normalizeMaxAgentDepth } from "../runtime/agent-depth.js";
import { buildTools } from "./tools.js";
import {
	type ParticipantWaitTarget,
	type ParticipantWaitResult,
	type SpawnParticipantKind,
} from "./participant-api.js";
import {
	PiCoordinator,
	needsParticipantTreeBirthSnapshot,
	runtimeGuidanceForParticipant,
	summarizeMessage,
	toolNames,
	type DeliveredMail,
	type RuntimeGuidanceProfile,
} from "./runtime.js";

export interface StandalonePiHostOptions {
	base?: string;
	/** Deprecated alias. */
	workspace?: string;
	session?: string;
	stateRoot?: string;
	webDomains?: string[];
	/** Maximum Agent edge depth below the human root for a new session. */
	maxAgentDepth?: number;
	/** Evaluator-scoped ports bridged from isolated Term namespaces to parent loopback. */
	termLoopbackPorts?: number[];
	/** Optional evaluator-visible directory mounted as Bash/Term /tmp. */
	sandboxTmpPath?: string;
	/** Semantically equivalent concise guide for a runner-created fixed Agent team. */
	runtimeGuidanceProfile?: RuntimeGuidanceProfile;
	onHumanMessage?: (notice: HumanMessageNotice) => void;
}

export interface HumanMessageNotice {
	messageId: string;
	senderId: ParticipantId;
	preview: string;
}

export interface MailboxSummary extends HumanMessageNotice {
	index: number;
	senderName: string;
	sentAt: number;
}

export interface SpawnTopLevelOptions {
	/** Defaults to Agent for compatibility with the original host API. */
	kind?: SpawnParticipantKind;
	name?: string;
	prompt?: string;
	/** Resource IDs or path inputs; prefix & for a read grant, plain to move complete ownership. */
	grants?: string[];
	inheritWorkspaceRead?: boolean;
	cwd?: string;
	/** False exposes Term spawn only; fixed before the Agent's Pi tools are built. */
	agentSpawnEnabled?: boolean;
}

export class StandalonePiHost {
	readonly coordinator: PiCoordinator;
	readonly registry: SessionRegistry;
	readonly manifest: SessionManifest;
	/** Participant whose Pi UI currently has the human's attention, if any. */
	attachedParticipantId?: ParticipantId;
	private disposePromise?: Promise<void>;

	private constructor(
		readonly authority: SessionAuthorityManager,
		registry: SessionRegistry,
		manifest: SessionManifest,
		private readonly lease: SessionLease,
		private readonly onHumanMessage?: (notice: HumanMessageNotice) => void,
		termLoopbackPorts: readonly number[] = [],
		private readonly runtimeGuidanceProfile: RuntimeGuidanceProfile = "full",
	) {
		this.registry = registry;
		this.manifest = manifest;
		this.coordinator = PiCoordinator.createStandalone(authority);
		this.coordinator.setTermLoopbackPorts(termLoopbackPorts);
		this.coordinator.setToolFactory((coordinator, participantId, cwd) => buildTools(coordinator, participantId, cwd));
		this.coordinator.setHostedRuntimeFactory((participantId, sessionManager) => this.createRuntime(participantId, sessionManager));
		this.coordinator.setHumanMessageHandler((message, payload) => {
			this.onHumanMessage?.({ messageId: message.id, senderId: message.senderId, preview: summarizeMessage(payload) });
		});
		// While the human is attached to a session they observe finals live, so
		// those finals are consumed in place instead of becoming unread mail.
		this.coordinator.setHumanFinalConsumer(async (message) => {
			if (this.attachedParticipantId !== message.senderId) return false;
			await this.coordinator.receive(this.authority.rootParticipantId, message.senderId);
			return true;
		});
	}

	static async open(options: StandalonePiHostOptions): Promise<StandalonePiHost> {
		const registry = new SessionRegistry(options.stateRoot);
		const requestedMaxAgentDepth = normalizeMaxAgentDepth(options.maxAgentDepth);
		let manifest = options.session
			? registry.resolve(options.session)
			: registry.create(options.base ?? options.workspace ?? process.cwd(), undefined, { maxAgentDepth: requestedMaxAgentDepth });
		if (options.session && requestedMaxAgentDepth !== undefined && manifest.maxAgentDepth !== requestedMaxAgentDepth) {
			throw new Error(`Linden session maxAgentDepth is ${manifest.maxAgentDepth ?? "unlimited"}, not ${requestedMaxAgentDepth}`);
		}
		if (options.session && (options.base || options.workspace)) {
			const { canonicalBase } = await import("../runtime/paths.js");
			const requested = canonicalBase(options.base ?? options.workspace!);
			if (requested !== manifest.base) throw new Error(`Session ${manifest.id} has base ${manifest.base}, not ${requested}`);
		}
		const lease = registry.acquire(manifest);
		let host: StandalonePiHost | undefined;
		try {
			manifest = registry.touch(manifest);
			const authority = await SessionAuthorityManager.open({ base: manifest.base, lindenSessionId: manifest.id, webDomains: options.webDomains, maxAgentDepth: manifest.maxAgentDepth, stateRoot: registry.root, stateDir: stateDirectory(manifest.id, registry.root), sandboxTmpPath: options.sandboxTmpPath });
			host = new StandalonePiHost(authority, registry, manifest, lease, options.onHumanMessage, options.termLoopbackPorts, options.runtimeGuidanceProfile);
			// Restore exactly the Agents the previous Linden process saved as active.
			// Terms deliberately have no process handle to restore: coordinator.dispose()
			// stops and reconciles them, and a later Term operation reconstructs its
			// stopped runtime from the durable participant record on demand.
			await host.coordinator.restoreChildren(authority.loadProcessState()?.activeAgents ?? []);
			return host;
		} catch (error) {
			try {
				if (host) await host.dispose();
				else lease.release();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Standalone Linden host initialization failed and cleanup did not complete", { cause: error });
			}
			throw error;
		}
	}

	async spawnTopLevel(options: SpawnTopLevelOptions = {}): Promise<ParticipantId> {
		return this.spawnParticipant(options);
	}

	/** Spawn an Agent or Term as a direct child of the Human participant. */
	async spawnParticipant(options: SpawnTopLevelOptions = {}): Promise<ParticipantId> {
		const childId = await this.coordinator.spawnParticipant(this.authority.rootParticipantId, {
			kind: options.kind ?? "agent",
			name: options.name,
			prompt: options.prompt,
			resources: options.grants ?? [],
			inheritRead: options.inheritWorkspaceRead ?? true,
			cwd: options.cwd ?? this.authority.base,
			agentSpawnEnabled: options.agentSpawnEnabled ?? true,
			origin: "runner",
		});
		this.recordActiveState();
		return childId;
	}

	async attach(reference: string): Promise<{ participantId: ParticipantId; consumed: DeliveredMail[] }> {
		// Attach is Agent-specific. Terms are observed and controlled through the
		// generic listen/wait/exec/input surface instead of a Pi UI.
		const targetId = await this.ensureRuntime(reference);
		const prepared = await this.coordinator.prepareAttach(this.authority.rootParticipantId, targetId);
		const runtime = this.coordinator.hostedRuntime(prepared.targetId);
		this.attachedParticipantId = prepared.targetId;
		try {
			const ui = new InteractiveMode(runtime.runtimeHost, { verbose: false, detachable: true });
			await ui.run();
		} finally {
			if (this.attachedParticipantId === prepared.targetId) this.attachedParticipantId = undefined;
		}
		return { participantId: prepared.targetId, consumed: prepared.consumed };
	}

	/** Ensure an Agent has a live Pi runtime. Terms are never attachable. */
	async ensureRuntime(reference: string): Promise<ParticipantId> {
		const targetId = this.coordinator.resolveParticipantRef(reference);
		const participant = this.authority.participant(targetId);
		if (!participant || participant.kind !== "agent") throw new Error(`Participant ${targetId} has no restorable Pi session`);
		if (this.coordinator.runtimes.has(targetId)) return targetId;
		await this.coordinator.restoreParticipant(targetId);
		return targetId;
	}

	/**
	 * Write the current active Agent set; call whenever the set changes.
	 *
	 * Term process handles are intentionally absent from process-state.json. A
	 * clean host disposal stops/reconciles every Term epoch, while the ledger keeps
	 * the stopped Term participant available for lazy reconstruction.
	 */
	recordActiveState(): void {
		const active: ParticipantId[] = [];
		for (const participantId of this.coordinator.runtimes.keys()) {
			const participant = this.authority.participant(participantId);
			if (!participant || participant.kind !== "agent" || !participant.sessionFile) continue;
			active.push(participantId);
		}
		this.authority.saveProcessState(active);
	}

	/**
	 * Exit-time persistence records restorable Agent sessions. Runtime shutdown is
	 * owned by dispose(): it aborts Agent foreground turns and stops/reconciles Term
	 * epochs before releasing the session lease. We must not forge a ready/stopped
	 * lifecycle value while either operation is still live.
	 */
	async saveActiveState(): Promise<void> {
		this.recordActiveState();
	}

	/** Human gives authority to a direct Agent or Term child: a plain resource moves complete ownership, while & grants a read pointer. */
	giveTo(reference: string, resourceInput: string, cwd?: string) {
		return this.coordinator.give(this.authority.rootParticipantId, reference, resourceInput, cwd);
	}

	/** Human gets a resource from its direct child; a running Agent receives the committed authority update and continues, while an open Term must be stopped explicitly before authority can move. */
	async getFrom(reference: string, resourceInput: ResourceId, cwd?: string): Promise<ResourceId[]> {
		const { targetId, resourceId } = await this.coordinator.resolveOwnedChildResource(
			this.authority.rootParticipantId,
			reference,
			resourceInput,
			cwd,
		);
		return this.coordinator.getOwnedResource(this.authority.rootParticipantId, targetId, resourceId);
	}

	listenParticipant(reference: string): Promise<string> {
		return this.coordinator.listenParticipant(this.authority.rootParticipantId, reference);
	}

	waitParticipant(reference: string, state: ParticipantWaitTarget = "ready"): Promise<ParticipantWaitResult> {
		return this.coordinator.waitParticipant(this.authority.rootParticipantId, reference, state);
	}

	interruptParticipant(reference: string): Promise<void> {
		return this.coordinator.interrupt(this.authority.rootParticipantId, reference);
	}

	stopParticipant(reference: string): Promise<void> {
		return this.coordinator.stop(this.authority.rootParticipantId, reference);
	}

	async archiveParticipant(reference: string): Promise<void> {
		await this.coordinator.archive(this.authority.rootParticipantId, reference);
		this.recordActiveState();
	}

	execTerm(reference: string, command: string): Promise<void> {
		return this.coordinator.termExec(this.authority.rootParticipantId, reference, command);
	}

	inputTerm(reference: string, data: string): Promise<void> {
		return this.coordinator.termInput(this.authority.rootParticipantId, reference, data);
	}

	mailbox(): MailboxSummary[] {
		const human = this.authority.rootParticipantId;
		const delivered = this.coordinator.peekMailbox(human);
		const state = this.authority.snapshot();
		return delivered.map((message, index) => {
			const participant = state.participants[message.senderId];
			const runtime = this.coordinator.runtimes.get(message.senderId);
			return {
				index: index + 1,
				messageId: message.id,
				senderId: message.senderId,
				senderName: runtime?.displayName?.() ?? participant?.name ?? message.senderId,
				preview: summarizeMessage(message.payload),
				sentAt: state.messages[message.id]?.sentAt ?? 0,
			};
		});
	}

	async consumeMailbox(sender?: string): Promise<DeliveredMail[]> {
		return this.coordinator.receive(this.authority.rootParticipantId, sender);
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = (async () => {
			const failures: unknown[] = [];
			let coordinatorClean = false;
			try { await this.coordinator.dispose(); coordinatorClean = true; } catch (error) { failures.push(error); }
			// If a hosted runtime failed to dispose, retaining the lease prevents a
			// second host from overlapping with work that may still be live.
			if (coordinatorClean) {
				try { this.lease.release(); } catch (error) { failures.push(error); }
			}
			if (failures.length) throw new AggregateError(failures, "Standalone Linden host did not dispose cleanly");
		})();
		return this.disposePromise;
	}

	isIdle(): boolean {
		if (this.attachedParticipantId !== undefined) return false;
		if (this.coordinator.hasActiveWork()) return false;
		// `ready` can retain live descendant/background work; only a fully stopped
		// tree is safe to hand to another standalone session host.
		return this.authority.listParticipants().every((participant) => participant.status === "stopped");
	}

	private async createRuntime(participantId: ParticipantId, initialSessionManager: SessionManager): Promise<AgentSessionRuntime> {
		const agentDir = getAgentDir();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: runtimeAgentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					extensionFactories: [this.lindenExtension(participantId, sessionManager)],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				customTools: buildTools(this.coordinator, participantId, cwd),
				noTools: "all",
				tools: toolNames(),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		return createAgentSessionRuntime(createRuntime, {
			cwd: initialSessionManager.getCwd(),
			agentDir,
			sessionManager: initialSessionManager,
		});
	}

	private lindenExtension(participantId: ParticipantId, sessionManager: SessionManager): ExtensionFactory {
		return (pi) => {
			const allowed = new Set(toolNames());
			pi.on("tool_call", (event) => allowed.has(event.toolName) ? undefined : { block: true, reason: `Tool ${event.toolName} is not mediated by Linden authority` });
			pi.on("before_agent_start", async (event) => {
				const birthSnapshot = needsParticipantTreeBirthSnapshot(sessionManager.getEntries())
					? `\n\n${await this.coordinator.formatParticipantTreeBirthSnapshot(participantId)}`
					: "";
				return {
					systemPrompt: `${event.systemPrompt}\n\nLinden authority (the sole source of resource permissions):\nYou are participant ${participantId}.\n${this.coordinator.describeAuthority(participantId)}\nUse only the registered Linden gateways for files, Bash, messages, transfers, checkout, and child participants.${birthSnapshot}\n\n${runtimeGuidanceForParticipant(this.coordinator.isAgentSpawnEnabled(participantId), this.runtimeGuidanceProfile)}`,
				};
			});
			pi.on("session_before_switch", () => ({ cancel: true }));
			pi.on("session_before_fork", () => ({ cancel: true }));
			pi.on("user_bash", () => ({
				operations: {
					exec: async (command: string, cwd: string, options: any) => {
						const result = await this.authority.bash(participantId, command, { ...options, cwd });
						return { exitCode: result.exitCode };
					},
				},
			}));
		};
	}
}
