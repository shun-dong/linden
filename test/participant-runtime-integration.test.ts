import assert from "node:assert/strict";
import { sandboxRequirements } from "./runtime-requirements.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StandalonePiHost } from "../src/pi/host.js";
import { PiCoordinator } from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

const sandboxRuntime = await sandboxRequirements(["script", "socat"]);

async function until(predicate: () => boolean, timeout = 3_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

test("Human host API spawns a Term and controls its asynchronous stdin lifecycle", { skip: sandboxRuntime.skip }, async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-human-term-"));
	const base = join(container, "workspace");
	const stateRoot = join(container, "state");
	let host: StandalonePiHost | undefined;
	try {
		mkdirSync(base);
		host = await StandalonePiHost.open({ base, stateRoot });
		const human = host.authority.rootParticipantId;
		const term = await host.spawnParticipant({ kind: "term", name: "interactive", cwd: base });
		assert.deepEqual(
			{
				kind: host.authority.participant(term)?.kind,
				parentId: host.authority.participant(term)?.parentId,
				status: host.authority.participant(term)?.status,
			},
			{ kind: "term", parentId: human, status: "stopped" },
		);

		const startedAt = Date.now();
		await host.execTerm(term, "IFS= read -r answer; printf 'answer:%s' \"$answer\"");
		assert.ok(Date.now() - startedAt < 2_000, "exec must return while the foreground command is waiting for stdin");
		assert.equal(host.authority.participant(term)?.status, "running");
		assert.match(await host.listenParticipant(term), /term=running/);

		await host.inputTerm(term, "forty-two\n");
		const inputEffects = host.authority.snapshot().effects.filter((effect) => effect.kind === "input" && effect.targetId === term);
		assert.equal(inputEffects.length, 1);
		assert.equal(inputEffects[0]?.status, "committed", "a normal foreground input must never be persisted as diverged");
		await host.waitParticipant(term, "stopped");
		assert.equal(host.authority.participant(term)?.status, "stopped");
		assert.match(await host.listenParticipant(term), /answer:forty-two/);
	} finally {
		await host?.dispose();
		rmSync(container, { recursive: true, force: true });
	}
});

test("Term log preserves command and output history across a cold session reopen without restoring a live Term", { skip: sandboxRuntime.skip }, async () => {
	const container = mkdtempSync("/tmp/linden-term-log-");
	const base = join(container, "workspace");
	const stateRoot = join(container, "state");
	let host: StandalonePiHost | undefined;
	let reopened: StandalonePiHost | undefined;
	try {
		mkdirSync(base);
		host = await StandalonePiHost.open({ base, stateRoot });
		const human = host.authority.rootParticipantId;
		const term = await host.spawnParticipant({ kind: "term", name: "logged", cwd: base });
		const firstCommand = "printf 'first-term-log-output\\n'; sleep 2 &";
		const secondCommand = "printf 'second-term-log-output\\n'";

		await host.execTerm(term, firstCommand);
		await host.waitParticipant(term, "ready");
		assert.equal(host.authority.participant(term)?.status, "ready", "the background job should keep both commands in one open epoch");
		await host.execTerm(term, secondCommand);
		await host.waitParticipant(term, "stopped");

		const warmLog = await host.coordinator.formatParticipantLog(human, term);
		const epochId = warmLog.match(/epoch-id=([^\s]+)/)?.[1];
		assert.ok(epochId?.startsWith("epoch:"), "the durable log should identify its Term epoch");
		assert.equal([...warmLog.matchAll(/\bepoch-id=/g)].length, 1, "both commands should be retained in the same Term epoch");
		assert.equal([...warmLog.matchAll(/\bcommand-id=/g)].length, 2);
		assert.equal([...warmLog.matchAll(/\bexit-code=0\b/g)].length, 2);
		assert.ok(warmLog.includes(`command=${JSON.stringify(firstCommand)}`));
		assert.ok(warmLog.includes(`command=${JSON.stringify(secondCommand)}`));
		assert.match(warmLog, /output:\s*[\s\S]*first-term-log-output/);
		assert.match(warmLog, /output:\s*[\s\S]*second-term-log-output/);

		const session = host.manifest.id;
		await host.dispose();
		host = undefined;
		reopened = await StandalonePiHost.open({ base, stateRoot, session });
		assert.equal(reopened.coordinator.runtimes.has(term), false, "opening a session must not restore a stopped Term adapter");

		const coldLog = await reopened.coordinator.formatParticipantLog(reopened.authority.rootParticipantId, term);
		assert.match(coldLog, new RegExp(`epoch-id=${epochId}`));
		assert.equal([...coldLog.matchAll(/\bepoch-id=/g)].length, 1);
		assert.equal([...coldLog.matchAll(/\bcommand-id=/g)].length, 2);
		assert.equal([...coldLog.matchAll(/\bexit-code=0\b/g)].length, 2);
		assert.ok(coldLog.includes(`command=${JSON.stringify(firstCommand)}`));
		assert.ok(coldLog.includes(`command=${JSON.stringify(secondCommand)}`));
		assert.match(coldLog, /output:\s*[\s\S]*first-term-log-output/);
		assert.match(coldLog, /output:\s*[\s\S]*second-term-log-output/);
		assert.equal(reopened.coordinator.runtimes.has(term), false, "read-only Term log must not construct a live Term adapter or sandbox");
	} finally {
		await host?.dispose();
		await reopened?.dispose();
		rmSync(container, { recursive: true, force: true });
	}
});

test("get rejects an open Term epoch immediately and leaves its background work running", { skip: sandboxRuntime.skip }, async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-term-get-open-"));
	const base = join(container, "workspace");
	const stateRoot = join(container, "state");
	let host: StandalonePiHost | undefined;
	try {
		mkdirSync(base);
		writeFileSync(join(base, "owned.txt"), "owned");
		host = await StandalonePiHost.open({ base, stateRoot });
		const human = host.authority.rootParticipantId;
		const term = await host.spawnParticipant({ kind: "term", name: "background-owner", cwd: base });
		await host.giveTo(term, "file:./");
		await host.execTerm(term, "sleep 30 &");
		await host.waitParticipant(term, "ready");

		const startedAt = Date.now();
		await assert.rejects(() => host!.getFrom(term, "file:./"), /TERM_EPOCH_ACTIVE/);
		assert.ok(Date.now() - startedAt < 2_000, "get must not wait indefinitely for a background Term epoch");
		assert.equal(host.authority.participant(term)?.status, "ready");
		assert.equal(host.authority.ownerOf(host.authority.baseResourceId()), term);

		await host.stopParticipant(term);
		await host.getFrom(term, "file:./");
		assert.equal(host.authority.ownerOf(host.authority.baseResourceId()), human);
	} finally {
		await host?.dispose();
		rmSync(container, { recursive: true, force: true });
	}
});

test("Term interrupt leaves descendants running, while stop and archive consume the whole subtree", { skip: sandboxRuntime.skip }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-tree-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		coordinator = PiCoordinator.createStandalone(manager);
		const parent = await coordinator.spawnParticipant(human, { kind: "term", name: "parent", cwd: workspace });
		const child = await coordinator.spawnParticipant(parent, { kind: "term", name: "child", cwd: workspace });

		await coordinator.termExec(parent, child, "sleep 30");
		await coordinator.termExec(human, parent, "sleep 30");
		await until(() => manager.participant(parent)?.status === "running" && manager.participant(child)?.status === "running");

		await coordinator.interrupt(human, parent);
		assert.equal(manager.participant(parent)?.status, "ready", "a live descendant keeps the interrupted parent ready");
		assert.equal(manager.participant(child)?.status, "running", "interrupt must not stop descendants");

		await coordinator.stop(human, parent);
		assert.equal(manager.participant(parent)?.status, "stopped");
		assert.equal(manager.participant(child)?.status, "stopped");

		await coordinator.archive(human, parent);
		assert.equal(manager.participant(parent), undefined);
		assert.equal(manager.participant(child), undefined);
		await assert.rejects(() => coordinator!.termExec(human, parent, "true"), /Unknown participant/);
		await assert.rejects(() => manager.archiveParticipant(human, parent, () => true), /UNKNOWN_PARTICIPANT/);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("an open Term epoch freezes authority, rejects overlapping native writes, and serves the pre-epoch read snapshot", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-epoch-"));
	let manager: SessionAuthorityManager | undefined;
	let epochOpen = false;
	const term = "term:epoch-integration";
	const epochId = "epoch:integration:1";
	const startedAt = Date.now();
	try {
		manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		await manager.writeFile(human, "snapshot.txt", "before");
		const base = manager.baseResourceId();
		await manager.spawnWith(human, term, "epoch", [], async () => ({}), {
			participantKind: "term",
			inheritWorkspaceRead: true,
			defaultReadRoot: workspace,
		});
		await manager.give(human, term, base);

		const fixedAuthority = await manager.beginTermEpoch({ termId: term, epochId, startedAt });
		epochOpen = true;
		assert.ok(fixedAuthority.writePaths.includes(workspace));
		writeFileSync(join(workspace, "snapshot.txt"), "during");

		const observed = await manager.readFile(human, "snapshot.txt");
		assert.deepEqual(
			{ content: observed.content, stale: observed.stale },
			{ content: "before", stale: true },
			"reads during an epoch must observe the last committed file state",
		);
		await assert.rejects(() => manager!.writeFile(term, "snapshot.txt", "native"), /TERM_EPOCH_WRITE_CONFLICT/);
		await assert.rejects(() => manager!.get(human, term, base), /TERM_EPOCH_AUTHORITY_FROZEN/);

		await manager.finishTermEpoch({ termId: term, epochId, startedAt, endedAt: Date.now(), forced: false });
		epochOpen = false;
		const committed = await manager.readFile(human, "snapshot.txt");
		assert.deepEqual({ content: committed.content, stale: committed.stale }, { content: "during", stale: false });
		assert.equal(manager.participant(term)?.status, "stopped");
	} finally {
		if (epochOpen && manager) {
			await manager.finishTermEpoch({ termId: term, epochId, startedAt, endedAt: Date.now(), forced: true }).catch(() => undefined);
		}
		rmSync(workspace, { recursive: true, force: true });
	}
});
