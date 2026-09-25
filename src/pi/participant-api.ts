import type { ParticipantId } from "../runtime/model.js";

export type SpawnParticipantKind = "agent" | "term";
export type ParticipantWaitTarget = "ready" | "stopped";
export type ParticipantWaitResult =
	| { status: "reached"; state: ParticipantWaitTarget }
	| { status: "interrupted"; reason: "message"; messageIds: string[] };

export interface SpawnParticipantOptions {
	kind: SpawnParticipantKind;
	name?: string;
	prompt?: string;
	resources?: readonly string[];
	inheritRead?: boolean;
	/** Human control-plane calls resolve relative grants and inherited reads from this cwd. */
	cwd?: string;
	/** Internal policy fixed before the child session and its tool schema are created. */
	agentSpawnEnabled?: boolean;
	/** Internal provenance for experiment telemetry; model is the public tool surface. */
	origin?: "model" | "runner" | "human";
}

export interface ListenParticipantOptions {
	after?: number;
	wait?: boolean;
	signal?: AbortSignal;
}

export interface ParticipantSpawnAttempt {
	id: string;
	startedAt: string;
	finishedAt: string;
	callerId: ParticipantId;
	kind: SpawnParticipantKind;
	origin: "model" | "runner" | "human";
	status: "committed" | "rejected";
	targetId?: ParticipantId;
	errorCode?: string;
	errorMessage?: string;
}

/**
 * The participant control surface implemented by PiCoordinator. Keeping this
 * interface here lets every model- and human-facing adapter share one contract
 * without embedding participant lifecycle logic in the command parsers.
 */
export interface ParticipantCoordinatorApi {
	spawnParticipant(callerId: ParticipantId, options: SpawnParticipantOptions): Promise<ParticipantId>;
	listenParticipant(callerId: ParticipantId, target: string, options?: ListenParticipantOptions): Promise<string>;
	waitParticipant(callerId: ParticipantId, target: string, state: ParticipantWaitTarget, signal?: AbortSignal): Promise<ParticipantWaitResult>;
	interrupt(callerId: ParticipantId, target: string): Promise<void>;
	stop(callerId: ParticipantId, target: string): Promise<void>;
	archive(callerId: ParticipantId, target: string): Promise<void>;
	termExec(callerId: ParticipantId, target: string, command: string): Promise<void>;
	termInput(callerId: ParticipantId, target: string, data: string): Promise<void>;
}

export function participantCoordinator(coordinator: ParticipantCoordinatorApi): ParticipantCoordinatorApi {
	return coordinator;
}

export interface ParticipantReference {
	participant?: string;
	/** Deprecated compatibility alias for participant. */
	agent?: string;
}

export function participantReference(input: ParticipantReference): string {
	const participant = input.participant?.trim();
	const agent = input.agent?.trim();
	if (participant && agent && participant !== agent) {
		throw new Error("participant and deprecated agent alias must identify the same target");
	}
	const target = participant || agent;
	if (!target) throw new Error("participant is required (agent is accepted as a deprecated alias)");
	return target;
}
