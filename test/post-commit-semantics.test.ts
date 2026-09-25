import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCoordinator, type MailPayload, type ParticipantRuntime } from "../src/pi/runtime.js";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import type { ParticipantId } from "../src/runtime/model.js";

function agentRuntime(participantId: ParticipantId, options: { dispose?: () => Promise<void> } = {}): ParticipantRuntime {
	const payloads = new Map<string, MailPayload>();
	let sequence = 0;
	return {
		participantId,
		entries: () => [],
		leafId: () => null,
		isRunning: () => false,
		abort: async () => undefined,
		appendEntry: async (_type, data) => {
			const id = `payload:${++sequence}`;
			payloads.set(id, data as MailPayload);
			return id;
		},
		setLabel: () => undefined,
		readPayload: (id) => payloads.get(id),
		deliverBatch: async () => undefined,
		summary: () => participantId,
		dispose: options.dispose,
	};
}

test("a committed Agent-to-Human Message is not reported as failed when the live Human notifier throws", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-post-commit-send-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const agent = "agent:post-commit-send";
		await manager.spawnWith(human, agent, "sender", [], async () => ({ piSessionId: "post-commit-send" }));
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.runtimes.set(agent, agentRuntime(agent));
		coordinator.setHumanMessageHandler(() => { throw new Error("injected Human notifier failure"); });

		const messageId = await coordinator.send(agent, human, "durable report");
		const pending = manager.pendingMessages(human);
		assert.equal(pending.length, 1);
		assert.equal(pending[0].id, messageId);
		assert.equal(pending[0].consumedAt, undefined);
	} finally {
		await coordinator?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("archive remains committed after adapter cleanup fails, while coordinator shutdown fails closed", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-post-commit-archive-"));
	let coordinator: PiCoordinator | undefined;
	try {
		const manager = await SessionAuthorityManager.open({ workspace, stateDir: join(workspace, ".linden-test") });
		const human = manager.rootParticipantId;
		const child = "agent:post-commit-archive";
		await manager.spawnWith(human, child, "retired", [], async () => ({ piSessionId: "post-commit-archive" }));
		coordinator = PiCoordinator.createStandalone(manager);
		coordinator.runtimes.set(child, agentRuntime(child, {
			dispose: async () => { throw new Error("injected adapter cleanup failure"); },
		}));

		await coordinator.archive(human, child);
		assert.equal(manager.participant(child), undefined, "the durable destructive archive is not rolled back or disguised as uncommitted");
		assert.ok(manager.participantTombstone(child));
		await assert.rejects(coordinator.dispose(), /did not dispose cleanly|adapter cleanup failure/);
		coordinator = undefined;
	} finally {
		if (coordinator) await coordinator.dispose().catch(() => undefined);
		rmSync(workspace, { recursive: true, force: true });
	}
});
