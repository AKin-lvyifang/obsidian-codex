import { setIcon } from "obsidian";
import {
  renderProviderBrandIcon,
  type ProviderBrandId
} from "../../settings/provider-brand-icons";
import type { EchoInkResource } from "../../resources/types";
import { enabledSkillResources } from "../../resources/registry";
import { mcpConnectionStatus, mcpConnectionStatusLabel } from "../../resources/mcp-connections";
import type { EchoInkResourceSettings } from "../../resources/types";
import type {
  PiConversationDiagnostic,
  PiConversationSupportState
} from "../../harness/pi-native/contracts";
import type { PiContextLedger } from "../../harness/pi-native/pi-context-budget";
import { formatContextTokenCount } from "../../core/mapping";
import type { StoredAttachment, StoredSession } from "../../settings/settings";
import type { PermissionMode, ReasoningEffort, UiMode } from "../../types/app-server";
import { composerPrimaryActionForState, composerStateForRuntimeState } from "../composer-state";
import { handleKnowledgeCommandMenuKeyDown } from "../knowledge-command-menu";
import type { QueuedTurnItem } from "../turn-queue";
import { renderAnimateIcon } from "../animate-icon";

let knowledgeCommandMenuId = 0;

export interface ComposerShellRefs {
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  workspaceEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  resourcePanelEl: HTMLElement;
  toolbarEl: HTMLElement;
}

export interface ComposerShellCallbacks {
  onInputChanged: () => void;
  onPasteFiles: (event: ClipboardEvent) => void;
  onSendMessage: () => void;
  onDropFiles: (event: DragEvent) => void;
}

export interface ComposerToolbarState {
  session: StoredSession;
  knowledgeTaskRunning: boolean;
  selectedSkill: EchoInkResource | null;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  running: boolean;
  promptEnhancerRunning: boolean;
  viewRunKind?: "chat" | "editor" | "";
  activeRunSessionId?: string;
  hasDraft: boolean;
  hasTextDraft: boolean;
  hasQueuedItems: boolean;
  currentComposerModel: string;
  currentComposerProviderBrand: ProviderBrandId;
  currentComposerSummaryTitle: string;
  workspacePath: string;
  workspaceDisplayName: string;
  workspaceValid: boolean;
  contextLedger?: Readonly<PiContextLedger>;
  contextPanelOpen: boolean;
}

export interface ComposerToolbarRefs {
  addButtonEl?: HTMLButtonElement;
  contextEl?: HTMLElement;
  contextRingEl?: HTMLElement;
}

export interface ComposerResourcePanelState {
  open: boolean;
  selectedSkill: EchoInkResource | null;
  selectedMode: UiMode;
  resources: EchoInkResource[];
  resourceSettings: Pick<EchoInkResourceSettings, "mcpConnections">;
  language: "zh-CN" | "en";
}

export interface ComposerResourcePanelCallbacks {
  onDismiss: (restoreFocus: boolean) => void;
  onPickFiles: (imagesOnly: boolean) => void;
  onAttachActiveFile: () => void;
  onSelectPlanMode: () => void;
  onSelectSkill: (skill: EchoInkResource) => void;
  onOpenMcpSettings: () => void;
}

export interface ComposerToolbarCallbacks {
  onOpenAddMenu: (event: MouseEvent) => void;
  onEnhancePrompt: () => void;
  onCaptureKnowledgeSource: () => void;
  onPermissionChange: (value: PermissionMode) => void;
  onOpenWorkspaceMenu: (event: MouseEvent, session: StoredSession) => void;
  onOpenModelMenu: (event: MouseEvent) => void;
  onToggleContextPanel: () => void;
  onMicInput: () => void;
  onCancelKnowledgeTask: () => void;
  onStopTurn: () => void;
  onSteerPiChat: () => void;
  onEnqueueDraft: () => void;
  onResumeQueue: (sessionId: string) => void;
  onSendMessage: () => void;
}

export interface TurnQueueState {
  items: QueuedTurnItem[];
  paused: boolean;
  canResume: boolean;
  recoveryRequired: boolean;
  canRecover: boolean;
  draggedItemId: string;
  piSupport: PiConversationSupportState | null;
  piRecoveryPending: boolean;
  canManagePiSupport: boolean;
}

export interface TurnQueueCallbacks {
  onResume: () => void;
  onRecover: () => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onReorder: (sessionId: string, sourceId: string, targetIndex: number) => void;
  onRemove: (sessionId: string, itemId: string) => void;
  onEditPiDraft: (draftId: string) => void;
  onRemovePiDraft: (draftId: string) => void;
  onRecoverPiConversation: (recoveryPath: string) => void;
}

export interface ComposerAttachmentsState {
  selectedSkill: EchoInkResource | null;
  attachments: StoredAttachment[];
}

export interface ComposerAttachmentsCallbacks {
  onRemoveSkill: () => void;
  onRemoveAttachment: (path: string) => void;
}

export function shouldShowComposerPlanIndicator(selectedMode: UiMode): boolean {
  return selectedMode === "plan";
}

export function renderComposerShell(rootEl: HTMLElement, callbacks: ComposerShellCallbacks): ComposerShellRefs {
  const inputWrap = rootEl.createDiv({ cls: "codex-input-wrap" });
  const queueEl = inputWrap.createDiv({ cls: "codex-turn-queue" });
  const attachmentsEl = inputWrap.createDiv({ cls: "codex-attachments" });
  const workspaceEl = inputWrap.createDiv({ cls: "codex-composer-workspace" });
  const commandMenuId = `codex-knowledge-command-menu-${++knowledgeCommandMenuId}`;
  const inputEl = inputWrap.createEl("textarea", {
    cls: "codex-input",
    attr: {
      placeholder: "问 Codex，让它管理当前 Obsidian 仓库",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": commandMenuId,
      "aria-label": "输入消息、命令或已启用 Skill"
    }
  });
  const promptEnhanceReviewEl = inputWrap.createDiv({ cls: "codex-composer-enhance-review" });
  const skillMenuEl = inputWrap.createDiv({ cls: "codex-skill-menu" });
  const knowledgeCommandMenuEl = inputWrap.createDiv({
    cls: "codex-knowledge-command-menu",
    attr: { id: commandMenuId, role: "listbox", "aria-label": "命令与已启用 Skill" }
  });
  const resourcePanelEl = inputWrap.createDiv({
    cls: "codex-composer-resource-panel",
    attr: {
      role: "menu",
      "aria-label": "添加资源",
      "aria-hidden": "true"
    }
  });
  const toolbarEl = inputWrap.createDiv({ cls: "codex-toolbar" });
  inputEl.addEventListener("input", callbacks.onInputChanged);
  inputEl.addEventListener("paste", callbacks.onPasteFiles);
  inputEl.addEventListener("keydown", (event) => {
    if (handleKnowledgeCommandMenuKeyDown(event, inputEl, knowledgeCommandMenuEl)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      callbacks.onSendMessage();
    }
  });
  inputWrap.addEventListener("dragover", (event) => {
    event.preventDefault();
    inputWrap.addClass("is-dragging");
  });
  inputWrap.addEventListener("dragleave", () => inputWrap.removeClass("is-dragging"));
  inputWrap.addEventListener("drop", (event) => {
    event.preventDefault();
    inputWrap.removeClass("is-dragging");
    callbacks.onDropFiles(event);
  });

  return {
    queueEl,
    attachmentsEl,
    workspaceEl,
    inputEl,
    promptEnhanceReviewEl,
    skillMenuEl,
    knowledgeCommandMenuEl,
    resourcePanelEl,
    toolbarEl
  };
}

export function renderPromptEnhanceReview(container: HTMLElement, callbacks: { onRestore: () => void }): void {
  container.empty();
  container.addClass("is-visible");
  const status = container.createSpan({ cls: "codex-composer-enhance-review-text", text: "已增强，可继续编辑" });
  status.createSpan({ cls: "codex-composer-enhance-review-dot", text: "·" });
  const restoreButton = container.createEl("button", {
    cls: "codex-composer-enhance-restore",
    attr: { type: "button", title: "还原", "aria-label": "还原" }
  });
  setIcon(restoreButton, "rotate-ccw");
  restoreButton.createSpan({ text: "还原" });
  restoreButton.onclick = callbacks.onRestore;
}

export function clearPromptEnhanceReview(container: HTMLElement | undefined): void {
  if (!container) return;
  container.empty();
  container.removeClass("is-visible");
}

export function renderComposerToolbar(
  container: HTMLElement,
  workspaceContainer: HTMLElement,
  state: ComposerToolbarState,
  callbacks: ComposerToolbarCallbacks
): ComposerToolbarRefs {
  container.empty();
  workspaceContainer.empty();
  workspaceContainer.addClass("is-visible");
  addWorkspaceButton(workspaceContainer, state, callbacks);
  if (shouldShowComposerPlanIndicator(state.selectedMode)) {
    addPlanModeIndicator(workspaceContainer);
  }

  const row = container.createDiv({ cls: "codex-composer-row" });
  const left = row.createDiv({ cls: "codex-composer-left" });
  const right = row.createDiv({ cls: "codex-composer-right" });

  const addButton = createComposerIconButton(left, "plus", "添加资源");
  addButton.setAttribute("aria-haspopup", "menu");
  addButton.setAttribute("aria-expanded", "false");
  addButton.dataset.composerAddButton = "true";
  addButton.onclick = callbacks.onOpenAddMenu;

  const refs: ComposerToolbarRefs = { addButtonEl: addButton };
  const captureButton = createComposerIconButton(left, "bookmark-plus", "收藏到知识库");
  captureButton.onclick = callbacks.onCaptureKnowledgeSource;

  addComposerSelect<PermissionMode>(left, "shield-check", ["read-only", "workspace-write", "danger-full-access"], state.selectedPermission, callbacks.onPermissionChange, "权限", "codex-permission-control");
  refs.contextEl = right.createEl("button", {
    cls: "codex-context-meter",
    attr: {
      type: "button",
      title: "查看最近一次模型请求的上下文用量",
      "aria-label": "查看上下文用量",
      "aria-expanded": state.contextPanelOpen ? "true" : "false",
      "aria-haspopup": "dialog"
    }
  });
  refs.contextRingEl = refs.contextEl.createSpan({ cls: "codex-context-ring", attr: { "aria-hidden": "true" } });
  refs.contextRingEl.createSpan({ cls: "codex-context-ring-hole" });
  refs.contextEl.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks.onToggleContextPanel();
  };

  const modelButton = addModelButton(
    right,
    "模型和运行参数",
    state.currentComposerSummaryTitle,
    state.currentComposerModel,
    state.currentComposerProviderBrand
  );
  modelButton.onclick = callbacks.onOpenModelMenu;

  const micButton = right.createEl("button", {
    cls: "codex-composer-icon-button codex-composer-mic-button",
    attr: { type: "button", "aria-label": "语音输入", title: "语音输入" }
  });
  renderAnimateIcon(micButton, "mic");
  micButton.onclick = callbacks.onMicInput;

  const composerState = composerStateForRuntimeState({
    viewRunning: state.running,
    viewRunKind: state.viewRunKind,
    globalKnowledgeTaskRunning: state.knowledgeTaskRunning,
    hasDraft: state.hasDraft,
    hasQueuedItems: state.hasQueuedItems
  });
  const action = composerPrimaryActionForState(composerState);
  if (shouldShowPiSteerAction(state)) {
    const steerButton = row.createEl("button", {
      cls: "codex-composer-steer-button",
      attr: {
        type: "button",
        title: "立即调整当前 Pi 任务方向",
        "aria-label": "调整方向"
      }
    });
    const steerIcon = steerButton.createSpan({
      cls: "codex-composer-steer-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(steerIcon, "git-branch");
    steerButton.createSpan({ cls: "codex-composer-steer-label", text: "调整方向" });
    steerButton.onclick = callbacks.onSteerPiChat;
  }
  const sendButtonView = composerActionButtonView(action);
  const sendButton = row.createEl("button", {
    cls: "codex-send-button codex-composer-send-button",
    attr: { type: "button", "aria-label": sendButtonView.label, title: sendButtonView.title }
  });
  sendButton.toggleClass("is-send-action", action === "send");
  sendButton.toggleClass("is-queue-action", action === "enqueue" || action === "resume-queue");
  sendButton.toggleClass("is-stop-action", action === "stop-turn" || action === "cancel-knowledge-task");
  sendButton.disabled = state.promptEnhancerRunning;
  if (state.promptEnhancerRunning) {
    sendButton.setAttribute("aria-label", "提示词增强中");
    sendButton.setAttribute("title", "提示词增强完成后再发送");
  }
  if (action === "send") {
    renderAnimateIcon(sendButton, "send");
  } else {
    const sendIconWrap = sendButton.createSpan({
      cls: "codex-composer-send-icon-wrap",
      attr: { "aria-hidden": "true" }
    });
    setIcon(sendIconWrap, sendButtonView.icon);
  }
  sendButton.onclick = () => {
    if (action === "cancel-knowledge-task") callbacks.onCancelKnowledgeTask();
    else if (action === "stop-turn") callbacks.onStopTurn();
    else if (action === "enqueue") callbacks.onEnqueueDraft();
    else if (action === "resume-queue") callbacks.onResumeQueue(state.session.id);
    else callbacks.onSendMessage();
  };
  return refs;
}

export function renderComposerResourcePanel(
  container: HTMLElement,
  state: ComposerResourcePanelState,
  callbacks: ComposerResourcePanelCallbacks
): void {
  container.empty();
  container.toggleClass("is-visible", state.open);
  container.setAttribute("aria-hidden", String(!state.open));
  if (!state.open) return;

  const addGroup = createResourcePanelGroup(container, "添加");
  createResourcePanelRow(addGroup, "paperclip", "文件和文件夹", "", () => callbacks.onPickFiles(false));
  createResourcePanelRow(addGroup, "file-text", "添加当前笔记", "", callbacks.onAttachActiveFile);
  createResourcePanelRow(
    addGroup,
    "lightbulb",
    "计划模式",
    state.selectedMode === "plan" ? "已开启" : "",
    callbacks.onSelectPlanMode,
    state.selectedMode === "plan"
  );
  createResourcePanelRow(addGroup, "image", "添加图片", "", () => callbacks.onPickFiles(true));

  const skillGroup = createResourcePanelGroup(container, "技能");
  const skills = enabledSkillResources(state.resources);
  if (skills.length) {
    for (const skill of skills) {
      createResourcePanelRow(
        skillGroup,
        "box",
        skill.name,
        skill.description || skill.contentPath || "已启用 Skill",
        () => callbacks.onSelectSkill(skill),
        state.selectedSkill?.id === skill.id
      );
    }
  } else {
    skillGroup.createDiv({ cls: "codex-composer-resource-empty", text: "暂无已启用 Skill" });
  }

  const mcpGroup = createResourcePanelGroup(container, "MCP");
  const mcpResources = state.resources
    .filter((resource) => resource.kind === "mcp-server")
    .sort((left, right) => left.name.localeCompare(right.name, state.language === "en" ? "en" : "zh-CN"));
  if (mcpResources.length) {
    for (const resource of mcpResources) {
      const status = mcpConnectionStatus(resource, state.resourceSettings);
      createResourcePanelRow(
        mcpGroup,
        "blocks",
        resource.name,
        mcpConnectionStatusLabel(status, state.language),
        callbacks.onOpenMcpSettings,
        resource.enabled,
        `is-mcp-status-${status}`
      );
    }
  } else {
    mcpGroup.createDiv({ cls: "codex-composer-resource-empty", text: "暂无已配置 MCP" });
  }

  container.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onDismiss(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".codex-composer-resource-row"));
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(container.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + rows.length) % rows.length
          : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };
}

function createResourcePanelGroup(container: HTMLElement, label: string): HTMLElement {
  const group = container.createDiv({ cls: "codex-composer-resource-group", attr: { role: "group", "aria-label": label } });
  group.createDiv({ cls: "codex-composer-resource-group-label", text: label });
  return group;
}

function createResourcePanelRow(
  container: HTMLElement,
  iconName: string,
  label: string,
  description: string,
  onActivate: () => void,
  active = false,
  extraClass = ""
): HTMLButtonElement {
  const row = container.createEl("button", {
    cls: `codex-composer-resource-row${active ? " is-active" : ""}${extraClass ? ` ${extraClass}` : ""}`,
    attr: { type: "button", role: "menuitem" }
  });
  const icon = row.createSpan({ cls: "codex-composer-resource-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, iconName);
  row.createSpan({ cls: "codex-composer-resource-name", text: label });
  if (description) row.createSpan({ cls: "codex-composer-resource-description", text: description });
  row.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
  return row;
}

const CONTEXT_CATEGORY_LABELS: Readonly<Record<
  PiContextLedger["categories"][number]["category"],
  string
>> = Object.freeze({
  system: "系统提示词",
  vault_tool_schema: "Obsidian 工具",
  mcp_tool_schema: "连接器及 MCP",
  skill: "技能",
  conversation: "对话消息",
  compaction: "上下文摘要",
  memory: "长期记忆",
  knowledge: "知识库",
  temporary_materials: "临时材料"
});

export function contextCategoryLabel(
  category: PiContextLedger["categories"][number]["category"]
): string {
  return CONTEXT_CATEGORY_LABELS[category];
}

export function renderContextPanel(
  container: HTMLElement,
  ledger: Readonly<PiContextLedger> | undefined,
  onClose: () => void
): void {
  container.empty();
  const header = container.createDiv({ cls: "codex-context-panel-header" });
  header.createDiv({ cls: "codex-context-panel-title", text: "上下文用量" });
  const closeButton = header.createEl("button", {
    cls: "codex-context-panel-close",
    attr: {
      type: "button",
      title: "关闭",
      "aria-label": "关闭上下文用量"
    }
  });
  setIcon(closeButton, "x");
  closeButton.onclick = onClose;
  if (!ledger) {
    container.createDiv({
      cls: "codex-context-panel-empty",
      text: "发送一条消息后，这里会显示最近一次模型请求的真实上下文用量。"
    });
    return;
  }

  const percent = ledger.budget.effectiveInputBudget > 0
    ? Math.min(100, (ledger.totalInputTokens / ledger.budget.effectiveInputBudget) * 100)
    : 0;
  const summary = container.createDiv({ cls: "codex-context-summary" });
  summary.createEl("strong", {
    cls: "codex-context-summary-percent",
    text: `${Math.round(percent * 10) / 10}%`
  });
  summary.createSpan({
    cls: "codex-context-summary-used",
    text: `已用 ${formatContextTokenCount(ledger.totalInputTokens)} / ${formatContextTokenCount(ledger.budget.effectiveInputBudget)}`
  });
  const progress = container.createDiv({
    cls: "codex-context-progress",
    attr: {
      role: "progressbar",
      "aria-label": "有效输入预算使用率",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(percent))
    }
  });
  const usedBar = progress.createDiv({ cls: "codex-context-progress-used", attr: { "aria-hidden": "true" } });
  usedBar.setCssProps({
    "--codex-context-progress": `${percent}%`
  });
  const categoryTotal = ledger.categories.reduce((total, category) => total + category.tokens, 0);
  for (const category of ledger.categories) {
    if (category.tokens <= 0 || categoryTotal <= 0) continue;
    usedBar.createDiv({
      cls: `codex-context-progress-segment is-${category.category}`
    }).setCssProps({
      "--codex-context-segment": `${(category.tokens / categoryTotal) * 100}%`
    });
  }

  const categories = container.createDiv({ cls: "codex-context-categories" });
  for (const category of ledger.categories) {
    const row = categories.createDiv({ cls: "codex-context-category" });
    const label = row.createSpan({ cls: "codex-context-category-label" });
    label.createSpan({
      cls: `codex-context-category-dot is-${category.category}`,
      attr: { "aria-hidden": "true" }
    });
    label.createSpan({ text: contextCategoryLabel(category.category) });
    row.createSpan({
      cls: "codex-context-category-value",
      text: `${ledger.budget.effectiveInputBudget > 0
        ? Math.round((category.tokens / ledger.budget.effectiveInputBudget) * 1000) / 10
        : 0}%`
    });
  }
}

export function shouldShowPiSteerAction(
  state: Pick<
    ComposerToolbarState,
    | "session"
    | "running"
    | "promptEnhancerRunning"
    | "viewRunKind"
    | "activeRunSessionId"
    | "hasTextDraft"
  >
): boolean {
  return Boolean(
    state.session.bodyAuthority === "pi_session_only"
    && state.running
    && !state.promptEnhancerRunning
    && state.viewRunKind === "chat"
    && state.activeRunSessionId === state.session.id
    && state.hasTextDraft
  );
}

export function renderTurnQueue(container: HTMLElement, state: TurnQueueState, callbacks: TurnQueueCallbacks): void {
  container.empty();
  const visibleDiagnostics = visiblePiConversationDiagnostics(state.piSupport);
  const recovery = piConversationRecoveryCandidate(state.piSupport);
  const piDrafts = state.piSupport?.drafts ?? [];
  const hasLegacyQueue = Boolean(state.items.length) || state.recoveryRequired;
  container.toggleClass(
    "is-visible",
    hasLegacyQueue || Boolean(piDrafts.length) || Boolean(visibleDiagnostics.length)
  );
  container.toggleClass("is-paused", state.paused);
  container.toggleClass("is-recovery-required", state.recoveryRequired);
  if (!hasLegacyQueue && !piDrafts.length && !visibleDiagnostics.length) return;

  if (visibleDiagnostics.length) {
    renderPiConversationDiagnostics(
      container,
      visibleDiagnostics,
      recovery,
      state,
      callbacks
    );
  }

  if (piDrafts.length) {
    renderPiConversationDrafts(container, state, callbacks);
  }

  if (!hasLegacyQueue) return;

  const header = container.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const titleIcon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(
    titleIcon,
    state.recoveryRequired
      ? "shield-alert"
      : state.paused
        ? "pause-circle"
        : "list-ordered"
  );
  title.createSpan({
    text: state.recoveryRequired
      ? `本地记录待恢复${state.items.length ? ` · 队列 ${state.items.length}` : ""}`
      : state.paused
        ? `队列已暂停 · ${state.items.length}`
        : `队列 · ${state.items.length}`
  });

  if (state.recoveryRequired && state.canRecover) {
    const recover = header.createEl("button", {
      cls: "codex-turn-queue-resume",
      attr: {
        type: "button",
        title: "重试恢复本地生命周期记录",
        "aria-label": "重试恢复本地生命周期记录"
      }
    });
    setIcon(recover, "refresh-cw");
    recover.onclick = callbacks.onRecover;
  } else if (state.canResume) {
    const resume = header.createEl("button", {
      cls: "codex-turn-queue-resume",
      attr: { type: "button", title: "继续队列", "aria-label": "继续队列" }
    });
    setIcon(resume, "play");
    resume.onclick = callbacks.onResume;
  }

  if (state.items.length) {
    const list = container.createDiv({ cls: "codex-turn-queue-list" });
    state.items.forEach((item, index) =>
      renderQueuedTurnItem(list, item, index, state, callbacks)
    );
  }
}

export function piConversationRecoveryCandidate(
  support: Readonly<PiConversationSupportState> | null
): PiConversationDiagnostic | null {
  const sessionFile = support?.catalog.sessionFile;
  if (!support || !sessionFile) return null;
  return support.diagnostics
    .filter((diagnostic) =>
      diagnostic.code === "session_recovered_prefix"
      && diagnostic.sourcePath === sessionFile
      && Boolean(diagnostic.recoveryPath)
    )
    .sort((left, right) =>
      right.createdAt - left.createdAt
      || right.diagnosticId.localeCompare(left.diagnosticId)
    )[0] ?? null;
}

export function visiblePiConversationDiagnostics(
  support: Readonly<PiConversationSupportState> | null
): PiConversationDiagnostic[] {
  if (!support) return [];
  const sessionFile = support.catalog.sessionFile;
  return support.diagnostics
    .filter((diagnostic) => {
      if (diagnostic.code === "session_recovered_prefix") return false;
      if (
        diagnostic.code === "session_jsonl_malformed"
        || diagnostic.code === "session_jsonl_truncated"
      ) {
        return Boolean(sessionFile && diagnostic.sourcePath === sessionFile);
      }
      return true;
    })
    .sort((left, right) =>
      right.createdAt - left.createdAt
      || right.diagnosticId.localeCompare(left.diagnosticId)
    );
}

function renderPiConversationDiagnostics(
  container: HTMLElement,
  diagnostics: readonly PiConversationDiagnostic[],
  recovery: PiConversationDiagnostic | null,
  state: TurnQueueState,
  callbacks: TurnQueueCallbacks
): void {
  const panel = container.createDiv({
    cls: "codex-pi-support-panel codex-pi-diagnostic-panel"
  });
  const header = panel.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const icon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(icon, recovery ? "shield-alert" : "triangle-alert");
  title.createSpan({
    text: recovery ? "Pi 会话记录需要修复" : "Pi 会话诊断"
  });
  if (recovery?.recoveryPath) {
    const recover = header.createEl("button", {
      cls: "codex-pi-support-action",
      text: state.piRecoveryPending ? "正在恢复…" : "恢复可验证部分",
      attr: {
        type: "button",
        title: "保留原文件，并把当前会话改绑到最后一个可验证 Entry"
      }
    });
    recover.disabled = !state.canManagePiSupport || state.piRecoveryPending;
    recover.onclick = () => callbacks.onRecoverPiConversation(
      recovery.recoveryPath!
    );
  }
  const list = panel.createDiv({ cls: "codex-pi-diagnostic-list" });
  for (const diagnostic of diagnostics.slice(0, 3)) {
    const item = list.createDiv({ cls: "codex-pi-diagnostic-item" });
    item.createDiv({ cls: "codex-pi-diagnostic-message", text: diagnostic.message });
    if (diagnostic.sourcePath) {
      item.createDiv({
        cls: "codex-pi-diagnostic-path",
        text: diagnostic.sourcePath,
        attr: { title: diagnostic.sourcePath }
      });
    }
  }
}

function renderPiConversationDrafts(
  container: HTMLElement,
  state: TurnQueueState,
  callbacks: TurnQueueCallbacks
): void {
  const drafts = state.piSupport?.drafts ?? [];
  const panel = container.createDiv({
    cls: "codex-pi-support-panel codex-pi-draft-panel"
  });
  const header = panel.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const icon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(icon, "file-pen-line");
  title.createSpan({ text: `待确认草稿 · ${drafts.length}` });
  const list = panel.createDiv({ cls: "codex-turn-queue-list" });
  for (const draft of drafts) {
    const row = list.createDiv({
      cls: "codex-turn-queue-item codex-pi-draft-item"
    });
    const body = row.createDiv({ cls: "codex-turn-queue-body" });
    body.createDiv({ cls: "codex-turn-queue-preview", text: draft.text });
    body.createDiv({
      cls: "codex-turn-queue-meta",
      text: `${piDraftSourceLabel(draft.source)} · 尚未写入 Pi Session`
    });
    const edit = row.createEl("button", {
      cls: "codex-pi-support-action",
      text: "继续编辑",
      attr: { type: "button", title: "放回输入框，由你确认后重新发送" }
    });
    edit.disabled = !state.canManagePiSupport;
    edit.onclick = () => callbacks.onEditPiDraft(draft.draftId);
    const remove = row.createEl("button", {
      cls: "codex-turn-queue-remove",
      attr: { type: "button", title: "删除草稿", "aria-label": "删除草稿" }
    });
    remove.disabled = !state.canManagePiSupport;
    setIcon(remove, "x");
    remove.onclick = () => callbacks.onRemovePiDraft(draft.draftId);
  }
}

function piDraftSourceLabel(
  source: PiConversationSupportState["drafts"][number]["source"]
): string {
  if (source === "steering") return "未消费的调整方向";
  if (source === "follow_up") return "未消费的后续消息";
  if (source === "abort") return "停止时保留";
  return "重启后恢复";
}

export function renderComposerAttachments(container: HTMLElement, state: ComposerAttachmentsState, callbacks: ComposerAttachmentsCallbacks): void {
  container.empty();
  container.toggleClass("is-empty", !state.selectedSkill && state.attachments.length === 0);
  if (state.selectedSkill) {
    const chip = container.createDiv({ cls: "codex-skill-token" });
    const icon = chip.createSpan({ cls: "codex-skill-token-icon" });
    setIcon(icon, "box");
    chip.createSpan({ cls: "codex-skill-token-name", text: state.selectedSkill.name });
    const remove = chip.createEl("button", { attr: { type: "button", "aria-label": `移除 Skill：${state.selectedSkill.name}`, title: "移除 Skill" } });
    setIcon(remove, "x");
    remove.onclick = callbacks.onRemoveSkill;
  }
  for (const item of state.attachments) {
    const chip = container.createDiv({ cls: "codex-attachment-chip" });
    chip.createSpan({ text: item.name });
    const remove = chip.createEl("button", { text: "×", attr: { type: "button" } });
    remove.onclick = () => callbacks.onRemoveAttachment(item.path);
  }
}

export function labelFor(value: string): string {
  const labels: Record<string, string> = {
    low: "低思考",
    medium: "中思考",
    high: "高思考",
    xhigh: "超高思考",
    standard: "标准",
    fast: "快速",
    flex: "弹性",
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问权限",
    agent: "Agent",
    plan: "Plan",
    normal: "使用长期记忆",
    no_memory: "不使用长期 Memory"
  };
  return labels[value] ?? value;
}

export function compactReasoningLabel(value: ReasoningEffort): string {
  const labels: Record<string, string> = {
    none: "无",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高"
  };
  return labels[value] ?? value;
}

export function shortModelLabel(value: string): string {
  if (!value.trim()) return "自动";
  return value
    .replace(/^gpt-/i, "")
    .replace(/-/g, " ")
    .replace(/\bmini\b/i, "Mini")
    .replace(/\bhigh\b/i, "High")
    .trim();
}

export function compactBrandedModelLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "自动";

  const separated = trimmed.match(/^(?:deepseek|kimi|qwen|gpt)[\s_:/-]+(.+)$/i);
  if (separated?.[1]) return separated[1];

  const adjacentVersion = trimmed.match(/^(?:qwen|gpt)(\d.*)$/i);
  return adjacentVersion?.[1] ?? value;
}

function renderQueuedTurnItem(container: HTMLElement, item: QueuedTurnItem, index: number, state: TurnQueueState, callbacks: TurnQueueCallbacks): void {
  const row = container.createDiv({ cls: "codex-turn-queue-item", attr: { draggable: "true" } });
  row.dataset.queueItemId = item.id;
  const handle = row.createSpan({ cls: "codex-turn-queue-handle", attr: { "aria-hidden": "true" } });
  setIcon(handle, "grip-vertical");
  row.ondragstart = (event) => {
    event.stopPropagation();
    callbacks.onDragStart(item.id);
    event.dataTransfer?.setData("text/plain", item.id);
    event.dataTransfer?.setDragImage(row, 12, 12);
  };
  row.ondragend = callbacks.onDragEnd;
  row.ondragover = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.addClass("is-drag-over");
  };
  row.ondragleave = (event) => {
    event.stopPropagation();
    row.removeClass("is-drag-over");
  };
  row.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.removeClass("is-drag-over");
    const sourceId = event.dataTransfer?.getData("text/plain") || state.draggedItemId;
    if (!sourceId || sourceId === item.id) return;
    callbacks.onReorder(item.sessionId, sourceId, index);
  };

  const body = row.createDiv({ cls: "codex-turn-queue-body" });
  body.createDiv({ cls: "codex-turn-queue-preview", text: queuedTurnPreview(item) });
  body.createDiv({ cls: "codex-turn-queue-meta", text: queuedTurnMeta(item) });

  const remove = row.createEl("button", {
    cls: "codex-turn-queue-remove",
    attr: { type: "button", title: "删除队列项", "aria-label": "删除队列项" }
  });
  setIcon(remove, "x");
  remove.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks.onRemove(item.sessionId, item.id);
  };
}

function createComposerIconButton(container: HTMLElement, iconName: string, title: string): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: "codex-composer-icon-button",
    attr: { type: "button", "aria-label": title, title }
  });
  setIcon(button, iconName);
  return button;
}

function addModelButton(
  container: HTMLElement,
  ariaLabel: string,
  title: string,
  model: string,
  providerBrand: ProviderBrandId
): HTMLButtonElement {
  const fullModelName = model.trim() || "自动";
  const modelButton = container.createEl("button", {
    cls: "codex-composer-model-button codex-model-summary-button",
    attr: {
      type: "button",
      "aria-label": `${ariaLabel}：${fullModelName}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title
    }
  });
  const providerIcon = modelButton.createSpan({ cls: "codex-composer-model-icon" });
  renderProviderBrandIcon(providerIcon, providerBrand);
  modelButton.createSpan({ cls: "codex-composer-model-name", text: compactBrandedModelLabel(model) });
  const chevron = modelButton.createSpan({ cls: "codex-composer-chevron" });
  setIcon(chevron, "chevron-down");
  return modelButton;
}

function addComposerSelect<T extends string>(
  container: HTMLElement,
  iconName: string,
  values: T[],
  selected: T,
  onChange: (value: T) => void,
  label: string,
  extraClass = ""
): void {
  const selectedLabel = labelFor(selected);
  const accessibleLabel = `${label}：${selectedLabel}`;
  const control = container.createDiv({
    cls: `codex-composer-select ${extraClass}`.trim(),
    attr: { title: accessibleLabel }
  });
  control.dataset.value = selected;
  const icon = control.createSpan({ cls: "codex-composer-select-icon" });
  setIcon(icon, iconName);
  const select = control.createEl("select", {
    cls: "codex-select codex-composer-native-select",
    attr: { "aria-label": accessibleLabel, title: accessibleLabel }
  });
  for (const value of values) select.createEl("option", { text: labelFor(value), value });
  select.value = selected;
  select.onchange = () => onChange(select.value as T);
}

function addWorkspaceButton(container: HTMLElement, state: ComposerToolbarState, callbacks: ComposerToolbarCallbacks): void {
  const title = state.workspacePath
    ? `工作区：${state.workspacePath}${state.workspaceValid ? "" : "\n文件夹不存在，请重新选择"}`
    : "选择文件夹作为本会话工作区";
  const button = container.createEl("button", {
    cls: "codex-composer-model-button codex-workspace-button",
    attr: { type: "button", title, "aria-label": "选择工作区", "aria-haspopup": "menu" }
  });
  button.toggleClass("has-workspace", Boolean(state.workspacePath));
  button.toggleClass("is-invalid", Boolean(state.workspacePath && !state.workspaceValid));
  const icon = button.createSpan({ cls: "codex-composer-model-icon" });
  setIcon(icon, state.workspacePath ? "folder-open" : "folder");
  button.createSpan({ cls: "codex-composer-model-text", text: state.workspacePath ? state.workspaceDisplayName : "请选择文件夹" });
  const chevron = button.createSpan({ cls: "codex-composer-chevron" });
  setIcon(chevron, "chevron-down");
  button.onclick = (event) => callbacks.onOpenWorkspaceMenu(event, state.session);
}

function addPlanModeIndicator(container: HTMLElement): void {
  const indicator = container.createDiv({
    cls: "codex-composer-mode-indicator",
    attr: { "aria-label": "当前模式：计划", title: "当前模式：计划" }
  });
  const icon = indicator.createSpan({ cls: "codex-composer-mode-indicator-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, "list-todo");
  indicator.createSpan({ cls: "codex-composer-mode-indicator-label", text: "计划" });
}

function composerActionButtonView(action: ReturnType<typeof composerPrimaryActionForState>): { icon: string; label: string; title: string } {
  if (action === "enqueue") return { icon: "list-plus", label: "入队发送", title: "加入队列，当前任务结束后发送" };
  if (action === "resume-queue") return { icon: "play", label: "继续队列", title: "继续队列" };
  if (action === "stop-turn" || action === "cancel-knowledge-task") return { icon: "square", label: "停止", title: "停止当前任务" };
  return { icon: "send", label: "发送", title: "发送" };
}

function queuedTurnPreview(item: QueuedTurnItem): string {
  const text = item.text.trim() || (item.attachments.length ? "(附件)" : "");
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function queuedTurnMeta(item: QueuedTurnItem): string {
  const parts = [
    "对话",
    item.turnOptions.model ? shortModelLabel(item.turnOptions.model) : "自动",
    compactReasoningLabel(item.turnOptions.reasoning)
  ];
  if (item.skill) parts.push(`Skill ${item.skill.name}`);
  if (item.attachments.length) parts.push(`${item.attachments.length} 个附件`);
  return parts.join(" · ");
}
