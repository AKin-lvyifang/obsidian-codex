import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TFile } from "obsidian";
import type { ChatMessage, SettingsLanguage } from "../settings/settings";
import { settingsCopy } from "../settings/i18n";
import { extractProcessFileRefs, stableHashedIdentity } from "../core/mapping";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import { PiTurnInteractionBroker } from "../plugin/pi-turn-interaction-broker";
import { renderRichText } from "../ui/render-message";
import {
  CodexMessageListRenderer,
  nextReasoningDisclosureState
} from "../ui/codex-view/message-list";
import { buildAgentTurnProjection } from "../ui/codex-view/agent-turn-process";
import { buildActionTimeline } from "../ui/codex-view/action-timeline";
import {
  createAIElementsDocumentSources,
  createSmoothAIArtifact,
  createSmoothAIReasoning,
  markSmoothAITaskList,
  markSmoothAIToolCall,
  renderSmoothBlurOutUp,
  SMOOTH_BLUR_OUT_UP_DURATION_MS,
  SMOOTH_BLUR_OUT_UP_EASING,
  SMOOTH_BLUR_OUT_UP_STAGGER_MS
} from "../ui/codex-view/smooth-chat-ui";
import {
  TASK_PLAN_DOCK_CLOSEOUT_MS,
  TaskPlanDockController,
  selectTaskPlanForDock,
  type TaskPlanDockClock
} from "../ui/codex-view/task-plan-dock";
import type { EchoInkTaskPlanSnapshot } from "../types/task-plan";
import type { EchoInkQuestionInteraction } from "../types/conversation-turn";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";

type TestEventHandler = (event: {
  preventDefault(): void;
  stopPropagation(): void;
}) => unknown;

interface TestActivationEvent {
  readonly isTrusted: boolean;
  readonly key?: string;
  readonly code?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestEventHandler>();
  children: FakeElement[] = [];
  content: Array<string | FakeElement> = [];
  className = "";
  clientHeight = 640;
  clientWidth = 420;
  checked = false;
  disabled = false;
  focused = false;
  id = "";
  open = false;
  parent: FakeElement | null = null;
  scrollHeight = 640;
  scrollTop = 0;
  src = "";
  textContent = "";
  value = "";
  onclick: ((event: TestActivationEvent) => unknown) | null = null;
  onchange: (() => unknown) | null = null;
  oninput: (() => unknown) | null = null;
  onkeydown: ((event: TestActivationEvent) => unknown) | null = null;
  ontoggle: ((event: { readonly isTrusted: boolean }) => unknown) | null = null;

  constructor(readonly tag: string) {}

  get childElementCount(): number {
    return this.children.length;
  }

  createEl(
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {}
  ): FakeElement {
    const child = new FakeElement(tag);
    child.parent = this;
    if (options.cls) child.className = options.cls;
    if (options.text !== undefined) {
      child.textContent = options.text;
      child.content.push(options.text);
    }
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, value);
    }
    this.children.push(child);
    this.content.push(child);
    return child;
  }

  createDiv(options: { cls?: string; text?: string; attr?: Record<string, string> } | string = {}): FakeElement {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: { cls?: string; text?: string; attr?: Record<string, string> } | string = {}): FakeElement {
    return this.createEl("span", typeof options === "string" ? { cls: options } : options);
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (!(node instanceof FakeElement)) continue;
      node.parent = this;
      this.children.push(node);
      this.content.push(node);
    }
  }

  appendText(text: string): void {
    this.textContent += text;
    this.content.push(text);
  }

  empty(): void {
    this.children = [];
    this.content = [];
    this.textContent = "";
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent.content = this.parent.content.filter((item) => item !== this);
    this.parent = null;
  }

  setText(text: string): void {
    this.children = [];
    this.content = [text];
    this.textContent = text;
  }

  addClass(cls: string): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    classes.add(cls);
    this.className = [...classes].join(" ");
  }

  removeClass(cls: string): void {
    this.className = this.className
      .split(/\s+/u)
      .filter((candidate) => candidate && candidate !== cls)
      .join(" ");
  }

  hasClass(cls: string): boolean {
    return this.className.split(/\s+/u).includes(cls);
  }

  toggleClass(cls: string, enabled: boolean): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    if (enabled) classes.add(cls);
    else classes.delete(cls);
    this.className = [...classes].join(" ");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "id") this.id = "";
  }

  querySelector<T = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T = FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches as unknown as T[];
  }

  closest<T = FakeElement>(selector: string): T | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matchesSelector(selector)) return current as unknown as T;
      current = current.parent;
    }
    return null;
  }

  focus(): void {
    this.focused = true;
  }

  setCssStyles(_styles: Record<string, string>): void {}

  getBoundingClientRect(): { height: number } {
    return { height: 0 };
  }

  findByClass(cls: string): FakeElement | null {
    return this.findAllByClass(cls)[0] ?? null;
  }

  findAllByClass(cls: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.className.split(/\s+/u).includes(cls)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  findAllByTag(tag: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.tag === tag) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  private matchesSelector(selector: string): boolean {
    if (selector.startsWith(".")) return this.hasClass(selector.slice(1));
    if (selector.startsWith("#")) {
      const expected = selector.slice(1);
      return this.id === expected || this.attributes.get("id") === expected;
    }
    return this.tag === selector.toLowerCase();
  }
}

function renderedText(element: FakeElement): string {
  return element.content
    .map((item) => typeof item === "string" ? item : renderedText(item))
    .join("");
}

interface TestContext {
  app: unknown;
  component: unknown;
  openedPaths: string[];
}

function createTestContext(): TestContext {
  const files = new Map([
    ["projects/Alpha.md", new TFile("projects/Alpha.md")],
    ["outputs/Result.md", new TFile("outputs/Result.md")],
    ["images/cover #1.png", new TFile("images/cover #1.png")]
  ]);
  const openedPaths: string[] = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => "/test-vault" },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getResourcePath: (file: TFile) => `app://echoink-vault/${file.path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`
    },
    metadataCache: {
      getFirstLinkpathDest: () => null
    },
    workspace: {
      getLeaf: (kind: string) => {
        assert.equal(kind, "tab", "note links must use Obsidian internal tab navigation");
        return {
          view: {},
          openFile: async (file: TFile) => {
            openedPaths.push(file.path);
          }
        };
      }
    }
  };
  const component = {
    registerDomEvent: (
      element: FakeElement,
      eventName: string,
      handler: TestEventHandler
    ) => {
      element.listeners.set(eventName, handler);
    }
  };
  return { app, component, openedPaths };
}

function bindRenderer(
  renderer: CodexMessageListRenderer,
  context: TestContext,
  settingsLanguage: SettingsLanguage = "zh-CN"
): void {
  (renderer as unknown as { env: unknown }).env = {
    app: context.app,
    component: context.component,
    messagesEl: new FakeElement("div"),
    virtualListEl: new FakeElement("div"),
    sessionId: "smooth-ui-test",
    welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
    settingsLanguage,
    messages: [],
    vaultPath: "/test-vault",
    readRawMessageText: async () => "",
    onDerivePiConversation: async () => undefined,
    onScheduleMeasure: () => undefined,
    onScheduleRunProgress: () => undefined,
    options: {}
  };
}

function renderMessage(
  renderer: CodexMessageListRenderer,
  message: ChatMessage,
  options: {
    showAgentFooter: boolean;
    showAgentHeader: boolean;
    processExpanded?: boolean;
  }
): FakeElement {
  const container = new FakeElement("div");
  (renderer as unknown as {
    renderMessage(container: unknown, message: ChatMessage, options: unknown): void;
  }).renderMessage(container, message, options);
  return container;
}

async function clickRegistered(element: FakeElement): Promise<void> {
  const handler = element.listeners.get("click");
  assert.ok(handler, "note link must register a click handler");
  await handler!({ preventDefault: () => undefined, stopPropagation: () => undefined });
}

function clickElement(element: FakeElement): void {
  element.onclick?.({
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as never);
}

async function assertInteractionDockContracts(): Promise<void> {
  const controller = new InteractionDockController();
  const container = new FakeElement("div");
  const questionBroker = new PiTurnInteractionBroker();
  const interaction: EchoInkQuestionInteraction = {
    kind: "question",
    interactionId: "question-interaction",
    conversationId: "conversation-question",
    piSessionId: "pi-question",
    turnId: "turn-question",
    status: "pending",
    questions: [{
      questionId: "approach",
      prompt: "采用哪种方案？",
      selection: "single",
      options: [{ optionId: "simple", label: "简单方案" }, {
        optionId: "extended",
        label: "扩展方案"
      }],
      allowSupplement: false
    }, {
      questionId: "evidence",
      prompt: "需要哪些验收证据？",
      selection: "multiple",
      options: [{ optionId: "ui", label: "界面" }, {
        optionId: "provider",
        label: "Provider"
      }],
      allowSupplement: true
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const answerPromise = questionBroker.waitForAnswers({
    conversationId: interaction.conversationId,
    piSessionId: interaction.piSessionId,
    productRunId: interaction.turnId,
    interactionId: interaction.interactionId,
    interaction
  });
  const questionBinding = questionBroker.bindingFor({
    conversationId: interaction.conversationId,
    piSessionId: interaction.piSessionId,
    productRunId: interaction.turnId,
    interactionId: interaction.interactionId
  });
  assert.ok(questionBinding);
  let questionResolved = 0;
  const questionInput = {
    question: {
      binding: questionBinding!,
      onResolved: () => { questionResolved += 1; }
    },
    onStale: () => assert.fail("a live Question binding must not go stale"),
    onScheduleMeasure: () => undefined
  } as const;

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-a",
    ...questionInput
  });
  assert.equal(container.hasClass("is-visible"), true);
  assert.equal(
    container.findByClass("codex-ai-elements-question")?.attributes.get("data-ai-elements-pattern"),
    "question"
  );
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "1/2");
  const firstSessionControls = container.findAllByClass("codex-interaction-option-control");
  firstSessionControls[0]!.checked = true;
  firstSessionControls[0]!.onchange?.();
  clickElement(container.findByClass("codex-interaction-action")!);
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "2/2");

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-b",
    ...questionInput
  });
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "1/2");
  assert.equal(
    container.findAllByClass("codex-interaction-option-control").some((control) => control.checked),
    false,
    "Question drafts are isolated by UI session"
  );

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-a",
    ...questionInput
  });
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "2/2");
  const secondQuestionControls = container.findAllByClass("codex-interaction-option-control");
  secondQuestionControls[1]!.checked = true;
  secondQuestionControls[1]!.onchange?.();
  const supplement = container.findByClass("codex-interaction-supplement-input")!;
  supplement.value = "保留真实 Provider 证据";
  supplement.oninput?.();
  const submit = container.findAllByClass("codex-interaction-action").at(-1)!;
  clickElement(submit);
  clickElement(submit);
  assert.equal(questionResolved, 1, "Question resolves exactly once");
  assert.equal(container.hasClass("is-visible"), false, "answered Question leaves the Dock");
  assert.equal(container.childElementCount, 0);
  assert.deepEqual(await answerPromise, [{
    questionId: "approach",
    selectedOptionIds: ["simple"]
  }, {
    questionId: "evidence",
    selectedOptionIds: ["provider"],
    supplement: "保留真实 Provider 证据"
  }]);
  assert.equal(questionBinding!.submit([]), false, "resolved Question binding cannot be replayed");

  const approvalBroker = new PiAgentApprovalBroker();
  const approvalIdentity = {
    conversationId: "conversation-confirmation",
    piSessionId: "pi-confirmation",
    productRunId: "turn-confirmation",
    toolCallId: "tool-confirmation"
  } as const;
  const approvalPromise = approvalBroker.waitForDecision({
    ...approvalIdentity,
    requestId: "approval-request",
    target: "写入 disposable.md",
    preview: "仅写入一次"
  });
  const confirmationBinding = approvalBroker.bindingFor(approvalIdentity);
  assert.ok(confirmationBinding);
  let confirmationResolved = 0;
  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-confirmation",
    confirmation: {
      binding: confirmationBinding!,
      onResolved: () => { confirmationResolved += 1; }
    },
    onStale: () => assert.fail("a live Confirmation binding must not go stale"),
    onScheduleMeasure: () => undefined
  });
  assert.equal(
    container.findByClass("codex-ai-elements-confirmation")?.attributes.get("data-ai-elements-pattern"),
    "confirmation"
  );
  const approve = container.findByClass("is-approve")!;
  clickElement(approve);
  clickElement(approve);
  assert.equal(await approvalPromise, true);
  assert.equal(confirmationResolved, 1, "Confirmation resolves exactly once");
  assert.equal(container.hasClass("is-visible"), false, "resolved Confirmation leaves the Dock");
  assert.equal(container.childElementCount, 0);
  assert.equal(confirmationBinding!.decide("reject"), false,
    "resolved Confirmation binding cannot be replayed");

  controller.dispose();
  questionBroker.dispose();
  approvalBroker.dispose();
}

class FakeTaskPlanDockClock implements TaskPlanDockClock {
  nowValue = 10_000;
  nextHandle = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  readonly cleared = new Set<number>();

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = ++this.nextHandle;
    this.timers.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.cleared.add(handle);
  }

  fire(handle: number): void {
    this.timers.get(handle)?.callback();
  }
}

function taskPlanMessage(
  plan: Readonly<EchoInkTaskPlanSnapshot>,
  id = `task-plan-${plan.version}`
): ChatMessage {
  return {
    id,
    role: "assistant",
    itemType: "taskPlan",
    text: "",
    taskPlan: plan,
    createdAt: plan.createdAt
  };
}

export async function runSmoothConversationUiTests(): Promise<void> {
  assert.equal(
    settingsCopy("zh-CN").general.settingsLanguageDesc,
    "控制 EchoInk 界面语言；不会改写 Prompt、会话内容或用户自定义名称。"
  );
  assert.equal(
    settingsCopy("en").general.settingsLanguageDesc,
    "Controls the EchoInk interface language. Prompts, chats, and custom names are unchanged."
  );
  const initialDisclosure = nextReasoningDisclosureState(undefined, "running");
  assert.deepEqual(initialDisclosure, {
    open: true,
    manual: false,
    autoFoldHandled: false,
    lastStatus: "running"
  });
  const autoFoldedDisclosure = nextReasoningDisclosureState(
    initialDisclosure,
    "completed"
  );
  assert.deepEqual(autoFoldedDisclosure, {
    open: false,
    manual: false,
    autoFoldHandled: true,
    lastStatus: "completed"
  });
  assert.equal(
    nextReasoningDisclosureState(autoFoldedDisclosure, "failed").open,
    false,
    "later terminal updates cannot replay the first-answer auto-fold"
  );
  assert.deepEqual(nextReasoningDisclosureState(undefined, "interrupted"), {
    open: false,
    manual: false,
    autoFoldHandled: true,
    lastStatus: "interrupted"
  }, "a restored terminal snapshot starts folded with auto-fold already handled");
  const chineseHost = new FakeElement("div");
  const chinese = renderSmoothBlurOutUp(
    chineseHost as unknown as HTMLElement,
    "从一个问题开始"
  ) as unknown as FakeElement;
  assert.equal(chinese.attributes.get("aria-label"), "从一个问题开始");
  assert.equal(chinese.attributes.get("data-duration-ms"), String(SMOOTH_BLUR_OUT_UP_DURATION_MS));
  assert.equal(chinese.attributes.get("data-easing"), SMOOTH_BLUR_OUT_UP_EASING);
  assert.equal(chinese.attributes.get("data-stagger-ms"), String(SMOOTH_BLUR_OUT_UP_STAGGER_MS));
  assert.equal(chinese.findAllByClass("codex-smooth-blur-out-up-unit").length, 1,
    "Chinese subtitle may animate as one semantic unit");
  assert.equal(chinese.findByClass("codex-smooth-blur-out-up-unit")?.attributes.get("aria-hidden"), "true");

  const englishHost = new FakeElement("div");
  const english = renderSmoothBlurOutUp(
    englishHost as unknown as HTMLElement,
    "Smooth conversation"
  ) as unknown as FakeElement;
  const units = english.findAllByClass("codex-smooth-blur-out-up-unit");
  assert.equal(units.length, 2);
  assert.equal(units[0].attributes.get("style"), "--codex-smooth-blur-delay: 0ms");
  assert.equal(units[1].attributes.get("style"), "--codex-smooth-blur-delay: 28ms");

  const primitiveHost = new FakeElement("div");
  const reasoning = createSmoothAIReasoning(primitiveHost as unknown as HTMLElement, {
    bodyId: "reasoning-body",
    open: true,
    status: "running",
    summary: "正在思考"
  });
  assert.equal((reasoning.root as unknown as FakeElement).tag, "details");
  assert.equal((reasoning.root as unknown as FakeElement).attributes.get("data-smooth-ui-pattern"), "ai-reasoning");
  assert.equal((reasoning.summary as unknown as FakeElement).attributes.get("aria-expanded"), "true");
  const tool = primitiveHost.createDiv();
  assert.equal(markSmoothAIToolCall(tool as unknown as HTMLElement, "completed"), "success");
  assert.equal(tool.attributes.get("data-smooth-ui-pattern"), "ai-tool-call");
  const artifact = createSmoothAIArtifact(primitiveHost as unknown as HTMLElement, "输出");
  assert.equal((artifact.root as unknown as FakeElement).attributes.get("data-smooth-ui-pattern"), "ai-artifact");
  const tasks = primitiveHost.createDiv();
  markSmoothAITaskList(tasks as unknown as HTMLElement);
  assert.equal(tasks.attributes.get("data-smooth-ui-pattern"), "ai-task-list");

  const dockClock = new FakeTaskPlanDockClock();
  const inProgressPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    schemaVersion: 1,
    planId: "shared-plan",
    title: "共享计划",
    status: "in_progress",
    version: 1,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "读取真实状态", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "更新界面", status: "in_progress" as const })
    ]),
    currentStepId: "step-2",
    source: "agent",
    createdAt: 9_000,
    updatedAt: 9_500
  });
  const inProgressMessage = taskPlanMessage(inProgressPlan, "stable-plan-message");
  assert.equal(
    selectTaskPlanForDock([inProgressMessage])?.plan,
    inProgressPlan,
    "the dock selector returns the exact projected taskPlan reference"
  );
  assert.equal(selectTaskPlanForDock([{
    id: "natural-language-plan",
    role: "assistant",
    text: "计划：先读，再写",
    createdAt: 9_600
  }]), null, "natural-language planning copy must not create a dock plan");

  const versionTwoPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    version: 2,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "读取真实状态", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "界面已同步到 v2", status: "in_progress" as const })
    ]),
    updatedAt: 9_700
  });
  const dock = new TaskPlanDockController(dockClock);
  const dockHost = new FakeElement("div");
  dock.render(dockHost as unknown as HTMLElement, {
    sessionId: "session-a",
    messages: [inProgressMessage]
  });
  assert.equal(dockHost.dataset.sessionTaskPlanId, "shared-plan");
  assert.ok(dockHost.findByClass("codex-smooth-ai-task-list"));
  assert.equal(
    dockHost.findByClass("codex-task-plan-progress")?.textContent,
    "2/2 · 进行中",
    "compact progress reports the real current step and whole-plan state"
  );
  assert.match(renderedText(dockHost), /更新界面/u);
  dock.render(dockHost as unknown as HTMLElement, {
    sessionId: "session-a",
    messages: [taskPlanMessage(versionTwoPlan, "stable-plan-message")]
  });
  assert.match(renderedText(dockHost), /界面已同步到 v2/u,
    "a same-message plan version replaces the dock immediately");
  clickElement(dockHost.findByClass("codex-task-plan-header")!);
  assert.equal(
    dockHost.findAllByClass("codex-task-plan-step").length,
    2,
    "expanded dock renders every real step"
  );
  dock.dispose();

  const completionClock = new FakeTaskPlanDockClock();
  const completedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...versionTwoPlan,
    status: "completed",
    version: 3,
    steps: Object.freeze(versionTwoPlan.steps.map((step) => Object.freeze({
      ...step,
      status: "completed" as const
    }))),
    currentStepId: undefined,
    updatedAt: completionClock.now()
  });
  const completionDock = new TaskPlanDockController(completionClock);
  const completionHost = new FakeElement("div");
  const completionInput = {
    sessionId: "session-completed",
    messages: [
      taskPlanMessage({
        ...inProgressPlan,
        planId: "older-plan",
        updatedAt: 8_000
      }, "older-plan-message"),
      taskPlanMessage(completedPlan)
    ]
  };
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  assert.match(renderedText(completionHost), /2\/2 · 已完成/u);
  assert.equal(completionClock.timers.size, 1,
    "repeated renders schedule one completion closeout");
  const completionHandle = [...completionClock.timers.keys()][0];
  assert.equal(completionClock.timers.get(completionHandle)?.delayMs, TASK_PLAN_DOCK_CLOSEOUT_MS);
  completionClock.fire(completionHandle);
  assert.equal(completionHost.hasClass("is-visible"), false);
  assert.equal(completionHost.dataset.sessionTaskPlanId, undefined,
    "hiding the latest completed plan never falls back to an older plan");
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  assert.equal(completionClock.timers.size, 1,
    "a hidden completed plan never schedules again");

  const manualClock = new FakeTaskPlanDockClock();
  const manualDock = new TaskPlanDockController(manualClock);
  const manualHost = new FakeElement("div");
  const manualInput = {
    sessionId: "session-manual",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: manualClock.now() })]
  };
  manualDock.render(manualHost as unknown as HTMLElement, manualInput);
  const manualHandle = [...manualClock.timers.keys()][0];
  clickElement(manualHost.findByClass("codex-task-plan-header")!);
  assert.equal(manualClock.cleared.has(manualHandle), true);
  manualClock.fire(manualHandle);
  assert.equal(manualHost.hasClass("is-visible"), true,
    "manual expansion protects a completed dock from collapse or hiding");

  const switchClock = new FakeTaskPlanDockClock();
  const switchDock = new TaskPlanDockController(switchClock);
  const switchHost = new FakeElement("div");
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-old",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: switchClock.now() })]
  });
  const staleHandle = [...switchClock.timers.keys()][0];
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-new",
    messages: [inProgressMessage]
  });
  assert.equal(switchClock.cleared.has(staleHandle), true);
  switchClock.fire(staleHandle);
  assert.equal(switchHost.dataset.sessionTaskPlanId, "shared-plan",
    "a late callback from the old session cannot hide the new session plan");
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-old",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: switchClock.now() })]
  });
  assert.equal(switchHost.hasClass("is-visible"), false,
    "switching back restores that session's handled presentation without replaying it");

  const oldClock = new FakeTaskPlanDockClock();
  oldClock.nowValue = completedPlan.updatedAt + TASK_PLAN_DOCK_CLOSEOUT_MS + 1;
  const oldHost = new FakeElement("div");
  new TaskPlanDockController(oldClock).render(oldHost as unknown as HTMLElement, {
    sessionId: "session-reopened",
    messages: [taskPlanMessage(completedPlan)]
  });
  assert.equal(oldHost.hasClass("is-visible"), false);
  assert.equal(oldClock.timers.size, 0,
    "an old completed plan does not replay its closeout on reopen");

  const failedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "failed",
    version: 4,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "中断的步骤", status: "interrupted" as const }),
      Object.freeze({ stepId: "step-2", text: "尚未开始", status: "pending" as const })
    ]),
    currentStepId: undefined,
    reason: "任务执行失败",
    updatedAt: 9_900
  });
  const failedHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(failedHost as unknown as HTMLElement, {
    sessionId: "session-failed",
    messages: [taskPlanMessage(failedPlan)]
  });
  assert.match(renderedText(failedHost), /任务失败/u);
  assert.equal(failedHost.findAllByClass("codex-task-plan-step-current").length, 0,
    "whole-task failure never fabricates a current or failed step");

  const pausedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "paused",
    version: 5,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "已完成步骤", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "中断步骤", status: "paused" as const })
    ]),
    currentStepId: "step-2",
    updatedAt: 10_100
  });
  const pausedHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(pausedHost as unknown as HTMLElement, {
    sessionId: "session-paused",
    messages: [taskPlanMessage(pausedPlan)]
  });
  assert.match(renderedText(pausedHost), /已中断，可继续/u);
  assert.doesNotMatch(renderedText(pausedHost), /进行中/u);
  assert.equal(
    pausedHost.findAllByClass("codex-task-plan-step")
      .some((step) => step.hasClass("is-failed")),
    false,
    "a paused Dock never fabricates a failed step"
  );

  const cancelledPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "cancelled",
    version: 6,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "已完成步骤", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "取消步骤", status: "cancelled" as const })
    ]),
    currentStepId: undefined,
    updatedAt: 10_200
  });
  const cancelledHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(cancelledHost as unknown as HTMLElement, {
    sessionId: "session-cancelled",
    messages: [taskPlanMessage(cancelledPlan)]
  });
  assert.match(renderedText(cancelledHost), /已取消/u);
  assert.doesNotMatch(renderedText(cancelledHost), /进行中/u);
  assert.equal(
    cancelledHost.findAllByClass("codex-task-plan-step")
      .some((step) => step.hasClass("is-failed")),
    false,
    "a cancelled Dock never fabricates a failed step"
  );

  const localSources = createAIElementsDocumentSources(
    primitiveHost as unknown as HTMLElement,
    1,
    true
  );
  assert.equal((localSources.root as unknown as FakeElement).tag, "details");
  assert.equal(
    (localSources.root as unknown as FakeElement).attributes.get("data-ai-elements-pattern"),
    "sources"
  );
  assert.equal(
    (localSources.summary as unknown as FakeElement).findByClass("codex-ai-elements-sources-label")?.textContent,
    "Used 1 document"
  );

  const emptyMessages = new FakeElement("div");
  const emptyVirtualList = new FakeElement("div");
  const selectedSuggestions: string[] = [];
  new CodexMessageListRenderer().render({
    app: {} as never,
    component: {} as never,
    messagesEl: emptyMessages as unknown as HTMLElement,
    virtualListEl: emptyVirtualList as unknown as HTMLElement,
    sessionId: "empty-conversation",
    welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
    settingsLanguage: "zh-CN",
    messages: [],
    vaultPath: "/test-vault",
    readRawMessageText: async () => "",
    onSuggestionSelect: (text) => selectedSuggestions.push(text),
    onScheduleMeasure: () => undefined,
    onScheduleRunProgress: () => undefined
  });
  const suggestionButtons = emptyVirtualList.findAllByClass("codex-smooth-ai-suggestion");
  assert.deepEqual(
    suggestionButtons.map((button) => button.textContent),
    ["整理知识库", "总结当前笔记", "从知识库找答案"]
  );
  suggestionButtons[1].onclick?.({} as never);
  assert.deepEqual(selectedSuggestions, ["总结当前笔记"], "suggestion click only selects its exact visible text");

  assert.deepEqual(
    extractProcessFileRefs("读取 Foo.md 后继续", "/test-vault").map((file) => file.path),
    ["Foo.md"],
    "a root-level Vault filename is projected like a nested path"
  );
  const durationFixture: ChatMessage = {
    id: "duration-tool",
    role: "tool",
    itemType: "dynamicToolCall",
    processKind: "view",
    title: "read",
    text: "result",
    status: "completed",
    createdAt: 1_000,
    completedAt: 2_250
  };
  assert.equal(
    buildActionTimeline([durationFixture]).groups[0]?.items[0]?.durationMs,
    1_250,
    "the compact ledger uses completion minus start"
  );
  assert.equal(
    buildActionTimeline([{ ...durationFixture, id: "missing-duration", completedAt: undefined }])
      .groups[0]?.items[0]?.durationMs,
    undefined,
    "a missing completion timestamp never fabricates duration"
  );
  assert.equal(
    buildActionTimeline([{ ...durationFixture, id: "reverse-duration", completedAt: 999 }])
      .groups[0]?.items[0]?.durationMs,
    undefined,
    "a reversed timestamp pair is not displayed as duration"
  );

  const approvalToolCallId = "approval-preview-Foo";
  const approvalMessageId = `pi:session-ledger:leaf:leaf-ledger:tool:${encodeURIComponent(approvalToolCallId)}`;
  const approvalDiff = [
    "--- a/Foo.md",
    "+++ b/Foo.md",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const approvalPreview = JSON.stringify({
    operation: "note_update",
    relativePath: "Foo.md",
    change: {
      kind: "update",
      relativePath: "Foo.md",
      added: 1,
      removed: 1,
      diff: approvalDiff
    }
  });
  const projector = new PiChatUiProjector();
  const approvalBase = projector.createEmpty({
    piSessionId: "session-ledger",
    activeLeafId: "leaf-ledger",
    now: 3_000
  });
  approvalBase.productRunId = "run-approval-ledger";
  approvalBase.runState = "running";
  approvalBase.messages = [{
    id: approvalMessageId,
    role: "tool",
    itemType: "dynamicToolCall",
    processKind: "tool",
    title: "note_update",
    text: "",
    processInput: "{\"relativePath\":\"Foo.md\"}",
    processInputAvailability: "provided",
    processOutputAvailability: "unavailable",
    status: "running",
    runId: "run-approval-ledger",
    turnId: "run-approval-ledger",
    createdAt: 3_000
  }];
  approvalBase.provisionalMessageIds = [approvalMessageId];
  approvalBase.pendingToolCallIds = [approvalToolCallId];
  const approvalRecords = [{
    piSessionId: "session-ledger",
    toolCallId: approvalToolCallId,
    productRunId: "run-approval-ledger",
    status: "pending" as const,
    target: "{\"relativePath\":\"Foo.md\"}",
    preview: approvalPreview,
    updatedAt: 3_100
  }];
  const approvalProjected = projector.decorateToolProductState(approvalBase, {
    approvals: approvalRecords
  });
  const approvalProjectionMessage = approvalProjected.messages[0]!;
  assert.equal(approvalProjectionMessage.status, "waiting_approval");
  assert.equal(approvalProjectionMessage.files?.[0]?.path, "Foo.md");
  assert.deepEqual(approvalProjectionMessage.diffSummary, {
    totalFiles: 1,
    added: 1,
    removed: 1,
    files: [{ path: "Foo.md", kind: "update", added: 1, removed: 1 }]
  });
  assert.deepEqual(
    projector.decorateToolProductState(approvalBase, { approvals: approvalRecords }).messages,
    approvalProjected.messages,
    "reopening from the same durable Approval preview rebuilds the same Tool projection"
  );

  const context = createTestContext();
  const renderer = new CodexMessageListRenderer();
  bindRenderer(renderer, context);
  const previousDocument = (globalThis as unknown as { document?: unknown }).document;
  const previousHTMLElement = (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElementNS: (_namespace: string, tag: string) => new FakeElement(tag)
    }
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined
    }
  });
  try {
    const answer = renderMessage(renderer, {
      id: "smooth:entry:answer-1",
      role: "assistant",
      text: "查看 **[[projects/Alpha.md|别名]]**",
      backendId: "deepseek-chat",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      status: "completed",
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000
    }, { showAgentFooter: true, showAgentHeader: true });
    assert.equal(answer.findAllByClass("codex-agent-header").length, 1);
    assert.equal(answer.findAllByClass("codex-agent-footer").length, 1);
    assert.equal(answer.findAllByClass("codex-answer-copy").length, 1);
    assert.equal(answer.findAllByClass("codex-message-derive-action").length, 1);
    assert.equal(answer.findByClass("codex-agent-footer-model")?.textContent, "deepseek-chat");
    assert.ok(answer.findByClass("codex-agent-footer-time"));
    assert.ok(answer.findByClass("codex-smooth-ai-message"));
    assert.ok(answer.findByClass("codex-smooth-ai-message-body"));
    assert.ok(answer.findByClass("codex-smooth-ai-response"));
    assert.equal(answer.findAllByClass("codex-smooth-ai-response-caret").length, 0,
      "completed answers do not retain a streaming caret");
    const normalLink = answer.findByClass("codex-message-note-link");
    assert.ok(normalLink);
    assert.equal(normalLink!.textContent, "Alpha", "resolved links display the note name, not aliases or paths");
    assert.equal(normalLink!.attributes.get("data-path"), "projects/Alpha.md");
    assert.equal(normalLink!.attributes.get("aria-label"), "打开笔记 Alpha");
    await clickRegistered(normalLink!);

    const imageAttachments = renderMessage(renderer, {
      id: "user-images",
      role: "user",
      text: "请比较两张图",
      images: [{
        type: "image",
        name: "clipboard-1720000000000-0.png",
        path: "images/cover #1.png",
        mimeType: "image/png",
        availability: "unavailable"
      }, {
        type: "image",
        name: "clipboard-1720000000000-1.png",
        path: "images/missing.png",
        mimeType: "image/png",
        availability: "available"
      }],
      createdAt: 1_700_000_000_500
    }, { showAgentFooter: false, showAgentHeader: false });
    const imageAttachmentList = imageAttachments.findByClass("codex-ai-elements-attachments")!;
    assert.equal(imageAttachmentList.attributes.get("data-ai-elements-pattern"), "attachments");
    assert.equal(imageAttachmentList.attributes.get("data-attachment-variant"), "grid");
    assert.equal(imageAttachmentList.attributes.get("role"), "list");
    const imagePreview = imageAttachments.findByClass("codex-message-image-preview")!;
    assert.equal(imagePreview.tag, "button");
    assert.equal(imagePreview.attributes.get("aria-label"), "打开图片：粘贴图片 1.png");
    assert.equal(
      imagePreview.findAllByTag("img")[0]?.src,
      "app://echoink-vault/images/cover%20%231.png",
      "message Attachments use the current Obsidian resource URI"
    );
    assert.match(
      renderedText(imageAttachments),
      /粘贴图片 2\.png · 图片附件不可在本地打开/u,
      "missing images keep an explicit durable fallback"
    );
    assert.doesNotMatch(renderedText(imageAttachments), /clipboard-/u);

    await assertInteractionDockContracts();

    const emptyRunningAnswer = renderMessage(renderer, {
      id: "answer-running-empty",
      role: "assistant",
      text: "",
      status: "running",
      createdAt: 1_700_000_001_100
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.ok(emptyRunningAnswer.findByClass("codex-smooth-ai-loader"));
    assert.equal(emptyRunningAnswer.findAllByClass("codex-smooth-ai-response").length, 0,
      "empty running answer stays a truthful loader before the first delta");

    const streamingAnswer = renderMessage(renderer, {
      id: "answer-running-text",
      role: "assistant",
      text: "第一段回复",
      status: "running",
      createdAt: 1_700_000_001_200
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.ok(streamingAnswer.findByClass("codex-smooth-ai-response"));
    assert.ok(streamingAnswer.findByClass("codex-smooth-ai-response-caret"));
    assert.equal(streamingAnswer.findAllByClass("codex-smooth-ai-loader").length, 0,
      "first text delta replaces the answer loader rather than coexisting with it");

    const reasoningMessage = renderMessage(renderer, {
      id: "reasoning-1",
      role: "assistant",
      itemType: "reasoning",
      text: "正在检查上下文",
      status: "running",
      createdAt: 1_700_000_002_000
    }, { showAgentFooter: false, showAgentHeader: false });
    const reasoningRoot = reasoningMessage.findByClass("codex-smooth-ai-reasoning");
    assert.ok(reasoningRoot);
    assert.equal(reasoningRoot!.tag, "details");
    assert.equal(reasoningRoot!.open, true);

    const structuredRunning: ChatMessage = {
      id: "pi:session:reasoning:run-structured",
      role: "assistant",
      itemType: "reasoning",
      title: "正在思考",
      text: "",
      status: "running",
      reasoningSummary: {
        schemaVersion: 1,
        conversationId: "conversation-structured",
        piSessionId: "session-structured",
        productRunId: "run-structured",
        status: "running",
        startedAt: 10_000,
        updatedAt: 10_000,
        activities: []
      },
      runId: "run-structured",
      turnId: "run-structured",
      createdAt: 10_000
    };
    const runningReasoning = renderMessage(
      renderer,
      structuredRunning,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const runningReasoningRoot = runningReasoning.findByClass(
      "codex-smooth-ai-reasoning"
    );
    assert.equal(runningReasoningRoot?.open, true);
    assert.equal(
      runningReasoning.findByClass("codex-smooth-ai-reasoning-label")?.textContent,
      "正在思考"
    );
    assert.equal(
      renderedText(runningReasoning).match(/正在思考/gu)?.length,
      1,
      "empty structured activity renders exactly one truthful summary label"
    );
    assert.equal(
      renderedText(runningReasoning.findByClass("codex-smooth-ai-reasoning-body")!),
      "",
      "empty Reasoning has no duplicate body fallback"
    );

    const conversationMessages = new FakeElement("div");
    const conversationVirtualList = new FakeElement("div");
    const sameRunEmptyAnswer: ChatMessage = {
      id: "answer-same-running-empty",
      role: "assistant",
      text: "",
      status: "running",
      runId: "run-structured",
      turnId: "run-structured",
      createdAt: 10_100
    };
    const otherRunEmptyAnswer: ChatMessage = {
      ...sameRunEmptyAnswer,
      id: "answer-other-running-empty",
      runId: "run-without-reasoning",
      turnId: "run-without-reasoning",
      createdAt: 10_200
    };
    const suppressionRenderer = new CodexMessageListRenderer();
    suppressionRenderer.render({
      app: context.app as never,
      component: context.component as never,
      messagesEl: conversationMessages as unknown as HTMLElement,
      virtualListEl: conversationVirtualList as unknown as HTMLElement,
      sessionId: "reasoning-loader-suppression",
      welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
      settingsLanguage: "zh",
      messages: [structuredRunning, sameRunEmptyAnswer, otherRunEmptyAnswer],
      vaultPath: "/test-vault",
      readRawMessageText: async () => "",
      onScheduleMeasure: () => undefined,
      onScheduleRunProgress: () => undefined
    });
    const runningTurnKeys = conversationVirtualList
      .findAllByClass("codex-message-type-assistantTurn")
      .map((message) => message.dataset.turnKey);
    assert.deepEqual(runningTurnKeys, ["run:run-structured", "run:run-without-reasoning"],
      "same-run Process and empty Answer share one Assistant Turn while another run remains isolated");
    assert.equal(
      conversationVirtualList.findAllByClass("codex-message-type-assistantTurn").length,
      2
    );
    assert.equal(
      conversationVirtualList.findAllByClass("codex-assistant-turn-node-title")
        .filter((title) => title.textContent === "正在思考").length,
      1,
      "legacy reasoningSummary creates one Process node, not fake Provider Reasoning"
    );
    assert.match(
      conversationVirtualList.findByClass("codex-assistant-turn-summary-copy")?.textContent ?? "",
      /正在处理 · 正在思考/u
    );
    assert.equal(
      conversationVirtualList.findAllByClass("codex-smooth-ai-reasoning").length,
      0
    );
    assert.equal(conversationVirtualList.findAllByClass("codex-smooth-ai-loader").length, 2,
      "each active Assistant Turn owns at most one generating-answer Loader");
    assert.equal(
      renderedText(conversationVirtualList).match(/正在生成回复/gu)?.length,
      2
    );
    suppressionRenderer.render({
      app: context.app as never,
      component: context.component as never,
      messagesEl: conversationMessages as unknown as HTMLElement,
      virtualListEl: conversationVirtualList as unknown as HTMLElement,
      sessionId: "reasoning-loader-suppression",
      welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
      settingsLanguage: "zh",
      messages: [
        structuredRunning,
        { ...sameRunEmptyAnswer, text: "首段公开回答" }
      ],
      vaultPath: "/test-vault",
      readRawMessageText: async () => "",
      onScheduleMeasure: () => undefined,
      onScheduleRunProgress: () => undefined
    });
    assert.equal(
      conversationVirtualList.findAllByClass("codex-message-type-assistantTurn").length,
      1,
      "the first public Answer delta updates the same Assistant Turn"
    );
    assert.equal(
      conversationVirtualList.findByClass("codex-assistant-turn-final")?.dataset.messageId,
      sameRunEmptyAnswer.id,
      "the final Answer section retains the original message identity"
    );
    assert.ok(conversationVirtualList.findByClass("codex-smooth-ai-response"));
    assert.equal(conversationVirtualList.findAllByClass("codex-smooth-ai-loader").length, 0);

    const structuredAnswered: ChatMessage = {
      ...structuredRunning,
      title: "思考完成 · 2 秒",
      text: "请求模型完成",
      status: "completed",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        status: "completed",
        firstAssistantTextAt: 12_000,
        updatedAt: 12_000,
        activities: [{
          id: "provider",
          kind: "provider",
          status: "completed",
          stage: "requesting",
          startedAt: 10_100,
          updatedAt: 12_000
        }]
      }
    };
    const answeredReasoning = renderMessage(
      renderer,
      structuredAnswered,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const answeredReasoningRoot = answeredReasoning.findByClass(
      "codex-smooth-ai-reasoning"
    );
    assert.equal(answeredReasoningRoot?.open, false,
      "the first real answer transition auto-folds once");
    assert.equal(
      answeredReasoning.findByClass("codex-smooth-ai-reasoning-label")?.textContent,
      "思考完成 · 2 秒"
    );
    answeredReasoningRoot!.open = true;
    answeredReasoningRoot!.ontoggle?.({ isTrusted: true });
    assert.equal(
      answeredReasoning.findByClass("codex-smooth-ai-reasoning-summary")
        ?.attributes.get("aria-expanded"),
      "true",
      "a trusted programmatic toggle still synchronizes accessibility state"
    );
    const afterProgrammaticOpen = renderMessage(
      renderer,
      structuredAnswered,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const afterProgrammaticRoot = afterProgrammaticOpen.findByClass(
      "codex-smooth-ai-reasoning"
    )!;
    assert.equal(afterProgrammaticRoot.open, false,
      "a trusted programmatic toggle without summary activation never becomes manual");
    const afterProgrammaticSummary = afterProgrammaticOpen.findByClass(
      "codex-smooth-ai-reasoning-summary"
    )!;
    afterProgrammaticSummary.onclick?.({
      isTrusted: true,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    afterProgrammaticRoot.open = true;
    afterProgrammaticRoot.ontoggle?.({ isTrusted: true });

    const structuredFailed: ChatMessage = {
      ...structuredAnswered,
      title: "处理失败 · 4 秒",
      status: "failed",
      completedAt: 14_000,
      reasoningSummary: {
        ...structuredAnswered.reasoningSummary!,
        status: "failed",
        terminalAt: 14_000,
        updatedAt: 14_000
      }
    };
    const failedAfterManualOpen = renderMessage(
      renderer,
      structuredFailed,
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      failedAfterManualOpen.findByClass("codex-smooth-ai-reasoning")?.open,
      true,
      "manual disclosure permanently wins over later live and terminal updates"
    );

    const collapsedRun: ChatMessage = {
      ...structuredRunning,
      id: "pi:session:reasoning:run-collapsed",
      runId: "run-collapsed",
      turnId: "run-collapsed",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        productRunId: "run-collapsed"
      }
    };
    const collapsedRunning = renderMessage(
      renderer,
      collapsedRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const collapsedRoot = collapsedRunning.findByClass("codex-smooth-ai-reasoning")!;
    collapsedRunning.findByClass("codex-smooth-ai-reasoning-summary")
      ?.onkeydown?.({
        isTrusted: true,
        key: "Enter",
        code: "Enter",
        preventDefault: () => undefined,
        stopPropagation: () => undefined
      });
    collapsedRoot.open = false;
    collapsedRoot.ontoggle?.({ isTrusted: true });
    const collapsedAnswered = renderMessage(
      renderer,
      {
        ...structuredAnswered,
        id: collapsedRun.id,
        runId: "run-collapsed",
        turnId: "run-collapsed",
        reasoningSummary: {
          ...structuredAnswered.reasoningSummary!,
          productRunId: "run-collapsed"
        }
      },
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      collapsedAnswered.findByClass("codex-smooth-ai-reasoning")?.open,
      false,
      "trusted Enter collapse before first text is never stolen"
    );

    const spaceRun: ChatMessage = {
      ...collapsedRun,
      id: "pi:session:reasoning:run-space",
      runId: "run-space",
      turnId: "run-space",
      reasoningSummary: {
        ...collapsedRun.reasoningSummary!,
        productRunId: "run-space"
      }
    };
    const spaceRunning = renderMessage(
      renderer,
      spaceRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const spaceRoot = spaceRunning.findByClass("codex-smooth-ai-reasoning")!;
    const spaceSummary = spaceRunning.findByClass(
      "codex-smooth-ai-reasoning-summary"
    )!;
    spaceSummary.onkeydown?.({
      isTrusted: true,
      key: " ",
      code: "Space",
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    spaceSummary.onclick?.({
      isTrusted: true,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    spaceRoot.open = false;
    spaceRoot.ontoggle?.({ isTrusted: true });
    const spaceAnswered = renderMessage(
      renderer,
      {
        ...structuredAnswered,
        id: spaceRun.id,
        runId: "run-space",
        turnId: "run-space",
        reasoningSummary: {
          ...structuredAnswered.reasoningSummary!,
          productRunId: "run-space"
        }
      },
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      spaceAnswered.findByClass("codex-smooth-ai-reasoning")?.open,
      false,
      "trusted Space activation is consumed once even when it also emits click"
    );

    (renderer as unknown as { env: { sessionId: string } }).env.sessionId =
      "smooth-ui-other-session";
    const otherSessionRunning = renderMessage(
      renderer,
      collapsedRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      otherSessionRunning.findByClass("codex-smooth-ai-reasoning")?.open,
      true,
      "another session cannot inherit disclosure state for the same productRunId"
    );
    (renderer as unknown as { env: { sessionId: string } }).env.sessionId =
      "smooth-ui-test";

    const restoredTerminalCases = [
      { status: "completed", title: "思考完成 · 4 秒" },
      { status: "failed", title: "处理失败 · 4 秒" },
      { status: "interrupted", title: "思考中断 · 4 秒" },
      { status: "cancelled", title: "思考已取消 · 4 秒" }
    ] as const;
    for (const terminalCase of restoredTerminalCases) {
      const restoredRenderer = new CodexMessageListRenderer();
      bindRenderer(restoredRenderer, context);
      const restoredTerminal = renderMessage(
        restoredRenderer,
        {
          ...structuredFailed,
          id: `reasoning-restored-${terminalCase.status}`,
          title: terminalCase.title,
          status: terminalCase.status,
          reasoningSummary: {
            ...structuredFailed.reasoningSummary!,
            productRunId: `run-restored-${terminalCase.status}`,
            status: terminalCase.status
          }
        },
        { showAgentFooter: false, showAgentHeader: false }
      );
      assert.equal(
        restoredTerminal.findByClass("codex-smooth-ai-reasoning")?.open,
        false,
        `restored ${terminalCase.status} Reasoning starts folded`
      );
      assert.equal(
        restoredTerminal.findByClass("codex-smooth-ai-reasoning-label")?.textContent,
        terminalCase.title
      );
    }

    const siblingCanaries = {
      prompt: "PROMPT_DOM_PRIVATE_CANARY",
      answer: "ANSWER_DOM_PRIVATE_CANARY",
      toolArgument: "TOOL_ARGUMENT_DOM_PRIVATE_CANARY",
      toolResult: "TOOL_RESULT_DOM_PRIVATE_CANARY",
      sourceData: "SOURCE_DATA_DOM_PRIVATE_CANARY",
      diffContent: "DIFF_CONTENT_DOM_PRIVATE_CANARY",
      approvalPayload: "APPROVAL_PAYLOAD_DOM_PRIVATE_CANARY",
      publicReasoning: "PUBLIC_PROVIDER_REASONING_DOM_CANARY",
      privateReasoning: "PRIVATE_REASONING_DOM_CANARY"
    } as const;
    const reasoningSibling = {
      ...structuredRunning,
      id: "reasoning-separated",
      title: "正在思考",
      text: "请求模型",
      status: "completed",
      details: siblingCanaries.privateReasoning,
      runId: "run-separated",
      turnId: "run-separated",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        productRunId: "run-separated",
        status: "completed",
        updatedAt: 4,
        activities: [{
          id: "provider",
          kind: "provider",
          status: "completed",
          stage: "requesting",
          startedAt: 2,
          updatedAt: 4
        }]
      },
      assistantTurn: {
        viewVersion: 1,
        turnId: "run-separated",
        status: "completed",
        startedAt: 2,
        updatedAt: 10,
        completedAt: 10,
        processNodes: [],
        providerReasoning: {
          reasoningId: "provider-reasoning-separated",
          source: "provider_public",
          status: "completed",
          text: siblingCanaries.publicReasoning,
          startedAt: 2,
          updatedAt: 4,
          completedAt: 4,
          durationMs: 2_000
        },
        interactionRecords: [{
          interactionId: "approval-separated",
          kind: "confirmation",
          outcome: "approved",
          summary: "已批准一次性写入",
          updatedAt: 7
        }],
        finalAnswerMessageId: "answer-separated",
        summary: {
          completedSteps: 7,
          toolCount: 2,
          durationMs: 8_000
        }
      }
    } as ChatMessage;
    const siblingMessages: ChatMessage[] = [
      {
        id: "reasoning-user-row",
        role: "user",
        text: `问题 ${siblingCanaries.prompt}`,
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 1
      },
      reasoningSibling,
      {
        id: "tool-separated",
        role: "tool",
        itemType: "dynamicToolCall",
        title: "使用工具：vault_search",
        text: siblingCanaries.toolResult,
        processInput: siblingCanaries.toolArgument,
        processOutput: siblingCanaries.toolResult,
        processInputAvailability: "provided",
        processOutputAvailability: "provided",
        status: "completed",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 3
      },
      {
        id: "task-separated",
        role: "assistant",
        itemType: "taskPlan",
        text: "",
        taskPlan: {
          schemaVersion: 1,
          planId: "plan-separated",
          title: "独立任务",
          status: "in_progress",
          version: 1,
          steps: [{ stepId: "step-separated", text: "继续处理", status: "in_progress" }],
          currentStepId: "step-separated",
          source: "agent",
          productRunId: "run-separated",
          createdAt: 4,
          updatedAt: 4
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 4
      },
      {
        id: "sources-separated",
        role: "assistant",
        text: "基于本地资料",
        citations: {
          status: "strong",
          counts: { wiki: 1, journal: 0, outputs: 0 },
          citations: [{
            bucket: "wiki",
            title: "Alpha",
            path: "projects/Alpha.md",
            excerptLines: [siblingCanaries.sourceData],
            relevance: "strong",
            reason: "matched",
            score: 1
          }]
        },
        askSourceAttribution: true,
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 5
      },
      {
        id: "diff-separated",
        role: "tool",
        itemType: "fileChange",
        title: "文件改动",
        text: `@@ -1 +1 @@\n-old\n+${siblingCanaries.diffContent}`,
        status: "completed",
        diffSummary: {
          totalFiles: 1,
          added: 1,
          removed: 1,
          files: [{ path: "projects/Alpha.md", kind: "update", added: 1, removed: 1 }]
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 6
      },
      {
        id: "approval-separated",
        role: "assistant",
        itemType: "interactionRecord",
        title: "用户已批准",
        text: "",
        details: "已批准一次性写入",
        status: "completed",
        interactionRecord: {
          interactionId: "approval-separated",
          kind: "confirmation",
          outcome: "approved",
          summary: "已批准一次性写入",
          updatedAt: 7
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 7
      },
      {
        id: "loader-separated",
        role: "assistant",
        text: "",
        status: "running",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 8
      },
      {
        id: "answer-separated",
        role: "assistant",
        text: `最终回答 ${siblingCanaries.answer}`,
        status: "completed",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 9,
        completedAt: 10
      }
    ];
    const sourceSibling = siblingMessages.find((message) => message.id === "sources-separated") as
      | (ChatMessage & { knowledgeProducedPaths?: string[] })
      | undefined;
    assert.ok(sourceSibling);
    sourceSibling!.knowledgeProducedPaths = ["outputs/Generated.md"];
    const separatedProjection = buildAgentTurnProjection(siblingMessages);
    assert.equal(
      separatedProjection.some((item) => item.kind === "completedProcess"),
      false,
      "the legacy completedProcess projection is no longer emitted"
    );
    assert.equal(separatedProjection.length, 2,
      "one user row plus one Assistant Turn are the only projected rows");
    assert.equal(separatedProjection[0]?.kind, "message");
    assert.equal(separatedProjection[1]?.kind, "assistantTurn");
    const unifiedTurn = separatedProjection[1]?.kind === "assistantTurn"
      ? separatedProjection[1].turn
      : null;
    assert.ok(unifiedTurn);
    assert.equal(unifiedTurn!.messages.length, siblingMessages.length - 1);
    assert.equal(unifiedTurn!.finalAnswer?.id, "answer-separated");
    assert.equal(unifiedTurn!.status, "completed");
    assert.equal(unifiedTurn!.currentNodeId, undefined);
    assert.deepEqual(
      unifiedTurn!.processNodes.map((node) => node.kind),
      ["process", "reasoning", "tool", "task", "retrieval", "artifact", "diff", "interaction"],
      "Reasoning, Tool, Task, Sources, Artifact, Diff, and interaction retain chronological order"
    );

    const uniqueToolCallId = "call:read/Foo.md";
    const projectedToolMessageId = `pi:session-unique-tool:leaf:leaf-unique-tool:tool:${encodeURIComponent(uniqueToolCallId)}`;
    const duplicateToolActivityId = stableHashedIdentity("reasoning-tool", uniqueToolCallId);
    const uniqueToolMessages: ChatMessage[] = [
      {
        id: "unique-tool-user",
        role: "user",
        text: "读取文件",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 10
      },
      {
        id: "unique-tool-reasoning",
        role: "assistant",
        itemType: "reasoning",
        text: "",
        status: "completed",
        reasoningSummary: {
          schemaVersion: 1,
          conversationId: "conversation-unique-tool",
          piSessionId: "session-unique-tool",
          productRunId: "run-unique-tool",
          status: "completed",
          startedAt: 11,
          updatedAt: 14,
          firstAssistantTextAt: 14,
          activities: [{
            id: duplicateToolActivityId,
            kind: "tool",
            status: "completed",
            name: "read",
            startedAt: 12,
            updatedAt: 13
          }]
        },
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 11,
        completedAt: 14
      },
      {
        id: projectedToolMessageId,
        role: "tool",
        itemType: "dynamicToolCall",
        processKind: "view",
        title: "read",
        text: "Foo contents",
        status: "completed",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 12,
        completedAt: 13
      },
      {
        id: "unique-tool-answer",
        role: "assistant",
        text: "读取完成",
        status: "completed",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 14,
        completedAt: 15
      }
    ];
    const uniqueToolProjection = buildAgentTurnProjection(uniqueToolMessages);
    const uniqueToolTurn = uniqueToolProjection[1]?.kind === "assistantTurn"
      ? uniqueToolProjection[1].turn
      : null;
    assert.ok(uniqueToolTurn);
    const uniqueToolNodes = uniqueToolTurn!.processNodes.filter(
      (node) => node.toolCallId === uniqueToolCallId
    );
    assert.equal(uniqueToolNodes.length, 1, "one toolCallId produces one process node");
    assert.equal(uniqueToolNodes[0]?.toolCallId, uniqueToolCallId);
    assert.equal(uniqueToolNodes[0]?.sourceMessageId, projectedToolMessageId,
      "the real Tool message remains the one content authority");
    assert.equal(uniqueToolTurn!.toolCount, 1, "the duplicate reasoning activity is not counted twice");
    assert.equal(
      uniqueToolMessages[1]?.reasoningSummary?.activities[0]?.id,
      duplicateToolActivityId,
      "the durable Reasoning snapshot remains unchanged"
    );

    const processOutput = [
      "{",
      "  \"status\": \"ok\",",
      "  \"note\": \"[[outputs/Result.md|结果别名]]\",",
      "  \"items\": [",
      "    \"alpha\",",
      "",
      "    \"beta\"",
      "  ]",
      "}",
      "",
      "[info] phase=done",
      "  detail: indentation stays",
      "",
      "$ printf \"done\\n\"",
      "done"
    ].join("\n");
    const processMessage = renderMessage(renderer, {
      id: "tool-1",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "生成结果",
      text: "已生成输出",
      status: "completed",
      processInputAvailability: "provided",
      processInput: "生成笔记",
      processOutputAvailability: "provided",
      processOutput,
      createdAt: 1_700_000_003_000
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(processMessage.findByClass("codex-smooth-ai-tool-call"));
    assert.ok(processMessage.findByClass("codex-smooth-ai-artifact"));
    const artifactRoot = processMessage.findByClass("codex-smooth-ai-artifact");
    assert.ok(artifactRoot);
    const outputBlocks = artifactRoot!.findAllByTag("pre");
    assert.equal(outputBlocks.length, 1, "artifact/process output stays in one preformatted block");
    assert.equal(
      renderedText(outputBlocks[0]),
      processOutput.replace("[[outputs/Result.md|结果别名]]", "Result"),
      "preformatted output preserves every non-note character and replaces only the resolved note span"
    );
    assert.equal(artifactRoot!.findAllByTag("p").length, 0, "process output must not create Markdown paragraphs");
    assert.equal(artifactRoot!.findAllByClass("codex-message-spacer").length, 0,
      "process output must not create Markdown spacers");
    const artifactLink = artifactRoot!.findByClass("codex-message-note-link");
    assert.ok(artifactLink, "artifact/process output must keep rich Vault-note rendering");
    assert.equal(artifactLink!.textContent, "Result");
    await clickRegistered(artifactLink!);

    const activeUnavailableTool = renderMessage(renderer, {
      id: "tool-active-unavailable",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待工具",
      text: "",
      status: "running",
      processContentAvailability: "unavailable",
      createdAt: 1_700_000_003_100
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(activeUnavailableTool.findByClass("codex-smooth-ai-loader"));

    const completedUnavailableTool = renderMessage(renderer, {
      id: "tool-completed-unavailable",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "工具完成",
      text: "",
      status: "completed",
      processContentAvailability: "unavailable",
      createdAt: 1_700_000_003_200
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(completedUnavailableTool.findAllByClass("codex-smooth-ai-loader").length, 0,
      "terminal unavailable output is static and never keeps spinning");

    const decisions: string[] = [];
    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "{\"relativePath\":\"projects/Alpha.md\"}",
      preview: "{\"change\":\"update\"}",
      decide: (decision: string) => {
        decisions.push(decision);
        return true;
      }
    });
    const approval = renderMessage(renderer, {
      id: "tool-waiting-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "即将运行命令",
      status: "waiting_approval",
      approval: {
        status: "pending",
        target: "{\"relativePath\":\"projects/Alpha.md\"}",
        preview: "{\"change\":\"update\"}",
        updatedAt: 1_700_000_003_300
      },
      createdAt: 1_700_000_003_300
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    const approvalRoot = approval.findByClass("codex-smooth-ai-approval-card");
    assert.ok(approvalRoot);
    assert.equal(approvalRoot!.attributes.get("data-approval-state"), "waiting_approval");
    assert.match(renderedText(approvalRoot!), /目标/u);
    assert.match(renderedText(approvalRoot!), /预览/u);
    const approveButton = approvalRoot!.findByClass("is-approve")!;
    const rejectButton = approvalRoot!.findByClass("is-reject")!;
    assert.ok(approveButton);
    assert.ok(rejectButton);
    clickElement(approveButton);
    assert.deepEqual(decisions, ["approve"]);
    assert.equal(approveButton.disabled, true);
    assert.equal(rejectButton.disabled, true);
    assert.equal(approvalRoot!.attributes.get("aria-busy"), "true");
    clickElement(rejectButton);
    assert.deepEqual(decisions, ["approve"], "the first decision disables both controls and decides once");

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => null;
    const pendingWithoutWaiter = renderMessage(renderer, {
      id: "tool-pending-without-waiter",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "恢复的等待记录",
      status: "waiting_approval",
      approval: { status: "pending", target: "Recovered.md" },
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(pendingWithoutWaiter.findByClass("codex-smooth-ai-approval-card"));
    assert.equal(pendingWithoutWaiter.findAllByClass("codex-smooth-ai-approval-button").length, 0,
      "a durable pending record without a live waiter is read-only");

    const statusOnlyApproval = renderMessage(renderer, {
      id: "tool-status-only-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "工具状态",
      text: "工具生命周期不能伪造审批记录",
      status: "denied",
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(statusOnlyApproval.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "Tool status alone never fabricates a durable Approval lifecycle");

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "Live.md",
      preview: "live waiter",
      decide: () => true
    });
    const liveFallbackApproval = renderMessage(renderer, {
      id: "tool-live-fallback-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "实时等待",
      text: "Ticket 投影刷新前的 live waiter",
      status: "running",
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(
      liveFallbackApproval.findByClass("codex-smooth-ai-approval-card")
        ?.attributes.get("data-approval-state"),
      "waiting_approval",
      "an exact live waiter is the only allowed pre-projection pending fallback"
    );
    assert.equal(liveFallbackApproval.findAllByClass("codex-smooth-ai-approval-button").length, 2);

    const staleDecisions: string[] = [];
    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "Stale.md",
      preview: "stale",
      decide: (decision: string) => {
        staleDecisions.push(decision);
        return false;
      }
    });
    const staleApproval = renderMessage(renderer, {
      id: "tool-stale-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "已失效的按钮闭包",
      status: "waiting_approval",
      approval: { status: "pending", target: "Stale.md" },
      createdAt: 1_700_000_003_302
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    const staleCard = staleApproval.findByClass("codex-smooth-ai-approval-card")!;
    const staleApprove = staleCard.findByClass("is-approve")!;
    const staleReject = staleCard.findByClass("is-reject")!;
    clickElement(staleReject);
    assert.deepEqual(staleDecisions, ["reject"]);
    assert.equal(staleCard.attributes.get("aria-busy"), "false");
    assert.equal(staleApprove.disabled, false);
    assert.equal(staleReject.disabled, false);

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => null;

    for (const state of ["approved", "denied", "cancelled", "expired"] as const) {
      const transcript = renderMessage(renderer, {
        id: `tool-approval-${state}`,
        role: "tool",
        itemType: "dynamicToolCall",
        title: "确认状态",
        text: "只读状态记录",
        status: state === "approved" ? "completed" : "denied",
        approval: { status: state, target: "Target.md", updatedAt: 1_700_000_003_302 },
        createdAt: 1_700_000_003_302
      }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
      const card = transcript.findByClass("codex-smooth-ai-approval-card");
      assert.equal(
        card?.attributes.get("data-approval-state"),
        state
      );
      assert.equal(card?.findAllByClass("codex-smooth-ai-approval-button").length, 0);
    }

    const localSourceMessage = {
      id: "answer-with-local-sources",
      role: "assistant",
      text: "基于本地资料回答。",
      status: "completed",
      citations: {
        status: "strong",
        counts: { wiki: 1, journal: 0, outputs: 1 },
        citations: [
          {
            bucket: "wiki",
            title: "Alpha 别名",
            path: "projects/Alpha.md",
            excerptLines: ["Alpha citation excerpt"],
            relevance: "strong",
            reason: "matched",
            score: 0.9
          },
          {
            bucket: "outputs",
            title: "Missing",
            path: "wiki/Missing.md",
            excerptLines: ["Missing structured excerpt"],
            relevance: "weak",
            reason: "historical",
            score: 0.4
          }
        ]
      },
      askSourceAttribution: true,
      knowledgeReferences: [
        {
          referenceId: "reference-alpha",
          vaultRelativePath: "projects/Alpha.md",
          title: "Alpha reference title",
          excerpt: "Alpha reference excerpt",
          contentRevision: `sha256:${"a".repeat(64)}`,
          lineStart: 2,
          lineEnd: 3
        },
        {
          referenceId: "reference-result",
          vaultRelativePath: "outputs/Result.md",
          title: "Result reference title",
          excerpt: "Result reference excerpt",
          contentRevision: `sha256:${"b".repeat(64)}`,
          lineStart: 5,
          lineEnd: 5
        }
      ],
      personalMemorySources: [
        { id: " memory-1 ", title: "共同记忆" },
        { id: "memory-1", title: "不应重复的同 id 记忆" },
        { id: "memory-2", title: "共同记忆" }
      ],
      knowledgeProducedPaths: ["outputs/Result.md"],
      createdAt: 1_700_000_003_400
    } as ChatMessage & {
      knowledgeProducedPaths: string[];
      knowledgeReferences: Array<{
        referenceId: string;
        vaultRelativePath: string;
        title: string;
        excerpt: string;
        contentRevision: string;
        lineStart: number;
        lineEnd: number;
      }>;
    };
    const localSourcesMessage = renderMessage(
      renderer,
      localSourceMessage,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const localSourcesRoot = localSourcesMessage.findByClass("codex-ai-elements-sources");
    assert.ok(localSourcesRoot);
    assert.equal(localSourcesMessage.findAllByClass("codex-ai-elements-sources").length, 1,
      "one message has one local document source surface");
    assert.equal(localSourcesMessage.findAllByClass("codex-smooth-ai-sources").length, 0,
      "local documents never populate SmoothUI webpage Sources");
    assert.equal(
      localSourcesRoot!.findByClass("codex-ai-elements-sources-label")?.textContent,
      "使用了 5 个文档",
      "count uses unique citations, references, and Memory ids but excludes produced paths"
    );
    const localRows = localSourcesRoot!.findAllByClass("codex-ai-elements-source");
    assert.equal(localRows.length, 5);
    assert.deepEqual(
      localRows.map((row) => row.attributes.get("data-source-key")),
      [
        "vault:projects/Alpha.md",
        "vault:wiki/Missing.md",
        "vault:outputs/Result.md",
        "memory:memory-1",
        "memory:memory-2"
      ],
      "local sources preserve first-seen structured order and stable deduplication keys"
    );
    assert.equal(localSourcesRoot!.findAllByClass("codex-ai-elements-source-icon").length, 5);
    assert.equal(localSourcesRoot!.findAllByClass("is-disabled").length, 3,
      "missing Vault path and Personal Memory stay non-clickable");
    assert.equal(localSourcesRoot!.findAllByTag("button").length, 2,
      "only currently resolvable Vault files render navigation buttons");
    assert.match(renderedText(localSourcesRoot!), /Alpha citation excerpt/u);
    assert.match(renderedText(localSourcesRoot!), /Alpha reference excerpt/u);
    assert.match(renderedText(localSourcesRoot!), /第 2-3 行/u);
    assert.match(renderedText(localSourcesRoot!), /强证据/u);
    assert.ok(localSourcesMessage.findByClass("codex-knowledge-produced-artifact"),
      "generated paths remain a separate artifact surface");
    localSourcesRoot!.findAllByTag("button")[0].onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);
    await Promise.resolve();

    const emptyAttributionMessage = renderMessage(renderer, {
      id: "answer-with-empty-attribution",
      role: "assistant",
      text: "没有本地依据。",
      status: "completed",
      citations: {
        status: "none",
        counts: { wiki: 0, journal: 0, outputs: 0 },
        citations: []
      },
      askSourceAttribution: true,
      personalMemorySources: [],
      createdAt: 1_700_000_003_500
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(emptyAttributionMessage.findAllByClass("codex-ai-elements-sources").length, 0);
    assert.match(renderedText(emptyAttributionMessage), /不会显示伪来源/u);
    assert.doesNotMatch(renderedText(emptyAttributionMessage), /使用了 0 个文档/u);

    const diffMessage = renderMessage(renderer, {
      id: "file-change-diff",
      role: "tool",
      itemType: "fileChange",
      title: "编辑 Alpha",
      text: "@@ -1,1 +1,2 @@\n-old\n+\n+new",
      status: "completed",
      diffSummary: {
        totalFiles: 1,
        added: 2,
        removed: 1,
        files: [{
          path: "projects/Alpha.md",
          kind: "update",
          added: 2,
          removed: 1
        }]
      },
      createdAt: 1_700_000_003_600
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(diffMessage.findByClass("codex-smooth-ai-diff"));
    const diffContent = diffMessage.findAllByClass("codex-diff-content").map((line) => line.textContent);
    assert.ok(diffContent.includes(""), "an actually empty added line stays an empty string");
    assert.equal(diffContent.includes(" "), false, "diff rendering never substitutes fake whitespace");
    assert.match(renderedText(diffMessage), /\+2/u);
    assert.match(renderedText(diffMessage), /-1/u);

    const nonDiffFileChange = renderMessage(renderer, {
      id: "file-change-plain-text",
      role: "tool",
      itemType: "fileChange",
      title: "文件改动摘要",
      text: "plain text without a parseable diff",
      status: "completed",
      diffSummary: {
        totalFiles: 1,
        added: 0,
        removed: 0,
        files: [{
          path: "projects/Alpha.md",
          kind: "update",
          added: 0,
          removed: 0
        }]
      },
      createdAt: 1_700_000_003_700
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(nonDiffFileChange.findAllByClass("codex-smooth-ai-diff").length, 0,
      "diffSummary alone cannot turn plain text into an AI Diff");
    assert.match(renderedText(nonDiffFileChange), /plain text without a parseable diff/u);

    const planMessage = renderMessage(renderer, {
      id: "plan-1",
      role: "assistant",
      itemType: "taskPlan",
      text: "",
      taskPlan: {
        schemaVersion: 1,
        planId: "plan-1",
        title: "真实计划",
        status: "in_progress",
        version: 1,
        steps: [{ stepId: "step-1", text: "完成界面", status: "in_progress" }],
        currentStepId: "step-1",
        source: "agent",
        createdAt: 1_700_000_004_000,
        updatedAt: 1_700_000_004_000
      },
      createdAt: 1_700_000_004_000
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.ok(planMessage.findByClass("codex-ai-elements-task"));
    assert.equal(planMessage.findAllByClass("codex-smooth-ai-task-list").length, 0);
    assert.equal(planMessage.findAllByTag("button").length, 0,
      "the durable history Task is read-only");

    const userRow = renderMessage(renderer, siblingMessages[0]!, {
      showAgentFooter: false,
      showAgentHeader: false
    });
    const assistantTurnSurface = new FakeElement("div");
    (renderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof unifiedTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(assistantTurnSurface, unifiedTurn!, false);
    const assistantTurnRoot = assistantTurnSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.equal(assistantTurnRoot.attributes.get("data-bubble"), "false");
    assert.equal(assistantTurnSurface.findAllByClass("codex-message-type-assistantTurn").length, 1);
    assert.equal(assistantTurnRoot.findAllByClass("codex-assistant-turn-spine").length, 1);
    assert.equal(
      assistantTurnRoot.findByClass("codex-assistant-turn-process")?.open,
      false,
      "a terminal process spine is collapsed to one summary row"
    );
    assert.equal(
      assistantTurnRoot.findByClass("codex-assistant-turn-summary-copy")?.textContent,
      "处理完成 · 7 个步骤 · 2 个工具 · 8s"
    );
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-node").some((node) => node.hasClass("is-current")),
      false,
      "a completed Assistant Turn has no animated current node"
    );
    assert.ok(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-node").some((node) => node.hasClass("is-completed")),
      "completed nodes retain their low-contrast status class"
    );
    const primaryLabels = new Set(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-section-primary")
        .map((label) => label.textContent)
    );
    const secondaryLabels = new Set(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-section-secondary")
        .map((label) => label.textContent)
    );
    assert.deepEqual(primaryLabels, new Set(["处理过程", "模型推理", "执行动作", "最终回答"]));
    assert.deepEqual(secondaryLabels, new Set());

    for (const componentClass of [
      "codex-smooth-ai-tool-call",
      "codex-assistant-turn-task-summary",
      "codex-ai-elements-sources",
      "codex-smooth-ai-reasoning",
      "codex-smooth-ai-response"
    ]) {
      assert.ok(assistantTurnRoot.findByClass(componentClass),
        `${componentClass} stays inside the one Assistant Turn`);
    }
    assert.match(renderedText(assistantTurnRoot), /已批准一次性写入/u,
      "resolved interaction leaves one compact process record");
    assert.equal(assistantTurnRoot.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "resolved Confirmation does not leave an interactive approval card in history");

    const unifiedLedgers = assistantTurnRoot.findAllByClass(
      "codex-assistant-turn-action-ledger"
    );
    assert.equal(unifiedLedgers.length, 2,
      "Task and Sources keep the two chronological Action ledger groups separated");
    assert.deepEqual(
      unifiedLedgers.map((ledger) =>
        ledger.findByClass("codex-assistant-turn-action-ledger-summary")?.textContent
      ),
      ["调用 1", "编辑 1"]
    );
    const unifiedActions = assistantTurnRoot.findAllByClass("codex-action-item");
    assert.equal(unifiedActions.length, 2);
    assert.equal(
      unifiedActions.find((action) => action.dataset.messageId === "tool-separated")
        ?.findByClass("codex-action-item-title")?.textContent,
      "vault_search",
      "persisted Tool chrome is stripped so the Chinese action row keeps only the raw tool name"
    );
    assert.ok(unifiedActions.every((action) => action.closest(".codex-assistant-turn-node") === null),
      "an Action row is not wrapped in a second titled process node");
    assert.ok(unifiedActions.every((action) =>
      action.findAllByClass("codex-smooth-ai-tool-status").length === 1
    ), "each collapsed Action owns one status icon");
    assert.equal(assistantTurnRoot.findAllByClass("codex-action-item-time").length, 0,
      "message clock time is never presented as Tool duration");
    assert.equal(assistantTurnRoot.findAllByClass("codex-action-item-detail").length, 0,
      "Tool details and error copy are not repeated as a collapsed second title");
    assert.ok(assistantTurnRoot.findAllByClass("codex-action-item-expandable")
      .every((action) => !action.open), "Action rows start collapsed");
    for (const action of assistantTurnRoot.findAllByClass("codex-action-item-expandable")) {
      action.open = true;
      action.ontoggle?.({ isTrusted: false });
    }
    assert.ok(assistantTurnRoot.findByClass("codex-smooth-ai-diff"),
      "expanded Diff stays reachable inside the one Assistant Turn");
    const providerReasoningDom = assistantTurnRoot.findByClass(
      "codex-smooth-ai-reasoning"
    )!;
    assert.match(renderedText(providerReasoningDom), new RegExp(siblingCanaries.publicReasoning, "u"));
    const visibleTurnCanaries = [
      siblingCanaries.answer,
      siblingCanaries.toolArgument,
      siblingCanaries.toolResult,
      siblingCanaries.sourceData,
      siblingCanaries.diffContent,
      siblingCanaries.publicReasoning
    ];
    for (const canary of visibleTurnCanaries) {
      assert.match(renderedText(assistantTurnRoot), new RegExp(canary, "u"),
        `${canary} remains reachable inside the unified Assistant Turn`);
    }
    assert.match(renderedText(userRow), new RegExp(siblingCanaries.prompt, "u"));
    assert.doesNotMatch(renderedText(assistantTurnRoot), new RegExp(siblingCanaries.prompt, "u"),
      "the user prompt remains outside the Assistant Turn");
    for (const canary of [
      siblingCanaries.prompt,
      siblingCanaries.answer,
      siblingCanaries.toolArgument,
      siblingCanaries.toolResult,
      siblingCanaries.sourceData,
      siblingCanaries.diffContent,
      siblingCanaries.approvalPayload,
      siblingCanaries.privateReasoning
    ]) {
      assert.doesNotMatch(
        JSON.stringify(reasoningSibling.reasoningSummary),
        new RegExp(canary, "u"),
        `Reasoning snapshot excludes ${canary}`
      );
      assert.doesNotMatch(reasoningSibling.text, new RegExp(canary, "u"),
        `Reasoning message text excludes ${canary}`);
      assert.doesNotMatch(renderedText(providerReasoningDom), new RegExp(canary, "u"),
        `Provider Reasoning DOM excludes unrelated or private ${canary}`);
    }
    assert.doesNotMatch(
      renderedText(assistantTurnRoot),
      new RegExp(siblingCanaries.privateReasoning, "u"),
      "private reasoning canary is never rendered anywhere"
    );
    assert.doesNotMatch(
      renderedText(assistantTurnRoot),
      new RegExp(siblingCanaries.approvalPayload, "u"),
      "resolved Confirmation history does not expose its live approval payload"
    );

    const approvalTurnProjection = buildAgentTurnProjection([{
      id: "approval-ledger-user",
      role: "user",
      text: "更新根目录文件",
      runId: "run-approval-ledger",
      turnId: "run-approval-ledger",
      createdAt: 2_900
    }, approvalProjectionMessage]);
    const approvalTurn = approvalTurnProjection[1]?.kind === "assistantTurn"
      ? approvalTurnProjection[1].turn
      : null;
    assert.ok(approvalTurn);
    const approvalTurnSurface = new FakeElement("div");
    (renderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof approvalTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(approvalTurnSurface, approvalTurn!, false);
    const approvalTurnRoot = approvalTurnSurface.findByClass(
      "codex-message-type-assistantTurn"
    )!;
    assert.equal(approvalTurnRoot.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "Approval preview remains inside its Tool Action instead of a sibling card");
    assert.equal(
      approvalTurnRoot.findByClass("codex-assistant-turn-action-ledger-summary")?.textContent,
      "调用 1"
    );
    assert.deepEqual(
      approvalTurnRoot.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );
    const approvalAction = approvalTurnRoot.findByClass("codex-action-item-expandable")!;
    assert.equal(approvalAction.open, false);
    approvalAction.open = true;
    approvalAction.ontoggle?.({ isTrusted: false });
    assert.ok(approvalAction.findByClass("codex-smooth-ai-diff"),
      "the expanded Approval Tool exposes the structured preview Diff");
    assert.match(renderedText(approvalAction), /Foo\.md/u);
    assert.match(renderedText(approvalAction), /new/u);

    const reopenedRenderer = new CodexMessageListRenderer();
    bindRenderer(reopenedRenderer, context);
    const reopenedApprovalSurface = new FakeElement("div");
    (reopenedRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof approvalTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(reopenedApprovalSurface, approvalTurn!, false);
    assert.equal(
      reopenedApprovalSurface.findByClass("codex-action-item-expandable")?.open,
      false,
      "reopening a durable Tool rebuilds the same collapsed Action without stale disclosure state"
    );
    assert.deepEqual(
      reopenedApprovalSurface.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );

    const failedToolError = "FAILED_TOOL_ERROR_ONLY_IN_DETAILS";
    const ledgerMessages: ChatMessage[] = [{
      id: "ledger-user",
      role: "user",
      text: "处理 Foo.md",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 1_000
    }, {
      id: "ledger-read",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "view",
      title: "read",
      text: "old",
      processInput: "Foo.md",
      processOutput: "old",
      processInputAvailability: "provided",
      processOutputAvailability: "provided",
      files: [{
        name: "Foo.md",
        path: "Foo.md",
        displayPath: "Foo.md",
        kind: "vault",
        openable: true
      }],
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 2_000,
      completedAt: 3_250
    }, {
      id: "ledger-edit",
      role: "tool",
      itemType: "fileChange",
      processKind: "edit",
      title: "file change",
      text: approvalDiff,
      diffSummary: {
        totalFiles: 1,
        added: 1,
        removed: 1,
        files: [{ path: "Foo.md", kind: "update", added: 1, removed: 1 }]
      },
      files: [{
        name: "Foo.md",
        path: "Foo.md",
        displayPath: "Foo.md",
        kind: "vault",
        openable: true
      }],
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 3_300,
      completedAt: 4_300
    }, {
      id: "ledger-task",
      role: "assistant",
      itemType: "taskPlan",
      text: "",
      taskPlan: {
        schemaVersion: 1,
        planId: "ledger-plan",
        title: "账本任务",
        status: "completed",
        version: 1,
        steps: [{ stepId: "ledger-step", text: "核对结果", status: "completed" }],
        source: "agent",
        productRunId: "run-compact-ledger",
        createdAt: 4_400,
        updatedAt: 4_400
      },
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 4_400,
      completedAt: 4_400
    }, {
      id: "ledger-failed-tool",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "tool",
      title: "danger_tool",
      details: failedToolError,
      text: failedToolError,
      processInput: "{\"path\":\"Foo.md\"}",
      processOutput: failedToolError,
      processInputAvailability: "provided",
      processOutputAvailability: "provided",
      status: "failed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 4_500,
      completedAt: 5_000
    }, {
      id: "ledger-answer",
      role: "assistant",
      text: "已报告失败",
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 5_100,
      completedAt: 5_200
    }];
    const ledgerProjection = buildAgentTurnProjection(ledgerMessages);
    const ledgerTurn = ledgerProjection[1]?.kind === "assistantTurn"
      ? ledgerProjection[1].turn
      : null;
    assert.ok(ledgerTurn);
    const ledgerSurface = new FakeElement("div");
    const ledgerRenderer = new CodexMessageListRenderer();
    bindRenderer(ledgerRenderer, context);
    (ledgerRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof ledgerTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(ledgerSurface, ledgerTurn!, false);
    const ledgerRoot = ledgerSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.deepEqual(
      ledgerRoot.findAllByClass("codex-assistant-turn-action-ledger-summary")
        .map((summary) => summary.textContent),
      ["读取 1 · 编辑 1", "调用 1"],
      "adjacent actions aggregate once while Task preserves the chronological break"
    );
    const ledgerActions = ledgerRoot.findAllByClass("codex-action-item");
    assert.equal(ledgerActions.length, 3);
    assert.deepEqual(
      ledgerRoot.findAllByClass("codex-action-item-duration")
        .map((duration) => duration.textContent.trim()),
      ["1.3s", "1s", "500ms"]
    );
    const readAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-read"
    )!;
    assert.equal(readAction.findByClass("codex-action-item-file")?.attributes.get("title"), "Foo.md");
    const editAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-edit"
    )!;
    assert.deepEqual(
      editAction.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );
    const failedAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-failed-tool"
    )!;
    assert.equal(failedAction.open, false);
    assert.doesNotMatch(renderedText(failedAction), new RegExp(failedToolError, "u"),
      "the collapsed failed row does not repeat its error as a second title");
    assert.equal(renderedText(failedAction).match(/失败/gu)?.length, 1,
      "the failed state is expressed once in the collapsed action copy");
    failedAction.open = true;
    failedAction.ontoggle?.({ isTrusted: false });
    assert.match(renderedText(failedAction), new RegExp(failedToolError, "u"),
      "the original backend error remains reachable after expansion");

    const sourcedToolProjection = buildAgentTurnProjection([{
      id: "sourced-tool-user",
      role: "user",
      text: "检索来源",
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_000
    }, {
      id: "sourced-tool",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "search",
      title: "vault_search",
      text: "matched",
      status: "completed",
      citations: {
        status: "strong",
        counts: { wiki: 1, journal: 0, outputs: 0 },
        citations: [{
          bucket: "wiki",
          title: "Foo",
          path: "Foo.md",
          excerptLines: ["matched"],
          relevance: "strong",
          reason: "matched",
          score: 1
        }]
      },
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_100,
      completedAt: 6_200
    }, {
      id: "sourced-tool-answer",
      role: "assistant",
      text: "找到来源",
      status: "completed",
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_300,
      completedAt: 6_400
    }]);
    const sourcedToolTurn = sourcedToolProjection[1]?.kind === "assistantTurn"
      ? sourcedToolProjection[1].turn
      : null;
    assert.ok(sourcedToolTurn);
    const sourcedToolSurface = new FakeElement("div");
    (ledgerRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof sourcedToolTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(sourcedToolSurface, sourcedToolTurn!, false);
    assert.equal(sourcedToolSurface.findAllByClass("codex-action-item").length, 1);
    assert.equal(sourcedToolSurface.findAllByClass("codex-ai-elements-sources").length, 1,
      "a Sources node derived from the same Tool message keeps its own chronological projection");

    const englishProjection = buildAgentTurnProjection(siblingMessages, "en");
    const englishTurn = englishProjection[1]?.kind === "assistantTurn"
      ? englishProjection[1].turn
      : null;
    assert.ok(englishTurn, "the English projection retains the unified Assistant Turn");
    const englishRenderer = new CodexMessageListRenderer();
    bindRenderer(englishRenderer, context, "en");
    const englishSurface = new FakeElement("div");
    (englishRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof englishTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(englishSurface, englishTurn!, false);
    const englishRoot = englishSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.equal(
      englishRoot.findByClass("codex-assistant-turn-summary-copy")?.textContent,
      "Completed · 7 steps · 2 tools · 8s"
    );
    assert.deepEqual(
      new Set(
        englishRoot.findAllByClass("codex-assistant-turn-section-primary")
          .map((label) => label.textContent)
      ),
      new Set(["Process", "Reasoning", "Tools & Sources", "Final Answer"])
    );
    assert.deepEqual(
      new Set(
        englishRoot.findAllByClass("codex-assistant-turn-section-secondary")
          .map((label) => label.textContent)
      ),
      new Set()
    );
    assert.ok(
      englishRoot.findAllByClass("codex-ai-elements-sources-label")
        .some((label) => label.textContent === "Used 1 document"),
      "English source chrome uses the Turn's single-source count"
    );
    assert.match(renderedText(englishRoot), /Public reasoning · 2s/u);
    assert.match(renderedText(englishRoot), /Called/u);
    assert.equal(
      englishRoot.findAllByClass("codex-action-item")
        .find((action) => action.dataset.messageId === "tool-separated")
        ?.findByClass("codex-action-item-title")?.textContent,
      "vault_search",
      "English action chrome strips a persisted Chinese Tool prefix without rewriting the tool name"
    );
    assert.doesNotMatch(renderedText(englishRoot), /使用工具/u,
      "English action chrome does not inherit the persisted Chinese Tool prefix");
    assert.deepEqual(
      englishRoot.findAllByClass("codex-assistant-turn-action-ledger-summary")
        .map((summary) => summary.textContent),
      ["Calls 1", "Edits 1"],
      "English Tool ledgers use one English-only dynamic summary"
    );
    assert.ok(
      englishRoot.findAllByClass("codex-action-item-head")
        .some((head) => head.attributes.get("title") === "View tool details"),
      "English action details expose English accessible chrome"
    );
    assert.ok(
      englishRoot.findAllByClass("codex-assistant-turn-node-marker")
        .every((marker) => marker.attributes.get("title") === "Completed"),
      "English terminal node status ARIA stays English"
    );
    for (const action of englishRoot.findAllByClass("codex-action-item-expandable")) {
      action.open = true;
      action.ontoggle?.({ isTrusted: false });
    }
    for (const canary of visibleTurnCanaries) {
      assert.match(renderedText(englishRoot), new RegExp(canary, "u"),
        `${canary} remains byte-for-byte visible in the English Turn`);
    }
    assert.doesNotMatch(
      renderedText(englishRoot),
      new RegExp(siblingCanaries.privateReasoning, "u"),
      "the English Turn does not expose private reasoning"
    );
  } finally {
    if (previousDocument === undefined) delete (globalThis as unknown as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    if (previousHTMLElement === undefined) delete (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
    else Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }

  assert.deepEqual(context.openedPaths, [
    "projects/Alpha.md",
    "outputs/Result.md",
    "projects/Alpha.md"
  ]);

  const styles = readFileSync("styles.css", "utf8");
  assert.match(styles, /filter:\s*blur\(6px\)/u);
  assert.match(styles, /opacity:\s*0;/u);
  assert.match(styles, /transform:\s*translateY\(10px\)/u);
  assert.match(styles, /codex-smooth-blur-out-up 560ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.codex-smooth-blur-out-up-unit \{[\s\S]*?animation:\s*none;/u);
  assert.match(styles, /\.codex-message-note-link \{[\s\S]*?font-weight:\s*400;/u);
  assert.match(styles, /\.codex-message-note-link \{[\s\S]*?background:\s*color-mix/u);
  assert.match(styles, /\.codex-ai-elements-sources-trigger \{/u);
  assert.match(styles, /\.codex-ai-elements-source-icon[\s\S]*?width:\s*16px;/u);
  assert.match(styles, /\.codex-ai-elements-source-title[\s\S]*?font-weight:\s*400;/u);
  assert.match(styles, /--echoink-conversation-font-label-primary:\s*var\(--font-ui-small, 13px\);/u);
  assert.match(styles, /--echoink-conversation-font-label-secondary:\s*var\(--font-ui-smaller, 12px\);/u);
  assert.match(styles, /--echoink-conversation-font-status:\s*var\(--font-ui-small, 13px\);/u);
  assert.match(styles, /--echoink-conversation-font-caption:\s*var\(--echoink-conversation-font-status\);/u);
  assert.match(styles, /--echoink-conversation-line-label:\s*1\.4;/u);
  assert.match(styles, /--echoink-conversation-line-status:\s*1\.4;/u);
  assert.match(styles, /--echoink-conversation-line-caption:\s*var\(--echoink-conversation-line-status\);/u);
  assert.match(styles, /--echoink-conversation-line-body:\s*1\.55;/u);
  assert.match(styles, /--echoink-conversation-radius-md:\s*var\(--radius-m, 8px\);/u);
  assert.match(styles, /\.codex-message-type-assistantTurn\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/u);
  assert.match(styles, /\.codex-assistant-turn-spine::before\s*\{[\s\S]*?width:\s*1px;/u);
  assert.match(styles, /\.codex-assistant-turn-node\.is-completed,[\s\S]*?opacity:\s*0\.66;/u);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*no-preference\)[\s\S]*?\.codex-assistant-turn-node\.is-current[\s\S]*?codex-assistant-turn-current/u);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.codex-assistant-turn-node\.is-current[\s\S]*?animation:\s*none;/u);
  assert.match(styles, /\.codex-assistant-turn-section-secondary\s*\{[\s\S]*?font-weight:\s*400;/u);
  assert.match(styles, /\.codex-assistant-turn-section-label\s*\{[\s\S]*?font-size:\s*var\(--echoink-conversation-font-label-primary\);/u);
  assert.match(styles, /\.codex-assistant-turn-section-secondary\s*\{[\s\S]*?font-size:\s*var\(--echoink-conversation-font-label-secondary\);/u);
  assert.match(styles, /\.codex-assistant-turn-summary-copy\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums;[\s\S]*?text-wrap:\s*pretty;/u);
  assert.match(styles, /\.codex-assistant-turn-answer\s*\{[\s\S]*?max-width:\s*min\(72ch, 100%\);[\s\S]*?overflow-wrap:\s*anywhere;/u);
  assert.match(styles, /\.codex-assistant-turn-action-ledger-summary\s*\{[\s\S]*?font-weight:\s*400;[\s\S]*?font-variant-numeric:\s*tabular-nums;[\s\S]*?text-wrap:\s*pretty;/u);
  assert.match(styles, /\.codex-assistant-turn-action-node\.is-success\s*\{[\s\S]*?opacity:\s*0\.66;/u);
  assert.match(styles, /\.codex-assistant-turn-action-ledger \.codex-action-item-main\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?font-size:\s*var\(--echoink-conversation-font-body\);[\s\S]*?line-height:\s*var\(--echoink-conversation-line-body\);/u);
  assert.match(styles, /\.codex-assistant-turn-action-ledger \.codex-action-item-duration,[\s\S]*?font-variant-numeric:\s*tabular-nums;/u);
  assert.match(styles, /\.codex-assistant-turn-action-ledger[\s\S]*?\.codex-process-file-text\.codex-action-item-file\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?text-overflow:\s*clip;[\s\S]*?white-space:\s*normal;/u);
  assert.match(styles, /\.codex-assistant-turn-action-node > \.codex-action-item-head:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--echoink-conversation-focus\);/u);
  assert.match(styles, /details\.codex-action-item\.codex-smooth-ai-tool-call:not\(\[open\]\)[\s\S]*?border:\s*0;/u);
  assert.match(styles, /details\.codex-action-item\.codex-smooth-ai-tool-call\[open\][\s\S]*?border:\s*1px solid var\(--background-modifier-border\);/u);
  assert.match(styles, /\.codex-assistant-turn-action-node\[open\] \.codex-smooth-ai-artifact,[\s\S]*?\.codex-assistant-turn-resource\[open\] \.codex-diff-files\s*\{[\s\S]*?border:\s*0;/u);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*no-preference\)[\s\S]*?\.codex-assistant-turn-action-node\.is-current[\s\S]*?codex-smooth-tool-ring/u);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.codex-assistant-turn-action-node\.is-current[\s\S]*?animation:\s*none;/u);
  assert.match(styles, /\.codex-assistant-turn-resource\s*\{[\s\S]*?border:\s*0;/u);
  assert.match(styles, /\.codex-assistant-turn-resource\[open\]\s*\{[\s\S]*?border:\s*1px solid var\(--background-modifier-border\);/u);
  assert.match(styles, /\.codex-interaction-progress\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums;/u);
  assert.match(styles, /\.codex-interaction-heading-secondary\s*\{[\s\S]*?font-weight:\s*400;/u);

  const helperSource = readFileSync("src/ui/codex-view/smooth-chat-ui.ts", "utf8");
  assert.doesNotMatch(helperSource, /from\s+["'](?:react|motion\/react|tailwindcss|lucide-react|@radix-ui\/react-collapsible)["']/u);
  const messageListSource = readFileSync("src/ui/codex-view/message-list.ts", "utf8");
  assert.doesNotMatch(messageListSource, /markSmoothAISources\(/u,
    "no local business data may populate the reserved SmoothUI webpage Sources primitive");
  const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
  const headerSource = readFileSync("src/ui/codex-view/header-controller.ts", "utf8");
  const messageControllerSource = readFileSync("src/ui/codex-view/message-controller.ts", "utf8");
  const viewShellSource = readFileSync("src/ui/codex-view/view-shell.ts", "utf8");
  assert.match(composerSource, /placeholder:\s*""/u);
  assert.match(headerSource, /setAttr\("placeholder",\s*""\)/u);
  assert.match(messageControllerSource, /onSuggestionSelect:[\s\S]*?dispatchEvent\(new Event\("input"[\s\S]*?inputEl\.focus\(\)/u);
  assert.doesNotMatch(
    messageControllerSource.match(/onSuggestionSelect:[\s\S]*?\n\s*\},/u)?.[0] ?? "",
    /sendMessage|onSend/u,
    "suggestion selection must not enter the send chain"
  );
  assert.match(
    viewShellSource,
    /host\.messagesEl[\s\S]*?host\.taskPlanDockEl[\s\S]*?host\.interactionDockEl[\s\S]*?renderComposerShell/u,
    "the Task and Interaction docks stay outside the message scroller immediately above the composer"
  );
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  assert.match(notices, /Copyright \(c\) 2024 Eduardo Calvo/u);
  assert.match(notices, /Blur Out Up.*AI Message.*AI Reasoning.*AI Tool Call.*AI Artifact.*AI Task List/su);
  assert.match(notices, /## Vercel AI Elements[\s\S]*?6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/u);
  assert.match(notices, /Vercel AI Elements[\s\S]*?`Task`[\s\S]*?task\.tsx/u);
  assert.match(notices, /Vercel AI Elements[\s\S]*?`Question`[\s\S]*?`Confirmation`[\s\S]*?`Attachments`/u);
  assert.match(notices, /question\.tsx[\s\S]*?confirmation\.tsx[\s\S]*?attachments\.tsx/u);
  assert.match(notices, /Copyright 2023 Vercel, Inc\.[\s\S]*?Apache License, Version 2\.0/u);
  assert.match(notices, /## AnimateIcons[\s\S]*?`Send Horizontal`[\s\S]*?`Circle Stop`/u);
  assert.match(notices, /send-horizontal-icon\.tsx[\s\S]*?circle-stop-icon\.tsx/u);
  assert.match(notices, /Copyright \(c\) 2025 Avijit Dey/u);

  console.log("PASS conversation-ui: one Assistant Turn, structured interaction Dock, durable Attachments, and truthful Provider Reasoning");
}
