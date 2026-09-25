import assert from "node:assert/strict";
import test from "node:test";
import lindenExtension from "../src/pi/extension.js";

test("Pi tool-call guard blocks gateways not mediated by Linden", () => {
	const handlers = new Map<string, Function[]>();
	const fake: any = {
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
	};
	lindenExtension(fake);
	const guard = handlers.get("tool_call")?.[0];
	assert.ok(guard);
	assert.equal(guard({ toolName: "read", input: {}, toolCallId: "safe" }), undefined);
	assert.deepEqual(guard({ toolName: "unrestricted_shell", input: {}, toolCallId: "unsafe" }), {
		block: true,
		reason: "Tool unrestricted_shell is not mediated by Linden authority",
	});
});
