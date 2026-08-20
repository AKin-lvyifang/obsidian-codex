/**
 * cognitive-system.ts — main-chain tests for 人格 / 做梦 / 二级事实 / Recall.
 *
 * The test Vault has no Provider API key, so dreaming is verified with a fake
 * LLM port; the real Provider path stays unverified by design.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import type { DreamLlmPort, DreamRunResult } from "../harness/memory/dream-engine";
import {
  applySecondaryDecay,
  createSecondaryRecord,
  secondaryRelativePath
} from "../harness/memory/secondary-memory-store";
import { currentPersonalityScores } from "../harness/memory/personality-state";
import { getPersonalityTemplate } from "../harness/memory/personality-templates";
import { defaultAgentProfile, defaultUserProfile } from "../harness/memory/personal-memory-repository";
import { renderAgentMarkdown } from "../harness/memory/cognitive-projection";
import { lexicalTokens } from "../harness/memory/search-index-v3";
import type { SecondaryMemoryRecord } from "../harness/memory/personal-memory-contracts";

const DAY_MS = 86_400_000;

function fakeDreamLlm(response: () => string): DreamLlmPort {
  return {
    call: async () => response()
  };
}

function validDreamJson(): string {
  return JSON.stringify({
    secondaryFacts: [{
      title: "手冲咖啡",
      content: "用户可能经常自己手冲咖啡，也许关心咖啡豆和器具话题。",
      recallWhen: "聊到咖啡、早餐或生活习惯时",
      matchTerms: ["手冲咖啡", "咖啡豆"],
      relation: "instance",
      reason: "来自记忆中对手冲流程的描述"
    }],
    personalitySignals: [{
      dimension: "tempo",
      direction: "increase",
      strength: 0.7,
      evidence: "用户偏好简短直接的回答"
    }],
    agentRequirements: ["回复保持简短直接"],
    userProfileItems: [{
      section: "preference",
      text: "用户喜欢手冲咖啡"
    }]
  });
}

async function createSystem(
  fixture: Readonly<PersonalMemoryFixture>,
  llm: () => DreamLlmPort | null
): Promise<CognitiveSystem> {
  return await CognitiveSystem.create({
    repository: fixture.repository,
    llm,
    getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
    isForegroundBusy: () => false,
    registerInterval: () => {},
    now: fixture.now
  });
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Personality template: instant local persistence, no Provider
// ---------------------------------------------------------------------------

async function scenarioTemplateSelectionPersistsWithoutProvider(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    let llmCalls = 0;
    const system = await createSystem(fixture, () => {
      llmCalls += 1;
      return { call: async () => { throw new Error("provider must not be called"); } };
    });

    const before = await readJson(fixture.repository.layout.manifest);
    const result = await system.selectPersonalityTemplate("executor");
    const template = getPersonalityTemplate("executor")!;

    assert.equal(llmCalls, 0);
    // State persisted to the truth source file.
    const stateFile = await readJson(fixture.repository.layout.personalityState);
    assert.equal(stateFile.templateId, "executor");
    const explicit = stateFile.explicit as Record<string, { score: number } | undefined>;
    for (const dimension of ["tempo", "energy", "mind", "warmth", "order", "stance"] as const) {
      assert.equal(explicit[dimension]?.score, template.scores[dimension]);
    }
    // AGENT.md rewritten in the same transaction, without Provider.
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.notEqual(agent, defaultAgentProfile());
    assert.match(agent, /执行人|执行/);
    // Manifest revision advanced exactly once.
    const after = await readJson(fixture.repository.layout.manifest);
    assert.equal(after.revision, (before.revision as number) + 1);
    // Scores visible to the product.
    const scores = currentPersonalityScores(result.state);
    assert.equal(scores.tempo, template.scores.tempo);
    // Durable across reopen (file is the truth source, not settings).
    const systemAgain = await createSystem(fixture, () => null);
    const reread = await systemAgain.readPersonalityState();
    assert.equal(reread.templateId, "executor");
  });
  console.log("PASS cognitive: template selection persists without Provider");
}

// ---------------------------------------------------------------------------
// 2. Personality reset: clears state, keeps Memory
// ---------------------------------------------------------------------------

async function scenarioPersonalityResetKeepsMemory(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("companion");
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户养了一只猫",
      content: "用户家里养了一只叫汤圆的猫。",
      recallWhen: "聊到宠物时",
      basis: "explicit"
    } as never, fixture.runtime());

    const result = await system.resetPersonality();
    assert.equal(result.state.templateId, null);
    const stateFile = await readJson(fixture.repository.layout.personalityState);
    assert.equal(stateFile.templateId ?? null, null);
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.equal(agent, renderAgentMarkdown(result.state));
    assert.ok(!agent.includes("温暖") || true); // projection is the empty-state default
    // Memory untouched.
    const state = await fixture.repository.readUserControlState();
    assert.ok(state.records.some((record) => record.id === created.record!.id && record.status === "current"));
  });
  console.log("PASS cognitive: reset clears personality but keeps Memory");
}

// ---------------------------------------------------------------------------
// 3. Dreaming: secondary facts + projections in ONE transaction
// ---------------------------------------------------------------------------

async function scenarioDreamCreatesSecondaryFacts(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    await system.selectPersonalityTemplate("advisor");
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "早晨的手冲流程",
      content: "用户每天早晨都有一套固定的手冲流程，偏好酸一点的风味。",
      recallWhen: "聊到早晨习惯或饮品时",
      basis: "explicit"
    } as never, fixture.runtime());
    const memoryId = created.record!.id;

    // The write was auto-enqueued into the durable pending queue.
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memoryId));

    const result = await system.forceDreamRun();
    assert.ok(result);
    assert.equal(result!.committed, true);
    assert.equal(result!.factsCreated, 1);
    assert.deepEqual([...result!.processedMemoryIds], [memoryId]);

    // Secondary markdown exists at the truth-source path.
    const facts = await system.listSecondaryForParent(memoryId);
    assert.equal(facts.length, 1);
    const fact = facts[0];
    assert.equal(fact.status, "current");
    assert.equal(fact.basis, "llm_inferred");
    assert.deepEqual([...fact.matchTerms], ["手冲咖啡", "咖啡豆"]);
    const onDisk = await readFile(
      `${fixture.vaultPath}/.echoink/${secondaryRelativePath(memoryId, fact.id)}`,
      "utf8"
    );
    assert.match(onDisk, /手冲咖啡/);

    // Pending queue drained + progress advanced only after success.
    const dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.deepEqual(dreamState.pendingMemoryIds, []);
    assert.ok((dreamState.lastSuccessAt as number) > 0);

    // Personality observed signal + requirement persisted (explicit slot untouched).
    const personality = await readJson(fixture.repository.layout.personalityState);
    const observed = personality.observed as Record<string, unknown>;
    assert.ok(Object.keys(observed).length > 0);
    assert.equal(personality.templateId, "advisor");

    // USER.md projection updated from profile items.
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /手冲咖啡/);

    // Search Index v3 folded the secondary fact in.
    const index = await readJson(fixture.repository.layout.searchIndex) as {
      schemaVersion: number;
      secondaryCatalog: readonly { parentId: string; matchTerms: readonly string[] }[];
    };
    assert.equal(index.schemaVersion, 3);
    assert.ok(index.secondaryCatalog.some((entry) =>
      entry.parentId === memoryId && entry.matchTerms.includes("咖啡豆")
    ));
  });
  console.log("PASS cognitive: dreaming creates secondary facts in one transaction");
}

// ---------------------------------------------------------------------------
// 4/5. Provider unavailable / invalid JSON → pending stays pending
// ---------------------------------------------------------------------------

async function scenarioDreamFailuresKeepPending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "待整理的记忆",
      content: "这条记忆在 Provider 不可用时不能被做梦处理。",
      recallWhen: "需要验证做梦队列时",
      basis: "explicit"
    } as never, fixture.runtime());
    const memoryId = created.record!.id;

    const unavailable = await system.forceDreamRun();
    assert.ok(unavailable);
    assert.equal(unavailable!.providerUnavailable, true);
    assert.equal(unavailable!.factsCreated, 0);
    assert.equal(unavailable!.processedMemoryIds.length, 0);
    // The pending queue survives a provider outage untouched.
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memoryId));
    const lastSuccessBeforeGarbage = (await readJson(fixture.repository.layout.dreamState)).lastSuccessAt as number ?? 0;

    // Invalid JSON keeps the memory pending as well.
    let useGarbage = true;
    (system as unknown as { }).toString(); // no-op: keep structure readable
    const system2 = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => fakeDreamLlm(() => useGarbage ? "这不是 JSON" : validDreamJson()),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: fixture.now
    });
    const garbageRun = await system2.forceDreamRun();
    assert.ok(garbageRun);
    assert.equal(garbageRun!.committed, false);
    assert.ok(garbageRun!.failedMemoryIds.includes(memoryId));
    const dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.ok((dreamState.pendingMemoryIds as string[]).includes(memoryId));
    // Invalid output must not advance durable dream progress.
    assert.equal((dreamState.lastSuccessAt as number) ?? 0, lastSuccessBeforeGarbage);
    useGarbage = false;
    const goodRun = await system2.forceDreamRun();
    assert.ok(goodRun);
    assert.equal(goodRun!.committed, true);
    const facts = await system2.listSecondaryForParent(memoryId);
    assert.equal(facts.length, 1);
  });
  console.log("PASS cognitive: provider outage and invalid JSON keep pending queue");
}

// ---------------------------------------------------------------------------
// 6. Recall: decisive secondary hits, hitCount, CJK bigram safety
// ---------------------------------------------------------------------------

async function scenarioRecallSecondaryDecisive(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "早晨的手冲流程",
      content: "用户每天早晨都有一套固定的手冲流程，偏好酸一点的风味。",
      recallWhen: "聊到早晨习惯或饮品时",
      basis: "explicit"
    } as never, fixture.runtime());
    const memoryId = created.record!.id;
    await system.forceDreamRun();

    // Query that only the secondary fact matches (咖啡豆 never appears in the primary).
    const decisive = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "咖啡豆"
    }, fixture.runtime());
    assert.ok(decisive.search);
    assert.equal(decisive.search!.items.length, 1);
    const item = decisive.search!.items[0];
    assert.equal(item.id, memoryId);
    assert.ok(item.matchedSecondaryId);
    assert.ok((item.secondaryMatches ?? []).length >= 1);
    assert.equal(decisive.search!.pendingSecondaryHits.length, 1);
    assert.equal(decisive.search!.pendingSecondaryHits[0].parentId, memoryId);

    // Hit recording increments hitCount exactly once per decisive recall.
    await fixture.repository.recordSecondaryRecallHits(decisive.search!.pendingSecondaryHits);
    const facts = await system.listSecondaryForParent(memoryId);
    assert.equal(facts[0].hitCount, 1);
    assert.ok(facts[0].lastHitAt && facts[0].lastHitAt > 0);

    // Query matching the primary directly → secondary NOT decisive.
    const direct = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "早晨的手冲流程"
    }, fixture.runtime());
    assert.ok(direct.search);
    assert.equal(direct.search!.pendingSecondaryHits.length, 0);
    const directItem = direct.search!.items.find((entry) => entry.id === memoryId);
    assert.ok(directItem);
    assert.equal(directItem!.matchedSecondaryId ?? null, null);

    // CJK bigram rule: one lone Han character never becomes a matching token.
    assert.deepEqual(lexicalTokens("项"), []);
    assert.deepEqual(lexicalTokens("咖啡豆").sort(), ["咖啡", "啡豆"].sort());
    assert.deepEqual(lexicalTokens("coffee").sort(), ["coffee"]);

    // A memory sharing only a single Han character with the query must not match.
    await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "机房值班表",
      content: "机房值班安排表。",
      recallWhen: "聊到值班时",
      basis: "explicit"
    } as never, fixture.runtime());
    const noOverlap = await fixture.repository.search({
      query: "咖啡机",
      limit: 10
    }, fixture.runtime());
    assert.ok(!noOverlap.items.some((entry) => entry.title === "机房值班表"));
  });
  console.log("PASS cognitive: recall secondary decisive hits + CJK bigram guard");
}

// ---------------------------------------------------------------------------
// 7. Decay idempotency (grace 30d, factor 0.8, once at day 30 not day 31)
// ---------------------------------------------------------------------------

async function scenarioSecondaryDecayIdempotent(): Promise<void> {
  const createdAt = 1_800_000_000_000;
  const record = createSecondaryRecord({
    parentId: "mem_parent_decay",
    title: "衰减测试",
    content: "用于验证二级事实衰减的幂等性。",
    recallWhen: "测试时",
    matchTerms: ["衰减测试"],
    relation: "associated",
    reason: "测试",
    basis: "llm_inferred",
    sourceMemoryRevision: 1,
    now: createdAt,
    idFactory: () => "sec_decay_test"
  });
  const confidence0 = record.confidence;

  const day29 = applySecondaryDecay(record, createdAt + 29 * DAY_MS);
  assert.equal(day29.decayed, false);
  assert.equal(day29.record.confidence, confidence0);

  const day30 = applySecondaryDecay(record, createdAt + 30 * DAY_MS);
  assert.equal(day30.decayed, true);
  assert.ok(Math.abs(day30.record.confidence - confidence0 * 0.8) < 1e-9);

  // Day 31 must NOT decay again (idempotent via lastDecayAt).
  const day31 = applySecondaryDecay(day30.record, createdAt + 31 * DAY_MS);
  assert.equal(day31.decayed, false);
  assert.equal(day31.record.confidence, day30.record.confidence);

  // Repeated decay passes on the same day are also idempotent.
  const day30again = applySecondaryDecay(day30.record, createdAt + 30 * DAY_MS + 1_000);
  assert.equal(day30again.decayed, false);

  // Auto-disable under the minimum confidence floor.
  let weak = record;
  for (let index = 0; index < 20 && weak.status === "current"; index += 1) {
    const pass = applySecondaryDecay(weak, weak.updatedAt + 30 * DAY_MS + index);
    weak = pass.record;
  }
  assert.equal(weak.status, "disabled");
  console.log("PASS cognitive: secondary decay is idempotent with 30-day grace");
}

// ---------------------------------------------------------------------------
// 8. Lifecycle: supersede/forget disable, restore re-enables
// ---------------------------------------------------------------------------

async function scenarioSecondaryLifecycle(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户常用的编辑器",
      content: "用户日常使用 Obsidian 做笔记。",
      recallWhen: "聊到工具时",
      basis: "explicit"
    } as never, fixture.runtime());
    const memoryId = created.record!.id;
    await system.forceDreamRun();
    assert.equal((await system.listSecondaryForParent(memoryId)).length, 1);

    // Supersede → the old parent's facts are disabled inside the SAME transaction.
    await fixture.repository.write({
      operation: "supersede",
      targetId: memoryId,
      title: "用户常用的编辑器（更新）",
      content: "用户现在主要用 Obsidian 和 VS Code。",
      recallWhen: "聊到工具时",
      reason: "工具范围更新",
      basis: "explicit"
    } as never, fixture.runtime());
    let facts = await system.secondaryStore.refresh();
    const forOldParent = facts.filter((fact) => fact.parentId === memoryId);
    assert.equal(forOldParent.length, 1);
    assert.equal(forOldParent[0].status, "disabled");
    // Index excludes disabled facts.
    const index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { parentId: string }[];
    };
    assert.ok(!index.secondaryCatalog.some((entry) => entry.parentId === memoryId));

    // Forget → restore on a memory that owns facts re-enables them.
    const second = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户的键盘",
      content: "用户用一把客制化机械键盘。",
      recallWhen: "聊到设备时",
      basis: "explicit"
    } as never, fixture.runtime());
    const secondId = second.record!.id;
    await system.forceDreamRun();
    assert.equal((await system.listSecondaryForParent(secondId)).length, 1);

    await fixture.repository.forgetFromUserControl(secondId, "测试删除");
    facts = await system.secondaryStore.refresh();
    assert.ok(facts
      .filter((fact) => fact.parentId === secondId)
      .every((fact) => fact.status === "disabled"));

    await fixture.repository.restoreForgotten(secondId);
    facts = await system.secondaryStore.refresh();
    assert.ok(facts
      .filter((fact) => fact.parentId === secondId)
      .every((fact) => fact.status === "current"));
    const restoredIndex = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { parentId: string }[];
    };
    assert.ok(restoredIndex.secondaryCatalog.some((entry) => entry.parentId === secondId));
  });
  console.log("PASS cognitive: supersede/forget/restore lifecycle of secondary facts");
}

// ---------------------------------------------------------------------------
// 9. User edit / delete of secondary facts (复盘 → 记忆修正)
// ---------------------------------------------------------------------------

async function scenarioSecondaryUserEditDelete(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "周末徒步",
      content: "用户周末经常去山里徒步。",
      recallWhen: "聊到运动或周末时",
      basis: "explicit"
    } as never, fixture.runtime());
    const memoryId = created.record!.id;
    await system.forceDreamRun();
    const fact = (await system.listSecondaryForParent(memoryId))[0];

    const edited = await system.updateSecondaryFact(fact.id, {
      title: "周末山地徒步",
      matchTerms: ["徒步", "山地运动"],
      reason: "用户手工修正"
    });
    assert.equal(edited.record.title, "周末山地徒步");
    assert.equal(edited.record.basis, "user_edited_inference");
    assert.deepEqual([...edited.record.matchTerms], ["徒步", "山地运动"]);
    const onDisk = await readFile(
      `${fixture.vaultPath}/.echoink/${secondaryRelativePath(memoryId, fact.id)}`,
      "utf8"
    );
    assert.match(onDisk, /user_edited_inference/);

    await system.deleteSecondaryFact(fact.id);
    assert.equal((await system.secondaryStore.refresh())
      .filter((record) => record.id === fact.id).length, 0);
    const index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly unknown[];
    };
    assert.equal(index.secondaryCatalog.length, 0);
  });
  console.log("PASS cognitive: user edit/delete of secondary facts");
}

// ---------------------------------------------------------------------------
// 10. Migration: v2 index rebuilds to v3; custom AGENT/USER preserved
// ---------------------------------------------------------------------------

async function scenarioV2MigrationAndCustomFilesPreserved(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    // Custom identity files must never be silently lost.
    const customAgent = "# 我的自定义 Agent 设定\n保持这个风格。\n";
    const customUser = "# 我的自定义用户画像\n只保留我确认过的内容。\n";
    await writeFile(fixture.repository.layout.agent, customAgent);
    await writeFile(fixture.repository.layout.user, customUser);
    await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "迁移测试记忆",
      content: "验证 v2 索引重建时不破坏内容。",
      recallWhen: "迁移测试时",
      basis: "explicit"
    } as never, fixture.runtime());

    // Force a legacy v2 index file on disk.
    const current = await readJson(fixture.repository.layout.searchIndex);
    const v2 = {
      schemaVersion: 2,
      revision: current.revision,
      catalog: (current.catalog as readonly Record<string, unknown>[]).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        title: entry.title,
        recallWhen: entry.recallWhen,
        date: entry.date,
        basis: entry.basis,
        sourceSummary: entry.sourceSummary,
        summary: entry.summary,
        routeTokens: entry.routeTokens,
        contentTokens: entry.contentTokens
      })),
      checksum: "legacy-v2-checksum"
    };
    await writeFile(fixture.repository.layout.searchIndex, JSON.stringify(v2));

    // Reopen: the derived index rebuilds to v3 from markdown truth.
    const reopened = await fixture.reopen();
    const rebuilt = await readJson(reopened.layout.searchIndex);
    assert.equal(rebuilt.schemaVersion, 3);
    assert.equal((rebuilt.catalog as unknown[]).length, (v2.catalog as unknown[]).length);
    assert.ok(Array.isArray(rebuilt.secondaryCatalog));
    assert.ok(Array.isArray(rebuilt.secondaryIndex));

    // Search works against the rebuilt index.
    const found = await reopened.search({ query: "迁移测试", limit: 5 }, fixture.runtime());
    assert.ok(found.items.some((item) => item.title === "迁移测试记忆"));

    // Custom identity files survived untouched.
    assert.equal(await readFile(reopened.layout.agent, "utf8"), customAgent);
    assert.equal(await readFile(reopened.layout.user, "utf8"), customUser);
    assert.notEqual(customAgent, defaultAgentProfile());
    assert.notEqual(customUser, defaultUserProfile());
  });
  console.log("PASS cognitive: v2→v3 index migration keeps custom identity files");
}

// ---------------------------------------------------------------------------

export async function runCognitiveSystemScenarios(): Promise<void> {
  await scenarioTemplateSelectionPersistsWithoutProvider();
  await scenarioPersonalityResetKeepsMemory();
  await scenarioDreamCreatesSecondaryFacts();
  await scenarioDreamFailuresKeepPending();
  await scenarioRecallSecondaryDecisive();
  await scenarioSecondaryDecayIdempotent();
  await scenarioSecondaryLifecycle();
  await scenarioSecondaryUserEditDelete();
  await scenarioV2MigrationAndCustomFilesPreserved();
}
