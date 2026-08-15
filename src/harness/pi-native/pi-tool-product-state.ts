export type PiChatUiToolProductStatus =
  | "waiting_approval"
  | "approved"
  | "denied"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export type PiChatUiToolApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export type PiChatUiToolReceiptStatus =
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

/** Product-owned approval fields consumed by the stateless UI projector. */
export interface PiChatUiToolApprovalView {
  readonly piSessionId?: string;
  readonly toolCallId: string;
  readonly productRunId: string;
  readonly operationIdentity?: string;
  readonly status: PiChatUiToolApprovalStatus;
  readonly target?: string;
  readonly preview?: string;
  readonly updatedAt?: number;
}

/**
 * Product-owned side-effect proof. It deliberately excludes Tool Result body
 * and file content; those remain authoritative Pi Session data.
 */
export interface PiChatUiToolReceiptView {
  readonly piSessionId?: string;
  readonly toolCallId: string;
  readonly productRunId: string;
  readonly operationIdentity: string;
  readonly status: PiChatUiToolReceiptStatus;
  readonly readbackVerified: boolean;
  readonly readbackRequired?: boolean;
  readonly target?: string;
  readonly summary?: string;
  readonly readbackSummary?: string;
  readonly updatedAt?: number;
}

export interface PiChatUiToolProductProjectionInput {
  readonly approvals?: readonly PiChatUiToolApprovalView[];
  readonly receipts?: readonly PiChatUiToolReceiptView[];
}

export interface PiChatUiToolProductResolutionInput {
  readonly piSessionId: string;
  readonly toolCallId: string;
  readonly productRunId?: string;
  readonly writeTool: boolean;
  readonly piStatus: PiChatUiToolProductStatus;
  readonly hasDurableResult: boolean;
  readonly approval?: PiChatUiToolApprovalView;
  readonly receipt?: PiChatUiToolReceiptView;
}

/**
 * Resolves display state without storing another Tool lifecycle. Pi proves the
 * call/result, product records prove authorization and side effects, and live
 * state is only the fallback while those records are not durable yet.
 */
export function resolvePiChatUiToolProductStatus(
  input: PiChatUiToolProductResolutionInput
): PiChatUiToolProductStatus {
  if (!input.writeTool) return input.piStatus;

  const approval = matchingApproval(input.approval, input);
  const receipt = matchingReceipt(input.receipt, approval, input);
  if (receipt) {
    if (approval && approval.status !== "approved") return "uncertain";
    if (receipt.status === "uncertain") return "uncertain";
    if (receipt.status === "failed") return "failed";
    if (receipt.status === "cancelled") return "cancelled";
    if (receipt.status === "running") return "running";
    if (receipt.status === "verifying") return "verifying";
    if (receipt.readbackRequired !== false && !receipt.readbackVerified) return "uncertain";
    if (input.piStatus === "failed" || input.piStatus === "cancelled") {
      return "uncertain";
    }
    return input.hasDurableResult && input.piStatus === "completed"
      ? "completed"
      : "verifying";
  }

  if (approval?.status === "denied" || approval?.status === "expired") return "denied";
  if (approval?.status === "cancelled") return "cancelled";
  if (input.piStatus === "failed" || input.piStatus === "cancelled") {
    return input.piStatus;
  }
  if (approval?.status === "pending") return "waiting_approval";
  if (approval?.status === "approved" && input.piStatus === "approved") return "approved";
  if (input.piStatus === "approved") return "approved";
  if (input.piStatus === "waiting_approval") return "waiting_approval";
  if (input.piStatus === "completed") return "verifying";
  return "running";
}

function matchingApproval(
  approval: PiChatUiToolApprovalView | undefined,
  input: PiChatUiToolProductResolutionInput
): PiChatUiToolApprovalView | undefined {
  if (!approval) return undefined;
  if (approval.piSessionId && approval.piSessionId !== input.piSessionId) return undefined;
  if (approval.toolCallId !== input.toolCallId) return undefined;
  if (!input.productRunId || approval.productRunId !== input.productRunId) return undefined;
  return approval;
}

function matchingReceipt(
  receipt: PiChatUiToolReceiptView | undefined,
  approval: PiChatUiToolApprovalView | undefined,
  input: PiChatUiToolProductResolutionInput
): PiChatUiToolReceiptView | undefined {
  if (!receipt) return undefined;
  if (receipt.piSessionId && receipt.piSessionId !== input.piSessionId) return undefined;
  if (receipt.toolCallId !== input.toolCallId) return undefined;
  if (!input.productRunId || receipt.productRunId !== input.productRunId) return undefined;
  if (!receipt.operationIdentity.trim()) return undefined;
  if (
    approval?.operationIdentity
    && approval.operationIdentity !== receipt.operationIdentity
  ) return undefined;
  return receipt;
}
