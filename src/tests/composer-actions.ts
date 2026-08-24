import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composerAttachmentImageSrc,
  renderComposerAttachments,
  renderComposerToolbar,
  type ComposerToolbarCallbacks,
  type ComposerToolbarState
} from "../ui/codex-view/composer";
import {
  composerModelMenuState,
  composerProviderModelOptions,
  selectComposerModel
} from "../ui/codex-view/composer-controller";
import {
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS
} from "../settings/settings";

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

    const attachmentContainer = new ComposerTestElement("div");
    const removedAttachments: string[] = [];
    renderComposerAttachments(
      attachmentContainer as unknown as HTMLElement,
      {
        selectedSkill: null,
        attachments: [
          { type: "image", name: "cover #1.png", path: "/tmp/Echo Ink/cover #1.png" },
          { type: "file", name: "requirements.md", path: "/tmp/Echo Ink/requirements.md" }
        ]
      },
      {
        onRemoveSkill: () => undefined,
        onRemoveAttachment: (path) => removedAttachments.push(path)
      }
    );
    const thumbnail = attachmentContainer.querySelector(".codex-attachment-thumbnail")!;
    const image = thumbnail.querySelector("img")!;
    assert.equal(image.src, "file:///tmp/Echo%20Ink/cover%20%231.png");
    assert.equal(thumbnail.getAttribute("title"), "/tmp/Echo Ink/cover #1.png");
    image.onerror?.();
    assert.equal(thumbnail.hasClass("is-broken"), true, "unsupported image switches to its fallback");
    assert.ok(thumbnail.querySelector(".codex-attachment-thumbnail-fallback"));
    const imageRemove = thumbnail.querySelector(".codex-attachment-thumbnail-remove")!;
    assert.equal(imageRemove.getAttribute("aria-label"), "移除图片：cover #1.png");
    imageRemove.click();

    const fileChip = attachmentContainer.querySelector(".codex-attachment-file-chip")!;
    assert.equal(fileChip.getAttribute("title"), "/tmp/Echo Ink/requirements.md");
    assert.equal(fileChip.querySelector(".codex-attachment-name")?.textContent, "requirements.md");
    assert.ok(fileChip.querySelector(".codex-attachment-file-icon"));
    const fileRemove = fileChip.querySelector(".codex-attachment-file-remove")!;
    assert.equal(fileRemove.getAttribute("aria-label"), "移除文件：requirements.md");
    fileRemove.click();
    assert.deepEqual(removedAttachments, [
      "/tmp/Echo Ink/cover #1.png",
      "/tmp/Echo Ink/requirements.md"
    ]);
    assert.equal(composerAttachmentImageSrc("file:///tmp/already.png"), "file:///tmp/already.png");

    const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
    const iconSource = readFileSync("src/ui/animate-icon.ts", "utf8");
    const css = readFileSync("styles.css", "utf8");
    const turnRunnerSource = readFileSync("src/ui/codex-view/turn-runner.ts", "utf8");
    assert.doesNotMatch(composerSource, /send-horizontal/u);
    assert.match(iconSource, /M19 10v2a7 7 0 0 1-14 0v-2/u);
    assert.match(css, /@keyframes echoink-animate-send/u);
    assert.match(css, /@keyframes echoink-animate-mic/u);
    assert.match(css, /prefers-reduced-motion:\s*reduce/u);
    assert.match(css, /\.codex-attachment-thumbnail \{[\s\S]*?width:\s*72px;[\s\S]*?height:\s*72px;/u);
    assert.match(css, /\.codex-attachment-thumbnail-image \{[\s\S]*?object-fit:\s*cover;/u);
    assert.match(css, /\.codex-attachment-thumbnail-remove \{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/u);
    assert.match(css, /@media \(max-width:\s*560px\)[\s\S]*?\.codex-attachment-thumbnail \{[\s\S]*?width:\s*64px;[\s\S]*?height:\s*64px;/u);
    assert.doesNotMatch(turnRunnerSource, /Pi Chat 的附件入口尚未完成切换，本轮没有发送/u);
    assert.match(turnRunnerSource, /preparePiChatImages/u);
    assert.match(turnRunnerSource, /preparedImages\.length/u);
    await assertExactComposerProviderModelSelection();
    console.log("PASS conversation-ui: composer actions, compact attachments, and exact Provider/model selection preserve send semantics");
  } finally {
    (globalThis as unknown as { document?: Document }).document = originalDocument;
  }
}

async function assertExactComposerProviderModelSelection(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = createApiProviderConfig("custom", "provider-first");
  first.name = "First Provider";
  first.baseUrl = "https://first.example/v1";
  first.apiKey = "fixture-first-key";
  first.models = [createApiProviderModelConfig("custom", "shared-model")];
  first.defaultModelId = "shared-model";
  const second = createApiProviderConfig("custom", "provider-second");
  second.name = "Second Provider";
  second.baseUrl = "https://second.example/v1";
  second.apiKey = "fixture-second-key";
  second.models = [createApiProviderModelConfig("custom", "shared-model")];
  second.defaultModelId = "shared-model";
  const missingCredential = createApiProviderConfig("custom", "provider-missing");
  missingCredential.name = "Missing Credential";
  missingCredential.baseUrl = "https://missing.example/v1";
  missingCredential.models = [createApiProviderModelConfig("custom", "hidden-model")];
  missingCredential.defaultModelId = "hidden-model";
  settings.apiProviders = [first, second, missingCredential];
  settings.activeApiProviderId = first.id;
  settings.defaultModel = "shared-model";

  let activationMode: "success" | "failure" | "busy" = "failure";
  let renderCount = 0;
  const host: any = {
    plugin: {
      settings,
      activateApiProviderSettings: async (applyCandidate: (candidate: typeof settings) => void) => {
        if (activationMode === "busy") {
          throw new Error("EchoInk 正在处理其他请求，请稍后再试。");
        }
        if (activationMode === "failure") throw new Error("runtime-create-failed");
        applyCandidate(settings);
      },
      saveSettings: async () => undefined
    },
    running: false,
    selectedProviderSettingsId: first.id,
    selectedModel: "shared-model",
    selectedReasoning: settings.defaultReasoning,
    selectedServiceTier: settings.defaultServiceTier,
    selectedPermission: settings.defaultPermission,
    selectedMode: settings.defaultMode,
    effectiveModel: () => host.selectedModel,
    renderToolbar: () => { renderCount += 1; }
  };

  const options = composerProviderModelOptions(host);
  assert.deepEqual(
    options.map((option) => [option.providerSettingsId, option.modelId]),
    [[first.id, "shared-model"], [second.id, "shared-model"]],
    "same model IDs must retain their Provider settings identity"
  );
  assert.deepEqual(
    composerModelMenuState(host).providerModels.map((option) => option.providerName),
    ["First Provider", "Second Provider"]
  );

  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), false);
  assert.equal(host.selectedProviderSettingsId, first.id);
  assert.equal(settings.activeApiProviderId, first.id);
  assert.equal(renderCount, 0);

  activationMode = "busy";
  host.running = true;
  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), false);
  assert.equal(host.selectedProviderSettingsId, first.id);
  assert.equal(settings.activeApiProviderId, first.id);
  assert.equal(renderCount, 0);

  activationMode = "success";
  host.running = false;
  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), true);
  assert.equal(host.selectedProviderSettingsId, second.id);
  assert.equal(host.selectedModel, "shared-model");
  assert.equal(settings.activeApiProviderId, second.id);
  assert.equal(settings.defaultModel, "shared-model");
  assert.equal(renderCount, 1);
  console.log("PASS conversation-ui: Composer preserves exact Provider/model identity and transactional rollback");
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
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  src = "";
  textContent = "";
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
    if (options.text !== undefined) element.textContent = String(options.text);
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
