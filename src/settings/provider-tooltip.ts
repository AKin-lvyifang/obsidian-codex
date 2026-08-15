import {
  getApiProviderPreset,
  type ApiProviderPreset
} from "./provider-presets";

export function providerTooltipBaseUrl(
  providerId: ApiProviderPreset["id"],
  customBaseUrl: string
): string {
  return (providerId === "custom"
    ? customBaseUrl
    : getApiProviderPreset(providerId).baseUrl).trim();
}
