import { netReference } from "./net.js";
import { canonicalCandidate, fileResourceId, isInside, type PathExpression } from "./paths.js";

export interface FilePermission {
	id: string;
	path: string;
	region: boolean;
	mode: "move" | "read";
}

export interface WriteReservation extends PathExpression { region: boolean }

export function filePermission(input: string, cwd: string): FilePermission {
	const mode = input.startsWith("&") ? "read" : "move";
	const typed = mode === "read" ? input.slice(1) : input;
	if (!typed.startsWith("file:") || typed.length === 5) throw new Error(`Expected file:<address>, got ${input}`);
	const address = typed.slice(5);
	if (address.includes("\\")) throw new Error("File references use '/' separators");
	const region = address.endsWith("/");
	const path = canonicalCandidate(address, cwd);
	return { id: fileResourceId(path, region), path, region, mode };
}

export function initialPermissions(inputs: readonly string[], cwd: string, noDefaults = false): string[] {
	const seen = new Set<string>();
	const result = inputs.map((input) => {
		const read = input.startsWith("&");
		const typed = read ? input.slice(1) : input;
		const id = typed.startsWith("net:") ? netReference(typed).id : filePermission(input, cwd).id;
		if (seen.has(id)) throw new Error(`Duplicate initial permission ${id}`);
		seen.add(id);
		return `${read ? "&" : ""}${id}`;
	});
	if (!noDefaults && !inputs.some((item) => item.replace(/^&/, "").startsWith("file:"))) result.push(fileResourceId(canonicalCandidate(cwd, cwd), true));
	if (!noDefaults && !inputs.some((item) => item.replace(/^&/, "").startsWith("net:"))) result.push("net:tcp/public");
	return result;
}

export function writeReservations(inputs: readonly string[], cwd: string): WriteReservation[] {
	const permissions = inputs.filter((item) => /^&?file:/.test(item)).map((item) => filePermission(item, cwd));
	return permissions.filter((item) => item.mode === "move").map((item) => ({
		include: item.path,
		region: item.region,
		exclude: item.region ? permissions.filter((child) => child.path !== item.path && isInside(child.path, item.path)).map((child) => child.path) : [],
	}));
}

/** Exact atoms never cover descendants; exclusions are region subtractions. */
export function writesOverlap(a: WriteReservation, b: WriteReservation): boolean {
	const candidate = a.include === b.include ? a.include
		: a.region && isInside(b.include, a.include) ? b.include
		: b.region && isInside(a.include, b.include) ? a.include : undefined;
	return candidate !== undefined && !a.exclude.some((path) => isInside(candidate, path)) && !b.exclude.some((path) => isInside(candidate, path));
}
