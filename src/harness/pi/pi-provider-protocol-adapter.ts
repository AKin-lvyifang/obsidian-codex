import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  clampThinkingLevel,
  getOverflowPatterns,
  isContextOverflow
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi
} from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  openAICompletionsApi
} from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  openAIResponsesApi
} from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  openAICodexResponsesApi
} from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type {
  ApiProviderProtocol
} from "../../settings/provider-presets";
import type {
  ControlledPiStreamInput,
  ControlledPiStreamPort
} from "./production-pi-model-resolver";

export type PiProviderProtocolAdapters = Readonly<
  Record<ApiProviderProtocol, ProviderStreams>
>;

export type PiProviderConnectionFailureKind =
  | "auth"
  | "protocol"
  | "model"
  | "rate_limit"
  | "network"
  | "provider";

const DEFAULT_PI_PROVIDER_PROTOCOL_ADAPTERS:
PiProviderProtocolAdapters = Object.freeze({
  "openai-codex-responses": createOpenAICodexSseAdapter(),
  "openai-responses": openAIResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "anthropic-messages": anthropicMessagesApi()
});
const PI_CONTEXT_OVERFLOW_PATTERNS = getOverflowPatterns();

export class PiProviderProtocolDispatcher {
  readonly adapters: PiProviderProtocolAdapters;

  constructor(adapters: Partial<PiProviderProtocolAdapters> = {}) {
    this.adapters = Object.freeze({
      ...DEFAULT_PI_PROVIDER_PROTOCOL_ADAPTERS,
      ...adapters
    });
  }

  stream(input: {
    model: Model<Api>;
    context: Context;
    apiKey: string;
    options: Omit<StreamOptions, "apiKey"> & Pick<SimpleStreamOptions, "reasoning">;
  }): AssistantMessageEventStream {
    const protocol = requireApiProviderProtocol(input.model.api);
    const { reasoning, ...streamOptions } = input.options;
    const clampedReasoning = reasoning
      ? clampThinkingLevel(input.model, reasoning)
      : undefined;
    const reasoningEffort = clampedReasoning === "off"
      ? undefined
      : clampedReasoning;
    return this.adapters[protocol].stream(
      input.model,
      input.context,
      {
        ...streamOptions,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        apiKey: input.apiKey
      }
    );
  }

  streamSimple(input: {
    model: Model<Api>;
    context: Context;
    apiKey: string;
    options: Omit<SimpleStreamOptions, "apiKey">;
  }): AssistantMessageEventStream {
    const protocol = requireApiProviderProtocol(input.model.api);
    return this.adapters[protocol].streamSimple(
      input.model,
      input.context,
      {
        ...input.options,
        apiKey: input.apiKey
      }
    );
  }
}

export class PiProviderProtocolTransport
implements ControlledPiStreamPort {
  readonly authorityId: string;
  readonly storeSetId: string;

  constructor(private readonly options: {
    authorityId: string;
    storeSetId: string;
    resolveAuthToken(): string | Promise<string>;
    dispatcher?: PiProviderProtocolDispatcher;
  }) {
    this.authorityId = options.authorityId;
    this.storeSetId = options.storeSetId;
  }

  async stream(
    input: ControlledPiStreamInput
  ): Promise<AssistantMessageEventStream> {
    let apiKey: string;
    try {
      apiKey = await this.options.resolveAuthToken();
    } catch {
      return failedStream(
        input.model,
        input.provider.authMode === "oauth"
          ? "provider_oauth_relogin_required"
          : "provider_api_key_missing"
      );
    }
    let responseStatus: number | null = null;
    try {
      const dispatcher = this.options.dispatcher
        ?? new PiProviderProtocolDispatcher();
      const dispatch = input.options.maxTokens === undefined
        && (
          input.model.api === "openai-completions"
          || input.model.api === "openai-responses"
        )
        ? dispatcher.stream.bind(dispatcher)
        : dispatcher.streamSimple.bind(dispatcher);
      const upstream = dispatch({
        model: input.model,
        context: input.context,
        apiKey,
        options: {
          signal: input.options.signal,
          ...(input.options.reasoning
            ? { reasoning: input.options.reasoning }
            : {}),
          ...(input.options.maxTokens === undefined
            ? {}
            : { maxTokens: input.options.maxTokens }),
          temperature: input.options.temperature,
          cacheRetention: input.options.cacheRetention,
          maxRetries: input.options.maxRetries,
          timeoutMs: input.options.timeoutMs,
          onResponse: (response) => {
            responseStatus = response.status;
          }
        }
      });
      return sanitizeProviderStream(
        upstream,
        input.model,
        () => responseStatus
      );
    } catch (error) {
      return failedStream(
        input.model,
        thrownProviderFailureCode(
          responseStatus,
          error instanceof Error ? error.message : ""
        )
      );
    }
  }
}

export function classifyPiProviderConnectionFailure(
  status: number | null,
  message: string
): PiProviderConnectionFailureKind {
  const normalized = message.toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (
    /(?:model).*(?:not found|does not exist|unsupported|invalid)/u.test(
      normalized
    )
    || /(?:unknown|invalid).*(?:model)/u.test(normalized)
  ) {
    return "model";
  }
  if ([400, 404, 405, 422].includes(status ?? -1)) return "protocol";
  if (status !== null && status >= 500) return "provider";
  if (
    /timeout|timed out|abort|network|connection error|failed to fetch|fetch failed|enotfound|econn|dns|tls|certificate|offline/u.test(
      normalized
    )
  ) {
    return "network";
  }
  if (
    /protocol|parse|invalid response|unexpected.*json|json.*unexpected/u.test(
      normalized
    )
  ) {
    return "protocol";
  }
  return "provider";
}

function sanitizeProviderStream(
  upstream: AssistantMessageEventStream,
  model: Model<Api>,
  responseStatus: () => number | null
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of upstream) {
        if (event.type !== "error") {
          output.push(event);
          continue;
        }
        output.push({
          type: "error",
          reason: event.reason,
          error: {
            ...event.error,
            errorMessage: runtimeProviderFailureCode(
              responseStatus(),
              event.error.errorMessage ?? "",
              event.error,
              model.contextWindow
            )
          }
        });
      }
    } catch (error) {
      output.push({
        type: "error",
        reason: "error",
        error: errorMessage(
          model,
          thrownProviderFailureCode(
            responseStatus(),
            error instanceof Error ? error.message : ""
          )
        )
      });
    }
  })();
  return output;
}

/**
 * Preserve Pi's context-overflow signal while reducing every other Provider
 * error to EchoInk's public failure vocabulary. AgentSession relies on the
 * canonical code to start its native compact-and-retry path.
 */
function runtimeProviderFailureCode(
  status: number | null,
  message: string,
  assistantMessage?: AssistantMessage,
  contextWindow?: number
): string {
  if (
    (
      assistantMessage
      && isContextOverflow(assistantMessage, contextWindow)
    )
    || isStatusContextOverflow(status, message)
  ) {
    return "context_length_exceeded";
  }
  return providerFailureCode(
    classifyPiProviderConnectionFailure(status, message)
  );
}

function thrownProviderFailureCode(
  status: number | null,
  message: string
): string {
  return isStatusContextOverflow(status, message)
    ? "context_length_exceeded"
    : "provider_network_failed";
}

function isStatusContextOverflow(
  status: number | null,
  message: string
): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (
    /^(?:throttling error|service unavailable):|rate limit|too many requests|throttl/u
      .test(normalized)
  ) {
    return false;
  }
  if (PI_CONTEXT_OVERFLOW_PATTERNS.some((pattern) =>
    pattern.test(message)
  )) {
    return true;
  }
  if (
    /context[_ ]length[_ ]exceeded|model_context_window_exceeded|request_too_large/u
      .test(normalized)
  ) {
    return true;
  }
  if (status !== 400 && status !== 413) return false;
  const overflowQualifier =
    /exceed|too (?:long|large|many)|maximum|max(?:imum)?|limit|overflow|out of range|reduce/u;
  if (!overflowQualifier.test(normalized)) return false;
  return (
    /context(?: window| length| size)?/u.test(normalized)
    || /(?:prompt|input).*(?:token|length|long|large)/u.test(normalized)
    || /(?:token count|token length|token limit|too many tokens)/u
      .test(normalized)
  );
}

function failedStream(
  model: Model<Api>,
  safeCode: string
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: errorMessage(model, safeCode)
    });
  });
  return stream;
}

function errorMessage(
  model: Model<Api>,
  safeCode: string
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "error",
    errorMessage: safeCode,
    timestamp: Date.now()
  };
}

function providerFailureCode(
  failure: PiProviderConnectionFailureKind
): string {
  switch (failure) {
    case "auth":
      return "provider_auth_failed";
    case "protocol":
      return "provider_protocol_mismatch";
    case "model":
      return "provider_model_unavailable";
    case "rate_limit":
      return "provider_rate_limited";
    case "network":
      return "provider_network_failed";
    case "provider":
      return "provider_unavailable";
  }
}

export function requireApiProviderProtocol(
  value: Api
): ApiProviderProtocol {
  if (
    value === "openai-codex-responses"
    || value === "openai-responses"
    || value === "openai-completions"
    || value === "anthropic-messages"
  ) {
    return value as ApiProviderProtocol;
  }
  throw new Error("provider_protocol_unsupported");
}

export function createOpenAICodexSseAdapter(
  upstream: ProviderStreams = openAICodexResponsesApi()
): ProviderStreams {
  return Object.freeze({
    stream: (
      model: Model<Api>,
      context: Context,
      options?: StreamOptions
    ) => upstream.stream(
      model,
      context,
      { ...options, transport: "sse" }
    ),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions
    ) => upstream.streamSimple(
      model,
      context,
      { ...options, transport: "sse" }
    )
  });
}
