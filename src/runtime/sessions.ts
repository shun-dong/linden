import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalBase, isInside } from "./paths.js";
import { atomicJson, lindenStateRoot, stateDirectory } from "./store.js";
import { normalizeMaxAgentDepth } from "./agent-depth.js";

export interface SessionManifest {
	schemaVersion: 4;
	id: string;
	base: string;
	/** Maximum number of Agent nodes on a root-to-participant path; absent means unlimited. */
	maxAgentDepth?: number;
	createdAt: number;
	lastOpenedAt: number;
}

interface ActiveLeaseRecord {
	schemaVersion: 1;
	sessionId: string;
	base: string;
	pid: number;
	token: string;
	updatedAt: number;
}

const sessionUuid = (sessionId: string): string => sessionId.replace(/^session:/, "");
const manifestPath = (root: string, sessionId: string): string => join(stateDirectory(sessionId, root), "session.json");

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error: any) { return error?.code === "EPERM"; }
}

export class SessionLease {
	private heartbeat?: ReturnType<typeof setInterval>;
	private released = false;

	constructor(private readonly path: string, private readonly record: ActiveLeaseRecord) {
		this.heartbeat = setInterval(() => this.touch(), 5_000);
		this.heartbeat.unref?.();
	}

	private touch(): void {
		if (this.released) return;
		try {
			const current = JSON.parse(readFileSync(this.path, "utf8")) as ActiveLeaseRecord;
			if (current.token !== this.record.token) return;
			this.record.updatedAt = Date.now();
			atomicJson(this.path, this.record);
		} catch { /* acquisition checks PID as well as heartbeat */ }
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		try {
			const current = JSON.parse(readFileSync(this.path, "utf8")) as ActiveLeaseRecord;
			if (current.token === this.record.token) rmSync(this.path, { force: true });
		} catch { /* already released or replaced */ }
	}
}

export class SessionRegistry {
	readonly root: string;
	readonly sessionsDir: string;
	readonly activeDir: string;
	private readonly guardDir: string;

	constructor(root = lindenStateRoot()) {
		this.root = root;
		this.sessionsDir = join(root, "sessions");
		this.activeDir = join(root, "active");
		this.guardDir = join(this.activeDir, ".registry-lock");
		mkdirSync(this.sessionsDir, { recursive: true });
		mkdirSync(this.activeDir, { recursive: true });
	}

	create(baseInput: string, requestedId?: string, options: { maxAgentDepth?: number } = {}): SessionManifest {
		const base = canonicalBase(baseInput);
		const maxAgentDepth = normalizeMaxAgentDepth(options.maxAgentDepth);
		const id = requestedId ?? `session:${randomUUID()}`;
		if (!/^session:[0-9a-f-]+$/i.test(id)) throw new Error(`Invalid Linden session ID ${id}`);
		const path = manifestPath(this.root, id);
		if (existsSync(path)) throw new Error(`Linden session ${id} already exists`);
		const timestamp = Date.now();
		const manifest: SessionManifest = { schemaVersion: 4, id, base, ...(maxAgentDepth === undefined ? {} : { maxAgentDepth }), createdAt: timestamp, lastOpenedAt: timestamp };
		atomicJson(path, manifest);
		return manifest;
	}

	list(): SessionManifest[] {
		if (!existsSync(this.sessionsDir)) return [];
		const result: SessionManifest[] = [];
		for (const name of readdirSync(this.sessionsDir)) {
			const path = join(this.sessionsDir, name, "session.json");
			if (!existsSync(path)) continue;
			try {
				const value = JSON.parse(readFileSync(path, "utf8")) as SessionManifest;
				if (value.schemaVersion === 4 && typeof value.id === "string" && typeof value.base === "string") {
					normalizeMaxAgentDepth(value.maxAgentDepth, "session maxAgentDepth");
					result.push(value);
				}
			} catch { /* damaged manifests are not resumable */ }
		}
		return result.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt || right.createdAt - left.createdAt);
	}

	resolve(reference: string): SessionManifest {
		const value = reference.trim();
		const sessions = this.list();
		const exact = sessions.find((session) => session.id === value);
		if (exact) return exact;
		const suffix = value.replace(/^session:/, "");
		const matches = sessions.filter((session) => sessionUuid(session.id).endsWith(suffix));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`Ambiguous Linden session suffix ${reference}: ${matches.map((session) => session.id).join(", ")}`);
		throw new Error(`Unknown Linden session ${reference}`);
	}

	touch(manifest: SessionManifest): SessionManifest {
		const next = { ...manifest, lastOpenedAt: Date.now() };
		atomicJson(manifestPath(this.root, manifest.id), next);
		return next;
	}

	acquire(manifest: SessionManifest): SessionLease {
		return this.withGuard(() => {
			const active = this.readActiveLeases();
			for (const item of active) {
				if (item.sessionId === manifest.id || isInside(item.base, manifest.base) || isInside(manifest.base, item.base)) {
					throw new Error(`ACTIVE_BASE_CONFLICT: ${manifest.base} overlaps active ${item.base} (${item.sessionId}, pid=${item.pid})`);
				}
			}
			const record: ActiveLeaseRecord = { schemaVersion: 1, sessionId: manifest.id, base: manifest.base, pid: process.pid, token: randomUUID(), updatedAt: Date.now() };
			const path = join(this.activeDir, `${sessionUuid(manifest.id)}.json`);
			atomicJson(path, record);
			return new SessionLease(path, record);
		});
	}

	private readActiveLeases(): ActiveLeaseRecord[] {
		const result: ActiveLeaseRecord[] = [];
		for (const name of readdirSync(this.activeDir)) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.activeDir, name);
			try {
				const record = JSON.parse(readFileSync(path, "utf8")) as ActiveLeaseRecord;
				const stale = !processAlive(record.pid) || Date.now() - record.updatedAt > 30_000;
				if (stale) { rmSync(path, { force: true }); continue; }
				result.push(record);
			} catch { rmSync(path, { force: true }); }
		}
		return result;
	}

	private withGuard<T>(operation: () => T): T {
		for (let attempt = 0; attempt < 100; attempt++) {
			try { mkdirSync(this.guardDir); break; }
			catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(this.guardDir).mtimeMs > 10_000) rmSync(this.guardDir, { recursive: true, force: true });
				} catch { /* another process released it */ }
				if (attempt === 99) throw new Error("Timed out acquiring Linden active-session registry");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		try { return operation(); }
		finally { rmSync(this.guardDir, { recursive: true, force: true }); }
	}
}
