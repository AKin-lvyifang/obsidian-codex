import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import type { SessionMessageInput } from "./session-message-store";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutText } from "../turn-watchdog";

export interface CodexTurnLifecycleHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  turnWatchdog: number | null;
  cancelPendingTurn?(): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  activeRunSession(): StoredSession;
  pauseQueueForSession(sessionId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  addMessageToSession(session: StoredSession, message: SessionMessageInput): void;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
}

export async function stopTurn(host: CodexTurnLifecycleHost): Promise<void> {
  const session = host.activeRunSession();
  const runId = host.activeRunId;
  host.cancelPendingTurn?.();
  host.pauseQueueForSession(session.id);
  if (!runId) return;
  if (!host.plugin.isPiProductionRun(runId)) return;
  host.clearTurnWatchdog();
  await host.plugin.cancelHarnessRun(runId);
  host.applyStatus();
}

export function armTurnWatchdog(host: CodexTurnLifecycleHost, timeoutMs = CHAT_TURN_WATCHDOG_MS, timeoutText?: string): void {
  host.clearTurnWatchdog();
  host.turnWatchdog = window.setTimeout(() => {
    host.turnWatchdog = null;
    if (!host.running) return;
    const session = host.activeRunSession();
    const runId = host.activeRunId;
    if (!runId) return;
    if (host.plugin.isPiProductionRun(runId)) {
      host.pauseQueueForSession(session.id);
      void host.plugin.cancelHarnessRun(runId)
        .catch((error) => console.error("Pi Chat timeout cancellation failed", error));
      host.applyStatus();
    }
  }, timeoutMs);
}

export function clearTurnWatchdog(host: CodexTurnLifecycleHost): void {
  if (!host.turnWatchdog) return;
  window.clearTimeout(host.turnWatchdog);
  host.turnWatchdog = null;
}

export function clearActiveRun(host: CodexTurnLifecycleHost, clearMessageStoreActiveRun: () => void): void {
  host.activeRunId = "";
  host.activeRunKind = "";
  host.activeRunSessionId = "";
  host.activeTurnId = "";
  clearMessageStoreActiveRun();
}
