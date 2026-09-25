import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { checkProgram, parse, resolveLogicalPath, type ValueType } from "../src/compiler/index.js";

const childRole: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:A", role: "child", peer: "agent:A" };

test("parser preserves source spans and privileged role syntax", () => {
	const source = 'a : File\n&>A = spawn! "inspect" &a\n';
	const result = parse(source);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.program.statements[1].kind, "assignment");
	const statement = result.program.statements[1];
	if (statement.kind !== "assignment") return;
	assert.equal(statement.binding.form, "child-role");
	assert.equal(statement.expression.name, "spawn");
	assert.equal(statement.expression.privileged, true);
	assert.equal(statement.expression.span.start.line, 2);
});

test("valid linear rebinding, pointer projection, state IDs, and spawn compile to checked IR", () => {
	const source = `
a : File
x = read &a
a = write a "first"
states = log &a
n : StateId<a> = choose states
a = checkout a n
&>A = spawn! "inspect" &a
send &>A "hello"
give! &>A a
`;
	const result = checkProgram(source, { allowCompleteDeclarations: true, versionedResources: ["a"] });
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["read", "write", "log", "choose", "checkout", "spawn", "send", "give"]);
	assert.deepEqual(result.ir.find((operation) => operation.operation === "write")?.consumes, ["a"]);
	assert.equal(result.ir.find((operation) => operation.operation === "read")?.produces.kind, "file-state");
	assert.equal(JSON.stringify(result.ir).includes("first"), false, "String adapter parameters do not enter typed history");
	assert.equal(JSON.stringify(result.ir).includes("hello"), false, "message text does not enter typed history");
});

test("use after give and duplicate complete overwrite are rejected", () => {
	const moved = checkProgram('a : File\ngive! &>A a\na = write a "late"\n', { allowCompleteDeclarations: true, initialBindings: { A: childRole } });
	assert.ok(moved.diagnostics.some((diagnostic) => diagnostic.code === "USE_AFTER_MOVE"));
	const overwrite = checkProgram("a : File\na = read &a\n", { allowCompleteDeclarations: true });
	assert.ok(overwrite.diagnostics.some((diagnostic) => diagnostic.code === "LIVE_LINEAR_REBIND"));
});

test("give can grant a read projection without consuming complete ownership", () => {
	const result = checkProgram('a : File\ngive! &>A &a\nx = read &a\n', { allowCompleteDeclarations: true, initialBindings: { A: childRole } });
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["give", "read"]);
	assert.deepEqual(result.ir[0].consumes, []);
	assert.deepEqual(result.ir[0].preserves, ["agent:A", "a"]);
	assert.equal(result.environment.get("a")?.live, true);
});

test("get accepts only the parent-side direct-child role", () => {
	const child: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:child", role: "child", peer: "agent:child" };
	const parent: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:parent", role: "parent", peer: "agent:parent" };
	const pointer: ValueType = { kind: "pointer", resource: "File", identity: "file:a" };
	const accepted = checkProgram("a = get! &>Child &target\n", { initialBindings: { Child: child, target: pointer } });
	assert.deepEqual(accepted.diagnostics, []);
	assert.deepEqual(accepted.ir.map((operation) => operation.operation), ["get"]);
	const result = accepted.environment.get("a")?.type;
	assert.equal(result?.kind, "complete");
	assert.equal(result?.kind === "complete" ? result.resource : undefined, "File");
	assert.equal(result?.kind === "complete" ? result.identity : undefined, "file:a");

	const rejected = checkProgram("a = get! &<Parent &target\n", { initialBindings: { Parent: parent, target: pointer } });
	assert.equal(rejected.diagnostics.filter((diagnostic) => diagnostic.code === "ROLE_MISMATCH").length, 1);
	assert.deepEqual(rejected.ir, []);
});

test("read pointers cannot write and capabilities cannot flow through String", () => {
	const pointer: ValueType = { kind: "pointer", resource: "File", identity: "file:a" };
	const write = checkProgram('a = write p "bad"\n', { initialBindings: { p: pointer } });
	assert.ok(write.diagnostics.some((diagnostic) => diagnostic.code === "TYPE_MISMATCH"));
	const send = checkProgram("send &>A &p\n", { initialBindings: { A: childRole, p: pointer } });
	assert.ok(send.diagnostics.some((diagnostic) => diagnostic.code === "TYPE_MISMATCH"));
});

test("role pointers cannot be fabricated and state IDs are resource scoped", () => {
	const role = checkProgram("&>A : &>Agent\n");
	assert.ok(role.diagnostics.some((diagnostic) => diagnostic.code === "ROLE_FORGERY"));
	const scoped = checkProgram("a : File\nb : File\nstates = log &a\nn : StateId<a> = choose states\nb = checkout b n\n", { allowCompleteDeclarations: true, versionedResources: ["a", "b"] });
	assert.ok(scoped.diagnostics.some((diagnostic) => diagnostic.code === "STATE_SCOPE_MISMATCH"));
});

test("bang marker is enforced on privileged operations", () => {
	const result = checkProgram('a : File\ngive &>A a\n', { allowCompleteDeclarations: true, initialBindings: { A: childRole } });
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PRIVILEGE_MARKER_REQUIRED"));
});

test("File region refinements split complete write regions into a child and a residual parent expression", () => {
	const source = `
root : File(".")
nested = subpath! root "src"
config = file! root "config.json"
`;
	const base = resolve("repo");
	const result = checkProgram(source, { allowCompleteDeclarations: true, base });
	assert.deepEqual(result.diagnostics, []);
	const root = result.environment.get("root")?.type;
	assert.equal(root?.kind, "complete");
	if (root?.kind === "complete") assert.deepEqual(root.path, { include: base, exclude: [resolve(base, "src"), resolve(base, "config.json")] });
	const nested = result.environment.get("nested")?.type;
	assert.equal(nested?.kind, "complete");
	if (nested?.kind === "complete") assert.deepEqual(nested.path, { include: resolve(base, "src"), exclude: [] });
	const config = result.environment.get("config")?.type;
	assert.equal(config?.kind === "complete" ? config.resource : undefined, "File");
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["subpath", "file"]);
	const outside = checkProgram('root : File(".")\nnested = subpath! root "src"\ntooDeep = subpath! root "src/deeper"\n', { allowCompleteDeclarations: true, base });
	assert.ok(outside.diagnostics.some((diagnostic) => diagnostic.code === "PATH_OUTSIDE_REGION"));
});

test("logical File resolution preserves a UNC share root", () => {
	const base = "\\\\wsl.localhost\\Ubuntu\\home\\artifact\\linden\\repo";
	assert.equal(resolveLogicalPath(base, "src/deeper"), `${base}\\src\\deeper`);
	assert.equal(resolveLogicalPath(base, "../../../../../../escape"), "\\\\wsl.localhost\\Ubuntu\\escape");
});

test("transitive Agent descendant roles permit listen, send, steer, stop, and log", () => {
	const descendant: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:D", role: "descendant", peer: "agent:D" };
	const supplied = checkProgram('&>>D : &>>Agent\ninfo = listen &>>D\nsend &>>D "hello"\nsteer &>>D "now"\nstop &>>D\nstates = log &>>D\n', { initialBindings: { D: descendant } });
	assert.deepEqual(supplied.diagnostics, []);
	assert.deepEqual(supplied.ir.map((operation) => operation.operation), ["listen", "send", "steer", "stop", "log"]);
	const denied = checkProgram('fromD = receive &>>D\n', { initialBindings: { D: descendant } });
	const roleErrors = denied.diagnostics.filter((diagnostic) => diagnostic.code === "ROLE_MISMATCH");
	assert.equal(roleErrors.length, 1);
});

test("participant log accepts Agent self and descendant Agent/Term roles, but not ordinary peers or Human", () => {
	const self: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:caller" };
	const child: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:child", role: "child", peer: "agent:child" };
	const term: ValueType = { kind: "pointer", resource: "Term", identity: "term:deep", role: "descendant", peer: "term:deep" };
	const accepted = checkProgram("selfStates = log &Self\nchildStates = log &>Child\ntermStates = log &>>T\n", {
		participant: "agent:caller",
		initialBindings: { Self: self, Child: child, T: term },
	});
	assert.deepEqual(accepted.diagnostics, []);
	assert.deepEqual(accepted.ir.map((operation) => operation.operation), ["log", "log", "log"]);
	assert.deepEqual(accepted.ir[2]?.produces, { kind: "string" }, "Term log is textual history, not a rewindable Term state list");

	const parent: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:parent" };
	const sibling: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:sibling" };
	const ordinaryTerm: ValueType = { kind: "pointer", resource: "Term", identity: "term:peer" };
	const humanChild: ValueType = { kind: "pointer", resource: "Human", identity: "human:child", role: "child", peer: "human:child" };
	const rejected = checkProgram("parentStates = log &Parent\nsiblingStates = log &Sibling\ntermStates = log &T\nhumanStates = log &>H\n", {
		participant: "agent:caller",
		initialBindings: { Parent: parent, Sibling: sibling, T: ordinaryTerm, H: humanChild },
	});
	assert.equal(rejected.diagnostics.filter((diagnostic) => diagnostic.code === "ROLE_MISMATCH").length, 3);
	assert.equal(rejected.diagnostics.filter((diagnostic) => diagnostic.code === "TYPE_MISMATCH").length, 1);
});

test("receive checks and consumes the current mailbox with an optional sender filter", () => {
	const ordinary: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:A" };
	const result = checkProgram("all = receive\nfromA = receive &A\n", { initialBindings: { A: ordinary } });
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["receive", "receive"]);
	const legacy = checkProgram('bad = receive &A "payload-match"\n', { initialBindings: { A: ordinary } });
	assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "ARITY_MISMATCH"));
});

test("generic participant syntax supports Term spawn and common lifecycle controls", () => {
	const source = `
a : File
&>T = spawn! Term &a
status = listen &>T
wait &>T ready
exec &>T "make test"
interrupt &>T
stop &>T
`;
	const result = checkProgram(source, { allowCompleteDeclarations: true });
	assert.deepEqual(result.diagnostics, []);
	const termBinding = result.environment.get("T")?.type;
	assert.equal(termBinding?.kind, "pointer");
	assert.equal(termBinding?.kind === "pointer" ? termBinding.resource : undefined, "Term");
	assert.deepEqual(result.ir.map((operation) => operation.operation), ["spawn", "listen", "wait", "exec", "interrupt", "stop"]);
});

test("Term exec/input and destructive archive check lifecycle evidence", () => {
	const term: ValueType = { kind: "pointer", resource: "Term", identity: "term:T", role: "child", peer: "term:T" };
	const running = checkProgram('exec &>T "bad"\ninput &>T "ok\\n"\narchive! &>T\n', {
		initialBindings: { T: term },
		participantStatuses: { "term:T": "running" },
	});
	assert.equal(running.diagnostics.filter((diagnostic) => diagnostic.code === "LIFECYCLE_MISMATCH").length, 2);
	const stopped = checkProgram('exec &>T "ok"\narchive! &>T\n', {
		initialBindings: { T: term },
		participantStatuses: { "term:T": "stopped" },
	});
	assert.deepEqual(stopped.diagnostics, []);
	assert.equal(stopped.environment.get("T")?.live, false, "archive consumes the live child role");
});

test("explicit Agent and Human spawn kinds produce correspondingly typed child roles", () => {
	const result = checkProgram('&>A = spawn! Agent "work"\n&>H = spawn! Human "review"\n');
	assert.deepEqual(result.diagnostics, []);
	const agent = result.environment.get("A")?.type;
	const human = result.environment.get("H")?.type;
	assert.equal(agent?.kind === "pointer" ? agent.resource : undefined, "Agent");
	assert.equal(human?.kind === "pointer" ? human.resource : undefined, "Human");
});

test("Term programs cannot use Human/Agent message-loop operations", () => {
	const agent: ValueType = { kind: "pointer", resource: "Agent", identity: "agent:A" };
	const result = checkProgram('send &A "x"\nreceive &A\nreason\n', { participantKind: "Term", initialBindings: { A: agent } });
	assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "TYPE_MISMATCH").length, 3);
});
