import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TFile } from "obsidian";
import type { ChatMessage } from "../settings/settings";
import { renderRichText } from "../ui/render-message";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import {
  createSmoothAIArtifact,
  createSmoothAIReasoning,
  markSmoothAITaskList,
  markSmoothAIToolCall,
  renderSmoothBlurOutUp,
  SMOOTH_BLUR_OUT_UP_DURATION_MS,
  SMOOTH_BLUR_OUT_UP_EASING,
  SMOOTH_BLUR_OUT_UP_STAGGER_MS
} from "../ui/codex-view/smooth-chat-ui";

type TestEventHandler = (event: {
  preventDefault(): void;
  stopPropagation(): void;
}) => unknown;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestEventHandler>();
  children: FakeElement[] = [];
  className = "";
  disabled = false;
  open = false;
  parent: FakeElement | null = null;
  textContent = "";
  onclick: ((event: never) => unknown) | null = null;
  onkeydown: ((event: never) => unknown) | null = null;
  ontoggle: (() => unknown) | null = null;

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
    if (options.text !== undefined) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, value);
    }
    this.children.push(child);
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
    }
  }

  appendText(text: string): void {
    this.textContent += text;
  }

  empty(): void {
    this.children = [];
    this.textContent = "";
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  setText(text: string): void {
    this.textContent = text;
  }

  addClass(cls: string): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    classes.add(cls);
    this.className = [...classes].join(" ");
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
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
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
}

interface TestContext {
  app: unknown;
  component: unknown;
  openedPaths: string[];
}

function createTestContext(): TestContext {
  const files = new Map([
    ["projects/Alpha.md", new TFile("projects/Alpha.md")],
    ["outputs/Result.md", new TFile("outputs/Result.md")]
  ]);
  const openedPaths: string[] = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => "/test-vault" },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getResourcePath: (file: TFile) => file.path
    },
    metadataCache: {
      getFirstLinkpathDest: () => null
    },
    workspace: {
      getLeaf: (kind: string) => {
        assert.equal(kind, "tab", "note links must use Obsidian internal tab navigation");
        return {
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

function bindRenderer(renderer: CodexMessageListRenderer, context: TestContext): void {
  (renderer as unknown as { env: unknown }).env = {
    app: context.app,
    component: context.component,
    messagesEl: new FakeElement("div"),
    virtualListEl: new FakeElement("div"),
    sessionId: "smooth-ui-test",
    welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
    settingsLanguage: "zh",
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

export async function runSmoothConversationUiTests(): Promise<void> {
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

  const context = createTestContext();
  const renderer = new CodexMessageListRenderer();
  bindRenderer(renderer, context);
  const previousDocument = (globalThis as unknown as { document?: unknown }).document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElementNS: (_namespace: string, tag: string) => new FakeElement(tag)
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
    const normalLink = answer.findByClass("codex-message-note-link");
    assert.ok(normalLink);
    assert.equal(normalLink!.textContent, "Alpha", "resolved links display the note name, not aliases or paths");
    assert.equal(normalLink!.attributes.get("data-path"), "projects/Alpha.md");
    assert.equal(normalLink!.attributes.get("aria-label"), "打开笔记 Alpha");
    await clickRegistered(normalLink!);

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
      processOutput: "已生成 [[outputs/Result.md|结果别名]]",
      createdAt: 1_700_000_003_000
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(processMessage.findByClass("codex-smooth-ai-tool-call"));
    assert.ok(processMessage.findByClass("codex-smooth-ai-artifact"));
    const artifactLink = processMessage.findByClass("codex-message-note-link");
    assert.ok(artifactLink, "artifact/process output must keep rich Vault-note rendering");
    assert.equal(artifactLink!.textContent, "Result");
    await clickRegistered(artifactLink!);

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
    assert.ok(planMessage.findByClass("codex-smooth-ai-task-list"));
  } finally {
    if (previousDocument === undefined) delete (globalThis as unknown as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }

  assert.deepEqual(context.openedPaths, ["projects/Alpha.md", "outputs/Result.md"]);

  const styles = readFileSync("styles.css", "utf8");
  assert.match(styles, /filter:\s*blur\(6px\)/u);
  assert.match(styles, /opacity:\s*0;/u);
  assert.match(styles, /transform:\s*translateY\(10px\)/u);
  assert.match(styles, /codex-smooth-blur-out-up 560ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.codex-smooth-blur-out-up-unit \{[\s\S]*?animation:\s*none;/u);
  assert.match(styles, /\.codex-message-note-link \{[\s\S]*?font-weight:\s*400;/u);
  assert.match(styles, /\.codex-message-note-link \{[\s\S]*?background:\s*color-mix/u);

  const helperSource = readFileSync("src/ui/codex-view/smooth-chat-ui.ts", "utf8");
  assert.doesNotMatch(helperSource, /from\s+["'](?:react|motion\/react|tailwindcss|lucide-react)["']/u);
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  assert.match(notices, /Copyright \(c\) 2024 Eduardo Calvo/u);
  assert.match(notices, /Blur Out Up.*AI Message.*AI Reasoning.*AI Tool Call.*AI Artifact.*AI Task List/su);

  console.log("PASS conversation-ui: SmoothUI native patterns, retained chrome, and Vault-note navigation");
}
