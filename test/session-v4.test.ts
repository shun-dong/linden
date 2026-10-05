import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { canonicalBase, fileResourceId, resolvePublicPath } from "../src/runtime/paths.js";
import { SessionRegistry } from "../src/runtime/sessions.js";
import { PiCoordinator } from "../src/pi/runtime.js";
import { assertWellFormedContexts } from "../src/compiler/judgment.js";

test("session manifests preserve immutable canonical bases and resolve unique suffixes", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-session-v4-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const registry = new SessionRegistry(join(container, "state"));
		const first = registry.create(base, "session:11111111-1111-1111-1111-111111111111", { maxAgentDepth: 2 });
		const secondBase = join(container, "second");
		mkdirSync(secondBase);
		registry.create(secondBase, "session:22222222-2222-2222-2222-222211111111");
		assert.equal(first.base, canonicalBase(base));
		assert.equal(first.maxAgentDepth, 2);
		assert.equal(registry.resolve(first.id).maxAgentDepth, 2);
		assert.equal(registry.resolve("11111111-1111-1111-1111-111111111111").id, first.id);
		assert.throws(() => registry.resolve("11111111"), /Ambiguous Linden session suffix/);
		assert.throws(() => registry.resolve("missing"), /Unknown Linden session/);
		assert.throws(() => registry.create(join(container, "absent")), /existing directory/);
		assert.throws(() => registry.create(base, undefined, { maxAgentDepth: 0 }), /positive integer/);
	} finally { rmSync(container, { recursive: true, force: true }); }
});

test("active base leases reject same, ancestor, and descendant bases but allow siblings", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-session-lease-"));
	try {
		const parent = join(container, "projects");
		const left = join(parent, "left");
		const nested = join(left, "nested");
		const right = join(parent, "right");
		for (const path of [left, nested, right]) mkdirSync(path, { recursive: true });
		const registry = new SessionRegistry(join(container, "state"));
		const leftSession = registry.create(left, "session:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
		const nestedSession = registry.create(nested, "session:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
		const rightSession = registry.create(right, "session:cccccccc-cccc-cccc-cccc-cccccccccccc");
		const lease = registry.acquire(leftSession);
		assert.throws(() => registry.acquire(leftSession), /ACTIVE_WRITE_CONFLICT/);
		assert.throws(() => registry.acquire(nestedSession), /ACTIVE_WRITE_CONFLICT/);
		const siblingLease = registry.acquire(rightSession);
		siblingLease.release();
		lease.release();
		const nestedLease = registry.acquire(nestedSession);
		nestedLease.release();
	} finally { rmSync(container, { recursive: true, force: true }); }
});

test("dead active leases are reclaimed", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-session-stale-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const registry = new SessionRegistry(join(container, "state"));
		const manifest = registry.create(base, "session:dddddddd-dddd-dddd-dddd-dddddddddddd");
		writeFileSync(join(registry.activeDir, "stale.json"), JSON.stringify({ schemaVersion: 1, sessionId: "session:stale", base, pid: 2147483647, token: "dead", updatedAt: Date.now() }));
		const lease = registry.acquire(manifest);
		lease.release();
	} finally { rmSync(container, { recursive: true, force: true }); }
});

test("File resolver canonicalizes relative forms and rejects base escape", async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-path-v4-"));
	try {
		const base = join(container, "base");
		const cwd = join(base, "nested");
		mkdirSync(cwd, { recursive: true });
		const plain = resolvePublicPath("note.txt", cwd, base, []);
		assert.equal(resolvePublicPath("./note.txt", cwd, base, []), plain);
		assert.equal(fileResourceId(plain), fileResourceId(resolvePublicPath(plain, base, base, [])));
		assert.match(fileResourceId(base, true), /^file:.*\/$/);
		assert.equal(resolvePublicPath("../../escape.txt", cwd, base, []), join(container, "escape.txt"));
		const manager = await SessionAuthorityManager.open({ base, stateRoot: join(container, "state"), lindenSessionId: "session:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
		const baseResource = manager.baseResourceId();
		assert.equal(manager.snapshot().resources[baseResource]?.kind, "file-region");
	} finally { rmSync(container, { recursive: true, force: true }); }
});

test("authority transfers require typed resource IDs and materialize every legal File ID", async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-resource-id-v4-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const base = join(container, "base");
		const nested = join(base, "nested");
		mkdirSync(nested, { recursive: true });
		const manager = await SessionAuthorityManager.open({ base, stateRoot: join(container, "state"), lindenSessionId: "session:abababab-abab-abab-abab-abababababab" });
		const human = manager.rootParticipantId;
		const child = "agent:typed-resource-child";
		await manager.spawnWith(human, child, "typed", [], async () => ({ piSessionId: "typed-resource-child" }), { inheritWorkspaceRead: false });
		coordinator = PiCoordinator.createStandalone(manager);

		await assert.rejects(coordinator.give(human, child, "./future.txt"), /RESOURCE_ID_REQUIRED/);
		await assert.rejects(coordinator.give(human, child, "file:."), /FILE_RESOURCE_KIND_MISMATCH.*directory/);

		const relative = await coordinator.give(human, child, "file:./future.txt");
		assert.deepEqual(relative.moved, [fileResourceId(join(base, "future.txt"))]);
		assert.equal(manager.resource(relative.moved[0])?.kind, "file");

		const canonicalId = fileResourceId(join(base, "canonical.txt"));
		assert.equal(manager.resource(canonicalId), undefined, "canonical ID starts unmaterialized");
		assert.deepEqual((await coordinator.give(human, child, canonicalId)).moved, [canonicalId]);

		const region = await coordinator.give(human, child, "&file:./nested/");
		assert.deepEqual(region.moved, [fileResourceId(nested, true)]);
		assert.equal(manager.resource(region.moved[0])?.ownerId, human);
		assert.ok(manager.resource(region.moved[0])?.pointers.includes(child));
	} finally {
		await coordinator?.dispose();
		rmSync(container, { recursive: true, force: true });
	}
});

test("Γ/Δ contexts are the sole ownership source across transfer", async () => {
	const container = mkdtempSync(join(tmpdir(), "linden-compiler-context-"));
	try {
		const manager = await SessionAuthorityManager.open({ base: container, stateDir: join(container, ".state"), lindenSessionId: "session:ffffffff-ffff-ffff-ffff-ffffffffffff" });
		const human = manager.rootParticipantId;
		const child = "agent:context-child";
		await manager.spawnWith(human, child, "context", [], async () => ({ piSessionId: "context-child" }));
		const file = await manager.writeFile(human, "context.txt", "one");
		await manager.give(human, child, file.resourceId);
		await assert.rejects(manager.writeFile(human, "context.txt", "stale"), /UNAUTHORIZED_WRITE/);
		await manager.get(human, child, file.resourceId);
		const state = manager.snapshot();
		assert.equal(manager.ownerOf(file.resourceId), human);
		assert.equal(Object.hasOwn(state.resources[file.resourceId], "ownerId"), false);
		assert.equal(Object.hasOwn(state.resources[file.resourceId], "pointers"), false);
		assertWellFormedContexts(state);
	} finally { rmSync(container, { recursive: true, force: true }); }
});
