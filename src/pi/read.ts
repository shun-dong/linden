import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionAuthorityManager } from "../runtime/manager.js";

// Pi does not export its buffer sniffer at the package root. Resolve the
// version-pinned implementation rather than sniffing the live file a second time.
const mimeModule = import(new URL("./utils/mime.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as Promise<{ detectSupportedImageMimeType(bytes: Buffer): string | null }>;

export function authorizedReadTool(manager: SessionAuthorityManager, participantId: string, cwd: string): ReturnType<typeof createReadToolDefinition> {
	const native = createReadToolDefinition(cwd);
	return {
		...native,
		async execute(...args: Parameters<typeof native.execute>) {
			let authorizedPath: string | undefined;
			let view: Awaited<ReturnType<typeof manager.readFileBytes>> | undefined;
			// Keep Pi's complete definition, including its renderers and image pipeline.
			// Only filesystem operations change: all consume one authorized published
			// view so an open Bash/Term epoch cannot leak uncommitted image bytes.
			const tool = createReadToolDefinition(cwd, { operations: {
				async access(path) {
					view = await manager.readFileBytes(participantId, path);
					authorizedPath = path;
					if (view.state === "Absent") throw Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: "ENOENT" });
				},
				async readFile(path) {
					if (!view || authorizedPath !== path) throw new Error("Read view was not authorized");
					return view.content;
				},
				async detectImageMimeType(path) {
					if (!view || authorizedPath !== path) throw new Error("Read view was not authorized");
					return (await mimeModule).detectSupportedImageMimeType(view.content);
				},
			} });
			return tool.execute(...args);
		},
	};
}
