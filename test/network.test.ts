import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/runtime/manager.js";
import { NetworkBridge, connectPublication, type NetworkGuard } from "../src/runtime/network-bridge.js";
import { NetGuard } from "../src/runtime/net-guard.js";

const listen = (server: Server): Promise<number> => new Promise((resolvePromise, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") reject(new Error("fixture server has no TCP address"));
		else resolvePromise(address.port);
	});
});

const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
	for (let index = 0; index < 200; index++) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new Error(message);
};

const localGuard: NetworkGuard = { resolveTarget: async (_host: string, port: number) => ({ address: "127.0.0.1", port }) };

function proxyRequest(socketPath: string, url: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const client = connect(socketPath);
		let output = "";
		client.once("error", reject);
		client.once("connect", () => client.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`));
		client.on("data", (chunk) => { output += chunk.toString(); });
		client.once("end", () => resolvePromise(output));
	});
}

test("publication broker pins a Unix socket and rejects symlink routes", { skip: process.platform !== "linux" }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "linden-publication-pin-"));
	const path = join(directory, "service.sock");
	const server = createHttpServer((_request, response) => response.end("published service"));
	await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(path, resolvePromise); });
	const endpoint = "net:tcp/dns/published.example:443";
	const guard = new NetGuard(() => ({ endpoints: [endpoint], exclusions: [] }), (id) => id === endpoint ? path : undefined);
	const bridge = new NetworkBridge(guard);
	await bridge.start();
	try {
		symlinkSync(path, join(directory, "alias.sock"));
		assert.throws(() => connectPublication(join(directory, "alias.sock")), /INVALID_SOCKET/);
		const response = await proxyRequest(bridge.httpSocket!, "http://published.example:443/");
		assert.match(response, /200 OK/);
		assert.match(response, /published service/);
		assert.match(await proxyRequest(bridge.httpSocket!, "http://published.example:444/"), /403 Forbidden/);
		assert.match(await proxyRequest(bridge.httpSocket!, "http://other.example:443/"), /403 Forbidden/);
	} finally {
		await bridge.stop();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		rmSync(directory, { recursive: true, force: true });
	}
});

function trackSocket(set: Set<Socket>, socket: Socket): void {
	set.add(socket);
	socket.on("error", () => {});
	socket.once("close", () => set.delete(socket));
}

function flood(socket: Socket): void {
	const chunk = Buffer.alloc(1024 * 1024, 65);
	const write = () => { while (!socket.destroyed && socket.write(chunk)) { /* fill until backpressure */ } };
	socket.on("drain", write);
	write();
}

test("NetGuard uses live exact/public authority and audits only allowed routes", async () => {
	const authority = { endpoints: ["net:tcp/public"], exclusions: ["net:tcp/8.8.8.8:443"] };
	const audit: Array<[string, string]> = [];
	const guard: NetworkGuard = new NetGuard(() => authority, undefined, (id, address) => audit.push([id, address]));
	assert.deepEqual(await guard.resolveTarget("8.8.8.8", 80), { address: "8.8.8.8", port: 80 });
	assert.equal(await guard.resolveTarget("8.8.8.8", 443), undefined);
	assert.equal(await guard.resolveTarget("127.0.0.1", 80), undefined);
	assert.equal(await guard.resolveTarget("8.8.8.8", 0), undefined);
	assert.equal(await guard.resolveTarget("8.8.8.8", 65536), undefined);

	authority.endpoints = ["net:tcp/127.0.0.1:80", "net:tcp/[::1]:443"];
	assert.deepEqual(await guard.resolveTarget("127.0.0.1", 80), { address: "127.0.0.1", port: 80 });
	assert.deepEqual(await guard.resolveTarget("[::1]", 443), { address: "::1", port: 443 });
	assert.equal(await guard.resolveTarget("127.0.0.1", 81), undefined);
	assert.equal(await guard.resolveTarget("8.8.8.8", 80), undefined);
	assert.deepEqual(audit, [["net:tcp/8.8.8.8:80", "8.8.8.8"], ["net:tcp/127.0.0.1:80", "127.0.0.1"], ["net:tcp/[::1]:443", "::1"]]);
});

test("Net publication lookup requires the exact canonical DNS/IP identity and port", async () => {
	const endpoint = "net:tcp/dns/published.example:443";
	const authority = { endpoints: [endpoint], exclusions: [] as string[] };
	const lookups: string[] = [];
	const audit: Array<[string, string]> = [];
	const guard = new NetGuard(() => authority, (id) => { lookups.push(id); return "/tmp/publication.sock"; }, (id, address) => audit.push([id, address]));
	assert.deepEqual(await guard.resolveTarget("PUBLISHED.EXAMPLE.", 443), { address: "127.0.0.1", port: 443, socketPath: "/tmp/publication.sock" });
	assert.equal(await guard.resolveTarget("published.example", 80), undefined);
	assert.equal(await guard.resolveTarget("127.0.0.1", 443), undefined);
	assert.equal(await guard.resolveTarget("other.example", 443), undefined);
	assert.deepEqual(lookups, [endpoint]);
	assert.deepEqual(audit, [[endpoint, "unix:/tmp/publication.sock"]]);
	authority.endpoints = [];
	assert.equal(await guard.resolveTarget("published.example", 443), undefined);
	assert.deepEqual(lookups, [endpoint], "revoked authority cannot consult a stale publication");
});

test("explicit DNS Net authority still rejects private answers", async () => {
	const audit: string[] = [];
	const guard = new NetGuard(() => ({ endpoints: ["net:tcp/dns/localhost:80"], exclusions: [] }), undefined, (id) => audit.push(id));
	assert.equal(await guard.resolveTarget("localhost", 80), undefined);
	assert.deepEqual(audit, []);
});

test("public Net authority is explicit and transfers only over direct edges", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-net-v7-"));
	try {
		const manager = await SessionAuthorityManager.open({ base, stateDir: join(base, ".state"), rootParticipantId: "human:net-test" });
		const human = manager.rootParticipantId;
		const child = "agent:net-child";
		await manager.spawnWith(human, child, "net child", [], async () => ({}), { inheritWorkspaceRead: false });
		assert.deepEqual(manager.effectiveAuthority(human).netEndpoints, ["net:tcp/public"]);
		assert.deepEqual(manager.effectiveAuthority(child).netEndpoints, []);
		await manager.give(human, child, "net:tcp/public");
		const endpoint = await manager.materializeNet(child, "net:tcp/dns/api.example.com:443");
		const grandchild = "agent:net-grandchild";
		await manager.spawnWith(child, grandchild, "net grandchild", [], async () => ({}), { inheritWorkspaceRead: false });
		await manager.give(child, grandchild, endpoint);
		await assert.rejects(manager.materializeNet(human, "net:tcp/dns/other.test:443"), /UNAUTHORIZED|complete Net/);
		await manager.get(human, child, "net:tcp/public");
		assert.equal(manager.ownerOf(endpoint), grandchild, "a broad get cannot skip the direct edge");
		assert.ok(manager.effectiveAuthority(human).netExclusions?.includes(endpoint));
		assert.throws(() => manager.materializeWeb(human, "web:example.com/"), /historical/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("plain HTTP downstream cancellation closes the upstream connection", async () => {
	const sockets = new Set<Socket>();
	const upstream = createHttpServer((_request, response) => {
		response.writeHead(200, { "content-length": String(1024 ** 3), connection: "close" });
		const chunk = Buffer.alloc(1024 * 1024, 65);
		const write = () => { while (!response.destroyed && response.write(chunk)) { /* fill until backpressure */ } };
		response.on("drain", write);
		write();
	});
	upstream.on("connection", (socket) => trackSocket(sockets, socket));
	const port = await listen(upstream);
	const bridge = new NetworkBridge(localGuard);
	await bridge.start();
	try {
		await new Promise<void>((resolvePromise, reject) => {
			const client = connect(bridge.httpSocket!);
			client.once("error", reject);
			client.once("connect", () => client.write(`GET http://allowed.example:${port}/ HTTP/1.1\r\nHost: allowed.example:${port}\r\nConnection: close\r\n\r\n`));
			client.once("data", () => { client.destroy(); resolvePromise(); });
		});
		await waitFor(() => sockets.size === 0, "plain HTTP upstream remained open after downstream cancellation");
	} finally {
		await bridge.stop();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
	}
});

test("CONNECT downstream cancellation is request-local and releases upstream", async () => {
	const sockets = new Set<Socket>();
	const upstream = createServer((socket) => { trackSocket(sockets, socket); flood(socket); });
	const port = await listen(upstream);
	const bridge = new NetworkBridge(localGuard);
	await bridge.start();
	try {
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise<void>((resolvePromise, reject) => {
				const client = connect(bridge.httpSocket!);
				client.once("error", reject);
				client.once("connect", () => client.write(`CONNECT allowed.example:${port} HTTP/1.1\r\nHost: allowed.example:${port}\r\n\r\n`));
				client.once("data", () => { client.destroy(); resolvePromise(); });
			});
		}
		await waitFor(() => sockets.size === 0, "CONNECT upstream remained open after downstream cancellation");
	} finally {
		await bridge.stop();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
	}
});

test("SOCKS downstream cancellation is request-local and releases upstream", async () => {
	const sockets = new Set<Socket>();
	const upstream = createServer((socket) => { trackSocket(sockets, socket); flood(socket); });
	const port = await listen(upstream);
	const bridge = new NetworkBridge(localGuard);
	await bridge.start();
	try {
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise<void>((resolvePromise, reject) => {
				const client = connect(bridge.socksSocket!);
				let stage = 0;
				client.once("error", reject);
				client.once("connect", () => client.write(Buffer.from([5, 1, 0])));
				client.on("data", () => {
					if (stage++ === 0) {
						const host = Buffer.from("allowed.example");
						const request = Buffer.alloc(7 + host.length);
						request.set([5, 1, 0, 3, host.length], 0);
						host.copy(request, 5);
						request.writeUInt16BE(port, 5 + host.length);
						client.write(request);
					} else { client.destroy(); resolvePromise(); }
				});
			});
		}
		await waitFor(() => sockets.size === 0, "SOCKS upstream remained open after downstream cancellation");
	} finally {
		await bridge.stop();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
	}
});
