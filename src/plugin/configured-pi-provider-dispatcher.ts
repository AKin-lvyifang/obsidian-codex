import type {
  ProviderStreams
} from "@earendil-works/pi-ai";
import {
  PiProviderProtocolDispatcher
} from "../harness/pi/pi-provider-protocol-adapter";
import type {
  ApiProviderId,
  ApiProviderProtocol
} from "../settings/provider-presets";
import {
  isLoopbackApiProviderUrl
} from "../settings/provider-presets";
import {
  createLoopbackOpenAICompletionsAdapter
} from "./loopback-openai-provider-adapter";
import {
  createQwenTokenPlanOpenAICompletionsAdapter
} from "./qwen-token-plan-provider-adapter";

export type ConfiguredPiProviderTransportKind =
  | "default"
  | "loopback"
  | "qwen-token-plan";

export interface ConfiguredPiProviderTransportInput {
  readonly providerId: ApiProviderId;
  readonly runtimeProviderId: string;
  readonly apiProtocol: ApiProviderProtocol;
  readonly baseUrl: string;
}

export function resolveConfiguredPiProviderTransportKind(
  input: ConfiguredPiProviderTransportInput
): ConfiguredPiProviderTransportKind {
  if (isLoopbackApiProviderUrl(input.baseUrl)) return "loopback";
  if (
    input.providerId === "qwen-token-plan"
    && input.apiProtocol === "openai-completions"
  ) {
    return "qwen-token-plan";
  }
  return "default";
}

/** Shared by settings preflight, background text generation and real Pi Chat. */
export function createConfiguredPiProviderProtocolDispatcher(
  input: ConfiguredPiProviderTransportInput,
  adapters: Readonly<{
    loopback?: ProviderStreams;
    qwenTokenPlan?: ProviderStreams;
  }> = {}
): PiProviderProtocolDispatcher {
  switch (resolveConfiguredPiProviderTransportKind(input)) {
    case "loopback":
      return new PiProviderProtocolDispatcher({
        "openai-completions": adapters.loopback
          ?? createLoopbackOpenAICompletionsAdapter()
      });
    case "qwen-token-plan":
      return new PiProviderProtocolDispatcher({
        "openai-completions": adapters.qwenTokenPlan
          ?? createQwenTokenPlanOpenAICompletionsAdapter()
      });
    default:
      return new PiProviderProtocolDispatcher();
  }
}
