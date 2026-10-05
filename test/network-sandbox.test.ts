import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxRequirements } from "./runtime-requirements.js";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

const sandboxRuntime = await sandboxRequirements();

test("Bash has no network path without Web authority", { skip: sandboxRuntime.skip }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-no-web-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "no-web", stateDir: join(workspace, ".linden-test") });
		const result = await manager.bash(manager.sessionParticipantId, "! timeout 2 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'");
		assert.equal(result.exitCode, 0, result.output);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
