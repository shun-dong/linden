import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager, type TermEpochFinish, type TermEpochStart } from "../src/runtime/manager.js";

async function fixture(name: string) {
	const workspace = mkdtempSync(join(tmpdir(), `linden-term-log-${name}-`));
	const stateDir = join(workspace, ".state");
	const lindenSessionId = `session:term-log-${name}`;
	const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
	const human = manager.rootParticipantId;
	const term = `term:${name}`;
	await manager.spawnWith(human, term, name, [], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
	return { workspace, stateDir, lindenSessionId, manager, human, term };
}

function completedFinish(epoch: TermEpochStart): TermEpochFinish {
	const commandStartedAt = new Date(epoch.startedAt + 1).toISOString();
	const commandEndedAt = new Date(epoch.startedAt + 2).toISOString();
	const output = "private-term-output\n";
	return {
		...epoch,
		endedAt: epoch.startedAt + 3,
		forced: false,
		trace: {
			commands: [{
				id: "command:one",
				command: "printf private-term-command",
				startedAt: commandStartedAt,
				endedAt: commandEndedAt,
				exitCode: 0,
				outputStart: 0,
				outputEnd: Buffer.byteLength(output),
			}],
			output: { start: 0, end: Buffer.byteLength(output), data: output, truncatedBefore: false },
		},
	};
}

test("completed Term trace is content-addressed, private from the typed ledger, and idempotent across stale-journal recovery", async () => {
	const value = await fixture("completed");
	const { workspace, stateDir, lindenSessionId, manager, human, term } = value;
	try {
		const epoch: TermEpochStart = { termId: term, epochId: "epoch:completed", startedAt: Date.now() };
		await manager.beginTermEpoch(epoch);
		const originalRemoveJournal = manager.store.removeJournal.bind(manager.store);
		let injected = false;
		manager.store.removeJournal = (id: string) => {
			if (!injected) { injected = true; throw new Error("injected Term journal deletion failure"); }
			originalRemoveJournal(id);
		};
		await manager.finishTermEpoch(completedFinish(epoch));
		manager.store.removeJournal = originalRemoveJournal;

		const warm = manager.termEpochLog(human, term);
		assert.equal(warm.length, 1);
		assert.equal(warm[0].epoch.id, epoch.epochId);
		assert.equal(warm[0].epoch.recovered, false);
		assert.equal(warm[0].trace.complete, true);
		assert.equal(warm[0].trace.commands[0]?.command, "printf private-term-command");
		assert.equal(warm[0].trace.output.data, "private-term-output\n");
		assert.equal(manager.store.readJournals().length, 1, "the injected post-commit cleanup gap remains replayable");

		const ledgerText = readFileSync(manager.store.ledgerPath, "utf8");
		assert.doesNotMatch(ledgerText, /private-term-command|private-term-output/, "raw terminal content must not enter the typed ledger");
		const ledger = JSON.parse(ledgerText);
		const metadata = ledger.runtimeMetadata.termEpochs[0];
		assert.equal(metadata.effectId, manager.snapshot().effects.find((effect) => effect.kind === "exec" && effect.targetId === term)?.id);
		assert.match(metadata.trace.blobHash, /^[0-9a-f]{64}$/);

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const cold = reopened.termEpochLog(reopened.rootParticipantId, term);
		assert.equal(cold.length, 1, "stale-journal recovery must not duplicate an epoch");
		assert.equal(cold[0].epoch.recovered, false, "a completed trace wins over the recovered fallback");
		assert.equal(cold[0].trace.commands[0]?.command, "printf private-term-command");
		assert.equal(reopened.snapshot().effects.filter((effect) => effect.id === cold[0].epoch.effectId).length, 1);
		assert.equal(reopened.store.readJournals().length, 0);

		writeFileSync(join(reopened.store.blobDir, cold[0].epoch.trace.blobHash!), "tampered");
		assert.throws(() => reopened.termEpochLog(reopened.rootParticipantId, term), /SNAPSHOT_INTEGRITY/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("failed Term epoch ledger save rolls back effect and log together, then commits exactly once on retry", async () => {
	const value = await fixture("retry");
	const { workspace, manager, human, term } = value;
	try {
		const epoch: TermEpochStart = { termId: term, epochId: "epoch:retry", startedAt: Date.now() };
		const finish = completedFinish(epoch);
		await manager.beginTermEpoch(epoch);
		const before = manager.snapshot();
		const originalSave = manager.store.save.bind(manager.store);
		manager.store.save = () => { throw new Error("injected Term log save failure"); };
		await assert.rejects(manager.finishTermEpoch(finish), /injected Term log save failure/);
		assert.deepEqual(manager.snapshot().termEpochs, before.termEpochs);
		assert.equal(manager.snapshot().effects.filter((effect) => effect.kind === "exec" && effect.targetId === term).length, 0);
		assert.equal(manager.hasOpenTermEpoch(term), true);
		assert.equal(manager.store.readJournals().length, 1);

		manager.store.save = originalSave;
		await manager.finishTermEpoch(finish);
		assert.equal(manager.termEpochLog(human, term).length, 1);
		assert.equal(manager.snapshot().effects.filter((effect) => effect.kind === "exec" && effect.targetId === term).length, 1);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term trace rejects forged byte ranges, duplicate command IDs, and command output beyond the epoch", async () => {
	const value = await fixture("trace-validation");
	const { workspace, manager, human, term } = value;
	try {
		const epoch: TermEpochStart = { termId: term, epochId: "epoch:trace-validation", startedAt: Date.now() };
		await manager.beginTermEpoch(epoch);
		const valid = completedFinish(epoch);

		const wrongLength = structuredClone(valid);
		wrongLength.trace!.output.end += 1;
		await assert.rejects(manager.finishTermEpoch(wrongLength), /output data length does not match its cursor range/);

		const duplicate = structuredClone(valid);
		duplicate.trace!.commands = [...duplicate.trace!.commands, { ...duplicate.trace!.commands[0] }];
		await assert.rejects(manager.finishTermEpoch(duplicate), /duplicate command id/);

		const outsideEpoch = structuredClone(valid);
		outsideEpoch.trace!.commands[0].outputEnd = outsideEpoch.trace!.output.end + 1;
		await assert.rejects(manager.finishTermEpoch(outsideEpoch), /output range exceeds the epoch output range/);

		const bounded = structuredClone(valid);
		bounded.trace!.output.data = "x".repeat(4 * 1024 * 1024 + 17);
		bounded.trace!.output.start = 0;
		bounded.trace!.output.end = Buffer.byteLength(bounded.trace!.output.data);
		bounded.trace!.commands[0].outputEnd = bounded.trace!.output.end;
		await manager.finishTermEpoch(bounded);
		assert.equal(manager.snapshot().termEpochs[epoch.epochId]?.effectId, manager.snapshot().effects.find((effect) => effect.kind === "exec" && effect.targetId === term)?.id);
		const retained = manager.termEpochLog(human, term)[0].trace.output;
		assert.equal(Buffer.byteLength(retained.data), 4 * 1024 * 1024);
		assert.equal(retained.end - retained.start, Buffer.byteLength(retained.data));
		assert.equal(retained.truncatedBefore, true);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("crash recovery creates one auditable incomplete Term trace, including for an early-v6 journal without termEpochId", async () => {
	const value = await fixture("recovered");
	const { workspace, stateDir, lindenSessionId, manager, term } = value;
	try {
		const epoch: TermEpochStart = { termId: term, epochId: "epoch:lost-at-crash", startedAt: Date.now() };
		await manager.beginTermEpoch(epoch);
		const journal = manager.store.readJournals()[0];
		assert.ok(journal?.type === "bash");
		if (journal.type !== "bash") return;
		delete journal.termEpochId;
		manager.store.writeJournal(journal);

		const recovered = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const log = recovered.termEpochLog(recovered.rootParticipantId, term);
		assert.equal(log.length, 1);
		assert.match(log[0].epoch.id, /^epoch:recovered:term-/);
		assert.equal(log[0].epoch.recovered, true);
		assert.equal(log[0].epoch.forced, true);
		assert.equal(log[0].trace.complete, false);
		assert.equal(log[0].trace.missingReason, "process-recovery");
		assert.deepEqual(log[0].trace.commands, []);
		assert.deepEqual(log[0].trace.output, { start: 0, end: 0, data: "", truncatedBefore: false });
		assert.equal(recovered.snapshot().effects.filter((effect) => effect.id === log[0].epoch.effectId).length, 1);
		assert.equal(recovered.store.readJournals().length, 0);

		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		assert.equal(reopened.termEpochLog(reopened.rootParticipantId, term).length, 1);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("v6 ledgers written before durable Term logs decode with an empty in-memory termEpochs index", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-log-old-v6-"));
	const stateDir = join(workspace, ".state");
	const lindenSessionId = "session:term-log-old-v6";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		const ledger = JSON.parse(readFileSync(manager.store.ledgerPath, "utf8"));
		delete ledger.runtimeMetadata.termEpochs;
		writeFileSync(manager.store.ledgerPath, `${JSON.stringify(ledger)}\n`);
		const reopened = await SessionAuthorityManager.open({ workspace, stateDir, lindenSessionId });
		assert.deepEqual(reopened.snapshot().termEpochs, {});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
