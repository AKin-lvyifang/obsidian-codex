import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import { conversationUiText } from "./ui-i18n";

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
  host.inputEl.setAttr("placeholder", "");
}

export function applyStatus(host: CodexHeaderHost): void {
  host.renderToolbar();
}

export function openPluginSettings(host: CodexHeaderHost): void {
  const setting = (host.app as unknown as ObsidianSettingsApi).setting;
  if (!setting?.open || !setting?.openTabById) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "无法打开插件设置页",
      "Could not open the plugin settings"
    ));
    return;
  }
  setting.open();
  setting.openTabById(host.plugin.manifest.id);
}
