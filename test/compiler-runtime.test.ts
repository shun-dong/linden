import assert from "node:assert/strict";
import test from "node:test";
import { checkProgram, type ValueType } from "../src/compiler/index.js";

test("source declarations can describe runtime-supplied bindings without forging roles", () => {
	const parentRole: ValueType = {
		kind: "pointer",
		resource: "Agent",
		identity: "human:root",
		role: "parent",
		peer: "human:root",
	};
	const file: ValueType = { kind: "complete", resource: "File", identity: "file:runtime" };
	const result = checkProgram("&<P : &<Agent\na : File\nsend &<P \"done\"\na = write a \"next\"\n", {
		initialBindings: { P: parentRole, a: file },
		versionedResources: ["file:runtime"],
	});
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["send", "write"]);
	assert.equal(result.environment.get("a")?.type.kind, "complete");
});
