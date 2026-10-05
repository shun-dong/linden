import { checkRuntimeCommand, probeBubblewrap } from "../src/runtime/capabilities.js";

/** Skip real sandbox tests for a diagnosed limitation, not a failed `which`. */
export async function sandboxRequirements(tools: readonly string[] = ["socat"]): Promise<{ available: boolean; skip: false | string }> {
	const sandbox = await probeBubblewrap();
	if (!sandbox.available) return { available: false, skip: `${sandbox.code}: ${sandbox.reason}` };
	for (const tool of tools) {
		const capability = await checkRuntimeCommand(tool, tool === "socat" ? ["-V"] : ["--version"]);
		if (!capability.available) return { available: false, skip: `${capability.code}: ${capability.reason}` };
	}
	return { available: true, skip: false };
}
