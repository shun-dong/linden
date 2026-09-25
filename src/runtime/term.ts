import { spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { EffectiveAuthority } from "./model.js";
import {
	DynamicSandbox,
	killGroup,
	type PlaceholderCleanupResult,
} from "./sandbox.js";
import type { BashPlaceholderJournal } from "./store.js";
import { pathExpressionContains } from "./paths.js";

export type TermLifecycle = "running" | "ready" | "stopped";
type InternalPhase =
	| "stopped"
	| "starting"
	| "running"
	| "background"
	| "reconciling"
	| "failed"
	| "disposed";

export interface TermForegroundSnapshot {
	id: string;
	command: string;
	startedAt: string;
}

export interface TermSnapshot {
	id: string;
	lifecycle: TermLifecycle;
	/** True exactly when lifecycle is ready or stopped (stopped is a subtype). */
	ready: boolean;
	reconciling: boolean;
	epochId?: string;
	foreground?: TermForegroundSnapshot;
	backgroundPids: number[];
	/** Evaluator-selected parent-loopback ports, and the subset currently bridged. */
	loopbackPorts?: number[];
	activeLoopbackPorts?: number[];
	outputCursor: number;
	error?: string;
}

export interface TermEpochStartInfo {
	termId: string;
	epochId: string;
	startedAt: string;
}

export interface TermEpochPreparedInfo extends TermEpochStartInfo {
	placeholders: BashPlaceholderJournal[];
}

export interface TermCommandRecord {
	id: string;
	command: string;
	startedAt: string;
	endedAt: string;
	exitCode: number;
	/** Global Term output cursor immediately before this command was launched. */
	outputStart: number;
	/** Global Term output cursor observed at trusted foreground completion. */
	outputEnd: number;
}

export interface TermRetainedOutput {
	/** First global cursor represented by data. */
	start: number;
	/** Exclusive global cursor represented by data. */
	end: number;
	data: string;
	/** True when output from the beginning of this epoch fell out of the bounded buffer. */
	truncatedBefore: boolean;
}

export interface TermEpochEndInfo extends TermEpochStartInfo {
	endedAt: string;
	commands: readonly TermCommandRecord[];
	/** Bounded retained terminal output belonging to this epoch. */
	output: TermRetainedOutput;
	cleanup: PlaceholderCleanupResult;
	forced: boolean;
	error?: string;
}

/**
 * Lets an adapter preserve a post-commit integrity error without asking Term
 * to retry an epoch that the durable manager has already closed.
 */
export interface TermEpochEndOutcome {
	committed: true;
	error?: Error | string;
}

export interface PersistentTermOptions {
	id: string;
	cwd: string;
	privateRoots: readonly string[];
	/**
	 * The start hook may atomically capture/journal/lease and return the exact
	 * authority for this epoch. It runs before placeholder creation.
	 */
	onEpochStart?: (
		info: TermEpochStartInfo,
	) => EffectiveAuthority | void | Promise<EffectiveAuthority | void>;
	/** Fallback used when onEpochStart does not return an authority. */
	getAuthority?: () => EffectiveAuthority | Promise<EffectiveAuthority>;
	/** Convenience fallback for tests and fixed-authority callers. */
	authority?: EffectiveAuthority;
	/** Runs after placeholder identities exist, but before any user command. */
	onEpochPrepared?: (info: TermEpochPreparedInfo) => void | Promise<void>;
	/**
	 * Runs only after all sandbox processes have ended, mounts are gone, and
	 * absent-file placeholders have been inspected/cleaned.
	 */
	onEpochEnd?: (info: TermEpochEndInfo) => void | TermEpochEndOutcome | Promise<void | TermEpochEndOutcome>;
	onStateChange?: (snapshot: TermSnapshot) => void;
	outputLimitBytes?: number;
	quiescencePollMs?: number;
	quiescenceConfirmations?: number;
	/** Grace period before interrupt escalates from SIGINT to foreground SIGKILL. */
	interruptGraceMs?: number;
	/** Explicit evaluator-scoped ports to bridge from the isolated Term namespace. */
	loopbackPorts?: readonly number[];
	/** Optional evaluator-visible directory mounted as this Term's /tmp. */
	sharedTmpPath?: string;
	/**
	 * Absolute override for a trusted, statically linked Linden Term supervisor.
	 * Normal builds resolve the packaged platform binary automatically.
	 */
	supervisorPath?: string;
}

export interface TermExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface TermExecResult {
	termId: string;
	epochId: string;
	commandId: string;
	exitCode: number;
}

export interface TermExecLaunch {
	termId: string;
	epochId: string;
	commandId: string;
	/** Foreground completion; launch itself resolves only after trusted start acknowledgement. */
	completion: Promise<TermExecResult>;
}

export interface TermListenOptions {
	after?: number;
	wait?: boolean;
	signal?: AbortSignal;
	/** Maximum bytes returned by this observation; omitted preserves the full retained range. */
	maxBytes?: number;
}

export interface TermListenResult {
	data: string;
	/** First global output cursor represented by data. */
	start: number;
	/** Exclusive global cursor after the returned data, not after undisclosed buffered data. */
	cursor: number;
	hasMore: boolean;
	state: TermSnapshot;
}

export interface TermWaitOptions {
	timeout?: number;
	signal?: AbortSignal;
}

interface Epoch {
	id: string;
	startedAt: string;
	outputStart: number;
	commands: TermCommandRecord[];
	authority?: EffectiveAuthority;
	cwd?: string;
	leaseAcquired: boolean;
	/** Physical teardown is complete; only the durable epoch-end hook may remain. */
	preparedEnd?: {
		info: TermEpochEndInfo;
		finalError?: Error;
	};
}

interface ActiveCommand {
	id: string;
	command: string;
	startedAt: string;
	outputStart: number;
	resolve: (result: TermExecResult) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	abort?: () => void;
	signal?: AbortSignal;
	abortError?: Error;
	interruptTimer?: NodeJS.Timeout;
	started: Deferred<void>;
	startedConfirmed: boolean;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (error: Error) => void;
}

interface ProcRecord {
	pid: number;
	ppid: number;
	state: string;
}

interface ProtocolRecord {
	type?: unknown;
	marker?: unknown;
	id?: unknown;
	exitCode?: unknown;
	cwd?: unknown;
	env?: unknown;
	message?: unknown;
}

const emptyCleanup = (): PlaceholderCleanupResult => ({ removed: [], violations: [] });
const isoNow = (): string => new Date().toISOString();
const delay = (milliseconds: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const hasCommand = (command: string): boolean => spawnSync("which", [command], { stdio: "ignore" }).status === 0;
const commandPath = (command: string, label: string): string => {
	const result = spawnSync("which", [command], { encoding: "utf8" });
	const candidate = result.status === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
	if (!candidate || !candidate.startsWith("/") || !existsSync(candidate)) throw new Error(`${label} is required for Term`);
	return realpathSync.native(candidate);
};

function termSupervisorPath(explicit?: string): string {
	if (explicit !== undefined && !isAbsolute(explicit)) {
		throw new Error("Term supervisorPath must be absolute");
	}
	const platformDirectory = "linux-" + process.arch;
	const relative = join("native", "term-supervisor", "bin", platformDirectory, "linden-term-supervisor");
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = explicit === undefined
		? [
			// Runtime images mount the helper beside their fixed Node binary so
			// Bubblewrap receives it through the already-visible /usr tree.
			join(dirname(process.execPath), "linden-term-supervisor"),
			resolve(moduleDirectory, "..", "..", relative),
			// TypeScript tests execute from .tmp-test/src/runtime.
			resolve(moduleDirectory, "..", "..", "..", relative),
		]
		: [explicit];
	for (const candidate of candidates) {
		try {
			const canonical = realpathSync.native(candidate);
			if (!statSync(canonical).isFile()) continue;
			accessSync(canonical, constants.X_OK);
			return canonical;
		} catch { /* try the next packaged layout */ }
	}
	throw new Error(
		"Static Linden Term supervisor is required for " + platformDirectory + "; "
		+ "run npm run build:term-supervisor before packaging or pass supervisorPath",
	);
}
const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const MAX_CWD_BYTES = 16 * 1024;
const MAX_ENV_BYTES = 128 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_BYTES = 8 * 1024;

const deniedEnvironmentNames = new Set([
	"BASH_ENV", "ENV", "PATH", "HOME", "SHELL", "IFS", "PWD", "OLDPWD", "SHLVL", "_",
	"SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "PS0", "PS1", "PS2", "PS3", "PS4",
	"CDPATH", "GLOBIGNORE", "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "PYTHONPATH",
	"PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF",
	"SSH_ASKPASS", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE", "EDITOR", "VISUAL",
]);
const deniedEnvironmentPrefixes = [
	"BASH_FUNC_", "LD_", "DYLD_", "LINDEN_", "PYTHON", "PERL", "RUBY", "NODE_",
];

function isSafeEnvironmentName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
		&& !deniedEnvironmentNames.has(name)
		&& !deniedEnvironmentPrefixes.some((prefix) => name.startsWith(prefix));
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}


function readProcTable(): Map<number, ProcRecord> {
	if (process.platform !== "linux") throw new Error("Term process supervision requires Linux /proc");
	const table = new Map<number, ProcRecord>();
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Cannot inspect /proc/${pid}/stat; Term supervision fails closed`, { cause: error });
		}
		const close = stat.lastIndexOf(")");
		if (close < 0) throw new Error(`Malformed /proc/${pid}/stat`);
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		if (fields.length < 2) throw new Error(`Incomplete /proc/${pid}/stat`);
		table.set(pid, {
			pid,
			state: fields[0] ?? "?",
			ppid: Number(fields[1]),
		});
	}
	return table;
}

function descendantRecords(rootPid: number): Map<number, ProcRecord> {
	const table = readProcTable();
	if (!table.has(rootPid)) throw new Error(`Term sandbox process ${rootPid} is no longer visible`);
	const byParent = new Map<number, ProcRecord[]>();
	for (const record of table.values()) {
		const children = byParent.get(record.ppid) ?? [];
		children.push(record);
		byParent.set(record.ppid, children);
	}
	const result = new Map<number, ProcRecord>();
	const pending = [rootPid];
	while (pending.length) {
		const pid = pending.pop()!;
		const record = table.get(pid);
		if (record) result.set(pid, record);
		for (const child of byParent.get(pid) ?? []) pending.push(child.pid);
	}
	return result;
}

function existingDirectory(path: string): string | undefined {
	try {
		if (!existsSync(path) || !statSync(path).isDirectory()) return undefined;
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}

function candidateForInclude(include: string): string | undefined {
	try {
		if (existsSync(include) && statSync(include).isDirectory()) return realpathSync.native(include);
		return existingDirectory(dirname(include));
	} catch {
		return existingDirectory(dirname(include));
	}
}

function decodeBase64(value: unknown, limit: number): Buffer | undefined {
	if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 + 4) return undefined;
	if (value !== "" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
	const result = Buffer.from(value, "base64");
	return result.length <= limit ? result : undefined;
}

/**
 * A persistent logical terminal backed by one bubblewrap sandbox per epoch.
 *
 * One non-dumpable supervisor owns the epoch PTY and the trusted control
 * socket. Each exec runs in a separate foreground Bash process, so completion
 * is an observed waitpid event rather than user-provided shell output. Only a
 * validated cwd and exported environment are retained; shell source is never
 * serialized or evaluated in a later authority epoch.
 */
export class PersistentTerm extends EventEmitter {
	readonly id: string;
	private readonly options: PersistentTermOptions;
	private phase: InternalPhase = "stopped";
	private epoch?: Epoch;
	private sandbox?: DynamicSandbox;
	private child?: ChildProcess;
	private childClose?: Promise<void>;
	private controlServer?: Server;
	private controlSocket?: Socket;
	private controlDirectory?: string;
	private controlPath?: string;
	private controlPeerAccepted = false;
	private expectedClose = false;
	private marker = "";
	private infrastructurePids = new Set<number>();
	private backgroundPids = new Set<number>();
	private current?: ActiveCommand;
	private commandSequence = 0;
	private shellCwd: string;
	private exportedEnvironment: Record<string, string> = Object.create(null) as Record<string, string>;
	private controlBuffer = "";
	private readyResolver?: Deferred<void>;
	private quiescenceTimer?: NodeJS.Timeout;
	private finishPromise?: Promise<void>;
	/** Serializes epoch publication with stop/dispose without covering command runtime. */
	private transitionTail: Promise<void> = Promise.resolve();
	private errorMessage?: string;
	private output = Buffer.alloc(0);
	private outputStart = 0;
	private readonly decoder = new StringDecoder("utf8");
	private scriptPath?: string;
	private supervisorPath?: string;

	constructor(options: PersistentTermOptions) {
		super();
		if (!options.id.startsWith("term:")) throw new Error(`Term id must use the term:<id> form: ${options.id}`);
		if (!options.onEpochStart && !options.getAuthority && !options.authority) {
			throw new Error("PersistentTerm requires onEpochStart, getAuthority, or a fixed authority");
		}
		this.id = options.id;
		this.options = options;
		this.shellCwd = options.cwd;
	}

	async initialize(): Promise<void> {
		if (this.phase === "disposed") throw new Error(`Term ${this.id} is disposed`);
		if (process.platform !== "linux") throw new Error(`Persistent Term requires Linux, got ${process.platform}`);
		if (!hasCommand("bwrap")) throw new Error("bubblewrap (bwrap) is required for Term");
		this.scriptPath = commandPath("script", "util-linux script");
		this.supervisorPath = termSupervisorPath(this.options.supervisorPath);
		this.emitState();
	}

	lifecycle(): TermSnapshot {
		const failed = this.phase === "failed";
		const incompleteFailure = failed && this.epoch !== undefined;
		const lifecycle: TermLifecycle = this.phase === "starting" || this.phase === "running" || this.phase === "reconciling" || incompleteFailure
			? "running"
			: this.phase === "stopped" || this.phase === "disposed" || failed
				? "stopped"
				: "ready";
		const exposure = this.sandbox?.loopbackExposure() ?? { configured: [...(this.options.loopbackPorts ?? [])], active: [] };
		return {
			id: this.id,
			lifecycle,
			// stopped is a subtype of ready. A failed Term is externally stopped
			// only once no sandbox or manager epoch remains to reconcile.
			ready: lifecycle !== "running",
			reconciling: this.phase === "reconciling",
			epochId: this.epoch?.id,
			foreground: this.current?.startedConfirmed ? {
				id: this.current.id,
				command: this.current.command,
				startedAt: this.current.startedAt,
			} : undefined,
			backgroundPids: [...this.backgroundPids].sort((left, right) => left - right),
			loopbackPorts: exposure.configured,
			activeLoopbackPorts: exposure.active,
			outputCursor: this.outputStart + this.output.length,
			error: this.errorMessage,
		};
	}

	async exec(command: string, options: TermExecOptions = {}): Promise<TermExecResult> {
		const launched = await this.startExec(command, options);
		return launched.completion;
	}

	async startExec(command: string, options: TermExecOptions = {}): Promise<TermExecLaunch> {
		const launched = await this.withTransition(async () => {
			this.assertUsable();
			if (this.phase !== "stopped" && this.phase !== "background") {
				throw new Error(`Term exec requires ready state; ${this.id} is ${this.phase}`);
			}
			if (command.includes("\0")) throw new Error("Term command contains a NUL byte");
			if (options.signal?.aborted) throw new Error("Term exec aborted");
			if (!this.epoch) {
				this.phase = "starting";
				this.emitState();
				try {
					await this.startEpoch();
				} catch (error) {
					await this.failStartedEpoch(error);
					throw error;
				}
			}
			this.stopQuiescenceWatcher();
			const epoch = this.epoch!;
			const id = `command:${++this.commandSequence}`;
			const startedAt = isoNow();
			const outputStart = this.outputCursor();
			this.phase = "starting";
			this.errorMessage = undefined;
			let active!: ActiveCommand;
			const completion = new Promise<TermExecResult>((resolvePromise, reject) => {
				active = {
					id, command, startedAt, outputStart, resolve: resolvePromise, reject, signal: options.signal,
					started: deferred<void>(), startedConfirmed: false,
				};
				if (options.timeout !== undefined && options.timeout > 0) {
					active.timer = setTimeout(() => {
						active.abortError = new Error(`Term exec timeout:${options.timeout}`);
						void this.interrupt().catch((interruptError) => this.queueRuntimeFailure(interruptError));
					}, options.timeout * 1000);
				}
				if (options.signal) {
					active.abort = () => {
						active.abortError = new Error("Term exec aborted");
						void this.interrupt().catch((interruptError) => this.queueRuntimeFailure(interruptError));
					};
					options.signal.addEventListener("abort", active.abort, { once: true });
				}
				this.current = active;
			});
			// startExec can reject before returning the completion handle. Keep the
			// internal completion rejection observed while preserving it for callers.
			void completion.catch(() => undefined);
			this.emitState();
			try {
				this.writeProtocol({
					type: "exec",
					marker: this.marker,
					id,
					command: Buffer.from(command).toString("base64"),
					cwd: this.shellCwd,
					env: this.exportedEnvironment,
				});
				await Promise.race([
					active.started.promise,
					delay(5_000).then(() => { throw new Error("Term supervisor did not acknowledge foreground start"); }),
				]);
			} catch (error) {
				const current = this.current;
				if (current === active) {
					this.current = undefined;
					this.clearActiveCommand(current);
					current.reject(error as Error);
				}
				await this.failRuntime(error);
				throw error;
			}
			this.emit("control", { type: "exec", termId: this.id, epochId: epoch.id, commandId: id });
			return { termId: this.id, epochId: epoch.id, commandId: id, completion };
		});
		return launched;
	}

	assertInputReady(): void {
		this.assertUsable();
		if (this.phase !== "running" || !this.current?.startedConfirmed) {
			throw new Error(`Term input requires running state with a started foreground; ${this.id} is ${this.phase}`);
		}
	}

	async waitForInputReady(): Promise<void> {
		this.assertUsable();
		if (this.phase === "running" && this.current?.startedConfirmed) return;
		if (this.phase !== "starting") this.assertInputReady();
		await new Promise<void>((resolvePromise, reject) => {
			const onState = () => {
				if (this.phase === "running" && this.current?.startedConfirmed) { cleanup(); resolvePromise(); return; }
				if (this.phase !== "starting") {
					cleanup();
					reject(new Error(this.errorMessage ?? `Term input requires running state with a started foreground; ${this.id} is ${this.phase}`));
				}
			};
			const cleanup = () => this.off("state", onState);
			this.on("state", onState);
			onState();
		});
	}

	async input(data: string | Buffer): Promise<void> {
		this.assertInputReady();
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Term PTY input is unavailable");
		await new Promise<void>((resolvePromise, reject) => {
			let settled = false;
			const finish = (error?: Error | null) => {
				if (settled) return;
				settled = true;
				stdin.off("error", onError);
				if (error) reject(error);
				else resolvePromise();
			};
			const onError = (error: Error) => finish(error);
			stdin.once("error", onError);
			try { stdin.write(data, (error) => finish(error)); }
			catch (error) { finish(error as Error); }
		});
	}

	async interrupt(): Promise<void> {
		await this.withTransition(() => {
			this.assertUsable();
			if (this.phase !== "running" || !this.current) throw new Error(`Term interrupt requires running state; ${this.id} is ${this.phase}`);
			const active = this.current;
			this.writeProtocol({ type: "interrupt", marker: this.marker, id: active.id });
			this.emit("control", { type: "interrupt", termId: this.id, commandId: active.id });
			if (!active.interruptTimer) {
				const grace = Math.max(10, this.options.interruptGraceMs ?? 1_000);
				active.interruptTimer = setTimeout(() => {
					void this.withTransition(async () => {
						if (this.phase !== "running" || this.current !== active) return;
						try {
							this.writeProtocol({ type: "kill", marker: this.marker, id: active.id });
							this.emit("control", { type: "kill", termId: this.id, commandId: active.id });
						} catch (error) {
							await this.failRuntime(error);
						}
					}).catch(() => undefined);
				}, grace);
			}
		});
	}

	async stopAll(): Promise<void> {
		await this.withTransition(() => this.stopAllUnlocked());
	}

	private async stopAllUnlocked(): Promise<void> {
		if (this.phase === "disposed") throw new Error(`Term ${this.id} is disposed`);
		if (!this.epoch) return;
		this.stopQuiescenceWatcher();
		const stoppedError = new Error(`Term ${this.id} was stopped`);
		if (this.current) {
			this.clearActiveCommand(this.current);
			this.current.reject(stoppedError);
			this.current = undefined;
		}
		await this.finishEpoch(true, stoppedError, false);
	}

	async listen(options: TermListenOptions = {}): Promise<TermListenResult> {
		const after = options.after ?? this.outputStart;
		if (!Number.isInteger(after) || after < 0) throw new Error(`Invalid Term output cursor: ${after}`);
		if (after < this.outputStart) throw new Error(`Term output before cursor ${this.outputStart} has been truncated`);
		const end = this.outputStart + this.output.length;
		if (after < end || !options.wait || this.lifecycle().lifecycle === "stopped") return this.listenResult(after, options.maxBytes);
		if (options.signal?.aborted) throw new Error("Term listen aborted");
		await new Promise<void>((resolvePromise, reject) => {
			const onActivity = () => { cleanup(); resolvePromise(); };
			const onAbort = () => { cleanup(); reject(new Error("Term listen aborted")); };
			const cleanup = () => {
				this.off("output", onActivity);
				this.off("state", onActivity);
				options.signal?.removeEventListener("abort", onAbort);
			};
			this.once("output", onActivity);
			this.once("state", onActivity);
			options.signal?.addEventListener("abort", onAbort, { once: true });
		});
		return this.listenResult(after, options.maxBytes);
	}

	async waitFor(target: "ready" | "stopped", options: TermWaitOptions = {}): Promise<TermSnapshot> {
		if (this.phase === "failed") throw new Error(this.errorMessage ?? `Term ${this.id} failed`);
		const satisfies = () => {
			const snapshot = this.lifecycle();
			return target === "ready" ? snapshot.ready : snapshot.lifecycle === "stopped";
		};
		if (satisfies()) return this.lifecycle();
		if (options.signal?.aborted) throw new Error("Term wait aborted");
		return new Promise<TermSnapshot>((resolvePromise, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const onState = () => {
				if (this.phase === "failed") { cleanup(); reject(new Error(this.errorMessage ?? `Term ${this.id} failed`)); return; }
				if (satisfies()) { cleanup(); resolvePromise(this.lifecycle()); }
			};
			const onAbort = () => { cleanup(); reject(new Error("Term wait aborted")); };
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.off("state", onState);
				options.signal?.removeEventListener("abort", onAbort);
			};
			this.on("state", onState);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeout !== undefined && options.timeout > 0) {
				timer = setTimeout(() => { cleanup(); reject(new Error(`Term wait timeout:${options.timeout}`)); }, options.timeout * 1000);
			}
		});
	}

	async dispose(): Promise<void> {
		await this.withTransition(async () => {
			if (this.phase === "disposed") return;
			if (this.epoch) await this.stopAllUnlocked();
			this.phase = "disposed";
			this.emitState();
			this.removeAllListeners();
		});
	}

	private async withTransition<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.transitionTail;
		let release!: () => void;
		this.transitionTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try { return await operation(); }
		finally { release(); }
	}

	private assertUsable(): void {
		if (this.phase === "disposed") throw new Error(`Term ${this.id} is disposed`);
		if (this.phase === "failed") throw new Error(this.errorMessage ?? `Term ${this.id} failed`);
	}

	private async startEpoch(): Promise<void> {
		const epoch: Epoch = {
			id: `epoch:${this.id.slice(5)}:${randomUUID()}`,
			startedAt: isoNow(),
			outputStart: this.outputCursor(),
			commands: [],
			leaseAcquired: false,
		};
		this.epoch = epoch;
		const startInfo: TermEpochStartInfo = { termId: this.id, epochId: epoch.id, startedAt: epoch.startedAt };
		let authority: EffectiveAuthority | undefined;
		if (this.options.onEpochStart) {
			const hookedAuthority = await this.options.onEpochStart(startInfo);
			if (hookedAuthority) authority = hookedAuthority;
			epoch.leaseAcquired = true;
		}
		authority ??= await this.options.getAuthority?.() ?? this.options.authority;
		if (!authority) throw new Error("Term epoch start did not provide authority");
		if (!this.options.onEpochStart) epoch.leaseAcquired = true;
		epoch.authority = authority;
		const epochCwd = this.selectEpochCwd(authority);
		epoch.cwd = epochCwd;
		this.shellCwd = epochCwd;
		const cwdIsDirectlyAuthorized = authority.readExpressions.some((expression) => pathExpressionContains(expression, epochCwd));
		const sandboxAuthority = cwdIsDirectlyAuthorized ? authority : {
			...authority,
			// Exact-File authority still needs its otherwise-empty structural parent
			// as cwd. readPaths remain unchanged, so this does not mount siblings.
			readExpressions: [...authority.readExpressions, { include: epochCwd, exclude: [] }],
		};
		this.sandbox = new DynamicSandbox(epochCwd, sandboxAuthority, [...this.options.privateRoots], this.options.loopbackPorts ?? [], this.supervisorPath, this.options.sharedTmpPath);
		await this.sandbox.initialize();
		await this.options.onEpochPrepared?.({
			...startInfo,
			placeholders: this.sandbox.placeholderJournal(),
		});
		await this.startSupervisor(epochCwd);
		this.phase = "background";
		this.emitState();
	}

	private selectEpochCwd(authority: EffectiveAuthority): string {
		for (const preferred of [this.shellCwd, this.options.cwd]) {
			const directory = existingDirectory(preferred);
			if (directory && authority.readExpressions.some((expression) => pathExpressionContains(expression, directory))) return directory;
		}
		for (const expression of authority.readExpressions) {
			if (!pathExpressionContains(expression, expression.include)) continue;
			const candidate = candidateForInclude(expression.include);
			if (candidate) return candidate;
		}
		for (const readablePath of authority.readPaths) {
			const candidate = candidateForInclude(readablePath);
			if (candidate) return candidate;
		}
		throw new Error(`Term ${this.id} has no authorized readable directory usable as cwd`);
	}

	private async startSupervisor(cwd: string): Promise<void> {
		if (!this.supervisorPath || !this.scriptPath) throw new Error("Term runtime commands were not initialized");
		this.marker = randomUUID();
		const controlPath = await this.openControlServer();
		const inner = ["exec", shellQuote(this.supervisorPath), shellQuote(controlPath), shellQuote(this.marker)].join(" ");
		const command = `exec ${shellQuote(this.scriptPath)} -qefc ${shellQuote(inner)} /dev/null`;
		this.readyResolver = deferred<void>();
		this.child = this.sandbox!.spawnProcess(command, cwd, {
			controlSockets: [controlPath],
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.expectedClose = false;
		const child = this.child;
		const stdout = child.stdout;
		const stderr = child.stderr;
		if (!stdout || !stderr || !child.stdin) throw new Error("Term supervisor pipes are unavailable");
		stdout.on("data", (data: Buffer) => this.appendOutput(data));
		stderr.on("data", (data: Buffer) => this.appendOutput(data));
		child.stdin.on("error", (error) => this.queueRuntimeFailure(error));
		child.once("error", (error) => this.queueRuntimeFailure(error));
		this.childClose = new Promise<void>((resolvePromise) => {
			child.once("close", () => {
				resolvePromise();
				if (!this.expectedClose) void this.handleUnexpectedClose();
			});
		});
		await Promise.race([
			this.readyResolver.promise,
			delay(5_000).then(() => { throw new Error("Term supervisor did not report ready"); }),
		]);
		this.infrastructurePids = new Set(descendantRecords(child.pid!).keys());
	}

	private consumeControl(data: Buffer): void {
		this.controlBuffer += data.toString("utf8");
		if (this.controlBuffer.length > MAX_CONTROL_BYTES) {
			this.queueRuntimeFailure(new Error("Term control record exceeded 8 MiB"));
			return;
		}
		let newline: number;
		while ((newline = this.controlBuffer.indexOf("\n")) >= 0) {
			const line = this.controlBuffer.slice(0, newline);
			this.controlBuffer = this.controlBuffer.slice(newline + 1);
			this.consumeControlLine(line);
		}
	}

	private consumeControlLine(line: string): void {
		let record: ProtocolRecord;
		try {
			record = JSON.parse(line) as ProtocolRecord;
		} catch (error) {
			this.queueRuntimeFailure(new Error("Malformed trusted Term control record", { cause: error }));
			return;
		}
		if (record.marker !== this.marker) {
			this.queueRuntimeFailure(new Error("Term supervisor control marker mismatch"));
			return;
		}
		if (record.type === "ready") {
			this.readyResolver?.resolve();
			this.readyResolver = undefined;
			return;
		}
		if (record.type === "started") {
			if (!this.current || record.id !== this.current.id || this.current.startedConfirmed) {
				this.queueRuntimeFailure(new Error(`Term start acknowledgement does not name the pending foreground: ${String(record.id)}`));
				return;
			}
			this.current.startedConfirmed = true;
			this.phase = "running";
			this.emitState();
			this.current.started.resolve();
			return;
		}
		if (record.type === "fatal") {
			this.queueRuntimeFailure(new Error(`Term supervisor failed: ${typeof record.message === "string" ? record.message : "unknown error"}`));
			return;
		}
		if (record.type !== "done") {
			this.queueRuntimeFailure(new Error(`Unknown trusted Term control record: ${String(record.type)}`));
			return;
		}
		if (!this.current || record.id !== this.current.id) {
			this.queueRuntimeFailure(new Error(`Term completion does not name the active command: ${String(record.id)}`));
			return;
		}
		if (!Number.isInteger(record.exitCode) || (record.exitCode as number) < 0 || (record.exitCode as number) > 255) {
			this.queueRuntimeFailure(new Error(`Invalid Term exit code: ${String(record.exitCode)}`));
			return;
		}
		this.acceptPersistentState(record.cwd, record.env);
		void this.completeForeground(record.exitCode as number);
	}

	private acceptPersistentState(encodedCwd: unknown, encodedEnvironment: unknown): void {
		const epoch = this.epoch;
		if (!epoch?.authority || !epoch.cwd) return;
		const cwdData = decodeBase64(encodedCwd, MAX_CWD_BYTES);
		if (cwdData?.length) {
			try {
				let cwd = new TextDecoder("utf-8", { fatal: true }).decode(cwdData);
				if (cwd.endsWith("\n")) cwd = cwd.slice(0, -1);
				if (cwd && !cwd.includes("\n") && !cwd.includes("\0")) {
					const canonical = existingDirectory(cwd);
					if (canonical && (canonical === epoch.cwd || epoch.authority.readExpressions.some((expression) => pathExpressionContains(expression, canonical)))) {
						this.shellCwd = canonical;
					}
				}
			} catch { /* adversarial state is ignored */ }
		}
		const environmentData = decodeBase64(encodedEnvironment, MAX_ENV_BYTES);
		if (!environmentData?.length || environmentData[environmentData.length - 1] !== 0) return;
		try {
			const parsed: Record<string, string> = Object.create(null) as Record<string, string>;
			const entries = environmentData.subarray(0, -1).toString("binary").split("\0");
			if (entries.length > MAX_ENV_ENTRIES) return;
			const decoder = new TextDecoder("utf-8", { fatal: true });
			for (const binaryEntry of entries) {
				const entry = decoder.decode(Buffer.from(binaryEntry, "binary"));
				const separator = entry.indexOf("=");
				if (separator <= 0) continue;
				const name = entry.slice(0, separator);
				const value = entry.slice(separator + 1);
				if (!isSafeEnvironmentName(name) || Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) continue;
				parsed[name] = value;
			}
			this.exportedEnvironment = parsed;
		} catch { /* invalid UTF-8 or malformed state is ignored as a unit */ }
	}

	private async completeForeground(exitCode: number): Promise<void> {
		const active = this.current;
		const epoch = this.epoch;
		if (!active || !epoch) return;
		this.current = undefined;
		this.clearActiveCommand(active);
		const record: TermCommandRecord = {
			id: active.id,
			command: active.command,
			startedAt: active.startedAt,
			endedAt: isoNow(),
			exitCode,
			outputStart: active.outputStart,
			outputEnd: this.outputCursor(),
		};
		epoch.commands.push(record);
		let workloads: Set<number>;
		try {
			workloads = this.scanWorkloadPids();
		} catch (error) {
			active.reject(error as Error);
			await this.failRuntime(error);
			return;
		}
		this.backgroundPids = workloads;
		const result: TermExecResult = {
			termId: this.id,
			epochId: epoch.id,
			commandId: active.id,
			exitCode,
		};
		if (workloads.size) {
			this.phase = "background";
			this.emitState();
			this.startQuiescenceWatcher();
			if (active.abortError) active.reject(active.abortError);
			else active.resolve(result);
			return;
		}
		try {
			await this.finishEpoch(false);
			if (active.abortError) active.reject(active.abortError);
			else active.resolve(result);
		} catch (error) {
			active.reject(error as Error);
		}
	}

	private scanWorkloadPids(): Set<number> {
		const root = this.child?.pid;
		if (!root) throw new Error("Term sandbox process is unavailable");
		const records = descendantRecords(root);
		const workload = new Set<number>();
		for (const [pid, record] of records) {
			if (!this.infrastructurePids.has(pid) && record.state !== "Z") workload.add(pid);
		}
		return workload;
	}

	private startQuiescenceWatcher(): void {
		this.stopQuiescenceWatcher();
		const interval = Math.max(10, this.options.quiescencePollMs ?? 50);
		const required = Math.max(1, this.options.quiescenceConfirmations ?? 2);
		let emptyScans = 0;
		const poll = async () => {
			if (this.phase !== "background" || !this.epoch) return;
			try {
				this.backgroundPids = this.scanWorkloadPids();
				if (this.backgroundPids.size) emptyScans = 0;
				else emptyScans += 1;
				this.emitState();
				if (emptyScans >= required) {
					await this.finishEpoch(false);
					return;
				}
				this.quiescenceTimer = setTimeout(() => void poll(), interval);
			} catch (error) {
				await this.failRuntime(error);
			}
		};
		this.quiescenceTimer = setTimeout(() => void poll(), interval);
	}

	private stopQuiescenceWatcher(): void {
		if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
		this.quiescenceTimer = undefined;
	}

	private async finishEpoch(forced: boolean, cause?: Error, fatal = false): Promise<void> {
		if (!this.epoch) return;
		if (this.finishPromise) return this.finishPromise;
		this.finishPromise = this.doFinishEpoch(forced, cause, fatal).finally(() => { this.finishPromise = undefined; });
		return this.finishPromise;
	}

	private async doFinishEpoch(forced: boolean, cause?: Error, fatal = false): Promise<void> {
		const epoch = this.epoch!;
		this.phase = "reconciling";
		this.backgroundPids.clear();
		this.emitState();
		this.stopQuiescenceWatcher();
		if (!epoch.preparedEnd) {
			let cleanup = emptyCleanup();
			try {
				await this.closeSandbox();
			} catch (error) {
				// The child/epoch are deliberately retained by closeSandbox on a
				// termination timeout. Do not reconcile files or close the manager
				// epoch while the sandbox may still be able to mutate them.
				const failure = error as Error;
				this.phase = "failed";
				this.errorMessage = failure.message;
				this.emitState();
				throw failure;
			}
			let teardownError: Error | undefined;
			try { cleanup = this.sandbox?.cleanupPlaceholders() ?? emptyCleanup(); }
			catch (error) { teardownError = error as Error; }
			this.sandbox = undefined;
			const outputEnd = this.outputCursor();
			const outputStart = Math.max(epoch.outputStart, this.outputStart);
			epoch.preparedEnd = {
				info: {
					termId: this.id,
					epochId: epoch.id,
					startedAt: epoch.startedAt,
					endedAt: isoNow(),
					commands: [...epoch.commands],
					output: {
						start: outputStart,
						end: outputEnd,
						data: this.output.subarray(outputStart - this.outputStart).toString("utf8"),
						truncatedBefore: epoch.outputStart < outputStart,
					},
					cleanup,
					forced,
					error: (cause ?? teardownError)?.message,
				},
				finalError: teardownError ?? (fatal ? cause : undefined),
			};
		}
		const prepared = epoch.preparedEnd;
		let outcome: void | TermEpochEndOutcome = undefined;
		if (epoch.leaseAcquired) {
			try {
				outcome = await this.options.onEpochEnd?.(prepared.info);
			} catch (error) {
				// Retain the exact prepared end record. A later stop/dispose retries
				// only the durable hook, never sandbox teardown or file cleanup.
				const failure = error as Error;
				this.phase = "failed";
				this.errorMessage = failure.message;
				this.emitState();
				throw failure;
			}
		}
		this.epoch = undefined;
		const committedError = outcome?.error instanceof Error
			? outcome.error
			: typeof outcome?.error === "string" ? new Error(outcome.error) : undefined;
		const finalError = committedError ?? prepared.finalError;
		if (finalError) {
			this.phase = "failed";
			this.errorMessage = finalError.message;
			this.emitState();
			throw finalError;
		}
		this.phase = "stopped";
		this.errorMessage = undefined;
		this.emitState();
	}

	private async closeSandbox(): Promise<void> {
		const child = this.child;
		this.expectedClose = true;
		if (child && child.exitCode === null && child.signalCode === null) {
			killGroup(child);
			// Do not clear the child or trusted control resources on timeout: a
			// later stop/dispose must be able to retry and must not report success.
			await Promise.race([
				this.childClose ?? once(child, "close").then(() => undefined),
				delay(5_000).then(() => { throw new Error("Term sandbox did not terminate"); }),
			]);
		}
		let failure: Error | undefined;
		this.child = undefined;
		this.childClose = undefined;
		this.infrastructurePids.clear();
		this.controlBuffer = "";
		try { await this.closeControlServer(); }
		catch (error) { failure = error as Error; }
		try { await this.sandbox?.shutdown(); }
		catch (error) { failure ??= error as Error; }
		if (failure) throw failure;
	}

	private async openControlServer(): Promise<string> {
		this.controlDirectory = mkdtempSync("/tmp/linden-term-control-");
		this.controlPath = join(this.controlDirectory, "events.sock");
		this.controlPeerAccepted = false;
		const server = createServer((socket) => {
			if (this.controlPeerAccepted) {
				socket.destroy();
				return;
			}
			this.controlPeerAccepted = true;
			this.controlSocket = socket;
			socket.on("data", (data: Buffer) => this.consumeControl(data));
			socket.on("error", (error) => {
				if (this.controlSocket === socket && !this.expectedClose) this.queueRuntimeFailure(error);
			});
			socket.once("close", () => {
				const wasCurrent = this.controlSocket === socket;
				if (wasCurrent) this.controlSocket = undefined;
				if (wasCurrent && !this.expectedClose && this.epoch) this.queueRuntimeFailure(new Error("Term supervisor control channel closed unexpectedly"));
			});
		});
		this.controlServer = server;
		server.on("error", (error) => {
			if (!this.expectedClose) this.queueRuntimeFailure(error);
		});
		await new Promise<void>((resolvePromise, reject) => {
			const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
			const onListening = () => { server.off("error", onError); resolvePromise(); };
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.controlPath);
		});
		chmodSync(this.controlPath, 0o600);
		return this.controlPath;
	}

	private async closeControlServer(): Promise<void> {
		let failure: Error | undefined;
		const socket = this.controlSocket;
		const server = this.controlServer;
		const directory = this.controlDirectory;
		this.controlSocket = undefined;
		this.controlServer = undefined;
		this.controlDirectory = undefined;
		this.controlPath = undefined;
		try { socket?.destroy(); }
		catch (error) { failure = error as Error; }
		try {
			if (server?.listening) {
				await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
			}
		} catch (error) {
			failure ??= error as Error;
		} finally {
			try { if (directory) rmSync(directory, { recursive: true, force: true }); }
			catch (error) { failure ??= error as Error; }
		}
		if (failure) throw failure;
	}

	private async failStartedEpoch(error: unknown): Promise<void> {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!this.epoch) {
			this.phase = "failed";
			this.errorMessage = failure.message;
			this.emitState();
			return;
		}
		try { await this.finishEpoch(true, failure, true); }
		catch { /* finishEpoch has preserved the failure */ }
	}

	private async failRuntime(error: unknown): Promise<void> {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (this.phase === "failed" || this.phase === "disposed") return;
		if (this.current) {
			const active = this.current;
			this.current = undefined;
			this.clearActiveCommand(active);
			active.reject(failure);
		}
		if (this.epoch) {
			try { await this.finishEpoch(true, failure, true); }
			catch { /* state already records reconciliation/teardown failure */ }
		} else {
			this.phase = "failed";
			this.errorMessage = failure.message;
			this.emitState();
		}
	}

	private queueRuntimeFailure(error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (this.current && !this.current.startedConfirmed) this.current.started.reject(failure);
		void this.withTransition(() => this.failRuntime(failure)).catch(() => undefined);
	}

	private async handleUnexpectedClose(): Promise<void> {
		if (this.phase === "disposed" || this.phase === "reconciling" || this.phase === "failed") return;
		this.queueRuntimeFailure(new Error(`Term sandbox exited unexpectedly: ${this.id}`));
	}

	private writeProtocol(record: Record<string, unknown>): void {
		const socket = this.controlSocket;
		if (!socket || socket.destroyed || !socket.writable) throw new Error("Term supervisor control channel is unavailable");
		const serialized = JSON.stringify(record) + "\n";
		if (Buffer.byteLength(serialized) > MAX_CONTROL_BYTES) throw new Error("Term control record exceeded 8 MiB");
		socket.write(serialized);
	}

	private appendOutput(data: Buffer): void {
		const decoded = this.decoder.write(data);
		if (!decoded) return;
		const bytes = Buffer.from(decoded, "utf8");
		this.output = Buffer.concat([this.output, bytes]);
		const limit = Math.max(1_024, this.options.outputLimitBytes ?? 4 * 1024 * 1024);
		if (this.output.length > limit) {
			const remove = this.output.length - limit;
			this.output = this.output.subarray(remove);
			this.outputStart += remove;
		}
		this.emit("output", { termId: this.id, cursor: this.outputStart + this.output.length });
	}

	private outputCursor(): number {
		return this.outputStart + this.output.length;
	}

	private listenResult(after: number, maxBytes?: number): TermListenResult {
		const offset = Math.min(this.output.length, Math.max(0, after - this.outputStart));
		if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error(`Invalid Term listen byte limit: ${maxBytes}`);
		let end = maxBytes === undefined ? this.output.length : Math.min(this.output.length, offset + maxBytes);
		// The retained buffer contains valid UTF-8. Do not end a page inside a
		// continuation sequence, otherwise paging could corrupt terminal text.
		while (end > offset && end < this.output.length && (this.output[end] & 0xc0) === 0x80) end--;
		return {
			data: this.output.subarray(offset, end).toString("utf8"),
			start: this.outputStart + offset,
			cursor: this.outputStart + end,
			hasMore: end < this.output.length,
			state: this.lifecycle(),
		};
	}

	private clearActiveCommand(active: ActiveCommand): void {
		if (active.timer) clearTimeout(active.timer);
		if (active.interruptTimer) clearTimeout(active.interruptTimer);
		if (active.abort) active.signal?.removeEventListener("abort", active.abort);
	}

	private emitState(): void {
		const snapshot = this.lifecycle();
		this.emit("state", snapshot);
		this.options.onStateChange?.(snapshot);
	}
}
