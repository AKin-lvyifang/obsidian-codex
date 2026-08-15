import * as path from "node:path";

export const CURRENT_PLUGIN_ID = "codex-echoink";

export function pluginDataDir(
  vaultPath: string,
  pluginDir = CURRENT_PLUGIN_ID
): string {
  const normalized = normalizePluginDir(pluginDir);
  if (normalized.startsWith(".obsidian/plugins/")) {
    return path.join(vaultPath, normalized);
  }
  return path.join(vaultPath, ".obsidian", "plugins", normalized);
}

function normalizePluginDir(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return CURRENT_PLUGIN_ID;
  if (normalized.split("/").includes("..")) throw new Error("非法插件目录");
  return normalized;
}
