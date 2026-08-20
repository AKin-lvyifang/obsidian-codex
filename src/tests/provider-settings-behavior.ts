import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App, openTestModals } from "obsidian";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  activateApiProvider,
  applyApiProviderModelPreset,
  createApiProviderConfig,
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  removeApiProvider
} from "../settings/settings";
import { API_PROVIDER_PRESETS, apiProviderRequestUrl } from "../settings/provider-presets";
import { providerTooltipBaseUrl } from "../settings/provider-tooltip";
import type {
  PiProviderConfigurationDraft,
  PiProviderConnectionTestResult,
  PiProviderModelListResult
} from "../plugin/pi-provider-configuration-service";
import { PiProviderConfigurationService } from "../plugin/pi-provider-configuration-service";
import type { PiProviderProtocolDispatcher } from "../harness/pi/pi-provider-protocol-adapter";
import {
  ProviderPreflightSession,
  providerPreflightApiKeyReady
} from "../settings/provider-preflight";
import { ProviderModelModal } from "../settings/provider-model-modal";
import { settingsCopy } from "../settings/i18n";
import { CodexSettingTab } from "../settings/settings-tab";
import { McpServerModal } from "../settings/mcp-server-modal";
import { MemoryCorrectionModal } from "../ui/modals";
import {
  ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION
} from "../knowledge-base/knowledge-maintenance-preferences";
import {
  createKnowledgeMaintenancePreferenceEditor
} from "../settings/knowledge-maintenance-preference-editor";
import {
  runHarnessV2PiObsidianSecretStorageTests
} from "./harness-v2/pi-obsidian-secret-storage";
import {
  runHarnessV2PiProviderSecurityTests
} from "./harness-v2/pi-provider-security";
import {
  runPiNativeControlledProviderTests
} from "./pi-native/pi-native-controlled-provider";
import {
  runApiProviderActivationServiceTests
} from "./api-provider-activation-service";
import { runEditorTranslationServiceTests } from "./editor-translation-service";
import { runEditorTranslationSelectionTests } from "./editor-translation-selection";
import {
  buildActiveEchoInkResourceCatalog,
  enabledSkillResources,
  mcpResourceEnablement
} from "../resources/registry";
import {
  loadMcpPanelView,
  renderMcpPanelView
} from "../ui/codex-view/mcp-panel";
import { currentTurnOptions } from "../ui/codex-view/workspace-controller";
import {
  EchoInkSettingsStore,
  ResourceMutationError,
  SettingsPersistenceError,
  restoreApiProviderSettings,
  snapshotApiProviderSettings
} from "../plugin/settings-store";
import { AgentIdentityModal } from "../ui/agent-identity-modal";
import {
  AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS,
  AGENT_AVATAR_SOURCE_MAX_BYTES,
  processAgentAvatar,
  validateAvatarSourceSize,
  validateAvatarSourceType
} from "../ui/agent-avatar-processor";
import {
  resolveAgentAvatarPresetAsset,
  resolveAgentAvatarUrl
} from "../ui/agent-avatar-presets";
import {
  AGENT_IDENTITY_STATE_SCHEMA,
  agentIdentityStateJson
} from "../harness/memory/agent-identity-state";

export async function runProviderSettingsBehaviorTests(): Promise<void> {
  assertSettingsV49MigrationContract();
  await assertRetiredSettingsRewritePersistence();
  assertProviderScopedRollbackPreservesConcurrentSettings();
  await assertPersistedProviderRollbackPreservesQueuedSettingsSave();
  await assertSettingsPersistenceReadbackOutcomes();
  await assertProviderApiKeyPersistenceLifecycle();
  await runApiProviderActivationServiceTests();
  await runEditorTranslationServiceTests();
  runEditorTranslationSelectionTests();
  await assertProviderTextGenerationCompletionContract();
  assertPresetRequestMappings();
  assertProviderTooltipBehavior();
  assertSavedModelLifecycle();
  assertNewProductGenerationKeepsConfigurationButDropsLegacyHistory();
  assertKnowledgeSettingsDetailRetiresLegacyControls();
  assertSettingsAccessibleNamesAndOverflow();
  await assertMemoryCorrectionModalContract();
  assertMemoryComposerVisualCssContract();
  await assertMcpPanelUsesTurnResourceTruth();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  await assertResourceScanErrorsClearAcrossTabs();
  assertProviderBadgeReflowCssContract();
  await assertSavedBindingPreflightLifecycle();
  await assertProviderModelModalPreflightLifecycle();
  await assertProviderApiKeyEditLifecycle();
  await assertProviderModalModelAccessibleNameIncludesValue();
  await assertProviderModelModalCloseCancelsPendingPreflight();
  await assertMcpModalFieldAccessibility();
  await runHarnessV2PiObsidianSecretStorageTests();
  await runHarnessV2PiProviderSecurityTests();
  await runPiNativeControlledProviderTests();
  await assertAgentIdentityCardPlacementAndCopy();
  await assertIdentityEditSaveRefreshesSettingsAndPersonalization();
  await assertFirstNamingModalZeroWriteOnCancel();
  await assertIdentityModalNameValidation();
  await assertAvatarPresetCatalogBehavior();
  await assertAvatarProcessorContract();
}

async function assertMemoryCorrectionModalContract(): Promise<void> {
  installProviderModalDomFixture();
  const generations = [
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>(),
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>(),
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>()
  ];
  const save = deferred<void>();
  const generationSignals: AbortSignal[] = [];
  let generationCalls = 0;
  let saveCalls = 0;
  let result: "saved" | "cancelled" | "conflict" | undefined;
  const modal = new MemoryCorrectionModal(
    new App(),
    {
      memoryType: "事实",
      title: "当前标题",
      content: "当前内容只能查看",
      recallWhen: "讨论验收边界时"
    },
    "zh-CN",
    {
      generate: async (_correction, signal) => {
        generationSignals.push(signal);
        return await generations[generationCalls++]!.promise;
      },
      save: async () => {
        saveCalls += 1;
        await save.promise;
      }
    },
    (value) => {
      result = value;
    }
  );
  modal.open();
  const title = modal.contentEl.querySelector("h2");
  assert.equal(title?.textContent, "修正事实记忆");
  assert.doesNotMatch(title?.textContent ?? "", /当前标题/u);
  assert.match(modal.contentEl.textContent, /说明哪里不准确，以及正确内容是什么/u);
  assert.ok(modal.contentEl.querySelector(".echoink-memory-correction-current"));
  assert.match(modal.contentEl.textContent, /当前标题/u);
  assert.match(modal.contentEl.textContent, /当前内容只能查看/u);
  assert.match(modal.contentEl.textContent, /讨论验收边界时/u);
  assert.match(modal.contentEl.textContent, /何时可能想起/u);
  assert.equal(modal.contentEl.querySelectorAll("input").length, 0);

  const textarea = modal.contentEl.querySelector<ProviderModalTestElement>(
    'textarea[aria-label="修正说明"]'
  );
  assert.ok(textarea);
  assert.equal(textarea.getAttribute("rows"), "7");
  const correct = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "修正");
  const saveButton = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "保存");
  assert.ok(correct);
  assert.ok(saveButton);
  assert.equal(correct.disabled, true);
  assert.equal(saveButton.disabled, true);

  textarea.value = "第一行纠正\n第二行补充";
  textarea.oninput?.();
  assert.equal(correct.disabled, false);
  correct.click();
  assert.equal(textarea.disabled, true);
  assert.equal(correct.textContent, "停止");
  assert.ok(correct.querySelector(".echoink-memory-correction-spinner"));
  assert.equal(saveButton.disabled, true);
  assert.equal(generationSignals.length, 1);

  correct.click();
  assert.equal(generationSignals[0]?.aborted, true);
  assert.equal(textarea.value, "第一行纠正\n第二行补充");
  assert.equal(textarea.disabled, false);
  assert.equal(correct.textContent, "修正");
  generations[0]!.resolve({
    title: "迟到标题",
    content: "迟到内容",
    recallWhen: "迟到召回"
  });
  await flushProviderModalTasks();
  assert.equal(saveButton.disabled, true);
  assert.equal(
    modal.contentEl.querySelector(".echoink-memory-correction-preview")
      ?.hasClass("is-hidden"),
    true
  );

  correct.click();
  generations[1]!.resolve({
    title: "修正标题",
    content: "修正正文",
    recallWhen: "需要核对时"
  });
  await flushProviderModalTasks();
  const preview = modal.contentEl.querySelector(
    ".echoink-memory-correction-preview"
  );
  assert.equal(preview?.hasClass("is-hidden"), false);
  assert.match(preview?.textContent ?? "", /修正标题/u);
  assert.match(preview?.textContent ?? "", /修正正文/u);
  assert.match(preview?.textContent ?? "", /需要核对时/u);
  assert.equal(saveButton.disabled, false);

  textarea.value = "再次调整";
  textarea.oninput?.();
  assert.equal(saveButton.disabled, true);
  assert.equal(preview?.hasClass("is-hidden"), true);

  correct.click();
  generations[2]!.resolve({
    title: "最终标题",
    content: "最终正文",
    recallWhen: "最终召回"
  });
  await flushProviderModalTasks();
  assert.equal(saveButton.disabled, false);
  saveButton.click();
  saveButton.click();
  assert.equal(saveCalls, 1);
  assert.equal(saveButton.disabled, true);
  save.resolve();
  await flushProviderModalTasks();
  assert.equal(result, "saved");

  const closeGeneration = deferred<Readonly<{
    title: string;
    content: string;
    recallWhen: string;
  }>>();
  let closeSignal: AbortSignal | undefined;
  let cancelled: "saved" | "cancelled" | "conflict" | undefined;
  const cancelledModal = new MemoryCorrectionModal(
    new App(),
    {
      memoryType: "事实",
      title: "标题",
      content: "内容",
      recallWhen: "情境"
    },
    "zh-CN",
    {
      generate: async (_correction, signal) => {
        closeSignal = signal;
        return await closeGeneration.promise;
      },
      save: async () => undefined
    },
    (value) => {
      cancelled = value;
    }
  );
  cancelledModal.open();
  const closeTextarea = cancelledModal.contentEl.querySelector<ProviderModalTestElement>(
    'textarea[aria-label="修正说明"]'
  );
  const closeCorrect = Array.from(cancelledModal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "修正");
  assert.ok(closeTextarea);
  assert.ok(closeCorrect);
  closeTextarea.value = "关闭时停止";
  closeTextarea.oninput?.();
  closeCorrect.click();
  cancelledModal.close();
  assert.equal(closeSignal?.aborted, true);
  assert.equal(cancelled, "cancelled");
  closeGeneration.resolve({
    title: "关闭后的迟到标题",
    content: "关闭后的迟到内容",
    recallWhen: "关闭后的迟到召回"
  });
  await flushProviderModalTasks();
  assert.equal(cancelled, "cancelled");
}

function assertMemoryComposerVisualCssContract(): void {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const currentRule = css.match(
    /\.echoink-memory-correction-current\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const previewRule = css.match(
    /\.echoink-memory-correction-preview\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const hiddenPreviewRule = css.match(
    /\.echoink-memory-correction-preview\.is-hidden\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const disabledSaveRule = css.match(
    /\.echoink-memory-correction-actions button\.mod-cta:disabled\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const sendButtonRule = css.match(
    /\.codex-composer-send-button\.codex-send-button\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const sendIconRule = css.match(
    /\.codex-composer-send-button\.codex-send-button svg\s*\{([^}]*)\}/u
  )?.[1] ?? "";

  assert.match(currentRule, /background:\s*var\(--background-secondary\);/u);
  assert.match(previewRule, /--echoink-memory-preview-cyan:\s*#70d7df;/u);
  assert.match(
    previewRule,
    /border-color:\s*color-mix\(\s*in srgb,\s*var\(--echoink-memory-preview-cyan\)\s*62%,\s*var\(--background-modifier-border\)\s*\);/u
  );
  assert.match(
    previewRule,
    /background:\s*color-mix\(\s*in srgb,\s*var\(--echoink-memory-preview-cyan\)\s*18%,\s*var\(--background-primary\)\s*\);/u
  );
  assert.match(hiddenPreviewRule, /display:\s*none;/u);
  assert.doesNotMatch(previewRule, /interactive-accent/u);
  assert.match(disabledSaveRule, /color:\s*var\(--text-faint\);/u);
  assert.match(
    disabledSaveRule,
    /background:\s*var\(--background-modifier-border\)\s*!important;/u
  );
  assert.match(disabledSaveRule, /cursor:\s*not-allowed;/u);
  assert.match(sendButtonRule, /width:\s*34px;/u);
  assert.match(sendButtonRule, /height:\s*34px;/u);
  assert.match(sendButtonRule, /flex:\s*0 0 34px;/u);
  assert.match(sendIconRule, /width:\s*24px;/u);
  assert.match(sendIconRule, /height:\s*24px;/u);
}

async function assertProviderTextGenerationCompletionContract(): Promise<void> {
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: "translation-provider",
    providerId: "deepseek",
    runtimeProviderId: "deepseek",
    apiProtocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-chat",
    apiKey: "fixture-key",
    toolCalling: false,
    imageInput: false,
    reasoning: false,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  };
  const host = {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => "/fixture-vault"
  };
  let nextResult: (signal: AbortSignal) => Promise<AssistantMessage> = async () =>
    providerTextMessage("stop", "\n  - **Hello**\n\n");
  const dispatcher = {
    stream: (request: { options: { signal?: AbortSignal } }) => ({
      result: async () => await nextResult(request.options.signal ?? new AbortController().signal)
    })
  } as unknown as Pick<PiProviderProtocolDispatcher, "stream">;
  const service = new PiProviderConfigurationService(host as never, {
    textGenerationDispatcher: dispatcher
  });
  const input = {
    draft,
    systemPrompt: "Translate.",
    userPrompt: "翻译。",
    timeoutMs: 1_000
  };
  let writebackAttempts = 0;
  const generateAndWriteBack = async (): Promise<void> => {
    await service.generateText(input);
    writebackAttempts += 1;
  };

  assert.equal(
    await service.generateText(input),
    "\n  - **Hello**\n\n"
  );

  nextResult = async () => providerTextMessage("stop", " \n\t ");
  await assert.rejects(
    generateAndWriteBack(),
    /provider_text_generation_failed/u
  );

  for (const stopReason of ["length", "toolUse", "error", "aborted"] as const) {
    nextResult = async () => providerTextMessage(
      stopReason,
      `partial-${stopReason}`
    );
    await assert.rejects(
      generateAndWriteBack(),
      /provider_text_generation_failed/u
    );
  }

  nextResult = async (signal) => await new Promise<AssistantMessage>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve(providerTextMessage("stop", "partial-after-timeout"));
    }, { once: true });
  });
  await assert.rejects(
    generateAndWriteBack(),
    /provider_text_generation_timeout/u
  );
  assert.equal(writebackAttempts, 0);

  const externalController = new AbortController();
  let providerSignal: AbortSignal | undefined;
  nextResult = async (signal) => {
    providerSignal = signal;
    return await new Promise<AssistantMessage>((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(providerTextMessage("stop", "partial-after-user-stop"));
      }, { once: true });
    });
  };
  const externallyCancelled = service.generateText({
    ...input,
    signal: externalController.signal
  });
  await flushProviderModalTasks();
  externalController.abort();
  await assert.rejects(
    externallyCancelled,
    /provider_text_generation_aborted/u
  );
  assert.equal(providerSignal?.aborted, true);
  assert.equal(writebackAttempts, 0);
}

function providerTextMessage(
  stopReason: AssistantMessage["stopReason"],
  text: string
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason,
    timestamp: Date.now()
  };
}

async function assertResourceScanErrorsClearAcrossTabs(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "resources";
  settings.resourceManagementTab = "skills";
  let scanError = "Vault scan failed";
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    buildRuntimeEchoInkResourceCatalog: async () => {
      settings.resources.lastError = scanError;
      return [];
    }
  };
  const tab = new CodexSettingTab(plugin as never);
  const mutableTab = tab as unknown as {
    resourceLoadErrors: Partial<Record<"plugins" | "mcp" | "skills", string>>;
    loadWorkspaceResources(force: boolean, tab: "plugins" | "mcp" | "skills"): Promise<void>;
  };
  mutableTab.resourceLoadErrors = {
    plugins: "stale plugin scan error",
    mcp: "stale MCP scan error"
  };

  await mutableTab.loadWorkspaceResources(true, "skills");
  assert.equal(mutableTab.resourceLoadErrors.skills, scanError);
  assert.equal(mutableTab.resourceLoadErrors.mcp, "stale MCP scan error");

  scanError = "";
  await mutableTab.loadWorkspaceResources(true, "skills");
  assert.deepEqual(mutableTab.resourceLoadErrors, {});
}

async function assertSkillToggleNotCommittedRestoresAuthoritativeUi(): Promise<void> {
  installProviderModalDomFixture();
  const skill = {
    id: "echoink-local:skill:toggle-rollback",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "toggle-rollback",
    description: "Skill toggle rollback fixture",
    enabled: false,
    bridgeMode: "prompt-only" as const,
    contentPath: ".echoink/skills/toggle-rollback/SKILL.md"
  };
  let persisted = structuredClone(DEFAULT_SETTINGS);
  persisted.settingsTab = "resources";
  persisted.resourceManagementTab = "skills";
  persisted.resources.catalog = [skill];
  const plugin: Record<string, any> = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings: structuredClone(persisted),
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    loadData: async () => structuredClone(persisted),
    saveData: async () => {
      throw new Error("fixture-not-committed");
    },
    buildRuntimeEchoInkResourceCatalog: async () =>
      structuredClone(plugin.settings.resources.catalog)
  };
  const store = new EchoInkSettingsStore(plugin as never);
  plugin.setEchoInkSkillResourceEnabled = async (
    resourceId: string,
    enabled: boolean
  ) => await store.withResourceMutation(async () => {
    const previous = structuredClone(plugin.settings.resources);
    const resource = plugin.settings.resources.catalog.find(
      (candidate: typeof skill) => candidate.id === resourceId
    );
    assert.ok(resource);
    resource.enabled = enabled;
    await store.saveResourceMutation(previous);
  });

  const tab = new CodexSettingTab(plugin as never);
  (tab as unknown as { runtimeEchoInkResources: typeof skill[] })
    .runtimeEchoInkResources = [structuredClone(skill)];
  tab.display();
  const toggle = tab.containerEl.querySelector<ProviderModalTestElement>(
    `[data-echoink-focus-key="resource:${skill.id}:enabled"]`
  );
  assert.ok(toggle);
  const row = toggle.closest<ProviderModalTestElement>(".codex-resource-row");
  assert.ok(row);
  assert.equal(toggle.checked, false);
  assert.equal(row.hasClass("is-disabled"), true);

  toggle.checked = true;
  await toggle.onchange?.();
  assert.equal(toggle.checked, false);
  assert.equal(row.hasClass("is-enabled"), false);
  assert.equal(row.hasClass("is-disabled"), true);
  assert.equal(plugin.settings.resources.catalog[0]?.enabled, false);
  assert.equal(persisted.resources.catalog[0]?.enabled, false);
  tab.hide();
}

async function assertProviderApiKeyEditLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const existing = createApiProviderConfig("custom", "custom-api-key-edit");
  existing.baseUrl = "https://custom.example/v1";
  existing.model = "custom-model";
  existing.models = [existing.model];
  existing.modelSelection = "model";
  existing.apiKey = "saved-api-key";

  let blankDraft: typeof existing | null = null;
  let blankInput = "not-called";
  const blankModal = new ProviderModelModal({
    app: new App(),
    draft: existing,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "unsupported" }),
      testConnection: async () => ({ status: "available" })
    },
    save: async (draft, apiKey) => {
      blankDraft = structuredClone(draft);
      blankInput = apiKey;
      return { saved: true };
    }
  });
  blankModal.open();
  const blankKey = providerModalElementByFocusKey(blankModal, "apiKey");
  assert.ok(blankKey);
  assert.match(blankKey.getAttribute("placeholder") ?? "", /saved/u);
  assert.equal(blankKey.value, "");
  providerModalElementByFocusKey(blankModal, "save")?.click();
  await flushProviderModalTasks();
  assert.equal(blankDraft?.apiKey, "saved-api-key");
  assert.equal(blankInput, "");

  let replacementDraft: typeof existing | null = null;
  let replacementInput = "";
  const replacementModal = new ProviderModelModal({
    app: new App(),
    draft: existing,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "unsupported" }),
      testConnection: async () => ({ status: "available" })
    },
    save: async (draft, apiKey) => {
      replacementDraft = structuredClone(draft);
      replacementInput = apiKey;
      return { saved: true };
    }
  });
  replacementModal.open();
  const replacementKey = providerModalElementByFocusKey(
    replacementModal,
    "apiKey"
  );
  assert.ok(replacementKey);
  replacementKey.value = "replacement-api-key";
  replacementKey.oninput?.();
  providerModalElementByFocusKey(replacementModal, "save")?.click();
  await flushProviderModalTasks();
  assert.equal(replacementDraft?.apiKey, "saved-api-key");
  assert.equal(replacementInput, "replacement-api-key");
  assert.doesNotMatch(
    replacementModal.contentEl.textContent,
    /Credential|凭据|轮换|撤销/u
  );
}

async function assertPersistedProviderRollbackPreservesQueuedSettingsSave(): Promise<void> {
  const old = createApiProviderConfig("deepseek", "persisted-old");
  old.apiKey = "persisted-old-api-key";
  let persisted = structuredClone(DEFAULT_SETTINGS);
  persisted.apiProviders = [old];
  activateApiProvider(persisted, old);
  const plugin = {
    settings: structuredClone(persisted),
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value) as typeof persisted;
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  const providerSnapshot = await store.readPersistedApiProviderSettingsSnapshot();
  const candidate = createApiProviderConfig("openai", "persisted-candidate");
  candidate.apiKey = "persisted-candidate-api-key";
  persisted.apiProviders = [candidate];
  activateApiProvider(persisted, candidate);
  const concurrentSave = store.withSettingsPersistenceAuthorityGate(async () => {
    persisted.settingsLanguage = "en";
    persisted.showWelcome = false;
  });
  const rollback = store.restorePersistedApiProviderSettingsSnapshot(
    providerSnapshot
  );
  await Promise.all([concurrentSave, rollback]);
  assert.equal(persisted.activeApiProviderId, old.id);
  assert.equal(persisted.settingsLanguage, "en");
  assert.equal(persisted.showWelcome, false);
}

async function assertProviderApiKeyPersistenceLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("deepseek", "direct-api-key");
  provider.apiKey = "direct-provider-api-key";
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.apiProviders = [provider];
  activateApiProvider(settings, provider);
  let persisted: unknown = null;
  const plugin = {
    settings,
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value);
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  await store.saveSettings(true, {
    flushConversationStore: false,
    flushRawWrites: false
  });
  const persistedProvider = (
    persisted as typeof settings
  ).apiProviders[0];
  assert.equal(persistedProvider?.apiKey, "direct-provider-api-key");
  assert.equal(Object.hasOwn(persistedProvider ?? {}, "providerRef"), false);
  assert.equal(Object.hasOwn(persistedProvider ?? {}, "credentialRef"), false);

  const reloadedPlugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value);
    }
  };
  await new EchoInkSettingsStore(reloadedPlugin as never).loadSettings();
  assert.equal(
    reloadedPlugin.settings.apiProviders[0]?.apiKey,
    "direct-provider-api-key"
  );

  const editingSettings = structuredClone(reloadedPlugin.settings);
  const editingProvider = editingSettings.apiProviders[0]!;
  const tabPlugin = {
    app: new App(),
    settings: editingSettings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    activateApiProviderSettings: async (
      apply: (candidate: typeof editingSettings) => void
    ) => apply(editingSettings)
  };
  const tab = new CodexSettingTab(tabPlugin as never) as unknown as {
    saveAndActivateProviderModel(
      draft: typeof editingProvider,
      apiKey: string,
      connectionVerified?: boolean
    ): Promise<Readonly<{ saved: boolean; message?: string }>>;
  };
  assert.equal((await tab.saveAndActivateProviderModel(
    structuredClone(editingProvider),
    ""
  )).saved, true);
  assert.equal(editingSettings.apiProviders[0]?.apiKey, "direct-provider-api-key");
  assert.equal((await tab.saveAndActivateProviderModel(
    structuredClone(editingSettings.apiProviders[0]!),
    "replacement-provider-api-key"
  )).saved, true);
  assert.equal(
    editingSettings.apiProviders[0]?.apiKey,
    "replacement-provider-api-key"
  );
}

async function assertSettingsPersistenceReadbackOutcomes(): Promise<void> {
  {
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        persisted = structuredClone(value) as typeof persisted;
        throw new Error("committed-before-throw");
      }
    };
    plugin.settings.autoOpen = !plugin.settings.autoOpen;
    const store = new EchoInkSettingsStore(plugin as never);
    await store.saveSettings(true, {
      flushConversationStore: false,
      flushRawWrites: false
    });
    assert.equal(persisted.autoOpen, plugin.settings.autoOpen);
  }

  {
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        const target = structuredClone(value) as typeof persisted;
        persisted = {
          ...target,
          autoOpen: !target.autoOpen,
          resources: {
            ...target.resources,
            catalog: target.resources.catalog.filter((resource) =>
              resource.source !== "echoink-local")
          }
        };
        throw new Error("unknown-readback");
      }
    };
    plugin.settings.autoOpenHome = !plugin.settings.autoOpenHome;
    const store = new EchoInkSettingsStore(plugin as never);
    await assert.rejects(store.saveSettings(true, {
      flushConversationStore: false,
      flushRawWrites: false
    }), (error: unknown) => {
      assert.ok(error instanceof SettingsPersistenceError);
      assert.equal(error.persistenceStatus, "unknown");
      assert.deepEqual(error.persistedSettings, normalizeSettingsData(persisted).settings);
      return true;
    });
  }

  {
    const skill = {
      id: "echoink-local:skill:authoritative-readback",
      kind: "skill" as const,
      source: "echoink-local" as const,
      name: "authoritative-readback",
      description: "Resource persistence fixture",
      enabled: false,
      bridgeMode: "prompt-only" as const,
      contentPath: ".echoink/skills/authoritative-readback/SKILL.md"
    };
    let persisted = structuredClone(DEFAULT_SETTINGS);
    persisted.resources.catalog = [skill];
    const plugin = {
      settings: structuredClone(persisted),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        const target = structuredClone(value) as typeof persisted;
        persisted = {
          ...target,
          resources: {
            ...target.resources,
            catalog: target.resources.catalog.map((resource) => ({
              ...resource,
              enabled: false
            })),
            lastError: "authoritative-resource-readback"
          }
        };
        throw new Error("resource-commit-unknown");
      }
    };
    const store = new EchoInkSettingsStore(plugin as never);
    let firstError: ResourceMutationError | null = null;
    await assert.rejects(store.withResourceMutation(async () => {
      const previous = structuredClone(plugin.settings.resources);
      plugin.settings.resources.catalog[0]!.enabled = true;
      await store.saveResourceMutation(previous);
    }), (error: unknown) => {
      assert.ok(error instanceof ResourceMutationError);
      firstError = error;
      assert.equal(error.rollbackSafe, false);
      assert.equal(error.candidateMayBePersisted, true);
      assert.equal(error.authorityKnown, true);
      return true;
    });
    assert.deepEqual(plugin.settings.resources, persisted.resources);
    assert.equal(plugin.settings.resources.catalog[0]?.enabled, false);
    await assert.rejects(
      store.withResourceMutation(async () => undefined),
      (error: unknown) => {
        assert.ok(firstError);
        assert.ok(error instanceof SettingsPersistenceError);
        assert.equal(error.persistenceStatus, "unknown");
        return true;
      }
    );
  }
}

function assertProviderBadgeReflowCssContract(): void {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const settingsTab = readFileSync(
    new URL("../src/settings/settings-tab.ts", import.meta.url),
    "utf8"
  );
  assert.match(css, /\.codex-provider-saved-meta\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/su);
  assert.match(css, /\.codex-provider-credential-badge,[\s\S]*\.codex-provider-connection-badge\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
  const activeBadgeRule = css.match(
    /\.codex-provider-active-badge\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  assert.match(activeBadgeRule, /color:\s*var\(--text-normal\)/u);
  assert.match(activeBadgeRule, /background:\s*color-mix\(in srgb,\s*var\(--interactive-accent\) 8%,\s*var\(--background-primary\)\)/u);
  assert.doesNotMatch(activeBadgeRule, /color:\s*var\(--text-accent\)/u);
  const successBadgeRule = css.match(
    /\.codex-provider-credential-badge\.is-ready,\s*\.codex-provider-connection-badge\.is-connected\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  assert.match(successBadgeRule, /color:\s*var\(--text-normal\)/u);
  assert.match(successBadgeRule, /background:\s*color-mix\([\s\S]*var\(--text-success,[\s\S]*12%[\s\S]*var\(--background-primary\)/u);
  assert.doesNotMatch(successBadgeRule, /background-modifier-success/u);
  assert.match(settingsTab, /label\("API Key 已填写", "API key configured"\)/u);
  assert.match(settingsTab, /label\("连接正常", "Connection verified"\)/u);
  assert.match(settingsTab, /label\("无需 API Key", "No API key required"\)/u);
  assertProviderBadgeDefaultThemeContrast();
  assert.match(css, /@container \(max-width:\s*520px\)[\s\S]*\.codex-provider-saved-meta\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*flex-start;/u);
  assert.match(css, /\.codex-provider-saved-identity\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/u);
  assert.match(css, /\.codex-provider-saved-copy\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/u);
  assert.match(css, /\.codex-provider-saved-provider\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/u);
  const narrowProviderRule = css.match(
    /@container \(max-width:\s*520px\)\s*\{([\s\S]*?)\n\}/u
  )?.[1] ?? "";
  assert.match(narrowProviderRule, /\.codex-provider-saved-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(narrowProviderRule, /\.codex-provider-saved-provider\s*\{[^}]*width:\s*100%;/u);
  assert.match(narrowProviderRule, /\.codex-provider-url-tooltip\s*\{[^}]*inset-inline:\s*0;[^}]*width:\s*100%;[^}]*max-width:\s*100%;/u);
  const narrowSettingsRule = css.match(
    /@container \(max-width:\s*560px\)\s*\{\s*\.echoink-settings-page\s*\{[\s\S]*?\n\}/u
  )?.[0] ?? "";
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control > select\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control > button\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
  assert.match(css, /\.echoink-settings-navigation-trailing\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/u);
  assert.match(css, /\.echoink-settings-navigation-value\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*0;[^}]*max-width:\s*28ch;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-navigation-value\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
}

function assertProviderBadgeDefaultThemeContrast(): void {
  const renderedThemeColors = {
    light: {
      textNormal: [34, 34, 34],
      activeBackground: [0.967809, 0.956104, 0.997416].map(srgbUnitToByte),
      successBackground: [225, 247, 234]
    },
    dark: {
      textNormal: [218, 218, 218],
      activeBackground: [0.144245, 0.129884, 0.177756].map(srgbUnitToByte),
      successBackground: [33, 49, 38]
    }
  } as const;
  for (const [theme, colors] of Object.entries(renderedThemeColors)) {
    assert.ok(
      contrastRatio(colors.textNormal, colors.activeBackground) >= 4.5,
      `${theme} active Provider badge must meet 4.5:1 contrast`
    );
    assert.ok(
      contrastRatio(colors.textNormal, colors.successBackground) >= 4.5,
      `${theme} successful Provider badge must retain 4.5:1 contrast`
    );
  }
}

function srgbUnitToByte(value: number): number {
  return value * 255;
}

function contrastRatio(
  foreground: readonly number[],
  background: readonly number[]
): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: readonly number[]): number {
  const [red = 0, green = 0, blue = 0] = color.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}


/** Minimal CognitiveSystem stub for settings-tab tests (no Provider, no files). */
function createCognitiveSystemStub(): Record<string, any> {
  return {
    listTemplates: async () => [],
    readPersonalityState: async () => ({
      schema: "echoink.personality.v1",
      revision: 0,
      templateId: null,
      explicit: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      observed: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      history: [],
      candidates: [],
      learnedRequirements: [],
      processedSources: [],
      updatedAt: 0
    }),
    renderPersonalitySummary: async () => "",
    selectPersonalityTemplate: async () => {
      throw new Error("cognitive stub: template selection not available in this test");
    },
    listSecondaryForParent: async () => [],
    listAllSecondary: async () => [],
    updateSecondaryFact: async () => {
      throw new Error("cognitive stub");
    },
    deleteSecondaryFact: async () => {
      throw new Error("cognitive stub");
    }
  };
}

function assertSettingsAccessibleNamesAndOverflow(): void {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("deepseek", "ui-contract");
  provider.apiKey = "ui-contract-api-key";
  const missingCredential = createApiProviderConfig(
    "deepseek",
    "ui-contract-missing"
  );
  const credentialFree = createApiProviderConfig(
    "ollama",
    "ui-contract-no-key"
  );
  settings.apiProviders = [provider, missingCredential, credentialFree];
  activateApiProvider(settings, provider);
  settings.settingsTab = "providers";
  const identityState = Object.freeze({
    agent: "# Agent",
    user: "# User",
    memory: "# Memory",
    revision: 1,
    learningEnabled: true,
    records: Object.freeze([Object.freeze({
      schema: "echoink.memory.v1",
      id: "mem_ui_private_id",
      kind: "fact",
      status: "current",
      date: "2026-08-15",
      source: "ui://private-source",
      basis: "explicit",
      contentOrigin: "user_statement",
      title: "当前事实",
      recallWhen: "需要核对事实时",
      content: "用户可见的事实正文",
      revision: 1,
      file: "records/facts/private.md"
    })]),
    forgottenIds: Object.freeze([])
  });
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkPersonalMemoryState: async () => identityState,
    listPiConversations: async () => [],
    setPiConversationStatus: async () => undefined,
    getCodexView: () => null
  };
  const tab = new CodexSettingTab(plugin as never);
  tab.display();
  const tabs = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".codex-settings-tabs"
  );
  assert.ok(tabs);
  tabs.clientWidth = 200;
  tabs.scrollWidth = 500;
  providerModalResizeObservers.at(-1)?.notify();
  assert.equal(tabs.parentElement?.hasClass("can-scroll-right"), true);
  const identity = tab.containerEl.querySelector(
    ".codex-provider-saved-identity"
  );
  assert.match(identity?.getAttribute("aria-label") ?? "", /DeepSeek/u);
  for (const action of ["edit", "delete"]) {
    const button = tab.containerEl.querySelector(
      `[data-echoink-focus-key="provider:${provider.id}:${action}"]`
    );
    assert.match(button?.getAttribute("aria-label") ?? "", /DeepSeek/u);
  }
  const providerRows = new Map([
    [provider.id, ["API Key 已填写", "is-ready"]],
    [missingCredential.id, ["未配置 API Key", "is-missing"]],
    [credentialFree.id, ["无需 API Key", "is-not-required"]]
  ] as const);
  for (const [providerId, [expectedText, expectedClass]] of providerRows) {
    const row = tab.containerEl.querySelector(
      `[data-echoink-focus-key="provider:${providerId}:edit"]`
    )?.closest(".codex-provider-saved-row");
    assert.ok(row);
    const badges = row.querySelectorAll(".codex-provider-credential-badge");
    assert.equal(badges.length, 1);
    assert.equal(badges[0]?.textContent, expectedText);
    assert.equal(badges[0]?.hasClass(expectedClass), true);
  }
  const credentialFreeRow = tab.containerEl.querySelector(
    `[data-echoink-focus-key="provider:${credentialFree.id}:edit"]`
  )?.closest(".codex-provider-saved-row");
  assert.equal(
    credentialFreeRow?.querySelector(".codex-provider-connection-badge"),
    null
  );

  settings.settingsTab = "review";
  tab.display();
  for (const label of ["生成 Agent 周报", "生成知识库周报"]) {
    const button = Array.from(tab.containerEl.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);
    assert.equal(button?.getAttribute("aria-label"), label);
  }
  assertSettingControlAccessibleName(tab.containerEl, "输出目录", "input");
  assertSettingControlAccessibleName(tab.containerEl, "统计周期", "select");
  assertSettingsToggleAccessibleName(tab.containerEl, "生成后打开 HTML");
  assert.ok(Array.from(tab.containerEl.querySelectorAll("button"))
    .some((candidate) => candidate.textContent === "选择"));
  assert.match(tab.containerEl.textContent, /已归档会话/u);
  assert.match(tab.containerEl.textContent, /记忆修正/u);
  assert.doesNotMatch(tab.containerEl.textContent, /最近报告|打开最近 HTML/u);

  assert.doesNotMatch(
    readFileSync("src/ui/codex-view/header.ts", "utf8"),
    /codex-provider-shortcut|codex-header-status/u
  );
  assert.doesNotMatch(
    readFileSync("src/ui/codex-view/view-shell.ts", "utf8"),
    /codex-kb-dashboard/u
  );

  const archivedEntry = Object.freeze({
    conversationId: "conversation-archived",
    piSessionId: "pi-archived",
    vaultId: "vault-disposable",
    title: "归档会话样例",
    status: "archived" as const,
    defaultMemoryMode: "normal" as const,
    createdAt: 1,
    updatedAt: 2,
    sessionFile: "/private/pi-session.jsonl"
  });
  const mutable = tab as unknown as {
    personalMemoryState: typeof identityState;
    archivedConversations: readonly typeof archivedEntry[];
    settingsDetail:
      | "knowledge-memory"
      | "review-archives"
      | "review-memory"
      | { kind: "review-memory-category"; category: "facts" }
      | null;
  };
  mutable.archivedConversations = Object.freeze([archivedEntry]);
  mutable.settingsDetail = "review-archives";
  tab.display();
  assert.match(tab.containerEl.textContent, /归档会话样例/u);
  assert.match(tab.containerEl.textContent, /归档时间/u);
  assert.ok(tab.containerEl.querySelector('input[aria-label="搜索已归档会话"]'));
  for (const label of ["恢复 归档会话样例", "删除 归档会话样例"]) {
    assert.ok(tab.containerEl.querySelector(`button[aria-label="${label}"]`));
  }
  assert.doesNotMatch(tab.containerEl.textContent, /pi-session\.jsonl|conversation-archived/u);

  mutable.settingsDetail = "review-memory";
  mutable.personalMemoryState = identityState;
  tab.display();
  for (const label of ["事实", "观点", "决定", "进行中", "经历"]) {
    assert.match(tab.containerEl.textContent, new RegExp(label, "u"));
  }
  mutable.settingsDetail = {
    kind: "review-memory-category",
    category: "facts"
  };
  tab.display();
  assert.match(tab.containerEl.textContent, /当前事实/u);
  assert.match(tab.containerEl.textContent, /用户可见的事实正文/u);
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /mem_ui_private_id|private-source|records\/facts|revision/u
  );

  settings.settingsTab = "general";
  mutable.settingsDetail = null;
  mutable.personalMemoryState = identityState;
  tab.display();
  assertSettingControlAccessibleName(tab.containerEl, "设置语言", "select");
  for (const label of [
    "启动时自动打开侧栏",
    "启动时自动打开首页",
    "使用长期记忆",
    "显示上下文容量",
    settingsCopy("zh-CN").general.showWelcome
  ]) {
    assertSettingsToggleAccessibleName(tab.containerEl, label);
  }
  // 人格系统重构草案 §1.1：用户不能手动编辑 AGENT.md / USER.md，设置页
  // 不再有「保存文件」编辑按钮；两份文件只由模板选择与做梦投影写入。
  assert.ok(!Array.from(tab.containerEl.querySelectorAll("button"))
    .some((button) => (button.getAttribute("aria-label") ?? "").includes("保存文件")));

  settings.settingsTab = "knowledgeBase";
  tab.display();
  assertSettingControlAccessibleName(tab.containerEl, "EchoInk 当前模型", "select");
  assert.equal(
    tab.containerEl.querySelector<HTMLOptionElement>(
      `option[value="${missingCredential.id}"]`
    )?.disabled,
    true
  );
  assert.equal(
    tab.containerEl.querySelector<HTMLOptionElement>(
      `option[value="${credentialFree.id}"]`
    )?.disabled,
    false
  );
  mutable.settingsDetail = "knowledge-memory";
  tab.display();
  assertSettingsToggleAccessibleName(tab.containerEl, "允许学习新 Memory");
  mutable.settingsDetail = null;
  tab.hide();
  assert.equal(providerModalResizeObservers.at(-1)?.disconnected, true);
}

function assertSettingControlAccessibleName(
  container: HTMLElement,
  label: string,
  selector: "input" | "select"
): void {
  const row = Array.from(container.querySelectorAll(".setting-item"))
    .find((candidate) => candidate.querySelector(".setting-item-name")?.textContent === label);
  assert.ok(row, `Expected setting row: ${label}`);
  assert.equal(row.querySelector(selector)?.getAttribute("aria-label"), label);
}

function assertSettingsToggleAccessibleName(
  container: HTMLElement,
  label: string
): void {
  const row = Array.from(container.querySelectorAll(".setting-item"))
    .find((candidate) => candidate.querySelector(".setting-item-name")?.textContent === label);
  assert.ok(row, `Expected toggle setting row: ${label}`);
  const toggle = row.querySelector<HTMLElement>(".checkbox-container");
  const input = toggle?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(toggle?.getAttribute("aria-label"), label);
  assert.equal(input?.getAttribute("aria-label"), label);
  assert.equal(toggle?.getAttribute("tabindex"), null);
  assert.equal(input?.getAttribute("tabindex"), "0");
  const tabStops = row.querySelectorAll<HTMLElement>('[tabindex="0"]');
  assert.equal(tabStops.length, 1);
  assert.equal(tabStops[0], input);
}

function assertProviderScopedRollbackPreservesConcurrentSettings(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const old = createApiProviderConfig("deepseek", "rollback-old");
  settings.apiProviders = [old];
  activateApiProvider(settings, old);
  const snapshot = snapshotApiProviderSettings(settings);
  const candidate = createApiProviderConfig("openai", "rollback-candidate");
  settings.apiProviders = [candidate];
  activateApiProvider(settings, candidate);
  settings.settingsLanguage = "en";
  settings.showWelcome = false;
  restoreApiProviderSettings(settings, snapshot);
  assert.equal(settings.activeApiProviderId, old.id);
  assert.equal(settings.settingsLanguage, "en");
  assert.equal(settings.showWelcome, false);
}

async function assertMcpModalFieldAccessibility(): Promise<void> {
  installProviderModalDomFixture();
  const modal = new McpServerModal({
    app: new App(),
    language: "en",
    save: async () => undefined
  });
  modal.open();
  const save = modal.contentEl.querySelector<HTMLButtonElement>(
    '[data-mcp-modal-focus-key="save"]'
  );
  assert.ok(save);
  save.click();
  await flushProviderModalTasks();
  const name = modal.contentEl.querySelector<HTMLInputElement>(
    '[data-mcp-modal-focus-key="name"]'
  );
  assert.ok(name);
  assert.equal(name.getAttribute("aria-invalid"), "true");
  assert.equal(
    name.getAttribute("aria-describedby"),
    "echoink-mcp-server-name-error"
  );
  assert.equal(providerModalTestDocument.activeElement, name);
  modal.close();
}

async function assertProviderModalModelAccessibleNameIncludesValue(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("deepseek", "accessible-model");
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "available", models: provider.models }),
      testConnection: async () => ({ status: "available" })
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  const trigger = providerModalElementByFocusKey(modal, "model");
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-labelledby"), null);
  assert.match(trigger.getAttribute("aria-label") ?? "", /Current model/u);
  assert.match(trigger.getAttribute("aria-label") ?? "", /Auto/u);
  modal.close();
}

function assertSettingsV49MigrationContract(): void {
  const failures: Error[] = [];
  const check = (label: string, assertion: () => void): void => {
    try {
      assertion();
    } catch (error) {
      failures.push(new Error(label, { cause: error }));
    }
  };

  check("fresh install does not select a Provider without a usable API Key", () => {
    assert.equal(DEFAULT_SETTINGS.settingsVersion, 49);
    assert.equal(DEFAULT_SETTINGS.activeApiProviderId, "");
    assert.equal(DEFAULT_SETTINGS.memory.useLongTermMemory, true);
    assert.equal(
      normalizeSettingsData(undefined).settings.activeApiProviderId,
      ""
    );
    assert.equal(
      normalizeSettingsData({ memory: { enabled: false } }).settings.memory.useLongTermMemory,
      true
    );
    assert.equal(
      normalizeSettingsData({ memory: { enabled: true, useLongTermMemory: false } }).settings.memory.useLongTermMemory,
      false
    );
  });

  check("v48 drops retired Provider references and requires API Key re-entry", () => {
    const uncredentialed = createApiProviderConfig("deepseek", "uncredentialed");
    const legacy = {
      ...uncredentialed,
      providerRef: `provider-${"a".repeat(32)}`,
      credentialRef: `cred-${"b".repeat(32)}`
    };
    const unavailable = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 48,
      activeApiProviderId: uncredentialed.id,
      apiProviders: [legacy]
    }).settings;
    assert.equal(unavailable.activeApiProviderId, "");
    assert.equal(unavailable.apiProviders[0]?.apiKey, "");
    assert.equal(
      Object.hasOwn(unavailable.apiProviders[0] ?? {}, "providerRef"),
      false
    );
    assert.equal(
      Object.hasOwn(unavailable.apiProviders[0] ?? {}, "credentialRef"),
      false
    );

    const configured = createApiProviderConfig("deepseek", "configured");
    configured.apiKey = "persisted-provider-api-key";
    const available = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 49,
      activeApiProviderId: configured.id,
      apiProviders: [configured]
    }).settings;
    assert.equal(available.activeApiProviderId, configured.id);
    assert.equal(available.apiProviders[0]?.apiKey, configured.apiKey);
  });

  check("v48 drops retired Knowledge scheduling state but preserves Review scheduling", () => {
    const result = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 48,
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        enabled: true,
        scheduleTime: "08:30",
        catchUpOnStartup: false,
        lastScheduledRunAt: 101,
        lastScheduledRunStatus: "success",
        lastScheduledRunId: "legacy-run",
        scheduledAttemptCount: 2,
        scheduledNextRetryAt: 202
      },
      review: {
        ...structuredClone(DEFAULT_SETTINGS.review),
        enabled: true,
        scheduleTime: "22:15",
        catchUpOnStartup: false,
        reports: {
          knowledgeBase: {
            lastRangeKey: "2026-08-03-to-2026-08-09",
            lastRunAt: 101,
            lastRunStatus: "success",
            lastMarkdownPath: "outputs/legacy.md",
            lastHtmlPath: "outputs/legacy.html",
            lastError: "legacy",
            lastSummary: "legacy"
          },
          agentChat: {
            lastRangeKey: ""
          }
        }
      },
      agents: {
        hermes: { apiKey: "sentinel-not-a-real-key" }
      }
    });
    const normalized = result.settings;
    assert.equal(result.changed, true);
    const knowledge = normalized.knowledgeBase as unknown as Record<string, unknown>;
    for (const key of [
      "scheduleTime",
      "catchUpOnStartup",
      "lastScheduledRunAt",
      "lastScheduledRunStatus",
      "lastScheduledRunId",
      "scheduledAttemptCount",
      "scheduledNextRetryAt"
    ]) {
      assert.equal(Object.hasOwn(knowledge, key), false, key);
    }
    assert.equal(normalized.review.scheduleTime, "22:15");
    assert.equal(normalized.review.catchUpOnStartup, false);
    assert.equal(normalized.review.enabled, true);
    assert.deepEqual(normalized.review.reports.knowledgeBase, {
      lastRangeKey: "2026-08-03-to-2026-08-09"
    });
    assert.deepEqual(normalized.review.reports.agentChat, {
      lastRangeKey: ""
    });
    assert.equal(
      JSON.stringify(normalized).includes("sentinel-not-a-real-key"),
      false
    );
    assert.equal(
      Object.hasOwn(normalized as unknown as Record<string, unknown>, "agents"),
      false
    );
  });

  check("legacy resource scope overrides collapse to one false-wins global switch", () => {
    const resource = {
      id: "skill-false-wins",
      kind: "skill" as const,
      source: "manual" as const,
      name: "False wins",
      description: "migration fixture",
      enabled: true,
      scopes: ["chat", "knowledge", "editor-actions"] as const,
      bridgeMode: "prompt-only" as const,
      contentPath: "skills/false-wins/SKILL.md"
    };
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [resource],
        enabledByScope: {
          chat: { [resource.id]: true },
          knowledge: { [resource.id]: false },
          "editor-actions": {}
        }
      }
    }).settings;
    const resources = normalized.resources as unknown as Record<string, unknown>;
    const migrated = (resources.catalog as Array<Record<string, unknown>>)[0];
    assert.equal(migrated?.enabled, false);
    assert.equal(Object.hasOwn(resources, "enabledByScope"), false);
    assert.equal(Object.hasOwn(migrated ?? {}, "scopes"), false);
  });

  check("v47 overrides-only false remains closed when a Vault Skill is rediscovered", () => {
    const resourceId = "echoink-local:skill:vault-only-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: {
          chat: { [resourceId]: true },
          knowledge: { [resourceId]: false },
          "editor-actions": {}
        }
      }
    }).settings;
    assert.deepEqual(normalized.resources.catalog, []);
    assert.equal(normalized.resources.legacyEnabledOverrides?.[resourceId], false);
    const merged = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: [{
        id: resourceId,
        kind: "skill",
        source: "echoink-local",
        name: "Rediscovered fixture",
        description: "",
        enabled: true,
        bridgeMode: "prompt-only",
        contentPath: "skills/rediscovered/SKILL.md"
      }]
    });
    assert.equal(merged[0]?.enabled, false);
  });

  check("v47 overrides-only true remains enabled over a disabled Vault binding", () => {
    const resourceId = "echoink-local:skill:vault-true-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: {
          chat: { [resourceId]: true },
          knowledge: {},
          "editor-actions": {}
        }
      }
    }).settings;
    const merged = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: [{
        id: resourceId,
        kind: "skill",
        source: "echoink-local",
        name: "Vault runtime fixture",
        description: "",
        enabled: false,
        bridgeMode: "prompt-only",
        contentPath: ".echoink/resources/skills/vault-true-fixture/SKILL.md"
      }]
    });
    assert.equal(
      merged.find((resource) => resource.id === resourceId)?.enabled,
      true
    );
    assert.deepEqual(normalized.resources.catalog, []);
  });

  check("stale v47 resource overrides never materialize ghost resources", () => {
    const staleId = "echoink-local:skill:removed-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: { chat: { [staleId]: true } }
      }
    }).settings;
    const catalog = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: []
    });
    assert.deepEqual(normalized.resources.catalog, []);
    assert.deepEqual(catalog, []);
    assert.deepEqual(enabledSkillResources(catalog), []);
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, "Settings v49 migration contract failed");
  }
}

async function assertRetiredSettingsRewritePersistence(): Promise<void> {
  const resource = {
    id: "manual:skill:retired-rewrite",
    kind: "skill" as const,
    source: "manual" as const,
    name: "Retired rewrite",
    description: "fixture",
    enabled: true,
    scopes: ["chat"] as const,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/retired-rewrite/SKILL.md"
  };
  let persisted: unknown = {
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 48,
    mcpEnabled: true,
    agents: { hermes: { apiKey: "sentinel-not-a-real-key" } },
    knowledgeBase: {
      ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
      enabled: true,
      scheduleTime: "08:30",
      catchUpOnStartup: false
    },
    resources: {
      ...structuredClone(DEFAULT_SETTINGS.resources),
      catalog: [resource],
      enabledByScope: { chat: { [resource.id]: false } }
    }
  };
  let saveCount = 0;
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      saveCount += 1;
      persisted = structuredClone(value);
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  await store.loadSettings();
  assert.equal(saveCount, 1);
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, /sentinel-not-a-real-key|"agents"|"hermes"/u);
  const data = persisted as Record<string, any>;
  assert.equal(Object.hasOwn(data.knowledgeBase, "enabled"), false);
  assert.equal(Object.hasOwn(data.knowledgeBase, "scheduleTime"), false);
  assert.equal(Object.hasOwn(data.knowledgeBase, "catchUpOnStartup"), false);
  assert.equal(Object.hasOwn(data.resources, "enabledByScope"), false);
  assert.equal(Object.hasOwn(data.resources.catalog[0], "scopes"), false);
  assert.equal(data.resources.catalog[0].enabled, false);
  assert.equal(Object.hasOwn(data, "mcpEnabled"), false);
}

async function assertMcpPanelUsesTurnResourceTruth(): Promise<void> {
  installProviderModalDomFixture();
  const createHost = (catalog: ReturnType<typeof mcpResourceFixture>[]) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.resources.catalog = structuredClone(catalog);
    return {
      app: new App(),
      plugin: { settings },
      running: false,
      selectedModel: "",
      selectedReasoning: settings.defaultReasoning,
      selectedServiceTier: settings.defaultServiceTier,
      selectedPermission: settings.defaultPermission,
      selectedMode: settings.defaultMode,
      ensureSession: () => settings.sessions[0],
      renderToolbar: () => undefined,
      renderMessages: () => undefined,
      updateInputPlaceholder: () => undefined,
      currentTurnOptions: () => currentTurnOptions({} as never),
      effectiveModel: () => "fixture-model"
    };
  };
  const render = (
    catalog: ReturnType<typeof mcpResourceFixture>[],
    error: string | null = null
  ) => {
    const host = createHost(catalog);
    const container = document.createElement("div");
    let retries = 0;
    const state = mcpResourceEnablement(catalog);
    renderMcpPanelView(container, error, state, {
      onRetry: () => { retries += 1; }
    });
    return { host, container, retries: () => retries };
  };

  const empty = render([]);
  assert.equal(empty.container.getAttribute("role"), "region");
  assert.equal(empty.container.getAttribute("aria-labelledby"), "echoink-mcp-panel-title");
  assert.equal(
    empty.container.querySelector(".codex-mcp-title")?.getAttribute("id"),
    "echoink-mcp-panel-title"
  );
  assert.match(empty.container.textContent, /当前没有 MCP 资源/u);
  const emptyStatus = empty.container.querySelector(".codex-mcp-empty");
  assert.ok(emptyStatus);
  assert.equal(emptyStatus.getAttribute("role"), "status");
  assert.equal(emptyStatus.getAttribute("aria-live"), "polite");
  assert.equal(currentTurnOptions(empty.host as never).mcpEnabled, false);

  const disabledCatalog = [mcpResourceFixture("disabled-a", false), mcpResourceFixture("disabled-b", false)];
  const disabled = render(disabledCatalog);
  assert.match(disabled.container.textContent, /当前 2 个 MCP 资源均已关闭/u);
  assert.equal(currentTurnOptions(disabled.host as never).mcpEnabled, false);

  const partialCatalog = [mcpResourceFixture("enabled", true), mcpResourceFixture("disabled", false)];
  const partial = render(partialCatalog);
  assert.match(partial.container.textContent, /当前已启用 1 \/ 2 个 MCP 资源/u);
  assert.match(partial.container.textContent, /Server 与 Tool 信任策略/u);
  assert.equal(currentTurnOptions(partial.host as never).mcpEnabled, true);

  const error = render(partialCatalog, "fixture scan failed");
  assert.match(error.container.textContent, /读取失败：fixture scan failed/u);
  assert.doesNotMatch(error.container.textContent, /当前已启用|均已关闭|没有读取到/u);
  assert.equal(error.container.querySelector(".codex-mcp-error")?.getAttribute("role"), "alert");
  assert.equal(error.container.querySelector(".codex-mcp-empty"), null);
  const retry = error.container.querySelector<HTMLButtonElement>(".codex-mcp-retry");
  assert.ok(retry);
  assert.equal(retry.textContent, "重新读取 MCP");
  assert.equal(retry.getAttribute("type"), "button");
  assert.equal(retry.getAttribute("aria-label"), "重新读取 MCP");
  retry.click();
  assert.equal(error.retries(), 1);

  const loaderContainer = document.createElement("div");
  let loaderReads = 0;
  const loaderInput = {
    container: loaderContainer,
    loadResources: () => {
      loaderReads += 1;
      if (loaderReads === 1) throw new Error("fixture catalog failed");
      return { total: 2, enabled: 1 };
    }
  };
  await assert.doesNotReject(loadMcpPanelView(loaderInput));
  assert.equal(loaderReads, 1);
  assert.match(loaderContainer.textContent, /读取失败：fixture catalog failed/u);
  assert.equal(loaderContainer.querySelector(".codex-mcp-error")?.getAttribute("role"), "alert");
  assert.equal(loaderContainer.querySelector(".codex-mcp-empty"), null);
  const loaderRetry = loaderContainer.querySelector<HTMLButtonElement>(".codex-mcp-retry");
  assert.ok(loaderRetry);
  loaderRetry.click();
  await flushProviderModalTasks();
  assert.equal(loaderReads, 2);
  assert.doesNotMatch(loaderContainer.textContent, /读取失败/u);
  assert.match(loaderContainer.textContent, /当前已启用 1 \/ 2 个 MCP 资源/u);

  assert.doesNotMatch(readFileSync("src/settings/i18n.ts", "utf8"), /mcpDisabledWarning|chat MCP master switch|聊天 MCP 总开关/u);
  assert.doesNotMatch(readFileSync("src/settings/settings.ts", "utf8"), /^\s*mcpEnabled\??:/mu);
  assert.match(readFileSync("src/ui/turn-options.ts", "utf8"), /^\s*mcpEnabled:/mu);
}

function mcpResourceFixture(id: string, enabled: boolean) {
  return {
    id: `manual:mcp-server:${id}`,
    kind: "mcp-server" as const,
    source: "manual" as const,
    name: id,
    description: "fixture",
    enabled,
    bridgeMode: "native" as const
  };
}

function assertKnowledgeSettingsDetailRetiresLegacyControls(): void {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "knowledgeBase";
  const preference = Object.freeze({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "custom" as const,
    revision: `sha256:${"a".repeat(64)}`,
    content: "# 自定义偏好\n\n优先保留失败、反例和决策边界。\n"
  });
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkKnowledgeMaintenancePreferenceState: async () => preference,
    saveEchoInkKnowledgeMaintenancePreferences: async () => preference
  };
  const tab = new CodexSettingTab(plugin as never);
  const mutableTab = tab as unknown as {
    knowledgePreferenceState: typeof preference;
    knowledgePreferenceEditor: ReturnType<
      typeof createKnowledgeMaintenancePreferenceEditor
    >;
  };
  mutableTab.knowledgePreferenceState = preference;
  mutableTab.knowledgePreferenceEditor =
    createKnowledgeMaintenancePreferenceEditor(preference);

  tab.display();
  assert.match(tab.containerEl.textContent, /Knowledge Agent/u);
  assert.match(tab.containerEl.textContent, /空知识库或没有命中时仍由 Pi Agent 正常回答/u);
  assert.match(tab.containerEl.textContent, /显式 \/maintain 会直接完成提炼、安全写入和回读验证/u);
  assert.match(tab.containerEl.textContent, /知识提炼偏好/u);
  assert.doesNotMatch(tab.containerEl.textContent, /等待确认|维护预览/u);
  assertLegacyKnowledgeControlsAbsent(tab.containerEl.textContent);
  const unavailableModelOption = tab.containerEl.querySelector<HTMLOptionElement>(
    'option[value=""]'
  );
  assert.equal(unavailableModelOption?.textContent, "无可用模型");

  const preferenceNavigation = tab.containerEl.querySelector<HTMLButtonElement>(
    '[data-echoink-focus-key="knowledge:preferences"]'
  );
  assert.ok(preferenceNavigation);
  preferenceNavigation.click();

  const steps = tab.containerEl.querySelectorAll(
    ".echoink-knowledge-protocol-item"
  );
  assert.equal(steps.length, 6);
  assert.match(tab.containerEl.textContent, /固定提炼步骤/u);
  assert.match(tab.containerEl.textContent, /自检、安全写入与回读/u);
  assert.doesNotMatch(tab.containerEl.textContent, /待确认预览|确认时仍提交原预览/u);
  const textarea = tab.containerEl.querySelector<HTMLTextAreaElement>(
    ".echoink-knowledge-preference-textarea"
  );
  const restore = tab.containerEl.querySelector<HTMLButtonElement>(
    '[data-echoink-focus-key="knowledge:preferences:restore"]'
  );
  const save = tab.containerEl.querySelector<HTMLButtonElement>(
    '[data-echoink-focus-key="knowledge:preferences:save"]'
  );
  const status = tab.containerEl.querySelector(
    ".echoink-knowledge-preference-status"
  );
  assert.ok(textarea);
  assert.ok(restore);
  assert.ok(save);
  assert.ok(status);
  assert.equal(textarea.value, preference.content);
  assert.match(status.textContent, /已自定义 · 已保存/u);
  assert.equal(save.disabled, true);

  textarea.value = `${preference.content}\n新增关注维度。`;
  textarea.oninput?.(new Event("input"));
  assert.match(status.textContent, /有未保存修改/u);
  assert.equal(save.disabled, false);
  restore.click();
  assert.equal(
    textarea.value,
    ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
  );
  assert.match(status.textContent, /使用 EchoInk 默认 · 有未保存修改/u);
  assert.equal(restore.disabled, true);
  assertLegacyKnowledgeControlsAbsent(tab.containerEl.textContent);
}

function assertLegacyKnowledgeControlsAbsent(text: string): void {
  for (const retired of [
    "LLM-WIKI.md",
    "规则文件路径",
    "修复规则文件",
    "打开规则文件",
    "定时维护",
    "启动补跑"
  ]) {
    assert.doesNotMatch(text, new RegExp(retired, "u"), retired);
  }
}

function assertNewProductGenerationKeepsConfigurationButDropsLegacyHistory(): void {
  const provider = createApiProviderConfig("deepseek", "retained-provider");
  provider.apiKey = "retained-provider-api-key";
  const retainedSkill = {
    id: "skill-retained",
    kind: "skill" as const,
    source: "manual" as const,
    name: "Retained Skill",
    description: "retained",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/retained/SKILL.md"
  };
  const retainedResources = {
    ...structuredClone(DEFAULT_SETTINGS.resources),
    catalog: [retainedSkill],
    enabledByScope: {
      chat: { [retainedSkill.id]: true, "tool-bundle:echoink-vault": true }
    },
    mcpConnections: {
      "mcp-retained": {
        transport: "http" as const,
        url: "https://example.invalid/mcp",
        trusted: true,
        toolPolicies: {},
        credential: {
          credentialRef: `cred-${"c".repeat(32)}`,
          purpose: "mcp_header" as const,
          targetName: "Authorization",
          endpointRevision: 1
        },
        tools: []
      }
    }
  };
  const legacyInput = {
    ...structuredClone(DEFAULT_SETTINGS),
    productGeneration: undefined,
    activeApiProviderId: provider.id,
    providerRef: `provider-${"a".repeat(32)}`,
    credentialRef: `cred-${"b".repeat(32)}`,
    apiProviders: [provider],
    resources: retainedResources,
    sessions: [{
      id: "legacy-session",
      title: "legacy",
      kind: "chat",
      messages: []
    }],
    activeSessionId: "legacy-session",
    knowledgeBase: {
      ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
      sessionId: "legacy-session",
      lastRunAt: 123,
      lastRunStatus: "success",
      lastReportPath: "outputs/legacy.md",
      processedSources: { "raw/legacy.md": { path: "raw/legacy.md" } }
    }
  };

  const normalized = normalizeSettingsData(legacyInput).settings;
  assert.equal(normalized.productGeneration, "pi-agent-product-v1");
  assert.equal(normalized.activeApiProviderId, provider.id);
  assert.equal(normalized.apiProviders[0]?.apiKey, provider.apiKey);
  assert.equal(Object.hasOwn(normalized.apiProviders[0] ?? {}, "providerRef"), false);
  assert.equal(Object.hasOwn(normalized.apiProviders[0] ?? {}, "credentialRef"), false);
  assert.equal(normalized.resources.catalog[0]?.id, retainedSkill.id);
  assert.equal(normalized.resources.catalog[0]?.enabled, true);
  assert.equal(Object.hasOwn(normalized.resources, "enabledByScope"), false);
  assert.equal(normalized.resources.mcpConnections["mcp-retained"]?.credential?.credentialRef, retainedResources.mcpConnections["mcp-retained"].credential.credentialRef);
  assert.deepEqual(normalized.sessions, []);
  assert.equal(normalized.activeSessionId, "");
  assert.equal(normalized.knowledgeBase.lastRunAt, 0);
  assert.equal(normalized.knowledgeBase.lastRunStatus, "idle");
  assert.equal(normalized.knowledgeBase.lastReportPath, "");
  assert.deepEqual(normalized.knowledgeBase.processedSources, {});

  const currentGenerationWithRetiredKnowledgeShell = {
    ...structuredClone(DEFAULT_SETTINGS),
    productGeneration: "pi-agent-product-v1",
    activeApiProviderId: provider.id,
    apiProviders: [provider],
    sessions: [
      {
        id: "retired-knowledge-session",
        title: "Knowledge",
        kind: "knowledge-base",
        messages: []
      },
      {
        id: "current-conversation",
        title: "Current",
        messages: []
      }
    ],
    activeSessionId: "retired-knowledge-session"
  };
  const currentNormalized = normalizeSettingsData(currentGenerationWithRetiredKnowledgeShell).settings;
  assert.equal(currentNormalized.activeApiProviderId, provider.id);
  assert.equal(currentNormalized.apiProviders[0]?.apiKey, provider.apiKey);
  assert.deepEqual(currentNormalized.sessions.map((session) => session.id), ["current-conversation"]);
  assert.equal(currentNormalized.activeSessionId, "current-conversation");
}

function assertPresetRequestMappings(): void {
  for (const preset of API_PROVIDER_PRESETS) {
    const configuration = createApiProviderConfig(preset.id, `${preset.id}-fixture`);
    if (!configuration.baseUrl) continue;
    const url = apiProviderRequestUrl(configuration.baseUrl, configuration.apiProtocol);
    assert.ok(url.startsWith(configuration.baseUrl));
    assert.ok(url.length > configuration.baseUrl.length);
  }
}

function assertProviderTooltipBehavior(): void {
  assert.equal(
    providerTooltipBaseUrl("deepseek", "https://ignored.example.com"),
    "https://api.deepseek.com"
  );
  assert.equal(
    providerTooltipBaseUrl("custom", "  https://custom.example.com/v1  "),
    "https://custom.example.com/v1"
  );
  assert.equal(providerTooltipBaseUrl("custom", "   "), "");
}

function assertSavedModelLifecycle(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const primary = createApiProviderConfig("deepseek", "primary");
  const fallback = createApiProviderConfig("ollama", "fallback");
  settings.apiProviders = [primary, fallback];

  activateApiProvider(settings, primary);
  assert.equal(settings.activeApiProviderId, primary.id);
  assert.equal(applyApiProviderModelPreset(primary, primary.models[1] ?? primary.model), true);
  assert.equal(removeApiProvider(settings, primary.id), true);
  assert.equal(settings.activeApiProviderId, fallback.id);
  assert.equal(removeApiProvider(settings, fallback.id), true);
  assert.equal(settings.activeApiProviderId, "");
}

async function assertSavedBindingPreflightLifecycle(): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "saved-provider");
  provider.apiKey = "saved-provider-api-key";
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: provider.id,
    providerId: "deepseek",
    runtimeProviderId: provider.runtimeProviderId,
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    modelId: provider.model,
    apiKey: "",
    toolCalling: provider.toolCalling,
    imageInput: provider.imageInput,
    reasoning: provider.reasoning,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens
  };
  assert.equal(providerPreflightApiKeyReady({
    providerId: "deepseek",
    apiKey: "",
    storedApiKey: provider.apiKey
  }), true);

  let resolveAutomatic!: (result: PiProviderModelListResult) => void;
  const automaticResult = new Promise<PiProviderModelListResult>((resolve) => {
    resolveAutomatic = resolve;
  });
  const calls: string[] = [];
  let modelListAttempt = 0;
  let connectionAttempt = 0;
  const service = {
    listModels: async (input: PiProviderConfigurationDraft) => {
      calls.push("listModels");
      modelListAttempt += 1;
      assert.equal(input.providerSettingsId, provider.id);
      assert.equal(input.apiKey, "");
      if (modelListAttempt === 1) return await automaticResult;
      return {
        status: modelListAttempt === 2
          ? "temporary_failure" as const
          : "credential_error" as const,
        models: []
      };
    },
    testConnection: async (input: PiProviderConfigurationDraft) => {
      calls.push("testConnection");
      connectionAttempt += 1;
      assert.equal(input.providerSettingsId, provider.id);
      assert.equal(input.apiKey, "");
      return connectionAttempt === 1
        ? { status: "failed" as const, failure: "protocol" as const }
        : { status: "available" as const };
    }
  };
  const states: string[] = [];
  const preflight = new ProviderPreflightSession(
    service,
    (state) => states.push(`${state.operation}:${state.status}`)
  );

  const automatic = preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "loading");
  assert.equal(modelListAttempt, 1);
  resolveAutomatic({
    status: "available",
    models: [provider.model]
  });
  await automatic;
  assert.equal(preflight.state.status, "available");
  assert.deepEqual(preflight.state.models, [provider.model]);

  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "temporary_failure");
  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "credential_error");
  await preflight.testConnection(draft);
  assert.equal(preflight.state.status, "unsupported");
  assert.equal(preflight.state.connectionFailure, "protocol");
  await preflight.testConnection(draft);
  assert.equal(preflight.state.status, "available");
  assert.deepEqual(calls, [
    "listModels",
    "listModels",
    "listModels",
    "testConnection",
    "testConnection"
  ]);
  assert.deepEqual(states, [
    "model_list:loading",
    "model_list:available",
    "model_list:loading",
    "model_list:temporary_failure",
    "model_list:loading",
    "model_list:credential_error",
    "connection:loading",
    "connection:unsupported",
    "connection:loading",
    "connection:available"
  ]);
}

async function assertProviderModelModalPreflightLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const copy = settingsCopy("en");
  const provider = createApiProviderConfig("deepseek", "saved-modal-provider");
  provider.apiKey = "saved-modal-provider-api-key";
  const automatic = deferred<PiProviderModelListResult>();
  const connections = [
    deferred<PiProviderConnectionTestResult>(),
    deferred<PiProviderConnectionTestResult>()
  ];
  const calls: Array<{
    operation: "listModels" | "testConnection";
    draft: PiProviderConfigurationDraft;
  }> = [];
  let connectionAttempt = 0;
  const service = {
    listModels: async (draft: PiProviderConfigurationDraft) => {
      calls.push({ operation: "listModels", draft: structuredClone(draft) });
      return await automatic.promise;
    },
    testConnection: async (draft: PiProviderConfigurationDraft) => {
      calls.push({ operation: "testConnection", draft: structuredClone(draft) });
      const pending = connections[connectionAttempt++];
      assert.ok(pending);
      return await pending.promise;
    }
  };
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy,
    preflight: service,
    save: async () => ({ saved: true })
  });

  modal.open();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "listModels");
  assert.equal(calls[0]?.draft.providerSettingsId, provider.id);
  assert.equal(calls[0]?.draft.apiKey, "");
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);

  automatic.resolve({ status: "available", models: provider.models });
  await flushProviderModalTasks();
  const firstTest = providerModalElementByFocusKey(
    modal,
    "provider-test-connection"
  );
  assert.ok(firstTest);
  firstTest.click();
  assert.equal(calls[1]?.operation, "testConnection");
  assert.equal(calls[1]?.draft.modelId, provider.model);
  assert.equal(calls[1]?.draft.apiKey, "");
  assertProviderModalStatus(modal, "loading", copy.providers.testingConnection);

  const nextModel = provider.models.find((model) => model !== provider.model);
  assert.ok(nextModel);
  const nextModelOption = Array.from(
    modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.title === nextModel);
  assert.ok(nextModelOption);
  nextModelOption.click();
  assertProviderModalStatus(modal, "idle");

  connections[0]?.resolve({ status: "available" });
  await flushProviderModalTasks();
  assertProviderModalStatus(modal, "idle");
  assert.doesNotMatch(
    providerModalStatus(modal).textContent,
    new RegExp(copy.providers.connectionAvailable, "u")
  );

  const secondTest = providerModalElementByFocusKey(
    modal,
    "provider-test-connection"
  );
  assert.ok(secondTest);
  secondTest.click();
  assert.equal(calls[2]?.operation, "testConnection");
  assert.equal(calls[2]?.draft.modelId, nextModel);
  assert.equal(calls[2]?.draft.apiKey, "");

  const customProvider = modal.contentEl.querySelector<HTMLButtonElement>(
    '[data-provider-id="custom"]'
  );
  assert.ok(customProvider);
  customProvider.click();
  const endpoint = providerModalElementByFocusKey(modal, "endpoint");
  assert.ok(endpoint);

  connections[1]?.resolve({ status: "available" });
  await flushProviderModalTasks();
  assert.equal(providerModalElementByFocusKey(modal, "endpoint"), endpoint);
  assert.deepEqual(
    calls.map((call) => call.operation),
    ["listModels", "testConnection", "testConnection"]
  );
  modal.close();
}

async function assertProviderModelModalCloseCancelsPendingPreflight(): Promise<void> {
  installProviderModalDomFixture();
  const copy = settingsCopy("en");
  const provider = createApiProviderConfig("deepseek", "close-modal-provider");
  provider.apiKey = "close-modal-provider-api-key";
  const first = deferred<PiProviderModelListResult>();
  const reopened = deferred<PiProviderModelListResult>();
  const pending = [first, reopened];
  let attempt = 0;
  const service = {
    listModels: async () => {
      const result = pending[attempt++];
      assert.ok(result);
      return await result.promise;
    },
    testConnection: async (): Promise<PiProviderConnectionTestResult> => ({
      status: "available"
    })
  };
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy,
    preflight: service,
    save: async () => ({ saved: true })
  });
  const closedRequestModel = "closed-request-model";

  modal.open();
  assert.equal(attempt, 1);
  modal.close();
  first.resolve({ status: "available", models: [closedRequestModel] });
  await flushProviderModalTasks();

  modal.open();
  assert.equal(attempt, 2);
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);
  assert.equal(
    Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .some((button) => button.title === closedRequestModel),
    false
  );
  reopened.resolve({ status: "available", models: [provider.model] });
  await flushProviderModalTasks();
  modal.close();
}

function assertProviderModalStatus(
  modal: ProviderModelModal,
  status: string,
  text?: string
): void {
  const element = providerModalStatus(modal);
  assert.equal(element.hasClass(`is-${status}`), true);
  if (text) assert.match(element.textContent, new RegExp(text, "u"));
}

function providerModalStatus(modal: ProviderModelModal): ProviderModalTestElement {
  const status = modal.contentEl.querySelector(
    ".codex-provider-model-status"
  ) as ProviderModalTestElement | null;
  assert.ok(status);
  return status;
}

function providerModalElementByFocusKey(
  modal: ProviderModelModal,
  focusKey: string
): ProviderModalTestElement | null {
  return modal.contentEl.querySelector(
    `[data-modal-focus-key="${focusKey}"]`
  ) as ProviderModalTestElement | null;
}

function replacementGuidanceAnnouncementCount(modal: ProviderModelModal): number {
  const liveRegion = modal.modalEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-modal-live-region"
  );
  assert.ok(liveRegion);
  return liveRegion.textContentAssignments.filter((message) =>
    /Connection settings changed/u.test(message)
  ).length;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushProviderModalTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let providerModalTestDocument: ProviderModalTestDocument;


// ---------------------------------------------------------------------------
// R4: Agent identity — settings card, naming modal, avatar processing
// ---------------------------------------------------------------------------

function createIdentityFixtureState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    agent: "# Agent",
    user: "# User",
    memory: "# Memory",
    revision: 3,
    learningEnabled: true,
    records: Object.freeze([]),
    forgottenIds: Object.freeze([]),
    agentIdentity: {
      schema: "echoink.agent-identity.v1",
      revision: 1,
      displayName: "小墨",
      avatar: { kind: "default" },
      updatedAt: 123
    },
    personalityState: {
      schema: "echoink.personality.v1",
      revision: 1,
      templateId: "executor",
      explicit: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      observed: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      history: [],
      candidates: [],
      learnedRequirements: [],
      processedSources: [],
      updatedAt: 0
    },
    ...overrides
  };
}

function createIdentityTestPlugin(fixtureState: Record<string, any>): {
  plugin: Record<string, any>;
  refreshCalls: () => number;
  personalMemoryCalls: () => number;
} {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "general";
  let refreshes = 0;
  let personalMemoryCalls = 0;
  const plugin: Record<string, any> = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getCodexView: () => ({ refreshPersonalizationUi: () => { refreshes += 1; } }),
    getEchoInkPersonalMemoryState: async () => {
      personalMemoryCalls += 1;
      return structuredClone(fixtureState);
    }
  };
  return {
    plugin,
    refreshCalls: () => refreshes,
    personalMemoryCalls: () => personalMemoryCalls
  };
}

async function assertAgentIdentityCardPlacementAndCopy(): Promise<void> {
  installProviderModalDomFixture();
  const { plugin } = createIdentityTestPlugin(createIdentityFixtureState());
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = createIdentityFixtureState();
  tab.display();

  const identityCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-card"
  );
  assert.ok(identityCard, "identity card must render in the personalization section");
  assert.match(identityCard.textContent, /小墨/u);
  assert.match(identityCard.textContent, /名称和头像会显示在 Agent 回复旁/u);
  assert.ok(identityCard.querySelector(".echoink-agent-identity-edit"), "edit button exists");

  // Identity card must come BEFORE the Agent profile card.
  const cards = Array.from(
    tab.containerEl.querySelectorAll<ProviderModalTestElement>(
      ".echoink-agent-identity-card, .echoink-agent-profile-card"
    )
  );
  const identityIndex = cards.findIndex((card) => card.hasClass("echoink-agent-identity-card"));
  const profileIndex = cards.findIndex((card) => card.hasClass("echoink-agent-profile-card"));
  assert.ok(identityIndex >= 0 && profileIndex >= 0 && identityIndex < profileIndex,
    "identity card must precede the Agent profile card");

  // Copy: Agent 身份 / Agent 画像 / 用户画像；no AGENT.md / USER.md filenames.
  const text = tab.containerEl.textContent;
  assert.match(text, /Agent 身份/u);
  assert.match(text, /Agent 画像/u);
  assert.match(text, /用户画像/u);
  assert.doesNotMatch(text, /AGENT\.md|USER\.md/u);
  assert.match(text, /查看完整画像/u);
  assert.doesNotMatch(text, /查看完整描述/u);
  console.log("PASS settings: identity card placement and profile copy");
}

async function assertIdentityEditSaveRefreshesSettingsAndPersonalization(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin, refreshCalls } = createIdentityTestPlugin(fixtureState);
  let updated: { displayName: string; avatar: { kind: string } } | null = null;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    updateAgentIdentity: async (draft: { displayName: string; avatar: { kind: string } }) => {
      updated = draft;
      fixtureState.agentIdentity = {
        schema: "echoink.agent-identity.v1",
        revision: 2,
        displayName: draft.displayName,
        avatar: draft.avatar,
        updatedAt: 456
      };
      return { revision: 4, identity: fixtureState.agentIdentity, agent: "# Agent" };
    }
  });

  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as {
    personalMemoryState: Record<string, any> | null;
    loadPersonalMemoryState(force?: boolean): Promise<void>;
  };
  mutable.personalMemoryState = createIdentityFixtureState();
  tab.display();

  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  assert.ok(editButton);
  editButton.click();

  // The shared modal opens prefilled with the current identity.
  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  assert.ok(nameInput, "identity modal must open with a name input");
  assert.equal((nameInput as unknown as { value: string }).value, "小墨");

  (nameInput as unknown as { value: string }).value = "阿澈";
  nameInput.fireEvent("input");
  const confirm = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-confirm");
  assert.ok(confirm);
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, false);
  confirm.click();
  await settleMicrotasks();

  assert.ok(updated, "updateAgentIdentity must be called on save");
  assert.equal(updated!.displayName, "阿澈");
  assert.equal(refreshCalls() >= 1, true, "personalization UI refresh must fire after save");
  console.log("PASS settings: identity edit save refreshes settings and personalization UI");
}

async function assertFirstNamingModalZeroWriteOnCancel(): Promise<void> {
  installProviderModalDomFixture();
  // First-time template selection without identity must open the naming modal
  // and NEVER call selectPersonalityTemplate until 完成设置.
  const fixtureState = createIdentityFixtureState({
    agentIdentity: {
      schema: "echoink.agent-identity.v1",
      revision: 0,
      displayName: "EchoInk",
      avatar: { kind: "default" },
      updatedAt: 0
    },
    personalityState: {
      schema: "echoink.personality.v1",
      revision: 0,
      templateId: null,
      explicit: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      observed: { tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null },
      history: [], candidates: [], learnedRequirements: [], processedSources: [],
      updatedAt: 0
    }
  });
  const { plugin } = createIdentityTestPlugin(fixtureState);
  let templateCalls = 0;
  let lastInitialIdentity: unknown = null;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => fixtureState.personalityState,
    readAgentIdentity: async () => fixtureState.agentIdentity,
    renderPersonalitySummary: async () => "summary",
    selectPersonalityTemplate: async (
      templateId: string,
      options?: { initialIdentity?: unknown }
    ) => {
      templateCalls += 1;
      lastInitialIdentity = options?.initialIdentity ?? null;
      return {
        revision: 1,
        state: { ...fixtureState.personalityState, templateId },
        agent: "# Agent",
        identity: fixtureState.agentIdentity
      };
    }
  });

  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const templateBtn = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-reselect"
  );
  assert.ok(templateBtn, "template button must exist when no template is chosen");
  templateBtn.click();

  const row = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-picker-row");
  assert.ok(row, "picker rows render");
  row.click();
  await settleMicrotasks();

  // First-time: the naming modal opened instead of writing anything.
  assert.equal(templateCalls, 0, "clicking a template must not write before naming");
  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  assert.ok(nameInput, "naming modal must open after template click");

  // Cancel = zero writes.
  const cancel = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-cancel");
  assert.ok(cancel);
  cancel.click();
  await settleMicrotasks();
  assert.equal(templateCalls, 0, "cancel must keep zero writes");

  // Re-open and complete the flow: exactly one call with initialIdentity.
  templateBtn.click();
  const rowAgain = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-picker-row");
  rowAgain!.click();
  await settleMicrotasks();
  const nameInput2 = findLatestModalElement<ProviderModalTestElement>("name-input");
  (nameInput2 as unknown as { value: string }).value = "小墨";
  nameInput2!.fireEvent("input");
  const confirm2 = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-confirm");
  assert.equal((confirm2 as unknown as { disabled: boolean }).disabled, false);
  confirm2!.click();
  await settleMicrotasks();

  assert.equal(templateCalls, 1, "完成设置 commits template + identity once");
  assert.deepEqual(lastInitialIdentity, {
    displayName: "小墨",
    avatar: { kind: "default" }
  });
  console.log("PASS settings: first naming modal keeps zero writes on cancel");
}

async function assertIdentityModalNameValidation(): Promise<void> {
  installProviderModalDomFixture();
  let confirmed: { displayName: string } | null = null;
  const modal = new AgentIdentityModal(new App(), {
    initialName: "",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "first-run",
    onConfirm: async (draft) => { confirmed = { displayName: draft.displayName }; }
  });
  modal.open();

  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  const errorEl = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-error"
  );
  const confirm = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-confirm"
  );
  assert.ok(nameInput && errorEl && confirm);

  // Empty name: disabled with visible reason.
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, true);
  assert.match(errorEl!.textContent, /请输入名称/u);

  // Too long (25 Unicode chars): disabled with visible reason.
  (nameInput as unknown as { value: string }).value = "一二三四五六七八九十一二三四五六七八九十一二三四五";
  nameInput!.fireEvent("input");
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, true);
  assert.match(errorEl!.textContent, /不能超过 24/u);

  // Valid CJK + Emoji name: enabled; confirm passes trimmed draft.
  (nameInput as unknown as { value: string }).value = "  小墨🖋️  ";
  nameInput!.fireEvent("input");
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, false);
  assert.equal(errorEl!.textContent, "");
  confirm!.click();
  await settleMicrotasks();
  assert.deepEqual(confirmed, { displayName: "小墨🖋️" });
  console.log("PASS settings: identity modal validates empty/too-long names");
}

async function assertAvatarPresetCatalogBehavior(): Promise<void> {
  installProviderModalDomFixture();

  // Empty catalog (the shipped default): no preset list in the modal.
  const emptyModal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    onConfirm: async () => undefined
  });
  emptyModal.open();
  assert.equal(emptyModal.contentEl.querySelector(".echoink-agent-avatar-preset-list"), null,
    "empty preset catalog must hide the list entirely");

  // Fake catalog: presets become selectable and produce a presetId draft.
  let saved: { avatar: { kind: string; presetId?: string } } | null = null;
  const fakeCatalog = Object.freeze([{
    id: "preset-ink",
    labelZh: "墨点",
    labelEn: "Ink Dot",
    assetPath: "assets/avatars/ink-dot.webp"
  }]);
  const modal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    presets: fakeCatalog,
    resolvePresetAsset: (id) => resolveAgentAvatarPresetAsset(id, fakeCatalog),
    onConfirm: async (draft) => { saved = { avatar: draft.avatar as never }; }
  });
  modal.open();
  const list = modal.contentEl.querySelector<ProviderModalTestElement>(".echoink-agent-avatar-preset-list");
  assert.ok(list, "non-empty catalog renders the preset list");
  const chip = list!.querySelector<ProviderModalTestElement>(".echoink-agent-avatar-preset");
  assert.ok(chip);
  assert.match(chip!.textContent, /墨点/u);
  chip!.click();
  const preview = modal.contentEl.querySelector<ProviderModalTestElement>("img");
  assert.ok(preview, "selected preset renders its asset in the preview");
  assert.equal(preview!.getAttribute("src"), "assets/avatars/ink-dot.webp");

  const confirm = modal.contentEl.querySelector<ProviderModalTestElement>(".echoink-agent-identity-confirm");
  confirm!.click();
  await settleMicrotasks();
  assert.deepEqual(saved, { avatar: { kind: "preset", presetId: "preset-ink" } });

  // Resolver: unknown preset and default avatar both fall back to null (bot icon).
  assert.equal(resolveAgentAvatarPresetAsset("missing"), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "default" }), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "preset", presetId: "missing" }), null);
  assert.equal(
    resolveAgentAvatarUrl({ kind: "preset", presetId: "preset-ink" }, fakeCatalog),
    "assets/avatars/ink-dot.webp"
  );
  console.log("PASS settings: preset catalog hidden when empty and selectable when provided");
}

async function assertAvatarProcessorContract(): Promise<void> {
  const smallWebp = "data:image/webp;base64,UkVE";
  const fakeRenderer = (result: { sourceWidth: number; sourceHeight: number; dataUrl: string }) =>
    async () => result;

  // Type validation: png/jpeg/webp accepted; svg/gif/heic/bmp/pdf rejected.
  assert.equal(validateAvatarSourceType("image/png"), true);
  assert.equal(validateAvatarSourceType("image/jpeg"), true);
  assert.equal(validateAvatarSourceType("image/webp"), true);
  for (const type of ["image/svg+xml", "image/gif", "image/heic", "image/bmp", "application/pdf", ""]) {
    assert.equal(validateAvatarSourceType(type), false, `must reject ${type}`);
  }
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/gif", 10, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /unsupported_type/u
  );

  // Size validation: 4MB cap on the source file.
  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES), true);
  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES + 1), false);
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/png", AGENT_AVATAR_SOURCE_MAX_BYTES + 1, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /source_too_large/u
  );

  // Dimension cap: any edge over 4096px is rejected after decode.
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/png", 100, fakeRenderer({ sourceWidth: 5000, sourceHeight: 100, dataUrl: smallWebp })),
    /image_too_large/u
  );

  // Output contract: 256x256 webp state.
  const ok = await processAgentAvatar(
    new BlobStub() as never, "image/jpeg", 100,
    fakeRenderer({ sourceWidth: 800, sourceHeight: 600, dataUrl: smallWebp })
  );
  assert.equal(ok.kind, "custom");
  assert.equal(ok.mimeType, "image/webp");
  assert.equal(ok.width, 256);
  assert.equal(ok.height, 256);
  assert.equal(ok.dataUrl, smallWebp);

  // JPEG data URL output is invalid (must be re-encoded to webp/png).
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/jpeg", 100, fakeRenderer({ sourceWidth: 800, sourceHeight: 600, dataUrl: "data:image/jpeg;base64,QUJD" })),
    /output_invalid/u
  );

  // Oversized output Data URL is rejected before persistence.
  const huge = `data:image/webp;base64,${"A".repeat(AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS)}`;
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/png", 100, fakeRenderer({ sourceWidth: 800, sourceHeight: 600, dataUrl: huge })),
    /output_too_large/u
  );

  // Decode failure surfaces decode_failed, never a raw fallback.
  await assert.rejects(
    processAgentAvatar(new BlobStub() as never, "image/png", 100, async () => { throw new Error("boom"); }),
    /decode_failed/u
  );

  // The identity JSON only ever contains the processed (small) Data URL,
  // never the raw source bytes.
  const rawMarker = "RAW_SOURCE_BYTES_MUST_NOT_APPEAR";
  const processed = await processAgentAvatar(
    { size: AGENT_AVATAR_SOURCE_MAX_BYTES } as never,
    "image/png",
    AGENT_AVATAR_SOURCE_MAX_BYTES,
    fakeRenderer({ sourceWidth: 4096, sourceHeight: 4096, dataUrl: smallWebp })
  );
  const json = agentIdentityStateJson({
    schema: AGENT_IDENTITY_STATE_SCHEMA,
    revision: 1,
    displayName: "小墨",
    avatar: processed,
    updatedAt: 1
  });
  assert.ok(json.length < AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS + 10_000);
  assert.ok(!json.includes(rawMarker));
  console.log("PASS settings: avatar processor type/size/dimension/output contract");
}

class BlobStub {}

function findLatestModalElement<T extends ProviderModalTestElement>(selector: string): T | null {
  const modal = openTestModals[openTestModals.length - 1];
  if (!modal) return null;
  const root = modal.contentEl as unknown as ProviderModalTestElement;
  if (selector === "name-input") {
    return root.querySelectorAll<T>("input")
      .find((input) => !input.hasClass("echoink-agent-identity-file")) ?? null;
  }
  return root.querySelector<T>(selector);
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function installProviderModalDomFixture(): void {
  if (providerModalTestDocument) return;
  providerModalTestDocument = new ProviderModalTestDocument();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.document = providerModalTestDocument;
  scope.window = globalThis;
  scope.Element = ProviderModalTestElement;
  scope.HTMLElement = ProviderModalTestElement;
  scope.SVGElement = ProviderModalTestSvgElement;
  scope.SVGSVGElement = ProviderModalTestSvgElement;
  scope.DOMParser = ProviderModalTestDomParser;
  scope.MouseEvent = ProviderModalTestMouseEvent;
  scope.innerHeight = 900;
  scope.addEventListener = () => undefined;
  scope.removeEventListener = () => undefined;
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  scope.cancelAnimationFrame = () => undefined;
  providerModalResizeObservers.length = 0;
  scope.ResizeObserver = ProviderModalTestResizeObserver;
}

const providerModalResizeObservers: ProviderModalTestResizeObserver[] = [];

class ProviderModalTestResizeObserver {
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    providerModalResizeObservers.push(this);
  }
  observe(): void { this.disconnected = false; }
  disconnect(): void { this.disconnected = true; }
  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class ProviderModalTestMouseEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown> = {}
  ) {}
}

class ProviderModalTestDocument {
  activeElement: ProviderModalTestElement | null = null;
  readonly defaultView = { MouseEvent: ProviderModalTestMouseEvent };

  createElement(tagName: string): ProviderModalTestElement {
    return new ProviderModalTestElement(tagName, this);
  }

  importNode(node: ProviderModalTestElement): ProviderModalTestElement {
    if (node instanceof ProviderModalTestSvgElement) {
      return new ProviderModalTestSvgElement(this);
    }
    return new ProviderModalTestElement(node.localName, this);
  }
}

class ProviderModalTestDomParser {
  parseFromString(): {
    documentElement: ProviderModalTestSvgElement;
    querySelector: () => null;
  } {
    return {
      documentElement: new ProviderModalTestSvgElement(providerModalTestDocument),
      querySelector: () => null
    };
  }
}

class ProviderModalTestClassList {
  constructor(private readonly element: ProviderModalTestElement) {}

  add(...classes: string[]): void {
    this.element.addClass(...classes);
  }

  remove(...classes: string[]): void {
    this.element.removeClass(...classes);
  }

  contains(className: string): boolean {
    return this.element.hasClass(className);
  }

  toggle(className: string, force?: boolean): boolean {
    const enabled = force ?? !this.contains(className);
    this.element.toggleClass(className, enabled);
    return enabled;
  }
}

class ProviderModalTestStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeProperty(name: string): string {
    const previous = this.values.get(name) ?? "";
    this.values.delete(name);
    return previous;
  }
}

class ProviderModalTestElement {
  readonly children: ProviderModalTestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = new ProviderModalTestClassList(this);
  readonly style = new ProviderModalTestStyle();
  readonly textContentAssignments: string[] = [];
  readonly tagName: string;
  readonly localName: string;
  readonly namespaceURI: string;
  parentElement: ProviderModalTestElement | null = null;
  className = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  clientWidth = 0;
  scrollWidth = 0;
  scrollLeft = 0;
  title = "";
  href = "";
  onclick: ((event: any) => void) | null = null;
  onchange: ((event?: any) => void) | null = null;
  oninput: ((event?: any) => void) | null = null;
  onkeydown: ((event: any) => void) | null = null;
  private readonly eventListeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const list = this.eventListeners.get(type) ?? [];
    list.push(handler);
    this.eventListeners.set(type, list);
  }

  removeEventListener(type: string, handler: ((event: any) => void) | null): void {
    const list = this.eventListeners.get(type);
    if (!list || !handler) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** Fire both on<type> property handlers and addEventListener handlers. */
  fireEvent(type: string, event: Record<string, unknown> = {}): void {
    const synthetic = {
      target: this,
      currentTarget: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      stopImmediatePropagation: () => undefined,
      ...event
    };
    const onHandler = (this as unknown as Record<string, ((e: any) => void) | null>)[`on${type}`];
    onHandler?.(synthetic);
    for (const listener of this.eventListeners.get(type) ?? []) listener(synthetic);
  }
  private readonly attributeValues = new Map<string, string>();
  private ownTextContent = "";
  private connected = true;

  constructor(
    tagName: string,
    readonly ownerDocument: ProviderModalTestDocument,
    namespaceURI = "http://www.w3.org/1999/xhtml"
  ) {
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get textContent(): string {
    return this.ownTextContent
      + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.disconnectChildren();
    this.ownTextContent = String(value ?? "");
    this.textContentAssignments.push(this.ownTextContent);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Array.from(this.attributeValues, ([name, value]) => ({ name, value }));
  }

  append(...children: ProviderModalTestElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: ProviderModalTestElement): ProviderModalTestElement {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.setConnected(this.connected);
    this.children.push(child);
    return child;
  }

  removeChild(child: ProviderModalTestElement): ProviderModalTestElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.setConnected(false);
    return child;
  }

  replaceChildren(...children: ProviderModalTestElement[]): void {
    this.disconnectChildren();
    this.ownTextContent = "";
    this.append(...children);
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  empty(): void {
    this.disconnectChildren();
    this.ownTextContent = "";
  }

  createEl(
    tagName: string,
    options: Record<string, any> = {}
  ): ProviderModalTestElement {
    const child = new ProviderModalTestElement(tagName, this.ownerDocument);
    if (typeof options.cls === "string") child.className = options.cls;
    if (options.text !== undefined) child.textContent = String(options.text);
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, String(value));
    }
    if (options.value !== undefined) child.value = String(options.value);
    if (options.href !== undefined) {
      child.href = String(options.href);
      child.setAttribute("href", child.href);
    }
    this.appendChild(child);
    return child;
  }

  createDiv(options: Record<string, any> | string = {}): ProviderModalTestElement {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: Record<string, any> | string = {}): ProviderModalTestElement {
    return this.createEl("span", typeof options === "string" ? { cls: options } : options);
  }

  setText(value: string): void {
    this.textContent = value;
  }

  addClass(...classes: string[]): void {
    const current = new Set(this.className.split(/\s+/u).filter(Boolean));
    for (const className of classes) current.add(className);
    this.className = Array.from(current).join(" ");
  }

  removeClass(...classes: string[]): void {
    const removed = new Set(classes);
    this.className = this.className
      .split(/\s+/u)
      .filter((className) => className && !removed.has(className))
      .join(" ");
  }

  toggleClass(className: string, enabled: boolean): void {
    if (enabled) this.addClass(className);
    else this.removeClass(className);
  }

  hasClass(className: string): boolean {
    return this.className.split(/\s+/u).includes(className);
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  }

  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value);
    if (name === "class") this.className = value;
    if (name === "value") this.value = value;
    if (name === "type") this.type = value;
    if (name === "title") this.title = value;
    if (name === "href") this.href = value;
    if (name.startsWith("data-")) {
      this.dataset[dataAttributeKey(name)] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    return this.attributeValues.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributeValues.delete(name);
    if (name === "class") this.className = "";
    if (name.startsWith("data-")) delete this.dataset[dataAttributeKey(name)];
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.attributeValues.has(name);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  querySelector<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T[] {
    const matches: T[] = [];
    const visit = (element: ProviderModalTestElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesSimpleSelector(
      this,
      part.trim()
    ));
  }

  closest<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T | null {
    let current: ProviderModalTestElement | null = this;
    while (current) {
      if (current.matches(selector)) return current as T;
      current = current.parentElement;
    }
    return null;
  }

  contains(element: ProviderModalTestElement): boolean {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }

  focus(): void {
    if (this.connected) this.ownerDocument.activeElement = this;
  }

  click(): void {
    this.fireEvent("click");
  }

  dispatchEvent(): boolean {
    return true;
  }

  getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } {
    return { top: 100, bottom: 132, left: 0, right: 240, width: 240, height: 32 };
  }

  scrollIntoView(): void {}

  private disconnectChildren(): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.setConnected(false);
    }
    this.children.length = 0;
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    for (const child of this.children) child.setConnected(connected);
  }
}

class ProviderModalTestSvgElement extends ProviderModalTestElement {
  constructor(ownerDocument: ProviderModalTestDocument) {
    super("svg", ownerDocument, "http://www.w3.org/2000/svg");
  }
}

function matchesSimpleSelector(
  element: ProviderModalTestElement,
  selector: string
): boolean {
  if (!selector) return false;
  const negations = Array.from(selector.matchAll(/:not\(([^)]+)\)/gu));
  for (const negation of negations) {
    if (matchesSimpleSelector(element, negation[1] ?? "")) return false;
  }
  const base = selector.replace(/:not\([^)]+\)/gu, "");
  if (base.includes(":disabled") && !element.disabled) return false;
  const withoutPseudos = base.replace(/:disabled/gu, "");
  const tag = withoutPseudos.match(/^[a-z][a-z0-9-]*/iu)?.[0];
  if (tag && element.localName !== tag.toLowerCase()) return false;
  for (const id of withoutPseudos.matchAll(/#([a-z0-9_-]+)/giu)) {
    if (element.id !== id[1]) return false;
  }
  for (const className of withoutPseudos.matchAll(/\.([a-z0-9_-]+)/giu)) {
    if (!element.hasClass(className[1] ?? "")) return false;
  }
  for (const attribute of withoutPseudos.matchAll(
    /\[([^\]=]+)(?:=["']([^"']*)["'])?\]/gu
  )) {
    const actual = element.getAttribute(attribute[1] ?? "");
    if (actual === null) return false;
    if (attribute[2] !== undefined && actual !== attribute[2]) return false;
  }
  return withoutPseudos === "*" || Boolean(
    tag
    || withoutPseudos.includes("#")
    || withoutPseudos.includes(".")
    || withoutPseudos.includes("[")
  );
}

function dataAttributeKey(name: string): string {
  return name
    .slice(5)
    .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

await runProviderSettingsBehaviorTests();
