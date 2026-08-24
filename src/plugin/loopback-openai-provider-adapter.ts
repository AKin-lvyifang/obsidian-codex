import { Buffer } from "node:buffer";
import {
  request as httpRequest,
  type IncomingHttpHeaders
} from "node:http";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions
} from "@earendil-works/pi-ai";
import {
  buildDeepSeekBody,
  emitBufferedMessage,
  parseDeepSeekSseResponse
} from "../harness/pi/provider-stream-codec";
import type {
  ControlledPiStreamInput
} from "../harness/pi/production-pi-model-resolver";
import {
  apiProviderRequestUrl,
  isLoopbackApiProviderUrl
} from "../settings/provider-presets";

const MAX_LOOPBACK_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOOPBACK_TIMEOUT_MS = 30_000;
type LoopbackStreamOptions = StreamOptions &
  Pick<SimpleStreamOptions, "reasoning">;

export interface LoopbackProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Pi's browser-compatible OpenAI client cannot reach an HTTP loopback server
 * from Obsidian's secure app origin. This adapter keeps Ollama inside the same
 * Pi Provider loop while using a strict, redirect-free Node HTTP hop that can
 * only target localhost/loopback. It is never selected for cloud Providers.
 */
export function createLoopbackOpenAICompletionsAdapter(): ProviderStreams {
  const start = (
    model: Model<Api>,
    context: Context,
    options: LoopbackStreamOptions
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void executeLoopbackCompletion({
      model,
      context,
      options,
      output
    });
    return output;
  };
  return Object.freeze({
    stream: (model, context, options = {}) =>
      start(model, context, options),
    streamSimple: (model, context, options = {}) =>
      start(model, context, options)
  });
}

export async function loopbackProviderFetch(
  input: string,
  init: RequestInit
): Promise<Pick<Response, "status" | "json">> {
  if ((init.method ?? "GET").toUpperCase() !== "GET") {
    throw new Error("loopback_model_list_method_invalid");
  }
  const response = await requestLoopbackProvider({
    url: input,
    method: "GET",
    headers: requestHeaders(init.headers),
    signal: init.signal ?? undefined,
    timeoutMs: DEFAULT_LOOPBACK_TIMEOUT_MS
  });
  return {
    status: response.status,
    json: async () => JSON.parse(response.body) as unknown
  };
}

export async function requestLoopbackProvider(input: {
  url: string;
  method: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LoopbackProviderResponse> {
  if (!isLoopbackApiProviderUrl(input.url)) {
    throw new Error("loopback_provider_target_invalid");
  }
  const parsed = new URL(input.url);
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("loopback_provider_target_invalid");
  }
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    1_000,
    120_000,
    DEFAULT_LOOPBACK_TIMEOUT_MS
  );
  const body = input.body ?? "";
  return await new Promise<LoopbackProviderResponse>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("loopback_provider_aborted"));
      return;
    }
    let settled = false;
    const request = httpRequest({
      protocol: "http:",
      hostname: parsed.hostname.replace(/^\[|\]$/gu, ""),
      port: parsed.port || "80",
      path: parsed.pathname,
      method: input.method,
      headers: {
        accept: input.method === "GET"
          ? "application/json"
          : "text/event-stream, application/json",
        ...input.headers,
        ...(body
          ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8"))
          }
          : {})
      },
      maxHeaderSize: 32 * 1024
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8");
        received += bytes.length;
        if (received > MAX_LOOPBACK_RESPONSE_BYTES) {
          request.destroy(new Error("loopback_provider_response_too_large"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: Buffer.concat(chunks).toString("utf8")
        }));
      });
      response.once("error", fail);
      response.once("aborted", () => fail(
        new Error("loopback_provider_response_aborted")
      ));
    });
    const onAbort = () => request.destroy(
      new Error("loopback_provider_aborted")
    );
    const cleanup = () => {
      input.signal?.removeEventListener("abort", onAbort);
      request.removeListener("error", fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", fail);
    request.setTimeout(timeoutMs, () => request.destroy(
      new Error("loopback_provider_timeout")
    ));
    request.end(body || undefined);
  });
}

async function executeLoopbackCompletion(input: {
  model: Model<Api>;
  context: Context;
  options: LoopbackStreamOptions;
  output: AssistantMessageEventStream;
}): Promise<void> {
  let status: number | null = null;
  try {
    if (
      input.model.api !== "openai-completions"
      || !isLoopbackApiProviderUrl(input.model.baseUrl)
    ) {
      throw new Error("loopback_provider_model_invalid");
    }
    const controlled = loopbackControlledInput(
      input.model,
      input.context,
      input.options
    );
    let payload: unknown = buildDeepSeekBody(controlled);
    const transformed = await input.options.onPayload?.(
      payload,
      input.model
    );
    if (transformed !== undefined) payload = transformed;
    const response = await requestLoopbackProvider({
      url: apiProviderRequestUrl(
        input.model.baseUrl,
        "openai-completions"
      ),
      method: "POST",
      headers: input.options.apiKey
        ? { authorization: `Bearer ${input.options.apiKey}` }
        : {},
      body: JSON.stringify(payload),
      signal: input.options.signal,
      timeoutMs: input.options.timeoutMs
    });
    status = response.status;
    await input.options.onResponse?.({
      status,
      headers: { ...response.headers }
    }, input.model);
    if (status < 200 || status >= 300) {
      throw new Error(status === 401 || status === 403
        ? "provider_auth_failed"
        : "provider_http_failed");
    }
    const message = parseDeepSeekSseResponse({
      statusCode: response.status,
      headers: response.headers,
      body: response.body
    }, input.model, Date.now());
    emitBufferedMessage(input.output, message);
  } catch (error) {
    input.output.push({
      type: "error",
      reason: input.options.signal?.aborted ? "aborted" : "error",
      error: loopbackFailureMessage(
        input.model,
        input.options.signal?.aborted,
        status,
        error
      )
    });
  }
}

function loopbackControlledInput(
  model: Model<Api>,
  context: Context,
  options: LoopbackStreamOptions
): ControlledPiStreamInput {
  return {
    runId: "loopback-provider-run",
    conversationId: "loopback-provider-conversation",
    turnId: "loopback-provider-turn",
    correlationId: "loopback-provider-correlation",
    provider: {
      providerId: model.provider,
      apiProtocol: "openai-completions",
      authMode: "api-key",
      baseUrl: model.baseUrl,
      modelRef: model.id
    },
    model,
    context,
    options: {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      maxTokens: boundedInteger(
        options.maxTokens,
        1,
        Math.max(1, model.maxTokens),
        Math.max(1, model.maxTokens)
      ),
      temperature: boundedNumber(options.temperature, 0, 2, 0),
      cacheRetention: "none",
      maxRetries: 0,
      timeoutMs: boundedInteger(
        options.timeoutMs,
        1_000,
        120_000,
        DEFAULT_LOOPBACK_TIMEOUT_MS
      )
    }
  };
}

function loopbackFailureMessage(
  model: Model<Api>,
  aborted: boolean | undefined,
  status: number | null,
  error: unknown
): AssistantMessage {
  const message = error instanceof Error ? error.message : "";
  const errorMessage = aborted
    ? "controlled_transport_aborted"
    : status === 401 || status === 403
      ? "provider_auth_failed"
      : /parse|json|sse|protocol/iu.test(message)
        ? "provider_protocol_failed"
        : "provider_network_failed";
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
    stopReason: aborted ? "aborted" : "error",
    errorMessage,
    timestamp: Date.now()
  };
}

function requestHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, name) => {
      result[name] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function normalizeHeaders(
  headers: IncomingHttpHeaders
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) {
      result[name.toLowerCase()] = value.join(", ");
    }
  }
  return Object.freeze(result);
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value!))
    : fallback;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
