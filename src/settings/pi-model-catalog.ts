import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type ChatTemplateKwargValue,
  type Model,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import {
  ANTHROPIC_MODELS
} from "@earendil-works/pi-ai/providers/anthropic.models";
import {
  DEEPSEEK_MODELS
} from "@earendil-works/pi-ai/providers/deepseek.models";
import {
  MINIMAX_CN_MODELS
} from "@earendil-works/pi-ai/providers/minimax-cn.models";
import {
  MOONSHOTAI_CN_MODELS
} from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import {
  OPENAI_MODELS
} from "@earendil-works/pi-ai/providers/openai.models";
import {
  OPENAI_CODEX_MODELS
} from "@earendil-works/pi-ai/providers/openai-codex.models";
import {
  QWEN_TOKEN_PLAN_MODELS
} from "@earendil-works/pi-ai/providers/qwen-token-plan.models";
import {
  QWEN_TOKEN_PLAN_CN_MODELS
} from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import {
  ZAI_CODING_CN_MODELS
} from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import type { ReasoningEffort } from "../types/app-server";

const ECHOINK_PI_MODEL_CATALOGS = Object.freeze({
  "openai-codex": OPENAI_CODEX_MODELS,
  "zai-coding-cn": ZAI_CODING_CN_MODELS,
  "moonshotai-cn": MOONSHOTAI_CN_MODELS,
  "minimax-cn": MINIMAX_CN_MODELS,
  deepseek: DEEPSEEK_MODELS,
  "qwen-token-plan": QWEN_TOKEN_PLAN_MODELS,
  "qwen-token-plan-cn": QWEN_TOKEN_PLAN_CN_MODELS,
  // Compatibility-only Provider identities remain readable for old settings.
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS
});

type EchoInkPiCatalogRuntimeProviderId =
  keyof typeof ECHOINK_PI_MODEL_CATALOGS;

const ECHOINK_PI_REASONING_LEVELS: readonly Readonly<{
  piLevel: ModelThinkingLevel;
  effort: ReasoningEffort;
}>[] = Object.freeze([
  Object.freeze({ piLevel: "off", effort: "none" }),
  Object.freeze({ piLevel: "minimal", effort: "minimal" }),
  Object.freeze({ piLevel: "low", effort: "low" }),
  Object.freeze({ piLevel: "medium", effort: "medium" }),
  Object.freeze({ piLevel: "high", effort: "high" }),
  Object.freeze({ piLevel: "xhigh", effort: "xhigh" }),
  Object.freeze({ piLevel: "max", effort: "max" })
]);

export interface EchoInkPiReasoningOption {
  readonly effort: ReasoningEffort;
  readonly piLevel: ModelThinkingLevel;
  readonly display: "off" | "level" | "toggle";
  /** Stable key for de-duplicating options that produce the same request. */
  readonly wireValueKey: string;
}

export interface EchoInkPiReasoningCapabilities {
  readonly source: "catalog" | "manual" | "unknown";
  readonly options: readonly Readonly<EchoInkPiReasoningOption>[];
  readonly defaultEffort: ReasoningEffort | null;
}

export function resolveEchoInkPiCatalogModel(
  runtimeProviderId: string,
  modelId: string
): Model<Api> | null {
  const providerId = runtimeProviderId.trim();
  const id = modelId.trim();
  if (!isEchoInkPiCatalogRuntimeProviderId(providerId) || !id) return null;
  const catalog = ECHOINK_PI_MODEL_CATALOGS[providerId] as Readonly<
    Record<string, Model<Api>>
  >;
  return Object.hasOwn(catalog, id) ? catalog[id] ?? null : null;
}

export function resolveEchoInkPiReasoningCapabilities(
  runtimeProviderId: string,
  modelId: string,
  manuallyConfiguredReasoning = false
): Readonly<EchoInkPiReasoningCapabilities> {
  const model = resolveEchoInkPiCatalogModel(runtimeProviderId, modelId);
  if (model) {
    return resolveEchoInkPiModelReasoningCapabilities(model);
  }
  if (!manuallyConfiguredReasoning) {
    return frozenCapabilities("unknown", [], null);
  }
  return frozenCapabilities("manual", [
    {
      effort: "none",
      piLevel: "off",
      display: "off",
      wireValueKey: "manual:off"
    },
    {
      effort: "medium",
      piLevel: "medium",
      display: "toggle",
      wireValueKey: "manual:on"
    }
  ], "medium");
}

export function resolveEchoInkPiModelReasoningCapabilities(
  model: Model<Api>
): Readonly<EchoInkPiReasoningCapabilities> {
  if (!model.reasoning) {
    return frozenCapabilities("catalog", [], null);
  }
  const supported = new Set(getSupportedThinkingLevels(model));
  const groups = new Map<string, Readonly<EchoInkPiReasoningOption>>();
  for (const candidate of ECHOINK_PI_REASONING_LEVELS) {
    if (!supported.has(candidate.piLevel)) continue;
    const option = Object.freeze({
      ...candidate,
      display: reasoningOptionDisplay(model, candidate.piLevel),
      wireValueKey: reasoningWireValueKey(model, candidate.piLevel)
    });
    const current = groups.get(option.wireValueKey);
    if (!current || reasoningOptionPreference(model, option.piLevel)
      > reasoningOptionPreference(model, current.piLevel)) {
      groups.set(option.wireValueKey, option);
    }
  }
  const options = [...groups.values()];
  const clampedDefault = clampThinkingLevel(model, "medium");
  const defaultWireValueKey = reasoningWireValueKey(model, clampedDefault);
  const defaultEffort = options.find(
    (option) => option.wireValueKey === defaultWireValueKey
  )?.effort ?? null;
  return frozenCapabilities("catalog", options, defaultEffort);
}

export function echoInkReasoningEffortToPiLevel(
  effort: ReasoningEffort
): ModelThinkingLevel {
  return effort === "none" ? "off" : effort;
}

export function isEchoInkReasoningEffort(value: unknown): value is ReasoningEffort {
  return ECHOINK_PI_REASONING_LEVELS.some((entry) => entry.effort === value);
}

export function normalizeEchoInkReasoningEffort(
  value: unknown
): ReasoningEffort | undefined {
  return isEchoInkReasoningEffort(value) ? value : undefined;
}

export function echoInkPiReasoningOption(
  capabilities: Readonly<EchoInkPiReasoningCapabilities>,
  effort: ReasoningEffort
): Readonly<EchoInkPiReasoningOption> | null {
  return capabilities.options.find((option) => option.effort === effort) ?? null;
}

export function isEchoInkPiReasoningEffortSupported(
  capabilities: Readonly<EchoInkPiReasoningCapabilities>,
  effort: ReasoningEffort
): boolean {
  if (echoInkPiReasoningOption(capabilities, effort)) return true;
  // Models with no configurable reasoning still have one legal Pi state: off.
  return effort === "none" && capabilities.options.length === 0;
}

function frozenCapabilities(
  source: EchoInkPiReasoningCapabilities["source"],
  options: readonly EchoInkPiReasoningOption[],
  defaultEffort: ReasoningEffort | null
): Readonly<EchoInkPiReasoningCapabilities> {
  return Object.freeze({
    source,
    options: Object.freeze(options.map((option) => Object.freeze({ ...option }))),
    defaultEffort
  });
}

function reasoningOptionPreference(
  model: Model<Api>,
  level: ModelThinkingLevel
): number {
  if (level === "off") return 100;
  const representative = reasoningWireEffort(model, level);
  if (representative === level) return 100;
  if (level === "medium") return 90;
  if (level === "low") return 70;
  return 60;
}

function reasoningOptionDisplay(
  model: Model<Api>,
  level: ModelThinkingLevel
): EchoInkPiReasoningOption["display"] {
  if (level === "off") return "off";
  if (model.api !== "openai-completions") return "level";
  const completionsModel = model as Model<"openai-completions">;
  const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
  if (format === "qwen" || format === "qwen-chat-template") return "toggle";
  if (
    (format === "zai" || format === "together" || format === "deepseek")
    && !openAICompletionsSupportsReasoningEffort(completionsModel, format)
  ) return "toggle";
  return "level";
}

function reasoningWireValueKey(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  if (
    isAnthropicAdaptiveThinkingModel(model)
  ) {
    return `${model.api}:${level === "off"
      ? "off"
      : anthropicAdaptiveThinkingEffort(model, level)}`;
  }
  if (model.api !== "openai-completions") {
    return `${model.api}:${mappedThinkingValue(model, level)}`;
  }
  const completionsModel = model as Model<"openai-completions">;
  const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
  const enabled = level !== "off";
  const supportsEffort = openAICompletionsSupportsReasoningEffort(
    completionsModel,
    format
  );
  const mapped = mappedThinkingValue(model, level);
  switch (format) {
    case "qwen":
    case "qwen-chat-template":
      return `${format}:${enabled}`;
    case "zai":
    case "together":
    case "deepseek":
      return enabled && supportsEffort
        ? `${format}:on:${mapped}`
        : `${format}:${enabled ? "on" : "off"}`;
    case "ant-ling": {
      const explicit = model.thinkingLevelMap?.[level];
      return enabled && typeof explicit === "string"
        ? `${format}:${explicit}`
        : `${format}:absent`;
    }
    case "chat-template":
      return `${format}:${chatTemplateWireValueKey(
        completionsModel,
        level
      )}`;
    default:
      return `${format}:${mapped}`;
  }
}

function reasoningWireEffort(
  model: Model<Api>,
  level: ModelThinkingLevel
): string | null {
  if (
    isAnthropicAdaptiveThinkingModel(model)
  ) {
    return anthropicAdaptiveThinkingEffort(model, level);
  }
  if (model.api === "openai-completions") {
    const completionsModel = model as Model<"openai-completions">;
    const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
    if (format === "qwen" || format === "qwen-chat-template") return null;
    if (
      (format === "zai" || format === "together" || format === "deepseek")
      && !openAICompletionsSupportsReasoningEffort(completionsModel, format)
    ) return null;
  }
  return mappedThinkingValue(model, level);
}

function anthropicAdaptiveThinkingEffort(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return level;
  return "high";
}

function isAnthropicAdaptiveThinkingModel(model: Model<Api>): boolean {
  return model.api === "anthropic-messages"
    && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking
      === true;
}

function mappedThinkingValue(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  return level === "off" ? "none" : level;
}

type OpenAICompletionsThinkingFormat = NonNullable<
  NonNullable<Model<"openai-completions">["compat"]>["thinkingFormat"]
>;

function resolvedOpenAICompletionsThinkingFormat(
  model: Model<"openai-completions">
): OpenAICompletionsThinkingFormat {
  const explicit = model.compat?.thinkingFormat;
  if (explicit) return explicit;
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  if (provider === "deepseek" || baseUrl.includes("deepseek.com")) {
    return "deepseek";
  }
  if (
    provider === "zai"
    || provider === "zai-coding-cn"
    || baseUrl.includes("api.z.ai")
    || baseUrl.includes("open.bigmodel.cn")
  ) return "zai";
  if (
    provider === "together"
    || baseUrl.includes("api.together.ai")
    || baseUrl.includes("api.together.xyz")
  ) return "together";
  if (provider === "ant-ling" || baseUrl.includes("api.ant-ling.com")) {
    return "ant-ling";
  }
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return "openrouter";
  }
  return "openai";
}

function openAICompletionsSupportsReasoningEffort(
  model: Model<"openai-completions">,
  format: OpenAICompletionsThinkingFormat
): boolean {
  if (typeof model.compat?.supportsReasoningEffort === "boolean") {
    return model.compat.supportsReasoningEffort;
  }
  if (format === "zai" || format === "together" || format === "ant-ling") {
    return false;
  }
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  return provider !== "xai"
    && provider !== "moonshotai"
    && provider !== "moonshotai-cn"
    && provider !== "nvidia"
    && provider !== "cloudflare-ai-gateway"
    && !baseUrl.includes("api.x.ai")
    && !baseUrl.includes("api.moonshot.")
    && !baseUrl.includes("integrate.api.nvidia.com")
    && !baseUrl.includes("gateway.ai.cloudflare.com");
}

function chatTemplateWireValueKey(
  model: Model<"openai-completions">,
  level: ModelThinkingLevel
): string {
  const entries = Object.entries(model.compat?.chatTemplateKwargs ?? {})
    .flatMap(([key, value]) => {
      const resolved = resolveChatTemplateValue(model, level, value);
      return resolved === undefined ? [] : [[key, resolved] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function resolveChatTemplateValue(
  model: Model<"openai-completions">,
  level: ModelThinkingLevel,
  value: ChatTemplateKwargValue
): string | number | boolean | null | undefined {
  if (typeof value !== "object" || value === null) return value;
  if (level === "off" && value.omitWhenOff) return undefined;
  if (value.$var === "thinking.enabled") return level !== "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  if (typeof mapped === "string") return mapped;
  return level === "off" ? undefined : level;
}

function isEchoInkPiCatalogRuntimeProviderId(
  value: string
): value is EchoInkPiCatalogRuntimeProviderId {
  return Object.hasOwn(ECHOINK_PI_MODEL_CATALOGS, value);
}
