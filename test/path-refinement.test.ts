import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxRequirements } from "./runtime-requirements.js";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

const sandboxRuntime = await sandboxRequirements();
const hasBwrap = sandboxRuntime.available;

async function moveWorkspaceTo(manager: SessionAuthorityManager, participantId: string): Promise<void> {
	await manager.give(manager.rootParticipantId, participantId, manager.baseResourceId());
}

test("a delegated nested Path overrides a broader writer in native and Bash gateways", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-path-refinement-"));
	const stateDir = join(workspace, ".linden-test");
	try {
		mkdirSync(join(workspace, "nested"));
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "path-refinement", stateDir });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const child = "agent:path-child";
		await manager.spawnWith(parent, child, "path child", [], async () => ({ piSessionId: "path-child" }));
		const nested = await manager.subpath(parent, manager.baseResourceId(), "nested", "write");
		await manager.give(parent, child, nested.resourceId);
		const parentAuthority = manager.effectiveAuthority(parent);
		const parentRegion = parentAuthority.writeExpressions.find((expression) => expression.include === workspace);
		assert.deepEqual(parentRegion, { include: workspace, exclude: [join(workspace, "nested")] });
		await assert.rejects(manager.writeFile(parent, "nested/owned.txt", "parent"), /UNAUTHORIZED_WRITE/);
		await manager.writeFile(child, "nested/owned.txt", "child");
		assert.equal((await manager.readFile(parent, "nested/owned.txt")).content, "child");
		if (hasBwrap) {
			const result = await manager.bash(parent, "printf parent > nested/owned.txt", { timeout: 5 });
			assert.notEqual(result.exitCode, 0);
			assert.equal(readFileSync(join(workspace, "nested", "owned.txt"), "utf8"), "child");
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("moving a Path also moves owned nested Path refinements", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-path-move-"));
	const stateDir = join(workspace, ".linden-test");
	try {
		mkdirSync(join(workspace, "nested"));
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "path-move", stateDir });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const child = "agent:path-move-child";
		await manager.spawnWith(parent, child, "path child", [], async () => ({ piSessionId: "path-move-child" }));
		const baseResource = manager.baseResourceId();
		const nested = await manager.subpath(parent, baseResource, "nested", "write");
		const moved = await manager.give(parent, child, baseResource);
		assert.ok(moved.includes(nested.resourceId));
		assert.equal(manager.resource(nested.resourceId)?.ownerId, child);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("spawn snapshots workspace File/Path read authority by default and supports explicit opt-out", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-default-read-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "default-read", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await manager.writeFile(manager.rootParticipantId, "shared.txt", "shared");
		const inherited = "agent:inherited-read";
		await manager.spawnWith(parent, inherited, "inherited", [], async () => ({ piSessionId: "inherited" }));
		assert.equal((await manager.readFile(inherited, "shared.txt")).content, "shared");
		await assert.rejects(manager.writeFile(inherited, "shared.txt", "no"), /UNAUTHORIZED_WRITE/);
		const isolated = "agent:isolated-read";
		await manager.spawnWith(parent, isolated, "isolated", [], async () => ({ piSessionId: "isolated" }), { inheritWorkspaceRead: false });
		await assert.rejects(manager.readFile(isolated, "shared.txt"), /UNAUTHORIZED_READ/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a File-region read pointer covers materialized descendants independent of grant order", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-region-read-set-"));
	try {
		mkdirSync(join(workspace, "nested"));
		const options = { workspace, sessionId: "region-read-set", stateDir: join(workspace, ".linden-test") };
		const manager = await SessionAuthorityManager.open(options);
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const base = manager.baseResourceId();
		const before = await manager.writeFile(parent, "before.txt", "before");
		await manager.subpath(parent, base, "nested", "write");

		const child = "agent:region-reader";
		await manager.spawnWith(parent, child, "region reader", [{ resourceId: base, mode: "read" }], async () => ({ piSessionId: "region-reader" }), { inheritWorkspaceRead: false });
		assert.equal(manager.snapshot().contexts[child].gamma.resourcePointers.includes(before.resourceId), false, "the grant remains one set-valued region pointer");
		assert.equal((await manager.readFile(child, "before.txt")).content, "before");
		assert.equal((await manager.statFile(child, "nested/future.txt")).state, "Absent");
		await assert.rejects(manager.writeFile(child, "before.txt", "no"), /UNAUTHORIZED_WRITE/);
		assert.equal(manager.effectiveAuthority(child).denyReadPaths.includes(join(workspace, "before.txt")), false);
		const direct = "agent:region-direct-reader";
		await manager.spawnWith(parent, direct, "direct region reader", [], async () => ({ piSessionId: "region-direct-reader" }), { inheritWorkspaceRead: false });
		await manager.give(parent, direct, base, "read");
		assert.equal((await manager.readFile(direct, "before.txt")).content, "before");

		const grandchild = "agent:region-reader-child";
		await manager.spawnWith(child, grandchild, "region reader child", [{ resourceId: base, mode: "read" }], async () => ({ piSessionId: "region-reader-child" }), { inheritWorkspaceRead: false });
		assert.equal((await manager.readFile(grandchild, "before.txt")).content, "before");

		const after = await manager.writeFile(parent, "after.txt", "after");
		assert.equal(manager.snapshot().contexts[child].gamma.resourcePointers.includes(after.resourceId), false, "later materialization does not backfill an exact pointer");
		assert.equal(manager.snapshot().contexts[grandchild].gamma.resourcePointers.includes(after.resourceId), false, "nested readers retain the same set-valued region pointer");
		assert.equal(manager.snapshot().contexts[direct].gamma.resourcePointers.includes(after.resourceId), false, "direct give also remains one set-valued pointer");
		assert.equal((await manager.readFile(child, "after.txt")).content, "after");
		assert.equal((await manager.readFile(grandchild, "after.txt")).content, "after");
		assert.equal((await manager.readFile(direct, "after.txt")).content, "after");

		const reopened = await SessionAuthorityManager.open({ ...options, lindenSessionId: manager.sessionId });
		for (const reader of [child, grandchild, direct]) {
			assert.equal((await reopened.readFile(reader, "before.txt")).content, "before");
			assert.equal((await reopened.readFile(reader, "after.txt")).content, "after");
			assert.equal(reopened.snapshot().contexts[reader].gamma.resourcePointers.includes(after.resourceId), false);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("an absent exact File can be delegated and subtracts that location from the parent's Path writer", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-absent-file-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "absent-file", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const child = "agent:absent-owner";
		await manager.spawnWith(parent, child, "absent owner", [], async () => ({ piSessionId: "absent-owner" }));
		const exact = await manager.file(parent, manager.baseResourceId(), "future.txt", "write");
		const before = await manager.statFile(parent, "future.txt");
		assert.equal(before.state, "Absent");
		await manager.give(parent, child, exact.resourceId);
		const parentRegion = manager.effectiveAuthority(parent).writeExpressions.find((expression) => expression.include === workspace);
		assert.deepEqual(parentRegion, { include: workspace, exclude: [join(workspace, "future.txt")] });
		await assert.rejects(manager.writeFile(parent, "future.txt", "parent"), /UNAUTHORIZED_WRITE/);
		if (hasBwrap) {
			const authority = manager.effectiveAuthority(parent);
			assert.deepEqual(authority.absentWriteFileExclusions, [join(workspace, "future.txt")]);
			assert.deepEqual(authority.unsafeAbsentWriteExclusions, []);
			const result = await manager.bash(parent, "test -f future.txt && test ! -s future.txt && ! printf parent > future.txt", { timeout: 5 });
			assert.equal(result.exitCode, 0, result.output);
			assert.equal(existsSync(join(workspace, "future.txt")), false);
			assert.equal(result.changedResources.includes(exact.resourceId), false);
			assert.equal(result.notices.length, 1);
		}
		await manager.writeFile(child, "future.txt", "child");
		const after = await manager.statFile(parent, "future.txt");
		assert.equal(after.state, "Present");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
test("a modified absent-File placeholder is retained and marks the delegated File divergent", { skip: sandboxRuntime.skip }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-absent-file-integrity-"));
	const target = join(workspace, "guarded.txt");
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "absent-file-integrity", stateDir: join(workspace, ".linden-test") });
		const parent = manager.sessionParticipantId;
		await moveWorkspaceTo(manager, parent);
		const child = "agent:absent-integrity-owner";
		await manager.spawnWith(parent, child, "absent integrity owner", [], async () => ({ piSessionId: "absent-integrity-owner" }));
		const exact = await manager.file(parent, manager.baseResourceId(), "guarded.txt", "write");
		await manager.give(parent, child, exact.resourceId);
		const running = manager.bash(parent, "sleep 1", { timeout: 5 });
		const deadline = Date.now() + 2_000;
		while (!existsSync(target) && Date.now() < deadline) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
		assert.equal(existsSync(target), true, "sandbox did not create the absent-File placeholder");
		writeFileSync(target, "external");
		await assert.rejects(running, /BASH_SANDBOX_INTEGRITY/);
		assert.equal(readFileSync(target, "utf8"), "external");
		assert.ok((manager.resource(exact.resourceId) as any).divergence);
		await assert.rejects(manager.writeFile(child, "guarded.txt", "child"), /RESOURCE_DIVERGED/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
