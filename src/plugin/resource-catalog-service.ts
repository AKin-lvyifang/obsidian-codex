import type CodexForObsidianPlugin from "../main";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import type { EchoInkResource } from "../resources/types";
import { loadVaultEchoInkResources } from "../resources/vault-resource-catalog";
import type { CodexForObsidianSettings } from "../settings/settings";

type ResourceCatalogHost = Pick<
  CodexForObsidianPlugin,
  | "getVaultPath"
  | "settings"
  | "withEchoInkResourceMutation"
  | "saveEchoInkResourceMutation"
>;

/**
 * Lightweight runtime catalog boundary shared by Settings and the MCP protocol
 * service. It intentionally does not construct the retired Harness runtime.
 */
export class EchoInkResourceCatalogService {
  constructor(private readonly plugin: ResourceCatalogHost) {}

  async buildRuntimeCatalog(): Promise<EchoInkResource[]> {
    return await this.plugin.withEchoInkResourceMutation(
      async () => await this.scanAndCommitRuntimeCatalog()
    );
  }

  private async scanAndCommitRuntimeCatalog(): Promise<EchoInkResource[]> {
    let vaultResources: Awaited<ReturnType<typeof loadVaultEchoInkResources>>;
    try {
      vaultResources = await loadVaultEchoInkResources({
        vaultPath: this.plugin.getVaultPath(),
        maxSkillBytes: 200_000
      });
    } catch (error) {
      this.plugin.settings.resources.lastError = errorMessage(error);
      return this.lastKnownRuntimeCatalog();
    }

    const liveResources = this.plugin.settings.resources;
    const previousResources = structuredClone(liveResources);
    const previousCatalog = structuredClone(liveResources.catalog);
    const previousLastError = liveResources.lastError;
    try {
      const catalog = buildActiveEchoInkResourceCatalog({
        settings: liveResources,
        manual: vaultResources.resources
      });
      const nextSavedCatalog = replaceScannedResources(
        previousCatalog,
        catalog.filter((resource) => resource.source === "echoink-local")
      );
      const consumedLegacyOverrides = consumeLegacyEnabledOverrides(
        liveResources,
        vaultResources.resources
      );
      const snapshotChanged = JSON.stringify(nextSavedCatalog)
        !== JSON.stringify(previousCatalog);
      const errorChanged = Boolean(previousLastError);
      if (snapshotChanged) {
        liveResources.catalog = structuredClone(nextSavedCatalog);
        liveResources.lastScannedAt = Date.now();
      }
      liveResources.lastError = "";
      if (snapshotChanged || errorChanged || consumedLegacyOverrides) {
        await this.plugin.saveEchoInkResourceMutation(previousResources);
      }
      const authoritativeResources = this.plugin.settings.resources;
      return buildActiveEchoInkResourceCatalog({
        settings: authoritativeResources,
        manual: vaultResources.resources
      });
    } catch (error) {
      if (isRollbackSafeResourceMutation(error)) {
        return this.lastKnownRuntimeCatalog();
      }
      throw error;
    }
  }

  private lastKnownRuntimeCatalog(): EchoInkResource[] {
    const settings = this.plugin.settings.resources;
    return buildActiveEchoInkResourceCatalog({
      settings,
      manual: settings.catalog.filter((resource) =>
        resource.source === "echoink-local")
    });
  }
}

function consumeLegacyEnabledOverrides(
  settings: CodexForObsidianSettings["resources"],
  scannedResources: EchoInkResource[]
): boolean {
  const overrides = settings.legacyEnabledOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return false;
  const discoveredIds = new Set(scannedResources.map((resource) => resource.id));
  const remaining = Object.fromEntries(
    Object.entries(overrides).filter(([resourceId]) => !discoveredIds.has(resourceId))
  );
  if (Object.keys(remaining).length === Object.keys(overrides).length) return false;
  if (Object.keys(remaining).length) settings.legacyEnabledOverrides = remaining;
  else delete settings.legacyEnabledOverrides;
  return true;
}

function replaceScannedResources(
  liveCatalog: EchoInkResource[],
  scannedResources: EchoInkResource[]
): EchoInkResource[] {
  const liveById = new Map(liveCatalog.map((resource) => [resource.id, resource]));
  return [
    ...liveCatalog.filter((resource) => resource.source !== "echoink-local"),
    ...scannedResources.map((resource) => {
      const live = liveById.get(resource.id);
      return live ? { ...resource, enabled: live.enabled } : resource;
    })
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRollbackSafeResourceMutation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { rollbackSafe?: unknown }).rollbackSafe === true
  );
}
