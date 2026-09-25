#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkProgram } from "./compiler/index.js";

const path = process.argv[2];
if (!path) {
	console.error("Usage: linden-check <program.linden>");
	process.exitCode = 2;
} else {
	const absolute = resolve(path);
	const result = checkProgram(readFileSync(absolute, "utf8"), { allowCompleteDeclarations: true });
	if (result.diagnostics.length) {
		for (const diagnostic of result.diagnostics) {
			const { line, column } = diagnostic.span.start;
			console.error(`${absolute}:${line}:${column}: ${diagnostic.code}: ${diagnostic.message}`);
		}
		process.exitCode = 1;
	} else {
		console.log(JSON.stringify({ accepted: true, operations: result.ir }, null, 2));
	}
}
