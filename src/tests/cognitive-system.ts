/**
 * cognitive-system.ts — main-chain regression tests:
 * 人格 / 做梦 / 二级事实 / Recall / 来源失效回收 / 重置 / 门控 / 事务语义。
 *
 * The test Vault has no Provider API key, so dreaming is verified with fake
 * LLM ports; the real Provider path stays unverified by design.
 */

import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import {
  buildDreamPrompts,
  type DreamLlmPort
} from "../harness/memory/dream-engine";
import {
  applySecondaryDecay,
  computeSecondaryConfidence,
  createSecondaryRecord,
  reconcileSecondaryForParent,
  secondaryRelativePath,
  SECONDARY_CONFIDENCE_THRESHOLD,
  type SecondaryFactCandidate
} from "../harness/memory/secondary-memory-store";
import {
  measureFinalInjectionTokens,
  PersonalMemoryRecallHarness
} from "../harness/memory/personal-memory-recall-harness";
import type { PersonalMemoryTurnCatalogCandidate } from "../harness/memory/personal-memory-repository";
import { currentPersonalityScores, type PersonalityState } from "../harness/memory/personality-state";
import { USER_OBSERVED_MIN_SOURCES, type UserProfileState } from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { getPersonalityTemplate, TRAIT_DIMENSION_META } from "../harness/memory/personality-templates";
import { defaultUserProfile } from "../harness/memory/personal-memory-repository";
import { lexicalTokens } from "../harness/memory/search-index-v3";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";

const DAY_MS = 86_400_000;

const EMPTY_DREAM_OUTPUT = Object.freeze({
  secondaryFacts: [],
  personalitySignals: [],
  agentRequirements: [],
  userProfileItems: []
});

function validDreamJson(): string {
  return JSON.stringify({
    secondaryFacts: [{
      title: "手冲咖啡",
      content: "用户可能经常自己手冲咖啡，也许关心咖啡豆和器具话题。",
      recallWhen: "聊到咖啡、早餐或生活习惯时",
      matchTerms: ["手冲咖啡", "咖啡豆"],
      relation: "instance",
      supportLevel: "strong_inference",
      reason: "来自记忆中对手冲流程的描述",
      evidence: "记忆描述了每天早晨固定的手冲流程"
    }],
    personalitySignals: [{
      dimension: "tempo",
      direction: "decrease",
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

function fakeDreamLlm(response: () => string): DreamLlmPort {
  return { call: async () => response() };
}

/** LLM that answers per-memory based on the memory title. */
function scriptedDreamLlm(
  script: (memory: { title: string; content: string; basis: string }) => unknown
): DreamLlmPort {
  return {
    call: async (input) => {
      const parsed = JSON.parse(input.userPrompt) as {
        memory: { title: string; content: string; basis: string };
      };
      return JSON.stringify(script(parsed.memory));
    }
  };
}

async function createSystem(
  fixture: Readonly<PersonalMemoryFixture>,
  llm: () => DreamLlmPort | null,
  config?: { enabled?: boolean; runsPerDay?: number }
): Promise<CognitiveSystem> {
  const system = await CognitiveSystem.create({
    repository: fixture.repository,
    llm,
    getDreamConfig: () => ({
      enabled: config?.enabled ?? true,
      runsPerDay: config?.runsPerDay ?? 3
    }),
    isForegroundBusy: () => false,
    registerInterval: () => {},
    now: fixture.now
  });
  // 测试只使用 forceDreamRun；停掉 60s 心跳，防止它在 fixture Vault 被
  // 清理后继续空转（测试环境没有可卸载的生命周期）。
  system.scheduler.stop();
  return system;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function createMemory(
  fixture: Readonly<PersonalMemoryFixture>,
  input: { title: string; content: string; kind?: string; basis?: string; recallWhen?: string }
): Promise<PersonalMemoryRecord> {
  const result = await fixture.repository.write({
    operation: "create",
    kind: input.kind ?? "fact",
    title: input.title,
    content: input.content,
    recallWhen: input.recallWhen ?? "相关话题出现时",
    basis: input.basis ?? "explicit"
  } as never, fixture.runtime());
  return result.record!;
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
    const stateFile = await readJson(fixture.repository.layout.personalityState);
    assert.equal(stateFile.templateId, "executor");
    const explicit = stateFile.explicit as Record<string, { score: number } | undefined>;
    for (const dimension of ["tempo", "energy", "mind", "warmth", "order", "stance"] as const) {
      assert.equal(explicit[dimension]?.score, template.scores[dimension]);
    }
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /执行人|执行/);
    const after = await readJson(fixture.repository.layout.manifest);
    assert.equal(after.revision, (before.revision as number) + 1);
    const scores = currentPersonalityScores(result.state);
    assert.equal(scores.tempo, template.scores.tempo);
    const systemAgain = await createSystem(fixture, () => null);
    const reread = await systemAgain.readPersonalityState();
    assert.equal(reread.templateId, "executor");
  });
  console.log("PASS cognitive: template selection persists without Provider");
}

// ---------------------------------------------------------------------------
// 2. Reset flow: zero writes on cancel, single transaction on apply
// ---------------------------------------------------------------------------

async function scenarioResetFlowSingleTransaction(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(() => validDreamJson()));
    await system.selectPersonalityTemplate("companion");
    const memory = await createMemory(fixture, {
      title: "用户偏好简短直接的回复",
      content: "用户明确要求以后回复尽量简短直接。",
      kind: "view"
    });
    await system.forceDreamRun();

    // State before reset: observed candidates / requirement exist.
    const beforeState = await system.readPersonalityState();
    assert.ok(beforeState.learnedRequirements.some((requirement) => requirement.status === "current"));

    // --- Cancel semantics: reading templates never writes anything ---------
    const manifestBefore = await readJson(fixture.repository.layout.manifest);
    void system.listTemplates();
    void (await system.readPersonalityState());
    const manifestMid = await readJson(fixture.repository.layout.manifest);
    assert.equal(manifestMid.revision, manifestBefore.revision);

    // --- Apply reset by selecting a new template ---------------------------
    const stateBefore = await system.readPersonalityState();
    const result = await system.selectPersonalityTemplate("executor", { reset: true });
    const template = getPersonalityTemplate("executor")!;

    // ONE repository transaction for the whole reset.
    const manifestAfter = await readJson(fixture.repository.layout.manifest);
    assert.equal(manifestAfter.revision, (manifestBefore.revision as number) + 1);

    // New explicit template saved.
    assert.equal(result.state.templateId, "executor");
    const explicit = result.state.explicit.tempo!;
    assert.equal(explicit.score, template.scores.tempo);

    // Old observed + learnedRequirements superseded with reason=reset, history kept.
    for (const requirement of result.state.learnedRequirements) {
      assert.equal(requirement.status, "superseded");
      assert.equal(requirement.reason, "reset");
    }
    for (const dimension of ["tempo", "energy", "mind", "warmth", "order", "stance"] as const) {
      assert.equal(result.state.observed[dimension], null);
    }
    assert.ok(result.state.history.some((record) => record.reason === "reset"));
    assert.ok(result.state.history.length >= stateBefore.history.length);

    // Candidates cleared; valid memories re-marked as dream sources.
    assert.equal(result.state.candidates.length, 0);
    assert.equal(result.state.processedSources.length, 0);
    const dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.ok((dreamState.pendingMemoryIds as string[]).includes(memory.id));
    assert.equal(dreamState.lastProcessedMemoryRevision, 0);

    // AGENT.md rewritten to the new template in the same transaction.
    assert.match(result.agent, /执行人|执行/);
    const agentOnDisk = await readFile(fixture.repository.layout.agent, "utf8");
    assert.equal(agentOnDisk, result.agent);

    // Memory itself untouched.
    const state = await fixture.repository.readUserControlState();
    assert.ok(state.records.some((record) => record.id === memory.id && record.status === "current"));

    // A later dream can re-form similar personality from the surviving memory.
    const rerun = await system.forceDreamRun();
    assert.ok(rerun);
    assert.equal(rerun!.committed, true);
    const afterRerun = await system.readPersonalityState();
    assert.ok(afterRerun.learnedRequirements.some((requirement) => requirement.status === "current"));
  });
  console.log("PASS cognitive: reset flow zero-write cancel + single transaction apply");
}

// ---------------------------------------------------------------------------
// 3. Dreaming: secondary facts + projections in ONE transaction
// ---------------------------------------------------------------------------

async function scenarioDreamCreatesSecondaryFacts(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    await system.selectPersonalityTemplate("advisor");
    const memory = await createMemory(fixture, {
      title: "早晨的手冲流程",
      content: "用户每天早晨都有一套固定的手冲流程，偏好酸一点的风味。"
    });
    const memoryId = memory.id;

    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memoryId));

    const beforeManifest = await readJson(fixture.repository.layout.manifest);
    const result = await system.forceDreamRun();
    assert.ok(result);
    assert.equal(result!.committed, true);
    assert.equal(result!.factsCreated, 1);
    assert.deepEqual([...result!.processedMemoryIds], [memoryId]);

    // Everything landed in ONE transaction: exactly one manifest revision.
    const afterManifest = await readJson(fixture.repository.layout.manifest);
    assert.equal(afterManifest.revision, (beforeManifest.revision as number) + 1);

    const facts = await system.listSecondaryForParent(memoryId);
    assert.equal(facts.length, 1);
    const fact = facts[0];
    assert.equal(fact.status, "current");
    assert.equal(fact.basis, "llm_inferred");
    assert.deepEqual([...fact.matchTerms], ["手冲咖啡", "咖啡豆"]);
    // Code-computed confidence: strong_inference × explicit + instance adjust.
    assert.equal(fact.confidence, computeSecondaryConfidence("strong_inference", "explicit", "instance"));

    // dream-state progress persisted in the same round.
    const dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.deepEqual(dreamState.pendingMemoryIds, []);
    assert.ok((dreamState.lastSuccessAt as number) > 0);
    assert.ok((dreamState.lastRunAt as number) > 0);
    assert.ok((dreamState.lastProcessedMemoryRevision as number) > 0);

    const personality = await readJson(fixture.repository.layout.personalityState);
    assert.equal(personality.templateId, "advisor");
    const candidates = personality.candidates as Array<{ dimension: string; direction: string }>;
    assert.ok(candidates.some((candidate) =>
      candidate.dimension === "tempo" && candidate.direction === "decrease"
    ));

    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /手冲咖啡/);

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
// 4. Dream gating: master switches all read by the scheduler
// ---------------------------------------------------------------------------

async function scenarioDreamGating(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const config = { enabled: true, runsPerDay: 3 };
    let llmCalls = 0;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => {
        llmCalls += 1;
        return fakeDreamLlm(validDreamJson);
      },
      getDreamConfig: () => ({ enabled: config.enabled, runsPerDay: config.runsPerDay }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: fixture.now
    });
    const memory = await createMemory(fixture, {
      title: "门控测试记忆",
      content: "关闭做梦或长期记忆后不得被处理。"
    });
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memory.id));

    // Dream switch off → no run at all, queue untouched.
    config.enabled = false;
    assert.equal(await system.scheduler.isDue(), false);
    assert.equal(await system.forceDreamRun(), null);
    await system.scheduler.tick();
    assert.equal(llmCalls, 0);
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memory.id));
    assert.equal((await system.listSecondaryForParent(memory.id)).length, 0);

    // Re-enabled → the same pending queue continues.
    config.enabled = true;
    const result = await system.forceDreamRun();
    assert.ok(result);
    assert.equal(result!.committed, true);
    assert.ok(llmCalls > 0);
    assert.equal((await system.listSecondaryForParent(memory.id)).length, 1);
  });
  console.log("PASS cognitive: dream gating reads all master switches");
}

// ---------------------------------------------------------------------------
// 5. Failure semantics + first-run no-Provider lastSuccessAt fix
// ---------------------------------------------------------------------------

async function scenarioDreamFailureSemantics(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    // Custom USER.md so the legacy migration path is exercised.
    await writeFile(fixture.repository.layout.user, "# USER\n\n我是自定义画像。\n");

    const system = await createSystem(fixture, () => null);
    const memory = await createMemory(fixture, {
      title: "待整理的记忆",
      content: "这条记忆在 Provider 不可用时不能被做梦处理。"
    });

    // Provider unavailable: migration (local) may commit, but lastSuccessAt
    // must NOT advance and pending must survive.
    const unavailable = await system.forceDreamRun();
    assert.ok(unavailable);
    assert.equal(unavailable!.providerUnavailable, true);
    assert.equal(unavailable!.factsCreated, 0);
    assert.equal(unavailable!.processedMemoryIds.length, 0);
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memory.id));
    let dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.equal(dreamState.lastSuccessAt, 0, "no-Provider run must not advance lastSuccessAt");

    // Migration produced a real primary memory despite no Provider.
    const migrated = (await fixture.repository.readUserControlState()).records
      .find((record) => record.title.includes("USER.md"));
    assert.ok(migrated, "custom USER.md must migrate into a primary Memory");
    assert.equal(migrated!.basis, "explicit");

    // Invalid JSON: nothing succeeds; lastRunAt records the attempt,
    // lastSuccessAt stays untouched, pending survives.
    const system2 = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => fakeDreamLlm(() => "这不是 JSON"),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: fixture.now
    });
    const garbageRun = await system2.forceDreamRun();
    assert.ok(garbageRun);
    assert.equal(garbageRun!.committed, false);
    assert.ok(garbageRun!.failedMemoryIds.includes(memory.id));
    dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.ok((dreamState.pendingMemoryIds as string[]).includes(memory.id));
    assert.equal(dreamState.lastSuccessAt, 0, "invalid JSON must not advance lastSuccessAt");
    assert.ok((dreamState.lastRunAt as number) > 0, "the attempt itself must be recorded");

    // Recovery: valid output afterwards processes the same pending memory.
    const system3 = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => fakeDreamLlm(validDreamJson),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: fixture.now
    });
    const goodRun = await system3.forceDreamRun();
    assert.ok(goodRun);
    assert.equal(goodRun!.committed, true);
    dreamState = await readJson(fixture.repository.layout.dreamState);
    assert.ok((dreamState.lastSuccessAt as number) > 0);
    assert.ok(!(dreamState.pendingMemoryIds as string[]).includes(memory.id));
  });
  console.log("PASS cognitive: failure semantics + no-Provider first run");
}

// ---------------------------------------------------------------------------
// 6. USER.md migration revision bug + custom AGENT.md history backup
// ---------------------------------------------------------------------------

async function scenarioLegacyFileCompatibility(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const customAgent = "# 我的自定义 Agent 设定\n保持这个风格。\n";
    const customUser = "# USER\n\n用户是一名长期远程工作的设计师。\n";
    await writeFile(fixture.repository.layout.agent, customAgent);
    await writeFile(fixture.repository.layout.user, customUser);

    const system = await createSystem(fixture, () => fakeDreamLlm(() => JSON.stringify({
      ...EMPTY_DREAM_OUTPUT,
      userProfileItems: [{ section: "identity", text: "用户是一名长期远程工作的设计师" }]
    })));

    // First template selection must persist a restorable history copy of the
    // custom AGENT.md BEFORE overwriting it.
    await system.selectPersonalityTemplate("butler");
    const agentOnDisk = await readFile(fixture.repository.layout.agent, "utf8");
    assert.notEqual(agentOnDisk, customAgent);
    const historyDir = `${fixture.vaultPath}/.echoink/agents/echoink/history`;
    const historyFiles = await readdir(historyDir).catch(() => [] as string[]);
    assert.ok(historyFiles.length >= 1, "custom AGENT.md must be backed up to history");
    const backup = await readFile(`${historyDir}/${historyFiles[0]}`, "utf8");
    assert.equal(backup, customAgent);

    // Selecting another template must not pile up duplicate backups.
    await system.selectPersonalityTemplate("steward");
    const historyFiles2 = await readdir(historyDir);
    assert.equal(historyFiles2.length, historyFiles.length);

    // USER.md migration: no revision_conflict, forms a correctable primary
    // Memory, and only then may the projection replace the custom USER.md.
    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    const records = (await fixture.repository.readUserControlState()).records;
    const migrated = records.find((record) => record.title.includes("USER.md"));
    assert.ok(migrated, "migration must create a primary Memory");
    assert.equal(migrated!.basis, "explicit");
    assert.equal(migrated!.status, "current");
    const profileState = await readJson(fixture.repository.layout.userProfileState) as { legacyUserMigration: string };
    assert.equal(profileState.legacyUserMigration, "done");

    // The migrated memory is pending and gets dreamed next; only then does
    // USER.md get re-projected from the item.
    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    const userAfter = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(userAfter, /长期远程工作的设计师/);
  });
  console.log("PASS cognitive: USER.md migration + AGENT.md history backup");
}

// ---------------------------------------------------------------------------
// 7. Source reconciliation retires stale projections (Memory 来源失效回收)
// ---------------------------------------------------------------------------

async function scenarioSourceReconciliation(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => {
      if (memory.title.includes("简短")) {
        return { ...EMPTY_DREAM_OUTPUT, agentRequirements: ["回复保持简短"] };
      }
      if (memory.title.includes("咖啡")) {
        return { ...EMPTY_DREAM_OUTPUT, userProfileItems: [{ section: "preference", text: "用户喜欢手冲咖啡" }] };
      }
      return EMPTY_DREAM_OUTPUT;
    }));
    await system.selectPersonalityTemplate("advisor");

    const requirementMemory = await createMemory(fixture, {
      title: "回复要简短",
      content: "用户要求以后回复尽量简短。",
      kind: "view"
    });
    const profileMemory = await createMemory(fixture, {
      title: "喜欢手冲咖啡",
      content: "用户说自己喜欢手冲咖啡。"
    });
    await system.forceDreamRun();

    let agent = await readFile(fixture.repository.layout.agent, "utf8");
    let user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(agent, /回复保持简短/);
    assert.match(user, /用户喜欢手冲咖啡/);

    // User corrects/forgets BOTH source memories.
    await fixture.repository.forgetFromUserControl(requirementMemory.id, "不再准确");
    await fixture.repository.forgetFromUserControl(profileMemory.id, "不再准确");

    // Next dream reconciles: stale requirement + profile item must retire and
    // the projections must be re-rendered in the same round.
    const run = await system.forceDreamRun();
    assert.ok(run);
    agent = await readFile(fixture.repository.layout.agent, "utf8");
    user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(!agent.includes("回复保持简短"), "stale requirement must leave AGENT.md");
    assert.ok(!user.includes("用户喜欢手冲咖啡"), "stale profile item must leave USER.md");

    const state = await system.readPersonalityState();
    assert.ok(state.learnedRequirements
      .filter((requirement) => requirement.status === "current")
      .every((requirement) => !requirement.text.includes("简短")));
    assert.equal(state.candidates.length, 0);
    assert.ok(!state.processedSources.some((source) => source.memoryId === requirementMemory.id));
  });
  console.log("PASS cognitive: source reconciliation retires stale projections");
}

// ---------------------------------------------------------------------------
// 8. Observed trait fallback when all evidence dies
// ---------------------------------------------------------------------------

async function scenarioObservedTraitFallback(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => {
      if (memory.title.includes("简短")) {
        return {
          ...EMPTY_DREAM_OUTPUT,
          personalitySignals: [{
            dimension: "tempo", direction: "decrease", strength: 0.8, evidence: memory.title
          }]
        };
      }
      return EMPTY_DREAM_OUTPUT;
    }));
    await system.selectPersonalityTemplate("advisor"); // explicit tempo = 0.75

    const sources: PersonalMemoryRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      sources.push(await createMemory(fixture, {
        title: `用户偏好简短回复 ${index + 1}`,
        content: `第 ${index + 1} 条：用户多次要求回复简短直接。`,
        kind: "view",
        basis: "observed"
      }));
    }
    await system.forceDreamRun();

    const evolved = await system.readPersonalityState();
    const observedTempo = evolved.observed.tempo;
    assert.ok(observedTempo, "3 consistent observed sources must create an observed trait");
    assert.ok(observedTempo!.score < 0.75, "tempo decrease moves toward the fast pole");
    const evolvedScores = currentPersonalityScores(evolved);
    assert.ok(evolvedScores.tempo < 0.75);

    // All evidence forgotten → observed must fall back to explicit baseline.
    for (const record of sources) {
      await fixture.repository.forgetFromUserControl(record.id, "测试");
    }
    await system.forceDreamRun();
    const fallen = await system.readPersonalityState();
    assert.equal(fallen.observed.tempo, null);
    assert.equal(currentPersonalityScores(fallen).tempo, 0.75);
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /节奏/);
  });
  console.log("PASS cognitive: observed trait falls back when evidence dies");
}

// ---------------------------------------------------------------------------
// 9. Evolution prompt directions + allergy bridging allowed
// ---------------------------------------------------------------------------

async function scenarioEvolutionPromptAndAllergyBridge(): Promise<void> {
  // Prompt directions must come from TRAIT_DIMENSION_META (0 = left pole).
  const record = {
    schema: "echoink.memory.v1", id: "mem_prompt_probe", kind: "view", status: "current",
    title: "回复风格", content: "用户喜欢简短直接的回复。", recallWhen: "聊到回复风格时",
    basis: "explicit", source: "test", revision: 1, file: "views/mem_prompt_probe.md"
  } as unknown as PersonalMemoryRecord;
  const { systemPrompt } = buildDreamPrompts(record, 2000);
  for (const dimension of ["tempo", "energy", "mind", "warmth", "order", "stance"] as const) {
    const meta = TRAIT_DIMENSION_META[dimension];
    assert.ok(systemPrompt.includes(`${dimension}：decrease`), `prompt must explain ${dimension} directions`);
    assert.ok(systemPrompt.includes(meta.leftZh), `prompt must use meta left pole for ${dimension}`);
    assert.ok(systemPrompt.includes(meta.rightZh), `prompt must use meta right pole for ${dimension}`);
  }
  // The blanket medical ban must be gone; hedged bridging is allowed.
  assert.ok(!systemPrompt.includes("疾病或医疗建议"));
  assert.ok(systemPrompt.includes("可能"));

  // Allergy memory → fruit/sugar bridge facts must be allowed.
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [
        {
          title: "水果与甜食过敏风险",
          content: "水果和含糖食物可能与这条甜食过敏记录相关。",
          recallWhen: "讨论水果、甜品或饮食风险时",
          matchTerms: ["水果", "芒果", "含糖食物"],
          relation: "instance",
          supportLevel: "strong_inference",
          reason: "甜食过敏常涉及含糖食物",
          evidence: "一级记忆记录了对甜食过敏"
        },
        {
          title: "甜点场景提醒",
          content: "也许在点甜点或零食的场景下可以参考这条过敏记录。",
          recallWhen: "点餐或选择零食时",
          matchTerms: ["甜点", "零食"],
          relation: "context",
          supportLevel: "strong_inference",
          reason: "常见触发场景",
          evidence: "由甜食过敏推断的相关场景"
        }
      ]
    })));
    const memory = await createMemory(fixture, {
      title: "我对甜食过敏",
      content: "我对甜食过敏。",
      recallWhen: "讨论饮食、甜味食物、零食或健康风险时"
    });
    const run = await system.forceDreamRun();
    assert.ok(run);
    const facts = await system.listSecondaryForParent(memory.id);
    assert.ok(facts.some((fact) => fact.title.includes("水果")),
      "hedged fruit bridge fact must be allowed");
    assert.equal(facts.length, 2);
  });
  console.log("PASS cognitive: evolution prompt directions + allergy bridging");
}

// ---------------------------------------------------------------------------
// 10. USER profile threshold + trust distinctions
// ---------------------------------------------------------------------------

async function scenarioUserProfileThresholdAndTrust(): Promise<void> {
  // Pure render rule: observed items need >= USER_OBSERVED_MIN_SOURCES sources.
  const baseItem = (sources: number) => Object.freeze({
    id: "profile_test", section: "preference" as const, text: "用户喜欢清晨散步",
    basis: "observed_memory" as const, status: "current" as const,
    sourceMemoryIds: Object.freeze(Array.from({ length: sources }, (_, i) => `mem_${i}`)),
    revision: 1
  });
  const stateWith = (sources: number): UserProfileState => Object.freeze({
    schema: "echoink.user-profile.v1", revision: 1,
    items: Object.freeze([baseItem(sources)]),
    processedSources: Object.freeze([]), legacyUserMigration: "done",
    lastProjectedUserHash: "", updatedAt: 0
  });
  assert.equal(USER_OBSERVED_MIN_SOURCES, 3);
  assert.ok(!renderUserMarkdown(stateWith(1)).includes("清晨散步"),
    "a single observed view must not enter USER.md");
  assert.ok(!renderUserMarkdown(stateWith(2)).includes("清晨散步"));
  const rendered = renderUserMarkdown(stateWith(3));
  assert.match(rendered, /清晨散步/);
  assert.match(rendered, /观察/, "observed items must carry an observation marker");

  // End-to-end: 3 consistent observed views → enters USER.md with marker.
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      userProfileItems: [{ section: "preference", text: "用户习惯清晨散步" }]
    })));
    await system.selectPersonalityTemplate("companion");
    const first = await createMemory(fixture, {
      title: "清晨散步 1", content: "用户提到喜欢清晨散步。", kind: "view", basis: "observed"
    });
    await system.forceDreamRun();
    let user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(!user.includes("清晨散步"), "one observed view must not reach USER.md");

    await createMemory(fixture, {
      title: "清晨散步 2", content: "用户又提到清晨散步的习惯。", kind: "view", basis: "observed"
    });
    await createMemory(fixture, {
      title: "清晨散步 3", content: "用户第三次提到清晨散步。", kind: "view", basis: "observed"
    });
    const run = await system.forceDreamRun();
    assert.ok(run);
    user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /清晨散步/);
    assert.match(user, /观察/);
    void first;
  });
  console.log("PASS cognitive: USER observed threshold + trust markers");
}

// ---------------------------------------------------------------------------
// 11. Secondary candidate pipeline: confidence / threshold / diversity
// ---------------------------------------------------------------------------

async function scenarioSecondaryCandidatePipeline(): Promise<void> {
  // Pure confidence rule.
  assert.equal(computeSecondaryConfidence("direct", "explicit", "instance"), 0.85);
  assert.equal(computeSecondaryConfidence("strong_inference", "observed", "attribute"), 0.58);
  assert.equal(computeSecondaryConfidence("weak_inference", "explicit", "associated"), 0.30);
  assert.equal(computeSecondaryConfidence("strong_inference", "explicit", "category"), 0.70);

  await withPersonalMemoryFixture(async (fixture) => {
    const candidates = [
      { title: "直接类别", relation: "category", supportLevel: "direct", terms: ["类别甲"] },        // 0.85 keep
      { title: "强实例", relation: "instance", supportLevel: "strong_inference", terms: ["实例甲"] }, // 0.70 keep
      { title: "强属性一", relation: "attribute", supportLevel: "strong_inference", terms: ["属性甲"] }, // 0.65 keep
      { title: "强属性二", relation: "attribute", supportLevel: "strong_inference", terms: ["属性乙"] }, // 0.65 keep (2/2)
      { title: "强属性三", relation: "attribute", supportLevel: "strong_inference", terms: ["属性丙"] }, // dropped: relation cap
      { title: "强场景", relation: "context", supportLevel: "strong_inference", terms: ["场景甲"] },   // 0.65 keep
      { title: "弱关联", relation: "associated", supportLevel: "strong_inference", terms: ["关联甲"] }, // 0.55 below threshold
      { title: "弱推断", relation: "instance", supportLevel: "weak_inference", terms: ["实例乙"] },   // 0.45 below threshold
      { title: "直接联想", relation: "associated", supportLevel: "direct", terms: ["关联乙"] },       // 0.70 keep
      { title: "强实例", relation: "instance", supportLevel: "direct", terms: ["实例甲"] },           // duplicate of 强实例 → keep higher only
      { title: "缺证据候选", relation: "context", supportLevel: "direct", terms: ["场景乙"], noEvidence: true },
      { title: "无支持级别", relation: "context", terms: ["场景丙"], noSupport: true }
    ];
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: candidates.map((candidate) => ({
        title: candidate.title,
        content: `关于「${candidate.title}」的可能联想内容。`,
        recallWhen: "相关话题出现时",
        matchTerms: candidate.terms,
        relation: candidate.relation,
        ...("noSupport" in candidate && candidate.noSupport ? {} : { supportLevel: candidate.supportLevel }),
        ...("noEvidence" in candidate && candidate.noEvidence ? {} : { evidence: `由一级记忆推导：${candidate.title}` }),
        reason: "测试候选"
      }))
    })));
    const memory = await createMemory(fixture, {
      title: "管道测试记忆",
      content: "用于验证二级事实候选管道。"
    });
    const run = await system.forceDreamRun();
    assert.ok(run);
    const facts = await system.listSecondaryForParent(memory.id);
    const titles = facts.map((fact) => fact.title);

    // Validation: candidates missing supportLevel/evidence never persist.
    assert.ok(!titles.includes("缺证据候选"));
    assert.ok(!titles.includes("无支持级别"));
    // Threshold: below 0.60 never persists.
    assert.ok(!titles.includes("弱关联"));
    assert.ok(!titles.includes("弱推断"));
    // Diversity: max 2 per relation.
    const attributeFacts = facts.filter((fact) => fact.relation === "attribute");
    assert.equal(attributeFacts.length, 2);
    assert.ok(!titles.includes("强属性三"));
    // Dedupe: duplicate fingerprint keeps the higher-scoring one.
    const instanceFacts = facts.filter((fact) => fact.title === "强实例");
    assert.equal(instanceFacts.length, 1);
    assert.equal(instanceFacts[0].confidence, 0.85, "dedupe must keep the higher score");
    // Everything persisted passed the threshold.
    for (const fact of facts) {
      assert.ok(fact.confidence >= SECONDARY_CONFIDENCE_THRESHOLD - 1e-9);
    }
    assert.ok(facts.length <= 8);
  });
  console.log("PASS cognitive: secondary candidate pipeline");
}

// ---------------------------------------------------------------------------
// 12. Redream reconciliation: no append, reuse ids, replace stale facts
// ---------------------------------------------------------------------------

async function scenarioSecondaryRedreamReconcile(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const round = { value: 1 };
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => {
      if (round.value === 1) {
        return {
          ...EMPTY_DREAM_OUTPUT,
          secondaryFacts: [
            {
              title: "水果与甜食过敏风险",
              content: "水果可能与这条甜食过敏记录相关。",
              recallWhen: "讨论水果时",
              matchTerms: ["水果", "芒果"],
              relation: "instance",
              supportLevel: "strong_inference",
              reason: "桥接", evidence: "甜食过敏"
            },
            {
              title: "含糖食物",
              content: "糖和含糖食物可能触发相关提醒。",
              recallWhen: "讨论糖或饮料时",
              matchTerms: ["糖", "奶茶"],
              relation: "category",
              supportLevel: "strong_inference",
              reason: "桥接", evidence: "甜食过敏"
            },
            {
              title: "点餐场景",
              content: "点餐场景下也许可以参考这条过敏记录。",
              recallWhen: "点餐时",
              matchTerms: ["点餐", "菜单"],
              relation: "context",
              supportLevel: "strong_inference",
              reason: "场景", evidence: "甜食过敏"
            }
          ]
        };
      }
      return {
        ...EMPTY_DREAM_OUTPUT,
        secondaryFacts: [
          {
            title: "水果与甜食过敏风险",
            content: "重新表述：水果也许与甜食过敏相关。",
            recallWhen: "讨论水果时",
            matchTerms: ["水果", "芒果"],
            relation: "instance",
            supportLevel: "strong_inference",
            reason: "桥接", evidence: "甜食过敏"
          },
          {
            title: "过敏原成分提醒",
            content: "配料表里的过敏原成分可能值得留意。",
            recallWhen: "看配料表时",
            matchTerms: ["配料表", "过敏原"],
            relation: "context",
            supportLevel: "direct",
            reason: "直接相关", evidence: "甜食过敏"
          }
        ]
      };
    }));
    const memory = await createMemory(fixture, {
      title: "我对甜食过敏",
      content: "我对甜食过敏。",
      recallWhen: "讨论饮食时"
    });
    await system.forceDreamRun();
    let facts = await system.listSecondaryForParent(memory.id);
    assert.equal(facts.length, 3);

    // Hit the fruit fact once, then let the user edit the sugar fact.
    const fruit = facts.find((fact) => fact.title.includes("水果"))!;
    const sugar = facts.find((fact) => fact.title.includes("含糖"))!;
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal", query: "芒果"
    }, fixture.runtime());
    assert.ok(snapshot.search);
    await fixture.repository.recordSecondaryRecallHits(snapshot.search!.pendingSecondaryHits);
    const fruitAfterHit = (await system.listSecondaryForParent(memory.id))
      .find((fact) => fact.id === fruit.id)!;
    assert.equal(fruitAfterHit.hitCount, 1);
    await system.updateSecondaryFact(sugar.id, { content: "用户手工修正：含糖食物需要留意。" });

    // Redream the parent: a personality reset re-marks every valid memory as
    // a dream source; the engine must reconcile instead of append.
    await system.selectPersonalityTemplate("executor", { reset: true });
    round.value = 2;
    const run = await system.forceDreamRun();
    assert.ok(run);
    assert.ok(run!.processedMemoryIds.includes(memory.id), "reset must re-dream the parent");
    facts = await system.listSecondaryForParent(memory.id);
    const current = facts.filter((fact) => fact.status === "current");

    // Reused fingerprint keeps id + hitCount + lastHitAt + history confidence.
    const fruitAgain = current.find((fact) => fact.title.includes("水果"))!;
    assert.equal(fruitAgain.id, fruit.id, "same fact must reuse the old id");
    assert.equal(fruitAgain.hitCount, fruitAfterHit.hitCount, "hitCount must be reused");
    assert.equal(fruitAgain.lastHitAt, fruitAfterHit.lastHitAt, "lastHitAt must be reused");
    assert.equal(fruitAgain.confidence, fruitAfterHit.confidence, "history confidence must be reused");

    // User edit survives redreaming untouched.
    const sugarAgain = current.find((fact) => fact.id === sugar.id);
    assert.ok(sugarAgain, "user_edited_inference must survive redreaming");
    assert.equal(sugarAgain!.basis, "user_edited_inference");
    assert.match(sugarAgain!.content, /用户手工修正/);

    // New fact added; stale llm fact (点餐场景) not re-selected → disabled.
    assert.ok(current.some((fact) => fact.title.includes("过敏原成分")));
    const stale = facts.find((fact) => fact.title.includes("点餐场景"))!;
    assert.equal(stale.status, "disabled");

    // No append duplicates.
    assert.equal(current.length, 3);

    // Final set still satisfies threshold / relation cap / hard cap.
    const index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { parentId: string }[];
    };
    assert.equal(index.secondaryCatalog.filter((entry) => entry.parentId === memory.id).length, 3);
  });
  console.log("PASS cognitive: redream reconciliation");
}

// ---------------------------------------------------------------------------
// 13. Recall: decisive secondary hits, hitCount, CJK bigram safety
// ---------------------------------------------------------------------------

async function scenarioRecallSecondaryDecisive(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const memory = await createMemory(fixture, {
      title: "早晨的手冲流程",
      content: "用户每天早晨都有一套固定的手冲流程，偏好酸一点的风味。"
    });
    const memoryId = memory.id;
    await system.forceDreamRun();

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

    await fixture.repository.recordSecondaryRecallHits(decisive.search!.pendingSecondaryHits);
    const facts = await system.listSecondaryForParent(memoryId);
    assert.equal(facts[0].hitCount, 1);
    assert.ok(facts[0].lastHitAt && facts[0].lastHitAt > 0);

    const direct = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "早晨的手冲流程"
    }, fixture.runtime());
    assert.ok(direct.search);
    assert.equal(direct.search!.pendingSecondaryHits.length, 0);

    assert.deepEqual(lexicalTokens("项"), []);
    assert.deepEqual(lexicalTokens("咖啡豆").sort(), ["咖啡", "啡豆"].sort());

    await createMemory(fixture, {
      title: "机房值班表",
      content: "机房值班安排表。",
      recallWhen: "聊到值班时"
    });
    const noOverlap = await fixture.repository.search({
      query: "咖啡机",
      limit: 10
    }, fixture.runtime());
    assert.ok(!noOverlap.items.some((entry) => entry.title === "机房值班表"));
  });
  console.log("PASS cognitive: recall secondary decisive hits + CJK bigram guard");
}

// ---------------------------------------------------------------------------
// 14. Decay idempotency (grace 30d, factor 0.8, once at day 30 not day 31)
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
    supportLevel: "strong_inference",
    evidence: "测试",
    confidence: computeSecondaryConfidence("strong_inference", "explicit", "associated"),
    sourceMemoryRevision: 1,
    now: createdAt,
    idFactory: () => "sec_decay_test"
  });
  const confidence0 = record.confidence;

  const day29 = applySecondaryDecay(record, createdAt + 29 * DAY_MS);
  assert.equal(day29.decayed, false);
  const day30 = applySecondaryDecay(record, createdAt + 30 * DAY_MS);
  assert.equal(day30.decayed, true);
  assert.ok(Math.abs(day30.record.confidence - confidence0 * 0.8) < 1e-9);
  const day31 = applySecondaryDecay(day30.record, createdAt + 31 * DAY_MS);
  assert.equal(day31.decayed, false);
  const day30again = applySecondaryDecay(day30.record, createdAt + 30 * DAY_MS + 1_000);
  assert.equal(day30again.decayed, false);

  let weak = record;
  for (let index = 0; index < 20 && weak.status === "current"; index += 1) {
    weak = applySecondaryDecay(weak, weak.updatedAt + 30 * DAY_MS + index).record;
  }
  assert.equal(weak.status, "disabled");
  console.log("PASS cognitive: secondary decay is idempotent with 30-day grace");
}

// ---------------------------------------------------------------------------
// 15. Lifecycle: supersede/forget disable, restore re-enables
// ---------------------------------------------------------------------------

async function scenarioSecondaryLifecycle(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const memory = await createMemory(fixture, {
      title: "用户常用的编辑器",
      content: "用户日常使用 Obsidian 做笔记。"
    });
    const memoryId = memory.id;
    await system.forceDreamRun();
    assert.equal((await system.listSecondaryForParent(memoryId)).length, 1);

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
    const index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { parentId: string }[];
    };
    assert.ok(!index.secondaryCatalog.some((entry) => entry.parentId === memoryId));

    const second = await createMemory(fixture, {
      title: "用户的键盘",
      content: "用户用一把客制化机械键盘。"
    });
    const secondId = second.id;
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
  });
  console.log("PASS cognitive: supersede/forget/restore lifecycle of secondary facts");
}

// ---------------------------------------------------------------------------
// 16. User edit / delete of secondary facts (复盘 → 记忆修正)
// ---------------------------------------------------------------------------

async function scenarioSecondaryUserEditDelete(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const memory = await createMemory(fixture, {
      title: "周末徒步",
      content: "用户周末经常去山里徒步。"
    });
    const memoryId = memory.id;
    await system.forceDreamRun();
    const fact = (await system.listSecondaryForParent(memoryId))[0];

    const edited = await system.updateSecondaryFact(fact.id, {
      title: "周末山地徒步",
      matchTerms: ["徒步", "山地运动"],
      reason: "用户手工修正"
    });
    assert.equal(edited.record.title, "周末山地徒步");
    assert.equal(edited.record.basis, "user_edited_inference");
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
// 17. Migration: v2 index rebuilds to v3; custom AGENT/USER preserved
// ---------------------------------------------------------------------------

async function scenarioV2MigrationAndCustomFilesPreserved(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const customAgent = "# 我的自定义 Agent 设定\n保持这个风格。\n";
    const customUser = "# 我的自定义用户画像\n只保留我确认过的内容。\n";
    await writeFile(fixture.repository.layout.agent, customAgent);
    await writeFile(fixture.repository.layout.user, customUser);
    await createMemory(fixture, {
      title: "迁移测试记忆",
      content: "验证 v2 索引重建时不破坏内容。"
    });

    const current = await readJson(fixture.repository.layout.searchIndex);
    const v2 = {
      schemaVersion: 2,
      revision: current.revision,
      catalog: (current.catalog as readonly Record<string, unknown>[]).map((entry) => ({
        id: entry.id, kind: entry.kind, status: entry.status, title: entry.title,
        recallWhen: entry.recallWhen, date: entry.date, basis: entry.basis,
        sourceSummary: entry.sourceSummary, summary: entry.summary,
        routeTokens: entry.routeTokens, contentTokens: entry.contentTokens
      })),
      checksum: "legacy-v2-checksum"
    };
    await writeFile(fixture.repository.layout.searchIndex, JSON.stringify(v2));

    const reopened = await fixture.reopen();
    const rebuilt = await readJson(reopened.layout.searchIndex);
    assert.equal(rebuilt.schemaVersion, 3);
    assert.equal((rebuilt.catalog as unknown[]).length, (v2.catalog as unknown[]).length);

    const found = await reopened.search({ query: "迁移测试", limit: 5 }, fixture.runtime());
    assert.ok(found.items.some((item) => item.title === "迁移测试记忆"));

    // No cognitive system ever ran here, so custom files survive untouched.
    assert.equal(await readFile(reopened.layout.agent, "utf8"), customAgent);
    assert.equal(await readFile(reopened.layout.user, "utf8"), customUser);
  });
  console.log("PASS cognitive: v2→v3 index migration keeps custom identity files");
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 18. Zero-fact bookkeeping: processed parents never re-call the Provider (§10)
// ---------------------------------------------------------------------------

async function scenarioZeroFactsBookkeeping(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    let llmCalls = 0;
    const llm: DreamLlmPort = {
      call: async () => {
        llmCalls += 1;
        return JSON.stringify(EMPTY_DREAM_OUTPUT);
      }
    };
    const system = await createSystem(fixture, () => llm);
    const memory = await createMemory(fixture, {
      title: "没有可靠推理的记忆",
      content: "这条记忆推导不出任何值得保存的二级事实。"
    });

    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    assert.ok(run1!.processedMemoryIds.includes(memory.id), "0-fact parent must still be marked processed");
    assert.equal(run1!.factsCreated, 0);
    assert.equal((await system.listSecondaryForParent(memory.id)).length, 0);
    assert.equal(llmCalls, 1);

    // processedSources recorded the revision → no re-selection on later runs.
    const personality = await system.readPersonalityState();
    const processed = personality.processedSources.find(
      (source) => source.memoryId === memory.id
    );
    assert.ok(processed, "processedSources must record the 0-fact parent");

    const run2 = await system.forceDreamRun();
    assert.equal(llmCalls, 1, "second dream must not call the Provider again");
    assert.ok(!run2 || !run2.processedMemoryIds.includes(memory.id));

    fixture.advance(31 * DAY_MS);
    await system.forceDreamRun();
    assert.equal(llmCalls, 1, "decay rounds must not re-process a 0-fact parent");
  });
  console.log("PASS cognitive: zero-fact bookkeeping avoids repeat Provider calls");
}

// ---------------------------------------------------------------------------
// 19. Consecutive redreams must not accumulate duplicates (§9 / 回归 #4)
// ---------------------------------------------------------------------------

async function scenarioRedreamNoAccumulation(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [
        {
          title: "重复做梦事实甲",
          content: "语义稳定的联想甲。",
          recallWhen: "相关话题出现时",
          matchTerms: ["重复甲"],
          relation: "instance",
          supportLevel: "strong_inference",
          reason: "测试",
          evidence: "由一级记忆推导"
        },
        {
          title: "重复做梦事实乙",
          content: "语义稳定的联想乙。",
          recallWhen: "相关话题出现时",
          matchTerms: ["重复乙"],
          relation: "category",
          supportLevel: "direct",
          reason: "测试",
          evidence: "由一级记忆直接推导"
        }
      ]
    })));
    const memory = await createMemory(fixture, {
      title: "重复做梦测试记忆",
      content: "验证连续做梦不会累积重复事实。"
    });

    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    const first = await system.listSecondaryForParent(memory.id);
    assert.equal(first.length, 2);
    const firstIds = first.map((fact) => fact.id).sort();

    // Reset re-marks valid memories as dream sources → same parent redreamed.
    await system.selectPersonalityTemplate("executor", { reset: true });
    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    assert.ok(run2!.processedMemoryIds.includes(memory.id));
    assert.equal(run2!.factsReused, 2, "identical semantics must reuse, not append");
    assert.equal(run2!.factsCreated, 0);

    const second = await system.listSecondaryForParent(memory.id);
    assert.equal(second.length, 2, "no accumulation across redreams");
    assert.deepEqual(second.map((fact) => fact.id).sort(), firstIds);
  });
  console.log("PASS cognitive: consecutive redreams do not accumulate duplicates");
}

// ---------------------------------------------------------------------------
// 20. Diversity: coverage first, no blind top-8 truncation, small keeps (§8)
// ---------------------------------------------------------------------------

function pipelineCandidate(
  title: string,
  relation: SecondaryFactCandidate["relation"],
  supportLevel: SecondaryFactCandidate["supportLevel"]
): SecondaryFactCandidate {
  return Object.freeze({
    title,
    content: `关于「${title}」的保守联想内容。`,
    recallWhen: "相关话题出现时",
    matchTerms: [title],
    relation,
    supportLevel,
    reason: "测试",
    evidence: `由一级记忆推导：${title}`
  });
}

async function scenarioDiversityCoverageNoTruncation(): Promise<void> {
  // 12 candidates: the BEST one sits at position 12 — a blind "keep first 8"
  // truncation would drop it; diversity must keep one per qualifying relation.
  const candidates: SecondaryFactCandidate[] = [
    ...[1, 2, 3, 4, 5, 6].map((i) => pipelineCandidate(`属性候选${i}`, "attribute", "strong_inference")),
    ...[1, 2, 3].map((i) => pipelineCandidate(`场景候选${i}`, "context", "strong_inference")),
    pipelineCandidate("弱实例候选", "instance", "weak_inference"),     // 0.45 below threshold
    pipelineCandidate("弱关联候选", "associated", "weak_inference"),   // 0.30 below threshold
    pipelineCandidate("高分分类候选", "category", "direct")            // 0.85, position 12
  ];
  const result = reconcileSecondaryForParent({
    parentId: "mem_diversity_parent",
    parentBasis: "explicit",
    parentRevision: 1,
    existing: [],
    candidates,
    now: 1_800_000_000_000,
    idFactory: (() => { let n = 0; return () => `sec_div_${++n}`; })()
  });
  const current = result.records.filter((record) => record.status === "current");
  const titles = current.map((record) => record.title);

  assert.ok(titles.includes("高分分类候选"), "position-12 candidate must survive (no top-8 truncation)");
  assert.equal(current.filter((r) => r.relation === "attribute").length, 2, "attribute capped at 2");
  assert.equal(current.filter((r) => r.relation === "context").length, 2, "context capped at 2");
  assert.ok(!titles.includes("弱实例候选"));
  assert.ok(!titles.includes("弱关联候选"));
  assert.equal(current.length, 5);
  assert.ok(current.length <= 8);

  // Only 2 candidates pass the threshold → keep exactly 2 (不凑数).
  const sparse = reconcileSecondaryForParent({
    parentId: "mem_sparse_parent",
    parentBasis: "explicit",
    parentRevision: 1,
    existing: [],
    candidates: [
      pipelineCandidate("稀疏分类", "category", "direct"),          // 0.85 keep
      pipelineCandidate("稀疏实例", "instance", "strong_inference"), // 0.70 keep
      pipelineCandidate("稀疏弱一", "context", "weak_inference"),    // 0.45 drop
      pipelineCandidate("稀疏弱二", "associated", "weak_inference"), // 0.30 drop
      pipelineCandidate("稀疏弱三", "attribute", "weak_inference")   // 0.40 drop
    ],
    now: 1_800_000_000_000,
    idFactory: (() => { let n = 0; return () => `sec_sparse_${++n}`; })()
  });
  const sparseCurrent = sparse.records.filter((record) => record.status === "current");
  assert.equal(sparseCurrent.length, 2, "only threshold-passing candidates persist");
  console.log("PASS cognitive: diversity coverage without top-8 truncation");
}

// ---------------------------------------------------------------------------
// 21. Final-payload budget + single secondary injection (§12 / 回归 #15)
// ---------------------------------------------------------------------------

async function scenarioFinalPayloadBudgetSingleInjection(): Promise<void> {
  const base: PersonalMemoryTurnCatalogCandidate = Object.freeze({
    id: "mem_budget_parent",
    kind: "fact",
    status: "current",
    title: "预算测试一级记忆",
    recallWhen: "相关话题出现时",
    summary: "用于验证预算按最终注入内容计算。",
    date: "2026-08-20",
    basis: "explicit",
    sourceSummary: "",
    score: 1
  });
  const withMatches: PersonalMemoryTurnCatalogCandidate = Object.freeze({
    ...base,
    secondaryMatches: Object.freeze([
      Object.freeze({
        id: "sec_budget_fact",
        parentId: base.id,
        title: "预算测试二级事实",
        content: "这段较长的二级事实正文必须计入最终注入预算，不能被遗漏。".repeat(4),
        recallWhen: "相关话题出现时",
        matchTerms: ["预算测试"],
        relation: "instance" as const,
        basis: "llm_inferred" as const
      })
    ])
  });
  const withTokens = measureFinalInjectionTokens(withMatches);
  const withoutTokens = measureFinalInjectionTokens(base);
  assert.ok(withTokens > withoutTokens,
    "budget must include secondary fact text, parentTitle and wrappers");

  // End-to-end: a tiny budget must not inject the candidate; a large one does.
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const memory = await createMemory(fixture, {
      title: "预算端到端记忆",
      content: "用户每天早晨都有一套固定的手冲流程。"
    });
    await system.forceDreamRun();
    const harness = new PersonalMemoryRecallHarness(fixture.repository);
    const common = {
      memoryMode: "normal" as const,
      query: "咖啡豆",
      vaultId: fixture.vaultId,
      conversationId: "conversation-budget",
      piSessionId: "pi-budget",
      productRunId: "run-budget"
    };
    const starved = await harness.prepareTurnContext({ ...common, tokenBudget: 8 });
    assert.equal(starved.recall?.injected ?? 0, 0, "tiny budget must inject nothing");

    const plenty = await harness.prepareTurnContext({ ...common, tokenBudget: 2_000 });
    assert.equal(plenty.recall?.injected, 1);
    const injected = plenty.recall!.candidates[0];
    assert.equal(injected.id, memory.id);
    assert.ok(injected.matchedSecondaryId, "decisive secondary id must stay on the candidate");
    assert.ok((injected.secondaryMatches ?? []).length >= 1,
      "full facts stay available for the single secondary block");
  });
  console.log("PASS cognitive: final-payload budget + single secondary injection");
}

// ---------------------------------------------------------------------------
// 22. Allergy bridge recall: 甜食过敏 → 芒果 query hits llm-inferred fact (#16/#17)
// ---------------------------------------------------------------------------

async function scenarioMangoRecallBridge(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: "甜食过敏相关食物",
        content: "用户可能对水果、含糖食物也需要留意（保守参考，非诊断）。",
        recallWhen: "聊到水果、甜食或点餐时",
        matchTerms: ["水果", "芒果", "含糖食物"],
        relation: "instance",
        supportLevel: "strong_inference",
        reason: "甜食过敏与水果/含糖食物可能相关",
        evidence: "一级记忆记录了甜食过敏"
      }]
    })));
    const memory = await createMemory(fixture, {
      title: "甜食过敏",
      content: "我对甜食过敏。"
    });
    await system.forceDreamRun();
    const facts = await system.listSecondaryForParent(memory.id);
    assert.equal(facts.length, 1);

    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "我想吃芒果"
    }, fixture.runtime());
    assert.ok(snapshot.search);
    assert.equal(snapshot.search!.items.length, 1);
    const item = snapshot.search!.items[0];
    assert.equal(item.id, memory.id, "bridge fact must pull the primary memory into recall");
    assert.ok(item.matchedSecondaryId);
    const match = (item.secondaryMatches ?? [])[0];
    assert.ok(match);
    assert.equal(match!.basis, "llm_inferred");
    assert.equal(snapshot.search!.pendingSecondaryHits.length, 1);
  });
  console.log("PASS cognitive: allergy bridge recall (芒果 → llm-inferred-reference fact)");
}

// ---------------------------------------------------------------------------
// 23. Hit stats transaction + decay revisions + disabledReason restore gate
//     (§11 / 回归 #18 #19)
// ---------------------------------------------------------------------------

async function scenarioHitStatsAndDisabledReasonRestore(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [
        {
          title: "甲寅统计事实",
          content: "用于验证命中事务与衰减。",
          recallWhen: "相关话题出现时",
          matchTerms: ["甲寅统计"],
          relation: "instance",
          supportLevel: "strong_inference",
          reason: "测试",
          evidence: "由一级记忆推导"
        },
        {
          title: "用户会编辑的事实",
          content: "用于验证 restore 限制。",
          recallWhen: "相关话题出现时",
          matchTerms: ["编辑验证"],
          relation: "category",
          supportLevel: "direct",
          reason: "测试",
          evidence: "由一级记忆直接推导"
        }
      ]
    })));
    const memory = await createMemory(fixture, {
      title: "命中与恢复测试记忆",
      content: "验证命中事务、衰减与 restore 限制。"
    });
    await system.forceDreamRun();
    let facts = await system.listSecondaryForParent(memory.id);
    assert.equal(facts.length, 2);
    const hitFact = facts.find((fact) => fact.title === "甲寅统计事实")!;
    const editedFact = facts.find((fact) => fact.title === "用户会编辑的事实")!;
    const hitRevision0 = hitFact.revision;

    // --- Hit: revision bump + repository transaction (manifest bumps). ---
    const manifestBefore = await readJson(fixture.repository.layout.manifest);
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "甲寅统计"
    }, fixture.runtime());
    assert.equal(snapshot.search!.pendingSecondaryHits.length, 1);
    await fixture.repository.recordSecondaryRecallHits(snapshot.search!.pendingSecondaryHits);
    const manifestAfter = await readJson(fixture.repository.layout.manifest);
    assert.ok(
      (manifestAfter.revision as number) > (manifestBefore.revision as number),
      "hit stats must commit through a repository transaction"
    );
    facts = await system.listSecondaryForParent(memory.id);
    const hitAfter = facts.find((fact) => fact.id === hitFact.id)!;
    assert.equal(hitAfter.hitCount, 1);
    assert.equal(hitAfter.confidence, 0.75);
    assert.equal(hitAfter.revision, hitRevision0 + 1, "hit must bump the fact's own revision");

    // --- User edit protects the second fact from auto-disable. ---
    await system.updateSecondaryFact(editedFact.id, { content: "用户手工修正后的内容。" });

    // --- Decay rounds: index removal at <0.60, auto-disable at <0.10. ---
    let lowConfidence: typeof hitAfter | undefined;
    let indexDroppedChecked = false;
    for (let round = 0; round < 16; round += 1) {
      fixture.advance(30 * DAY_MS + 1_000);
      await system.forceDreamRun();
      facts = await system.listSecondaryForParent(memory.id);
      const current = facts.find((fact) => fact.id === hitFact.id)!;
      if (!indexDroppedChecked && current.status === "current" && current.confidence < 0.60) {
        const index = await readJson(fixture.repository.layout.searchIndex) as {
          secondaryCatalog: readonly { id: string }[];
        };
        assert.ok(!index.secondaryCatalog.some((entry) => entry.id === hitFact.id),
          "below-threshold facts leave the Recall Index but keep their files");
        indexDroppedChecked = true;
      }
      if (current.status === "disabled") {
        lowConfidence = current;
        break;
      }
    }
    assert.ok(lowConfidence, "llm_inferred fact must auto-disable below 0.10");
    assert.equal(lowConfidence!.disabledReason, "low_confidence");
    assert.ok(indexDroppedChecked);
    facts = await system.listSecondaryForParent(memory.id);
    const editedAfterDecay = facts.find((fact) => fact.id === editedFact.id)!;
    assert.equal(editedAfterDecay.status, "current", "user_edited_inference never auto-disables");
    assert.equal(editedAfterDecay.basis, "user_edited_inference");

    // --- Forget disables by parent lifecycle; restore only re-enables those. ---
    await fixture.repository.forgetFromUserControl(memory.id, "测试忘记");
    facts = await system.secondaryStore.refresh();
    const editedDisabled = facts.find((fact) => fact.id === editedFact.id)!;
    assert.equal(editedDisabled.status, "disabled");
    assert.equal(editedDisabled.disabledReason, "parent_lifecycle");

    await fixture.repository.restoreForgotten(memory.id);
    facts = await system.secondaryStore.refresh();
    const editedRestored = facts.find((fact) => fact.id === editedFact.id)!;
    assert.equal(editedRestored.status, "current", "parent_lifecycle facts restore");
    const stillDisabled = facts.find((fact) => fact.id === hitFact.id)!;
    assert.equal(stillDisabled.status, "disabled", "low_confidence facts must NOT restore");
    assert.equal(stillDisabled.disabledReason, "low_confidence");
  });
  console.log("PASS cognitive: hit transaction + decay revisions + restore gate");
}

export async function runCognitiveSystemScenarios(): Promise<void> {
  await scenarioTemplateSelectionPersistsWithoutProvider();
  await scenarioResetFlowSingleTransaction();
  await scenarioDreamCreatesSecondaryFacts();
  await scenarioDreamGating();
  await scenarioDreamFailureSemantics();
  await scenarioLegacyFileCompatibility();
  await scenarioSourceReconciliation();
  await scenarioObservedTraitFallback();
  await scenarioEvolutionPromptAndAllergyBridge();
  await scenarioUserProfileThresholdAndTrust();
  await scenarioSecondaryCandidatePipeline();
  await scenarioSecondaryRedreamReconcile();
  await scenarioRecallSecondaryDecisive();
  await scenarioSecondaryDecayIdempotent();
  await scenarioSecondaryLifecycle();
  await scenarioSecondaryUserEditDelete();
  await scenarioV2MigrationAndCustomFilesPreserved();
  await scenarioZeroFactsBookkeeping();
  await scenarioRedreamNoAccumulation();
  await scenarioDiversityCoverageNoTruncation();
  await scenarioFinalPayloadBudgetSingleInjection();
  await scenarioMangoRecallBridge();
  await scenarioHitStatsAndDisabledReasonRestore();
}
