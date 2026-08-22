import type { Component } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import { shouldCloseComposerMenusForClick } from "../composer-menu";
import { renderComposerShell } from "./composer";
import { renderCodexHeader } from "./header";

export interface CodexViewShellHost extends Component {
  readonly contentEl: HTMLElement;
  readonly plugin: CodexForObsidianPlugin;
  rootEl: HTMLElement;
  tabBarEl: HTMLElement;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  workspaceEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  resourcePanelEl: HTMLElement;
  resourcePanelAnchorEl: HTMLButtonElement;
  resourcePanelOpen: boolean;
  contextPanelEl: HTMLElement | null;
  toolbarEl: HTMLElement;
  mcpPanelEl: HTMLElement;
  messageScrollFollow: {
    handleWheel(event: WheelEvent): void;
    handleTouchStart(event: TouchEvent): void;
    handleTouchMove(event: TouchEvent): void;
  };
  ensureSession(): StoredSession;
  openPluginSettings(): void;
  closeComposerMenus(): void;
  handleMessagesScroll(): void;
  onInputChanged(): void;
  handlePastedFiles(event: ClipboardEvent): Promise<void>;
  sendMessage(): Promise<void>;
  handleDroppedFiles(event: DragEvent): void;
  renderToolbar(): void;
  updateInputPlaceholder(): void;
}

export function renderViewShell(host: CodexViewShellHost): void {
  host.contentEl.empty();
  host.rootEl = host.contentEl.createDiv({ cls: "codex-container" });

  renderCodexHeader(host.rootEl, {
    onOpenWorkspaceResources: () => void host.plugin.openWorkspaceResourceSettings("plugins"),
    onOpenSettings: () => {
      void host.plugin.handleEchoInkOnboardingTargetActivated("settings")
        .then((handled) => {
          if (!handled) host.openPluginSettings();
        })
        .catch(() => host.openPluginSettings());
    }
  });
  host.registerDomEvent(document, "click", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target) return;
    if (host.contextPanelEl?.contains(target)) return;
    if (shouldCloseComposerMenusForClick(target, host.rootEl, [
      host.skillMenuEl,
      host.knowledgeCommandMenuEl,
      host.resourcePanelEl,
      host.resourcePanelAnchorEl
    ])) host.closeComposerMenus();
  });

  host.tabBarEl = host.rootEl.createDiv({ cls: "codex-tabs" });
  host.messagesEl = host.rootEl.createDiv({ cls: "codex-messages" });
  host.virtualListEl = host.messagesEl.createDiv({ cls: "codex-virtual-list" });
  host.registerDomEvent(host.messagesEl, "wheel", (event) => host.messageScrollFollow.handleWheel(event as WheelEvent));
  host.registerDomEvent(host.messagesEl, "touchstart", (event) => host.messageScrollFollow.handleTouchStart(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "touchmove", (event) => host.messageScrollFollow.handleTouchMove(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "scroll", () => host.handleMessagesScroll());
  const composerRefs = renderComposerShell(host.rootEl, {
    onInputChanged: () => host.onInputChanged(),
    onPasteFiles: (event) => void host.handlePastedFiles(event),
    onSendMessage: () => void host.sendMessage(),
    onDropFiles: (event) => host.handleDroppedFiles(event)
  });
  host.queueEl = composerRefs.queueEl;
  host.attachmentsEl = composerRefs.attachmentsEl;
  host.workspaceEl = composerRefs.workspaceEl;
  host.inputEl = composerRefs.inputEl;
  host.promptEnhanceReviewEl = composerRefs.promptEnhanceReviewEl;
  host.skillMenuEl = composerRefs.skillMenuEl;
  host.knowledgeCommandMenuEl = composerRefs.knowledgeCommandMenuEl;
  host.resourcePanelEl = composerRefs.resourcePanelEl;
  host.resourcePanelOpen = false;
  host.toolbarEl = composerRefs.toolbarEl;
  host.mcpPanelEl = host.rootEl.createDiv({ cls: "codex-mcp-panel" });
  host.renderToolbar();
  host.updateInputPlaceholder();
}
