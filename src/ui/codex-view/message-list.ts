import { Notice, normalizePath, Platform, setIcon, TFile, type App, type Component, type Editor } from "obsidian";
import type {
  ChatMessage,
  DiffSummary,
  EchoInkWelcomeCopy,
  PersonalMemorySourceReference,
  SettingsLanguage,
  StoredAttachment
} from "../../settings/settings";
import type { KnowledgeBaseCitation, KnowledgeBaseCitationBucket, KnowledgeBaseCitationSummary, KnowledgeWorkflowEvent, KnowledgeWorkflowPhaseId } from "../../knowledge-base/types";
import type { ProcessFileRef, TokenUsage } from "../../types/app-server";
import { showItemInFinder } from "../../core/electron";
import { basename, normalizeProcessFileRef } from "../../core/mapping";
import { diffSummaryLabel, parseFileChangeDiff, type ParsedDiffFile } from "../../core/diff-summary";
import { displayTextForMessage, isLargeRawMessage } from "../../core/raw-message-store";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom } from "../../core/virtual-window";
import { extractKnowledgeBaseResultTitle } from "../knowledge-base-result-title";
import type { KnowledgeBaseMaintainReportPayload, KnowledgeBaseMaintainReportSectionItem, KnowledgeBaseMessageUiPayload, KnowledgeBaseRunPayload } from "../../knowledge-base/maintain-report-card";
import { formatMessageHeaderTime } from "../message-time";
import { openImageOverlay, renderPreformattedVaultNoteText, renderRichText } from "../render-message";
import { buildActionTimeline, isActionTimelineItem, type ActionGroupKind, type ActionItemViewModel } from "./action-timeline";
import { buildAgentTurnProjection, formatAgentTurnDuration, isAgentAnswerMessage, isAgentProcessItemType, type CompletedAgentTurn } from "./agent-turn-process";
import { copyAnswerMarkdown } from "./answer-copy";
import { piEntryIdFromProjectedMessageId } from "../../harness/pi-native/pi-chat-ui-projector";
import type { KnowledgeReference } from "../../knowledge-base/types";
import {
  knowledgeUsageMessageData,
  mergeKnowledgeUsageMessageData,
  type KnowledgeUsageMessageData
} from "../../knowledge-base/usage";
import {
  taskPlanProgress,
  type EchoInkTaskPlanStepStatus,
  type EchoInkTaskPlanStatus
} from "../../types/task-plan";
import { renderProviderBrandIcon, type ProviderBrandId } from "../../settings/provider-brand-icons";
import { API_PROVIDER_PRESETS } from "../../settings/provider-presets";
import {
  createAIElementsDocumentSources,
  createAIElementsTask,
  createSmoothAIApprovalCard,
  createSmoothAIArtifact,
  createSmoothAIMessageBody,
  createSmoothAIReasoning,
  markSmoothAIApproval,
  markSmoothAIArtifact,
  markSmoothAIDiff,
  markSmoothAIReasoning,
  markSmoothAIResponse,
  markSmoothAIToolCall,
  renderSmoothAILoader,
  renderSmoothAISuggestions,
  renderSmoothAIToolStatus,
  renderSmoothBlurOutUp,
  smoothAIStatus,
  type SmoothAIApprovalState
} from "./smooth-chat-ui";

type MessageRenderRow =
  | { id: string; kind: "message"; message: ChatMessage; showAgentHeader: boolean; showAgentFooter: boolean; processExpanded: boolean }
  | { id: string; kind: "actionItem"; message: ChatMessage; showAgentHeader: boolean }
  | { id: string; kind: "turnProcess"; turn: CompletedAgentTurn; showAgentHeader: boolean };

interface LocalVaultDocumentSource {
  citations: KnowledgeBaseCitation[];
  key: string;
  kind: "vault";
  path: string;
  references: KnowledgeReference[];
}

interface LocalMemoryDocumentSource {
  key: string;
  kind: "memory";
  source: PersonalMemorySourceReference;
}

type LocalDocumentSource = LocalVaultDocumentSource | LocalMemoryDocumentSource;

export interface MessageListRenderOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

/** 只读展示快照：当前 Agent 名称 + 头像 URL（null = 默认 bot 图标）。 */
export interface AgentIdentityView {
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface MessageApprovalDecisionBinding {
  readonly target: string;
  readonly preview: string;
  decide(decision: "approve" | "reject"): boolean;
}

export interface MessageListRenderInput {
  app: App;
  component: Component;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  sessionId: string;
  welcomeCopy: Readonly<EchoInkWelcomeCopy>;
  settingsLanguage: SettingsLanguage;
  messages: ChatMessage[];
  /** 当前 Agent 身份展示快照；缺省时回退 EchoInk + bot 图标。 */
  agentIdentity?: AgentIdentityView;
  tokenUsage?: TokenUsage;
  vaultPath: string;
  readRawMessageText: (rawRef: string) => Promise<string>;
  onDerivePiConversation?: (entryId: string) => Promise<void>;
  piConversationDeriveDisabled?: boolean;
  onTaskPlanAction?: (
    planId: string,
    action: "execute" | "continue" | "pause" | "cancel"
  ) => Promise<void>;
  onModifyTaskPlan?: (planId: string, title: string) => void;
  resolveApprovalDecision?: (
    message: Readonly<ChatMessage>
  ) => MessageApprovalDecisionBinding | null;
  onSuggestionSelect?: (text: string) => void;
  onScheduleMeasure: (forceBottom?: boolean) => void;
  onScheduleRunProgress: () => void;
  shouldFollowBottom?: () => boolean;
  options?: MessageListRenderOptions;
}

interface MessageListEnvironment extends MessageListRenderInput {
  options: MessageListRenderOptions;
}

interface PendingProcessMessageUpdate {
  message: ChatMessage;
  sessionId: string;
  shouldPinBottom: boolean;
}

export class LatestByKeyFrameBatcher<T> {
  private readonly pending = new Map<string, T>();
  private scheduled = false;

  enqueue(
    key: string,
    value: T,
    scheduleFrame: (callback: () => void) => void,
    flush: (values: T[]) => void
  ): void {
    this.pending.set(key, value);
    if (this.scheduled) return;
    this.scheduled = true;
    scheduleFrame(() => {
      this.scheduled = false;
      const values = Array.from(this.pending.values());
      this.pending.clear();
      if (values.length) flush(values);
    });
  }
}

const KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT = 18;
const KNOWLEDGE_BASE_RUN_CELL_MS = 360;
const MESSAGE_LIST_BOTTOM_SPACER_PX = 0;
const MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX = 2;
const VIRTUAL_RERENDER_BURST_LIMIT = 24;
const VIRTUAL_RERENDER_WINDOW_MS = 1000;
const AGENT_LIVE_COPY_INTERVAL_MS = 1800;
const PROCESS_CONTENT_UNAVAILABLE_TEXT = "后端未提供可展示内容";
const COLD_START_STATUS_TEXT = "正在整理上下文";
const COLD_START_COPY_TEXTS = ["先把问题看明白", "等模型接上话", "把上下文放到手边"];
const EMPTY_CONVERSATION_SUGGESTIONS = [
  { id: "organize-knowledge-base", label: "整理知识库" },
  { id: "summarize-current-note", label: "总结当前笔记" },
  { id: "search-knowledge-base", label: "从知识库找答案" }
] as const;

export interface KnowledgeBaseRunProgressState {
  totalCells: number;
  filledCells: number;
  activeIndex: number;
}

export function knowledgeBaseRunProgressState(status: string | undefined, createdAt: number, now: number, phaseCount: number): KnowledgeBaseRunProgressState {
  const totalCells = KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, phaseCount - 1);
  if (status === "completed") {
    return { totalCells, filledCells: totalCells, activeIndex: -1 };
  }
  if (status !== "running") {
    return { totalCells, filledCells: 0, activeIndex: -1 };
  }
  const elapsedCells = Math.floor(Math.max(0, now - createdAt) / KNOWLEDGE_BASE_RUN_CELL_MS);
  const filledCells = Math.max(0, Math.min(Math.max(0, totalCells - 1), elapsedCells));
  const activeIndex = filledCells >= totalCells
    ? -1
    : Math.min(Math.floor(filledCells / KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT), phaseCount - 2);
  return { totalCells, filledCells, activeIndex };
}

export function knowledgeBaseRunProgressStateFromEvents(status: string | undefined, events: KnowledgeWorkflowEvent[], phaseCount: number): KnowledgeBaseRunProgressState | null {
  if (!events.length) return null;
  const totalCells = KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, phaseCount - 1);
  if (status === "completed" || events.some((event) => event.type === "workflow.completed" && event.status === "success")) {
    return { totalCells, filledCells: totalCells, activeIndex: -1 };
  }
  const phaseOrder: KnowledgeWorkflowPhaseId[] = ["prepare", "digest", "organize", "report", "complete"];
  const completed = new Set(events.filter((event) => event.type === "workflow.phase.completed" && event.phaseId).map((event) => event.phaseId as KnowledgeWorkflowPhaseId));
  const lastPhaseEvent = events.slice().reverse().find((event) => event.phaseId && (event.type === "workflow.phase.started" || event.type === "workflow.phase.progress" || event.type === "workflow.phase.failed"));
  const activePhase = lastPhaseEvent?.phaseId;
  const activeIndex = activePhase ? phaseOrder.indexOf(activePhase) : -1;
  const furthestCompletedSegment = events
    .filter((event) => event.type === "workflow.phase.completed" && event.phaseId)
    .reduce((furthest, event) => {
      const index = phaseOrder.indexOf(event.phaseId as KnowledgeWorkflowPhaseId);
      return index < 0 ? furthest : Math.max(furthest, index + 1);
    }, 0);
  const completedSegments = Math.min(
    Math.max(0, phaseCount - 1),
    Math.max(
      furthestCompletedSegment,
      activeIndex >= 0 ? activeIndex : 0,
      phaseOrder.slice(0, Math.max(0, phaseCount - 1)).filter((phase) => completed.has(phase)).length
    )
  );
  const progressEvent = activePhase
    ? events.slice().reverse().find((event) => event.phaseId === activePhase && event.type === "workflow.phase.progress" && typeof event.current === "number" && typeof event.total === "number" && event.total > 0)
    : undefined;
  const progressCells = progressEvent
    ? Math.floor(Math.max(0, Math.min(1, (progressEvent.current ?? 0) / (progressEvent.total ?? 1))) * KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT)
    : 0;
  return {
    totalCells,
    filledCells: Math.max(0, Math.min(totalCells, completedSegments * KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT + progressCells)),
    activeIndex
  };
}

export function messageListVirtualHeight(contentHeight: number, viewportHeight: number): number {
  return Math.max(Math.max(0, contentHeight) + MESSAGE_LIST_BOTTOM_SPACER_PX, Math.max(1, viewportHeight));
}

export function scrollTopForMessageListBottom(contentHeight: number, viewportHeight: number): number {
  return scrollTopForVirtualBottom(messageListVirtualHeight(contentHeight, viewportHeight), viewportHeight);
}

export function shouldPinMessageListBottom(options: MessageListRenderOptions, nearBottom: boolean): boolean {
  return Boolean(options.forceBottom) || (!options.fromScroll && !options.preserveScroll && nearBottom);
}

export function piConversationDeriveActionLabel(
  message: Pick<ChatMessage, "role">
): "从这条回复新建会话" | null {
  if (message.role === "assistant") return "从这条回复新建会话";
  return null;
}

export function knowledgeBaseMaintainSectionOpenState(storedOpen: boolean | undefined, initiallyOpen: boolean): boolean {
  return storedOpen ?? initiallyOpen;
}

export function knowledgeBaseMaintainReportItemPath(item: KnowledgeBaseMaintainReportSectionItem): string | undefined {
  const explicitPath = item.path?.trim();
  if (explicitPath) return explicitPath;
  const legacyTitle = item.title.trim();
  return /\.(?:md|markdown|txt)$/i.test(legacyTitle) ? legacyTitle : undefined;
}

/** Empty source metadata can mean an older event did not persist it. */
export function personalMemorySourceCountLabel(count: number): string {
  return count > 0 ? `${count} 条 Personal Memory` : "Personal Memory 来源";
}

export function personalMemorySourceEmptyStateLabel(): string {
  return "未记录可展示的 Personal Memory 来源。";
}

export interface ReasoningDisclosureState {
  readonly open: boolean;
  readonly manual: boolean;
  readonly autoFoldHandled: boolean;
  readonly lastStatus: string;
}

export function nextReasoningDisclosureState(
  previous: Readonly<ReasoningDisclosureState> | undefined,
  status: string
): Readonly<ReasoningDisclosureState> {
  if (!previous) {
    const running = status === "running";
    return Object.freeze({
      open: running,
      manual: false,
      autoFoldHandled: !running,
      lastStatus: status
    });
  }
  if (
    !previous.manual
    && !previous.autoFoldHandled
    && previous.lastStatus === "running"
    && status !== "running"
  ) {
    return Object.freeze({
      open: false,
      manual: false,
      autoFoldHandled: true,
      lastStatus: status
    });
  }
  return Object.freeze({ ...previous, lastStatus: status });
}

export class CodexMessageListRenderer {
  private virtualSessionId = "";
  private virtualRowHeights = new Map<string, number>();
  private viewportResizeObserver: ResizeObserver | null = null;
  private observedMessagesEl: HTMLElement | null = null;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private rawTextCache = new Map<string, string>();
  private openProcessItems = new Map<string, boolean>();
  private openActionItemDetails = new Map<string, boolean>();
  private openCompletedTurns = new Map<string, boolean>();
  private openKnowledgeBaseCitations = new Map<string, boolean>();
  private openKnowledgeBaseReportSections = new Map<string, boolean>();
  private openTaskPlans = new Map<string, boolean>();
  private reasoningDisclosureStates = new Map<string, ReasoningDisclosureState>();
  private env: MessageListEnvironment | null = null;
  private virtualRerenderScheduled = false;
  private virtualRerenderBurst = 0;
  private virtualRerenderWindowStartedAt = 0;
  private virtualRerenderTrailingTimer: number | null = null;
  private virtualRerenderPendingForceBottom = false;
  private readonly processMessageBatcher = new LatestByKeyFrameBatcher<PendingProcessMessageUpdate>();
  private readonly answerMessageBatcher = new LatestByKeyFrameBatcher<PendingProcessMessageUpdate>();

  render(input: MessageListRenderInput): void {
    const env: MessageListEnvironment = { ...input, options: input.options ?? {} };
    this.env = env;
    const { messagesEl, virtualListEl, messages } = env;
    this.observeMessageViewport(messagesEl);
    if (this.virtualSessionId !== env.sessionId) {
      this.virtualSessionId = env.sessionId;
      this.virtualRowHeights.clear();
      this.cancelVirtualRerenderTrailing(true);
      this.resetVirtualRerenderThrottle();
    }
    const previousScrollTop = messagesEl.scrollTop;
    const shouldPinBottom = shouldPinMessageListBottom(env.options, this.isNearBottom(messagesEl, virtualListEl));
    virtualListEl.empty();
    if (messages.length === 0) {
      virtualListEl.setCssStyles({ height: "100%" });
      const welcome = virtualListEl.createDiv({ cls: "codex-welcome" });
      welcome.createDiv({ cls: "codex-welcome-title", text: env.welcomeCopy.title });
      renderSmoothBlurOutUp(
        welcome.createDiv({ cls: "codex-resource-note codex-welcome-subtitle" }),
        env.welcomeCopy.subtitle
      );
      const suggestions = renderSmoothAISuggestions(
        welcome,
        EMPTY_CONVERSATION_SUGGESTIONS,
        (suggestion) => env.onSuggestionSelect?.(suggestion.label)
      );
      suggestions.addClass("codex-welcome-suggestions");
      return;
    }

    const rows = this.buildVirtualRows(messages);
    const rowIds = rows.map((row) => row.id);
    this.pruneVirtualHeights(rowIds);
    const viewportHeight = Math.max(1, messagesEl.clientHeight);
    const virtual = calculateVirtualWindow({
      rowIds,
      rowHeights: this.virtualRowHeights,
      scrollTop: previousScrollTop,
      viewportHeight
    });
    virtualListEl.setCssStyles({ height: `${messageListVirtualHeight(virtual.totalHeight, viewportHeight)}px` });

    for (const virtualRow of virtual.rows) {
      const row = rows[virtualRow.index];
      if (!row) continue;
      const rowEl = virtualListEl.createDiv({ cls: `codex-virtual-row codex-virtual-row-${row.kind}` });
      rowEl.dataset.rowId = virtualRow.id;
      rowEl.dataset.index = String(virtualRow.index);
      rowEl.setCssStyles({ transform: `translateY(${virtualRow.top}px)` });
      this.renderVirtualRow(rowEl, row);
    }

    this.measureVisibleVirtualRows(messagesEl, virtualListEl, shouldPinBottom);
    if (shouldPinBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (env.options.fromScroll || env.options.preserveScroll) {
      messagesEl.scrollTop = previousScrollTop;
    }
  }

  measureVisibleVirtualRows(messagesEl: HTMLElement, virtualListEl: HTMLElement, forceBottom = false, options: { rerender?: boolean } = {}): boolean {
    if (messagesEl.clientHeight === 0) return false;
    if (forceBottom && (this.virtualRerenderScheduled || this.virtualRerenderTrailingTimer !== null)) {
      this.virtualRerenderPendingForceBottom = true;
    }
    let changed = false;
    for (const child of Array.from(virtualListEl.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset.rowId;
      if (!id) continue;
      const measuredHeight = child.getBoundingClientRect().height;
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) continue;
      const height = Math.ceil(measuredHeight);
      if (this.virtualRowHeights.get(id) !== height) {
        this.virtualRowHeights.set(id, height);
        changed = true;
      }
    }
    if (changed && options.rerender !== false) this.scheduleMeasuredRowsRerender(forceBottom);
    if (!changed) {
      this.resetVirtualRerenderThrottle();
    }
    if (forceBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return changed;
  }

  tryUpdateMessage(message: ChatMessage): boolean {
    const env = this.env;
    if (!env || message.rawRef || message.citations || message.itemType === "knowledgeBase") return false;
    const processMessage = isAgentProcessItemType(message.itemType);
    if (!processMessage && message.status !== "running") return false;
    const target = this.findRenderedMessageElement(message.id);
    const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
    if (!wrapper) return false;
    const shouldPinBottom = env.shouldFollowBottom
      ? env.shouldFollowBottom()
      : this.isAtBottom(env.messagesEl, env.virtualListEl);
    if (processMessage) {
      const virtualRow = wrapper.closest<HTMLElement>(".codex-virtual-row");
      if (!isDirectProcessVirtualRow(virtualRow?.dataset.rowId, message)) return false;
      this.processMessageBatcher.enqueue(
        message.id,
        { message, sessionId: env.sessionId, shouldPinBottom },
        (callback) => window.requestAnimationFrame(callback),
        (updates) => this.flushProcessMessageUpdates(updates)
      );
      return true;
    }
    this.answerMessageBatcher.enqueue(
      message.id,
      { message, sessionId: env.sessionId, shouldPinBottom },
      (callback) => window.requestAnimationFrame(callback),
      (updates) => this.flushAnswerMessageUpdates(updates)
    );
    return true;
  }

  isNearBottom(messagesEl: HTMLElement, virtualListEl: HTMLElement): boolean {
    return isNearVirtualBottom(
      messagesEl.scrollTop,
      Math.max(1, messagesEl.clientHeight),
      Math.max(virtualListEl.scrollHeight, messagesEl.scrollHeight)
    );
  }

  isAtBottom(messagesEl: HTMLElement, virtualListEl: HTMLElement): boolean {
    return isNearVirtualBottom(
      messagesEl.scrollTop,
      Math.max(1, messagesEl.clientHeight),
      Math.max(virtualListEl.scrollHeight, messagesEl.scrollHeight),
      MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX
    );
  }

  resetVirtualWindow(): void {
    this.virtualSessionId = "";
    this.virtualRowHeights.clear();
    this.cancelVirtualRerenderTrailing(true);
    this.resetVirtualRerenderThrottle();
  }

  dispose(): void {
    this.disconnectViewportObserver();
    this.env = null;
    this.resetVirtualWindow();
  }

  private requireEnv(): MessageListEnvironment {
    if (!this.env) throw new Error("Message list renderer has not been initialized");
    return this.env;
  }

  private observeMessageViewport(messagesEl: HTMLElement): void {
    if (this.observedMessagesEl === messagesEl && this.viewportResizeObserver) return;
    this.disconnectViewportObserver();
    this.observedMessagesEl = messagesEl;
    this.viewportWidth = Math.max(0, messagesEl.clientWidth);
    this.viewportHeight = Math.max(0, messagesEl.clientHeight);
    const ownerWindow = messagesEl.ownerDocument?.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
    const ResizeObserverCtor = ownerWindow?.ResizeObserver
      ?? (typeof globalThis.ResizeObserver === "function" ? globalThis.ResizeObserver : null);
    if (!ResizeObserverCtor) return;
    this.viewportResizeObserver = new ResizeObserverCtor(() => {
      if (this.observedMessagesEl !== messagesEl) return;
      const previousWidth = this.viewportWidth;
      const previousHeight = this.viewportHeight;
      const nextWidth = Math.max(0, messagesEl.clientWidth);
      const nextHeight = Math.max(0, messagesEl.clientHeight);
      this.viewportWidth = nextWidth;
      this.viewportHeight = nextHeight;
      if (nextHeight <= 0) return;
      const becameVisible = previousHeight <= 0;
      const widthChanged = nextWidth > 0 && nextWidth !== previousWidth;
      const heightChanged = nextHeight !== previousHeight;
      if (!becameVisible && !widthChanged && !heightChanged) return;
      if (becameVisible || widthChanged) {
        this.virtualRowHeights.clear();
        this.cancelVirtualRerenderTrailing(true);
        this.resetVirtualRerenderThrottle();
      }
      this.scheduleMeasuredRowsRerender(false);
    });
    this.viewportResizeObserver.observe(messagesEl);
  }

  private disconnectViewportObserver(): void {
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.observedMessagesEl = null;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
  }

  private resetVirtualRerenderThrottle(): void {
    this.virtualRerenderBurst = 0;
    this.virtualRerenderWindowStartedAt = 0;
  }

  private cancelVirtualRerenderTrailing(clearPendingForceBottom = false): void {
    if (this.virtualRerenderTrailingTimer !== null) {
      window.clearTimeout(this.virtualRerenderTrailingTimer);
      this.virtualRerenderTrailingTimer = null;
    }
    if (clearPendingForceBottom) this.virtualRerenderPendingForceBottom = false;
  }

  private findRenderedMessageElement(messageId: string): HTMLElement | null {
    const env = this.requireEnv();
    for (const element of Array.from(env.virtualListEl.querySelectorAll<HTMLElement>("[data-message-id]"))) {
      if (element.dataset.messageId === messageId) return element;
    }
    return null;
  }

  private flushProcessMessageUpdates(updates: PendingProcessMessageUpdate[]): void {
    const env = this.env;
    if (!env) return;
    let updated = false;
    let shouldPinBottom = false;
    for (const update of updates) {
      if (update.sessionId !== env.sessionId) continue;
      const target = this.findRenderedMessageElement(update.message.id);
      const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
      const virtualRow = wrapper?.closest<HTMLElement>(".codex-virtual-row");
      if (!wrapper || !virtualRow) continue;
      if (!isDirectProcessVirtualRow(virtualRow.dataset.rowId, update.message)) continue;
      const showAgentHeader = Boolean(wrapper.querySelector(".codex-agent-header"));
      virtualRow.empty();
      if (isActionTimelineItem(update.message)) {
        this.renderActionStreamItem(virtualRow, update.message, showAgentHeader);
      } else {
        this.renderMessage(virtualRow, update.message, {
          showAgentHeader,
          showAgentFooter: false,
          processExpanded: true
        });
      }
      updated = true;
      shouldPinBottom = shouldPinBottom || update.shouldPinBottom;
    }
    if (updated) env.onScheduleMeasure(shouldPinBottom && (env.shouldFollowBottom?.() ?? true));
  }

  private flushAnswerMessageUpdates(updates: PendingProcessMessageUpdate[]): void {
    const env = this.env;
    if (!env) return;
    let updated = false;
    let shouldPinBottom = false;
    for (const update of updates) {
      if (update.sessionId !== env.sessionId) continue;
      const target = this.findRenderedMessageElement(update.message.id);
      const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
      const virtualRow = wrapper?.closest<HTMLElement>(".codex-virtual-row");
      if (!wrapper || !virtualRow || virtualRow.dataset.rowId !== messageRowId(update.message)) continue;
      const content = wrapper.querySelector<HTMLElement>("[data-message-content]");
      if (!content) continue;
      wrapper.toggleClass("codex-message-streaming", update.message.status === "running");
      wrapper.toggleClass("codex-message-empty-running", update.message.status === "running" && !displayTextForMessage(update.message).trim());
      if (isAgentAnswerMessage(update.message)) this.renderAgentAnswerContent(content, update.message);
      else renderRichText(env.app, env.component, content, displayTextForMessage(update.message));
      updated = true;
      shouldPinBottom = shouldPinBottom || update.shouldPinBottom;
    }
    if (updated) env.onScheduleMeasure(shouldPinBottom && (env.shouldFollowBottom?.() ?? true));
  }

  private scheduleMeasuredRowsRerender(forceBottom: boolean): void {
    if (!this.env) return;
    this.virtualRerenderPendingForceBottom = this.virtualRerenderPendingForceBottom || forceBottom;
    if (this.virtualRerenderScheduled) return;
    const now = Date.now();
    if (!this.virtualRerenderWindowStartedAt || now - this.virtualRerenderWindowStartedAt > VIRTUAL_RERENDER_WINDOW_MS) {
      this.virtualRerenderWindowStartedAt = now;
      this.virtualRerenderBurst = 0;
    }
    if (this.virtualRerenderBurst >= VIRTUAL_RERENDER_BURST_LIMIT) {
      if (this.virtualRerenderTrailingTimer === null) {
        const remainingWindowMs = Math.max(
          0,
          this.virtualRerenderWindowStartedAt + VIRTUAL_RERENDER_WINDOW_MS - now
        );
        this.virtualRerenderTrailingTimer = window.setTimeout(() => {
          this.virtualRerenderTrailingTimer = null;
          this.resetVirtualRerenderThrottle();
          this.scheduleMeasuredRowsRerender(false);
        }, remainingWindowMs);
      }
      return;
    }
    this.cancelVirtualRerenderTrailing();
    this.virtualRerenderBurst += 1;
    this.virtualRerenderScheduled = true;
    window.requestAnimationFrame(() => {
      this.virtualRerenderScheduled = false;
      const effectiveForceBottom = this.virtualRerenderPendingForceBottom;
      this.virtualRerenderPendingForceBottom = false;
      const env = this.env;
      if (!env) return;
      const stillPinnedBottom = effectiveForceBottom && (env.shouldFollowBottom?.() ?? true) && isNearVirtualBottom(
        env.messagesEl.scrollTop,
        Math.max(1, env.messagesEl.clientHeight),
        Math.max(env.virtualListEl.scrollHeight, env.messagesEl.scrollHeight),
        MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX
      );
      this.render({ ...env, options: { forceBottom: stillPinnedBottom, preserveScroll: !stillPinnedBottom } });
    });
  }

  private buildVirtualRows(messages: ChatMessage[]): MessageRenderRow[] {
    const rows: MessageRenderRow[] = [];
    const agentHeaderKeys = new Set<string>();
    const footerMessageIds = terminalAnswerFooterMessageIds(messages);
    for (const item of buildAgentTurnProjection(
      messagesWithoutSameRunEmptyAnswerLoader(messages)
    )) {
      if (item.kind === "completedProcess") {
        const completedTurn = item.turn;
        const headerKey = agentRunHeaderKey(completedTurn.processMessages[0] ?? completedTurn.finalAnswer);
        const showAgentHeader = !agentHeaderKeys.has(headerKey);
        if (showAgentHeader) agentHeaderKeys.add(headerKey);
        rows.push({ id: completedTurnRowId(completedTurn), kind: "turnProcess", turn: completedTurn, showAgentHeader });
        continue;
      }
      const message = item.message;
      if (isActionTimelineItem(message)) {
        const headerKey = agentRunHeaderKey(message);
        const showAgentHeader = !agentHeaderKeys.has(headerKey);
        if (showAgentHeader) agentHeaderKeys.add(headerKey);
        rows.push({ id: actionItemRowId(message), kind: "actionItem", message, showAgentHeader });
        continue;
      }
      const headerKey = agentRunHeaderKey(message);
      const showAgentHeader = isAgentHeaderCandidate(message) && !agentHeaderKeys.has(headerKey);
      if (showAgentHeader) agentHeaderKeys.add(headerKey);
      rows.push({
        id: messageRowId(message),
        kind: "message",
        message,
        showAgentHeader,
        showAgentFooter: footerMessageIds.has(message.id),
        processExpanded: isAgentProcessItemType(message.itemType)
      });
    }
    return rows;
  }

  private renderVirtualRow(container: HTMLElement, row: MessageRenderRow): void {
    if (row.kind === "turnProcess") {
      this.renderCompletedTurnProcess(container, row.turn, row.showAgentHeader);
      return;
    }
    if (row.kind === "actionItem") {
      this.renderActionStreamItem(container, row.message, row.showAgentHeader);
      return;
    }
    if (row.message.role === "user") container.addClass("codex-virtual-row-user-message");
    this.renderMessage(container, row.message, { showAgentHeader: row.showAgentHeader, showAgentFooter: row.showAgentFooter, processExpanded: row.processExpanded });
  }

  private renderMessage(container: HTMLElement, message: ChatMessage, options: { showAgentHeader: boolean; showAgentFooter: boolean; processExpanded?: boolean; allowConversationDerive?: boolean } = { showAgentHeader: false, showAgentFooter: false }): void {
    const env = this.requireEnv();
    const wrapper = container.createDiv({ cls: `codex-message codex-message-${message.role}` });
    wrapper.dataset.messageId = message.id;
    wrapper.toggleClass("codex-message-streaming", message.status === "running");
    wrapper.toggleClass(`codex-message-type-${message.itemType ?? "text"}`, true);
    const emptyRunningAnswer = isAgentAnswerMessage(message) && message.status === "running" && !displayTextForMessage(message).trim();
    wrapper.toggleClass("codex-message-empty-running", emptyRunningAnswer);
    wrapper.toggleClass("has-agent-header", options.showAgentHeader);
    if (message.taskPlan) {
      this.renderTaskPlanCard(wrapper, message);
      return;
    }
    if (options.showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: false
    });
    const bodyHost = message.role === "assistant"
      ? createSmoothAIMessageBody(wrapper)
      : wrapper;
    if (!emptyRunningAnswer && shouldRenderMessageTitle(message, options.showAgentHeader)) {
      const title = bodyHost.createDiv({ cls: "codex-message-title" });
      title.createSpan({ cls: "codex-message-title-label", text: message.title ?? "" });
      const time = messageTitleTime(message);
      if (time) {
        title.createSpan({
          cls: "codex-message-title-time",
          text: time,
          attr: { title: formatAbsoluteTime(message.createdAt) }
        });
      }
    }
    if (message.attachments?.length) {
      this.renderUserAttachmentChips(bodyHost.createDiv({ cls: "codex-message-attachments" }), message.attachments);
    }
    if (message.images?.length) {
      const images = bodyHost.createDiv({ cls: "codex-message-images" });
      for (const image of message.images) {
        const img = images.createEl("img", { attr: { alt: image.name } });
        img.src = toImageSrc(env.app, image.path);
        img.onload = () => env.onScheduleMeasure();
        img.onclick = () => openImageOverlay(img.src);
      }
    }
    const content = bodyHost.createDiv({ cls: "codex-message-content" });
    content.dataset.messageContent = "true";
    if (emptyRunningAnswer) {
      this.renderAgentAnswerContent(content, message);
      return;
    }
    if (message.itemType === "thinking") {
      this.renderThinkingMessage(content, message);
      return;
    }
    if (message.itemType === "reasoning") {
      content.addClass("codex-inline-reasoning");
      const bodyId = `codex-smooth-reasoning-${safeDomIdentity(message.id)}`;
      const disclosureKey = message.reasoningSummary
        ? `${env.sessionId}\0${message.reasoningSummary.productRunId}`
        : "";
      const disclosure = message.reasoningSummary
        ? nextReasoningDisclosureState(
            this.reasoningDisclosureStates.get(disclosureKey),
            message.reasoningSummary.status
          )
        : undefined;
      if (disclosure) {
        this.reasoningDisclosureStates.set(disclosureKey, disclosure);
      }
      const open = disclosure?.open
        ?? this.openProcessItems.get(message.id)
        ?? message.status === "running";
      const status = message.reasoningSummary?.status ?? message.status;
      const reasoning = createSmoothAIReasoning(content, {
        bodyId,
        open,
        status: status === "interrupted" || status === "cancelled"
          ? "error"
          : smoothAIStatus(status),
        summary: message.reasoningSummary
          ? message.title ?? "正在思考"
          : message.status === "running" ? "正在思考" : "思考过程"
      });
      let pendingUserDisclosureIntent = false;
      if (message.reasoningSummary) {
        reasoning.summary.onclick = (event) => {
          if (event.isTrusted) pendingUserDisclosureIntent = true;
        };
        reasoning.summary.onkeydown = (event) => {
          if (
            event.isTrusted
            && (
              event.key === "Enter"
              || event.key === " "
              || event.code === "Space"
            )
          ) {
            pendingUserDisclosureIntent = true;
          }
        };
      }
      reasoning.root.ontoggle = () => {
        if (message.reasoningSummary) {
          const current = this.reasoningDisclosureStates.get(disclosureKey)
            ?? nextReasoningDisclosureState(undefined, message.reasoningSummary.status);
          if (pendingUserDisclosureIntent) {
            this.reasoningDisclosureStates.set(disclosureKey, Object.freeze({
              ...current,
              open: reasoning.root.open,
              manual: true
            }));
          }
          pendingUserDisclosureIntent = false;
        } else {
          rememberOpenState(this.openProcessItems, message.id, reasoning.root.open);
        }
        reasoning.summary.setAttribute("aria-expanded", String(reasoning.root.open));
        env.onScheduleMeasure();
      };
      renderRichText(env.app, env.component, reasoning.body, displayTextForMessage(message));
      return;
    }
    if (isProcessItemType(message.itemType)) {
      this.renderProcessMessage(content, message, false, options.processExpanded === true);
      this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message), message.citations);
      return;
    }
    const displayText = displayTextForMessage(message);
    if (!this.renderKnowledgeBaseResultContent(content, message, displayText)) {
      if (isAgentAnswerMessage(message)) this.renderAgentAnswerContent(content, message);
      else renderRichText(env.app, env.component, content, displayText);
    }
    if (message.rawRef) this.renderRawMessageExpander(content, message);
    if (message.itemType === "knowledgeBase" && message.details) this.renderKnowledgeBaseContextNote(wrapper, message.details);
    this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message), message.citations);
    if (message.role === "user") this.renderMessageCopyAction(wrapper, message, true);
    const footerActions = options.showAgentFooter
      ? this.renderAgentFooter(wrapper, message)
      : null;
    if (options.allowConversationDerive !== false) {
      this.renderPiConversationDeriveAction(
        footerActions ?? wrapper,
        message,
        Boolean(footerActions)
      );
    }
  }

  private renderAgentAnswerContent(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const text = displayTextForMessage(message);
    if (message.status === "running" && !text.trim()) {
      container.empty();
      renderSmoothAILoader(container, "正在生成回复");
      return;
    }
    renderRichText(env.app, env.component, container, text);
    markSmoothAIResponse(container, message.status === "running");
  }

  private renderTaskPlanCard(
    container: HTMLElement,
    message: ChatMessage
  ): void {
    const env = this.requireEnv();
    const plan = message.taskPlan;
    if (!plan) return;
    container.addClass("codex-message-task-plan");
    const progress = taskPlanProgress(plan);
    const expanded = this.openTaskPlans.get(message.id) ?? true;
    const stepsId = `codex-task-plan-steps-${safeDomIdentity(message.id)}`;
    const task = createAIElementsTask(container, {
      bodyId: stepsId,
      label: `任务计划：${plan.title}`,
      open: expanded
    });
    task.root.addClass(`is-${plan.status}`);
    const header = task.summary;
    this.renderTaskPlanStatusIcon(
      header.createSpan({ cls: "codex-task-plan-status" }),
      plan.status
    );
    const heading = header.createSpan({ cls: "codex-task-plan-heading" });
    heading.createSpan({ cls: "codex-task-plan-title", text: plan.title });
    heading.createSpan({
      cls: "codex-task-plan-progress",
      text: taskPlanHistoryStatus(plan.status, progress.completed, progress.total)
    });
    const disclosure = header.createSpan({
      cls: "codex-task-plan-disclosure",
      attr: { "aria-hidden": "true" }
    });
    setIcon(disclosure, expanded ? "chevron-up" : "chevron-down");
    task.root.ontoggle = () => {
      this.openTaskPlans.set(message.id, task.root.open);
      header.setAttribute("aria-expanded", String(task.root.open));
      env.onScheduleMeasure();
    };

    const steps = task.body;
    for (const step of plan.steps) {
      const row = steps.createDiv({
        cls: `codex-task-plan-step is-${step.status}`
      });
      this.renderTaskPlanStatusIcon(
        row.createSpan({ cls: "codex-task-plan-step-status" }),
        step.status
      );
      const copy = row.createDiv({ cls: "codex-task-plan-step-copy" });
      copy.createDiv({ cls: "codex-task-plan-step-text", text: step.text });
      if (step.reason) {
        copy.createDiv({
          cls: "codex-task-plan-step-reason",
          text: step.reason
        });
      }
    }
    if (plan.reason) {
      steps.createDiv({ cls: "codex-task-plan-reason", text: plan.reason });
    }
  }

  private renderTaskPlanStatusIcon(
    container: HTMLElement,
    status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
  ): void {
    container.addClass(`is-${status}`);
    container.setAttribute("role", "img");
    container.setAttribute("aria-label", taskPlanStatusLabel(status));
    setIcon(container, taskPlanStatusIcon(status));
  }

  private renderPiConversationDeriveAction(
    container: HTMLElement,
    message: ChatMessage,
    inline: boolean
  ): void {
    const env = this.requireEnv();
    const entryId = piEntryIdFromProjectedMessageId(message.id);
    const label = piConversationDeriveActionLabel(message);
    if (!entryId || !label || !env.onDerivePiConversation) return;
    const actions = inline
      ? container
      : container.createDiv({ cls: "codex-message-derive-actions" });
    const button = actions.createEl("button", {
      cls: "codex-message-action codex-message-derive-action",
      attr: {
        type: "button",
        title: label,
        "aria-label": label,
        "aria-busy": "false"
      }
    });
    button.disabled = Boolean(env.piConversationDeriveDisabled);
    const icon = button.createSpan({
      cls: "codex-message-action-icon codex-message-derive-action-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, "git-fork");
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await env.onDerivePiConversation?.(entryId);
      } finally {
        button.setAttribute("aria-busy", "false");
        button.disabled = Boolean(env.piConversationDeriveDisabled);
      }
    };
  }

  private renderMessageCopyAction(
    container: HTMLElement,
    message: ChatMessage,
    userMessage: boolean
  ): HTMLButtonElement {
    const env = this.requireEnv();
    const idleLabel = userMessage ? "复制消息" : "复制回答";
    const successLabel = userMessage ? "消息已复制" : "回答已复制";
    const failureLabel = userMessage ? "消息复制失败" : "回答复制失败";
    const copyButton = container.createEl("button", {
      cls: `codex-message-action ${userMessage ? "codex-user-message-copy" : "codex-answer-copy"}`,
      attr: {
        type: "button",
        title: idleLabel,
        "aria-label": idleLabel,
        "aria-live": "polite"
      }
    });
    const icon = copyButton.createSpan({
      cls: "codex-message-action-icon",
      attr: { "aria-hidden": "true" }
    });
    const renderIcon = (name: string) => {
      icon.empty();
      setIcon(icon, name);
    };
    renderIcon("copy");
    copyButton.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (copyButton.disabled) return;
      copyButton.disabled = true;
      const result = await copyAnswerMarkdown(
        message,
        env.readRawMessageText,
        (text) => navigator.clipboard.writeText(text)
      );
      if (result.status === "success") {
        renderIcon("check");
        copyButton.setAttr("title", "已复制");
        copyButton.setAttr("aria-label", successLabel);
      } else {
        renderIcon("triangle-alert");
        copyButton.setAttr("title", "复制失败");
        copyButton.setAttr("aria-label", failureLabel);
        new Notice(`复制失败：${result.error instanceof Error ? result.error.message : String(result.error)}`);
      }
      window.setTimeout(() => {
        renderIcon("copy");
        copyButton.setAttr("title", idleLabel);
        copyButton.setAttr("aria-label", idleLabel);
        copyButton.disabled = false;
      }, 1400);
    };
    return copyButton;
  }

  private renderAgentHeader(container: HTMLElement, input: { message?: ChatMessage; statusLabel: string; compact: boolean; agentIdentity?: AgentIdentityView }): void {
    const header = container.createDiv({ cls: "codex-agent-header" });
    header.toggleClass("is-compact", input.compact);
    // 未显式传入时读取当前渲染环境的身份快照（消息头全部使用同一份
    // 当前身份，不做逐消息持久化）。
    const identity = input.agentIdentity ?? this.env?.agentIdentity;
    const displayName = identity?.displayName?.trim() || "EchoInk";
    const avatarUrl = identity?.avatarUrl ?? null;
    const avatar = header.createSpan({ cls: "codex-agent-avatar", attr: { "aria-hidden": "true" } });
    if (avatarUrl) {
      // 自定义 / preset 头像：装饰性图片，容器保持 aria-hidden。
      avatar.addClass("has-image");
      avatar.createEl("img", { attr: { src: avatarUrl, alt: "" } });
    } else {
      setIcon(avatar, "bot");
    }
    const main = header.createDiv({ cls: "codex-agent-header-main" });
    const nameRow = main.createDiv({ cls: "codex-agent-name-row" });
    nameRow.createSpan({ cls: "codex-agent-name", text: displayName });
    const agent = input.message ? agentModelLine(input.message) : "";
    if (agent) nameRow.createSpan({ cls: "codex-agent-model-pill", text: `· ${agent}` });
    if (input.statusLabel) main.createDiv({ cls: "codex-agent-status-line", text: input.statusLabel });
  }

  private renderAgentFooter(
    container: HTMLElement,
    message: ChatMessage
  ): HTMLElement {
    const footer = container.createDiv({ cls: "codex-agent-footer" });
    const actions = footer.createDiv({ cls: "codex-agent-footer-actions" });
    this.renderMessageCopyAction(actions, message, false);
    const runtime = footer.createSpan({
      cls: "codex-agent-footer-runtime",
      attr: { title: message.providerId || "历史消息未记录 Provider 身份" }
    });
    const providerIcon = runtime.createSpan({
      cls: "codex-agent-footer-provider-icon",
      attr: { "aria-hidden": "true" }
    });
    renderProviderBrandIcon(providerIcon, providerBrandForMessage(message));
    runtime.createSpan({
      cls: "codex-agent-footer-model",
      text: message.modelId?.trim() || "未知模型"
    });
    const time = formatAnswerFooterTime(message.completedAt ?? message.createdAt);
    if (time) footer.createSpan({ cls: "codex-agent-footer-time", text: time });
    return actions;
  }

  private renderKnowledgeBaseResultContent(container: HTMLElement, message: ChatMessage, text: string): boolean {
    const env = this.requireEnv();
    if (message.itemType === "knowledgeBase" && message.knowledgeBaseUi) {
      markSmoothAIArtifact(container);
      this.renderKnowledgeBaseUiPayload(container, message.knowledgeBaseUi, message);
      return true;
    }
    const result = extractKnowledgeBaseResultTitle(message.itemType, text);
    if (!result) return false;
    markSmoothAIArtifact(container);
    const title = container.createDiv({ cls: `codex-kb-result-title codex-kb-result-title-${result.status}` });
    const icon = title.createSpan({ cls: "codex-kb-result-title-icon" });
    setIcon(icon, result.status === "success" ? "badge-check" : result.status === "canceled" ? "circle-slash" : "triangle-alert");
    title.createSpan({ cls: "codex-kb-result-title-text", text: result.title });
    if (result.body.trim()) renderRichText(env.app, env.component, container.createDiv({ cls: "codex-kb-result-body" }), result.body);
    return true;
  }

  private renderKnowledgeBaseUiPayload(container: HTMLElement, payload: KnowledgeBaseMessageUiPayload, message: ChatMessage): void {
    if (payload.kind === "maintain-run") {
      this.renderKnowledgeBaseRunCard(container, payload, message);
      return;
    }
    this.renderKnowledgeBaseMaintainReportCard(container, payload, message);
  }

  private renderKnowledgeBaseRunCard(container: HTMLElement, payload: KnowledgeBaseRunPayload, message: ChatMessage): void {
    const status = message.status ?? "running";
    const card = container.createDiv({ cls: `codex-kb-run-card codex-kb-run-card-${status}` });
    const head = card.createDiv({ cls: "codex-kb-run-head" });
    const mark = head.createSpan({ cls: "codex-kb-run-mark" });
    setIcon(mark, knowledgeBaseRunStatusIcon(payload, status));
    const text = head.createDiv({ cls: "codex-kb-run-copy" });
    text.createDiv({ cls: "codex-kb-run-title", text: knowledgeBaseRunDisplayTitle(payload, status) });
    const liveCopy = knowledgeBaseRunEventCopy(payload);
    if (liveCopy) text.createDiv({ cls: "codex-kb-run-subtitle", text: liveCopy });
    const track = card.createDiv({ cls: "codex-kb-run-track" });
    const eventProgress = knowledgeBaseRunProgressStateFromEvents(status, payload.events ?? [], payload.phases.length);
    const timedProgress = knowledgeBaseRunProgressState(status, message.createdAt, Date.now(), payload.phases.length);
    const { totalCells, filledCells, activeIndex } = eventProgress ?? {
      totalCells: timedProgress.totalCells,
      filledCells: timedProgress.filledCells,
      activeIndex: timedProgress.activeIndex
    };
    payload.phases.forEach((phase, index) => {
      const node = track.createDiv({ cls: `codex-kb-run-node codex-kb-run-node-${phase.id} codex-kb-run-motion-${phase.motion}` });
      node.toggleClass("is-done", filledCells >= totalCells || index < activeIndex);
      node.toggleClass("is-active", index === activeIndex);
      const rail = node.createDiv({ cls: "codex-kb-run-phase-rail" });
      const icon = rail.createSpan({ cls: "codex-kb-run-node-icon" });
      setIcon(icon, phase.icon);
      if (index < payload.phases.length - 1) {
        rail.createSpan({ cls: "codex-kb-run-phase-connector" });
      }
      const body = node.createDiv({ cls: "codex-kb-run-phase-body" });
      const labelRow = body.createDiv({ cls: "codex-kb-run-phase-label-row" });
      labelRow.createSpan({ cls: "codex-kb-run-node-label", text: phase.label });
      if (index === activeIndex) {
        const statusCopy = labelRow.createSpan({ cls: "codex-kb-run-phase-status-copy" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-rule" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-dot" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-text", text: liveCopy || payload.subtitle });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-rule" });
      }
    });
  }

  private renderKnowledgeBaseMaintainReportCard(container: HTMLElement, payload: KnowledgeBaseMaintainReportPayload, message: ChatMessage): void {
    const card = container.createDiv({ cls: `codex-kb-maintain-card codex-kb-maintain-card-${payload.status}` });
    const header = card.createDiv({ cls: "codex-kb-maintain-header" });
    const icon = header.createSpan({ cls: "codex-kb-maintain-icon" });
    setIcon(icon, payload.status === "success" ? "badge-check" : payload.status === "canceled" ? "circle-slash" : "triangle-alert");
    const title = header.createDiv({ cls: "codex-kb-maintain-title" });
    title.createDiv({ cls: "codex-kb-maintain-title-text", text: payload.title });
    if (payload.reportPath) title.createDiv({ cls: "codex-kb-maintain-report-path", text: payload.reportPath });
    if (payload.reportPath) {
      const open = header.createEl("button", { cls: "codex-kb-maintain-open", attr: { type: "button", title: payload.reportPath } });
      setIcon(open.createSpan({ cls: "codex-kb-maintain-open-icon" }), "external-link");
      open.createSpan({ text: "打开报告" });
      open.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openKnowledgeBasePath(payload.reportPath);
      };
    }
    const executionItems = knowledgeBaseMaintainExecutionItems(payload);
    if (executionItems.length) {
      const execution = card.createDiv({ cls: "codex-kb-maintain-execution" });
      for (const item of executionItems) {
        execution.createSpan({ cls: "codex-kb-maintain-execution-item", text: item });
      }
    }
    const care = card.createDiv({ cls: "codex-kb-maintain-care" });
    care.createDiv({ cls: "codex-kb-maintain-section-title", text: "我应该关心" });
    const careList = care.createDiv({ cls: "codex-kb-maintain-care-list" });
    for (const item of payload.careItems) {
      const row = careList.createDiv({ cls: `codex-kb-maintain-care-item codex-kb-maintain-care-${item.tone}` });
      const bullet = row.createSpan({ cls: "codex-kb-maintain-care-icon" });
      setIcon(bullet, item.tone === "warning" ? "triangle-alert" : item.tone === "info" ? "info" : "check");
      row.createSpan({ cls: "codex-kb-maintain-care-text", text: item.text });
    }
    if (payload.sections.length) {
      const sections = card.createDiv({ cls: "codex-kb-maintain-sections" });
      const firstOpenSection = payload.sections.find((section) => section.count > 0)?.id;
      for (const section of payload.sections) {
        const sectionStateKey = `kb-maintain-report:${message.id}:${section.id}`;
        const details = sections.createEl("details", { cls: "codex-kb-maintain-section" });
        details.open = knowledgeBaseMaintainSectionOpenState(
          this.openKnowledgeBaseReportSections.get(sectionStateKey),
          section.id === firstOpenSection
        );
        details.ontoggle = () => {
          this.openKnowledgeBaseReportSections.set(sectionStateKey, details.open);
          this.requireEnv().onScheduleMeasure();
        };
        const summary = details.createEl("summary", { cls: "codex-kb-maintain-section-summary" });
        summary.createSpan({ cls: "codex-kb-maintain-section-name", text: section.title });
        summary.createSpan({ cls: "codex-kb-maintain-section-count", text: String(section.count) });
        const chevron = summary.createSpan({ cls: "codex-kb-maintain-section-chevron" });
        setIcon(chevron, "chevron-right");
        const body = details.createDiv({ cls: "codex-kb-maintain-section-body" });
        if (!section.items.length) {
          body.createDiv({ cls: "codex-kb-maintain-empty", text: section.emptyText });
          continue;
        }
        for (const item of section.items) {
          const row = body.createDiv({ cls: `codex-kb-maintain-detail codex-kb-maintain-detail-${item.tone ?? "info"}` });
          const itemPath = knowledgeBaseMaintainReportItemPath(item);
          if (itemPath) {
            const title = row.createEl("button", {
              cls: "codex-kb-maintain-detail-title codex-kb-maintain-detail-link",
              text: item.title,
              attr: { type: "button", title: `打开 ${itemPath}` }
            });
            title.onclick = (event) => {
              event.preventDefault();
              event.stopPropagation();
              void this.openKnowledgeBasePath(itemPath);
            };
          } else {
            row.createDiv({ cls: "codex-kb-maintain-detail-title", text: item.title });
          }
          row.createDiv({ cls: "codex-kb-maintain-detail-desc", text: item.description });
        }
      }
    }
  }

  private async openKnowledgeBasePath(path: string): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(path);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    const absolute = `${env.vaultPath.replace(/\/$/, "")}/${normalized}`;
    if (showItemInFinder(absolute)) return;
    new Notice(`没有在当前 Obsidian 仓库找到：${path}`);
  }

  private renderKnowledgeUsageCards(
    container: HTMLElement,
    messageId: string,
    usage: KnowledgeUsageMessageData,
    citations?: KnowledgeBaseCitationSummary
  ): void {
    const documents = localDocumentSources(citations, usage);
    if (documents.length) {
      const stateKey = `knowledge-documents:${messageId}`;
      const sources = createAIElementsDocumentSources(
        container,
        documents.length,
        this.openKnowledgeBaseCitations.get(stateKey) ?? false
      );
      sources.root.ontoggle = () => {
        this.openKnowledgeBaseCitations.set(stateKey, sources.root.open);
        sources.summary.setAttribute("aria-expanded", String(sources.root.open));
        this.requireEnv().onScheduleMeasure();
      };
      for (const document of documents) {
        this.renderLocalDocumentSource(sources.body, document, citations?.status);
      }
    } else if (citations || usage.askSourceAttribution) {
      container.createDiv({
        cls: "codex-kb-no-evidence codex-ai-elements-sources-empty",
        text: citations
          ? "没有命中文件，也没有引用片段；不会显示伪来源。"
          : personalMemorySourceEmptyStateLabel()
      });
    }
    if (usage.producedPaths.length) {
      const artifact = createSmoothAIArtifact(container, "本轮产物");
      artifact.root.addClass("codex-knowledge-produced-artifact");
      for (const producedPath of usage.producedPaths) {
        this.renderKnowledgeProducedPath(artifact.body, producedPath);
      }
    }
  }

  private renderLocalDocumentSource(
    container: HTMLElement,
    document: LocalDocumentSource,
    evidenceStatus?: KnowledgeBaseCitationSummary["status"]
  ): void {
    const item = container.createDiv({
      cls: `codex-ai-elements-source is-${document.kind}`,
      attr: { "data-source-key": document.key }
    });
    const header = item.createDiv({ cls: "codex-ai-elements-source-header" });
    const icon = header.createSpan({
      cls: "codex-ai-elements-source-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, "book-open");
    if (document.kind === "memory") {
      header.createSpan({
        cls: "codex-ai-elements-source-title codex-message-note-link is-disabled",
        text: document.source.title,
        attr: { title: "Personal Memory 没有 Vault 路径，无法打开" }
      });
      return;
    }

    const env = this.requireEnv();
    const file = env.app.vault.getAbstractFileByPath(document.path);
    const noteName = noteNameForPath(document.path);
    if (file instanceof TFile) {
      const title = header.createEl("button", {
        cls: "codex-ai-elements-source-title codex-message-note-link",
        text: noteName,
        attr: {
          type: "button",
          "aria-label": `打开笔记 ${noteName}`,
          "data-path": document.path,
          title: `在 Obsidian 中打开 ${document.path}`
        }
      });
      title.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openLocalDocumentSource(document);
      };
    } else {
      header.createSpan({
        cls: "codex-ai-elements-source-title codex-message-note-link is-disabled",
        text: noteName,
        attr: { title: `当前 Vault 中找不到 ${document.path}，无法打开` }
      });
    }

    const metadata = localDocumentMetadata(document, evidenceStatus);
    if (metadata.length) {
      const meta = item.createDiv({ cls: "codex-ai-elements-source-meta" });
      for (const label of metadata) meta.createSpan({ text: label });
    }
    for (const excerpt of localDocumentExcerpts(document)) {
      const quote = item.createDiv({ cls: "codex-kb-citation-quote" });
      for (const line of excerpt.split(/\r\n|\n|\r/u)) {
        quote.createDiv({ cls: "codex-kb-citation-line", text: line });
      }
    }
  }

  private renderKnowledgeProducedPath(container: HTMLElement, producedPath: string): void {
    const item = container.createDiv({ cls: "codex-kb-citation-item codex-knowledge-produced-path" });
    const header = item.createDiv({ cls: "codex-kb-citation-header" });
    const title = header.createEl("button", {
      cls: "codex-kb-citation-title codex-message-note-link",
      text: noteNameForPath(producedPath),
      attr: {
        type: "button",
        "aria-label": `打开笔记 ${noteNameForPath(producedPath)}`,
        "data-path": producedPath,
        title: `打开 ${producedPath}`
      }
    });
    title.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openKnowledgeBasePath(producedPath);
    };
  }

  private async openLocalDocumentSource(document: LocalVaultDocumentSource): Promise<void> {
    const reference = document.references[0];
    if (reference) {
      await this.openKnowledgeReference(reference);
      return;
    }
    const env = this.requireEnv();
    const file = env.app.vault.getAbstractFileByPath(document.path);
    if (!(file instanceof TFile)) {
      new Notice(`没有在当前 Obsidian 仓库找到：${document.path}`);
      return;
    }
    await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }

  private async openKnowledgeReference(reference: KnowledgeReference): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(reference.vaultRelativePath);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      new Notice(`没有在当前 Obsidian 仓库找到：${reference.vaultRelativePath}`);
      return;
    }
    const leaf = env.app.workspace.getLeaf("tab");
    const firstLine = Math.max(0, reference.lineStart - 1);
    await leaf.openFile(file, {
      active: true,
      eState: { line: firstLine }
    });
    const editor = (leaf.view as { editor?: Editor }).editor;
    if (!editor) return;
    const availableLastLine = Math.max(0, editor.lineCount() - 1);
    const clampedFirstLine = Math.min(firstLine, availableLastLine);
    const lastLine = Math.min(
      Math.max(clampedFirstLine, reference.lineEnd - 1),
      availableLastLine
    );
    const from = { line: clampedFirstLine, ch: 0 };
    const to = { line: lastLine, ch: editor.getLine(lastLine).length };
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    editor.focus();
  }

  private renderKnowledgeBaseContextNote(container: HTMLElement, details: string): void {
    const normalized = details.trim();
    if (!normalized) return;
    const note = container.createDiv({ cls: "codex-kb-context-note" });
    const icon = note.createSpan({ cls: "codex-kb-context-note-icon" });
    setIcon(icon, "message-square-share");
    note.createSpan({ cls: "codex-kb-context-note-text", text: normalized });
  }

  private renderActionStreamItem(container: HTMLElement, message: ChatMessage, showAgentHeader: boolean): void {
    const timeline = buildActionTimeline([message]);
    const item = timeline.groups[0]?.items[0];
    if (!item) return;
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-actionStream" });
    wrapper.dataset.messageId = message.id;
    if (showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: true
    });
    const region = wrapper.createDiv({ cls: "codex-action-region codex-action-stream" });
    this.renderActionItem(region, item, { standalone: false });
    this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message));
  }

  private renderCompletedTurnProcess(container: HTMLElement, turn: CompletedAgentTurn, showAgentHeader: boolean): void {
    const stateId = `${turn.key}:${turn.finalAnswer.id}`;
    const open = this.openCompletedTurns.get(stateId) ?? (turn.failed || turn.requiresAttention);
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-turnProcess" });
    if (showAgentHeader) this.renderAgentHeader(wrapper, { message: turn.finalAnswer, statusLabel: "", compact: true });
    const region = wrapper.createDiv({ cls: "codex-turn-process" });
    markSmoothAIReasoning(region, turn.failed ? "failed" : turn.requiresAttention ? "blocked" : "completed");
    const bodyId = stableDomId(`codex-turn-process-${stateId}`);
    const summary = region.createEl("button", {
      cls: "codex-turn-process-summary",
      attr: {
        type: "button",
        "aria-controls": bodyId,
        "aria-expanded": String(open)
      }
    });
    summary.createSpan({ cls: "codex-turn-process-title", text: formatAgentTurnDuration(turn.durationMs) });
    const caret = summary.createSpan({ cls: "codex-turn-process-caret" });
    setIcon(caret, open ? "chevron-down" : "chevron-right");
    summary.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openCompletedTurns.set(stateId, !open);
      this.requireEnv().onScheduleMeasure();
      this.rerenderPreservingScroll();
    };
    if (open) {
      const body = region.createDiv({ cls: "codex-turn-process-body", attr: { id: bodyId } });
      for (const message of turn.processMessages) this.renderTurnProcessMessage(body, message);
    }
    this.renderKnowledgeUsageCards(
      wrapper,
      `turn:${stateId}`,
      mergeKnowledgeUsageMessageData(turn.processMessages)
    );
  }

  private renderTurnProcessMessage(container: HTMLElement, message: ChatMessage): void {
    if (isActionTimelineItem(message)) {
      const item = buildActionTimeline([message]).groups[0]?.items[0];
      if (item) this.renderActionItem(container.createDiv({ cls: "codex-action-region codex-action-stream" }), item, { standalone: false });
      return;
    }
    this.renderMessage(container, message, {
      showAgentHeader: false,
      showAgentFooter: false,
      processExpanded: true,
      allowConversationDerive: false
    });
  }

  private renderActionItem(container: HTMLElement, item: ActionItemViewModel, options: { standalone: boolean }): void {
    if (hasActionItemDetails(item)) {
      this.renderExpandableActionItem(container, item, options);
      return;
    }
    const row = container.createDiv({ cls: `codex-action-item codex-action-item-${item.kind}` });
    markSmoothAIToolCall(row, item.status);
    const approvalState = approvalStateForMessage(item.source);
    if (approvalState) markSmoothAIApproval(row, approvalState);
    row.toggleClass("is-standalone", options.standalone);
    row.toggleClass("is-failed", isAttentionActionStatus(item.status));
    row.toggleClass("is-running", isActiveActionStatus(item.status));
    const head = row.createDiv({ cls: "codex-action-item-head" });
    this.renderActionItemHead(head, item);
    this.renderApprovalCard(row, item.source);
  }

  private renderExpandableActionItem(container: HTMLElement, item: ActionItemViewModel, options: { standalone: boolean }): void {
    const detailId = stableDomId(`codex-action-detail-${item.id}`);
    const details = container.createEl("details", { cls: `codex-action-item codex-action-item-${item.kind} codex-action-item-expandable` });
    markSmoothAIToolCall(details, item.status);
    const approvalState = approvalStateForMessage(item.source);
    if (approvalState) markSmoothAIApproval(details, approvalState);
    details.toggleClass("is-standalone", options.standalone);
    details.toggleClass("is-failed", isAttentionActionStatus(item.status));
    details.toggleClass("is-running", isActiveActionStatus(item.status));
    details.open = this.openActionItemDetails.get(item.id)
      ?? (isAttentionActionStatus(item.status) && item.kind !== "edit");
    let summary: HTMLElement | null = null;
    let caret: HTMLElement | null = null;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-action-item-details-body", attr: { id: detailId } });
      this.renderProcessBody(body, item.source);
    };
    details.ontoggle = () => {
      rememberOpenState(this.openActionItemDetails, item.id, details.open);
      if (details.open) renderBody();
      if (summary) summary.setAttr("aria-expanded", String(details.open));
      if (caret) {
        caret.empty();
        setIcon(caret, details.open ? "chevron-up" : "chevron-down");
      }
      this.requireEnv().onScheduleMeasure();
    };
    summary = details.createEl("summary", {
      cls: "codex-action-item-head",
      attr: {
        "aria-controls": detailId,
        "aria-expanded": String(details.open),
        title: actionItemDetailLabel(item)
      }
    });
    this.renderActionItemHead(summary, item);
    caret = summary.createSpan({ cls: "codex-action-item-caret" });
    setIcon(caret, details.open ? "chevron-up" : "chevron-down");
    this.renderApprovalCard(container, item.source);
    if (details.open) renderBody();
  }

  private renderActionItemHead(head: HTMLElement, item: ActionItemViewModel): void {
    const icon = renderSmoothAIToolStatus(head, item.status);
    icon.addClass("codex-action-item-icon");
    setIcon(icon, iconForActionKind(item.kind, item.status));
    const main = head.createDiv({ cls: "codex-action-item-main" });
    this.renderActionItemTitle(main, item);
    const meta = actionItemMeta(item);
    if (meta) main.createSpan({ cls: "codex-action-item-detail", text: meta });
    this.renderActionItemStats(head, item);
    const time = formatMessageHeaderTime(item.createdAt);
    if (time) head.createSpan({ cls: "codex-action-item-time", text: time });
  }

  private renderActionItemTitle(container: HTMLElement, item: ActionItemViewModel): void {
    const prefix = actionVerb(item);
    if (item.kind === "edit" && item.source.diffSummary?.files.length) {
      const file = item.source.diffSummary.files[0];
      container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
      const ref = findProcessFileRef(item.source.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(container, ref, basename(file.path), "codex-action-item-file");
      if (item.source.diffSummary.files.length > 1) container.createSpan({ cls: "codex-action-item-extra", text: ` 等 ${item.source.diffSummary.files.length} 个文件` });
      return;
    }
    if (item.file) {
      container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
      this.renderProcessFileTextLink(container, item.file, item.file.name || item.file.displayPath, "codex-action-item-file");
      return;
    }
    container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
    container.createSpan({ cls: "codex-action-item-title", text: actionItemTarget(item) || item.title });
  }

  private renderActionItemStats(container: HTMLElement, item: ActionItemViewModel): void {
    if (!item.diff || (item.diff.added === undefined && item.diff.removed === undefined)) return;
    const stats = container.createSpan({ cls: "codex-action-diff-stats" });
    if (typeof item.diff.added === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${item.diff.added}` });
    if (typeof item.diff.removed === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${item.diff.removed}` });
  }

  private renderApprovalCard(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const binding = env.resolveApprovalDecision?.(message) ?? null;
    const state = approvalStateForMessage(message)
      ?? (binding ? "waiting_approval" : null);
    if (!state) return;
    const elements = createSmoothAIApprovalCard(container, {
      state,
      target: message.approval?.target || binding?.target,
      preview: message.approval?.preview || binding?.preview,
      controlled: state === "waiting_approval" && Boolean(binding)
    });
    if (!binding || !elements.approveButton || !elements.rejectButton) return;
    const buttons = [elements.approveButton, elements.rejectButton];
    let deciding = false;
    const decide = (decision: "approve" | "reject") => (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (deciding) return;
      deciding = true;
      elements.root.setAttribute("aria-busy", "true");
      for (const button of buttons) button.disabled = true;
      let accepted = false;
      try {
        accepted = binding.decide(decision);
      } catch {
        accepted = false;
      }
      if (accepted) {
        env.onScheduleMeasure();
        return;
      }
      deciding = false;
      elements.root.setAttribute("aria-busy", "false");
      for (const button of buttons) button.disabled = false;
      new Notice("该审批已失效，请等待状态刷新。");
      this.rerenderPreservingScroll();
    };
    elements.approveButton.onclick = decide("approve");
    elements.rejectButton.onclick = decide("reject");
  }

  private rerenderPreservingScroll(): void {
    const env = this.env;
    if (!env) return;
    this.render({ ...env, options: { ...env.options, preserveScroll: true } });
  }

  private renderUserAttachmentChips(container: HTMLElement, attachments: StoredAttachment[]): void {
    for (const attachment of attachments) {
      const chip = container.createEl("button", {
        cls: `codex-message-attachment-chip codex-message-attachment-${attachment.type}`,
        attr: {
          type: "button",
          title: attachment.path,
          "aria-label": `打开附件 ${attachment.name}`
        }
      });
      const icon = chip.createSpan({ cls: "codex-message-attachment-icon" });
      setIcon(icon, attachment.type === "image" ? "image" : "file-text");
      chip.createSpan({ cls: "codex-message-attachment-name", text: attachment.name });
      chip.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openAttachment(attachment);
      };
    }
  }

  private async openAttachment(attachment: StoredAttachment): Promise<void> {
    const env = this.requireEnv();
    if (attachment.type === "image") {
      openImageOverlay(toImageSrc(env.app, attachment.path));
      return;
    }
    const ref = normalizeProcessFileRef(attachment.path, env.vaultPath);
    await this.openProcessFile(ref);
  }

  private renderThinkingMessage(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const shell = container.createDiv({ cls: "codex-thinking-shell" });
    markSmoothAIReasoning(shell, message.status);
    if (message.status === "running") {
      const row = shell.createDiv({ cls: "codex-thinking-live" });
      renderSmoothAILoader(row, message.text || COLD_START_STATUS_TEXT);
      row.createSpan({ cls: "codex-agent-live-copy", text: ` · ${rotatingChoice(COLD_START_COPY_TEXTS, message.createdAt)}` });
      env.onScheduleRunProgress();
      return;
    }
    shell.createEl("em", { cls: "codex-response-footer", text: message.text || "思考完成" });
  }

  private renderProcessMessage(container: HTMLElement, message: ChatMessage, nested = false, forceOpen = false): void {
    const details = container.createEl("details", { cls: `codex-structured codex-process codex-process-${message.itemType ?? "item"}` });
    markSmoothAIToolCall(details, message.status);
    const approvalState = approvalStateForMessage(message);
    if (approvalState) markSmoothAIApproval(details, approvalState);
    details.toggleClass("is-running", isActiveProcessStatus(message.status));
    details.toggleClass("is-completed", message.status === "completed");
    details.toggleClass("is-error", isAttentionProcessStatus(message.status));
    details.toggleClass("is-nested", nested);
    if (message.processKind) details.toggleClass(`codex-process-kind-${message.processKind}`, true);
    const defaultOpen = forceOpen || (!nested && (
      message.itemType === "plan"
      || isAttentionProcessStatus(message.status)
    ));
    details.open = forceOpen ? true : this.openProcessItems.get(message.id) ?? defaultOpen;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-structured-body codex-process-body" });
      this.renderProcessBody(body, message);
    };
    details.ontoggle = () => {
      rememberOpenState(this.openProcessItems, message.id, details.open);
      if (details.open) renderBody();
      this.requireEnv().onScheduleMeasure();
    };
    const summary = details.createEl("summary", { cls: "codex-process-summary" });
    const icon = renderSmoothAIToolStatus(summary, message.status);
    icon.addClass("codex-structured-icon");
    icon.addClass("codex-process-icon");
    setIcon(icon, iconForProcessMessage(message));
    const main = summary.createDiv({ cls: "codex-process-main" });
    if (message.itemType === "fileChange" && message.diffSummary?.files.length) {
      this.renderProcessEditSummary(main, message);
    } else {
      main.createSpan({ cls: "codex-structured-title codex-process-title", text: titleForItemType(message) });
      if (message.itemType === "fileChange" && message.diffSummary) this.renderDiffStats(main, message.diffSummary);
      if (message.details) main.createDiv({ cls: "codex-process-detail", text: message.details });
      if (message.itemType === "fileChange" && message.files?.length) this.renderProcessFileChips(main.createDiv({ cls: "codex-process-files" }), message.files);
    }
    if (message.status) summary.createSpan({ cls: "codex-structured-status", text: labelForStatus(message.status) });
    this.renderApprovalCard(container, message);
    if (details.open) renderBody();
  }

  private renderProcessBody(body: HTMLElement, message: ChatMessage): void {
    const hasExplicitChannels = hasExplicitProcessChannels(message);
    const env = this.requireEnv();
    if (!hasExplicitChannels && message.processContentAvailability === "unavailable") {
      if (isActiveProcessStatus(message.status)) this.renderProcessLoader(body, "正在等待工具输出");
      else body.createDiv({ cls: "codex-process-raw-loading", text: PROCESS_CONTENT_UNAVAILABLE_TEXT });
      return;
    }
    const fallback = message.status === "running" ? "正在接收过程内容..." : "暂无内容";
    if (message.itemType === "commandExecution") {
      if (hasExplicitChannels) this.renderProcessChannels(body, message);
      else this.renderCommandExecutionBody(body, message, fallback);
      return;
    }
    if (message.itemType === "fileChange" && message.diffSummary) {
      if (hasExplicitChannels) this.renderProcessChannels(body, message);
      const diffBody = hasExplicitChannels
        ? body.createDiv({ cls: "codex-process-channel codex-process-channel-diff" })
        : body;
      this.renderFileChangeBody(diffBody, message, fallback);
      return;
    }
    if (hasExplicitChannels) {
      this.renderProcessChannels(body, message);
      return;
    }
    const rawLike = message.itemType === "commandExecution" || message.itemType === "fileChange" || message.itemType === "mcpToolCall" || message.itemType === "dynamicToolCall" || message.itemType === "collabAgentToolCall";
    if (rawLike) body.createDiv({ cls: "codex-process-raw-title", text: this.rawMetaLabel(message) });
    if (message.rawRef) {
      this.renderDeferredRawText(body, message, fallback);
      return;
    }
    const text = displayTextForMessage(message) || fallback;
    if (rawLike || isLargeRawMessage(message)) {
      this.renderPlainTextBlock(body, text);
      return;
    }
    renderRichText(env.app, env.component, body, text);
  }

  private renderProcessChannels(body: HTMLElement, message: ChatMessage): void {
    const active = isActiveProcessStatus(message.status);
    this.renderProcessChannel(body, "输入", message.processInputAvailability, message.processInput, false, false);
    this.renderProcessChannel(body, "输出", message.processOutputAvailability, message.processOutput, true, active);
  }

  private renderProcessChannel(
    body: HTMLElement,
    label: string,
    availability: ChatMessage["processInputAvailability"],
    text: string | undefined,
    artifact: boolean,
    activeWait: boolean
  ): void {
    if (!availability) return;
    const artifactElements = artifact ? createSmoothAIArtifact(body, label) : null;
    const channel = artifactElements?.body ?? body.createDiv({ cls: "codex-process-channel" });
    artifactElements?.root.addClass("codex-process-channel");
    if (!artifact) channel.createDiv({ cls: "codex-process-raw-title", text: label });
    if (availability === "unavailable") {
      if (activeWait) this.renderProcessLoader(channel, "正在等待工具输出");
      else channel.createDiv({ cls: "codex-process-raw-loading", text: PROCESS_CONTENT_UNAVAILABLE_TEXT });
      return;
    }
    if (availability === "empty") {
      channel.createDiv({ cls: "codex-process-raw-loading", text: "后端返回空内容" });
      return;
    }
    const content = text?.trim() ? text : PROCESS_CONTENT_UNAVAILABLE_TEXT;
    if (artifact) {
      const env = this.requireEnv();
      renderPreformattedVaultNoteText(env.app, env.component, channel, content);
    } else {
      this.renderPlainTextBlock(channel, content);
    }
  }

  private renderFileChangeBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const renderDiff = (text: string) => {
      body.empty();
      const artifact = createSmoothAIArtifact(body, "文件改动");
      const artifactBody = artifact.body;
      const files = parseFileChangeDiff(text || fallback, message.diffSummary);
      if (!hasRenderableDiff(files)) {
        this.renderPlainTextBlock(artifactBody, text || fallback);
        return;
      }
      markSmoothAIDiff(artifact.root);
      if (message.diffSummary) this.renderDiffOverview(artifactBody, message.diffSummary);
      this.renderDiffFiles(artifactBody, files, message.files ?? []);
    };
    if (message.rawRef) {
      this.renderProcessLoader(body, "正在加载文件改动");
      void this.loadRawText(message)
        .then((text) => {
          renderDiff(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `文件改动加载失败：${error instanceof Error ? error.message : String(error)}` });
          this.renderPlainTextBlock(body, displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderDiff(displayTextForMessage(message) || fallback);
  }

  private renderCommandExecutionBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const renderShell = (text: string) => {
      body.empty();
      const shell = body.createDiv({ cls: "codex-shell-block" });
      shell.createDiv({ cls: "codex-shell-label", text: "Shell" });
      shell.createEl("pre", { cls: "codex-shell-output", text: shellTranscript(text || fallback) });
    };
    if (message.rawRef) {
      this.renderProcessLoader(body, "正在加载命令输出");
      void this.loadRawText(message)
        .then((text) => {
          renderShell(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `命令输出加载失败：${error instanceof Error ? error.message : String(error)}` });
          renderShell(displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderShell(displayTextForMessage(message) || fallback);
  }

  private renderDiffOverview(container: HTMLElement, summary: DiffSummary): void {
    const row = container.createDiv({ cls: "codex-diff-overview" });
    row.createSpan({ cls: "codex-diff-overview-title", text: diffSummaryLabel(summary) });
    this.renderDiffStats(row, summary);
  }

  private renderDiffStats(container: HTMLElement, summary: DiffSummary): void {
    const stats = container.createSpan({ cls: "codex-diff-stats" });
    stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${summary.added}` });
    stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${summary.removed}` });
  }

  private renderDiffFiles(container: HTMLElement, files: ParsedDiffFile[], refs: ProcessFileRef[]): void {
    const list = container.createDiv({ cls: "codex-diff-files" });
    if (files.length === 1) {
      this.renderDiffFileBody(list, files[0]);
      return;
    }
    files.forEach((file, index) => {
      const details = list.createEl("details", { cls: "codex-diff-file" });
      details.open = files.length === 1 || index === 0;
      let rendered = false;
      const renderRows = () => {
        if (rendered) return;
        rendered = true;
        this.renderDiffFileBody(details, file);
      };
      details.ontoggle = () => {
        if (details.open) renderRows();
        this.requireEnv().onScheduleMeasure();
      };
      const summary = details.createEl("summary", { cls: "codex-diff-file-summary" });
      const main = summary.createSpan({ cls: "codex-diff-file-main" });
      const ref = findProcessFileRef(refs, file.path);
      if (ref) {
        this.renderProcessFileTextLink(main, ref, file.path, "codex-diff-file-path");
      } else {
        main.createSpan({ cls: "codex-diff-file-path", text: file.path });
      }
      if (file.previousPath) main.createSpan({ cls: "codex-diff-file-previous", text: `原路径 ${file.previousPath}` });
      summary.createSpan({ cls: "codex-diff-file-kind", text: labelForDiffKind(file.kind) });
      const stats = summary.createSpan({ cls: "codex-diff-file-stats" });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${file.added}` });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${file.removed}` });
      if (details.open) renderRows();
    });
  }

  private renderDiffFileBody(container: HTMLElement, file: ParsedDiffFile): void {
    const body = container.createDiv({ cls: "codex-diff-file-body" });
    if (!file.lines.length) {
      body.createDiv({ cls: "codex-diff-empty", text: "没有可展示的 diff 内容" });
      return;
    }
    for (const line of file.lines) {
      const row = body.createDiv({ cls: `codex-diff-line codex-diff-line-${line.type}` });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-old", text: line.oldLine === null ? "" : String(line.oldLine) });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-new", text: line.newLine === null ? "" : String(line.newLine) });
      row.createSpan({ cls: "codex-diff-marker", text: line.marker });
      row.createSpan({ cls: "codex-diff-content", text: line.text });
    }
  }

  private renderProcessEditSummary(container: HTMLElement, message: ChatMessage): void {
    const list = container.createDiv({ cls: "codex-process-edit-list" });
    for (const file of message.diffSummary?.files ?? []) {
      const row = list.createDiv({ cls: "codex-process-edit-row" });
      row.createSpan({ cls: "codex-process-edit-prefix", text: "已编辑 " });
      const ref = findProcessFileRef(message.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(row, ref, basename(file.path), "codex-process-edit-file");
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: ` +${file.added}` });
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: ` -${file.removed}` });
    }
  }

  private renderProcessFileTextLink(container: HTMLElement, file: ProcessFileRef, label: string, extraClass = ""): HTMLElement {
    const displayLabel = file.kind === "vault" ? noteNameForPath(file.path || label) : label;
    if (!file.openable) {
      return container.createSpan({
        cls: `codex-process-file-text is-disabled ${extraClass}`.trim(),
        text: displayLabel,
        attr: { title: `${file.displayPath}（无法打开）` }
      });
    }
    const link = container.createEl("span", {
      cls: `codex-process-file-link codex-process-file-link-${file.kind} ${extraClass}`.trim(),
      text: displayLabel,
      attr: {
        role: "button",
        tabindex: "0",
        title: file.displayPath,
        "aria-label": `打开 ${displayLabel}`
      }
    });
    link.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(file);
    };
    link.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(file);
    };
    return link;
  }

  private renderDeferredRawText(container: HTMLElement, message: ChatMessage, fallback: string): void {
    const status = this.renderProcessLoader(container, "正在加载全文");
    const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
    pre.setText(displayTextForMessage(message) || fallback);
    void this.loadRawText(message)
      .then((text) => {
        status.empty();
        status.setText(this.rawMetaLabel(message, text));
        pre.setText(text || fallback);
        this.requireEnv().onScheduleMeasure();
      })
      .catch((error) => {
        status.empty();
        status.setText(`全文加载失败：${error instanceof Error ? error.message : String(error)}`);
        this.requireEnv().onScheduleMeasure();
      });
  }

  private renderRawMessageExpander(container: HTMLElement, message: ChatMessage): void {
    const details = container.createEl("details", { cls: "codex-raw-message-details" });
    details.createEl("summary", { text: this.rawMetaLabel(message) });
    let loaded = false;
    details.ontoggle = () => {
      if (!details.open || loaded) return;
      loaded = true;
      const body = details.createDiv({ cls: "codex-raw-message-body" });
      this.renderProcessLoader(body, "正在加载全文");
      this.requireEnv().onScheduleMeasure();
      void this.loadRawText(message)
        .then((text) => {
          body.empty();
          this.renderPlainTextBlock(body, text || "暂无内容");
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `全文加载失败：${error instanceof Error ? error.message : String(error)}` });
          this.requireEnv().onScheduleMeasure();
        });
    };
  }

  private renderProcessLoader(container: HTMLElement, label: string): HTMLElement {
    const host = container.createDiv({ cls: "codex-process-raw-loading" });
    renderSmoothAILoader(host, label);
    return host;
  }

  private renderPlainTextBlock(container: HTMLElement, text: string): void {
    const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
    pre.setText(text);
  }

  private async loadRawText(message: ChatMessage): Promise<string> {
    if (!message.rawRef) return displayTextForMessage(message);
    const cached = this.rawTextCache.get(message.rawRef);
    if (cached !== undefined) return cached;
    const text = await this.requireEnv().readRawMessageText(message.rawRef);
    this.rawTextCache.set(message.rawRef, text);
    while (this.rawTextCache.size > 5) {
      const oldest = this.rawTextCache.keys().next().value;
      if (!oldest) break;
      this.rawTextCache.delete(oldest);
    }
    return text;
  }

  private rawMetaLabel(message: ChatMessage, loadedText?: string): string {
    const size = message.rawSize ?? loadedText?.length ?? displayTextForMessage(message).length;
    const lines = message.rawLines ?? (loadedText ? countLines(loadedText) : null);
    const parts = ["原始输出"];
    if (size) parts.push(formatBytes(size));
    if (lines) parts.push(`${lines} 行`);
    if (message.rawRef) parts.push("展开后已保留全文");
    return parts.join(" · ");
  }

  private renderProcessFileChips(container: HTMLElement, files: ProcessFileRef[]): void {
    for (const file of files) {
      const displayName = file.kind === "vault" ? noteNameForPath(file.path || file.name) : file.name;
      const chip = container.createEl("button", {
        cls: `codex-process-file-chip codex-process-file-${file.kind}`,
        attr: {
          type: "button",
          title: file.openable ? file.displayPath : `${file.displayPath}（无法打开）`,
          "aria-label": `打开 ${displayName}`
        }
      });
      chip.toggleClass("is-disabled", !file.openable);
      const icon = chip.createSpan({ cls: "codex-process-file-icon" });
      setIcon(icon, file.kind === "external" ? "folder-open" : "file-text");
      chip.createSpan({ cls: "codex-process-file-name", text: displayName });
      chip.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openProcessFile(file);
      };
    }
  }

  private async openProcessFile(file: ProcessFileRef): Promise<void> {
    const env = this.requireEnv();
    if (!file.openable) {
      new Notice("这个文件路径无法打开");
      return;
    }
    if (file.kind === "vault") {
      const vaultFile = env.app.vault.getAbstractFileByPath(normalizePath(file.path));
      if (vaultFile instanceof TFile) {
        await env.app.workspace.getLeaf("tab").openFile(vaultFile, { active: true });
        return;
      }
      if (file.absolutePath && showItemInFinder(file.absolutePath)) return;
      new Notice(`没有在当前 Obsidian 仓库找到：${file.displayPath}`);
      return;
    }
    if (file.kind === "external" && showItemInFinder(file.absolutePath ?? file.path)) return;
    new Notice("无法打开这个文件位置");
  }

  private pruneVirtualHeights(rowIds: string[]): void {
    const valid = new Set(rowIds);
    for (const key of Array.from(this.virtualRowHeights.keys())) {
      if (!valid.has(key)) this.virtualRowHeights.delete(key);
    }
  }
}

export const isProcessItemType = isAgentProcessItemType;

export function messageProvenanceMetaItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const backend = message.backendId ? backendDisplayName(message.backendId) : "";
  const agent = [backend, message.modelId, message.profileId].filter(Boolean).join(" · ");
  if (agent) items.push(agent);
  return items;
}

const ACTIVE_ANSWER_FOOTER_STATUSES = new Set(["running", "in_progress", "inProgress", "approval", "blocked"]);
const FAILED_ANSWER_STATUSES = new Set(["failed", "error", "canceled", "cancelled", "interrupted"]);

export function terminalAnswerFooterMessageIds(messages: ChatMessage[]): Set<string> {
  const activeKeys = new Set<string>();
  const finalAnswerByKey = new Map<string, ChatMessage>();
  for (const message of messages) {
    const key = agentRunHeaderKey(message);
    if (ACTIVE_ANSWER_FOOTER_STATUSES.has(message.status ?? "")) activeKeys.add(key);
    if (isAgentAnswerMessage(message)) finalAnswerByKey.set(key, message);
  }
  return new Set(Array.from(finalAnswerByKey.entries())
    .filter(([key, message]) => !activeKeys.has(key) && !ACTIVE_ANSWER_FOOTER_STATUSES.has(message.status ?? ""))
    .map(([, message]) => message.id));
}

function messagesWithoutSameRunEmptyAnswerLoader(
  messages: readonly ChatMessage[]
): ChatMessage[] {
  const runningReasoningRunIds = new Set(messages.flatMap((message) =>
    message.itemType === "reasoning"
    && message.reasoningSummary?.status === "running"
    && message.runId
      ? [message.runId]
      : []
  ));
  if (!runningReasoningRunIds.size) return [...messages];
  return messages.filter((message) => !(
    message.runId
    && runningReasoningRunIds.has(message.runId)
    && isAgentAnswerMessage(message)
    && message.status === "running"
    && !displayTextForMessage(message).trim()
  ));
}

function agentRunHeaderKey(message: ChatMessage): string {
  if (message.runId) return `run:${message.runId}`;
  if (message.turnId) return `turn:${message.turnId}`;
  return `message:${message.id}`;
}

function isAgentHeaderCandidate(message: ChatMessage): boolean {
  if (
    message.role === "user"
    || message.itemType === "knowledgeBase"
    || message.itemType === "taskPlan"
  ) return false;
  return message.itemType !== "thinking" && message.itemType !== "contextCompaction";
}

function taskPlanStatusLabel(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
): string {
  if (status === "pending") return "待执行";
  if (status === "in_progress") return "进行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "paused") return "已暂停";
  if (status === "interrupted") return "已中断";
  return "已取消";
}

function taskPlanStatusIcon(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
): string {
  if (status === "pending") return "circle";
  if (status === "in_progress") return "loader-circle";
  if (status === "completed") return "circle-check";
  if (status === "failed") return "circle-alert";
  if (status === "paused") return "circle-pause";
  if (status === "interrupted") return "circle-pause";
  return "circle-x";
}

function taskPlanHistoryStatus(
  status: EchoInkTaskPlanStatus,
  completed: number,
  total: number
): string {
  if (status === "completed") return `${total}/${total} 已完成`;
  if (status === "failed") return "任务失败";
  if (status === "cancelled") return "已取消";
  if (status === "paused") return "已中断，可继续";
  if (status === "pending") return "等待开始";
  return `${completed}/${total} 已完成`;
}

function safeDomIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(-160);
}

export function shouldRenderMessageTitle(message: ChatMessage, hasAgentHeader: boolean): boolean {
  if (!message.title || isProcessItemType(message.itemType)) return false;
  if (isAgentAnswerMessage(message)) return FAILED_ANSWER_STATUSES.has(message.status ?? "");
  return !hasAgentHeader;
}

export function messageTitleTime(message: ChatMessage): string {
  return isAgentAnswerMessage(message) ? "" : formatMessageHeaderTime(message.createdAt);
}

function agentModelLine(message: ChatMessage): string {
  return message.backendId ? backendDisplayName(message.backendId) : "";
}

export function agentFooterItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const time = formatAnswerFooterTime(message.completedAt ?? message.createdAt);
  if (time) items.push(time);
  return items;
}

function providerBrandForMessage(message: ChatMessage): ProviderBrandId {
  const identity = message.providerId?.trim();
  if (!identity) return "custom";
  return API_PROVIDER_PRESETS.find((preset) =>
    preset.id === identity || preset.runtimeProviderId === identity
  )?.id ?? "custom";
}

function noteNameForPath(path: string): string {
  return basename(path).replace(/\.md$/iu, "") || path;
}

function formatAnswerFooterTime(value: number): string {
  return formatMessageHeaderTime(value)
    .replace(/^星期/, "周")
    .replace(/([一二三四五六日天])(?=\d{2}:\d{2}$)/, "$1 ");
}

function rotatingChoice<T>(items: readonly T[], createdAt?: number): T {
  return items[rotatingIndex(createdAt) % items.length];
}

function rotatingIndex(createdAt?: number): number {
  const seed = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now();
  return Math.max(0, Math.floor((Date.now() - seed) / AGENT_LIVE_COPY_INTERVAL_MS));
}

function backendDisplayName(backendId: string): string {
  return backendId;
}

function messageRowId(message: Pick<ChatMessage, "id">): string {
  return `message:${message.id}`;
}

function actionItemRowId(message: Pick<ChatMessage, "id">): string {
  return `actionItem:${message.id}`;
}

export function isDirectProcessVirtualRow(rowId: string | undefined, message: Pick<ChatMessage, "id" | "itemType" | "role">): boolean {
  return rowId === (isActionTimelineItem(message) ? actionItemRowId(message) : messageRowId(message));
}

function completedTurnRowId(turn: CompletedAgentTurn): string {
  return `turnProcess:${turn.key}:${turn.finalAnswer.id}`;
}

function actionItemMeta(item: ActionItemViewModel): string {
  if (item.status === "failed" && item.detail) return item.detail;
  if (item.kind === "tool" && item.detail) return item.detail;
  if (item.kind === "agent" && item.detail) return item.detail;
  if (item.kind === "system" && item.detail) return item.detail;
  return "";
}

function actionItemTarget(item: ActionItemViewModel): string {
  if (item.kind === "command" && item.command?.summary) return item.command.summary;
  const prefix = actionVerb(item);
  const title = item.title.startsWith(prefix) ? item.title.slice(prefix.length).trim() : item.title;
  return title
    .replace(/^(?:已运行|已读取|已搜索|已编辑|已调用|已处理|已更新|已验证|已记录|正在编辑|创建失败)\s*/, "")
    .replace(/^命令\s*/, "")
    .trim();
}

function hasActionItemDetails(item: ActionItemViewModel): boolean {
  if (item.source.processContentAvailability === "unavailable" || hasExplicitProcessChannels(item.source)) return true;
  const hasToolPayload = Boolean(
    item.source.rawRef
    || item.source.text.trim()
    || item.source.files?.length
    || item.source.diffSummary?.files.length
  );
  return Boolean(
    item.source.rawRef ||
    item.kind === "command" ||
    item.kind === "edit" ||
    ((item.kind === "tool" || item.kind === "agent") && hasToolPayload)
  );
}

function hasExplicitProcessChannels(message: ChatMessage): boolean {
  return Boolean(message.processInputAvailability || message.processOutputAvailability);
}

function actionItemDetailLabel(item: ActionItemViewModel): string {
  if (item.kind === "command") return item.status === "failed" ? "查看错误输出" : "查看 Shell 输出";
  if (item.kind === "edit") return "查看文件改动";
  if (item.kind === "tool" || item.kind === "agent") return "查看工具详情";
  return "查看详情";
}

export function actionVerb(item: ActionItemViewModel): string {
  if (item.source.status === "expired") return statusActionVerb(item.kind, "确认已过期");
  if (item.status === "unconfirmed") return statusActionVerb(item.kind, "状态未回传");
  if (item.status === "interrupted") return statusActionVerb(item.kind, "已中断");
  if (item.status === "canceled") return statusActionVerb(item.kind, "已取消");
  if (item.status === "waiting_approval") return statusActionVerb(item.kind, "等待确认");
  if (item.status === "approved") return statusActionVerb(item.kind, "已批准");
  if (item.status === "verifying") return statusActionVerb(item.kind, "验证中");
  if (item.status === "denied") return statusActionVerb(item.kind, "已拒绝");
  if (item.status === "uncertain") return statusActionVerb(item.kind, "结果不确定");
  if (item.status === "recovery-pending") return statusActionVerb(item.kind, "等待恢复");
  if (item.status === "recovery-blocked") return statusActionVerb(item.kind, "恢复受阻");
  if (item.status === "running" || item.status === "blocked") return runningActionVerb(item.kind);
  if (item.status === "failed") return statusActionVerb(item.kind, "失败");
  if (item.kind === "read") return "已读取";
  if (item.kind === "search") return "已搜索";
  if (item.kind === "command") return "已运行";
  if (item.kind === "edit") return "已编辑";
  if (item.kind === "tool") return "已调用";
  if (item.kind === "agent") return "已处理";
  if (item.kind === "plan") return "已更新";
  if (item.kind === "verify") return "已验证";
  return "已记录";
}

function statusActionVerb(kind: ActionGroupKind, suffix: string): string {
  const labels: Record<ActionGroupKind, string> = {
    read: "读取",
    search: "搜索",
    command: "运行",
    edit: "编辑",
    tool: "工具调用",
    agent: "智能体动作",
    plan: "计划更新",
    verify: "验证",
    system: "系统动作"
  };
  return `${labels[kind]}${suffix}`;
}

function runningActionVerb(kind: ActionGroupKind): string {
  const labels: Record<ActionGroupKind, string> = {
    read: "正在读取",
    search: "正在搜索",
    command: "正在运行",
    edit: "正在编辑",
    tool: "正在调用",
    agent: "正在处理",
    plan: "正在更新",
    verify: "正在验证",
    system: "正在处理"
  };
  return labels[kind];
}

function iconForActionKind(kind: ActionGroupKind, status?: string): string {
  if (status === "failed" || status === "uncertain" || status === "recovery-blocked") return "triangle-alert";
  if (status === "denied" || status === "canceled") return "circle-slash";
  const icons: Record<ActionGroupKind, string> = {
    read: "book-open",
    search: "search",
    command: "terminal",
    edit: "file-pen",
    tool: "blocks",
    agent: "bot",
    plan: "list-checks",
    verify: "badge-check",
    system: "minimize-2"
  };
  return icons[kind] ?? "circle";
}

function stableDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function findProcessFileRef(refs: ProcessFileRef[], filePath: string): ProcessFileRef | null {
  const normalizedPath = normalizePath(filePath);
  const fileName = basename(filePath);
  return (
    refs.find((ref) => ref.path === filePath || ref.displayPath === filePath || ref.absolutePath === filePath) ??
    refs.find((ref) => normalizePath(ref.path) === normalizedPath || normalizePath(ref.displayPath) === normalizedPath) ??
    refs.find((ref) => ref.name === fileName) ??
    null
  );
}

function shellTranscript(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "$";
  const lines = trimmed.split(/\r?\n/);
  const command = lines.shift()?.trim() ?? "";
  const output = lines.join("\n").trim();
  if (!output) return `$ ${command}`;
  return `$ ${command}\n\n${output}`;
}

function iconForProcessMessage(message: ChatMessage): string {
  const processIcons: Record<string, string> = {
    search: "search",
    view: "book-open",
    edit: "pencil",
    run: "terminal",
    command: "terminal",
    tool: "blocks"
  };
  const processIcon = processIcons[message.processKind ?? ""];
  if (processIcon) return processIcon;
  return iconForItemType(message.itemType);
}

function iconForItemType(itemType?: string): string {
  const icons: Record<string, string> = {
    plan: "list-checks",
    commandExecution: "terminal",
    fileChange: "file-diff",
    mcpToolCall: "blocks",
    dynamicToolCall: "blocks",
    collabAgentToolCall: "blocks"
  };
  return icons[itemType ?? ""] ?? "chevron-right";
}

function titleForItemType(message: ChatMessage): string {
  if (message.title) return message.title;
  const titles: Record<string, string> = {
    plan: "更新计划",
    commandExecution: "使用命令",
    fileChange: "编辑文件",
    mcpToolCall: "使用工具",
    dynamicToolCall: "使用工具",
    collabAgentToolCall: "使用工具"
  };
  return titles[message.itemType ?? ""] ?? "工具";
}

function labelForStatus(status: string): string {
  const labels: Record<string, string> = {
    running: "进行中",
    waiting_approval: "等待确认",
    approved: "已批准",
    verifying: "验证中",
    completed: "完成",
    error: "失败",
    failed: "失败",
    denied: "已拒绝",
    uncertain: "结果不确定",
    canceled: "已取消",
    cancelled: "已取消",
    expired: "确认已过期",
    blocked: "等待确认",
    interrupted: "中断",
    unconfirmed: "状态未回传",
    "recovery-pending": "等待恢复",
    "recovery-blocked": "恢复受阻"
  };
  return labels[status] ?? status;
}

function isActiveActionStatus(status: ActionItemViewModel["status"]): boolean {
  return status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying";
}

function isAttentionActionStatus(status: ActionItemViewModel["status"]): boolean {
  return status === "failed" || status === "denied" || status === "uncertain";
}

function isActiveProcessStatus(status: string | undefined): boolean {
  return status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying"
    || status === "blocked"
    || status === "recovery-pending";
}

function approvalStateForMessage(
  message: Readonly<ChatMessage>
): SmoothAIApprovalState | null {
  const status = message.approval?.status;
  if (status === "pending") return "waiting_approval";
  if (status === "approved") return "approved";
  if (status === "denied") return "denied";
  if (status === "cancelled") return "cancelled";
  if (status === "expired") return "expired";
  return null;
}

function isAttentionProcessStatus(status: string | undefined): boolean {
  return status === "error"
    || status === "failed"
    || status === "denied"
    || status === "uncertain";
}

function labelForDiffKind(kind: string): string {
  const labels: Record<string, string> = {
    add: "新增",
    delete: "删除",
    update: "修改",
    move: "移动",
    unknown: "改动"
  };
  return labels[kind] ?? "改动";
}

function localDocumentSources(
  citations: KnowledgeBaseCitationSummary | undefined,
  usage: KnowledgeUsageMessageData
): LocalDocumentSource[] {
  const documents: LocalDocumentSource[] = [];
  const vaultDocuments = new Map<string, LocalVaultDocumentSource>();
  const memoryKeys = new Set<string>();
  const getVaultDocument = (rawPath: string): LocalVaultDocumentSource | null => {
    const path = rawPath.trim();
    if (!path) return null;
    const normalizedPath = normalizePath(path);
    const key = `vault:${normalizedPath}`;
    const existing = vaultDocuments.get(key);
    if (existing) return existing;
    const document: LocalVaultDocumentSource = {
      citations: [],
      key,
      kind: "vault",
      path: normalizedPath,
      references: []
    };
    vaultDocuments.set(key, document);
    documents.push(document);
    return document;
  };

  for (const citation of citations?.citations ?? []) {
    getVaultDocument(citation.path)?.citations.push(citation);
  }
  for (const reference of usage.references) {
    getVaultDocument(reference.vaultRelativePath)?.references.push(reference);
  }
  for (const source of usage.personalMemorySources) {
    const id = source.id.trim();
    if (!id) continue;
    const key = `memory:${id}`;
    if (memoryKeys.has(key)) continue;
    memoryKeys.add(key);
    documents.push({ key, kind: "memory", source });
  }
  return documents;
}

function localDocumentMetadata(
  document: LocalVaultDocumentSource,
  evidenceStatus?: KnowledgeBaseCitationSummary["status"]
): string[] {
  const labels = new Set<string>();
  for (const citation of document.citations) labels.add(kbBucketLabel(citation.bucket));
  if (document.citations.length && evidenceStatus) labels.add(kbEvidenceStatusLabel(evidenceStatus));
  for (const reference of document.references) {
    labels.add(`第 ${reference.lineStart}-${reference.lineEnd} 行`);
  }
  return Array.from(labels);
}

function localDocumentExcerpts(document: LocalVaultDocumentSource): string[] {
  const excerpts = new Set<string>();
  for (const citation of document.citations) {
    const excerpt = citation.excerptLines.join("\n");
    if (excerpt) excerpts.add(excerpt);
  }
  for (const reference of document.references) {
    if (reference.excerpt) excerpts.add(reference.excerpt);
  }
  return Array.from(excerpts);
}

function hasRenderableDiff(files: ParsedDiffFile[]): boolean {
  return files.some((file) => file.lines.some((line) =>
    line.type === "hunk"
    || line.type === "add"
    || line.type === "remove"
    || line.type === "context"
  ));
}

function kbBucketLabel(bucket: KnowledgeBaseCitationBucket): string {
  if (bucket === "wiki") return "Wiki";
  if (bucket === "journal") return "Journal";
  return "Outputs";
}

function kbEvidenceStatusLabel(status: KnowledgeBaseCitationSummary["status"]): string {
  if (status === "strong") return "强证据";
  if (status === "weak") return "弱相关";
  return "无本地依据";
}

function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function knowledgeBaseRunDisplayTitle(payload: KnowledgeBaseRunPayload, status?: string): string {
  if (status === "recovery-pending") return "正在恢复上次知识库维护";
  if (status === "recovery-blocked") return "知识库维护恢复被阻断";
  if (status === "interrupted") return "知识库任务已中断";
  if (status === "canceled") return "知识库任务已取消";
  if (status === "failed") return "知识库任务失败";
  if (status === "completed") return "知识库任务已完成";
  return payload.title;
}

function knowledgeBaseRunStatusIcon(payload: KnowledgeBaseRunPayload, status: string): string {
  if (status === "completed") return "check";
  if (status === "recovery-blocked" || status === "interrupted" || status === "canceled" || status === "failed") return "x";
  return payload.icon;
}

export function knowledgeBaseRunEventCopy(payload: KnowledgeBaseRunPayload): string {
  const event = [...(payload.events ?? [])].reverse().find((candidate) =>
    candidate.type === "workflow.phase.started"
    || candidate.type === "workflow.phase.progress"
    || candidate.type === "workflow.phase.failed"
  );
  if (!event) return payload.subtitle;
  if (event.message?.trim()) return event.message.trim();
  if (event.phaseId) {
    const phase = payload.phases.find((candidate) => candidate.id === event.phaseId);
    if (phase) return `${phase.label}阶段`;
  }
  return payload.subtitle;
}

export function knowledgeBaseMaintainExecutionItems(
  payload: KnowledgeBaseMaintainReportPayload
): string[] {
  const items: string[] = [];
  if (payload.completion === "noop") items.push("无新来源");
  else if (payload.completion === "partial") items.push("部分完成");
  else if (payload.completion === "recovered") items.push("自动恢复完成");
  else if (payload.completion === "full") items.push("完整完成");

  if (payload.performance) {
    items.push(formatKnowledgeBaseRunDuration(payload.performance.totalMs));
    if (!payload.performance.agentCalled) items.push("未调用 Agent");
    if (payload.performance.index) {
      items.push(`索引复用 ${payload.performance.index.reused}，刷新 ${payload.performance.index.refreshed}`);
    }
    const completedPhases = payload.performance.phases.filter((phase) => phase.status === "success").length;
    if (payload.performance.phases.length) {
      items.push(`${completedPhases}/${payload.performance.phases.length} 阶段`);
    }
  }
  return items;
}

function formatKnowledgeBaseRunDuration(durationMs: number): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs < 1000) return `用时 ${Math.round(safeMs)}ms`;
  const totalSeconds = Math.round(safeMs / 100) / 10;
  if (totalSeconds < 60) return `用时 ${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds ? `用时 ${minutes} 分 ${seconds} 秒` : `用时 ${minutes} 分`;
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${Math.round(byteCount / 1024)} KB`;
  return `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function rememberOpenState(store: Map<string, boolean>, id: string, open: boolean): void {
  if (open) store.set(id, true);
  else store.delete(id);
}

function toImageSrc(app: App, imagePath: string): string {
  if (imagePath.startsWith("/")) return `file://${imagePath}`;
  const file = app.vault.getAbstractFileByPath(imagePath);
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  if (Platform.isDesktopApp) return `file://${imagePath}`;
  return imagePath;
}
