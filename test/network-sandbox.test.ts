import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SessionAuthorityManager } from "../src/authority/manager.js";

const hasBwrap = spawnSync("which", ["bwrap"], { stdio: "ignore" }).status === 0;

test("Bash has no network path without Web authority", { skip: !hasBwrap }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-no-web-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "no-web", stateDir: join(workspace, ".linden-test") });
		const result = await manager.bash(manager.sessionParticipantId, "! timeout 2 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'");
		assert.equal(result.exitCode, 0, result.output);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
