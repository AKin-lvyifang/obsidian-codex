import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TFile, type App } from "obsidian";
import { openTestNoticeMessages } from "./obsidian-shim";
import {
  renderComposerAttachments,
  renderComposerToolbar,
  type ComposerToolbarCallbacks,
  type ComposerToolbarState
} from "../ui/codex-view/composer";
import { createAttachmentResourceResolver } from "../ui/codex-view/attachment-resource";
import {
  composerModelMenuState,
  composerProviderModelOptions,
  selectComposerModel,
  selectComposerReasoning
} from "../ui/codex-view/composer-controller";
import {
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  normalizeSettingsData
} from "../settings/settings";

export async function runComposerActionTests(): Promise<void> {
  const originalDocument = globalThis.document;
  const testDocument = new ComposerTestDocument();
  (globalThis as unknown as { document: Document }).document = testDocument as unknown as Document;
  try {
    const send = renderAction();
    assert.equal(send.primary.getAttribute("aria-label"), "发送");
    assert.equal(send.primary.hasClass("is-send-action"), true);
    assert.equal(send.primary.querySelectorAll(".echoink-animate-icon-send-horizontal").length, 1);
    assert.equal(
      send.primary.querySelector("path")?.getAttribute("d"),
      "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"
    );
    assert.equal(send.primary.querySelectorAll("path")[1]?.getAttribute("d"), "M6 12h16");
    send.primary.click();
    assert.equal(send.calls.send, 1, "ordinary send keeps onSendMessage");
    send.mic.click();
    assert.equal(send.calls.mic, 1, "Mic keeps onMicInput");
    assert.equal(send.mic.getAttribute("aria-label"), "语音输入");
    assert.equal(send.mic.querySelectorAll(".echoink-animate-icon-mic").length, 1);
    assert.equal(send.mic.querySelector("rect")?.getAttribute("rx"), "3");

    const enqueue = renderAction({ running: true, hasDraft: true });
    assert.equal(enqueue.primary.hasClass("is-queue-action"), true);
    assert.equal(enqueue.primary.querySelector(".echoink-animate-icon-send-horizontal"), null);
    enqueue.primary.click();
    assert.equal(enqueue.calls.enqueue, 1);

    const stop = renderAction({ running: true, hasDraft: false });
    assert.equal(stop.primary.hasClass("is-stop-action"), true);
    assert.equal(stop.primary.querySelectorAll(".echoink-animate-icon-circle-stop").length, 1);
    assert.equal(stop.primary.querySelector("circle")?.getAttribute("r"), "10");
    assert.equal(stop.primary.querySelector("rect")?.getAttribute("rx"), "1");
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
    const vaultFile = Object.assign(Object.create(TFile.prototype), {
      path: "cover #1.png"
    }) as TFile;
    const attachmentResolver = createAttachmentResourceResolver({
      vault: {
        getAbstractFileByPath: (path: string) => path === vaultFile.path ? vaultFile : null,
        getResourcePath: (file: TFile) => `app://echoink-vault/${encodeURIComponent(file.path)}`
      }
    } as unknown as App, "/tmp/Echo Ink");
    renderComposerAttachments(
      attachmentContainer as unknown as HTMLElement,
      {
        selectedSkill: null,
        attachments: [
          { type: "image", name: "cover #1.png", path: "/tmp/Echo Ink/cover #1.png" },
          { type: "file", name: "requirements.md", path: "/tmp/Echo Ink/requirements.md" },
          { type: "image", name: "clipboard-1720000000000-1.png", path: "/tmp/Echo Ink/missing.png" }
        ],
        attachmentResolver
      },
      {
        onRemoveSkill: () => undefined,
        onRemoveAttachment: (path) => removedAttachments.push(path)
      }
    );
    const thumbnail = attachmentContainer.querySelector(".codex-attachment-thumbnail")!;
    const image = thumbnail.querySelector("img")!;
    assert.equal(image.src, "app://echoink-vault/cover%20%231.png");
    assert.equal(thumbnail.getAttribute("title"), "cover #1.png");
    assert.equal(thumbnail.getAttribute("role"), "listitem");
    image.onerror?.();
    assert.equal(thumbnail.hasClass("is-broken"), true, "unsupported image switches to its fallback");
    assert.ok(thumbnail.querySelector(".codex-attachment-thumbnail-fallback"));
    const imageRemove = thumbnail.querySelector(".codex-attachment-thumbnail-remove")!;
    assert.equal(imageRemove.getAttribute("aria-label"), "移除图片：cover #1.png");
    imageRemove.click();

    const fileChip = attachmentContainer.querySelector(".codex-attachment-file-chip")!;
    assert.equal(fileChip.getAttribute("title"), "requirements.md");
    assert.equal(fileChip.querySelector(".codex-attachment-name")?.textContent, "requirements.md");
    assert.ok(fileChip.querySelector(".codex-attachment-file-icon"));
    const fileRemove = fileChip.querySelector(".codex-attachment-file-remove")!;
    assert.equal(fileRemove.getAttribute("aria-label"), "移除文件：requirements.md");
    fileRemove.click();
    const attachmentList = attachmentContainer.querySelector(".codex-ai-elements-attachments-list")!;
    assert.equal(attachmentList.getAttribute("data-ai-elements-pattern"), "attachments");
    assert.equal(attachmentList.getAttribute("data-attachment-variant"), "grid");
    assert.equal(attachmentList.getAttribute("role"), "list");
    const thumbnails = attachmentContainer.querySelectorAll(".codex-attachment-thumbnail");
    const missingThumbnail = thumbnails[1]!;
    assert.equal(missingThumbnail.hasClass("is-broken"), true);
    assert.equal(missingThumbnail.getAttribute("aria-label"), "图片：粘贴图片 2.png，无法预览");
    assert.equal(
      missingThumbnail.querySelector(".codex-attachment-thumbnail-name")?.textContent,
      "粘贴图片 2.png · 无法预览"
    );
    assert.doesNotMatch(renderedComposerText(attachmentContainer), /clipboard-/u);
    assert.deepEqual(removedAttachments, [
      "/tmp/Echo Ink/cover #1.png",
      "/tmp/Echo Ink/requirements.md"
    ]);

    const missing = attachmentResolver.resolve({
      type: "image",
      name: "clipboard-1720000000000-0.png",
      path: "/tmp/Echo Ink/missing.png"
    });
    assert.equal(missing.displayName, "粘贴图片 1.png");
    assert.equal(missing.availability, "unavailable");
    assert.equal(missing.resourceUri, undefined);

    const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
    const iconSource = readFileSync("src/ui/animate-icon.ts", "utf8");
    const css = readFileSync("styles.css", "utf8");
    const turnRunnerSource = readFileSync("src/ui/codex-view/turn-runner.ts", "utf8");
    assert.match(composerSource, /renderAnimateIcon\(sendButton, "send-horizontal"\)/u);
    assert.match(composerSource, /renderAnimateIcon\(sendButton, "circle-stop"\)/u);
    assert.match(composerSource, /queueEl[\s\S]*workspaceEl[\s\S]*attachmentsEl[\s\S]*inputEl/u);
    assert.match(iconSource, /M19 10v2a7 7 0 0 1-14 0v-2/u);
    assert.match(iconSource, /M3\.714 3\.048/u);
    assert.match(iconSource, /circle\("12", "12", "10"/u);
    assert.match(css, /@keyframes echoink-animate-send-horizontal/u);
    assert.match(css, /@keyframes echoink-animate-circle-stop-ring/u);
    assert.match(css, /@keyframes echoink-animate-circle-stop-symbol/u);
    assert.match(css, /@keyframes echoink-animate-mic/u);
    assert.match(css, /prefers-reduced-motion:\s*no-preference/u);
    assert.match(css, /\.codex-attachment-thumbnail \{[\s\S]*?width:\s*84px;[\s\S]*?height:\s*84px;/u);
    assert.match(css, /\.codex-attachment-thumbnail-image \{[\s\S]*?object-fit:\s*cover;/u);
    assert.match(css, /\.codex-attachment-thumbnail-remove \{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/u);
    assert.match(css, /@media \(max-width:\s*560px\)[\s\S]*?\.codex-attachment-thumbnail \{[\s\S]*?width:\s*72px;[\s\S]*?height:\s*72px;/u);
    assert.match(css, /\.codex-composer-send-button\.codex-send-button\.is-stop-action\s*\{[\s\S]*?color:\s*var\(--text-normal\);[\s\S]*?box-shadow:\s*none\s*!important;/u);
    assert.match(css, /\.codex-composer-send-button\.codex-send-button\.is-stop-action:is\(:hover, :focus-visible\)[\s\S]*?--echoink-conversation-status-danger/u);
    assert.doesNotMatch(turnRunnerSource, /Pi Chat 的附件入口尚未完成切换，本轮没有发送/u);
    assert.match(turnRunnerSource, /preparePiChatImages/u);
    assert.match(turnRunnerSource, /preparedImages\.length/u);
    await assertExactComposerProviderModelSelection();
    assertAdaptiveComposerReasoning();
    console.log("PASS conversation-ui: composer actions, compact attachments, and exact Provider/model selection preserve send semantics");
  } finally {
    (globalThis as unknown as { document?: Document }).document = originalDocument;
  }
}

function assertAdaptiveComposerReasoning(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("deepseek", "adaptive-reasoning");
  provider.apiKey = "fixture-key";
  const alternate = createApiProviderModelConfig(
    "deepseek",
    "deepseek-v4-pro"
  );
  alternate.reasoningEffort = "none";
  provider.models.push(alternate);
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  settings.defaultModel = provider.defaultModelId;
  const primary = provider.models.find(
    (model) => model.id === provider.defaultModelId
  );
  assert.ok(primary);
  primary.reasoningEffort = "xhigh";

  let saveCount = 0;
  let renderCount = 0;
  const host: any = {
    plugin: {
      settings,
      saveSettings: async () => { saveCount += 1; }
    },
    selectedProviderSettingsId: provider.id,
    selectedModel: primary.id,
    selectedPermission: settings.defaultPermission,
    selectedMode: settings.defaultMode,
    effectiveModel: () => host.selectedModel,
    renderToolbar: () => { renderCount += 1; }
  };

  openTestNoticeMessages.length = 0;
  const deepSeek = composerModelMenuState(host);
  assert.equal(primary.reasoningEffort, "high");
  assert.equal(deepSeek.selectedReasoning, "high");
  assert.deepEqual(
    deepSeek.reasoningOptions.map((option) => [option.effort, option.label]),
    [["none", "关闭"], ["high", "高思考"], ["max", "最强思考"]]
  );
  assert.equal(saveCount, 1);
  assert.match(openTestNoticeMessages.at(-1) ?? "", /原思考强度已不可用，已回落为高思考/u);

  const invalidStoredProvider = createApiProviderConfig(
    "deepseek",
    "invalid-stored-reasoning"
  );
  invalidStoredProvider.apiKey = "fixture-key";
  const invalidStoredModel = invalidStoredProvider.models[0] as typeof primary & {
    reasoningEffort: string;
  };
  invalidStoredModel.reasoningEffort = "turbo";
  const invalidStoredSettings = structuredClone(
    normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      activeApiProviderId: invalidStoredProvider.id,
      defaultModel: invalidStoredModel.id,
      apiProviders: [invalidStoredProvider]
    }).settings
  );
  const normalizedInvalidProvider = invalidStoredSettings.apiProviders[0];
  const normalizedInvalidModel = normalizedInvalidProvider?.models[0];
  assert.ok(normalizedInvalidProvider && normalizedInvalidModel);
  let invalidSaveCount = 0;
  const invalidHost: any = {
    plugin: {
      settings: invalidStoredSettings,
      saveSettings: async () => { invalidSaveCount += 1; }
    },
    selectedProviderSettingsId: normalizedInvalidProvider.id,
    selectedModel: normalizedInvalidModel.id,
    selectedPermission: invalidStoredSettings.defaultPermission,
    selectedMode: invalidStoredSettings.defaultMode,
    effectiveModel: () => invalidHost.selectedModel,
    renderToolbar: () => undefined
  };
  openTestNoticeMessages.length = 0;
  composerModelMenuState(invalidHost);
  assert.equal(normalizedInvalidModel.reasoningEffort, "high");
  assert.equal(invalidSaveCount, 1);
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /原思考强度已不可用，已回落为高思考/u
  );
  assert.doesNotMatch(JSON.stringify(invalidStoredSettings), /turbo/u);

  const missingProvider = createApiProviderConfig(
    "deepseek",
    "missing-stored-reasoning"
  );
  missingProvider.apiKey = "fixture-key";
  const missingSettings = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 52,
    activeApiProviderId: missingProvider.id,
    defaultModel: missingProvider.defaultModelId,
    apiProviders: [missingProvider]
  }).settings;
  const normalizedMissingProvider = missingSettings.apiProviders[0];
  const normalizedMissingModel = normalizedMissingProvider?.models[0];
  assert.ok(normalizedMissingProvider && normalizedMissingModel);
  let missingSaveCount = 0;
  const missingHost: any = {
    plugin: {
      settings: missingSettings,
      saveSettings: async () => { missingSaveCount += 1; }
    },
    selectedProviderSettingsId: normalizedMissingProvider.id,
    selectedModel: normalizedMissingModel.id,
    selectedPermission: missingSettings.defaultPermission,
    selectedMode: missingSettings.defaultMode,
    effectiveModel: () => missingHost.selectedModel,
    renderToolbar: () => undefined
  };
  openTestNoticeMessages.length = 0;
  composerModelMenuState(missingHost);
  assert.equal(normalizedMissingModel.reasoningEffort, "high");
  assert.equal(missingSaveCount, 1);
  assert.deepEqual(openTestNoticeMessages, []);

  selectComposerReasoning(host, "max");
  assert.equal(primary.reasoningEffort, "max");
  assert.equal(saveCount, 2);
  assert.equal(renderCount, 1);

  host.selectedModel = alternate.id;
  const restored = composerModelMenuState(host);
  assert.equal(restored.selectedReasoning, "none");
  assert.equal(primary.reasoningEffort, "max");

  const qwenProvider = createApiProviderConfig("custom", "qwen-adaptive");
  qwenProvider.runtimeProviderId = "qwen-token-plan";
  qwenProvider.baseUrl = "https://qwen.example/v1";
  qwenProvider.apiKey = "fixture-key";
  const qwenModel = createApiProviderModelConfig(
    "custom",
    "qwen3.8-max-preview",
    qwenProvider.runtimeProviderId
  );
  qwenProvider.models = [qwenModel];
  qwenProvider.defaultModelId = qwenModel.id;
  settings.apiProviders.push(qwenProvider);
  host.selectedProviderSettingsId = qwenProvider.id;
  host.selectedModel = qwenModel.id;
  const qwen = composerModelMenuState(host);
  assert.equal(qwenModel.reasoningEffort, "medium");
  assert.deepEqual(
    qwen.reasoningOptions.map((option) => [option.effort, option.label]),
    [["none", "关闭"], ["medium", "开启"]]
  );

  const nonReasoningProvider = createApiProviderConfig(
    "custom",
    "non-reasoning"
  );
  nonReasoningProvider.runtimeProviderId = "openai";
  nonReasoningProvider.baseUrl = "https://openai.example/v1";
  nonReasoningProvider.apiKey = "fixture-key";
  const nonReasoningModel = createApiProviderModelConfig(
    "custom",
    "gpt-4",
    nonReasoningProvider.runtimeProviderId
  );
  nonReasoningProvider.models = [nonReasoningModel];
  nonReasoningProvider.defaultModelId = nonReasoningModel.id;
  settings.apiProviders.push(nonReasoningProvider);
  host.selectedProviderSettingsId = nonReasoningProvider.id;
  host.selectedModel = nonReasoningModel.id;
  const nonReasoning = composerModelMenuState(host);
  assert.equal(nonReasoning.selectedReasoning, null);
  assert.deepEqual(nonReasoning.reasoningOptions, []);
  assert.equal(nonReasoningModel.reasoningEffort, undefined);
}

function renderedComposerText(root: ComposerTestElement): string {
  return [root.textContent, ...root.children.map(renderedComposerText)].join(" ");
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
