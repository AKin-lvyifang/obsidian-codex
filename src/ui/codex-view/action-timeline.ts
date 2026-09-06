import type { ChatMessage, DiffSummary, SettingsLanguage } from "../../settings/settings";
import {
  conversationCopy,
  type ConversationActionKind,
  type ConversationActionStatus,
  type ConversationCopy,
  type ConversationToolAction
} from "../../settings/i18n";
import type { ProcessFileRef } from "../../types/app-server";

export type ActionGroupKind = ConversationActionKind;

export type ActionStatus = ConversationActionStatus;

export interface ActionSearchResultViewModel {
  path?: string;
  title?: string;
  excerpt?: string;
}

export interface ActionParameterViewModel {
  label: string;
  value: string;
}

export interface ActionUserDetailsViewModel {
  action: ConversationToolAction;
  targetPath?: string;
  sourcePath?: string;
  destinationPath?: string;
  preview?: string;
  query?: string;
  scopePath?: string;
  resultCount?: number;
  results?: ActionSearchResultViewModel[];
  command?: string;
  stdout?: string;
  stderr?: string;
  result?: string;
  error?: string;
  deleteOutcome?: "recoverable" | "completed";
  parameters?: ActionParameterViewModel[];
}

export interface ActionItemViewModel {
  id: string;
  kind: ActionGroupKind;
  toolId?: string;
  toolAction?: ConversationToolAction;
  title: string;
  target?: string;
  detail?: string;
  userDetails?: ActionUserDetailsViewModel;
  status: ActionStatus;
  createdAt: number;
  durationMs?: number;
  file?: ProcessFileRef;
  files?: ProcessFileRef[];
  diff?: {
    added?: number;
    removed?: number;
  };
  command?: {
    summary: string;
    durationMs?: number;
    rawRef?: string;
  };
  rawRef?: string;
  source: ChatMessage;
}

export interface ActionGroupViewModel {
  id: string;
  runId: string;
  kind: ActionGroupKind;
  title: string;
  status: ActionStatus;
  count: number;
  items: ActionItemViewModel[];
  defaultExpanded: boolean;
}

export interface ActionTimelineViewModel {
  stateId: string;
  runId: string;
  runStatus: ActionStatus;
  summaryTitle: string;
  summaryDetail: string;
  activeLabel: string;
  totalCount: number;
  countLabels: string[];
  groups: ActionGroupViewModel[];
}

const TOOL_ACTION_BY_ID: Readonly<Record<string, ConversationToolAction>> = Object.freeze({
  vault_search: "search",
  note_read: "read",
  note_create: "create",
  note_update: "edit",
  metadata_update: "edit",
  note_move: "move",
  note_delete: "delete",
  bash: "command"
});

export function isActionTimelineItem(message: Pick<ChatMessage, "itemType" | "role">): boolean {
  if (message.itemType === "knowledgeBase") return false;
  if (message.itemType === "reasoning") return false;
  return Boolean(
    message.itemType === "commandExecution" ||
    message.itemType === "fileChange" ||
    message.itemType === "mcpToolCall" ||
    message.itemType === "dynamicToolCall" ||
    message.itemType === "collabAgentToolCall" ||
    message.itemType === "plan" ||
    message.itemType === "contextCompaction"
  );
}

export function buildActionTimeline(
  messages: ChatMessage[],
  language: SettingsLanguage = "zh-CN"
): ActionTimelineViewModel {
  const copy = conversationCopy(language);
  const items = messages.filter(isActionTimelineItem).map((message) => toActionItem(message, copy));
  const groups: ActionGroupViewModel[] = [];
  for (const item of items) {
    const previous = groups[groups.length - 1];
    if (previous && canAppendToGroup(previous, item)) {
      previous.items.push(item);
      previous.count = previous.items.length;
      previous.status = statusForItems(previous.items);
      previous.title = titleForGroup(previous.kind, previous.items, copy);
      continue;
    }
    groups.push({
      id: actionGroupId(item),
      runId: item.source.runId ?? "",
      kind: item.kind,
      title: titleForGroup(item.kind, [item], copy),
      status: item.status,
      count: 1,
      items: [item],
      defaultExpanded: false
    });
  }
  applyDefaultExpanded(groups);
  const runId = items.find((item) => item.source.runId)?.source.runId ?? "";
  const runStatus = statusForItems(items);
  const countLabelsValue = countLabels(items, copy);
  return {
    stateId: actionTimelineStateId(items),
    runId,
    runStatus,
    summaryTitle: copy.action.summary(items.length, runStatus),
    summaryDetail: countLabelsValue.join(" · "),
    activeLabel: activeLabelForItems(items, runStatus, copy),
    totalCount: items.length,
    countLabels: countLabelsValue,
    groups
  };
}

function toActionItem(message: ChatMessage, copy: ConversationCopy): ActionItemViewModel {
  const toolId = toolIdForMessage(message);
  const toolAction = toolActionForMessage(message, toolId);
  const kind = actionKindForMessage(message, toolAction);
  const userDetails = toolAction
    ? buildActionUserDetails(message, toolAction)
    : undefined;
  const commandSummary = kind === "command"
    ? userDetails?.command || commandSummaryForMessage(message)
    : "";
  const diff = diffForMessage(message.diffSummary);
  const target = actionTargetForMessage(message, toolId, toolAction, userDetails, commandSummary);
  return {
    id: message.id,
    kind,
    ...(toolId ? { toolId } : {}),
    ...(toolAction ? { toolAction } : {}),
    title: actionTitleForMessage(message, kind, target, copy),
    ...(target ? { target } : {}),
    detail: message.details || undefined,
    ...(userDetails ? { userDetails } : {}),
    status: normalizeStatus(message.status),
    createdAt: message.createdAt,
    durationMs: reliableDurationMs(message),
    file: primaryFileForMessage(message),
    files: message.files,
    diff,
    command: kind === "command"
      ? {
        summary: commandSummary || message.details || message.title || copy.action.commandFallback,
        rawRef: message.rawRef
      }
      : undefined,
    rawRef: message.rawRef,
    source: message
  };
}

function toolIdForMessage(message: ChatMessage): string | undefined {
  if (
    message.role !== "tool"
    && message.itemType !== "commandExecution"
    && message.itemType !== "fileChange"
    && message.itemType !== "mcpToolCall"
    && message.itemType !== "dynamicToolCall"
    && message.itemType !== "collabAgentToolCall"
  ) return undefined;
  let candidate = message.title?.trim() ?? "";
  for (const prefix of ["使用工具：", "使用工具:", "调用工具：", "调用工具:", "Use tool:", "Called tool:"]) {
    if (!candidate.startsWith(prefix)) continue;
    candidate = candidate.slice(prefix.length).trim();
    break;
  }
  if (!/^[a-z0-9][a-z0-9._:/-]*$/iu.test(candidate)) return undefined;
  return candidate.toLowerCase();
}

function toolActionForMessage(
  message: ChatMessage,
  toolId: string | undefined
): ConversationToolAction | undefined {
  if (toolId) return TOOL_ACTION_BY_ID[toolId] ?? "call";
  if (message.itemType === "commandExecution") return "command";
  if (message.itemType === "fileChange") return "edit";
  if (
    message.role === "tool"
    || message.itemType === "mcpToolCall"
    || message.itemType === "dynamicToolCall"
  ) {
    if (message.processKind === "search") return "search";
    if (message.processKind === "view") return "read";
    return "call";
  }
  return undefined;
}

function buildActionUserDetails(
  message: ChatMessage,
  action: ConversationToolAction
): ActionUserDetailsViewModel {
  const input = parseDisplayPayload(message.processInput);
  const output = parseDisplayPayload(message.processOutput);
  const approvalTarget = parseDisplayPayload(message.approval?.target);
  const inputRecord = plainRecord(input);
  const outputRecord = plainRecord(output);
  const approvalRecord = plainRecord(approvalTarget);
  const filePath = firstNonEmpty([
    stringField(inputRecord, "relativePath", "path"),
    stringField(approvalRecord, "relativePath", "path", "targetPath"),
    stringField(outputRecord, "targetPath", "sourcePath", "relativePath", "path"),
    message.diffSummary?.files[0]?.path,
    message.files?.[0]?.path
  ]);
  const error = actionError(message, output);

  if (action === "search") {
    const results = searchResults(outputRecord);
    const query = firstNonEmpty([
      stringField(inputRecord, "query"),
      stringField(outputRecord, "query")
    ]);
    const scopePath = firstNonEmpty([
      stringField(inputRecord, "scopePath"),
      stringField(outputRecord, "scopePath")
    ]);
    return {
      action,
      ...(query ? { query } : {}),
      ...(scopePath ? { scopePath } : {}),
      ...(Array.isArray(outputRecord?.items) ? { resultCount: results.length } : {}),
      ...(results.length ? { results } : {}),
      ...(error ? { error } : {})
    };
  }

  if (action === "move") {
    const sourcePath = firstNonEmpty([
      stringField(inputRecord, "sourcePath", "relativePath", "path"),
      stringField(outputRecord, "sourcePath"),
      message.diffSummary?.files[0]?.previousPath
    ]);
    const destinationPath = firstNonEmpty([
      stringField(inputRecord, "targetPath"),
      stringField(outputRecord, "targetPath"),
      message.diffSummary?.files[0]?.path
    ]);
    return {
      action,
      ...(sourcePath ? { sourcePath } : {}),
      ...(destinationPath ? { destinationPath } : {}),
      ...(error ? { error } : {})
    };
  }

  if (action === "delete") {
    const sourcePath = firstNonEmpty([
      stringField(inputRecord, "relativePath", "sourcePath", "path"),
      stringField(outputRecord, "sourcePath", "relativePath", "path"),
      message.diffSummary?.files[0]?.previousPath,
      message.diffSummary?.files[0]?.path,
      message.files?.[0]?.path
    ]);
    return {
      action,
      ...(sourcePath ? { sourcePath, targetPath: sourcePath } : {}),
      ...(deleteOutcome(outputRecord) ? { deleteOutcome: deleteOutcome(outputRecord)! } : {}),
      ...(error ? { error } : {})
    };
  }

  if (action === "command") {
    const command = firstNonEmpty([
      stringField(inputRecord, "command", "cmd", "script"),
      typeof input === "string" ? input : undefined
    ]);
    const stdout = firstNonEmpty([
      stringField(outputRecord, "stdout", "output", "text"),
      !outputRecord && typeof output === "string" && !error ? output : undefined
    ]);
    const stderr = firstNonEmpty([
      stringField(outputRecord, "stderr"),
      stringField(plainRecord(outputRecord?.error), "stderr")
    ]);
    return {
      action,
      ...(command ? { command } : {}),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      ...(error ? { error } : {})
    };
  }

  if (action === "create" || action === "edit") {
    const content = stringField(inputRecord, "content", "text");
    const metadataPreview = action === "edit"
      ? readableMetadataPreview(inputRecord?.patch)
      : undefined;
    return {
      action,
      ...(filePath ? { targetPath: filePath } : {}),
      ...(content ? { preview: content } : metadataPreview ? { preview: metadataPreview } : {}),
      ...(error ? { error } : {})
    };
  }

  if (action === "read") {
    return {
      action,
      ...(filePath ? { targetPath: filePath } : {}),
      ...(error ? { error } : {})
    };
  }

  const result = readableResult(output, outputRecord, error);
  const parameters = readableParameters(inputRecord);
  return {
    action,
    ...(filePath ? { targetPath: filePath } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {})
  };
}

function actionTargetForMessage(
  message: ChatMessage,
  toolId: string | undefined,
  action: ConversationToolAction | undefined,
  details: ActionUserDetailsViewModel | undefined,
  commandSummary: string
): string {
  if (action === "command") return details?.command || commandSummary;
  if (action === "move") return details?.destinationPath || details?.sourcePath || "";
  if (action === "delete") return details?.sourcePath || "";
  if (action === "search") return details?.query || toolId || "";
  if (action === "call" && toolId) return toolId;
  if (details?.targetPath) return details.targetPath;
  if (message.diffSummary?.files[0]?.path) return message.diffSummary.files[0].path;
  if (message.files?.[0]) {
    const file = message.files[0];
    return file.name || file.displayPath || file.path;
  }
  if (action && toolId) return toolId;
  return "";
}

function parseDisplayPayload(value: string | undefined): unknown {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function searchResults(
  record: Record<string, unknown> | undefined
): ActionSearchResultViewModel[] {
  if (!Array.isArray(record?.items)) return [];
  return record.items.flatMap((candidate) => {
    const item = plainRecord(candidate);
    if (!item) return [];
    const path = stringField(item, "relativePath", "path");
    const title = stringField(item, "title", "name");
    const excerpt = stringField(item, "excerpt", "summary", "text");
    if (!path && !title && !excerpt) return [];
    return [{
      ...(path ? { path } : {}),
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {})
    }];
  });
}

function actionError(message: ChatMessage, output: unknown): string | undefined {
  if (message.status !== "failed" && message.status !== "error") return undefined;
  const outputRecord = plainRecord(output);
  const errorValue = outputRecord?.error;
  const errorRecord = plainRecord(errorValue);
  return firstNonEmpty([
    typeof errorValue === "string" ? errorValue : undefined,
    stringField(errorRecord, "message", "reason", "code"),
    stringField(outputRecord, "message", "reason"),
    typeof output === "string" ? output : undefined,
    message.text,
    message.details
  ]) || undefined;
}

function deleteOutcome(
  output: Record<string, unknown> | undefined
): "recoverable" | "completed" | undefined {
  if (!output) return undefined;
  const readback = plainRecord(output.readback);
  const trash = plainRecord(readback?.trash);
  if (trash?.kind === "obsidian_recoverable") return "recoverable";
  if (output.status === "completed") return "completed";
  return undefined;
}

function readableMetadataPreview(value: unknown): string | undefined {
  const lines: string[] = [];
  collectReadableEntries(value, "", lines);
  return lines.length ? lines.slice(0, 12).join("\n") : undefined;
}

function collectReadableEntries(value: unknown, prefix: string, lines: string[]): void {
  if (lines.length >= 12) return;
  const record = plainRecord(value);
  if (record) {
    for (const [key, nested] of Object.entries(record)) {
      collectReadableEntries(nested, prefix ? `${prefix}.${key}` : key, lines);
      if (lines.length >= 12) break;
    }
    return;
  }
  const formatted = readableScalar(value);
  if (prefix && formatted) lines.push(`${prefix}: ${formatted}`);
}

function readableParameters(
  record: Record<string, unknown> | undefined
): ActionParameterViewModel[] {
  if (!record) return [];
  const hidden = new Set([
    "content",
    "expectedVersion",
    "operationIdentity",
    "readbackVerified",
    "authorizationId",
    "productRunId",
    "piSessionId",
    "toolCallId"
  ]);
  return Object.entries(record).flatMap(([label, value]) => {
    if (hidden.has(label)) return [];
    const readable = readableScalar(value);
    return readable ? [{ label, value: readable }] : [];
  }).slice(0, 6);
}

function readableScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean"
  )) return value.map(String).join(", ");
  return undefined;
}

function readableResult(
  output: unknown,
  record: Record<string, unknown> | undefined,
  error: string | undefined
): string | undefined {
  if (error) return undefined;
  if (typeof output === "string") return output.trim() || undefined;
  return stringField(record, "summary", "message", "text", "output", "result");
}

function actionKindForMessage(
  message: ChatMessage,
  toolAction?: ConversationToolAction
): ActionGroupKind {
  if (toolAction === "search") return "search";
  if (toolAction === "read") return "read";
  if (toolAction === "command") return "command";
  if (
    toolAction === "create"
    || toolAction === "edit"
    || toolAction === "move"
    || toolAction === "delete"
  ) return "edit";
  if (toolAction === "call") return "tool";
  if (message.itemType === "contextCompaction") return "system";
  if (message.itemType === "plan" || message.processKind === "plan") return "plan";
  if (message.itemType === "fileChange" || message.processKind === "edit") return "edit";
  if (message.itemType === "collabAgentToolCall") return "agent";
  if (message.processKind === "search") return "search";
  if (message.processKind === "view") return "read";
  if (message.itemType === "commandExecution" || message.processKind === "run" || message.processKind === "command") return "command";
  if (message.itemType === "mcpToolCall" || message.itemType === "dynamicToolCall" || message.processKind === "tool") return "tool";
  return "system";
}

function actionTitleForMessage(
  message: ChatMessage,
  kind: ActionGroupKind,
  target: string,
  copy: ConversationCopy
): string {
  if (target) return target;
  if (kind === "tool") return message.title || copy.action.fallbackTitle(kind);
  if (kind === "agent") {
    return message.status === "failed" || message.status === "error"
      ? copy.action.agentFailed
      : message.title || copy.action.agentFallback;
  }
  return message.title || copy.action.fallbackTitle(kind);
}

function canAppendToGroup(group: ActionGroupViewModel, item: ActionItemViewModel): boolean {
  return group.kind === item.kind && group.runId === (item.source.runId ?? "") && sameStatusFamily(group.status, item.status);
}

function sameStatusFamily(a: ActionStatus, b: ActionStatus): boolean {
  if (a === "failed" || b === "failed") return a === b;
  if (a === "denied" || b === "denied") return a === b;
  if (a === "uncertain" || b === "uncertain") return a === b;
  if (a === "waiting_approval" || b === "waiting_approval") return a === b;
  if (a === "approved" || b === "approved") return a === b;
  if (a === "verifying" || b === "verifying") return a === b;
  if (a === "blocked" || b === "blocked") return a === b;
  if (a === "recovery-pending" || b === "recovery-pending") return a === b;
  if (a === "recovery-blocked" || b === "recovery-blocked") return a === b;
  if (a === "canceled" || b === "canceled") return a === b;
  if (a === "unconfirmed" || b === "unconfirmed") return a === b;
  if (a === "interrupted" || b === "interrupted") return a === b;
  return true;
}

function statusForItems(items: ActionItemViewModel[]): ActionStatus {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "recovery-blocked")) return "recovery-blocked";
  if (items.some((item) => item.status === "recovery-pending")) return "recovery-pending";
  if (items.some((item) => item.status === "uncertain")) return "uncertain";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "denied")) return "denied";
  if (items.some((item) => item.status === "waiting_approval")) return "waiting_approval";
  if (items.some((item) => item.status === "verifying")) return "verifying";
  if (items.some((item) => item.status === "approved")) return "approved";
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "interrupted")) return "interrupted";
  if (items.some((item) => item.status === "canceled")) return "canceled";
  if (items.some((item) => item.status === "unconfirmed")) return "unconfirmed";
  return "completed";
}

function normalizeStatus(status: string | undefined): ActionStatus {
  if (status === "running" || status === "in_progress" || status === "inProgress") return "running";
  if (status === "waiting_approval") return "waiting_approval";
  if (status === "approved") return "approved";
  if (status === "verifying") return "verifying";
  if (status === "recovery-pending") return "recovery-pending";
  if (status === "recovery-blocked") return "recovery-blocked";
  if (status === "error" || status === "failed") return "failed";
  if (status === "denied") return "denied";
  if (status === "uncertain") return "uncertain";
  if (status === "blocked" || status === "approval") return "blocked";
  if (status === "interrupted") return "interrupted";
  if (status === "unconfirmed") return "unconfirmed";
  if (status === "canceled" || status === "cancelled") return "canceled";
  return "completed";
}

function applyDefaultExpanded(groups: ActionGroupViewModel[]): void {
  const target = groups.find((group) =>
    group.status === "failed"
    || group.status === "uncertain"
    || group.status === "denied"
    || group.status === "recovery-blocked"
  ) ?? groups.find((group) =>
    group.status === "running"
    || group.status === "waiting_approval"
    || group.status === "approved"
    || group.status === "verifying"
    || group.status === "blocked"
    || group.status === "recovery-pending"
  );
  for (const group of groups) group.defaultExpanded = group === target;
}

function actionTimelineStateId(items: ActionItemViewModel[]): string {
  const first = items[0];
  const runId = first?.source.runId;
  if (runId) return `run:${runId}`;
  return `run:${first?.id ?? "empty"}`;
}

function activeLabelForItems(
  items: ActionItemViewModel[],
  status: ActionStatus,
  copy: ConversationCopy
): string {
  const active = items.slice().reverse().find((item) =>
    item.status === "running"
    || item.status === "waiting_approval"
    || item.status === "approved"
    || item.status === "verifying"
    || item.status === "blocked"
    || item.status === "unconfirmed"
    || item.status === "interrupted"
    || item.status === "recovery-pending"
    || item.status === "recovery-blocked"
  ) ?? items[items.length - 1];
  if (!active) return "";
  if (status === "failed") {
    const failed = items.slice().reverse().find((item) => item.status === "failed") ?? active;
    return liveLabelForItem(failed, "failed", copy);
  }
  if (
    status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying"
    || status === "denied"
    || status === "uncertain"
    || status === "blocked"
  ) return liveLabelForItem(active, status, copy);
  if (status === "recovery-pending") return copy.action.recoveryPending;
  if (status === "recovery-blocked") return copy.action.recoveryBlocked;
  if (status === "unconfirmed") return copy.action.statusUnconfirmed;
  if (status === "interrupted") return copy.action.processInterrupted;
  if (status === "canceled") return copy.action.processCancelled;
  return copy.action.summary(items.length, status);
}

function liveLabelForItem(
  item: ActionItemViewModel,
  status: ActionStatus,
  copy: ConversationCopy
): string {
  const target = actionTarget(item);
  return copy.action.active(item.kind, status, target);
}

function actionTarget(item: ActionItemViewModel): string {
  if (item.target) return trimActionTarget(item.target);
  if (item.kind === "command" && item.command?.summary) return trimActionTarget(item.command.summary);
  if (item.kind === "edit" && item.source.diffSummary?.files.length) return trimActionTarget(item.source.diffSummary.files[0].path);
  if (item.file) return trimActionTarget(item.file.name || item.file.displayPath || item.file.path);
  if (item.detail) return trimActionTarget(item.detail);
  if (item.title) {
    return trimActionTarget(item.title
      .replace(/^(?:已运行|已读取|Ran|Read)\s+/u, ""));
  }
  return "";
}

function trimActionTarget(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 64 ? `${normalized.slice(0, 63)}…` : normalized;
}

function countLabels(items: ActionItemViewModel[], copy: ConversationCopy): string[] {
  const counts = new Map<ActionGroupKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const kinds: ActionGroupKind[] = ["read", "search", "command", "edit", "tool", "agent", "plan", "verify", "system"];
  return kinds
    .filter((kind) => counts.has(kind))
    .map((kind) => copy.action.countLabel(kind, counts.get(kind) ?? 0));
}

function titleForGroup(
  kind: ActionGroupKind,
  items: ActionItemViewModel[],
  copy: ConversationCopy
): string {
  const count = items.length;
  const status = statusForItems(items);
  return copy.action.groupTitle(
    kind,
    status,
    count,
    uniqueFileCount(items),
    items.some((item) => item.status === "failed")
  );
}

function uniqueFileCount(items: ActionItemViewModel[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    for (const file of item.files ?? []) paths.add(file.displayPath || file.path || file.name);
  }
  return paths.size;
}

function diffForMessage(diffSummary: DiffSummary | undefined): ActionItemViewModel["diff"] | undefined {
  if (!diffSummary) return undefined;
  return {
    added: diffSummary.added,
    removed: diffSummary.removed
  };
}

function primaryFileForMessage(message: ChatMessage): ProcessFileRef | undefined {
  return message.files?.[0];
}

function commandSummaryForMessage(message: ChatMessage): string {
  const text = message.details || message.text || "";
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  const withoutPrefix = firstLine.replace(/^(?:已运行|Ran)\s+/u, "").replace(/^\$\s*/, "");
  return withoutPrefix.length > 96 ? `${withoutPrefix.slice(0, 95)}…` : withoutPrefix;
}

function reliableDurationMs(message: Pick<ChatMessage, "createdAt" | "completedAt">): number | undefined {
  const startedAt = message.createdAt;
  const completedAt = message.completedAt;
  if (
    !Number.isFinite(startedAt)
    || startedAt <= 0
    || typeof completedAt !== "number"
    || !Number.isFinite(completedAt)
    || completedAt <= startedAt
  ) return undefined;
  return completedAt - startedAt;
}

function actionGroupId(item: ActionItemViewModel): string {
  return `action:${item.source.runId ?? "none"}:${item.kind}:${item.id}`;
}
