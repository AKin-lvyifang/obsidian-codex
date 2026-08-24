import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentIdentityStateJson,
  type AgentIdentityState
} from "../harness/memory/agent-identity-state";
import {
  renderAgentMarkdown,
  renderBaseAgentMarkdown
} from "../harness/memory/cognitive-projection";
import {
  applyTemplateToState,
  emptyPersonalityState,
  personalityStateJson,
  type PersonalityState
} from "../harness/memory/personality-state";
import { renderTraitLine } from "../harness/memory/personality-templates";
import {
  PiPersonalMemoryToolSecurity,
  createPiPersonalMemoryToolDefinitions
} from "../harness/pi-native/pi-personal-memory-tools";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import {
  PersonalMemoryAccessError
} from "../harness/memory/personal-memory-repository";
import { estimatePiContextTokens } from "../harness/pi-native/pi-context-budget";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";

export async function runMemoryRecallHarnessContractScenarios(): Promise<void> {
  await scenarioRecallWhenIsNewWriteOldReadCompatible();
  await scenarioCompleteCatalogAndStablePagination();
  await scenarioRouteTokensOutrankContentNoise();
  await scenarioSearchToolResultAlwaysContainsCompleteJson();
  await scenarioRecallContextUsesTokenBudgetAndNoMemorySkips();
  await scenarioHarnessScansPastFiftyByBudget();
  await scenarioNoMemoryIdentityOnlyAndWarmSnapshotReuse();
  await scenarioCreateIsIdempotentAndBroadConflictsDoNotWrite();
  await scenarioRecallUsesOneBoundedTurnSnapshot();
  scenarioRecallProgressReusesAndDismissesOneTemporaryMessage();
  await scenarioHotPathPreparesRecallBeforeProviderRequest();
  console.log("PASS Memory Recall Harness contract scenarios");
}

async function scenarioCreateIsIdempotentAndBroadConflictsDoNotWrite(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const request = {
      operation: "create" as const,
      kind: "fact" as const,
      title: "稳定宽 key",
      content: "完全相同的正文",
      recallWhen: "需要稳定事实时",
      basis: "explicit" as const,
      expectedRevision: 0
    };
    const first = await fixture.repository.write(request, fixture.runtime({ userEntryId: "idem-1" }));
    const retry = await fixture.repository.write(request, fixture.runtime({ userEntryId: "idem-2" }));
    assert.equal(retry.status, "idempotent");
    assert.equal(retry.record?.id, first.record?.id);
    assert.equal(retry.revision, first.revision, "idempotent retry performs zero writes");

    const conflict = await fixture.repository.write({
      ...request,
      content: "同一宽 key 下的不同正文"
    }, fixture.runtime({ userEntryId: "idem-3" }));
    assert.equal(conflict.status, "possible_duplicate");
    assert.equal(conflict.record?.id, first.record?.id);
    assert.equal(conflict.revision, first.revision, "possible_duplicate performs zero writes");
    assert.equal((await fixture.repository.inspect()).records.length, 1);
  });
  console.log("PASS Memory create idempotency and possible_duplicate contract");
}

async function scenarioHarnessScansPastFiftyByBudget(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const query = "准备核对预算召回路标时";
    for (let index = 0; index < 60; index += 1) {
      await fixture.repository.write({
        operation: "create",
        kind: "decision",
        title: `${query} ${"超长候选".repeat(24)} ${index}`.slice(0, 200),
        content: "这批高分候选故意超过单轮注入预算。".repeat(30),
        recallWhen: `${query}，并检查第 ${index} 个高分干扰项。`,
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `past-fifty-noise-${index}` }));
    }
    const target = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "预算内目标",
      content: "目标正文很短。",
      recallWhen: query,
      basis: "explicit"
    } as never, fixture.runtime({ userEntryId: "past-fifty-target" }));
    for (let index = 0; index < 60; index += 1) {
      await fixture.repository.write({
        operation: "create",
        kind: "episode",
        title: `无关历史 ${index}`,
        content: "与当前召回路标无关。",
        recallWhen: `回顾其他主题 ${index} 时`,
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `past-fifty-tail-${index}` }));
    }

    const internals = fixture.repository as unknown as {
      readRecord: (...args: unknown[]) => Promise<unknown>;
    };
    const originalReadRecord = internals.readRecord.bind(fixture.repository);
    let recordReads = 0;
    internals.readRecord = async (...args: unknown[]) => {
      recordReads += 1;
      return await originalReadRecord(...args);
    };

    const runtime = fixture.runtime();
    const prepared = await new PersonalMemoryRecallHarness(fixture.repository).prepareTurnContext({
      memoryMode: "normal",
      query,
      // 预算包含一次性 JSON/XML 包装开销（Recall PRD §12），因此比旧值略高。
      tokenBudget: 120,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    });
    assert.equal(prepared.recall?.total, 121);
    assert.equal(prepared.recall?.candidates.some((item) => item.id === target.record?.id), true);
    assert.equal(recordReads, prepared.recall?.injected, "只能读取预算实际选中的正文");
  });
}

async function scenarioNoMemoryIdentityOnlyAndWarmSnapshotReuse(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "暖轮失效检测",
      content: "外部编辑前的正文。",
      recallWhen: "检查 Repository 暖轮时",
      basis: "explicit"
    } as never, fixture.runtime({ userEntryId: "warm-snapshot-record" }));
    const internals = fixture.repository as unknown as {
      reconcileMarkdownTruth: (...args: unknown[]) => Promise<unknown>;
      readMarkdownRecords: (...args: unknown[]) => Promise<unknown>;
      readSearchIndexSnapshot: (...args: unknown[]) => Promise<unknown>;
    };
    const originalReconcile = internals.reconcileMarkdownTruth.bind(fixture.repository);
    const originalReadRecords = internals.readMarkdownRecords.bind(fixture.repository);
    const originalReadIndex = internals.readSearchIndexSnapshot.bind(fixture.repository);
    let reconcileCalls = 0;
    let recordScans = 0;
    let indexReads = 0;
    internals.reconcileMarkdownTruth = async (...args: unknown[]) => {
      reconcileCalls += 1;
      return await originalReconcile(...args);
    };
    internals.readMarkdownRecords = async (...args: unknown[]) => {
      recordScans += 1;
      return await originalReadRecords(...args);
    };
    internals.readSearchIndexSnapshot = async (...args: unknown[]) => {
      indexReads += 1;
      return await originalReadIndex(...args);
    };

    const harness = new PersonalMemoryRecallHarness(fixture.repository);
    const runtime = fixture.runtime();
    const input = {
      memoryMode: "normal" as const,
      query: "检查 Repository 暖轮",
      tokenBudget: 300,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    };
    const coldStartedAt = performance.now();
    const cold = await harness.prepareTurnContext(input);
    const coldPrefetchMs = performance.now() - coldStartedAt;
    const afterCold = { reconcileCalls, recordScans, indexReads };
    const warmStartedAt = performance.now();
    const warm = await harness.prepareTurnContext(input);
    const warmPrefetchMs = performance.now() - warmStartedAt;
    assert.equal(warm.revision, cold.revision);
    assert.deepEqual(
      { reconcileCalls, recordScans },
      { reconcileCalls: afterCold.reconcileCalls, recordScans: afterCold.recordScans },
      "同一 Repository 暖轮不得重做 Markdown reconcile 或 records 全扫"
    );
    assert.equal(indexReads, afterCold.indexReads + 1, "暖轮只复用已构建索引，不重新分词重建");
    console.log(
      `EVIDENCE Memory Recall local prefetch cold=${coldPrefetchMs.toFixed(2)}ms warm=${warmPrefetchMs.toFixed(2)}ms warmReconcileDelta=0 warmRecordScanDelta=0`
    );

    const recordPath = path.join(fixture.repository.layout.root, created.record!.file);
    const external = (await readFile(recordPath, "utf8")).replace(
      "外部编辑前的正文。",
      "外部编辑后的正文。"
    );
    await writeFile(recordPath, external, "utf8");
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: created.record!.file
    });
    const changed = await harness.prepareTurnContext(input);
    assert.ok(changed.revision > warm.revision, "外部 Markdown 编辑必须让暖快照失效");
    assert.equal(reconcileCalls, afterCold.reconcileCalls,
      "已知文件事件不得重跑全量 reconcile");
    assert.equal(recordScans, afterCold.recordScans,
      "已知文件事件只刷新该文件，不扫描一级 Memory 目录");

    const templated = applyTemplateToState(emptyPersonalityState(0), {
      templateId: "advisor",
      now: fixture.now(),
      reset: false,
      idFactory: (() => {
        let id = 0;
        return () => `no_memory_template_${++id}`;
      })()
    });
    const personalized: PersonalityState = Object.freeze({
      ...templated,
      revision: templated.revision + 1,
      observed: Object.freeze({
        ...templated.observed,
        sharpness: Object.freeze({
          id: "no_memory_observed_sharpness",
          dimension: "sharpness",
          basis: "observed",
          status: "current",
          score: 0.95,
          sourceMemoryIds: Object.freeze([created.record!.id]),
          evidence: "长期协作观察出的表达强度",
          createdAt: fixture.now(),
          updatedAt: fixture.now(),
          revision: templated.revision + 1
        })
      }),
      learnedRequirements: Object.freeze([Object.freeze({
        id: "no_memory_learned_requirement",
        text: "长期协作要求：每次都复述隐藏画像",
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: Object.freeze([created.record!.id]),
        revision: templated.revision + 1
      })]),
      processedSources: Object.freeze([Object.freeze({
        memoryId: created.record!.id,
        memoryRevision: created.record!.revision,
        processedAt: fixture.now()
      })]),
      updatedAt: fixture.now()
    });
    const identity: AgentIdentityState = Object.freeze({
      schema: "echoink.agent-identity.v1",
      revision: 3,
      displayName: "静墨",
      avatar: Object.freeze({ kind: "preset", presetId: "fixture-avatar" }),
      updatedAt: fixture.now()
    });
    const hiddenUserText = "只应存在于 USER.md 的隐藏画像";
    await writeFile(fixture.repository.layout.personalityState, personalityStateJson(personalized), "utf8");
    await writeFile(fixture.repository.layout.agentIdentity, agentIdentityStateJson(identity), "utf8");
    await writeFile(fixture.repository.layout.agent, renderAgentMarkdown(personalized, identity), "utf8");
    await writeFile(fixture.repository.layout.user, `# USER\n\n- ${hiddenUserText}\n`, "utf8");

    const beforeNoMemory = { reconcileCalls, recordScans, indexReads };
    const beforeNoMemoryTree = await snapshotTreeBytes(fixture.repository.layout.root);
    const noMemory = await harness.prepareTurnContext({
      ...input,
      memoryMode: "no_memory"
    });
    const explicitSharpnessLine = renderTraitLine(
      "sharpness",
      personalized.explicit.sharpness!.score,
      "zh"
    );
    const observedSharpnessLine = renderTraitLine(
      "sharpness",
      personalized.observed.sharpness!.score,
      "zh"
    );
    assert.notEqual(explicitSharpnessLine, observedSharpnessLine,
      "fixture must independently distinguish explicit and observed trait output");
    assert.equal(noMemory.agent, renderBaseAgentMarkdown(personalized, identity));
    assert.notEqual(noMemory.agent, renderAgentMarkdown(personalized, identity),
      "no_memory must remove observed personality and learned requirements");
    assert.ok(noMemory.agent.includes(explicitSharpnessLine),
      "no_memory keeps the selected template's explicit trait line");
    assert.ok(!noMemory.agent.includes(observedSharpnessLine),
      "no_memory excludes the observed trait line independently of learned requirements");
    assert.match(noMemory.agent, /当前名称：静墨/u,
      "no_memory keeps the configured Agent name");
    assert.match(noMemory.agent, /初始模板：/u,
      "no_memory keeps the selected personality template baseline");
    assert.doesNotMatch(noMemory.agent, /长期协作要求：每次都复述隐藏画像/u);
    assert.doesNotMatch(noMemory.agent, new RegExp(hiddenUserText, "u"));
    assert.equal(noMemory.user, null);
    assert.equal(noMemory.memory, null);
    assert.equal(noMemory.recall, null);
    assert.deepEqual(noMemory.injectionKeys, ["echoink.agent"]);
    assert.deepEqual(
      { reconcileCalls, recordScans, indexReads },
      beforeNoMemory,
      "/no-memory 只能读取身份与人格模板状态，不得 reconcile、扫描 records 或读取 search-index"
    );
    assert.deepEqual(
      await snapshotTreeBytes(fixture.repository.layout.root),
      beforeNoMemoryTree,
      "/no-memory must not initialize, rewrite, or otherwise mutate the Memory tree"
    );
  });
}

async function snapshotTreeBytes(root: string): Promise<readonly Readonly<{
  relativePath: string;
  type: "directory" | "file";
  content?: string;
}>[]> {
  const snapshot: Array<Readonly<{
    relativePath: string;
    type: "directory" | "file";
    content?: string;
  }>> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (entry.isDirectory()) {
        snapshot.push(Object.freeze({ relativePath, type: "directory" }));
        await visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.push(Object.freeze({
          relativePath,
          type: "file",
          content: (await readFile(absolutePath)).toString("base64")
        }));
      }
    }
  };
  await visit(root);
  return Object.freeze(snapshot);
}

async function scenarioRecallUsesOneBoundedTurnSnapshot(): Promise<void> {
  let snapshotCalls = 0;
  let capturedQuery = "";
  let capturedMode = "";
  let capturedRuntime: Record<string, unknown> | null = null;
  const repository = {
    async prepareTurnSnapshot(
      input: Readonly<{ memoryMode: string; query?: string }>,
      runtime?: Record<string, unknown>
    ) {
      snapshotCalls += 1;
      capturedMode = input.memoryMode;
      capturedQuery = input.query ?? "";
      capturedRuntime = runtime ?? null;
      return {
        revision: 41,
        scanned: 1,
        agent: "AGENT",
        user: "USER",
        memory: "OVERVIEW",
        injectionKeys: ["echoink.agent", "echoink.user", "echoink.memory.overview"],
        search: {
          revision: 41,
          total: 1,
          returned: 1,
          remaining: 0,
          exhausted: true,
          pendingSecondaryHits: [],
          nextCursor: null,
          items: [{
            id: "mem_snapshot",
            kind: "decision",
            status: "current",
            title: "当前问题优先",
            recallWhen: "超长问题仍需召回时",
            summary: "同一 revision 候选。",
            date: "2026-08-12",
            basis: "explicit",
            sourceSummary: "fixture",
            score: 10
          }]
        }
      };
    },
    async loadFixedContext() {
      throw new Error("recall_must_not_load_fixed_context_separately");
    },
    async search() {
      throw new Error("recall_must_not_search_separately");
    }
  };
  const harness = new PersonalMemoryRecallHarness(repository as never);
  const current = `当前关键问题-${"甲".repeat(2_500)}`;
  const prepared = await harness.prepareTurnContext({
    memoryMode: "normal",
    query: current,
    recentConversation: ["更旧历史-" + "乙".repeat(2_500), "最近历史-" + "丙".repeat(2_500)],
    tokenBudget: 320,
    vaultId: "vault-snapshot",
    conversationId: "conversation-snapshot",
    piSessionId: "session-snapshot",
    productRunId: "run-snapshot"
  });
  assert.equal(snapshotCalls, 1);
  assert.equal(capturedMode, "normal");
  assert.deepEqual(capturedRuntime, {
    vaultId: "vault-snapshot",
    conversationId: "conversation-snapshot",
    piSessionId: "session-snapshot",
    productRunId: "run-snapshot",
    memoryMode: "normal"
  });
  assert.equal("userEntryId" in (capturedRuntime ?? {}), false);
  assert.equal(prepared.revision, 41);
  assert.equal(prepared.recall?.candidates[0]?.id, "mem_snapshot");
  assert.ok(capturedQuery.length <= 2_000);
  assert.ok(estimatePiContextTokens(capturedQuery).tokens <= 320);
  assert.match(capturedQuery, /^当前关键问题-/u, "当前消息必须优先于历史保留");
}

function scenarioRecallProgressReusesAndDismissesOneTemporaryMessage(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({ piSessionId: "session-recall-progress", now: 1 });
  const event = (status: "active" | "completed", stage: "loading" | "matching" | "assembling", occurredAt: number) => ({
    type: "memory_recall_progress" as const,
    productRunId: "run-recall-progress",
    conversationId: "conversation-recall-progress",
    piSessionId: "session-recall-progress",
    activeLeafId: null,
    occurredAt,
    status,
    stage,
    elapsedMs: occurredAt - 1
  });
  view = projector.projectRuntimeEvent({ current: view, event: event("active", "loading", 301) });
  const first = view.messages.find((message) => message.itemType === "thinking");
  assert.ok(first);
  assert.match(first.text, /读取 Memory 真源/u);
  view = projector.projectRuntimeEvent({ current: view, event: event("active", "matching", 350) });
  const progressMessages = view.messages.filter((message) => message.itemType === "thinking");
  assert.equal(progressMessages.length, 1);
  assert.equal(progressMessages[0]!.id, first.id);
  assert.match(progressMessages[0]!.text, /寻找相关历史/u);
  view = projector.projectRuntimeEvent({ current: view, event: event("completed", "assembling", 380) });
  assert.equal(view.messages.some((message) => message.itemType === "thinking"), false);

  view = projector.projectRuntimeEvent({ current: view, event: event("active", "matching", 700) });
  view = projector.projectRuntimeEvent({
    current: view,
    event: {
      type: "message_update",
      productRunId: "run-recall-progress",
      conversationId: "conversation-recall-progress",
      piSessionId: "session-recall-progress",
      activeLeafId: null,
      occurredAt: 701,
      messageKey: "assistant-answer",
      textDelta: "首个回答"
    }
  });
  assert.equal(view.messages.some((message) => message.itemType === "thinking"), false);
}

async function scenarioRecallContextUsesTokenBudgetAndNoMemorySkips(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    for (let index = 0; index < 20; index += 1) {
      await fixture.repository.write({
        operation: "create",
        kind: "decision",
        title: `隐私排障决定 ${index}`,
        content: "排障只记录阶段与计数，不记录查询和 Memory 正文。".repeat(8),
        recallWhen: "准备展示隐私安全的排障证据时",
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `recall-budget-${index}` }));
    }
    const harness = new PersonalMemoryRecallHarness(fixture.repository);
    const runtime = fixture.runtime();
    const prepared = await harness.prepareTurnContext({
      memoryMode: "normal",
      query: "怎么展示隐私安全排障证据？",
      recentConversation: ["之前约定不能记录正文。"],
      tokenBudget: 300,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    });
    assert.ok(prepared.recall);
    assert.ok(prepared.recall.candidates.length > 0);
    assert.ok(prepared.recall.candidates.length < prepared.recall.total);
    assert.equal(prepared.recall.exhaustive, false);
    assert.equal(prepared.recall.hasMore, true);
    assert.equal(prepared.injectionKeys.includes("echoink.memory.recall"), true);

    const noMemory = await harness.prepareTurnContext({
      memoryMode: "no_memory",
      query: "即使相关也不能召回",
      tokenBudget: 300,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    });
    assert.equal(noMemory.memory, null);
    assert.equal(noMemory.recall, null);
    assert.equal(noMemory.injectionKeys.includes("echoink.memory.recall"), false);
  });
}

async function scenarioRecallWhenIsNewWriteOldReadCompatible(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "发布前先核对真实验收",
      content: "自动化通过不能冒充真实 Provider 与 Obsidian 验收。",
      recallWhen: "准备宣布阶段完成或发布时",
      basis: "explicit"
    } as never, fixture.runtime());
    const recordPath = path.join(fixture.repository.layout.root, created.record!.file);
    const newMarkdown = await readFile(recordPath, "utf8");
    assert.match(newMarkdown, /^recall_when: "准备宣布阶段完成或发布时"$/mu);
    assert.equal((created.record as unknown as { recallWhen?: string }).recallWhen, "准备宣布阶段完成或发布时");

    const legacyMarkdown = newMarkdown.replace(/^recall_when: .*\n/mu, "");
    await writeFile(recordPath, legacyMarkdown, "utf8");
    const legacyManifest = JSON.parse(
      await readFile(fixture.repository.layout.manifest, "utf8")
    ) as { records: Array<Record<string, unknown>> };
    delete legacyManifest.records[0]!.recallWhen;
    await writeFile(
      fixture.repository.layout.manifest,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
      "utf8"
    );
    const reopened = await fixture.reopen();
    const legacy = await reopened.read(created.record!.id, fixture.runtime());
    assert.equal(
      (legacy.record as unknown as { recallWhen?: string }).recallWhen,
      created.record!.title,
      "旧 Markdown 缺少 recall_when 时必须仅在读取结果中回退 title"
    );
    assert.doesNotMatch(await readFile(recordPath, "utf8"), /^recall_when:/mu);

    const superseded = await reopened.write({
      operation: "supersede",
      targetId: created.record!.id,
      title: "发布前核对真实验收与隐私边界",
      content: "自动化、真实 Provider、真实 UI 与隐私证据必须分层。",
      recallWhen: "准备宣布完成、发布或展示排障证据时",
      basis: "explicit",
      reason: "补充隐私边界",
      expectedRevision: legacy.revision
    } as never, fixture.runtime({ userEntryId: "supersede-recall-when" }));
    assert.equal(
      (superseded.record as unknown as { recallWhen?: string }).recallWhen,
      "准备宣布完成、发布或展示排障证据时"
    );
  });
}

async function scenarioCompleteCatalogAndStablePagination(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const expectedIds: string[] = [];
    const recallMarkers = new Map<number, string>([
      [9, "准备季度经营复盘时"],
      [37, "需要纠正已经变化的长期决定时"],
      [88, "讨论隐私安全排障证据时"]
    ]);
    for (let index = 1; index <= 105; index += 1) {
      const created = await fixture.repository.write({
        operation: "create",
        kind: index % 2 === 0 ? "fact" : "view",
        title: `历史记录 ${String(index).padStart(3, "0")}`,
        content: `这是第 ${index} 条长期记录，正文不包含召回路标。`,
        recallWhen: recallMarkers.get(index) ?? `处理历史主题 ${index} 时`,
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `catalog-entry-${index}` }));
      expectedIds.push(created.record!.id);
    }

    const index = JSON.parse(await readFile(fixture.repository.layout.searchIndex, "utf8")) as {
      schemaVersion?: number;
      catalog?: readonly unknown[];
    };
    assert.equal(index.schemaVersion, 3);
    assert.equal(index.catalog?.length, 105);

    await writeFile(fixture.repository.layout.searchIndex, JSON.stringify({
      ...index,
      catalog: [
        ...(index.catalog ?? []),
        { id: "mem_ghost_catalog", title: "幽灵记录", tokens: ["幽灵"] }
      ]
    }), "utf8");
    const repairedAfterTamper = await fixture.reopen();
    const tamperRepairedIndex = JSON.parse(
      await readFile(repairedAfterTamper.layout.searchIndex, "utf8")
    ) as { catalog: readonly { id: string }[] };
    assert.equal(tamperRepairedIndex.catalog.some((item) => item.id === "mem_ghost_catalog"), false);
    await assert.rejects(
      () => repairedAfterTamper.read("mem_ghost_catalog", fixture.runtime()),
      /unavailable/iu
    );

    await rm(repairedAfterTamper.layout.searchIndex);
    const repairedAfterMissing = await fixture.reopen();
    assert.equal(
      (JSON.parse(await readFile(repairedAfterMissing.layout.searchIndex, "utf8")) as { catalog: unknown[] }).catalog.length,
      105
    );
    await writeFile(repairedAfterMissing.layout.searchIndex, "{corrupt-index\n", "utf8");
    const repairedAfterCorruption = await fixture.reopen();
    assert.equal(
      (JSON.parse(await readFile(repairedAfterCorruption.layout.searchIndex, "utf8")) as { catalog: unknown[] }).catalog.length,
      105
    );

    const visited: string[] = [];
    let cursor: string | undefined;
    let revision: number | undefined;
    do {
      const page = await fixture.repository.search({
        query: "",
        limit: 17,
        ...(cursor ? { cursor } : {})
      } as never, fixture.runtime()) as unknown as {
        revision: number;
        total: number;
        returned: number;
        remaining: number;
        exhausted: boolean;
        nextCursor: string | null;
        items: readonly { id: string }[];
      };
      revision ??= page.revision;
      assert.equal(page.revision, revision);
      assert.equal(page.total, 105);
      assert.equal(page.returned, page.items.length);
      assert.equal(page.remaining, page.total - visited.length - page.returned);
      assert.equal(page.exhausted, page.remaining === 0);
      assert.equal(page.nextCursor === null, page.exhausted);
      visited.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(visited.length, 105);
    assert.equal(new Set(visited).size, 105);
    assert.deepEqual([...visited].sort(), [...expectedIds].sort());

    for (const [position, query] of recallMarkers) {
      const found = await fixture.repository.search({ query, limit: 10 } as never, fixture.runtime());
      assert.equal(found.items.some((item) => item.id === expectedIds[position - 1]), true);
    }

    const first = await fixture.repository.search({ query: "历史", limit: 1 } as never, fixture.runtime()) as unknown as {
      nextCursor: string | null;
      items: readonly { id: string }[];
    };
    assert.ok(first.nextCursor);
    const resizedPage = await fixture.repository.search({
      query: "历史",
      limit: 7,
      cursor: first.nextCursor
    } as never, fixture.runtime());
    assert.equal(resizedPage.returned, 7, "续页必须允许调整页大小");
    assert.equal(resizedPage.items.some((item) => item.id === first.items[0]?.id), false);
    await assert.rejects(
      () => fixture.repository.search({ query: "不同查询", limit: 1, cursor: first.nextCursor } as never, fixture.runtime()),
      (error) => error instanceof PersonalMemoryAccessError && error.code === "invalid_request"
    );
    await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "推进 revision",
      content: "旧 cursor 必须失效。",
      recallWhen: "分页期间发生外部变更时",
      basis: "explicit"
    } as never, fixture.runtime({ userEntryId: "catalog-revision-change" }));
    await assert.rejects(
      () => fixture.repository.search({ query: "历史", limit: 1, cursor: first.nextCursor } as never, fixture.runtime()),
      (error) => error instanceof PersonalMemoryAccessError && error.code === "revision_conflict"
    );
  });
}

async function scenarioRouteTokensOutrankContentNoise(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const target = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "发布门禁",
      content: "目标正文没有重复堆砌查询词。",
      recallWhen: "准备核对隐私安全排障证据时",
      basis: "explicit"
    } as never, fixture.runtime({ userEntryId: "route-target" }));
    for (let index = 0; index < 30; index += 1) {
      await fixture.repository.write({
        operation: "create",
        kind: "episode",
        title: `正文干扰 ${index}`,
        content: "隐私 安全 排障 证据 ".repeat(200),
        recallWhen: `回顾无关事件 ${index} 时`,
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `route-noise-${index}` }));
    }
    const found = await fixture.repository.search({
      query: "现在的问题是什么？\n准备核对隐私安全排障证据时\n此前聊过排障",
      limit: 10
    }, fixture.runtime());
    assert.equal(found.items[0]?.id, target.record?.id);
  });
}

async function scenarioSearchToolResultAlwaysContainsCompleteJson(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const longTitle = "结果预算".repeat(48).slice(0, 198);
    const longContent = "完整 JSON 不得被静默截断。".repeat(40);
    const longScope = "scope-segment-".repeat(18).slice(0, 238);
    for (let index = 0; index < 55; index += 1) {
      await fixture.repository.write({
        operation: "create",
        kind: "fact",
        title: `${longTitle}${index}`.slice(0, 200),
        content: longContent,
        recallWhen: `需要验证 Tool Result JSON 预算 ${index} 时`,
        scope: longScope,
        basis: "explicit"
      } as never, fixture.runtime({ userEntryId: `json-budget-${index}` }));
    }
    const runtime = fixture.runtime();
    const security = new PiPersonalMemoryToolSecurity({
      currentRuntime: () => runtime,
      currentUserEntry: { current: () => ({ entryId: runtime.userEntryId, text: "搜索长期 Memory" }) },
      writeAuthorization: { async authorize() { return null; } }
    });
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const tool = tools.find((candidate) => candidate.name === "memory_search");
    assert.ok(tool);
    const input = { query: "", limit: 50 };
    const toolCallId = "memory-search-json-budget";
    assert.equal(
      await security.handleToolCall({ toolName: "memory_search", toolCallId, input } as never, undefined),
      undefined
    );
    const pending = await tool.execute(
      toolCallId,
      input,
      new AbortController().signal,
      undefined,
      {} as never
    );
    const corrected = await security.handleToolResult({
      toolName: "memory_search",
      toolCallId,
      content: pending.content,
      details: pending.details,
      isError: false
    } as never);
    const match = /<echoink_memory_result[^>]*>\n([\s\S]*)\n<\/echoink_memory_result>/u.exec(
      corrected.content[0]?.text ?? ""
    );
    assert.ok(match);
    const result = JSON.parse(match[1]!) as {
      total: number;
      returned: number;
      remaining: number;
      exhausted: boolean;
      nextCursor: string | null;
      items: readonly unknown[];
    };
    assert.equal(result.returned, result.items.length);
    assert.equal(result.total, 55);
    assert.equal(result.remaining, result.total - result.returned);
    assert.equal(result.exhausted, result.remaining === 0);
    assert.equal(result.nextCursor === null, result.exhausted);
  });
}

async function scenarioHotPathPreparesRecallBeforeProviderRequest(): Promise<void> {
  const handlers = new Map<string, (event: any) => Promise<any>>();
  let loadFixedContextCalls = 0;
  let prepareTurnContextCalls = 0;
  let preparedMemoryMode = "";
  const progressEvents: unknown[] = [];
  const memoryAccess: any[] = [];
  const extension = createPiKnowledgeInlineExtension({
    vaultSecurity: Object.freeze({
      name: "memory-recall-hot-path-test",
      hidden: true,
      factory: async () => undefined
    }) as never,
    currentTurn: () => null,
    currentMemoryTurn: () => ({
      vaultId: "vault-recall",
      conversationId: "conversation-recall",
      piSessionId: "session-recall",
      productRunId: "product-run-recall",
      memoryMode: "normal",
      query: "这次决定与以前的隐私边界是否冲突？",
      recentConversation: ["之前讨论过排障证据。"],
      tokenBudget: 1_200
    } as never),
    currentTaskPlanTurn: () => null,
    personalMemory: {
      async loadFixedContext() {
        loadFixedContextCalls += 1;
        return {
          revision: 8,
          agent: "AGENT",
          user: "USER",
          memory: "OVERVIEW",
          injectionKeys: ["echoink.agent", "echoink.user", "echoink.memory.overview"]
        };
      },
      async prepareTurnContext(input) {
        prepareTurnContextCalls += 1;
        preparedMemoryMode = input.memoryMode;
        await input.onProgress?.("loading");
        await input.onProgress?.("catalog");
        await input.onProgress?.("matching");
        await input.onProgress?.("budgeting");
        await input.onProgress?.("assembling", {
          result: "completed",
          scanned: 8,
          candidates: 2,
          injected: 1,
          remaining: 7,
          exhausted: false
        });
        return {
          revision: 8,
          agent: "AGENT",
          user: "USER",
          memory: "OVERVIEW",
          recall: {
            candidates: [{ id: "mem_recall", title: "隐私边界", recallWhen: "展示排障证据时" }],
            exhaustive: false,
            hasMore: true
          },
          injectionKeys: ["echoink.agent", "echoink.user", "echoink.memory.overview", "echoink.memory.recall"]
        };
      }
    } as never,
    onPersonalMemoryRecallProgress(progress) {
      progressEvents.push(progress);
    },
    personalMemoryAvailable: false
    ,
    contextLedger: {
      captureBeforeAgentStart() {},
      captureTransientContextMessages() {},
      capturePersonalMemoryAccess(access) {
        if (access.mode === "normal") memoryAccess.push(access);
      }
    }
  });
  await extension.factory({
    on(name: string, handler: (event: any) => Promise<any>) {
      handlers.set(name, handler);
    }
  } as never);
  const before = await handlers.get("before_agent_start")!({
    systemPrompt: "SYSTEM",
    systemPromptOptions: { skills: [] }
  });
  assert.equal(prepareTurnContextCalls, 1);
  assert.equal(loadFixedContextCalls, 0);
  assert.equal(
    preparedMemoryMode,
    "normal",
    "toolCalling=false 只能禁用 Memory Tool，不能禁用本地 Recall"
  );
  assert.equal(
    memoryAccess[0]?.capability,
    "recall_only",
    "toolCalling=false 必须记录本地 Recall，而不是 fixed_context_only"
  );
  assert.equal(
    progressEvents.some((event: any) => event.status === "active"),
    false,
    "300ms 内完成的 Recall 不得闪烁临时状态"
  );
  assert.deepEqual((progressEvents[0] as any)?.recall, {
    result: "completed",
    scanned: 8,
    candidates: 2,
    injected: 1,
    remaining: 7,
    exhausted: false,
    stage: "assembling",
    elapsedMs: (progressEvents[0] as any).elapsedMs
  });
  assert.deepEqual(memoryAccess[0]?.recall, (progressEvents[0] as any)?.recall);
  const transformed = await handlers.get("context")!({
    messages: [{ role: "user", content: "question", timestamp: 1 }, before?.message].filter(Boolean)
  });
  assert.equal(
    transformed.messages.filter((message: any) => message.customType === "echoink-personal-memory-context-v1").length,
    1
  );
  assert.match(
    transformed.messages.find((message: any) => message.customType === "echoink-personal-memory-context-v1")?.content ?? "",
    /mem_recall/u
  );
}
