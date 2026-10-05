import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager as LegacyAuthorityManager } from "../src/authority/manager.js";
import { SessionAuthorityManager as LegacyAuthorityIndexManager } from "../src/authority/index.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { resolvePublicPath } from "../src/runtime/paths.js";
import {
	AuthorityStore,
	decodeLedger,
	decodeLedgerV6,
	encodeLedger,
	encodeLedgerV6,
	migrateLedgerV5ToV6,
	type PersistedLedgerV5,
} from "../src/runtime/store.js";

test("deprecated authority import paths retain the canonical runtime manager", () => {
	assert.equal(LegacyAuthorityManager, SessionAuthorityManager);
	assert.equal(LegacyAuthorityIndexManager, SessionAuthorityManager);
});

function legacyWebLedger(base: string): PersistedLedgerV5 {
	const root = "human:compat";
	const child = "agent:legacy";
	return {
		schemaVersion: 5,
		Delta: [
			{ variable: root, type: "Agent", owner: root, state: { participant: { name: "compat", kind: "human", status: "idle", createdAt: 1 }, history: [], checkpoints: [] } },
			{ variable: child, type: "Agent", owner: child, state: { participant: { name: "legacy", kind: "agent", status: "idle", createdAt: 1 }, history: [], checkpoints: [] } },
			{ variable: "web:*.example.com/", type: "Web", owner: root, state: null },
		],
		Gamma: [
			{ variable: `&>${child}`, type: "&>Agent", owners: [root] },
			{ variable: "&web:*.example.com/", type: "&Web", owners: [child] },
		],
		runtimeMetadata: {
			sessionId: "session:compat-web",
			base,
			createdAt: 1,
			lastOpenedAt: 1,
			sequence: 0,
			rootParticipantId: root,
			effects: [],
			messageReceipts: [],
		},
	};
}

test("canonical codecs keep v6 aliases and explicit v5 Web migration unchanged", () => {
	const base = mkdtempSync(join(tmpdir(), "linden-codec-compat-"));
	try {
		assert.equal(encodeLedgerV6, encodeLedger);
		assert.equal(decodeLedgerV6, decodeLedger);
		const original = legacyWebLedger(base);
		const unchanged = structuredClone(original);
		const migrated = migrateLedgerV5ToV6(original);
		assert.deepEqual(original, unchanged, "migration must remain pure");
		assert.equal(migrated.schemaVersion, 6);
		const state = decodeLedger(migrated, base);
		assert.equal(state.participants["human:compat"].status, "ready");
		assert.equal(state.participants["agent:legacy"].parentId, "human:compat");
		assert.deepEqual(state.contexts["agent:legacy"].gamma.resourcePointers, ["web:*.example.com/"]);
		const encoded = encodeLedgerV6(state);
		assert.equal(encoded.schemaVersion, 6);
		assert.deepEqual(JSON.parse(JSON.stringify(encoded.Delta)), migrated.Delta);
		assert.deepEqual(encoded.Gamma, migrated.Gamma);
		assert.deepEqual(encodeLedger(decodeLedgerV6(encoded, base)), encoded);

		const nonCanonical = structuredClone(migrated);
		const web = nonCanonical.Delta.find((entry) => entry.type === "Web")!;
		web.variable = "web:*.EXAMPLE.COM/";
		assert.throws(() => decodeLedger(nonCanonical, base), /invalid Web variable.*identity is not canonical/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("v6 upgrade retains Web history but new authority uses only Net", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-web-upgrade-"));
	try {
		const store = new AuthorityStore(join(base, ".state"));
		store.save(decodeLedger(migrateLedgerV5ToV6(legacyWebLedger(base)), base));
		const manager = await SessionAuthorityManager.open({ base, stateDir: store.stateDir, lindenSessionId: "session:compat-web", rootParticipantId: "human:compat" });
		const state = manager.snapshot();
		assert.equal(state.schemaVersion, 8);
		assert.equal(state.resources["web:*.example.com/"].kind, "web");
		assert.equal(manager.ownerOf("web:*.example.com/"), "human:compat");
		assert.ok(state.contexts["agent:legacy"].gamma.resourcePointers.includes("web:*.example.com/"));
		assert.deepEqual(manager.effectiveAuthority("human:compat").webDomains, []);
		assert.deepEqual(manager.effectiveAuthority("agent:legacy").webDomains, []);
		assert.deepEqual(manager.effectiveAuthority("human:compat").netEndpoints, ["net:tcp/public"]);
		assert.deepEqual(manager.effectiveAuthority("agent:legacy").netEndpoints, []);
		assert.throws(() => manager.materializeWeb("human:compat", "web:api.example.com/"), /historical/);
		const backup = JSON.parse(readFileSync(join(store.stateDir, "ledger.v6.backup.json"), "utf8"));
		assert.equal(backup.schemaVersion, 6);
		assert.ok(backup.Delta.some((entry: { type: string }) => entry.type === "Web"));
		const encoded = encodeLedger(state);
		assert.equal(encoded.schemaVersion, 8);
		assert.deepEqual(encodeLedgerV6(decodeLedgerV6(encoded, base, manager.privateRoots)), encoded);
		assert.equal(store.load(base, manager.privateRoots)?.resources["web:*.example.com/"].kind, "web");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("both public path API forms retain canonicalization, validation, and private boundaries", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-path-compat-"));
	const base = join(container, "base");
	const outside = join(container, "outside");
	const privateRoot = join(base, ".state");
	mkdirSync(privateRoot, { recursive: true });
	mkdirSync(outside);
	try {
		symlinkSync(outside, join(base, "public-link"));
		symlinkSync(privateRoot, join(base, "private-link"));
		const target = join(outside, "new.txt");
		assert.equal(resolvePublicPath("public-link/new.txt", base, [privateRoot]), target);
		assert.equal(resolvePublicPath("public-link/new.txt", base, base, [privateRoot]), target);
		for (const path of [".state/ledger.json", "private-link/ledger.json"]) {
			assert.throws(() => resolvePublicPath(path, base, [privateRoot]), /not an addressable resource/);
			assert.throws(() => resolvePublicPath(path, base, base, [privateRoot]), /not an addressable resource/);
		}
		assert.throws(() => resolvePublicPath("\0", base, base, []), /NUL byte/);
		assert.throws(() => resolvePublicPath("\0", base, [] as unknown as string, []), TypeError, "base argument validation still precedes candidate resolution");
	} finally { rmSync(container, { recursive: true, force: true }); }
});

test("legacy evaluator tmp selection retains public directory checks", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-evaluator-compat-"));
	const options = { base, stateDir: join(base, ".state"), lindenSessionId: "session:compat-tmp", rootParticipantId: "human:compat" };
	try {
		const shared = join(base, "shared");
		mkdirSync(shared);
		writeFileSync(join(base, "not-a-directory"), "file");
		const manager = await SessionAuthorityManager.open({ ...options, sandboxTmpPath: shared });
		assert.equal(manager.sandboxTmpPath, shared);
		await assert.rejects(SessionAuthorityManager.open({ ...options, sandboxTmpPath: base }), /existing public directory strictly inside/);
		await assert.rejects(SessionAuthorityManager.open({ ...options, sandboxTmpPath: options.stateDir }), /not an addressable resource/);
		await assert.rejects(SessionAuthorityManager.open({ ...options, sandboxTmpPath: join(base, "missing") }), /existing public directory/);
		await assert.rejects(SessionAuthorityManager.open({ ...options, sandboxTmpPath: join(base, "not-a-directory") }), /existing public directory/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});
