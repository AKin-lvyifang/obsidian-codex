import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";

type ObsidianSettingsApi = {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
};

export interface CodexHeaderHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  promptEnhancerRunning: boolean;
  inputEl: HTMLTextAreaElement;
  ensureSession(): StoredSession;
  renderToolbar(): void;
  openPluginSettings(): void;
  applyStatus(): void;
}

export function updateInputPlaceholder(host: CodexHeaderHost): void {
  if (!host.inputEl) return;
  const session = host.ensureSession();
  host.inputEl.setAttr("placeholder", session.cwd
    ? "问 EchoInk；查知识库用 /ask，维护用 /maintain"
    : "选择工作区后开始对话");
}

export function applyStatus(host: CodexHeaderHost): void {
  host.renderToolbar();
}

export function openPluginSettings(host: CodexHeaderHost): void {
  const setting = (host.app as unknown as ObsidianSettingsApi).setting;
  if (!setting?.open || !setting?.openTabById) {
    new Notice("无法打开插件设置页");
    return;
  }
  setting.open();
  setting.openTabById(host.plugin.manifest.id);
}
