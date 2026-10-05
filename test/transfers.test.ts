import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import type { FileResource } from "../src/runtime/model.js";
import { PiCoordinator } from "../src/pi/runtime.js";
import { buildTools } from "../src/pi/tools.js";
import { formatTransferResult, transferInputs } from "../src/pi/transfers.js";

async function fixture() {
	const base = mkdtempSync("/tmp/linden-transfers-");
	const options = { base, stateDir: join(base, ".state"), rootParticipantId: "human:transfer-test", lindenSessionId: "session:transfer-test" };
	const manager = await SessionAuthorityManager.open(options);
	const human = manager.rootParticipantId;
	const child = "agent:child";
	const sibling = "agent:sibling";
	for (const id of [child, sibling]) await manager.spawnWith(human, id, id, [], async () => ({}), { inheritWorkspaceRead: false });
	const coordinator = PiCoordinator.createStandalone(manager);
	const payloads = new Map<string, any>();
	for (const id of [child, sibling]) coordinator.runtimes.set(id, {
		participantId: id, isRunning: () => false, abort: async () => {}, summary: () => id,
		appendRuntimeNotice: async () => "notice",
		appendEntry: async (_type: string, data: any) => { payloads.set(data.messageId, data); return data.messageId; },
		readPayload: (id: string) => payloads.get(id), deliverBatch: async () => {},
	} as any);
	return { base, options, manager, human, child, sibling, coordinator, close: async () => { await coordinator.dispose(); rmSync(base, { recursive: true, force: true }); } };
}

test("get imports marked divergence at the current branch tip and persists bytes, receipt and notice", async () => {
	const f = await fixture();
	try {
		const first = await f.manager.writeFile(f.human, "drift.txt", "original");
		await f.manager.writeFile(f.human, "drift.txt", "other branch");
		await f.manager.checkout(f.human, first.resourceId, first.stateId);
		await f.manager.give(f.human, f.child, first.resourceId);
		writeFileSync(join(f.base, "drift.txt"), "external");
		await assert.rejects(f.manager.readFile(f.child, "drift.txt"), /RESOURCE_DIVERGED/);
		const before = f.manager.resource(first.resourceId) as FileResource;
		const result = await f.coordinator.getPermission(f.human, f.child, first.resourceId);
		const after = f.manager.resource(first.resourceId) as FileResource;
		assert.equal(f.manager.ownerOf(first.resourceId), f.human);
		assert.equal(after.divergence, undefined);
		assert.deepEqual(after.versions.slice(0, -1), before.versions);
		assert.equal(after.versions.at(-1)?.parentId, first.stateId);
		assert.equal(after.versions.at(-1)?.operation, "save");
		assert.equal((await f.manager.readFile(f.human, "drift.txt")).content, "external");
		assert.equal(readFileSync(join(f.base, "drift.txt"), "utf8"), "external");
		assert.equal(result.fileUpdates?.[0].stateId, after.currentVersionId);
		assert.match(formatTransferResult(result), /External disk changes saved/);
		assert.ok(f.manager.snapshot().runtimeEvents?.some((event) => event.participantId === f.child && event.text.includes(after.currentVersionId)));
		const reopened = await SessionAuthorityManager.open(f.options);
		assert.equal((reopened.resource(first.resourceId) as FileResource).currentVersionId, after.currentVersionId);
		assert.equal((await reopened.readFile(f.human, "drift.txt")).content, "external");
		await reopened.checkout(f.human, first.resourceId, first.stateId);
		assert.equal((await reopened.readFile(f.human, "drift.txt")).content, "original");
	} finally { await f.close(); }
});

test("region give detects unmarked changes, preserves binary bytes and modes, and leaves delegated Files alone", async () => {
	const f = await fixture();
	try {
		const binary = await f.manager.writeFile(f.human, "binary.dat", "initial");
		const other = await f.manager.writeFile(f.human, "other.txt", "original");
		await f.manager.give(f.human, f.sibling, other.resourceId);
		const otherVersionCount = (f.manager.resource(other.resourceId) as FileResource).versions.length;
		const bytes = Buffer.from([0, 255, 128, 10]);
		writeFileSync(join(f.base, "binary.dat"), bytes);
		chmodSync(join(f.base, "binary.dat"), 0o600);
		writeFileSync(join(f.base, "other.txt"), "sibling external");
		const result = await f.coordinator.give(f.human, f.child, f.manager.baseResourceId());
		assert.deepEqual(result.fileUpdates?.map((update) => update.resourceId), [binary.resourceId]);
		assert.deepEqual((await f.manager.readFileBytes(f.child, "binary.dat")).content, bytes);
		const version = (f.manager.resource(binary.resourceId) as FileResource).versions.at(-1)!;
		assert.equal(version.snapshot.mode, 0o600);
		assert.equal(f.manager.ownerOf(other.resourceId), f.sibling);
		assert.equal((f.manager.resource(other.resourceId) as FileResource).versions.length, otherVersionCount);
	} finally { await f.close(); }
});

test("unchanged transfer adds no File version, verified divergence clears without a duplicate version", async () => {
	const f = await fixture();
	try {
		const file = await f.manager.writeFile(f.human, "restored.txt", "original");
		const count = (f.manager.resource(file.resourceId) as FileResource).versions.length;
		const unchanged = await f.manager.giveWithReceipt(f.human, f.child, file.resourceId);
		assert.deepEqual(unchanged.fileUpdates, []);
		writeFileSync(join(f.base, "restored.txt"), "external");
		await assert.rejects(f.manager.readFile(f.child, "restored.txt"), /RESOURCE_DIVERGED/);
		writeFileSync(join(f.base, "restored.txt"), "original");
		const verified = await f.manager.getWithReceipt(f.human, f.child, file.resourceId);
		assert.deepEqual(verified.fileUpdates, [{ resourceId: file.resourceId, stateId: file.stateId, change: "verified" }]);
		assert.equal((f.manager.resource(file.resourceId) as FileResource).versions.length, count);
		assert.equal((await f.manager.readFile(f.human, "restored.txt")).content, "original");
	} finally { await f.close(); }
});

test("external deletion is kept as an Absent File version during get", async () => {
	const f = await fixture();
	try {
		const file = await f.manager.writeFile(f.human, "deleted.txt", "original");
		await f.manager.give(f.human, f.child, file.resourceId);
		rmSync(join(f.base, "deleted.txt"));
		await f.manager.get(f.human, f.child, file.resourceId);
		assert.equal((await f.manager.statFile(f.human, "deleted.txt")).state, "Absent");
		assert.equal((f.manager.resource(file.resourceId) as FileResource).versions.at(-1)?.snapshot.exists, false);
	} finally { await f.close(); }
});

test("failed persistence rolls back the imported version, divergence, ownership and notices together", async () => {
	const f = await fixture();
	try {
		const file = await f.manager.writeFile(f.human, "drift.txt", "original");
		await f.manager.give(f.human, f.child, file.resourceId);
		writeFileSync(join(f.base, "drift.txt"), "external");
		await assert.rejects(f.manager.readFile(f.child, "drift.txt"), /RESOURCE_DIVERGED/);
		const before = f.manager.snapshot();
		const save = f.manager.store.save.bind(f.manager.store);
		f.manager.store.save = () => { throw new Error("injected commit failure"); };
		try { await assert.rejects(f.manager.get(f.human, f.child, file.resourceId), /injected commit failure/); }
		finally { f.manager.store.save = save; }
		assert.deepEqual(f.manager.snapshot(), before);
		assert.equal(readFileSync(join(f.base, "drift.txt"), "utf8"), "external");
	} finally { await f.close(); }
});

test("unsupported physical replacement refuses the single transfer without moving ownership", async () => {
	const f = await fixture();
	try {
		const file = await f.manager.writeFile(f.human, "replaced.txt", "original");
		rmSync(join(f.base, "replaced.txt"));
		symlinkSync(join(f.base, ".state", "ledger.json"), join(f.base, "replaced.txt"));
		const before = f.manager.snapshot();
		await assert.rejects(f.manager.give(f.human, f.child, file.resourceId), /Symlink states/);
		assert.deepEqual(f.manager.snapshot(), before);
	} finally { await f.close(); }
});

test("batch give tool preserves the first commit, stops at failure and reports the untouched tail", async () => {
	const f = await fixture();
	try {
		const files = [];
		for (const name of ["first", "second", "third"]) files.push(await f.manager.writeFile(f.human, `${name}.txt`, name));
		await f.manager.give(f.human, f.sibling, files[1].resourceId);
		const tool = buildTools(f.coordinator, f.human, f.base).find((tool) => tool.name === "give")!;
		const response = await (tool.execute as any)("batch", { participant: f.child, resources: files.map((file) => file.resourceId) });
		assert.equal(response.details.status, "partial");
		assert.equal(response.details.completed.length, 1);
		assert.equal(response.details.failed.resource, files[1].resourceId);
		assert.deepEqual(response.details.unattempted, [files[2].resourceId]);
		assert.equal(f.manager.ownerOf(files[0].resourceId), f.child);
		assert.equal(f.manager.ownerOf(files[1].resourceId), f.sibling);
		assert.equal(f.manager.ownerOf(files[2].resourceId), f.human);
		assert.match(response.content[0].text, /Not attempted:/);
	} finally { await f.close(); }
});

test("batch get tool saves drift on the first item and stops before an unavailable child resource", async () => {
	const f = await fixture();
	try {
		const files = [];
		for (const name of ["first", "second", "third"]) files.push(await f.manager.writeFile(f.human, `${name}.txt`, name));
		for (const index of [0, 2]) await f.manager.give(f.human, f.child, files[index].resourceId);
		writeFileSync(join(f.base, "first.txt"), "external");
		const tool = buildTools(f.coordinator, f.human, f.base).find((tool) => tool.name === "get")!;
		const response = await (tool.execute as any)("batch", { participant: f.child, resources: files.map((file) => file.resourceId) });
		assert.equal(response.details.status, "partial");
		assert.equal(response.details.completed[0].result.fileUpdates[0].change, "saved");
		assert.equal(f.manager.ownerOf(files[0].resourceId), f.human);
		assert.equal((await f.manager.readFile(f.human, "first.txt")).content, "external");
		assert.equal(f.manager.ownerOf(files[2].resourceId), f.child);
	} finally { await f.close(); }
});

test("all-of-mine batch requests stop on unavailable and retain the previously granted item", async () => {
	const f = await fixture();
	try {
		const files = [];
		for (const name of ["first", "second", "third"]) files.push(await f.manager.writeFile(f.human, `${name}.txt`, name));
		await f.manager.give(f.human, f.sibling, files[1].resourceId);
		await f.manager.setPermissionMode(f.human, "all-of-mine");
		const result = await f.coordinator.transferResources(f.child, f.human, files.map((file) => file.resourceId), "get");
		assert.equal(result.status, "partial");
		assert.equal(result.failed?.index, 1);
		assert.equal(f.manager.ownerOf(files[0].resourceId), f.child);
		assert.equal(f.manager.ownerOf(files[2].resourceId), f.human);
	} finally { await f.close(); }
});

test("batch give accepts mixed ownership and use grants without changing projection semantics", async () => {
	const f = await fixture();
	try {
		const owned = await f.manager.writeFile(f.human, "owned.txt", "owned");
		const shared = await f.manager.writeFile(f.human, "shared.txt", "shared");
		const result = await f.coordinator.transferResources(f.human, f.child, [owned.resourceId, `&${shared.resourceId}`, "&net:tcp/dns/example.com:443"], "give");
		assert.equal(result.status, "completed");
		assert.equal(result.completed.length, 3);
		assert.equal(f.manager.ownerOf(owned.resourceId), f.child);
		assert.equal(f.manager.ownerOf(shared.resourceId), f.human);
		assert.equal((await f.manager.readFile(f.child, "shared.txt")).content, "shared");
		await assert.rejects(f.manager.writeFile(f.child, "shared.txt", "denied"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(f.manager.give(f.child, f.human, "net:tcp/dns/example.com:443", "read"), /UNAUTHORIZED/);
	} finally { await f.close(); }
});

test("manual batch requests remain pending and grant no authority", async () => {
	const f = await fixture();
	try {
		const files = [];
		for (const name of ["first", "second"]) files.push(await f.manager.writeFile(f.human, `${name}.txt`, name));
		const result = await f.coordinator.transferResources(f.child, f.human, files.map((file) => file.resourceId), "get");
		assert.equal(result.status, "completed");
		assert.deepEqual(result.completed.map((item) => "status" in item.result && item.result.status), ["pending", "pending"]);
		assert.equal(f.manager.pendingMessages(f.human).length, 2);
		for (const file of files) assert.equal(f.manager.ownerOf(file.resourceId), f.human);
	} finally { await f.close(); }
});

test("an invalid middle reference fails in order after the earlier transfer", async () => {
	const f = await fixture();
	try {
		const first = await f.manager.writeFile(f.human, "first.txt", "first");
		const result = await f.coordinator.transferResources(f.human, f.child, [first.resourceId, "", "file:./third.txt"], "give");
		assert.equal(result.status, "partial");
		assert.equal(result.failed?.index, 1);
		assert.equal(f.manager.ownerOf(first.resourceId), f.child);
		assert.deepEqual(result.unattempted, ["file:./third.txt"]);
	} finally { await f.close(); }
});

test("a File changing during capture refuses the transfer and preserves the existing ledger", async () => {
	const f = await fixture();
	try {
		const file = await f.manager.writeFile(f.human, "unstable.txt", "original");
		const before = f.manager.snapshot();
		const capture = f.manager.store.capture.bind(f.manager.store);
		f.manager.store.capture = (path, archive = true, rejectHardlinks = false) => {
			const snapshot = capture(path, archive, rejectHardlinks);
			if (path === file.path && archive) writeFileSync(path, "concurrent external write");
			return snapshot;
		};
		try { await assert.rejects(f.manager.give(f.human, f.child, file.resourceId), /TRANSFER_UNSTABLE_FILE/); }
		finally { f.manager.store.capture = capture; }
		assert.deepEqual(f.manager.snapshot(), before);
		assert.equal(readFileSync(file.path, "utf8"), "concurrent external write");
	} finally { await f.close(); }
});

test("get refuses an open Term epoch without importing external changes or moving the File", async () => {
	const f = await fixture();
	const term = "term:active";
	const epochId = "epoch:active";
	const startedAt = Date.now();
	let open = false;
	try {
		const file = await f.manager.writeFile(f.human, "active.txt", "original");
		await f.manager.spawnWith(f.human, term, term, [], async () => ({}), { participantKind: "term", inheritWorkspaceRead: false });
		await f.manager.give(f.human, term, file.resourceId);
		await f.manager.beginTermEpoch({ termId: term, epochId, startedAt });
		open = true;
		writeFileSync(file.path, "epoch write");
		const before = f.manager.snapshot();
		await assert.rejects(f.coordinator.getPermission(f.human, term, file.resourceId), /TERM_EPOCH_ACTIVE/);
		assert.deepEqual(f.manager.snapshot(), before);
		assert.equal(f.manager.hasOpenTermEpoch(term), true);
	} finally {
		if (open) await f.manager.finishTermEpoch({ termId: term, epochId, startedAt, endedAt: Date.now(), forced: false });
		await f.close();
	}
});

test("a published Net stops a batch after the first File and leaves later permissions untouched", async () => {
	const f = await fixture();
	try {
		const first = await f.manager.writeFile(f.human, "first.txt", "first");
		const last = await f.manager.writeFile(f.human, "last.txt", "last");
		const net = await f.manager.materializeNet(f.human, "net:tcp/dns/example.com:443");
		f.manager.publications.set(net, { ownerId: f.human, termId: "term:publication", internalPort: 8000, socketPath: join(f.base, "publication.sock"), state: "ready" });
		const result = await f.coordinator.transferResources(f.human, f.child, [first.resourceId, net, last.resourceId], "give");
		assert.equal(result.status, "partial");
		assert.match(result.failed?.reason ?? "", /NET_PUBLISHED/);
		assert.equal(f.manager.ownerOf(first.resourceId), f.child);
		assert.equal(f.manager.ownerOf(net), f.human);
		assert.equal(f.manager.ownerOf(last.resourceId), f.human);
		assert.equal(f.manager.publications.has(net), true);
	} finally { await f.close(); }
});

test("transfer resource parameters are exclusive and the list must not be empty", () => {
	assert.deepEqual(transferInputs({ resource: "file:./one.txt" }), ["file:./one.txt"]);
	assert.throws(() => transferInputs({}), /exactly one/);
	assert.throws(() => transferInputs({ resource: "file:one", resources: ["file:two"] }), /exactly one/);
	assert.throws(() => transferInputs({ resources: [] }), /at least one/);
});
