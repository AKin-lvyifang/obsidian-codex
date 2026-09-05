import type { App } from "obsidian";
import * as path from "node:path";
import { readNativeJournalContext, nativeJournalPathForDate } from "../home/native-journal";
import { normalizeObsidianCliRequest, type ObsidianNativePort } from "../harness/pi-native/pi-obsidian-tools";
import type { VaultDomainAdapter } from "../harness/pi-native/vault-domain-service";
import { VaultTargetResolver } from "../harness/pi-native/vault-target-resolver";

interface NativeCliApp {
  cli?: { handlers?: Map<string, { handler(args: Record<string, string>): string | Promise<string> }> };
}

export function createObsidianNativePort(
  app: App, adapter: VaultDomainAdapter, legacyDirectory: () => string
): ObsidianNativePort {
  const resolver = new VaultTargetResolver(adapter);
  return {
    async context() {
      const now = new Date();
      await resolver.resolve({
        vaultId: adapter.vaultId,
        relativePath: nativeJournalPathForDate(app, now, legacyDirectory()),
        mustExist: false,
        expectedKind: "file",
        allowMissingParentDirectories: true
      });
      return await readNativeJournalContext(app, {
        now, legacyDirectory: legacyDirectory(),
        readTemplate: async (relativePath) => {
          const target = await resolver.resolve({
            vaultId: adapter.vaultId, relativePath, mustExist: false,
            expectedKind: "file", allowMissingParentDirectories: true
          });
          if (!target.exists) return null;
          const snapshot = await adapter.readFile(target, { maxBytes: 24_000 });
          if (snapshot?.truncated) throw new Error("日记模板过长，本次未读取完整，请缩短模板后保存。");
          return snapshot?.content ?? null;
        }
      });
    },
    async cli(request) {
      const normalized = normalizeObsidianCliRequest({ ...request });
      // The captured App owns the current Vault. Never select a Vault by a model argument.
      const appAdapter = app.vault.adapter as unknown as { getBasePath?(): string };
      if (!appAdapter?.getBasePath || path.resolve(appAdapter.getBasePath()) !== path.resolve(adapter.vaultRootPath)) {
        throw new Error("obsidian_cli_vault_mismatch");
      }
      const handlers = (app as unknown as NativeCliApp).cli?.handlers;
      const handler = handlers?.get(normalized.command);
      if (!handler || typeof handler.handler !== "function") {
        return { available: false, engine: "obsidian-native-cli", reason: "当前 Obsidian 的原生 CLI 引擎不提供此命令。未执行终端或 PATH 同名程序。", fallbackTools: ["vault_search", "note_read", "obsidian_context"] };
      }
      const args: Record<string, string> = {};
      const relativePath = normalized.command === "files" ? normalized.folder : normalized.path;
      if (relativePath) {
        const target = await resolver.resolve({
          vaultId: adapter.vaultId, relativePath, mustExist: true,
          expectedKind: normalized.command === "read" ? "file" : "directory"
        });
        args[normalized.command === "files" ? "folder" : "path"] = target.relativePath;
      }
      if (normalized.query) args.query = normalized.query;
      if (normalized.ext) args.ext = normalized.ext;
      if (normalized.command === "search") args.limit = String(normalized.limit ?? 20);
      const result = await handler.handler(args);
      if (typeof result !== "string") throw new Error("obsidian_cli_result_invalid");
      return { available: true, engine: "obsidian-native-cli", command: normalized.command, output: result };
    }
  };
}
