import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyContext } from "../src/compiler/judgment.js";
import {
	AuthorityStore,
	decodeLedgerV6,
	encodeLedgerV6,
	migrateLedgerV5ToV6,
	type PersistedLedgerV5,
} from "../src/runtime/store.js";

function legacyLedger(base: string, archived?: boolean): PersistedLedgerV5 {
	const root = "human:tester";
	return {
		schemaVersion: 5,
		Delta: [{
			variable: root,
			type: "Agent",
			owner: root,
			state: {
				participant: { name: "tester", kind: "human", status: "idle", createdAt: 1, ...(archived === undefined ? {} : { archived }) },
				history: [],
				checkpoints: [],
			},
		}],
		Gamma: [],
		runtimeMetadata: {
			sessionId: "session:11111111-1111-1111-1111-111111111111",
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

test("v5 migration is explicit and maps idle to ready only through the migration API", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-v6-migrate-"));
	try {
		const base = join(container, "base");
		const stateDir = join(container, "state");
		mkdirSync(base);
		mkdirSync(stateDir);
		const store = new AuthorityStore(stateDir);
		writeFileSync(store.ledgerPath, JSON.stringify(legacyLedger(base)));
		assert.throws(() => store.load(base), /LEDGER_V5_REQUIRES_EXPLICIT_MIGRATION/);
		const migrated = store.migrateV5({}, base);
		assert.equal(migrated.schemaVersion, 6);
		assert.equal(migrated.participants["human:tester"].status, "ready");
		assert.equal(migrated.contexts["human:tester"].delta.completeValues[0].type, "Human");
		assert.equal(JSON.parse(readFileSync(store.ledgerPath, "utf8")).schemaVersion, 6);
		assert.deepEqual(decodeLedgerV6(encodeLedgerV6(migrated), base).participants, migrated.participants);
	} finally {
		rmSync(container, { recursive: true, force: true });
	}
});

test("v5 archived participants require an explicit restore decision", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-v6-archive-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const legacy = legacyLedger(base, true);
		assert.throws(() => migrateLedgerV5ToV6(legacy), /MIGRATION_V5_ARCHIVED_PARTICIPANT/);
		const restored = migrateLedgerV5ToV6(legacy, { restoreArchived: true });
		const participant = restored.Delta.find((entry) => entry.variable === "human:tester");
		assert.equal(participant?.type, "Human");
		assert.equal(participant && "participant" in participant.state ? Object.hasOwn(participant.state.participant, "archived") : true, false);
	} finally {
		rmSync(container, { recursive: true, force: true });
	}
});

test("v5 archive effect history is explicitly rejected because it has no v6 tombstones", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-v6-archive-effect-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const legacy = legacyLedger(base);
		legacy.runtimeMetadata.effects.push({
			id: "effect:legacy-archive",
			sequence: 0,
			kind: "archive",
			participantId: "human:tester",
			targetId: "agent:retired-without-tombstone",
			status: "committed",
			createdAt: 1,
		});
		assert.throws(() => migrateLedgerV5ToV6(legacy, { restoreArchived: true }), /MIGRATION_V5_ARCHIVE_HISTORY_UNSUPPORTED/);
	} finally {
		rmSync(container, { recursive: true, force: true });
	}
});

test("v6 persistence permits non-root Human and Term participants", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-v6-kinds-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const root = "human:tester";
		const reviewer = "human:reviewer";
		const term = "term:shell";
		const state = decodeLedgerV6(migrateLedgerV5ToV6(legacyLedger(base)), base);
		state.participants[root].childIds = [reviewer];
		state.participants[reviewer] = { id: reviewer, name: "reviewer", kind: "human", status: "ready", parentId: root, childIds: [term], createdAt: 2 };
		state.participants[term] = { id: term, name: "shell", kind: "term", status: "stopped", parentId: reviewer, childIds: [], createdAt: 3 };
		state.contexts[root].gamma.agentPointers.push(reviewer);
		state.contexts[root].gamma.roles.push({ targetId: reviewer, role: "parent" });
		state.contexts[reviewer] = emptyContext(reviewer, "human");
		state.contexts[reviewer].gamma.agentPointers.push(root, term);
		state.contexts[reviewer].gamma.roles.push({ targetId: root, role: "child" }, { targetId: term, role: "parent" });
		state.contexts[term] = emptyContext(term, "term");
		state.contexts[term].gamma.agentPointers.push(reviewer);
		state.contexts[term].gamma.roles.push({ targetId: reviewer, role: "child" });

		const roundTrip = decodeLedgerV6(encodeLedgerV6(state), base);
		assert.equal(roundTrip.participants[reviewer].kind, "human");
		assert.equal(roundTrip.participants[reviewer].parentId, root);
		assert.equal(roundTrip.participants[term].kind, "term");
		assert.equal(roundTrip.contexts[term].delta.completeValues[0].type, "Term");
	} finally {
		rmSync(container, { recursive: true, force: true });
	}
});

test("v6 validation uses v6 participant diagnostics", () => {
	const container = mkdtempSync(join(tmpdir(), "linden-v6-diagnostics-"));
	try {
		const base = join(container, "base");
		mkdirSync(base);
		const malformed = migrateLedgerV5ToV6(legacyLedger(base));
		malformed.Delta[0] = { ...malformed.Delta[0], state: null } as unknown as typeof malformed.Delta[number];
		assert.throws(() => decodeLedgerV6(malformed, base), /INVALID_LEDGER_V6: malformed participant state human:tester/);

		const cyclic = migrateLedgerV5ToV6(legacyLedger(base));
		for (const id of ["human:a", "human:b"] as const) {
			cyclic.Delta.push({
				variable: id,
				type: "Human",
				owner: id,
				state: { participant: { name: id, kind: "human", status: "ready", createdAt: 2 }, history: [], checkpoints: [] },
			});
		}
		cyclic.Delta.sort((left, right) => left.variable.localeCompare(right.variable) || left.type.localeCompare(right.type));
		cyclic.Gamma.push(
			{ variable: "&>human:a", type: "&>Human", owners: ["human:b"] },
			{ variable: "&>human:b", type: "&>Human", owners: ["human:a"] },
		);
		cyclic.Gamma.sort((left, right) => left.variable.localeCompare(right.variable) || left.type.localeCompare(right.type));
		assert.throws(() => decodeLedgerV6(cyclic, base), /INVALID_LEDGER_V6: cycle in participant tree/);
	} finally {
		rmSync(container, { recursive: true, force: true });
	}
});
