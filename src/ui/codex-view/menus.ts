import { Menu, Notice, setIcon } from "obsidian";
import { filterSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { ReasoningEffort, UiMode } from "../../types/app-server";
import { knowledgeCommandOptions, type KnowledgeBaseCommandOption } from "../../knowledge-base/commands";
import { selectKnowledgeCommandItem, setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import { labelFor } from "./composer";
import { positionAnchoredMenu, positionSubmenu } from "./floating-menu-position";

export interface SkillMenuElements {
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
}

export interface SkillMenuState {
  skillsRequested: boolean;
}

export interface SkillMenuCallbacks {
  onSkillsRequested: () => void;
  onLoadSkills: () => Promise<EchoInkResource[]>;
  onRenderMatches: (skills?: EchoInkResource[]) => void;
}

export interface SkillMatchesState {
  skills: EchoInkResource[];
  selectedSkill: EchoInkResource | null;
}

export interface SkillMatchesCallbacks {
  onSelectSkill: (skill: EchoInkResource) => void;
}

export interface SlashMenuCallbacks extends SkillMatchesCallbacks {
  onFillCommand: (command: string) => void;
}

export interface AddMenuCallbacks {
  onAttachActiveFile: () => void;
  onPickFiles: (imagesOnly: boolean) => void;
  onToggleMcpPanel: () => void;
}

export interface WorkspaceMenuCallbacks {
  onChooseWorkspace: () => void;
  onRevealWorkspace: () => boolean;
  onClearWorkspace: () => void;
}

export interface ModelMenuState {
  providerModels: ComposerProviderModelOption[];
  selectedProviderSettingsId: string;
  selectedModel: string;
  selectedReasoning: ReasoningEffort | null;
  reasoningOptions: readonly Readonly<{
    effort: ReasoningEffort;
    label: string;
  }>[];
  selectedMode: UiMode;
}

export interface ComposerProviderModelOption {
  providerSettingsId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

export interface ModelMenuCallbacks {
  onSelectModel: (selection: Readonly<{
    providerSettingsId: string;
    modelId: string;
  }>) => void;
  onSelectReasoning: (reasoning: ReasoningEffort) => void;
  onSelectMode: (mode: UiMode) => void;
}

export interface SessionMenuCallbacks {
  onRename: () => void;
  onArchive: () => void;
  onResetCache: () => void;
  onDelete: () => void;
}

interface ComposerParameterOption {
  value: string;
  label: string;
  selected: boolean;
  group?: string;
  groupId?: string;
  providerSettingsId?: string;
}

interface ComposerParameterSection {
  id: string;
  icon: string;
  label: string;
  currentValue: string;
  options: ComposerParameterOption[];
  onSelect: (option: ComposerParameterOption) => void;
}

interface ActiveComposerParameterMenu {
  anchor: HTMLElement;
  root: HTMLElement;
  submenu: HTMLElement | null;
  activeTrigger: HTMLButtonElement | null;
  activeSectionId: string;
  cleanup: () => void;
  reposition: () => void;
}

let activeComposerParameterMenu: ActiveComposerParameterMenu | null = null;

export function openSkillMenu(event: MouseEvent, elements: SkillMenuElements, state: SkillMenuState, callbacks: SkillMenuCallbacks): void {
  event.preventDefault();
  event.stopPropagation();
  elements.knowledgeCommandMenuEl.removeClass("is-visible");
  if (elements.skillMenuEl.hasClass("is-visible")) {
    elements.skillMenuEl.removeClass("is-visible");
    return;
  }
  callbacks.onSkillsRequested();
  if (!state.skillsRequested) {
    elements.skillMenuEl.empty();
    elements.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "正在加载 skills..." });
    elements.skillMenuEl.addClass("is-visible");
  } else {
    callbacks.onRenderMatches();
  }
  void callbacks.onLoadSkills().then((skills) => callbacks.onRenderMatches(skills));
}

export function openAddMenu(event: MouseEvent, callbacks: AddMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("添加当前笔记（只作上下文）")
      .setIcon("file-text")
      .onClick(callbacks.onAttachActiveFile)
  );
  menu.addItem((item) =>
    item
      .setTitle("添加文件（只作上下文）")
      .setIcon("folder")
      .onClick(() => callbacks.onPickFiles(false))
  );
  menu.addItem((item) =>
    item
      .setTitle("添加图片")
      .setIcon("image")
      .onClick(() => callbacks.onPickFiles(true))
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle("MCP 状态")
      .setIcon("blocks")
      .onClick(callbacks.onToggleMcpPanel)
  );
  menu.showAtMouseEvent(event);
}

export function openWorkspaceMenu(event: MouseEvent, workspacePath: string, callbacks: WorkspaceMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  if (workspacePath) {
    menu.addItem((item) => item.setTitle(workspacePath).setIcon("folder-open").setIsLabel(true));
    menu.addSeparator();
  }
  menu.addItem((item) =>
    item
      .setTitle(workspacePath ? "更换工作区" : "选择工作区")
      .setIcon("folder-plus")
      .onClick(callbacks.onChooseWorkspace)
  );
  if (workspacePath) {
    menu.addItem((item) =>
      item
        .setTitle("在 Finder 显示")
        .setIcon("external-link")
        .onClick(() => {
          if (!callbacks.onRevealWorkspace()) new Notice("无法打开这个文件夹");
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("清除工作区")
        .setIcon("x")
        .onClick(callbacks.onClearWorkspace)
    );
  }
  menu.showAtMouseEvent(event);
}

export function openKnowledgeCommandMenu(event: MouseEvent, onFillCommand: (command: string) => void): void {
  event.preventDefault();
  const menu = new Menu();
  for (const command of knowledgeCommandOptions()) {
    menu.addItem((item) =>
      item
        .setTitle(command.title)
        .setIcon(command.icon)
        .onClick(() => onFillCommand(command.text))
    );
  }
  menu.showAtMouseEvent(event);
}

export function openModelMenu(event: MouseEvent, state: ModelMenuState, callbacks: ModelMenuCallbacks): void {
  openComposerParameterMenu(event, parameterSections(state, callbacks, true), "模型和运行参数");
}

export function closeComposerParameterMenu(): void {
  const active = activeComposerParameterMenu;
  if (!active) return;
  activeComposerParameterMenu = null;
  active.anchor.removeClass("is-open");
  active.anchor.setAttribute("aria-expanded", "false");
  active.submenu?.remove();
  active.root.remove();
  active.cleanup();
}

export function openSessionMenu(
  event: MouseEvent,
  callbacks: SessionMenuCallbacks
): void {
  event.preventDefault();
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("重命名会话")
      .setIcon("pencil")
      .onClick(callbacks.onRename)
  );
  menu.addItem((item) =>
    item
      .setTitle("归档会话")
      .setIcon("archive")
      .onClick(callbacks.onArchive)
  );
  menu.addItem((item) =>
    item
      .setTitle("重置 Agent 缓存")
      .setIcon("rotate-ccw")
      .onClick(callbacks.onResetCache)
  );
  menu.addItem((item) =>
    item
      .setTitle("删除会话")
      .setIcon("trash")
      .setWarning(true)
      .onClick(callbacks.onDelete)
  );
  menu.showAtMouseEvent(event);
}

export function renderSkillMatches(container: HTMLElement, query: string, state: SkillMatchesState, callbacks: SkillMatchesCallbacks): void {
  container.empty();
  const matches = filterSkillResources(state.skills, query);
  for (const skill of matches) {
    const item = container.createDiv({ cls: "codex-skill-item" });
    item.toggleClass("is-selected", state.selectedSkill?.id === skill.id);
    const heading = item.createDiv({ cls: "codex-skill-heading" });
    const icon = heading.createSpan({ cls: "codex-skill-icon" });
    setIcon(icon, "box");
    heading.createDiv({ cls: "codex-skill-name", text: skill.name });
    item.createDiv({ cls: "codex-skill-desc", text: skill.description || skill.contentPath || skill.source });
    item.onclick = () => callbacks.onSelectSkill(skill);
  }
  if (matches.length === 0) container.createDiv({ cls: "codex-skill-empty", text: "没有匹配的 skill" });
  container.addClass("is-visible");
}

export function renderKnowledgeCommandMatches(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  query: string,
  state: SkillMatchesState,
  callbacks: SlashMenuCallbacks
): void {
  container.empty();
  const commands = knowledgeCommandOptions(query);
  const skills = filterSkillResources(state.skills, query);
  let index = 0;
  for (const command of commands) {
    container.appendChild(createKnowledgeCommandItem(container, input, command, index++, callbacks.onFillCommand));
  }
  for (const skill of skills) {
    container.appendChild(createSlashSkillItem(container, input, skill, index++, state.selectedSkill?.id === skill.id, callbacks.onSelectSkill));
  }
  if (index === 0) container.createDiv({ cls: "codex-skill-empty", text: "没有匹配的命令或已启用 Skill" });
  container.scrollTop = 0;
  setKnowledgeCommandMenuOpen(input, container, true);
  selectKnowledgeCommandItem(input, container, index > 0 ? 0 : -1);
}

function parameterSections(
  state: ModelMenuState,
  callbacks: ModelMenuCallbacks,
  includeRuntimeOptions: boolean
): ComposerParameterSection[] {
  const selectedModel = state.providerModels.find((model) =>
    model.providerSettingsId === state.selectedProviderSettingsId
    && model.modelId === state.selectedModel
  );
  const sections: ComposerParameterSection[] = [{
      id: "model",
      icon: "box",
      label: "模型",
      currentValue: selectedModel?.modelName || state.selectedModel || "未选择",
      options: state.providerModels.map((model) => ({
        value: model.modelId,
        label: model.modelName,
        selected: model.providerSettingsId === state.selectedProviderSettingsId
          && model.modelId === state.selectedModel,
        group: model.providerName,
        groupId: model.providerSettingsId,
        providerSettingsId: model.providerSettingsId
      })),
      onSelect: (option) => {
        if (!option.providerSettingsId) return;
        callbacks.onSelectModel({
          providerSettingsId: option.providerSettingsId,
          modelId: option.value
        });
      }
    }];
  if (state.reasoningOptions.length > 0) {
    sections.push({
      id: "reasoning",
      icon: "brain",
      label: "思考强度",
      currentValue: state.reasoningOptions.find(
        (option) => option.effort === state.selectedReasoning
      )?.label ?? "未选择",
      options: state.reasoningOptions.map((option) => ({
        value: option.effort,
        label: option.label,
        selected: state.selectedReasoning === option.effort
      })),
      onSelect: (option) => callbacks.onSelectReasoning(option.value as ReasoningEffort)
    });
  }
  if (!includeRuntimeOptions) return sections;

  sections.push({
      id: "mode",
      icon: "route",
      label: "模式",
      currentValue: labelFor(state.selectedMode),
      options: (["agent", "plan"] as UiMode[]).map((mode) => ({
        value: mode,
        label: labelFor(mode),
        selected: state.selectedMode === mode
      })),
      onSelect: (option) => callbacks.onSelectMode(option.value as UiMode)
    });
  return sections;
}

function openComposerParameterMenu(event: MouseEvent, sections: ComposerParameterSection[], ariaLabel: string): void {
  event.preventDefault();
  event.stopPropagation();
  const anchor = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!anchor) return;
  if (activeComposerParameterMenu?.anchor === anchor) {
    closeComposerParameterMenu();
    return;
  }
  closeComposerParameterMenu();

  const doc = anchor.ownerDocument;
  const view = doc.defaultView ?? window;
  const root = doc.createElement("div");
  root.className = "codex-composer-parameter-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", ariaLabel);
  root.setCssStyles({ visibility: "hidden" });
  doc.body.appendChild(root);

  const active: ActiveComposerParameterMenu = {
    anchor,
    root,
    submenu: null,
    activeTrigger: null,
    activeSectionId: "",
    cleanup: () => undefined,
    reposition: () => undefined
  };
  activeComposerParameterMenu = active;
  anchor.addClass("is-open");
  anchor.setAttribute("aria-expanded", "true");

  for (const section of sections) {
    const trigger = createParameterTrigger(root, section);
    trigger.onmouseenter = () => openParameterSubmenu(active, section, trigger, false);
    trigger.onclick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      openParameterSubmenu(active, section, trigger, true);
    };
    trigger.onkeydown = (keyEvent) => {
      if (keyEvent.key !== "ArrowRight" && keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
      keyEvent.preventDefault();
      openParameterSubmenu(active, section, trigger, true);
    };
  }

  const reposition = () => {
    if (!anchor.isConnected) {
      closeComposerParameterMenu();
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const placement = positionAnchoredMenu(anchorRect, rootRect, viewport);
    root.setCssStyles({
      left: `${placement.left}px`,
      top: `${placement.top}px`
    });
    root.dataset.verticalSide = placement.verticalSide;
    root.setCssStyles({ visibility: "visible" });
    positionActiveSubmenu(active);
  };
  active.reposition = reposition;

  const onPointerDown = (pointerEvent: PointerEvent) => {
    const target = pointerEvent.target instanceof Node ? pointerEvent.target : null;
    if (!target || root.contains(target) || active.submenu?.contains(target) || anchor.contains(target)) return;
    closeComposerParameterMenu();
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    if (active.submenu) {
      active.submenu.remove();
      active.submenu = null;
      active.activeSectionId = "";
      active.activeTrigger?.removeClass("is-open");
      active.activeTrigger?.setAttribute("aria-expanded", "false");
      active.activeTrigger?.focus();
      active.activeTrigger = null;
      return;
    }
    closeComposerParameterMenu();
    anchor.focus();
  };
  const observer = new MutationObserver(() => {
    if (!anchor.isConnected) closeComposerParameterMenu();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", reposition, true);
  view.addEventListener("resize", reposition);
  active.cleanup = () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", reposition, true);
    view.removeEventListener("resize", reposition);
  };

  reposition();
  root.querySelector<HTMLButtonElement>("button")?.focus();
}

function createParameterTrigger(container: HTMLElement, section: ComposerParameterSection): HTMLButtonElement {
  const trigger = container.createEl("button", {
    cls: "codex-parameter-menu-item codex-parameter-menu-trigger",
    attr: {
      type: "button",
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false"
    }
  });
  const icon = trigger.createSpan({ cls: "codex-parameter-menu-icon" });
  setIcon(icon, section.icon);
  trigger.createSpan({ cls: "codex-parameter-menu-label", text: section.label });
  trigger.createSpan({ cls: "codex-parameter-menu-value", text: section.currentValue });
  const chevron = trigger.createSpan({ cls: "codex-parameter-menu-chevron" });
  setIcon(chevron, "chevron-right");
  return trigger;
}

function openParameterSubmenu(
  active: ActiveComposerParameterMenu,
  section: ComposerParameterSection,
  trigger: HTMLButtonElement,
  focusFirstOption: boolean
): void {
  if (activeComposerParameterMenu !== active) return;
  if (active.activeSectionId === section.id && active.submenu) {
    if (focusFirstOption) active.submenu.querySelector<HTMLButtonElement>("button")?.focus();
    return;
  }

  active.activeTrigger?.removeClass("is-open");
  active.activeTrigger?.setAttribute("aria-expanded", "false");
  active.submenu?.remove();
  active.activeTrigger = trigger;
  active.activeSectionId = section.id;
  trigger.addClass("is-open");
  trigger.setAttribute("aria-expanded", "true");

  const panel = active.root.ownerDocument.createElement("div");
  panel.className = "codex-composer-parameter-submenu";
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", section.label);
  panel.setCssStyles({ visibility: "hidden" });
  panel.createDiv({ cls: "codex-parameter-submenu-title", text: section.label });
  let previousGroupId = "";
  for (const option of section.options) {
    if (option.group && option.groupId !== previousGroupId) {
      panel.createDiv({
        cls: "codex-parameter-option-group",
        text: option.group,
        attr: { role: "presentation" }
      });
      previousGroupId = option.groupId ?? option.group;
    }
    const button = panel.createEl("button", {
      cls: `codex-parameter-menu-item codex-parameter-option${option.selected ? " is-selected" : ""}`,
      attr: {
        type: "button",
        role: "menuitemradio",
        "aria-checked": String(option.selected)
      }
    });
    button.createSpan({ cls: "codex-parameter-option-label", text: option.label });
    const check = button.createSpan({ cls: "codex-parameter-option-check" });
    if (option.selected) setIcon(check, "check");
    button.onclick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeComposerParameterMenu();
      section.onSelect(option);
    };
  }
  panel.onkeydown = (keyEvent) => {
    if (keyEvent.key !== "ArrowLeft") return;
    keyEvent.preventDefault();
    panel.remove();
    active.submenu = null;
    active.activeSectionId = "";
    trigger.removeClass("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  };
  active.root.ownerDocument.body.appendChild(panel);
  active.submenu = panel;
  positionActiveSubmenu(active);
  if (focusFirstOption) panel.querySelector<HTMLButtonElement>("button")?.focus();
}

function positionActiveSubmenu(active: ActiveComposerParameterMenu): void {
  if (!active.submenu || !active.activeTrigger) return;
  const doc = active.root.ownerDocument;
  const triggerRect = active.activeTrigger.getBoundingClientRect();
  const rootRect = active.root.getBoundingClientRect();
  const panelRect = active.submenu.getBoundingClientRect();
  const viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  const placement = positionSubmenu(triggerRect, rootRect, panelRect, viewport);
  active.submenu.setCssStyles({
    left: `${placement.left}px`,
    top: `${placement.top}px`
  });
  active.submenu.dataset.horizontalSide = placement.horizontalSide;
  active.submenu.setCssStyles({ visibility: "visible" });
}

function createKnowledgeCommandItem(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  command: KnowledgeBaseCommandOption,
  index: number,
  onFillCommand: (command: string) => void
): HTMLElement {
  const item = document.createElement("button");
  item.setAttribute("type", "button");
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");
  item.id = `${container.id}-option-${index}`;
  item.addClass("codex-command-item");
  const icon = item.createSpan({ cls: "codex-command-icon" });
  setIcon(icon, command.icon);
  const body = item.createDiv({ cls: "codex-command-body" });
  const heading = body.createDiv({ cls: "codex-command-heading" });
  heading.createSpan({ cls: "codex-command-text", text: command.text.trim() });
  heading.createSpan({ cls: "codex-command-title", text: command.title });
  body.createDiv({ cls: "codex-command-desc", text: command.description });
  item.onmouseenter = () => selectKnowledgeCommandItem(input, container, index);
  item.onmousedown = (event) => event.preventDefault();
  item.onclick = () => onFillCommand(command.text);
  return item;
}

function createSlashSkillItem(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  skill: EchoInkResource,
  index: number,
  selected: boolean,
  onSelectSkill: (skill: EchoInkResource) => void
): HTMLElement {
  const item = document.createElement("button");
  item.setAttribute("type", "button");
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", String(selected));
  item.id = `${container.id}-option-${index}`;
  item.addClass("codex-command-item", "codex-command-skill");
  item.toggleClass("is-current", selected);
  const icon = item.createSpan({ cls: "codex-command-icon" });
  setIcon(icon, "box");
  const body = item.createDiv({ cls: "codex-command-body" });
  body.createSpan({ cls: "codex-command-text", text: skill.name });
  body.createSpan({
    cls: "codex-command-desc",
    text: skill.description || skill.contentPath || "已启用 Skill"
  });
  item.createSpan({ cls: "codex-command-shortcut", text: selected ? "已选择" : "↵" });
  item.onmouseenter = () => selectKnowledgeCommandItem(input, container, index);
  item.onmousedown = (event) => event.preventDefault();
  item.onclick = () => onSelectSkill(skill);
  return item;
}
