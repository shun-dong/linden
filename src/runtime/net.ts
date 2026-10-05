import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface NetEndpoint {
	id: string;
	host: string;
	port: number;
	dns: boolean;
	public: boolean;
}

export function netReference(input: string): NetEndpoint {
	if (input === "net:tcp/public") return { id: input, host: "public", port: 0, dns: false, public: true };
	const match = /^net:tcp\/(dns\/([^/:]+)|\[([^\]]+)\]|([^/:]+)):(\d+)$/.exec(input);
	if (!match) throw new Error(`Invalid Net reference ${input}`);
	const dns = !!match[2];
	let host = match[2] ?? match[3] ?? match[4];
	const port = Number(match[5]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Net port must be in 1..65535");
	if (dns) {
		host = domainToASCII(host.replace(/\.$/, "").toLowerCase());
		if (!host || host.length > 253 || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error(`Invalid DNS name ${input}`);
	} else {
		if (!isIP(host) || host.includes("%")) throw new Error(`Invalid IP address ${input}`);
		if (isIP(host) === 6) host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
	}
	return { id: `net:tcp/${dns ? `dns/${host}` : isIP(host) === 6 ? `[${host}]` : host}:${port}`, host, port, dns, public: false };
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
