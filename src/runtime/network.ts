/** Compatibility entry point. New Net transports depend on the structural guard protocol. */
export { hostSelectorContains } from "../compiler/judgment.js";
export { privateAddress } from "./net.js";
export { NetworkBridge, connectPublication, type NetworkGuard, type NetworkTarget } from "./network-bridge.js";
export {
	DomainGuard,
	LoopbackExposureBridge,
	domainMatches,
	resolveWebResourceReference,
	type WebResourceReference,
} from "./compat/network.js";
