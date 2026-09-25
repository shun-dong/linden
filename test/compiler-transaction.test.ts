import assert from "node:assert/strict";
import test from "node:test";
import { checkProgram, type ValueType } from "../src/compiler/index.js";

test("a rejected get assignment does not commit an atomic ownership transition", () => {
	const child: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:C", role: "child", peer: "agent:C" };
	const pointer: ValueType = { kind: "pointer", resource: "File", identity: "file:a" };
	const held: ValueType = { kind: "complete", resource: "File", identity: "file:x" };
	const result = checkProgram("x = get! &>C &a\na = get! &>C &a\n", {
		initialBindings: { C: child, a: pointer, x: held },
	});
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "LIVE_LINEAR_REBIND"));
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["get"]);
});
