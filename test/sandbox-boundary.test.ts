import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandboxRequirements } from "./runtime-requirements.js";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";

const sandboxRuntime = await sandboxRequirements();

test("sandbox hides host configuration and secrets while retaining the active Node toolchain", { skip: sandboxRuntime.skip }, async () => {
	// WSL may inherit a Windows TEMP under /mnt/c. An authorized workspace there
	// necessarily materializes /mnt as a directory skeleton, making the /mnt
	// visibility assertion self-contradictory. bwrap is Linux-only, so use the
	// native private temporary root for this host-mount boundary probe.
	const workspace = mkdtempSync("/tmp/linden-bash-boundary-");
	const previous = process.env.LINDEN_TEST_SECRET;
	process.env.LINDEN_TEST_SECRET = "must-not-cross";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "bash-boundary", stateDir: join(workspace, ".linden-test") });
		const result = await manager.bash(
			manager.sessionParticipantId,
			'test ! -e /etc/hosts && test ! -e /sys && test ! -e /mnt && ! mkdir -p /home/linden-escape 2>/dev/null && test -z "${LINDEN_TEST_SECRET-}" && mkdir -p "$HOME" && printf scratch > "$HOME/probe" && node -e "process.stdout.write(\'node-ok\')"',
		);
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(result.output, "node-ok");
	} finally {
		if (previous === undefined) delete process.env.LINDEN_TEST_SECRET;
		else process.env.LINDEN_TEST_SECRET = previous;
		rmSync(workspace, { recursive: true, force: true });
	}
});
