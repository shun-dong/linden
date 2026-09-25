import assert from "node:assert/strict";
import test from "node:test";
import { formatParticipants } from "../src/pi/participants.js";
import type { AuthorityState, ParticipantRecord } from "../src/runtime/model.js";

function stateWith(participants: ParticipantRecord[]): AuthorityState {
	return {
		schemaVersion: 6,
		sessionId: "session:test",
		base: "/workspace",
		maxAgentDepth: 3,
		createdAt: 1,
		lastOpenedAt: 1,
		sequence: 0,
		rootParticipantId: "human:root",
		contexts: {},
		participants: Object.fromEntries(participants.map((participant) => [participant.id, participant])),
		participantTombstones: {},
		resources: {},
		messages: {},
		effects: [],
		checkpoints: {},
		agentStates: {},
		currentAgentStateIds: {},
		termEpochs: {},
	};
}

test("participant tree shows every kind and lifecycle without an archive view", () => {
	const state = stateWith([
		{ id: "human:root", name: "root", kind: "human", status: "stopped", childIds: ["agent:lead"], createdAt: 1 },
		{ id: "agent:lead", name: "lead", kind: "agent", status: "running", parentId: "human:root", childIds: ["term:shell"], createdAt: 2 },
		{ id: "term:shell", name: "shell", kind: "term", status: "ready", parentId: "agent:lead", childIds: ["human:reviewer"], createdAt: 3 },
		{ id: "human:reviewer", name: "reviewer", kind: "human", status: "stopped", parentId: "term:shell", childIds: [], createdAt: 4 },
	]);

	assert.equal(formatParticipants(state, "agent:lead"), [
		"Agent depth limit: 3",
		"root(human:root) [parent] [kind=Human, lifecycle=stopped]",
		"└── lead(agent:lead) [self] [kind=Agent, lifecycle=running]",
		"    └── shell(term:shell) [child] [kind=Term, lifecycle=ready]",
		"        └── reviewer(human:reviewer) [descendant] [kind=Human, lifecycle=stopped]",
	].join("\n"));
});
