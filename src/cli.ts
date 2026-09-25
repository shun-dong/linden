#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import type { ResourceId } from "./runtime/model.js";
import { StandalonePiHost, type HumanMessageNotice, type MailboxSummary } from "./pi/host.js";
import { parseParticipantPayloadCommand } from "./pi/human-command.js";
import { participantCoordinator, type SpawnParticipantKind } from "./pi/participant-api.js";
import { formatMaxAgentDepth, normalizeMaxAgentDepth } from "./runtime/agent-depth.js";
import { resolvePublicPath } from "./runtime/paths.js";

export interface LindenCliOptions {
	base?: string;
	session?: string;
	webDomains: string[];
	maxAgentDepth?: number;
}

export interface ParsedSpawn {
	kind: SpawnParticipantKind;
	name?: string;
	grants: string[];
	inheritWorkspaceRead: boolean;
}

export const LINDEN_CLI_HELP = `Linden control plane

ordinary text                 run one sandboxed Bash command as the human
cd [path]                     update the CLI-managed cwd; shell state never persists
:participants                 show Human, Agent, and Term participants and lifecycle states
:authority [participant]      show current Linden authority
:spawn [name] [options]       create a direct child participant (kind defaults to agent)
  --kind <agent|term>          choose an Agent or persistent Term child
  --give <resource-id>         add a typed file:/web: grant (& prefix = read pointer, plain = move ownership)
  --no-cwd-read               opt out of the default current-directory read snapshot
:attach <agent>               attach to a descendant Agent Pi UI
:listen <participant>         observe participant output and lifecycle state
:log <resource-or-participant> show durable File, Agent, or Term history
:wait <participant> [state]   wait for ready (default) or stopped
:interrupt <participant>      interrupt only the participant's own foreground activity
:stop <participant>           recursively stop the participant subtree and background work
:archive <participant>        reclaim and permanently remove a stopped direct-child subtree
:exec <term> <command>        start the raw command tail in a ready persistent Term
:input <term> <data>          write the raw data tail to a running Term's foreground stdin
:inputln <term> [data]        write the raw data tail followed by a newline (or just newline)
:send <participant> <message> send the raw message tail to an allowed participant
:steer <agent> <message>      steer an allowed Agent with the raw message tail
:rewind <agent> <state-id>    rewind a direct-child Agent to a typed state
:give <participant> <resource-id> give typed file:/web: authority (& prefix = read pointer)
:get <participant> <resource-id>  get back authority owned by your own direct child
:mailbox                      list unread summaries without consuming them
:mailbox <number>             consume that sender's unread mail and attach
:mailbox show <number>        consume and print that sender's full unread mail
:resume [number|session-id]   list sessions by recent use or switch while no participant work is active
:help                         show this help
:exit                         save active participants and close the Linden control plane

Active Agent sessions are saved when the control plane exits and restored on the next start.
Up/down arrows recall previous control-plane commands.

Inside an attached Pi UI, /exit returns here without stopping the Agent session.`;

const RAW_PARTICIPANT_COMMANDS = new Set(["exec", "input", "inputln", "send", "steer"]);

export function parseShellWords(value: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of value.trim()) {
		if (escaped) { current += character; escaped = false; continue; }
		if (character === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if (/\s/.test(character)) {
			if (current) { words.push(current); current = ""; }
			continue;
		}
		current += character;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error(`Unterminated ${quote} quote`);
	if (current) words.push(current);
	return words;
}

export function parseSpawn(arguments_: string[]): ParsedSpawn {
	let index = 0;
	let kind: SpawnParticipantKind = "agent";
	let name: string | undefined;
	const grants: ParsedSpawn["grants"] = [];
	let inheritWorkspaceRead = true;
	while (index < arguments_.length) {
		const flag = arguments_[index++];
		if (flag === "--kind") {
			const value = arguments_[index++];
			if (value !== "agent" && value !== "term") throw new Error("--kind must be agent or term");
			kind = value;
			continue;
		}
		if (flag === "--no-cwd-read" || flag === "--no-workspace-read" || flag === "--no-inherit-read") { inheritWorkspaceRead = false; continue; }
		if (flag === "--give") {
			const resource = arguments_[index++];
			if (!resource) throw new Error(`Missing resource after ${flag}`);
			grants.push(resource);
			continue;
		}
		if (flag.startsWith("--")) throw new Error(`Unknown :spawn option ${flag}`);
		if (name !== undefined) throw new Error(`Unexpected :spawn argument ${flag}; only one optional name is allowed`);
		name = flag;
	}
	return { kind, name, grants, inheritWorkspaceRead };
}

export function parseCliOptions(arguments_: string[]): LindenCliOptions | undefined {
	let base: string | undefined;
	let session: string | undefined;
	let webDomains: string[] = [];
	let maxAgentDepth: number | undefined;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--help" || argument === "-h") return undefined;
		if (argument === "--base" || argument === "--workspace") {
			const value = arguments_[++index];
			if (!value) throw new Error("Missing path after --workspace");
			base = resolve(value);
			continue;
		}
		if (argument === "--session") {
			const value = arguments_[++index];
			if (!value) throw new Error("Missing ID after --session");
			session = value;
			continue;
		}
		if (argument === "--web") {
			const value = arguments_[++index];
			if (!value) throw new Error("Missing comma-separated domains after --web");
			webDomains = value.split(",").map((domain) => domain.trim()).filter(Boolean);
			continue;
		}
		if (argument === "--max-agent-depth") {
			const value = arguments_[++index];
			if (!value) throw new Error("Missing positive integer after --max-agent-depth");
			maxAgentDepth = normalizeMaxAgentDepth(Number(value), "--max-agent-depth");
			continue;
		}
		if (!argument.startsWith("--") && index === 0) { base = resolve(argument); continue; }
		throw new Error(`Unknown option ${argument}`);
	}
	return { base, session, webDomains, maxAgentDepth };
}

function readControlLine(prompt: string, history: string[], setActive: (input: Interface | undefined) => void): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true, history });
		let settled = false;
		const finish = (value?: string): void => {
			if (settled) return;
			settled = true;
			setActive(undefined);
			input.close();
			resolvePromise(value);
		};
		input.once("line", finish);
		input.once("close", () => finish());
		input.once("SIGINT", () => finish());
		input.setPrompt(prompt);
		setActive(input);
		input.prompt();
	});
}

function mailboxEntry(entries: MailboxSummary[], reference: string): MailboxSummary {
	const index = Number(reference);
	if (!Number.isInteger(index) || index < 1) throw new Error("Mailbox reference must be a positive list number");
	const entry = entries[index - 1];
	if (!entry) throw new Error(`No unread mailbox entry ${reference}`);
	return entry;
}

export function formatMailbox(entries: MailboxSummary[]): string {
	if (!entries.length) return "Mailbox empty.";
	return entries.map((entry) => {
		const time = entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "unknown time";
		return `${entry.index}. ${entry.senderName}(${entry.senderId}) [${time}] ${entry.preview}`;
	}).join("\n");
}

function formatNotice(host: StandalonePiHost, notice: HumanMessageNotice): string {
	const participant = host.authority.participant(notice.senderId);
	return `[unread from ${participant?.name ?? notice.senderId}(${notice.senderId})] ${notice.preview}`;
}

async function attach(host: StandalonePiHost, reference: string): Promise<void> {
	const target = host.authority.resolveParticipantRef(reference);
	const participant = host.authority.participant(target);
	const label = `${participant?.name ?? target}(${target})`;
	process.stdout.write(`Attaching to ${label}; use /exit to return.\n`);
	const result = await host.attach(target);
	process.stdout.write(`Detached from ${label}.\n`);
	if (result.consumed.length) process.stdout.write(`Consumed ${result.consumed.length} unread message(s) from this session.\n`);
}

async function runHumanBash(host: StandalonePiHost, command: string, cwd: string): Promise<void> {
	const controller = new AbortController();
	const interrupt = (): void => controller.abort();
	process.once("SIGINT", interrupt);
	try {
		const result = await host.authority.bash(host.authority.rootParticipantId, command, {
			cwd,
			signal: controller.signal,
			onData: (data) => process.stdout.write(data),
		});
		for (const notice of result.notices) process.stderr.write(`[Linden sandbox] ${notice}\n`);
		if (result.exitCode && result.exitCode !== 0) process.stderr.write(`[exit ${result.exitCode}]\n`);
	} catch (error) {
		if (controller.signal.aborted) process.stderr.write("[interrupted]\n");
		else throw error;
	} finally {
		process.off("SIGINT", interrupt);
	}
}

export async function runLindenCli(options: LindenCliOptions): Promise<void> {
	const notices: HumanMessageNotice[] = [];
	let activeInput: Interface | undefined;
	let activeHost: StandalonePiHost | undefined;
	const openHost = (session?: string, base: string | null | undefined = options.base, applyConfiguredDepth = false) => StandalonePiHost.open({
		base: base === null ? undefined : base,
		session,
		webDomains: options.webDomains,
		...(applyConfiguredDepth ? { maxAgentDepth: options.maxAgentDepth } : {}),
		onHumanMessage: (notice: HumanMessageNotice) => {
			if (activeHost && activeInput) {
				process.stdout.write(`\n${formatNotice(activeHost, notice)}\n`);
				activeInput.prompt(true);
			} else notices.push(notice);
		},
	});
	let host = await openHost(options.session, options.base, true);
	activeHost = host;
	let cwd = host.authority.workspace;
	const history: string[] = [];
	try {
		process.stdout.write(`Linden session: ${host.manifest.id}\nHuman: ${host.authority.rootParticipantId}\nBase: ${host.authority.base}\nMax Agent depth: ${formatMaxAgentDepth(host.authority.maxAgentDepth)}\n`);
		const restored = [...host.coordinator.runtimes.keys()].filter((participantId) => host.authority.participant(participantId)?.kind === "agent");
		if (restored.length) process.stdout.write(`Restored ${restored.length} active agent session(s) from the previous Linden process.\n`);
		process.stdout.write(`Type :help for commands.\n`);
		while (true) {
			while (notices.length) process.stdout.write(`${formatNotice(host, notices.shift()!)}\n`);
			const line = await readControlLine("linden> ", history, (input) => { activeInput = input; });
			if (line === undefined) break;
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const participantApi = participantCoordinator(host.coordinator);
				const human = host.authority.rootParticipantId;
				if (!trimmed.startsWith(":")) {
					const words = parseShellWords(trimmed);
					if (words[0] === "cd" && words.length <= 2) {
						const candidate = resolvePublicPath(words[1] ?? host.authority.base, cwd, host.authority.base, host.authority.privateRoots);
						host.authority.requireRead(host.authority.rootParticipantId, candidate);
						if (!statSync(candidate).isDirectory()) throw new Error(`Not a directory: ${candidate}`);
						cwd = candidate;
					} else await runHumanBash(host, trimmed, cwd);
					continue;
				}
				const controlSource = line.trimStart().slice(1);
				const raw = parseParticipantPayloadCommand(controlSource);
				const command = raw.action ?? "";
				// Raw-payload commands parse only their action and target. Parsing the
				// whole line here would reject or rewrite data intended for the Term or
				// recipient (for example an unmatched quote sent through :input).
				const arguments_ = RAW_PARTICIPANT_COMMANDS.has(command)
					? (raw.target ? [raw.target] : [])
					: parseShellWords(controlSource).slice(1);
				if (command === "exit" || command === "quit") break;
				if (command === "help") process.stdout.write(`${LINDEN_CLI_HELP}\n`);
				else if (command === "participants") {
					if (arguments_.length) throw new Error("Usage: :participants");
					process.stdout.write(`${await host.coordinator.discoverParticipantTree(host.authority.rootParticipantId)}\n`);
				}
				else if (command === "authority") process.stdout.write(`${host.coordinator.describeAuthority(host.authority.rootParticipantId, arguments_[0] ?? host.authority.rootParticipantId)}\n`);
				else if (command === "spawn") {
					const parsed = parseSpawn(arguments_);
					const child = await participantApi.spawnParticipant(human, {
						kind: parsed.kind,
						name: parsed.name,
						resources: parsed.grants,
						inheritRead: parsed.inheritWorkspaceRead,
						cwd,
					});
					host.recordActiveState();
					if (parsed.kind === "agent") await attach(host, child);
					else process.stdout.write(`Spawned Term ${child}.\n`);
				} else if (command === "resume") {
					const sessions = host.registry.list();
					if (!sessions.length) throw new Error("No Linden sessions are available");
					const listing = sessions.map((session, index) => `${index + 1}. ${new Date(session.lastOpenedAt).toLocaleString()} ${session.id}${session.id === host.manifest.id ? " [current]" : ""}\n   ${session.base}`).join("\n");
					process.stdout.write(`${listing}\n`);
					let reference: string | undefined = arguments_[0];
					if (!reference) reference = (await readControlLine("resume> ", history, (input) => { activeInput = input; }))?.trim();
					if (!reference) continue;
					const numeric = Number(reference);
					const selected = Number.isInteger(numeric) && numeric >= 1 ? sessions[numeric - 1] : host.registry.resolve(reference);
					if (!selected) throw new Error(`No Linden session ${reference}`);
					if (selected.id === host.manifest.id) continue;
					if (!host.isIdle()) throw new Error("Cannot resume another session while a participant, Bash command, or attachment is active");
					const previousId = host.manifest.id;
					await host.saveActiveState();
					await host.dispose();
					activeHost = undefined;
					try { host = await openHost(selected.id, null); }
					catch (error) {
						host = await openHost(previousId, null);
						activeHost = host;
						throw error;
					}
					activeHost = host;
					cwd = host.authority.base;
					process.stdout.write(`Resumed ${host.manifest.id}\nBase: ${host.authority.base}\n`);
				} else if (command === "attach") {
					if (arguments_.length !== 1) throw new Error("Usage: :attach <id-or-unique-session-suffix>");
					await attach(host, arguments_[0]);
				} else if (command === "listen") {
					if (arguments_.length !== 1) throw new Error("Usage: :listen <participant>");
					process.stdout.write(`${await participantApi.listenParticipant(human, arguments_[0])}\n`);
				} else if (command === "log") {
					if (arguments_.length !== 1) throw new Error("Usage: :log <resource-or-participant>");
					process.stdout.write(`${await host.coordinator.formatParticipantLog(human, arguments_[0])}\n`);
				} else if (command === "wait") {
					if (!arguments_[0] || arguments_.length > 2) throw new Error("Usage: :wait <participant> [ready|stopped]");
					const state = arguments_[1] ?? "ready";
					if (state !== "ready" && state !== "stopped") throw new Error("wait state must be ready or stopped");
					const outcome = await participantApi.waitParticipant(human, arguments_[0], state);
					process.stdout.write(outcome.status === "interrupted"
						? `Wait for ${arguments_[0]} was interrupted by incoming message(s): ${outcome.messageIds.join(", ")}. Use :receive.\n`
						: `${arguments_[0]} is ${state}.\n`);
				} else if (command === "interrupt") {
					if (arguments_.length !== 1) throw new Error("Usage: :interrupt <participant>");
					await participantApi.interrupt(human, arguments_[0]);
					process.stdout.write(`Interrupted foreground activity for ${arguments_[0]}.\n`);
				} else if (command === "give") {
					if (arguments_.length !== 2) throw new Error("Usage: :give <participant> <resource>");
					const result = await host.giveTo(arguments_[0], arguments_[1], cwd);
					process.stdout.write(result.mode === "read"
						? `Granted read pointer on ${result.moved.join(", ")} to ${result.targetId}.\n`
						: `Moved ${result.moved.join(", ")} to ${result.targetId}.\n`);
				} else if (command === "get") {
					if (arguments_.length !== 2) throw new Error("Usage: :get <participant> <resource>");
					const resources = await host.getFrom(arguments_[0], arguments_[1] as ResourceId, cwd);
					process.stdout.write(`Got ${resources.join(", ")} back from the participant.\n`);
				} else if (command === "stop") {
					if (arguments_.length !== 1) throw new Error("Usage: :stop <participant>");
					await participantApi.stop(human, arguments_[0]);
					process.stdout.write(`Stopped participant subtree ${arguments_[0]}.\n`);
				} else if (command === "archive") {
					if (arguments_.length !== 1) throw new Error("Usage: :archive <stopped-direct-child>");
					const targetId = host.authority.resolveParticipantRef(arguments_[0]);
					await participantApi.archive(human, targetId);
					host.recordActiveState();
					process.stdout.write(`Archived and removed ${targetId}.\n`);
				} else if (command === "exec") {
					if (!raw.target || !raw.hasPayloadSeparator || !raw.payload) throw new Error("Usage: :exec <term> <command>");
					await participantApi.termExec(human, raw.target, raw.payload);
					process.stdout.write(`Started command in ${raw.target}.\n`);
				} else if (command === "input") {
					if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: :input <term> <data>");
					await participantApi.termInput(human, raw.target, raw.payload);
					process.stdout.write(`Wrote stdin to ${raw.target}.\n`);
				} else if (command === "inputln") {
					if (!raw.target) throw new Error("Usage: :inputln <term> [data]");
					await participantApi.termInput(human, raw.target, `${raw.hasPayloadSeparator ? raw.payload : ""}\n`);
					process.stdout.write(`Wrote stdin line to ${raw.target}.\n`);
				} else if (command === "send") {
					if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: :send <participant> <message>");
					const messageId = await host.coordinator.send(human, raw.target, raw.payload);
					process.stdout.write(`Sent ${messageId}.\n`);
				} else if (command === "steer") {
					if (!raw.target || !raw.hasPayloadSeparator) throw new Error("Usage: :steer <agent> <message>");
					const messageId = await host.coordinator.steer(human, raw.target, raw.payload);
					process.stdout.write(`Steered ${messageId}.\n`);
				} else if (command === "rewind") {
					if (arguments_.length !== 2) throw new Error("Usage: :rewind <agent> <agent-state-id>");
					await host.coordinator.rewind(human, arguments_[0], arguments_[1]);
					process.stdout.write(`Rewound ${arguments_[0]} to ${arguments_[1]}.\n`);
				} else if (command === "mailbox") {
					const entries = host.mailbox();
					if (!arguments_.length) process.stdout.write(`${formatMailbox(entries)}\n`);
					else if (arguments_[0] === "show") {
						if (arguments_.length !== 2) throw new Error("Usage: :mailbox show <number>");
						const entry = mailboxEntry(entries, arguments_[1]);
						const messages = await host.consumeMailbox(entry.senderId);
						process.stdout.write(`${messages.map((message) => `from=${message.senderId} id=${message.id}\n${message.payload}`).join("\n\n") || "Mailbox empty."}\n`);
					} else {
						if (arguments_.length !== 1) throw new Error("Usage: :mailbox [number]");
						await attach(host, mailboxEntry(entries, arguments_[0]).senderId);
					}
				} else throw new Error(`Unknown control command :${command || trimmed.slice(1)}`);
			} catch (error) {
				process.stderr.write(`[Linden] ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	} finally {
		try {
			await host.saveActiveState();
		} catch (error) {
			process.stderr.write(`[Linden] could not save active agents: ${error instanceof Error ? error.message : String(error)}\n`);
		}
		await host.dispose();
	}
}

async function main(): Promise<void> {
	const options = parseCliOptions(process.argv.slice(2));
	if (!options) {
		process.stdout.write(`${LINDEN_CLI_HELP}\n\nUsage: linden [base] [--base <path>] [--session <id>] [--max-agent-depth <positive-integer>]\n`);
		return;
	}
	await runLindenCli(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void main().catch((error) => {
		process.stderr.write(`linden: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
