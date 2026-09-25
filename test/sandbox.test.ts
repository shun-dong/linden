import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SessionAuthorityManager } from "../src/authority/manager.js";
import { DynamicSandbox } from "../src/runtime/sandbox.js";

const hasBwrap = spawnSync("which", ["bwrap"], { stdio: "ignore" }).status === 0;

async function moveWorkspaceTo(manager: SessionAuthorityManager, participantId: string): Promise<void> {
	await manager.give(manager.rootParticipantId, participantId, manager.baseResourceId());
}

test("sandboxed Bash mutates only held Path authority and reconciles versions", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-"));
	const hostSentinel = join(tmpdir(), `linden-host-${process.pid}`);
	writeFileSync(hostSentinel, "host");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-session", stateDir: join(workspace, ".linden-test") });
		const result = await manager.bash(manager.rootParticipantId, `printf ok > bash.txt; test ! -e ${hostSentinel}; cat bash.txt`);
		assert.equal(result.exitCode, 0);
		assert.match(result.output, /ok/);
		assert.equal(readFileSync(join(workspace, "bash.txt"), "utf8"), "ok");
		assert.equal(result.changedResources.length, 1);
	} finally { rmSync(workspace, { recursive: true, force: true }); rmSync(hostSentinel, { force: true }); }
});

test("Bash permits a hardlink group only when every alias stays inside write authority", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-hardlinks-"));
	const outside = mkdtempSync(join(tmpdir(), "linden-bash-hardlinks-outside-"));
	try {
		const first = join(workspace, "first.txt");
		const second = join(workspace, "second.txt");
		writeFileSync(first, "before");
		linkSync(first, second);
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const result = await manager.bash(manager.rootParticipantId, `printf after > ${JSON.stringify(first)}`);
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(readFileSync(first, "utf8"), "after");
		assert.equal(readFileSync(second, "utf8"), "after");

		const escaped = join(workspace, "escaped.txt");
		writeFileSync(escaped, "guarded");
		linkSync(escaped, join(outside, "outside-alias.txt"));
		await assert.rejects(
			manager.bash(manager.rootParticipantId, "true"),
			/HARDLINK_ALIAS_OUTSIDE_WRITE_AUTHORITY/,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("an explicitly shared sandbox tmp remains typed and visible at its public source", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-shared-tmp-"));
	const sharedTmp = join(workspace, "grader-visible-tmp");
	try {
		mkdirSync(sharedTmp);
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test"), sandboxTmpPath: sharedTmp });
		const result = await manager.bash(manager.rootParticipantId, "printf visible > /tmp/result.txt");
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(readFileSync(join(sharedTmp, "result.txt"), "utf8"), "visible");
		assert.ok(result.changedResources.some((resource) => resource.includes("grader-visible-tmp")));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("reads during a long Bash writer return the last committed snapshot without waiting", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-snapshot-read-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-snapshot-read", stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		await manager.writeFile(human, "snapshot.txt", "before");
		const running = manager.bash(human, "printf during > snapshot.txt; sleep 1; printf after > snapshot.txt", { timeout: 5 });
		const physicalDeadline = Date.now() + 2_000;
		while (readFileSync(join(workspace, "snapshot.txt"), "utf8") !== "during") {
			if (Date.now() >= physicalDeadline) throw new Error("Bash did not reach its in-flight write");
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		const startedAt = Date.now();
		const observed = await manager.readFile(human, "snapshot.txt");
		const status = await manager.statFile(human, "snapshot.txt");
		assert.equal(observed.content, "before");
		assert.equal(observed.stale, true);
		assert.equal(status.stale, true);
		assert.ok(Date.now() - startedAt < 500, "read waited for the long Bash writer");
		await running;
		const committed = await manager.readFile(human, "snapshot.txt");
		assert.equal(committed.content, "after");
		assert.equal(committed.stale, false);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("delegated exact File is over-mounted read-only in former owner's broad Path sandbox", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-transfer-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-transfer", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const file = await manager.writeFile(parent, "guarded.txt", "safe");
		const child = "agent:bash-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "bash-child" }));
		await manager.give(parent, child, file.resourceId);
		const result = await manager.bash(parent, "printf hacked > guarded.txt", { timeout: 5 });
		assert.notEqual(result.exitCode, 0);
		assert.equal(readFileSync(join(workspace, "guarded.txt"), "utf8"), "safe");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("owner Bash can rm a tracked exact File and the version tree returns to Absent", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-rm-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-rm", stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const worker = "agent:rm-worker";
		await manager.spawnWith(human, worker, "rm-worker", [], async () => ({ piSessionId: "rm-worker-session" }));
		await moveWorkspaceTo(manager, worker);
		const exact = await manager.file(worker, manager.baseResourceId(), "tracked.md", "write");
		const written = await manager.writeFile(worker, "tracked.md", "tracked");
		const logAfterWrite = manager.resourceLog(worker, exact.resourceId);
		assert.equal(logAfterWrite[logAfterWrite.length - 1].id, written.stateId);
		const removed = await manager.bash(worker, `rm ${workspace}/tracked.md && printf plain > plain.txt`, { timeout: 10 });
		assert.equal(removed.exitCode, 0, removed.output);
		assert.ok(!existsSync(join(workspace, "tracked.md")), "tracked file should be removable by its owner");
		assert.equal(readFileSync(join(workspace, "plain.txt"), "utf8"), "plain");
		const log = manager.resourceLog(worker, exact.resourceId);
		assert.equal(log.length, logAfterWrite.length + 1, "rm should append exactly one new version");
		assert.match(log[log.length - 1].summary, /absent/);
		assert.equal((await manager.statFile(worker, "tracked.md")).state, "Absent");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("an exact-File placeholder reservation race preserves the external replacement", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-bash-placeholder-race-"));
	let sandbox: DynamicSandbox | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-placeholder-race", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const child = "agent:bash-placeholder-child";
		await manager.spawnWith(parent, child, "child", [], async () => ({ piSessionId: "bash-placeholder-child" }));
		const exact = await manager.file(parent, manager.baseResourceId(), "reserved.txt", "write");
		await manager.give(parent, child, exact.resourceId);
		const authority = manager.effectiveAuthority(parent);
		const path = join(workspace, "reserved.txt");
		assert.deepEqual(authority.absentWriteFileExclusions, [path]);

		writeFileSync(path, "external replacement");
		sandbox = new DynamicSandbox(workspace, authority, manager.privateRoots);
		await assert.rejects(sandbox.initialize(), /could not be reserved/);
		const cleanup = sandbox.cleanupPlaceholders();
		assert.equal(readFileSync(path, "utf8"), "external replacement");
		assert.deepEqual(cleanup.removed, []);
		assert.equal(cleanup.violations.length, 1);
		assert.equal(cleanup.violations[0]?.path, path);
	} finally {
		await sandbox?.shutdown();
		rmSync(workspace, { recursive: true, force: true });
	}
});
