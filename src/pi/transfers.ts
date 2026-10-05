import type { FileTransferUpdate } from "../runtime/manager.js";
import type { ParticipantId, ResourceId } from "../runtime/model.js";

export interface GiveResult {
	targetId: ParticipantId;
	mode: "move" | "read";
	moved: ResourceId[];
	fileUpdates?: FileTransferUpdate[];
}

export interface GetPermissionResult {
	status: "granted" | "pending" | "unavailable";
	targetId: ParticipantId;
	resources: ResourceId[];
	operationId?: string;
	reason?: string;
	fileUpdates?: FileTransferUpdate[];
}

export interface BatchTransferResult {
	status: "completed" | "partial" | "failed";
	completed: { resource: string; result: GiveResult | GetPermissionResult }[];
	failed?: { resource: string; index: number; reason: string };
	unattempted: string[];
}

export function transferInputs(input: { resource?: string; resources?: readonly string[] }): string[] {
	if ((input.resource !== undefined) === (input.resources !== undefined)) throw new Error("Provide exactly one of resource or resources");
	const resources = input.resource !== undefined ? [input.resource] : input.resources!;
	if (!Array.isArray(resources) || !resources.length) throw new Error("resources must contain at least one typed resource reference");
	return [...resources];
}

/** Each item commits separately. A failed item stops the list without undoing earlier results. */
export async function sequentialTransfers(resources: readonly string[], transfer: (resource: string) => Promise<GiveResult | GetPermissionResult>): Promise<BatchTransferResult> {
	const inputs = transferInputs({ resources });
	const completed: BatchTransferResult["completed"] = [];
	for (let index = 0; index < inputs.length; index++) {
		const resource = inputs[index];
		try {
			if (typeof resource !== "string" || !resource.trim()) throw new Error("Expected a non-empty typed resource reference");
			const result = await transfer(resource);
			if ("status" in result && result.status === "unavailable") throw new Error(result.reason ?? "Permission unavailable");
			completed.push({ resource, result });
		} catch (error) {
			return { status: completed.length ? "partial" : "failed", completed, failed: { resource, index, reason: error instanceof Error ? error.message : String(error) }, unattempted: inputs.slice(index + 1) };
		}
	}
	return { status: "completed", completed, unattempted: [] };
}

export function formatTransferResult(result: GiveResult | GetPermissionResult): string {
	const summary = "moved" in result
		? `${result.mode === "read" ? "Granted use projection on" : "Moved"} ${result.moved.join(", ")} to ${result.targetId}`
		: `${result.status}: ${result.resources.join(", ") || result.reason || result.operationId || "permission request"}`;
	const updates = (result.fileUpdates ?? []).map((update) => update.change === "saved"
		? `External disk changes saved as a new File version: ${update.resourceId} -> ${update.stateId}.`
		: `Disk verified against the current File version: ${update.resourceId} -> ${update.stateId}; divergence cleared.`);
	return [summary, ...updates].join("\n");
}

export function formatBatchTransfer(result: BatchTransferResult): string {
	return [
		`Batch ${result.status}: ${result.completed.length} item(s) completed.`,
		...result.completed.map((item) => `${item.resource}: ${formatTransferResult(item.result)}`),
		...(result.failed ? [`Failed: ${result.failed.resource}: ${result.failed.reason}`] : []),
		...(result.unattempted.length ? [`Not attempted: ${result.unattempted.join(", ")}`] : []),
	].join("\n");
}
