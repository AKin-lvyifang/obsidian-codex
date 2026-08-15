import type {
  AssistantMessage,
  ProviderResponse,
  ProviderStreams
} from "@earendil-works/pi-ai";
import {
  PiProviderProtocolDispatcher,
  classifyPiProviderConnectionFailure,
  type PiProviderConnectionFailureKind
} from "../harness/pi/pi-provider-protocol-adapter";
import {
  createPiProviderModelDefinition
} from "../harness/pi/production-pi-model-resolver";
import {
  isValidApiProviderModelId,
  type CodexForObsidianSettings
} from "../settings/settings";
import {
  apiProviderApiKeyRequired,
  apiProviderMaxOutputReserve,
  apiProviderModelsUrl,
  isLoopbackApiProviderUrl,
  normalizeApiProviderBaseUrl,
  normalizeApiProviderId,
  type ApiProviderId,
  type ApiProviderProtocol
} from "../settings/provider-presets";
import {
  createLoopbackOpenAICompletionsAdapter,
  loopbackProviderFetch
} from "./loopback-openai-provider-adapter";

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_MODEL_LIMIT = 200;

export interface PiProviderConfigurationDraft {
  readonly providerSettingsId: string;
  readonly providerId: ApiProviderId;
  readonly runtimeProviderId: string;
  readonly apiProtocol: ApiProviderProtocol;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export type PiProviderModelListStatus =
  | "available"
  | "unsupported"
  | "api_key_error"
  | "temporary_failure";

export interface PiProviderModelListResult {
  readonly status: PiProviderModelListStatus;
  readonly models: readonly string[];
}

export type PiProviderConnectionFailure =
  PiProviderConnectionFailureKind;

export type PiProviderConnectionTestResult =
  | { readonly status: "available" }
  | {
    readonly status: "failed";
    readonly failure: PiProviderConnectionFailure;
  };

export interface PiProviderTextGenerationInput {
  readonly draft: PiProviderConfigurationDraft;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface PiProviderConfigurationHost {
  readonly settings: CodexForObsidianSettings;
}

export type PiProviderFetch = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, "status" | "json">>;

export class PiProviderConfigurationService {
  constructor(
    private readonly host: PiProviderConfigurationHost,
    private readonly options: {
      fetchImpl?: PiProviderFetch;
      adapters?: Readonly<Record<ApiProviderProtocol, ProviderStreams>>;
      textGenerationDispatcher?: Pick<PiProviderProtocolDispatcher, "stream">;
      timeoutMs?: number;
    } = {}
  ) {}

  async listModels(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderModelListResult> {
    const normalized = normalizeDraft(draft, false);
    let apiKey: string;
    try {
      apiKey = await this.resolveApiKey(normalized);
    } catch {
      return { status: "api_key_error", models: [] };
    }
    return await requestProviderModels({
      draft: normalized,
      apiKey,
      fetchImpl: this.options.fetchImpl
        ?? (isLoopbackApiProviderUrl(normalized.baseUrl)
          ? loopbackProviderFetch
          : fetch),
      timeoutMs: this.options.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS
    });
  }

  async testConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderConnectionTestResult> {
    const normalized = normalizeDraft(draft, true);
    let apiKey: string;
    try {
      apiKey = await this.resolveApiKey(normalized);
    } catch {
      return { status: "failed", failure: "auth" };
    }
    return await testProviderConnection({
      draft: normalized,
      apiKey,
      dispatcher: new PiProviderProtocolDispatcher(
        this.options.adapters
          ?? (isLoopbackApiProviderUrl(normalized.baseUrl)
            ? {
              "openai-completions":
                createLoopbackOpenAICompletionsAdapter()
            }
            : undefined)
      ),
      timeoutMs: this.options.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS
    });
  }

  async generateText(
    input: PiProviderTextGenerationInput
  ): Promise<string> {
    if (input.signal?.aborted) {
      throw new Error("provider_text_generation_aborted");
    }
    const normalized = normalizeDraft(input.draft, true);
    const apiKey = await this.resolveApiKey(normalized);
    if (input.signal?.aborted) {
      throw new Error("provider_text_generation_aborted");
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(120_000, input.timeoutMs));
    let abortKind: "external" | "timeout" | null = null;
    const abort = (kind: "external" | "timeout") => {
      if (abortKind) return;
      abortKind = kind;
      controller.abort();
    };
    const abortFromExternal = () => abort("external");
    input.signal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    try {
      const dispatcher = this.options.textGenerationDispatcher
        ?? new PiProviderProtocolDispatcher(
          this.options.adapters
            ?? (isLoopbackApiProviderUrl(normalized.baseUrl)
              ? { "openai-completions": createLoopbackOpenAICompletionsAdapter() }
              : undefined)
        );
      const stream = dispatcher.stream({
        model: createPiProviderModelDefinition({
          providerId: normalized.runtimeProviderId,
          apiProtocol: normalized.apiProtocol,
          baseUrl: normalized.baseUrl,
          modelRef: normalized.modelId,
          contextWindow: normalized.contextWindow,
          maxOutputTokens: normalized.maxOutputTokens,
          reasoning: normalized.reasoning,
          imageInput: false
        }),
        context: {
          systemPrompt: input.systemPrompt,
          messages: [{
            role: "user",
            content: input.userPrompt,
            timestamp: Date.now()
          }],
          tools: []
        },
        apiKey,
        options: {
          signal: controller.signal,
          maxTokens: Math.max(1, Math.min(
            normalized.maxOutputTokens,
            input.maxTokens ?? 4_096
          )),
          temperature: 0,
          cacheRetention: "none",
          maxRetries: 0,
          timeoutMs
        }
      });
      const message = await stream.result();
      const text = assistantText(message);
      if (
        abortKind
        || message.stopReason !== "stop"
        || !text.trim()
      ) {
        throw new Error(abortKind === "external"
          ? "provider_text_generation_aborted"
          : abortKind === "timeout"
            ? "provider_text_generation_timeout"
          : "provider_text_generation_failed");
      }
      return text;
    } catch (error) {
      if (abortKind === "external") {
        throw new Error("provider_text_generation_aborted");
      }
      if (abortKind === "timeout") {
        throw new Error("provider_text_generation_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromExternal);
    }
  }

  private async resolveApiKey(
    draft: PiProviderConfigurationDraft
  ): Promise<string> {
    if (draft.apiKey.trim()) return draft.apiKey.trim();
    if (!apiProviderApiKeyRequired(draft.providerId)) return "";
    const provider = this.host.settings.apiProviders.find(
      (candidate) => candidate.id === draft.providerSettingsId
    );
    const apiKey = provider?.apiKey.trim() ?? "";
    if (!apiKey) throw new Error("provider_api_key_missing");
    return apiKey;
  }
}

export async function requestProviderModels(input: {
  draft: PiProviderConfigurationDraft;
  apiKey: string;
  fetchImpl: PiProviderFetch;
  timeoutMs?: number;
}): Promise<PiProviderModelListResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS
  );
  try {
    const headers: Record<string, string> = input.draft.apiProtocol
      === "anthropic-messages"
      ? {
        ...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
        "anthropic-version": "2023-06-01"
      }
      : input.apiKey
        ? { authorization: `Bearer ${input.apiKey}` }
        : {};
    const response = await input.fetchImpl(
      apiProviderModelsUrl(
        input.draft.baseUrl,
        input.draft.apiProtocol
      ),
      {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error"
      }
    );
    if (response.status === 401 || response.status === 403) {
      return { status: "api_key_error", models: [] };
    }
    if ([404, 405, 501].includes(response.status)) {
      return { status: "unsupported", models: [] };
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: "temporary_failure", models: [] };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "temporary_failure", models: [] };
    }
    const body = await response.json();
    const models = modelIdsFromResponse(body);
    return models === null
      ? { status: "unsupported", models: [] }
      : { status: "available", models };
  } catch {
    return { status: "temporary_failure", models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testProviderConnection(input: {
  draft: PiProviderConfigurationDraft;
  apiKey: string;
  dispatcher: PiProviderProtocolDispatcher;
  timeoutMs?: number;
}): Promise<PiProviderConnectionTestResult> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let responseStatus: number | null = null;
  try {
    const stream = input.dispatcher.stream({
      model: createPiProviderModelDefinition({
        providerId: input.draft.runtimeProviderId,
        apiProtocol: input.draft.apiProtocol,
        baseUrl: input.draft.baseUrl,
        modelRef: input.draft.modelId,
        contextWindow: input.draft.contextWindow,
        maxOutputTokens: input.draft.maxOutputTokens,
        reasoning: input.draft.reasoning,
        imageInput: input.draft.imageInput
      }),
      context: {
        systemPrompt: "Connection check. Reply with OK only.",
        messages: [{
          role: "user",
          content: "只回复 OK",
          timestamp: Date.now()
        }],
        tools: []
      },
      apiKey: input.apiKey,
      options: {
        signal: controller.signal,
        maxTokens: 32,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs,
        onResponse: (response: ProviderResponse) => {
          responseStatus = response.status;
        }
      }
    });
    const message = await stream.result();
    if (
      message.stopReason !== "error"
      && message.stopReason !== "aborted"
      && assistantText(message).trim().length > 0
    ) {
      return { status: "available" };
    }
    return {
      status: "failed",
      failure: classifyPiProviderConnectionFailure(
        responseStatus,
        message.errorMessage ?? ""
      )
    };
  } catch (error) {
    return {
      status: "failed",
      failure: classifyPiProviderConnectionFailure(
        responseStatus,
        controller.signal.aborted
          ? "timeout"
          : error instanceof Error ? error.message : ""
      )
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDraft(
  draft: PiProviderConfigurationDraft,
  requireModel: boolean
): PiProviderConfigurationDraft {
  const modelId = draft.modelId.trim();
  if (requireModel && !isValidApiProviderModelId(modelId)) {
    throw new Error("provider_model_invalid");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(
      draft.runtimeProviderId.trim()
    )
    || !Number.isSafeInteger(draft.contextWindow)
    || draft.contextWindow < 1_024
    || draft.contextWindow > 2_000_000
    || !Number.isSafeInteger(draft.maxOutputTokens)
    || draft.maxOutputTokens < 1
    || draft.maxOutputTokens > Math.min(
      draft.contextWindow,
      1_000_000
    )
  ) {
    throw new Error("provider_model_metadata_invalid");
  }
  return Object.freeze({
    providerSettingsId: draft.providerSettingsId,
    providerId: draft.providerId,
    runtimeProviderId: draft.runtimeProviderId.trim(),
    apiProtocol: draft.apiProtocol,
    baseUrl: normalizeApiProviderBaseUrl(
      draft.baseUrl,
      draft.apiProtocol
    ),
    modelId,
    apiKey: draft.apiKey.trim(),
    toolCalling: draft.toolCalling,
    imageInput: draft.imageInput,
    reasoning: draft.reasoning,
    contextWindow: draft.contextWindow,
    maxOutputTokens: apiProviderMaxOutputReserve(
      draft.providerId,
      modelId,
      draft.maxOutputTokens
    )
  });
}

function modelIdsFromResponse(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (!isValidApiProviderModelId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= PROVIDER_MODEL_LIMIT) break;
  }
  return ids;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}
