import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SessionAuthorityManager } from "../src/authority/manager.js";

const hasBwrap = spawnSync("which", ["bwrap"], { stdio: "ignore" }).status === 0;

test("the entire .linden tree is private across sessions", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-private-state-"));
	try {
		const stateRoot = join(workspace, ".linden");
		const first = await SessionAuthorityManager.open({ workspace, lindenSessionId: "session:11111111-1111-1111-1111-111111111111", sessionId: "one", stateRoot });
		await SessionAuthorityManager.open({ workspace, lindenSessionId: "session:22222222-2222-2222-2222-222222222222", sessionId: "two", stateRoot });
		const otherLedger = ".linden/sessions/22222222-2222-2222-2222-222222222222/ledger.json";
		await assert.rejects(first.readFile(first.sessionParticipantId, otherLedger), /not an addressable resource/);
		await assert.rejects(first.writeFile(first.sessionParticipantId, otherLedger, "tamper"), /not an addressable resource/);
		if (hasBwrap) {
			const result = await first.bash(first.sessionParticipantId, `test ! -e ${otherLedger}`);
			assert.equal(result.exitCode, 0, result.output);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a custom state directory receives the same private treatment", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-custom-private-"));
	try {
		const stateDir = join(workspace, ".runtime-private");
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "custom", stateDir });
		await assert.rejects(manager.readFile(manager.sessionParticipantId, ".runtime-private/ledger.json"), /not an addressable resource/);
		if (hasBwrap) {
			const result = await manager.bash(manager.sessionParticipantId, "test ! -e .runtime-private/ledger.json");
			assert.equal(result.exitCode, 0, result.output);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
