import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
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
  diffSummary?: DiffSummary;
  attachments?: StoredAttachment[];
  files?: ProcessFileRef[];
  images?: StoredAttachment[];
  createdAt: number;
}

export interface StoredSession {
  id: string;
  title: string;
  threadId?: string;
  cwd: string;
  messages: ChatMessage[];
  tokenUsage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type ResourceManagementTab = "plugins" | "mcp" | "skills";

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
  settingsVersion: number;
  cliPath: string;
  proxyEnabled: boolean;
  proxyUrl: string;
  mcpEnabled: boolean;
  defaultModel: string;
  defaultReasoning: ReasoningEffort;
  defaultServiceTier: ServiceTierChoice;
  defaultPermission: PermissionMode;
  defaultMode: UiMode;
  autoOpen: boolean;
  showContext: boolean;
  resourceManagementTab: ResourceManagementTab;
  workspaceResources: WorkspaceResourceToggles;
  workspaceResourceCache: WorkspaceResourceCache;
  sessions: StoredSession[];
  activeSessionId: string;
}

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  settingsVersion: 5,
  cliPath: "",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  mcpEnabled: false,
  defaultModel: "gpt-5.5",
  defaultReasoning: "high",
  defaultServiceTier: "fast",
  defaultPermission: "workspace-write",
  defaultMode: "agent",
  autoOpen: false,
  showContext: true,
  resourceManagementTab: "plugins",
  workspaceResources: {
    plugins: {},
    mcpServers: {},
    skills: {}
  },
  workspaceResourceCache: {},
  sessions: [],
  activeSessionId: ""
};

export function normalizeSettingsData(data: any): { settings: CodexForObsidianSettings; changed: boolean } {
  const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
  const settings: CodexForObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    activeSessionId: typeof data?.activeSessionId === "string" ? data.activeSessionId : ""
  };

  if (previousVersion < 1) {
    if (!data?.defaultModel) settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    if (data?.defaultReasoning === "high") settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    if (data?.defaultServiceTier === "standard") settings.defaultServiceTier = DEFAULT_SETTINGS.defaultServiceTier;
    settings.proxyEnabled = data?.proxyEnabled !== false;
    settings.proxyUrl = typeof data?.proxyUrl === "string" && data.proxyUrl.trim() ? data.proxyUrl.trim() : DEFAULT_SETTINGS.proxyUrl;
    settings.mcpEnabled = data?.mcpEnabled === true;
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

  settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  return { settings, changed: previousVersion !== DEFAULT_SETTINGS.settingsVersion };
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

export function normalizeWorkspaceResources(value: any): WorkspaceResourceToggles {
  return {
    plugins: normalizeBooleanMap(value?.plugins),
    mcpServers: normalizeBooleanMap(value?.mcpServers),
    skills: normalizeBooleanMap(value?.skills)
  };
}

export function normalizeWorkspaceResourceCache(value: any): WorkspaceResourceCache {
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

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeResourceManagementTab(value: any): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeBooleanMap(value: any): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key === "string" && key.trim() && typeof enabled === "boolean") result[key] = enabled;
  }
  return result;
}

function normalizeCacheEntry<T>(value: any, normalizeItem: (item: any) => T | null): WorkspaceResourceCacheEntry<T> | undefined {
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) return undefined;
  const items = value.items.map(normalizeItem).filter((item): item is T => Boolean(item));
  const fetchedAt = typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : Date.now();
  const error = typeof value.error === "string" && value.error.trim() ? value.error : "";
  return { fetchedAt, items, ...(error ? { error } : {}) };
}

function normalizeCachedPlugin(item: any): CodexPluginInfo | null {
  const id = typeof item?.id === "string" ? item.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof item?.name === "string" ? item.name : id,
    displayName: typeof item?.displayName === "string" ? item.displayName : id,
    description: typeof item?.description === "string" ? item.description : "",
    marketplace: typeof item?.marketplace === "string" ? item.marketplace : "",
    category: typeof item?.category === "string" ? item.category : "",
    installed: item?.installed !== false,
    enabled: item?.enabled !== false
  };
}

function normalizeCachedSkill(item: any): CodexSkill | null {
  const name = typeof item?.name === "string" ? item.name : "";
  const path = typeof item?.path === "string" ? item.path : "";
  if (!name || !path) return null;
  return {
    name,
    path,
    description: typeof item?.description === "string" ? item.description : "",
    scope: typeof item?.scope === "string" ? item.scope : "",
    enabled: item?.enabled !== false
  };
}

function normalizeCachedMcp(item: any): McpServerStatus | null {
  const name = typeof item?.name === "string" ? item.name : "";
  if (!name) return null;
  return {
    name,
    tools: item?.tools && typeof item.tools === "object" && !Array.isArray(item.tools) ? item.tools : {},
    resources: Array.isArray(item?.resources) ? item.resources : [],
    resourceTemplates: Array.isArray(item?.resourceTemplates) ? item.resourceTemplates : [],
    authStatus: typeof item?.authStatus === "string" ? item.authStatus : "unknown"
  };
}
