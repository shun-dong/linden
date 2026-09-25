import { spawn, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { BlockList, connect, createServer, isIP, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

export interface WebResourceReference {
	id: string;
	selector: string;
}

/** Parse one Web host-selector reference into its canonical ledger identity. */
export function resolveWebResourceReference(input: string): WebResourceReference {
	let selector = input.trim().toLowerCase();
	if (selector.startsWith("web:")) selector = selector.slice("web:".length);
	selector = selector.replace(/\/+$/, "");
	if (selector.includes("/")) throw new Error(`Web host selectors do not accept URL paths: ${input}`);
	if (!selector || selector.includes(":")) throw new Error(`Invalid Web host selector ${input}`);
	if (selector === "*") return { id: "web:*/", selector };
	const wildcard = selector.startsWith("*.");
	if (selector.includes("*") && !wildcard) throw new Error(`Invalid Web host selector ${input}`);
	const hostname = wildcard ? selector.slice(2) : selector;
	const labels = hostname.split(".");
	if (hostname.length > 253 || labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
		throw new Error(`Invalid Web host selector ${input}`);
	}
	return { id: `web:${selector}/`, selector };
}

export function domainMatches(host: string, pattern: string): boolean {
	const value = host.toLowerCase().replace(/\.$/, "");
	const rule = pattern.toLowerCase().replace(/\.$/, "");
	if (rule === "*") return true;
	if (rule.startsWith("*.")) return value.endsWith(rule.slice(1)) && value !== rule.slice(2);
	return value === rule;
}

/** True when every host selected by `child` is selected by `parent`. */
export function hostSelectorContains(parent: string, child: string): boolean {
	const broad = parent.toLowerCase().replace(/\.$/, "");
	const narrow = child.toLowerCase().replace(/\.$/, "");
	if (broad === "*" || broad === narrow) return true;
	if (!broad.startsWith("*.")) return false;
	const suffix = broad.slice(1);
	if (narrow.startsWith("*.")) return narrow.slice(1).endsWith(suffix) && narrow.length > broad.length;
	return domainMatches(narrow, broad);
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
	["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
	["2001:2::", 48], ["2001:10::", 28], ["2001:db8::", 32], ["2002::", 16],
	["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as Array<[string, number]>) blockedAddresses.addSubnet(network, prefix, "ipv6");

export function privateAddress(address: string): boolean {
	const normalized = address.toLowerCase().split("%", 1)[0];
	const family = isIP(normalized);
	if (!family) return true;
	return blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export class DomainGuard {
	constructor(private readonly allowedDomains: string[]) {}

	async resolveAllowed(host: string): Promise<string | undefined> {
		const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
		if (!this.allowedDomains.some((rule) => domainMatches(clean, rule))) return undefined;
		try {
			const answers = isIP(clean) ? [{ address: clean }] : await lookup(clean, { all: true, verbatim: true });
			if (!answers.length || answers.some(({ address }) => privateAddress(address))) return undefined;
			return answers[0].address;
		} catch { return undefined; }
	}
}

const listen = (server: Server): Promise<number> => new Promise((resolvePromise, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", reject);
		const address = server.address();
		if (!address || typeof address === "string") reject(new Error("Network proxy did not bind a TCP port"));
		else resolvePromise(address.port);
	});
});

const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise) => server.close(() => resolvePromise()));

/** Couple a tunnel before either peer can emit an unhandled Socket error. */
function coupleSockets(left: Duplex, right: Duplex): { start: () => boolean } {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		left.unpipe(right);
		right.unpipe(left);
		if (!left.destroyed) left.destroy();
		if (!right.destroyed) right.destroy();
	};
	left.on("error", close);
	right.on("error", close);
	left.on("close", close);
	right.on("close", close);
	return { start: () => {
		if (closed || left.destroyed || right.destroyed) { close(); return false; }
		left.pipe(right);
		right.pipe(left);
		return true;
	} };
}

/**
 * Exposes selected TCP ports from an isolated sandbox back to the parent
 * loopback interface. The sandbox side creates one Unix socket only after the
 * requested TCP port is actually listening; this avoids reserving a port for
 * every idle Term and keeps the bridge explicit and evaluator-scoped.
 */
export class LoopbackExposureBridge {
	private directoryPath?: string;
	private readonly servers = new Map<number, Server>();
	private readonly monitors = new Map<number, NodeJS.Timeout>();
	private readonly sockets = new Set<Socket>();
	private stopped = false;

	constructor(readonly ports: readonly number[]) {
		if (new Set(ports).size !== ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
			throw new Error("Loopback exposure ports must be unique TCP ports in 1..65535");
		}
	}

	get directory(): string | undefined { return this.directoryPath; }

	socketPath(port: number): string {
		if (!this.directoryPath || !this.ports.includes(port)) throw new Error(`Loopback exposure port is not prepared: ${port}`);
		return join(this.directoryPath, `tcp-${port}.sock`);
	}

	activePorts(): number[] { return [...this.servers.keys()].sort((left, right) => left - right); }

	async start(): Promise<void> {
		if (!this.ports.length) return;
		this.stopped = false;
		this.directoryPath = mkdtempSync(join(process.platform === "linux" ? "/tmp" : tmpdir(), "linden-term-expose-"));
		for (const port of this.ports) this.schedule(port, 0);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const timer of this.monitors.values()) clearTimeout(timer);
		this.monitors.clear();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await Promise.all([...this.servers.values()].map((server) => server.listening ? closeServer(server) : Promise.resolve()));
		this.servers.clear();
		if (this.directoryPath) rmSync(this.directoryPath, { recursive: true, force: true });
		this.directoryPath = undefined;
	}

	private schedule(port: number, delayMs: number): void {
		if (this.stopped) return;
		const timer = setTimeout(() => {
			this.monitors.delete(port);
			this.tryBind(port);
		}, delayMs);
		timer.unref?.();
		this.monitors.set(port, timer);
	}

	private tryBind(port: number): void {
		if (this.stopped || this.servers.has(port)) return;
		const path = this.socketPath(port);
		if (!existsSync(path)) { this.schedule(port, 25); return; }
		const server = createServer((incoming) => {
			this.track(incoming);
			const upstream = connect(path);
			this.track(upstream);
			const pair = coupleSockets(incoming, upstream);
			upstream.once("connect", () => pair.start());
		});
		let settled = false;
		server.once("error", () => {
			if (settled || this.stopped) return;
			settled = true;
			this.schedule(port, 50);
		});
		server.listen(port, "127.0.0.1", () => {
			if (settled || this.stopped) { server.close(); return; }
			settled = true;
			this.servers.set(port, server);
		});
	}

	private track(socket: Socket): void {
		if (this.sockets.has(socket)) return;
		this.sockets.add(socket);
		// The peer-specific listener is installed by coupleSockets. This listener
		// also covers the brief interval before an outbound peer is available.
		socket.on("error", () => {});
		socket.once("close", () => this.sockets.delete(socket));
	}
}

export class NetworkBridge {
	private httpServer?: Server;
	private socksServer?: Server;
	private readonly sockets = new Set<Socket>();
	private bridges: ChildProcess[] = [];
	private directory?: string;
	httpSocket?: string;
	socksSocket?: string;

	constructor(private readonly guard: DomainGuard) {}

	async start(): Promise<void> {
		this.httpServer = this.createHttpProxy();
		this.socksServer = this.createSocksProxy();
		for (const server of [this.httpServer, this.socksServer]) server.on("connection", (socket: Socket) => this.track(socket));
		const [httpPort, socksPort] = await Promise.all([listen(this.httpServer), listen(this.socksServer)]);
		this.directory = mkdtempSync(join(process.platform === "linux" ? "/tmp" : tmpdir(), "linden-net-"));
		this.httpSocket = join(this.directory, "http.sock");
		this.socksSocket = join(this.directory, "socks.sock");
		this.bridges = [this.spawnBridge(this.httpSocket, httpPort), this.spawnBridge(this.socksSocket, socksPort)];
		for (let index = 0; index < 100; index++) {
			const { existsSync } = await import("node:fs");
			if (existsSync(this.httpSocket) && existsSync(this.socksSocket)) return;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		throw new Error("Timed out creating Linden network bridge sockets");
	}

	async stop(): Promise<void> {
		const closingServers = [this.httpServer, this.socksServer].map((server) => server?.listening ? closeServer(server) : Promise.resolve());
		for (const child of this.bridges) child.kill("SIGKILL");
		this.bridges = [];
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await Promise.all(closingServers);
		this.httpServer = undefined;
		this.socksServer = undefined;
		if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		this.directory = undefined;
		this.httpSocket = undefined;
		this.socksSocket = undefined;
	}

	private spawnBridge(socket: string, port: number): ChildProcess {
		return spawn("socat", [`UNIX-LISTEN:${socket},fork,mode=600`, `TCP:127.0.0.1:${port}`], { stdio: "ignore" });
	}

	private createHttpProxy(): Server {
		const server = createHttpServer(async (incoming, outgoing) => {
			let upstream: ReturnType<typeof request> | undefined;
			const abortUpstream = () => upstream?.destroy();
			incoming.on("aborted", abortUpstream);
			incoming.on("error", abortUpstream);
			outgoing.on("error", abortUpstream);
			outgoing.on("close", () => { if (!outgoing.writableFinished) abortUpstream(); });
			try {
				const url = new URL(incoming.url ?? "", `http://${incoming.headers.host ?? ""}`);
				const address = await this.guard.resolveAllowed(url.hostname);
				if (outgoing.destroyed) return;
				if (!address || url.protocol !== "http:") { outgoing.writeHead(403); outgoing.end("Blocked by Linden Web authority"); return; }
				upstream = request({ protocol: "http:", hostname: address, port: url.port || 80, path: `${url.pathname}${url.search}`, method: incoming.method, headers: { ...incoming.headers, host: url.host } }, (response) => {
					response.on("error", () => outgoing.destroy());
					outgoing.on("close", () => response.destroy());
					if (outgoing.destroyed) { response.destroy(); return; }
					outgoing.writeHead(response.statusCode ?? 502, response.headers);
					response.pipe(outgoing);
				});
				upstream.on("socket", (socket) => this.track(socket));
				upstream.on("error", () => {
					if (outgoing.destroyed) return;
					if (!outgoing.headersSent) outgoing.writeHead(502);
					outgoing.end();
				});
				incoming.pipe(upstream);
			} catch {
				abortUpstream();
				if (!outgoing.destroyed) { outgoing.writeHead(400); outgoing.end(); }
			}
		});
		server.on("connect", async (incoming, client, head) => {
			try {
				const target = new URL(`http://${incoming.url ?? ""}`);
				const port = Number(target.port || 443);
				const address = await this.guard.resolveAllowed(target.hostname);
				if (client.destroyed || !address || !Number.isInteger(port) || port < 1 || port > 65535) { client.destroy(); return; }
				const upstream = connect(port, address);
				this.track(upstream);
				const pair = coupleSockets(client, upstream);
				upstream.once("connect", () => {
					if (client.destroyed) { upstream.destroy(); return; }
					client.write(`HTTP/1.1 200 Connection Established${String.fromCharCode(13, 10, 13, 10)}`);
					if (head.length) upstream.write(head);
					pair.start();
				});
			} catch { client.destroy(); }
		});
		return server;
	}

	private createSocksProxy(): Server {
		return createServer((socket) => socket.once("data", (hello) => {
			const methodCount = hello[1] ?? 0;
			if (hello.length < 2 + methodCount || hello[0] !== 5 || !hello.subarray(2, 2 + methodCount).includes(0)) { socket.end(Buffer.from([5, 255])); return; }
			socket.write(Buffer.from([5, 0]));
			socket.once("data", (data) => void this.handleSocksRequest(socket, data).catch(() => socket.destroy()));
		}));
	}

	private async handleSocksRequest(socket: Socket, data: Buffer): Promise<void> {
		if (data.length < 7 || data[0] !== 5 || data[1] !== 1) { socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		let host: string; let offset: number;
		if (data[3] === 1 && data.length >= 10) { host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`; offset = 8; }
		else if (data[3] === 3) { const length = data[4]; host = data.subarray(5, 5 + length).toString("utf8"); offset = 5 + length; }
		else { socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		if (data.length < offset + 2) { socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		const port = data.readUInt16BE(offset);
		const address = await this.guard.resolveAllowed(host);
		if (socket.destroyed || !address || port < 1) { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		const upstream = connect(port, address);
		this.track(upstream);
		const pair = coupleSockets(socket, upstream);
		upstream.once("connect", () => {
			if (socket.destroyed) { upstream.destroy(); return; }
			socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
			pair.start();
		});
	}

	private track(socket: Socket): void {
		if (this.sockets.has(socket)) return;
		this.sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => this.sockets.delete(socket));
	}
}
