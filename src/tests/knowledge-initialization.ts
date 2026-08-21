import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  KnowledgeBaseInitializer,
  KNOWLEDGE_INITIALIZATION_GUIDE_PATH,
  type KnowledgeInitializationBatchResult,
  type KnowledgeInitializationHost,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationProviderSnapshot,
  type KnowledgeInitializationVaultFile
} from "../knowledge-base/initializer";

export async function runKnowledgeInitializationTests(): Promise<void> {
  await assertRecommendedAndCustomPreview();
  await assertProviderOrModelChangeRequiresNewPreview();
  await assertZeroQueuePreservesUserFilesAndSkipsProvider();
  await assertSerialBatchSizes();
  await assertFrozenExtractionSourcesAndNoProgress();
  await assertVerifiedMoveAndSourceChangePause();
  await assertConflictCancellationAndProviderRecoveryStops();
  await assertGuideConflictPreservesUserFile();
  await assertRestartPausesWithoutProviderReplay();
}

async function assertProviderOrModelChangeRequiresNewPreview(): Promise<void> {
  for (const changedProvider of [
    { providerId: "provider-changed", model: "model-ready" },
    { providerId: "provider-ready", model: "model-changed" }
  ]) {
    await withHost(async (host) => {
      host.addFile("raw/a.md", "a");
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      const preview = await initializer.startPreview("recommended");
      assert.deepEqual(preview.provider, {
        providerId: "provider-ready",
        model: "model-ready"
      });
      host.setProvider(changedProvider);
      const paused = await initializer.confirm();
      assert.equal(paused.status, "paused");
      assert.equal(paused.confirmedDigest, null);
      assert.match(paused.lastError, /Provider 或模型已变化/u);
      assert.match(paused.recoveryAction, /重新生成预览并确认/u);
      assert.equal(host.batchCalls.length, 0);
    });
  }
}

async function assertRecommendedAndCustomPreview(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("outside/note.md", "alpha");
    host.addFile("outside/long.markdown", "beta");
    host.addFile("outside/rejected.mdown", "nope");
    host.addFile("raw/existing.md", "raw");
    host.addFile("wiki/existing.md", "wiki");
    host.addFile("LLM-WIKI.md", "profile");
    host.addFile("assets/image.png", "binary");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const recommended = await initializer.startPreview("recommended");
    assert.deepEqual(
      recommended.items.map((item) => item.sourcePath),
      ["outside/long.markdown", "outside/note.md"]
    );
    assert.deepEqual(
      recommended.items.map((item) => item.targetPath),
      ["raw/imported/outside/long.markdown", "raw/imported/outside/note.md"]
    );
    assert.deepEqual(recommended.extractionQueue, [
      "raw/existing.md",
      "raw/imported/outside/long.markdown",
      "raw/imported/outside/note.md"
    ]);
    assert.deepEqual(
      recommended.extractionSources.map((source) => source.path),
      recommended.extractionQueue
    );
    assert.equal(recommended.expectedBatches, 1);

    const custom = await initializer.startPreview("custom");
    const assigned = await initializer.assign("outside/note.md", "wiki");
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/note.md")?.targetPath,
      "wiki/imported/outside/note.md"
    );
    assert.equal(assigned.extractionQueue.includes("wiki/imported/outside/note.md"), false);
    assert.equal(assigned.extractionQueue.includes("raw/imported/outside/note.md"), false);
    assert.equal(custom.mode, "custom");
  });
}

async function assertFrozenExtractionSourcesAndNoProgress(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("raw/a.md", "before");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.match(preview.extractionSources[0]?.sourceRevision ?? "", /^sha256:/u);
    host.addFile("raw/a.md", "after");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "failed_recoverable");
    assert.match(paused.lastError, /待提炼来源已变化/u);
    assert.equal(host.batchCalls.length, 0);
  });

  await withHost(async (host) => {
    host.addFile("raw/a.md", "a");
    host.addFile("raw/b.md", "b");
    host.processedBatchPaths = ["raw/a.md"];
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "paused");
    assert.equal(paused.extractionCursor, 0);
    assert.match(paused.lastError, /队列没有可靠下降/u);
  });
}

async function assertGuideConflictPreservesUserFile(): Promise<void> {
  await withHost(async (host) => {
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, "# User guide\n");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const blocked = await waitForTerminal(initializer);
    assert.equal(blocked.status, "blocked_conflict");
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), "# User guide\n");
    assert.equal(host.initializedJob, null);
  }, null);
}

async function assertConflictCancellationAndProviderRecoveryStops(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("notes/conflict.md", "source");
    host.addFile("raw/imported/notes/conflict.md", "user target");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.equal(preview.items[0]?.state, "conflict");
    const blocked = await initializer.confirm();
    assert.equal(blocked.status, "blocked_conflict");
    assert.equal(host.read("raw/imported/notes/conflict.md"), "user target");
  });

  await withHost(async (host) => {
    host.addFile("notes/move-before-cancel.md", "preserve moved bytes");
    host.blockBatchUntilAbort = true;
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    await waitUntil(() => host.batchCalls.length === 1);
    const cancelled = await initializer.cancel();
    assert.equal(cancelled?.status, "cancelled");
    await waitUntil(() => !initializer.isRunning);
    assert.equal(host.read("notes/move-before-cancel.md"), null);
    assert.equal(
      host.read("raw/imported/notes/move-before-cancel.md"),
      "preserve moved bytes"
    );
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), null);
    assert.equal(host.initializedJob, null);
  });

  for (const [outcome, expectedCalls] of [
    ["failed", 2],
    ["write_uncertain", 1]
  ] as const) {
    await withHost(async (host) => {
      host.addFile("raw/a.md", "a");
      host.batchOutcome = outcome;
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      await initializer.startPreview("recommended");
      await initializer.confirm();
      const stopped = await waitForTerminal(initializer);
      assert.equal(
        stopped.status,
        outcome === "failed" ? "failed_recoverable" : "write_uncertain"
      );
      assert.equal(host.batchCalls.length, expectedCalls);
      assert.equal(stopped.extractionCursor, 0);
    });
  }
}

async function assertZeroQueuePreservesUserFilesAndSkipsProvider(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("wiki/index.md", "# User index\n\nKeep me.\n");
    host.addFile("LLM-WIKI.md", "# Existing profile\n");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.equal(preview.extractionQueue.length, 0);
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.batchCalls.length, 0);
    assert.match(host.read("wiki/index.md") ?? "", /Keep me/u);
    assert.match(host.read("wiki/index.md") ?? "", /echoink-onboarding-kb-init:start/u);
    assert.equal(host.read("LLM-WIKI.md"), "# Existing profile\n");
    assert.ok(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
    assert.equal(host.openedGuide, KNOWLEDGE_INITIALIZATION_GUIDE_PATH);
    await waitUntil(() => host.initializedJob?.status === "initialized");
    assert.equal(host.initializedJob?.status, "initialized");
  }, null);
}

async function assertSerialBatchSizes(): Promise<void> {
  for (const [count, expected] of [
    [1, [1]],
    [20, [20]],
    [21, [20, 1]]
  ] as const) {
    await withHost(async (host) => {
      for (let index = 0; index < count; index += 1) {
        host.addFile(`raw/note-${String(index).padStart(2, "0")}.md`, `note ${index}`);
      }
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      const preview = await initializer.startPreview("recommended");
      assert.equal(preview.extractionQueue.length, count);
      await initializer.confirm();
      const completed = await waitForTerminal(initializer);
      assert.equal(completed.status, "initialized");
      assert.deepEqual(host.batchCalls.map((batch) => batch.length), expected);
      assert.equal(new Set(host.batchConversationIds).size, 1);
    });
  }
}

async function assertVerifiedMoveAndSourceChangePause(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("notes/a.md", "original");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.read("notes/a.md"), null);
    assert.equal(host.read("raw/imported/notes/a.md"), "original");
  });

  await withHost(async (host) => {
    host.addFile("notes/changed.md", "before");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    host.addFile("notes/changed.md", "after");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "failed_recoverable");
    assert.match(paused.lastError, /source_changed/u);
    assert.equal(host.read("raw/imported/notes/changed.md"), null);
  });
}

async function assertRestartPausesWithoutProviderReplay(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("raw/a.md", "a");
    host.blockFolders = true;
    const first = new KnowledgeBaseInitializer(host);
    await first.initialize();
    await first.startPreview("recommended");
    await first.confirm();
    await waitUntil(() => first.snapshot()?.status === "active");
    const resumed = new KnowledgeBaseInitializer(host);
    await resumed.initialize();
    assert.equal(resumed.snapshot()?.status, "paused");
    assert.equal(host.batchCalls.length, 0);
  });
}

async function waitForTerminal(
  initializer: KnowledgeBaseInitializer
): Promise<Readonly<KnowledgeInitializationJob>> {
  await waitUntil(() => {
    const status = initializer.snapshot()?.status;
    return Boolean(status && status !== "active" && status !== "preview");
  });
  const snapshot = initializer.snapshot();
  assert.ok(snapshot);
  return snapshot;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("knowledge initialization test timed out");
}

async function withHost(
  run: (host: MemoryKnowledgeInitializationHost) => Promise<void>,
  provider: KnowledgeInitializationProviderSnapshot | null = {
    providerId: "provider-ready",
    model: "model-ready"
  }
): Promise<void> {
  const privateRootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-kb-init-"));
  const host = new MemoryKnowledgeInitializationHost(privateRootPath, provider);
  try {
    await run(host);
  } finally {
    await fsp.rm(privateRootPath, { recursive: true, force: true });
  }
}

class MemoryKnowledgeInitializationHost implements KnowledgeInitializationHost {
  readonly vaultRootPath = "/virtual/vault";
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly batchCalls: string[][] = [];
  readonly batchConversationIds: string[] = [];
  readonly processed = new Set<string>();
  openedGuide = "";
  initializedJob: Readonly<KnowledgeInitializationJob> | null = null;
  processedBatchPaths: string[] | null = null;
  batchOutcome: "completed" | "failed" | "write_uncertain" = "completed";
  blockBatchUntilAbort = false;
  blockFolders = false;
  private clock = 1_700_000_000_000;

  constructor(
    readonly privateRootPath: string,
    private provider: KnowledgeInitializationProviderSnapshot | null
  ) {}

  now = (): number => ++this.clock;

  addFile(relativePath: string, content: string): void {
    this.files.set(relativePath, content);
  }

  read(relativePath: string): string | null {
    return this.files.get(relativePath) ?? null;
  }

  async listVaultFiles(): Promise<readonly KnowledgeInitializationVaultFile[]> {
    return [...this.files.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, content]) => ({
        path: filePath,
        size: Buffer.byteLength(content),
        mtime: 100,
        extension: path.posix.extname(filePath).slice(1),
        symbolicLink: false
      }));
  }

  async readText(relativePath: string): Promise<string | null> {
    return this.read(relativePath);
  }

  async pathExists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath) || this.folders.has(relativePath);
  }

  async createFolder(relativePath: string): Promise<void> {
    if (this.blockFolders) await new Promise<void>(() => {});
    this.folders.add(relativePath);
  }

  async createText(relativePath: string, content: string): Promise<void> {
    if (this.files.has(relativePath)) throw new Error("already_exists");
    this.files.set(relativePath, content);
  }

  async updateText(relativePath: string, expectedContentHash: string, content: string): Promise<void> {
    const current = this.files.get(relativePath);
    if (current === undefined || hash(current) !== expectedContentHash) throw new Error("version_conflict");
    this.files.set(relativePath, content);
  }

  async moveMarkdown(sourcePath: string, targetPath: string, expectedContentHash: string): Promise<void> {
    const source = this.files.get(sourcePath);
    if (source === undefined || hash(source) !== expectedContentHash) throw new Error("version_conflict");
    if (this.files.has(targetPath)) throw new Error("already_exists");
    this.files.delete(sourcePath);
    this.files.set(targetPath, source);
  }

  currentProvider(): KnowledgeInitializationProviderSnapshot | null {
    return this.provider;
  }

  setProvider(provider: KnowledgeInitializationProviderSnapshot | null): void {
    this.provider = provider;
  }

  processedRawPaths(): ReadonlySet<string> {
    return this.processed;
  }

  async ensureInitializationConversation(existingConversationId: string | null): Promise<string> {
    return existingConversationId ?? "knowledge-initialization-conversation";
  }

  async runMaintenanceBatch(input: Readonly<{
    conversationId: string;
    sourcePaths: readonly string[];
    signal: AbortSignal;
  }>): Promise<Readonly<KnowledgeInitializationBatchResult>> {
    this.batchCalls.push([...input.sourcePaths]);
    this.batchConversationIds.push(input.conversationId);
    if (this.blockBatchUntilAbort) {
      return await new Promise((resolve) => {
        input.signal.addEventListener("abort", () => resolve({
          status: "cancelled",
          productRunId: `run-${this.batchCalls.length}`
        }), { once: true });
      });
    }
    if (this.batchOutcome !== "completed") {
      return {
        status: this.batchOutcome,
        productRunId: `run-${this.batchCalls.length}`,
        message: `fixture-${this.batchOutcome}`
      };
    }
    return {
      status: "completed",
      productRunId: `run-${this.batchCalls.length}`,
      processedSourcePaths: this.processedBatchPaths ?? [...input.sourcePaths]
    };
  }

  async openGuide(relativePath: string): Promise<void> {
    this.openedGuide = relativePath;
  }

  async markInitialized(job: Readonly<KnowledgeInitializationJob>): Promise<void> {
    this.initializedJob = structuredClone(job);
  }
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
