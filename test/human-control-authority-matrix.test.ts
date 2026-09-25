import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	PiCoordinator,
	TermParticipantRuntime,
	type ParticipantRuntime,
} from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import type { ParticipantId } from "../src/runtime/model.js";

interface Fixture {
	container: string;
	workspace: string;
	manager: SessionAuthorityManager;
	coordinator: PiCoordinator;
}

async function fixture(prefix: string): Promise<Fixture> {
	const container = mkdtempSync(join(tmpdir(), prefix));
	const workspace = join(container, "workspace");
	mkdirSync(workspace);
	const manager = await SessionAuthorityManager.open({
		workspace,
		stateDir: join(container, "state"),
	});
	return {
		container,
		workspace,
		manager,
		coordinator: PiCoordinator.createStandalone(manager),
	};
}

async function closeFixture(value: Fixture | undefined): Promise<void> {
	if (!value) return;
	await value.coordinator.dispose().catch(() => undefined);
	rmSync(value.container, { recursive: true, force: true });
}

async function spawnAgent(
	manager: SessionAuthorityManager,
	parentId: ParticipantId,
	id: ParticipantId,
): Promise<void> {
	const suffix = id.slice("agent:".length);
	await manager.spawnWith(
		parentId,
		id,
		suffix,
		[],
		async () => ({ piSessionId: "pi-" + suffix }),
		{ inheritWorkspaceRead: false },
	);
}

async function spawnTerm(
	manager: SessionAuthorityManager,
	parentId: ParticipantId,
	id: ParticipantId,
): Promise<void> {
	await manager.spawnWith(
		parentId,
		id,
		id.slice("term:".length),
		[],
		async () => ({}),
		{ participantKind: "term", inheritWorkspaceRead: false },
	);
}

function fakeAgentRuntime(
	participantId: ParticipantId,
	isRunning: () => boolean = () => false,
): ParticipantRuntime {
	const payloads = new Map<string, unknown>();
	let sequence = 0;
	return {
		participantId,
		entries: () => [],
		leafId: () => null,
		isRunning,
		abort: async () => undefined,
		appendEntry: async (_customType, data) => {
			const id = "entry:" + participantId + ":" + (++sequence);
			payloads.set(id, data);
			return id;
		},
		setLabel: () => undefined,
		readPayload: (id) => payloads.get(id) as never,
		deliverBatch: async () => undefined,
		summary: () => participantId + " fake-agent",
		navigate: async () => undefined,
		appendRuntimeNotice: async () => "notice:" + participantId + ":" + (++sequence),
		dispose: async () => undefined,
	};
}

function fakeTermRuntime(participantId: ParticipantId): {
	runtime: TermParticipantRuntime;
	inputs: string[];
	finish: () => void;
} {
	type Lifecycle = "running" | "ready" | "stopped";
	let lifecycle: Lifecycle = "stopped";
	let completion: ((result: unknown) => void) | undefined;
	let commandSequence = 0;
	const inputs: string[] = [];
	const snapshot = () => ({
		id: participantId,
		lifecycle,
		ready: lifecycle !== "running",
		reconciling: false,
		foreground: lifecycle === "running" ? { id: "command:" + commandSequence } : undefined,
		backgroundPids: [],
		outputCursor: 0,
	});
	const finish = (): void => {
		if (lifecycle !== "running") return;
		lifecycle = "stopped";
		const resolve = completion;
		completion = undefined;
		resolve?.({
			termId: participantId,
			epochId: "epoch:test",
			commandId: "command:" + commandSequence,
			exitCode: 0,
		});
	};
	const term = {
		lifecycle: snapshot,
		async startExec() {
			if (lifecycle === "running") throw new Error("Term exec requires ready state");
			lifecycle = "running";
			commandSequence += 1;
			const operation = new Promise((resolvePromise) => { completion = resolvePromise; });
			return {
				termId: participantId,
				epochId: "epoch:test",
				commandId: "command:" + commandSequence,
				completion: operation,
			};
		},
		assertInputReady() {
			if (lifecycle !== "running") throw new Error("Term input requires running state");
		},
		async waitForInputReady() {
			if (lifecycle !== "running") throw new Error("Term input requires running state");
		},
		async input(data: string) {
			if (lifecycle !== "running") throw new Error("Term input requires running state");
			inputs.push(data);
		},
		async waitFor(target: "ready" | "stopped") {
			if (target === "ready" ? lifecycle === "running" : lifecycle !== "stopped") {
				throw new Error("Fake Term has not reached " + target);
			}
			return snapshot();
		},
		async interrupt() {
			finish();
		},
		async stopAll() {
			finish();
			lifecycle = "stopped";
		},
		async listen() {
			return { cursor: 0, data: "" };
		},
		async dispose() {
			finish();
			lifecycle = "stopped";
		},
	};
	return {
		runtime: new TermParticipantRuntime(participantId, term as never, participantId),
		inputs,
		finish,
	};
}

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
	}
}

test("root Human common controls require a strict ancestor relation", async () => {
	let value: Fixture | undefined;
	try {
		value = await fixture("linden-human-control-matrix-");
		const { manager, coordinator } = value;
		const human = manager.rootParticipantId;
		const parent = "agent:control-parent";
		const child = "agent:control-child";
		const sibling = "agent:control-sibling";
		await spawnAgent(manager, human, parent);
		await spawnAgent(manager, parent, child);
		await spawnAgent(manager, human, sibling);
		for (const id of [parent, child, sibling]) {
			coordinator.runtimes.set(id, fakeAgentRuntime(id));
		}

		await assert.rejects(coordinator.listenParticipant(human, human), /ROLE_MISMATCH/);
		assert.match(await coordinator.listenParticipant(human, child), /control-child/);
		await coordinator.waitParticipant(human, child, "ready");
		await coordinator.waitParticipant(human, child, "stopped");
		await coordinator.interrupt(human, child);
		await coordinator.stop(human, child);

		const commonControls = [
			(from: ParticipantId, target: ParticipantId) => coordinator.listenParticipant(from, target).then(() => undefined),
			(from: ParticipantId, target: ParticipantId) => coordinator.waitParticipant(from, target, "stopped"),
			(from: ParticipantId, target: ParticipantId) => coordinator.interrupt(from, target),
			(from: ParticipantId, target: ParticipantId) => coordinator.stop(from, target),
		];
		for (const operation of commonControls) {
			await assert.rejects(operation(child, parent), /ROLE_MISMATCH/, "child-to-parent control must be rejected");
			await assert.rejects(operation(sibling, child), /ROLE_MISMATCH/, "sibling control must be rejected");
		}
	} finally {
		await closeFixture(value);
	}
});

test("Human information, Agent-only controls, and Term lifecycle use their kind-specific gates", async () => {
	let value: Fixture | undefined;
	try {
		value = await fixture("linden-human-kind-matrix-");
		const { manager, coordinator } = value;
		const human = manager.rootParticipantId;
		const parent = "agent:kind-parent";
		const child = "agent:kind-child";
		const sibling = "agent:kind-sibling";
		const term = "term:kind-shell";
		await spawnAgent(manager, human, parent);
		await spawnAgent(manager, parent, child);
		await spawnAgent(manager, human, sibling);
		await spawnTerm(manager, human, term);
		for (const id of [parent, child, sibling]) {
			coordinator.runtimes.set(id, fakeAgentRuntime(id));
		}
		const fakeTerm = fakeTermRuntime(term);
		coordinator.runtimes.set(term, fakeTerm.runtime);

		await coordinator.send(human, parent, "human to agent");
		await coordinator.send(parent, human, "agent to human");
		await coordinator.send(human, child, "ancestor to descendant agent");
		await assert.rejects(coordinator.send(human, term, "human to term"), /PARTICIPANT_KIND_MISMATCH/);
		await assert.rejects(coordinator.send(parent, term, "agent to term"), /PARTICIPANT_KIND_MISMATCH/);
		await assert.rejects(coordinator.send(term, parent, "term to agent"), /PARTICIPANT_KIND_MISMATCH/);

		await coordinator.steer(human, child, "descendant steering");
		await assert.rejects(coordinator.steer(child, parent, "reverse steering"), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.steer(sibling, child, "sibling steering"), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.steer(human, term, "term steering"), /PARTICIPANT_KIND_MISMATCH/);

		let termAdapterLookups = 0;
		const ensureTermRuntime = (coordinator as any).ensureTermRuntime.bind(coordinator);
		(coordinator as any).ensureTermRuntime = async (...args: unknown[]) => {
			termAdapterLookups += 1;
			return ensureTermRuntime(...args);
		};
		await assert.rejects(coordinator.termInput(parent, term, "unauthorized"), /ROLE_MISMATCH/);
		assert.equal(termAdapterLookups, 0, "input authority is checked before a Term adapter is restored or created");

		assert.equal((await coordinator.prepareAttach(human, child)).targetId, child);
		await assert.rejects(coordinator.prepareAttach(child, parent), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.prepareAttach(sibling, child), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.prepareAttach(human, term), /PARTICIPANT_KIND_MISMATCH/);

		const checkpoint = await manager.recordCheckpoint(
			manager.checkpointEnvelope(parent),
			"pi:kind-parent",
		);
		await coordinator.rewind(human, parent, checkpoint.id);
		await assert.rejects(coordinator.rewind(human, child, checkpoint.id), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.rewind(child, parent, checkpoint.id), /ROLE_MISMATCH/);
		await assert.rejects(coordinator.rewind(human, term, checkpoint.id), /PARTICIPANT_KIND_MISMATCH/);

		await coordinator.termExec(human, term, "hold");
		assert.equal(manager.participant(term)?.status, "running");
		await assert.rejects(coordinator.termExec(human, term, "second"), /PARTICIPANT_STATUS_MISMATCH/);
		await coordinator.termInput(human, term, "answer\n");
		assert.deepEqual(fakeTerm.inputs, ["answer\n"]);
		await assert.rejects(coordinator.termExec(human, parent, "wrong kind"), /PARTICIPANT_KIND_MISMATCH/);
		await assert.rejects(coordinator.termInput(human, parent, "wrong kind"), /PARTICIPANT_KIND_MISMATCH/);
		fakeTerm.finish();
		await until(() => manager.participant(term)?.status === "stopped");
		await coordinator.waitParticipant(human, term, "ready");
		await coordinator.waitParticipant(human, term, "stopped");
		await assert.rejects(coordinator.termInput(human, term, "late"), /PARTICIPANT_STATUS_MISMATCH/);
	} finally {
		await closeFixture(value);
	}
});

test("Human log permits Agent self and arbitrary Agent/Term descendants but rejects reverse and unrelated access", async () => {
	let value: Fixture | undefined;
	try {
		value = await fixture("linden-human-log-matrix-");
		const { manager, coordinator } = value;
		const human = manager.rootParticipantId;
		const parent = "agent:log-parent";
		const grandchild = "agent:log-grandchild";
		const sibling = "agent:log-sibling";
		const term = "term:log-shell";
		await spawnAgent(manager, human, parent);
		await spawnAgent(manager, parent, grandchild);
		await spawnAgent(manager, human, sibling);
		await spawnTerm(manager, human, term);
		for (const id of [parent, grandchild, sibling]) {
			coordinator.runtimes.set(id, fakeAgentRuntime(id));
		}
		coordinator.runtimes.set(term, fakeTermRuntime(term).runtime);

		assert.equal(await coordinator.formatAgentLog(parent, parent), "No Pi entries.");
		assert.equal(await coordinator.formatAgentLog(human, grandchild), "No Pi entries.");
		assert.equal(await coordinator.formatParticipantLog(human, term), `No Term epochs for ${term}.`);
		await assert.rejects(coordinator.formatAgentLog(grandchild, parent), /ROLE_FORGERY|ROLE_MISMATCH/);
		await assert.rejects(coordinator.formatAgentLog(sibling, parent), /ROLE_FORGERY|ROLE_MISMATCH/);
		// The Agent-specific formatter remains kind-safe even though generic log
		// dispatch now supports descendant Terms.
		await assert.rejects(coordinator.formatAgentLog(human, term), /PARTICIPANT_KIND_MISMATCH/);
	} finally {
		await closeFixture(value);
	}
});

test("Human archive, give, and get preserve direct-edge and stopped-subtree boundaries", async () => {
	let value: Fixture | undefined;
	try {
		value = await fixture("linden-human-edge-matrix-");
		const { manager, coordinator, workspace } = value;
		const human = manager.rootParticipantId;
		const parent = "agent:edge-parent";
		const grandchild = "agent:edge-grandchild";
		const sibling = "agent:edge-sibling";
		await spawnAgent(manager, human, parent);
		await spawnAgent(manager, parent, grandchild);
		await spawnAgent(manager, human, sibling);
		let grandchildRunning = false;
		coordinator.runtimes.set(parent, fakeAgentRuntime(parent));
		coordinator.runtimes.set(grandchild, fakeAgentRuntime(grandchild, () => grandchildRunning));
		coordinator.runtimes.set(sibling, fakeAgentRuntime(sibling));

		const direct = await manager.writeFile(human, "direct.txt", "direct");
		await coordinator.give(human, parent, direct.resourceId, workspace);
		assert.equal(manager.resource(direct.resourceId)?.ownerId, parent);
		assert.deepEqual(await coordinator.getOwnedResource(human, parent, direct.resourceId), [direct.resourceId]);
		assert.equal(manager.resource(direct.resourceId)?.ownerId, human);

		const rejectedGive = await manager.writeFile(human, "grandchild-give.txt", "grandchild");
		let grantResolutions = 0;
		const resolveGrantResource = (coordinator as any).resolveGrantResource.bind(coordinator);
		(coordinator as any).resolveGrantResource = async (...args: unknown[]) => {
			grantResolutions += 1;
			return resolveGrantResource(...args);
		};
		await assert.rejects(
			coordinator.give(human, grandchild, rejectedGive.resourceId, workspace),
			/ROLE_MISMATCH/,
		);
		assert.equal(grantResolutions, 0, "an invalid give edge is rejected before typed resource refinement");
		(coordinator as any).resolveGrantResource = resolveGrantResource;
		assert.equal(manager.resource(rejectedGive.resourceId)?.ownerId, human);

		const deep = await manager.writeFile(human, "deep-get.txt", "deep");
		await coordinator.give(human, parent, deep.resourceId, workspace);
		await coordinator.give(parent, grandchild, deep.resourceId, workspace);
		assert.equal(manager.resource(deep.resourceId)?.ownerId, grandchild);
		await assert.rejects(coordinator.getOwnedResource(human, grandchild, deep.resourceId), /ROLE_MISMATCH/);
		let resourceResolutions = 0;
		const resolveOwnedResource = coordinator.resolveOwnedResource.bind(coordinator);
		(coordinator as any).resolveOwnedResource = async (...args: Parameters<typeof resolveOwnedResource>) => {
			resourceResolutions += 1;
			return resolveOwnedResource(...args);
		};
		await assert.rejects(
			coordinator.resolveOwnedChildResource(human, grandchild, "file:never-materialized.txt", workspace),
			/ROLE_MISMATCH/,
		);
		assert.equal(resourceResolutions, 0, "an invalid get edge is rejected before typed resource refinement");

		const raced = await manager.writeFile(human, "raced-get.txt", "raced");
		await coordinator.give(human, parent, raced.resourceId, workspace);
		const resolvedRace = await coordinator.resolveOwnedChildResource(human, parent, raced.resourceId, workspace);
		await manager.get(human, parent, raced.resourceId);
		await coordinator.give(human, sibling, raced.resourceId, workspace);
		await assert.rejects(
			coordinator.getOwnedResource(human, resolvedRace.targetId, resolvedRace.resourceId),
			/does not own/,
		);
		assert.equal(manager.resource(raced.resourceId)?.ownerId, sibling, "get never substitutes a new owner for the explicitly selected child");

		grandchildRunning = true;
		await assert.rejects(coordinator.archive(human, parent), /PARTICIPANT_STATUS_MISMATCH|stopped/);
		await assert.rejects(coordinator.archive(human, grandchild), /ROLE_MISMATCH/);
		grandchildRunning = false;
		await coordinator.archive(human, parent);
		assert.equal(manager.participant(parent), undefined);
		assert.equal(manager.participant(grandchild), undefined);
		assert.equal(manager.resource(deep.resourceId)?.ownerId, human);
	} finally {
		await closeFixture(value);
	}
});
