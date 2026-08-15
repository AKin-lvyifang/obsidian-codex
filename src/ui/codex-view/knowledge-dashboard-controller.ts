import type { App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../../knowledge-base/dashboard";
import { clearKnowledgeDashboardHealthTooltips, renderKnowledgeDashboardView, type KnowledgeDashboardTooltipState } from "./knowledge-dashboard";

export interface CodexKnowledgeDashboardHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  knowledgeDashboardEl: HTMLElement;
  knowledgeDashboardSnapshot: KnowledgeBaseDashboardSnapshot | null;
  knowledgeDashboardExpanded: boolean;
  knowledgeDashboardLoading: boolean;
  knowledgeDashboardError: string;
  knowledgeDashboardRequestId: number;
  knowledgeDashboardTooltipState: KnowledgeDashboardTooltipState;
  ensureSession(): StoredSession;
  renderKnowledgeDashboard(): void;
  refreshKnowledgeDashboard(force?: boolean): Promise<void>;
}

export function renderKnowledgeDashboard(host: CodexKnowledgeDashboardHost): void {
  if (!host.knowledgeDashboardEl) return;
  host.ensureSession();
  const recovery = host.plugin.getKnowledgeSurfaceService()?.maintenanceRecoveryStatus ?? {
    state: "ready" as const,
    message: ""
  };
  renderKnowledgeDashboardView(
    host.knowledgeDashboardEl,
    {
      visible: true,
      snapshot: host.knowledgeDashboardSnapshot,
      expanded: host.knowledgeDashboardExpanded,
      loading: host.knowledgeDashboardLoading,
      error: host.knowledgeDashboardError,
      recovery
    },
    {
      onRefresh: () => void host.refreshKnowledgeDashboard(true),
      onToggleExpanded: () => {
        host.knowledgeDashboardExpanded = !host.knowledgeDashboardExpanded;
        host.renderKnowledgeDashboard();
      }
    },
    host.knowledgeDashboardTooltipState
  );
}

export async function refreshKnowledgeDashboard(host: CodexKnowledgeDashboardHost, force = false): Promise<void> {
  if (!host.knowledgeDashboardEl) return;
  host.ensureSession();
  if (host.knowledgeDashboardLoading && !force) return;
  const manager = host.plugin.getKnowledgeSurfaceService();
  if (!manager) return;
  const requestId = ++host.knowledgeDashboardRequestId;
  host.knowledgeDashboardLoading = true;
  host.knowledgeDashboardError = "";
  host.renderKnowledgeDashboard();
  try {
    const snapshot = await manager.getDashboardSnapshot();
    if (requestId !== host.knowledgeDashboardRequestId) return;
    host.knowledgeDashboardSnapshot = snapshot;
  } catch (error) {
    if (requestId !== host.knowledgeDashboardRequestId) return;
    host.knowledgeDashboardError = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === host.knowledgeDashboardRequestId) {
      host.knowledgeDashboardLoading = false;
      host.renderKnowledgeDashboard();
    }
  }
}

export function clearKnowledgeDashboardTooltips(host: CodexKnowledgeDashboardHost): void {
  clearKnowledgeDashboardHealthTooltips(host.knowledgeDashboardTooltipState);
}
