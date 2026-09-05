import { isDeepStrictEqual } from "node:util";
import {
  defineTool,
  type AgentToolResult,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type {
  PiKnowledgeMaintenanceToolPort,
  PiKnowledgeMaintenanceToolResult,
  PiKnowledgeMaintenanceScope,
  PiKnowledgeRunIdentity
} from "./contracts";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import {
  secureVaultToolResult,
  type VaultToolResultEgressPort
} from "./vault-tool-result-safety";
import { echoInkKnowledgeMaintenanceProtocolPrompt } from "../../knowledge-base/knowledge-maintenance-protocol";
import { isRawMarkdownPath } from "../../knowledge-base/raw-digest";
import type { KnowledgeMaintenanceAssessment } from "../../knowledge-base/knowledge-maintenance-result";

export const PI_KNOWLEDGE_MAINTAIN_TOOL_ID = "knowledge_maintain" as const;

const MAINTENANCE_RESULT_LIMIT_BYTES = 8_000;
const RESULT_PENDING_SAFETY = "knowledge_maintain_result_pending_safety";

export type PiKnowledgeMaintenanceCommandContext = Readonly<{
  mode: "maintain";
  request: string;
  scope: PiKnowledgeMaintenanceScope;
  preference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    providerResourceText: string;
  }>;
}>;

interface KnowledgeMaintenanceCandidateAction {
  targetPath: string;
  content: string;
  expectedTarget: Readonly<
    | { kind: "missing" }
    | { kind: "file"; contentRevision: string }
  >;
}

interface AuthorizedMaintenanceExecution {
  readonly identity: Readonly<PiKnowledgeRunIdentity>;
  readonly command: Readonly<PiKnowledgeMaintenanceCommandContext>;
  readonly candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
  readonly sourcePaths: readonly string[];
  readonly assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly externalReadVerified: boolean;
  state: "authorized" | "consumed" | "result_ready";
  result?: Readonly<PiKnowledgeMaintenanceToolResult>;
}

export interface CreatePiKnowledgeMaintenanceSecurityOptions {
  currentRunIdentity(): Readonly<PiKnowledgeRunIdentity>;
  currentCommand(): Readonly<PiKnowledgeMaintenanceCommandContext> | Promise<Readonly<PiKnowledgeMaintenanceCommandContext>>;
  /** True only after a successful external-read Tool result in this ProductRun. */
  hasSuccessfulExternalRead?(): boolean;
  readonly egress: VaultToolResultEgressPort;
}

/** One-shot policy authority shared by Extension hooks and the Tool wrapper. */
export class PiKnowledgeMaintenanceToolSecurity
implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_KNOWLEDGE_MAINTAIN_TOOL_ID;

  private readonly executions = new Map<string, AuthorizedMaintenanceExecution>();
  private readonly seenToolCallIds = new Set<string>();
  private readonly seenProductRunIds = new Set<string>();

  constructor(
    private readonly options: Readonly<CreatePiKnowledgeMaintenanceSecurityOptions>
  ) {
    if (!options.egress) throw new TypeError("knowledge_maintenance_egress_required");
  }

  async handleToolCall(
    event: ToolCallEvent,
    _signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: string }> | void> {
    if (event.toolName !== this.toolName) return block("tool_policy_blocked");
    if (this.seenToolCallIds.has(event.toolCallId)) {
      return block("authorization_failed");
    }
    let identity: Readonly<PiKnowledgeRunIdentity>;
    let command: Readonly<PiKnowledgeMaintenanceCommandContext>;
    let candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
    let sourcePaths: readonly string[];
    let assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
    let normalizedArguments: Readonly<Record<string, unknown>>;
    let externalReadVerified: boolean;
    try {
      identity = freezeIdentity(this.options.currentRunIdentity());
      command = freezeCommand(await this.options.currentCommand());
      if (this.seenProductRunIds.has(identity.productRunId)) {
        return block("authorization_failed");
      }
      externalReadVerified = this.options.hasSuccessfulExternalRead?.() === true;
      const normalized = normalizeArguments(
        event.input,
        command,
        externalReadVerified
      );
      candidateActions = normalized.candidateActions;
      sourcePaths = normalized.sourcePaths;
      assessments = normalized.assessments;
      normalizedArguments = normalized.arguments;
    } catch {
      return block("tool_policy_blocked");
    }
    this.seenToolCallIds.add(event.toolCallId);
    this.seenProductRunIds.add(identity.productRunId);
    this.executions.set(event.toolCallId, {
      identity,
      command,
      candidateActions,
      sourcePaths,
      assessments,
      arguments: normalizedArguments,
      externalReadVerified,
      state: "authorized"
    });
  }

  consume(
    toolCallId: string,
    rawArguments: unknown
  ): Readonly<{
    identity: Readonly<PiKnowledgeRunIdentity>;
    command: Readonly<PiKnowledgeMaintenanceCommandContext>;
    candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
    sourcePaths: readonly string[];
    assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
  }> {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "authorized") {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    const normalized = normalizeArguments(
      rawArguments,
      execution.command,
      execution.externalReadVerified
    );
    if (!isDeepStrictEqual(normalized.arguments, execution.arguments)) {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    execution.state = "consumed";
    return Object.freeze({
      identity: execution.identity,
      command: execution.command,
      candidateActions: execution.candidateActions,
      sourcePaths: execution.sourcePaths,
      assessments: execution.assessments
    });
  }

  complete(
    toolCallId: string,
    result: Readonly<PiKnowledgeMaintenanceToolResult>
  ): void {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "consumed") {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    execution.result = Object.freeze({
      ...result,
      ...(result.maintenanceResult
        ? { maintenanceResult: result.maintenanceResult }
        : {}),
      ...(result.producedPaths
        ? { producedPaths: Object.freeze([...result.producedPaths]) }
        : {})
    });
    execution.state = "result_ready";
  }

  async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>> {
    const execution = this.executions.get(event.toolCallId);
    if (
      event.toolName !== this.toolName
      || !execution
      || execution.state !== "result_ready"
      || !execution.result
    ) {
      this.executions.delete(event.toolCallId);
      return rejectedResult(event.toolCallId, "authorization_failed");
    }
    try {
      const secured = await secureVaultToolResult({
        toolId: this.toolName,
        effectType: "user_write",
        egressPolicy: "echoink-configured-provider-v1",
        value: execution.result.message,
        sizeLimitBytes: MAINTENANCE_RESULT_LIMIT_BYTES,
        egress: this.options.egress
      });
      return Object.freeze({
        content: [{ type: "text" as const, text: secured.text }],
        details: Object.freeze({
          source: "echoink-knowledge-maintenance",
          toolCallId: event.toolCallId,
          productRunId: execution.identity.productRunId,
          piSessionId: execution.identity.piSessionId,
          status: execution.result.status,
          ...(execution.result.protocolVersion
            ? { protocolVersion: execution.result.protocolVersion }
            : {}),
          ...(execution.result.preferenceProfileVersion
            ? {
                preferenceProfileVersion:
                  execution.result.preferenceProfileVersion
              }
            : {}),
          ...(execution.result.preferenceState
            ? { preferenceState: execution.result.preferenceState }
            : {}),
          ...(execution.result.errorCode
            ? { errorCode: execution.result.errorCode }
            : {}),
          ...(execution.result.producedPaths
            ? { producedPaths: [...execution.result.producedPaths] }
            : {}),
          ...(execution.result.maintenanceResult
            ? { maintenanceResult: execution.result.maintenanceResult }
            : {})
        }),
        isError: event.isError
          || execution.result.status === "failed"
          || execution.result.status === "cancelled"
      });
    } catch {
      return rejectedResult(event.toolCallId, "tool_result_rejected");
    } finally {
      this.executions.delete(event.toolCallId);
    }
  }
}

export function createPiKnowledgeMaintenanceToolSecurity(
  options: Readonly<CreatePiKnowledgeMaintenanceSecurityOptions>
): PiKnowledgeMaintenanceToolSecurity {
  return new PiKnowledgeMaintenanceToolSecurity(options);
}

export interface CreatePiKnowledgeMaintenanceToolOptions {
  readonly port: PiKnowledgeMaintenanceToolPort;
  readonly security: PiKnowledgeMaintenanceToolSecurity;
}

/**
 * The same AgentSession reads Raw and supplies ordered candidate actions. The
 * wrapper never starts a Provider, Agent, Harness, or second Tool loop.
 */
export function createPiKnowledgeMaintenanceToolDefinition(
  options: Readonly<CreatePiKnowledgeMaintenanceToolOptions>
): ToolDefinition {
  return defineTool({
    name: PI_KNOWLEDGE_MAINTAIN_TOOL_ID,
    label: "维护知识库",
    description: [
      "用户要求维护知识库时，提交当前已确认范围内的知识维护动作。",
      echoInkKnowledgeMaintenanceProtocolPrompt(),
      "exact 范围只可使用已绑定单篇 Raw；batch 范围只可使用已绑定的 1-20 篇 Raw；query 范围必须从候选中选择唯一 sourcePaths；global 范围不得提供 sourcePaths。",
      "有明确 Raw 时只读取这些 Raw；只有 global 范围才读取 outputs/.ingest-tracker.md，",
      "再读取 Tracker 标记 changed 的 Raw。candidateActions 只可包含 wiki/** 或 projects/** 的 Markdown 候选；",
      "每个候选必须携带 expectedTarget。更新已有目标前先 note_read，并原样使用其 contentRevision；确认目标不存在时使用 kind=missing。",
      "raw/index.md、Tracker 和维护报告由 EchoInk 确定性生成，不要放进 candidateActions。",
      "候选完成自检后只调用一次本工具；工具会直接安全写入并回读。不要调用任何 Vault 写 Tool。",
      "同时对重要知识主张给出 assessments：仍有效(valid)、需补充(needs_supplement)、已过时(outdated)或冲突(conflict)，并记录证据、日期和是否完成外部核验；candidateActions 非空时 assessments 至少一项；无法核验时使用 unverified。"
    ].join(""),
    parameters: Type.Object({
      sourcePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 20
      })),
      candidateActions: Type.Optional(Type.Array(Type.Object({
        targetPath: Type.String({ minLength: 1 }),
        content: Type.String(),
        expectedTarget: Type.Union([
          Type.Object({
            kind: Type.Literal("missing")
          }, { additionalProperties: false }),
          Type.Object({
            kind: Type.Literal("file"),
            contentRevision: Type.String({
              pattern: "^sha256:[a-f0-9]{64}$"
            })
          }, { additionalProperties: false })
        ])
      }, { additionalProperties: false }))),
      assessments: Type.Optional(Type.Array(Type.Object({
        claim: Type.String({ minLength: 1, maxLength: 500 }),
        status: Type.Union([
          Type.Literal("valid"),
          Type.Literal("needs_supplement"),
          Type.Literal("outdated"),
          Type.Literal("conflict")
        ]),
        evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 20
        }),
        asOf: Type.String({ minLength: 1, maxLength: 100 }),
        verification: Type.Union([
          Type.Literal("local_verified"),
          Type.Literal("external_verified"),
          Type.Literal("unverified")
        ])
      }, { additionalProperties: false }), { maxItems: 100 }))
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, rawArguments, signal) => {
      const authorized = options.security.consume(toolCallId, rawArguments);
      const result = await options.port.execute(Object.freeze({
        ...authorized.identity,
        toolCallId,
        mode: "maintain",
        request: authorized.command.request,
        sourcePaths: authorized.sourcePaths,
        candidateActions: authorized.candidateActions,
        assessments: authorized.assessments,
        preferenceSnapshot: {
          profileVersion: authorized.command.preference.profileVersion,
          state: authorized.command.preference.state,
          revision: authorized.command.preference.revision
        },
        ...(signal ? { signal } : {})
      }));
      options.security.complete(toolCallId, result);
      return pendingResult(toolCallId, authorized.identity);
    }
  });
}

function pendingResult(
  toolCallId: string,
  identity: Readonly<PiKnowledgeRunIdentity>
): AgentToolResult<Readonly<Record<string, unknown>>> {
  return {
    content: [{ type: "text", text: RESULT_PENDING_SAFETY }],
    details: Object.freeze({
      source: "echoink-knowledge-maintenance",
      toolCallId,
      productRunId: identity.productRunId,
      piSessionId: identity.piSessionId,
      status: "verifying"
    })
  };
}

function normalizeArguments(
  value: unknown,
  command: Readonly<PiKnowledgeMaintenanceCommandContext>,
  externalReadVerified = false
): Readonly<{
  arguments: Readonly<Record<string, unknown>>;
  candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
  sourcePaths: readonly string[];
  assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("knowledge_maintenance_arguments_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedKeys = new Set(["candidateActions", "sourcePaths", "assessments"]);
  if (
    !Object.prototype.hasOwnProperty.call(record, "candidateActions")
    || keys.some((key) => !allowedKeys.has(key))
    || !Array.isArray(record.candidateActions)
    || record.candidateActions.length > 100
  ) {
    throw new TypeError("knowledge_maintenance_arguments_invalid");
  }
  const candidateActions = Object.freeze(record.candidateActions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("knowledge_maintenance_action_invalid");
    }
    const action = item as Record<string, unknown>;
    if (
      Object.keys(action).length !== 3
      || !Object.prototype.hasOwnProperty.call(action, "targetPath")
      || !Object.prototype.hasOwnProperty.call(action, "content")
      || !Object.prototype.hasOwnProperty.call(action, "expectedTarget")
      || typeof action.targetPath !== "string"
      || !action.targetPath.trim()
      || typeof action.content !== "string"
    ) {
      throw new TypeError("knowledge_maintenance_action_invalid");
    }
    return Object.freeze({
      targetPath: action.targetPath,
      content: action.content,
      expectedTarget: normalizeExpectedTarget(action.expectedTarget)
    });
  }));
  const sourcePaths = normalizeMaintenanceSourcePaths(
    record.sourcePaths,
    command.scope
  );
  const assessments = normalizeMaintenanceAssessments(
    record.assessments,
    externalReadVerified
  );
  if (candidateActions.length > 0 && assessments.length === 0) {
    throw new TypeError("knowledge_maintenance_assessments_required");
  }
  return Object.freeze({
    arguments: Object.freeze({
      candidateActions,
      ...(sourcePaths.length ? { sourcePaths } : {}),
      assessments
    }),
    candidateActions,
    sourcePaths,
    assessments
  });
}

function normalizeMaintenanceAssessments(
  value: unknown,
  externalReadVerified: boolean
): readonly Readonly<KnowledgeMaintenanceAssessment>[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError("knowledge_maintenance_assessments_invalid");
  }
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("knowledge_maintenance_assessment_invalid");
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join("\0")
      !== "asOf\0claim\0evidence\0status\0verification"
      || typeof record.claim !== "string" || !record.claim.trim()
      || record.claim.length > 500
      || !["valid", "needs_supplement", "outdated", "conflict"].includes(
        String(record.status)
      )
      || !Array.isArray(record.evidence) || record.evidence.length > 20
      || record.evidence.some((entry) =>
        typeof entry !== "string" || !entry.trim() || entry.length > 500
      )
      || typeof record.asOf !== "string" || !record.asOf.trim()
      || record.asOf.length > 100
      || !["local_verified", "external_verified", "unverified"].includes(
        String(record.verification)
      )) {
      throw new TypeError("knowledge_maintenance_assessment_invalid");
    }
    return Object.freeze({
      claim: record.claim.trim(),
      status: record.status as KnowledgeMaintenanceAssessment["status"],
      evidence: Object.freeze((record.evidence as string[]).map((entry) =>
        entry.trim()
      )),
      asOf: record.asOf.trim(),
      verification: record.verification === "external_verified"
        && !externalReadVerified
        ? "unverified"
        : record.verification as KnowledgeMaintenanceAssessment["verification"]
    });
  }));
}

function normalizeMaintenanceSourcePaths(
  value: unknown,
  scope: PiKnowledgeMaintenanceScope
): readonly string[] {
  if (scope.mode === "global") {
    if (value !== undefined) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze([]);
  }
  if (scope.mode === "exact") {
    const expected = scope.sourcePaths[0];
    if (value === undefined) return Object.freeze([expected]);
    if (
      !Array.isArray(value)
      || value.length !== 1
      || normalizeMaintenanceRawPath(value[0]) !== expected
    ) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze([expected]);
  }
  if (scope.mode === "batch") {
    const expected = scope.sourcePaths;
    if (value === undefined) return Object.freeze([...expected]);
    if (!Array.isArray(value) || value.length !== expected.length) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    const selected = value.map(normalizeMaintenanceRawPath);
    if (!isDeepStrictEqual(selected, expected)) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze(selected);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  const selected = normalizeMaintenanceRawPath(value[0]);
  if (!scope.candidatePaths.includes(selected)) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  return Object.freeze([selected]);
}

function normalizeMaintenanceRawPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized.toLocaleLowerCase().startsWith("raw/")
    || !isRawMarkdownPath(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  return normalized;
}

function normalizeExpectedTarget(
  value: unknown
): Readonly<KnowledgeMaintenanceCandidateAction["expectedTarget"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("knowledge_maintenance_expected_target_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "missing" && Object.keys(record).length === 1) {
    return Object.freeze({ kind: "missing" as const });
  }
  if (
    record.kind === "file"
    && Object.keys(record).length === 2
    && typeof record.contentRevision === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(record.contentRevision)
  ) {
    return Object.freeze({
      kind: "file" as const,
      contentRevision: record.contentRevision
    });
  }
  throw new TypeError("knowledge_maintenance_expected_target_invalid");
}

function freezeIdentity(
  value: Readonly<PiKnowledgeRunIdentity>
): Readonly<PiKnowledgeRunIdentity> {
  for (const field of ["vaultId", "conversationId", "piSessionId", "productRunId"] as const) {
    if (typeof value?.[field] !== "string" || !value[field].trim()) {
      throw new TypeError("knowledge_maintenance_identity_invalid");
    }
  }
  return Object.freeze({ ...value });
}

function freezeCommand(
  value: Readonly<PiKnowledgeMaintenanceCommandContext>
): Readonly<PiKnowledgeMaintenanceCommandContext> {
  if (!value || value.mode !== "maintain") {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  if (typeof value.request !== "string") {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  const scope = value.scope;
  if (
    !scope
    || !["global", "exact", "batch", "query"].includes(scope.mode)
  ) {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  if (
    scope.mode === "batch"
    && (
      scope.sourcePaths.length === 0
      || scope.sourcePaths.length > 20
      || new Set(scope.sourcePaths.map(normalizeMaintenanceRawPath)).size
        !== scope.sourcePaths.length
    )
  ) {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  const preference = value.preference;
  if (
    !preference
    || typeof preference.profileVersion !== "string"
    || !preference.profileVersion.trim()
    || (preference.state !== "default" && preference.state !== "custom")
    || typeof preference.revision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(preference.revision)
    || typeof preference.providerResourceText !== "string"
    || !preference.providerResourceText.trim()
  ) {
    throw new TypeError("knowledge_maintenance_preference_invalid");
  }
  return Object.freeze({
    ...value,
    scope: scope.mode === "global"
      ? Object.freeze({ mode: "global" as const })
      : scope.mode === "exact"
        ? Object.freeze({
            mode: "exact" as const,
            sourcePaths: Object.freeze<[string]>([
              normalizeMaintenanceRawPath(scope.sourcePaths[0])
            ])
          })
        : scope.mode === "batch"
          ? Object.freeze({
              mode: "batch" as const,
              sourcePaths: Object.freeze(scope.sourcePaths.map(
                normalizeMaintenanceRawPath
              ))
            })
          : Object.freeze({
            mode: "query" as const,
            candidatePaths: Object.freeze(scope.candidatePaths.map(
              normalizeMaintenanceRawPath
            ))
          }),
    preference: Object.freeze({ ...preference })
  });
}

function block(reason: string): Readonly<{ block: true; reason: string }> {
  return Object.freeze({ block: true, reason });
}

function rejectedResult(
  toolCallId: string,
  reason: string
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: true;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-knowledge-maintenance",
      toolCallId,
      status: "failed"
    }),
    isError: true
  });
}
