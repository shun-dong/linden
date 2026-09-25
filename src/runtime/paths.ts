import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** A normalized path capability: include one region and subtract exclusions. */
export interface PathExpression {
	include: string;
	exclude: string[];
}

export const isInside = (candidate: string, root: string): boolean => {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export function normalizePathExpression(include: string, exclusions: Iterable<string> = []): PathExpression {
	const normalized = [...new Set(exclusions)]
		.filter((candidate) => candidate !== include && isInside(candidate, include))
		.sort((left, right) => left.length - right.length)
		.filter((candidate, index, all) => !all.slice(0, index).some((parent) => isInside(candidate, parent)));
	return { include, exclude: normalized };
}

export function subtractPath(expression: PathExpression, exclusion: string): PathExpression {
	if (!isInside(exclusion, expression.include)) throw new Error(`${exclusion} is outside ${expression.include}`);
	if (exclusion === expression.include) return { include: expression.include, exclude: [expression.include] };
	return normalizePathExpression(expression.include, [...expression.exclude, exclusion]);
}

export function pathExpressionContains(expression: PathExpression, candidate: string): boolean {
	return isInside(candidate, expression.include) && !expression.exclude.some((excluded) => isInside(candidate, excluded));
}

export function intersectPath(expression: PathExpression, region: string): PathExpression | undefined {
	if (!isInside(region, expression.include)) return undefined;
	if (!pathExpressionContains(expression, region)) return undefined;
	return normalizePathExpression(region, expression.exclude.filter((excluded) => isInside(excluded, region)));
}

export function formatPathExpression(expression: PathExpression): string {
	return expression.exclude.length ? `${expression.include} - ${expression.exclude.join(" - ")}` : expression.include;
}

/**
 * Resolve through the nearest existing ancestor. This gives non-existent paths
 * the same namespace semantics as existing paths and blocks symlink traversal
 * through an ancestor without pretending to support arbitrary link mutation.
 */
export function canonicalCandidate(input: string, cwd: string): string {
	if (input.includes("\0")) throw new Error("Path contains a NUL byte");
	const expanded = input === "~" ? homedir() : input.startsWith(`~${sep}`) || input.startsWith("~/") || input.startsWith("~\\")
		? resolve(homedir(), input.slice(2))
		: input;
	let cursor = resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	const suffix: string[] = [];
	let cursorExists = existsSync(cursor);
	while (!cursorExists) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		cursor = parent;
		cursorExists = existsSync(cursor);
	}
	let base = cursor;
	if (cursorExists) {
		try { base = realpathSync.native(cursor); }
		catch (error: any) { throw new Error(`PATH_CANONICALIZATION_FAILED: ${input}: ${error?.code ?? error}`); }
	}
	return resolve(base, ...suffix);
}

export function canonicalWorkspace(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

/** Resolve and validate the immutable base of a Linden session. */
export function canonicalBase(path: string): string {
	const result = canonicalCandidate(path, process.cwd());
	if (!existsSync(result) || !statSync(result).isDirectory()) throw new Error(`Linden base must be an existing directory: ${path}`);
	return result;
}

/**
 * Resolve a public File address relative to cwd, then enforce the immutable
 * session base and the private Linden state boundary.
 */
export function resolvePublicPath(input: string, cwd: string, baseOrPrivateRoots: string | string[], maybePrivateRoots?: string | string[]): string {
	// The four-argument form is used with a manager's immutable canonical base;
	// avoid re-realpathing that same directory on every gateway call. The legacy
	// three-argument form still canonicalizes its cwd-derived base.
	const base = maybePrivateRoots === undefined ? canonicalWorkspace(cwd) : resolve(baseOrPrivateRoots as string);
	const privateRoots = maybePrivateRoots === undefined ? baseOrPrivateRoots : maybePrivateRoots;
	const result = canonicalCandidate(input, cwd);
	if (!isInside(result, base)) throw new Error(`PATH_OUTSIDE_BASE: ${input} resolves outside Linden base ${base}`);
	for (const privateRoot of Array.isArray(privateRoots) ? privateRoots : [privateRoots]) {
		if (isInside(result, privateRoot)) throw new Error(`Linden runtime state is not an addressable resource: ${input}`);
	}
	return result;
}

/** Stable, readable File identities use slash separators on every OS. */
export function fileResourceId(path: string, region = false): string {
	let address = path.replace(/\\/g, "/");
	if (/^[a-z]:\//i.test(address)) address = `${address[0].toUpperCase()}${address.slice(1)}`;
	address = address.replace(/\/+$/, "");
	return `file:${address}${region ? "/" : ""}`;
}

export function isFileResourceId(value: string): boolean { return value.startsWith("file:"); }

export interface FileResourceReference {
	address: string;
	region: boolean;
}

/**
 * Parse the typed, user-facing File resource syntax. The address portion may
 * be relative (including `.` and `~`) or absolute, but the `file:` kind is
 * mandatory. A trailing slash is the sole syntactic region marker.
 */
export function parseFileResourceReference(value: string): FileResourceReference {
	if (!value.startsWith("file:")) throw new Error(`RESOURCE_ID_REQUIRED: expected file:<address> or web:<selector>/, got ${value}`);
	const address = value.slice("file:".length);
	if (!address) throw new Error("INVALID_FILE_RESOURCE_ID: file: requires an address");
	if (address.includes("\\")) throw new Error("INVALID_FILE_RESOURCE_ID: use '/' separators in File resource IDs");
	const region = address.endsWith("/");
	if (region && address.length > 1 && !/^[A-Za-z]:\/$/.test(address) && address.slice(0, -1).endsWith("/")) {
		throw new Error(`INVALID_FILE_RESOURCE_ID: duplicate trailing slash in ${value}`);
	}
	const normalizedAddress = region && address !== "/" && !/^[A-Za-z]:\/$/.test(address)
		? address.slice(0, -1)
		: address;
	return { address: normalizedAddress, region };
}

/** Resolve a typed File reference to the one canonical ledger identity. */
export function resolveFileResourceReference(
	value: string,
	cwd: string,
	base: string,
	privateRoots: string | string[],
): { id: string; path: string; region: boolean } {
	const parsed = parseFileResourceReference(value);
	const path = resolvePublicPath(parsed.address, cwd, base, privateRoots);
	return { id: fileResourceId(path, parsed.region), path, region: parsed.region };
}
