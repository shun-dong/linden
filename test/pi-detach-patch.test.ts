import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

test("the Pi 0.84.2 detachable UI patch is version-guarded and idempotent", () => {
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
	assert.equal(packageJson.version, "0.84.2");
	const rerun = spawnSync(process.execPath, ["scripts/patch-pi-detach.mjs"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	assert.equal(rerun.status, 0, rerun.stderr);
	assert.match(rerun.stdout, /Applied Linden detachable Pi patch for 0\.84\.2/);

	const source = readFileSync(join(packageRoot, "dist", "modes", "interactive", "interactive-mode.js"), "utf8");
	assert.equal(source.match(/LINDEN_DETACH_PATCH_0_84_2/g)?.length, 1);
	assert.match(source, /text === "\/exit"/);
	assert.match(source, /Promise\.race\(\[\s*completion,/);
	const detachStart = source.indexOf("    detach() {");
	const detachEnd = source.indexOf("    emergencyTerminalExit()", detachStart);
	assert.ok(detachStart >= 0 && detachEnd > detachStart);
	const detachMethod = source.slice(detachStart, detachEnd);
	assert.match(detachMethod, /this\.stop\(\)/);
	assert.doesNotMatch(detachMethod, /runtimeHost\.dispose|session\.abort/);

	const declarations = readFileSync(join(packageRoot, "dist", "modes", "interactive", "interactive-mode.d.ts"), "utf8");
	assert.match(declarations, /detachable\?: boolean/);
	const commands = readFileSync(join(packageRoot, "dist", "core", "slash-commands.js"), "utf8");
	assert.equal(commands.match(/name: "exit"/g)?.length, 1);
});
