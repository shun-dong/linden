import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectExecutable, probeBubblewrap, probeCommand } from "../src/runtime/capabilities.js";

test("command lookup follows PATH links without depending on which", () => {
	const base = mkdtempSync(join(tmpdir(), "linden-tool-lookup-"));
	try {
		const program = join(base, "program");
		writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		symlinkSync(program, join(base, "alias"));
		assert.equal(inspectExecutable("alias", base).path, program);
		assert.equal(inspectExecutable("which", base).code, "TOOL_NOT_FOUND");
		symlinkSync(join(base, "missing"), join(base, "broken"));
		assert.equal(inspectExecutable("broken", base).code, "TOOL_LINK_BROKEN");
		chmodSync(program, 0o644);
		assert.equal(inspectExecutable("alias", base).code, "TOOL_NOT_EXECUTABLE");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("an existing executable with a missing interpreter reports execution failure", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-tool-loader-"));
	try {
		const program = join(base, "program");
		writeFileSync(program, `#!${base}/missing-interpreter\n`, { mode: 0o755 });
		assert.equal(inspectExecutable(program).available, true);
		const result = await probeCommand(program, []);
		assert.equal(result.available, false);
		assert.equal(result.stage, "execute");
		assert.equal(result.code, "TOOL_EXECUTION_FAILED");
		assert.match(result.reason, /exists.*could not start/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("a present bwrap that runs --version can still fail the actual isolation probe", { skip: process.platform !== "linux" }, async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-isolation-probe-"));
	try {
		writeFileSync(join(base, "bwrap"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo bubblewrap; exit 0; fi\nfor arg do if [ "$arg" = "--unshare-net" ]; then echo "namespace permission denied" >&2; exit 1; fi; done\nexit 0\n', { mode: 0o755 });
		const result = await probeBubblewrap(base);
		assert.equal(result.available, false);
		assert.equal(result.scope, "sandbox");
		assert.equal(result.stage, "isolation");
		assert.equal(result.code, "SANDBOX_UNAVAILABLE");
		assert.match(result.reason, /installed and executable.*namespace permission denied/);
		assert.equal((await probeBubblewrap(join(base, "missing"))).code, "TOOL_NOT_FOUND");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("a hung tool is bounded by the capability check timeout", async () => {
	const result = await probeCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 100);
	assert.equal(result.available, false);
	assert.equal(result.code, "TOOL_TIMEOUT");
});
