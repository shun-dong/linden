import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAuthorityManager } from "../src/authority/manager.js";
import { DomainGuard, NetworkBridge, domainMatches, hostSelectorContains, privateAddress } from "../src/runtime/network.js";

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

const localGuard = { resolveAllowed: async () => "127.0.0.1" } as unknown as DomainGuard;

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

test("Web domain patterns match only the requested host boundary", () => {
	assert.equal(domainMatches("api.example.com", "*.example.com"), true);
	assert.equal(domainMatches("example.com", "*.example.com"), false);
	assert.equal(domainMatches("notexample.com", "*.example.com"), false);
	assert.equal(domainMatches("API.EXAMPLE.COM.", "api.example.com"), true);
	assert.equal(hostSelectorContains("*.example.com", "api.example.com"), true);
	assert.equal(hostSelectorContains("*.example.com", "*.api.example.com"), true);
	assert.equal(hostSelectorContains("api.example.com", "*.api.example.com"), false);
});

test("Web authority rejects non-public and IPv4-mapped addresses", async () => {
	for (const address of [
		"127.0.0.1",
		"100.64.0.1",
		"169.254.169.254",
		"224.0.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
	]) assert.equal(privateAddress(address), true, address);
	assert.equal(privateAddress("8.8.8.8"), false);
	assert.equal(privateAddress("2606:4700:4700::1111"), false);
	assert.equal(await new DomainGuard(["127.0.0.1"]).resolveAllowed("127.0.0.1"), undefined);
	assert.equal(await new DomainGuard(["8.8.8.8"]).resolveAllowed("8.8.8.8"), "8.8.8.8");
});

test("human Web authority is implicit while Agent grants move and return across a direct edge", async () => {
	const base = mkdtempSync(join(tmpdir(), "linden-web-v3-"));
	try {
		const manager = await SessionAuthorityManager.open({ base, stateDir: join(base, ".state"), lindenSessionId: "session:99999999-9999-9999-9999-999999999999" });
		const human = manager.rootParticipantId;
		const child = "agent:web-child";
		await manager.spawnWith(human, child, "web child", [], async () => ({ piSessionId: "web-child" }), { inheritWorkspaceRead: false });
		assert.deepEqual(manager.effectiveAuthority(human).webDomains, ["*"]);
		assert.deepEqual(manager.effectiveAuthority(child).webDomains, []);
		const web = manager.materializeWeb(human, "web:*.example.com/");
		await manager.give(human, child, web);
		assert.deepEqual(manager.effectiveAuthority(child).webDomains, ["*.example.com"]);
		const grandchild = "agent:web-grandchild";
		await manager.spawnWith(child, grandchild, "web grandchild", [], async () => ({ piSessionId: "web-grandchild" }), { inheritWorkspaceRead: false });
		const exact = manager.materializeWeb(child, "web:api.example.com/");
		await manager.give(child, grandchild, exact);
		assert.equal(manager.resource(exact)?.ownerId, grandchild);
		assert.throws(() => manager.materializeWeb(child, "web:other.test/"), /does not own a Web selector/);
		assert.throws(() => manager.materializeWeb(human, "web:v1.api.example.com/"), /does not own the most-specific Web selector/);
		await manager.get(human, child, web);
		assert.equal(manager.resource(web)?.ownerId, human);
		assert.equal(manager.resource(exact)?.ownerId, grandchild, "a broad get does not cross the child-grandchild edge");
		assert.throws(() => manager.materializeWeb(human, "web:example.com/private/path"), /URL paths/);
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
