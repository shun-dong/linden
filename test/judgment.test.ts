import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	assertWellFormedContexts,
	deriveJudgment,
	emptyContext,
	ownerOf,
	type JudgmentState,
} from "../src/compiler/judgment.js";

function state(): JudgmentState {
	const root = "agent:root";
	const child = "agent:child";
	const contexts = { [root]: emptyContext(root), [child]: emptyContext(child) };
	contexts[root].gamma.agentPointers.push(child);
	contexts[root].gamma.roles.push({ role: "parent", targetId: child });
	contexts[child].gamma.agentPointers.push(root);
	contexts[child].gamma.roles.push({ role: "child", targetId: root });
	contexts[root].delta.completeValues.push({ identity: "file:/workspace/a.txt", type: "File", stateId: "state:v1" });
	contexts[root].gamma.resourcePointers.push("file:/workspace/a.txt");
	return {
		base: "/workspace",
		rootParticipantId: root,
		contexts,
		participants: {
			[root]: { id: root, kind: "agent", status: "ready", childIds: [child] },
			[child]: { id: child, kind: "agent", status: "ready", parentId: root, childIds: [] },
		},
		resources: {
			"file:/workspace/a.txt": {
				id: "file:/workspace/a.txt",
				kind: "file",
				path: "/workspace/a.txt",
				versioned: true,
				versions: [{ id: "state:v1" }],
				currentVersionId: "state:v1",
			},
		},
		messages: {},
		agentStates: {},
		currentAgentStateIds: {},
	};
}

test("algorithmic give/get derive Γ′/Δ′ instead of ownership summaries", () => {
	const before = state();
	const pointer = deriveJudgment(before, { kind: "give", participantId: "agent:root", peerId: "agent:child", resourceId: "file:/workspace/a.txt", mode: "read" });
	assert.equal(pointer.accepted, true);
	if (!pointer.accepted) return;
	assert.ok(pointer.derivation.contexts["agent:child"].gamma.resourcePointers.includes("file:/workspace/a.txt"));
	assert.equal(ownerOf({ ...before, contexts: pointer.derivation.contexts }, "file:/workspace/a.txt"), "agent:root");

	const moved = deriveJudgment(before, { kind: "give", participantId: "agent:root", peerId: "agent:child", resourceId: "file:/workspace/a.txt", mode: "move" });
	assert.equal(moved.accepted, true);
	if (!moved.accepted) return;
	const childState = { ...before, contexts: moved.derivation.contexts };
	assert.equal(ownerOf(childState, "file:/workspace/a.txt"), "agent:child");
	assert.equal(childState.contexts["agent:child"].delta.completeValues.find((value) => value.identity === "file:/workspace/a.txt")?.stateId, "state:v1");

	const returned = deriveJudgment(childState, { kind: "get", participantId: "agent:root", peerId: "agent:child", resourceId: "file:/workspace/a.txt" });
	assert.equal(returned.accepted, true);
	if (!returned.accepted) return;
	assert.equal(ownerOf({ ...before, contexts: returned.derivation.contexts }, "file:/workspace/a.txt"), "agent:root");
});

test("give &A may forward an ordinary pointer without possessing the complete value", () => {
	const logical = state();
	const middle = "agent:middle";
	const leaf = "agent:leaf";
	logical.participants["agent:root"].childIds = [middle];
	logical.participants[middle] = { id: middle, kind: "agent", status: "ready", parentId: "agent:root", childIds: [leaf] };
	logical.participants[leaf] = { id: leaf, kind: "agent", status: "ready", parentId: middle, childIds: [] };
	logical.contexts[middle] = emptyContext(middle);
	logical.contexts[leaf] = emptyContext(leaf);
	logical.contexts[middle].gamma.resourcePointers.push("file:/workspace/a.txt");
	delete logical.contexts["agent:child"];
	delete logical.participants["agent:child"];

	const checked = deriveJudgment(logical, { kind: "give", participantId: middle, peerId: leaf, resourceId: "file:/workspace/a.txt", mode: "read" });
	assert.equal(checked.accepted, true);
	if (!checked.accepted) return;
	assert.ok(checked.derivation.contexts[leaf].gamma.resourcePointers.includes("file:/workspace/a.txt"));
	assert.equal(ownerOf({ ...logical, contexts: checked.derivation.contexts }, "file:/workspace/a.txt"), "agent:root");
});

test("rejected judgments leave the input contexts unchanged and effects remain one-way classified", () => {
	const logical = state();
	const before = structuredClone(logical.contexts);
	const rejected = deriveJudgment(logical, { kind: "get", participantId: "agent:child", peerId: "agent:root", resourceId: "file:/workspace/a.txt" });
	assert.equal(rejected.accepted, false);
	assert.deepEqual(logical.contexts, before);

	const share = deriveJudgment(logical, { kind: "read", participantId: "agent:root", path: "/workspace/a.txt" });
	const io = deriveJudgment(logical, { kind: "bash", participantId: "agent:root" });
	assert.equal(share.accepted && share.derivation.effect, "Share");
	assert.equal(io.accepted && io.derivation.effect, "IO");
	assertWellFormedContexts(logical);
});

test("receive consumes one live Message from the recipient Delta", () => {
	const logical = state();
	const messageId = "msg:test";
	logical.contexts["agent:child"].gamma.agentPointers.push("agent:root");
	logical.contexts["agent:child"].delta.completeValues.push({ identity: messageId, type: "Message" });
	logical.messages[messageId] = { id: messageId, sequence: 1, kind: "follow_up", senderId: "agent:root", targetId: "agent:child", sentAt: 1 };
	assertWellFormedContexts(logical);

	const received = deriveJudgment(logical, { kind: "receive", participantId: "agent:child", senderId: "agent:root", messageId, filtered: true });
	assert.equal(received.accepted, true);
	if (!received.accepted) return;
	assert.equal(received.derivation.contexts["agent:child"].delta.completeValues.some((value) => value.identity === messageId), false);
	assert.equal(logical.contexts["agent:child"].delta.completeValues.some((value) => value.identity === messageId), true, "derivation remains pure");
});

test("receive derives sender-filtered FIFO independently within each delivery class", () => {
	const logical = state();
	logical.contexts["agent:child"].gamma.agentPointers.push("agent:root");
	for (const [id, sequence, kind] of [["msg:first", 1, "follow_up"], ["msg:second", 2, "follow_up"], ["msg:steer", 3, "steering"]] as const) {
		logical.contexts["agent:child"].delta.completeValues.push({ identity: id, type: "Message" });
		logical.messages[id] = { id, sequence, kind, senderId: "agent:root", targetId: "agent:child", sentAt: sequence };
	}
	assert.equal(deriveJudgment(logical, { kind: "receive", participantId: "agent:child", senderId: "agent:root", messageId: "msg:second", filtered: true }).accepted, false);
	const steering = deriveJudgment(logical, { kind: "receive", participantId: "agent:child", senderId: "agent:root", messageId: "msg:steer", filtered: true });
	assert.equal(steering.accepted, true);
	if (!steering.accepted) return;
	const afterSteering = { ...logical, contexts: steering.derivation.contexts };
	assert.equal(deriveJudgment(afterSteering, { kind: "receive", participantId: "agent:child", senderId: "agent:root", messageId: "msg:second", filtered: true }).accepted, false);
	assert.equal(deriveJudgment(afterSteering, { kind: "receive", participantId: "agent:child", senderId: "agent:root", messageId: "msg:first", filtered: true }).accepted, true);
});

test("participant judgments distinguish common controls, Agent messaging, and Term lifecycle", () => {
	const logical = state();
	const root = "agent:root";
	const term = "term:shell";
	logical.participants[root].childIds.push(term);
	logical.participants[term] = { id: term, kind: "term", status: "ready", parentId: root, childIds: [] };
	logical.contexts[term] = emptyContext(term, "term");
	logical.contexts[root].gamma.agentPointers.push(term);
	logical.contexts[root].gamma.roles.push({ role: "parent", targetId: term });
	logical.contexts[term].gamma.agentPointers.push(root);
	logical.contexts[term].gamma.roles.push({ role: "child", targetId: root });

	assert.equal(deriveJudgment(logical, { kind: "listen", participantId: root, targetId: term }).accepted, true);
	assert.equal(deriveJudgment(logical, { kind: "wait", participantId: root, targetId: term, until: "stopped" }).accepted, true, "wait may block until its target state");
	assert.equal(deriveJudgment(logical, { kind: "exec", participantId: root, targetId: term }).accepted, true);
	assert.equal(deriveJudgment(logical, { kind: "input", participantId: root, targetId: term }).accepted, false);
	logical.participants[term].status = "running";
	assert.equal(deriveJudgment(logical, { kind: "input", participantId: root, targetId: term }).accepted, true);
	assert.equal(deriveJudgment(logical, { kind: "exec", participantId: root, targetId: term }).accepted, false);
	assert.equal(deriveJudgment(logical, { kind: "send", participantId: root, targetId: term }).accepted, false);
	assert.equal(deriveJudgment(logical, { kind: "log-agent", participantId: root, targetId: root }).accepted, true, "Agent self-log is defined");
	assert.equal(deriveJudgment(logical, { kind: "log-term", participantId: root, targetId: term }).accepted, true, "an ancestor may log a Term descendant");
	assert.equal(deriveJudgment(logical, { kind: "log-participant", participantId: root, targetId: term }).accepted, true, "generic participant log follows the target kind");
	assert.equal(deriveJudgment(logical, { kind: "log-term", participantId: term, targetId: term }).accepted, false, "Term self-log is not a judgment entry point");
	assert.equal(deriveJudgment(logical, { kind: "log-agent", participantId: root, targetId: term }).accepted, false, "legacy Agent log remains kind-specific");
	assert.equal(deriveJudgment(logical, { kind: "archive", participantId: root, targetId: term }).accepted, false);
	logical.participants[term].status = "stopped";
	assert.equal(deriveJudgment(logical, { kind: "archive", participantId: root, targetId: term }).accepted, true);
	assertWellFormedContexts(logical);
});

test("spawn derives the complete value for the requested participant kind", () => {
	const logical = state();
	const derived = deriveJudgment(logical, { kind: "spawn", participantId: "agent:root", childId: "human:reviewer", participantKind: "human", grants: [] });
	assert.equal(derived.accepted, true);
	if (!derived.accepted) return;
	assert.equal(derived.derivation.resultType, "Human");
	assert.deepEqual(derived.derivation.contexts["human:reviewer"].delta.completeValues, [{ identity: "human:reviewer", type: "Human" }]);
});

test("module imports enforce compiler → runtime → Pi layering", () => {
	const compiler = join(process.cwd(), "src", "compiler");
	for (const name of readdirSync(compiler).filter((entry) => entry.endsWith(".ts"))) {
		const source = readFileSync(join(compiler, name), "utf8");
		assert.doesNotMatch(source, /from\s+["'](?:node:|\.\.\/runtime|\.\.\/authority)/, name);
	}
	for (const layer of ["runtime", "pi"]) {
		const directory = join(process.cwd(), "src", layer);
		for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".ts"))) {
			const source = readFileSync(join(directory, name), "utf8");
			assert.doesNotMatch(source, /from\s+["']\.\.\/authority/, `${layer}/${name}`);
		}
	}
});
