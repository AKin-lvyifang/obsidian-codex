import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";
import {
  apiProviderApiKeyRequired,
  apiProviderMaxOutputReserve,
  getApiProviderPreset,
  getApiProviderModelPreset,
  isLoopbackApiProviderUrl,
  normalizeApiProviderId,
  normalizeApiProviderProtocol,
  normalizeApiProviderBaseUrl,
  type ApiProviderId,
  type ApiProviderProtocol
} from "./provider-presets";
import {
  parsePiContextLedger,
  type PiContextLedger
} from "../harness/pi-native/pi-context-budget";
import { normalizeHarnessRunUsage, type HarnessRunUsage } from "../harness/contracts/event";
import { defaultResourceSettings } from "../resources/registry";
import { normalizeMcpConnectionRecords } from "../resources/mcp-connections";
import type { EchoInkResourceSettings } from "../resources/types";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE, LEGACY_CLAUDE_RULES_FILE } from "../knowledge-base/constants";
import type {
  KnowledgeBaseCitationSummary,
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunWarning
} from "../knowledge-base/types";
import type { KnowledgeBaseMessageUiPayload } from "../knowledge-base/maintain-report-card";
import {
  normalizeEchoInkTaskPlanSnapshot,
  type EchoInkTaskPlanSnapshot
} from "../types/task-plan";
import type { EchoInkConversationSessionShell } from "./current-conversation";

export interface StoredAttachment {
  type: "file" | "image";
  name: string;
  path: string;
}

export interface DiffFileSummary {
  path: string;
  previousPath?: string;
  kind: "add" | "delete" | "update" | "move" | "unknown";
  added: number;
  removed: number;
}

export interface DiffSummary {
  totalFiles: number;
  added: number;
  removed: number;
  files: DiffFileSummary[];
}

export type EchoInkChatTerminalPayloadSource =
  | {
    kind: "inline";
    value: string;
    contentHash: string;
    size: number;
    lines: number;
  }
  | {
    kind: "raw";
    rawRef: string;
    contentHash: string;
    previewHash: string;
    size: number;
    lines: number;
  };

export interface EchoInkChatRunTerminalRecovery {
  namespace: "echoink.chat-terminal";
  schemaVersion: 1;
  runId: string;
  status: "completed" | "cancelled" | "failed";
  backendId?: string;
  data?: Record<string, unknown>;
  payloadPresent: boolean;
  payloadHash: string;
  terminalCommitId: string;
  carrierMessageId: string;
  payloadSource: EchoInkChatTerminalPayloadSource;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  backendId?: string;
  /** Exact runtime Provider identity captured from Pi; absent on historical messages. */
  providerId?: string;
  modelId?: string;
  profileId?: string;
  runTerminalRecoveryPending?: "completed" | "cancelled" | "failed";
  echoInkRunTerminalRecovery?: EchoInkChatRunTerminalRecovery;
  runTerminalRecovered?: boolean;
  previewText?: string;
  rawRef?: string;
  rawSize?: number;
  rawLines?: number;
  rawTruncatedForPreview?: boolean;
  phase?: string | null;
  itemType?: string;
  runId?: string;
  turnId?: string;
  processKind?: ProcessEventKind;
  title?: string;
  status?: string;
  details?: string;
  processContentAvailability?: "provided" | "empty" | "unavailable";
  processInput?: string;
  processOutput?: string;
  processInputAvailability?: "provided" | "empty" | "unavailable";
  processOutputAvailability?: "provided" | "empty" | "unavailable";
  diffSummary?: DiffSummary;
  citations?: KnowledgeBaseCitationSummary;
  knowledgeBaseUi?: KnowledgeBaseMessageUiPayload;
  attachments?: StoredAttachment[];
  files?: ProcessFileRef[];
  images?: StoredAttachment[];
  runUsage?: HarnessRunUsage;
  /** Thin projection of a structured Pi Session task-plan entry. */
  taskPlan?: Readonly<EchoInkTaskPlanSnapshot>;
  createdAt: number;
  completedAt?: number;
}

export type StoredSession = EchoInkConversationSessionShell<
  ChatMessage,
  Readonly<PiContextLedger>,
  TokenUsage
>;

export type SettingsTab = "general" | "providers" | "resources" | "knowledgeBase" | "review";
export type ProviderMode = "custom-api";
export type ResourceManagementTab = "plugins" | "mcp" | "skills";
export type KnowledgeBaseRunStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type KnowledgeBaseInitStatus = "not-started" | "preview-ready" | "initialized" | "failed";
export type KnowledgeBaseCaptureTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";
export type KnowledgeBaseHealthCheckStatus = "success" | "failed";
export type KnowledgeBaseMaintenanceTerminalStatus = KnowledgeBaseHealthCheckStatus | "canceled";
export type KnowledgeBaseMaintenanceMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox" | "unknown";
export type ReviewReportKind = "knowledge-base" | "agent-chat";
export type ReviewRangeMode = "previous-week" | "current-week";
export type SettingsLanguage = "zh-CN" | "en";

export interface SetupSettings {
  completedAt: number;
  lastCheckedAt: number;
  dismissedVersion: string;
  tutorialStep: "provider" | "knowledge" | "personality";
}

export interface EchoInkMemorySettings {
  enabled: boolean;
  useLongTermMemory: boolean;
  /** Dream scheduler: offline memory consolidation (anchor expansion + personality signal extraction). */
  dreamEnabled: boolean;
  /** Number of dream runs per day (1-6). */
  dreamRunsPerDay: number;
  /** Max token budget per dream run. */
  dreamTokenBudget: number;
}

export interface KnowledgeBaseProcessedSource {
  path: string;
  size: number;
  mtime: number;
  fingerprint?: string;
  digestedAt: number;
  reportPath?: string;
  evidencePaths?: string[];
  runId?: string;
  confidence?: "verified" | "repaired";
}

export interface KnowledgeBaseHealthHistoryEntry {
  date: string;
  status: KnowledgeBaseHealthCheckStatus;
  at: number;
}

export interface KnowledgeBaseMaintenanceHistoryEntry {
  date: string;
  status: KnowledgeBaseMaintenanceTerminalStatus;
  at: number;
  runId?: string;
  mode: KnowledgeBaseMaintenanceMode;
  reportPath: string;
  completion?: KnowledgeBaseRunCompletion;
  pendingSources?: string[];
  /** @deprecated Read-only compatibility for pre-resilience history. */
  phase?: string;
  errorCode?: string;
  warnings?: KnowledgeBaseRunWarning[];
}

export interface KnowledgeBaseSettings {
  useCustomRulesFile: boolean;
  rulesFilePath: string;
  lastRunAt: number;
  lastRunStatus: KnowledgeBaseRunStatus;
  lastReportPath: string;
  lastError: string;
  lastSummary: string;
  lastCompletion: KnowledgeBaseRunCompletion | "";
  lastPendingSources: string[];
  lastWarnings: KnowledgeBaseRunWarning[];
  initialization: KnowledgeBaseInitializationSettings;
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  healthHistory: KnowledgeBaseHealthHistoryEntry[];
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
}

export interface KnowledgeBaseInitializationSettings {
  status: KnowledgeBaseInitStatus;
  initializedAt: number;
  rulesFilePath: string;
  templateVersion: string;
  lastPreviewSummary: string;
}

export interface ReviewReportState {
  lastRangeKey: string;
}

export interface WeeklyReviewSettings {
  enabled: boolean;
  knowledgeBaseEnabled: boolean;
  agentChatEnabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  outputDir: string;
  rangeMode: ReviewRangeMode;
  openHtmlAfterRun: boolean;
  reports: {
    knowledgeBase: ReviewReportState;
    agentChat: ReviewReportState;
  };
}

export interface ApiProviderConfig {
  id: string;
  providerId?: ApiProviderId;
  runtimeProviderId: string;
  apiProtocol: ApiProviderProtocol;
  name: string;
  baseUrl: string;
  model: string;
  models: string[];
  modelSelection: "auto" | "model";
  toolCalling: boolean;
  imageInput: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  apiKey: string;
  queryParams?: Record<string, string>;
}

export interface WorkspaceResourceToggles {
  plugins: Record<string, boolean>;
  mcpServers: Record<string, boolean>;
  skills: Record<string, boolean>;
}

export interface WorkspaceResourceCacheEntry<T> {
  fetchedAt: number;
  items: T[];
  error?: string;
}

export interface WorkspaceResourceCache {
  plugins?: WorkspaceResourceCacheEntry<CodexPluginInfo>;
  mcp?: WorkspaceResourceCacheEntry<McpServerStatus>;
  skills?: WorkspaceResourceCacheEntry<CodexSkill>;
}

export interface CodexForObsidianSettings {
  productGeneration: "pi-agent-product-v1";
  settingsVersion: number;
  settingsLanguage: SettingsLanguage;
  settingsTab: SettingsTab;
  proxyEnabled: boolean;
  proxyUrl: string;
  proxyEndpoint: string;
  proxyCredentialRef: string;
  providerMode: ProviderMode;
  activeApiProviderId: string;
  apiProviders: ApiProviderConfig[];
  defaultModel: string;
  defaultReasoning: ReasoningEffort;
  defaultServiceTier: ServiceTierChoice;
  defaultPermission: PermissionMode;
  defaultMode: UiMode;
  autoOpen: boolean;
  autoOpenHome: boolean;
  showContext: boolean;
  showWelcome: boolean;
  setup: SetupSettings;
  memory: EchoInkMemorySettings;
  resourceManagementTab: ResourceManagementTab;
  knowledgeBase: KnowledgeBaseSettings;
  review: WeeklyReviewSettings;
  resources: EchoInkResourceSettings;
  workspaceResources: WorkspaceResourceToggles;
  workspaceResourceCache: WorkspaceResourceCache;
  sessions: StoredSession[];
  activeSessionId: string;
}

export const DEFAULT_REVIEW_OUTPUT_DIR = "outputs";

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  productGeneration: "pi-agent-product-v1",
  settingsVersion: 50,
  settingsLanguage: "zh-CN",
  settingsTab: "providers",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  proxyEndpoint: "",
  proxyCredentialRef: "",
  providerMode: "custom-api",
  activeApiProviderId: "",
  apiProviders: [createDefaultApiProvider()],
  defaultModel: "",
  defaultReasoning: "high",
  defaultServiceTier: "fast",
  defaultPermission: "workspace-write",
  defaultMode: "agent",
  autoOpen: false,
  autoOpenHome: false,
  showContext: true,
  showWelcome: true,
  setup: {
    completedAt: 0,
    lastCheckedAt: 0,
    dismissedVersion: "",
    tutorialStep: "provider"
  },
  memory: {
    enabled: true,
    useLongTermMemory: true,
    dreamEnabled: false,
    dreamRunsPerDay: 3,
    dreamTokenBudget: 50000
  },
  resourceManagementTab: "plugins",
  knowledgeBase: {
    useCustomRulesFile: true,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
    lastRunAt: 0,
    lastRunStatus: "idle",
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    lastCompletion: "",
    lastPendingSources: [],
    lastWarnings: [],
    initialization: {
      status: "not-started",
      initializedAt: 0,
      rulesFilePath: "",
      templateVersion: "v0.7",
      lastPreviewSummary: ""
    },
    processedSources: {},
    healthHistory: [],
    maintenanceHistory: []
  },
  review: {
    enabled: false,
    knowledgeBaseEnabled: true,
    agentChatEnabled: true,
    scheduleTime: "21:00",
    catchUpOnStartup: true,
    outputDir: DEFAULT_REVIEW_OUTPUT_DIR,
    rangeMode: "previous-week",
    openHtmlAfterRun: false,
    reports: {
      knowledgeBase: {
        lastRangeKey: ""
      },
      agentChat: {
        lastRangeKey: ""
      }
    }
  },
  resources: defaultResourceSettings(),
  workspaceResources: {
    plugins: {},
    mcpServers: {},
    skills: {}
  },
  workspaceResourceCache: {},
  sessions: [],
  activeSessionId: ""
};

export function normalizeSettingsData(input: unknown): { settings: CodexForObsidianSettings; changed: boolean } {
  const data = settingsRecord(input) ?? {};
  const retiredDataPresent = hasRetiredSettingsData(data);
  const currentProductData = data.productGeneration === DEFAULT_SETTINGS.productGeneration;
  const currentData = Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS)
      .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
      .map((key) => [key, data[key]])
  ) as Partial<CodexForObsidianSettings>;
  const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
  const normalizedLanguage = normalizeSettingsLanguage(data?.settingsLanguage);
  const settings: CodexForObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...currentData,
    productGeneration: DEFAULT_SETTINGS.productGeneration,
    settingsLanguage: normalizedLanguage,
    settingsTab: normalizeSettingsTab(data?.settingsTab),
    providerMode: normalizeProviderMode(data?.providerMode),
    autoOpenHome: data?.autoOpenHome === true,
    activeApiProviderId: typeof data?.activeApiProviderId === "string" ? data.activeApiProviderId.trim() : "",
    apiProviders: normalizeApiProviders(data?.apiProviders),
    showWelcome: data?.showWelcome !== false,
    setup: normalizeSetupSettings(data?.setup),
    memory: normalizeMemorySettings(data?.memory),
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    knowledgeBase: normalizeKnowledgeBaseSettings(data?.knowledgeBase),
    review: normalizeReviewSettings(data?.review),
    resources: normalizeEchoInkResourceSettings(data?.resources, data?.workspaceResources),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: currentProductData ? normalizeStoredSessions(data?.sessions) : [],
    activeSessionId: currentProductData && typeof data?.activeSessionId === "string"
      ? data.activeSessionId
      : ""
  };

  settings.knowledgeBase.lastRunAt = currentProductData ? settings.knowledgeBase.lastRunAt : 0;
  settings.knowledgeBase.lastRunStatus = currentProductData ? settings.knowledgeBase.lastRunStatus : "idle";
  settings.knowledgeBase.lastReportPath = currentProductData ? settings.knowledgeBase.lastReportPath : "";
  settings.knowledgeBase.lastError = currentProductData ? settings.knowledgeBase.lastError : "";
  settings.knowledgeBase.lastSummary = currentProductData ? settings.knowledgeBase.lastSummary : "";
  settings.knowledgeBase.lastCompletion = currentProductData ? settings.knowledgeBase.lastCompletion : "";
  settings.knowledgeBase.lastPendingSources = currentProductData ? settings.knowledgeBase.lastPendingSources : [];
  settings.knowledgeBase.lastWarnings = currentProductData ? settings.knowledgeBase.lastWarnings : [];
  settings.knowledgeBase.processedSources = currentProductData ? settings.knowledgeBase.processedSources : {};
  settings.knowledgeBase.healthHistory = currentProductData ? settings.knowledgeBase.healthHistory : [];
  settings.knowledgeBase.maintenanceHistory = currentProductData ? settings.knowledgeBase.maintenanceHistory : [];
  if (!settings.sessions.some((session) => session.id === settings.activeSessionId)) {
    settings.activeSessionId = settings.sessions[0]?.id ?? "";
  }

  if (previousVersion < 1) {
    if (!data?.defaultModel) settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    if (data?.defaultReasoning === "high") settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    if (data?.defaultServiceTier === "standard") settings.defaultServiceTier = DEFAULT_SETTINGS.defaultServiceTier;
    settings.proxyEnabled = data?.proxyEnabled !== false;
    settings.proxyUrl = settings.proxyEndpoint || settings.proxyCredentialRef
      ? ""
      : typeof data?.proxyUrl === "string" && data.proxyUrl.trim()
        ? data.proxyUrl.trim()
        : DEFAULT_SETTINGS.proxyUrl;
  }

  if (previousVersion < 3) {
    if (settings.defaultReasoning === "high" || settings.defaultReasoning === "xhigh") {
      settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    }
    if (settings.defaultServiceTier === "standard") {
      settings.defaultServiceTier = DEFAULT_SETTINGS.defaultServiceTier;
    }
  }

  if (previousVersion < 4) {
    if (!settings.defaultModel || settings.defaultModel === "gpt-5.4" || settings.defaultModel === "gpt-5.4-mini") {
      settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    }
    if (!settings.defaultReasoning || settings.defaultReasoning === "low") {
      settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    }
  }

  if (previousVersion < 25 && settings.defaultModel === "gpt-5.5") {
    settings.defaultModel = "";
  }

  if (settings.proxyEndpoint || settings.proxyCredentialRef) {
    settings.proxyUrl = "";
  }
  normalizeApiProviderSelection(settings);
  settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  const languageChanged = data?.settingsLanguage !== normalizedLanguage;
  const sessionBoundaryChanged = currentProductData
    && (
      settings.activeSessionId !== data?.activeSessionId
      || settings.sessions.length !== (Array.isArray(data?.sessions) ? data.sessions.length : 0)
    );
  return {
    settings,
    changed: previousVersion !== DEFAULT_SETTINGS.settingsVersion
      || languageChanged
      || !currentProductData
      || sessionBoundaryChanged
      || retiredDataPresent
  };
}

function hasRetiredSettingsData(data: Record<string, unknown>): boolean {
  const currentKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  if (Object.keys(data).some((key) => !currentKeys.has(key))) return true;
  const knowledgeBase = settingsRecord(data.knowledgeBase);
  if (knowledgeBase && Object.keys(knowledgeBase).some((key) => !KNOWLEDGE_BASE_SETTINGS_KEYS.has(key))) {
    return true;
  }
  const resources = settingsRecord(data.resources);
  if (!resources) return false;
  if (Object.hasOwn(resources, "enabledByScope")) return true;
  return Array.isArray(resources.catalog) && resources.catalog.some((resource) => {
    const record = settingsRecord(resource);
    return Boolean(record && Object.hasOwn(record, "scopes"));
  });
}

const KNOWLEDGE_BASE_SETTINGS_KEYS = new Set<string>([
  "useCustomRulesFile",
  "rulesFilePath",
  "lastRunAt",
  "lastRunStatus",
  "lastReportPath",
  "lastError",
  "lastSummary",
  "lastCompletion",
  "lastPendingSources",
  "lastWarnings",
  "initialization",
  "processedSources",
  "healthHistory",
  "maintenanceHistory"
]);

export function getActiveApiProvider(settings: Pick<CodexForObsidianSettings, "activeApiProviderId" | "apiProviders">): ApiProviderConfig | null {
  return settings.apiProviders.find((provider) => provider.id === settings.activeApiProviderId) ?? null;
}

export function apiProviderHasUsableApiKey(provider: ApiProviderConfig): boolean {
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  return !apiProviderApiKeyRequired(providerId)
    || Boolean(provider.apiKey.trim());
}

export function applyApiProviderPreset(
  settings: Pick<
    CodexForObsidianSettings,
    | "providerMode"
    | "activeApiProviderId"
  >,
  provider: ApiProviderConfig,
  providerId: ApiProviderId
): void {
  const preset = getApiProviderPreset(providerId);
  const modelPreset = preset.models[0];
  provider.providerId = preset.id;
  provider.runtimeProviderId = preset.runtimeProviderId;
  provider.apiProtocol = preset.apiProtocol;
  provider.name = preset.name;
  provider.baseUrl = preset.baseUrl;
  provider.model = preset.model;
  provider.models = preset.models.map((model) => model.id);
  provider.modelSelection = "auto";
  provider.toolCalling = modelPreset?.toolCalling ?? true;
  provider.imageInput = modelPreset?.imageInput ?? false;
  provider.reasoning = modelPreset?.reasoning ?? false;
  provider.contextWindow = modelPreset?.contextWindow ?? 64_000;
  provider.maxOutputTokens = modelPreset?.maxOutputTokens ?? 8_192;
  delete provider.queryParams;
  clearApiProviderApiKey(settings, provider);
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
}

export function createApiProviderConfig(
  providerId: ApiProviderId = "deepseek",
  id = newId("provider")
): ApiProviderConfig {
  const preset = getApiProviderPreset(providerId);
  const modelPreset = preset.models[0];
  return {
    id,
    providerId: preset.id,
    runtimeProviderId: preset.runtimeProviderId,
    apiProtocol: preset.apiProtocol,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.model,
    models: preset.models.map((model) => model.id),
    modelSelection: "auto",
    toolCalling: modelPreset?.toolCalling ?? true,
    imageInput: modelPreset?.imageInput ?? false,
    reasoning: modelPreset?.reasoning ?? false,
    contextWindow: modelPreset?.contextWindow ?? 64_000,
    maxOutputTokens: modelPreset?.maxOutputTokens ?? 8_192,
    apiKey: ""
  };
}

export function applyApiProviderModelPreset(
  provider: ApiProviderConfig,
  modelId: string
): boolean {
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  const modelPreset = getApiProviderModelPreset(providerId, modelId);
  if (!modelPreset) return false;
  provider.model = modelPreset.id;
  provider.modelSelection = "model";
  provider.toolCalling = modelPreset.toolCalling;
  provider.imageInput = modelPreset.imageInput;
  provider.reasoning = modelPreset.reasoning;
  provider.contextWindow = modelPreset.contextWindow;
  provider.maxOutputTokens = modelPreset.maxOutputTokens;
  return true;
}

export function activateApiProvider(
  settings: Pick<
    CodexForObsidianSettings,
    | "providerMode"
    | "activeApiProviderId"
    | "defaultModel"
  >,
  provider: ApiProviderConfig
): void {
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
  settings.defaultModel = provider.model;
}

export function clearApiProviderApiKey(
  settings: Pick<
    CodexForObsidianSettings,
    "providerMode" | "activeApiProviderId"
  >,
  provider: ApiProviderConfig
): void {
  provider.apiKey = "";
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
}

export function getApiProviderModels(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>): string[] {
  return normalizeModelList([...(provider.models ?? []), provider.model]);
}

export function providerModelLabel(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>, language: SettingsLanguage = "zh-CN"): string {
  const models = getApiProviderModels(provider);
  if (!models.length) return language === "en" ? "No model set" : "未设置模型";
  return models.length === 1 ? models[0] : language === "en" ? `${models[0]} + ${models.length - 1} more` : `${models[0]} 等 ${models.length} 个`;
}

export function sanitizeCredentialSettingsForDataSave(
  settings: CodexForObsidianSettings
): void {
  assertCredentialSettingsReadyForDataSave(settings);
  if (
    settings.proxyEndpoint
    || settings.proxyCredentialRef
  ) {
    settings.proxyUrl = "";
  }
}

export type CredentialSettingsPersistenceErrorCode =
  "proxy_credential_plaintext_unmigrated";

export class CredentialSettingsPersistenceError extends Error {
  constructor(readonly code: CredentialSettingsPersistenceErrorCode) {
    super(code);
    this.name = "CredentialSettingsPersistenceError";
  }
}

function assertCredentialSettingsReadyForDataSave(
  settings: CodexForObsidianSettings
): void {
  const proxyUrls = [settings.proxyUrl];
  const proxyEndpoints = [settings.proxyEndpoint];
  if (proxyEndpoints.some(proxyUrlContainsCredential)) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
  if (!proxyUrls.some(proxyUrlContainsCredential)) return;

  const topLevelCredentialRef = normalizeCredentialRef(
    settings.proxyCredentialRef
  );
  const topLevelEndpoint = normalizeOptionalText(settings.proxyEndpoint);
  if (
    !topLevelCredentialRef
    || !topLevelEndpoint
  ) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
}

function proxyUrlContainsCredential(value: unknown): boolean {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return false;
  if (
    raw !== raw.trim()
    || raw.includes("\\")
    || [...raw].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined
        && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
    ? raw
    : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new CredentialSettingsPersistenceError(
        "proxy_credential_plaintext_unmigrated"
      );
    }
    return (
      parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
    );
  } catch (error) {
    if (error instanceof CredentialSettingsPersistenceError) {
      throw error;
    }
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
}

export function validateApiProvider(provider: Pick<ApiProviderConfig,
  | "name"
  | "baseUrl"
  | "model"
  | "apiKey"
  | "apiProtocol"
  | "runtimeProviderId"
  | "contextWindow"
  | "maxOutputTokens"
> & Partial<Pick<ApiProviderConfig,
  "models" | "providerId"
>>, language: SettingsLanguage = "zh-CN"): string[] {
  const errors: string[] = [];
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  if (!provider.name.trim()) errors.push(language === "en" ? "Name is required" : "名称不能为空");
  if (!provider.baseUrl.trim()) errors.push(language === "en" ? "Base URL is required" : "Base URL 不能为空");
  if (provider.baseUrl.trim()) {
    try {
      normalizeApiProviderBaseUrl(
        provider.baseUrl,
        provider.apiProtocol
      );
    } catch {
      errors.push(language === "en" ? "API URL must use HTTPS or exact loopback HTTP" : "API URL 必须使用 HTTPS；本地仅允许精确 loopback HTTP 地址");
    }
  }
  if (
    providerId === "ollama"
    && provider.baseUrl.trim()
    && !isLoopbackApiProviderUrl(provider.baseUrl)
  ) {
    errors.push(language === "en"
      ? "Ollama must use an exact local loopback address"
      : "Ollama 只允许使用精确的本机 loopback 地址");
  }
  if (!isValidApiProviderModelId(provider.model)) {
    errors.push(language === "en"
      ? "Model ID is invalid"
      : "Model ID 无效");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(provider.runtimeProviderId)) {
    errors.push(language === "en" ? "Runtime Provider ID is invalid" : "Runtime Provider ID 无效");
  }
  if (!Number.isSafeInteger(provider.contextWindow) || provider.contextWindow < 1_024 || provider.contextWindow > 2_000_000) {
    errors.push(language === "en" ? "Input context is invalid" : "输入 Context 无效");
  }
  if (!Number.isSafeInteger(provider.maxOutputTokens) || provider.maxOutputTokens < 1 || provider.maxOutputTokens > Math.min(provider.contextWindow, 1_000_000)) {
    errors.push(language === "en" ? "Output context is invalid" : "输出 Context 无效");
  }
  if (
    apiProviderApiKeyRequired(providerId)
    && !provider.apiKey.trim()
  ) {
    errors.push(language === "en" ? "API key is required" : "API key 不能为空");
  }
  return errors;
}

export function isValidApiProviderModelId(value: unknown): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\s\p{Cc}]/u.test(value);
}

export function removeApiProvider(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, providerId: string): boolean {
  const index = settings.apiProviders.findIndex((provider) => provider.id === providerId);
  if (index < 0) return false;
  const wasActive = settings.activeApiProviderId === providerId;
  settings.apiProviders.splice(index, 1);
  if (wasActive) {
    const next = settings.apiProviders[Math.min(index, settings.apiProviders.length - 1)];
    settings.activeApiProviderId = next?.id ?? "";
    if (!next) settings.providerMode = "custom-api";
  }
  return true;
}

export function selectActiveConversationSession(
  settings: Pick<
    CodexForObsidianSettings,
    "sessions" | "activeSessionId"
  >
): StoredSession | null {
  const active = settings.sessions.find(
    (session) => session.id === settings.activeSessionId
  );
  if (active) return active;
  const fallback = settings.sessions[0] ?? null;
  settings.activeSessionId = fallback?.id ?? "";
  return fallback;
}

export function providerConnectionLabel(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, language: SettingsLanguage = "zh-CN"): string {
  const provider = getActiveApiProvider(settings);
  if (!provider) return language === "en" ? "Provider not configured" : "Provider 未配置";
  return `${provider.name} · ${providerModelLabel(provider, language)}`;
}

export function ensureModelChoices(models: CodexModel[], ...preferredModels: Array<string | null | undefined>): CodexModel[] {
  const seen = new Set(models.map((item) => item.model));
  const preferred: CodexModel[] = [];
  for (const value of preferredModels) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    preferred.push({ id: model, model, displayName: model });
  }
  return [...preferred, ...models];
}

export function normalizeWorkspaceResources(input: unknown): WorkspaceResourceToggles {
  const value = settingsRecord(input) ?? {};
  return {
    plugins: normalizeBooleanMap(value?.plugins),
    mcpServers: normalizeBooleanMap(value?.mcpServers),
    skills: normalizeBooleanMap(value?.skills)
  };
}

export function normalizeWorkspaceResourceCache(input: unknown): WorkspaceResourceCache {
  const value = settingsRecord(input) ?? {};
  return {
    ...(normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) ? { plugins: normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) } : {}),
    ...(normalizeCacheEntry(value?.mcp, normalizeCachedMcp) ? { mcp: normalizeCacheEntry(value?.mcp, normalizeCachedMcp) } : {}),
    ...(normalizeCacheEntry(value?.skills, normalizeCachedSkill) ? { skills: normalizeCacheEntry(value?.skills, normalizeCachedSkill) } : {})
  };
}

export function resourceEnabled(overrides: Record<string, boolean> | undefined, key: string, sourceEnabled = true): boolean {
  if (!key) return sourceEnabled;
  const override = overrides?.[key];
  return typeof override === "boolean" ? override : sourceEnabled;
}

export function hasResourceOverrides(overrides: Record<string, boolean> | undefined): boolean {
  return Boolean(overrides && Object.keys(overrides).length > 0);
}

export function filterEnabledSkills(skills: CodexSkill[], overrides: Record<string, boolean> | undefined): CodexSkill[] {
  return skills.filter((skill) => resourceEnabled(overrides, skill.path || skill.name, skill.enabled !== false));
}

export function getKnowledgeBaseRulesFileChoices(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const item of paths) {
    const raw = String(item ?? "").replace(/\\/g, "/").trim();
    if (raw.split("/").some((part) => part === "..")) continue;
    const clean = normalizeKnowledgeBaseRulesPath(item, "");
    if (!clean || !/\.md$/i.test(clean)) continue;
    seen.add(clean);
  }
  return Array.from(seen).sort((left, right) => {
    const byRank = rulesFileChoiceRank(left) - rulesFileChoiceRank(right);
    return byRank || left.localeCompare(right);
  });
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeResourceManagementTab(value: unknown): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeSettingsTab(value: unknown): SettingsTab {
  if (value === "agents") return "providers";
  return value === "providers"
    || value === "resources"
    || value === "knowledgeBase"
    || value === "review"
    || value === "general"
    ? value
    : DEFAULT_SETTINGS.settingsTab;
}

export function normalizeSettingsLanguage(value: unknown): SettingsLanguage {
  return value === "en" ? "en" : DEFAULT_SETTINGS.settingsLanguage;
}

function normalizeProviderMode(value: unknown): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
}

function normalizeKnowledgeBaseRunStatus(value: unknown): KnowledgeBaseRunStatus {
  return value === "running" || value === "success" || value === "failed" || value === "canceled" ? value : "idle";
}

function normalizeKnowledgeBaseInitStatus(value: unknown): KnowledgeBaseInitStatus {
  return value === "preview-ready" || value === "initialized" || value === "failed" ? value : "not-started";
}

function normalizeKnowledgeBaseRulesPath(value: unknown, fallback: string): string {
  const raw = normalizeText(value, fallback).replace(/\\/g, "/").trim();
  const withoutLeadingSlash = raw.replace(/^\/+/, "");
  const clean = withoutLeadingSlash
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function rulesFileChoiceRank(value: string): number {
  const upper = value.toUpperCase();
  if (upper === DEFAULT_KNOWLEDGE_BASE_RULES_FILE.toUpperCase()) return 0;
  if (upper === AGENTS_RULES_FILE.toUpperCase()) return 1;
  if (upper === LEGACY_CLAUDE_RULES_FILE.toUpperCase()) return 2;
  return value.includes("/") ? 3 : 2;
}

function normalizeEchoInkResourceSettings(value: unknown, legacyWorkspaceResources: unknown): EchoInkResourceSettings {
  void legacyWorkspaceResources;
  const record = settingsRecord(value) ?? {};
  const fallback = defaultResourceSettings();
  const enabledByScope = settingsRecord(record.enabledByScope) ?? {};
  const legacyOverrides = Object.values(enabledByScope)
    .map(normalizeBooleanMap);
  const importedFrom = settingsRecord(record.importedFrom);
  const catalog = Array.isArray(record.catalog)
    ? record.catalog.filter(isEchoInkResourceLike).map((resource) => {
        const legacyValues = legacyOverrides.flatMap((overrides) =>
          typeof overrides[resource.id] === "boolean" ? [overrides[resource.id]] : []);
        const enabled = legacyValues.includes(false)
          ? false
          : legacyValues.includes(true)
            ? true
            : resource.enabled !== false;
        const { scopes: _legacyScopes, ...current } = resource as EchoInkResourceSettings["catalog"][number] & { scopes?: unknown };
        return { ...current, enabled };
      })
    : [];
  const catalogIds = new Set(catalog.map((resource) => resource.id));
  const legacyEnabledOverrides = Object.fromEntries([
    ...Object.entries(normalizeBooleanMap(record.legacyEnabledOverrides)),
    ...legacyResourceDecisions(legacyOverrides)
  ].filter(([resourceId]) => !catalogIds.has(resourceId)));
  return {
    catalog,
    ...(Object.keys(legacyEnabledOverrides).length ? { legacyEnabledOverrides } : {}),
    importedFrom: importedFrom
      ? Object.fromEntries(Object.entries(importedFrom).map(([key, raw]) => [key, normalizeNonNegativeNumber(raw)]))
      : fallback.importedFrom,
    mcpConnections: normalizeMcpConnectionRecords(record.mcpConnections ?? fallback.mcpConnections),
    lastScannedAt: normalizeNonNegativeNumber(record.lastScannedAt),
    lastError: normalizeOptionalText(record.lastError)
  };
}

function legacyResourceDecisions(
  overrides: Array<Record<string, boolean>>
): Array<[string, boolean]> {
  const ids = new Set<string>();
  for (const values of overrides) {
    for (const resourceId of Object.keys(values)) ids.add(resourceId);
  }
  return Array.from(ids).map((resourceId) => {
    const values = overrides.flatMap((scope) =>
      typeof scope[resourceId] === "boolean" ? [scope[resourceId]] : []);
    return [resourceId, !values.includes(false) && values.includes(true)];
  });
}

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : fallback;
}

function normalizeServiceTierChoice(value: unknown, fallback: ServiceTierChoice): ServiceTierChoice {
  return value === "standard" || value === "fast" || value === "flex" ? value : fallback;
}

function normalizePermissionMode(value: unknown, fallback: PermissionMode): PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : fallback;
}

function normalizeUiMode(value: unknown, fallback: UiMode): UiMode {
  return value === "agent" || value === "plan" ? value : fallback;
}

function normalizeSetupSettings(input: unknown): SetupSettings {
  const value = settingsRecord(input) ?? {};
  return {
    completedAt: normalizeNonNegativeNumber(value?.completedAt),
    lastCheckedAt: normalizeNonNegativeNumber(value?.lastCheckedAt),
    dismissedVersion: normalizeOptionalText(value?.dismissedVersion),
    tutorialStep: value?.tutorialStep === "knowledge" || value?.tutorialStep === "personality"
      ? value.tutorialStep
      : "provider"
  };
}

function normalizeMemorySettings(input: unknown): EchoInkMemorySettings {
  const value = settingsRecord(input) ?? {};
  const runsPerDay = typeof value?.dreamRunsPerDay === "number" && Number.isSafeInteger(value.dreamRunsPerDay)
    ? Math.max(1, Math.min(6, value.dreamRunsPerDay))
    : 3;
  const tokenBudget = typeof value?.dreamTokenBudget === "number" && Number.isSafeInteger(value.dreamTokenBudget)
    ? Math.max(1000, Math.min(200000, value.dreamTokenBudget))
    : 50000;
  return {
    enabled: value?.enabled !== false,
    useLongTermMemory: value?.useLongTermMemory !== false,
    dreamEnabled: value?.dreamEnabled === true,
    dreamRunsPerDay: runsPerDay,
    dreamTokenBudget: tokenBudget
  };
}

function normalizeKnowledgeBaseSettings(input: unknown): KnowledgeBaseSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.knowledgeBase;
  const normalized: KnowledgeBaseSettings = {
    useCustomRulesFile: value?.useCustomRulesFile === true,
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    lastRunAt: normalizeNonNegativeNumber(value?.lastRunAt),
    lastRunStatus: normalizeKnowledgeBaseRunStatus(value?.lastRunStatus),
    lastReportPath: normalizeOptionalText(value?.lastReportPath),
    lastError: normalizeOptionalText(value?.lastError),
    lastSummary: normalizeOptionalText(value?.lastSummary),
    lastCompletion: normalizeKnowledgeBaseRunCompletion(value?.lastCompletion),
    lastPendingSources: normalizeKnowledgeBasePendingSources(value?.lastPendingSources),
    lastWarnings: normalizeKnowledgeBaseRunWarnings(value?.lastWarnings),
    initialization: normalizeKnowledgeBaseInitialization(value?.initialization),
    processedSources: normalizeKnowledgeBaseProcessedSources(value?.processedSources),
    healthHistory: normalizeKnowledgeBaseHealthHistory(value?.healthHistory),
    maintenanceHistory: normalizeKnowledgeBaseMaintenanceHistory(value?.maintenanceHistory)
  };
  return normalized;
}

function normalizeReviewSettings(input: unknown): WeeklyReviewSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.review;
  const outputDir = normalizeReviewOutputDir(value?.outputDir, fallback.outputDir);
  const reports = settingsRecord(value?.reports) ?? {};
  return {
    enabled: value?.enabled === true,
    knowledgeBaseEnabled: typeof value?.knowledgeBaseEnabled === "boolean" ? value.knowledgeBaseEnabled : fallback.knowledgeBaseEnabled,
    agentChatEnabled: typeof value?.agentChatEnabled === "boolean" ? value.agentChatEnabled : fallback.agentChatEnabled,
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    outputDir,
    rangeMode: normalizeReviewRangeMode(value?.rangeMode, fallback.rangeMode),
    openHtmlAfterRun: value?.openHtmlAfterRun === true,
    reports: {
      knowledgeBase: normalizeReviewReportState(reports.knowledgeBase),
      agentChat: normalizeReviewReportState(reports.agentChat)
    }
  };
}

function normalizeReviewReportState(input: unknown): ReviewReportState {
  const value = settingsRecord(input) ?? {};
  return {
    lastRangeKey: normalizeReviewRangeKey(value?.lastRangeKey)
  };
}

function normalizeReviewRangeMode(value: unknown, fallback: ReviewRangeMode): ReviewRangeMode {
  return value === "current-week" || value === "previous-week" ? value : fallback;
}

function normalizeReviewRangeKey(value: unknown): string {
  const text = normalizeOptionalText(value);
  return /^\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function normalizeReviewOutputDir(value: unknown, fallback = DEFAULT_REVIEW_OUTPUT_DIR): string {
  const raw = normalizeText(value, fallback).replace(/\\/g, "/").replace(/^\/+/, "");
  if (raw === ".") return ".";
  const clean = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function normalizeKnowledgeBaseInitialization(input: unknown): KnowledgeBaseInitializationSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.knowledgeBase.initialization;
  return {
    status: normalizeKnowledgeBaseInitStatus(value?.status),
    initializedAt: normalizeNonNegativeNumber(value?.initializedAt),
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    templateVersion: normalizeText(value?.templateVersion, fallback.templateVersion),
    lastPreviewSummary: normalizeOptionalText(value?.lastPreviewSummary)
  };
}

function normalizeStoredSessions(value: unknown): StoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rawSession: unknown): StoredSession | null => {
      const session = settingsRecord(rawSession) ?? {};
      if (session.kind === "knowledge-base") return null;
      const id = normalizeOptionalText(session.id);
      if (!id) return null;
      const messages = normalizeChatMessages(session.messages);
      const piSessionId = normalizeOptionalText(session.piSessionId) || undefined;
      const parsedContextLedger = parsePiContextLedger(session.contextLedger);
      const contextLedger = parsedContextLedger
        && parsedContextLedger.conversationId === id
        && (!piSessionId || parsedContextLedger.piSessionId === piSessionId)
        ? parsedContextLedger
        : undefined;
      return {
        id,
        title: normalizeText(session.title, "新会话"),
        piSessionId,
        defaultMemoryMode: normalizeStoredSessionMemoryMode(session.defaultMemoryMode),
        bodyAuthority: normalizeStoredSessionBodyAuthority(session.bodyAuthority),
        cwd: normalizeOptionalText(session.cwd),
        messages,
        tokenUsage: session.tokenUsage as TokenUsage,
        contextLedger,
        createdAt: normalizeNonNegativeNumber(session.createdAt),
        updatedAt: normalizeNonNegativeNumber(session.updatedAt)
      };
    })
    .filter((session): session is StoredSession => Boolean(session));
}

function normalizeStoredSessionMemoryMode(
  value: unknown
): StoredSession["defaultMemoryMode"] {
  return value === "normal" || value === "no_memory" ? value : undefined;
}

function normalizeStoredSessionBodyAuthority(
  value: unknown
): StoredSession["bodyAuthority"] {
  return value === "pi_session_only" ? value : undefined;
}

function normalizeChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw: unknown): ChatMessage | null => {
      const item = settingsRecord(raw);
      if (!item) return null;
      const id = normalizeOptionalText(item.id);
      const role = normalizeChatMessageRole(item.role);
      if (!id || !role) return null;
      const message = { ...item, id, role } as unknown as ChatMessage;
      message.text = typeof item.text === "string" ? item.text : "";
      assignOptionalText(message, "backendId", item.backendId);
      assignOptionalText(message, "providerId", item.providerId ?? item.provider);
      assignOptionalText(message, "modelId", item.modelId ?? item.model);
      assignOptionalText(message, "profileId", item.profileId ?? item.profile);
      message.runTerminalRecoveryPending = normalizeRunTerminalRecoveryPending(item.runTerminalRecoveryPending);
      message.echoInkRunTerminalRecovery = normalizeEchoInkChatRunTerminalRecovery(
        item.echoInkRunTerminalRecovery
      );
      if (!message.echoInkRunTerminalRecovery) {
        delete message.echoInkRunTerminalRecovery;
      }
      if (typeof item.runTerminalRecovered === "boolean") message.runTerminalRecovered = item.runTerminalRecovered;
      else delete message.runTerminalRecovered;
      message.runUsage = normalizeHarnessRunUsage(item.runUsage);
      if (!message.runUsage) delete message.runUsage;
      try {
        message.taskPlan = normalizeEchoInkTaskPlanSnapshot(item.taskPlan);
      } catch {
        delete message.taskPlan;
      }
      message.createdAt = normalizeNonNegativeNumber(item.createdAt);
      message.completedAt = normalizeOptionalPositiveNumber(item.completedAt);
      return message;
    })
    .filter((message): message is ChatMessage => Boolean(message));
}

function assignOptionalText<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const normalized = normalizeOptionalText(value);
  if (normalized) target[key] = normalized as T[K];
  else delete target[key];
}

function normalizeChatMessageRole(value: unknown): ChatMessage["role"] | null {
  return value === "user" || value === "assistant" || value === "system" || value === "tool" ? value : null;
}

function normalizeRunTerminalRecoveryPending(value: unknown): ChatMessage["runTerminalRecoveryPending"] {
  return value === "completed" || value === "cancelled" || value === "failed"
    ? value
    : undefined;
}

function normalizeEchoInkChatRunTerminalRecovery(
  value: unknown
): ChatMessage["echoInkRunTerminalRecovery"] {
  const marker = settingsRecord(value);
  if (
    !marker
    || marker.namespace !== "echoink.chat-terminal"
    || marker.schemaVersion !== 1
  ) {
    return undefined;
  }
  const runId = normalizeOptionalText(marker.runId);
  const status = normalizeRunTerminalRecoveryPending(marker.status);
  const payloadHash = normalizeOptionalText(marker.payloadHash);
  const terminalCommitId = normalizeOptionalText(marker.terminalCommitId);
  const carrierMessageId = normalizeOptionalText(marker.carrierMessageId);
  const payloadSource = normalizeEchoInkChatTerminalPayloadSource(
    marker.payloadSource
  );
  if (
    !runId
    || !status
    || !payloadHash
    || !terminalCommitId
    || !carrierMessageId
    || !payloadSource
    || typeof marker.payloadPresent !== "boolean"
  ) {
    return undefined;
  }
  const backendId = normalizeOptionalText(marker.backendId);
  const data = marker.data === undefined
    ? undefined
    : settingsRecord(marker.data) ?? undefined;
  if (marker.data !== undefined && !data) return undefined;
  return {
    namespace: "echoink.chat-terminal",
    schemaVersion: 1,
    runId,
    status,
    ...(backendId ? { backendId } : {}),
    ...(data ? { data } : {}),
    payloadPresent: marker.payloadPresent,
    payloadHash,
    terminalCommitId,
    carrierMessageId,
    payloadSource
  };
}

function normalizeEchoInkChatTerminalPayloadSource(
  value: unknown
): EchoInkChatTerminalPayloadSource | undefined {
  const source = settingsRecord(value);
  if (!source) return undefined;
  const contentHash = normalizeOptionalText(source.contentHash);
  const size = normalizeOptionalNonNegativeInteger(source.size);
  const lines = normalizeOptionalNonNegativeInteger(source.lines);
  if (!contentHash || size === undefined || lines === undefined) {
    return undefined;
  }
  if (source.kind === "inline" && typeof source.value === "string") {
    return {
      kind: "inline",
      value: source.value,
      contentHash,
      size,
      lines
    };
  }
  const rawRef = normalizeOptionalText(source.rawRef);
  const previewHash = normalizeOptionalText(source.previewHash);
  if (source.kind !== "raw" || !rawRef || !previewHash) return undefined;
  return {
    kind: "raw",
    rawRef,
    contentHash,
    previewHash,
    size,
    lines
  };
}

function normalizeOptionalNonNegativeInteger(
  value: unknown
): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function normalizeOptionalPositiveNumber(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeNumber(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeKnowledgeBaseProcessedSources(value: unknown): Record<string, KnowledgeBaseProcessedSource> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([key, item]: [string, unknown]) => {
      const record = settingsRecord(item) ?? {};
      const path = normalizeOptionalText(record.path || key);
      if (!path) return null;
      const fingerprint = normalizeOptionalText(record.fingerprint);
      const source: KnowledgeBaseProcessedSource = {
        path,
        size: normalizeNonNegativeNumber(record.size),
        mtime: normalizeNonNegativeNumber(record.mtime),
        digestedAt: normalizeNonNegativeNumber(record.digestedAt)
      };
      if (fingerprint) source.fingerprint = fingerprint;
      const reportPath = normalizeOptionalText(record.reportPath);
      if (reportPath) source.reportPath = reportPath;
      const evidencePaths = Array.isArray(record.evidencePaths)
        ? record.evidencePaths.map(normalizeOptionalText).filter(Boolean)
        : [];
      if (evidencePaths.length) source.evidencePaths = evidencePaths;
      const runId = normalizeOptionalText(record.runId);
      if (runId) source.runId = runId;
      if (record.confidence === "verified" || record.confidence === "repaired") source.confidence = record.confidence;
      return [
        path,
        source
      ] as const;
    })
    .filter((item): item is readonly [string, KnowledgeBaseProcessedSource] => Boolean(item))
    .sort((left, right) => right[1].digestedAt - left[1].digestedAt)
    .slice(0, 1000);
  return Object.fromEntries(entries);
}

function normalizeKnowledgeBaseHealthHistory(value: unknown): KnowledgeBaseHealthHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, KnowledgeBaseHealthHistoryEntry>();
  for (const item of value) {
    const record = settingsRecord(item) ?? {};
    const date = normalizeOptionalText(record.date);
    const status = normalizeKnowledgeBaseHealthCheckStatus(record.status);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) continue;
    byDate.set(date, {
      date,
      status,
      at: normalizeNonNegativeNumber(record.at)
    });
  }
  return Array.from(byDate.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-90);
}

const KNOWLEDGE_BASE_RESULT_MAX_PENDING_SOURCES = 50;
const KNOWLEDGE_BASE_RESULT_MAX_WARNINGS = 10;
const KNOWLEDGE_BASE_RESULT_MAX_MESSAGE_CHARS = 500;
const KNOWLEDGE_BASE_MAINTENANCE_HISTORY_MAX = 500;
const KNOWLEDGE_BASE_WORKFLOW_ID_MAX_CHARS = 512;

export function canonicalizeKnowledgeBaseMaintenanceHistoryEntry(
  value: unknown,
  legacyMode: KnowledgeBaseMaintenanceMode = "unknown"
): KnowledgeBaseMaintenanceHistoryEntry | null {
  const record = settingsRecord(value) ?? {};
  const date = normalizeOptionalText(record.date);
  const status = normalizeKnowledgeBaseMaintenanceTerminalStatus(record.status);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) return null;
  const at = normalizeNonNegativeNumber(record.at);
  const runId = normalizeLimitedText(
    record.runId,
    KNOWLEDGE_BASE_WORKFLOW_ID_MAX_CHARS
  );
  const mode = normalizeKnowledgeBaseMaintenanceMode(record.mode) ?? legacyMode;
  const reportPath = normalizeOptionalText(record.reportPath);
  const completion = normalizeKnowledgeBaseRunCompletion(record.completion);
  const pendingSources = normalizeKnowledgeBasePendingSources(record.pendingSources);
  const phase = normalizeLimitedText(record.phase, 160);
  const errorCode = normalizeLimitedText(record.errorCode, 160);
  const warnings = normalizeKnowledgeBaseRunWarnings(record.warnings);
  return {
    date,
    status,
    at,
    ...(runId ? { runId } : {}),
    mode,
    reportPath,
    ...(completion ? { completion } : {}),
    ...(pendingSources.length ? { pendingSources } : {}),
    ...(phase ? { phase } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(warnings.length ? { warnings } : {})
  };
}

function normalizeKnowledgeBaseMaintenanceHistory(value: unknown, legacyHealthHistory?: unknown): KnowledgeBaseMaintenanceHistoryEntry[] {
  const byRun = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
  const add = (item: unknown, legacyMode: KnowledgeBaseMaintenanceMode): void => {
    const normalized =
      canonicalizeKnowledgeBaseMaintenanceHistoryEntry(item, legacyMode);
    if (!normalized) return;
    const key = normalized.runId || [
      normalized.date,
      normalized.at,
      normalized.mode,
      normalized.status,
      normalized.reportPath
    ].join("\u0000");
    byRun.set(key, normalized);
  };
  if (Array.isArray(value)) {
    for (const item of value) add(item, "unknown");
  }
  if (Array.isArray(legacyHealthHistory)) {
    const representedDates = new Set(Array.from(byRun.values()).map((entry) => entry.date));
    for (const item of legacyHealthHistory) {
      const record = settingsRecord(item) ?? {};
      const date = normalizeOptionalText(record.date);
      if (!representedDates.has(date)) add(item, "lint");
    }
  }
  return Array.from(byRun.values())
    .sort((left, right) =>
      left.at - right.at
      || left.date.localeCompare(right.date)
      || (left.runId ?? "").localeCompare(right.runId ?? ""))
    .slice(-KNOWLEDGE_BASE_MAINTENANCE_HISTORY_MAX);
}

function normalizeKnowledgeBaseMaintenanceTerminalStatus(value: unknown): KnowledgeBaseMaintenanceTerminalStatus | "" {
  return value === "success" || value === "failed" || value === "canceled" ? value : "";
}

function normalizeKnowledgeBaseRunCompletion(value: unknown): KnowledgeBaseRunCompletion | "" {
  return value === "full" || value === "partial" || value === "recovered" || value === "noop" ? value : "";
}

function normalizeKnowledgeBasePendingSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const source = normalizeLimitedText(item, 1000).replace(/\\/g, "/");
    if (!source || seen.has(source)) continue;
    seen.add(source);
    result.push(source);
    if (result.length >= KNOWLEDGE_BASE_RESULT_MAX_PENDING_SOURCES) break;
  }
  return result;
}

function normalizeKnowledgeBaseRunWarnings(value: unknown): KnowledgeBaseRunWarning[] {
  if (!Array.isArray(value)) return [];
  const result: KnowledgeBaseRunWarning[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = settingsRecord(value[index]);
    const message = normalizeLimitedText(record?.message ?? value[index], KNOWLEDGE_BASE_RESULT_MAX_MESSAGE_CHARS);
    if (!message) continue;
    const id = normalizeLimitedText(record?.id, 160) || `warning-${index + 1}`;
    result.push({ id, message });
    if (result.length >= KNOWLEDGE_BASE_RESULT_MAX_WARNINGS) break;
  }
  return result;
}

function normalizeLimitedText(value: unknown, maxChars: number): string {
  return normalizeOptionalText(value).slice(0, maxChars);
}

function normalizeKnowledgeBaseHealthCheckStatus(value: unknown): KnowledgeBaseHealthCheckStatus | null {
  return value === "success" || value === "failed" ? value : null;
}

function normalizeKnowledgeBaseMaintenanceMode(value: unknown): KnowledgeBaseMaintenanceMode | null {
  return value === "maintain" || value === "lint" || value === "reingest" || value === "outputs" || value === "inbox" || value === "unknown" ? value : null;
}

export function recordKnowledgeBaseHealthCheck(settings: KnowledgeBaseSettings, status: KnowledgeBaseHealthCheckStatus, at = Date.now()): void {
  const date = formatLocalDateKey(at);
  settings.healthHistory = normalizeKnowledgeBaseHealthHistory([
    ...(settings.healthHistory ?? []).filter((entry) => entry.date !== date),
    { date, status, at }
  ]);
}

export function recordKnowledgeBaseMaintenanceRun(
  settings: KnowledgeBaseSettings,
  input: {
    status: KnowledgeBaseMaintenanceTerminalStatus;
    mode: KnowledgeBaseMaintenanceMode;
    at?: number;
    runId?: string;
    reportPath?: string;
    completion?: KnowledgeBaseRunCompletion;
    pendingSources?: string[];
    phase?: string;
    errorCode?: string;
    warnings?: KnowledgeBaseRunWarning[];
  }
): void {
  const at = input.at ?? Date.now();
  const date = formatLocalDateKey(at);
  const entry = canonicalizeKnowledgeBaseMaintenanceHistoryEntry({
    ...input,
    date,
    at,
    reportPath: input.reportPath ?? ""
  });
  if (!entry) {
    throw new Error("知识库维护历史终态无法规范化");
  }
  settings.lastCompletion = entry.completion ?? "";
  settings.lastPendingSources = entry.pendingSources ?? [];
  settings.lastWarnings = entry.warnings ?? [];
  settings.maintenanceHistory = normalizeKnowledgeBaseMaintenanceHistory([
    ...(settings.maintenanceHistory ?? []),
    entry
  ], settings.healthHistory);
  if (input.mode === "lint" && input.status !== "canceled") {
    recordKnowledgeBaseHealthCheck(settings, input.status, at);
  }
}

function formatLocalDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeScheduleTime(value: unknown, fallback: string): string {
  const text = normalizeOptionalText(value);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComparablePath(value: unknown): string {
  return normalizeOptionalText(value)
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeNonNegativeNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function normalizeApiProviderSelection(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">): void {
  const active = getActiveApiProvider(settings);
  settings.providerMode = "custom-api";
  if (active && apiProviderHasUsableApiKey(active)) return;
  const first = settings.apiProviders.find(apiProviderHasUsableApiKey);
  settings.activeApiProviderId = first?.id ?? "";
}

function normalizeApiProviders(value: unknown): ApiProviderConfig[] {
  if (!Array.isArray(value)) {
    return [createDefaultApiProvider()];
  }
  if (value.length === 0) return [];
  const usedIds = new Set<string>();
  return value.map((item, index) => {
    const record = settingsRecord(item) ?? {};
    const id = uniqueProviderId(sanitizeProviderId(record.id, index), usedIds, index);
    usedIds.add(id);
    const queryParams = normalizeQueryParams(record.queryParams);
    const storedModels: unknown[] = Array.isArray(record.models)
      ? record.models
      : [];
    const models = normalizeModelList([
      ...storedModels,
      record.model
    ]);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    const providerId = normalizeApiProviderId(
      record.providerId,
      baseUrl,
      name
    );
    const preset = getApiProviderPreset(providerId);
    const selectedModel = models[0] ?? preset.model;
    const modelPreset = getApiProviderModelPreset(
      providerId,
      selectedModel
    );
    return {
      id,
      providerId,
      runtimeProviderId: normalizeRuntimeProviderId(
        record.runtimeProviderId,
        providerId === "custom"
          ? preset.runtimeProviderId
          : providerId === "openai"
            || providerId === "anthropic"
            || providerId === "qwen"
            ? providerId
            : preset.runtimeProviderId
      ),
      apiProtocol: normalizeApiProviderProtocol(
        record.apiProtocol,
        providerId
      ),
      name: name || preset.name,
      baseUrl: baseUrl || preset.baseUrl,
      model: selectedModel,
      models: normalizeModelList([
        ...models,
        ...preset.models.map((model) => model.id)
      ]),
      modelSelection: record.modelSelection === "auto"
        ? "auto"
        : "model",
      toolCalling: typeof record.toolCalling === "boolean"
        ? record.toolCalling
        : modelPreset?.toolCalling ?? true,
      imageInput: typeof record.imageInput === "boolean"
        ? record.imageInput
        : modelPreset?.imageInput ?? false,
      reasoning: typeof record.reasoning === "boolean"
        ? record.reasoning
        : modelPreset?.reasoning ?? false,
      contextWindow: normalizePositiveInteger(
        record.contextWindow,
        modelPreset?.contextWindow ?? 64_000,
        1_024,
        2_000_000
      ),
      maxOutputTokens: normalizeApiProviderMaxOutputTokens({
        storedValue: record.maxOutputTokens,
        providerId,
        modelPreset
      }),
      apiKey: typeof record.apiKey === "string"
        ? record.apiKey.trim()
        : "",
      ...(Object.keys(queryParams).length ? { queryParams } : {})
    };
  });
}

function normalizeApiProviderMaxOutputTokens(input: Readonly<{
  storedValue: unknown;
  providerId: ApiProviderId;
  modelPreset: ReturnType<typeof getApiProviderModelPreset>;
}>): number {
  const normalized = normalizePositiveInteger(
    input.storedValue,
    input.modelPreset?.maxOutputTokens ?? 8_192,
    1,
    1_000_000
  );
  // v44's exact 256K Kimi preset value is migrated to 64K. Lower user limits
  // remain valid, while no Kimi request may exceed the product ceiling.
  return apiProviderMaxOutputReserve(
    input.providerId,
    input.modelPreset?.id ?? "",
    normalized
  );
}

function createDefaultApiProvider(): ApiProviderConfig {
  const preset = getApiProviderPreset("deepseek");
  const modelPreset = preset.models[0];
  return {
    id: "provider-default",
    providerId: preset.id,
    runtimeProviderId: preset.runtimeProviderId,
    apiProtocol: preset.apiProtocol,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.model,
    models: preset.models.map((model) => model.id),
    modelSelection: "auto",
    toolCalling: modelPreset.toolCalling,
    imageInput: modelPreset.imageInput,
    reasoning: modelPreset.reasoning,
    contextWindow: modelPreset.contextWindow,
    maxOutputTokens: modelPreset.maxOutputTokens,
    apiKey: ""
  };
}

function normalizeRuntimeProviderId(
  value: unknown,
  fallback: string
): string {
  const providerId = normalizeOptionalText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(providerId)
    ? providerId
    : fallback;
}

function normalizeCredentialRef(value: unknown): string {
  const credentialRef = normalizeOptionalText(value);
  return /^cred-[a-f0-9]{32}$/u.test(credentialRef)
    ? credentialRef
    : "";
}

function normalizeModelList(value: unknown[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    const model = typeof item === "string" ? item.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function sanitizeProviderId(value: unknown, index: number): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `provider_${index + 1}`;
}

function uniqueProviderId(id: string, usedIds: Set<string>, index: number): string {
  if (!usedIds.has(id)) return id;
  let next = `provider_${index + 1}`;
  let suffix = 2;
  while (usedIds.has(next)) {
    next = `provider_${index + 1}_${suffix}`;
    suffix += 1;
  }
  return next;
}

function normalizeQueryParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const stringValue = typeof raw === "string" ? raw.trim() : "";
    if (stringValue) result[key] = stringValue;
  }
  return result;
}

function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key === "string" && key.trim() && typeof enabled === "boolean") result[key] = enabled;
  }
  return result;
}

function normalizeCacheEntry<T>(value: unknown, normalizeItem: (item: unknown) => T | null): WorkspaceResourceCacheEntry<T> | undefined {
  const record = settingsRecord(value);
  if (!record || !Array.isArray(record.items)) return undefined;
  const items = record.items.map(normalizeItem).filter((item): item is T => Boolean(item));
  const fetchedAt = typeof record.fetchedAt === "number" && Number.isFinite(record.fetchedAt) ? record.fetchedAt : Date.now();
  const error = typeof record.error === "string" && record.error.trim() ? record.error : "";
  return { fetchedAt, items, ...(error ? { error } : {}) };
}

function normalizeCachedPlugin(item: unknown): CodexPluginInfo | null {
  const value = settingsRecord(item) ?? {};
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof value.name === "string" ? value.name : id,
    displayName: typeof value.displayName === "string" ? value.displayName : id,
    description: typeof value.description === "string" ? value.description : "",
    marketplace: typeof value.marketplace === "string" ? value.marketplace : "",
    category: typeof value.category === "string" ? value.category : "",
    installed: value.installed !== false,
    enabled: value.enabled !== false
  };
}

function normalizeCachedSkill(item: unknown): CodexSkill | null {
  const value = settingsRecord(item) ?? {};
  const name = typeof value.name === "string" ? value.name : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!name || !path) return null;
  return {
    name,
    path,
    description: typeof value.description === "string" ? value.description : "",
    scope: typeof value.scope === "string" ? value.scope : "",
    enabled: value.enabled !== false
  };
}

function normalizeCachedMcp(item: unknown): McpServerStatus | null {
  const value = settingsRecord(item) ?? {};
  const name = typeof value.name === "string" ? value.name : "";
  if (!name) return null;
  return {
    name,
    tools: settingsRecord(value.tools) ?? {},
    resources: Array.isArray(value.resources) ? value.resources : [],
    resourceTemplates: Array.isArray(value.resourceTemplates) ? value.resourceTemplates : [],
    authStatus: typeof value.authStatus === "string" ? value.authStatus : "unknown"
  };
}

function isEchoInkResourceLike(value: unknown): value is EchoInkResourceSettings["catalog"][number] {
  const record = settingsRecord(value);
  return typeof record?.id === "string";
}

function settingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
