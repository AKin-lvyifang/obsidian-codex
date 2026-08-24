import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TFile } from "obsidian";
import type { ChatMessage } from "../settings/settings";
import { renderRichText } from "../ui/render-message";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
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

type TestEventHandler = (event: {
  preventDefault(): void;
  stopPropagation(): void;
}) => unknown;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestEventHandler>();
  children: FakeElement[] = [];
  content: Array<string | FakeElement> = [];
  className = "";
  clientHeight = 640;
  clientWidth = 420;
  disabled = false;
  open = false;
  parent: FakeElement | null = null;
  scrollHeight = 640;
  scrollTop = 0;
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
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  }

  setCssStyles(_styles: Record<string, string>): void {}

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

function clickElement(element: FakeElement): void {
  element.onclick?.({
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as never);
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
    assert.ok(answer.findByClass("codex-smooth-ai-response"));
    assert.equal(answer.findAllByClass("codex-smooth-ai-response-caret").length, 0,
      "completed answers do not retain a streaming caret");
    const normalLink = answer.findByClass("codex-message-note-link");
    assert.ok(normalLink);
    assert.equal(normalLink!.textContent, "Alpha", "resolved links display the note name, not aliases or paths");
    assert.equal(normalLink!.attributes.get("data-path"), "projects/Alpha.md");
    assert.equal(normalLink!.attributes.get("aria-label"), "打开笔记 Alpha");
    await clickRegistered(normalLink!);

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
      "Used 5 documents",
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
    assert.doesNotMatch(renderedText(emptyAttributionMessage), /Used 0 documents/u);

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
    assert.ok(planMessage.findByClass("codex-smooth-ai-task-list"));
  } finally {
    if (previousDocument === undefined) delete (globalThis as unknown as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
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

  const helperSource = readFileSync("src/ui/codex-view/smooth-chat-ui.ts", "utf8");
  assert.doesNotMatch(helperSource, /from\s+["'](?:react|motion\/react|tailwindcss|lucide-react|@radix-ui\/react-collapsible)["']/u);
  const messageListSource = readFileSync("src/ui/codex-view/message-list.ts", "utf8");
  assert.doesNotMatch(messageListSource, /markSmoothAISources\(/u,
    "no local business data may populate the reserved SmoothUI webpage Sources primitive");
  const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
  const headerSource = readFileSync("src/ui/codex-view/header-controller.ts", "utf8");
  const messageControllerSource = readFileSync("src/ui/codex-view/message-controller.ts", "utf8");
  assert.match(composerSource, /placeholder:\s*""/u);
  assert.match(headerSource, /setAttr\("placeholder",\s*""\)/u);
  assert.match(messageControllerSource, /onSuggestionSelect:[\s\S]*?dispatchEvent\(new Event\("input"[\s\S]*?inputEl\.focus\(\)/u);
  assert.doesNotMatch(
    messageControllerSource.match(/onSuggestionSelect:[\s\S]*?\n\s*\},/u)?.[0] ?? "",
    /sendMessage|onSend/u,
    "suggestion selection must not enter the send chain"
  );
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  assert.match(notices, /Copyright \(c\) 2024 Eduardo Calvo/u);
  assert.match(notices, /Blur Out Up.*AI Message.*AI Reasoning.*AI Tool Call.*AI Artifact.*AI Task List/su);
  assert.match(notices, /## Vercel AI Elements[\s\S]*?6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/u);
  assert.match(notices, /Copyright 2023 Vercel, Inc\.[\s\S]*?Apache License, Version 2\.0/u);

  console.log("PASS conversation-ui: truthful SmoothUI and AI Elements sources, retained chrome, and Vault-note navigation");
}
