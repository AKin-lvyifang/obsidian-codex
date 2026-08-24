import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App, openTestModals } from "obsidian";
import type {
  AssistantMessage,
  ProviderStreams,
  StreamOptions
} from "@earendil-works/pi-ai";
import {
  MOONSHOTAI_CN_MODELS
} from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import {
  activateApiProvider,
  activateApiProviderModel,
  applyApiProviderModelPreset,
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  resolveEchoInkWelcomeCopy,
  removeApiProvider,
  type ApiProviderConfig,
  type ApiProviderModelConfig
} from "../settings/settings";
import CodexForObsidianPlugin from "../main";
import { API_PROVIDER_PRESETS, apiProviderRequestUrl } from "../settings/provider-presets";
import { providerTooltipBaseUrl } from "../settings/provider-tooltip";
import type {
  PiProviderConfigurationDraft,
  PiProviderConnectionTestResult,
  PiProviderModelListResult
} from "../plugin/pi-provider-configuration-service";
import { PiProviderConfigurationService } from "../plugin/pi-provider-configuration-service";
import {
  createOpenAICodexSseAdapter,
  PiProviderProtocolTransport,
  type PiProviderProtocolDispatcher
} from "../harness/pi/pi-provider-protocol-adapter";
import {
  createPiProviderModelDefinition
} from "../harness/pi/production-pi-model-resolver";
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
import {
  ApiProviderActivationService,
  ProductActivityGate
} from "../plugin/api-provider-activation-service";
import { CodexView } from "../ui/codex-view";
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
  settingsForDataSave,
  snapshotApiProviderSettings
} from "../plugin/settings-store";
import { AgentIdentityModal } from "../ui/agent-identity-modal";
import { KnowledgeNotePickerModal } from "../settings/knowledge-note-picker-modal";
import {
  AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS,
  AGENT_AVATAR_SOURCE_MAX_BYTES,
  processAgentAvatar,
  validateAgentAvatarSvg,
  validateAvatarSourceSize,
  validateAvatarSourceType
} from "../ui/agent-avatar-processor";
import {
  AGENT_AVATAR_PRESETS,
  DEFAULT_AGENT_AVATAR_PRESET_ID,
  resolveAgentAvatarPresetAsset,
  resolveAgentAvatarUrl
} from "../ui/agent-avatar-presets";
import {
  AGENT_IDENTITY_STATE_SCHEMA,
  agentIdentityStateJson
} from "../harness/memory/agent-identity-state";
import {
  applyTemplateToState,
  emptyPersonalityState
} from "../harness/memory/personality-state";
import {
  PERSONALITY_TEMPLATES,
  TRAIT_DIMENSIONS,
  TRAIT_DIMENSION_META,
  traitBehaviorBand,
  type PersonalityTemplate
} from "../harness/memory/personality-templates";
import { getDimensionShortLabel } from "../ui/trait-hexagon";
import {
  advanceEchoInkOnboardingTutorial,
  deriveEchoInkOnboardingTruth,
  dismissEchoInkOnboardingTutorial,
  ECHOINK_ONBOARDING_VERSION,
  echoInkOnboardingTab,
  isEmptyEchoInkPluginData,
  onboardingCoachmarkCopy,
  prepareEchoInkOnboardingTutorial,
  shouldAutoStartEchoInkOnboarding
} from "../settings/onboarding";
import { renderCodexHeader, updateCodexHeaderIdentity } from "../ui/codex-view/header";
import { mountEchoInkOnboardingCoachmark } from "../ui/onboarding-coachmark";
import { KNOWLEDGE_INITIALIZATION_ROOTS } from "../knowledge-base/initializer";
import {
  logoutOpenAICodexAfterRuntimeSuspension,
  OpenAICodexOAuthService,
  OpenAICodexSettingsCredentialStore
} from "../plugin/openai-codex-oauth-service";

export async function runProviderSettingsBehaviorTests(): Promise<void> {
  assertSettingsV51MigrationContract();
  assertOnboardingTruthContract();
  assertFiveStepOnboardingEntrypoints();
  assertCodexHeaderIdentityContract();
  await assertOnboardingCoachmarkAccessibilityContract();
  await assertOnboardingDoesNotLockSettingsNavigation();
  await assertManualOnboardingReopenIsRemoved();
  await assertRetiredSettingsRewritePersistence();
  assertProviderScopedRollbackPreservesConcurrentSettings();
  await assertPersistedProviderRollbackPreservesQueuedSettingsSave();
  await assertSettingsPersistenceReadbackOutcomes();
  assertConversationSettingsDiscardMessageBodies();
  await assertProviderApiKeyPersistenceLifecycle();
  await assertOpenAICodexCredentialStoreContract();
  await assertOpenAICodexLogoutSuspendsRuntime();
  await runApiProviderActivationServiceTests();
  await assertProviderActivationMainTransactionContract();
  assertAllOpenComposersSynchronizeAfterActivation();
  await runEditorTranslationServiceTests();
  runEditorTranslationSelectionTests();
  await assertProviderTextGenerationCompletionContract();
  assertPresetRequestMappings();
  assertOpenAICodexSseAdapterContract();
  await assertProviderAuthResolutionFailureContract();
  assertProviderTooltipBehavior();
  assertSavedModelLifecycle();
  assertNewProductGenerationKeepsConfigurationButDropsLegacyHistory();
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  await assertKnowledgeInitializationExperienceContract();
  await assertAnimatedSettingsTabIcons();
  assertSettingsAccessibleNamesAndOverflow();
  await assertMemoryCorrectionModalContract();
  assertMemoryComposerVisualCssContract();
  await assertMcpPanelUsesTurnResourceTruth();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  await assertResourceScanErrorsClearAcrossTabs();
  assertProviderBadgeReflowCssContract();
  await assertSavedBindingPreflightLifecycle();
  await assertProviderPickerGroupingAndFiltering();
  await assertOpenAICodexModalLifecycle();
  await assertProviderModelModalPreflightLifecycle();
  await assertProviderApiKeyEditLifecycle();
  await assertProviderModalModelAccessibleNameIncludesValue();
  await assertProviderModelModalCloseCancelsPendingPreflight();
  await assertMcpModalFieldAccessibility();
  await runHarnessV2PiObsidianSecretStorageTests();
  await runHarnessV2PiProviderSecurityTests();
  await runPiNativeControlledProviderTests();
  await assertAgentIdentityCardPlacementAndCopy();
  await assertCustomWelcomeSettingsUi();
  assertCustomWelcomeContract();
  assertAboutGitHubActionsContract();
  await assertIdentityEditSaveRefreshesSettingsAndPersonalization();
  await assertFirstNamingModalZeroWriteOnCancel();
  await assertIdentityEntryWithoutTemplateOpensPicker();
  await assertIdentityEntryFirstRunKeepsSingleTransaction();
  await assertIdentityEntryWithTemplateOpensEditModal();
  await assertTemplatePickerCardGridStructure();
  await assertPersonalityResetStillRequiresConfirm();
  await assertIdentityEntryRespectsFailClosedRetry();
  await assertIdentityModalNameValidation();
  await assertAvatarPresetCatalogBehavior();
  await assertAvatarProcessorContract();
  await assertPersonalityCardUsesNewBehaviorDimensions();
  await assertHexagonCaptionSurvivesRepeatedAsyncRender();
}

function replaceProviderModels(
  provider: ApiProviderConfig,
  ...modelIds: string[]
): void {
  provider.models = modelIds.map((modelId) =>
    createApiProviderModelConfig(provider.providerId, modelId)
  );
  provider.defaultModelId = provider.models[0]?.id ?? "";
}

function primaryProviderModel(provider: ApiProviderConfig): ApiProviderModelConfig {
  const model = provider.models.find(
    (candidate) => candidate.id === provider.defaultModelId
  );
  assert.ok(model);
  return model;
}

async function assertProviderActivationMainTransactionContract(): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "transaction-provider");
  provider.apiKey = "fixture-key";
  const alternateId = API_PROVIDER_PRESETS.find(
    (candidate) => candidate.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(alternateId);
  provider.models.push(createApiProviderModelConfig("deepseek", alternateId));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.apiProviders = [provider];
  activateApiProvider(settings, provider);
  const events: string[] = [];
  const plugin = Object.create(
    CodexForObsidianPlugin.prototype
  ) as CodexForObsidianPlugin & Record<string, any>;
  plugin.settings = settings;
  plugin.piRunConversations = new Map();
  plugin.productActivity = new ProductActivityGate();
  plugin.apiProviderActivation = new ApiProviderActivationService();
  plugin.piRuntimeBundle = null;
  plugin.piRuntimeFlight = null;
  plugin.piActivatedConversationId = null;
  plugin.cancelAllPiConversationActivations = async () => {
    events.push("cancel-activations");
  };
  let persisted = snapshotApiProviderSettings(settings);
  plugin.getSettingsStore = () => ({
    readPersistedApiProviderSettingsSnapshot: async () => {
      events.push("read-persisted");
      return structuredClone(persisted);
    },
    restorePersistedApiProviderSettingsSnapshot: async (
      snapshot: typeof persisted
    ) => {
      events.push("restore-persisted");
      persisted = structuredClone(snapshot);
    }
  });
  plugin.saveSettings = async () => {
    events.push("persist-candidate");
    persisted = snapshotApiProviderSettings(plugin.settings);
  };
  plugin.applyComposerDefaultsToView = () => {
    events.push("sync-composers");
  };

  plugin.piRunConversations.set("conversation-busy", "run-busy");
  await assert.rejects(
    plugin.activateApiProviderSettings(() => undefined),
    /正在回答/u
  );
  assert.deepEqual(events, [], "busy must be checked before activation cancellation");
  plugin.piRunConversations.clear();

  await assert.rejects(plugin.activateApiProviderSettings((candidate) => {
    const model = candidate.apiProviders[0]?.models[0];
    assert.ok(model);
    model.contextWindow = 1_024;
    model.modelMaxTokens = 2_048;
    model.maxOutputTokens = 2_048;
  }), /Context|metadata/u);
  assert.deepEqual(events, [], "invalid candidate must fail before cancellation or persistence");
  assert.equal(plugin.settings.defaultModel, provider.defaultModelId);

  await plugin.activateApiProviderSettings((candidate) => {
    const target = candidate.apiProviders[0];
    assert.ok(target);
    activateApiProviderModel(candidate, target, alternateId);
  }, "preserve");
  assert.deepEqual(events, [
    "cancel-activations",
    "read-persisted",
    "persist-candidate",
    "sync-composers"
  ]);
  assert.equal(plugin.settings.defaultModel, alternateId);
  assert.equal(persisted.defaultModel, alternateId);
}

function assertAllOpenComposersSynchronizeAfterActivation(): void {
  const synchronized: string[] = [];
  const first = Object.create(CodexView.prototype) as CodexView;
  const second = Object.create(CodexView.prototype) as CodexView;
  first.applySavedComposerDefaults = () => { synchronized.push("first"); };
  second.applySavedComposerDefaults = () => { synchronized.push("second"); };
  CodexForObsidianPlugin.prototype.applyComposerDefaultsToView.call({
    app: {
      workspace: {
        getLeavesOfType: () => [
          { view: first },
          { view: { applySavedComposerDefaults: () => synchronized.push("other") } },
          { view: second }
        ]
      }
    }
  });
  assert.deepEqual(synchronized, ["first", "second"]);
}

async function assertAnimatedSettingsTabIcons(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "providers";
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkPersonalMemoryState: async () => ({
      agent: "# Agent",
      user: "# User",
      memory: "# Memory",
      revision: 0,
      learningEnabled: true,
      records: [],
      forgottenIds: []
    }),
    listPiConversations: async () => [],
    setPiConversationStatus: async () => undefined,
    getCodexView: () => null
  });
  const tab = new CodexSettingTab(plugin as never);
  tab.display();

  const expected = [
    ["general", "settings"],
    ["providers", "key-round"],
    ["resources", "layout-list"],
    ["knowledgeBase", "book-open-check"],
    ["review", "clipboard-check"]
  ] as const;
  const icons = tab.containerEl.querySelectorAll<ProviderModalTestElement>(
    ".codex-settings-tab-icon"
  );
  assert.equal(icons.length, expected.length);
  expected.forEach(([tabId, iconName], index) => {
    assert.equal(
      icons[index]?.parentElement?.getAttribute("data-settings-tab"),
      tabId
    );
    assert.equal(icons[index]?.getAttribute("data-animated-icon"), iconName);
    assert.equal(icons[index]?.hasClass("is-animating"), false);
    const svg = icons[index]?.querySelector("svg");
    assert.ok(svg, `${iconName} renders its own layered SVG`);
    assert.equal(svg.getAttribute("data-animateicons-source"), "lucide");
    assert.equal(svg.getAttribute("data-animateicons-icon"), iconName);
  });
  const iconFor = (tabId: string) => tab.containerEl
    .querySelector(`[data-settings-tab="${tabId}"]`)
    ?.querySelector<ProviderModalTestElement>(".codex-settings-tab-icon");
  assert.equal(iconFor("general")?.querySelectorAll('[data-part="settings-spark"]').length, 5);
  assert.ok(iconFor("general")?.querySelector('[data-part="settings-gear-draw"]'));
  assert.ok(iconFor("general")?.querySelector('[data-part="settings-core-draw"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-path"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-bite"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-head"]'));
  assert.equal(iconFor("resources")?.querySelectorAll('[data-part="layout-box"]').length, 2);
  assert.equal(iconFor("resources")?.querySelectorAll('[data-part="layout-line"]').length, 4);
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-spine"]'));
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-body"]'));
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-check"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-clip"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-body"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-check"]'));

  const providers = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="providers"]'
  );
  assert.ok(providers);
  providers.fireEvent("keydown", { key: "End" });
  await flushProviderModalTasks();

  const review = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="review"]'
  );
  assert.equal(review?.getAttribute("aria-selected"), "true");
  assert.equal(review?.getAttribute("tabindex"), "0");
  assert.equal(
    review?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    true
  );

  const mutableTab = tab as unknown as {
    renderSettingsContent(): void;
    settingsTabIconAnimation: { tabId: string; startedAtMs: number } | null;
  };
  assert.ok(mutableTab.settingsTabIconAnimation);
  mutableTab.settingsTabIconAnimation.startedAtMs = Date.now() - 400;
  mutableTab.renderSettingsContent();
  const continuedIcon = tab.containerEl.querySelector('[data-settings-tab="review"]')
    ?.querySelector<ProviderModalTestElement>(".codex-settings-tab-icon");
  assert.equal(continuedIcon?.hasClass("is-animating"), true);
  assert.ok(
    Number.parseInt(
      continuedIcon?.style.getPropertyValue("--echoink-tab-icon-delay") ?? "0",
      10
    ) <= -350,
    "same-tab rerenders continue the original timeline instead of replaying it"
  );
  mutableTab.settingsTabIconAnimation = {
    tabId: "review",
    startedAtMs: Date.now() - 1_300
  };
  mutableTab.renderSettingsContent();
  assert.equal(
    tab.containerEl.querySelector('[data-settings-tab="review"]')
      ?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    false,
    "the tab icon animation ends after its bounded window"
  );

  tab.display();
  const providersAgain = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="providers"]'
  );
  assert.ok(providersAgain);
  providersAgain.fireEvent("pointerdown");
  providersAgain.click();
  await flushProviderModalTasks();
  assert.equal(
    tab.containerEl.querySelector('[data-settings-tab="providers"]')
      ?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    true,
    "pointer tab switches animate the newly selected icon once"
  );

  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const keyframe of [
    "settings-motion",
    "settings-gear-draw",
    "settings-core-draw",
    "settings-spark",
    "key-motion",
    "key-path",
    "key-bite",
    "key-head",
    "layout-box",
    "layout-line",
    "book-motion",
    "book-spine",
    "book-body",
    "book-check",
    "clipboard-body",
    "clipboard-clip",
    "clipboard-check"
  ]) {
    assert.match(css, new RegExp(`@keyframes echoink-tab-icon-${keyframe}\\b`, "u"));
  }
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.codex-settings-tab-icon\.is-animating svg[\s\S]*animation:\s*none !important;/u
  );
  tab.hide();
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
    /\.codex-composer-send-icon-wrap svg,\s*\.codex-composer-send-button \.echoink-animate-icon-send-horizontal,\s*\.codex-composer-send-button \.echoink-animate-icon-circle-stop\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const stopButtonRule = css.match(
    /\.codex-composer-send-button\.codex-send-button\.is-stop-action\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const permissionKeyboardFocusRule = css.match(
    /\.codex-permission-control \.codex-composer-native-select\.codex-select:is\(:focus, :focus-visible\)\s*\{([^}]*)\}/u
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
  assert.match(sendButtonRule, /color:\s*var\(--text-normal\);/u);
  assert.match(sendButtonRule, /box-shadow:\s*none\s*!important;/u);
  assert.doesNotMatch(sendButtonRule, /interactive-accent|text-on-accent/u);
  assert.match(sendIconRule, /width:\s*20px;/u);
  assert.match(sendIconRule, /height:\s*20px;/u);
  assert.match(stopButtonRule, /color:\s*var\(--text-normal\);/u);
  assert.match(stopButtonRule, /box-shadow:\s*none\s*!important;/u);
  assert.doesNotMatch(stopButtonRule, /text-error|status-danger/u);
  assert.match(permissionKeyboardFocusRule, /outline:\s*none\s*!important;/u);
  assert.match(permissionKeyboardFocusRule, /border:\s*0\s*!important;/u);
  assert.match(permissionKeyboardFocusRule, /box-shadow:\s*none\s*!important;/u);
  assert.doesNotMatch(permissionKeyboardFocusRule, /interactive-accent|currentColor/u);
  assert.doesNotMatch(
    css,
    /\.codex-permission-control:focus-within\s*\{[^}]*outline:\s*2px solid currentColor/u,
    "pointer-opened native permission menus must not leave a yellow focus ring behind"
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)[\s\S]*?\.echoink-animate-icon-host\.is-send-horizontal-icon:is\(:hover, :focus-visible\)[\s\S]*?\.echoink-animate-icon-send-horizontal\s*\{[\s\S]*?1400ms ease-in-out/u,
    "the ordinary send action uses the pinned AnimateIcons send-horizontal timing"
  );
  assert.match(
    css,
    /\.echoink-animate-icon-host\.is-circle-stop-icon:is\(:hover, :focus-visible\)[\s\S]*?\.echoink-animate-circle-stop-ring/u,
    "the stop action uses the pinned AnimateIcons circle-stop motion"
  );
  assert.doesNotMatch(css, /codex-composer-send-icon-confirm/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none\s*!important/u);
}

async function assertProviderTextGenerationCompletionContract(): Promise<void> {
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: "translation-provider",
    providerId: "deepseek",
    runtimeProviderId: "deepseek",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-chat",
    apiKey: "fixture-key",
    toolCalling: false,
    imageInput: true,
    reasoning: true,
    contextWindow: 96_000,
    modelMaxTokens: 12_000,
    maxOutputTokens: 4_000
  };
  const host = {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => "/fixture-vault"
  };
  let nextResult: (signal: AbortSignal) => Promise<AssistantMessage> = async () =>
    providerTextMessage("stop", "\n  - **Hello**\n\n");
  let capturedRequest: any = null;
  const dispatcher = {
    stream: (request: { options: { signal?: AbortSignal } }) => {
      capturedRequest = request;
      return {
        result: async () => await nextResult(request.options.signal ?? new AbortController().signal)
      };
    }
  } as unknown as Pick<PiProviderProtocolDispatcher, "stream">;
  const service = new PiProviderConfigurationService(host as never, {
    textGenerationDispatcher: dispatcher
  });
  const input = {
    draft,
    systemPrompt: "Translate.",
    userPrompt: "翻译。",
    timeoutMs: 1_000,
    maxTokens: 10_000
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
  assert.deepEqual(capturedRequest?.model.input, ["text", "image"]);
  assert.equal(capturedRequest?.model.reasoning, true);
  assert.equal(capturedRequest?.model.contextWindow, 96_000);
  assert.equal(capturedRequest?.model.maxTokens, 12_000);
  assert.equal(capturedRequest?.options.maxTokens, 4_000);

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
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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
  replaceProviderModels(existing, "custom-model");
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
  const candidate = createApiProviderConfig("deepseek", "persisted-candidate");
  candidate.apiKey = "persisted-candidate-api-key";
  persisted.apiProviders = [candidate];
  activateApiProvider(persisted, candidate);
  const concurrentSave = store.withSettingsPersistenceAuthorityGate(async () => {
    persisted.settingsLanguage = "en";
    persisted.customWelcomeEnabled = true;
    persisted.customWelcomeTitle = "Concurrent title";
  });
  const rollback = store.restorePersistedApiProviderSettingsSnapshot(
    providerSnapshot
  );
  await Promise.all([concurrentSave, rollback]);
  assert.equal(persisted.activeApiProviderId, old.id);
  assert.equal(persisted.settingsLanguage, "en");
  assert.equal(persisted.customWelcomeEnabled, true);
  assert.equal(persisted.customWelcomeTitle, "Concurrent title");
}

function assertConversationSettingsDiscardMessageBodies(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sessions = [{
    id: "conversation-persistence-shell",
    title: "Persistence shell",
    piSessionId: "pi-conversation-persistence-shell",
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [{
      id: "durable-message-body",
      role: "assistant",
      text: "This message must remain in the Pi Session, not settings.",
      createdAt: 1
    }],
    piImageAttachments: {
      "entry-image-metadata": [{
        name: "first.png",
        path: "/disposable-vault/first.png",
        mimeType: "image/png",
        availability: "available",
        data: "SETTINGS_BASE64_CANARY"
      }, {
        name: "second.jpg",
        path: "/disposable-vault/second.jpg",
        mimeType: "image/jpeg",
        availability: "unavailable",
        base64: "SETTINGS_SECOND_BASE64_CANARY"
      }]
    } as never,
    createdAt: 1,
    updatedAt: 2
  }];
  settings.activeSessionId = "conversation-persistence-shell";

  const persisted = settingsForDataSave(settings);
  assert.equal(persisted.activeSessionId, settings.activeSessionId);
  assert.deepEqual(persisted.sessions[0]?.messages, []);
  assert.deepEqual(persisted.sessions[0]?.piImageAttachments, {
    "entry-image-metadata": [{
      name: "first.png",
      path: "/disposable-vault/first.png",
      mimeType: "image/png",
      availability: "available"
    }, {
      name: "second.jpg",
      path: "/disposable-vault/second.jpg",
      mimeType: "image/jpeg",
      availability: "unavailable"
    }]
  });
  assert.deepEqual(
    normalizeSettingsData(persisted).settings.sessions[0]?.piImageAttachments,
    persisted.sessions[0]?.piImageAttachments
  );
  assert.equal(
    settings.sessions[0]?.messages[0]?.id,
    "durable-message-body",
    "persisting the settings shell must not mutate the live active body"
  );
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /This message must remain in the Pi Session|SETTINGS_(?:SECOND_)?BASE64_CANARY/u
  );
  assert.match(
    JSON.stringify(settings),
    /SETTINGS_BASE64_CANARY/u,
    "settings projection must not mutate live local metadata while sanitizing"
  );
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
  const tab = new CodexSettingTab(withSettingsTabDefaults(tabPlugin) as never) as unknown as {
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

async function assertOpenAICodexCredentialStoreContract(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const persistedStates: Array<string | null> = [];
  const host = {
    settings,
    saveSettings: async () => {
      persistedStates.push(
        settings.openAICodexCredential?.access ?? null
      );
    }
  };
  const store = new OpenAICodexSettingsCredentialStore(host);
  const firstGate = deferred<void>();
  const first = store.modify("openai-codex", async (current) => {
    assert.equal(current, undefined);
    await firstGate.promise;
    return codexCredentialFixture("first");
  });
  let secondStarted = false;
  const second = store.modify("openai-codex", async (current) => {
    secondStarted = true;
    assert.equal(current?.type, "oauth");
    assert.equal(current?.access, "fixture-access-first");
    return codexCredentialFixture("rotated");
  });
  await flushProviderModalTasks();
  assert.equal(secondStarted, false);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(persistedStates, [
    "fixture-access-first",
    "fixture-access-rotated"
  ]);
  assert.equal(
    settings.openAICodexCredential?.refresh,
    "fixture-refresh-rotated"
  );
  assert.deepEqual(await store.list(), [{
    providerId: "openai-codex",
    type: "oauth"
  }]);

  const oauth = new OpenAICodexOAuthService(host);
  assert.equal((await oauth.status()).state, "connected");
  assert.equal(
    await oauth.resolveAccessToken(),
    "fixture-access-rotated"
  );
  await oauth.logout();
  assert.equal(settings.openAICodexCredential, null);
  assert.equal((await oauth.status()).state, "disconnected");
  await assert.rejects(
    oauth.resolveAccessToken(),
    /OpenAI Codex 授权已失效，请在设置中重新登录/u
  );

  settings.openAICodexCredential = {
    ...codexCredentialFixture("expired"),
    expires: 1
  };
  assert.equal(
    (await new OpenAICodexOAuthService(host).status()).state,
    "expired"
  );

  const beforeFailure = structuredClone(settings.openAICodexCredential);
  const failingStore = new OpenAICodexSettingsCredentialStore({
    settings,
    saveSettings: async () => {
      throw new Error("fixture-persist-failed");
    }
  });
  await assert.rejects(
    failingStore.modify("openai-codex", async () =>
      codexCredentialFixture("not-persisted")
    ),
    /codex_oauth_credential_persist_failed/u
  );
  assert.deepEqual(settings.openAICodexCredential, beforeFailure);
}

function codexCredentialFixture(suffix: string) {
  return {
    type: "oauth" as const,
    access: `fixture-access-${suffix}`,
    refresh: `fixture-refresh-${suffix}`,
    expires: Date.now() + 60_000,
    accountId: `fixture-account-${suffix}`
  };
}

async function assertOpenAICodexLogoutSuspendsRuntime(): Promise<void> {
  const order: string[] = [];
  await logoutOpenAICodexAfterRuntimeSuspension({
    active: true,
    suspendRuntime: async () => {
      order.push("runtime-suspended");
    },
    logout: async () => {
      order.push("credential-deleted");
    }
  });
  assert.deepEqual(order, [
    "runtime-suspended",
    "credential-deleted"
  ]);

  let logoutCalled = false;
  await assert.rejects(
    logoutOpenAICodexAfterRuntimeSuspension({
      active: true,
      suspendRuntime: async () => {
        throw new Error("fixture-runtime-shutdown-failed");
      },
      logout: async () => {
        logoutCalled = true;
      }
    }),
    /fixture-runtime-shutdown-failed/u
  );
  assert.equal(logoutCalled, false);
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
      explicit: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      observed: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
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
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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
  const correctionCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-memory-correction-row"
  );
  assert.ok(correctionCard, "the current Memory renders as one correction card");
  const cardHeader = correctionCard.querySelector<ProviderModalTestElement>(
    ".echoink-memory-card-header"
  );
  const cardFields = correctionCard.querySelector<ProviderModalTestElement>(
    ".echoink-memory-card-fields"
  );
  assert.ok(cardHeader && cardFields);
  assert.equal(correctionCard.children[0], cardHeader,
    "the title and Correct action stay in the first card layer");
  assert.equal(correctionCard.children[1], cardFields,
    "the readable Memory fields follow the header");
  assert.equal(
    cardHeader.querySelector(".echoink-memory-card-title")?.textContent,
    "当前事实"
  );
  assert.deepEqual(
    cardFields.querySelectorAll(".echoink-memory-card-label")
      .map((element) => element.textContent),
    ["记忆内容", "召回时机"]
  );
  assert.deepEqual(
    cardFields.querySelectorAll(".echoink-memory-card-body")
      .map((element) => element.textContent),
    ["用户可见的事实正文", "需要核对事实时"]
  );
  assert.deepEqual(
    cardFields.children.map((element) => element.className),
    [
      "echoink-memory-card-field echoink-memory-card-content",
      "echoink-memory-card-field echoink-memory-card-recall"
    ]
  );
  const correctionActions = correctionCard.querySelectorAll<ProviderModalTestElement>("button");
  assert.deepEqual(correctionActions.map((button) => button.textContent), ["修正"]);
  assert.equal(correctionActions[0]?.closest(".echoink-memory-card-header"), cardHeader);
  assert.equal(correctionCard.querySelectorAll("input, textarea, select").length, 0);
  assert.equal(
    correctionCard.querySelectorAll("*")
      .some((element) => element.className.includes("echoink-secondary-")),
    false
  );
  assert.doesNotMatch(
    correctionCard.textContent,
    /联想线索|AI 推断|Association clues|secondary/iu
  );
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /mem_ui_private_id|private-source|records\/facts|revision/u
  );

  settings.settingsLanguage = "en";
  tab.display();
  const englishCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-memory-correction-row"
  );
  assert.ok(englishCard);
  assert.deepEqual(
    englishCard.querySelectorAll(".echoink-memory-card-label")
      .map((element) => element.textContent),
    ["Memory content", "Recall when"]
  );
  assert.deepEqual(
    englishCard.querySelectorAll("button").map((button) => button.textContent),
    ["Correct"]
  );
  assert.doesNotMatch(englishCard.textContent, /Association clues|AI inferred/iu);
  settings.settingsLanguage = "zh-CN";

  const correctionCss = readFileSync("styles.css", "utf8");
  const bodyRule = correctionCss.match(/\.echoink-memory-card-body\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.match(bodyRule, /max-inline-size:\s*68ch;/u);
  assert.match(bodyRule, /line-height:\s*1\.6;/u);
  assert.match(bodyRule, /overflow-wrap:\s*anywhere;/u);
  assert.match(bodyRule, /text-wrap:\s*pretty;/u);
  assert.doesNotMatch(bodyRule, /(?:^|;)\s*(?:width|height)\s*:/u);
  assert.match(
    correctionCss,
    /@container \(max-width:\s*360px\)\s*\{[\s\S]*?\.echoink-memory-card-header\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u
  );
  assert.doesNotMatch(correctionCss, /\.echoink-secondary-/u);
  const settingsTabSource = readFileSync("src/settings/settings-tab.ts", "utf8");
  assert.doesNotMatch(
    settingsTabSource,
    /echoink-secondary-facts|listSecondaryForParent|renderSecondaryFactRow|openSecondaryFactEditor/u
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
    settingsCopy("zh-CN").general.customWelcome
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
  const modelOptions = Array.from(
    tab.containerEl.querySelectorAll<HTMLOptionElement>("option")
  );
  const optionForProvider = (providerId: string) => modelOptions.find((option) => {
    try {
      const value: unknown = JSON.parse(option.value);
      return Array.isArray(value) && value[0] === providerId;
    } catch {
      return false;
    }
  });
  assert.equal(
    optionForProvider(missingCredential.id)?.disabled,
    true
  );
  assert.equal(
    optionForProvider(credentialFree.id)?.disabled,
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
  const candidate = createApiProviderConfig("deepseek", "rollback-candidate");
  settings.apiProviders = [candidate];
  activateApiProvider(settings, candidate);
  settings.settingsLanguage = "en";
  settings.customWelcomeEnabled = true;
  settings.customWelcomeSubtitle = "Concurrent greeting";
  restoreApiProviderSettings(settings, snapshot);
  assert.equal(settings.activeApiProviderId, old.id);
  assert.equal(settings.settingsLanguage, "en");
  assert.equal(settings.customWelcomeEnabled, true);
  assert.equal(settings.customWelcomeSubtitle, "Concurrent greeting");
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
      listModels: async () => ({
        status: "available",
        models: provider.models.map((model) => model.id)
      }),
      testConnection: async () => ({ status: "available" })
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  const trigger = providerModalElementByFocusKey(modal, "model-discover");
  assert.ok(trigger);
  assert.equal(trigger.textContent, "Get models");
  assert.doesNotMatch(modal.contentEl.textContent, /\bAuto\b/u);
  const selected = primaryProviderModel(provider);
  assert.ok(providerModalElementByFocusKey(
    modal,
    `model-enabled:${selected.id}`
  ));
  assert.ok(providerModalElementByFocusKey(
    modal,
    `model-default:${selected.id}`
  ));
  providerModalElementByFocusKey(modal, "manual-model-add")?.click();
  assert.match(
    modal.contentEl.textContent,
    new RegExp(settingsCopy("en").providers.invalidModel, "u")
  );
  const manual = providerModalElementByFocusKey(modal, "manual-model");
  assert.ok(manual);
  manual.value = "manual-model-id";
  manual.oninput?.(new Event("input"));
  providerModalElementByFocusKey(modal, "manual-model-add")?.click();
  assert.equal(
    providerModalElementByFocusKey(
      modal,
      "model-enabled:manual-model-id"
    )?.checked,
    true
  );
  modal.close();
}

function assertSettingsV51MigrationContract(): void {
  const failures: Error[] = [];
  const check = (label: string, assertion: () => void): void => {
    try {
      assertion();
    } catch (error) {
      failures.push(new Error(label, { cause: error }));
    }
  };

  check("fresh install does not select a Provider without a usable API Key", () => {
    assert.equal(DEFAULT_SETTINGS.settingsVersion, 51);
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

  check("v50 flat and auto Provider settings migrate to one explicit enabled default model", () => {
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 50,
      activeApiProviderId: "legacy-custom",
      defaultModel: "legacy-model",
      apiProviders: [{
        id: "legacy-custom",
        providerId: "custom",
        runtimeProviderId: "legacy-runtime",
        apiProtocol: "openai-completions",
        authMode: "api-key",
        name: "Legacy custom",
        baseUrl: "https://legacy.example/v1",
        model: "legacy-model",
        models: ["legacy-model", "unselected-discovery-result"],
        modelSelection: "auto",
        toolCalling: true,
        imageInput: true,
        reasoning: true,
        contextWindow: 96_000,
        maxOutputTokens: 12_000,
        apiKey: "fixture-key"
      }]
    }).settings;
    const provider = normalized.apiProviders[0];
    assert.ok(provider);
    assert.equal(provider.defaultModelId, "legacy-model");
    assert.equal(normalized.defaultModel, "legacy-model");
    assert.deepEqual(provider.models.map((model) => model.id), ["legacy-model"]);
    assert.deepEqual(provider.models[0], {
      id: "legacy-model",
      displayName: "legacy-model",
      input: ["text", "image"],
      toolCalling: true,
      reasoning: true,
      contextWindow: 96_000,
      modelMaxTokens: 12_000,
      maxOutputTokens: 12_000,
      metadataSource: "manual"
    });
    for (const retired of [
      "model",
      "modelSelection",
      "toolCalling",
      "imageInput",
      "reasoning",
      "contextWindow",
      "maxOutputTokens"
    ]) {
      assert.equal(Object.hasOwn(provider, retired), false, retired);
    }
  });

  check("v51 preserves an active non-default enabled Composer model", () => {
    const provider = createApiProviderConfig("custom", "current-multi-model");
    provider.name = "Current multi-model";
    provider.baseUrl = "https://current.example/v1";
    provider.apiKey = "fixture-key";
    replaceProviderModels(provider, "model-default", "model-selected");
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      activeApiProviderId: provider.id,
      defaultModel: "model-selected",
      apiProviders: [provider]
    }).settings;
    assert.equal(normalized.activeApiProviderId, provider.id);
    assert.equal(normalized.apiProviders[0]?.defaultModelId, "model-default");
    assert.equal(normalized.defaultModel, "model-selected");
  });

  check("unknown model metadata starts text-only without inherited capabilities", () => {
    const unknown = createApiProviderModelConfig("custom", "undocumented-model");
    assert.deepEqual(unknown.input, ["text"]);
    assert.equal(unknown.toolCalling, false);
    assert.equal(unknown.reasoning, false);
    assert.equal(unknown.metadataSource, "unknown");
  });

  check("discovered IDs use exact runtime Provider metadata from the Pi catalog", () => {
    const catalog = MOONSHOTAI_CN_MODELS["kimi-k2.7-code"];
    assert.ok(catalog);
    assert.equal(Object.hasOwn(catalog, "toolCalling"), false);
    const discovered = createApiProviderModelConfig(
      "kimi",
      catalog.id,
      "moonshotai-cn"
    );
    assert.deepEqual(discovered, {
      id: catalog.id,
      displayName: catalog.name,
      input: catalog.input.includes("image")
        ? ["text", "image"]
        : ["text"],
      toolCalling: true,
      reasoning: catalog.reasoning,
      contextWindow: catalog.contextWindow,
      modelMaxTokens: catalog.maxTokens,
      maxOutputTokens: 65_536,
      metadataSource: "catalog"
    });
    const provider = createApiProviderConfig("kimi", "catalog-provider");
    provider.models = [discovered];
    provider.defaultModelId = discovered.id;
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.deepEqual(reopened, discovered);
    const sameIdWrongProvider = createApiProviderModelConfig(
      "custom",
      catalog.id,
      "deepseek"
    );
    assert.equal(sameIdWrongProvider.metadataSource, "unknown");
    assert.deepEqual(sameIdWrongProvider.input, ["text"]);
    assert.equal(sameIdWrongProvider.toolCalling, false);
    assert.equal(sameIdWrongProvider.reasoning, false);
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
    assert.equal(available.apiProviders[0]?.authMode, "api-key");
  });

  check("v49 adds explicit Codex OAuth without weakening API-key Providers", () => {
    const apiKeyProvider = createApiProviderConfig("deepseek", "api-key-v49");
    apiKeyProvider.apiKey = "fixture-provider-key";
    const codexProvider = {
      ...createApiProviderConfig("openai-codex", "codex-v49"),
      authMode: undefined,
      apiProtocol: "openai-completions",
      apiKey: "must-not-be-used-as-codex-auth"
    };
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 49,
      activeApiProviderId: apiKeyProvider.id,
      apiProviders: [apiKeyProvider, codexProvider]
    }).settings;
    assert.equal(normalized.apiProviders[0]?.authMode, "api-key");
    assert.equal(
      normalized.apiProviders[0]?.apiKey,
      "fixture-provider-key"
    );
    assert.equal(normalized.apiProviders[1]?.authMode, "oauth");
    assert.equal(
      normalized.apiProviders[1]?.apiProtocol,
      "openai-codex-responses"
    );
    assert.equal(normalized.apiProviders[1]?.apiKey, "");
    assert.equal(normalized.openAICodexCredential, null);
    assert.equal(normalized.activeApiProviderId, apiKeyProvider.id);
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

  check("retired LLM-WIKI settings are removed without touching current Knowledge state", () => {
    const legacyInput: unknown = {
      ...structuredClone(DEFAULT_SETTINGS),
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        useCustomRulesFile: true,
        rulesFilePath: "LLM-WIKI.md",
        initialization: {
          ...structuredClone(DEFAULT_SETTINGS.knowledgeBase.initialization),
          rulesFilePath: "LLM-WIKI.md"
        }
      }
    };
    const result = normalizeSettingsData(legacyInput);
    assert.equal(result.changed, true);
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase, "useCustomRulesFile"),
      false
    );
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase, "rulesFilePath"),
      false
    );
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase.initialization, "rulesFilePath"),
      false
    );

    const nestedOnly = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        initialization: {
          ...structuredClone(DEFAULT_SETTINGS.knowledgeBase.initialization),
          rulesFilePath: "LLM-WIKI.md"
        }
      }
    });
    assert.equal(nestedOnly.changed, true);
    assert.equal(
      Object.hasOwn(nestedOnly.settings.knowledgeBase.initialization, "rulesFilePath"),
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
    throw new AggregateError(failures, "Settings v50 migration contract failed");
  }
}

function assertOnboardingTruthContract(): void {
  assert.equal(isEmptyEchoInkPluginData(undefined), true);
  assert.equal(isEmptyEchoInkPluginData(null), true);
  assert.equal(isEmptyEchoInkPluginData({}), true);
  assert.equal(isEmptyEchoInkPluginData({ settingsVersion: 49 }), false);

  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(settings.setup.tutorialStep, "sidebar");
  assert.equal(settings.setup.tutorialVersion, "");
  assert.equal(shouldAutoStartEchoInkOnboarding(true, settings.setup), true);
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup),
    true,
    "an unseen onboarding version starts once after an update"
  );
  assert.equal(prepareEchoInkOnboardingTutorial(settings.setup, { forceRestart: false }), true);
  assert.equal(settings.setup.tutorialVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(settings.setup.tutorialStep, "sidebar");

  settings.setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup, false),
    false,
    "ordinary Obsidian startup must not repeat a seen tutorial"
  );
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup, true),
    true,
    "enabling the plugin after layout-ready restarts onboarding"
  );
  settings.setup.tutorialStep = "knowledge";
  assert.equal(prepareEchoInkOnboardingTutorial(settings.setup, { forceRestart: true }), true);
  assert.equal(settings.setup.tutorialStep, "sidebar");
  settings.setup.dismissedVersion = "";

  let truth = deriveEchoInkOnboardingTruth(settings, null);
  assert.equal(truth.providerComplete, false);
  assert.equal(truth.knowledgeComplete, false);
  assert.equal(truth.personalityComplete, false);

  const provider = createApiProviderConfig("deepseek", "onboarding-provider");
  provider.apiKey = "configured-key";
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  settings.knowledgeBase.initialization.status = "initialized";
  truth = deriveEchoInkOnboardingTruth(settings, "template-balanced");
  assert.deepEqual(truth, {
    providerComplete: true,
    knowledgeComplete: true,
    personalityComplete: true
  });
  assert.equal(settings.setup.tutorialStep, "sidebar");

  const first = advanceEchoInkOnboardingTutorial(settings.setup, "sidebar", 101);
  assert.deepEqual(first, { changed: true, completed: false, nextStep: "settings" });
  assert.equal(settings.setup.completedAt, 0);
  const stale = advanceEchoInkOnboardingTutorial(settings.setup, "sidebar", 102);
  assert.deepEqual(stale, { changed: false, completed: false, nextStep: "settings" });
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "settings", 103),
    { changed: true, completed: false, nextStep: "provider" }
  );
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "provider", 104),
    { changed: true, completed: false, nextStep: "knowledge" }
  );
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "knowledge", 105),
    { changed: true, completed: false, nextStep: "personality" }
  );
  const finish = advanceEchoInkOnboardingTutorial(settings.setup, "personality", 106);
  assert.deepEqual(finish, { changed: true, completed: true, nextStep: null });
  assert.equal(settings.setup.completedAt, 106);
  assert.equal(settings.setup.lastCheckedAt, 106);
  assert.equal(settings.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(shouldAutoStartEchoInkOnboarding(false, settings.setup), false);
  assert.equal(settings.setup.tutorialStep, "sidebar");

  assert.equal(echoInkOnboardingTab("provider"), "providers");
  assert.equal(echoInkOnboardingTab("knowledge"), "knowledgeBase");
  assert.equal(echoInkOnboardingTab("personality"), "general");

  const resumed = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    setup: {
      completedAt: 0,
      lastCheckedAt: 0,
      dismissedVersion: ECHOINK_ONBOARDING_VERSION,
      tutorialVersion: ECHOINK_ONBOARDING_VERSION,
      tutorialStep: "knowledge"
    }
  }).settings;
  assert.equal(resumed.setup.tutorialStep, "knowledge");
  assert.equal(resumed.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(shouldAutoStartEchoInkOnboarding(true, resumed.setup), false);
  dismissEchoInkOnboardingTutorial(resumed.setup);
  assert.equal(resumed.setup.tutorialStep, "knowledge");
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, resumed.setup),
    false,
    "a seen tutorial stays closed during an ordinary restart"
  );
  assert.equal(normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    setup: { tutorialStep: "invalid" }
  }).settings.setup.tutorialStep, "sidebar");
  assert.equal(settings.memory.dreamEnabled, false);
}

function assertFiveStepOnboardingEntrypoints(): void {
  installProviderModalDomFixture();
  const expected = [
    ["sidebar", "第 1 步，共 5 步", "打开 Agent 侧栏"],
    ["settings", "第 2 步，共 5 步", "进入 EchoInk 设置"],
    ["provider", "第 3 步，共 5 步", "连接一个模型"],
    ["knowledge", "第 4 步，共 5 步", "建立知识库"],
    ["personality", "第 5 步，共 5 步", "选择 Agent 风格"]
  ] as const;
  for (const [step, stepLabel, title] of expected) {
    const copy = onboardingCoachmarkCopy(step, true);
    assert.equal(copy.step, stepLabel);
    assert.equal(copy.title, title);
    assert.doesNotMatch(copy.description, /本教程|配置完整|可恢复的预览|Memory 学习|稍后/u);
  }
  assert.equal(onboardingCoachmarkCopy("sidebar", true).action, "打开 EchoInk");
  assert.equal(onboardingCoachmarkCopy("settings", true).action, "打开设置");
  assert.equal(onboardingCoachmarkCopy("provider", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("knowledge", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("personality", true).action, "完成");

  const root = providerModalTestDocument.createElement("div");
  let settingsCalls = 0;
  renderCodexHeader(root as never, {
    onOpenWorkspaceResources: () => undefined,
    onOpenSettings: () => { settingsCalls += 1; }
  });
  const settingsButton = root.querySelector<ProviderModalTestElement>(".codex-settings-button");
  assert.ok(settingsButton);
  assert.equal(settingsButton!.getAttribute("data-echoink-onboarding-anchor"), "settings");
  settingsButton!.click();
  assert.equal(settingsCalls, 1);

  const bootstrapSource = readFileSync("src/plugin/bootstrap.ts", "utf8");
  assert.match(bootstrapSource, /setEchoInkOnboardingRibbonAnchor/u);
  assert.match(bootstrapSource, /handleEchoInkOnboardingTargetActivated\("sidebar"\)/u);
  const mainSource = readFileSync("src/main.ts", "utf8");
  assert.match(mainSource, /workspace\.layoutReady/u);
  assert.match(mainSource, /prepareEchoInkOnboardingTutorial/u);
  assert.match(mainSource, /\.modal\.mod-settings/u);
  assert.match(mainSource, /MutationObserver/u);
  assert.match(mainSource, /actionLabel:\s*copy\.action/u);
  assert.match(mainSource, /await this\.activateHomeAndSidebar\(\)/u);
  assert.doesNotMatch(
    mainSource.slice(
      mainSource.indexOf("private async showEchoInkOnboardingWorkspaceCoachmark"),
      mainSource.indexOf("private findEchoInkOnboardingSettingsAnchor")
    ),
    /稍后设置|Set up later|dismissLabel/u
  );
  console.log("PASS settings: onboarding starts from ribbon and sidebar settings gear");
}

function assertCodexHeaderIdentityContract(): void {
  installProviderModalDomFixture();
  const root = providerModalTestDocument.createElement("div");
  const avatarUrl = "data:image/webp;base64,UkVE";
  renderCodexHeader(root as never, {
    onOpenWorkspaceResources: () => undefined,
    onOpenSettings: () => undefined
  }, {
    displayName: "小墨",
    avatarUrl
  });

  const label = root.querySelector<ProviderModalTestElement>(".codex-title-text");
  const icon = root.querySelector<ProviderModalTestElement>(".codex-title-icon-codex");
  const avatar = root.querySelector<ProviderModalTestElement>(".codex-title-avatar");
  assert.equal(label?.textContent, "小墨");
  assert.equal(avatar?.getAttribute("src"), avatarUrl);
  assert.equal(icon?.hasClass("has-image"), true);

  updateCodexHeaderIdentity(root as never, { displayName: "   ", avatarUrl: null });
  assert.equal(label?.textContent, "EchoInk");
  assert.equal(root.querySelector(".codex-title-avatar"), null);
  assert.equal(icon?.hasClass("has-image"), false);

  updateCodexHeaderIdentity(root as never, { displayName: "新名字", avatarUrl });
  assert.equal(label?.textContent, "新名字");
  assert.equal(
    root.querySelector<ProviderModalTestElement>(".codex-title-avatar")?.getAttribute("src"),
    avatarUrl
  );

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.codex-title-icon-codex\.has-image\s*\{[^}]*border-radius:\s*50%/u);
  assert.match(css, /\.codex-title-avatar\s*\{[^}]*object-fit:\s*cover/u);
  console.log("PASS settings: sidebar header follows cached Agent identity");
}

async function assertOnboardingCoachmarkAccessibilityContract(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  let dismissCalls = 0;
  let now = 200;
  const advanceCalls: string[] = [];
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    dismissEchoInkOnboarding: async () => { dismissCalls += 1; },
    advanceEchoInkOnboarding: async (
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality"
    ) => {
      advanceCalls.push(step);
      return advanceEchoInkOnboardingTutorial(settings.setup, step, ++now).nextStep;
    }
  });
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as {
    renderOnboardingCoachmark(
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality"
    ): void;
    clearOnboardingCoachmark(restoreFocus: boolean): void;
  };
  const restoreFocus = providerModalTestDocument.createElement("button");
  providerModalTestDocument.body.appendChild(restoreFocus);

  for (const fixture of [
    { step: "provider" as const, key: "providers:add", label: "连接一个模型", action: "下一步" },
    { step: "knowledge" as const, key: "knowledge:onboarding", label: "建立知识库", action: "下一步" },
    { step: "personality" as const, key: "general:personality-template", label: "选择 Agent 风格", action: "完成" }
  ]) {
    tab.containerEl.empty();
    const anchor = tab.containerEl.createEl("button", {
      attr: { "data-echoink-focus-key": fixture.key }
    });
    restoreFocus.focus();
    mutable.renderOnboardingCoachmark(fixture.step);
    const coachmark = providerModalTestDocument.body.querySelector(
      `.echoink-onboarding-coachmark.is-${fixture.step}`
    );
    assert.ok(coachmark);
    assert.equal(coachmark.getAttribute("role"), "dialog");
    assert.equal(coachmark.getAttribute("aria-modal"), "false");
    assert.equal(coachmark.getAttribute("aria-label"), fixture.label);
    assert.equal(coachmark.getAttribute("tabindex"), "-1");
    assert.equal(
      coachmark.querySelector("button.echoink-onboarding-action")?.textContent,
      fixture.action
    );
    assert.equal(coachmark.querySelectorAll("button").length, 1);
    const action = coachmark.querySelector("button.echoink-onboarding-action");
    assert.equal(action?.getAttribute("aria-label"), fixture.action);
    assert.equal(
      action?.querySelector(".echoink-onboarding-action-icon")?.getAttribute("data-echoink-icon"),
      "arrow-right"
    );
    assert.equal(action?.querySelectorAll(".echoink-onboarding-action-icon").length, 1);
    assert.equal(
      action?.querySelector(".echoink-onboarding-action-label")?.getAttribute("data-label"),
      fixture.action
    );
    assert.equal(providerModalTestDocument.activeElement, coachmark);
    assert.equal(anchor.hasClass("is-echoink-onboarding-target"), true);
    assert.equal(anchor.scrollIntoViewCalls, 3);
    mutable.clearOnboardingCoachmark(true);
    assert.equal(providerModalTestDocument.activeElement, restoreFocus);
    assert.equal(anchor.hasClass("is-echoink-onboarding-target"), false);
  }

  const detachedDocument = new ProviderModalTestDocument();
  const detachedTab = new CodexSettingTab(plugin as never);
  const detachedContainer = detachedDocument.createElement("div");
  detachedDocument.body.appendChild(detachedContainer);
  (detachedTab as unknown as { containerEl: ProviderModalTestElement }).containerEl =
    detachedContainer;
  const detachedAnchor = detachedContainer.createEl("button", {
    attr: { "data-echoink-focus-key": "providers:add" }
  });
  const detachedMutable = detachedTab as unknown as {
    renderOnboardingCoachmark(
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality"
    ): void;
    clearOnboardingCoachmark(restoreFocus: boolean): void;
  };
  detachedMutable.renderOnboardingCoachmark("provider");
  const detachedCoachmark = detachedDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-provider"
  );
  assert.ok(detachedCoachmark, "coachmark must render in the settings window document");
  assert.equal(detachedCoachmark.ownerDocument, detachedDocument);
  assert.equal(detachedAnchor.hasClass("is-echoink-onboarding-target"), true);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null,
    "detached settings coachmark must not leak into the main Vault document"
  );
  detachedMutable.clearOnboardingCoachmark(false);

  settings.setup.completedAt = 0;
  settings.setup.tutorialStep = "provider";
  settings.setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  for (const fixture of [
    { step: "provider" as const, key: "providers:add", tab: "providers" as const, nextTab: "knowledgeBase" as const },
    { step: "knowledge" as const, key: "knowledge:onboarding", tab: "knowledgeBase" as const, nextTab: "general" as const },
    { step: "personality" as const, key: "general:personality-template", tab: "general" as const, nextTab: null }
  ]) {
    settings.settingsTab = fixture.tab;
    tab.containerEl.empty();
    tab.containerEl.createEl("button", {
      attr: { "data-echoink-focus-key": fixture.key }
    });
    mutable.renderOnboardingCoachmark(fixture.step);
    const next = providerModalTestDocument.body
      .querySelector<ProviderModalTestElement>(".echoink-onboarding-coachmark")
      ?.querySelector<ProviderModalTestElement>("button.echoink-onboarding-action");
    assert.ok(next);
    next.click();
    await flushProviderModalTasks();
    if (fixture.nextTab) assert.equal(settings.settingsTab, fixture.nextTab);
  }
  assert.deepEqual(advanceCalls, ["provider", "knowledge", "personality"]);
  assert.equal(settings.setup.completedAt, 203);
  assert.equal(settings.setup.tutorialStep, "sidebar");
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null
  );

  tab.containerEl.empty();
  tab.containerEl.createEl("button", {
    attr: { "data-echoink-focus-key": "providers:add" }
  });
  restoreFocus.focus();
  mutable.renderOnboardingCoachmark("provider");
  providerModalTestDocument.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks();
  assert.equal(dismissCalls, 0);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null
  );
  assert.equal(providerModalTestDocument.activeElement, restoreFocus);

  // 前两步是必须经过的导航动作：只提供主按钮；Escape 只临时关闭提示，
  // 不调用持久化 dismiss，也不会把教程标记为完成。
  const mandatoryAnchor = providerModalTestDocument.createElement("button");
  providerModalTestDocument.body.appendChild(mandatoryAnchor);
  let mandatoryActionCalls = 0;
  mountEchoInkOnboardingCoachmark({
    anchor: mandatoryAnchor as never,
    stepClass: "sidebar",
    stepLabel: "第 1 步，共 5 步",
    title: "打开 Agent 侧栏",
    description: "点击左侧机器人图标。",
    actionLabel: "打开 EchoInk",
    onAction: () => { mandatoryActionCalls += 1; }
  });
  let mandatoryCoachmark = providerModalTestDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-sidebar"
  );
  assert.ok(mandatoryCoachmark);
  assert.deepEqual(
    Array.from(mandatoryCoachmark.querySelectorAll("button")).map((button) => button.textContent),
    ["打开 EchoInk"]
  );
  providerModalTestDocument.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks();
  assert.equal(mandatoryActionCalls, 0);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-sidebar"),
    null
  );

  const mandatoryHandle = mountEchoInkOnboardingCoachmark({
    anchor: mandatoryAnchor as never,
    stepClass: "sidebar",
    stepLabel: "第 1 步，共 5 步",
    title: "打开 Agent 侧栏",
    description: "点击左侧机器人图标。",
    actionLabel: "打开 EchoInk",
    onAction: () => { mandatoryActionCalls += 1; }
  });
  mandatoryCoachmark = providerModalTestDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-sidebar"
  );
  mandatoryCoachmark?.querySelector<ProviderModalTestElement>("button.echoink-onboarding-action")?.click();
  await flushProviderModalTasks();
  assert.equal(mandatoryActionCalls, 1);
  mandatoryHandle.destroy();

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.echoink-onboarding-coachmark\s*\{[\s\S]*?animation:\s*none/u);
  assert.match(css, /\.echoink-onboarding-coachmark \.echoink-onboarding-action\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*min-height:\s*40px;[^}]*padding:\s*0 11px;/u);
  assert.doesNotMatch(css, /\.echoink-onboarding-coachmark \.echoink-onboarding-action\s*\{\s*width:\s*100%;/u);
  assert.match(css, /\.echoink-onboarding-action-label-window\s*\{[^}]*height:\s*18px;[^}]*overflow:\s*hidden/u);
  assert.match(css, /\.echoink-onboarding-action-label::after\s*\{[^}]*content:\s*attr\(data-label\)/u);
  assert.match(css, /\.echoink-onboarding-action:is\(:hover, :focus-visible\) \.echoink-onboarding-action-icon\s*\{[^}]*rotate\(45deg\)/u);
  assert.match(css, /\.echoink-onboarding-action:is\(:hover, :focus-visible\) \.echoink-onboarding-action-label\s*\{[^}]*translateY\(-18px\)/u);
}

async function assertOnboardingDoesNotLockSettingsNavigation(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "general";
  settings.setup.tutorialStep = "knowledge";
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    isEchoInkOnboardingRequested: () => true,
    getEchoInkOnboardingStep: () => "knowledge" as const
  });
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as {
    settingsVisible: boolean;
    refreshOnboardingCoachmark(): Promise<void>;
  };
  mutable.settingsVisible = true;

  await mutable.refreshOnboardingCoachmark();

  assert.equal(
    settings.settingsTab,
    "general",
    "an active tutorial must not force the user back from a manually selected settings tab"
  );
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null,
    "the coachmark stays hidden until the user returns to the tutorial step"
  );
  console.log("PASS settings: onboarding never locks manual settings navigation");
}

async function assertManualOnboardingReopenIsRemoved(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  plugin.settings.settingsTab = "general";
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  assert.doesNotMatch(
    tab.containerEl.textContent,
    /首次设置|重新打开|First-time setup|Reopen/u,
    "existing Vault settings must not expose a manual tutorial restart"
  );
  const bootstrapSource = readFileSync("src/plugin/bootstrap.ts", "utf8");
  assert.doesNotMatch(bootstrapSource, /open-echoink-onboarding|重新打开首次设置/u);
  console.log("PASS settings: manual onboarding reopen entry and command are removed");
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

async function assertKnowledgeSettingsDetailRetiresLegacyControls(): Promise<void> {
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
    saveEchoInkKnowledgeMaintenancePreferences: async () => preference,
    getEchoInkKnowledgeInitializationState: async () => null,
    isEchoInkOnboardingRequested: () => false,
    getEchoInkOnboardingStep: () => "provider" as const,
    advanceEchoInkOnboarding: async () => null,
    dismissEchoInkOnboarding: async () => undefined
  };
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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
  await flushProviderModalTasks();
  // 初始化区块异步加载后消费了一次调度帧；再渲染一次，既拿到加载后的
  // 文案，也让后续点击能正常触发 scheduleDisplay。
  tab.display();
  assert.match(tab.containerEl.textContent, /知识库管理/u);
  assert.match(tab.containerEl.textContent, /初始化知识库/u);
  assert.match(tab.containerEl.textContent, /\/ask 始终只读/u);
  assert.match(tab.containerEl.textContent, /显式 \/maintain 会在一轮内安全写入并回读验证/u);
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

// ---------------------------------------------------------------------------
// 知识库初始化体验：默认/自定义 Tab、一键开始、目录分配、多选 Modal、
// 真实进度、暂停/错误映射与完成态。
// ---------------------------------------------------------------------------

function makeKnowledgeInitItemFixture(
  sourcePath: string,
  role: string,
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  return {
    sourcePath,
    targetPath: role === "keep" ? null : `${role}/imported/${sourcePath}`,
    role,
    sourceRevision: `sha256:rev-${sourcePath}`,
    contentHash: `sha256:hash-${sourcePath}`,
    size: 10,
    mtime: 100,
    state: "pending",
    reason: "",
    ...overrides
  };
}

function makeKnowledgeInitJobFixture(
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  return {
    schemaVersion: 1,
    jobId: "knowledge-init-fixture",
    templateVersion: "onboarding-v1",
    mode: "custom",
    phase: "preview",
    status: "preview",
    createdAt: 1,
    updatedAt: 2,
    provider: { providerId: "provider-ready", model: "model-ready" },
    planDigest: "sha256:plan-digest-fixture",
    confirmedDigest: null,
    items: [
      makeKnowledgeInitItemFixture("notes/alpha.md", "wiki"),
      makeKnowledgeInitItemFixture("notes/beta.md", "raw"),
      makeKnowledgeInitItemFixture("notes/gamma.md", "raw"),
      makeKnowledgeInitItemFixture("notes/delta.md", "projects")
    ],
    extractionSources: [],
    extractionQueue: [],
    extractionCursor: 0,
    expectedBatches: 0,
    moveCursor: 0,
    createdDirectories: [],
    conversationId: null,
    productRunIds: [],
    counts: { move: 4, keep: 0, conflict: 0, ignored: 0, extraction: 0 },
    guidePath: "wiki/开始使用 EchoInk 知识库.md",
    lastError: "",
    recoveryAction: "",
    ...overrides
  };
}

function makeKnowledgeBaseStructureFixture(
  state: "uninitialized" | "incomplete" | "ready",
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  const roots = [...KNOWLEDGE_INITIALIZATION_ROOTS];
  const base = state === "ready"
    ? { existingRoots: roots, missingRoots: [], conflictingRoots: [] }
    : state === "incomplete"
      ? {
          existingRoots: ["raw", "wiki"],
          missingRoots: roots.filter((root) => root !== "raw" && root !== "wiki"),
          conflictingRoots: []
        }
      : { existingRoots: [], missingRoots: roots, conflictingRoots: [] };
  return { state, ...base, checkedAt: 1, ...overrides };
}

function createKnowledgeInitPluginFixture(state: {
  job: Record<string, any> | null;
  structure?: Record<string, any>;
}) {
  const calls: Array<{ method: string; args?: unknown }> = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "knowledgeBase";
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkKnowledgeMaintenancePreferenceState: async () => null,
    getEchoInkKnowledgeInitializationState: async () => state.job,
    getEchoInkKnowledgeBaseStructure: async () => {
      state.structure ??= state.job?.status === "initialized"
        ? makeKnowledgeBaseStructureFixture("ready")
        : makeKnowledgeBaseStructureFixture("uninitialized");
      return state.structure;
    },
    restoreEchoInkKnowledgeBaseStructure: async (
      onProgress?: (progress: Record<string, unknown>) => void
    ) => {
      calls.push({ method: "restore-structure" });
      const previous = state.structure ?? makeKnowledgeBaseStructureFixture("uninitialized");
      onProgress?.({ completed: 0, total: 10, percent: 0, currentRoot: null });
      KNOWLEDGE_INITIALIZATION_ROOTS.forEach((root, index) => {
        onProgress?.({
          completed: index + 1,
          total: 10,
          percent: (index + 1) * 10,
          currentRoot: root
        });
      });
      state.structure = makeKnowledgeBaseStructureFixture("ready");
      return {
        structure: state.structure,
        createdRoots: [...(previous.missingRoots ?? [])]
      };
    },
    startEchoInkKnowledgeInitialization: async (mode: string) => {
      calls.push({ method: `start:${mode}` });
      state.job = makeKnowledgeInitJobFixture({ mode });
      return state.job;
    },
    confirmEchoInkKnowledgeInitialization: async () => {
      calls.push({ method: "confirm" });
      state.job = {
        ...state.job,
        status: "active",
        phase: "create_directories",
        confirmedDigest: state.job?.planDigest ?? null
      };
      return state.job;
    },
    continueEchoInkKnowledgeInitialization: async () => {
      calls.push({ method: "continue" });
      state.job = { ...state.job, status: "active", lastError: "", recoveryAction: "" };
      return state.job;
    },
    cancelEchoInkKnowledgeInitialization: async () => {
      calls.push({ method: "cancel" });
      state.job = { ...state.job, status: "cancelled" };
      return state.job;
    },
    assignManyEchoInkKnowledgeInitializationNotes: async (
      assignments: ReadonlyArray<{ sourcePath: string; role: string }>
    ) => {
      calls.push({ method: "assignMany", args: assignments });
      for (const assignment of assignments) {
        const item = state.job?.items.find(
          (candidate: Record<string, any>) => candidate.sourcePath === assignment.sourcePath
        );
        if (item) {
          item.role = assignment.role;
          item.targetPath = `${assignment.role}/imported/${item.sourcePath}`;
        }
      }
      return state.job;
    }
  };
  return { plugin, calls, settings };
}

async function renderKnowledgeInitTab(plugin: Record<string, any>) {
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const preference = Object.freeze({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "default" as const,
    revision: `sha256:${"b".repeat(64)}`,
    content: ""
  });
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
  await settleKnowledgeInitTab(tab);
  return tab;
}

/**
 * 测试 DOM 的 requestAnimationFrame 是同步的：一次 scheduleDisplay 之后
 * displayFrame 会停在非空值。这里先冲刷微任务，再用 display() 做一次干净
 * 的重渲染并复位 displayFrame，模拟真实环境里的下一帧。
 */
async function settleKnowledgeInitTab(tab: CodexSettingTab): Promise<void> {
  await flushProviderModalTasks();
  tab.display();
}

function knowledgeInitPanel(tab: CodexSettingTab) {
  const panel = tab.containerEl.querySelector(".echoink-knowledge-init-panel");
  assert.ok(panel, "expected the single knowledge initialization panel");
  return panel;
}

function knowledgeInitButtons(panel: ReturnType<typeof knowledgeInitPanel>) {
  return Array.from(panel.querySelectorAll("button"));
}

async function assertKnowledgeInitializationExperienceContract(): Promise<void> {
  await assertKnowledgeInitDefaultTabAndOneClickStart();
  await assertKnowledgeInitCustomTabDirectoriesAndAssignments();
  await assertKnowledgeInitPausedMappingsHideTechnicalDetails();
  await assertKnowledgeInitProgressAndCompletion();
  await assertKnowledgeInitStructureTruthAndRepair();
  await assertKnowledgeInitNotePickerModalContract();
  await assertKnowledgeInitRecoveryAndActionErrorRendering();
  await assertKnowledgeInitRawPickerSemantics();
  assertKnowledgeInitNarrowLayoutCssContract();
}

async function assertKnowledgeInitDefaultTabAndOneClickStart(): Promise<void> {
  installProviderModalDomFixture();
  const state = { job: null as Record<string, any> | null };
  const { plugin, calls } = createKnowledgeInitPluginFixture(state);
  const tab = await renderKnowledgeInitTab(plugin);
  const panel = knowledgeInitPanel(tab);
  assert.equal(
    panel.getAttribute("data-echoink-focus-key"),
    "knowledge:onboarding",
    "the knowledge tutorial anchor must exist for every initialization state"
  );

  // 1. 默认 Tab 为初始选中，roving tabindex。
  const tabs = panel.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 2);
  const defaultTab = tabs[0];
  const customTab = tabs[1];
  assert.equal(defaultTab.textContent, "默认方案");
  assert.equal(customTab.textContent, "自定义方案");
  assert.equal(defaultTab.getAttribute("aria-selected"), "true");
  assert.equal(defaultTab.getAttribute("tabindex"), "0");
  assert.equal(customTab.getAttribute("aria-selected"), "false");
  assert.equal(customTab.getAttribute("tabindex"), "-1");
  const tabpanel = panel.querySelector('[role="tabpanel"]');
  assert.ok(tabpanel);
  assert.equal(tabpanel.getAttribute("aria-labelledby"), defaultTab.getAttribute("id"));

  // 默认方案内容：直接用用户能理解的顺序说清楚方法、十个目录、
  // 原笔记保护与 AI 分批提炼；不再藏在「方案说明」折叠区。
  assert.match(panel.textContent, /Karpathy（卡帕西）/u);
  assert.match(panel.textContent, /现有的普通文件/u);
  assert.match(panel.textContent, /Markdown、图片和 PDF/u);
  assert.match(panel.textContent, /Raw/u);
  assert.match(panel.textContent, /AI/u);
  assert.match(panel.textContent, /Wiki/u);
  assert.match(panel.textContent, /不会改写原文/u);
  assert.match(panel.textContent, /没有可提炼内容时会直接跳过/u);
  assert.match(panel.textContent, /确认无误后/u);
  assert.equal(panel.querySelectorAll(".echoink-knowledge-init-folder-purpose").length, 10);
  assert.equal(panel.querySelector(".echoink-knowledge-init-plan-details"), null);
  assert.doesNotMatch(panel.textContent, /一次点击|体系外的 Markdown/u);
  assert.equal(panel.querySelectorAll(".mod-cta").length, 1);
  assert.equal(panel.querySelector(".mod-cta")?.textContent, "开始初始化");
  assert.ok(panel.querySelector('[data-echoink-focus-key="knowledge:initialize"]'));
  assert.equal(panel.querySelector("select"), null);

  // 21. 方向键切换 Tab（自动激活 + roving tabindex）。
  defaultTab.fireEvent("keydown", { key: "ArrowRight" });
  assert.equal(customTab.getAttribute("aria-selected"), "true");
  assert.equal(customTab.getAttribute("tabindex"), "0");
  assert.equal(defaultTab.getAttribute("tabindex"), "-1");
  assert.equal(providerModalTestDocument.activeElement, customTab);
  customTab.fireEvent("keydown", { key: "ArrowLeft" });
  assert.equal(defaultTab.getAttribute("aria-selected"), "true");
  assert.equal(providerModalTestDocument.activeElement, defaultTab);

  // 2. 首次切到自定义：只生成并持久化本地 preview（允许），不 confirm、
  // 不分配、不暂停。
  customTab.click();
  await settleKnowledgeInitTab(tab);
  assert.deepEqual(calls.map((call) => call.method), ["start:custom"]);
  const regeneratedPanel = knowledgeInitPanel(tab);
  assert.equal(
    regeneratedPanel.querySelectorAll(".echoink-knowledge-init-dir-row").length,
    10
  );

  // 2. preview 已存在后，来回切换只替换同一 tabpanel 的主体，且不再产生调用。
  const regeneratedTabs = regeneratedPanel.querySelectorAll('[role="tab"]');
  const stableTabpanel = regeneratedPanel.querySelector('[role="tabpanel"]');
  const callsBeforeSwitching = calls.length;
  regeneratedTabs[0].click();
  assert.equal(regeneratedPanel.querySelector('[role="tabpanel"]'), stableTabpanel);
  assert.equal(regeneratedPanel.querySelectorAll(".echoink-knowledge-init-dir-row").length, 0);
  regeneratedTabs[1].click();
  assert.equal(regeneratedPanel.querySelector('[role="tabpanel"]'), stableTabpanel);
  assert.equal(
    regeneratedPanel.querySelectorAll(".echoink-knowledge-init-dir-row").length,
    10
  );
  assert.equal(calls.length, callsBeforeSwitching);

  // 4. 默认方案点击一次：顺序执行 preview + confirm。
  regeneratedTabs[0].click();
  const cta = regeneratedPanel.querySelector(".echoink-knowledge-init-cta");
  assert.equal(cta?.textContent, "开始初始化");
  cta.click();
  await settleKnowledgeInitTab(tab);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["start:custom", "start:recommended", "confirm"]
  );
  // 3/18. 进入 active 后显示「暂停初始化」，主界面没有内部术语。
  const activePanel = knowledgeInitPanel(tab);
  assert.match(activePanel.textContent, /暂停初始化/u);
  assert.doesNotMatch(activePanel.textContent, /确认并开始|冻结预览|重新预览|Digest/u);
  assert.equal(activePanel.querySelector("select"), null);
  // 收尾：hide 会清理进度轮询定时器，避免挂住测试进程。
  tab.hide();
}

async function assertKnowledgeInitCustomTabDirectoriesAndAssignments(): Promise<void> {
  installProviderModalDomFixture();
  const state = { job: makeKnowledgeInitJobFixture() };
  const { plugin, calls } = createKnowledgeInitPluginFixture(state);
  const tab = await renderKnowledgeInitTab(plugin);
  const panel = knowledgeInitPanel(tab);

  // 5. 页面重载后恢复自定义 Tab 与已有分配，且没有触发任何新调用。
  const tabs = panel.querySelectorAll('[role="tab"]');
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].getAttribute("tabindex"), "-1");
  assert.deepEqual(calls, []);

  // 6. 十个目录全部展示；assets 标注附件目录且无「添加笔记」。
  const rows = panel.querySelectorAll(".echoink-knowledge-init-dir-row");
  assert.equal(rows.length, 10);
  const expectedDirs = [
    "Raw", "Wiki", "Projects", "Outputs", "Inbox",
    "Journal", "Work", "Archive", "Templates"
  ];
  expectedDirs.forEach((label, index) => {
    assert.equal(
      rows[index].querySelector(".echoink-knowledge-init-dir-name")?.textContent,
      label
    );
    assert.ok(rows[index].querySelector(".echoink-knowledge-init-dir-add"));
    assert.equal(
      rows[index].querySelector(".echoink-knowledge-init-dir-toggle")
        ?.getAttribute("aria-expanded"),
      "false"
    );
  });
  const assetsRow = rows[9];
  assert.ok(assetsRow.hasClass("is-assets"));
  assert.equal(assetsRow.querySelector(".echoink-knowledge-init-dir-name")?.textContent, "assets");
  assert.match(assetsRow.textContent, /附件目录/u);
  assert.equal(assetsRow.querySelector(".echoink-knowledge-init-dir-add"), null);
  assert.equal(assetsRow.querySelector(".echoink-knowledge-init-dir-toggle"), null);

  // 8. 未指定笔记默认属于 raw：raw 行计数为 2。
  assert.equal(
    rows[0].querySelector(".echoink-knowledge-init-dir-count")?.textContent,
    "2"
  );

  // 展开为缩进列表行；非 raw 笔记可移回 Raw。
  const wikiToggle = rows[1].querySelector(".echoink-knowledge-init-dir-toggle");
  wikiToggle.click();
  // renderDirectoryList 会重建行 DOM，重新取引用再断言展开态。
  const expandedRows = panel.querySelectorAll(".echoink-knowledge-init-dir-row");
  const expandedToggle = expandedRows[1].querySelector(".echoink-knowledge-init-dir-toggle");
  assert.equal(expandedToggle.getAttribute("aria-expanded"), "true");
  const notePaths = panel.querySelectorAll(".echoink-knowledge-init-note-path");
  assert.equal(notePaths.length, 1);
  assert.equal(notePaths[0].textContent, "notes/alpha.md");
  const remove = panel.querySelector(".echoink-knowledge-init-note-remove");
  assert.ok(remove);
  remove.click();
  await flushProviderModalTasks();
  const assignCall = calls.find((call) => call.method === "assignMany");
  assert.deepEqual(assignCall?.args, [
    { sourcePath: "notes/alpha.md", role: "raw" }
  ]);

  // 9. 同一笔记只有一个目标目录：alpha 移回 raw 后 wiki 计数为 0、raw 为 3。
  const refreshedRows = panel.querySelectorAll(".echoink-knowledge-init-dir-row");
  assert.equal(
    refreshedRows[1].querySelector(".echoink-knowledge-init-dir-count")?.textContent,
    "0"
  );
  assert.equal(
    refreshedRows[0].querySelector(".echoink-knowledge-init-dir-count")?.textContent,
    "3"
  );
}

async function assertKnowledgeInitPausedMappingsHideTechnicalDetails(): Promise<void> {
  installProviderModalDomFixture();
  // 暂停态只展示人话原因和恢复动作，内部状态、错误、Provider 与 digest
  // 在用户界面中完全不出现。
  // 夹具 digest 一致、Provider 与当前设置一致 → 派生为 continue 分支。
  const state = {
    job: makeKnowledgeInitJobFixture({
      status: "failed_recoverable",
      phase: "move_notes",
      confirmedDigest: "sha256:plan-digest-fixture",
      lastError: "File already exists: raw/imported/notes/alpha.md",
      recoveryAction: "检查源与目标的真实状态后再继续；不会覆盖或删除任何文件。"
    })
  };
  const { plugin, calls, settings } = createKnowledgeInitPluginFixture(state);
  // continue 分支要求当前设置里存在与 job 快照一致的可用 Provider：
  // 快照比对用 providerId + model（id 即 provider-ready）。
  const readyProvider = createApiProviderConfig("deepseek", "provider-ready");
  readyProvider.apiKey = "knowledge-init-test-key";
  replaceProviderModels(readyProvider, "model-ready");
  settings.apiProviders = [readyProvider];
  activateApiProvider(settings, readyProvider);
  const tab = await renderKnowledgeInitTab(plugin);
  const panel = knowledgeInitPanel(tab);
  assert.match(panel.textContent, /初始化没有完成/u);
  assert.match(panel.textContent, /失败原因/u);
  assert.match(panel.textContent, /有文件未能安全归入 Raw/u);
  assert.match(panel.textContent, /已完成/u);
  assert.match(panel.textContent, /下一步/u);
  assert.ok(panel.querySelector(".echoink-knowledge-init-pause-icon"));
  const resume = panel.querySelector(".echoink-knowledge-init-cta");
  assert.equal(resume?.textContent, "继续初始化");
  assert.ok(
    knowledgeInitButtons(panel).some((button) => button.textContent === "重新选择方案")
  );

  assert.equal(panel.querySelector(".echoink-knowledge-init-tech"), null);
  const mainText = panel.textContent;
  for (const internal of [
    "failed_recoverable",
    "blocked_conflict",
    "write_uncertain",
    "File already exists",
    "plan-digest-fixture",
    "provider-ready",
    "Digest"
  ]) {
    assert.ok(!mainText.includes(internal), `main UI must not expose ${internal}`);
  }
  assert.doesNotMatch(mainText, /确认并开始|冻结预览/u);
  assert.equal(panel.querySelector("select"), null);

  // 18. paused 显示「继续初始化」；点击后恢复运行。
  resume.click();
  await settleKnowledgeInitTab(tab);
  assert.deepEqual(calls.map((call) => call.method), ["continue"]);
  assert.match(knowledgeInitPanel(tab).textContent, /暂停初始化/u);
  tab.hide();

  // 「重新选择方案」回到 Tab 选择界面。
  const rerunState = { job: makeKnowledgeInitJobFixture({ status: "cancelled" }) };
  const rerun = createKnowledgeInitPluginFixture(rerunState);
  const rerunTab = await renderKnowledgeInitTab(rerun.plugin);
  const rerunPanel = knowledgeInitPanel(rerunTab);
  assert.match(rerunPanel.textContent, /初始化已暂停/u);
  const rerunReselect = knowledgeInitButtons(rerunPanel)
    .find((button) => button.textContent === "重新选择方案");
  rerunReselect?.click();
  await settleKnowledgeInitTab(rerunTab);
  assert.equal(knowledgeInitPanel(rerunTab).querySelectorAll('[role="tab"]').length, 2);
  // 原作业是 custom 且已取消：重新选择后回到自定义 Tab，会重建本地预览
  // （只扫描目录生成 preview，不调用 Provider、不移动文件）。
  assert.deepEqual(rerun.calls.map((call) => call.method), ["start:custom"]);

  // Provider 缺失时使用人话说明。
  const providerlessState = {
    job: makeKnowledgeInitJobFixture({
      status: "failed_recoverable",
      extractionQueue: ["raw/imported/notes/beta.md"],
      provider: null
    })
  };
  const providerless = createKnowledgeInitPluginFixture(providerlessState);
  const providerlessTab = await renderKnowledgeInitTab(providerless.plugin);
  assert.match(
    knowledgeInitPanel(providerlessTab).textContent,
    /没有可用的 API Provider/u
  );
}

async function assertKnowledgeInitProgressAndCompletion(): Promise<void> {
  installProviderModalDomFixture();
  // 14/15/18. active 运行态：真实进度、稳定 live region、暂停按钮。
  const items = Array.from({ length: 40 }, (_unused, index) =>
    makeKnowledgeInitItemFixture(`notes/n${String(index).padStart(2, "0")}.md`, "raw")
  );
  const state = {
    job: makeKnowledgeInitJobFixture({
      mode: "recommended",
      status: "active",
      phase: "move_notes",
      moveCursor: 12,
      items,
      counts: { move: 40, keep: 0, conflict: 0, ignored: 0, extraction: 0 }
    })
  };
  const { plugin } = createKnowledgeInitPluginFixture(state);
  const tab = await renderKnowledgeInitTab(plugin);
  const panel = knowledgeInitPanel(tab);
  const bar = panel.querySelector('.echoink-knowledge-init-bar[role="progressbar"]');
  assert.ok(bar);
  assert.equal(bar.getAttribute("aria-valuemin"), "0");
  assert.equal(bar.getAttribute("aria-valuemax"), "100");
  assert.equal(bar.getAttribute("aria-valuenow"), "28");
  assert.equal(
    panel.querySelector<HTMLElement>(".echoink-knowledge-init-bar-indicator")
      ?.style.getPropertyValue("--echoink-knowledge-init-progress"),
    "28%"
  );
  assert.equal(panel.querySelector(".echoink-knowledge-init-percent")?.textContent, "28%");
  assert.equal(panel.querySelector(".echoink-knowledge-init-step")?.textContent, "正在移动笔记");
  assert.equal(panel.querySelector(".echoink-knowledge-init-count")?.textContent, "12 / 40");
  const status = panel.querySelector(".echoink-knowledge-init-status");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.getAttribute("tabindex"), null);
  assert.match(status.textContent, /正在移动笔记 · 12 \/ 40 · 28%/u);
  assert.match(panel.textContent, /暂停初始化/u);
  tab.hide();

  // 暂停按钮调用现有 cancel API。
  const pause = knowledgeInitButtons(panel)
    .find((button) => button.textContent === "暂停初始化");
  assert.ok(pause);

  // 20. 完成态只显示「打开 Wiki 首页」与「整理新增笔记」。
  const doneState = {
    job: makeKnowledgeInitJobFixture({ status: "initialized", phase: "complete" })
  };
  const done = createKnowledgeInitPluginFixture(doneState);
  done.settings.knowledgeBase.initialization.status = "initialized";
  const doneTab = await renderKnowledgeInitTab(done.plugin);
  const donePanel = knowledgeInitPanel(doneTab);
  assert.equal(
    donePanel.getAttribute("data-echoink-focus-key"),
    "knowledge:onboarding",
    "an initialized knowledge base must still expose the tutorial anchor"
  );
  assert.match(donePanel.textContent, /知识库状态正常/u);
  assert.ok(donePanel.querySelector(".echoink-knowledge-init-status-heading.is-init-ready"));
  assert.deepEqual(
    knowledgeInitButtons(donePanel).map((button) => button.textContent),
    ["打开 Wiki 首页", "整理新增笔记"]
  );
  assert.doesNotMatch(donePanel.textContent, /Digest|provider-ready|移动 4/u);
}

async function assertKnowledgeInitStructureTruthAndRepair(): Promise<void> {
  installProviderModalDomFixture();

  // 历史 initialized 不能覆盖真实空 Vault：十个目录一个都没有时必须
  // 回到默认/自定义初始化入口。
  const emptyState = {
    job: makeKnowledgeInitJobFixture({ status: "initialized", phase: "complete" }),
    structure: makeKnowledgeBaseStructureFixture("uninitialized")
  };
  const empty = createKnowledgeInitPluginFixture(emptyState);
  empty.settings.knowledgeBase.initialization.status = "initialized";
  const emptyTab = await renderKnowledgeInitTab(empty.plugin);
  const emptyPanel = knowledgeInitPanel(emptyTab);
  assert.match(emptyPanel.textContent, /初始化知识库/u);
  assert.equal(emptyPanel.querySelectorAll('[role="tab"]').length, 2);
  assert.equal(
    emptyPanel.querySelectorAll('[role="tab"]')[0]?.getAttribute("aria-selected"),
    "true"
  );
  assert.doesNotMatch(emptyPanel.textContent, /知识库状态正常/u);
  emptyTab.hide();

  // 部分目录缺失：就地说明发生了什么、为什么影响使用、点击什么恢复。
  const partialState = {
    job: makeKnowledgeInitJobFixture({ status: "initialized", phase: "complete" }),
    structure: makeKnowledgeBaseStructureFixture("incomplete", {
      existingRoots: ["raw", "wiki", "outputs", "inbox", "journal", "work", "archive", "templates"],
      missingRoots: ["projects", "assets"]
    })
  };
  const partial = createKnowledgeInitPluginFixture(partialState);
  const repairFlight = deferred<Record<string, any>>();
  partial.plugin.restoreEchoInkKnowledgeBaseStructure = async (
    onProgress?: (progress: Record<string, unknown>) => void
  ) => {
    onProgress?.({ completed: 0, total: 10, percent: 0, currentRoot: null });
    onProgress?.({ completed: 4, total: 10, percent: 40, currentRoot: "outputs" });
    return await repairFlight.promise;
  };
  const partialTab = await renderKnowledgeInitTab(partial.plugin);
  let partialPanel = knowledgeInitPanel(partialTab);
  assert.match(partialPanel.textContent, /知识库文件夹结构不完整/u);
  assert.match(partialPanel.textContent, /缺少目录：projects、assets/u);
  assert.match(partialPanel.textContent, /可能无法正常工作/u);
  assert.match(partialPanel.textContent, /不会移动、删除或改写任何笔记/u);
  assert.ok(partialPanel.querySelector(".echoink-knowledge-init-status-heading.is-init-warning"));
  assert.equal(
    knowledgeInitButtons(partialPanel).find((button) => button.textContent === "恢复文件夹体系")
      ?.getAttribute("type"),
    "button"
  );

  // 恢复期间显示真实 0–100% 进度；完成后再由真实结构切到正常态。
  knowledgeInitButtons(partialPanel)
    .find((button) => button.textContent === "恢复文件夹体系")
    ?.click();
  await flushProviderModalTasks();
  partialTab.display();
  partialPanel = knowledgeInitPanel(partialTab);
  assert.match(partialPanel.textContent, /正在恢复文件夹体系/u);
  assert.ok(partialPanel.querySelector(".echoink-knowledge-init-status-heading.is-init-loading"));
  assert.equal(
    partialPanel.querySelector(".echoink-knowledge-init-status-heading.is-loading"),
    null,
    "knowledge initialization must not reuse Obsidian's generic is-loading class"
  );
  assert.equal(
    partialPanel.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    "40"
  );
  assert.equal(partialPanel.querySelector(".echoink-knowledge-init-percent")?.textContent, "40%");
  repairFlight.resolve({
    structure: makeKnowledgeBaseStructureFixture("ready"),
    createdRoots: ["projects", "assets"]
  });
  await flushProviderModalTasks();
  partialTab.display();
  partialPanel = knowledgeInitPanel(partialTab);
  assert.match(partialPanel.textContent, /知识库状态正常/u);
  assert.ok(partialPanel.querySelector(".echoink-knowledge-init-status-heading.is-init-ready"));
  // 关闭后重新进入必须重新读 Vault，不能继续复用上次的 ready 快照。
  partialTab.hide();
  partialState.structure = makeKnowledgeBaseStructureFixture("uninitialized");
  partialTab.display();
  await settleKnowledgeInitTab(partialTab);
  assert.match(knowledgeInitPanel(partialTab).textContent, /初始化知识库/u);
  assert.doesNotMatch(knowledgeInitPanel(partialTab).textContent, /知识库状态正常/u);
  partialTab.hide();

  // 同名文件冲突必须保留原文件，并明确要求先重命名；不能伪装成可自动覆盖。
  const conflictState = {
    job: makeKnowledgeInitJobFixture({ status: "initialized", phase: "complete" }),
    structure: makeKnowledgeBaseStructureFixture("incomplete", {
      existingRoots: KNOWLEDGE_INITIALIZATION_ROOTS.filter((root) => root !== "raw"),
      missingRoots: [],
      conflictingRoots: ["raw"]
    })
  };
  const conflict = createKnowledgeInitPluginFixture(conflictState);
  const conflictTab = await renderKnowledgeInitTab(conflict.plugin);
  const conflictPanel = knowledgeInitPanel(conflictTab);
  assert.match(conflictPanel.textContent, /同名文件占用：raw/u);
  assert.match(conflictPanel.textContent, /不会覆盖或移动/u);
  assert.ok(
    knowledgeInitButtons(conflictPanel).some((button) => button.textContent === "重新检查")
  );
  conflictTab.hide();
}

async function assertKnowledgeInitNotePickerModalContract(): Promise<void> {
  installProviderModalDomFixture();
  const state = { job: makeKnowledgeInitJobFixture() };
  const { plugin, calls } = createKnowledgeInitPluginFixture(state);
  const originalStart = plugin.startEchoInkKnowledgeInitialization;
  plugin.startEchoInkKnowledgeInitialization = async (mode: string) => {
    const refreshed = await originalStart(mode);
    if (mode === "custom") {
      // 模拟用户在旧 preview 生成后才新建的两篇笔记；点击「添加笔记」
      // 必须重新读取当前 Vault，不能继续展示旧冻结列表。
      refreshed.items.push(
        makeKnowledgeInitItemFixture("notes/10.md", "raw"),
        makeKnowledgeInitItemFixture("notes/2.md", "raw")
      );
    }
    return refreshed;
  };
  const tab = await renderKnowledgeInitTab(plugin);
  let panel = knowledgeInitPanel(tab);
  let wikiRow = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[1];
  const add = wikiRow.querySelector<HTMLButtonElement>(".echoink-knowledge-init-dir-add");
  add.focus();
  add.click();
  await flushProviderModalTasks();
  const modal = openTestModals.at(-1);
  assert.ok(modal, "note picker modal opens");

  // 13. 打开后焦点在搜索框；当前目录笔记默认勾选；其他目录显示当前归属。
  const search = modal.contentEl.querySelector<HTMLInputElement>(
    ".echoink-knowledge-note-picker-search"
  );
  assert.ok(search);
  assert.equal(providerModalTestDocument.activeElement, search);
  assert.equal(
    modal.contentEl.querySelectorAll(".echoink-knowledge-note-picker-row").length,
    6
  );
  const defaultPaths = modal.contentEl
    .querySelectorAll(".echoink-knowledge-note-picker-path")
    .map((element) => element.textContent);
  assert.deepEqual(defaultPaths, [
    "notes/2.md",
    "notes/10.md",
    "notes/alpha.md",
    "notes/beta.md",
    "notes/delta.md",
    "notes/gamma.md"
  ]);
  assert.equal(modal.contentEl.querySelector(".echoink-knowledge-note-picker-empty"), null);
  const checkboxes = modal.contentEl.querySelectorAll<HTMLInputElement>(
    ".echoink-knowledge-note-picker-checkbox"
  );
  assert.deepEqual(
    checkboxes.map((checkbox) => checkbox.checked),
    [false, false, true, false, false, false]
  );
  assert.doesNotMatch(modal.contentEl.textContent, /当前：|将移动到|将移回/u);
  assert.equal(
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.textContent,
    "选好了（1）"
  );

  // 13. 搜索过滤但保留勾选状态。
  search.value = "gamma";
  search.fireEvent("input");
  assert.equal(
    modal.contentEl.querySelectorAll(".echoink-knowledge-note-picker-row").length,
    1
  );
  search.value = "";
  search.fireEvent("input");
  const checkboxesAfterFilter = modal.contentEl.querySelectorAll<HTMLInputElement>(
    ".echoink-knowledge-note-picker-checkbox"
  );
  assert.equal(checkboxesAfterFilter.length, 6);
  assert.equal(checkboxesAfterFilter[2].checked, true);

  search.value = "does-not-exist";
  search.fireEvent("input");
  assert.match(
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-empty")?.textContent ?? "",
    /没有匹配的笔记/u
  );
  search.value = "";
  search.fireEvent("input");

  // 整行 label 与 checkbox 同一点击区域；复选框是每行最右侧元素。
  const selectableRows = modal.contentEl.querySelectorAll<HTMLLabelElement>(
    ".echoink-knowledge-note-picker-row:not(.is-readonly)"
  );
  for (const row of selectableRows) {
    const checkbox = row.querySelector(".echoink-knowledge-note-picker-checkbox");
    assert.equal(checkbox?.parentElement?.tagName.toLowerCase(), "label");
    assert.equal(row.children.at(-1) === checkbox, true);
  }

  // 勾选 beta 与 delta → 计数更新。
  const checkboxFor = (sourcePath: string): HTMLInputElement => {
    const row = modal.contentEl.querySelectorAll<HTMLLabelElement>(
      ".echoink-knowledge-note-picker-row"
    ).find((candidate) => candidate.textContent.includes(sourcePath));
    const checkbox = row?.querySelector<HTMLInputElement>(
      ".echoink-knowledge-note-picker-checkbox"
    );
    assert.ok(checkbox, `expected checkbox for ${sourcePath}`);
    return checkbox;
  };
  for (const sourcePath of ["notes/beta.md", "notes/delta.md"]) {
    const checkbox = checkboxFor(sourcePath);
    checkbox.checked = true;
    checkbox.fireEvent("change");
  }
  assert.doesNotMatch(modal.contentEl.textContent, /当前：|将移动到|将移回/u);
  assert.equal(
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.textContent,
    "选好了（3）"
  );

  // 13/21. 焦点约束：Shift+Tab 从搜索框循环到确认按钮。
  modal.modalEl.fireEvent("keydown", { key: "Tab", shiftKey: true });
  assert.equal(
    providerModalTestDocument.activeElement,
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")
  );

  // 确认后一次性批量写入，焦点恢复到触发按钮。
  modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.click();
  await flushProviderModalTasks();
  const assignCall = calls.filter((call) => call.method === "assignMany").at(-1);
  assert.deepEqual(assignCall?.args, [
    { sourcePath: "notes/beta.md", role: "wiki" },
    { sourcePath: "notes/delta.md", role: "wiki" }
  ]);
  assert.equal(openTestModals.length, 0);
  // 确认后目录列表原地重建，焦点回到重建后的 Wiki「添加笔记」按钮。
  const rebuiltWikiAdd = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[1]
    .querySelector(".echoink-knowledge-init-dir-add");
  assert.equal(providerModalTestDocument.activeElement, rebuiltWikiAdd);

  // 12. Escape 取消零写入，焦点同样恢复。
  panel = knowledgeInitPanel(tab);
  wikiRow = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[1];
  const addAgain = wikiRow.querySelector<HTMLButtonElement>(".echoink-knowledge-init-dir-add");
  addAgain.focus();
  addAgain.click();
  await flushProviderModalTasks();
  const cancelModal = openTestModals.at(-1);
  assert.ok(cancelModal);
  const writesBeforeEscape = calls.filter((call) => call.method === "assignMany").length;
  const cancelCheckboxes = cancelModal.contentEl.querySelectorAll<HTMLInputElement>(
    ".echoink-knowledge-note-picker-checkbox"
  );
  cancelCheckboxes[1].checked = true;
  cancelCheckboxes[1].fireEvent("change");
  cancelModal.modalEl.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks();
  assert.equal(openTestModals.length, 0);
  assert.equal(
    calls.filter((call) => call.method === "assignMany").length,
    writesBeforeEscape,
    "Escape must not write assignments"
  );
  const addAfterEscape = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[1]
    .querySelector(".echoink-knowledge-init-dir-add");
  assert.equal(providerModalTestDocument.activeElement === addAfterEscape, true);

  // Vault 真的没有可分配笔记时使用独立空状态；只有用户输入搜索且无结果
  // 才能说「没有匹配的笔记」。
  const emptyModal = new KnowledgeNotePickerModal(plugin.app, {
    zh: true,
    targetRole: "wiki",
    targetLabel: "Wiki",
    notes: [],
    onConfirm: async () => undefined
  });
  emptyModal.open();
  assert.match(emptyModal.contentEl.textContent, /还没有可分配的 Markdown 笔记/u);
  assert.doesNotMatch(emptyModal.contentEl.textContent, /没有匹配的笔记/u);
  emptyModal.close();
}

/**
 * 修复1/2/3 回归：
 * - 渲染优先级：settings 已 initialized 也不能遮住新的未完成作业；
 *   无 job 时由真实目录结构决定完成态。
 * - 恢复动作按结构化字段派生：blocked_conflict 不出现「继续初始化」；
 *   Provider 缺失 / digest 不一致 → 「重新检查并继续」。
 * - 用户动作失败必须可见可重试（actionError + 技术详情）。
 */
async function assertKnowledgeInitRecoveryAndActionErrorRendering(): Promise<void> {
  installProviderModalDomFixture();

  // 1. settings 已 initialized + 新的 paused 作业（digest 与 Provider 一致）：
  //    必须显示恢复界面，而不是「知识库状态正常」。
  const maskedState = {
    job: makeKnowledgeInitJobFixture({
      status: "paused",
      phase: "move_notes",
      confirmedDigest: "sha256:plan-digest-fixture"
    })
  };
  const masked = createKnowledgeInitPluginFixture(maskedState);
  const readyProvider = createApiProviderConfig("deepseek", "provider-ready");
  readyProvider.apiKey = "knowledge-init-test-key";
  replaceProviderModels(readyProvider, "model-ready");
  masked.settings.apiProviders = [readyProvider];
  activateApiProvider(masked.settings, readyProvider);
  masked.settings.knowledgeBase.initialization.status = "initialized";
  const maskedTab = await renderKnowledgeInitTab(masked.plugin);
  const maskedPanel = knowledgeInitPanel(maskedTab);
  assert.doesNotMatch(maskedPanel.textContent, /知识库状态正常/u,
    "a pending job must never be masked by the done panel");
  assert.match(maskedPanel.textContent, /初始化已暂停/u);
  assert.equal(maskedPanel.querySelector(".echoink-knowledge-init-cta")?.textContent, "继续初始化");
  maskedTab.hide();

  // 2. 无 job + settings initialized + 真实目录完整 → 完成态。
  const doneState = {
    job: null as Record<string, any> | null,
    structure: makeKnowledgeBaseStructureFixture("ready")
  };
  const done = createKnowledgeInitPluginFixture(doneState);
  done.settings.knowledgeBase.initialization.status = "initialized";
  const doneTab = await renderKnowledgeInitTab(done.plugin);
  assert.match(knowledgeInitPanel(doneTab).textContent, /知识库状态正常/u);
  doneTab.hide();

  // 3. blocked_conflict：只有「重新检查冲突」+「重新选择方案」，
  //    禁止出现必然失败的「继续初始化」。
  const conflictState = {
    job: makeKnowledgeInitJobFixture({
      mode: "recommended",
      status: "blocked_conflict",
      phase: "confirmed",
      confirmedDigest: "sha256:plan-digest-fixture"
    })
  };
  const conflict = createKnowledgeInitPluginFixture(conflictState);
  const conflictTab = await renderKnowledgeInitTab(conflict.plugin);
  const conflictPanel = knowledgeInitPanel(conflictTab);
  assert.match(conflictPanel.textContent, /初始化遇到冲突/u);
  assert.equal(conflictPanel.querySelector(".echoink-knowledge-init-cta")?.textContent, "重新检查冲突");
  assert.ok(
    !knowledgeInitButtons(conflictPanel).some((button) => button.textContent === "继续初始化"),
    "blocked_conflict must not offer a doomed continue"
  );
  // 推荐模式重新检查 = 重新扫描后立即确认。
  conflictPanel.querySelector<HTMLButtonElement>(".echoink-knowledge-init-cta")?.click();
  await settleKnowledgeInitTab(conflictTab);
  assert.deepEqual(conflict.calls.map((call) => call.method), ["start:recommended", "confirm"]);
  conflictTab.hide();

  // 3b. 自定义冲突点「修改分配」时，重新扫描后必须一次性恢复仍然合法的
  // 旧目录选择；兼容的 keep 也必须保留，不能静默退回 Raw。
  const customConflictState = {
    job: makeKnowledgeInitJobFixture({
      mode: "custom",
      status: "blocked_conflict",
      phase: "confirmed",
      confirmedDigest: "sha256:plan-digest-fixture",
      items: [
        makeKnowledgeInitItemFixture("notes/alpha.md", "wiki"),
        makeKnowledgeInitItemFixture("notes/beta.md", "keep", {
          targetPath: null,
          state: "kept"
        }),
        makeKnowledgeInitItemFixture("notes/gamma.md", "raw"),
        makeKnowledgeInitItemFixture("notes/delta.md", "projects"),
      ]
    })
  };
  const customConflict = createKnowledgeInitPluginFixture(customConflictState);
  const customConflictTab = await renderKnowledgeInitTab(customConflict.plugin);
  const customConflictPanel = knowledgeInitPanel(customConflictTab);
  const editAssignments = knowledgeInitButtons(customConflictPanel).find(
    (button) => button.textContent === "修改分配"
  );
  assert.ok(editAssignments, "custom conflict must offer an edit-assignments action");
  editAssignments.click();
  await settleKnowledgeInitTab(customConflictTab);
  assert.deepEqual(
    customConflict.calls.map((call) => call.method),
    ["start:custom", "assignMany"],
    "editing a custom conflict must rescan once and restore assignments once"
  );
  assert.deepEqual(
    customConflict.calls.find((call) => call.method === "assignMany")?.args,
    [
      { sourcePath: "notes/alpha.md", role: "wiki" },
      { sourcePath: "notes/beta.md", role: "keep" },
      { sourcePath: "notes/delta.md", role: "projects" },
    ],
    "custom recovery must preserve every still-valid non-Raw assignment"
  );
  assert.ok(
    knowledgeInitPanel(customConflictTab).querySelector('[role="tabpanel"]'),
    "custom recovery must stop at the editable preview instead of confirming"
  );
  customConflictTab.hide();

  // 4a. Provider 缺失（当前设置没有可用 Provider）→ 重新检查并继续 + 人话提示。
  const providerlessState = {
    job: makeKnowledgeInitJobFixture({
      status: "paused",
      phase: "move_notes",
      confirmedDigest: "sha256:plan-digest-fixture"
    })
  };
  const providerless = createKnowledgeInitPluginFixture(providerlessState);
  const providerlessTab = await renderKnowledgeInitTab(providerless.plugin);
  const providerlessPanel = knowledgeInitPanel(providerlessTab);
  const providerlessRecheck = providerlessPanel.querySelector<HTMLButtonElement>(
    ".echoink-knowledge-init-cta"
  );
  assert.equal(providerlessRecheck?.textContent, "重新检查并继续");
  assert.ok(providerlessRecheck?.hasClass("echoink-particle-button"));
  assert.equal(
    providerlessRecheck?.querySelector(".echoink-particle-button-icon")
      ?.getAttribute("data-echoink-icon"),
    "refresh-cw"
  );
  assert.equal(
    providerlessRecheck?.querySelectorAll(".echoink-particle-button-dot").length,
    6
  );
  assert.match(providerlessPanel.textContent, /没有可用的 API Provider/u);
  const providerLink = providerlessPanel.querySelector<HTMLButtonElement>(
    ".echoink-knowledge-init-provider-link"
  );
  assert.equal(providerLink?.textContent, "去设置 API Provider");
  assert.equal(providerLink?.getAttribute("type"), "button");
  assert.equal(
    providerLink?.closest('[role="status"]'),
    null,
    "the interactive Provider link must stay outside the live status node"
  );
  providerLink?.click();
  await flushProviderModalTasks();
  assert.equal(providerless.settings.settingsTab, "providers");
  assert.deepEqual(providerless.calls, [], "opening Provider settings must not retry initialization");
  providerlessTab.hide();

  // 4b. digest 不一致（从未确认）→ 重新检查并继续，提示「计划已变化」。
  const staleDigestState = {
    job: makeKnowledgeInitJobFixture({ status: "paused", phase: "preview" })
  };
  const staleDigest = createKnowledgeInitPluginFixture(staleDigestState);
  const staleProvider = createApiProviderConfig("deepseek", "provider-ready");
  staleProvider.apiKey = "knowledge-init-test-key";
  replaceProviderModels(staleProvider, "model-ready");
  staleDigest.settings.apiProviders = [staleProvider];
  activateApiProvider(staleDigest.settings, staleProvider);
  const staleTab = await renderKnowledgeInitTab(staleDigest.plugin);
  const stalePanel = knowledgeInitPanel(staleTab);
  assert.equal(stalePanel.querySelector(".echoink-knowledge-init-cta")?.textContent, "重新检查并继续");
  assert.match(stalePanel.textContent, /模型或文件计划在确认后发生了变化/u);
  assert.equal(
    stalePanel.querySelector(".echoink-knowledge-init-provider-link"),
    null,
    "a changed plan with a usable Provider must not show the setup link"
  );
  staleTab.hide();

  // 5. 用户动作失败可见可重试：开始初始化抛错 → 只显示人话错误；
  //    再次点击成功 → 错误消失并进入进度界面。
  //    用闭包标志切换「抛错 / 成功」，避免渲染后替换方法被快照绕过。
  const errorState = { job: null as Record<string, any> | null };
  const { plugin } = createKnowledgeInitPluginFixture(errorState);
  const originalStart = plugin.startEchoInkKnowledgeInitialization;
  let startShouldThrow = true;
  plugin.startEchoInkKnowledgeInitialization = async () => {
    if (startShouldThrow) throw new Error("injected-start-failure");
    return originalStart("recommended");
  };
  const errorTab = await renderKnowledgeInitTab(plugin);
  let errorPanel = knowledgeInitPanel(errorTab);
  errorPanel.querySelector<HTMLButtonElement>(".echoink-knowledge-init-cta")?.click();
  await settleKnowledgeInitTab(errorTab);
  errorPanel = knowledgeInitPanel(errorTab);
  const errorBoxPresent = errorPanel.querySelector(".echoink-knowledge-init-action-error") !== null;
  assert.equal(errorBoxPresent, true, "failed user action must surface a visible error");
  assert.match(errorPanel.textContent, /操作没有完成，可以再试一次/u);
  assert.doesNotMatch(errorPanel.textContent, /injected-start-failure|查看技术详情/u);
  // 重试成功：切到成功分支，错误提示消失，进入运行态。
  startShouldThrow = false;
  errorPanel.querySelector<HTMLButtonElement>(".echoink-knowledge-init-cta")?.click();
  await settleKnowledgeInitTab(errorTab);
  const recoveredPanel = knowledgeInitPanel(errorTab);
  const recoveredHasError = recoveredPanel.querySelector(".echoink-knowledge-init-action-error") !== null;
  assert.equal(recoveredHasError, false, "a successful retry must clear the action error");
  assert.match(recoveredPanel.textContent, /暂停初始化/u);
  errorTab.hide();
}

/**
 * 修复5/3 回归：Raw 目录选择器是「移回 Raw」语义——
 * 已在 Raw 的笔记只读展示、无预勾选；提交失败时 Modal 保持打开、
 * 显示内联错误且可以再次提交。
 */
async function assertKnowledgeInitRawPickerSemantics(): Promise<void> {
  installProviderModalDomFixture();
  const state = { job: makeKnowledgeInitJobFixture() };
  const { plugin, calls } = createKnowledgeInitPluginFixture(state);
  const originalStart = plugin.startEchoInkKnowledgeInitialization;
  plugin.startEchoInkKnowledgeInitialization = async (mode: string) => {
    const refreshed = await originalStart(mode);
    if (mode === "custom") {
      // fixture 中 notes/* 都是体系外笔记，重新扫描时它们的默认目录应为 Raw；
      // UI 再恢复用户明确做过的非 Raw 分配。
      for (const item of refreshed.items) {
        item.role = "raw";
        item.targetPath = `raw/imported/${item.sourcePath}`;
        item.state = "pending";
      }
    }
    return refreshed;
  };
  // 失败注入必须在渲染前接好：renderKnowledgeInitTab 会把 plugin 展开成快照，
  // 渲染之后再替换方法不会生效。这里用闭包标志切换「下一次 assignMany 抛错」。
  const originalAssign = plugin.assignManyEchoInkKnowledgeInitializationNotes;
  let failNextAssign = false;
  plugin.assignManyEchoInkKnowledgeInitializationNotes = async (
    assignments: ReadonlyArray<{ sourcePath: string; role: string }>
  ) => {
    if (failNextAssign) {
      failNextAssign = false;
      throw new Error("injected-assign-failure");
    }
    return originalAssign(assignments);
  };
  const tab = await renderKnowledgeInitTab(plugin);
  let panel = knowledgeInitPanel(tab);

  // Raw 行（第 0 行）按钮文案是「移回 Raw」而不是「添加笔记」。
  const rawRow = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[0];
  const rawAdd = rawRow.querySelector<HTMLButtonElement>(".echoink-knowledge-init-dir-add");
  assert.equal(rawAdd.textContent, "移回 Raw");
  assert.equal(rawAdd.getAttribute("aria-label"), "把其他目录的笔记移回 Raw");
  rawAdd.focus();
  rawAdd.click();
  await flushProviderModalTasks();
  const modal = openTestModals.at(-1);
  assert.ok(modal, "raw picker modal opens");
  assert.match(modal.titleEl.textContent, /移回 Raw/u);

  // 已在 Raw 的笔记（beta/gamma）只读；其他笔记（alpha/delta）可勾选，无预勾选。
  assert.match(modal.contentEl.textContent, /已在 Raw/u);
  const readonlyRows = modal.contentEl.querySelectorAll(".echoink-knowledge-note-picker-row.is-readonly");
  assert.equal(readonlyRows.length, 2);
  const checkboxes = modal.contentEl.querySelectorAll<HTMLInputElement>(
    ".echoink-knowledge-note-picker-checkbox"
  );
  assert.equal(checkboxes.length, 2);
  assert.deepEqual(checkboxes.map((checkbox) => checkbox.checked), [false, false]);
  assert.equal(
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.textContent,
    "移回 Raw（0）"
  );

  // 勾选 alpha → 计数与 badge 更新，确认后只写 raw 分配。
  checkboxes[0].checked = true;
  checkboxes[0].fireEvent("change");
  assert.equal(
    modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.textContent,
    "移回 Raw（1）"
  );
  modal.contentEl.querySelector(".echoink-knowledge-note-picker-confirm")?.click();
  await flushProviderModalTasks();
  assert.deepEqual(calls.filter((call) => call.method === "assignMany").at(-1)?.args, [
    { sourcePath: "notes/alpha.md", role: "raw" }
  ]);
  assert.equal(openTestModals.length, 0);
  // 焦点恢复到重建后的 Raw「移回 Raw」按钮。
  panel = knowledgeInitPanel(tab);
  const rebuiltRawAdd = panel.querySelectorAll(".echoink-knowledge-init-dir-row")[0]
    .querySelector(".echoink-knowledge-init-dir-add");
  assert.equal(providerModalTestDocument.activeElement, rebuiltRawAdd);

  // 提交失败：Modal 保持打开、内联错误、按钮可再次点击；重试成功后关闭。
  rebuiltRawAdd.click();
  await flushProviderModalTasks();
  const failModal = openTestModals.at(-1);
  assert.ok(failModal, "raw picker reopens for the failure scenario");
  failNextAssign = true;
  const failCheckboxes = failModal.contentEl.querySelectorAll<HTMLInputElement>(
    ".echoink-knowledge-note-picker-checkbox"
  );
  // alpha 已经在 Raw（只读）；剩下 delta 一个可勾选。
  assert.equal(failCheckboxes.length, 1);
  failCheckboxes[0].checked = true;
  failCheckboxes[0].fireEvent("change");
  const failConfirm = failModal.contentEl.querySelector<HTMLButtonElement>(
    ".echoink-knowledge-note-picker-confirm"
  );
  failConfirm.click();
  await flushProviderModalTasks();
  assert.equal(openTestModals.length, 1, "failed save must keep the modal open");
  const inlineError = failModal.contentEl.querySelector(".echoink-knowledge-note-picker-error");
  assert.ok(inlineError, "failed save must render an inline error");
  assert.match(inlineError.textContent, /没有保存成功，请再试一次/u);
  assert.doesNotMatch(inlineError.textContent, /injected-assign-failure/u);
  assert.equal(failConfirm.disabled, false, "confirm button must be re-enabled after failure");
  assert.ok(
    knowledgeInitPanel(tab).querySelector(".echoink-knowledge-init-action-error"),
    "the parent panel must also surface the failed assignment"
  );
  // 再次提交：成功并关闭。
  failConfirm.click();
  await flushProviderModalTasks();
  assert.equal(openTestModals.length, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === "assignMany").at(-1)?.args,
    [{ sourcePath: "notes/delta.md", role: "raw" }]
  );
  assert.equal(
    knowledgeInitPanel(tab).querySelector(".echoink-knowledge-init-action-error"),
    null,
    "a successful retry must remove the stale parent error banner immediately"
  );
  tab.hide();
}

function assertKnowledgeInitNarrowLayoutCssContract(): void {
  // 22. 窄设置窗口不依赖固定双列宽度；长路径可换行。
  const css = readFileSync("styles.css", "utf8");
  const dirRow = css.match(/\.echoink-knowledge-init-dir-row\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(dirRow, /minmax\(0,\s*1fr\)/u);
  assert.doesNotMatch(dirRow, /grid-template-columns:\s*1fr\s+1fr/u);
  assert.match(
    css,
    /\.modal\.echoink-knowledge-note-picker\s*\{[^}]*width:\s*min\(/u,
    "note picker selector must match the modal element itself (.modal.echoink-knowledge-note-picker)"
  );
  assert.match(
    css,
    /\.echoink-knowledge-note-picker-path\s*\{[^}]*overflow-wrap:\s*anywhere/u
  );
  assert.match(
    css,
    /\.echoink-knowledge-note-picker-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/u,
    "note text must occupy the left column and the checkbox the right column"
  );
  assert.match(
    css,
    /\.echoink-knowledge-init-bar-indicator\s*\{[^}]*transition:\s*width/u,
    "the progress indicator must animate real percentage changes"
  );
  assert.match(
    css,
    /prefers-reduced-motion:\s*reduce[\s\S]*\.echoink-knowledge-init-bar-indicator[\s\S]*transition:\s*none/u,
    "reduced-motion users must get immediate progress updates"
  );
  assert.match(
    css,
    /\.echoink-particle-button\.is-particle-bursting \.echoink-particle-button-dot\s*\{[^}]*animation:\s*echoink-particle-button-burst/u,
    "the recoverable recheck action must use the six-particle burst"
  );
  assert.match(
    css,
    /prefers-reduced-motion:\s*reduce[\s\S]*\.echoink-particle-button-dot\s*\{[^}]*animation:\s*none\s*!important/u,
    "particle motion must be disabled when reduced motion is requested"
  );
  assert.match(
    css,
    /\.echoink-knowledge-init-pause \.echoink-knowledge-init-provider-link\s*\{[^}]*background-size:\s*0\s+1px[^}]*color:\s*var\(--text-accent\)/u,
    "the Provider route must look like an accent-colored animated text link"
  );
  assert.match(
    css,
    /\.echoink-knowledge-init-pause \.echoink-knowledge-init-provider-link:is\(:hover, :focus-visible\)\s*\{[^}]*background-size:\s*100%\s+1px/u,
    "the Provider link underline must grow on hover and keyboard focus"
  );
  assert.doesNotMatch(css, /\.echoink-knowledge-init-tech(?:-|\s|\.)/u);
  assert.match(
    css,
    /\.echoink-knowledge-init-note-path\s*\{[^}]*overflow-wrap:\s*anywhere/u
  );
  assert.match(css, /\.echoink-knowledge-init-tabpanel\s*\{[^}]*min-width:\s*0/u);
  assert.match(css, /prefers-reduced-motion/u);
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

function assertOpenAICodexSseAdapterContract(): void {
  const captured: StreamOptions[] = [];
  const upstream: ProviderStreams = {
    stream: (_model, _context, options) => {
      captured.push(options ?? {});
      return {} as never;
    },
    streamSimple: (_model, _context, options) => {
      captured.push(options ?? {});
      return {} as never;
    }
  };
  const adapter = createOpenAICodexSseAdapter(upstream);
  adapter.stream({} as never, {} as never, {
    transport: "websocket"
  });
  adapter.streamSimple({} as never, {} as never, {
    transport: "auto"
  });
  assert.deepEqual(
    captured.map((options) => options.transport),
    ["sse", "sse"]
  );
}

async function assertProviderAuthResolutionFailureContract(): Promise<void> {
  const failureCode = async (
    authMode: "api-key" | "oauth"
  ): Promise<string | undefined> => {
    const oauth = authMode === "oauth";
    const model = createPiProviderModelDefinition({
      providerId: oauth ? "openai-codex" : "deepseek",
      apiProtocol: oauth
        ? "openai-codex-responses"
        : "openai-completions",
      baseUrl: oauth
        ? "https://chatgpt.com/backend-api"
        : "https://api.deepseek.com",
      modelRef: oauth ? "gpt-5.6-sol" : "deepseek-v4-flash"
    });
    const transport = new PiProviderProtocolTransport({
      authorityId: "fixture-authority",
      storeSetId: "fixture-store-set",
      resolveAuthToken: async () => {
        throw new Error("fixture-auth-resolution-failed");
      }
    });
    const stream = await transport.stream({
      runId: "fixture-run",
      conversationId: "fixture-conversation",
      turnId: "fixture-turn",
      correlationId: "fixture-correlation",
      provider: {
        providerId: model.provider,
        apiProtocol: model.api,
        authMode,
        baseUrl: model.baseUrl,
        modelRef: model.id
      },
      model,
      context: { messages: [], tools: [] },
      options: {
        maxTokens: 32,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 1_000
      }
    });
    return (await stream.result()).errorMessage;
  };

  assert.equal(
    await failureCode("oauth"),
    "provider_oauth_relogin_required"
  );
  assert.equal(
    await failureCode("api-key"),
    "provider_api_key_missing"
  );
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
  assert.equal(
    providerTooltipBaseUrl("openai-codex", "https://ignored.example.com"),
    ""
  );
}

function assertSavedModelLifecycle(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const primary = createApiProviderConfig("deepseek", "primary");
  const fallback = createApiProviderConfig("ollama", "fallback");
  settings.apiProviders = [primary, fallback];

  activateApiProvider(settings, primary);
  assert.equal(settings.activeApiProviderId, primary.id);
  const primaryModelId = primary.defaultModelId;
  const alternate = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(alternate);
  assert.equal(applyApiProviderModelPreset(primary, alternate), true);
  assert.deepEqual(
    primary.models.map((model) => model.id),
    [primaryModelId, alternate]
  );
  assert.equal(primary.defaultModelId, alternate);
  assert.equal(removeApiProvider(settings, primary.id), true);
  assert.equal(settings.activeApiProviderId, fallback.id);
  assert.equal(removeApiProvider(settings, fallback.id), true);
  assert.equal(settings.activeApiProviderId, "");
}

async function assertSavedBindingPreflightLifecycle(): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "saved-provider");
  provider.apiKey = "saved-provider-api-key";
  const model = primaryProviderModel(provider);
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: provider.id,
    providerId: "deepseek",
    runtimeProviderId: provider.runtimeProviderId,
    apiProtocol: provider.apiProtocol,
    authMode: provider.authMode,
    baseUrl: provider.baseUrl,
    modelId: model.id,
    apiKey: "",
    toolCalling: model.toolCalling,
    imageInput: model.input.includes("image"),
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    modelMaxTokens: model.modelMaxTokens,
    maxOutputTokens: model.maxOutputTokens
  };
  assert.equal(providerPreflightApiKeyReady({
    providerId: "deepseek",
    apiKey: "",
    storedApiKey: provider.apiKey
  }), true);

  let resolveRequested!: (result: PiProviderModelListResult) => void;
  const requestedResult = new Promise<PiProviderModelListResult>((resolve) => {
    resolveRequested = resolve;
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
      if (modelListAttempt === 1) return await requestedResult;
      return {
        status: modelListAttempt === 2
          ? "temporary_failure" as const
          : "api_key_error" as const,
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

  const requested = preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "loading");
  assert.equal(modelListAttempt, 1);
  resolveRequested({
    status: "available",
    models: [model.id]
  });
  await requested;
  assert.equal(preflight.state.status, "available");
  assert.deepEqual(preflight.state.models, [model.id]);

  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "temporary_failure");
  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "api_key_error");
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
    "model_list:api_key_error",
    "connection:loading",
    "connection:unsupported",
    "connection:loading",
    "connection:available"
  ]);
}

async function assertProviderPickerGroupingAndFiltering(): Promise<void> {
  installProviderModalDomFixture();
  const modalRegistryBaseline = openTestModals.length;
  const provider = createApiProviderConfig("deepseek", "provider-grouping-modal");
  const preflight = {
    listModels: async () => ({
      status: "available" as const,
      models: provider.models
    }),
    testConnection: async () => ({ status: "available" as const })
  };
  const createModal = (language: "zh-CN" | "en") => new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language,
    copy: settingsCopy(language),
    preflight,
    save: async () => ({ saved: true })
  });

  const modal = createModal("zh-CN");
  modal.open();
  const picker = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox"
  );
  const options = picker?.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-options"
  );
  const trigger = picker?.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-trigger"
  );
  const search = picker?.querySelector<ProviderModalTestElement>(
    'input[aria-label="搜索 Provider"]'
  );
  assert.ok(picker && options && trigger && search);
  assert.equal(openTestModals.length, modalRegistryBaseline + 1);
  assert.deepEqual(
    options.children.map((child) => child.hasClass("codex-provider-combobox-group")
      ? `group:${child.textContent}`
      : `option:${child.getAttribute("data-provider-id")}`),
    [
      "group:登录账户",
      "option:openai-codex",
      "group:供应商",
      "option:glm",
      "option:kimi",
      "option:minimax",
      "option:deepseek",
      "option:ollama",
      "group:其他",
      "option:custom"
    ]
  );
  const optionIds = options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-combobox-option"
  ).map((option) => option.getAttribute("data-provider-id"));
  const visibleOptionIds = () => options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-combobox-option"
  )
    .filter((option) => !option.hasClass("is-hidden"))
    .map((option) => option.getAttribute("data-provider-id"));
  assert.deepEqual(optionIds, [
    "openai-codex",
    "glm",
    "kimi",
    "minimax",
    "deepseek",
    "ollama",
    "custom"
  ]);
  assert.equal(optionIds.includes("grok"), false);
  assert.doesNotMatch(options.textContent, /Grok/iu);
  const oauthPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === "openai-codex");
  assert.equal(oauthPreset?.authMode, "oauth");
  assert.ok(oauthPreset?.baseUrl,
    "OAuth grouping has priority even when the preset defines a baseUrl");

  const selected = options.querySelector<ProviderModalTestElement>(
    '[data-provider-id="deepseek"]'
  );
  const ollama = options.querySelector<ProviderModalTestElement>(
    '[data-provider-id="ollama"]'
  );
  assert.ok(selected && ollama);
  assert.equal(selected.hasClass("is-selected"), true);
  assert.equal(selected.getAttribute("aria-selected"), "true");
  trigger.fireEvent("keydown", { key: "ArrowDown" });
  assert.equal(picker.hasClass("is-open"), true);
  assert.equal(providerModalTestDocument.activeElement, selected,
    "opening by keyboard focuses the selected Provider across groups");
  options.fireEvent("keydown", { key: "ArrowDown", target: selected });
  assert.equal(providerModalTestDocument.activeElement, ollama,
    "keyboard navigation skips headings and follows visible Provider order");

  const headings = options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-combobox-group"
  );
  assert.deepEqual(headings.map((heading) => heading.textContent), [
    "登录账户",
    "供应商",
    "其他"
  ]);
  search.value = "codex";
  search.fireEvent("input");
  assert.deepEqual(headings.map((heading) => heading.hasClass("is-hidden")), [
    false,
    true,
    true
  ]);
  assert.deepEqual(visibleOptionIds(), ["openai-codex"]);
  search.fireEvent("keydown", { key: "ArrowDown" });
  assert.equal(
    providerModalTestDocument.activeElement?.getAttribute("data-provider-id"),
    "openai-codex"
  );
  search.value = "deepseek";
  search.fireEvent("input");
  assert.deepEqual(headings.map((heading) => heading.hasClass("is-hidden")), [
    true,
    false,
    true
  ]);
  assert.deepEqual(visibleOptionIds(), ["deepseek"]);
  search.value = "custom";
  search.fireEvent("input");
  assert.deepEqual(headings.map((heading) => heading.hasClass("is-hidden")), [
    true,
    true,
    false
  ]);
  assert.deepEqual(visibleOptionIds(), ["custom"]);
  search.value = "no matching provider";
  search.fireEvent("input");
  assert.deepEqual(headings.map((heading) => heading.hasClass("is-hidden")), [
    true,
    true,
    true
  ]);
  assert.deepEqual(visibleOptionIds(), []);
  search.value = "";
  search.fireEvent("input");
  assert.deepEqual(headings.map((heading) => heading.hasClass("is-hidden")), [
    false,
    false,
    false
  ]);
  assert.deepEqual(visibleOptionIds(), optionIds);
  assert.equal(selected.getAttribute("aria-selected"), "true",
    "filtering never changes the selected Provider");

  options.fireEvent("keydown", {
    key: "Escape",
    target: providerModalTestDocument.activeElement
  });
  assert.equal(picker.hasClass("is-open"), false);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(providerModalTestDocument.activeElement, trigger);
  modal.close();
  assert.equal(openTestModals.length, modalRegistryBaseline,
    "closing the grouped Provider Modal must release the fake Modal registry");
  providerModalTestDocument.activeElement = null;
  await flushProviderModalTasks();

  const englishModal = createModal("en");
  englishModal.open();
  assert.equal(openTestModals.length, modalRegistryBaseline + 1);
  assert.deepEqual(
    englishModal.contentEl.querySelectorAll<ProviderModalTestElement>(
      ".codex-provider-combobox-group"
    ).map((heading) => heading.textContent),
    ["Account sign-in", "Providers", "Other"]
  );
  englishModal.close();
  await flushProviderModalTasks();
  assert.equal(openTestModals.length, modalRegistryBaseline,
    "the English Provider Modal must also release the fake Modal registry");
}

async function assertOpenAICodexModalLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig(
    "openai-codex",
    "codex-oauth-modal"
  );
  const openedUrls: string[] = [];
  let modelListCalls = 0;
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: false,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => {
        modelListCalls += 1;
        return {
          status: "available",
          models: provider.models.map((model) => model.id)
        };
      },
      testConnection: async () => ({
        status: "failed",
        failure: "auth"
      })
    },
    codexOAuth: {
      status: async () => ({ state: "disconnected" }),
      openExternal: async (url) => {
        openedUrls.push(url);
        return true;
      },
      login: async (interaction) => {
        const method = await interaction.prompt({
          type: "select",
          message: "fixture",
          options: [{ id: "browser", label: "Browser" }]
        });
        assert.equal(method, "browser");
        interaction.notify({
          type: "auth_url",
          url: "https://auth.openai.com/fixture"
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "fixture"
        });
        assert.equal(code, "fixture-authorization-code");
        return { state: "connected" };
      },
      logout: async () => undefined
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  await flushProviderModalTasks();
  assert.equal(modelListCalls, 0);
  assert.match(modal.contentEl.textContent, /Beta/u);
  assert.match(modal.contentEl.textContent, /OpenAI browser authorization/u);
  assert.doesNotMatch(modal.contentEl.textContent, /API Key/u);
  assert.equal(
    modal.titleEl.querySelector(".codex-provider-protocol-pill"),
    null
  );
  assert.match(modal.contentEl.textContent, /GPT-5\.6 Sol/u);

  const login = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Sign in with OpenAI");
  assert.ok(login);
  login.click();
  await flushProviderModalTasks();
  assert.deepEqual(openedUrls, ["https://auth.openai.com/fixture"]);
  const manual = modal.contentEl.querySelector<HTMLInputElement>(
    '[data-modal-focus-key="codex-oauth-manual"]'
  );
  assert.ok(manual);
  manual.value = "fixture-authorization-code";
  manual.oninput?.(new Event("input"));
  const finish = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Complete authorization");
  assert.ok(finish);
  assert.equal(finish.disabled, false);
  finish.click();
  await flushProviderModalTasks();
  assert.equal(modelListCalls, 0, "OAuth completion must not request models");
  assert.match(modal.contentEl.textContent, /OpenAI Codex is connected/u);
  assert.ok(Array.from(modal.contentEl.querySelectorAll("button"))
    .some((button) => button.textContent === "Log out"));
  const testConnection = Array.from(
    modal.contentEl.querySelectorAll("button")
  ).find((button) => button.textContent === "Test connection");
  assert.ok(testConnection);
  testConnection.click();
  await flushProviderModalTasks();
  assert.match(
    modal.contentEl.textContent,
    /OpenAI Codex authorization expired\. Sign in again\./u
  );
  modal.close();
}

async function assertProviderModelModalPreflightLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const copy = settingsCopy("en");
  const provider = createApiProviderConfig("deepseek", "saved-modal-provider");
  provider.apiKey = "saved-modal-provider-api-key";
  const discovery = deferred<PiProviderModelListResult>();
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
      return await discovery.promise;
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
  assert.equal(calls.length, 0, "opening the modal must not request models");
  assertProviderModalStatus(modal, "idle");
  const apiKey = providerModalElementByFocusKey(modal, "apiKey");
  assert.ok(apiKey);
  apiKey.value = "replacement-api-key";
  apiKey.oninput?.(new Event("input"));
  assert.equal(calls.length, 0, "editing an API key must not request models");
  const discover = providerModalElementByFocusKey(modal, "model-discover");
  assert.ok(discover);
  discover.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "listModels");
  assert.equal(calls[0]?.draft.providerSettingsId, provider.id);
  assert.equal(calls[0]?.draft.apiKey, "replacement-api-key");
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);

  const nextModel = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(nextModel);
  discovery.resolve({
    status: "available",
    models: [primaryProviderModel(provider).id, nextModel]
  });
  await flushProviderModalTasks();
  assert.deepEqual(
    provider.models.map((model) => model.id),
    [primaryProviderModel(provider).id],
    "refresh results must not silently change enabled models"
  );
  const firstTest = providerModalElementByFocusKey(
    modal,
    "provider-test-connection"
  );
  assert.ok(firstTest);
  firstTest.click();
  assert.equal(calls[1]?.operation, "testConnection");
  assert.equal(calls[1]?.draft.modelId, primaryProviderModel(provider).id);
  assert.equal(calls[1]?.draft.apiKey, "replacement-api-key");
  assertProviderModalStatus(modal, "loading", copy.providers.testingConnection);

  const nextEnabled = providerModalElementByFocusKey(
    modal,
    `model-enabled:${nextModel}`
  );
  assert.ok(nextEnabled);
  nextEnabled.checked = true;
  nextEnabled.onchange?.(new Event("change"));
  const nextDefault = providerModalElementByFocusKey(
    modal,
    `model-default:${nextModel}`
  );
  assert.ok(nextDefault);
  nextDefault.checked = true;
  nextDefault.onchange?.(new Event("change"));
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
  assert.equal(calls[2]?.draft.apiKey, "replacement-api-key");

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
  assert.equal(attempt, 0);
  providerModalElementByFocusKey(modal, "model-discover")?.click();
  assert.equal(attempt, 1);
  modal.close();
  first.resolve({ status: "available", models: [closedRequestModel] });
  await flushProviderModalTasks();

  modal.open();
  assert.equal(attempt, 1);
  assertProviderModalStatus(modal, "idle");
  providerModalElementByFocusKey(modal, "model-discover")?.click();
  assert.equal(attempt, 2);
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);
  assert.equal(
    Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .some((button) => button.title === closedRequestModel),
    false
  );
  reopened.resolve({
    status: "available",
    models: [primaryProviderModel(provider).id]
  });
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
      explicit: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      observed: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
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
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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

async function assertCustomWelcomeSettingsUi(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin, refreshCalls } = createIdentityTestPlugin(fixtureState);
  let saveCalls = 0;
  plugin.saveSettings = async () => { saveCalls += 1; };
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);

  tab.display();
  const customToggleRow = Array.from(
    tab.containerEl.querySelectorAll<ProviderModalTestElement>(".setting-item")
  ).find((row) => row.querySelector(".setting-item-name")?.textContent === "自定义加载欢迎语");
  assert.ok(customToggleRow, "custom welcome toggle renders");
  assert.equal(
    customToggleRow!.querySelector<ProviderModalTestElement>('input[type="checkbox"]')?.checked,
    false,
    "custom welcome is disabled by default"
  );
  assert.equal(tab.containerEl.querySelector('input[aria-label="欢迎标题"]'), null);
  assert.equal(tab.containerEl.querySelector('input[aria-label="问候语"]'), null);

  plugin.settings.customWelcomeEnabled = true;
  tab.display();
  const title = tab.containerEl.querySelector<ProviderModalTestElement>(
    'input[aria-label="欢迎标题"]'
  );
  const subtitle = tab.containerEl.querySelector<ProviderModalTestElement>(
    'input[aria-label="问候语"]'
  );
  assert.ok(title && subtitle, "enabling custom welcome exposes exactly two editable lines");
  assert.equal(title!.value, "What's new?");
  assert.match(subtitle!.value, /当前 Conversation/u);

  title!.value = "今天想聊什么？";
  title!.onchange?.();
  subtitle!.value = "从一个问题开始，我来陪你想清楚。";
  subtitle!.onchange?.();
  await settleMicrotasks();
  assert.equal(plugin.settings.customWelcomeTitle, "今天想聊什么？");
  assert.equal(plugin.settings.customWelcomeSubtitle, "从一个问题开始，我来陪你想清楚。");
  assert.equal(saveCalls, 2);
  assert.equal(refreshCalls(), 2, "both fields refresh the empty conversation UI");
  console.log("PASS settings: custom welcome exposes two editable lines only when enabled");
}

function assertCustomWelcomeContract(): void {
  assert.equal(DEFAULT_SETTINGS.customWelcomeEnabled, false);
  assert.deepEqual(resolveEchoInkWelcomeCopy(DEFAULT_SETTINGS), {
    title: "What's new?",
    subtitle: "当前 Conversation 需要先选择工作区；添加笔记只作为本轮上下文。"
  });

  const customized = structuredClone(DEFAULT_SETTINGS);
  customized.customWelcomeEnabled = true;
  customized.customWelcomeTitle = "  今天想聊什么？  ";
  customized.customWelcomeSubtitle = "  从一个问题开始。  ";
  assert.deepEqual(resolveEchoInkWelcomeCopy(customized), {
    title: "今天想聊什么？",
    subtitle: "从一个问题开始。"
  });
  customized.customWelcomeTitle = "   ";
  customized.customWelcomeSubtitle = "";
  assert.deepEqual(
    resolveEchoInkWelcomeCopy(customized),
    resolveEchoInkWelcomeCopy(DEFAULT_SETTINGS),
    "blank custom lines fall back to the shipped welcome copy"
  );

  const legacy = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  delete legacy.customWelcomeEnabled;
  delete legacy.customWelcomeTitle;
  delete legacy.customWelcomeSubtitle;
  legacy.showWelcome = false;
  const normalized = normalizeSettingsData(legacy).settings;
  assert.equal(normalized.customWelcomeEnabled, false);
  assert.equal(Object.hasOwn(normalized, "showWelcome"), false);

  const controllerSource = readFileSync("src/ui/codex-view/message-controller.ts", "utf8");
  assert.match(controllerSource, /resolveEchoInkWelcomeCopy/u);
  assert.doesNotMatch(controllerSource, /settings\.showWelcome/u);
  const listSource = readFileSync("src/ui/codex-view/message-list.ts", "utf8");
  assert.match(listSource, /welcomeCopy\.title/u);
  assert.match(listSource, /welcomeCopy\.subtitle/u);
  assert.doesNotMatch(listSource, /shouldRenderEchoInkWelcome/u);
  console.log("PASS settings: default welcome always renders and custom copy has safe fallbacks");
}

function assertAboutGitHubActionsContract(): void {
  installProviderModalDomFixture();
  const { plugin } = createIdentityTestPlugin(createIdentityFixtureState());
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = createIdentityFixtureState();
  tab.display();

  const about = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-about-card"
  );
  assert.ok(about, "about card renders");
  assert.doesNotMatch(about!.textContent, /查看源码|Source Code/u);

  const actions = about!.querySelectorAll<ProviderModalTestElement>(
    ".echoink-about-btn"
  );
  assert.equal(actions.length, 2, "about card keeps only Star and issue actions");
  const star = actions.find((action) => action.textContent.includes("Star on GitHub"));
  const issue = actions.find((action) => /反馈问题|Report Issue/u.test(action.textContent));
  assert.ok(star && issue, "Star and issue actions both render");
  assert.equal(star!.getAttribute("href"), "https://github.com/AKin-lvyifang/codex-echoink");
  assert.equal(issue!.getAttribute("href"), "https://github.com/AKin-lvyifang/codex-echoink/issues");
  assert.ok(star!.hasClass("echoink-about-btn-surface"), "Star uses the shared surface style");
  assert.ok(issue!.hasClass("echoink-about-btn-surface"), "issue action matches Star's surface style");
  assert.ok(issue!.hasClass("echoink-about-btn-issue"), "issue action uses the btn-24 interaction");
  assert.ok(issue!.querySelector(".echoink-about-morph-icon-default"), "send icon renders");
  assert.ok(issue!.querySelector(".echoink-about-morph-icon-hover"), "check icon renders");

  const css = readFileSync("styles.css", "utf8");
  assert.match(
    css,
    /\.echoink-about-btn-issue:hover \.echoink-about-morph-icon-default\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?scale\(0\.25\)/u,
    "btn-24 hover morph hides and shrinks the send icon"
  );
  assert.match(
    css,
    /\.echoink-about-btn-issue:hover \.echoink-about-morph-icon-hover\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?scale\(1\)/u,
    "btn-24 hover morph reveals the check icon"
  );
  const aboutButtonRule = css.match(/\.echoink-about-btn\s*\{([^}]*)\}/u)?.[1] ?? "";
  const issueButtonRule = css.match(/\.echoink-about-btn-issue\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.match(aboutButtonRule, /min-height:\s*28px;/u);
  assert.match(aboutButtonRule, /border-radius:\s*7px;/u);
  assert.match(issueButtonRule, /padding-inline:\s*10px;/u);
  assert.doesNotMatch(
    css,
    /\.echoink-about-btn-issue:hover,[\s\S]*?padding-inline:\s*28px/u,
    "About actions must not grow into oversized pills on hover"
  );
  console.log("PASS settings: about actions remove source and morph issue feedback");
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

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
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
      explicit: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      observed: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
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

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const templateBtn = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-reselect"
  );
  assert.ok(templateBtn, "template button must exist when no template is chosen");
  assert.equal(templateBtn.tagName, "BUTTON");
  assert.equal(templateBtn.type, "button");
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
    avatar: { kind: "preset", presetId: DEFAULT_AGENT_AVATAR_PRESET_ID }
  });
  console.log("PASS settings: first naming modal keeps zero writes on cancel");
}

/** 未选择人格模板（冷启动）时的身份卡片固定装置。 */
function createNoTemplateIdentityFixtureState(): Record<string, any> {
  return createIdentityFixtureState({
    agentIdentity: null,
    personalityState: {
      schema: "echoink.personality.v1",
      revision: 0,
      templateId: null,
      explicit: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      observed: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      history: [], candidates: [], learnedRequirements: [], processedSources: [],
      updatedAt: 0
    }
  });
}

async function assertIdentityEntryWithoutTemplateOpensPicker(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createNoTemplateIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  assert.ok(editButton, "identity button must exist when no template is chosen");
  assert.equal(editButton.disabled, false, "identity button must NOT be disabled without a template");
  assert.match(editButton.textContent, /选择风格并设置身份/u, "button copy guides into the main chain");

  // Card copy must tell the user to pick a starting style first (not a dead end).
  const identityCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-card"
  );
  assert.ok(identityCard);
  assert.match(identityCard.textContent, /先选择一个初始风格/u, "card copy explains the next step");

  // Clicking opens the template picker with all eight rows.
  editButton.click();
  const picker = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-template-picker.is-visible"
  );
  assert.ok(picker, "clicking the identity entry opens the template picker");
  const rows = tab.containerEl.querySelectorAll<ProviderModalTestElement>(".echoink-picker-row");
  assert.equal(rows.length, PERSONALITY_TEMPLATES.length, "all eight template rows render");
  console.log("PASS settings: identity entry without template opens the picker");
}

async function assertIdentityEntryFirstRunKeepsSingleTransaction(): Promise<void> {
  installProviderModalDomFixture();
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
      explicit: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      observed: { sharpness: null, dominance: null, rigor: null, structure: null, boldness: null, creativity: null },
      history: [], candidates: [], learnedRequirements: [], processedSources: [],
      updatedAt: 0
    }
  });
  const { plugin } = createIdentityTestPlugin(fixtureState);
  let templateCalls = 0;
  let updateCalls = 0;
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
    },
    updateAgentIdentity: async () => { updateCalls += 1; }
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  // Enter the first-run flow through the identity entry (not the profile footer).
  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  assert.ok(editButton);
  editButton.click();
  const row = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-picker-row");
  assert.ok(row, "picker rows render from the identity entry");
  row.click();
  await settleMicrotasks();

  // First-time: naming modal opened, nothing written yet.
  assert.equal(templateCalls, 0, "selecting a template must not write before naming");
  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  assert.ok(nameInput, "first-run naming modal opens from the identity entry");

  // Cancel = zero writes.
  const cancel = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-cancel");
  assert.ok(cancel);
  cancel.click();
  await settleMicrotasks();
  assert.equal(templateCalls, 0, "cancel keeps zero writes");
  assert.equal(updateCalls, 0, "cancel must not call updateAgentIdentity");

  // Complete the main chain: exactly one transaction carrying initialIdentity,
  // and NO second write through updateAgentIdentity.
  const rowAgain = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-picker-row");
  assert.ok(rowAgain, "picker stays open after cancelling the naming modal");
  rowAgain!.click();
  await settleMicrotasks();
  const nameInput2 = findLatestModalElement<ProviderModalTestElement>("name-input");
  assert.ok(nameInput2);
  (nameInput2 as unknown as { value: string }).value = "小墨";
  nameInput2!.fireEvent("input");
  const confirm2 = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-confirm");
  assert.ok(confirm2);
  assert.equal((confirm2 as unknown as { disabled: boolean }).disabled, false);
  confirm2!.click();
  await settleMicrotasks();

  assert.equal(templateCalls, 1, "完成设置 commits template + identity exactly once");
  assert.deepEqual(lastInitialIdentity, {
    displayName: "小墨",
    avatar: { kind: "preset", presetId: DEFAULT_AGENT_AVATAR_PRESET_ID }
  });
  assert.equal(updateCalls, 0, "first-run must not double-write via updateAgentIdentity");
  console.log("PASS settings: identity-entry first-run keeps a single transaction");
}

async function assertIdentityEntryWithTemplateOpensEditModal(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin, refreshCalls } = createIdentityTestPlugin(fixtureState);
  let updated: { displayName: string; avatar: { kind: string } } | null = null;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => fixtureState.personalityState,
    renderPersonalitySummary: async () => "summary",
    updateAgentIdentity: async (draft: { displayName: string; avatar: { kind: string } }) => {
      updated = draft;
      return { revision: 4, identity: { ...fixtureState.agentIdentity, ...draft }, agent: "# Agent" };
    }
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  assert.ok(editButton);
  assert.equal(editButton.disabled, false, "edit identity stays clickable with a template");
  assert.match(editButton.textContent, /编辑身份/u, "button copy is 编辑身份 once a template exists");

  editButton.click();
  // Edit-mode modal opens prefilled; the template picker must NOT open.
  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  assert.ok(nameInput, "edit identity modal opens");
  assert.equal((nameInput as unknown as { value: string }).value, "小墨");
  assert.equal(
    tab.containerEl.querySelector(".echoink-template-picker.is-visible"),
    null,
    "editing identity must not open the template picker"
  );

  (nameInput as unknown as { value: string }).value = "阿澈";
  nameInput.fireEvent("input");
  const confirm = findLatestModalElement<ProviderModalTestElement>(".echoink-agent-identity-confirm");
  assert.ok(confirm);
  confirm.click();
  await settleMicrotasks();

  assert.ok(updated, "updateAgentIdentity must be called on save");
  assert.equal(updated!.displayName, "阿澈");
  assert.equal(refreshCalls() >= 1, true, "save refreshes settings + message headers");
  console.log("PASS settings: identity entry with template opens the edit modal only");
}

async function assertTemplatePickerCardGridStructure(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createNoTemplateIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  let templateCalls = 0;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => fixtureState.personalityState,
    readAgentIdentity: async () => ({
      schema: "echoink.agent-identity.v1",
      revision: 0,
      displayName: "EchoInk",
      avatar: { kind: "default" },
      updatedAt: 0
    }),
    renderPersonalitySummary: async () => "summary",
    selectPersonalityTemplate: async () => {
      templateCalls += 1;
      throw new Error("structure test must not write");
    }
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  editButton!.click();
  const picker = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-template-picker.is-visible"
  );
  assert.ok(picker, "picker opens");

  const introTitle = picker.querySelector(".echoink-picker-intro-title");
  const introCopy = picker.querySelector(".echoink-picker-intro-copy");
  assert.match(introTitle?.textContent ?? "", /选择 Agent 的初始风格/u);
  assert.match(introCopy?.textContent ?? "", /起点/u);
  assert.equal(
    picker.querySelector(".echoink-picker-columns-header"),
    null,
    "the card grid must not retain the table header"
  );
  assert.ok(picker.querySelector(".echoink-picker-list"), "picker renders one card grid");

  // Each template is one whole-card button carrying a left-aligned hierarchy and
  // a stable action affordance.
  const rows = tab.containerEl.querySelectorAll<ProviderModalTestElement>(".echoink-picker-row");
  assert.equal(rows.length, PERSONALITY_TEMPLATES.length, "eight template rows");
  PERSONALITY_TEMPLATES.forEach((template, index) => {
    const row = rows[index];
    assert.equal(row.tagName, "BUTTON", `card ${template.id} is a single clickable button`);
    assert.equal(row.querySelectorAll("button").length, 0, `row ${template.id} has no nested buttons`);
    const name = row.querySelector(".echoink-picker-row-name");
    const desc = row.querySelector(".echoink-picker-row-desc");
    const indicator = row.querySelector(".echoink-picker-row-indicator");
    assert.ok(name && desc, `row ${template.id} carries name and description nodes`);
    assert.ok(indicator, `row ${template.id} keeps a visible selection affordance`);
    assert.equal(name!.textContent, template.labelZh, `row order follows PERSONALITY_TEMPLATES (${template.id})`);
    assert.equal(desc!.textContent, template.richDescZh, `description for ${template.id} comes from the template constant`);
    assert.equal(row.getAttribute("aria-current"), null, "first selection has no current template badge");
  });

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.echoink-picker-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(css, /button\.echoink-picker-row\s*\{[\s\S]*?text-align:\s*start/u);
  assert.match(
    css,
    /button\.echoink-picker-row\s*\{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*none;/u,
    "Obsidian's fixed button height must not clip the card description"
  );
  assert.match(css, /@container\s*\(max-width:\s*520px\)[\s\S]*?\.echoink-picker-list\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/u);

  // Cancel closes the list with zero writes.
  const cancelBtn = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-picker-cancel-btn");
  assert.ok(cancelBtn, "cancel button renders");
  cancelBtn!.click();
  const closedPicker = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-template-picker");
  assert.ok(closedPicker && !closedPicker.hasClass("is-visible"), "cancel closes the picker");
  assert.equal(tab.containerEl.querySelectorAll(".echoink-picker-row").length, 0, "rows removed on cancel");
  assert.equal(templateCalls, 0, "cancel keeps zero writes");
  console.log("PASS settings: template picker renders as a responsive card grid");
}

async function assertPersonalityResetStillRequiresConfirm(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  let templateCalls = 0;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => fixtureState.personalityState,
    renderPersonalitySummary: async () => "summary",
    selectPersonalityTemplate: async () => {
      templateCalls += 1;
      throw new Error("reset test must not write");
    }
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();
  await settleMicrotasks();

  const reselect = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-reselect"
  );
  assert.ok(reselect, "reset entry exists when a template is set");
  assert.equal(reselect.dataset.hasTemplate, "true", "personality load marks the template present");

  // Clicking must open the confirmation modal, NOT the picker directly.
  reselect!.click();
  await settleMicrotasks();
  assert.equal(
    tab.containerEl.querySelector(".echoink-template-picker.is-visible"),
    null,
    "reset must stay gated behind the confirmation modal"
  );
  const confirmDialog = openTestModals[openTestModals.length - 1];
  assert.ok(confirmDialog, "confirmation modal opens for personality reset");
  const resetBody = (confirmDialog.contentEl as unknown as ProviderModalTestElement)
    .querySelector<ProviderModalTestElement>(".echoink-confirm-modal-preformatted");
  assert.ok(resetBody, "reset consequences use a scan-friendly preformatted body");
  assert.match(resetBody!.textContent, /选择新模板后：/u);
  assert.match(resetBody!.textContent, /• 当前自动演化的人格会被替换。/u);
  assert.match(resetBody!.textContent, /• 长期 Memory 不会删除。/u);
  assert.match(resetBody!.textContent, /「复盘」/u);
  assert.doesNotMatch(resetBody!.textContent, /重置会把 Agent 当前人格恢复到你重新选择的模板/u);
  const dialogButtons = (confirmDialog.contentEl as unknown as ProviderModalTestElement)
    .querySelectorAll<ProviderModalTestElement>("button");
  const decline = dialogButtons.find((button) => button.textContent === "取消");
  assert.ok(
    dialogButtons.some((button) => button.textContent === "选择新模板"),
    "the primary action says what happens next"
  );
  assert.ok(decline, "confirm dialog offers cancel");
  decline!.click();
  await settleMicrotasks();
  assert.equal(
    tab.containerEl.querySelector(".echoink-template-picker.is-visible"),
    null,
    "declining keeps the picker closed"
  );
  assert.equal(templateCalls, 0, "declining writes nothing");

  // Accepting opens the template list (still no write until a row is chosen).
  reselect!.click();
  await settleMicrotasks();
  const confirmDialog2 = openTestModals[openTestModals.length - 1];
  const accept = (confirmDialog2.contentEl as unknown as ProviderModalTestElement)
    .querySelectorAll<ProviderModalTestElement>("button")
    .find((button) => button.hasClass("mod-cta"));
  assert.ok(accept, "confirm dialog offers an accept action");
  accept!.click();
  await settleMicrotasks();
  assert.ok(
    tab.containerEl.querySelector(".echoink-template-picker.is-visible"),
    "accepting opens the template list"
  );
  const currentCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    '.echoink-picker-row[data-template-id="executor"]'
  );
  assert.ok(currentCard, "the current template card remains present during reset");
  assert.equal(currentCard!.getAttribute("aria-current"), "true");
  assert.match(
    currentCard!.querySelector(".echoink-picker-current-badge")?.textContent ?? "",
    /当前模板/u
  );
  assert.equal(templateCalls, 0, "opening the reset list writes nothing");
  const css = readFileSync("styles.css", "utf8");
  assert.match(
    css,
    /\.echoink-confirm-modal-preformatted\s*\{[\s\S]*?line-height:\s*1\.6/u
  );
  console.log("PASS settings: personality reset still requires the confirmation modal");
}

async function assertIdentityEntryRespectsFailClosedRetry(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createNoTemplateIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  let templateCalls = 0;
  let updateCalls = 0;
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => {
      throw new Error("personality-state-corrupt");
    },
    readAgentIdentity: async () => null,
    renderPersonalitySummary: async () => "summary",
    selectPersonalityTemplate: async () => { templateCalls += 1; },
    updateAgentIdentity: async () => { updateCalls += 1; }
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();
  await settleMicrotasks();

  // The profile card entered fail-closed mode (retry entry, not template picker).
  const reselect = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-reselect"
  );
  assert.ok(reselect);
  assert.equal(reselect.dataset.failClosed, "true", "profile card enters fail-closed on read failure");

  // Identity entry stays clickable but must route into the retry gate,
  // never into identity creation under an unknown personality state.
  const editButton = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-edit"
  );
  assert.ok(editButton, "identity entry exists in fail-closed mode");
  assert.equal(editButton.disabled, false, "identity entry stays clickable in fail-closed mode");
  editButton!.click();
  await settleMicrotasks();

  assert.equal(
    tab.containerEl.querySelector(".echoink-template-picker.is-visible"),
    null,
    "fail-closed: identity entry must not open the picker"
  );
  assert.equal(
    findLatestModalElement<ProviderModalTestElement>("name-input"),
    null,
    "fail-closed: identity entry must not open an identity modal"
  );
  assert.equal(templateCalls, 0, "fail-closed: no template write");
  assert.equal(updateCalls, 0, "fail-closed: no identity write");
  console.log("PASS settings: identity entry respects the fail-closed retry gate");
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
  assert.deepEqual(
    AGENT_AVATAR_PRESETS.map((preset) => preset.labelEn),
    ["Nova", "Rio", "Lin", "Sol", "Mica", "Aya", "Bo", "Cleo", "Dev", "Emi", "Finn", "Gia", "Han", "Ivo", "June"],
    "the shipped catalog keeps the approved fixed order"
  );
  assert.equal(AGENT_AVATAR_PRESETS.length, 15);
  assert.ok(AGENT_AVATAR_PRESETS.every((preset) => preset.assetPath.startsWith("data:image/svg+xml")));

  const modal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    onConfirm: async () => undefined
  });
  modal.open();
  assert.match(modal.contentEl.textContent, /给你的 Agent 选一个形象/u);
  assert.ok(modal.contentEl.querySelector(".echoink-agent-identity-upload"));
  assert.equal(modal.contentEl.querySelector(".echoink-agent-identity-modal-preview"), null);
  assert.equal(modal.contentEl.querySelector(".echoink-agent-identity-remove"), null);
  assert.equal(modal.contentEl.querySelectorAll("fieldset").length, 1);
  const options = modal.contentEl.querySelectorAll<ProviderModalTestElement>(".echoink-agent-avatar-option");
  const radios = modal.contentEl.querySelectorAll<ProviderModalTestElement>('input[type="radio"]');
  assert.equal(options.length, 15, "wide picker exposes all 15 preset tiles");
  assert.equal(radios.length, 15, "each tile uses a real radio control");
  assert.equal(radios[0].getAttribute("name"), radios[14].getAttribute("name"));
  assert.equal(radios[0].checked, true, "default identity selects Nova in the draft");
  assert.equal(options[0].hasClass("is-selected"), true);
  assert.ok(options[0].querySelector(".echoink-agent-avatar-option-check"));
  radios[1].focus();
  radios[1].checked = true;
  radios[1].fireEvent("change");
  assert.equal(providerModalTestDocument.activeElement, radios[1], "radio selection preserves keyboard focus");
  assert.deepEqual(modal.currentDraft().avatar, { kind: "preset", presetId: "rio" });
  assert.equal(options[1].hasClass("is-selected"), true);
  assert.equal(options[0].hasClass("is-selected"), false);

  const customDataUrl = "data:image/webp;base64,UkVE";
  const customModal = new AgentIdentityModal(new App(), {
    initialName: "阿澈",
    initialAvatar: {
      kind: "custom",
      mimeType: "image/webp",
      dataUrl: customDataUrl,
      width: 256,
      height: 256
    },
    language: "zh",
    mode: "edit",
    onConfirm: async () => undefined
  });
  customModal.open();
  assert.equal(customModal.contentEl.querySelectorAll(".echoink-agent-avatar-option").length, 16);
  const customTile = customModal.contentEl.querySelector<ProviderModalTestElement>(
    '[data-avatar-value="custom"]'
  );
  assert.ok(customTile?.hasClass("is-selected"), "existing custom avatar is the selected unique custom tile");

  const uploadModal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    avatarRenderer: async () => ({ sourceWidth: 256, sourceHeight: 256, dataUrl: customDataUrl }),
    onConfirm: async () => undefined
  });
  uploadModal.open();
  const fileInput = uploadModal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-file"
  )!;
  (fileInput as unknown as { files: Blob[] }).files = [
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="100"/></svg>'], { type: "image/svg+xml" })
  ];
  fileInput.fireEvent("change");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (uploadModal.contentEl.querySelector('[data-avatar-value="custom"]')) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const uploaded = uploadModal.contentEl.querySelector<ProviderModalTestElement>(
    '[data-avatar-value="custom"]'
  );
  assert.ok(
    uploaded?.hasClass("is-selected"),
    `successful upload creates, replaces, and selects one custom tile; error=${uploadModal.contentEl.querySelector(".echoink-agent-avatar-error")?.textContent ?? ""}; draft=${JSON.stringify(uploadModal.currentDraft())}`
  );

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.echoink-agent-avatar-grid\s*\{[\s\S]*?repeat\(5,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(css, /@container\s*\(max-width:\s*520px\)[\s\S]*?repeat\(3,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(css, /@container\s*\(max-width:\s*340px\)[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(css, /\.echoink-agent-avatar-option:focus-within\s*\{[\s\S]*?outline:\s*2px solid/u);
  assert.match(css, /\.echoink-agent-avatar-option\.is-selected \.echoink-agent-avatar-option-check\s*\{[\s\S]*?display:\s*inline-flex/u);

  assert.equal(resolveAgentAvatarPresetAsset("missing"), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "default" }), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "preset", presetId: "missing" }), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "preset", presetId: "nova" }), AGENT_AVATAR_PRESETS[0].assetPath);
  console.log("PASS settings: fixed avatar grid, Nova default, custom tile, and accessible radio semantics");
}

async function assertAvatarProcessorContract(): Promise<void> {
  const smallWebp = "data:image/webp;base64,UkVE";
  const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200"/></svg>';
  const svgBlob = (source = validSvg) => new Blob([source], { type: "image/svg+xml" });
  const fakeRenderer = (result: { sourceWidth: number; sourceHeight: number; dataUrl: string }) =>
    async () => result;

  assert.equal(validateAvatarSourceType("image/svg+xml"), true);
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", ""]) {
    assert.equal(validateAvatarSourceType(type), false, `must reject ${type}`);
  }
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/png", 10, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /unsupported_type/u
  );

  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES), true);
  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES + 1), false);
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", AGENT_AVATAR_SOURCE_MAX_BYTES + 1, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /source_too_large/u
  );

  assert.deepEqual(validateAgentAvatarSvg(validSvg), { width: 512, height: 512 });
  assert.deepEqual(
    validateAgentAvatarSvg('<svg xmlns="http://www.w3.org/2000/svg" width="256px" height="256px"></svg>'),
    { width: 256, height: 256 }
  );
  await assert.rejects(
    processAgentAvatar(svgBlob('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256"></svg>'), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 256, dataUrl: smallWebp })),
    /svg_not_square/u
  );
  await assert.rejects(
    processAgentAvatar(svgBlob('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000"></svg>'), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 5000, sourceHeight: 5000, dataUrl: smallWebp })),
    /image_too_large/u
  );

  for (const unsafeSvg of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect onclick="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use href="#shape"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import url(https://example.com/a.css)</style></svg>'
  ]) {
    assert.throws(() => validateAgentAvatarSvg(unsafeSvg), /svg_unsafe/u);
  }
  assert.throws(() => validateAgentAvatarSvg("<svg><broken>"), /svg_invalid/u);

  const ok = await processAgentAvatar(
    svgBlob(), "image/svg+xml", 100,
    fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: smallWebp })
  );
  assert.equal(ok.kind, "custom");
  assert.equal(ok.mimeType, "image/webp");
  assert.equal(ok.width, 256);
  assert.equal(ok.height, 256);
  assert.equal(ok.dataUrl, smallWebp);

  // JPEG data URL output is invalid (must be re-encoded to webp/png).
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: "data:image/jpeg;base64,QUJD" })),
    /output_invalid/u
  );

  // Oversized output Data URL is rejected before persistence.
  const huge = `data:image/webp;base64,${"A".repeat(AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS)}`;
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: huge })),
    /output_too_large/u
  );

  // Decode failure surfaces decode_failed, never a raw fallback.
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, async () => { throw new Error("boom"); }),
    /decode_failed/u
  );

  // The identity JSON only ever contains the processed (small) Data URL,
  // never the raw source bytes.
  const rawMarker = "RAW_SOURCE_BYTES_MUST_NOT_APPEAR";
  const processed = await processAgentAvatar(
    svgBlob(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4096 4096"><text>${rawMarker}</text></svg>`),
    "image/svg+xml",
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
  console.log("PASS settings: safe square-SVG validation and 256px raster output contract");
}

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


// ---------------------------------------------------------------------------
// R5: settings UI — new six behavioral dimensions (bars, bands, hexagon copy)
// ---------------------------------------------------------------------------

async function assertPersonalityCardUsesNewBehaviorDimensions(): Promise<void> {
  installProviderModalDomFixture();
  const { plugin } = createIdentityTestPlugin(createIdentityFixtureState());
  // executor template: sharpness 0.75 → band 犀利.
  const executorState = applyTemplateToState(emptyPersonalityState(0), {
    templateId: "executor",
    now: 1,
    reset: false
  });
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => executorState,
    renderPersonalitySummary: async () => "summary"
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = createIdentityFixtureState();
  tab.display();
  await settleMicrotasks();

  const card = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-card"
  );
  assert.ok(card, "personality card renders");
  const text = card!.textContent;

  // 1. New dimension labels; 2. no legacy labels anywhere in the card.
  for (const dimension of TRAIT_DIMENSIONS) {
    assert.ok(text.includes(TRAIT_DIMENSION_META[dimension].labelZh),
      `card must show ${dimension} label`);
  }
  for (const legacy of ["节奏", "能量", "思维", "温度", "秩序", "立场"]) {
    assert.ok(!text.includes(legacy), `legacy label ${legacy} must be gone`);
  }

  // 3/5. Value format "75 · 犀利"; no percent signs.
  const sharpRow = card!.querySelectorAll<ProviderModalTestElement>(".echoink-trait-value");
  assert.equal(sharpRow.length, 6, "six trait value labels");
  assert.equal(sharpRow[0].textContent, "75 · 犀利",
    "executor sharpness 0.75 renders as 75 · 犀利");
  for (const valueEl of sharpRow) {
    assert.ok(!valueEl.textContent.includes("%"), "no percent signs");
    assert.match(valueEl.textContent, /^\d+ · /u, "value uses 'N · band' format");
  }
  assert.ok(!text.includes("30%"), "old percent copy must be gone");

  // 4. No two-pole arrows.
  assert.ok(!text.includes("←→") && !text.includes("↔"), "no bidirectional pole arrows");
  assert.ok(!text.includes("偏左") && !text.includes("偏右") && !text.includes("靠右极"));

  // 6. Description line comes from the shared band Meta.
  const descs = card!.querySelectorAll<ProviderModalTestElement>(".echoink-trait-band-desc");
  assert.equal(descs.length, 6);
  const sharpBand = traitBehaviorBand("sharpness", 0.75);
  assert.equal(descs[0].textContent, sharpBand.uiDescriptionZh);

  // 7. Bar order matches TRAIT_DIMENSIONS; hexagon short labels come from the
  //    same Meta in the same order.
  const dimSpans = card!.querySelectorAll<ProviderModalTestElement>(".echoink-trait-dim");
  assert.deepEqual(
    dimSpans.map((span) => span.textContent),
    TRAIT_DIMENSIONS.map((dimension) => TRAIT_DIMENSION_META[dimension].labelZh)
  );
  assert.deepEqual(
    TRAIT_DIMENSIONS.map((dimension) => getDimensionShortLabel(dimension)),
    ["锋利", "主导", "较真", "条理", "果敢", "创意"]
  );

  // 8. Baseline + current layers use the new dimensions (hexagon input keys).
  for (const template of PERSONALITY_TEMPLATES) {
    assert.deepEqual(
      Object.keys((template as PersonalityTemplate).scores).sort(),
      [...TRAIT_DIMENSIONS].sort()
    );
  }

  // 9. Still no direct score editor on the personality card.
  assert.ok(!card!.querySelectorAll("input").some((input) => input.type === "range"),
    "no slider score editor");

  // 10. Round-4 identity card and Agent画像 copy are not regressed.
  const identityCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-card"
  );
  assert.ok(identityCard, "identity card still present");
  assert.match(tab.containerEl.textContent, /Agent 画像/u);
  assert.match(tab.containerEl.textContent, /用户画像/u);

  // Template picker descriptions come from the shared template constants.
  const executorTemplate = PERSONALITY_TEMPLATES.find((template) => template.id === "executor")!;
  assert.equal(executorTemplate.richDescZh, executorTemplate.cardZh,
    "picker and card read the same description constant");
  console.log("PASS settings: personality card uses new behavior dimensions and bands");
}

// Round 6 修复八：人格轮廓说明（caption）不得被异步六边形重渲染删除。
// 连续刷新两次后 caption 仍只有一份、文案不变；SVG 被替换而不是累积。
async function assertHexagonCaptionSurvivesRepeatedAsyncRender(): Promise<void> {
  installProviderModalDomFixture();
  const { plugin } = createIdentityTestPlugin(createIdentityFixtureState());
  const executorState = applyTemplateToState(emptyPersonalityState(0), {
    templateId: "executor",
    now: 1,
    reset: false
  });
  plugin.getCognitiveSystem = async () => ({
    ...createCognitiveSystemStub(),
    readPersonalityState: async () => executorState,
    renderPersonalitySummary: async () => "summary",
    readFixedFiles: async () => ({ agent: "# AGENT" })
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = createIdentityFixtureState();
  tab.display();
  await settleMicrotasks();

  const card = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-card"
  );
  assert.ok(card, "personality card renders");
  const captionText = "人格轮廓表示六种行为特质的强弱组合，不代表 Agent 能力高低。";
  const captions = () =>
    card!.querySelectorAll<ProviderModalTestElement>(".echoink-trait-hexagon-caption");
  const svgs = () =>
    card!.querySelectorAll<ProviderModalTestElement>(".echoink-trait-hexagon");

  // 1. 首次异步渲染完成后：caption 存在且只有一份，文案正确。
  assert.equal(captions().length, 1, "caption exists after first async render");
  assert.equal(captions()[0].textContent, captionText, "caption copy is intact");

  // 3. SVG 渲染在独立挂载节点内，baseline/current 两层都在。
  const mount = card!.querySelector<ProviderModalTestElement>(".echoink-trait-hexagon-mount");
  assert.ok(mount, "dedicated SVG mount node exists");
  assert.equal(svgs().length, 1, "hexagon SVG rendered");
  assert.ok(mount!.contains(svgs()[0]), "SVG must live inside the mount node");
  assert.ok(!mount!.contains(captions()[0]),
    "caption must be a sibling of the mount, never inside it");
  assert.equal(card!.querySelectorAll(".echoink-trait-hexagon-baseline").length, 1,
    "baseline polygon present");
  assert.equal(card!.querySelectorAll(".echoink-trait-hexagon-score").length, 1,
    "current score polygon present");

  // 2. 连续两次异步刷新（展开抽屉会重新 loadPersonalityIntoCard）：
  //    caption 不重复、不被删除；SVG 被替换而不是累积。
  const expandBtn = card!.querySelector<ProviderModalTestElement>(
    ".echoink-agent-profile-expand-btn"
  )!;
  expandBtn.click(); // 展开 → 触发第二次异步渲染
  await settleMicrotasks();
  expandBtn.click(); // 收起
  expandBtn.click(); // 再展开 → 触发第三次异步渲染
  await settleMicrotasks();

  assert.equal(captions().length, 1, "caption must not duplicate or vanish across re-renders");
  assert.equal(captions()[0].textContent, captionText, "caption copy unchanged after re-renders");
  assert.equal(svgs().length, 1, "SVG must be replaced, not accumulated");
  assert.equal(card!.querySelectorAll(".echoink-trait-hexagon-baseline").length, 1);
  assert.equal(card!.querySelectorAll(".echoink-trait-hexagon-score").length, 1);
  console.log("PASS settings: personality profile caption survives repeated async renders");
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
  readonly defaultView = {
    MouseEvent: ProviderModalTestMouseEvent,
    ResizeObserver: ProviderModalTestResizeObserver,
    innerWidth: 1200,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  readonly body = new ProviderModalTestElement("body", this);
  private readonly eventListeners = new Map<string, Array<(event: any) => void>>();

  createElement(tagName: string): ProviderModalTestElement {
    return new ProviderModalTestElement(tagName, this);
  }

  createElementNS(namespaceURI: string, tagName: string): ProviderModalTestElement {
    if (namespaceURI === "http://www.w3.org/2000/svg") {
      return new ProviderModalTestSvgElement(this, tagName);
    }
    return new ProviderModalTestElement(tagName, this, namespaceURI);
  }

  importNode(node: ProviderModalTestElement): ProviderModalTestElement {
    if (node instanceof ProviderModalTestSvgElement) {
      return new ProviderModalTestSvgElement(this);
    }
    return new ProviderModalTestElement(node.localName, this);
  }

  addEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(handler);
    this.eventListeners.set(type, listeners);
  }

  removeEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const listeners = this.eventListeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(handler);
    if (index >= 0) listeners.splice(index, 1);
  }

  fireEvent(type: string, event: Record<string, unknown> = {}): void {
    const synthetic = {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event
    };
    for (const listener of this.eventListeners.get(type) ?? []) listener(synthetic);
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

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
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
  scrollIntoViewCalls = 0;
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

  setCssStyles(styles: Partial<CSSStyleDeclaration>): void {
    for (const [name, value] of Object.entries(styles)) {
      if (value !== undefined && value !== null) {
        this.style.setProperty(name, String(value));
      }
    }
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

  scrollIntoView(): void {
    this.scrollIntoViewCalls += 1;
  }

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
  constructor(ownerDocument: ProviderModalTestDocument, tagName = "svg") {
    super(tagName, ownerDocument, "http://www.w3.org/2000/svg");
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

function withSettingsTabDefaults<T extends object>(plugin: T) {
  return {
    getEchoInkKnowledgeInitializationState: async () => null,
    getEchoInkKnowledgeBaseStructure: async () =>
      makeKnowledgeBaseStructureFixture("uninitialized"),
    restoreEchoInkKnowledgeBaseStructure: async () => ({
      structure: makeKnowledgeBaseStructureFixture("ready"),
      createdRoots: [...KNOWLEDGE_INITIALIZATION_ROOTS]
    }),
    isEchoInkOnboardingRequested: () => false,
    getEchoInkOnboardingStep: () => "provider" as const,
    advanceEchoInkOnboarding: async () => null,
    dismissEchoInkOnboarding: async () => undefined,
    ...plugin
  };
}

await runProviderSettingsBehaviorTests();
