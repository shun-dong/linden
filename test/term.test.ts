import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import type { EffectiveAuthority } from "../src/runtime/model.js";
import {
	PersistentTerm,
	type TermEpochEndInfo,
} from "../src/runtime/term.js";

const hasRuntime = process.platform === "linux"
	&& spawnSync("which", ["bwrap"], { stdio: "ignore" }).status === 0
	&& spawnSync("which", ["script"], { stdio: "ignore" }).status === 0;

function workspaceAuthority(workspace: string): EffectiveAuthority {
	const expression = { include: workspace, exclude: [] };
	return {
		readExpressions: [expression],
		writeExpressions: [expression],
		readPaths: [workspace],
		writePaths: [workspace],
		denyReadPaths: [],
		denyWritePaths: [],
		absentWriteFileExclusions: [],
		unsafeAbsentWriteExclusions: [],
		webDomains: [],
	};
}

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

async function freeLoopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate a loopback test port");
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	return address.port;
}

async function requestLoopback(port: number): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const socket = createConnection(port, "127.0.0.1");
		let response = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n"));
		socket.on("data", (chunk) => { response += chunk; });
		socket.once("error", reject);
		socket.once("end", () => resolvePromise(response));
	});
}

test("Term listen pages retained UTF-8 output without skipping undisclosed bytes", async () => {
	const term = new PersistentTerm({ id: "term:paging", cwd: process.cwd(), privateRoots: [], authority: workspaceAuthority(process.cwd()) });
	(term as any).appendOutput(Buffer.from("α".repeat(100), "utf8"));
	const first = await term.listen({ maxBytes: 7 });
	assert.equal(first.start, 0);
	assert.equal(first.cursor, 6);
	assert.equal(first.data, "ααα");
	assert.equal(first.hasMore, true);
	const second = await term.listen({ after: first.cursor, maxBytes: 7 });
	assert.equal(second.start, first.cursor);
	assert.equal(second.cursor, 12);
	assert.equal(second.data, "ααα");
	assert.equal(second.hasMore, true);
});

test("Term trusts supervisor completion and preserves only safe cwd/exports across epochs", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-state-"));
	const nested = join(workspace, "nested");
	mkdirSync(nested);
	const hookOrder: string[] = [];
	const ended: TermEpochEndInfo[] = [];
	const term = new PersistentTerm({
		id: "term:state",
		cwd: workspace,
		privateRoots: [],
		onEpochStart: (info) => {
			hookOrder.push(`start:${info.epochId}`);
			return workspaceAuthority(workspace);
		},
		onEpochPrepared: (info) => { hookOrder.push(`prepared:${info.epochId}`); },
		onEpochEnd: (info) => {
			hookOrder.push(`end:${info.epochId}`);
			ended.push(info);
		},
	});
	try {
		await term.initialize();
		const startedAt = Date.now();
		const first = await term.exec("cd nested; export EXPORTED=outer; LOCAL=inner; greet() { printf 'hello:%s' \"$1\"; }; printf '$ '; sleep 0.2; printf done");
		assert.equal(first.exitCode, 0);
		assert.ok(Date.now() - startedAt >= 180, "a printed prompt must not be mistaken for foreground completion");
		assert.equal(term.lifecycle().lifecycle, "stopped");

		const second = await term.exec("printf '%s|%s|' \"$PWD\" \"$EXPORTED\"; printf '%s|' \"${LOCAL-unset}\"; if declare -F greet >/dev/null; then printf function-leaked; else printf function-cleared; fi");
		assert.equal(second.exitCode, 0);
		const listened = await term.listen();
		assert.match(listened.data, /\$ done/);
		assert.match(listened.data, new RegExp(`${nested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|outer\\|unset\\|function-cleared`));
		assert.equal(ended.length, 2, "a quiescent command closes one epoch before the next authority acquisition");
		assert.notEqual(ended[0]?.epochId, ended[1]?.epochId);
		assert.match(ended[0]?.epochId ?? "", /^epoch:state:[0-9a-f-]{36}$/);
		assert.deepEqual(hookOrder, [
			`start:${ended[0]?.epochId}`, `prepared:${ended[0]?.epochId}`, `end:${ended[0]?.epochId}`,
			`start:${ended[1]?.epochId}`, `prepared:${ended[1]?.epochId}`, `end:${ended[1]?.epochId}`,
		]);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term control completion cannot be forged through output, a second socket, /proc fds, or pidfd_getfd", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-protocol-"));
	const term = new PersistentTerm({
		id: "term:protocol",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
	});
	try {
		await term.initialize();
		const attack = [
			"printf 'DONE\\tfake\\tcommand:1\\t0\\n'",
			"printf inherited-fd3 >&3 2>/dev/null || true",
			"if find /proc/$$/fd -lname 'socket:*' -print -quit 2>/dev/null | grep -q .; then printf inherited-control-socket; fi",
			"supervisor=$PPID",
			"opened=0; for fd in /proc/$supervisor/fd/*; do if printf forged-via-proc >\"$fd\" 2>/dev/null; then opened=1; fi; done; if [ \"$opened\" = 1 ]; then printf opened-supervisor-fd; fi",
			"python3 - \"$supervisor\" <<'PY'",
			"import ctypes, os, sys",
			"target = int(sys.argv[1])",
			"leaked = False",
			"try:",
			"    pidfd = os.pidfd_open(target)",
			"    libc = ctypes.CDLL(None, use_errno=True)",
			"    for descriptor in range(32):",
			"        copied = libc.syscall(438, pidfd, descriptor, 0)",
			"        if copied >= 0:",
			"            leaked = True",
			"            os.close(copied)",
			"    os.close(pidfd)",
			"except (AttributeError, OSError):",
			"    pass",
			"if leaked:",
			"    print('pidfd-control-leak', end='')",
			"PY",
			"python3 - \"$supervisor\" <<'PY'",
			"import glob, json, os, socket, sys",
			"target = int(sys.argv[1])",
			"arguments = [part for part in open(f'/proc/{target}/cmdline', 'rb').read().split(b'\\0') if part]",
			"marker = arguments[-1].decode()",
			"for path in glob.glob('/tmp/linden-term-control-*/events.sock'):",
			"    try:",
			"        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
			"        peer.connect(path)",
			"        peer.sendall((json.dumps({'type':'done','marker':marker,'id':'command:1','exitCode':0,'cwd':'','env':''}) + '\\n').encode())",
			"        peer.close()",
			"    except OSError:",
			"        pass",
			"PY",
			"sleep 0.25",
			"printf genuine-completion",
		].join("\n");
		const startedAt = Date.now();
		assert.equal((await term.exec(attack)).exitCode, 0);
		assert.ok(Date.now() - startedAt >= 220, "forged records must not complete the command early");
		const output = (await term.listen()).data;
		assert.match(output, /DONE.*fake/);
		assert.match(output, /genuine-completion/);
		assert.doesNotMatch(output, /inherited-control-socket|opened-supervisor-fd|pidfd-control-leak/);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term never evaluates captured state after authority expands", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-state-injection-"));
	const safe = join(workspace, "safe");
	const expanded = join(workspace, "expanded");
	mkdirSync(safe);
	mkdirSync(expanded);
	const payload = join(expanded, "payload.sh");
	const marker = join(expanded, "state-was-evaluated");
	writeFileSync(payload, `printf exploited > ${JSON.stringify(marker)}\n`);
	let epoch = 0;
	const term = new PersistentTerm({
		id: "term:state-injection",
		cwd: safe,
		privateRoots: [],
		onEpochStart: () => ++epoch === 1 ? workspaceAuthority(safe) : workspaceAuthority(workspace),
	});
	try {
		await term.initialize();
		const literal = `$(printf exploited > ${marker})`;
		assert.equal((await term.exec(`export SAFE_LITERAL='${literal}'; export BASH_ENV=${JSON.stringify(payload)}; export LD_PRELOAD=${JSON.stringify(payload)}; printf first`)).exitCode, 0);
		assert.equal((await term.exec("printf '%s|%s|%s|%s' \"$PWD\" \"$SAFE_LITERAL\" \"${BASH_ENV-unset}\" \"${LD_PRELOAD-unset}\"")).exitCode, 0);
		const output = (await term.listen()).data;
		assert.ok(output.includes(`${safe}|${literal}|unset|unset`));
		assert.equal(existsSync(marker), false, "shell startup/state text must never run in the expanded epoch");
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term chooses the structural parent of exact-File authority as cwd", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-exact-cwd-"));
	const file = join(workspace, "allowed.txt");
	writeFileSync(file, "allowed-content");
	const expression = { include: file, exclude: [] };
	const authority: EffectiveAuthority = {
		readExpressions: [expression],
		writeExpressions: [],
		readPaths: [file],
		writePaths: [],
		denyReadPaths: [],
		denyWritePaths: [],
		absentWriteFileExclusions: [],
		unsafeAbsentWriteExclusions: [],
		webDomains: [],
	};
	const term = new PersistentTerm({ id: "term:exact-cwd", cwd: join(workspace, "unreadable-base"), privateRoots: [], authority });
	try {
		await term.initialize();
		assert.equal((await term.exec("printf '%s|' \"$PWD\"; cat allowed.txt")).exitCode, 0);
		assert.match((await term.listen()).data, new RegExp(`${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|allowed-content`));
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term start-hook failure does not end an unacquired lease and remains an error", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-lease-"));
	let ended = 0;
	const term = new PersistentTerm({
		id: "term:lease",
		cwd: workspace,
		privateRoots: [],
		onEpochStart: () => { throw new Error("lease acquisition failed"); },
		onEpochEnd: () => { ended += 1; },
	});
	try {
		await term.initialize();
		await assert.rejects(term.exec("true"), /lease acquisition failed/);
		assert.equal(ended, 0);
		assert.equal(term.lifecycle().lifecycle, "stopped");
		assert.equal(term.lifecycle().ready, true, "a fully cleaned failure still obeys stopped being ready");
		assert.match(term.lifecycle().error ?? "", /lease acquisition failed/);
		await assert.rejects(term.waitFor("ready"), /lease acquisition failed/);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term input is running-only and interrupt targets the PTY foreground", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-input-"));
	const term = new PersistentTerm({
		id: "term:input",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
	});
	try {
		await term.initialize();
		await assert.rejects(term.input("invalid\n"), /requires running/);
		const reading = await term.startExec("IFS= read -r answer; printf 'answer:%s' \"$answer\"");
		assert.equal(term.lifecycle().foreground?.id, reading.commandId, "launch resolves only after the trusted foreground acknowledgement");
		await term.input("forty-two\n");
		assert.equal((await reading.completion).exitCode, 0);
		assert.match((await term.listen()).data, /answer:forty-two/);

		const sleeping = term.exec("sleep 0.5 & sleep 30");
		await until(() => term.lifecycle().lifecycle === "running");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
		await term.interrupt();
		const interrupted = await sleeping;
		assert.notEqual(interrupted.exitCode, 0);
		assert.equal(term.lifecycle().lifecycle, "ready", "foreground interrupt must leave a background job alive");
		assert.ok(term.lifecycle().backgroundPids.length > 0);
		assert.equal((await term.waitFor("stopped", { timeout: 5 })).lifecycle, "stopped");

		const builtinLoop = term.exec("while :; do :; done");
		await until(() => term.lifecycle().lifecycle === "running");
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
		await term.interrupt();
		assert.notEqual((await builtinLoop).exitCode, 0);
		assert.equal((await term.waitFor("stopped", { timeout: 5 })).lifecycle, "stopped");
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term keeps an epoch ready for jobs and tracks disowned sandbox descendants", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-background-"));
	const ends: TermEpochEndInfo[] = [];
	const term = new PersistentTerm({
		id: "term:background",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: (info) => { ends.push(info); },
		quiescencePollMs: 20,
	});
	try {
		await term.initialize();
		const foreground = await term.exec("setsid /bin/sleep 0.35 >/dev/null 2>&1 & disown; printf detached");
		assert.equal(foreground.exitCode, 0);
		assert.equal(term.lifecycle().lifecycle, "ready");
		assert.ok(term.lifecycle().backgroundPids.length > 0, "detached processes must remain visible to the PID-namespace supervisor");
		assert.equal((await term.waitFor("stopped", { timeout: 5 })).lifecycle, "stopped");
		assert.equal(ends.length, 1);
		assert.equal(ends[0]?.forced, false);

		await term.exec("sleep 30 & printf long-background");
		assert.equal(term.lifecycle().lifecycle, "ready");
		await term.stopAll();
		assert.equal(term.lifecycle().lifecycle, "stopped");
		assert.equal(ends.length, 2);
		assert.equal(ends[1]?.forced, true);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term keeps network isolation while explicitly bridging a listening service to parent loopback", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-loopback-"));
	const port = await freeLoopbackPort();
	const term = new PersistentTerm({
		id: "term:loopback",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		loopbackPorts: [port],
		quiescencePollMs: 20,
	});
	try {
		await term.initialize();
		assert.equal((await term.exec(`python3 -m http.server ${port} --bind 0.0.0.0 >/dev/null 2>&1 &`)).exitCode, 0);
		await until(() => term.lifecycle().activeLoopbackPorts?.includes(port) === true, 5_000);
		assert.match(await requestLoopback(port), /^HTTP\/1\.0 200 OK/m);
		await term.stopAll();
		assert.equal(term.lifecycle().lifecycle, "stopped");
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term records command output ranges and bounded output for a multi-command epoch", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-trace-"));
	const ends: TermEpochEndInfo[] = [];
	const term = new PersistentTerm({
		id: "term:trace",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: (info) => { ends.push(info); },
		quiescencePollMs: 20,
	});
	try {
		await term.initialize();
		assert.equal((await term.exec("sleep 0.35 >/dev/null 2>&1 & printf first-marker")).exitCode, 0);
		assert.equal(term.lifecycle().lifecycle, "ready", "the background job keeps the epoch open");
		assert.equal((await term.exec("printf second-marker")).exitCode, 0);
		assert.equal((await term.waitFor("stopped", { timeout: 5 })).lifecycle, "stopped");

		assert.equal(ends.length, 1);
		const end = ends[0]!;
		assert.equal(end.commands.length, 2);
		assert.equal(end.output.truncatedBefore, false);
		assert.equal(Buffer.byteLength(end.output.data), end.output.end - end.output.start);
		assert.equal(end.output.end, (await term.listen()).cursor);

		const [first, second] = end.commands;
		assert.ok(first && second);
		assert.ok(end.output.start <= first.outputStart);
		assert.ok(first.outputStart <= first.outputEnd);
		assert.ok(first.outputEnd <= second.outputStart);
		assert.ok(second.outputStart <= second.outputEnd);
		assert.ok(second.outputEnd <= end.output.end);
		const bytes = Buffer.from(end.output.data);
		const commandOutput = (start: number, finish: number) => bytes
			.subarray(start - end.output.start, finish - end.output.start)
			.toString("utf8");
		assert.match(commandOutput(first.outputStart, first.outputEnd), /first-marker/);
		assert.match(commandOutput(second.outputStart, second.outputEnd), /second-marker/);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term marks an epoch when its bounded retained output loses the prefix", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-trace-truncated-"));
	const ends: TermEpochEndInfo[] = [];
	const term = new PersistentTerm({
		id: "term:trace-truncated",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: (info) => { ends.push(info); },
		outputLimitBytes: 1_024,
	});
	try {
		await term.initialize();
		assert.equal((await term.exec("head -c 2048 /dev/zero | tr '\\0' x; printf tail-marker")).exitCode, 0);
		assert.equal(ends.length, 1);
		const end = ends[0]!;
		const command = end.commands[0]!;
		assert.equal(end.output.truncatedBefore, true);
		assert.equal(Buffer.byteLength(end.output.data), 1_024);
		assert.equal(end.output.end - end.output.start, 1_024);
		assert.ok(command.outputStart < end.output.start);
		assert.ok(command.outputEnd <= end.output.end);
		assert.match(end.output.data, /tail-marker$/);
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term serializes a slow epoch start with stop and leaves no open lease", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-start-stop-"));
	let enterStart!: () => void;
	const startEntered = new Promise<void>((resolvePromise) => { enterStart = resolvePromise; });
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise; });
	let leaseOpen = false;
	let ends = 0;
	const term = new PersistentTerm({
		id: "term:start-stop",
		cwd: workspace,
		privateRoots: [],
		onEpochStart: async () => {
			enterStart();
			await startGate;
			leaseOpen = true;
			return workspaceAuthority(workspace);
		},
		onEpochEnd: () => {
			assert.equal(leaseOpen, true);
			leaseOpen = false;
			ends += 1;
		},
	});
	try {
		await term.initialize();
		const execution = term.exec("sleep 30");
		const executionStopped = assert.rejects(execution, /was stopped/);
		await startEntered;
		assert.equal(term.lifecycle().lifecycle, "running", "starting is externally busy, not ready");
		let stopSettled = false;
		const stopping = term.stopAll().finally(() => { stopSettled = true; });
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
		assert.equal(stopSettled, false, "stop must wait for epoch publication instead of racing it");
		releaseStart();
		await executionStopped;
		await stopping;
		assert.equal(leaseOpen, false);
		assert.equal(ends, 1);
		assert.equal(term.lifecycle().epochId, undefined);
		assert.equal(term.lifecycle().lifecycle, "stopped");
	} finally {
		releaseStart();
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term exposes reconciliation as busy and dispose propagates epoch-end failure", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-reconcile-"));
	let releaseEnd!: () => void;
	const endGate = new Promise<void>((resolvePromise) => { releaseEnd = resolvePromise; });
	let endEntered = false;
	let failEnd = false;
	const endInfos: TermEpochEndInfo[] = [];
	const term = new PersistentTerm({
		id: "term:reconcile",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: async (info) => {
			endInfos.push(info);
			endEntered = true;
			await endGate;
			if (failEnd) throw new Error("epoch-end persist failed");
		},
	});
	try {
		await term.initialize();
		const first = term.exec("true");
		await until(() => endEntered);
		assert.equal(term.lifecycle().reconciling, true);
		assert.equal(term.lifecycle().lifecycle, "running", "reconciliation cannot be observed as ready");
		await assert.rejects(term.waitFor("ready", { timeout: 0.05 }), /timeout/);
		releaseEnd();
		assert.equal((await first).exitCode, 0);

		failEnd = true;
		await term.exec("sleep 30 & printf ready");
		await assert.rejects(term.dispose(), /epoch-end persist failed/);
		assert.equal(term.lifecycle().lifecycle, "running", "an open manager epoch is not stopped");
		assert.equal(term.lifecycle().ready, false);
		assert.ok(term.lifecycle().epochId);
		assert.match(term.lifecycle().error ?? "", /epoch-end persist failed/);
		await assert.rejects(term.waitFor("stopped"), /epoch-end persist failed/);
		failEnd = false;
		await term.dispose();
		assert.equal(endInfos.length, 3);
		assert.strictEqual(endInfos[1], endInfos[2], "retry reuses the prepared end record without physical reconciliation");
	} finally {
		releaseEnd();
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term retains an epoch when sandbox termination fails and retries cleanup", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-close-retry-"));
	let ends = 0;
	const term = new PersistentTerm({
		id: "term:close-retry",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: () => { ends += 1; },
	});
	const internal = term as unknown as { closeSandbox: () => Promise<void> };
	let originalClose: (() => Promise<void>) | undefined;
	try {
		await term.initialize();
		await term.exec("sleep 30 & printf ready");
		originalClose = internal.closeSandbox.bind(term);
		internal.closeSandbox = async () => { throw new Error("synthetic sandbox termination timeout"); };
		await assert.rejects(term.dispose(), /synthetic sandbox termination timeout/);
		assert.equal(ends, 0, "epoch-end must not run while the sandbox may still mutate files");
		assert.ok(term.lifecycle().epochId, "the epoch must remain retryable");
		assert.equal(term.lifecycle().lifecycle, "running");
		assert.equal(term.lifecycle().ready, false);
		internal.closeSandbox = originalClose;
		await term.dispose();
		assert.equal(ends, 1);
	} finally {
		if (originalClose) internal.closeSandbox = originalClose;
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term does not retry an epoch-end error already durably committed", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-committed-end-"));
	let ends = 0;
	const term = new PersistentTerm({
		id: "term:committed-end",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		onEpochEnd: () => {
			ends += 1;
			return { committed: true, error: new Error("committed integrity divergence") };
		},
	});
	try {
		await term.initialize();
		await assert.rejects(term.exec("true"), /committed integrity divergence/);
		assert.equal(ends, 1);
		assert.equal(term.lifecycle().epochId, undefined);
		assert.equal(term.lifecycle().lifecycle, "stopped");
		assert.equal(term.lifecycle().ready, true);
		await term.dispose();
		assert.equal(ends, 1, "dispose must not retry a committed epoch");
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Term interrupt escalates only the uncooperative foreground", { skip: !hasRuntime }, async () => {
	const workspace = mkdtempSync(join(tmpdir(), "linden-term-interrupt-kill-"));
	const term = new PersistentTerm({
		id: "term:interrupt-kill",
		cwd: workspace,
		privateRoots: [],
		authority: workspaceAuthority(workspace),
		interruptGraceMs: 100,
	});
	try {
		await term.initialize();
		const execution = term.exec("trap '' INT; while :; do sleep 1; done");
		await until(() => term.lifecycle().foreground !== undefined);
		const startedAt = Date.now();
		await term.interrupt();
		assert.notEqual((await execution).exitCode, 0);
		assert.ok(Date.now() - startedAt < 2_000, "SIGINT-ignoring foreground must be force-terminated after grace");
		assert.equal((await term.waitFor("stopped", { timeout: 5 })).lifecycle, "stopped");
	} finally {
		await term.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
});
