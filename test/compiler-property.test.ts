import assert from "node:assert/strict";
import test from "node:test";
import { checkProgram } from "../src/compiler/index.js";

test("property: arbitrary-length write chains preserve exactly one live complete binding", () => {
	for (let revisions = 1; revisions <= 48; revisions++) {
		const writes = Array.from({ length: revisions }, (_, index) => `a = write a "revision-${index}"`).join("\n");
		const result = checkProgram(`a : File\n${writes}\n`, { allowCompleteDeclarations: true });
		assert.deepEqual(result.diagnostics, [], `revisions=${revisions}`);
		assert.equal(result.ir.length, revisions);
		assert.ok(result.ir.every((operation) => operation.operation === "write" && operation.consumes.length === 1 && operation.consumes[0] === "a"));
		assert.equal(result.environment.get("a")?.live, true);
	}
});
