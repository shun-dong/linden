import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { fileResourceId } from "../src/runtime/paths.js";

async function fixture() {
	const workspace = mkdtempSync(join(tmpdir(), "linden-authority-"));
	const manager = await SessionAuthorityManager.open({ workspace, lindenSessionId: "session:test-session", sessionId: "test-session", stateDir: join(workspace, ".linden-test") });
	return { workspace, manager, session: manager.sessionParticipantId, human: manager.rootParticipantId };
}
test("new ledgers use the OS username and participant references accept only unique Pi-session suffixes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-participant-ref-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, sessionId: "participant-ref", stateDir: join(workspace, ".linden-test") });
		assert.equal(manager.rootParticipantId, `human:${userInfo().username}`);
		const firstSession = "01a009e7-8e05-7a21-b336-aaaa1111";
		const secondSession = "01a009e7-8e05-7a21-b336-bbbb1111";
		const first = `agent:${firstSession}`;
		const second = `agent:${secondSession}`;
		await manager.spawnWith(manager.sessionParticipantId, first, "first", [], async () => ({ piSessionId: firstSession }));
		await manager.spawnWith(manager.sessionParticipantId, second, "second", [], async () => ({ piSessionId: secondSession }));
		assert.equal(manager.resolveParticipantRef(first), first);
		assert.equal(manager.resolveParticipantRef(firstSession), first);
		assert.equal(manager.resolveParticipantRef("aaaa1111"), first);
		assert.throws(() => manager.resolveParticipantRef(`term:${firstSession}`), /Unknown participant/);
		assert.throws(() => manager.resolveParticipantRef(`human:${firstSession}`), /Unknown participant/);
		assert.throws(() => manager.resolveParticipantRef("agent:aaaa1111"), /Unknown participant/);
		assert.throws(() => manager.resolveParticipantRef("1111"), /Ambiguous participant suffix/);
		const legacy = "agent:legacy-random-id";
		await manager.spawnWith(manager.sessionParticipantId, legacy, "legacy", [], async () => ({ piSessionId: "01a009e7-legacy-cafebabe" }));
		assert.equal(manager.resolveParticipantRef("cafebabe"), legacy);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("wait records an effect only while its requested lifecycle predicate is true", async () => {
	const { workspace, manager, session, human } = await fixture();
	try {
		await manager.setParticipantStatus(session, "running");
		const before = manager.snapshot().effects.length;
		assert.equal(await manager.commitWait(human, session, "ready", () => true), false);
		assert.equal(manager.snapshot().effects.length, before);
		await manager.setParticipantStatus(session, "ready");
		assert.equal(await manager.commitWait(human, session, "ready", () => false), false);
		assert.equal(manager.snapshot().effects.length, before, "a stale durable status cannot bypass the live runtime predicate");
		assert.equal(await manager.commitWait(human, session, "ready", () => true), true);
		assert.equal(manager.snapshot().effects.at(-1)?.kind, "wait");
		assert.equal(manager.snapshot().effects.at(-1)?.targetId, session);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("an empty receive batch still enforces the recipient participant kind", async () => {
	const { workspace, manager, human } = await fixture();
	try {
		const term = "term:empty-receive";
		await manager.spawnWith(human, term, "term", [], async () => ({}), {
			participantKind: "term",
			inheritWorkspaceRead: false,
		});
		await assert.rejects(
			manager.receiveMessages(term, []),
			/PARTICIPANT_KIND_MISMATCH/,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("human owns the base while a top-level Agent defaults to base read only", async () => {
	const { workspace, manager, session, human } = await fixture();
	try {
		const workspaceResource = manager.resource(manager.baseResourceId());
		assert.equal(workspaceResource?.ownerId, human);
		assert.ok(workspaceResource?.pointers.includes(session));
		assert.equal(manager.snapshot().base, workspace);
		assert.equal(Object.values(manager.snapshot().resources).some((resource) => resource.id === "path:home"), false);
		await manager.writeFile(human, "human-owned.txt", "visible");
		assert.equal((await manager.readFile(session, "human-owned.txt")).content, "visible");
		await assert.rejects(manager.writeFile(session, "human-owned.txt", "agent write"), /UNAUTHORIZED_WRITE/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("pre-v5 ledgers are rejected instead of migrated", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-v1-rejection-"));
	const stateDir = join(workspace, ".legacy-linden");
	try {
		mkdirSync(stateDir, { recursive: true });
		for (const schemaVersion of [1, 2, 3, 4]) {
			writeFileSync(join(stateDir, "ledger.json"), JSON.stringify({ schemaVersion }));
			await assert.rejects(
				SessionAuthorityManager.open({ workspace, stateDir }),
				new RegExp(`UNSUPPORTED_LEDGER_V${schemaVersion}: pre-v5 Linden ledgers are not migrated`),
			);
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("ledger v6 persists one canonical Delta/Gamma normal form and reconstructs runtime indexes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-v6-ledger-"));
	const stateDir = join(workspace, ".state");
	try {
		const options = { workspace, stateDir, lindenSessionId: "session:v6-layout", sessionId: "v6-pi" };
		const manager = await SessionAuthorityManager.open(options);
		const file = await manager.writeFile(manager.rootParticipantId, "state.txt", "v6");
		const state = manager.snapshot();
		const owner = manager.ownerOf(file.resourceId)!;
		const complete = state.contexts[owner].delta.completeValues.find((value) => value.identity === file.resourceId);
		const resource = state.resources[file.resourceId];
		assert.equal(resource.kind, "file");
		assert.equal(complete?.type, "File");
		assert.equal(complete?.stateId, resource.kind === "file" ? resource.currentVersionId : undefined);

		const ledger = JSON.parse(readFileSync(join(stateDir, "ledger.json"), "utf8"));
		assert.equal(ledger.schemaVersion, 8);
		assert.ok(Array.isArray(ledger.Delta));
		assert.ok(Array.isArray(ledger.Gamma));
		assert.ok(ledger.runtimeMetadata.effects);
		assert.equal(new Set(ledger.Delta.map((entry: any) => entry.variable)).size, ledger.Delta.length);
		const persistedFile = ledger.Delta.find((entry: any) => entry.variable === file.resourceId);
		assert.deepEqual({ type: persistedFile.type, owner: persistedFile.owner, current: persistedFile.state.current }, { type: "File", owner, current: (resource as any).currentVersionId });
		for (const duplicate of ["id", "kind", "path", "ownerId", "pointers"]) assert.equal(Object.hasOwn(persistedFile.state, duplicate), false);
		const base = ledger.Delta.find((entry: any) => entry.type === "FileRegion" && entry.owner === manager.rootParticipantId);
		assert.equal(base.state, null);
		const session = manager.sessionParticipantId;
		const directRole = ledger.Gamma.find((entry: any) => entry.variable === `&>${session}` && entry.type === "&>Agent");
		assert.deepEqual(directRole.owners, [manager.rootParticipantId]);
		const persistedAgent = ledger.Delta.find((entry: any) => entry.variable === session);
		assert.equal(Object.hasOwn(persistedAgent.state.participant, "parentId"), false);
		assert.equal(Object.hasOwn(persistedAgent.state.participant, "childIds"), false);
		for (const duplicate of ["contexts", "participants", "resources", "messages", "checkpoints", "agentStates", "currentAgentStateIds"]) {
			assert.equal(Object.hasOwn(ledger.runtimeMetadata, duplicate), false);
		}

		const reopened = await SessionAuthorityManager.open(options);
		assert.equal(reopened.participant(session)?.parentId, reopened.rootParticipantId);
		assert.equal((await reopened.readFile(session, "state.txt")).content, "v6");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("opening an unchanged v6 ledger does not rewrite it", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-clean-reopen-"));
	const stateDir = join(workspace, ".state");
	const options = { workspace, stateDir, lindenSessionId: "session:clean-reopen", sessionId: "clean-reopen-pi" };
	try {
		await SessionAuthorityManager.open(options);
		const ledgerPath = join(stateDir, "ledger.json");
		const before = readFileSync(ledgerPath, "utf8");
		await SessionAuthorityManager.open(options);
		assert.equal(readFileSync(ledgerPath, "utf8"), before);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("ledger v6 rejects non-canonical authority and state references without rewriting the input", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-v6-tamper-"));
	const stateDir = join(workspace, ".state");
		const options = { workspace, stateDir, lindenSessionId: "session:v6-tamper", sessionId: "v6-tamper-pi" };
	try {
		const manager = await SessionAuthorityManager.open(options);
		await manager.writeFile(manager.rootParticipantId, "present.txt", "present");
		const ledgerPath = join(stateDir, "ledger.json");
		const valid = readFileSync(ledgerPath, "utf8");
		const root = manager.rootParticipantId;
		const session = manager.sessionParticipantId;
		const cases: Array<{ name: string; mutate: (ledger: any) => string | void }> = [
			{
				name: "session base mismatch",
				mutate(ledger) { ledger.runtimeMetadata.base = resolve(workspace, ".."); },
			},
			{
				name: "base escape",
				mutate(ledger) { ledger.Delta.push({ variable: fileResourceId(resolve(workspace, "..", "outside"), true), state: null, type: "FileRegion", owner: root }); },
			},
			{
				name: "private state path",
				mutate(ledger) { ledger.Delta.push({ variable: fileResourceId(join(stateDir, "hidden"), true), state: null, type: "FileRegion", owner: root }); },
			},
			{
				name: "non-canonical Web wildcard",
				mutate(ledger) { ledger.Delta.push({ variable: "web:*./", state: null, type: "Web", owner: root }); },
			},
			{
				name: "File type marker mismatch",
				mutate(ledger) { ledger.Delta.push({ variable: fileResourceId(join(workspace, "not-a-region"), false), state: null, type: "FileRegion", owner: root }); },
			},
			{
				name: "snapshot blob traversal",
				mutate(ledger) {
					const file = ledger.Delta.find((entry: any) => entry.type === "File");
					file.state.versions.find((node: any) => node.snapshot.exists).snapshot.blobHash = "../../ledger.json";
				},
			},
			{
				name: "non-finite sequence",
				mutate(ledger) {
					ledger.runtimeMetadata.sequence = "__INFINITY__";
					return JSON.stringify(ledger).replace('"__INFINITY__"', "1e309");
				},
			},
			{
				name: "non-canonical Agent ID",
				mutate(ledger) {
					const agent = structuredClone(ledger.Delta.find((entry: any) => entry.variable === session));
					agent.variable = "__proto__";
					agent.owner = "__proto__";
					ledger.Delta.push(agent);
				},
			},
			{
				name: "duplicate Pi session binding",
				mutate(ledger) {
					const agent = structuredClone(ledger.Delta.find((entry: any) => entry.variable === session));
					agent.variable = "agent:duplicate-session-owner";
					agent.owner = agent.variable;
					ledger.Delta.push(agent);
					ledger.Delta.sort((left: any, right: any) => left.variable < right.variable ? -1 : left.variable > right.variable ? 1 : left.type < right.type ? -1 : left.type > right.type ? 1 : 0);
				},
			},
			{
				name: "human payload traversal",
				mutate(ledger) {
					ledger.Delta.push({ variable: "msg:tampered", state: { sequence: ledger.runtimeMetadata.sequence, kind: "follow_up", senderId: root, payloadEntryId: "private:../../ledger", sentAt: Date.now(), origin: "explicit" }, type: "Message", owner: session });
				},
			},
			{
				name: "empty Gamma holder set",
				mutate(ledger) {
					const file = ledger.Delta.find((entry: any) => entry.type === "File");
					ledger.Gamma.push({ variable: `&${file.variable}`, type: "&File", owners: [] });
					ledger.Gamma.sort((left: any, right: any) => left.variable.localeCompare(right.variable) || left.type.localeCompare(right.type));
				},
			},
			{
				name: "derived owner pointer in Gamma",
				mutate(ledger) {
					const file = ledger.Delta.find((entry: any) => entry.type === "File");
					ledger.Gamma.push({ variable: `&${file.variable}`, type: "&File", owners: [file.owner] });
					ledger.Gamma.sort((left: any, right: any) => left.variable.localeCompare(right.variable) || left.type.localeCompare(right.type));
				},
			},
		];
		for (const scenario of cases) {
			const ledger = JSON.parse(valid);
			const encoded = scenario.mutate(ledger) ?? JSON.stringify(ledger);
			writeFileSync(ledgerPath, encoded);
			await assert.rejects(SessionAuthorityManager.open(options), /INVALID_LEDGER_V[56]|Linden runtime state/, scenario.name);
			assert.equal(readFileSync(ledgerPath, "utf8"), encoded, `${scenario.name} was rewritten`);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("snapshot and private-payload stores reject traversal and corrupted blob content", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-store-integrity-"));
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".state") });
		const snapshot = manager.store.captureBuffer(Buffer.from("safe"));
		writeFileSync(join(manager.store.blobDir, snapshot.blobHash!), "tampered");
		assert.throws(() => manager.store.readSnapshot(snapshot), /SNAPSHOT_INTEGRITY/);
		assert.throws(() => manager.store.writeSnapshot(join(workspace, "bad.txt"), { exists: true, hash: "a".repeat(64), blobHash: "..\/ledger.json", mode: 0o644, size: 1 }), /INVALID_SNAPSHOT/);
		assert.equal(manager.store.readPrivatePayload("private:../../ledger"), undefined);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("participant APIs reject identities that the v5 decoder could not reopen", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-participant-id-"));
	try {
		await assert.rejects(SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".bad-root"), rootParticipantId: "root" }), /INVALID_PARTICIPANT_ID/);
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".state"), sessionId: "participant-id" });
		await assert.rejects(manager.spawnWith(manager.sessionParticipantId, "child", "child", [], async () => ({ piSessionId: "child" })), /INVALID_PARTICIPANT_ID/);
		await assert.rejects(manager.spawnWith(manager.sessionParticipantId, "agent:empty-runtime", "empty", [], async () => ({ piSessionId: "" })), /INVALID_PARTICIPANT_STATE/);
		await assert.rejects(manager.spawnWith(manager.sessionParticipantId, "agent:orphan-session-file", "orphan", [], async () => ({ sessionFile: join(workspace, "orphan.jsonl") })), /INVALID_PARTICIPANT_STATE/);
		await manager.spawnWith(manager.sessionParticipantId, "agent:first-runtime", "first", [], async () => ({ piSessionId: "shared-runtime" }));
		await assert.rejects(manager.spawnWith(manager.sessionParticipantId, "agent:second-runtime", "second", [], async () => ({ piSessionId: "shared-runtime" })), /already bound/);
		assert.equal(manager.participant("agent:second-runtime"), undefined);
		const reopened = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".state"), lindenSessionId: manager.sessionId, sessionId: "participant-id" });
		assert.equal(reopened.participant("agent:first-runtime")?.piSessionId, "shared-runtime");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("native write/edit/checkouts preserve a branching File tree", async () => {
	const { workspace, manager, human } = await fixture();
	try {
		const first = await manager.writeFile(human, "note.txt", "one");
		const second = await manager.editFile(human, "note.txt", "one", "two");
		assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "two");
		await assert.rejects(manager.editFile(human, "note.txt", "missing", "x"), /not found/);
		assert.equal(manager.resource(first.resourceId)?.kind, "file");
		await manager.checkout(human, first.resourceId, first.stateId);
		assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "one");
		const branch = await manager.writeFile(human, "note.txt", "branch");
		const log = manager.resourceLog(human, first.resourceId);
		assert.equal(log.length, 4); // absent root, first, second, branch
		assert.equal(log.find((node) => node.id === branch.stateId)?.parent, first.stateId);
		assert.equal(log.filter((node) => node.current).length, 1);
		assert.notEqual(second.stateId, branch.stateId);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("give moves ownership atomically across a direct edge; stale writes fail", async () => {
	const { workspace, manager, session, human } = await fixture();
	try {
		const baseResource = manager.baseResourceId();
		const moved = await manager.give(human, session, baseResource);
		assert.ok(moved.includes(baseResource));
		assert.equal(manager.resource(baseResource)?.ownerId, session, "give completes the transfer immediately");
		const file = await manager.writeFile(session, "owned.txt", "parent");
		const child = "agent:child";
		await manager.spawnWith(session, child, "child", [{ resourceId: file.resourceId, mode: "read" }], async () => ({ piSessionId: "child-session" }));
		assert.equal((await manager.readFile(child, "owned.txt")).content, "parent");
		await assert.rejects(manager.writeFile(child, "owned.txt", "early"), /UNAUTHORIZED_WRITE/);
		await manager.give(session, child, file.resourceId);
		assert.equal(manager.resource(file.resourceId)?.ownerId, child);
		await assert.rejects(manager.writeFile(session, "owned.txt", "stale"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(manager.give(session, child, file.resourceId), /UNAUTHORIZED_WRITE/, "the previous owner no longer holds the resource");
		await manager.writeFile(child, "owned.txt", "child");
		assert.equal(readFileSync(join(workspace, "owned.txt"), "utf8"), "child");
		const sibling = "agent:sibling";
		await manager.spawnWith(session, sibling, "sibling", [], async () => ({ piSessionId: "sibling-session" }));
		await assert.rejects(manager.give(child, sibling, file.resourceId), /ROLE_MISMATCH/);
		// the parent takes the resource back with get; a child cannot take from its parent
		const taken = await manager.get(session, child, file.resourceId);
		assert.ok(taken.includes(file.resourceId));
		assert.equal(manager.resource(file.resourceId)?.ownerId, session);
		await assert.rejects(manager.get(child, session, file.resourceId), /ROLE_MISMATCH/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("give &A grants a read pointer without moving ownership", async () => {
	const { workspace, manager, session, human } = await fixture();
	try {
		await manager.give(human, session, manager.baseResourceId());
		const file = await manager.writeFile(session, "shared.txt", "shared");
		const child = "agent:read-child";
		await manager.spawnWith(session, child, "read-child", [], async () => ({ piSessionId: "read-child-session" }), { inheritWorkspaceRead: false });
		await assert.rejects(manager.readFile(child, "shared.txt"), /UNAUTHORIZED_READ/);
		assert.deepEqual(await manager.give(session, child, file.resourceId, "read"), [file.resourceId], "read grants return the granted resource without moving ownership");
		assert.equal(manager.resource(file.resourceId)?.ownerId, session, "ownership does not move on a read grant");
		assert.ok(manager.resource(file.resourceId)?.pointers.includes(child));
		assert.equal((await manager.readFile(child, "shared.txt")).content, "shared");
		await assert.rejects(manager.writeFile(child, "shared.txt", "nope"), /UNAUTHORIZED_WRITE/);
		// complete ownership can still move across the same edge afterwards
		await manager.give(session, child, file.resourceId);
		assert.equal(manager.resource(file.resourceId)?.ownerId, child);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("read returns Absent as a FileState instead of failing", async () => {
	const { workspace, manager, session, human } = await fixture();
	try {
		await manager.give(human, session, manager.baseResourceId());
		const result = await manager.readFile(session, "not-there.txt");
		assert.equal(result.state, "Absent");
		assert.equal(result.content, "");
		await manager.writeFile(session, "not-there.txt", "now");
		const present = await manager.readFile(session, "not-there.txt");
		assert.equal(present.state, "Present");
		assert.equal(present.content, "now");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("mail messages have stable IDs and receive consumes exactly once", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const child = "agent:mail-child";
		await manager.spawnWith(session, child, "mail", [], async () => ({ piSessionId: "mail-session" }));
		const message = await manager.sendWithPayload(session, child, async (id) => `entry:${id}`);
		assert.match(message.id, /^msg:/);
		let ledger = JSON.parse(readFileSync(join(workspace, ".linden-test", "ledger.json"), "utf8"));
		assert.deepEqual(ledger.Delta.find((entry: any) => entry.variable === message.id)?.owner, child);
		assert.equal(manager.pendingMessages(child, session)[0].id, message.id);
		await manager.receive(child, session, message.id);
		ledger = JSON.parse(readFileSync(join(workspace, ".linden-test", "ledger.json"), "utf8"));
		assert.equal(ledger.Delta.some((entry: any) => entry.variable === message.id), false);
		assert.equal(ledger.runtimeMetadata.messageReceipts.some((receipt: any) => receipt.id === message.id), true);
		await assert.rejects(manager.receive(child, session, message.id), /MESSAGE_ALREADY_CONSUMED/);
		const reopened = await SessionAuthorityManager.open({ workspace, lindenSessionId: manager.sessionId, sessionId: "test-session", stateDir: join(workspace, ".linden-test") });
		await assert.rejects(reopened.receive(child, session, message.id), /MESSAGE_ALREADY_CONSUMED/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("receiveMessages consumes the whole current mailbox in FIFO order", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const childA = "agent:mail-a";
		const childB = "agent:mail-b";
		await manager.spawnWith(session, childA, "mail-a", [], async () => ({ piSessionId: "mail-a-session" }));
		await manager.spawnWith(session, childB, "mail-b", [], async () => ({ piSessionId: "mail-b-session" }));
		const first = await manager.sendWithPayload(childA, session, async (id) => `entry:${id}`);
		const second = await manager.sendWithPayload(childB, session, async (id) => `entry:${id}`);
		const pending = manager.pendingMessages(session);
		assert.deepEqual(pending.map((message) => message.id), [first.id, second.id]);
		const received = await manager.receiveMessages(session, pending.map((message) => message.id));
		assert.deepEqual(received.map((message) => message.senderId), [childA, childB]);
		assert.deepEqual(manager.pendingMessages(session), []);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("payload storage does not hold the global commit lock and is revalidated before send commits", { timeout: 2_000 }, async () => {
	const { workspace, manager, session } = await fixture();
	let releasePayload!: () => void;
	try {
		const child = "agent:delayed-payload-child";
		await manager.spawnWith(session, child, "delayed payload", [], async () => ({ piSessionId: "delayed-payload-child" }));
		let payloadStarted!: () => void;
		const started = new Promise<void>((resolveStarted) => { payloadStarted = resolveStarted; });
		const release = new Promise<void>((resolveRelease) => { releasePayload = resolveRelease; });
		const send = manager.sendWithPayload(session, child, async (id) => {
			payloadStarted();
			await release;
			return `entry:${id}`;
		});
		const sendOutcome = send.then((message) => ({ message }), (error: unknown) => ({ error }));
		await started;
		const archived = manager.archiveParticipant(session, child, () => true);
		const archiveCompletedWhilePayloadWaited = await Promise.race([
			archived.then(() => true),
			new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 100)),
		]);
		releasePayload();
		await archived;
		const outcome = await sendOutcome;
		assert.equal(archiveCompletedWhilePayloadWaited, true);
		assert.ok("error" in outcome && outcome.error instanceof Error && /UNKNOWN_PARTICIPANT/.test(outcome.error.message));
		assert.equal(manager.participant(child), undefined, "destructive archive removes the child before send revalidation");
		assert.throws(() => manager.pendingMessages(child), /Unknown participant/);
	} finally {
		releasePayload?.();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("spawn re-derives the latest context after asynchronous runtime creation", { timeout: 2_000 }, async () => {
	const { workspace, manager, session } = await fixture();
	let releaseRuntime!: () => void;
	try {
		const sender = "agent:spawn-race-sender";
		const delayedChild = "agent:spawn-race-child";
		await manager.spawnWith(session, sender, "sender", [], async () => ({ piSessionId: "spawn-race-sender" }));
		let runtimeStarted!: () => void;
		const started = new Promise<void>((resolveStarted) => { runtimeStarted = resolveStarted; });
		const release = new Promise<void>((resolveRelease) => { releaseRuntime = resolveRelease; });
		const spawning = manager.spawnWith(session, delayedChild, "delayed", [], async () => {
			runtimeStarted();
			await release;
			return { piSessionId: "spawn-race-child" };
		});
		await started;
		const message = await manager.sendWithPayload(sender, session, async (id) => `entry:${id}`);
		releaseRuntime();
		await spawning;
		assert.deepEqual(manager.pendingMessages(session).map((candidate) => candidate.id), [message.id]);
		assert.ok(manager.snapshot().contexts[session].delta.completeValues.some((value) => value.identity === message.id && value.type === "Message"));
		const reopened = await SessionAuthorityManager.open({ workspace, lindenSessionId: manager.sessionId, sessionId: "test-session", stateDir: join(workspace, ".linden-test") });
		assert.deepEqual(reopened.pendingMessages(session).map((candidate) => candidate.id), [message.id]);
	} finally {
		releaseRuntime?.();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Message reservations preserve FIFO per sender and let steering precede follow-ups", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const child = "agent:mail-order-child";
		await manager.spawnWith(session, child, "mail order", [], async () => ({ piSessionId: "mail-order-child" }));
		const first = await manager.sendWithPayload(child, session, async (id) => `entry:${id}`);
		const claimed = await manager.claimPendingMessages(session, "follow_up", "batch:first");
		assert.deepEqual(claimed.map((message) => message.id), [first.id]);
		const second = await manager.sendWithPayload(child, session, async (id) => `entry:${id}`);
		await assert.rejects(manager.claimPendingMessages(session, "follow_up", "batch:second"), /MESSAGE_OUT_OF_ORDER/);
		await manager.acknowledgeDelivery(session, "batch:first");
		assert.deepEqual((await manager.claimPendingMessages(session, "follow_up", "batch:second")).map((message) => message.id), [second.id]);
		await manager.acknowledgeDelivery(session, "batch:second");

		const followUp = await manager.sendWithPayload(session, child, async (id) => `entry:${id}`);
		const steering = await manager.sendWithPayload(session, child, async (id) => `entry:${id}`, "steering");
		assert.deepEqual((await manager.claimPendingMessages(child, "steering", "batch:steering")).map((message) => message.id), [steering.id]);
		await manager.acknowledgeDelivery(child, "batch:steering");
		assert.deepEqual(manager.pendingMessages(child, session, "follow_up").map((message) => message.id), [followUp.id]);
		await manager.receive(child, session, followUp.id);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("delivery reservations remain process-local and reopen as pending", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const child = "agent:volatile-claim-child";
		await manager.spawnWith(session, child, "volatile claim", [], async () => ({ piSessionId: "volatile-claim-child" }));
		const message = await manager.sendWithPayload(session, child, async (id) => `entry:${id}`);
		const ledgerPath = join(workspace, ".linden-test", "ledger.json");
		const beforeClaim = readFileSync(ledgerPath, "utf8");
		assert.deepEqual((await manager.claimPendingMessages(child, "follow_up", "batch:volatile")).map((candidate) => candidate.id), [message.id]);
		assert.equal(readFileSync(ledgerPath, "utf8"), beforeClaim, "claiming does not fsync or rewrite the ledger");
		await manager.setParticipantStatus(child, "running");
		const persisted = JSON.parse(readFileSync(ledgerPath, "utf8"));
		const messageState = persisted.Delta.find((entry: any) => entry.variable === message.id)?.state;
		assert.equal(messageState.deliveryBatchId, undefined);
		assert.equal(messageState.queuedAt, undefined);
		const reopened = await SessionAuthorityManager.open({ workspace, lindenSessionId: manager.sessionId, sessionId: "test-session", stateDir: join(workspace, ".linden-test") });
		assert.deepEqual(reopened.pendingMessages(child).map((candidate) => candidate.id), [message.id]);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("steering rejects a non-ancestor and is consumed on delivery acknowledgment", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const child = "agent:steer-child";
		const sibling = "agent:steer-sibling";
		await manager.spawnWith(session, child, "steer-child", [], async () => ({ piSessionId: "steer-child-session" }));
		await manager.spawnWith(session, sibling, "steer-sibling", [], async () => ({ piSessionId: "steer-sibling-session" }));
		const message = await manager.sendWithPayload(session, child, async (id) => `entry:${id}`, "steering");
		assert.equal(message.kind, "steering");
		await assert.rejects(manager.sendWithPayload(sibling, child, async (id) => `entry:${id}`, "steering"), /ROLE_MISMATCH/);
		const claimed = await manager.claimPendingMessages(child, "steering", "batch:test");
		assert.deepEqual(claimed.map((record) => record.id), [message.id]);
		assert.deepEqual(manager.pendingMessages(child, undefined, "steering"), []);
		await manager.acknowledgeDelivery(child, "batch:test");
		const stored = manager.snapshot().messages[message.id];
		assert.ok(stored.deliveredAt);
		assert.equal(stored.consumedBy, child);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("external paths require explicit authority after canonicalization", async () => {
	const { workspace, manager, session } = await fixture();
	const outside = mkdtempSync(join(tmpdir(), "linden-outside-"));
	try {
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
		await assert.rejects(manager.readFile(session, "link.txt"), /UNAUTHORIZED_READ/);
		await assert.rejects(manager.writeFile(session, join(outside, "escape.txt"), "bad"), /UNAUTHORIZED_WRITE/);
		await assert.rejects(manager.readFile(session, "."), /NOT_A_FILE/);
		assert.equal((await manager.readFile(session, "./note.txt")).state, "Absent");
		await assert.rejects(manager.readFile(session, "~/note.txt"), /UNAUTHORIZED_READ|PATH_CANONICALIZATION_FAILED/);
	} finally { rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("runtime-state boundaries reject a physical alias through a symlink ancestor", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-private-alias-"));
	const physicalParent = join(workspace, "physical-private");
	const alias = join(workspace, "state-alias");
	const stateDir = join(alias, "nested-state");
	const options = { workspace, stateDir, lindenSessionId: "session:private-alias" };
	try {
		mkdirSync(physicalParent);
		symlinkSync(physicalParent, alias, process.platform === "win32" ? "junction" : "dir");
		const manager = await SessionAuthorityManager.open(options);
		const physicalStateDir = join(physicalParent, "nested-state");
		await assert.rejects(
			manager.writeFile(manager.rootParticipantId, join(physicalStateDir, "hidden.txt"), "secret"),
			/Linden runtime state/,
		);

		const ledgerPath = join(stateDir, "ledger.json");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		ledger.Delta.push({ variable: fileResourceId(join(physicalStateDir, "hidden"), true), state: null, type: "FileRegion", owner: manager.rootParticipantId });
		ledger.Delta.sort((left: any, right: any) => left.variable < right.variable ? -1 : left.variable > right.variable ? 1 : left.type < right.type ? -1 : left.type > right.type ? 1 : 0);
		writeFileSync(ledgerPath, JSON.stringify(ledger));
		await assert.rejects(SessionAuthorityManager.open(options), /Linden runtime state/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("hardlinked File aliases fail closed", async () => {
	const { workspace, manager, human } = await fixture();
	const outside = mkdtempSync(join(tmpdir(), "linden-hardlink-outside-"));
	try {
		const target = join(outside, "shared.txt");
		writeFileSync(target, "outside");
		linkSync(target, join(workspace, "alias.txt"));
		await assert.rejects(manager.readFile(human, "alias.txt"), /HARDLINK_UNSUPPORTED/);
		await assert.rejects(manager.writeFile(human, "alias.txt", "changed"), /HARDLINK_UNSUPPORTED/);
		assert.equal(readFileSync(target, "utf8"), "outside");
	} finally { rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("out-of-band mutation marks the versioned resource divergent and fails closed", async () => {
	const { workspace, manager, human } = await fixture();
	try {
		await manager.writeFile(human, "drift.txt", "tracked");
		writeFileSync(join(workspace, "drift.txt"), "external");
		await assert.rejects(manager.readFile(human, "drift.txt"), /RESOURCE_DIVERGED/);
		await assert.rejects(manager.writeFile(human, "drift.txt", "later"), /RESOURCE_DIVERGED/);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("prepared physical writes are committed from journal after restart", async () => {
	const { workspace, manager, human } = await fixture();
	try {
		const first = await manager.writeFile(human, "recover.txt", "before");
		const before = manager.store.capture(join(workspace, "recover.txt"), true);
		const after = manager.store.captureBuffer(Buffer.from("after"));
		const stateNodeId = `state:${first.resourceId}:recovered`;
		manager.store.writeJournal({ version: 1, type: "file", id: "crash-window", operation: "write", participantId: human, resourceId: first.resourceId, path: join(workspace, "recover.txt"), before, after, stateNodeId, createdAt: Date.now() });
		manager.store.atomicWrite(join(workspace, "recover.txt"), Buffer.from("after"));
		const reopened = await SessionAuthorityManager.open({ workspace, lindenSessionId: manager.sessionId, sessionId: "test-session", stateDir: join(workspace, ".linden-test") });
		assert.equal((reopened.resource(first.resourceId) as any).currentVersionId, stateNodeId);
		assert.equal((await reopened.readFile(human, "recover.txt")).content, "after");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("reopen batch-normalizes stale running participants and remembers the interrupted set in memory", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-stale-running-"));
	const stateDir = join(workspace, ".linden-test");
	const lindenSessionId = "session:stale-running";
	try {
		const manager = await SessionAuthorityManager.open({ workspace, lindenSessionId, stateDir });
		const child = "agent:stale-running-child";
		await manager.spawnWith(manager.rootParticipantId, child, "child", [], async () => ({ piSessionId: "stale-running-child" }));
		await manager.setParticipantStatus(child, "running");

		const reopened = await SessionAuthorityManager.open({ workspace, lindenSessionId, stateDir });
		assert.equal(reopened.participant(child)?.status, "stopped");
		assert.equal(reopened.wasParticipantRunningAtOpen(child), true);

		const reopenedAgain = await SessionAuthorityManager.open({ workspace, lindenSessionId, stateDir });
		assert.equal(reopenedAgain.participant(child)?.status, "stopped");
		assert.equal(reopenedAgain.wasParticipantRunningAtOpen(child), false, "the normalized stopped state is persisted once");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("assistant final is an idempotent ordinary follow-up to the direct parent", async () => {
	const { workspace, manager, session } = await fixture();
	try {
		const child = "agent:final-child";
		await manager.spawnWith(session, child, "final", [], async () => ({ piSessionId: "final-child" }));
		let appendCount = 0;
		const first = await manager.sendFinalWithPayload(child, "pi:assistant-final", async (id) => { appendCount++; return `entry:${id}`; });
		const second = await manager.sendFinalWithPayload(child, "pi:assistant-final", async (id) => { appendCount++; return `entry:${id}`; });
		assert.equal(second.id, first.id);
		assert.equal(appendCount, 1);
		assert.equal(first.origin, "assistant_final");
		const pending = manager.pendingMessages(session, child, "follow_up");
		assert.deepEqual(pending.map((message) => message.id), [first.id]);
		await manager.receiveMessages(session, [first.id]);
		assert.deepEqual(manager.pendingMessages(session, child, "follow_up"), []);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
