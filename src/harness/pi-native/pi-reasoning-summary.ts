import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
  ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION,
  freezeEchoInkReasoningSummary,
  normalizeEchoInkReasoningSummarySnapshot,
  reasoningSummaryEntryData,
  reasoningSummaryFromSessionEntry,
  type EchoInkReasoningActivity,
  type EchoInkReasoningSummarySnapshot,
  type EchoInkReasoningSummaryStatus
} from "../../types/reasoning-summary";

export function createReasoningSummary(input: Readonly<{
  conversationId: string;
  piSessionId: string;
  productRunId: string;
  startedAt: number;
}>): Readonly<EchoInkReasoningSummarySnapshot> {
  return normalizeEchoInkReasoningSummarySnapshot({
    schemaVersion: ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION,
    conversationId: input.conversationId,
    piSessionId: input.piSessionId,
    productRunId: input.productRunId,
    status: "running",
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    activities: []
  });
}

export function updateReasoningActivity(input: Readonly<{
  summary: Readonly<EchoInkReasoningSummarySnapshot>;
  activity: Readonly<EchoInkReasoningActivity>;
}>): Readonly<EchoInkReasoningSummarySnapshot> {
  if (input.summary.terminalAt !== undefined) return input.summary;
  const existingIndex = input.summary.activities.findIndex(
    (activity) => activity.id === input.activity.id
  );
  if (existingIndex < 0 && input.summary.activities.length >= 64) {
    return input.summary;
  }
  const activities = input.summary.activities.map((activity) => ({ ...activity }));
  if (existingIndex >= 0) {
    const previous = activities[existingIndex];
    activities[existingIndex] = {
      ...input.activity,
      startedAt: Math.min(previous.startedAt, input.activity.startedAt),
      updatedAt: Math.max(previous.updatedAt, input.activity.updatedAt)
    };
  } else {
    activities.push({ ...input.activity });
  }
  return normalizeEchoInkReasoningSummarySnapshot({
    ...input.summary,
    updatedAt: Math.max(input.summary.updatedAt, input.activity.updatedAt),
    activities
  });
}

export function completeReasoningAtFirstText(input: Readonly<{
  summary: Readonly<EchoInkReasoningSummarySnapshot>;
  observedAt: number;
}>): Readonly<EchoInkReasoningSummarySnapshot> {
  if (
    input.summary.firstAssistantTextAt !== undefined
    || input.summary.terminalAt !== undefined
  ) return input.summary;
  const observedAt = Math.max(input.summary.startedAt, input.observedAt);
  return normalizeEchoInkReasoningSummarySnapshot({
    ...input.summary,
    status: "completed",
    firstAssistantTextAt: observedAt,
    updatedAt: Math.max(input.summary.updatedAt, observedAt)
  });
}

export function closeReasoningSummary(input: Readonly<{
  summary: Readonly<EchoInkReasoningSummarySnapshot>;
  status: Exclude<EchoInkReasoningSummaryStatus, "running">;
  terminalAt: number;
}>): Readonly<EchoInkReasoningSummarySnapshot> {
  if (input.summary.terminalAt !== undefined) return input.summary;
  const terminalAt = Math.max(input.summary.startedAt, input.terminalAt);
  const terminalActivityStatus = input.status === "completed"
    ? "completed"
    : input.status;
  return normalizeEchoInkReasoningSummarySnapshot({
    ...input.summary,
    status: input.status,
    terminalAt,
    updatedAt: Math.max(input.summary.updatedAt, terminalAt),
    activities: input.summary.activities.map((activity) =>
      activity.status === "active"
        ? {
            ...activity,
            status: terminalActivityStatus,
            updatedAt: Math.max(activity.updatedAt, terminalAt)
          }
        : activity
    )
  });
}

export function interruptReasoningSummary(input: Readonly<{
  summary: Readonly<EchoInkReasoningSummarySnapshot>;
  interruptedAt: number;
}>): Readonly<EchoInkReasoningSummarySnapshot> {
  return closeReasoningSummary({
    summary: input.summary,
    status: "interrupted",
    terminalAt: input.interruptedAt
  });
}

export function appendReasoningSummaryEntry(
  sessionManager: SessionManager,
  summary: Readonly<EchoInkReasoningSummarySnapshot>
): string {
  if (sessionManager.getSessionId() !== summary.piSessionId) {
    throw new Error("reasoning_summary_session_identity_mismatch");
  }
  const existingCount = sessionManager.getBranch().filter((entry) =>
    reasoningSummaryFromSessionEntry(entry, summary.piSessionId)
      ?.productRunId === summary.productRunId
  ).length;
  if (existingCount >= 2) {
    throw new Error("reasoning_summary_entry_limit_exceeded");
  }
  return sessionManager.appendCustomEntry(
    ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
    reasoningSummaryEntryData({
      conversationId: summary.conversationId,
      piSessionId: summary.piSessionId,
      summary
    })
  );
}

export function freezeReasoningActivity(
  activity: EchoInkReasoningActivity
): Readonly<EchoInkReasoningActivity> {
  return Object.freeze({ ...activity });
}

export function cloneReasoningSummary(
  summary: Readonly<EchoInkReasoningSummarySnapshot>
): Readonly<EchoInkReasoningSummarySnapshot> {
  return freezeEchoInkReasoningSummary({
    ...summary,
    activities: summary.activities.map((activity) => ({ ...activity }))
  });
}
