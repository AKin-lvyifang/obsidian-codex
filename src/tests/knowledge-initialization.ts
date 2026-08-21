import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildKnowledgeInitializationGuideTemplate,
  isKnowledgeInitializationRole,
  KnowledgeBaseInitializer,
  KNOWLEDGE_INITIALIZATION_GUIDE_PATH,
  KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES,
  knowledgeInitializationParentFolder,
  knowledgeInitializationPathExists,
  type KnowledgeInitializationBatchResult,
  type KnowledgeInitializationHost,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationProviderSnapshot,
  type KnowledgeInitializationVaultFile
} from "../knowledge-base/initializer";
import { buildKnowledgeInitializationProgress } from "../knowledge-base/initialization-progress";

export async function runKnowledgeInitializationTests(): Promise<void> {
  assertRootLevelInitializationFileHasNoFolderCreation();
  await assertHiddenInitializationFileExistsOutsideVaultIndex();
  await assertRecommendedAndCustomPreview();
  await assertArchiveAndTemplatesRoles();
  await assertAssignManyBatchSemantics();
  assertKnowledgeInitializationProgressContract();
  await assertProviderOrModelChangeRequiresNewPreview();
  await assertZeroQueuePreservesUserFilesAndSkipsProvider();
  await assertSerialBatchSizes();
  await assertFrozenExtractionSourcesAndNoProgress();
  await assertVerifiedMoveAndSourceChangePause();
  await assertConflictCancellationAndProviderRecoveryStops();
  await assertGuideConflictPreservesUserFile();
  await assertPriorGeneratedGuideIsReusableAfterNewPreview();
  await assertRestartPausesWithoutProviderReplay();
}

function assertRootLevelInitializationFileHasNoFolderCreation(): void {
  assert.equal(knowledgeInitializationParentFolder("LLM-WIKI.md"), null);
  assert.equal(
    knowledgeInitializationParentFolder("wiki/开始使用 EchoInk 知识库.md"),
    "wiki"
  );
}

async function assertHiddenInitializationFileExistsOutsideVaultIndex(): Promise<void> {
  const vaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-kb-path-exists-"));
  try {
    await fsp.mkdir(path.join(vaultRoot, "outputs"));
    await fsp.writeFile(path.join(vaultRoot, "outputs", ".ingest-tracker.md"), "tracker");
    assert.equal(
      await knowledgeInitializationPathExists(
        vaultRoot,
        "outputs/.ingest-tracker.md",
        false
      ),
      true,
      "disk files hidden from Obsidian's Vault index must still count as existing"
    );
    assert.equal(
      await knowledgeInitializationPathExists(vaultRoot, "LLM-WIKI.md", false),
      false
    );
  } finally {
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  }
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

async function assertArchiveAndTemplatesRoles(): Promise<void> {
  // archive/templates 是新 UI 的合法 Markdown 目标；assets 不是角色；
  // keep 仅保留给旧状态兼容。
  assert.deepEqual(KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES, [
    "raw", "wiki", "projects", "outputs", "inbox", "journal",
    "work", "archive", "templates"
  ]);
  assert.equal(isKnowledgeInitializationRole("archive"), true);
  assert.equal(isKnowledgeInitializationRole("templates"), true);
  assert.equal(isKnowledgeInitializationRole("keep"), true);
  assert.equal(isKnowledgeInitializationRole("assets"), false);
  assert.equal(isKnowledgeInitializationRole("unknown"), false);
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");
    const assigned = await initializer.assignMany([
      { sourcePath: "outside/a.md", role: "archive" },
      { sourcePath: "outside/b.md", role: "templates" }
    ]);
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/a.md")?.targetPath,
      "archive/imported/outside/a.md"
    );
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/b.md")?.targetPath,
      "templates/imported/outside/b.md"
    );
    // archive/templates 与 wiki 一样只做安全移动，不进入提炼队列；
    // 只有分配到 raw 的笔记才参与 /maintain 提炼。
    assert.deepEqual(assigned.extractionQueue, []);
    assert.equal(assigned.expectedBatches, 0);
    assert.equal(assigned.counts.move, 2);
  });
}

async function assertAssignManyBatchSemantics(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    host.addFile("outside/c.md", "gamma");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");

    // 10. 批量分配：同一 sourcePath 只处理一次，整批只刷新一次冻结计划、
    // 只持久化一次（onStateChanged 恰好一次）。
    const stateChangesBefore = host.stateChangedCalls;
    const batched = await initializer.assignMany([
      { sourcePath: "outside/a.md", role: "wiki" },
      { sourcePath: "outside/b.md", role: "projects" },
      { sourcePath: "outside/a.md", role: "archive" }
    ]);
    assert.equal(host.stateChangedCalls, stateChangesBefore + 1);
    const byPath = new Map(batched.items.map((item) => [item.sourcePath, item]));
    assert.equal(byPath.get("outside/a.md")?.role, "archive");
    assert.equal(byPath.get("outside/a.md")?.targetPath, "archive/imported/outside/a.md");
    assert.equal(byPath.get("outside/b.md")?.role, "projects");
    assert.equal(byPath.get("outside/c.md")?.role, "raw");
    // 只有 raw 目标的笔记进入提炼队列；archive/projects 只移动不提炼。
    assert.deepEqual(batched.extractionQueue, ["raw/imported/outside/c.md"]);
    assert.notEqual(batched.planDigest, "");

    // 11. 非法输入（未知路径）：整批零部分修改。
    const digestBefore = batched.planDigest;
    const stateBeforeInvalid = host.stateChangedCalls;
    await assert.rejects(
      initializer.assignMany([
        { sourcePath: "outside/c.md", role: "wiki" },
        { sourcePath: "outside/missing.md", role: "wiki" }
      ]),
      /找不到待分配的笔记/u
    );
    const afterInvalid = initializer.snapshot();
    assert.equal(afterInvalid?.planDigest, digestBefore);
    assert.equal(
      afterInvalid?.items.find((item) => item.sourcePath === "outside/c.md")?.role,
      "raw"
    );
    assert.equal(host.stateChangedCalls, stateBeforeInvalid);

    // 11. 非法输入（未知角色）：同样整批拒绝。
    await assert.rejects(
      initializer.assignMany([
        { sourcePath: "outside/c.md", role: "assets" as never }
      ]),
      /无效的知识库目录角色/u
    );
    assert.equal(
      initializer.snapshot()?.items.find((item) => item.sourcePath === "outside/c.md")?.role,
      "raw"
    );

    // 7/9. 单条 assign 委托批量接口：把同一笔记从 archive 移到 wiki 后，
    // 它只属于 wiki 一个目录；archive 目标不再出现在任何计划字段里。
    const moved = await initializer.assign("outside/a.md", "wiki");
    const movedItem = moved.items.find((item) => item.sourcePath === "outside/a.md");
    assert.equal(movedItem?.role, "wiki");
    assert.equal(movedItem?.targetPath, "wiki/imported/outside/a.md");
    assert.equal(moved.extractionQueue.includes("archive/imported/outside/a.md"), false);
    assert.equal(moved.extractionQueue.includes("wiki/imported/outside/a.md"), false);
    assert.deepEqual(moved.extractionQueue, ["raw/imported/outside/c.md"]);
  });
}

function assertKnowledgeInitializationProgressContract(): void {
  const baseJob = makeProgressJobFixture();

  // 无 job / 各阶段权重。
  assert.deepEqual(buildKnowledgeInitializationProgress(null, false), {
    stage: "idle", percent: 0, completed: 0, total: 0
  });
  assert.deepEqual(
    buildKnowledgeInitializationProgress({ ...baseJob, phase: "preview" }, false),
    { stage: "plan", percent: 5, completed: 0, total: 0 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "create_directories", createdDirectories: ["raw", "wiki", "projects", "outputs"]
    }, false),
    { stage: "directories", percent: 11, completed: 4, total: 10 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "move_notes", moveCursor: 4, items: makeProgressItems(10)
    }, false),
    { stage: "moving", percent: 30, completed: 4, total: 10 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "batch_extraction",
      extractionQueue: makeProgressItems(20), extractionCursor: 8
    }, false),
    { stage: "extracting", percent: 63, completed: 8, total: 20 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({ ...baseJob, phase: "generate_guide" }, false),
    { stage: "guide", percent: 95, completed: 0, total: 0 }
  );

  // 16/17. job.status 已 initialized 但 settings 未标记时最多 99%；
  // settings 真正 initialized 后才 100%。
  assert.deepEqual(
    buildKnowledgeInitializationProgress(
      { ...baseJob, phase: "complete", status: "initialized" },
      false
    ),
    { stage: "done", percent: 99, completed: 0, total: 0 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress(
      { ...baseJob, phase: "complete", status: "initialized" },
      true
    ),
    { stage: "done", percent: 100, completed: 0, total: 0 }
  );

  // 15. 空目录 / 0 篇移动 / 0 篇提炼不产生 NaN，按区间完成处理。
  const emptyDirs = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "create_directories", createdDirectories: [] },
    false
  );
  assert.equal(emptyDirs.percent, 5);
  const emptyMoves = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "move_notes", items: [], moveCursor: 0 },
    false
  );
  assert.equal(emptyMoves.percent, 45);
  const emptyExtractions = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "batch_extraction", extractionQueue: [], extractionCursor: 0 },
    false
  );
  assert.equal(emptyExtractions.percent, 90);
  for (const progress of [emptyDirs, emptyMoves, emptyExtractions]) {
    assert.equal(Number.isFinite(progress.percent), true);
    assert.equal(Number.isNaN(progress.percent), false);
    assert.ok(progress.percent >= 0 && progress.percent <= 100);
  }
}

function makeProgressItems(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `raw/imported/note-${index}.md`);
}

function makeProgressJobFixture(): KnowledgeInitializationJob {
  return {
    schemaVersion: 1,
    jobId: "progress-fixture",
    templateVersion: "onboarding-v1",
    mode: "recommended",
    phase: "move_notes",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    provider: { providerId: "provider-ready", model: "model-ready" },
    planDigest: "sha256:progress-fixture",
    confirmedDigest: null,
    items: [],
    extractionSources: [],
    extractionQueue: [],
    extractionCursor: 0,
    expectedBatches: 0,
    moveCursor: 0,
    createdDirectories: [],
    conversationId: null,
    productRunIds: [],
    counts: { move: 0, keep: 0, conflict: 0, ignored: 0, extraction: 0 },
    guidePath: KNOWLEDGE_INITIALIZATION_GUIDE_PATH,
    lastError: "",
    recoveryAction: ""
  };
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

async function assertPriorGeneratedGuideIsReusableAfterNewPreview(): Promise<void> {
  await withHost(async (host) => {
    const priorGuide = buildKnowledgeInitializationGuideTemplate(
      new Date("2026-08-20T08:30:00.000Z")
    );
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, priorGuide);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), priorGuide);
    assert.equal(host.openedGuide, KNOWLEDGE_INITIALIZATION_GUIDE_PATH);
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
  stateChangedCalls = 0;
  private clock = 1_700_000_000_000;

  constructor(
    readonly privateRootPath: string,
    private provider: KnowledgeInitializationProviderSnapshot | null
  ) {}

  now = (): number => ++this.clock;

  onStateChanged = (): void => {
    this.stateChangedCalls += 1;
  };

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
    if (!relativePath || relativePath === "." || this.folders.has(relativePath)) {
      throw new Error("Folder already exists.");
    }
    this.folders.add(relativePath);
  }

  async createText(relativePath: string, content: string): Promise<void> {
    if (this.files.has(relativePath)) throw new Error("already_exists");
    const parentFolder = knowledgeInitializationParentFolder(relativePath);
    if (parentFolder && !await this.pathExists(parentFolder)) {
      await this.createFolder(parentFolder);
    }
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
