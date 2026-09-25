import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthorityState, FileResource, ParticipantId, ResourceId } from "../src/runtime/model.js";
import { SessionAuthorityManager, type TermEpochStart } from "../src/runtime/manager.js";

interface TermJournalFixture {
	workspace: string;
	stateDir: string;
	lindenSessionId: string;
	manager: SessionAuthorityManager;
	termId: ParticipantId;
	resourceId: ResourceId;
	epoch: TermEpochStart;
}

async function termJournalFixture(name: string): Promise<TermJournalFixture> {
	const workspace = mkdtempSync(join(tmpdir(), `linden-journal-${name}-`));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = `session:journal-${name}`;
	const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
	const human = manager.rootParticipantId;
	const initial = await manager.writeFile(human, "journal.txt", "before");
	const termId = `term:journal-${name}`;
	await manager.spawnWith(human, termId, name, [], async () => ({}), {
		participantKind: "term",
		inheritWorkspaceRead: true,
		defaultReadRoot: workspace,
	});
	await manager.give(human, termId, manager.baseResourceId());
	const epoch: TermEpochStart = { termId, epochId: `epoch:${name}`, startedAt: Date.now() };
	await manager.beginTermEpoch(epoch);
	return { workspace, stateDir, lindenSessionId, manager, termId, resourceId: initial.resourceId, epoch };
}

function file(state: AuthorityState, resourceId: ResourceId): FileResource {
	const resource = state.resources[resourceId];
	assert.ok(resource && resource.kind === "file", `${resourceId} must remain a File resource`);
	return resource;
}

function execEffects(state: AuthorityState, termId: ParticipantId) {
	return state.effects.filter((effect) => effect.kind === "exec" && effect.participantId === termId && effect.targetId === termId);
}

test("recovery cleans a committed Bash journal after a later legal File write", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-journal-bash-remove-failure-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:journal-bash-remove-failure";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		const initial = await manager.writeFile(human, "journal.txt", "before");
		const resourceId = initial.resourceId;
		const before = manager.snapshot();
		const path = join(workspace, "journal.txt");
		const beforePhysical = manager.store.capture(path, true);
		const afterPhysical = manager.store.captureBuffer(Buffer.from("after"));
		const effectId = "effect:bash-remove-failure";
		manager.store.writeJournal({
			version: 1,
			type: "bash",
			operation: "bash",
			effectId,
			id: "bash-remove-failure",
			participantId: human,
			roots: [workspace],
			before: { [path]: beforePhysical },
			after: { [path]: afterPhysical },
			createdAt: Date.now(),
		});
		writeFileSync(path, "after");

		const originalRemoveJournal = manager.store.removeJournal.bind(manager.store);
		let injected = false;
		manager.store.removeJournal = (id: string) => {
			if (!injected) {
				injected = true;
				throw new Error("injected journal deletion failure");
			}
			originalRemoveJournal(id);
		};

		await (manager as unknown as { recover(): Promise<void> }).recover();
		assert.equal(injected, true, "the committed-journal cleanup failure must be exercised");
		const committed = manager.snapshot();
		const committedBashEffects = committed.effects.filter((effect) => effect.kind === "bash" && effect.participantId === human);
		assert.equal(committedBashEffects.length, before.effects.filter((effect) => effect.kind === "bash" && effect.participantId === human).length + 1);
		assert.equal(file(committed, resourceId).versions.length, file(before, resourceId).versions.length + 1);
		assert.equal(manager.store.readJournals().length, 1, "the crash-window journal must remain durable");
		assert.equal(committedBashEffects.at(-1)!.id, effectId);

		const later = await manager.writeFile(human, "journal.txt", "later");
		const afterLaterWrite = manager.snapshot();
		assert.equal(file(afterLaterWrite, resourceId).versions.length, file(committed, resourceId).versions.length + 1);
		assert.equal(file(afterLaterWrite, resourceId).currentVersionId, later.stateId);
		assert.equal(manager.store.readJournals().length, 1, "a later legal write does not own the stale journal cleanup");

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const recovered = reopened.snapshot();
		const recoveredBashEffects = recovered.effects.filter((effect) => effect.kind === "bash" && effect.participantId === human);
		assert.equal(recoveredBashEffects.length, committedBashEffects.length, "recovery must not append a second effect");
		assert.equal(recoveredBashEffects.at(-1)!.id, effectId, "recovery must preserve the reserved effect identity");
		assert.equal(file(recovered, resourceId).versions.length, file(afterLaterWrite, resourceId).versions.length, "recovery must preserve both the committed Bash version and the later File version");
		assert.equal(file(recovered, resourceId).currentVersionId, later.stateId);
		assert.equal(reopened.store.readJournals().length, 0, "successful idempotent recovery removes the stale journal");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("beginTermEpoch rolls back all in-memory state and its journal when ledger persistence fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-journal-begin-term-save-failure-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:journal-begin-term-save-failure";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		const termId = "term:begin-save-failure";
		await manager.spawnWith(human, termId, "begin-save-failure", [], async () => ({}), {
			participantKind: "term",
			inheritWorkspaceRead: false,
		});
		const epoch: TermEpochStart = { termId, epochId: "epoch:begin-save-failure", startedAt: Date.now() };
		const before = manager.snapshot();
		const originalSave = manager.store.save.bind(manager.store);
		manager.store.save = () => { throw new Error("injected begin ledger save failure"); };

		await assert.rejects(manager.beginTermEpoch(epoch), /injected begin ledger save failure/);
		assert.deepEqual(manager.snapshot(), before, "failed begin must restore the exact pre-epoch in-memory ledger");
		assert.equal(manager.hasOpenTermEpoch(termId), false);
		assert.equal((manager as any).activeReadViews.size, 0);
		assert.equal(manager.store.readJournals().length, 0);

		manager.store.save = originalSave;
		await manager.beginTermEpoch(epoch);
		assert.equal(manager.hasOpenTermEpoch(termId), true, "the same manager remains usable after rollback");
		await manager.finishTermEpoch({ ...epoch, endedAt: Date.now(), forced: false });
		assert.equal(manager.hasOpenTermEpoch(termId), false);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("commitInputWith never writes stdin without a durable intent and marks a failed final save uncertain", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-input-two-phase-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:input-two-phase";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const human = manager.rootParticipantId;
		const termId = "term:input-two-phase";
		await manager.spawnWith(human, termId, "input-two-phase", [], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
		await manager.setParticipantStatus(termId, "running");
		const originalSave = manager.store.save.bind(manager.store);
		let deliveries = 0;
		await assert.rejects(
			manager.commitInputWith(
				human,
				termId,
				() => { deliveries += 1; },
				() => { throw new Error("foreground not started"); },
			),
			/foreground not started/,
		);
		assert.equal(deliveries, 0);
		assert.equal(manager.snapshot().effects.filter((effect) => effect.kind === "input").length, 0, "known preflight failure creates no diverged intent");

		manager.store.save = () => { throw new Error("injected input intent save failure"); };
		await assert.rejects(
			manager.commitInputWith(human, termId, () => { deliveries += 1; }),
			/injected input intent save failure/,
		);
		assert.equal(deliveries, 0, "stdin is untouched until the uncertain intent is durable");
		assert.equal(manager.snapshot().effects.filter((effect) => effect.kind === "input").length, 0);

		let saves = 0;
		manager.store.save = (state: AuthorityState) => {
			saves += 1;
			if (saves === 2) throw new Error("injected input confirmation save failure");
			originalSave(state);
		};
		let confirmDelivery!: () => void;
		const deliveryConfirmed = new Promise<void>((resolvePromise) => { confirmDelivery = resolvePromise; });
		const input = manager.commitInputWith(human, termId, async () => {
			deliveries += 1;
			await deliveryConfirmed;
		});
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(deliveries, 1, "the physical write is attempted exactly once");
		assert.equal(saves, 1, "the committed upgrade waits for the Writable callback");
		confirmDelivery();
		await assert.rejects(input, /TERM_INPUT_COMMIT_UNCERTAIN/);
		const inputEffects = manager.snapshot().effects.filter((effect) => effect.kind === "input" && effect.targetId === termId);
		assert.equal(inputEffects.length, 1);
		assert.equal(inputEffects[0].status, "diverged", "failed confirmation remains an explicit uncertain delivery");

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const durableInputEffects = reopened.snapshot().effects.filter((effect) => effect.kind === "input" && effect.targetId === termId);
		assert.equal(durableInputEffects.length, 1);
		assert.equal(durableInputEffects[0].id, inputEffects[0].id);
		assert.equal(durableInputEffects[0].status, "diverged");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("ordinary ledger commits roll back live memory when persistence fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-staged-ledger-"));
	const stateDir = join(workspace, ".linden-test");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId: "session:staged-ledger" });
		const human = manager.rootParticipantId;
		const agent = "agent:staged-ledger-child";
		await manager.spawnWith(human, agent, "child", [], async () => ({ piSessionId: "staged-ledger-child" }));
		const written = await manager.writeFile(human, "owned.txt", "owned");
		const originalSave = manager.store.save.bind(manager.store);
		const expectRollback = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
			const before = manager.snapshot();
			manager.store.save = () => { throw new Error(`injected ${label} save failure`); };
			try { await assert.rejects(operation(), new RegExp(`injected ${label} save failure`)); }
			finally { manager.store.save = originalSave; }
			assert.deepEqual(manager.snapshot(), before, `${label} must not leak a failed transition into live memory`);
		};

		await expectRollback("give", () => manager.give(human, agent, written.resourceId));
		assert.equal(manager.resource(written.resourceId)?.ownerId, human);
		await manager.give(human, agent, written.resourceId);
		await expectRollback("get", () => manager.get(human, agent, written.resourceId));
		assert.equal(manager.resource(written.resourceId)?.ownerId, agent);

		const pending = await manager.sendWithPayload(agent, human, async () => "pi:staged-ledger-payload");
		await expectRollback("receive", () => manager.receiveMessages(human, [pending.id], agent));
		assert.equal(manager.pendingMessages(human, agent).length, 1);
		await expectRollback("send", () => manager.sendWithPayload(human, agent, async (messageId) => manager.store.writePrivatePayload(`send:${messageId}`, { messageId })));
		assert.equal(manager.pendingMessages(agent, human).length, 0);

		await expectRollback("lifecycle", () => manager.setParticipantStatus(agent, "running"));
		assert.equal(manager.participant(agent)?.status, "stopped");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a failed Term journal ledger save rolls back memory and the same epoch commits once on retry", async () => {
	const fixture = await termJournalFixture("save-failure");
	const { workspace, stateDir, lindenSessionId, manager, termId, resourceId, epoch } = fixture;
	try {
		const before = manager.snapshot();
		writeFileSync(join(workspace, "journal.txt"), "after");

		const originalSave = manager.store.save.bind(manager.store);
		let injected = false;
		manager.store.save = (state: AuthorityState) => {
			if (!injected) {
				injected = true;
				throw new Error("injected ledger save failure");
			}
			originalSave(state);
		};

		await assert.rejects(
			manager.finishTermEpoch({ ...epoch, endedAt: Date.now(), forced: false }),
			/injected ledger save failure/,
		);
		const rolledBack = manager.snapshot();
		assert.equal(execEffects(rolledBack, termId).length, execEffects(before, termId).length, "failed persistence must roll back the staged effect");
		assert.equal(file(rolledBack, resourceId).versions.length, file(before, resourceId).versions.length, "failed persistence must roll back the staged version");
		assert.equal(file(rolledBack, resourceId).currentVersionId, file(before, resourceId).currentVersionId);
		assert.equal(manager.store.readJournals().length, 1, "the prepared journal remains available for retry");

		manager.store.save = originalSave;
		await manager.finishTermEpoch({ ...epoch, endedAt: Date.now(), forced: false });
		const retried = manager.snapshot();
		assert.equal(execEffects(retried, termId).length, execEffects(before, termId).length + 1);
		assert.equal(file(retried, resourceId).versions.length, file(before, resourceId).versions.length + 1);
		assert.equal(file(retried, resourceId).versions.filter((version) => version.operation === "term").length, 1);
		assert.equal(manager.store.readJournals().length, 0);

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		assert.equal(execEffects(reopened.snapshot(), termId).length, execEffects(retried, termId).length);
		assert.equal(file(reopened.snapshot(), resourceId).versions.length, file(retried, resourceId).versions.length);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
