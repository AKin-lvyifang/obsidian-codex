import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderComposerToolbar, type ComposerToolbarCallbacks, type ComposerToolbarState } from "../ui/codex-view/composer";

export async function runComposerActionTests(): Promise<void> {
  const originalDocument = globalThis.document;
  const testDocument = new ComposerTestDocument();
  (globalThis as unknown as { document: Document }).document = testDocument as unknown as Document;
  try {
    const send = renderAction();
    assert.equal(send.primary.getAttribute("aria-label"), "发送");
    assert.equal(send.primary.hasClass("is-send-action"), true);
    assert.equal(send.primary.querySelectorAll(".echoink-animate-icon-send").length, 1);
    assert.equal(
      send.primary.querySelector("path")?.getAttribute("d"),
      "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
    );
    send.primary.click();
    assert.equal(send.calls.send, 1, "ordinary send keeps onSendMessage");
    send.mic.click();
    assert.equal(send.calls.mic, 1, "Mic keeps onMicInput");
    assert.equal(send.mic.getAttribute("aria-label"), "语音输入");
    assert.equal(send.mic.querySelectorAll(".echoink-animate-icon-mic").length, 1);
    assert.equal(send.mic.querySelector("rect")?.getAttribute("rx"), "3");

    const enqueue = renderAction({ running: true, hasDraft: true });
    assert.equal(enqueue.primary.hasClass("is-queue-action"), true);
    assert.equal(enqueue.primary.querySelector(".echoink-animate-icon-send"), null);
    enqueue.primary.click();
    assert.equal(enqueue.calls.enqueue, 1);

    const stop = renderAction({ running: true, hasDraft: false });
    assert.equal(stop.primary.hasClass("is-stop-action"), true);
    stop.primary.click();
    assert.equal(stop.calls.stop, 1);

    const resume = renderAction({ hasQueuedItems: true, hasDraft: false });
    assert.equal(resume.primary.getAttribute("aria-label"), "继续队列");
    resume.primary.click();
    assert.equal(resume.calls.resume, 1);

    const cancelKnowledge = renderAction({ knowledgeTaskRunning: true });
    cancelKnowledge.primary.click();
    assert.equal(cancelKnowledge.calls.cancelKnowledge, 1);

    const disabled = renderAction({ promptEnhancerRunning: true });
    assert.equal(disabled.primary.disabled, true);
    assert.equal(disabled.primary.getAttribute("aria-label"), "提示词增强中");

    const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
    const iconSource = readFileSync("src/ui/animate-icon.ts", "utf8");
    const css = readFileSync("styles.css", "utf8");
    assert.doesNotMatch(composerSource, /send-horizontal/u);
    assert.match(iconSource, /M19 10v2a7 7 0 0 1-14 0v-2/u);
    assert.match(css, /@keyframes echoink-animate-send/u);
    assert.match(css, /@keyframes echoink-animate-mic/u);
    assert.match(css, /prefers-reduced-motion:\s*reduce/u);
    console.log("PASS conversation-ui: Animate Icons Send/Mic preserve composer action semantics");
  } finally {
    (globalThis as unknown as { document?: Document }).document = originalDocument;
  }
}

function renderAction(overrides: Partial<ComposerToolbarState> = {}) {
  const calls = { send: 0, mic: 0, enqueue: 0, stop: 0, resume: 0, cancelKnowledge: 0 };
  const callbacks: ComposerToolbarCallbacks = {
    onOpenAddMenu: () => undefined,
    onEnhancePrompt: () => undefined,
    onCaptureKnowledgeSource: () => undefined,
    onPermissionChange: () => undefined,
    onOpenWorkspaceMenu: () => undefined,
    onOpenModelMenu: () => undefined,
    onToggleContextPanel: () => undefined,
    onMicInput: () => { calls.mic += 1; },
    onCancelKnowledgeTask: () => { calls.cancelKnowledge += 1; },
    onStopTurn: () => { calls.stop += 1; },
    onSteerPiChat: () => undefined,
    onEnqueueDraft: () => { calls.enqueue += 1; },
    onResumeQueue: () => { calls.resume += 1; },
    onSendMessage: () => { calls.send += 1; }
  };
  const state: ComposerToolbarState = {
    session: { id: "session-test" } as never,
    knowledgeTaskRunning: false,
    selectedSkill: null,
    selectedPermission: "workspace-write",
    selectedMode: "agent",
    running: false,
    promptEnhancerRunning: false,
    viewRunKind: "",
    activeRunSessionId: "",
    hasDraft: false,
    hasTextDraft: false,
    hasQueuedItems: false,
    currentComposerModel: "deepseek-chat",
    currentComposerProviderBrand: "custom",
    currentComposerSummaryTitle: "模型",
    workspacePath: "",
    workspaceDisplayName: "",
    workspaceValid: true,
    contextPanelOpen: false,
    ...overrides
  };
  const container = new ComposerTestElement("div");
  const workspace = new ComposerTestElement("div");
  renderComposerToolbar(container as unknown as HTMLElement, workspace as unknown as HTMLElement, state, callbacks);
  return {
    calls,
    primary: container.querySelector(".codex-composer-send-button")!,
    mic: container.querySelector(".codex-composer-mic-button")!
  };
}

class ComposerTestDocument {
  createElement(tagName: string): ComposerTestElement {
    return new ComposerTestElement(tagName);
  }
  createElementNS(_namespace: string, tagName: string): ComposerTestElement {
    return new ComposerTestElement(tagName);
  }
}

class ComposerTestElement {
  readonly children: ComposerTestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: () => undefined };
  readonly classList = {
    add: (...classNames: string[]) => this.addClass(...classNames),
    remove: (...classNames: string[]) => this.removeClass(...classNames)
  };
  className = "";
  disabled = false;
  value = "";
  onclick: ((event?: unknown) => void) | null = null;
  onchange: (() => void) | null = null;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  empty(): void { this.children.length = 0; }
  append(...children: ComposerTestElement[]): void { this.children.push(...children); }
  replaceChildren(...children: ComposerTestElement[]): void { this.empty(); this.append(...children); }
  createDiv(options: Record<string, unknown> = {}): ComposerTestElement { return this.createEl("div", options); }
  createSpan(options: Record<string, unknown> = {}): ComposerTestElement { return this.createEl("span", options); }
  createEl(tagName: string, options: Record<string, any> = {}): ComposerTestElement {
    const element = new ComposerTestElement(tagName);
    if (options.cls) element.className = String(options.cls);
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
    this.append(element);
    return element;
  }
  addClass(...classNames: string[]): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    for (const className of classNames) classes.add(className);
    this.className = [...classes].join(" ");
  }
  removeClass(...classNames: string[]): void {
    const remove = new Set(classNames);
    this.className = this.className.split(/\s+/u).filter((name) => name && !remove.has(name)).join(" ");
  }
  toggleClass(className: string, enabled: boolean): void {
    if (enabled) this.addClass(className); else this.removeClass(className);
  }
  hasClass(className: string): boolean { return this.className.split(/\s+/u).includes(className); }
  setAttr(name: string, value: string): void { this.setAttribute(name, value); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null { return name === "class" ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  querySelector(selector: string): ComposerTestElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): ComposerTestElement[] {
    const matches: ComposerTestElement[] = [];
    const visit = (node: ComposerTestElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  matches(selector: string): boolean {
    const tag = selector.match(/^[a-z][a-z0-9-]*/iu)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const className of selector.matchAll(/\.([a-z0-9_-]+)/giu)) {
      if (!this.hasClass(className[1])) return false;
    }
    return Boolean(tag || selector.includes("."));
  }
  click(): void { if (!this.disabled) this.onclick?.({}); }
}
