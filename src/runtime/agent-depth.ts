export function normalizeMaxAgentDepth(value: unknown, label = "maxAgentDepth"): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

export function formatMaxAgentDepth(value: number | undefined): string {
	return value === undefined ? "unlimited" : String(value);
}
