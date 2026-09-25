import { formatPathExpression, intersectPath, normalizePathExpression, resolveLogicalPath, subtractPath, type PathExpression } from "./judgment.js";
import type { Atom, BindingForm, OperationExpression, Program, SourceSpan } from "./ast.js";
import { parse } from "./parser.js";

export type ParticipantKindName = "Human" | "Agent" | "Term";
export type ParticipantLifecycle = "running" | "ready" | "stopped";
export type CompleteKind = "File" | "Web" | ParticipantKindName;
export type ValueType =
	| { kind: "complete"; resource: CompleteKind; identity: string; path?: PathExpression }
	| { kind: "pointer"; resource: CompleteKind; identity: string; role?: "child" | "descendant" | "parent"; peer?: string; path?: PathExpression }
	| { kind: "string" }
	| { kind: "unit" }
	| { kind: "file-state" }
	| { kind: "state-list"; scope: string; resource: CompleteKind }
	| { kind: "state-id"; scope: string; resource: CompleteKind };

export interface CompilerBinding {
	name: string;
	type: ValueType;
	live: boolean;
	declaredAt: SourceSpan;
}

export type CompilerDiagnosticCode =
	| "UNKNOWN_TYPE"
	| "UNKNOWN_BINDING"
	| "TYPE_MISMATCH"
	| "USE_AFTER_MOVE"
	| "LIVE_LINEAR_REBIND"
	| "DISCARDED_LINEAR_VALUE"
	| "ROLE_FORGERY"
	| "ROLE_MISMATCH"
	| "STATE_SCOPE_MISMATCH"
	| "STATE_NOT_AVAILABLE"
	| "LIFECYCLE_MISMATCH"
	| "PRIVILEGE_MARKER_REQUIRED"
	| "PRIVILEGE_MARKER_FORBIDDEN"
	| "ARITY_MISMATCH"
	| "PATH_NOT_STATIC"
	| "PATH_OUTSIDE_REGION"
	| "UNKNOWN_OPERATION";

export interface CompilerDiagnostic {
	code: CompilerDiagnosticCode | "PARSE_ERROR";
	message: string;
	span: SourceSpan;
	notes?: string[];
}

export interface CheckedOperationIR {
	participant: string;
	operation: string;
	privileged: boolean;
	consumes: string[];
	preserves: string[];
	produces: ValueType;
	dependencies: string[];
	/** Typed references only. Literal/String adapter parameters are intentionally absent. */
	arguments: Array<{ kind: "resource" | "state"; identity: string }>;
	span: SourceSpan;
}

export interface ProgramCheckOptions {
	participant?: string;
	participantKind?: ParticipantKindName;
	initialBindings?: Record<string, ValueType>;
	allowCompleteDeclarations?: boolean;
	versionedResources?: Iterable<string>;
	availableStateIds?: Record<string, Iterable<string>>;
	/** Runtime lifecycle evidence used to discharge exec/input preconditions. */
	participantStatuses?: Record<string, ParticipantLifecycle>;
	base?: string;
	/** Deprecated compiler input alias. */
	workspace?: string;
}

export interface ProgramCheckResult {
	program: Program;
	ir: CheckedOperationIR[];
	diagnostics: CompilerDiagnostic[];
	environment: ReadonlyMap<string, CompilerBinding>;
}

interface Evaluated {
	type: ValueType;
	consumes: Set<string>;
	preserves: Set<string>;
	dependencies: Set<string>;
	residuals: Map<string, PathExpression>;
}

const completeKinds = new Set<CompleteKind>(["File", "Web", "Human", "Agent", "Term"]);
const participantKinds = new Set<ParticipantKindName>(["Human", "Agent", "Term"]);
const isComplete = (type: ValueType): type is Extract<ValueType, { kind: "complete" }> => type.kind === "complete";
const objectName = (type: Extract<ValueType, { kind: "complete" | "pointer" }>): string => {
	if (type.resource === "File" && type.path) return `File(${formatPathExpression(type.path)})`;
	return type.resource;
};
const typeName = (type: ValueType): string => {
	if (type.kind === "complete") return objectName(type);
	if (type.kind === "pointer") return `&${type.role === "child" ? ">" : type.role === "descendant" ? ">>" : type.role === "parent" ? "<" : ""}${objectName(type)}`;
	if (type.kind === "state-id") return `StateId<${type.scope}>`;
	if (type.kind === "state-list") return `StateList<${type.scope}>`;
	return type.kind === "string" ? "String" : type.kind === "file-state" ? "State_File" : "Unit";
};

const typeShape = (type: ValueType): string => type.kind === "complete" ? `complete:${objectName(type)}` : type.kind === "pointer" ? `pointer:${type.role ?? "plain"}:${objectName(type)}` : typeName(type);
const samePath = (left?: PathExpression, right?: PathExpression): boolean => !left && !right || !!left && !!right && left.include === right.include && left.exclude.join("\0") === right.exclude.join("\0");
function sameType(left: ValueType, right: ValueType): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "string" || left.kind === "unit" || left.kind === "file-state") return true;
	if (left.kind === "complete" && right.kind === "complete") return left.resource === right.resource && left.identity === right.identity && samePath(left.path, right.path);
	if (left.kind === "pointer" && right.kind === "pointer") return left.resource === right.resource && left.identity === right.identity && left.role === right.role && samePath(left.path, right.path);
	if (left.kind === "state-id" && right.kind === "state-id") return left.resource === right.resource && left.scope === right.scope;
	if (left.kind === "state-list" && right.kind === "state-list") return left.resource === right.resource && left.scope === right.scope;
	return false;
}

function normalizeInitialName(name: string): string { return name.replace(/^&(?:>>|[<>])?/, ""); }

export class ProgramChecker {
	private readonly bindings = new Map<string, CompilerBinding>();
	private readonly diagnostics: CompilerDiagnostic[] = [];
	private readonly ir: CheckedOperationIR[] = [];
	private readonly versioned: Set<string>;
	private readonly stateIds = new Map<string, Set<string>>();
	private readonly participant: string;
	private readonly participantKind: ParticipantKindName;

	constructor(private readonly options: ProgramCheckOptions = {}) {
		this.participant = options.participant ?? "participant:main";
		this.participantKind = options.participantKind ?? "Agent";
		this.versioned = new Set(options.versionedResources ?? []);
		for (const [scope, ids] of Object.entries(options.availableStateIds ?? {})) this.stateIds.set(scope, new Set(ids));
		for (const [rawName, type] of Object.entries(options.initialBindings ?? {})) {
			const name = normalizeInitialName(rawName);
			this.bindings.set(name, { name, type, live: true, declaredAt: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } } });
		}
	}

	check(program: Program): ProgramCheckResult {
		for (const statement of program.statements) {
			if (statement.kind === "declaration") this.checkDeclaration(statement.binding.form, statement.binding.name, statement.annotation, statement.span);
			else if (statement.kind === "assignment") this.checkAssignment(statement.binding.form, statement.binding.name, statement.annotation, statement.expression, statement.span);
			else this.checkCommand(statement.expression);
		}
		return { program, ir: this.ir, diagnostics: this.diagnostics, environment: new Map(this.bindings) };
	}

	private report(code: CompilerDiagnosticCode, message: string, span: SourceSpan, notes?: string[]): undefined {
		this.diagnostics.push({ code, message, span, notes });
		return undefined;
	}

	private resolveScopeName(raw: string, span: SourceSpan): { scope: string; resource: CompleteKind } | undefined {
		const binding = this.bindings.get(raw);
		if (!binding) return this.report("UNKNOWN_BINDING", `Unknown state scope ${raw}`, span);
		if (!binding.live) return this.report("USE_AFTER_MOVE", `State scope ${raw} is no longer live`, span);
		if (binding.type.kind !== "complete" && binding.type.kind !== "pointer") return this.report("TYPE_MISMATCH", `${raw} does not name a resource`, span);
		return { scope: binding.type.identity, resource: binding.type.resource };
	}

	private parseType(annotation: string, bindingName: string, span: SourceSpan): ValueType | undefined {
		const path = /^(&)?File\((["'])(.*)\2\)$/.exec(annotation);
		if (path) {
			const raw = path[3].replace(/\\(["'\\])/g, "$1");
			const region = normalizePathExpression(resolveLogicalPath(this.options.base ?? this.options.workspace ?? "/workspace", raw));
			return path[1]
				? { kind: "pointer", resource: "File", identity: bindingName, path: region }
				: { kind: "complete", resource: "File", identity: bindingName, path: region };
		}
		if (completeKinds.has(annotation as CompleteKind)) return { kind: "complete", resource: annotation as CompleteKind, identity: bindingName };
		if (annotation === "String") return { kind: "string" };
		if (annotation === "Unit" || annotation === "1") return { kind: "unit" };
		const pointer = /^&((?:>>|>|<)?)(File|Web|Human|Agent|Term)$/.exec(annotation);
		if (pointer) {
			const role = pointer[1] === ">" ? "child" : pointer[1] === ">>" ? "descendant" : pointer[1] === "<" ? "parent" : undefined;
			return { kind: "pointer", resource: pointer[2] as CompleteKind, identity: bindingName, role, peer: role ? bindingName : undefined };
		}
		const state = /^(StateId|StateList)<([\p{L}\p{N}_-]+)>$/u.exec(annotation);
		if (state) {
			const resolved = this.resolveScopeName(state[2], span);
			if (!resolved) return undefined;
			return { kind: state[1] === "StateId" ? "state-id" : "state-list", scope: resolved.scope, resource: resolved.resource };
		}
		return this.report("UNKNOWN_TYPE", `Unknown type ${annotation}`, span);
	}

	private checkDeclaration(form: BindingForm, name: string, annotation: string, span: SourceSpan): void {
		const existing = this.bindings.get(name);
		const type = this.parseType(annotation, name, span);
		if (!type) return;
		const roleSigil = type.kind === "pointer" && type.role === "child" ? ">" : type.kind === "pointer" && type.role === "descendant" ? ">>" : type.kind === "pointer" && type.role === "parent" ? "<" : "";
		const supplied = this.options.initialBindings?.[name] ?? this.options.initialBindings?.[`&${roleSigil}${name}`];
		if (existing && supplied) {
			if (typeShape(existing.type) !== typeShape(type)) this.report("TYPE_MISMATCH", `Runtime binding ${name} has type ${typeName(existing.type)}, not ${annotation}`, span);
			return;
		}
		const formRole = form === "child-role" ? "child" : form === "descendant-role" ? "descendant" : form === "parent-role" ? "parent" : undefined;
		if (formRole && !(type.kind === "pointer" && type.role === formRole)) {
			this.report("TYPE_MISMATCH", `Binding sigil does not match ${annotation}`, span);
			return;
		}
		if (type.kind === "pointer" && type.role && !supplied) {
			this.report("ROLE_FORGERY", `Role pointer ${name} must be supplied by spawn!, not declared by source`, span);
			return;
		}
		if (isComplete(type) && !this.options.allowCompleteDeclarations && !this.options.initialBindings?.[name]) {
			this.report("TYPE_MISMATCH", `Complete binding ${name} must be supplied by the participant state`, span);
			return;
		}
		if (existing?.live && isComplete(existing.type)) {
			this.report("LIVE_LINEAR_REBIND", `Cannot redeclare live complete binding ${name}`, span);
			return;
		}
		this.bindings.set(name, { name, type, live: true, declaredAt: span });
	}

	private checkAssignment(form: BindingForm, name: string, annotation: string | undefined, expression: OperationExpression, span: SourceSpan): void {
		const evaluated = this.evaluateOperation(expression, name);
		if (!evaluated) return;
		const expected = annotation ? this.parseType(annotation, name, span) : undefined;
		if (annotation && !expected) return;
		if (expected && !sameType(expected, evaluated.type)) {
			this.report("TYPE_MISMATCH", `Expected ${typeName(expected)}, received ${typeName(evaluated.type)}`, span);
			return;
		}
		const formRole = form === "child-role" ? "child" : form === "descendant-role" ? "descendant" : form === "parent-role" ? "parent" : undefined;
		if (formRole && !(evaluated.type.kind === "pointer" && evaluated.type.role === formRole)) {
			this.report("TYPE_MISMATCH", `Binding ${name} cannot hold ${typeName(evaluated.type)}`, span);
			return;
		}
		const existing = this.bindings.get(name);
		if (existing?.live && isComplete(existing.type) && !evaluated.consumes.has(name)) {
			this.report("LIVE_LINEAR_REBIND", `Assignment would overwrite live complete binding ${name}`, span, ["Consume the old binding in the right-hand side before reusing its name."]);
			return;
		}
		this.commitResiduals(evaluated.residuals);
		this.commitConsumption(evaluated.consumes);
		let resultType = evaluated.type;
		if (expression.name === "spawn" && resultType.kind === "pointer" && resultType.role === "child") {
			const prefix = resultType.resource.toLowerCase();
			resultType = { ...resultType, identity: `${prefix}:${name}`, peer: `${prefix}:${name}` };
		}
		this.bindings.set(name, { name, type: resultType, live: true, declaredAt: span });
		this.emitIR(expression, evaluated);
	}

	private checkCommand(expression: OperationExpression): void {
		const evaluated = this.evaluateOperation(expression);
		if (!evaluated) return;
		if (isComplete(evaluated.type)) {
			this.report("DISCARDED_LINEAR_VALUE", `${expression.name} returns a complete ${evaluated.type.resource}; bind the result`, expression.span);
			return;
		}
		this.commitResiduals(evaluated.residuals);
		this.commitConsumption(evaluated.consumes);
		this.emitIR(expression, evaluated);
	}

	private emitIR(expression: OperationExpression, evaluated: Evaluated): void {
		const historyIdentity = (name: string): string | undefined => {
			const type = this.bindings.get(name)?.type;
			if (type?.kind === "complete" || type?.kind === "pointer") return type.identity;
			if (type?.kind === "state-id" || type?.kind === "state-list") return type.scope;
			return undefined;
		};
		this.ir.push({
			participant: this.participant,
			operation: expression.name,
			privileged: expression.privileged,
			consumes: [...evaluated.consumes].map(historyIdentity).filter((identity): identity is string => !!identity),
			preserves: [...evaluated.preserves].map(historyIdentity).filter((identity): identity is string => !!identity),
			produces: evaluated.type,
			dependencies: [...evaluated.dependencies],
			arguments: expression.arguments.reduce<CheckedOperationIR["arguments"]>((references, argument) => {
				if (argument.kind !== "identifier" && argument.kind !== "pointer") return references;
				const type = this.bindings.get(argument.name)?.type;
				if (type?.kind === "complete" || type?.kind === "pointer") references.push({ kind: "resource", identity: type.identity });
				else if (type?.kind === "state-id" || type?.kind === "state-list") references.push({ kind: "state", identity: type.scope });
				return references;
			}, []),
			span: expression.span,
		});
	}

	private commitConsumption(names: Set<string>): void {
		for (const name of names) {
			const binding = this.bindings.get(name);
			if (binding) binding.live = false;
		}
	}

	private commitResiduals(residuals: Map<string, PathExpression>): void {
		for (const [name, path] of residuals) {
			const binding = this.bindings.get(name);
			if (binding && (binding.type.kind === "complete" || binding.type.kind === "pointer")) binding.type = { ...binding.type, path };
		}
	}

	private atom(atom: Atom, expected?: "string" | "complete" | "pointer" | "participant" | "agent" | "term" | "communicator" | "state-id" | "state-list"): { type: ValueType; binding?: string } | undefined {
		if (atom.kind === "string") {
			const result = { type: { kind: "string" } as ValueType };
			if (expected && expected !== "string") return this.report("TYPE_MISMATCH", `Expected ${expected}, received String`, atom.span);
			return result;
		}
		if (atom.kind === "number") return this.report("TYPE_MISMATCH", "Numbers are only meta-level values in the current surface language", atom.span);
		const binding = this.bindings.get(atom.name);
		if (!binding) return this.report("UNKNOWN_BINDING", `Unknown binding ${atom.name}`, atom.span);
		if (!binding.live) return this.report("USE_AFTER_MOVE", `Binding ${atom.name} was already consumed`, atom.span);
		let type = binding.type;
		if (atom.kind === "pointer") {
			if (atom.form === "plain") {
				if (type.kind === "complete") type = { kind: "pointer", resource: type.resource, identity: type.identity, path: type.path };
				else if (type.kind !== "pointer" || type.role) return this.report("TYPE_MISMATCH", `${atom.name} cannot be projected as an ordinary pointer`, atom.span);
			} else {
				const role = atom.form === "child-role" ? "child" : atom.form === "descendant-role" ? "descendant" : "parent";
				if (type.kind !== "pointer" || !participantKinds.has(type.resource as ParticipantKindName) || type.role !== role) return this.report("ROLE_MISMATCH", `${atom.name} is not a ${role} participant role pointer`, atom.span);
			}
		}
		if (expected === "string" && type.kind !== "string") return this.report("TYPE_MISMATCH", `Expected String, received ${typeName(type)}`, atom.span);
		if (expected === "complete" && type.kind !== "complete") return this.report("TYPE_MISMATCH", `Expected a complete resource, received ${typeName(type)}`, atom.span);
		if (expected === "pointer" && type.kind !== "pointer") return this.report("TYPE_MISMATCH", `Expected a pointer, received ${typeName(type)}`, atom.span);
		if (expected === "participant" && !(type.kind === "pointer" && participantKinds.has(type.resource as ParticipantKindName))) return this.report("TYPE_MISMATCH", `Expected a participant pointer, received ${typeName(type)}`, atom.span);
		if (expected === "agent" && !(type.kind === "pointer" && type.resource === "Agent")) return this.report("TYPE_MISMATCH", `Expected an Agent pointer, received ${typeName(type)}`, atom.span);
		if (expected === "term" && !(type.kind === "pointer" && type.resource === "Term")) return this.report("TYPE_MISMATCH", `Expected a Term pointer, received ${typeName(type)}`, atom.span);
		if (expected === "communicator" && !(type.kind === "pointer" && (type.resource === "Human" || type.resource === "Agent"))) return this.report("TYPE_MISMATCH", `Expected a Human or Agent pointer, received ${typeName(type)}`, atom.span);
		if (expected === "state-id" && type.kind !== "state-id") return this.report("TYPE_MISMATCH", `Expected StateId, received ${typeName(type)}`, atom.span);
		if (expected === "state-list" && type.kind !== "state-list") return this.report("TYPE_MISMATCH", `Expected a state list, received ${typeName(type)}`, atom.span);
		return { type, binding: atom.name };
	}

	private requireArity(expression: OperationExpression, min: number, max = min): boolean {
		if (expression.arguments.length >= min && expression.arguments.length <= max) return true;
		this.report("ARITY_MISMATCH", `${expression.name} expects ${min === max ? min : `${min}-${max}`} arguments, received ${expression.arguments.length}`, expression.span);
		return false;
	}

	private requirePrivilege(expression: OperationExpression, required: boolean): boolean {
		if (required === expression.privileged) return true;
		this.report(required ? "PRIVILEGE_MARKER_REQUIRED" : "PRIVILEGE_MARKER_FORBIDDEN", `${expression.name}${required ? " requires" : " does not accept"} !`, expression.operationSpan);
		return false;
	}

	private evaluateOperation(expression: OperationExpression, resultName?: string): Evaluated | undefined {
		const consumes = new Set<string>();
		const preserves = new Set<string>();
		const dependencies = new Set<string>();
		const residuals = new Map<string, PathExpression>();
		const use = (index: number, expected?: Parameters<ProgramChecker["atom"]>[1]) => this.atom(expression.arguments[index], expected);
		const preserve = (value?: { type: ValueType; binding?: string }) => { if (value?.binding) preserves.add(value.binding); return value; };
		const consume = (value?: { type: ValueType; binding?: string }) => { if (value?.binding) consumes.add(value.binding); return value; };
		const result = (type: ValueType): Evaluated => ({ type, consumes, preserves, dependencies, residuals });

		switch (expression.name) {
			case "subpath":
			case "file": {
				if (!this.requireArity(expression, 2)) return undefined;
				const writable = expression.privileged;
				const base = preserve(use(0, writable ? "complete" : "pointer"));
				if (!base) return undefined;
				if (base.type.kind !== (writable ? "complete" : "pointer")) return this.report("TYPE_MISMATCH", `${expression.name}${writable ? "!" : ""} requires ${writable ? "a File region" : "a &File region"}`, expression.arguments[0].span);
				if (base.type.resource !== "File" || (base.type.kind === "pointer" && base.type.role)) return this.report("TYPE_MISMATCH", `${expression.name}${writable ? "!" : ""} requires ${writable ? "a File region" : "a &File region"}`, expression.arguments[0].span);
				const literal = expression.arguments[1];
				if (literal?.kind !== "string") {
					return this.report("PATH_NOT_STATIC", `${expression.name} requires a literal relative path`, literal?.span ?? expression.span);
				}
				const path = base.type.path;
				if (!path) return this.report("TYPE_MISMATCH", `${expression.name} requires a region-qualified File(π)`, expression.arguments[0].span);
				const target = resolveLogicalPath(path.include, literal.value);
				if (target === path.include) return this.report("PATH_OUTSIDE_REGION", `${target} is not a strict refinement of ${formatPathExpression(path)}`, literal.span);
				const refined = intersectPath(path, target);
				if (!refined) return this.report("PATH_OUTSIDE_REGION", `${target} is outside ${formatPathExpression(path)}`, literal.span);
				if (writable && base.binding) residuals.set(base.binding, subtractPath(path, target));
				const resultPath = expression.name === "file" ? normalizePathExpression(target) : refined;
				const identity = resultName ?? `${expression.name}:${target}`;
				return writable
					? result({ kind: "complete", resource: "File", identity, path: resultPath })
					: result({ kind: "pointer", resource: "File", identity, path: resultPath });
			}
			case "stat": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const file = preserve(use(0, "pointer"));
				if (!file) return undefined;
				if (file.type.kind !== "pointer" || file.type.resource !== "File" || file.type.role) return this.report("TYPE_MISMATCH", "stat requires &File", expression.arguments[0].span);
				return result({ kind: "file-state" });
			}
			case "read": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const value = preserve(use(0, "pointer"));
				if (!value || value.type.kind !== "pointer" || value.type.resource !== "File" || value.type.role) return value ? this.report("TYPE_MISMATCH", "read requires &File", expression.arguments[0].span) : undefined;
				return result({ kind: "file-state" });
			}
			case "write":
			case "edit": {
				const arity = expression.name === "write" ? 2 : 3;
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, arity)) return undefined;
				const file = consume(use(0, "complete"));
				if (!file || file.type.kind !== "complete" || file.type.resource !== "File") return file ? this.report("TYPE_MISMATCH", `${expression.name} requires a complete File`, expression.arguments[0].span) : undefined;
				for (let index = 1; index < arity; index++) if (!preserve(use(index, "string"))) return undefined;
				return result(file.type);
			}
			case "listen": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const target = preserve(use(0, "participant"));
				if (!target || target.type.kind !== "pointer" || (target.type.role !== "child" && target.type.role !== "descendant")) return target ? this.report("ROLE_MISMATCH", "listen requires a child or descendant participant role", expression.arguments[0].span) : undefined;
				dependencies.add(`descendant:${target.type.identity}`);
				return result({ kind: "string" });
			}
			case "steer": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 2)) return undefined;
				const agent = preserve(use(0, "agent")); const text = preserve(use(1, "string"));
				if (!agent || !text || agent.type.kind !== "pointer" || (agent.type.role !== "child" && agent.type.role !== "descendant")) return this.report("ROLE_MISMATCH", "steer requires &>Agent or &>>Agent", expression.arguments[0].span);
				dependencies.add(`descendant:${agent.type.identity}`);
				return result({ kind: "unit" });
			}
			case "stop":
			case "interrupt": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const target = preserve(use(0, "participant"));
				if (!target || target.type.kind !== "pointer" || (target.type.role !== "child" && target.type.role !== "descendant")) return target ? this.report("ROLE_MISMATCH", `${expression.name} requires a child or descendant participant role`, expression.arguments[0].span) : undefined;
				dependencies.add(`descendant:${target.type.identity}`);
				return result({ kind: "unit" });
			}
			case "wait": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 2)) return undefined;
				const target = preserve(use(0, "participant"));
				if (!target || target.type.kind !== "pointer" || (target.type.role !== "child" && target.type.role !== "descendant")) return target ? this.report("ROLE_MISMATCH", "wait requires a child or descendant participant role", expression.arguments[0].span) : undefined;
				const until = expression.arguments[1];
				if (until?.kind !== "identifier" || (until.name !== "ready" && until.name !== "stopped")) return this.report("TYPE_MISMATCH", "wait state must be ready or stopped", until?.span ?? expression.span);
				dependencies.add(`lifecycle:${target.type.identity}:${until.name}`);
				return result({ kind: "unit" });
			}
			case "exec":
			case "input": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 2)) return undefined;
				const term = preserve(use(0, "term")); const text = preserve(use(1, "string"));
				if (!term || !text || term.type.kind !== "pointer" || (term.type.role !== "child" && term.type.role !== "descendant")) return term ? this.report("ROLE_MISMATCH", `${expression.name} requires &>Term or &>>Term`, expression.arguments[0].span) : undefined;
				const status = this.options.participantStatuses?.[term.type.identity];
				const valid = expression.name === "exec" ? status === undefined || status === "ready" || status === "stopped" : status === undefined || status === "running";
				if (!valid) return this.report("LIFECYCLE_MISMATCH", `${expression.name} is unavailable while ${term.type.identity} is ${status}`, expression.arguments[0].span);
				dependencies.add(`lifecycle:${term.type.identity}:${expression.name === "exec" ? "ready" : "running"}`);
				return result({ kind: "unit" });
			}
			case "send": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 2)) return undefined;
				if (this.participantKind === "Term") return this.report("TYPE_MISMATCH", "send is only available to Human and Agent participants", expression.operationSpan);
				const target = preserve(use(0, "communicator")); const text = preserve(use(1, "string"));
				if (!target || !text) return undefined;
				dependencies.add(`participant-pointer:${target.type.kind === "pointer" ? target.type.identity : "unknown"}`);
				return result({ kind: "unit" });
			}
			case "receive": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 0, 1)) return undefined;
				if (this.participantKind === "Term") return this.report("TYPE_MISMATCH", "receive is only available to Human and Agent participants", expression.operationSpan);
				if (expression.arguments[0]) {
					const sender = preserve(use(0, "communicator")); if (!sender) return undefined;
					if (sender.type.kind === "pointer" && sender.type.role === "descendant") return this.report("ROLE_MISMATCH", "A descendant role does not grant receive", expression.arguments[0].span);
				}
				return result({ kind: "string" });
			}
			case "reason":
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 0)) return undefined;
				if (this.participantKind === "Term") return this.report("TYPE_MISMATCH", "reason is only available to Human and Agent participants", expression.operationSpan);
				return result({ kind: "string" });
			case "log": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const target = preserve(use(0, "pointer")); if (!target || target.type.kind !== "pointer") return undefined;
				if (participantKinds.has(target.type.resource as ParticipantKindName)) {
					if (target.type.resource === "Human") return this.report("TYPE_MISMATCH", "Human participant history is not defined", expression.arguments[0].span);
					const agentSelf = target.type.resource === "Agent" && !target.type.role && target.type.identity === this.participant;
					const descendant = (target.type.resource === "Agent" || target.type.resource === "Term")
						&& (target.type.role === "child" || target.type.role === "descendant");
					if (!agentSelf && !descendant) return this.report("ROLE_MISMATCH", "Participant log requires the current Agent or a child/descendant Agent or Term role", expression.arguments[0].span);
					if (descendant) dependencies.add(`descendant:${target.type.identity}`);
					if (target.type.resource === "Term") return result({ kind: "string" });
				}
				return result({ kind: "state-list", scope: target.type.identity, resource: target.type.resource });
			}
			case "choose": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1)) return undefined;
				const list = preserve(use(0, "state-list")); if (!list || list.type.kind !== "state-list") return undefined;
				return result({ kind: "state-id", scope: list.type.scope, resource: list.type.resource });
			}
			case "checkout": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 2)) return undefined;
				const file = consume(use(0, "complete")); const state = preserve(use(1, "state-id"));
				if (!file || !state || file.type.kind !== "complete" || file.type.resource !== "File" || state.type.kind !== "state-id") return undefined;
				if (state.type.scope !== file.type.identity) return this.report("STATE_SCOPE_MISMATCH", `State belongs to ${state.type.scope}, not ${file.type.identity}`, expression.arguments[1].span);
				if (this.versioned.size && !this.versioned.has(file.type.identity)) return this.report("STATE_NOT_AVAILABLE", `${file.type.identity} does not support checkout`, expression.arguments[0].span);
				return result(file.type);
			}
			case "spawn": {
				if (!this.requirePrivilege(expression, true) || !this.requireArity(expression, 1, Number.MAX_SAFE_INTEGER)) return undefined;
				const first = expression.arguments[0];
				let participantKind: ParticipantKindName = "Agent";
				let grantsStart = 1;
				if (first.kind === "identifier" && participantKinds.has(first.name as ParticipantKindName)) {
					participantKind = first.name as ParticipantKindName;
					if (participantKind === "Agent") {
						if (expression.arguments.length < 2 || !preserve(use(1, "string"))) return expression.arguments[1] ? undefined : this.report("ARITY_MISMATCH", "spawn! Agent requires a prompt String", expression.span);
						grantsStart = 2;
					} else if (expression.arguments[1]?.kind === "string") {
						if (!preserve(use(1, "string"))) return undefined;
						grantsStart = 2;
					}
				} else {
					// Compatibility spelling: spawn! "prompt" ... means spawn! Agent "prompt" ...
					if (!preserve(use(0, "string"))) return undefined;
				}
				for (let index = grantsStart; index < expression.arguments.length; index++) {
					const grant = use(index);
					if (!grant || (grant.type.kind !== "complete" && grant.type.kind !== "pointer")) return this.report("TYPE_MISMATCH", "spawn! permissions must be complete resources or ordinary pointers", expression.arguments[index].span);
					if (grant.type.kind === "pointer" && grant.type.role) return this.report("ROLE_FORGERY", "spawn! cannot provision an existing role pointer", expression.arguments[index].span);
					if (grant.type.kind === "complete") consume(grant); else preserve(grant);
				}
				const identity = `${participantKind.toLowerCase()}:${resultName ?? "fresh"}`;
				return result({ kind: "pointer", resource: participantKind, identity, role: "child", peer: identity });
			}
			case "archive": {
				if (!this.requirePrivilege(expression, true) || !this.requireArity(expression, 1)) return undefined;
				const target = consume(use(0, "participant"));
				if (!target || target.type.kind !== "pointer" || target.type.role !== "child") return target ? this.report("ROLE_MISMATCH", "archive! requires a direct child participant role", expression.arguments[0].span) : undefined;
				const status = this.options.participantStatuses?.[target.type.identity];
				if (status !== undefined && status !== "stopped") return this.report("LIFECYCLE_MISMATCH", `archive! requires stopped, but ${target.type.identity} is ${status}`, expression.arguments[0].span);
				dependencies.add(`lifecycle:${target.type.identity}:stopped`);
				return result({ kind: "unit" });
			}
			case "give": {
				if (!this.requirePrivilege(expression, true) || !this.requireArity(expression, 2)) return undefined;
				const role = preserve(use(0, "participant")); const resource = use(1);
				if (!role || role.type.kind !== "pointer" || (role.type.role !== "child" && role.type.role !== "parent")) return role ? this.report("ROLE_MISMATCH", "give! requires a direct parent or child role pointer", expression.arguments[0].span) : undefined;
				if (!resource || (resource.type.kind !== "complete" && resource.type.kind !== "pointer")) return resource ? this.report("TYPE_MISMATCH", "give! requires a complete resource or ordinary pointer", expression.arguments[1].span) : undefined;
				if (resource.type.kind === "pointer" && resource.type.role) return this.report("ROLE_FORGERY", "give! cannot grant a participant role pointer", expression.arguments[1].span);
				if (resource.type.kind === "complete") consume(resource); else preserve(resource);
				dependencies.add(`edge:${role.type.peer ?? role.type.identity}`);
				return result({ kind: "unit" });
			}
			case "get": {
				if (!this.requirePrivilege(expression, true) || !this.requireArity(expression, 2)) return undefined;
				const role = preserve(use(0, "participant")); const pointer = preserve(use(1, "pointer"));
				if (!role || role.type.kind !== "pointer" || role.type.role !== "child") return role ? this.report("ROLE_MISMATCH", "get! requires a parent-side direct child participant role", expression.arguments[0].span) : undefined;
				if (!pointer || pointer.type.kind !== "pointer" || pointer.type.role) return pointer ? this.report("TYPE_MISMATCH", "get! requires an ordinary resource pointer", expression.arguments[1].span) : undefined;
				dependencies.add(`edge:${role.type.peer ?? role.type.identity}`);
				return result({ kind: "complete", resource: pointer.type.resource, identity: pointer.type.identity, path: pointer.type.path });
			}
			case "rewind": {
				if (!this.requirePrivilege(expression, true) || !this.requireArity(expression, 2)) return undefined;
				const role = preserve(use(0, "agent")); const state = preserve(use(1, "state-id"));
				if (!role || role.type.kind !== "pointer" || role.type.role !== "child") return role ? this.report("ROLE_MISMATCH", "rewind! requires a parent-side child role", expression.arguments[0].span) : undefined;
				if (!state || state.type.kind !== "state-id" || state.type.resource !== "Agent") return state ? this.report("TYPE_MISMATCH", "rewind! requires an Agent StateId", expression.arguments[1].span) : undefined;
				if (state.type.scope !== role.type.identity) return this.report("STATE_SCOPE_MISMATCH", `Agent state belongs to ${state.type.scope}, not ${role.type.identity}`, expression.arguments[1].span);
				return result({ kind: "unit" });
			}
			case "bash": {
				if (!this.requirePrivilege(expression, false) || !this.requireArity(expression, 1) || !preserve(use(0, "string"))) return undefined;
				return result({ kind: "string" });
			}
			default:
				return this.report("UNKNOWN_OPERATION", `Unknown operation ${expression.name}`, expression.operationSpan);
		}
	}
}

export function checkProgram(source: string, options: ProgramCheckOptions = {}): ProgramCheckResult {
	const parsed = parse(source);
	const checked = new ProgramChecker(options).check(parsed.program);
	return { ...checked, diagnostics: [...parsed.diagnostics, ...checked.diagnostics] };
}
