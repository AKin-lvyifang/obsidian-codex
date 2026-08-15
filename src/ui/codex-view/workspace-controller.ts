import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { TurnOptions } from "../turn-options";
import { getActiveApiProvider, getApiProviderModels, type StoredSession } from "../../settings/settings";
import { buildActiveEchoInkResourceCatalog, hasEnabledMcpResources, workspaceResourcesFromEchoInkResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { showItemInFinder } from "../../core/electron";
import { textInputModal } from "../modals";
import { openWorkspaceMenu as showWorkspaceMenu } from "./menus";
import { normalizeWorkspacePath, pickWorkspaceDirectory, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";

export interface CodexWorkspaceHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  selectedModel: string;
  selectedReasoning: ReasoningEffort;
  selectedServiceTier: ServiceTierChoice;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  ensureSession(): StoredSession;
  renderToolbar(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  updateInputPlaceholder(): void;
  currentTurnOptions(session?: StoredSession): TurnOptions;
  effectiveModel(): string;
}

export function openWorkspaceMenu(host: CodexWorkspaceHost, event: MouseEvent, session: StoredSession): void {
  const workspacePath = normalizeWorkspacePath(session.cwd);
  showWorkspaceMenu(event, workspacePath, {
    onChooseWorkspace: () => void chooseChatWorkspace(host, session),
    onRevealWorkspace: () => showItemInFinder(workspacePath),
    onClearWorkspace: () => void clearChatWorkspace(host, session)
  });
}

export async function chooseChatWorkspace(host: CodexWorkspaceHost, session: StoredSession): Promise<boolean> {
  if (host.running) {
    new Notice("当前会话运行中，结束后再切换工作区");
    return false;
  }
  const pickedPath = await pickWorkspaceDirectory(session.cwd);
  const selectedPath = pickedPath === undefined
    ? await textInputModal(host.app, "选择工作区", "文件夹路径", session.cwd)
    : pickedPath;
  if (!selectedPath) return false;
  if (host.running) {
    new Notice("当前会话运行中，结束后再切换工作区");
    return false;
  }
  const workspacePath = normalizeWorkspacePath(selectedPath);
  if (!workspaceDirectoryExists(workspacePath)) {
    new Notice("请选择一个存在的文件夹作为工作区");
    return false;
  }
  const changed = normalizeWorkspacePath(session.cwd) !== workspacePath;
  if (changed) {
    try {
      await commitChatWorkspaceSelection(host, session, workspacePath);
    } catch (error) {
      new Notice(`切换工作区失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  new Notice(changed
    ? `工作区已设为：${workspaceDisplayName(workspacePath)}`
    : `工作区已设为：${workspaceDisplayName(workspacePath)}`);
  return true;
}

export async function clearChatWorkspace(host: CodexWorkspaceHost, session: StoredSession): Promise<void> {
  if (host.running) {
    new Notice("当前会话运行中，结束后再清除工作区");
    return;
  }
  session.cwd = "";
  delete session.tokenUsage;
  await host.plugin.saveSettings(true);
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  new Notice("已清除工作区");
}

export async function commitChatWorkspaceSelection(
  host: CodexWorkspaceHost,
  session: StoredSession,
  workspacePath: string
): Promise<void> {
  session.cwd = workspacePath;
  delete session.tokenUsage;
  await host.plugin.saveSettings(true);
}

export async function ensureChatWorkspaceSelected(host: CodexWorkspaceHost, session: StoredSession): Promise<boolean> {
  const workspacePath = normalizeWorkspacePath(session.cwd);
  if (workspacePath && workspaceDirectoryExists(workspacePath)) return true;
  const picked = await chooseChatWorkspace(host, session);
  if (!picked) new Notice("普通会话需要先选择一个文件夹作为工作区");
  return picked;
}

export function currentTurnOptions(host: CodexWorkspaceHost, session?: StoredSession): TurnOptions {
  const cwd = session ? normalizeWorkspacePath(session.cwd) : "";
  const catalog = currentEchoInkResourceCatalog(host);
  const workspaceResources = workspaceResourcesFromEchoInkResources(catalog);
  return {
    ...(cwd ? { cwd } : {}),
    model: host.effectiveModel(),
    reasoning: host.selectedReasoning,
    serviceTier: host.selectedServiceTier,
    permission: host.selectedPermission,
    mode: host.selectedMode,
    mcpEnabled: hasEnabledMcpResources(catalog),
    workspaceResources
  };
}

export function currentEchoInkResourceCatalog(host: CodexWorkspaceHost): EchoInkResource[] {
  return buildActiveEchoInkResourceCatalog({ settings: host.plugin.settings.resources });
}

export function activeProviderModels(host: CodexWorkspaceHost): string[] {
  if (host.plugin.settings.providerMode !== "custom-api") return [];
  const provider = getActiveApiProvider(host.plugin.settings);
  return provider ? getApiProviderModels(provider) : [];
}

export function effectiveModel(host: CodexWorkspaceHost): string {
  const providerModels = activeProviderModels(host);
  if (providerModels.length) {
    return providerModels.includes(host.selectedModel) ? host.selectedModel : providerModels[0];
  }
  return host.selectedModel || host.plugin.settings.defaultModel || "";
}
