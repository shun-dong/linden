import { NetGuard } from "./net-guard.js";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { EffectiveAuthority } from "./model.js";
import { isInside, pathExpressionContains } from "./paths.js";
import { NetworkBridge, type NetworkGuard } from "./network-bridge.js";
import { DomainGuard, LoopbackExposureBridge } from "./compat/network.js";
import type { BashPlaceholderIdentity, BashPlaceholderJournal } from "./store.js";
import { BUBBLEWRAP_ISOLATION_ARGS, requireBubblewrap, requireRuntimeCommand } from "./capabilities.js";

export interface SandboxRunOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

export interface SandboxSpawnOptions {
	/** Host Unix sockets mounted at the same private /tmp path in the sandbox. */
	controlSockets?: string[];
	stdio?: StdioOptions;
}

export interface PlaceholderViolation {
	path: string;
	reason: string;
}

export interface PlaceholderCleanupResult {
	removed: string[];
	violations: PlaceholderViolation[];
}

function identityOfDescriptor(descriptor: number, path: string): BashPlaceholderIdentity {
	const stat = fstatSync(descriptor, { bigint: true });
	if (!stat.isFile()) throw new Error(`Absent write exclusion is not a regular file placeholder: ${path}`);
	return {
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		ctimeNs: stat.ctimeNs.toString(),
		mode: Number(stat.mode & 0o777n),
		links: stat.nlink.toString(),
	};
}

export function cleanupAbsentWritePlaceholders(records: BashPlaceholderJournal[]): PlaceholderCleanupResult {
	const removed: string[] = [];
	const violations: PlaceholderViolation[] = [];
	for (const record of records) {
		let stat;
		try { stat = lstatSync(record.path, { bigint: true }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (record.identity) violations.push({ path: record.path, reason: "placeholder disappeared while Bash was running" });
				continue;
			}
			violations.push({ path: record.path, reason: `cannot inspect placeholder: ${String(error)}` });
			continue;
		}
		const identity = record.identity;
		const unchanged = identity !== undefined
			&& stat.isFile()
			&& stat.dev.toString() === identity.device
			&& stat.ino.toString() === identity.inode
			&& stat.ctimeNs.toString() === identity.ctimeNs
			&& Number(stat.mode & 0o777n) === identity.mode
			&& stat.nlink.toString() === identity.links
			&& stat.size === 0n;
		if (!unchanged) {
			violations.push({ path: record.path, reason: "placeholder was replaced, modified, or made non-empty; retained on disk" });
			continue;
		}
		try { rmSync(record.path); removed.push(record.path); }
		catch (error) { violations.push({ path: record.path, reason: `cannot remove unchanged placeholder: ${String(error)}` }); }
	}
	return { removed, violations };
}
const systemRuntimeRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const systemRuntimeFiles = ["/etc/ld.so.cache", "/etc/ca-certificates.conf"];
const certificateRoots = ["/etc/ssl", "/etc/pki"];
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
function sandboxEnvironment(): NodeJS.ProcessEnv {
	const runtimeBin = dirname(process.execPath);
	const environment: NodeJS.ProcessEnv = {
		HOME: "/tmp/linden-home",
		LANG: process.env.LANG ?? "C.UTF-8",
		PATH: `${runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
	};
	for (const name of ["LC_ALL", "LC_CTYPE", "COLORTERM", "TERM", "TZ"]) if (process.env[name]) environment[name] = process.env[name];
	return environment;
}

function killGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* process already ended */ } }
}

function ancestorDirs(path: string): string[] {
	const result: string[] = [];
	let cursor = dirname(path);
	const root = parse(path).root;
	while (cursor !== root) { result.unshift(cursor); cursor = dirname(cursor); }
	return result;
}

export class DynamicSandbox {
	private bubblewrapPath?: string;
	private identityDirectory?: string;
	private bridge?: NetworkBridge;
	private exposureBridge?: LoopbackExposureBridge;
	private placeholders: BashPlaceholderJournal[] = [];

	constructor(
		readonly cwd: string,
		readonly authority: EffectiveAuthority,
		readonly privateRoots: string[],
		readonly loopbackPorts: readonly number[] = [],
		readonly runtimeHelperExecutable?: string,
		readonly sharedTmpPath?: string,
		readonly netGuard?: NetworkGuard,
		readonly onNetworkBridge?: (bridge: NetworkBridge) => void,
		readonly publicationDirectory?: string,
	) {}

	async initialize(): Promise<void> {
		this.bubblewrapPath = await requireBubblewrap();
		if (this.sharedTmpPath !== undefined) {
			if (!isAbsolute(this.sharedTmpPath) || !existsSync(this.sharedTmpPath) || !lstatSync(this.sharedTmpPath).isDirectory()
				|| this.privateRoots.some((root) => isInside(this.sharedTmpPath!, root))
				|| !this.authority.writeExpressions.some((expression) => pathExpressionContains(expression, this.sharedTmpPath!))) {
				throw new Error("sharedTmpPath must be an existing public absolute directory");
			}
			mkdirSync(join(this.sharedTmpPath, "linden-home"), { recursive: true });
		}
		if (this.authority.unsafeAbsentWriteExclusions.length) {
			throw new Error(`Bash denied: delegated non-existent paths cannot be excluded safely by bubblewrap (${this.authority.unsafeAbsentWriteExclusions.join(", ")})`);
		}
		this.prepareAbsentWritePlaceholders();
		if (this.authority.webDomains.length || this.authority.netEndpoints?.length || this.netGuard) {
			await requireRuntimeCommand("socat", ["-V"]);
			this.bridge = new NetworkBridge(this.netGuard ?? (this.authority.netEndpoints ? new NetGuard(() => ({ endpoints: this.authority.netEndpoints ?? [], exclusions: this.authority.netExclusions ?? [] })) : new DomainGuard(this.authority.webDomains)));
			await this.bridge.start();
			this.onNetworkBridge?.(this.bridge);
		}
		if (this.runtimeHelperExecutable !== undefined
			&& (!this.runtimeHelperExecutable.startsWith("/") || !existsSync(this.runtimeHelperExecutable))) {
			throw new Error("An absolute Linden runtime helper is required for Term");
		}
		if (this.loopbackPorts.length) {
			await requireRuntimeCommand("socat", ["-V"]);
			if (!this.runtimeHelperExecutable) throw new Error("The Linden runtime helper is required for Term loopback exposure monitoring");
			this.exposureBridge = new LoopbackExposureBridge(this.loopbackPorts);
			await this.exposureBridge.start();
		}
		if (!this.identityDirectory) {
			this.identityDirectory = mkdtempSync(join(tmpdir(), "linden-system-"));
			// Compatibility identity only: it never defines a Linden participant or authority.
			writeFileSync(join(this.identityDirectory, "passwd"), "linden:x:0:0:Linden sandbox:/tmp/linden-home:/bin/bash\n", { mode: 0o644 });
			writeFileSync(join(this.identityDirectory, "group"), "linden:x:0:\n", { mode: 0o644 });
		}
	}


	placeholderJournal(): BashPlaceholderJournal[] { return this.placeholders.map((record) => ({ path: record.path, identity: record.identity && { ...record.identity } })); }

	cleanupPlaceholders(): PlaceholderCleanupResult {
		const records = this.placeholderJournal();
		this.placeholders = [];
		return cleanupAbsentWritePlaceholders(records);
	}

	private prepareAbsentWritePlaceholders(): void {
		for (const path of this.authority.absentWriteFileExclusions) {
			const record: BashPlaceholderJournal = { path };
			this.placeholders.push(record);
			let descriptor: number | undefined;
			try {
				descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
				record.identity = identityOfDescriptor(descriptor, path);
			} catch (error) {
				throw new Error(`Bash denied: absent exact File exclusion could not be reserved at ${path}`, { cause: error });
			} finally {
				if (descriptor !== undefined) closeSync(descriptor);
			}
		}
	}
	loopbackExposure(): { configured: number[]; active: number[] } {
		return { configured: [...this.loopbackPorts], active: this.exposureBridge?.activePorts() ?? [] };
	}

	async shutdown(): Promise<void> {
		try { await Promise.all([this.bridge?.stop(), this.exposureBridge?.stop()]); }
		finally {
			if (this.identityDirectory) rmSync(this.identityDirectory, { recursive: true, force: true });
			this.identityDirectory = undefined;
		}
	}

	operations(): BashOperations { return { exec: async (command, cwd, options) => this.exec(command, cwd, options) }; }

	/**
	 * Start a process in the already-initialized sandbox without imposing the
	 * one-shot Bash lifecycle. Callers own the child and must wait for it to
	 * exit before cleanupPlaceholders().
	 */
	spawnProcess(command: string, cwd = this.cwd, options: SandboxSpawnOptions = {}): ChildProcess {
		if (!this.bubblewrapPath || !this.identityDirectory) throw new Error("LINDEN_SANDBOX_NOT_INITIALIZED: initialize the sandbox before starting a process");
		const args = this.arguments(command, cwd, options.controlSockets ?? []);
		return spawn(this.bubblewrapPath, args, {
			cwd: "/",
			detached: true,
			stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
			env: sandboxEnvironment(),
		});
	}

	async exec(command: string, cwd = this.cwd, options: SandboxRunOptions = {}): Promise<{ exitCode: number | null }> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnProcess(command, cwd);
			let timedOut = false;
			const timer = options.timeout && options.timeout > 0 ? setTimeout(() => { timedOut = true; killGroup(child); }, options.timeout * 1000) : undefined;
			const abort = () => killGroup(child);
			options.signal?.addEventListener("abort", abort, { once: true });
			child.stdout?.on("data", (data: Buffer) => options.onData?.(data));
			child.stderr?.on("data", (data: Buffer) => options.onData?.(data));
			child.once("error", reject);
			child.once("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else resolvePromise({ exitCode: code });
			});
		});
	}

	private arguments(command: string, cwd: string, controlSockets: string[] = []): string[] {
		if (this.privateRoots.some((root) => isInside(cwd, root))) throw new Error("Bash cwd is private state");
		const args = [
			...BUBBLEWRAP_ISOLATION_ARGS,
			// Bubblewrap starts with an empty root. Normally /tmp is private. An
			// explicit evaluator path may instead be mounted there so an outer grader
			// can observe declared Unix sockets or files while authority still tracks
			// the same source directory at its public address.
			...(this.sharedTmpPath ? ["--dir", "/tmp", "--bind", this.sharedTmpPath, "/tmp"] : ["--tmpfs", "/tmp"]),
			"--dir", "/tmp/linden-home", "--dev", "/dev", "--proc", "/proc",
			"--setenv", "HOME", "/tmp/linden-home",
		];
		const createdDirs = new Set(["/", "/tmp", "/tmp/linden-home", "/dev", "/proc"]);
		const visibleRoots = new Set<string>();
		const readonlyOverlays = new Set<string>();
		const mounted = new Map<string, boolean>();
		const createDir = (path: string) => {
			if (path === "/" || createdDirs.has(path)) return;
			args.push("--dir", path);
			createdDirs.add(path);
		};
		const createAncestors = (path: string) => {
			for (const dir of ancestorDirs(path)) createDir(dir);
		};
		const mount = (source: string, writable: boolean) => {
			if (!existsSync(source)) {
				if (writable) throw new Error(`Bash cannot mount non-existent exact File ${source}; grant a containing Path for creation`);
				return;
			}
			createAncestors(source);
			const previous = mounted.get(source);
			if (previous === undefined || writable && !previous) {
				args.push(writable ? "--bind" : "--ro-bind", source, source);
				mounted.set(source, writable);
			}
			visibleRoots.add(source);
		};
		const exposeSystemRoot = (path: string) => {
			if (!existsSync(path)) return;
			createAncestors(path);
			if (lstatSync(path).isSymbolicLink()) {
				args.push("--symlink", readlinkSync(path), path);
				createdDirs.add(path);
				return;
			}
			mount(path, false);
		};
		for (const path of systemRuntimeRoots) exposeSystemRoot(path);
		for (const path of [...systemRuntimeFiles, ...certificateRoots]) mount(path, false);
		createDir("/etc");
		for (const file of ["passwd", "group"]) args.push("--ro-bind", join(this.identityDirectory!, file), `/etc/${file}`);
		// Debian's which traverses /etc/alternatives outside the mounted /usr.
		// Recreate only this command's missing links, never the host /etc tree.
		const repairedLinks = new Set<string>();
		for (const candidate of ["/usr/bin/which", "/bin/which"]) {
			if (!existsSync(candidate)) continue;
			let path = join(realpathSync.native(dirname(candidate)), basename(candidate));
			const visited = new Set<string>();
			while (!visited.has(path) && lstatSync(path).isSymbolicLink()) {
				visited.add(path);
				const target = readlinkSync(path);
				if (!repairedLinks.has(path) && !systemRuntimeRoots.some((root) => isInside(path, root))) {
					createAncestors(path);
					args.push("--symlink", target, path);
					repairedLinks.add(path);
				}
				path = resolve(dirname(path), target);
			}
			if (![...visibleRoots].some((root) => isInside(path, root))) mount(path, false);
		}
		const runtimeRoot = dirname(dirname(process.execPath));
		if (!systemRuntimeRoots.some((root) => isInside(process.execPath, root))) mount(runtimeRoot, false);
		if (this.runtimeHelperExecutable
			&& !systemRuntimeRoots.some((root) => this.runtimeHelperExecutable === root || isInside(this.runtimeHelperExecutable!, root))) {
			mount(this.runtimeHelperExecutable, false);
		}
		for (const socket of controlSockets) {
			if (!socket.startsWith("/tmp/linden-term-control-") || !existsSync(socket) || !lstatSync(socket).isSocket()) {
				throw new Error(`Invalid Term control socket: ${socket}`);
			}
			createAncestors(socket);
			args.push("--bind", socket, socket);
			visibleRoots.add(socket);
		}
		const exposureDirectories = [...new Set([this.publicationDirectory, this.exposureBridge?.directory].filter((path): path is string => !!path))];
		for (const exposureDirectory of exposureDirectories) {
			if (!exposureDirectory.startsWith("/tmp/linden-term-expose-") || !existsSync(exposureDirectory) || !lstatSync(exposureDirectory).isDirectory()) {
				throw new Error(`Invalid Term loopback exposure directory: ${exposureDirectory}`);
			}
			createAncestors(exposureDirectory);
			args.push("--bind", exposureDirectory, exposureDirectory);
			visibleRoots.add(exposureDirectory);
		}
		for (const path of this.authority.readPaths) if (!this.authority.writePaths.some((root) => path === root || isInside(path, root))) mount(path, false);
		for (const path of this.authority.writePaths) {
			// A tracked exact File inside an already-writable directory root must not become
			// its own mount point: mount points cannot be unlinked (EBUSY), which would
			// make `rm` of an owner-tracked file impossible inside Bash.
			if (this.authority.writePaths.some((root) => root !== path && existsSync(root) && isInside(path, root))) continue;
			mount(path, true);
		}
		const isVisible = (path: string): boolean => [...visibleRoots].some((root) => path === root || isInside(path, root));
		for (const path of [...this.authority.denyWritePaths, ...this.authority.absentWriteFileExclusions]) {
			if (!existsSync(path) || !isVisible(path)) continue;
			createAncestors(path);
			args.push("--ro-bind", path, path);
			visibleRoots.add(path);
		}
		for (const path of [...this.authority.denyReadPaths, ...this.privateRoots]) {
			if (!existsSync(path) || !isVisible(path)) continue;
			createAncestors(path);
			if (lstatSync(path).isDirectory()) {
				args.push("--tmpfs", path);
				readonlyOverlays.add(path);
			} else {
				args.push("--ro-bind", "/dev/null", path);
			}
		}
		let wrapped = command;
		const bridgeStarts: string[] = [];
		const bridgePids: string[] = [];
		if (this.bridge?.httpSocket && this.bridge.socksSocket) {
			for (const socket of [this.bridge.httpSocket, this.bridge.socksSocket]) {
				createAncestors(socket);
				args.push("--bind", socket, socket);
			}
			args.push("--setenv", "HTTP_PROXY", "http://127.0.0.1:3128", "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128", "--setenv", "ALL_PROXY", "socks5h://127.0.0.1:1080", "--setenv", "NO_PROXY", "");
			bridgeStarts.push(`socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:${shellQuote(this.bridge.httpSocket)} >/dev/null 2>&1 & __linden_http=$!`);
			bridgeStarts.push(`socat TCP-LISTEN:1080,fork,reuseaddr UNIX-CONNECT:${shellQuote(this.bridge.socksSocket)} >/dev/null 2>&1 & __linden_socks=$!`);
			bridgePids.push("$__linden_http", "$__linden_socks");
		}
		if (this.exposureBridge) {
			for (const port of this.loopbackPorts) {
				const variable = `__linden_expose_${port}`;
				const socket = shellQuote(this.exposureBridge.socketPath(port));
				bridgeStarts.push([
					shellQuote(this.runtimeHelperExecutable!),
					"loopback-monitor",
					String(port),
					socket,
					">/dev/null 2>&1 &",
					variable + "=$!",
				].join(" "));
				bridgePids.push(`$${variable}`);
			}
		}
		if (bridgeStarts.length) wrapped = `set -m; ${bridgeStarts.join("; ")}; trap 'kill ${bridgePids.join(" ")} 2>/dev/null' EXIT; ${command}`;
		for (const path of readonlyOverlays) args.push("--remount-ro", path);
		// Freeze the empty directory skeleton. Nested writable authority binds and
		// the private /tmp mount remain writable because remount-ro is not recursive.
		createAncestors(cwd);
		if (!visibleRoots.has(cwd) && ![...visibleRoots].some((root) => isInside(cwd, root)) && !createdDirs.has(cwd)) createDir(cwd);
		args.push("--remount-ro", "/");
		args.push("--chdir", cwd, "--", "/bin/bash", "--noprofile", "--norc", "-c", wrapped);
		return args;
	}
}

export { killGroup };
