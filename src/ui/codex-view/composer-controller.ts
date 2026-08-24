import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { enabledSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import {
  activateApiProviderModel,
  apiProviderHasUsableCredential,
  getActiveApiProvider,
  getApiProviderModel,
  type StoredAttachment,
  type StoredSession
} from "../../settings/settings";
import type { ProviderBrandId } from "../../settings/provider-brand-icons";
import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { knowledgeCommandQueryForInput } from "../../knowledge-base/commands";
import { contextUsageView } from "../../core/mapping";
import { composerStateForRuntimeState, type ComposerPrimaryActionState } from "../composer-state";
import { RuntimeTurnQueue } from "../turn-queue";
import { setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import {
  clearPromptEnhanceReview,
  compactReasoningLabel,
  labelFor,
  renderContextPanel,
  renderComposerResourcePanel,
  renderComposerToolbar,
  renderTurnQueue,
  shortModelLabel
} from "./composer";
import {
  openKnowledgeCommandMenu as showKnowledgeCommandMenu,
  openModelMenu as showModelMenu,
  openSkillMenu as showSkillMenu,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesView,
  renderSkillMatches as renderSkillMatchesView,
  type ComposerProviderModelOption
} from "./menus";
import { normalizeWorkspacePath, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";
import {
  clearSelectedPiConversationDraft,
  isPiConversationRecovering,
  piConversationSupport,
  projectPiImageAttachments,
  refreshPiConversationSupport,
  rememberPiConversationProjection,
  selectPiConversationDraft,
  setPiConversationRecovering
} from "./pi-conversation-support";
import { positionAnchoredMenu } from "./floating-menu-position";

let contextPopoverId = 0;

export interface CodexComposerHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  readonly turnQueue: RuntimeTurnQueue;
  toolbarEl: HTMLElement;
  workspaceEl: HTMLElement;
  queueEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  resourcePanelEl: HTMLElement;
  resourcePanelAnchorEl: HTMLButtonElement;
  resourcePanelOpen: boolean;
  resourcePanelResources: EchoInkResource[];
  contextEl: HTMLElement;
  contextRingEl: HTMLElement;
  contextPanelEl: HTMLElement | null;
  contextPanelCleanup: (() => void) | null;
  contextPanelReposition: (() => void) | null;
  contextPanelOpen: boolean;
  draggedQueueItemId: string;
  selectedSkill: EchoInkResource | null;
  attachments: StoredAttachment[];
  selectedProviderSettingsId: string;
  selectedModel: string;
  selectedReasoning: ReasoningEffort;
  selectedServiceTier: ServiceTierChoice;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  skillsRequested: boolean;
  running: boolean;
  promptEnhancerRunning: boolean;
  activeRunKind: "chat" | "";
  activeRunSessionId: string;
  ensureSession(): StoredSession;
  currentEchoInkResourceCatalog(): EchoInkResource[];
  effectiveModel(): string;
  renderToolbar(): void;
  renderMessages(options?: {
    forceBottom?: boolean;
    preserveScroll?: boolean;
  }): void;
  resetVirtualWindow(): void;
  enhancePrompt(): void;
  renderQueue(): void;
  renderAttachments(): void;
  updateContext(tokenUsage: StoredSession["tokenUsage"], persist: boolean): void;
  runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void>;
  pickKnowledgeBaseFiles(): void;
  openKnowledgeCommandMenu(event: MouseEvent): void;
  openWorkspaceMenu(event: MouseEvent, session: StoredSession): void;
  openModelMenu(event: MouseEvent): void;
  pauseQueueForSession(sessionId: string): void;
  stopTurn(): Promise<void>;
  steerPiChatFromComposer(): Promise<void>;
  enqueueComposerDraft(): Promise<void>;
  resumeQueuedTurns(sessionId: string): Promise<void>;
  sendMessage(): Promise<void>;
  attachActiveFile(): void;
  pickFiles(imagesOnly: boolean): void;
  toggleMcpPanel(): Promise<void>;
  fillKnowledgeBaseCommand(command: string): void;
  renderKnowledgeCommandMatches(query: string): void;
}

export function renderToolbar(host: CodexComposerHost): void {
  if (!host.toolbarEl) return;
  disposeContextPopover(host);
  host.renderQueue();
  host.renderAttachments();

  const session = host.ensureSession();
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
  const knowledgeTaskRunning = Boolean(knowledgeManager?.isRunning);
  const workspacePath = normalizeWorkspacePath(session.cwd);
  const refs = renderComposerToolbar(
    host.toolbarEl,
    host.workspaceEl,
    {
      session,
      knowledgeTaskRunning,
      selectedSkill: host.selectedSkill,
      selectedPermission: host.selectedPermission,
      selectedMode: host.selectedMode,
      running: host.running,
      promptEnhancerRunning: host.promptEnhancerRunning,
      viewRunKind: host.activeRunKind,
      activeRunSessionId: host.activeRunSessionId,
      hasDraft: hasComposerDraft(host),
      hasTextDraft: Boolean(host.inputEl.value.trim()),
      hasQueuedItems: host.turnQueue.hasQueuedItems(session.id),
      currentComposerModel: host.effectiveModel(),
      currentComposerProviderBrand: currentComposerProviderBrand(host),
      currentComposerSummaryTitle: currentComposerSummaryTitle(host),
      workspacePath,
      workspaceDisplayName: workspacePath ? workspaceDisplayName(workspacePath) : "",
      workspaceValid: workspacePath ? workspaceDirectoryExists(workspacePath) : false,
      contextLedger: session.contextLedger,
      contextPanelOpen: host.contextPanelOpen && host.plugin.settings.showContext
    },
    {
      onOpenAddMenu: (event) => openAddMenu(host, event),
      onEnhancePrompt: () => host.enhancePrompt(),
      onCaptureKnowledgeSource: () => host.runKnowledgeBaseShortcut("收藏", async () => {
        const paths = await host.plugin.getKnowledgeSurfaceService()?.captureLink();
        return paths?.length ? `已收藏：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收藏内容。";
      }),
      onPermissionChange: (value) => {
        host.selectedPermission = value;
        persistComposerDefaults(host);
        host.renderToolbar();
      },
      onOpenWorkspaceMenu: (event, nextSession) => host.openWorkspaceMenu(event, nextSession),
      onOpenModelMenu: (event) => host.openModelMenu(event),
      onToggleContextPanel: () => {
        if (!host.plugin.settings.showContext) return;
        if (host.contextPanelOpen) {
          closeContextPopover(host, true);
          return;
        }
        host.contextPanelOpen = true;
        host.renderToolbar();
        host.contextPanelEl?.focus();
      },
      onMicInput: () => new Notice("语音输入暂未接入"),
      onCancelKnowledgeTask: () => {
        void knowledgeManager?.cancelMaintenance().then((cancellation) => {
          if (cancellation.accepted) {
            host.pauseQueueForSession(session.id);
          }
        });
      },
      onStopTurn: () => void host.stopTurn(),
      onSteerPiChat: () => void host.steerPiChatFromComposer(),
      onEnqueueDraft: () => void host.enqueueComposerDraft(),
      onResumeQueue: (sessionId) => void host.resumeQueuedTurns(sessionId),
      onSendMessage: () => void host.sendMessage()
    }
  );
  host.contextEl = refs.contextEl!;
  host.resourcePanelAnchorEl = refs.addButtonEl!;
  host.resourcePanelAnchorEl.setAttribute("aria-expanded", String(host.resourcePanelOpen));
  host.contextRingEl = refs.contextRingEl!;
  syncContextPopover(host, session.contextLedger);
  renderComposerResourcePanel(
    host.resourcePanelEl,
    {
      open: host.resourcePanelOpen,
      selectedSkill: host.selectedSkill,
      selectedMode: host.selectedMode,
      resources: host.resourcePanelResources.length
        ? host.resourcePanelResources
        : host.currentEchoInkResourceCatalog(),
      resourceSettings: host.plugin.settings.resources,
      language: host.plugin.settings.settingsLanguage
    },
    {
      onDismiss: (restoreFocus) => closeResourcePanel(host, restoreFocus),
      onPickFiles: (imagesOnly) => {
        closeResourcePanel(host, false);
        host.pickFiles(imagesOnly);
      },
      onAttachActiveFile: () => {
        closeResourcePanel(host, false);
        host.attachActiveFile();
      },
      onSelectPlanMode: () => {
        closeResourcePanel(host, false);
        selectComposerMode(host, "plan");
      },
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        closeResourcePanel(host, false);
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      },
      onOpenMcpSettings: () => {
        closeResourcePanel(host, false);
        void host.plugin.openWorkspaceResourceSettings("mcp");
      }
    }
  );
  host.updateContext(session.tokenUsage, false);
}

export function renderQueue(host: CodexComposerHost): void {
  if (!host.queueEl) return;
  const session = host.ensureSession();
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
  const maintenanceReady = (knowledgeManager?.maintenanceRecoveryStatus?.state ?? "ready") === "ready";
  const maintenanceRecoveryBlocksHead = false;
  const piSupport = session.bodyAuthority === "pi_session_only"
    ? piConversationSupport(host.plugin, session.id)
    : null;
  renderTurnQueue(
    host.queueEl,
    {
      items: host.turnQueue.itemsForSession(session.id),
      paused: host.turnQueue.isSessionQueuePaused(session.id)
        || host.turnQueue.isSessionRecoveryRequired(session.id),
      canResume: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning
        && !maintenanceRecoveryBlocksHead
        && !host.turnQueue.isSessionRecoveryRequired(session.id),
      recoveryRequired:
        host.turnQueue.isSessionRecoveryRequired(session.id),
      canRecover: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning,
      draggedItemId: host.draggedQueueItemId,
      piSupport,
      piRecoveryPending: isPiConversationRecovering(
        host.plugin,
        session.id
      ),
      canManagePiSupport: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning
    },
    {
      onResume: () => void host.resumeQueuedTurns(session.id),
      onRecover: () => undefined,
      onDragStart: (itemId) => {
        host.draggedQueueItemId = itemId;
      },
      onDragEnd: () => {
        host.draggedQueueItemId = "";
      },
      onReorder: (sessionId, sourceId, index) => {
        host.turnQueue.reorderQueuedItem(sessionId, sourceId, index);
        host.renderQueue();
      },
      onRemove: (sessionId, itemId) => {
        host.turnQueue.removeQueuedItem(sessionId, itemId);
        host.renderQueue();
        host.renderToolbar();
      },
      onEditPiDraft: (draftId) => editPiConversationDraft(
        host,
        session.id,
        draftId
      ),
      onRemovePiDraft: (draftId) => void removePiConversationDraft(
        host,
        session.id,
        draftId
      ),
      onRecoverPiConversation: (recoveryPath) =>
        void recoverPiConversation(host, session, recoveryPath)
    }
  );
}

export function editPiConversationDraft(
  host: CodexComposerHost,
  conversationId: string,
  draftId: string
): boolean {
  const draft = selectPiConversationDraft(
    host.plugin,
    conversationId,
    draftId
  );
  if (!draft) {
    new Notice("这条 Pi 草稿已经不存在，请刷新后重试。");
    return false;
  }
  host.inputEl.value = draft.text;
  host.inputEl.setSelectionRange(draft.text.length, draft.text.length);
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.renderToolbar();
  host.inputEl.focus();
  return true;
}

export async function removePiConversationDraft(
  host: CodexComposerHost,
  conversationId: string,
  draftId: string
): Promise<boolean> {
  try {
    const removed = await host.plugin.discardPiConversationDraft(
      conversationId,
      draftId
    );
    await refreshPiConversationSupport(host.plugin, conversationId);
    clearSelectedPiConversationDraft(host.plugin, conversationId);
    host.renderToolbar();
    if (removed) new Notice("Pi 草稿已删除");
    return removed;
  } catch (error) {
    new Notice(`删除 Pi 草稿失败：${errorMessage(error)}`);
    return false;
  }
}

export async function recoverPiConversation(
  host: CodexComposerHost,
  session: StoredSession,
  recoveryPath: string
): Promise<boolean> {
  setPiConversationRecovering(host.plugin, session.id, true);
  host.renderToolbar();
  try {
    const recovered = await host.plugin.recoverPiConversationFromVerifiedPrefix({
      conversationId: session.id,
      recoveryPath
    });
    const projection = await host.plugin.readPiConversationProjection(session.id);
    rememberPiConversationProjection(host.plugin, projection);
    session.title = projection.catalog.title;
    session.piSessionId = projection.catalog.piSessionId;
    session.defaultMemoryMode = projection.catalog.defaultMemoryMode;
    session.bodyAuthority = "pi_session_only";
    session.messages = projectPiImageAttachments(
      session,
      structuredClone(projection.messages)
    );
    if (projection.contextLedger) {
      session.contextLedger = structuredClone(projection.contextLedger);
    } else {
      delete session.contextLedger;
    }
    session.createdAt = projection.catalog.createdAt;
    session.updatedAt = projection.catalog.updatedAt;
    host.resetVirtualWindow();
    host.renderMessages({ forceBottom: true });
    new Notice(
      `已恢复 ${recovered.recoveredEntryCount} 条可验证记录；原损坏文件已保留。`
    );
    return true;
  } catch (error) {
    await refreshPiConversationSupport(host.plugin, session.id)
      .catch(() => undefined);
    new Notice(`恢复 Pi 会话失败：${errorMessage(error)}`);
    return false;
  } finally {
    setPiConversationRecovering(host.plugin, session.id, false);
    host.renderToolbar();
  }
}

export function closeComposerMenus(host: CodexComposerHost): void {
  host.skillMenuEl?.removeClass("is-visible");
  closeResourcePanel(host, false);
  closeContextPopover(host, false);
  if (host.inputEl && host.knowledgeCommandMenuEl) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  }
}

export function openSkillMenu(host: CodexComposerHost, event: MouseEvent): void {
  setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  showSkillMenu(
    event,
    { skillMenuEl: host.skillMenuEl, knowledgeCommandMenuEl: host.knowledgeCommandMenuEl },
    { skillsRequested: host.skillsRequested },
    {
      onSkillsRequested: () => {
        host.skillsRequested = true;
      },
      onLoadSkills: async () => enabledSkillsForComposerMenu(
        await host.plugin.ensureEchoInkSkillResourcesLoaded(true)
      ),
      onRenderMatches: (skills) => renderSkillMatches(host, "", skills)
    }
  );
}

export function openAddMenu(host: CodexComposerHost, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (host.resourcePanelOpen) {
    closeResourcePanel(host, true);
    return;
  }
  host.skillMenuEl.removeClass("is-visible");
  setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  host.resourcePanelOpen = true;
  host.resourcePanelResources = host.currentEchoInkResourceCatalog();
  host.renderToolbar();
  host.resourcePanelEl.querySelector<HTMLButtonElement>(".codex-composer-resource-row")?.focus();
  void host.plugin.buildRuntimeEchoInkResourceCatalog().then((resources) => {
    if (!host.resourcePanelOpen) return;
    host.resourcePanelResources = resources;
    host.renderToolbar();
    host.resourcePanelEl.querySelector<HTMLButtonElement>(".codex-composer-resource-row")?.focus();
  }).catch(() => undefined);
}

function closeResourcePanel(host: CodexComposerHost, restoreFocus: boolean): void {
  if (!host.resourcePanelOpen && !host.resourcePanelEl?.hasClass("is-visible")) return;
  host.resourcePanelOpen = false;
  host.resourcePanelEl?.removeClass("is-visible");
  host.resourcePanelEl?.setAttribute("aria-hidden", "true");
  host.resourcePanelAnchorEl?.setAttribute("aria-expanded", "false");
  if (restoreFocus) host.resourcePanelAnchorEl?.focus();
}

export function openKnowledgeCommandMenu(host: CodexComposerHost, event: MouseEvent): void {
  showKnowledgeCommandMenu(event, (command) => fillKnowledgeBaseCommand(host, command));
}

export function fillKnowledgeBaseCommand(host: CodexComposerHost, command: string): void {
  host.inputEl.value = command;
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.inputEl.setSelectionRange(command.length, command.length);
  closeComposerMenus(host);
  window.setTimeout(() => host.inputEl?.focus(), 50);
}

export async function submitKnowledgeBaseCommand(host: CodexComposerHost, command: string): Promise<void> {
  fillKnowledgeBaseCommand(host, command);
  await host.sendMessage();
}

export function openModelMenu(host: CodexComposerHost, event: MouseEvent): void {
  showModelMenu(event, composerModelMenuState(host), {
    onSelectModel: (selection) => void selectComposerModel(host, selection),
    onSelectReasoning: (reasoning) => selectComposerReasoning(host, reasoning),
    onSelectServiceTier: (tier) => selectComposerServiceTier(host, tier),
    onSelectMode: (mode) => selectComposerMode(host, mode)
  });
}

export function composerModelMenuState(host: CodexComposerHost) {
  return {
    providerModels: composerProviderModelOptions(host),
    selectedProviderSettingsId: host.selectedProviderSettingsId,
    selectedModel: host.selectedModel,
    selectedReasoning: host.selectedReasoning,
    selectedServiceTier: host.selectedServiceTier,
    selectedMode: host.selectedMode
  };
}

export function composerProviderModelOptions(
  host: Pick<CodexComposerHost, "plugin">
): ComposerProviderModelOption[] {
  const settings = host.plugin.settings;
  return settings.apiProviders.flatMap((provider) =>
    apiProviderHasUsableCredential(provider, settings.openAICodexCredential)
      ? provider.models.map((model) => ({
          providerSettingsId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.displayName || model.id
        }))
      : []
  );
}

export async function selectComposerModel(
  host: CodexComposerHost,
  selection: Readonly<{
    providerSettingsId: string;
    modelId: string;
  }>
): Promise<boolean> {
  const target = host.plugin.settings.apiProviders.find(
    (provider) => provider.id === selection.providerSettingsId
  );
  const targetModel = target && getApiProviderModel(target, selection.modelId);
  if (
    !target
    || !targetModel
    || !apiProviderHasUsableCredential(
      target,
      host.plugin.settings.openAICodexCredential
    )
  ) {
    new Notice("所选 Provider 或模型已不可用，请先检查 Provider 设置");
    return false;
  }
  try {
    await host.plugin.activateApiProviderSettings((settings) => {
      const candidate = settings.apiProviders.find(
        (provider) => provider.id === selection.providerSettingsId
      );
      if (
        !candidate
        || !apiProviderHasUsableCredential(
          candidate,
          settings.openAICodexCredential
        )
      ) {
        throw new Error("Provider authentication unavailable");
      }
      activateApiProviderModel(settings, candidate, selection.modelId);
    });
  } catch (error) {
    new Notice(
      `切换 Provider/模型失败：${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
  host.selectedProviderSettingsId = selection.providerSettingsId;
  host.selectedModel = selection.modelId;
  host.renderToolbar();
  new Notice(`已切换到 ${target.name} · ${targetModel.displayName || targetModel.id}`);
  return true;
}

export function selectComposerReasoning(host: CodexComposerHost, reasoning: ReasoningEffort): void {
  host.selectedReasoning = reasoning;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function selectComposerServiceTier(host: CodexComposerHost, tier: ServiceTierChoice): void {
  host.selectedServiceTier = tier;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function selectComposerMode(host: CodexComposerHost, mode: UiMode): void {
  host.selectedMode = mode;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function currentComposerSummary(host: CodexComposerHost): string {
  return `${shortModelLabel(host.effectiveModel())} ${compactReasoningLabel(host.selectedReasoning)}`;
}

export function currentComposerSummaryTitle(host: CodexComposerHost): string {
  return `模型：${host.effectiveModel() || "未选择"}\n打开模型和运行参数`;
}

export function currentComposerProviderBrand(host: CodexComposerHost): ProviderBrandId {
  const providerId = getActiveApiProvider(host.plugin.settings)?.providerId;
  switch (providerId) {
    case "glm":
    case "kimi":
    case "minimax":
    case "deepseek":
    case "ollama":
    case "custom":
      return providerId;
    default:
      return "custom";
  }
}

export function persistComposerDefaults(host: CodexComposerHost): void {
  host.plugin.settings.defaultModel = host.selectedModel;
  host.plugin.settings.defaultReasoning = host.selectedReasoning;
  host.plugin.settings.defaultServiceTier = host.selectedServiceTier;
  host.plugin.settings.defaultPermission = host.selectedPermission;
  host.plugin.settings.defaultMode = host.selectedMode;
  void host.plugin.saveSettings(true).catch((error) => {
    console.error("Codex composer defaults save failed", error);
    new Notice(`运行参数保存失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

export function onInputChanged(host: CodexComposerHost): void {
  host.skillMenuEl.removeClass("is-visible");
  closeResourcePanel(host, false);
  if (!host.inputEl.value.trim()) {
    clearPromptEnhanceReview(host.promptEnhanceReviewEl);
    const session = host.ensureSession();
    clearSelectedPiConversationDraft(host.plugin, session.id);
  }
  host.renderToolbar();
  const query = knowledgeCommandQueryForInput(host.inputEl.value);
  if (query === null) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
    return;
  }
  host.renderKnowledgeCommandMatches(query);
}

export function renderSkillMatches(host: CodexComposerHost, query = "", loadedSkills?: EchoInkResource[]): void {
  renderSkillMatchesView(
    host.skillMenuEl,
    query,
    {
      skills: enabledSkillsForComposerMenu(
        loadedSkills ?? host.currentEchoInkResourceCatalog()
      ),
      selectedSkill: host.selectedSkill
    },
    {
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        host.skillMenuEl.removeClass("is-visible");
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      }
    }
  );
}

export function enabledSkillsForComposerMenu(
  catalog: EchoInkResource[]
): EchoInkResource[] {
  return enabledSkillResources(catalog);
}

export function renderKnowledgeCommandMatches(
  host: CodexComposerHost,
  query: string,
  loadedSkills?: EchoInkResource[]
): void {
  renderKnowledgeCommandMatchesView(
    host.knowledgeCommandMenuEl,
    host.inputEl,
    query,
    {
      skills: enabledSkillsForComposerMenu(
        loadedSkills ?? host.currentEchoInkResourceCatalog()
      ),
      selectedSkill: host.selectedSkill
    },
    {
      onFillCommand: (command) => fillKnowledgeBaseCommand(host, command),
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        host.inputEl.value = removeTrailingSlashQuery(host.inputEl.value);
        clearPromptEnhanceReview(host.promptEnhanceReviewEl);
        setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      }
    }
  );
  if (host.skillsRequested) return;
  host.skillsRequested = true;
  void host.plugin.ensureEchoInkSkillResourcesLoaded(true).then((skills) => {
    const currentQuery = knowledgeCommandQueryForInput(host.inputEl.value);
    if (currentQuery !== null) renderKnowledgeCommandMatches(host, currentQuery, skills);
  }).catch(() => undefined);
}

export function removeTrailingSlashQuery(value: string): string {
  return value.replace(/(^|\s)\/[^\s/]*$/u, (_match, prefix: string) => prefix ? " " : "").replace(/\s+$/u, "");
}

export function hasComposerDraft(host: CodexComposerHost): boolean {
  return Boolean(host.inputEl?.value.trim() || host.attachments.length || host.selectedSkill);
}

export function clearComposerDraft(host: CodexComposerHost): void {
  const session = host.ensureSession();
  clearSelectedPiConversationDraft(host.plugin, session.id);
  host.inputEl.value = "";
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  closeComposerMenus(host);
  host.attachments = [];
  host.selectedSkill = null;
}

export function composerStateForSession(host: CodexComposerHost, session: StoredSession): ComposerPrimaryActionState {
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
  return composerStateForRuntimeState({
    viewRunning: host.running,
    viewRunKind: host.activeRunKind,
    globalKnowledgeTaskRunning: Boolean(knowledgeManager?.isRunning),
    hasDraft: hasComposerDraft(host),
    hasQueuedItems: host.turnQueue.hasQueuedItems(session.id)
  });
}

export function pauseQueueForSession(host: CodexComposerHost, sessionId: string): void {
  if (!host.turnQueue.hasQueuedItems(sessionId)) return;
  host.turnQueue.pauseSessionQueue(sessionId);
  host.renderQueue();
  host.renderToolbar();
}

export function requireQueueRecoveryForSession(host: CodexComposerHost, sessionId: string): void {
  host.turnQueue.requireSessionRecovery(sessionId);
  host.renderQueue();
  host.renderToolbar();
}

export function updateContext(host: CodexComposerHost, tokenUsage: StoredSession["tokenUsage"], persist: boolean): void {
  updateContextForSession(host, host.ensureSession(), tokenUsage, persist);
}

export function updateContextForSession(host: CodexComposerHost, session: StoredSession, tokenUsage: StoredSession["tokenUsage"], persist: boolean): void {
  if (persist) {
    session.tokenUsage = tokenUsage;
    session.updatedAt = Date.now();
    void host.plugin.saveSettings();
  }
  if (session.id !== host.plugin.settings.activeSessionId) return;
  if (!host.contextEl) return;
  host.contextEl.toggleClass("is-hidden", !host.plugin.settings.showContext);
  if (!host.plugin.settings.showContext) return;
  const view = contextUsageView(tokenUsage, session.contextLedger);
  host.contextEl.setCssProps({ "--codex-context-angle": `${view.angle}deg` });
  const tooltip = view.percent === null || view.effectiveInputBudget === null
    ? "暂未读取到上下文用量"
    : `${view.percent}% · ${formatContextValue(view.totalTokens)} / ${formatContextValue(view.effectiveInputBudget)} 上下文已使用`;
  host.contextEl.setAttr("aria-label", tooltip);
  host.contextEl.setAttr("title", tooltip);
  host.contextEl.toggleClass("is-empty", view.percent === null);
  host.contextEl.toggleClass("is-warning", (view.percent ?? 0) >= 80);
  if (host.contextPanelOpen && host.contextPanelEl) {
    renderContextPanel(host.contextPanelEl, session.contextLedger, () => closeContextPopover(host, true));
    host.contextPanelReposition?.();
  }
}

function formatContextValue(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}

function syncContextPopover(
  host: CodexComposerHost,
  ledger: StoredSession["contextLedger"]
): void {
  if (!host.contextPanelOpen || !host.plugin.settings.showContext) {
    host.contextPanelOpen = false;
    host.contextEl.setAttribute("aria-expanded", "false");
    return;
  }

  const doc = host.contextEl.ownerDocument;
  const win = doc.defaultView ?? window;
  const panelId = `codex-context-popover-${++contextPopoverId}`;
  const panel = doc.body.createDiv({
    cls: "codex-context-panel",
    attr: {
      id: panelId,
      role: "dialog",
      "aria-label": "上下文用量明细",
      tabindex: "-1"
    }
  });
  host.contextPanelEl = panel;
  host.contextEl.setAttribute("aria-expanded", "true");
  host.contextEl.setAttribute("aria-controls", panelId);
  renderContextPanel(panel, ledger, () => closeContextPopover(host, true));

  const reposition = () => {
    if (!host.contextEl.isConnected || !panel.isConnected) {
      closeContextPopover(host, false);
      return;
    }
    const anchorRect = host.contextEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const placement = positionAnchoredMenu(
      anchorRect,
      panelRect,
      {
        width: doc.documentElement.clientWidth,
        height: doc.documentElement.clientHeight
      }
    );
    panel.setCssStyles({
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      visibility: "visible"
    });
    panel.dataset.verticalSide = placement.verticalSide;
  };
  host.contextPanelReposition = reposition;

  const abortController = new AbortController();
  const eventOptions = { signal: abortController.signal };
  doc.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target || panel.contains(target) || host.contextEl.contains(target)) return;
    closeContextPopover(host, false);
  }, eventOptions);
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !host.contextPanelOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closeContextPopover(host, true);
  }, eventOptions);
  doc.addEventListener("scroll", reposition, { capture: true, signal: abortController.signal });
  win.addEventListener("resize", reposition, eventOptions);
  host.contextPanelCleanup = () => abortController.abort();
  reposition();
}

function closeContextPopover(host: CodexComposerHost, restoreFocus: boolean): void {
  if (!host.contextPanelOpen && !host.contextPanelEl) return;
  host.contextPanelOpen = false;
  disposeContextPopover(host);
  host.contextEl?.setAttribute("aria-expanded", "false");
  if (restoreFocus) host.contextEl?.focus();
}

export function disposeContextPopover(host: CodexComposerHost): void {
  host.contextPanelCleanup?.();
  host.contextPanelCleanup = null;
  host.contextPanelReposition = null;
  host.contextPanelEl?.remove();
  host.contextPanelEl = null;
  host.contextEl?.removeAttribute("aria-controls");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
