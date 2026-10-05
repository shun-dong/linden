/** Opt-in live provider test. Build first; uses Pi's configured credentials.
 * Run: PI_CODING_AGENT_DIR=<config> node scripts/smoke-pi-luna.mjs
 * Every model turn must use openai-codex/gpt-6-luna; no mock adapters.
 */
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { StandalonePiHost } from '../dist/pi/host.js';
import { fileResourceId } from '../dist/runtime/paths.js';
import { canWritePath } from '../dist/compiler/judgment.js';

const directory = mkdtempSync(join(tmpdir(), 'linden-live-luna-'));
const base = join(directory, 'workspace');
const stateRoot = join(directory, 'state');
mkdirSync(base);
// Isolate settings changes and credential refresh from the user's Pi directory.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const agentDir = join(directory, 'pi-config');
mkdirSync(agentDir, { mode: 0o700 });
for (const name of ['auth.json', 'models.json', 'models-store.json']) {
	if (existsSync(join(originalAgentDir, name))) {
		copyFileSync(join(originalAgentDir, name), join(agentDir, name));
		chmodSync(join(agentDir, name), 0o600);
	}
}
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6-luna', defaultThinkingLevel: 'low', quietStartup: true }), { mode: 0o600 });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
const reportPath = join(directory, 'report.json');
const report = { model: 'openai-codex/gpt-6-luna', startedAt: new Date().toISOString(), directory, checks: [], turns: [] };
let host;
const check = (name, verify) => { verify(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
const text = (result) => (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const resultsFor = (turn, name) => turn.tools.filter((tool) => tool.name === name);
const entriesFor = (id) => host.coordinator.hostedRuntime(id).session.sessionManager.getEntries();
const assistantCount = (id) => entriesFor(id).filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function png() {
	const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
	const chunk = (kind, bytes) => { const tag = Buffer.from(kind); const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); tag.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(Buffer.concat([tag, bytes])), bytes.length + 8); return result; };
	const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
	const rows = Buffer.alloc(32 * (1 + 32 * 3)); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rows[y * 97 + 1 + x * 3] = 255;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function turn(id, name, prompt) {
	const session = host.coordinator.hostedRuntime(id).session;
	assert.equal(session.model?.provider, 'openai-codex');
	assert.equal(session.model?.id, 'gpt-6-luna', 'A model fallback is not an acceptable live test');
	session.setThinkingLevel('low');
	const record = { name, participantId: id, model: `${session.model.provider}/${session.model.id}`, tools: [], requests: [], startedAt: new Date().toISOString() };
	report.turns.push(record);
	const originalPayloadHook = session.agent.onPayload;
	session.agent.onPayload = async (payload, model) => {
		const transformed = await originalPayloadHook?.(payload, model);
		const body = transformed ?? payload;
		const images = [];
		const visit = (value) => {
			if (!value || typeof value !== 'object') return;
			if (value.type === 'input_image' && typeof value.image_url === 'string') images.push(digest(Buffer.from(value.image_url.split(',')[1], 'base64')));
			for (const child of Object.values(value)) visit(child);
		};
		visit(body);
		record.requests.push({ model: body.model, imageHashes: images });
		return transformed;
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === 'tool_execution_start') console.log(`${name}: ${event.toolName}`);
		if (event.type === 'tool_execution_end') record.tools.push({ name: event.toolName, isError: event.isError, text: text(event.result).slice(0, 16000), imageCount: (event.result?.content ?? []).filter((part) => part.type === 'image').length, details: event.result?.details });
	});
	const started = Date.now();
	const timer = setTimeout(() => { record.timedOut = true; void session.abort(); }, 180_000);
	try {
		await session.prompt(`${prompt}\nThis is a bounded live test: do only these steps, do not ask questions or create additional Agents, then finish.`, { expandPromptTemplates: false });
		assert.ok(!record.timedOut, `${name} timed out`);
		record.final = session.getLastAssistantText();
		record.elapsedMs = Date.now() - started;
		record.stats = session.getSessionStats();
		const last = session.sessionManager.getEntries().filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').at(-1)?.message;
		assert.equal(last?.stopReason, 'stop', `${name}: ${last?.errorMessage ?? last?.stopReason ?? 'no assistant response'}`);
		console.log(`${name}: completed in ${record.elapsedMs} ms`);
		await host.coordinator.stop(host.authority.rootParticipantId, id);
		return record;
	} finally { clearTimeout(timer); unsubscribe(); session.agent.onPayload = originalPayloadHook; writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
}

try {
	writeFileSync(join(base, 'manual.txt'), 'BEFORE\n');
	writeFileSync(join(base, 'seed.txt'), 'SEED_LIVE\n');
	writeFileSync(join(base, 'tile.png'), png());
	host = await StandalonePiHost.open({ base, stateRoot });
	const human = host.authority.rootParticipantId;
	const agent = await host.spawnTopLevel({ name: 'live-gpt-6-luna', agentSpawnEnabled: false });
	const vision = await turn(agent, 'fresh-image-perception', 'Use read exactly once for tile.png. Look at the actual image pixels. Reply only with the dominant color in English. Do not use any other tools.');
	check('native Pi image reaches the real model with intact bytes', () => {
		assert.ok(resultsFor(vision, 'read').some((result) => result.imageCount > 0 && !result.isError));
		assert.ok(vision.requests.some((request) => request.imageHashes.includes(digest(readFileSync(join(base, 'tile.png'))))));
		assert.match(vision.final, /red/i);
	});
	const first = await turn(agent, 'manual-permission', `Use authority and participants. Call get with participant ${human}, resource file:manual.txt. It should be a permission request with pending status. Then call write once on manual.txt with content SHOULD_BE_DENIED. This should fail; do not retry or use Bash to bypass it. Finish with MANUAL_PENDING.`);
	check('manual get requests without transferring authority', () => {
		assert.ok(resultsFor(first, 'get').some((result) => result.details?.status === 'pending'));
		assert.ok(resultsFor(first, 'write').some((result) => result.isError));
		assert.equal(readFileSync(join(base, 'manual.txt'), 'utf8'), 'BEFORE\n');
		assert.equal(canWritePath(host.authority.snapshot(), human, join(base, 'manual.txt')), true);
		assert.equal(canWritePath(host.authority.snapshot(), agent, join(base, 'manual.txt')), false);
	});
	check('participant tree reports held permissions', () => assert.ok(resultsFor(first, 'participants').some((result) => result.text.includes('[held:'))));
	await host.authority.setPermissionMode(human, 'all-of-mine');
	const second = await turn(agent, 'automatic-permission-image-bash-term', `Parent ${human} now uses permission all-of-mine. Use get for file:manual.txt, then write manual.txt with exactly LUNA_LIVE_OK followed by a newline. Read seed.txt and tile.png using read; report the image's dominant color in your final. Try write once on forbidden.txt with content SHOULD_BE_DENIED; expect denial and do not retry. Use bash with command "pwd; cat manual.txt" to check your own root and the saved content. Use get from ${human} for &net:tcp/dns/example.com:443; this grants connection use only. Spawn one Term named live-term with kind term, inheritRead true, resources []. Use exec on that Term with command "pwd; printf 'LUNA_TERM_OK\\n'". Wait for state stopped, then listen to inspect its output. Finally call authority and finish with LIVE_TOOLS_COMPLETE.`);
	check('all-of-mine grants full File and connection-only Net', () => {
		assert.ok(resultsFor(second, 'get').filter((result) => result.details?.status === 'granted').length >= 2);
		assert.equal(readFileSync(join(base, 'manual.txt'), 'utf8'), 'LUNA_LIVE_OK\n');
		assert.equal(host.authority.ownerOf(fileResourceId(join(base, 'manual.txt'))), agent);
		assert.ok(host.authority.effectiveAuthority(agent).netEndpoints.includes('net:tcp/dns/example.com:443'));
		assert.equal(host.authority.ownerOf('net:tcp/dns/example.com:443'), human);
	});
	check('native Pi image survives a multi-tool model run', () => {
		assert.ok(resultsFor(second, 'read').some((result) => result.imageCount > 0 && !result.isError));
		assert.ok(second.requests.some((request) => request.imageHashes.includes(digest(readFileSync(join(base, 'tile.png'))))));
		if (!/red/i.test(second.final)) (report.observations ??= []).push({ name: 'multi-tool image perception', actual: second.final, expected: 'red', note: 'Provider received intact image bytes; this is a model perception mismatch.' });
	});
	check('unauthorized File write remains blocked', () => {
		assert.ok(resultsFor(second, 'write').some((result) => result.isError));
		assert.throws(() => readFileSync(join(base, 'forbidden.txt')));
	});
	check('real Bash and Term use participant roots', () => {
		assert.ok(resultsFor(second, 'bash').some((result) => !result.isError && result.text.includes(base) && result.text.includes('LUNA_LIVE_OK')));
		assert.ok(resultsFor(second, 'listen').some((result) => !result.isError && result.text.includes(base) && result.text.includes('LUNA_TERM_OK')));
	});
	await host.archiveParticipant(agent);
	await host.coordinator.unarchive(human, agent);
	check('unchanged File restore stays quiet while Net restoration is reported', () => {
		const events = host.authority.snapshot().runtimeEvents.filter((event) => event.participantId === agent && event.kind === 'restore');
		assert.ok(events.some((event) => event.text.includes('Net authority restored')));
		assert.ok(events.every((event) => !event.text.includes('Files changed while archived')));
	});
	const beforeIdle = assistantCount(agent);
	await new Promise((resolve) => setTimeout(resolve, 200));
	check('runtime restoration notices do not wake the stopped model', () => assert.equal(assistantCount(agent), beforeIdle));
	writeFileSync(join(base, 'seed.txt'), 'EXTERNAL_SAVED\n');
	const saved = await host.authority.saveExternalChanges(human);
	check('Human save imports external changes', () => assert.ok(saved.includes(fileResourceId(join(base, 'seed.txt')))));
	const third = await turn(agent, 'restored-context', 'Use authority. Read manual.txt and seed.txt, verify LUNA_LIVE_OK and EXTERNAL_SAVED. In the final briefly explain what your restoration notice says about Net connections/publications and finish with RESTORED_CONTEXT_OK. Do not request or change any permissions.');
	check('real model continues with restored authority and saved versions', () => {
		assert.ok(resultsFor(third, 'read').some((result) => result.text.includes('LUNA_LIVE_OK')));
		assert.ok(resultsFor(third, 'read').some((result) => result.text.includes('EXTERNAL_SAVED')));
		assert.match(third.final, /RESTORED_CONTEXT_OK/);
	});
	const fork = await host.coordinator.fork(human, agent, 'live-history-only-fork');
	const forkTurn = await turn(fork, 'history-only-fork', 'This is a fork with copied transcript context and no File/Net resource authority. Use authority, then call read once on manual.txt. Expect denial; do not request permissions or retry. Finish with FORK_DENIED.');
	check('forked real model cannot use historical permissions', () => {
		assert.ok(resultsFor(forkTurn, 'read').some((result) => result.isError));
		assert.deepEqual(host.authority.effectiveAuthority(fork).netEndpoints, []);
		assert.match(forkTurn.final, /FORK_DENIED/);
	});
	const workspaceId = host.manifest.id;
	const beforeReopen = assistantCount(agent);
	await host.dispose(); host = undefined;
	host = await StandalonePiHost.open({ stateRoot, session: workspaceId });
	await host.coordinator.restoreParticipant(agent);
	check('workspace reopen restores rights without replaying model work', () => {
		assert.equal(host.authority.participant(agent).status, 'stopped');
		assert.equal(assistantCount(agent), beforeReopen);
		assert.equal(host.authority.ownerOf(fileResourceId(join(base, 'manual.txt'))), agent);
		assert.equal(readFileSync(join(base, 'manual.txt'), 'utf8'), 'LUNA_LIVE_OK\n');
	});
	report.passed = true;
} catch (error) {
	report.passed = false;
	report.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
	process.exitCode = 1;
	console.error(report.failure.message);
} finally {
	try { await host?.dispose(); } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
	report.finishedAt = new Date().toISOString();
	writeFileSync(reportPath, JSON.stringify(report, null, 2));
	rmSync(agentDir, { recursive: true, force: true });
	console.log(`Live test report: ${reportPath}`);
}
