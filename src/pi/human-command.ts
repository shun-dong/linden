export interface ParticipantPayloadCommand {
	action?: string;
	target?: string;
	/** Everything after the single whitespace character that separates target from payload. */
	payload: string;
	hasPayloadSeparator: boolean;
}

interface ParsedWord {
	value: string;
	end: number;
}

function nextShellWord(source: string, offset: number): ParsedWord | undefined {
	let index = offset;
	while (index < source.length && /\s/.test(source[index])) index += 1;
	if (index >= source.length) return undefined;
	let value = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else value += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) break;
		value += character;
	}
	if (escaped) value += "\\";
	if (quote) throw new Error(`Unterminated ${quote} quote`);
	return { value, end: index };
}

/**
 * Parse only the action and participant target of a Human control command.
 *
 * The payload is deliberately not shell-parsed. Exactly one whitespace
 * character is consumed as the target/payload delimiter; any additional
 * leading whitespace, quotes, escapes, and trailing whitespace belong to the
 * payload verbatim.
 */
export function parseParticipantPayloadCommand(source: string): ParticipantPayloadCommand {
	const action = nextShellWord(source, 0);
	if (!action) return { payload: "", hasPayloadSeparator: false };
	const target = nextShellWord(source, action.end);
	if (!target) return { action: action.value, payload: "", hasPayloadSeparator: false };
	const hasPayloadSeparator = target.end < source.length && /\s/.test(source[target.end]);
	return {
		action: action.value,
		target: target.value,
		payload: hasPayloadSeparator ? source.slice(target.end + 1) : "",
		hasPayloadSeparator,
	};
}
