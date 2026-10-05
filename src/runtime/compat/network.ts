/** Historical Web authority and evaluator-only loopback exposure. */
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateAddress } from "../net.js";
import { closeServer, coupleSockets, type NetworkGuard, type NetworkTarget } from "../network-bridge.js";

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

export class DomainGuard implements NetworkGuard {
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

	async resolveTarget(host: string, port: number): Promise<NetworkTarget | undefined> {
		const address = await this.resolveAllowed(host);
		return address ? { address, port } : undefined;
	}
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
