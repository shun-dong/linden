import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_VERSION = "0.84.2";
const MARKER = "LINDEN_DETACH_PATCH_0_84_2";
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version !== PATCH_VERSION) {
	throw new Error(`Linden's detachable Pi patch supports ${PATCH_VERSION}, but ${packageJson.version} is installed; review the upstream InteractiveMode before upgrading.`);
}

function replaceOnce(source, before, after, label) {
	const first = source.indexOf(before);
	if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
		throw new Error(`Cannot apply Linden Pi detach patch: expected exactly one ${label} anchor.`);
	}
	return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

const interactivePath = join(packageRoot, "dist", "modes", "interactive", "interactive-mode.js");
let interactive = readFileSync(interactivePath, "utf8");
if (!interactive.includes(MARKER)) {
	interactive = replaceOnce(
		interactive,
		"    // Shutdown state\n    shutdownRequested = false;",
		`    // Shutdown state\n    shutdownRequested = false;\n    // ${MARKER}: return control to an embedding host without aborting the Agent.\n    detachRequested = false;\n    resolveDetach;\n    detachPromise = new Promise((resolve) => {\n        this.resolveDetach = resolve;\n    });`,
		"shutdown state",
	);
	interactive = replaceOnce(
		interactive,
		`        // Main interactive loop\n        while (true) {\n            const userInput = await this.getUserInput();\n            try {\n                await this.session.prompt(userInput);\n            }\n            catch (error) {\n                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";\n                this.showError(errorMessage);\n            }\n        }`,
		`        // Main interactive loop. The detach side of each race stops only this\n        // renderer; the in-flight Agent promise keeps running under the host.\n        while (!this.detachRequested) {\n            const input = await Promise.race([\n                this.getUserInput().then((value) => ({ kind: "input", value })),\n                this.detachPromise.then(() => ({ kind: "detach" })),\n            ]);\n            if (input.kind === "detach")\n                return;\n            const completion = this.session.prompt(input.value).then(\n                () => ({ kind: "complete" }),\n                (error) => ({ kind: "error", error }),\n            );\n            const result = await Promise.race([\n                completion,\n                this.detachPromise.then(() => ({ kind: "detach" })),\n            ]);\n            if (result.kind === "detach")\n                return;\n            if (result.kind === "error") {\n                const errorMessage = result.error instanceof Error ? result.error.message : "Unknown error occurred";\n                this.showError(errorMessage);\n            }\n        }`,
		"interactive loop",
	);
	interactive = replaceOnce(
		interactive,
		`            if (text === "/quit") {\n                this.editor.setText("");\n                await this.shutdown();\n                return;\n            }`,
		`            if (text === "/exit") {\n                this.editor.setText("");\n                if (this.options.detachable)\n                    this.detach();\n                else\n                    this.showWarning("/exit is available only when Pi is embedded by Linden");\n                return;\n            }\n            if (text === "/quit") {\n                this.editor.setText("");\n                await this.shutdown();\n                return;\n            }`,
		"quit command",
	);
	interactive = replaceOnce(
		interactive,
		`    emergencyTerminalExit() {`,
		`    detach() {\n        if (this.detachRequested)\n            return;\n        this.detachRequested = true;\n        this.onInputCallback = undefined;\n        this.resolveDetach?.();\n        this.resolveDetach = undefined;\n        this.stop();\n    }\n    emergencyTerminalExit() {`,
		"emergency terminal exit",
	);
	writeFileSync(interactivePath, interactive);
}

const typesPath = join(packageRoot, "dist", "modes", "interactive", "interactive-mode.d.ts");
let types = readFileSync(typesPath, "utf8");
if (!types.includes("detachable?: boolean")) {
	types = replaceOnce(
		types,
		"    /** Force verbose startup (overrides quietStartup setting) */\n    verbose?: boolean;",
		"    /** Force verbose startup (overrides quietStartup setting) */\n    verbose?: boolean;\n    /** Allow /exit to return to an embedding host without stopping the Agent session. */\n    detachable?: boolean;",
		"InteractiveModeOptions verbose field",
	);
	writeFileSync(typesPath, types);
}

const commandsPath = join(packageRoot, "dist", "core", "slash-commands.js");
let commands = readFileSync(commandsPath, "utf8");
if (!commands.includes('{ name: "exit", description: "Return to the Linden host without stopping this session" }')) {
	commands = replaceOnce(
		commands,
		`    { name: "quit", description: \`Quit \${APP_NAME}\` },`,
		`    { name: "exit", description: "Return to the Linden host without stopping this session" },\n    { name: "quit", description: \`Quit \${APP_NAME}\` },`,
		"quit slash command",
	);
	writeFileSync(commandsPath, commands);
}

console.log(`Applied Linden detachable Pi patch for ${packageJson.version}.`);
