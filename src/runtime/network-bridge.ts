import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/** Authorized route selected by a guard; publications use a pinned Unix socket. */
export interface NetworkTarget {
	address: string;
	port: number;
	socketPath?: string;
}

/** Structural protocol shared by exact Net guards and historical Web guards. */
export interface NetworkGuard {
	resolveTarget(host: string, port: number): Promise<NetworkTarget | undefined>;
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

/** @internal Shared transport teardown for the legacy loopback bridge. */
export const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise) => server.close(() => resolvePromise()));

/** Couple a tunnel before either peer can emit an unhandled Socket error. */
export function coupleSockets(left: Duplex, right: Duplex): { start: () => boolean } {
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

/** Pin the socket inode before connect; the shared directory is writable in Term.
 * O_PATH|O_NOFOLLOW plus the descriptor path prevents a symlink/replacement race
 * from turning a publication into access to a different host Unix socket. */
export function connectPublication(socketPath: string): Socket {
	if (process.platform !== "linux") throw new Error("Term publications require Linux");
	const descriptor = openSync(socketPath, 0x200000 /* Linux O_PATH */ | constants.O_NOFOLLOW);
	let closed = false;
	const close = () => { if (!closed) { closed = true; closeSync(descriptor); } };
	try {
		if (!fstatSync(descriptor).isSocket()) throw new Error("NET_PUBLICATION_INVALID_SOCKET");
		const socket = connect(`/proc/self/fd/${descriptor}`);
		socket.once("connect", close);
		socket.once("error", close);
		socket.once("close", close);
		return socket;
	} catch (error) { close(); throw error; }
}

export class NetworkBridge {
	private httpServer?: Server;
	private socksServer?: Server;
	private readonly sockets = new Set<Socket>();
	private bridges: ChildProcess[] = [];
	private directory?: string;
	httpSocket?: string;
	socksSocket?: string;

	constructor(private readonly guard: NetworkGuard) {}

	closeConnections(): void { for (const socket of this.sockets) socket.destroy(); }

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
				const target = await this.guard.resolveTarget(url.hostname, Number(url.port || 80));
				const address = target?.address;
				if (outgoing.destroyed) return;
				if (!address || url.protocol !== "http:") { outgoing.writeHead(403); outgoing.end("Blocked by Linden Net authority"); return; }
				upstream = request({ protocol: "http:", hostname: address, port: target!.port, ...(target?.socketPath ? { createConnection: () => connectPublication(target.socketPath!) } : {}), path: `${url.pathname}${url.search}`, method: incoming.method, headers: { ...incoming.headers, host: url.host } }, (response) => {
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
				const route = await this.guard.resolveTarget(target.hostname, port);
				const address = route?.address;
				if (client.destroyed || !address || !Number.isInteger(port) || port < 1 || port > 65535) { client.destroy(); return; }
				const upstream = route?.socketPath ? connectPublication(route.socketPath) : connect(route!.port, address);
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
		else if (data[3] === 4 && data.length >= 22) { host = Array.from({ length: 8 }, (_, index) => data.readUInt16BE(4 + index * 2).toString(16)).join(":"); offset = 20; }
		else { socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		if (data.length < offset + 2) { socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		const port = data.readUInt16BE(offset);
		const route = await this.guard.resolveTarget(host, port);
		const address = route?.address;
		if (socket.destroyed || !address || port < 1) { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
		const upstream = route?.socketPath ? connectPublication(route.socketPath) : connect(route!.port, address);
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
