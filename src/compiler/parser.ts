import {
	mergeSpans,
	point,
	span,
	type Atom,
	type BindingPattern,
	type OperationExpression,
	type ParseDiagnostic,
	type ParseResult,
	type Program,
	type SourceSpan,
	type Statement,
} from "./ast.js";

type TokenKind = "identifier" | "string" | "number" | "punctuation";
interface Token { kind: TokenKind; text: string; value?: string | number; span: SourceSpan }

const identifierStart = /[\p{L}_]/u;
const identifierPart = /[\p{L}\p{N}_-]/u;

function lexLine(source: string, lineText: string, line: number, lineOffset: number): { tokens: Token[]; diagnostic?: ParseDiagnostic } {
	const tokens: Token[] = [];
	let index = 0;
	const tokenSpan = (start: number, end: number) => span(point(lineOffset + start, line, start + 1), point(lineOffset + end, line, end + 1));
	while (index < lineText.length) {
		const char = lineText[index];
		if (/\s/.test(char)) { index++; continue; }
		if (char === "/" && lineText[index + 1] === "/") break;
		if ("=:&><!(),".includes(char)) {
			tokens.push({ kind: "punctuation", text: char, span: tokenSpan(index, index + 1) });
			index++;
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			const start = index++;
			let value = "";
			let closed = false;
			while (index < lineText.length) {
				const current = lineText[index++];
				if (current === quote) { closed = true; break; }
				if (current !== "\\") { value += current; continue; }
				if (index >= lineText.length) break;
				const escaped = lineText[index++];
				const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
				value += escapes[escaped] ?? escaped;
			}
			if (!closed) return { tokens, diagnostic: { code: "PARSE_ERROR", message: "Unterminated string literal", span: tokenSpan(start, lineText.length) } };
			tokens.push({ kind: "string", text: source.slice(lineOffset + start, lineOffset + index), value, span: tokenSpan(start, index) });
			continue;
		}
		if (/\d/.test(char)) {
			const start = index;
			while (index < lineText.length && /\d/.test(lineText[index])) index++;
			const text = lineText.slice(start, index);
			tokens.push({ kind: "number", text, value: Number(text), span: tokenSpan(start, index) });
			continue;
		}
		if (identifierStart.test(char)) {
			const start = index++;
			while (index < lineText.length && identifierPart.test(lineText[index])) index++;
			const text = lineText.slice(start, index);
			tokens.push({ kind: "identifier", text, span: tokenSpan(start, index) });
			continue;
		}
		return { tokens, diagnostic: { code: "PARSE_ERROR", message: `Unexpected character ${JSON.stringify(char)}`, span: tokenSpan(index, index + 1) } };
	}
	return { tokens };
}

function parseBinding(tokens: Token[], diagnostics: ParseDiagnostic[]): BindingPattern | undefined {
	if (!tokens.length) return undefined;
	let index = 0;
	let form: BindingPattern["form"] = "plain";
	if (tokens[index]?.text === "&") {
		index++;
		if (tokens[index]?.text === ">") {
			if (tokens[index + 1]?.text === ">") { form = "descendant-role"; index += 2; }
			else { form = "child-role"; index++; }
		}
		else if (tokens[index]?.text === "<") { form = "parent-role"; index++; }
		else form = "pointer";
	}
	const name = tokens[index];
	if (!name || name.kind !== "identifier" || index !== tokens.length - 1) {
		const bad = tokens[0]?.span ?? span(point(0, 1, 1), point(0, 1, 1));
		diagnostics.push({ code: "PARSE_ERROR", message: "Expected a single binding name", span: bad });
		return undefined;
	}
	return { form, name: name.text, span: mergeSpans(tokens[0].span, name.span) };
}

function parseAtom(tokens: Token[], index: number, diagnostics: ParseDiagnostic[]): { atom?: Atom; next: number } {
	const token = tokens[index];
	if (!token) return { next: index };
	if (token.text === "&") {
		let cursor = index + 1;
		let form: "plain" | "child-role" | "descendant-role" | "parent-role" = "plain";
		if (tokens[cursor]?.text === ">") {
			if (tokens[cursor + 1]?.text === ">") { form = "descendant-role"; cursor += 2; }
			else { form = "child-role"; cursor++; }
		}
		else if (tokens[cursor]?.text === "<") { form = "parent-role"; cursor++; }
		const name = tokens[cursor];
		if (!name || name.kind !== "identifier") {
			diagnostics.push({ code: "PARSE_ERROR", message: "Expected an identifier after pointer sigil", span: token.span });
			return { next: cursor + 1 };
		}
		return { atom: { kind: "pointer", form, name: name.text, span: mergeSpans(token.span, name.span) }, next: cursor + 1 };
	}
	if (token.kind === "identifier") return { atom: { kind: "identifier", name: token.text, span: token.span }, next: index + 1 };
	if (token.kind === "string") return { atom: { kind: "string", value: String(token.value ?? ""), span: token.span }, next: index + 1 };
	if (token.kind === "number") return { atom: { kind: "number", value: Number(token.value), span: token.span }, next: index + 1 };
	diagnostics.push({ code: "PARSE_ERROR", message: `Unexpected token ${token.text} in operation arguments`, span: token.span });
	return { next: index + 1 };
}

function parseOperation(tokens: Token[], diagnostics: ParseDiagnostic[]): OperationExpression | undefined {
	const first = tokens[0];
	if (!first || first.kind !== "identifier") {
		if (first) diagnostics.push({ code: "PARSE_ERROR", message: "Expected an operation name", span: first.span });
		return undefined;
	}
	let index = 1;
	let privileged = false;
	if (tokens[index]?.text === "!") { privileged = true; index++; }
	const args: Atom[] = [];
	while (index < tokens.length) {
		if (tokens[index].text === "," || tokens[index].text === "(" || tokens[index].text === ")") { index++; continue; }
		const parsed = parseAtom(tokens, index, diagnostics);
		if (parsed.atom) args.push(parsed.atom);
		index = parsed.next;
	}
	return {
		kind: "operation",
		name: first.text,
		privileged,
		arguments: args,
		span: mergeSpans(first.span, tokens.at(-1)?.span ?? first.span),
		operationSpan: privileged ? mergeSpans(first.span, tokens[1].span) : first.span,
	};
}

function annotationText(source: string, tokens: Token[]): string {
	if (!tokens.length) return "";
	return source.slice(tokens[0].span.start.offset, tokens.at(-1)!.span.end.offset).replace(/\s+/g, "");
}

export function parse(source: string): ParseResult {
	const diagnostics: ParseDiagnostic[] = [];
	const statements: Statement[] = [];
	const lines = source.split(/\n/);
	let offset = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const lineText = lines[lineIndex].replace(/\r$/, "");
		const lineNumber = lineIndex + 1;
		const { tokens, diagnostic } = lexLine(source, lineText, lineNumber, offset);
		if (diagnostic) diagnostics.push(diagnostic);
		if (!tokens.length) { offset += lines[lineIndex].length + 1; continue; }
		const equals = tokens.findIndex((token) => token.text === "=");
		const colon = tokens.findIndex((token) => token.text === ":");
		if (equals >= 0) {
			const leftEnd = colon >= 0 && colon < equals ? colon : equals;
			const binding = parseBinding(tokens.slice(0, leftEnd), diagnostics);
			const annotation = colon >= 0 && colon < equals ? annotationText(source, tokens.slice(colon + 1, equals)) : undefined;
			const expression = parseOperation(tokens.slice(equals + 1), diagnostics);
			if (!annotation && colon >= 0 && colon < equals) diagnostics.push({ code: "PARSE_ERROR", message: "Missing type annotation", span: tokens[colon].span });
			if (binding && expression) statements.push({ kind: "assignment", binding, annotation, expression, span: mergeSpans(tokens[0].span, tokens.at(-1)!.span) });
		} else if (colon >= 0) {
			const binding = parseBinding(tokens.slice(0, colon), diagnostics);
			const annotation = annotationText(source, tokens.slice(colon + 1));
			if (!annotation) diagnostics.push({ code: "PARSE_ERROR", message: "Missing type annotation", span: tokens[colon].span });
			if (binding && annotation) statements.push({ kind: "declaration", binding, annotation, span: mergeSpans(tokens[0].span, tokens.at(-1)!.span) });
		} else {
			const expression = parseOperation(tokens, diagnostics);
			if (expression) statements.push({ kind: "command", expression, span: expression.span });
		}
		offset += lines[lineIndex].length + 1;
	}
	const endLine = lines.length;
	const endColumn = (lines.at(-1)?.replace(/\r$/, "").length ?? 0) + 1;
	const program: Program = { kind: "program", source, statements, span: span(point(0, 1, 1), point(source.length, endLine, endColumn)) };
	return { program, diagnostics };
}
