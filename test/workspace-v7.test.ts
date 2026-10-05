import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxRequirements } from "./runtime-requirements.js";
import { createConnection } from "node:net";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { SessionRegistry } from "../src/runtime/sessions.js";
import { fileResourceId } from "../src/runtime/paths.js";
import { NetGuard } from "../src/runtime/net-guard.js";
import { netReference } from "../src/runtime/net.js";
import { authoritySummary, managedParticipants } from "../src/runtime/authority-display.js";
import { checkProgram } from "../src/compiler/checker.js";
import { PiCoordinator, RUNTIME_NOTICE } from "../src/pi/runtime.js";
import { StandalonePiHost } from "../src/pi/host.js";
import { authorizedReadTool } from "../src/pi/read.js";
import { parseCliOptions } from "../src/cli.js";
import { createReadToolDefinition, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const temp = () => mkdtempSync(join(tmpdir(), "linden-v7-"));
const options = (base: string) => ({ base, stateDir: join(base, ".state"), lindenSessionId: "session:v7-test" });
const readContext = {} as ExtensionContext;
function imagePng(width = 1, height = 1, rgb = [255, 0, 0]): Buffer {
	const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
	const chunk = (type: string, data: Buffer) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, out.length - 4)), out.length - 4); return out; };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
async function agent(manager: SessionAuthorityManager, id = "agent:child", parent = manager.rootParticipantId) {
	await manager.spawnWith(parent, id, id, [], async () => ({}), { inheritWorkspaceRead: false });
	return id;
}
async function acknowledge(manager: SessionAuthorityManager) {
	for (const event of manager.snapshot().runtimeEvents ?? []) await manager.acknowledgeRuntimeEvent(event.id);
}

test("typed startup permissions replace per-kind defaults; root is only a position", async () => {
	const base = temp(); const outside = temp();
	try {
		writeFileSync(join(outside, "read.txt"), "outside");
		const manager = await SessionAuthorityManager.open({ ...options(base), permissions: [`&file:${outside}/`, "&net:tcp/dns/EXAMPLE.com.:443"] });
		assert.equal((await manager.readFile(manager.rootParticipantId, join(outside, "read.txt"))).content, "outside");
		assert.throws(() => manager.baseResourceId(), /not implicit/);
		await assert.rejects(manager.writeFile(manager.rootParticipantId, join(outside, "read.txt"), "denied"), /UNAUTHORIZED_WRITE/);
		assert.deepEqual(manager.effectiveAuthority(manager.rootParticipantId).netEndpoints, ["net:tcp/dns/example.com:443"]);
		const child = await agent(manager);
		await assert.rejects(manager.give(manager.rootParticipantId, child, "net:tcp/dns/example.com:443", "read"), /UNAUTHORIZED/);
		const restored = await SessionAuthorityManager.open(options(base));
		assert.equal(restored.ownerOf(fileResourceId(outside, true)), "environment");
		assert.equal((await restored.readFile(restored.rootParticipantId, join(outside, "read.txt"))).content, "outside");
		assert.equal(parseCliOptions([`&file:${outside}/`, "&net:tcp/public"])?.permissions?.length, 2);
		assert.throws(() => parseCliOptions(["--web", "example.com"]), /Unknown/);
	} finally { rmSync(base, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("leases compare complete File write sets, allowing shared roots and read overlap", () => {
	const base = temp();
	const leases: Array<{ release(): void }> = [];
	try {
		mkdirSync(join(base, "readonly"));
		const registry = new SessionRegistry(join(base, ".registry"));
		const first = registry.create(base, undefined, { permissions: [`file:${base}/`, `&file:${base}/readonly/`] });
		const second = registry.create(base, undefined, { permissions: [`file:${base}/readonly/`] });
		const readOnly = registry.create(base, undefined, { permissions: [`&file:${base}/`] });
		leases.push(registry.acquire(first), registry.acquire(second), registry.acquire(readOnly));
		assert.throws(() => registry.acquire(readOnly), /ACTIVE_WRITE_CONFLICT/, "one workspace cannot be activated twice even without writes");
		const conflict = registry.create(base, undefined, { permissions: [`file:${base}/other.txt`] });
		assert.throws(() => registry.acquire(conflict), /ACTIVE_WRITE_CONFLICT/);
	} finally { leases.forEach((lease) => lease.release()); rmSync(base, { recursive: true, force: true }); }
});

test("parent get is a request; all-of-mine grants only currently held authority", async () => {
	const base = temp(); let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager); const sibling = await agent(manager, "agent:sibling");
		const file = await manager.writeFile(manager.rootParticipantId, "owned.txt", "owned");
		coordinator = PiCoordinator.createStandalone(manager);
		const payloads = new Map<string, any>();
		coordinator.runtimes.set(child, { participantId: child, isRunning: () => false, abort: async () => {}, summary: () => child, appendEntry: async (_type: string, data: any) => { payloads.set(data.messageId, data); return data.messageId; }, readPayload: (id: string) => payloads.get(id), deliverBatch: async () => {}, appendRuntimeNotice: async () => "notice" } as any);
		const requested = await coordinator.getPermission(child, manager.rootParticipantId, "file:owned.txt", base);
		assert.equal(requested.status, "pending");
		assert.equal(manager.ownerOf(file.resourceId), manager.rootParticipantId);
		assert.equal(manager.pendingMessages(manager.rootParticipantId).length, 1);
		await manager.setPermissionMode(manager.rootParticipantId, "all-of-mine");
		assert.equal((await coordinator.getPermission(child, manager.rootParticipantId, file.resourceId)).status, "granted");
		assert.equal(manager.ownerOf(file.resourceId), child);
		assert.equal((await coordinator.getPermission(child, manager.rootParticipantId, file.resourceId)).status, "granted", "already held permissions are idempotent");
		const other = await manager.writeFile(manager.rootParticipantId, "sibling.txt", "sibling");
		await manager.give(manager.rootParticipantId, sibling, other.resourceId);
		assert.equal((await coordinator.getPermission(child, manager.rootParticipantId, other.resourceId)).status, "unavailable");
		assert.equal(manager.ownerOf(other.resourceId), sibling);
	} finally { await coordinator?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("committed runtime notices retry without duplicate context or waking a stopped Agent", async () => {
	const base = temp(); let coordinator: PiCoordinator | undefined;
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const file = await manager.writeFile(manager.rootParticipantId, "notice.txt", "notice");
		await manager.give(manager.rootParticipantId, child, file.resourceId);
		manager = await SessionAuthorityManager.open(options(base));
		const event = manager.snapshot().runtimeEvents!.find((item) => item.participantId === child)!;
		coordinator = PiCoordinator.createStandalone(manager);
		const entries: any[] = [];
		let appended = 0;
		coordinator.runtimes.set(child, { participantId: child, isRunning: () => false, abort: async () => {}, summary: () => child, entries: () => entries, appendRuntimeNotice: async (_text: string, settings: any) => {
			assert.equal(settings.continueLoop, false);
			appended++;
			entries.push({ type: "custom_message", details: { eventId: settings.eventId } });
			throw new Error("fixture: adapter failed after persisting the notice");
		} } as any);
		await coordinator.flushRuntimeEvents();
		assert.equal(manager.snapshot().runtimeEvents!.find((item) => item.id === event.id)?.delivered, undefined);
		await coordinator.flushRuntimeEvents();
		assert.equal(appended, 1);
		assert.equal(manager.participant(child)?.status, "stopped");
		manager = await SessionAuthorityManager.open(options(base));
		assert.equal(manager.snapshot().runtimeEvents!.find((item) => item.id === event.id)?.delivered, true);
	} finally { await coordinator?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("participant unarchive restores atomically and adds no notice for unchanged Files", async () => {
	const base = temp();
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager); const sibling = await agent(manager, "agent:sibling");
		const a = await manager.writeFile(manager.rootParticipantId, "a.txt", "a");
		const b = await manager.writeFile(manager.rootParticipantId, "b.txt", "b");
		await manager.give(manager.rootParticipantId, child, a.resourceId);
		await manager.give(manager.rootParticipantId, child, b.resourceId);
		await acknowledge(manager);
		await manager.archiveParticipant(manager.rootParticipantId, child, () => true);
		await manager.give(manager.rootParticipantId, sibling, b.resourceId);
		manager = await SessionAuthorityManager.open(options(base));
		await assert.rejects(manager.unarchiveParticipant(manager.rootParticipantId, child), /UNARCHIVE_AUTHORITY_CONFLICT/);
		assert.equal(manager.participant(child), undefined);
		assert.equal(manager.ownerOf(a.resourceId), manager.rootParticipantId);
		await manager.get(manager.rootParticipantId, sibling, b.resourceId);
		await manager.unarchiveParticipant(manager.rootParticipantId, child);
		assert.equal(manager.participant(child)?.status, "stopped");
		assert.equal(manager.ownerOf(a.resourceId), child);
		assert.equal(manager.ownerOf(b.resourceId), child);
		assert.equal(manager.snapshot().runtimeEvents?.filter((event) => !event.delivered && event.participantId === child).length, 0);
		manager = await SessionAuthorityManager.open(options(base));
		assert.equal((await manager.readFile(child, "a.txt")).content, "a");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("changed archived Files become a new version and restored Net always emits a notice", async () => {
	const base = temp();
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const file = await manager.writeFile(manager.rootParticipantId, "a.txt", "before");
		const net = await manager.materializeNet(manager.rootParticipantId, "net:tcp/dns/example.com:443");
		await manager.give(manager.rootParticipantId, child, file.resourceId);
		await manager.give(manager.rootParticipantId, child, net);
		await acknowledge(manager);
		await manager.archiveParticipant(manager.rootParticipantId, child, () => true);
		writeFileSync(join(base, "a.txt"), "after");
		manager = await SessionAuthorityManager.open(options(base));
		await manager.unarchiveParticipant(manager.rootParticipantId, child);
		assert.equal((await manager.readFile(child, "a.txt")).content, "after");
		const notice = manager.snapshot().runtimeEvents?.find((event) => !event.delivered && event.participantId === child);
		assert.match(notice?.text ?? "", /Files changed while archived/);
		assert.match(notice?.text ?? "", /Connections and publication bridges were not restored/);
		await manager.archiveParticipant(manager.rootParticipantId, child, () => true);
		await acknowledge(manager);
		await manager.unarchiveParticipant(manager.rootParticipantId, child);
		const second = manager.snapshot().runtimeEvents?.find((event) => !event.delivered && event.participantId === child);
		assert.match(second?.text ?? "", /Net authority restored/);
		assert.doesNotMatch(second?.text ?? "", /Files changed/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("archived workspace disables all rights and restores them after reopening", async () => {
	const base = temp();
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const file = await manager.writeFile(manager.rootParticipantId, "a.txt", "before");
		await manager.give(manager.rootParticipantId, child, file.resourceId);
		await acknowledge(manager);
		await manager.archiveWorkspace();
		await assert.rejects(manager.readFile(child, "a.txt"), /ARCHIVED/);
		writeFileSync(join(base, "a.txt"), "after");
		manager = await SessionAuthorityManager.open(options(base));
		await manager.unarchiveWorkspace();
		assert.equal((await manager.readFile(child, "a.txt")).content, "after");
		assert.equal(manager.participant(child)?.status, "stopped");
		const persisted = JSON.parse(readFileSync(join(base, ".state", "ledger.json"), "utf8"));
		persisted.runtimeMetadata.explicitAuthority = false;
		writeFileSync(join(base, ".state", "ledger.json"), JSON.stringify(persisted));
		await assert.rejects(SessionAuthorityManager.open(options(base)), /INVALID_LEDGER_V7/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("save imports external changes and deletions but excludes child-owned Files", async () => {
	const base = temp();
	try {
		writeFileSync(join(base, "initial.txt"), "initial");
		const manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const excluded = await manager.writeFile(manager.rootParticipantId, "child.txt", "child");
		await manager.give(manager.rootParticipantId, child, excluded.resourceId);
		writeFileSync(join(base, "initial.txt"), "changed");
		writeFileSync(join(base, "new.txt"), "new");
		writeFileSync(join(base, "child.txt"), "external-child-change");
		const saved = await manager.saveExternalChanges(manager.rootParticipantId);
		assert.deepEqual(saved.sort(), [fileResourceId(join(base, "initial.txt")), fileResourceId(join(base, "new.txt"))].sort());
		rmSync(join(base, "new.txt"));
		assert.deepEqual(await manager.saveExternalChanges(manager.rootParticipantId), [fileResourceId(join(base, "new.txt"))]);
		assert.deepEqual(await manager.saveExternalChanges(manager.rootParticipantId), []);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("save includes registered cache Files and explicitly granted cache roots", async () => {
	const base = temp();
	try {
		mkdirSync(join(base, "dist"));
		const manager = await SessionAuthorityManager.open(options(base));
		const tracked = await manager.writeFile(manager.rootParticipantId, "dist/tracked.txt", "before");
		writeFileSync(join(base, "dist", "tracked.txt"), "after");
		assert.deepEqual(await manager.saveExternalChanges(manager.rootParticipantId), [tracked.resourceId]);
		const explicit = await SessionAuthorityManager.open({ base, stateDir: join(base, ".explicit"), permissions: [`file:${join(base, "dist")}/`], noDefaultPermissions: true });
		writeFileSync(join(base, "dist", "new.txt"), "new");
		assert.deepEqual(await explicit.saveExternalChanges(explicit.rootParticipantId), [fileResourceId(join(base, "dist", "new.txt"))]);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("authority summaries simplify a managed subtree while keeping per-node write exclusions", async () => {
	const base = temp();
	try {
		const manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const region = await manager.subpath(manager.rootParticipantId, manager.baseResourceId(), "child", "write");
		await manager.give(manager.rootParticipantId, child, region.resourceId);
		const state = manager.snapshot();
		assert.match(authoritySummary(state, [manager.rootParticipantId]), /−/);
		assert.doesNotMatch(authoritySummary(state, managedParticipants(state, manager.rootParticipantId)), /−/);
		assert.match(PiCoordinator.createStandalone(manager).formatParticipantTree(manager.rootParticipantId), /\| file:/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("Net canonicalization and use projections preserve exact endpoint identity", async () => {
	assert.equal(netReference("net:tcp/[2001:0db8::1]:80").id, "net:tcp/[2001:db8::1]:80");
	assert.equal(netReference("net:tcp/dns/EXAMPLE.com.:0443").id, "net:tcp/dns/example.com:443");
	assert.throws(() => netReference("net:udp/1.2.3.4:80"));
	assert.throws(() => netReference("net:tcp/1.2.3.4:65536"));
	const projection = new NetGuard(() => ({ endpoints: ["net:tcp/127.0.0.1:40001"], exclusions: [] }));
	assert.equal((await projection.resolveTarget("127.0.0.1", 40001))?.address, "127.0.0.1");
	assert.equal(await projection.resolveTarget("127.0.0.1", 40002), undefined);
	const audit: string[] = [];
	const published = new NetGuard(() => ({ endpoints: ["net:tcp/dns/service.example:443"], exclusions: [] }), () => "/tmp/publication.sock", (id, address) => audit.push(`${id} ${address}`));
	assert.equal((await published.resolveTarget("service.example", 443))?.socketPath, "/tmp/publication.sock");
	assert.deepEqual(audit, ["net:tcp/dns/service.example:443 unix:/tmp/publication.sock"]);
	const broad = new NetGuard(() => ({ endpoints: ["net:tcp/public"], exclusions: ["net:tcp/1.1.1.1:443"] }));
	assert.equal(await broad.resolveTarget("127.0.0.1", 40001), undefined);
	assert.equal(await broad.resolveTarget("1.1.1.1", 443), undefined);
	assert.equal((await broad.resolveTarget("1.1.1.1", 80))?.address, "1.1.1.1");
});

test("Net refinements keep exclusions after ledger roundtrip and &Net cannot be forwarded", async () => {
	const base = temp();
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const endpoint = await manager.materializeNet(manager.rootParticipantId, "net:tcp/1.1.1.1:443");
		await manager.give(manager.rootParticipantId, child, endpoint);
		manager = await SessionAuthorityManager.open(options(base));
		assert.ok(manager.effectiveAuthority(manager.rootParticipantId).netExclusions?.includes(endpoint));
		assert.equal(await manager.networkGuard(manager.rootParticipantId).resolveTarget("1.1.1.1", 443), undefined);
		const grandchild = await agent(manager, "agent:grandchild", child);
		await manager.give(child, grandchild, endpoint, "read");
		await assert.rejects(manager.give(grandchild, child, endpoint, "read"), /UNAUTHORIZED/);
		assert.equal(checkProgram("n : Net\nconnect &n", { allowCompleteDeclarations: true }).diagnostics.length, 0);
		assert.ok(checkProgram("n : &Net\nc = spawn! Agent \"task\" n", { allowCompleteDeclarations: true }).diagnostics.some((diagnostic) => diagnostic.code === "TYPE_MISMATCH"));
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("native Pi read preserves image output and absence errors behind File authorization", async () => {
	const base = temp();
	try {
		const png = imagePng();
		writeFileSync(join(base, "image.png"), png);
		const manager = await SessionAuthorityManager.open(options(base));
		const tool = authorizedReadTool(manager, manager.rootParticipantId, base);
		const native = createReadToolDefinition(base);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		assert.deepEqual(tool.promptGuidelines, native.promptGuidelines);
		const result = await tool.execute("image", { path: "image.png" }, undefined, undefined, readContext);
		assert.ok(result.content.some((item) => item.type === "image"));
		assert.deepEqual(result, await native.execute("image", { path: "image.png" }, undefined, undefined, readContext));
		writeFileSync(join(base, "large.png"), imagePng(2048, 32));
		assert.deepEqual(await tool.execute("large", { path: "large.png" }, undefined, undefined, readContext), await native.execute("large", { path: "large.png" }, undefined, undefined, readContext));
		await assert.rejects(tool.execute("absent", { path: "absent.txt" }, undefined, undefined, readContext), /ENOENT/);
		assert.equal((await manager.statFile(manager.rootParticipantId, "absent.txt")).state, "Absent");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("image read rejects unauthorized paths and keeps the published view during a Term epoch", async () => {
	const base = temp();
	try {
		const red = imagePng();
		writeFileSync(join(base, "image.png"), red);
		const manager = await SessionAuthorityManager.open(options(base));
		const reader = await agent(manager, "agent:reader");
		const tool = authorizedReadTool(manager, reader, base);
		await assert.rejects(tool.execute("denied", { path: "image.png" }, undefined, undefined, readContext), /UNAUTHORIZED_READ/);
		await manager.give(manager.rootParticipantId, reader, manager.baseResourceId(), "read");
		await manager.spawnWith(manager.rootParticipantId, "term:writer", "writer", [{ resourceId: manager.baseResourceId(), mode: "move" }], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
		const epoch = { termId: "term:writer", epochId: "epoch:image", startedAt: Date.now() };
		await manager.beginTermEpoch(epoch);
		writeFileSync(join(base, "image.png"), imagePng(1, 1, [0, 0, 255]));
		writeFileSync(join(base, "unpublished.png"), red);
		const before = await tool.execute("published", { path: "image.png" }, undefined, undefined, readContext);
		assert.deepEqual(before.content.find((item) => item.type === "image"), { type: "image", mimeType: "image/png", data: red.toString("base64") });
		await assert.rejects(tool.execute("unpublished", { path: "unpublished.png" }, undefined, undefined, readContext), /ENOENT/);
		await manager.finishTermEpoch({ ...epoch, endedAt: Date.now(), forced: false });
		assert.deepEqual(await tool.execute("committed", { path: "image.png" }, undefined, undefined, readContext), await createReadToolDefinition(base).execute("native", { path: "image.png" }, undefined, undefined, readContext));
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("standalone exit archives its workspace and subsequent open restores authority", async () => {
	const base = temp(); let host: StandalonePiHost | undefined;
	try {
		host = await StandalonePiHost.open({ base, stateRoot: join(base, ".registry") });
		const id = host.manifest.id;
		await host.authority.writeFile(host.authority.rootParticipantId, "human.txt", "saved");
		await host.dispose();
		assert.equal(host.authority.snapshot().archived, true);
		host = await StandalonePiHost.open({ session: id, stateRoot: join(base, ".registry") });
		assert.equal(host.authority.snapshot().archived, false);
		assert.equal((await host.authority.readFile(host.authority.rootParticipantId, "human.txt")).content, "saved");
	} finally { await host?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("unarchive retains unread mail for explicit receive without activating the old task", async () => {
	const base = temp();
	try {
		let manager = await SessionAuthorityManager.open(options(base));
		const child = await agent(manager);
		const message = await manager.sendWithPayload(manager.rootParticipantId, child, async (id) => manager.store.writePrivatePayload(id, { messageId: id, senderId: manager.rootParticipantId, payload: "old task" }));
		await manager.archiveParticipant(manager.rootParticipantId, child, () => true);
		manager = await SessionAuthorityManager.open(options(base));
		await manager.unarchiveParticipant(manager.rootParticipantId, child);
		assert.equal(manager.pendingMessages(child).length, 1);
		assert.equal(manager.pendingMessages(child, undefined, "follow_up").length, 0);
		assert.deepEqual(await manager.claimPendingMessages(child, "follow_up", "batch:deferred"), []);
		await manager.receive(child, manager.rootParticipantId, message.id);
		assert.equal(manager.pendingMessages(child).length, 0);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("fork copies one branch to fresh IDs, adds its notice, and carries no authority or policy", async () => {
	const base = temp(); let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open(options(base));
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.setToolFactory(() => []);
		coordinator.setHostedRuntimeFactory(async (_id, sessionManager) => ({ session: { sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager, isStreaming: false, subscribe() {}, async abort() {}, dispose() {} }, async dispose() {} } as any));
		const file = await manager.writeFile(manager.rootParticipantId, "source.txt", "source");
		const sourceId = await coordinator.spawn(manager.rootParticipantId, "source", undefined, [file.resourceId], false, base);
		const source = SessionManager.open(manager.participant(sourceId)!.sessionFile!);
		const historicalId = source.appendMessage({ role: "user", content: "historical task", timestamp: Date.now() });
		await manager.setPermissionMode(sourceId, "all-of-mine");
		const forkId = await coordinator.fork(manager.rootParticipantId, sourceId, "copy");
		assert.notEqual(forkId, sourceId);
		assert.deepEqual(manager.authoritySnapshot(forkId).owned, []);
		assert.deepEqual(manager.authoritySnapshot(forkId).pointers, []);
		assert.deepEqual(manager.participant(forkId)?.childIds, []);
		assert.notEqual(manager.participant(forkId)?.permissionMode, "all-of-mine");
		assert.equal(manager.participant(forkId)?.status, "stopped");
		assert.equal(manager.ownerOf(file.resourceId), sourceId);
		assert.equal(manager.pendingMessages(forkId).length, 0);
		const copied = SessionManager.open(manager.participant(forkId)!.sessionFile!);
		assert.equal(copied.getEntry(historicalId), undefined);
		assert.ok(copied.getEntries().some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("historical task")));
		assert.ok(copied.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === RUNTIME_NOTICE && String(entry.content).includes("no File or Net permissions")));
		assert.equal(source.getEntry(historicalId)?.id, historicalId, "source history is preserved");
	} finally { await coordinator?.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("v6 migration materializes implicit entry rights and preserves its original backup", async () => {
	const base = temp();
	try {
		const manager = await SessionAuthorityManager.open(options(base));
		const path = join(base, ".state", "ledger.json");
		const legacy = JSON.parse(readFileSync(path, "utf8"));
		legacy.schemaVersion = 6;
		legacy.Delta = legacy.Delta.filter((entry: any) => entry.type !== "Net" && entry.type !== "FileRegion");
		legacy.Gamma = legacy.Gamma.filter((entry: any) => entry.type !== "&Net" && entry.type !== "&FileRegion");
		for (const key of ["explicitAuthority", "initialPermissions", "archives", "runtimeEvents", "saveBaseline"]) delete legacy.runtimeMetadata[key];
		writeFileSync(path, JSON.stringify(legacy));
		const migrated = await SessionAuthorityManager.open(options(base));
		assert.equal(migrated.snapshot().schemaVersion, 8);
		assert.equal(migrated.ownerOf(fileResourceId(base, true)), manager.rootParticipantId);
		assert.equal(migrated.ownerOf("net:tcp/public"), manager.rootParticipantId);
		const backupPath = join(base, ".state", "ledger.v6.backup.json");
		assert.deepEqual(JSON.parse(readFileSync(backupPath, "utf8")), legacy);
		const before = readFileSync(backupPath, "utf8");
		await SessionAuthorityManager.open(options(base));
		assert.equal(readFileSync(backupPath, "utf8"), before);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

const sandboxRuntime = await sandboxRequirements(["script", "socat"]);
test("Net publication routes a Term service without binding a host port and unpublish keeps service alive", { skip: sandboxRuntime.skip }, async () => {
	const base = temp(); let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open(options(base));
		coordinator = PiCoordinator.createStandalone(manager);
		const term = await coordinator.spawnParticipant(manager.rootParticipantId, { kind: "term", inheritRead: false, cwd: base });
		await coordinator.termExec(manager.rootParticipantId, term, "socat TCP-LISTEN:40001,reuseaddr,fork EXEC:/bin/cat &");
		await coordinator.waitParticipant(manager.rootParticipantId, term, "ready");
		const endpoint = "net:tcp/dns/service.example.invalid:40001";
		await coordinator.publishNet(manager.rootParticipantId, term, endpoint, 40001);
		const publication = manager.publications.get(endpoint)!;
		const deadline = Date.now() + 3000;
		while (!existsSync(publication.socketPath)) { if (Date.now() > deadline) throw new Error("publication never became ready"); await new Promise((resolve) => setTimeout(resolve, 10)); }
		assert.equal((await manager.networkGuard(manager.rootParticipantId).resolveTarget("service.example.invalid", 40001))?.socketPath, publication.socketPath);
		await new Promise<void>((resolve, reject) => { const socket = createConnection(publication.socketPath); socket.once("error", reject); socket.once("connect", () => socket.write("hello")); socket.once("data", (bytes) => { try { assert.equal(bytes.toString(), "hello"); socket.destroy(); resolve(); } catch (error) { reject(error); } }); });
		const child = await agent(manager);
		await assert.rejects(manager.give(manager.rootParticipantId, child, endpoint), /NET_PUBLISHED/);
		await coordinator.unpublishNet(manager.rootParticipantId, endpoint);
		assert.equal(manager.publications.has(endpoint), false);
		assert.equal(manager.hasOpenTermEpoch(term), true, "unpublish does not stop the service");
		await coordinator.stop(manager.rootParticipantId, term);
	} finally { await coordinator?.dispose(); rmSync(base, { recursive: true, force: true }); }
});
