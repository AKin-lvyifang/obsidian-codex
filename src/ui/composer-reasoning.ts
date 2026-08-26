import type {
  ApiProviderConfig,
  ApiProviderModelConfig,
  CodexForObsidianSettings
} from "../settings/settings";
import {
  apiProviderModelHadInvalidStoredReasoningEffort,
  clearApiProviderModelInvalidStoredReasoningEffort
} from "../settings/settings";
import {
  echoInkPiReasoningOption,
  resolveEchoInkPiReasoningCapabilities,
  type EchoInkPiReasoningCapabilities
} from "../settings/pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";

export interface ComposerReasoningState {
  readonly provider: ApiProviderConfig;
  readonly model: ApiProviderModelConfig;
  readonly capabilities: Readonly<EchoInkPiReasoningCapabilities>;
  readonly effort: ReasoningEffort | null;
  readonly status: "valid" | "missing" | "invalid" | "unavailable";
  readonly previousEffort: ReasoningEffort | undefined;
}

export function resolveComposerReasoningState(
  settings: Pick<CodexForObsidianSettings, "apiProviders">,
  providerSettingsId: string,
  modelId: string
): Readonly<ComposerReasoningState> | null {
  const provider = settings.apiProviders.find(
    (candidate) => candidate.id === providerSettingsId
  );
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  if (!provider || !model) return null;
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    provider.runtimeProviderId,
    model.id,
    model.metadataSource === "manual" && model.reasoning
  );
  const previousEffort = model.reasoningEffort;
  const invalidStoredEffort =
    apiProviderModelHadInvalidStoredReasoningEffort(provider.id, model);
  if (
    previousEffort
    && !invalidStoredEffort
    && echoInkPiReasoningOption(capabilities, previousEffort)
  ) {
    return Object.freeze({
      provider,
      model,
      capabilities,
      effort: previousEffort,
      status: "valid",
      previousEffort
    });
  }
  const effort = capabilities.defaultEffort;
  return Object.freeze({
    provider,
    model,
    capabilities,
    effort,
    status: previousEffort || invalidStoredEffort
      ? "invalid"
      : effort ? "missing" : "unavailable",
    previousEffort
  });
}

export function applyComposerReasoningFallback(
  state: Readonly<ComposerReasoningState>
): boolean {
  if (state.status !== "missing" && state.status !== "invalid") return false;
  if (state.effort) state.model.reasoningEffort = state.effort;
  else delete state.model.reasoningEffort;
  clearApiProviderModelInvalidStoredReasoningEffort(
    state.provider.id,
    state.model
  );
  return true;
}
