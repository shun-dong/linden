import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "native", "term-supervisor");
const targets = {
	x64: "x86_64-unknown-linux-gnu",
	arm64: "aarch64-unknown-linux-gnu",
};

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: crate,
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
		env: options.env ?? process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(command + " failed with status " + String(result.status)
			+ (options.capture ? ": " + (result.stderr || result.stdout || "").trim() : ""));
	}
	return result;
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

if (process.platform !== "linux") {
	console.log("Skipping the Linux-only Linden Term supervisor build on " + process.platform);
	process.exit(0);
}

const target = targets[process.arch];
if (!target) throw new Error("Unsupported Linux architecture for Term supervisor: " + process.arch);
const rustVerbose = run("rustc", ["-vV"], { capture: true }).stdout;
const host = /^host: (.+)$/m.exec(rustVerbose)?.[1];
if (host !== target) {
	throw new Error("Native static supervisor build requires host target " + target + ", got " + String(host));
}

const rustFlags = "-C target-feature=+crt-static -C link-arg=-Wl,--build-id=none";
run("cargo", ["build", "--release", "--locked", "--offline", "--target", target], {
	env: {
		...process.env,
		CARGO_INCREMENTAL: "0",
		SOURCE_DATE_EPOCH: "0",
		RUSTFLAGS: rustFlags,
	},
});

const built = join(crate, "target", target, "release", "linden-term-supervisor");
if (!existsSync(built)) throw new Error("Cargo did not produce " + built);
const programHeaders = run("readelf", ["-lW", built], { capture: true }).stdout;
const dynamicSection = run("readelf", ["-dW", built], { capture: true }).stdout;
if (/\bINTERP\b/.test(programHeaders) || /\(NEEDED\)/.test(dynamicSection)) {
	throw new Error("Term supervisor is dynamically linked; refusing to package it");
}
run(built, ["--version"], { capture: true });

const destination = join(crate, "bin", "linux-" + process.arch);
mkdirSync(destination, { recursive: true, mode: 0o755 });
const binary = join(destination, "linden-term-supervisor");
copyFileSync(built, binary);
chmodSync(binary, 0o755);

const sourceFiles = ["Cargo.toml", "Cargo.lock", join("src", "main.rs")];
const sourceHash = createHash("sha256");
for (const relative of sourceFiles) sourceHash.update(readFileSync(join(crate, relative)));
const bytes = readFileSync(binary);
const metadata = {
	schemaVersion: 1,
	name: "linden-term-supervisor",
	target,
	platform: process.platform,
	arch: process.arch,
	profile: "release",
	static: true,
	rustFlags,
	rustc: run("rustc", ["--version"], { capture: true }).stdout.trim(),
	cargo: run("cargo", ["--version"], { capture: true }).stdout.trim(),
	sourceSha256: sourceHash.digest("hex"),
	binarySha256: sha256(bytes),
	bytes: statSync(binary).size,
};
writeFileSync(
	join(destination, "build-metadata.json"),
	JSON.stringify(metadata, null, 2) + "\n",
	{ mode: 0o644 },
);
console.log("Built static Term supervisor: " + binary + " (" + metadata.bytes + " bytes, sha256 " + metadata.binarySha256 + ")");
