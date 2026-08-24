import type { Api, Model } from "@earendil-works/pi-ai";
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
  ZAI_CODING_CN_MODELS
} from "@earendil-works/pi-ai/providers/zai-coding-cn.models";

const ECHOINK_PI_MODEL_CATALOGS = Object.freeze({
  "openai-codex": OPENAI_CODEX_MODELS,
  "zai-coding-cn": ZAI_CODING_CN_MODELS,
  "moonshotai-cn": MOONSHOTAI_CN_MODELS,
  "minimax-cn": MINIMAX_CN_MODELS,
  deepseek: DEEPSEEK_MODELS,
  // Compatibility-only Provider identities remain readable for old settings.
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS
});

type EchoInkPiCatalogRuntimeProviderId =
  keyof typeof ECHOINK_PI_MODEL_CATALOGS;

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

function isEchoInkPiCatalogRuntimeProviderId(
  value: string
): value is EchoInkPiCatalogRuntimeProviderId {
  return Object.hasOwn(ECHOINK_PI_MODEL_CATALOGS, value);
}
