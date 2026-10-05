import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainGuard } from "./compat/network.js";
import type { NetworkGuard, NetworkTarget } from "./network-bridge.js";
import { netReference, privateAddress } from "./net.js";

// Retain the historical superclass/resolveAllowed API for library callers.
// New transports depend only on NetworkGuard.resolveTarget, not DomainGuard.
export class NetGuard extends DomainGuard implements NetworkGuard {
	constructor(
		private readonly authority: () => { endpoints: string[]; exclusions: string[] },
		private readonly publication: (id: string) => string | undefined = () => undefined,
		private readonly audit: (id: string, address: string) => void = () => {},
	) { super([]); }

	override async resolveTarget(host: string, port: number): Promise<NetworkTarget | undefined> {
		const clean = host.replace(/^\[|\]$/g, "");
		let endpoint;
		try { endpoint = netReference(`net:tcp/${isIP(clean) ? isIP(clean) === 6 ? `[${clean}]` : clean : `dns/${clean}`}:${port}`); }
		catch { return undefined; }
		const permitted = () => {
			const { endpoints, exclusions } = this.authority();
			return endpoints.includes(endpoint.id) || (endpoints.includes("net:tcp/public") && !exclusions.includes(endpoint.id));
		};
		if (!permitted()) return undefined;
		const socketPath = this.publication(endpoint.id);
		if (socketPath) {
			this.audit(endpoint.id, `unix:${socketPath}`);
			return { address: "127.0.0.1", port, socketPath };
		}
		try {
			const answers = endpoint.dns ? await lookup(endpoint.host, { all: true, verbatim: true }) : [{ address: endpoint.host }];
			if (!answers.length || !permitted()) return undefined;
			const explicit = this.authority().endpoints.includes(endpoint.id);
			if ((endpoint.dns || !explicit) && answers.some(({ address }) => privateAddress(address))) return undefined;
			const address = answers[0].address;
			this.audit(endpoint.id, address);
			return { address, port };
		} catch { return undefined; }
	}
}
