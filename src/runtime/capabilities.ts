import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export interface RuntimeCapability {
	available: boolean;
	scope: "host" | "sandbox";
	stage: "lookup" | "execute" | "isolation";
	code: string;
	reason: string;
	command: string;
	path?: string;
	exitCode?: number | null;
}

/** Shared by the production sandbox and the isolation probe. */
export const BUBBLEWRAP_ISOLATION_ARGS = [
	"--new-session", "--die-with-parent", "--unshare-user", "--uid", "0", "--gid", "0",
	"--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
] as const;

/** Resolve PATH directly; neither a shell nor an external `which` is needed. */
export function inspectExecutable(command: string, searchPath = process.env.PATH ?? "/usr/bin:/bin"): RuntimeCapability {
	const candidates = isAbsolute(command) || command.includes("/")
		? [resolve(command)] : searchPath.split(delimiter).map((directory) => resolve(directory || ".", command));
	let unavailable: RuntimeCapability | undefined;
	for (const candidate of candidates) {
		try {
			const path = realpathSync.native(candidate);
			if (!statSync(path).isFile()) {
				unavailable = { available: false, scope: "host", stage: "lookup", code: "TOOL_NOT_EXECUTABLE", command, reason: `Host tool ${command} resolves to a directory or non-file at ${path}` };
				continue;
			}
			accessSync(path, constants.X_OK);
			return { available: true, scope: "host", stage: "lookup", code: "AVAILABLE", command, path, reason: `${command} is executable at ${path}` };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				try {
					if (lstatSync(candidate).isSymbolicLink()) unavailable = {
						available: false, scope: "host", stage: "lookup", code: "TOOL_LINK_BROKEN", command,
						reason: `Host tool ${command} has a broken symbolic link at ${candidate}; its target is unavailable in this execution environment`,
					};
				} catch { /* candidate itself is absent */ }
			}
			if (code !== "ENOENT" && code !== "ENOTDIR") unavailable = {
				available: false, scope: "host", stage: "lookup", code: "TOOL_NOT_EXECUTABLE", command,
				reason: `Host tool ${command} cannot be accessed or executed (${code ?? String(error)})`,
			};
		}
	}
	return unavailable ?? { available: false, scope: "host", stage: "lookup", code: "TOOL_NOT_FOUND", command, reason: `Host tool ${command} was not found in PATH` };
}

export class RuntimeCapabilityError extends Error {
	constructor(readonly capability: RuntimeCapability) {
		super(`LINDEN_${capability.code}: ${capability.reason}`);
		this.name = "RuntimeCapabilityError";
	}
}

/** A real asynchronous execution also catches missing loaders/interpreters. */
export async function probeCommand(command: string, args: readonly string[], searchPath?: string, timeoutMs = 5000): Promise<RuntimeCapability> {
	const capability = inspectExecutable(command, searchPath);
	if (!capability.available) return capability;
	return new Promise((resolveProbe) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		const child = spawn(capability.path!, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			finish({ ...capability, available: false, stage: "execute", code: "TOOL_TIMEOUT", reason: `Host tool ${command} did not finish its capability check within ${timeoutMs} ms` });
			child.stdout?.destroy();
			child.stderr?.destroy();
		}, timeoutMs);
		const finish = (result: RuntimeCapability) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveProbe(result);
		};
		const capture = (data: Buffer) => { output = (output + data.toString()).slice(0, 8192); };
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.once("error", (error: NodeJS.ErrnoException) => finish({
			...capability, available: false, stage: "execute", code: "TOOL_EXECUTION_FAILED",
			reason: `Host tool ${command} exists at ${capability.path}, but could not start (${error.code ?? error.message}); check its interpreter, loader and execution permissions`,
		}));
		child.once("close", (exitCode, signal) => finish({
			...capability, available: exitCode === 0 && !timedOut, stage: "execute", exitCode,
			code: timedOut ? "TOOL_TIMEOUT" : exitCode === 0 ? "AVAILABLE" : "TOOL_EXECUTION_FAILED",
			reason: timedOut ? `Host tool ${command} did not finish its capability check within ${timeoutMs} ms`
				: exitCode === 0 ? `${command} executed successfully`
					: `Host tool ${command} failed its capability check (${signal ?? `exit ${exitCode}`}): ${output.trim() || "no diagnostic output"}`,
		}));
	});
}

const commandChecks = new Map<string, Promise<RuntimeCapability>>();
const isolationChecks = new Map<string, Promise<RuntimeCapability>>();
function executableKey(capability: RuntimeCapability): string {
	const stat = statSync(capability.path!);
	return `${capability.path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/** Cache by executable identity; replacing a tool causes a new check. */
export async function checkRuntimeCommand(command: string, args: readonly string[]): Promise<RuntimeCapability> {
	const capability = inspectExecutable(command);
	if (!capability.available) return capability;
	const key = `${executableKey(capability)}:${JSON.stringify(args)}`;
	let check = commandChecks.get(key);
	if (!check) {
		check = probeCommand(capability.path!, args);
		commandChecks.set(key, check);
	}
	return check;
}

export async function requireRuntimeCommand(command: string, args: readonly string[]): Promise<string> {
	const capability = await checkRuntimeCommand(command, args);
	if (!capability.available) throw new RuntimeCapabilityError(capability);
	return capability.path!;
}

/** No user command, network request, permission change, or project write. */
export async function probeBubblewrap(searchPath?: string): Promise<RuntimeCapability> {
	if (process.platform !== "linux") return {
		available: false, scope: "sandbox", stage: "isolation", code: "UNSUPPORTED_PLATFORM", command: "bwrap",
		reason: `Linden's bubblewrap sandbox requires Linux, got ${process.platform}`,
	};
	const executable = inspectExecutable("bwrap", searchPath);
	if (!executable.available) return executable;
	const key = executableKey(executable);
	let check = isolationChecks.get(key);
	if (!check) {
		check = (async () => {
			const version = await probeCommand(executable.path!, ["--version"]);
			if (!version.available) return version;
			const isolation = await probeCommand(executable.path!, [
				...BUBBLEWRAP_ISOLATION_ARGS, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true",
			]);
			return {
				...isolation, scope: "sandbox", stage: "isolation", command: "bwrap",
				code: isolation.available ? "AVAILABLE" : "SANDBOX_UNAVAILABLE",
				reason: isolation.available ? "Linden sandbox isolation is available"
					: `bwrap is installed and executable, but Linden sandbox isolation cannot run in this execution environment: ${isolation.reason}`,
			} satisfies RuntimeCapability;
		})();
		isolationChecks.set(key, check);
	}
	return check;
}

export async function requireBubblewrap(): Promise<string> {
	const capability = await probeBubblewrap();
	if (!capability.available) throw new RuntimeCapabilityError(capability);
	return capability.path!;
}
