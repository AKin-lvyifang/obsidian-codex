import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ChatMessage, StoredAttachment, StoredSession } from "../settings/settings";
import { providerConnectionLabel } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import type {
  PermissionMode,
  ReasoningEffort,
  ServiceTierChoice,
  TokenUsage,
  UiMode
} from "../types/app-server";
import {
  cloneEchoInkTurnInteraction,
  type EchoInkTurnInteraction
} from "../types/conversation-turn";
import { diagnoseProviderError, type ProviderErrorDiagnostic } from "../core/provider-diagnostics";
import { buildUserInput } from "../core/mapping";
import { composerPrimaryActionForState, type ComposerPrimaryActionState } from "./composer-state";
import { canStartQueuedTurn, RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { clearPromptEnhanceReview } from "./codex-view/composer";
import { CodexMessageListRenderer, isProcessItemType } from "./codex-view/message-list";
import { loadMcpPanelView } from "./codex-view/mcp-panel";
import { mcpResourceEnablement } from "../resources/registry";
import { MessageScrollFollowController, type MessageRenderScheduleOptions } from "./codex-view/message-scroll-follow";
import { enhanceChatInput as enhanceChatInputRunner } from "./codex-view/prompt-enhancer-runner";
import {
  afterTurnSettled as afterTurnSettledRunner,
  createQueuedTurnFromComposer as createQueuedTurnFromComposerRunner,
  enqueueComposerDraft as enqueueComposerDraftRunner,
  handlePiTaskPlanAction as handlePiTaskPlanActionRunner,
  resumeQueuedTurns as resumeQueuedTurnsRunner,
  runKnowledgeBaseShortcut as runKnowledgeBaseShortcutRunner,
  sendMessage as sendMessageRunner,
  steerPiChatFromComposer as steerPiChatFromComposerRunner,
  startChatTurn as startChatTurnRunner,
  startNextQueuedTurn as startNextQueuedTurnRunner,
  startQueuedTurnItem as startQueuedTurnItemRunner,
  startQueuedTurnItemSafely as startQueuedTurnItemSafelyRunner
} from "./codex-view/turn-runner";
import type {
  CodexViewLifecycleSnapshot,
  CodexViewPromptEnhanceContext,
  CodexViewTurnContext
} from "./codex-view/runner-context";
import type { SessionMessageInput } from "./codex-view/session-message-store";
import {
  attachActiveFile as attachActiveFileAction,
  handleDroppedFiles as handleDroppedFilesAction,
  handlePastedFiles as handlePastedFilesAction,
  pickFiles as pickFilesAction,
  pickKnowledgeBaseFiles as pickKnowledgeBaseFilesAction,
  renderAttachmentsView,
  type CodexAttachmentHost
} from "./codex-view/attachments";
import { normalizeWorkspacePath } from "./codex-view/workspace-utils";
import {
  currentEchoInkResourceCatalog as currentEchoInkResourceCatalogAction,
  currentTurnOptions as currentTurnOptionsAction,
  effectiveModel as effectiveModelAction,
  ensureChatWorkspaceSelected as ensureChatWorkspaceSelectedAction,
  openWorkspaceMenu as openWorkspaceMenuAction,
  type CodexWorkspaceHost
} from "./codex-view/workspace-controller";
import {
  clearComposerDraft as clearComposerDraftAction,
  closeComposerMenus as closeComposerMenusAction,
  composerStateForSession as composerStateForSessionAction,
  disposeContextPopover,
  fillKnowledgeBaseCommand as fillKnowledgeBaseCommandAction,
  onInputChanged as onInputChangedAction,
  openKnowledgeCommandMenu as openKnowledgeCommandMenuAction,
  openModelMenu as openModelMenuAction,
  pauseQueueForSession as pauseQueueForSessionAction,
  requireQueueRecoveryForSession as requireQueueRecoveryForSessionAction,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesAction,
  renderQueue as renderQueueAction,
  renderToolbar as renderToolbarAction,
  submitKnowledgeBaseCommand as submitKnowledgeBaseCommandAction,
  updateContextForSession as updateContextForSessionAction,
  selectComposerMode as selectComposerModeAction,
  type CodexComposerHost
} from "./codex-view/composer-controller";
import {
  addContextCompactionMessage as addContextCompactionMessageAction,
  addMessageToSession as addMessageToSessionAction,
  attachTurnIdToRun as attachTurnIdToRunAction,
  clearKnowledgeBaseRunProgressTimer as clearKnowledgeBaseRunProgressTimerAction,
  clearSessionMessageActiveRun,
  dismissThinkingMessage as dismissThinkingMessageAction,
  ensureThinkingMessage as ensureThinkingMessageAction,
  finishPlanMessage as finishPlanMessageAction,
  finishRunningProcessMessages as finishRunningProcessMessagesAction,
  finishThinkingMessage as finishThinkingMessageAction,
  flushSessionSave as flushSessionSaveAction,
  handleMessagesScroll as handleMessagesScrollAction,
  isMessagesAtBottom as isMessagesAtBottomAction,
  isMessagesNearBottom as isMessagesNearBottomAction,
  jumpToLatest as jumpToLatestAction,
  moveMessageToEnd as moveMessageToEndAction,
  renderMessages as renderMessagesAction,
  renderMessagesIfActive as renderMessagesIfActiveAction,
  resetVirtualWindow as resetVirtualWindowAction,
  scheduleKnowledgeBaseRunProgress as scheduleKnowledgeBaseRunProgressAction,
  scheduleMeasureVirtualRows as scheduleMeasureVirtualRowsAction,
  scheduleRenderMessages as scheduleRenderMessagesAction,
  scheduleSessionSave as scheduleSessionSaveAction,
  settleStaleMessages as settleStaleMessagesAction,
  type CodexMessageHost
} from "./codex-view/message-controller";
import {
  applyStatus as applyStatusAction,
  openPluginSettings as openPluginSettingsAction,
  updateInputPlaceholder as updateInputPlaceholderAction,
  type CodexHeaderHost
} from "./codex-view/header-controller";
import {
  armTurnWatchdog as armTurnWatchdogAction,
  clearActiveRun as clearActiveRunAction,
  clearTurnWatchdog as clearTurnWatchdogAction,
  stopTurn as stopTurnAction,
  type CodexTurnLifecycleHost
} from "./codex-view/turn-lifecycle";
import { renderViewShell, type CodexViewShellHost } from "./codex-view/view-shell";
import { TaskPlanDockController } from "./codex-view/task-plan-dock";
import { InteractionDockController } from "./codex-view/interaction-dock";
import { piToolCallIdFromProjectedMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { updateCodexHeaderIdentity } from "./codex-view/header";
import { closeComposerParameterMenu } from "./codex-view/menus";
import {
  activateSession as activateSessionAction,
  activeRunSession as activeRunSessionAction,
  archiveSession as archiveSessionAction,
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  ensureInitialConversation as ensureInitialConversationAction,
  ensureSession as ensureSessionAction,
  derivePiConversationFromMessage as derivePiConversationFromMessageAction,
  refreshPiConversationShells as refreshPiConversationShellsAction,
  renderTabsView,
  renameSession as renameSessionAction,
  sessionById as sessionByIdAction,
  type CodexSessionHost
} from "./codex-view/session-controller";

export const VIEW_TYPE_CODEX = "codex-for-obsidian-view";
export { isKnowledgeDashboardHealthTooltipHoverPoint } from "./codex-view/knowledge-dashboard";

export class CodexView extends ItemView {
  private rootEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private virtualListEl!: HTMLElement;
  private jumpToLatestEl!: HTMLButtonElement;
  private taskPlanDockEl!: HTMLElement;
  private interactionDockEl!: HTMLElement;
  private workspaceEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private promptEnhanceReviewEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextRingEl!: HTMLElement;
  private contextPanelEl: HTMLElement | null = null;
  private contextPanelCleanup: (() => void) | null = null;
  private contextPanelReposition: (() => void) | null = null;
  private contextPanelOpen = false;
  private skillMenuEl!: HTMLElement;
  private knowledgeCommandMenuEl!: HTMLElement;
  private resourcePanelEl!: HTMLElement;
  private resourcePanelAnchorEl!: HTMLButtonElement;
  private resourcePanelOpen = false;
  private resourcePanelResources: EchoInkResource[] = [];
  private mcpPanelEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private queueEl!: HTMLElement;
  private running = false;
  private activeRunId = "";
  private activeRunKind: "chat" | "";
  private activeRunSessionId = "";
  private activeTurnId = "";
  private promptEnhancerRunning = false;
  private promptEnhancerRunId = "";
  private promptEnhancerTurnId = "";
  private turnStartedAt = 0;
  private turnWatchdog: number | null = null;
  private sessionSaveTimer: number | null = null;
  private readonly messageScrollFollow = new MessageScrollFollowController();
  private knowledgeBaseRunProgressTimer: number | null = null;
  private messageListRenderer = new CodexMessageListRenderer();
  private readonly taskPlanDock = new TaskPlanDockController();
  private readonly interactionDock = new InteractionDockController();
  private readonly pendingInteractionsBySession = new Map<
    string,
    Readonly<EchoInkTurnInteraction>
  >();
  private selectedSkill: EchoInkResource | null = null;
  private attachments: StoredAttachment[] = [];
  private selectedProviderSettingsId = "";
  private selectedModel = "";
  private selectedReasoning: ReasoningEffort;
  private selectedServiceTier: ServiceTierChoice;
  private selectedPermission: PermissionMode;
  private selectedMode: UiMode;
  private skillsRequested = false;
  private viewLifecycleGeneration = 0;
  private viewLifecycleAbortController = new AbortController();
  private readonly turnQueue = new RuntimeTurnQueue();
  private queueStartInProgress = false;
  private draggedQueueItemId = "";
  private readonly turnRunnerContext: CodexViewTurnContext;
  private readonly promptEnhancerRunnerContext: CodexViewPromptEnhanceContext;

  get messagesBottomFollowPaused(): boolean {
    return this.messageScrollFollow.paused;
  }

  set messagesBottomFollowPaused(paused: boolean) {
    this.messageScrollFollow.paused = paused;
  }

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.selectedProviderSettingsId = plugin.settings.activeApiProviderId;
    this.selectedModel = plugin.settings.defaultModel;
    this.selectedReasoning = plugin.settings.defaultReasoning;
    this.selectedServiceTier = plugin.settings.defaultServiceTier;
    this.selectedPermission = plugin.settings.defaultPermission;
    this.selectedMode = plugin.settings.defaultMode;
    this.activeRunKind = "";
    this.turnRunnerContext = this.createTurnRunnerContext();
    this.promptEnhancerRunnerContext = this.createPromptEnhancerRunnerContext();
  }

  private attachmentHost(): CodexAttachmentHost { return this as unknown as CodexAttachmentHost; }
  private sessionHost(): CodexSessionHost { return this as unknown as CodexSessionHost; }
  private workspaceHost(): CodexWorkspaceHost { return this as unknown as CodexWorkspaceHost; }
  private composerHost(): CodexComposerHost { return this as unknown as CodexComposerHost; }
  private messageHost(): CodexMessageHost { return this as unknown as CodexMessageHost; }
  private headerHost(): CodexHeaderHost { return this as unknown as CodexHeaderHost; }
  private turnLifecycleHost(): CodexTurnLifecycleHost { return this as unknown as CodexTurnLifecycleHost; }
  private shellHost(): CodexViewShellHost { return this as unknown as CodexViewShellHost; }

  private createTurnRunnerContext(): CodexViewTurnContext {
    const view = this;
    return {
      get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return view.running; }, set running(value) { view.running = value; }, get activeRunId() { return view.activeRunId; }, set activeRunId(value) { view.activeRunId = value; }, get activeRunKind() { return view.activeRunKind; }, set activeRunKind(value) { view.activeRunKind = value; }, get activeRunSessionId() { return view.activeRunSessionId; }, set activeRunSessionId(value) { view.activeRunSessionId = value; }, get activeTurnId() { return view.activeTurnId; }, set activeTurnId(value) { view.activeTurnId = value; },
      get turnQueue() { return view.turnQueue; }, get queueStartInProgress() { return view.queueStartInProgress; }, set queueStartInProgress(value) { view.queueStartInProgress = value; }, get turnStartedAt() { return view.turnStartedAt; }, set turnStartedAt(value) { view.turnStartedAt = value; }, get inputEl() { return view.inputEl; }, get attachments() { return view.attachments; }, get selectedSkill() { return view.selectedSkill; }, get selectedProviderSettingsId() { return view.selectedProviderSettingsId; }, set selectedProviderSettingsId(value) { view.selectedProviderSettingsId = value; }, get selectedModel() { return view.selectedModel; }, set selectedModel(value) { view.selectedModel = value; }, get messagesBottomFollowPaused() { return view.messagesBottomFollowPaused; }, set messagesBottomFollowPaused(value) { view.messagesBottomFollowPaused = value; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => view.armTurnWatchdog(timeoutMs, timeoutText), clearTurnWatchdog: () => view.clearTurnWatchdog(), clearActiveRun: () => view.clearActiveRun(), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), ensureSession: () => view.ensureSession(), composerStateForSession: (session) => view.composerStateForSession(session), enqueueComposerDraft: () => view.enqueueComposerDraft(), resumeQueuedTurns: (sessionId) => view.resumeQueuedTurns(sessionId), stopTurn: () => view.stopTurn(), pauseQueueForSession: (sessionId) => view.pauseQueueForSession(sessionId),
      createQueuedTurnFromComposer: (options) => view.createQueuedTurnFromComposer(options), startQueuedTurnItem: (item, source) => view.startQueuedTurnItem(item, source), startQueuedTurnItemSafely: (item, source) => view.startQueuedTurnItemSafely(item, source), afterTurnSettled: (sessionId, succeeded) => view.afterTurnSettled(sessionId, succeeded), startNextQueuedTurn: (sessionId) => view.startNextQueuedTurn(sessionId), startChatTurn: (session, item, source) => view.startChatTurn(session, item, source), clearComposerDraft: () => view.clearComposerDraft(),
      ensureChatWorkspaceSelected: (session) => view.ensureChatWorkspaceSelected(session), currentTurnOptions: (session) => view.currentTurnOptions(session), sessionById: (sessionId) => view.sessionById(sessionId), renderQueue: () => view.renderQueue(), renderTabs: () => view.renderTabs(), renderMessages: (options) => view.renderMessages(options), renderMessagesIfActive: (session, updatedMessage) => view.renderMessagesIfActive(session, updatedMessage), setPendingInteraction: (sessionId, interaction, expectedTurnId) => view.setPendingInteraction(sessionId, interaction, expectedTurnId), ensureThinkingMessage: (session, title, text) => view.ensureThinkingMessage(session, title, text), dismissThinkingMessage: (session) => view.dismissThinkingMessage(session), attachTurnIdToRun: (session, turnId) => view.attachTurnIdToRun(session, turnId), finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status), finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status), finishPlanMessage: (session) => view.finishPlanMessage(session), addMessageToSession: (session, message) => view.addMessageToSession(session, message), moveMessageToEnd: (session, messageId) => view.moveMessageToEnd(session, messageId), fillKnowledgeBaseCommand: (command) => view.fillKnowledgeBaseCommand(command)
    } satisfies CodexViewTurnContext;
  }

  private createPromptEnhancerRunnerContext(): CodexViewPromptEnhanceContext {
    const view = this;
    return {
      get plugin() { return view.plugin; }, get normalTaskRunning() { return view.running; }, get inputEl() { return view.inputEl; }, get promptEnhanceReviewEl() { return view.promptEnhanceReviewEl; }, get promptEnhancerRunning() { return view.promptEnhancerRunning; }, set promptEnhancerRunning(value) { view.promptEnhancerRunning = value; }, get promptEnhancerRunId() { return view.promptEnhancerRunId; }, set promptEnhancerRunId(value) { view.promptEnhancerRunId = value; }, get promptEnhancerTurnId() { return view.promptEnhancerTurnId; }, set promptEnhancerTurnId(value) { view.promptEnhancerTurnId = value; },
      captureViewLifecycle: () => view.captureViewLifecycle(), applyStatus: () => view.applyStatus(), renderToolbar: () => view.renderToolbar(), onInputChanged: () => view.onInputChanged(), focusInput: () => view.focusInput()
    } satisfies CodexViewPromptEnhanceContext;
  }


  getViewType(): string {
    return VIEW_TYPE_CODEX;
  }

  getDisplayText(): string {
    return "Codex";
  }

  getIcon(): string {
    return "bot";
  }

  refreshPersonalizationUi(): void {
    if (this.rootEl) {
      updateCodexHeaderIdentity(
        this.rootEl,
        this.plugin.getEchoInkAgentIdentityView()
      );
    }
    this.renderMessages({ preserveScroll: true });
  }

  async onOpen(): Promise<void> {
    this.viewLifecycleAbortController?.abort();
    this.viewLifecycleGeneration = (
      Number.isSafeInteger(this.viewLifecycleGeneration)
        ? this.viewLifecycleGeneration
        : 0
    ) + 1;
    this.viewLifecycleAbortController = new AbortController();
    try {
      await refreshPiConversationShellsAction(this.sessionHost());
    } catch (error) {
      console.error("Pi Conversation Catalog refresh failed", error);
      new Notice(
        `读取会话列表失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    const initialConversation = await ensureInitialConversationAction(this.sessionHost());
    this.render();
    if (!initialConversation.created) {
      try {
        await activateSessionAction(this.sessionHost(), initialConversation.session);
      } catch (error) {
        console.error("Pi Conversation activation failed", error);
        new Notice(
          `恢复会话失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.applyStatus();
  }

  async onClose(): Promise<void> {
    this.viewLifecycleGeneration = (
      Number.isSafeInteger(this.viewLifecycleGeneration)
        ? this.viewLifecycleGeneration
        : 0
    ) + 1;
    this.viewLifecycleAbortController?.abort();
    try {
      closeComposerParameterMenu();
      disposeContextPopover(this.composerHost());
      this.contextPanelOpen = false;
      this.clearTurnWatchdog();
      this.clearKnowledgeBaseRunProgressTimer();
      const activeRunId = this.activeRunId;
      const activeRunKind = this.activeRunKind;
      const activeRunSessionId = activeRunId ? this.activeRunSession().id : "";
      const activePiChatRun = Boolean(
        activeRunId
        && activeRunKind === "chat"
        && this.plugin.isPiProductionRun(activeRunId)
      );
      const promptEnhancerRunId = this.promptEnhancerRunId;
      this.promptEnhancerRunning = false;
      this.promptEnhancerRunId = "";
      this.promptEnhancerTurnId = "";
      if (promptEnhancerRunId) {
        await this.plugin.cancelHarnessRun(promptEnhancerRunId).catch((error) => {
          console.error("Prompt enhancer cancellation failed while closing EchoInk", error);
        });
      }
      if (activeRunId) {
        const cancelError = await this.plugin.cancelHarnessRun(activeRunId).then(
          () => null,
          (error) => error instanceof Error ? error : new Error(String(error))
        );
        if (cancelError && activeRunKind === "chat") {
          console.error("Chat cancellation failed while closing EchoInk", cancelError);
        }
        this.running = false;
        this.clearActiveRun();
        if (activePiChatRun) {
          this.plugin.releasePiProductionRun(activeRunId);
        }
      }
      await this.flushSessionSave();
      const activeSession = this.plugin.settings.sessions.find(
        (session) => session.id === this.plugin.settings.activeSessionId
      );
      if (activeSession) {
        await this.plugin.releasePiConversation(activeSession.id).catch((error) => {
          console.error("Pi Conversation release failed while closing EchoInk", error);
        });
      }
    } finally {
      this.taskPlanDock.dispose();
      this.interactionDock.dispose();
      this.pendingInteractionsBySession.clear();
      this.messageListRenderer.dispose();
    }
  }

  private captureViewLifecycle(): CodexViewLifecycleSnapshot {
    return {
      generation: this.viewLifecycleGeneration,
      signal: this.viewLifecycleAbortController.signal
    };
  }

  applySavedComposerDefaults(): void {
    this.selectedProviderSettingsId = this.plugin.settings.activeApiProviderId;
    this.selectedModel = this.plugin.settings.defaultModel;
    this.selectedReasoning = this.plugin.settings.defaultReasoning;
    this.selectedServiceTier = this.plugin.settings.defaultServiceTier;
    this.selectedPermission = this.plugin.settings.defaultPermission;
    this.selectedMode = this.plugin.settings.defaultMode;
    this.renderToolbar();
  }

  refreshActiveSession(): void {
    this.resetVirtualWindow();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.updateInputPlaceholder();
    this.focusInput();
  }

  async refreshPiConversationCatalog(): Promise<void> {
    await refreshPiConversationShellsAction(this.sessionHost());
    this.refreshActiveSession();
  }

  refreshKnowledgeBaseDashboard(): void {
    this.renderToolbar();
  }

  refreshAfterBackgroundKnowledgeMessage(): void {
    this.renderTabs();
    this.renderMessages({ forceBottom: this.isMessagesNearBottom() });
  }

  private diagnoseCodexFailure(error: unknown, model = this.effectiveModel()): ProviderErrorDiagnostic {
    return diagnoseProviderError(error, {
      model,
      providerLabel: providerConnectionLabel(this.plugin.settings)
    });
  }

  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  private render(): void {
    renderViewShell(this.shellHost());
  }

  private updateInputPlaceholder(): void { updateInputPlaceholderAction(this.headerHost()); }
  private applyStatus(): void { applyStatusAction(this.headerHost()); }
  private openPluginSettings(): void { openPluginSettingsAction(this.headerHost()); }
  private renderTabs(): void { renderTabsView(this.sessionHost()); }
  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void { renderMessagesAction(this.messageHost(), options); }
  private renderTaskPlanDock(session: StoredSession): void {
    this.taskPlanDock.render(this.taskPlanDockEl, {
      sessionId: session.id,
      messages: session.bodyAuthority === "pi_session_only"
        ? session.messages
        : [],
      onAction: (planId, action) => this.handlePiTaskPlanAction(planId, action),
      onModify: (planId, title) => this.preparePiTaskPlanModification(planId, title)
    });
  }
  private renderInteractionDock(session: StoredSession): void {
    const pending = this.pendingInteractionsBySession.get(session.id);
    const questionBinding = pending?.kind === "question"
      && pending.status === "pending"
      && pending.conversationId === session.id
      && pending.piSessionId === session.piSessionId
      ? this.plugin.piTurnInteractionBinding({
          conversationId: session.id,
          piSessionId: pending.piSessionId,
          productRunId: pending.turnId,
          interactionId: pending.interactionId
        })
      : null;
    const confirmationBinding = session.bodyAuthority === "pi_session_only"
      ? this.pendingApprovalBinding(session)
      : null;
    this.interactionDock.render(this.interactionDockEl, {
      sessionId: session.id,
      ...(questionBinding
        ? {
            question: {
              binding: questionBinding,
              onResolved: () => {
                this.setPendingInteraction(session.id, null, pending?.turnId);
              }
            }
          }
        : {}),
      ...(confirmationBinding
        ? {
            confirmation: {
              binding: confirmationBinding,
              onResolved: () => this.renderInteractionDock(session)
            }
          }
        : {}),
      onStale: () => {
        new Notice("该交互已失效，请等待当前会话状态刷新。");
        this.renderInteractionDock(session);
      },
      onScheduleMeasure: () => this.scheduleMeasureVirtualRows()
    });
  }
  private pendingApprovalBinding(session: StoredSession) {
    const piSessionId = session.piSessionId?.trim();
    if (!piSessionId) return null;
    for (const message of session.messages.slice().reverse()) {
      const productRunId = message.runId?.trim();
      const toolCallId = piToolCallIdFromProjectedMessageId(message.id);
      if (!productRunId || !toolCallId) continue;
      const binding = this.plugin.piAgentApprovalBinding({
        conversationId: session.id,
        piSessionId,
        productRunId,
        toolCallId
      });
      if (binding) return binding;
    }
    return null;
  }
  private setPendingInteraction(
    sessionId: string,
    interaction: Readonly<EchoInkTurnInteraction> | null,
    expectedTurnId?: string
  ): void {
    const current = this.pendingInteractionsBySession.get(sessionId);
    if (interaction) {
      if (interaction.conversationId !== sessionId) return;
      this.pendingInteractionsBySession.set(
        sessionId,
        cloneEchoInkTurnInteraction(interaction)
      );
    } else if (!expectedTurnId || current?.turnId === expectedTurnId) {
      this.pendingInteractionsBySession.delete(sessionId);
    }
    if (this.plugin.settings.activeSessionId === sessionId) {
      const session = this.sessionById(sessionId);
      if (session) this.renderInteractionDock(session);
    }
  }
  private renderToolbar(): void { renderToolbarAction(this.composerHost()); }
  private enhancePrompt(): void { void enhanceChatInputRunner(this.promptEnhancerRunnerContext); }
  private renderQueue(): void { renderQueueAction(this.composerHost()); }
  private renderAttachments(): void { renderAttachmentsView(this.attachmentHost()); }
  private closeComposerMenus(): void { closeComposerMenusAction(this.composerHost()); }
  private openWorkspaceMenu(event: MouseEvent, session: StoredSession): void { openWorkspaceMenuAction(this.workspaceHost(), event, session); }

  private async ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean> {
    return await ensureChatWorkspaceSelectedAction(this.workspaceHost(), session);
  }

  private openKnowledgeCommandMenu(event: MouseEvent): void { openKnowledgeCommandMenuAction(this.composerHost(), event); }
  fillKnowledgeBaseCommand(command: string): void { fillKnowledgeBaseCommandAction(this.composerHost(), command); }
  async submitKnowledgeBaseCommand(command: string): Promise<void> { await submitKnowledgeBaseCommandAction(this.composerHost(), command); }
  private openModelMenu(event: MouseEvent): void { openModelMenuAction(this.composerHost(), event); }

  private async renameSession(session: StoredSession): Promise<void> {
    await renameSessionAction(this.sessionHost(), session);
  }

  private async archiveSession(sessionId: string): Promise<void> {
    await archiveSessionAction(this.sessionHost(), sessionId);
  }

  private async derivePiConversationFromMessage(
    session: StoredSession,
    targetEntryId: string
  ): Promise<void> {
    await derivePiConversationFromMessageAction(
      this.sessionHost(),
      session,
      targetEntryId
    );
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionAction(this.sessionHost(), sessionId);
  }

  private onInputChanged(): void {
    onInputChangedAction(this.composerHost());
  }
  private renderKnowledgeCommandMatches(query: string): void { renderKnowledgeCommandMatchesAction(this.composerHost(), query); }
  private clearComposerDraft(): void { clearComposerDraftAction(this.composerHost()); }
  private composerStateForSession(session: StoredSession): ComposerPrimaryActionState { return composerStateForSessionAction(this.composerHost(), session); }
  private pauseQueueForSession(sessionId: string): void { pauseQueueForSessionAction(this.composerHost(), sessionId); }
  private requireQueueRecoveryForSession(sessionId: string): void { requireQueueRecoveryForSessionAction(this.composerHost(), sessionId); }
  private sessionById(sessionId: string): StoredSession | null { return sessionByIdAction(this.sessionHost(), sessionId); }

  private async sendMessage(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice("提示词正在增强，请稍候");
      return;
    }
    await sendMessageRunner(this.turnRunnerContext);
  }

  private async enqueueComposerDraft(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice("提示词正在增强，请稍候");
      return;
    }
    await enqueueComposerDraftRunner(this.turnRunnerContext);
  }
  private async steerPiChatFromComposer(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice("提示词正在增强，请稍候");
      return;
    }
    await steerPiChatFromComposerRunner(this.turnRunnerContext);
  }
  private async handlePiTaskPlanAction(
    planId: string,
    action: "execute" | "continue" | "pause" | "cancel"
  ): Promise<void> {
    await handlePiTaskPlanActionRunner(this.turnRunnerContext, planId, action);
  }
  private preparePiTaskPlanModification(planId: string, title: string): void {
    if (this.running) {
      new Notice("请先暂停当前计划，再修改计划。");
      return;
    }
    selectComposerModeAction(this.composerHost(), "plan");
    this.inputEl.value = `请修改任务计划“${title}”（planId: ${planId}）：`;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.focusInput();
  }
  private async resumeQueuedTurns(sessionId: string): Promise<void> { await resumeQueuedTurnsRunner(this.turnRunnerContext, sessionId); }
  private async afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void> { await afterTurnSettledRunner(this.turnRunnerContext, sessionId, succeeded); }
  private async startNextQueuedTurn(sessionId: string): Promise<void> { await startNextQueuedTurnRunner(this.turnRunnerContext, sessionId); }
  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> { return await createQueuedTurnFromComposerRunner(this.turnRunnerContext, options); }
  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startQueuedTurnItemRunner(this.turnRunnerContext, item, source); }
  private async startQueuedTurnItemSafely(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startQueuedTurnItemSafelyRunner(this.turnRunnerContext, item, source); }
  private async startChatTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startChatTurnRunner(this.turnRunnerContext, session, item, source); }
  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> { await runKnowledgeBaseShortcutRunner(this.turnRunnerContext, label, runner); }
  private async stopTurn(): Promise<void> { await stopTurnAction(this.turnLifecycleHost()); }
  private settleStaleMessages(session: StoredSession): void { settleStaleMessagesAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session); }
  private armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void { armTurnWatchdogAction(this.turnLifecycleHost(), timeoutMs, timeoutText); }
  private clearTurnWatchdog(): void { clearTurnWatchdogAction(this.turnLifecycleHost()); }
  private currentTurnOptions(session?: StoredSession) { return currentTurnOptionsAction(this.workspaceHost(), session); }
  private currentEchoInkResourceCatalog(): EchoInkResource[] { return currentEchoInkResourceCatalogAction(this.workspaceHost()); }
  private effectiveModel(): string { return effectiveModelAction(this.workspaceHost()); }

  private ensureThinkingMessage(session: StoredSession, title: string, text: string): void { ensureThinkingMessageAction(this.messageHost(), session, title, text); }
  private dismissThinkingMessage(session: StoredSession): void { dismissThinkingMessageAction(this.messageHost(), session); }
  private finishThinkingMessage(session: StoredSession, _status: string): void { finishThinkingMessageAction(this.messageHost(), session, _status); }
  private finishPlanMessage(session: StoredSession): void { finishPlanMessageAction(this.messageHost(), session); }
  private finishRunningProcessMessages(session: StoredSession, status: string): void { finishRunningProcessMessagesAction(this.messageHost(), session, status); }
  private addMessageToSession(session: StoredSession, message: SessionMessageInput): void { addMessageToSessionAction(this.messageHost(), session, message); }
  private scheduleSessionSave(): void { scheduleSessionSaveAction(this.messageHost()); }
  private async flushSessionSave(): Promise<void> { await flushSessionSaveAction(this.messageHost()); }
  private moveMessageToEnd(session: StoredSession, messageId: string): void { moveMessageToEndAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session, messageId); }
  private updateContext(tokenUsage: TokenUsage | undefined, persist: boolean): void { this.updateContextForSession(this.ensureSession(), tokenUsage, persist); }
  private updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void { updateContextForSessionAction(this.composerHost(), session, tokenUsage, persist); }

  private async toggleMcpPanel(): Promise<void> {
    const willOpen = !this.mcpPanelEl.hasClass("is-visible");
    this.mcpPanelEl.toggleClass("is-visible", willOpen);
    if (!willOpen) return;
    this.mcpPanelEl.empty();
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-title", text: "MCP 状态" });
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-empty", text: "正在读取 MCP 状态..." });
    await this.loadMcpPanel();
  }

  private async loadMcpPanel(): Promise<void> {
    await loadMcpPanelView({
      container: this.mcpPanelEl,
      loadResources: () => mcpResourceEnablement(
        this.currentEchoInkResourceCatalog()
      )
    });
  }

  private activeRunSession(): StoredSession { return activeRunSessionAction(this.sessionHost()); }
  private addContextCompactionMessage(session: StoredSession): void { addContextCompactionMessageAction(this.messageHost(), session); }
  private clearActiveRun(): void {
    if (typeof (this as unknown as { turnLifecycleHost?: unknown }).turnLifecycleHost === "function") {
      clearActiveRunAction(this.turnLifecycleHost(), () => clearSessionMessageActiveRun(this.messageHost()));
      return;
    }
    const host = this as unknown as { activeRunId: string; activeRunKind: string; activeRunSessionId: string; activeTurnId: string; activeThinkingMessageId?: string; activePlanMessageId?: string };
    host.activeRunId = "";
    host.activeRunKind = "";
    host.activeRunSessionId = "";
    host.activeTurnId = "";
    host.activeThinkingMessageId = "";
    host.activePlanMessageId = "";
  }
  private attachTurnIdToRun(session: StoredSession, turnId: string): void { attachTurnIdToRunAction(this.messageHost(), session, turnId); }
  private renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void { renderMessagesIfActiveAction(this.messageHost(), session, updatedMessage); }
  private handleMessagesScroll(): void { handleMessagesScrollAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private jumpToLatest(): void { jumpToLatestAction(this.messageHost()); }
  private scheduleRenderMessages(options: MessageRenderScheduleOptions = {}): void { scheduleRenderMessagesAction(this.messageHost(), options); }
  private scheduleMeasureVirtualRows(forceBottom = !this.messagesBottomFollowPaused): void { scheduleMeasureVirtualRowsAction(this.messageHost(), forceBottom); }
  private scheduleKnowledgeBaseRunProgress(): void { scheduleKnowledgeBaseRunProgressAction(this.messageHost()); }
  private clearKnowledgeBaseRunProgressTimer(): void { clearKnowledgeBaseRunProgressTimerAction(this.messageHost()); }
  private isMessagesNearBottom(): boolean { return isMessagesNearBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private isMessagesAtBottom(): boolean { return isMessagesAtBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private resetVirtualWindow(): void { resetVirtualWindowAction(this.messageHost()); }
  private ensureSession(): StoredSession { return ensureSessionAction(this.sessionHost()); }
  private async createSession(title = "新会话"): Promise<StoredSession> {
    return await createSessionAction(this.sessionHost(), title);
  }
  private attachActiveFile(): void { attachActiveFileAction(this.attachmentHost()); }
  private pickFiles(imagesOnly: boolean): void { pickFilesAction(this.attachmentHost(), imagesOnly); }
  private pickKnowledgeBaseFiles(): void { pickKnowledgeBaseFilesAction(this.attachmentHost()); }
  private handleDroppedFiles(event: DragEvent): void { handleDroppedFilesAction(this.attachmentHost(), event); }
  private async handlePastedFiles(event: ClipboardEvent): Promise<void> { await handlePastedFilesAction(this.attachmentHost(), event); }
}
