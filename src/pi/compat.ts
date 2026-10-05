import type { SpawnParticipantKind } from "./participant-api.js";

/** Compatibility parser for the former attached Human spawn command. */
export interface ParsedHumanSpawn {
	kind: SpawnParticipantKind;
	name?: string;
	prompt?: string;
	grants: string[];
	inheritWorkspaceRead: boolean;
}

export function parseHumanSpawn(rest: string[]): ParsedHumanSpawn {
	const separator = rest.indexOf("--");
	const options = separator < 0 ? rest : rest.slice(0, separator);
	const promptParts: string[] = separator < 0 ? [] : rest.slice(separator + 1);
	const grants: string[] = [];
	let kind: SpawnParticipantKind = "agent";
	let name: string | undefined;
	let inheritWorkspaceRead = true;
	for (let index = 0; index < options.length;) {
		const flag = options[index++];
		if (flag === "--kind") {
			const value = options[index++];
			if (value !== "agent" && value !== "term") throw new Error("--kind must be agent or term");
			kind = value;
			continue;
		}
		if (flag === "--no-inherit-read" || flag === "--no-cwd-read" || flag === "--no-workspace-read") {
			inheritWorkspaceRead = false;
			continue;
		}
		if (flag === "--give") {
			const resource = options[index++];
			if (!resource) throw new Error(`Missing resource after ${flag}`);
			grants.push(resource);
			continue;
		}
		if (flag.startsWith("--")) throw new Error(`Unknown spawn option ${flag}`);
		if (name === undefined) { name = flag; continue; }
		if (separator < 0) { promptParts.push(flag, ...options.slice(index)); break; }
		throw new Error(`Unexpected spawn argument ${flag}; only one optional name is allowed before --`);
	}
	const prompt = promptParts.join(" ").trim() || undefined;
	return { kind, name, prompt, grants, inheritWorkspaceRead };
}
