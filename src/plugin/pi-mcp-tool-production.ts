import type { App } from "obsidian";
import type {
  DomainRecoveryReadbackResult,
  FileDomainReceiptStore
} from "../harness/pi-native/domain-receipt-store";
import {
  verifyPiMcpReadback
} from "../harness/pi-native/pi-mcp-custom-tool-adapter";
import type {
  PiMcpApprovalConfirmationInput,
  PiMcpApprovalConfirmationPort as SecurityConfirmationPort
} from "../harness/pi-native/pi-mcp-tool-security";
import type { JsonValue } from "../harness/pi-native/tool-authorization";
import type { EchoInkMcpToolReadbackContract } from "../resources/types";
import { confirmModal } from "../ui/modals";

const MCP_RECOVERY_TIMEOUT_MS = 30_000;

export function createObsidianPiMcpApprovalConfirmation(
  app: App
): SecurityConfirmationPort {
  return Object.freeze({
    async confirm(input: Readonly<PiMcpApprovalConfirmationInput>) {
      const risk = input.destructive
        ? "该 Tool 声明为破坏性操作。"
        : "该 Tool 会产生外部副作用。";
      return await confirmModal(
        app,
        `允许 ${input.resourceName} · ${input.toolName}？`,
        [risk, "确认后只执行这一次调用。", safeJson(input.arguments)].join("\n\n"),
        "确认执行",
        "拒绝",
        { signal: input.signal, preformatted: true }
      );
    }
  });
}

/**
 * Recovers only durable MCP journals. It may call a declared read-only
 * Readback Tool, but it never retries the original side effect.
 */
export async function recoverPiMcpDomainReceipts(input: {
  readonly receipts: FileDomainReceiptStore;
  readonly callTool: (request: Readonly<{
    resourceId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
  }>) => Promise<unknown>;
  readonly now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const pending = await input.receipts.listPendingRecovery();
  for (const view of pending) {
    if (!view.toolId.startsWith("echoink_mcp_")) continue;
    const inspection = await input.receipts.inspectRecovery(view.operationIdentity);
    if (inspection.state === "not_started") {
      const checkedAt = now();
      await input.receipts.persistReceipt({
        operationIdentity: view.operationIdentity,
        status: "cancelled",
        safeSummary: { reason: "recovered_before_mcp_dispatch" },
        readback: {
          checkedAt,
          readbackVerified: false,
          observedTargetVersion: null,
          safeSummary: { reason: "mcp_side_effect_not_started" }
        }
      });
      continue;
    }
    if (inspection.state !== "readback_required") continue;

    const recovery = parseMcpRecoveryContract(
      inspection.operation.resolvedTarget,
      inspection.operation.targetVersion
    );
    await input.receipts.recoverMissingReceipt(
      view.operationIdentity,
      async (): Promise<Readonly<DomainRecoveryReadbackResult>> => {
        const checkedAt = now();
        if (!recovery) {
          return {
            status: "uncertain" as const,
            safeSummary: { reason: "mcp_readback_contract_unavailable" },
            readback: {
              checkedAt,
              readbackVerified: false,
              observedTargetVersion: null,
              safeSummary: { reason: "no_automatic_side_effect_retry" }
            }
          };
        }
        try {
          const result = await input.callTool({
            resourceId: recovery.resourceId,
            toolName: recovery.contract.toolName,
            arguments: recovery.readbackArguments,
            timeoutMs: MCP_RECOVERY_TIMEOUT_MS,
            signal: AbortSignal.timeout(MCP_RECOVERY_TIMEOUT_MS)
          });
          const verified = verifyPiMcpReadback(
            recovery.contract,
            recovery.assertionArguments,
            result
          );
          return {
            status: verified ? "completed" as const : "uncertain" as const,
            safeSummary: {
              reason: verified
                ? "mcp_readback_verified_after_restart"
                : "mcp_readback_inconclusive_after_restart"
            },
            readback: {
              checkedAt,
              readbackVerified: verified,
              observedTargetVersion: { readbackCompleted: true },
              safeSummary: {
                server: recovery.resourceId,
                tool: recovery.contract.toolName,
                verified
              }
            }
          };
        } catch {
          return {
            status: "uncertain" as const,
            safeSummary: { reason: "mcp_readback_failed_after_restart" },
            readback: {
              checkedAt,
              readbackVerified: false,
              observedTargetVersion: null,
              safeSummary: { reason: "no_automatic_side_effect_retry" }
            }
          };
        }
      }
    );
  }
}

interface McpRecoveryContract {
  readonly resourceId: string;
  readonly contract: EchoInkMcpToolReadbackContract;
  readonly readbackArguments: Record<string, unknown>;
  readonly assertionArguments: Record<string, unknown>;
}

function parseMcpRecoveryContract(
  resolvedTarget: JsonValue,
  targetVersion: JsonValue
): McpRecoveryContract | null {
  const target = plainRecord(resolvedTarget);
  const version = plainRecord(targetVersion);
  const resourceId = stringValue(target?.resourceId);
  if (!resourceId || version?.readbackRequired !== true) return null;
  const contract = parseReadbackContract(version.readbackContract);
  const readbackArguments = jsonRecord(version.readbackArguments);
  const assertionArguments = jsonRecord(version.assertionArguments);
  if (!contract || !readbackArguments || !assertionArguments) return null;
  return Object.freeze({
    resourceId,
    contract,
    readbackArguments,
    assertionArguments
  });
}

function parseReadbackContract(value: unknown): EchoInkMcpToolReadbackContract | null {
  const object = plainRecord(value);
  const toolName = stringValue(object?.toolName);
  const argumentMap = stringRecord(object?.argumentMap);
  const assertions = Array.isArray(object?.assertions)
    ? object.assertions.flatMap((raw) => {
        const item = plainRecord(raw);
        const resultPath = stringValue(item?.resultPath);
        const argumentKey = stringValue(item?.argumentKey);
        return resultPath && argumentKey ? [{ resultPath, argumentKey }] : [];
      })
    : [];
  return toolName && argumentMap && Object.keys(argumentMap).length && assertions.length
    ? { toolName, argumentMap, assertions }
    : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  const object = plainRecord(value);
  return object ? structuredClone(object) : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const object = plainRecord(value);
  if (!object) return null;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(object)) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    result[key] = raw;
  }
  return result;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? "{}";
    return text.length <= 8_000 ? text : `${text.slice(0, 7_980)}\n…[TRUNCATED]`;
  } catch {
    return "{}";
  }
}
