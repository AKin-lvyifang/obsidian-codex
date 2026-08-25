import type { ChatMessage, DiffSummary, SettingsLanguage } from "../../settings/settings";
import {
  conversationCopy,
  type ConversationActionKind,
  type ConversationActionStatus,
  type ConversationCopy
} from "../../settings/i18n";
import type { ProcessFileRef } from "../../types/app-server";

export type ActionGroupKind = ConversationActionKind;

export type ActionStatus = ConversationActionStatus;

export interface ActionItemViewModel {
  id: string;
  kind: ActionGroupKind;
  title: string;
  detail?: string;
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
  const kind = actionKindForMessage(message);
  const commandSummary = kind === "command" ? commandSummaryForMessage(message) : "";
  const diff = diffForMessage(message.diffSummary);
  return {
    id: message.id,
    kind,
    title: actionTitleForMessage(message, kind, commandSummary, copy),
    detail: message.details || undefined,
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

function actionKindForMessage(message: ChatMessage): ActionGroupKind {
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
  commandSummary: string,
  copy: ConversationCopy
): string {
  if (kind === "command" && commandSummary) return copy.action.completedTitle(kind, commandSummary);
  if (kind === "edit" && message.diffSummary?.files.length === 1) {
    return copy.action.completedTitle(kind, message.diffSummary.files[0].path);
  }
  if (kind === "read" && message.files?.[0]) {
    return copy.action.completedTitle(kind, message.files[0].name);
  }
  if (kind === "search") return message.details || message.title || copy.action.fallbackTitle(kind);
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
    || completedAt < startedAt
  ) return undefined;
  return completedAt - startedAt;
}

function actionGroupId(item: ActionItemViewModel): string {
  return `action:${item.source.runId ?? "none"}:${item.kind}:${item.id}`;
}
