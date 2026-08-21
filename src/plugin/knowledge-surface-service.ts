import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { normalizePath, type TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import {
  buildKnowledgeBaseDashboardSnapshot,
  type KnowledgeBaseDashboardSnapshot
} from "../knowledge-base/dashboard";
import type { StoredAttachment } from "../settings/settings";
import {
  apiProviderHasUsableApiKey,
  getActiveApiProvider,
  newId,
  validateApiProvider
} from "../settings/settings";
import {
  KnowledgeBaseInitializer,
  type KnowledgeInitializationHost,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationMode,
  type KnowledgeInitializationRole,
  type KnowledgeInitializationVaultFile
} from "../knowledge-base/initializer";
import { pluginDataDir } from "./plugin-data-paths";

export type KnowledgeMaintenanceSurfaceStatus = Readonly<{
  state: "ready";
  message: "";
}>;

/** Current Knowledge dashboard and capture surfaces. Pi owns agent execution. */
export class EchoInkKnowledgeSurfaceService {
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly initializer: KnowledgeBaseInitializer;
  private readonly initializerReady: Promise<void>;
  private dashboardSnapshot:
    | { value: KnowledgeBaseDashboardSnapshot; signature: string; savedAt: number }
    | null = null;
  private dashboardFlight: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.captureService = new KnowledgeBaseCaptureService(plugin);
    this.initializer = new KnowledgeBaseInitializer(
      createKnowledgeInitializationHost(plugin)
    );
    this.initializerReady = this.initializer.initialize();
  }

  get isRunning(): boolean {
    return this.initializer.isRunning;
  }

  get maintenanceRecoveryStatus(): KnowledgeMaintenanceSurfaceStatus {
    return { state: "ready", message: "" };
  }

  async getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> {
    const signature = JSON.stringify(this.plugin.settings.knowledgeBase);
    const now = Date.now();
    if (
      this.dashboardSnapshot
      && this.dashboardSnapshot.signature === signature
      && now - this.dashboardSnapshot.savedAt <= 5_000
    ) {
      return this.dashboardSnapshot.value;
    }
    if (!this.dashboardFlight) {
      this.dashboardFlight = buildKnowledgeBaseDashboardSnapshot(
        this.plugin.getVaultPath(),
        this.plugin.settings.knowledgeBase
      ).then((value) => {
        this.dashboardSnapshot = { value, signature, savedAt: Date.now() };
        return value;
      }).finally(() => {
        this.dashboardFlight = null;
      });
    }
    return await this.dashboardFlight;
  }

  async cancelMaintenance(): Promise<{ accepted: false; message: string }> {
    return {
      accepted: false,
      message: "Knowledge 维护由 Pi Agent 执行，请在普通 EchoInk 会话中使用 /maintain。"
    };
  }

  async getInitializationState(): Promise<Readonly<KnowledgeInitializationJob> | null> {
    await this.initializerReady;
    return this.initializer.snapshot();
  }

  async startInitialization(
    mode: KnowledgeInitializationMode
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.startPreview(mode);
  }

  async assignInitializationNote(
    sourcePath: string,
    role: KnowledgeInitializationRole
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.assign(sourcePath, role);
  }

  async confirmInitialization(): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.confirm();
  }

  async continueInitialization(): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.continueJob();
  }

  async cancelInitialization(): Promise<Readonly<KnowledgeInitializationJob> | null> {
    await this.initializerReady;
    return await this.initializer.cancel();
  }

  async captureLink(): Promise<string[]> {
    return await this.captureService.captureLink();
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return await this.captureService.captureExternalFiles(files);
  }

  async unload(): Promise<void> {}
}

function createKnowledgeInitializationHost(
  plugin: CodexForObsidianPlugin
): KnowledgeInitializationHost {
  const vaultRootPath = path.resolve(plugin.getVaultPath());
  const privateRootPath = pluginDataDir(
    vaultRootPath,
    plugin.getPluginDataDirName()
  );
  const readText = async (relativePath: string): Promise<string | null> => {
    const file = plugin.app.vault.getFileByPath(normalizePath(relativePath));
    return file ? await plugin.app.vault.cachedRead(file) : null;
  };
  const ensureFolder = async (relativePath: string): Promise<void> => {
    const segments = normalizePath(relativePath).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = plugin.app.vault.getAbstractFileByPath(current);
      if (existing) continue;
      try {
        await plugin.app.vault.createFolder(current);
      } catch (error) {
        if (!plugin.app.vault.getAbstractFileByPath(current)) throw error;
      }
    }
  };
  return {
    vaultRootPath,
    privateRootPath,
    now: Date.now,
    async listVaultFiles(): Promise<readonly KnowledgeInitializationVaultFile[]> {
      return await Promise.all(plugin.app.vault.getFiles().map(async (file) => {
        const absolute = path.join(vaultRootPath, file.path);
        const symbolicLink = await fsp.lstat(absolute)
          .then((stats) => stats.isSymbolicLink(), () => true);
        return Object.freeze({
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
          extension: file.extension,
          symbolicLink
        });
      }));
    },
    readText,
    async pathExists(relativePath: string): Promise<boolean> {
      return plugin.app.vault.getAbstractFileByPath(normalizePath(relativePath)) !== null;
    },
    createFolder: ensureFolder,
    async createText(relativePath: string, content: string): Promise<void> {
      const normalized = normalizePath(relativePath);
      await ensureFolder(path.posix.dirname(normalized));
      if (plugin.app.vault.getAbstractFileByPath(normalized)) {
        throw new Error(`目标已存在：${normalized}`);
      }
      await plugin.app.vault.create(normalized, content);
    },
    async updateText(relativePath: string, expectedContentHash: string, content: string): Promise<void> {
      const file = requireVaultFile(plugin, relativePath);
      await plugin.app.vault.process(file, (current) => {
        if (contentHash(current) !== expectedContentHash) {
          throw new Error(`目标内容已变化：${relativePath}`);
        }
        return content;
      });
    },
    async moveMarkdown(sourcePath: string, targetPath: string, expectedContentHash: string): Promise<void> {
      const source = requireVaultFile(plugin, sourcePath);
      if (contentHash(await plugin.app.vault.cachedRead(source)) !== expectedContentHash) {
        throw new Error(`源笔记已变化：${sourcePath}`);
      }
      if (plugin.app.vault.getAbstractFileByPath(normalizePath(targetPath))) {
        throw new Error(`目标已存在：${targetPath}`);
      }
      await ensureFolder(path.posix.dirname(targetPath));
      await plugin.app.fileManager.renameFile(source, normalizePath(targetPath));
    },
    currentProvider() {
      const provider = getActiveApiProvider(plugin.settings);
      if (
        !provider
        || !apiProviderHasUsableApiKey(provider)
        || validateApiProvider(provider).length > 0
      ) return null;
      return Object.freeze({ providerId: provider.id, model: provider.model });
    },
    processedRawPaths() {
      return new Set(Object.keys(plugin.settings.knowledgeBase.processedSources));
    },
    async ensureInitializationConversation(existingConversationId: string | null): Promise<string> {
      if (existingConversationId) {
        const existing = await plugin.listPiConversations();
        if (existing.some((entry) => entry.conversationId === existingConversationId)) {
          return existingConversationId;
        }
      }
      const conversationId = newId("knowledge-initialization");
      const entry = await plugin.createPiConversation({
        conversationId,
        title: "知识库初始化",
        cwd: vaultRootPath,
        defaultMemoryMode: "normal"
      });
      if (!plugin.settings.sessions.some((session) => session.id === conversationId)) {
        plugin.settings.sessions.push({
          id: conversationId,
          title: entry.title,
          piSessionId: entry.piSessionId,
          defaultMemoryMode: entry.defaultMemoryMode,
          bodyAuthority: "pi_session_only",
          cwd: vaultRootPath,
          messages: [],
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        });
        await plugin.saveSettings(true);
      }
      return conversationId;
    },
    async runMaintenanceBatch(input) {
      const handle = await plugin.submitPiChat({
        conversationId: input.conversationId,
        text: "/maintain",
        submittedAt: Date.now(),
        maintenanceScope: {
          mode: "batch",
          sourcePaths: Object.freeze([...input.sourcePaths])
        }
      });
      const cancel = () => void plugin.cancelHarnessRun(handle.productRunId);
      input.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await handle.result;
        const error = result.error ?? "";
        if (result.terminalState === "cancelled") {
          return { status: "cancelled" as const, productRunId: handle.productRunId, message: error };
        }
        if (/write_uncertain/u.test(error)) {
          return { status: "write_uncertain" as const, productRunId: handle.productRunId, message: error };
        }
        if (result.terminalState !== "completed") {
          return { status: "failed" as const, productRunId: handle.productRunId, message: error || "Provider 批次失败。" };
        }
        return {
          status: "completed" as const,
          productRunId: handle.productRunId,
          processedSourcePaths: Object.freeze([...input.sourcePaths])
        };
      } finally {
        input.signal.removeEventListener("abort", cancel);
        plugin.releasePiProductionRun(handle.productRunId);
      }
    },
    async openGuide(relativePath: string): Promise<void> {
      const file = requireVaultFile(plugin, relativePath);
      await plugin.app.workspace.getLeaf("tab").openFile(file);
    },
    async markInitialized(job: Readonly<KnowledgeInitializationJob>): Promise<void> {
      plugin.settings.knowledgeBase.initialization = {
        status: "initialized",
        initializedAt: job.updatedAt,
        rulesFilePath: "LLM-WIKI.md",
        templateVersion: job.templateVersion,
        lastPreviewSummary: `移动 ${job.counts.move}，保留 ${job.counts.keep}，提炼 ${job.counts.extraction}，批次 ${job.expectedBatches}`
      };
      await plugin.saveSettings(true);
      plugin.refreshKnowledgeBaseSurfaces();
    },
    onStateChanged: () => plugin.refreshKnowledgeBaseSurfaces()
  };
}

function requireVaultFile(
  plugin: CodexForObsidianPlugin,
  relativePath: string
): TFile {
  const file = plugin.app.vault.getFileByPath(normalizePath(relativePath));
  if (!file) throw new Error(`找不到 Vault 文件：${relativePath}`);
  return file;
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
