export const API_PROVIDER_IDS = [
  "glm",
  "kimi",
  "minimax",
  "deepseek",
  "ollama",
  "custom",
  // Compatibility-only identities. They remain readable so an existing
  // saved configuration is never destroyed by a settings migration, but they
  // are not rendered as new product presets.
  "openai",
  "anthropic",
  "qwen"
] as const;

export type ApiProviderId = typeof API_PROVIDER_IDS[number];

export const API_PROVIDER_PROTOCOLS = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages"
] as const;

export type ApiProviderProtocol =
  typeof API_PROVIDER_PROTOCOLS[number];

const KIMI_K2_CONTEXT_WINDOW = 262_144;
const KIMI_MAX_OUTPUT_RESERVE = 65_536;

export interface ApiProviderModelPreset {
  readonly id: string;
  /** A human-readable product name when the provider publishes one. */
  readonly displayName?: string;
  readonly contextWindow: number;
  /** Provider-published model capability retained in Pi model metadata. */
  readonly modelMaxTokens: number;
  /** EchoInk's actual per-request output ceiling and input-budget reserve. */
  readonly maxOutputTokens: number;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
}

export interface ApiProviderPreset {
  readonly id: Extract<ApiProviderId,
    "glm" | "kimi" | "minimax" | "deepseek" | "ollama" | "custom">;
  readonly name: string;
  readonly runtimeProviderId: string;
  readonly baseUrl: string;
  readonly docsUrl: string;
  readonly model: string;
  readonly models: readonly ApiProviderModelPreset[];
  readonly apiProtocol: ApiProviderProtocol;
  readonly apiKeyRequired: boolean;
  readonly modelDiscovery: "supported" | "provider_dependent";
}

/**
 * Product presets supported by the pinned Pi 0.82.1 runtime.
 *
 * Base URLs are Pi model base URLs. Endpoint suffixes are appended only by
 * apiProviderRequestUrl(), so the UI and runtime can never double-append
 * /chat/completions or /v1/messages.
 */
export const API_PROVIDER_PRESETS: readonly ApiProviderPreset[] =
  Object.freeze([
    preset({
      id: "glm",
      name: "智谱开放平台 / GLM API",
      runtimeProviderId: "zai-coding-cn",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: [
        model("glm-4.7", 204_800, 131_072, true, false, true),
        model("glm-5-turbo", 200_000, 131_072, true, false, true),
        model("glm-5v-turbo", 200_000, 131_072, true, true, true)
      ]
    }),
    preset({
      id: "kimi",
      name: "Kimi 中国版 / Kimi China",
      runtimeProviderId: "moonshotai-cn",
      baseUrl: "https://api.moonshot.cn/v1",
      docsUrl: "https://platform.moonshot.cn/docs/guide/start-using-kimi-api",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      models: [
        model("kimi-k2.5", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, true, true, undefined, KIMI_K2_CONTEXT_WINDOW),
        model("kimi-k2-thinking", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, false, true, undefined, KIMI_K2_CONTEXT_WINDOW),
        model("kimi-k2-turbo-preview", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, false, false, undefined, KIMI_K2_CONTEXT_WINDOW)
      ]
    }),
    preset({
      id: "minimax",
      name: "MiniMax 中国版 / MiniMax China",
      runtimeProviderId: "minimax-cn",
      baseUrl: "https://api.minimaxi.com/anthropic",
      docsUrl: "https://platform.minimaxi.com/document/Guides",
      apiProtocol: "anthropic-messages",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: [
        model("MiniMax-M2.7", 204_800, 131_072, true, false, true),
        model("MiniMax-M2.7-highspeed", 204_800, 131_072, true, false, true),
        model("MiniMax-M3", 1_000_000, 128_000, true, true, true)
      ]
    }),
    preset({
      id: "deepseek",
      name: "深度求索 / DeepSeek",
      runtimeProviderId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      docsUrl: "https://api-docs.deepseek.com/",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      models: [
        model("deepseek-v4-flash", 1_000_000, 384_000, true, false, true, "DeepSeek-V4 Flash"),
        model("deepseek-v4-pro", 1_000_000, 384_000, true, false, true, "DeepSeek-V4 Pro")
      ]
    }),
    preset({
      id: "ollama",
      name: "Ollama 本地 / Ollama",
      runtimeProviderId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      docsUrl: "https://docs.ollama.com/api/openai-compatibility",
      apiProtocol: "openai-completions",
      apiKeyRequired: false,
      modelDiscovery: "supported",
      models: [
        model("qwen2.5:7b", 32_768, 8_192, true, false, false),
        model("llama3.2", 131_072, 8_192, true, false, false)
      ]
    }),
    preset({
      id: "custom",
      name: "自定义 / Custom",
      runtimeProviderId: "echoink-custom",
      baseUrl: "",
      docsUrl: "",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: []
    })
  ]);

export function getApiProviderPreset(
  providerId: ApiProviderId
): ApiProviderPreset {
  return API_PROVIDER_PRESETS.find((preset) => preset.id === providerId)
    ?? API_PROVIDER_PRESETS[API_PROVIDER_PRESETS.length - 1];
}

export function getApiProviderModelPreset(
  providerId: ApiProviderId,
  modelId: string
): ApiProviderModelPreset | null {
  const preset = getApiProviderPreset(providerId);
  return preset.models.find((model) => model.id === modelId) ?? null;
}

export function apiProviderModelMaxTokens(
  providerId: ApiProviderId,
  modelId: string,
  fallback: number
): number {
  return getApiProviderModelPreset(providerId, modelId)?.modelMaxTokens
    ?? fallback;
}

export function apiProviderMaxOutputReserve(
  providerId: ApiProviderId,
  modelId: string,
  configuredLimit: number
): number {
  const preset = getApiProviderModelPreset(providerId, modelId);
  return providerId === "kimi"
    ? Math.min(
        configuredLimit,
        preset?.maxOutputTokens ?? KIMI_MAX_OUTPUT_RESERVE
      )
    : configuredLimit;
}

export function apiProviderApiKeyRequired(
  providerId: ApiProviderId
): boolean {
  return getApiProviderPreset(providerId).apiKeyRequired;
}

export function normalizeApiProviderId(
  value: unknown,
  baseUrl = "",
  name = ""
): ApiProviderId {
  if (
    typeof value === "string"
    && (API_PROVIDER_IDS as readonly string[]).includes(value)
  ) {
    return value as ApiProviderId;
  }
  const normalizedBaseUrl = baseUrl.toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedBaseUrl.includes("127.0.0.1:11434")
    || normalizedBaseUrl.includes("localhost:11434")
    || normalizedName === "ollama"
  ) return "ollama";
  if (
    normalizedBaseUrl.includes("deepseek")
    || normalizedName === "deepseek"
  ) return "deepseek";
  if (
    normalizedBaseUrl.includes("bigmodel")
    || normalizedName === "glm"
  ) return "glm";
  if (
    normalizedBaseUrl.includes("moonshot")
    || normalizedName === "kimi"
  ) return "kimi";
  if (
    normalizedBaseUrl.includes("minimaxi")
    || normalizedName === "minimax"
  ) return "minimax";
  if (
    normalizedBaseUrl.includes("dashscope")
    || normalizedName === "qwen"
  ) return "qwen";
  if (
    normalizedBaseUrl.includes("anthropic")
    || normalizedName === "anthropic"
  ) return "anthropic";
  if (
    normalizedBaseUrl.includes("api.openai.com")
    || normalizedName === "openai"
  ) return "openai";
  return "custom";
}

export function normalizeApiProviderProtocol(
  value: unknown,
  providerId: ApiProviderId
): ApiProviderProtocol {
  if (
    typeof value === "string"
    && (API_PROVIDER_PROTOCOLS as readonly string[]).includes(value)
  ) {
    return value as ApiProviderProtocol;
  }
  return getApiProviderPreset(providerId).apiProtocol;
}

export function normalizeApiProviderBaseUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const parsed = new URL(baseUrl.trim());
  const loopbackHttp = parsed.protocol === "http:"
    && isLoopbackHostname(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("provider_url_invalid");
  }
  let path = parsed.pathname.replace(/\/+$/u, "");
  if (apiProtocol === "openai-responses") {
    path = path.replace(/\/responses$/u, "");
  } else if (apiProtocol === "openai-completions") {
    path = path.replace(/\/chat\/completions$/u, "");
  } else {
    path = path.replace(/\/v1(?:\/messages)?$/u, "");
  }
  parsed.pathname = path || "/";
  return parsed.toString().replace(/\/$/u, "");
}

export function isLoopbackApiProviderUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function apiProviderRequestUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const normalized = normalizeApiProviderBaseUrl(baseUrl, apiProtocol);
  if (apiProtocol === "openai-responses") {
    return `${normalized}/responses`;
  }
  if (apiProtocol === "anthropic-messages") {
    return `${normalized}/v1/messages`;
  }
  return `${normalized}/chat/completions`;
}

export function apiProviderModelsUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const normalized = normalizeApiProviderBaseUrl(baseUrl, apiProtocol);
  return apiProtocol === "anthropic-messages"
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

export function openAiCompatibleChatCompletionsUrl(
  baseUrl: string
): string {
  return apiProviderRequestUrl(baseUrl, "openai-completions");
}

function preset(input: Omit<ApiProviderPreset, "model">): ApiProviderPreset {
  return Object.freeze({
    ...input,
    model: input.models[0]?.id ?? "",
    models: Object.freeze([...input.models])
  });
}

function model(
  id: string,
  contextWindow: number,
  maxOutputTokens: number,
  toolCalling: boolean,
  imageInput: boolean,
  reasoning: boolean,
  displayName?: string,
  modelMaxTokens = maxOutputTokens
): ApiProviderModelPreset {
  return Object.freeze({
    id,
    displayName,
    contextWindow,
    modelMaxTokens,
    maxOutputTokens,
    toolCalling,
    imageInput,
    reasoning
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}
