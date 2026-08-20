import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { Plugin } from "obsidian";
import { closeMcpBrokerConnectionPool } from "./resources/mcp-broker";
import {
  EchoInkMcpBrokerService,
  type CallEchoInkMcpToolInput
} from "./resources/mcp-broker-service";
import type { EchoInkResource } from "./resources/types";
import { enabledSkillResources } from "./resources/registry";
import type { ReviewManager } from "./review/manager";
import {
  apiProviderHasUsableCredential,
  getActiveApiProvider,
  type ChatMessage,
  type CodexForObsidianSettings,
  type KnowledgeBaseSettings,
  type ResourceManagementTab,
  type StoredSession
} from "./settings/settings";
import type { CodexView } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import {
  EchoInkSettingsStore,
  restoreApiProviderSettings,
  snapshotApiProviderSettings,
  type SettingsSaveOptions
} from "./plugin/settings-store";
import { EchoInkViewService } from "./plugin/view-service";
import { EchoInkResourceCatalogService } from "./plugin/resource-catalog-service";
import {
  EchoInkMcpSettingsService,
  type EchoInkMcpServerDraft
} from "./plugin/mcp-settings-service";
import { EchoInkKnowledgeSurfaceService } from "./plugin/knowledge-surface-service";
import type {
  ExperienceSourceRef,
  PiBranchNavigationResult,
  PiChatEventSubscription,
  PiChatRunHandle,
  PiChatRuntimeEventListener,
  PiChatSubmitRequest,
  PiKnowledgeMaintenanceScope,
  PiConversationCatalogEntry,
  PiConversationDerivationResult,
  PiConversationMemoryMode,
  PiConversationCatalogStatus,
  PiConversationProjection,
  PiConversationSupportState,
  PiTaskPlanTransitionRequest,
  PiTaskPlanTransitionResult
} from "./harness/pi-native/contracts";
import type {
  ActivatePiNativeConversationOptions,
  CreatePiNativeConversationInput,
  DerivePiNativeConversationInput,
  PiNativeConversationRecoveryResult,
  RecoverPiNativeConversationInput
} from "./harness/pi-native/pi-native-conversation-runtime";
import {
  createPiProductionRuntimeBundle,
  type PiProductionRuntimeBundle
} from "./plugin/pi-production-runtime-composition";
import { PiLocalDataService } from "./plugin/pi-local-data-service";
import { pluginDataDir } from "./plugin/plugin-data-paths";
import {
  KnowledgeMaintenancePreferenceRepository
} from "./knowledge-base/knowledge-maintenance-preferences";
import { isRawMarkdownPath } from "./knowledge-base/raw-digest";
import {
  PiProviderConfigurationService,
  type PiProviderConfigurationDraft,
  type PiProviderConnectionTestResult,
  type PiProviderModelListResult
} from "./plugin/pi-provider-configuration-service";
import {
  ApiProviderActivationService,
  ProductActivityGate
} from "./plugin/api-provider-activation-service";
import { EditorTranslationService } from "./plugin/editor-translation-service";
import {
  PersonalMemoryCorrectionService,
  type PersonalMemoryCorrectionRecord
} from "./plugin/personal-memory-correction-service";
import { normalizeApiProviderId } from "./settings/provider-presets";
import {
  OpenAICodexOAuthService,
  type OpenAICodexAuthStatus
} from "./plugin/openai-codex-oauth-service";

interface PiConversationActivationTask {
  readonly generation: number;
  readonly isStillCurrent?: () => boolean;
  cancelled: boolean;
  promise: Promise<void>;
}

export interface PiConversationSelectionActivationOptions
extends ActivatePiNativeConversationOptions {
  /** UI-owned selection guard; never forwarded into AgentSession options. */
  isStillCurrent?: () => boolean;
}

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  private knowledgeBase: EchoInkKnowledgeSurfaceService | null = null;
  private review: ReviewManager | null = null;
  private settingsStore: EchoInkSettingsStore | null = null;
  private viewService: EchoInkViewService | null = null;
  private resourceCatalogService: EchoInkResourceCatalogService | null = null;
  private mcpBrokerService: EchoInkMcpBrokerService | null = null;
  private mcpSettingsService: EchoInkMcpSettingsService | null = null;
  private piProviderConfigurationService:
    PiProviderConfigurationService | null = null;
  private openAICodexOAuthService:
    OpenAICodexOAuthService | null = null;
  private piRuntimeBundle: PiProductionRuntimeBundle | null = null;
  private piRuntimeFlight: Promise<PiProductionRuntimeBundle> | null = null;
  private piConversationActivationGeneration = 0;
  private piConversationActivationLane: Promise<void> = Promise.resolve();
  private readonly piConversationActivationTasks = new Map<
    string,
    PiConversationActivationTask
  >();
  private piActivatedConversationId: string | null = null;
  private piLocalData: PiLocalDataService | null = null;
  private piLocalDataFlight: Promise<PiLocalDataService> | null = null;
  private readonly piRunConversations = new Map<string, string>();
  private readonly apiProviderActivation = new ApiProviderActivationService();
  private editorTranslation: EditorTranslationService | null = null;
  private personalMemoryCorrection: PersonalMemoryCorrectionService | null = null;
  private readonly productActivity = new ProductActivityGate();
  async onload(): Promise<void> {
    await this.loadSettings();
    await this.initializePiLocalData();
    const controllers = registerEchoInkPluginFeatures(this);
    this.knowledgeBase = controllers.knowledgeBase;
    this.review = controllers.review;
    registerEchoInkStartupTasks(this);
  }

  onunload(): void {
    void this.performUnload();
  }

  private async performUnload(): Promise<void> {
    await this.knowledgeBase?.unload();
    this.review?.unload();
    await this.cancelAllPiConversationActivations();
    await this.piRuntimeBundle?.runtime.shutdown();
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await this.persistPiNativeSettings();
    await closeMcpBrokerConnectionPool();
  }

  async activateHomeAndSidebar(): Promise<void> { return this.getViewService().activateHomeAndSidebar(); }
  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> { return this.getViewService().activateHomeView(options); }
  async activateView(): Promise<void> { return this.getViewService().activateView(); }
  applyComposerDefaultsToView(): void { this.getViewService().applyComposerDefaultsToView(); }
  getCodexView(): CodexView | null { return this.getViewService().getCodexView(); }
  refreshKnowledgeBaseSurfaces(): void { this.getViewService().refreshKnowledgeBaseSurfaces(); }
  async openWorkspaceResourceSettings(tab: ResourceManagementTab = "plugins"): Promise<void> { return this.getViewService().openWorkspaceResourceSettings(tab); }
  async openReviewHtmlPreview(relativePath: string): Promise<void> { return this.getViewService().openReviewHtmlPreview(relativePath); }
  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000, signal?: AbortSignal): Promise<unknown[]> {
    return await this.getMcpBrokerService().listTools(resourceId, timeoutMs, signal);
  }
  async callEchoInkMcpTool(input: CallEchoInkMcpToolInput): Promise<unknown> {
    return await this.getMcpBrokerService().callTool(input);
  }
  async callEchoInkMcpToolFromResourceSnapshot(
    input: CallEchoInkMcpToolInput,
    snapshot: Readonly<CodexForObsidianSettings["resources"]>
  ): Promise<unknown> {
    return await this.getMcpBrokerService().callToolFromResourceSnapshot(input, snapshot);
  }
  async saveEchoInkMcpServer(draft: Readonly<EchoInkMcpServerDraft>): Promise<EchoInkResource> {
    return await this.getMcpSettingsService().saveServer(draft);
  }
  async deleteEchoInkMcpServer(resourceId: string): Promise<void> {
    await this.getMcpSettingsService().deleteServer(resourceId);
  }
  async refreshEchoInkMcpServer(resourceId: string, timeoutMs = 30_000, signal?: AbortSignal) {
    return await this.getMcpSettingsService().refreshServer(resourceId, timeoutMs, signal);
  }
  async setEchoInkMcpServerTrusted(resourceId: string, trusted: boolean): Promise<void> {
    await this.getMcpSettingsService().setServerTrusted(resourceId, trusted);
  }
  async setEchoInkMcpServerEnabled(resourceId: string, enabled: boolean): Promise<void> {
    await this.getMcpSettingsService().setServerEnabled(resourceId, enabled);
  }
  async setEchoInkMcpToolPolicy(resourceId: string, toolName: string, patch: { enabled?: boolean; trusted?: boolean }): Promise<void> {
    await this.getMcpSettingsService().setToolPolicy(resourceId, toolName, patch);
  }
  async setEchoInkSkillResourceEnabled(resourceId: string, enabled: boolean): Promise<void> {
    await this.withEchoInkResourceMutation(async () => {
      const previous = structuredClone(this.settings.resources);
      const resource = this.settings.resources.catalog.find((candidate) =>
        candidate.id === resourceId && candidate.kind === "skill"
      );
      if (!resource) throw new Error("skill_resource_not_found");
      if (resource.enabled === enabled) return;
      resource.enabled = enabled;
      await this.getSettingsStore().saveResourceMutation(previous);
    });
  }
  async listPiProviderModels(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderModelListResult> {
    return await this.getPiProviderConfigurationService().listModels(draft);
  }
  async testPiProviderConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderConnectionTestResult> {
    return await this.getPiProviderConfigurationService()
      .testConnection(draft);
  }
  async getOpenAICodexAuthStatus(): Promise<OpenAICodexAuthStatus> {
    return await this.getOpenAICodexOAuthService().status();
  }
  async loginOpenAICodex(
    interaction: AuthInteraction
  ): Promise<OpenAICodexAuthStatus> {
    return await this.getOpenAICodexOAuthService().login(interaction);
  }
  async logoutOpenAICodex(): Promise<void> {
    await this.getOpenAICodexOAuthService().logout();
  }
  async resolveOpenAICodexAccessToken(): Promise<string> {
    return await this.getOpenAICodexOAuthService().resolveAccessToken();
  }
  async translateEditorSelectionToEnglish(selectedText: string): Promise<string> {
    return await this.withProductActivity(
      async () => await this.getEditorTranslationService().translate(selectedText)
    );
  }
  async cancelHarnessRun(runId: string): Promise<void> {
    const conversationId = this.piRunConversations.get(runId);
    if (conversationId && this.piRuntimeBundle) {
      await this.piRuntimeBundle.runtime.abort(conversationId);
    }
  }
  async prepareEchoInkKnowledgeMaintenanceScope(input: Readonly<{
    request: string;
    attachmentPaths: readonly string[];
  }>): Promise<Readonly<PiKnowledgeMaintenanceScope>> {
    const request = input.request.trim();
    if (input.attachmentPaths.length > 1) {
      throw new Error("/maintain 一次只支持一篇 Raw 笔记。");
    }
    if (input.attachmentPaths.length && request) {
      throw new Error("/maintain 不能同时使用附件和尾随名称。");
    }
    const bundle = await this.ensurePiProductionRuntime();
    if (input.attachmentPaths.length === 1) {
      const vaultRoot = await fsp.realpath(this.getVaultPath());
      const candidate = await fsp.realpath(input.attachmentPaths[0] ?? "")
        .catch(() => "");
      const relative = candidate
        ? path.relative(vaultRoot, candidate).split(path.sep).join("/")
        : "";
      if (
        !candidate
        || !relative
        || relative.startsWith("../")
        || path.isAbsolute(relative)
        || !relative.toLocaleLowerCase().startsWith("raw/")
        || !isRawMarkdownPath(relative)
      ) {
        throw new Error("/maintain 附件必须是当前 Vault 的 raw/** Markdown 笔记。");
      }
      await bundle.knowledgeAgentIndex.read({ vaultRelativePath: relative });
      return Object.freeze({
        mode: "exact" as const,
        sourcePaths: Object.freeze<[string]>([relative])
      });
    }
    if (!request) return Object.freeze({ mode: "global" as const });
    const result = await bundle.knowledgeAgentIndex.search({
      query: request,
      kinds: ["raw"],
      limit: 50
    });
    const candidatePaths = result.hits
      .map((hit) => hit.vaultRelativePath)
      .filter(isRawMarkdownPath)
      .slice(0, 12);
    if (!candidatePaths.length) {
      throw new Error("没有找到可可靠匹配的 Raw 笔记；本轮不会回退到全局维护。");
    }
    return Object.freeze({
      mode: "query" as const,
      candidatePaths: Object.freeze(candidatePaths)
    });
  }
  async submitPiChat(
    request: PiChatSubmitRequest
  ): Promise<PiChatRunHandle> {
    return await this.withProductActivity(async () => {
      await this.waitForPiConversationActivation(request.conversationId);
      const bundle = await this.ensurePiProductionRuntime();
      const handle = await bundle.runtime.submit(request);
      this.piRunConversations.set(
        handle.productRunId,
        handle.conversationId
      );
      return handle;
    });
  }
  subscribePiRun(
    productRunId: string,
    listener: PiChatRuntimeEventListener
  ): PiChatEventSubscription {
    if (!this.piRuntimeBundle) {
      throw new Error("EchoInk Pi Runtime 尚未就绪。");
    }
    return this.piRuntimeBundle.runtime.subscribeProductRun(
      productRunId,
      listener
    );
  }
  isPiProductionRun(runId: string): boolean {
    return this.piRunConversations.has(runId);
  }
  releasePiProductionRun(runId: string): void {
    this.piRunConversations.delete(runId);
    this.piRuntimeBundle?.runtime.releaseProductRun(runId);
  }
  async readPiConversationProjection(
    conversationId: string
  ): Promise<PiConversationProjection> {
    if (this.piRuntimeBundle) {
      return await this.piRuntimeBundle.runtime.readProjection(conversationId);
    }
    const localData = await this.ensurePiLocalData();
    const cwd = this.settings.sessions.find(
      (session) => session.id === conversationId
    )?.cwd;
    return await localData.readConversationProjection(conversationId, cwd);
  }
  async readPiConversationSupportState(
    conversationId: string
  ): Promise<PiConversationSupportState> {
    return await (await this.ensurePiLocalData())
      .readConversationSupportState(conversationId);
  }
  async discardPiConversationDraft(
    conversationId: string,
    draftId: string
  ): Promise<boolean> {
    return await (await this.ensurePiLocalData())
      .discardDraft(conversationId, draftId);
  }
  async recoverPiConversationFromVerifiedPrefix(
    input: RecoverPiNativeConversationInput
  ): Promise<Readonly<PiNativeConversationRecoveryResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.recoverConversationFromVerifiedPrefix(input);
  }
  async readPiExperienceSourceRef(
    productRunId: string
  ): Promise<Readonly<ExperienceSourceRef> | null> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.readExperienceSourceRef(productRunId);
  }
  async listPiConversations(
    statuses?: readonly PiConversationCatalogStatus[]
  ): Promise<Readonly<PiConversationCatalogEntry>[]> {
    return await (await this.ensurePiLocalData()).listConversations(statuses);
  }
  async createPiConversation(
    input: CreatePiNativeConversationInput
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    return await (await this.ensurePiLocalData()).createConversation(input);
  }
  async derivePiConversation(
    input: DerivePiNativeConversationInput
  ): Promise<Readonly<PiConversationDerivationResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.deriveConversation(input);
  }
  async renamePiConversation(
    conversationId: string,
    title: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    await this.settlePiRuntimeFlight();
    return this.piRuntimeBundle
      ? await this.piRuntimeBundle.runtime.renameConversation(
          conversationId,
          title
        )
      : await (await this.ensurePiLocalData()).renameConversation(
          conversationId,
          title
        );
  }
  async setPiConversationMemoryMode(
    conversationId: string,
    defaultMemoryMode: PiConversationMemoryMode
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    await this.settlePiRuntimeFlight();
    return this.piRuntimeBundle
      ? await this.piRuntimeBundle.runtime.setConversationMemoryMode(
          conversationId,
          defaultMemoryMode
        )
      : await (await this.ensurePiLocalData()).setConversationMemoryMode(
          conversationId,
          defaultMemoryMode
        );
  }
  async setPiConversationStatus(
    conversationId: string,
    status: PiConversationCatalogStatus
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const runtime = this.piRuntimeBundle;
    if (status !== "active") {
      // A task waiting for its Production Runtime has not created an
      // AgentSession yet, so cancel it without making local management join
      // that initialization. Once a runtime exists, wait for task cleanup.
      await this.cancelPiConversationActivation(
        conversationId,
        runtime !== null
      );
    }
    try {
      return runtime
        ? await runtime.runtime.setConversationStatus(
            conversationId,
            status
          )
        : await (await this.ensurePiLocalData()).setConversationStatus(
            conversationId,
            status
          );
    } finally {
      if (
        status !== "active"
        && this.piActivatedConversationId === conversationId
      ) {
        this.piActivatedConversationId = null;
      }
    }
  }
  async activatePiConversation(
    conversationId: string,
    options: PiConversationSelectionActivationOptions = {}
  ): Promise<PiConversationProjection> {
    // Start both sides of the selection before awaiting local history.
    const localProjection = this.readPiConversationProjection(
      conversationId
    );
    const { isStillCurrent, ...activationOptions } = options;
    if (isStillCurrent?.() !== false) {
      this.queuePiConversationActivation(
        null,
        conversationId,
        activationOptions,
        isStillCurrent
      );
    }
    return await localProjection;
  }
  async switchPiConversation(
    previousConversationId: string | null,
    nextConversationId: string,
    options: PiConversationSelectionActivationOptions = {}
  ): Promise<PiConversationProjection> {
    // Start both sides of the selection before awaiting local history.
    const localProjection = this.readPiConversationProjection(
      nextConversationId
    );
    const { isStillCurrent, ...activationOptions } = options;
    if (isStillCurrent?.() !== false) {
      this.queuePiConversationActivation(
        previousConversationId,
        nextConversationId,
        activationOptions,
        isStillCurrent
      );
    }
    return await localProjection;
  }
  async releasePiConversation(conversationId: string): Promise<void> {
    await this.cancelPiConversationActivation(conversationId);
    await this.settlePiRuntimeFlight();
    try {
      await this.piRuntimeBundle?.runtime.releaseConversation(conversationId);
    } finally {
      if (this.piActivatedConversationId === conversationId) {
        this.piActivatedConversationId = null;
      }
    }
  }
  async steerPiConversation(
    conversationId: string,
    text: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.steer(conversationId, text);
  }
  async followUpPiConversation(
    conversationId: string,
    text: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.followUp(conversationId, text);
  }
  async abortPiConversation(conversationId: string): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.abort(conversationId);
  }
  async transitionPiTaskPlan(
    request: Readonly<PiTaskPlanTransitionRequest>
  ): Promise<Readonly<PiTaskPlanTransitionResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.transitionTaskPlan(request);
  }
  async navigatePiConversationBranch(
    conversationId: string,
    targetEntryId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {}
  ): Promise<PiBranchNavigationResult> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.navigateBranch(
      conversationId,
      targetEntryId,
      options
    );
  }
  async compactPiConversation(
    conversationId: string,
    customInstructions?: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.compactConversation(
      conversationId,
      customInstructions
    );
  }
  async reloadPiProductionRuntime(): Promise<void> {
    await this.cancelAllPiConversationActivations();
    if (this.piRuntimeFlight) {
      await this.piRuntimeFlight.catch(() => undefined);
    }
    const current = this.piRuntimeBundle;
    this.piRuntimeBundle = null;
    this.piRuntimeFlight = null;
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await current?.runtime.shutdown();
    await this.ensurePiProductionRuntime();
  }
  async activateApiProviderSettings(
    applyCandidate: (settings: CodexForObsidianSettings) => void,
    runtimeMode: "replace" | "preserve" | "suspend" = "replace"
  ): Promise<void> {
    await this.cancelAllPiConversationActivations();
    await this.apiProviderActivation.run({
      isBusy: () => this.productActivity.hasActivity
        || this.piRunConversations.size > 0,
      beginSwitch: () => this.productActivity.beginSwitch(),
      endSwitch: () => this.productActivity.endSwitch(),
      snapshotMemory: () => snapshotApiProviderSettings(this.settings),
      readPersisted: async () =>
        await this.getSettingsStore().readPersistedApiProviderSettingsSnapshot(),
      applyCandidate: () => applyCandidate(this.settings),
      persistCandidate: async () => {
        await this.saveSettings(true);
      },
      createCandidateRuntime: async () => {
        if (runtimeMode === "preserve") return this.piRuntimeBundle;
        if (runtimeMode === "suspend") return null;
        return await createPiProductionRuntimeBundle(
          this,
          await this.ensurePiLocalData()
        );
      },
      currentRuntime: () => this.piRuntimeBundle,
      finalizeCandidate: async () => undefined,
      abortCandidate: async () => undefined,
      activateRuntime: (runtime) => {
        const changed = runtime !== this.piRuntimeBundle;
        this.piRuntimeBundle = runtime;
        this.piRuntimeFlight = null;
        if (changed) {
          this.piActivatedConversationId = null;
          this.piRunConversations.clear();
        }
      },
      shutdownRuntime: async (runtime) => await runtime.runtime.shutdown(),
      restoreMemory: (snapshot) => restoreApiProviderSettings(this.settings, snapshot),
      restorePersisted: async (snapshot) =>
        await this.getSettingsStore().restorePersistedApiProviderSettingsSnapshot(snapshot)
    });
  }

  private async withProductActivity<T>(action: () => Promise<T>): Promise<T> {
    if (this.piRunConversations.size > 0 || this.productActivity.hasActivity) {
      throw new Error("EchoInk 正在处理其他请求，请稍后再试。");
    }
    return await this.productActivity.run(action);
  }
  async suspendPiProductionRuntime(): Promise<void> {
    await this.cancelAllPiConversationActivations();
    if (this.piRuntimeFlight) {
      await this.piRuntimeFlight.catch(() => undefined);
    }
    const current = this.piRuntimeBundle;
    this.piRuntimeBundle = null;
    this.piRuntimeFlight = null;
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await current?.runtime.shutdown();
  }
  async getEchoInkPersonalMemoryState() {
    const localData = await this.ensurePiLocalData();
    return Object.freeze({
      ...await localData.personalMemory.readUserControlState(),
      learningEnabled: this.settings.memory.enabled
    });
  }
  async updateEchoInkPersonalMemoryProfile(
    profile: "agent" | "user",
    content: string,
    expectedRevision: number
  ) {
    return await (await this.ensurePiLocalData()).personalMemory.updateIdentityFile(
      profile,
      content,
      expectedRevision
    );
  }
  async generateEchoInkPersonalMemoryCorrection(
    record: PersonalMemoryCorrectionRecord,
    correction: string,
    signal?: AbortSignal
  ) {
    return await this.withProductActivity(
      async () => await this.getPersonalMemoryCorrectionService()
        .generatePreview({ record, correction, signal })
    );
  }
  async applyEchoInkPersonalMemoryCorrection(input: Readonly<{
    targetId: string;
    title: string;
    content: string;
    recallWhen: string;
    reason: string;
    expectedRevision: number;
  }>) {
    return await this.withProductActivity(async () =>
      await (await this.ensurePiLocalData()).personalMemory
        .supersedeFromUserCorrection(input)
    );
  }
  async setEchoInkPersonalMemoryLearningEnabled(enabled: boolean): Promise<void> {
    this.settings.memory.enabled = enabled;
    await this.saveSettings(true);
  }
  async exportEchoInkPersonalMemory() {
    return await (await this.ensurePiLocalData()).personalMemory.exportMemory();
  }
  async forgetEchoInkPersonalMemory(
    id: string,
    reason: string,
    expectedRevision: number
  ) {
    return await (await this.ensurePiLocalData()).personalMemory.forgetFromUserControl(
      id,
      reason,
      expectedRevision
    );
  }
  async restoreEchoInkPersonalMemory(id: string, expectedRevision: number) {
    return await (await this.ensurePiLocalData()).personalMemory.restoreForgotten(
      id,
      expectedRevision
    );
  }
  async getEchoInkKnowledgeMaintenancePreferenceState() {
    const stores = await this.resolveKnowledgeMaintenancePreferenceStores();
    return await stores.preferences.read();
  }
  async saveEchoInkKnowledgeMaintenancePreferences(
    content: string,
    expectedRevision: string
  ) {
    const stores = await this.resolveKnowledgeMaintenancePreferenceStores();
    return await stores.preferences.save({
      content,
      expectedRevision
    });
  }
  async buildRuntimeEchoInkResourceCatalog(): Promise<EchoInkResource[]> { return await this.getResourceCatalogService().buildRuntimeCatalog(); }
  async readPersistedEchoInkResourceSnapshot(): Promise<
  CodexForObsidianSettings["resources"]> {
    return await this.getSettingsStore().readPersistedEchoInkResourceSnapshot();
  }
  async ensureEchoInkSkillResourcesLoaded(_force = false): Promise<EchoInkResource[]> {
    return enabledSkillResources(await this.buildRuntimeEchoInkResourceCatalog());
  }
  getVaultPath(): string { const adapter = this.app.vault.adapter as { basePath?: string; path?: string }; return adapter.basePath || adapter.path || ""; }
  getPluginDataDirName(): string { const dir = (this.manifest as { dir?: unknown }).dir; return typeof dir === "string" && dir.trim() ? dir : this.manifest.id; }
  async loadSettings(): Promise<void> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> { return this.getSettingsStore().saveSettings(force, options); }
  async persistPiNativeSettings(): Promise<void> {
    await this.getSettingsStore().saveSettings(true, {
      flushConversationStore: false
    });
  }
  async withEchoInkConversationMutation<R>(conversationId: string, action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withConversationMutation(conversationId, action); }
  async withEchoInkSettingsPersistenceAuthorityGate<R>(action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withSettingsPersistenceAuthorityGate(action); }
  async withEchoInkResourceMutation<R>(action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withResourceMutation(action); }
  async saveEchoInkResourceMutation(previous: CodexForObsidianSettings["resources"]): Promise<void> { await this.getSettingsStore().saveResourceMutation(previous); }
  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> { return this.getSettingsStore().externalizeMessageText(message, fullText); }
  async readRawMessageText(rawRef: string): Promise<string> { return this.getSettingsStore().readRawMessageText(rawRef); }
  getKnowledgeSurfaceService(): EchoInkKnowledgeSurfaceService | null { return this.knowledgeBase; } getReviewManager(): ReviewManager | null { return this.review; }
  private getMcpBrokerService(): EchoInkMcpBrokerService {
    if (!this.mcpBrokerService) {
      this.mcpBrokerService = new EchoInkMcpBrokerService(this);
    }
    return this.mcpBrokerService;
  }
  private getMcpSettingsService(): EchoInkMcpSettingsService {
    if (!this.mcpSettingsService) {
      this.mcpSettingsService = new EchoInkMcpSettingsService(this);
    }
    return this.mcpSettingsService;
  }
  private getSettingsStore(): EchoInkSettingsStore {
    if (!this.settingsStore) this.settingsStore = new EchoInkSettingsStore(this);
    return this.settingsStore;
  }
  private getViewService(): EchoInkViewService {
    if (!this.viewService) this.viewService = new EchoInkViewService(this);
    return this.viewService;
  }
  private getResourceCatalogService(): EchoInkResourceCatalogService {
    if (!this.resourceCatalogService) {
      this.resourceCatalogService = new EchoInkResourceCatalogService(this);
    }
    return this.resourceCatalogService;
  }
  private getPiProviderConfigurationService():
  PiProviderConfigurationService {
    if (!this.piProviderConfigurationService) {
      this.piProviderConfigurationService =
        new PiProviderConfigurationService(this, {
          resolveOAuthAccessToken: async () =>
            await this.resolveOpenAICodexAccessToken()
        });
    }
    return this.piProviderConfigurationService;
  }
  private getOpenAICodexOAuthService(): OpenAICodexOAuthService {
    if (!this.openAICodexOAuthService) {
      this.openAICodexOAuthService = new OpenAICodexOAuthService(this);
    }
    return this.openAICodexOAuthService;
  }
  private getEditorTranslationService(): EditorTranslationService {
    if (!this.editorTranslation) {
      this.editorTranslation = new EditorTranslationService({
        generateEnglishTranslation: async (input) => {
          const provider = getActiveApiProvider(this.settings);
          if (!provider) throw new Error("请先在 API Provider 中选择可用模型。");
          return await this.getPiProviderConfigurationService().generateText({
            draft: {
              providerSettingsId: provider.id,
              providerId: normalizeApiProviderId(
                provider.providerId,
                provider.baseUrl,
                provider.name
              ),
              runtimeProviderId: provider.runtimeProviderId,
              apiProtocol: provider.apiProtocol,
              authMode: provider.authMode,
              baseUrl: provider.baseUrl,
              modelId: provider.model,
              apiKey: "",
              toolCalling: false,
              imageInput: false,
              reasoning: provider.reasoning,
              contextWindow: provider.contextWindow,
              maxOutputTokens: provider.maxOutputTokens
            },
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            timeoutMs: input.timeoutMs,
            maxTokens: 4_096
          });
        }
      });
    }
    return this.editorTranslation;
  }

  private getPersonalMemoryCorrectionService(): PersonalMemoryCorrectionService {
    if (!this.personalMemoryCorrection) {
      this.personalMemoryCorrection = new PersonalMemoryCorrectionService({
        generateCorrection: async (input) => {
          const provider = getActiveApiProvider(this.settings);
          if (!provider) throw new Error("请先在 API Provider 中选择可用模型。");
          return await this.getPiProviderConfigurationService().generateText({
            draft: {
              providerSettingsId: provider.id,
              providerId: normalizeApiProviderId(
                provider.providerId,
                provider.baseUrl,
                provider.name
              ),
              runtimeProviderId: provider.runtimeProviderId,
              apiProtocol: provider.apiProtocol,
              authMode: provider.authMode,
              baseUrl: provider.baseUrl,
              modelId: provider.model,
              apiKey: "",
              toolCalling: false,
              imageInput: false,
              reasoning: provider.reasoning,
              contextWindow: provider.contextWindow,
              maxOutputTokens: provider.maxOutputTokens
            },
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            timeoutMs: input.timeoutMs,
            maxTokens: 2_048,
            signal: input.signal
          });
        }
      });
    }
    return this.personalMemoryCorrection;
  }

  private async resolveKnowledgeMaintenancePreferenceStores() {
    const vaultRootPath = await fsp.realpath(this.getVaultPath());
    const rawPluginDataRootPath = pluginDataDir(
      vaultRootPath,
      this.getPluginDataDirName()
    );
    await fsp.mkdir(rawPluginDataRootPath, { recursive: true, mode: 0o700 });
    const pluginDataRootPath = await fsp.realpath(rawPluginDataRootPath);
    const privateKnowledgeRootPath = path.join(
      pluginDataRootPath,
      "pi-agent-product-v1",
      "knowledge"
    );
    return Object.freeze({
      preferences: new KnowledgeMaintenancePreferenceRepository(
        privateKnowledgeRootPath
      )
    });
  }

  private async initializePiLocalData(): Promise<void> {
    try {
      await this.ensurePiLocalData();
    } catch (error) {
      console.error("EchoInk 本地数据初始化失败", error);
    }
  }

  private queuePiConversationActivation(
    previousConversationId: string | null,
    conversationId: string,
    options: ActivatePiNativeConversationOptions = {},
    isStillCurrent?: () => boolean
  ): PiConversationActivationTask {
    const task: PiConversationActivationTask = {
      generation: ++this.piConversationActivationGeneration,
      ...(isStillCurrent ? { isStillCurrent } : {}),
      cancelled: false,
      promise: Promise.resolve()
    };
    const previousLane = this.piConversationActivationLane;
    task.promise = previousLane
      .then(async () => {
        if (!this.isCurrentPiConversationActivation(task)) return;
        const previousActiveConversationId =
          this.piActivatedConversationId
          ?? (
            previousConversationId
            && previousConversationId !== conversationId
              ? previousConversationId
              : null
          );
        if (!this.piProviderCanActivateAgentSession()) {
          const bundle = this.piRuntimeBundle;
          if (previousActiveConversationId && bundle) {
            try {
              await bundle.runtime.releaseConversation(
                previousActiveConversationId
              );
            } finally {
              if (
                this.piActivatedConversationId
                === previousActiveConversationId
              ) {
                this.piActivatedConversationId = null;
              }
            }
          } else if (
            this.piActivatedConversationId === previousActiveConversationId
          ) {
            this.piActivatedConversationId = null;
          }
          return;
        }

        const bundle = await this.ensurePiProductionRuntime();
        if (!this.isCurrentPiConversationActivation(task)) return;

        if (
          previousActiveConversationId
          && previousActiveConversationId !== conversationId
        ) {
          this.piActivatedConversationId = null;
          await bundle.runtime.switchConversation(
            previousActiveConversationId,
            conversationId,
            options
          );
        } else {
          await bundle.runtime.activateConversation(conversationId, options);
        }
        this.piActivatedConversationId = conversationId;

        if (!this.isCurrentPiConversationActivation(task)) {
          try {
            await bundle.runtime.releaseConversation(conversationId);
          } finally {
            if (this.piActivatedConversationId === conversationId) {
              this.piActivatedConversationId = null;
            }
          }
        }
      })
      .finally(() => {
        if (this.piConversationActivationTasks.get(conversationId) === task) {
          this.piConversationActivationTasks.delete(conversationId);
        }
      });
    this.piConversationActivationTasks.set(conversationId, task);
    this.piConversationActivationLane = task.promise.then(
      () => undefined,
      () => undefined
    );
    void task.promise.catch(() => undefined);
    return task;
  }

  private isCurrentPiConversationActivation(
    task: Readonly<PiConversationActivationTask>
  ): boolean {
    return !task.cancelled
      && task.generation === this.piConversationActivationGeneration
      && task.isStillCurrent?.() !== false;
  }

  private async waitForPiConversationActivation(
    conversationId: string
  ): Promise<void> {
    if (this.piActivatedConversationId === conversationId) return;
    const pending = this.piConversationActivationTasks.get(conversationId);
    if (!this.piProviderCanActivateAgentSession()) {
      if (pending) await pending.promise;
      return;
    }

    const task = pending ?? this.queuePiConversationActivation(
      this.piActivatedConversationId,
      conversationId
    );
    await task.promise;
    if (
      this.piActivatedConversationId === conversationId
      || !this.piProviderCanActivateAgentSession()
    ) return;
    throw new Error(
      "会话已切换或关闭，本轮消息未发送；请在当前会话重试。"
    );
  }

  private async cancelPiConversationActivation(
    conversationId: string,
    waitForSettlement = true
  ): Promise<void> {
    const task = this.piConversationActivationTasks.get(conversationId);
    if (!task) return;
    task.cancelled = true;
    if (waitForSettlement) {
      await task.promise.catch(() => undefined);
    }
  }

  private async cancelAllPiConversationActivations(): Promise<void> {
    for (const task of this.piConversationActivationTasks.values()) {
      task.cancelled = true;
    }
    await this.piConversationActivationLane;
  }

  private async ensurePiLocalData(): Promise<PiLocalDataService> {
    if (this.piLocalData) return this.piLocalData;
    if (this.piLocalDataFlight) return await this.piLocalDataFlight;
    const flight = PiLocalDataService.create(this)
      .then((localData) => {
        this.piLocalData = localData;
        return localData;
      })
      .finally(() => {
        if (this.piLocalDataFlight === flight) {
          this.piLocalDataFlight = null;
        }
      });
    this.piLocalDataFlight = flight;
    return await flight;
  }

  private async settlePiRuntimeFlight(): Promise<void> {
    await this.piRuntimeFlight?.catch(() => undefined);
  }

  private piProviderCanActivateAgentSession(): boolean {
    const provider = getActiveApiProvider(this.settings);
    return Boolean(provider && apiProviderHasUsableCredential(
      provider,
      this.settings.openAICodexCredential
    ));
  }

  private async ensurePiProductionRuntime(): Promise<PiProductionRuntimeBundle> {
    if (this.piRuntimeBundle) return this.piRuntimeBundle;
    if (this.piRuntimeFlight) return await this.piRuntimeFlight;
    const flight = this.ensurePiLocalData()
      .then(async (localData) =>
        await createPiProductionRuntimeBundle(this, localData)
      )
      .then((bundle) => {
        this.piRuntimeBundle = bundle;
        return bundle;
      })
      .finally(() => {
        if (this.piRuntimeFlight === flight) {
          this.piRuntimeFlight = null;
        }
      });
    this.piRuntimeFlight = flight;
    return await flight;
  }
}
