import { setIcon } from "obsidian";
import { renderSettingsGearIcon } from "../codex-icon";
import type { AgentIdentityView } from "./message-list";

export interface CodexHeaderCallbacks {
  onOpenWorkspaceResources: () => void;
  onOpenSettings: () => void;
}

const DEFAULT_AGENT_IDENTITY: AgentIdentityView = Object.freeze({
  displayName: "EchoInk",
  avatarUrl: null
});

export function renderCodexHeader(
  rootEl: HTMLElement,
  callbacks: CodexHeaderCallbacks,
  identity: Readonly<AgentIdentityView> = DEFAULT_AGENT_IDENTITY
): void {
  const header = rootEl.createDiv({ cls: "codex-header" });
  const title = header.createDiv({ cls: "codex-title" });
  const icon = title.createSpan({ cls: "codex-title-icon codex-title-icon-codex", attr: { "aria-hidden": "true" } });
  title.createSpan({ cls: "codex-title-text" });
  updateCodexHeaderIdentity(header, identity);

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

/**
 * 只更新聊天栏标题中的身份展示，不重建 Composer、会话标签或滚动区域。
 * 名称和头像来自 CognitiveSystem 的同步缓存；空值始终回退 EchoInk + bot。
 */
export function updateCodexHeaderIdentity(
  rootEl: HTMLElement,
  identity: Readonly<AgentIdentityView> = DEFAULT_AGENT_IDENTITY
): void {
  const icon = rootEl.querySelector<HTMLElement>(".codex-title-icon-codex");
  const label = rootEl.querySelector<HTMLElement>(".codex-title-text");
  if (!icon || !label) return;

  const displayName = identity.displayName.trim() || DEFAULT_AGENT_IDENTITY.displayName;
  const avatarUrl = identity.avatarUrl?.trim() || null;
  label.textContent = displayName;
  icon.empty();
  icon.removeClass("has-image");
  if (!avatarUrl) {
    setIcon(icon, "bot");
    return;
  }
  icon.addClass("has-image");
  icon.createEl("img", {
    cls: "codex-title-avatar",
    attr: {
      src: avatarUrl,
      alt: "",
      draggable: "false",
      decoding: "async"
    }
  });
}
