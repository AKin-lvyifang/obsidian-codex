import {
  getApiProviderPreset,
  type ApiProviderPreset
} from "./provider-presets";

export function providerTooltipBaseUrl(
  providerId: ApiProviderPreset["id"],
  customBaseUrl: string
): string {
  if (providerId === "openai-codex") return "";
  return (providerId === "custom"
    ? customBaseUrl
    : getApiProviderPreset(providerId).baseUrl).trim();
}
