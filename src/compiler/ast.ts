export interface SourcePoint {
	offset: number;
	line: number;
	column: number;
}

export interface SourceSpan {
	start: SourcePoint;
	end: SourcePoint;
}

export type BindingForm = "plain" | "pointer" | "child-role" | "descendant-role" | "parent-role";

export interface BindingPattern {
	form: BindingForm;
	name: string;
	span: SourceSpan;
}

export type Atom =
	| { kind: "identifier"; name: string; span: SourceSpan }
	| { kind: "string"; value: string; span: SourceSpan }
	| { kind: "number"; value: number; span: SourceSpan }
	| { kind: "pointer"; form: "plain" | "child-role" | "descendant-role" | "parent-role"; name: string; span: SourceSpan };

export interface OperationExpression {
	kind: "operation";
	name: string;
	privileged: boolean;
	arguments: Atom[];
	span: SourceSpan;
	operationSpan: SourceSpan;
}

export type Statement =
	| {
		kind: "declaration";
		binding: BindingPattern;
		annotation: string;
		span: SourceSpan;
	}
	| {
		kind: "assignment";
		binding: BindingPattern;
		annotation?: string;
		expression: OperationExpression;
		span: SourceSpan;
	}
	| {
		kind: "command";
		expression: OperationExpression;
		span: SourceSpan;
	};

export interface Program {
	kind: "program";
	source: string;
	statements: Statement[];
	span: SourceSpan;
}

export interface ParseDiagnostic {
	code: "PARSE_ERROR";
	message: string;
	span: SourceSpan;
}

export interface ParseResult {
	program: Program;
	diagnostics: ParseDiagnostic[];
}

export const point = (offset: number, line: number, column: number): SourcePoint => ({ offset, line, column });

export const span = (start: SourcePoint, end: SourcePoint): SourceSpan => ({ start, end });

export const mergeSpans = (first: SourceSpan, last: SourceSpan): SourceSpan => span(first.start, last.end);
