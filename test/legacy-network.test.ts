import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import test from "node:test";
import { hostSelectorContains } from "../src/compiler/judgment.js";
import { DomainGuard, LoopbackExposureBridge, domainMatches, resolveWebResourceReference } from "../src/runtime/compat/network.js";
import { NetGuard } from "../src/runtime/net-guard.js";
import { NetworkBridge, connectPublication } from "../src/runtime/network-bridge.js";
import { privateAddress } from "../src/runtime/net.js";
import * as legacy from "../src/runtime/network.js";

const listen = (server: Server): Promise<number> => new Promise((resolvePromise, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", reject);
		const address = server.address();
		if (!address || typeof address === "string") reject(new Error("fixture server has no TCP address"));
		else resolvePromise(address.port);
	});
});
const close = (server: Server): Promise<void> => new Promise((resolvePromise) => server.close(() => resolvePromise()));

test("legacy network exports retain the canonical implementations", () => {
	assert.equal(legacy.DomainGuard, DomainGuard);
	assert.equal(legacy.LoopbackExposureBridge, LoopbackExposureBridge);
	assert.equal(legacy.domainMatches, domainMatches);
	assert.equal(legacy.resolveWebResourceReference, resolveWebResourceReference);
	assert.equal(legacy.hostSelectorContains, hostSelectorContains);
	assert.equal(legacy.privateAddress, privateAddress);
	assert.equal(legacy.NetworkBridge, NetworkBridge);
	assert.equal(legacy.connectPublication, connectPublication);
});

test("Web references retain canonical legacy identities and validation", () => {
	assert.deepEqual(resolveWebResourceReference(" web:API.EXAMPLE.COM/// "), { id: "web:api.example.com/", selector: "api.example.com" });
	assert.deepEqual(resolveWebResourceReference("*.Example.com/"), { id: "web:*.example.com/", selector: "*.example.com" });
	assert.deepEqual(resolveWebResourceReference("web:*/"), { id: "web:*/", selector: "*" });
	for (const reference of ["", "web:", "web:example.com/path", "https://example.com", "example.com:443", "foo*.example.com", "*.*.example.com", "*.", "-example.com", "example..com", `${"a".repeat(64)}.com`]) {
		assert.throws(() => resolveWebResourceReference(reference), /Web host selector|URL paths/, reference);
	}
});

test("Web host-selector containment has one compiler/runtime meaning", () => {
	const cases: Array<[string, string, boolean]> = [
		["*", "*", true],
		["*", "*.api.example.com", true],
		["*.example.com", "*.example.com", true],
		["*.example.com", "api.example.com", true],
		["*.example.com", "*.api.example.com", true],
		["*.api.example.com", "*.example.com", false],
		["*.example.com", "example.com", false],
		["*.example.com", "notexample.com", false],
		["*.example.com", "api.notexample.com", false],
		["*.example.com", "*.notexample.com", false],
		["api.example.com", "*.api.example.com", false],
		["api.example.com", "deep.api.example.com", false],
		["api.example.com", "*", false],
		["API.EXAMPLE.COM.", "api.example.com", true],
		["*.EXAMPLE.COM.", "Api.Example.Com.", true],
		["*.com", "*.example.com", true],
		["*.example.com", "*.com", false],
	];
	for (const [parent, child, expected] of cases) {
		assert.equal(hostSelectorContains(parent, child), expected, `${parent} contains ${child}`);
		assert.equal(legacy.hostSelectorContains(parent, child), expected);
		if (!child.includes("*")) assert.equal(domainMatches(child, parent), expected);
	}
	assert.equal(domainMatches("API.EXAMPLE.COM.", "api.example.com"), true);
	assert.equal(domainMatches("example.com", "*.example.com"), false);
});

test("Web authority still rejects non-public and IPv4-mapped addresses", async () => {
	for (const address of ["127.0.0.1", "100.64.0.1", "169.254.169.254", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "not-an-ip"]) {
		assert.equal(privateAddress(address), true, address);
	}
	assert.equal(privateAddress("8.8.8.8"), false);
	assert.equal(privateAddress("2606:4700:4700::1111"), false);
	assert.equal(await new DomainGuard(["127.0.0.1"]).resolveAllowed("127.0.0.1"), undefined);
	assert.equal(await new DomainGuard(["8.8.8.8"]).resolveAllowed("8.8.8.8"), "8.8.8.8");
	assert.deepEqual(await new DomainGuard(["8.8.8.8"]).resolveTarget("8.8.8.8", 8443), { address: "8.8.8.8", port: 8443 });
	assert.equal(await new DomainGuard(["8.8.8.8"]).resolveTarget("1.1.1.1", 8443), undefined);
});

test("NetGuard retains the legacy superclass API without using it for exact routes", async () => {
	const guard = new NetGuard(() => ({ endpoints: ["net:tcp/127.0.0.1:8080"], exclusions: [] }));
	assert.ok(guard instanceof DomainGuard);
	assert.equal(await guard.resolveAllowed("8.8.8.8"), undefined);
	assert.deepEqual(await guard.resolveTarget("127.0.0.1", 8080), { address: "127.0.0.1", port: 8080 });
});

test("legacy loopback ports retain validation and an empty bridge stays inert", async () => {
	for (const ports of [[0], [65536], [1.5], [8080, 8080]]) assert.throws(() => new LoopbackExposureBridge(ports), /unique TCP ports/);
	const bridge = new LoopbackExposureBridge([]);
	await bridge.start();
	assert.equal(bridge.directory, undefined);
	assert.deepEqual(bridge.activePorts(), []);
	assert.throws(() => bridge.socketPath(8080), /not prepared/);
	await bridge.stop();
});

test("legacy loopback exposure remains lazy, forwards Unix traffic, and tears down", { timeout: 5000 }, async () => {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const bridge = new LoopbackExposureBridge([port]);
	const sockets = new Set<Socket>();
	const service = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
		socket.pipe(socket);
	});
	await bridge.start();
	const directory = bridge.directory!;
	try {
		if (process.platform === "linux") assert.match(directory, /^\/tmp\/linden-term-expose-/);
		assert.deepEqual(bridge.activePorts(), []);
		assert.throws(() => bridge.socketPath(port === 65535 ? 65534 : port + 1), /not prepared/);
		await new Promise<void>((resolvePromise, reject) => {
			service.once("error", reject);
			service.listen(bridge.socketPath(port), () => { service.off("error", reject); resolvePromise(); });
		});
		for (let attempt = 0; attempt < 100 && !bridge.activePorts().includes(port); attempt++) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		assert.deepEqual(bridge.activePorts(), [port]);
		const result = await new Promise<string>((resolvePromise, reject) => {
			const socket = connect(port, "127.0.0.1");
			let output = "";
			socket.once("error", reject);
			socket.once("connect", () => socket.write("legacy loopback"));
			socket.on("data", (data) => {
				output += data.toString();
				if (output.length >= "legacy loopback".length) { socket.destroy(); resolvePromise(output); }
			});
		});
		assert.equal(result, "legacy loopback");
	} finally {
		await bridge.stop();
		for (const socket of sockets) socket.destroy();
		if (service.listening) await close(service);
	}
	assert.equal(bridge.directory, undefined);
	assert.deepEqual(bridge.activePorts(), []);
	assert.equal(existsSync(directory), false);
});
