import { setIcon } from "obsidian";
import { renderSettingsGearIcon } from "../codex-icon";

export interface CodexHeaderCallbacks {
  onOpenWorkspaceResources: () => void;
  onOpenSettings: () => void;
}

export function renderCodexHeader(rootEl: HTMLElement, callbacks: CodexHeaderCallbacks): void {
  const header = rootEl.createDiv({ cls: "codex-header" });
  const title = header.createDiv({ cls: "codex-title" });
  const icon = title.createSpan({ cls: "codex-title-icon codex-title-icon-codex", attr: { "aria-hidden": "true" } });
  setIcon(icon, "bot");
  title.createSpan({ cls: "codex-title-text", text: "EchoInk" });

  const headerActions = header.createDiv({ cls: "codex-header-actions" });
  const resourceButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-resource-button",
    attr: { type: "button", "aria-label": "插件 MCP Skills 管理", title: "插件 / MCP / Skills 管理" }
  });
  setIcon(resourceButton, "blocks");
  resourceButton.onclick = callbacks.onOpenWorkspaceResources;

  const settingsButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-settings-button",
    attr: {
      type: "button",
      "aria-label": "打开插件设置",
      title: "打开插件设置",
      "data-echoink-onboarding-anchor": "settings"
    }
  });
  renderSettingsGearIcon(settingsButton);
  settingsButton.onclick = callbacks.onOpenSettings;
}
