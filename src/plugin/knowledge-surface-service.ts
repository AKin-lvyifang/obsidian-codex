import type CodexForObsidianPlugin from "../main";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import {
  buildKnowledgeBaseDashboardSnapshot,
  type KnowledgeBaseDashboardSnapshot
} from "../knowledge-base/dashboard";
import type { StoredAttachment } from "../settings/settings";

export type KnowledgeMaintenanceSurfaceStatus = Readonly<{
  state: "ready";
  message: "";
}>;

/** Current Knowledge dashboard and capture surfaces. Pi owns agent execution. */
export class EchoInkKnowledgeSurfaceService {
  private readonly captureService: KnowledgeBaseCaptureService;
  private dashboardSnapshot:
    | { value: KnowledgeBaseDashboardSnapshot; signature: string; savedAt: number }
    | null = null;
  private dashboardFlight: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.captureService = new KnowledgeBaseCaptureService(plugin);
  }

  get isRunning(): boolean {
    return false;
  }

  get maintenanceRecoveryStatus(): KnowledgeMaintenanceSurfaceStatus {
    return { state: "ready", message: "" };
  }

  async getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> {
    const signature = JSON.stringify(this.plugin.settings.knowledgeBase);
    const now = Date.now();
    if (
      this.dashboardSnapshot
      && this.dashboardSnapshot.signature === signature
      && now - this.dashboardSnapshot.savedAt <= 5_000
    ) {
      return this.dashboardSnapshot.value;
    }
    if (!this.dashboardFlight) {
      this.dashboardFlight = buildKnowledgeBaseDashboardSnapshot(
        this.plugin.getVaultPath(),
        this.plugin.settings.knowledgeBase
      ).then((value) => {
        this.dashboardSnapshot = { value, signature, savedAt: Date.now() };
        return value;
      }).finally(() => {
        this.dashboardFlight = null;
      });
    }
    return await this.dashboardFlight;
  }

  async cancelMaintenance(): Promise<{ accepted: false; message: string }> {
    return {
      accepted: false,
      message: "Knowledge 维护由 Pi Agent 执行，请在普通 EchoInk 会话中使用 /maintain。"
    };
  }

  async captureLink(): Promise<string[]> {
    return await this.captureService.captureLink();
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return await this.captureService.captureExternalFiles(files);
  }

  async unload(): Promise<void> {}
}
