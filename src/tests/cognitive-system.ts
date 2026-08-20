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
  applySecondaryHit,
  computeSecondaryConfidence,
  createSecondaryRecord,
  reconcileSecondaryForParent,
  secondaryRelativePath,
  SECONDARY_CONFIDENCE_THRESHOLD,
  type SecondaryFactCandidate
} from "../harness/memory/secondary-memory-store";
import {
  measureFinalInjectionTokens,
  PersonalMemoryRecallHarness,
  serializeRecallInjection
} from "../harness/memory/personal-memory-recall-harness";
import { estimatePiContextTokens } from "../harness/pi-native/pi-context-budget";
import type { PersonalMemoryTurnCatalogCandidate } from "../harness/memory/personal-memory-repository";
import { currentPersonalityScores, type PersonalityState } from "../harness/memory/personality-state";
import { parseUserProfileState, USER_OBSERVED_MIN_SOURCES, type UserProfileState } from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { getPersonalityTemplate, TRAIT_DIMENSION_META } from "../harness/memory/personality-templates";
import { defaultUserProfile } from "../harness/memory/personal-memory-repository";
import { lexicalTokens } from "../harness/memory/search-index-v3";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import type { AgentAvatarState } from "../harness/memory/agent-identity-state";

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
    const result = await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小执", avatar: { kind: "default" } }
    });
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
    await system.selectPersonalityTemplate("companion", {
      initialIdentity: { displayName: "小伴", avatar: { kind: "default" } }
    });
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
    await system.selectPersonalityTemplate("advisor", {
      initialIdentity: { displayName: "小问", avatar: { kind: "default" } }
    });
    const memory = await createMemory(fixture, {
      title: "早晨的手冲流程",
      content: "用户每天早晨都有一套固定的手冲流程，偏好酸一点的风味。"
    });
    const memoryId = memory.id;

    await system.settleDreamEnqueue();
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
    await system.settleDreamEnqueue();
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
    await system.settleDreamEnqueue();

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
    await system.selectPersonalityTemplate("butler", {
      initialIdentity: { displayName: "小管", avatar: { kind: "default" } }
    });
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
    await system.selectPersonalityTemplate("advisor", {
      initialIdentity: { displayName: "小问", avatar: { kind: "default" } }
    });

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
    await system.selectPersonalityTemplate("advisor", { // explicit tempo = 0.75
      initialIdentity: { displayName: "小问", avatar: { kind: "default" } }
    });

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
    await system.selectPersonalityTemplate("companion", {
      initialIdentity: { displayName: "小伴", avatar: { kind: "default" } }
    });
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
    let facts = await system.listAllSecondary();
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
    facts = await system.listAllSecondary();
    assert.ok(facts
      .filter((fact) => fact.parentId === secondId)
      .every((fact) => fact.status === "disabled"));

    await fixture.repository.restoreForgotten(secondId);
    facts = await system.listAllSecondary();
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
    assert.equal((await system.listAllSecondary())
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
  const withTokens = measureFinalInjectionTokens([withMatches]);
  const withoutTokens = measureFinalInjectionTokens([base]);
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
    facts = await system.listAllSecondary();
    const editedDisabled = facts.find((fact) => fact.id === editedFact.id)!;
    assert.equal(editedDisabled.status, "disabled");
    assert.equal(editedDisabled.disabledReason, "parent_lifecycle");

    await fixture.repository.restoreForgotten(memory.id);
    facts = await system.listAllSecondary();
    const editedRestored = facts.find((fact) => fact.id === editedFact.id)!;
    assert.equal(editedRestored.status, "current", "parent_lifecycle facts restore");
    const stillDisabled = facts.find((fact) => fact.id === hitFact.id)!;
    assert.equal(stillDisabled.status, "disabled", "low_confidence facts must NOT restore");
    assert.equal(stillDisabled.disabledReason, "low_confidence");
  });
  console.log("PASS cognitive: hit transaction + decay revisions + restore gate");
}


// ---------------------------------------------------------------------------
// R3-1. DreamState restart: enqueue merges into real persisted state (§1)
// ---------------------------------------------------------------------------

async function scenarioDreamStateRestartMergesEnqueues(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const seeded = {
      schema: "echoink.dream.v1",
      revision: 7,
      lastRunAt: 1_700_000_000_000,
      lastSuccessAt: 1_700_000_000_000,
      lastProcessedMemoryRevision: 3,
      pendingMemoryIds: ["mem_legacy_pending"],
      backfillCursor: "mem_cursor_x",
      updatedAt: 1_700_000_000_000
    };
    await writeFile(fixture.repository.layout.dreamState, JSON.stringify(seeded, null, 2));

    // Rebuild the system (simulated restart) — no scheduler tick involved.
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));

    // Immediately write three new memories concurrently: enqueue must merge
    // into the real persisted state, not an uninitialized in-memory default.
    const writes = await Promise.all([
      createMemory(fixture, { title: "重启后记忆一", content: "重启后第一条记忆。" }),
      createMemory(fixture, { title: "重启后记忆二", content: "重启后第二条记忆。" }),
      createMemory(fixture, { title: "重启后记忆三", content: "重启后第三条记忆。" })
    ]);
    await system.settleDreamEnqueue();

    const state = await readJson(fixture.repository.layout.dreamState) as {
      revision: number;
      lastRunAt: number;
      lastSuccessAt: number;
      lastProcessedMemoryRevision: number;
      pendingMemoryIds: readonly string[];
      backfillCursor: string | null;
    };
    assert.deepEqual(
      [...state.pendingMemoryIds].sort(),
      ["mem_legacy_pending", ...writes.map((record) => record.id)].sort(),
      "pre-existing pending and all new writes must survive rebuild + concurrent enqueues"
    );
    assert.equal(state.lastRunAt, 1_700_000_000_000, "enqueue must never reset lastRunAt");
    assert.equal(state.lastSuccessAt, 1_700_000_000_000, "enqueue must never reset lastSuccessAt");
    assert.equal(state.lastProcessedMemoryRevision, 3, "enqueue must never reset the processed watermark");
    assert.equal(state.backfillCursor, "mem_cursor_x", "enqueue must never reset the backfill cursor");
    assert.equal(state.revision, 10, "each real enqueue bumps the dream-state revision exactly once");
  });
  console.log("PASS cognitive: restart merges dream enqueues into persisted state");
}

// ---------------------------------------------------------------------------
// R3-2. Dual-cache consistency: immediate visibility, rebuild, failed txn (§2)
// ---------------------------------------------------------------------------

async function scenarioSecondaryCacheImmediateAndConsistent(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(validDreamJson));
    const memory = await createMemory(fixture, {
      title: "缓存一致性记忆",
      content: "用于验证二级事实双缓存一致性。"
    });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    const fact = (await system.listSecondaryForParent(memory.id))[0];
    assert.ok(fact);

    // close → immediately visible through the committed cache (no refresh).
    await fixture.repository.write({
      operation: "close",
      targetId: memory.id,
      reason: "测试关闭"
    } as never, fixture.runtime());
    const afterClose = await system.listSecondaryForParent(memory.id);
    assert.equal(afterClose[0].status, "disabled", "close must be visible without any refresh");
    assert.equal(afterClose[0].disabledReason, "parent_lifecycle");

    // Rebuild from disk (fresh system) → identical view.
    const rebuilt = await createSystem(fixture, () => null);
    const fromDisk = await rebuilt.listAllSecondary();
    const fromCache = await system.listAllSecondary();
    assert.deepEqual(
      fromDisk.map((record) => `${record.id}:${record.status}:${record.disabledReason}`),
      fromCache.map((record) => `${record.id}:${record.status}:${record.disabledReason}`),
      "rebuild from disk must match the committed cache"
    );

    // Failed cognitive transaction: disk and BOTH caches keep the old values.
    // An unsafe extraChanges path makes runTransaction reject mid-flight.
    const factPath = `${fixture.vaultPath}/.echoink/${fact.file}`;
    const diskBefore = await readFile(factPath, "utf8");
    const cacheBefore = (await system.listAllSecondary())
      .map((record) => `${record.id}:${record.confidence}:${record.revision}`);
    await assert.rejects(
      fixture.repository.applyCognitiveUpdate({
        secondaryRecords: (await system.listAllSecondary()).map((record) => ({ ...record, confidence: 0.01 })),
        extraChanges: [{ relativePath: "../escape.md", content: "must fail" }],
        detail: "must-fail"
      }),
      /escapes/u
    );
    assert.equal(await readFile(factPath, "utf8"), diskBefore,
      "failed transaction must not touch secondary files on disk");
    const cacheAfter = (await system.listAllSecondary())
      .map((record) => `${record.id}:${record.confidence}:${record.revision}`);
    assert.deepEqual(cacheAfter, cacheBefore,
      "failed transaction must leave both caches at the pre-commit state");
    const rebuiltAfterFail = await createSystem(fixture, () => null);
    assert.deepEqual(
      (await rebuiltAfterFail.listAllSecondary())
        .map((record) => `${record.id}:${record.confidence}:${record.revision}`),
      cacheBefore,
      "disk rebuild after a failed transaction also sees the old state"
    );
  });
  console.log("PASS cognitive: secondary caches stay consistent through lifecycle and failures");
}

// ---------------------------------------------------------------------------
// R3-3. Partial failure retries only the failed records (§3)
// ---------------------------------------------------------------------------

async function scenarioPartialFailureRedreamsOnlyFailed(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const calls: string[] = [];
    let bValid = false;
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => {
      calls.push(memory.title);
      if (memory.title === "部分失败记忆乙") {
        if (!bValid) return "{invalid-json";
        return {
          ...EMPTY_DREAM_OUTPUT,
          secondaryFacts: [{
            title: "乙记忆事实",
            content: "由乙记忆推导的事实。",
            recallWhen: "相关话题出现时",
            matchTerms: ["部分失败乙"],
            relation: "instance",
            supportLevel: "direct",
            reason: "测试",
            evidence: "记忆直接陈述"
          }]
        };
      }
      return {
        ...EMPTY_DREAM_OUTPUT,
        secondaryFacts: [{
          title: "甲记忆事实",
          content: "由甲记忆推导的事实。",
          recallWhen: "相关话题出现时",
          matchTerms: ["部分失败甲"],
          relation: "instance",
          supportLevel: "direct",
          reason: "测试",
          evidence: "记忆直接陈述"
        }]
      };
    }));
    const memoryA = await createMemory(fixture, { title: "部分失败记忆甲", content: "甲记忆内容。" });
    const memoryB = await createMemory(fixture, { title: "部分失败记忆乙", content: "乙记忆内容。" });
    await system.settleDreamEnqueue();

    // Round 1: A valid, B invalid → only A commits; B stays pending.
    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    assert.equal(run1!.committed, true);
    assert.deepEqual(run1!.processedMemoryIds, [memoryA.id]);
    assert.deepEqual(run1!.failedMemoryIds, [memoryB.id]);
    const factsA1 = await system.listSecondaryForParent(memoryA.id);
    assert.equal(factsA1.length, 1);
    assert.equal((await system.listSecondaryForParent(memoryB.id)).length, 0);
    let dreamState = await readJson(fixture.repository.layout.dreamState) as {
      pendingMemoryIds: readonly string[];
      lastSuccessAt: number;
    };
    assert.deepEqual(dreamState.pendingMemoryIds, [memoryB.id], "failed record stays pending");
    assert.equal(dreamState.lastSuccessAt, 0, "partial failure must not advance lastSuccessAt");

    // Round 2: Provider receives ONLY B; A's facts/revision/calls unchanged.
    bValid = true;
    const aCallsBefore = calls.filter((title) => title === "部分失败记忆甲").length;
    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    assert.deepEqual(run2!.processedMemoryIds, [memoryB.id]);
    assert.deepEqual(run2!.failedMemoryIds, []);
    assert.equal(
      calls.filter((title) => title === "部分失败记忆甲").length,
      aCallsBefore,
      "already-succeeded record must never be re-sent to the Provider"
    );
    const factsA2 = await system.listSecondaryForParent(memoryA.id);
    assert.equal(factsA2.length, 1);
    assert.equal(factsA2[0].id, factsA1[0].id, "A's fact id untouched");
    assert.equal(factsA2[0].revision, factsA1[0].revision, "A's fact revision untouched");
    assert.equal(factsA2[0].confidence, factsA1[0].confidence, "A's fact confidence untouched");
    assert.equal((await system.listSecondaryForParent(memoryB.id)).length, 1);
    dreamState = await readJson(fixture.repository.layout.dreamState) as {
      pendingMemoryIds: readonly string[];
      lastSuccessAt: number;
    };
    assert.deepEqual(dreamState.pendingMemoryIds, [], "queue empties once B succeeds");
    assert.ok(dreamState.lastSuccessAt > 0, "zero-failure round advances lastSuccessAt");
  });
  console.log("PASS cognitive: partial failure retries only failed records");
}

// ---------------------------------------------------------------------------
// R3-4. Recall budget measures the real final payload once (§4)
// ---------------------------------------------------------------------------

async function scenarioRecallBudgetFinalPayloadOnce(): Promise<void> {
  const factContent = "用于预算验证的二级事实正文，必须足够长以主导包络开销。".repeat(3);
  const make = (suffix: string): PersonalMemoryTurnCatalogCandidate => Object.freeze({
    id: `mem_budget_${suffix}`,
    kind: "fact",
    status: "current",
    title: `预算记忆${suffix}`,
    recallWhen: "相关话题出现时",
    summary: `预算摘要${suffix}`,
    date: "2026-08-20",
    basis: "explicit",
    sourceSummary: "",
    score: 1,
    secondaryMatches: Object.freeze([Object.freeze({
      id: `sec_budget_${suffix}`,
      parentId: `mem_budget_${suffix}`,
      title: `预算事实${suffix}`,
      content: factContent,
      recallWhen: "相关话题出现时",
      matchTerms: [`预算${suffix}`],
      relation: "instance" as const,
      basis: "llm_inferred" as const
    })])
  });
  const a = make("甲");
  const b = make("乙");

  // Envelope/wrapper overhead is counted ONCE across candidates.
  const together = measureFinalInjectionTokens([a, b]);
  const separate = measureFinalInjectionTokens([a]) + measureFinalInjectionTokens([b]);
  assert.ok(together < separate, "wrapper overhead must be counted once, not per candidate");

  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: memory.title.includes("甲") ? "预算事实甲" : "预算事实乙",
        content: factContent,
        recallWhen: "相关话题出现时",
        matchTerms: [memory.title.includes("甲") ? "预算甲" : "预算乙"],
        relation: "instance",
        supportLevel: "direct",
        reason: "测试",
        evidence: "记忆直接陈述"
      }]
    })));
    await createMemory(fixture, { title: "预算记忆甲", content: "预算记忆甲的内容。预算甲" });
    await createMemory(fixture, { title: "预算记忆乙", content: "预算记忆乙的内容。预算乙" });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();

    // Index-only fields must never leak into recall match views.
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "预算甲 预算乙"
    }, fixture.runtime());
    assert.ok(snapshot.search);
    assert.ok(snapshot.search!.items.length >= 2);
    for (const item of snapshot.search!.items) {
      for (const match of item.secondaryMatches ?? []) {
        assert.ok(!("routeTokens" in match), "match views must not carry routeTokens");
        assert.ok(!("contentTokens" in match), "match views must not carry contentTokens");
      }
    }

    const harness = new PersonalMemoryRecallHarness(fixture.repository);
    const common = {
      memoryMode: "normal" as const,
      query: "预算甲 预算乙",
      vaultId: fixture.vaultId,
      conversationId: "conversation-budget-r3",
      piSessionId: "pi-budget-r3",
      productRunId: "run-budget-r3"
    };
    const plenty = await harness.prepareTurnContext({ ...common, tokenBudget: 20_000 });
    assert.equal(plenty.recall?.injected, 2);

    // Budget = the exact cumulative final payload → both candidates admitted
    // (per-candidate wrapper double-counting would reject the second one).
    const exactBudget = measureFinalInjectionTokens(plenty.recall!.candidates);
    assert.ok(exactBudget < separate, "cumulative measurement must beat the old over-estimate");
    const exact = await harness.prepareTurnContext({ ...common, tokenBudget: exactBudget });
    assert.equal(exact.recall?.injected, 2,
      "cumulative payload at the exact budget must admit both candidates");

    // The shared serializer's final payload really fits the budget.
    const secondaryFacts = [];
    for (const candidate of exact.recall!.candidates) {
      for (const view of candidate.secondaryMatches ?? []) {
        secondaryFacts.push({ parentId: candidate.id, parentTitle: candidate.title, fact: view });
      }
    }
    const payload = serializeRecallInjection({
      candidates: exact.recall!.candidates,
      secondaryFacts
    });
    assert.ok(estimatePiContextTokens(payload).tokens <= exactBudget,
      "serialized final payload must stay within the measured budget");
  });
  console.log("PASS cognitive: recall budget measures the real final payload once");
}

// ---------------------------------------------------------------------------
// R3-5. Observed profile aggregation by stable profileKey (§5)
// ---------------------------------------------------------------------------

async function scenarioObservedProfileKeyAggregation(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const texts: Record<string, string> = {
      散步记忆一: "用户每天早晨都会去公园散步",
      散步记忆二: "用户有清晨散步的习惯",
      散步记忆三: "用户喜欢在清晨散步"
    };
    const prompts: string[] = [];
    const llm: DreamLlmPort = {
      call: async (input) => {
        prompts.push(input.systemPrompt);
        const parsed = JSON.parse(input.userPrompt) as { memory: { title: string } };
        return JSON.stringify({
          ...EMPTY_DREAM_OUTPUT,
          userProfileItems: [{
            section: "preference",
            profileKey: "清晨散步",
            text: texts[parsed.memory.title] ?? "用户喜欢清晨散步"
          }]
        });
      }
    };
    const system = await createSystem(fixture, () => llm);
    for (const title of Object.keys(texts)) {
      await createMemory(fixture, {
        title,
        content: `${title}的内容：用户谈到自己的散步习惯。`,
        kind: "view",
        basis: "observed"
      });
    }
    await system.settleDreamEnqueue();
    await system.forceDreamRun();

    const raw = await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>;
    const profileState = parseUserProfileState(raw);
    assert.ok(profileState);
    const currentItems = profileState!.items.filter((item) => item.status === "current");
    assert.equal(currentItems.length, 1, "three near-synonym observed texts must merge into ONE item");
    assert.equal(currentItems[0].sourceMemoryIds.length, 3, "all three sources must accumulate");
    assert.equal(currentItems[0].profileKey, "清晨散步");
    assert.ok(!prompts[0].includes("已有 profileKey"), "first memory sees no existing keys");
    assert.ok(prompts[1].includes("清晨散步"),
      "later memories in the same round must be offered keys created earlier");

    // USER.md renders the merged observed item (threshold 3 reached).
    const userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(userMd.includes(currentItems[0].text), "merged item must reach USER.md");

    // Legacy state without profileKey still parses with a fallback key.
    const legacy = parseUserProfileState({
      schema: "echoink.user-profile.v1",
      revision: 2,
      items: [{ id: "p_legacy", section: "preference", text: "用户喜欢手冲咖啡" }],
      processedSources: [],
      updatedAt: 5
    });
    assert.ok(legacy);
    assert.ok(legacy!.items[0].profileKey.length > 0, "legacy items get a fallback key");
    assert.equal(legacy!.items[0].text, "用户喜欢手冲咖啡", "legacy text preserved");
  });
  console.log("PASS cognitive: observed profile aggregates near-synonyms by profileKey");
}

// ---------------------------------------------------------------------------
// R3-6. User-edited low-confidence facts stay recallable (§6)
// ---------------------------------------------------------------------------

async function scenarioUserEditedLowConfidenceRecallable(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: "丙类关联事实",
        content: "用于验证用户编辑后的低置信事实召回。",
        recallWhen: "相关话题出现时",
        matchTerms: ["丙类关联"],
        relation: "associated",
        supportLevel: "direct",
        reason: "测试",
        evidence: "记忆直接陈述"
      }]
    })));
    const memory = await createMemory(fixture, {
      title: "丙类记忆",
      content: "用户提到丙类相关内容。"
    });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    const fact = (await system.listSecondaryForParent(memory.id))[0];
    // direct(0.85) × explicit(1.00) + associated(−0.15) = 0.70.
    assert.ok(Math.abs(fact.confidence - 0.70) < 1e-9);

    // One decay period → below the 0.60 index threshold.
    fixture.advance(30 * DAY_MS + 1_000);
    await system.forceDreamRun();
    const decayedFact = (await system.listSecondaryForParent(memory.id))[0];
    assert.ok(Math.abs(decayedFact.confidence - 0.56) < 1e-9);
    assert.equal(decayedFact.status, "current");
    let index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { id: string }[];
    };
    assert.ok(!index.secondaryCatalog.some((entry) => entry.id === fact.id),
      "decayed fact must leave the search index");

    // User edit → immediately recallable again (index rebuilt in the same txn).
    await system.updateSecondaryFact(fact.id, { content: "用户确认丙类关联。" });
    const edited = (await system.listSecondaryForParent(memory.id))[0];
    assert.equal(edited.basis, "user_edited_inference");
    index = await readJson(fixture.repository.layout.searchIndex) as {
      secondaryCatalog: readonly { id: string }[];
    };
    assert.ok(index.secondaryCatalog.some((entry) => entry.id === fact.id),
      "user-edited fact must re-enter the index immediately, regardless of confidence");
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "丙类关联"
    }, fixture.runtime());
    assert.ok(snapshot.search);
    const match = (snapshot.search!.items[0]?.secondaryMatches ?? [])[0];
    assert.ok(match, "edited low-confidence fact must be recallable immediately");
    assert.equal(match!.basis, "user_edited_inference");

    // Still recallable after a rebuild from disk.
    await createSystem(fixture, () => null);
    const snapshot2 = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "丙类关联"
    }, fixture.runtime());
    assert.equal((snapshot2.search!.items[0]?.secondaryMatches ?? []).length, 1,
      "recall survives restart");

    // Survives multiple dream rounds with zero further decay.
    for (let round = 0; round < 3; round += 1) {
      fixture.advance(30 * DAY_MS + 1_000);
      await system.forceDreamRun();
    }
    const stable = (await system.listSecondaryForParent(memory.id))[0];
    assert.ok(Math.abs(stable.confidence - 0.56) < 1e-9,
      "user_edited_inference never decays further");
    assert.equal(stable.status, "current", "user_edited_inference never auto-disables");
    assert.equal(stable.basis, "user_edited_inference");
  });
  console.log("PASS cognitive: user-edited low-confidence facts stay recallable");
}

// ---------------------------------------------------------------------------
// R3-7. Decay revision discipline + no-op writes (§7)
// ---------------------------------------------------------------------------

async function scenarioDecayRevisionAndNoOpWrites(): Promise<void> {
  const now = 1_800_000_000_000;
  const make = (confidence: number): ReturnType<typeof createSecondaryRecord> =>
    createSecondaryRecord({
      parentId: "mem_decay_parent",
      title: "衰减事实",
      content: "用于验证衰减 revision 纪律。",
      recallWhen: "相关话题出现时",
      matchTerms: ["衰减验证"],
      relation: "instance",
      reason: "测试",
      supportLevel: "strong_inference",
      evidence: "由记忆推导",
      basis: "llm_inferred",
      confidence,
      sourceMemoryRevision: 1,
      now
    });

  const base = make(0.8);
  const d1 = applySecondaryDecay(base, now + 30 * DAY_MS + 1_000);
  assert.equal(d1.decayed, true);
  assert.equal(d1.record.revision, base.revision + 1, "real decay bumps revision exactly once");
  assert.ok(d1.record.lastDecayAt !== null);

  // Same-period repeat is a pure no-op (no confidence/lastDecayAt/updatedAt/revision change).
  const d2 = applySecondaryDecay(d1.record, now + 30 * DAY_MS + 2_000);
  assert.equal(d2.decayed, false);
  assert.equal(d2.record, d1.record, "same-period re-run must return the identical record");

  // Multi-period catch-up = ONE persisted change, ONE revision bump.
  const d3 = applySecondaryDecay(base, now + 90 * DAY_MS + 3_000);
  assert.equal(d3.decayed, true);
  assert.equal(d3.record.revision, base.revision + 1, "multi-period catch-up is a single revision bump");
  assert.ok(Math.abs(d3.record.confidence - 0.8 * Math.pow(0.8, 3)) < 1e-9);

  // Auto-disable shares the same single revision change.
  const weak = make(0.12);
  const w1 = applySecondaryDecay(weak, now + 30 * DAY_MS + 1_000);
  assert.equal(w1.autoDisabled, true);
  assert.equal(w1.record.status, "disabled");
  assert.equal(w1.record.disabledReason, "low_confidence");
  assert.equal(w1.record.revision, weak.revision + 1,
    "decay + auto-disable land in one revision change");

  // System level: the second run in the same period writes nothing.
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: "衰减系统事实",
        content: "用于验证系统级衰减写盘纪律。",
        recallWhen: "相关话题出现时",
        matchTerms: ["衰减系统"],
        relation: "instance",
        supportLevel: "strong_inference",
        reason: "测试",
        evidence: "由记忆推导"
      }]
    })));
    const memory = await createMemory(fixture, { title: "衰减系统记忆", content: "衰减系统记忆内容。" });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();

    fixture.advance(30 * DAY_MS + 1_000);
    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    assert.equal(run1!.decayed, 1);
    const factAfterRun1 = (await system.listSecondaryForParent(memory.id))[0];
    const filePath = `${fixture.vaultPath}/.echoink/${factAfterRun1.file}`;
    const contentAfterRun1 = await readFile(filePath, "utf8");

    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    assert.equal(run2!.decayed, 0, "same-period repeat must decay nothing");
    assert.equal(await readFile(filePath, "utf8"), contentAfterRun1,
      "no file rewrite for a no-op decay round");
    const factAfterRun2 = (await system.listSecondaryForParent(memory.id))[0];
    assert.equal(factAfterRun2.revision, factAfterRun1.revision);
    assert.equal(factAfterRun2.confidence, factAfterRun1.confidence);
    assert.equal(factAfterRun2.lastDecayAt, factAfterRun1.lastDecayAt);
    assert.equal(factAfterRun2.updatedAt, factAfterRun1.updatedAt);
  });
  console.log("PASS cognitive: decay revision discipline + no-op writes");
}

// ---------------------------------------------------------------------------
// R3-8. Secondary dedupe: title OR term set, user-edited precedence (§8)
// ---------------------------------------------------------------------------

async function scenarioSecondaryDedupeTitleOrTerms(): Promise<void> {
  const now = 1_800_000_000_000;
  const makeExisting = (confidence: number, basis: "llm_inferred" | "user_edited_inference") =>
    createSecondaryRecord({
      parentId: "mem_dedupe_parent",
      title: "手冲咖啡",
      content: "既有二级事实。",
      recallWhen: "相关话题出现时",
      matchTerms: ["咖啡豆", "滤纸"],
      relation: "instance",
      reason: "测试",
      supportLevel: "strong_inference",
      evidence: "由记忆推导",
      basis,
      confidence,
      sourceMemoryRevision: 1,
      now
    });
  const candidate = (
    title: string,
    matchTerms: readonly string[],
    supportLevel: SecondaryFactCandidate["supportLevel"] = "direct"
  ): SecondaryFactCandidate => Object.freeze({
    title,
    content: "新候选内容。",
    recallWhen: "相关话题出现时",
    matchTerms,
    relation: "instance" as const,
    supportLevel,
    reason: "测试",
    evidence: "记忆直接陈述"
  });
  const reconcile = (
    existing: readonly ReturnType<typeof makeExisting>[],
    candidates: readonly SecondaryFactCandidate[]
  ) => reconcileSecondaryForParent({
    parentId: "mem_dedupe_parent",
    parentBasis: "explicit",
    parentRevision: 2,
    existing,
    candidates,
    now: now + 1_000
  });

  // 1) Same title, different terms, higher candidate confidence → replace.
  let result = reconcile([makeExisting(0.75, "llm_inferred")], [candidate("手冲咖啡", ["手冲", "器具"])]);
  assert.equal(result.records.filter((record) => record.status === "current").length, 1);
  assert.equal(result.factsCreated, 1);
  assert.equal(
    result.records.filter((record) => record.disabledReason === "redream_replaced").length,
    1
  );

  // 2) Same title, existing confidence higher → keep old record untouched.
  const boosted = applySecondaryHit(makeExisting(0.75, "llm_inferred"), now + 500);
  assert.ok(boosted.confidence >= 0.80);
  result = reconcile([boosted], [candidate("手冲咖啡", ["手冲", "器具"], "strong_inference")]);
  let current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, boosted.id, "kept record reuses the old id");
  assert.equal(current[0].hitCount, boosted.hitCount, "hitCount unchanged");
  assert.equal(current[0].lastHitAt, boosted.lastHitAt, "lastHitAt unchanged");
  assert.equal(current[0].revision, boosted.revision, "kept record is not rewritten");
  assert.ok(!result.fileChanges.some((change) => change.relativePath === boosted.file),
    "kept record causes no file write");
  assert.equal(result.factsCreated, 0);
  assert.equal(result.factsRetired, 0);

  // 3) Different title, same non-empty term set → duplicate as well.
  result = reconcile([boosted], [candidate("清晨手冲", ["咖啡豆", "滤纸"], "strong_inference")]);
  current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, boosted.id, "same term set dedupes despite different title");
  assert.equal(result.factsCreated, 0);

  // 4) user_edited_inference always beats LLM candidates (title or terms).
  const userFact = makeExisting(0.62, "user_edited_inference");
  result = reconcile([userFact], [candidate("手冲咖啡", ["完全不同的词"])]);
  current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, userFact.id, "same-title candidate loses to user edit");
  assert.equal(current[0].basis, "user_edited_inference");
  assert.equal(result.factsCreated, 0);
  result = reconcile([userFact], [candidate("另一个标题", ["咖啡豆", "滤纸"])]);
  current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, userFact.id, "same-term candidate loses to user edit");
  assert.equal(result.factsCreated, 0);
  console.log("PASS cognitive: secondary dedupe by title OR term set with user-edit precedence");
}


// ---------------------------------------------------------------------------
// R4. Agent identity (名称 + 头像)：首次命名单事务、改名、重置保留、做梦不改
// ---------------------------------------------------------------------------

const TEST_AVATAR_DATA_URL = `data:image/png;base64,${"QUJD".repeat(24)}`;
const TEST_CUSTOM_AVATAR = Object.freeze({
  kind: "custom",
  mimeType: "image/png",
  dataUrl: TEST_AVATAR_DATA_URL,
  width: 256,
  height: 256
}) as AgentAvatarState;

async function scenarioFirstTemplateRequiresIdentity(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };
    const agentBefore = await readFile(fixture.repository.layout.agent, "utf8");

    await assert.rejects(
      system.selectPersonalityTemplate("executor"),
      /agent_identity_required/u,
      "first template selection without identity must be rejected"
    );

    // 零写入：人格、身份、AGENT.md、manifest 全部保持原样。
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision);
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), agentBefore);
    await assert.rejects(readFile(fixture.repository.layout.personalityState, "utf8"));
    await assert.rejects(readFile(fixture.repository.layout.agentIdentity, "utf8"),
      "cancelled naming must not create agent-identity.json");
    const identity = await system.readAgentIdentity();
    assert.equal(identity.revision, 0);
    assert.equal(identity.displayName, "EchoInk");
    assert.equal(identity.avatar.kind, "default");
  });
  console.log("PASS cognitive: first template selection requires identity (zero writes otherwise)");
}

async function scenarioFirstTemplateIdentitySingleTransaction(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    // No Provider at all: naming + template must be a purely local transaction.
    const system = await createSystem(fixture, () => null);
    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };

    const result = await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "  小墨  ", avatar: { kind: "default" } }
    });

    // 只提交一次 Repository 事务：manifest revision 恰好 +1。
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision + 1,
      "template + identity + AGENT.md must commit in ONE transaction");

    // 人格、identity JSON 与 AGENT.md 同时成功。
    assert.equal(result.state.templateId, "executor");
    assert.equal(result.identity.displayName, "小墨", "display name is trimmed");
    assert.equal(result.identity.revision, 1);
    assert.equal(result.identity.avatar.kind, "default");
    const identityOnDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      revision: number; displayName: string; avatar: { kind: string };
    };
    assert.equal(identityOnDisk.displayName, "小墨");
    assert.equal(identityOnDisk.revision, 1);
    assert.equal(identityOnDisk.avatar.kind, "default");

    // AGENT.md 包含名称，但绝不包含头像 Data URL / presetId / 图片路径。
    assert.ok(result.agent.includes("当前名称：小墨"));
    assert.ok(!result.agent.includes("data:image"));
    assert.ok(!result.agent.includes("presetId"));
    const agentOnDisk = await readFile(fixture.repository.layout.agent, "utf8");
    assert.equal(agentOnDisk, result.agent);

    // 缓存立即可读（设置页与对话区无需重启）。
    assert.equal(system.currentAgentIdentity().displayName, "小墨");
  });
  console.log("PASS cognitive: first template + naming commits once without Provider");
}

async function scenarioIdentityTransactionFailureKeepsOld(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    // 先正常完成首次命名，得到一份旧版本基线。
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "旧名字", avatar: { kind: "default" } }
    });
    const identityBefore = await readFile(fixture.repository.layout.agentIdentity, "utf8");
    const agentBefore = await readFile(fixture.repository.layout.agent, "utf8");
    const personalityBefore = await readFile(fixture.repository.layout.personalityState, "utf8");

    // 模拟事务失败：把 identity 目标路径占成目录，事务写入阶段必然抛错回滚。
    const { mkdirSync, rmSync } = await import("node:fs");
    rmSync(fixture.repository.layout.agentIdentity);
    mkdirSync(fixture.repository.layout.agentIdentity, { recursive: true });
    await assert.rejects(
      system.updateAgentIdentity({ displayName: "新名字", avatar: { kind: "default" } })
    );
    rmSync(fixture.repository.layout.agentIdentity, { recursive: true, force: true });

    // 失败后：身份、AGENT.md、人格全部保持旧版本。
    assert.equal(system.currentAgentIdentity().displayName, "旧名字",
      "failed transaction must keep the cached identity");
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), agentBefore);
    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), personalityBefore);
    assert.equal((await system.readAgentIdentity()).displayName, "旧名字");
    void identityBefore;
  });
  console.log("PASS cognitive: failed identity transaction keeps old identity and AGENT.md");
}

async function scenarioRenameUpdatesAgentSameRound(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: { kind: "default" } }
    });
    const personalityBefore = await readFile(fixture.repository.layout.personalityState, "utf8");

    const result = await system.updateAgentIdentity({
      displayName: "阿澈",
      avatar: { kind: "default" }
    });

    assert.equal(result.identity.revision, 2, "rename bumps identity revision");
    assert.equal(result.identity.displayName, "阿澈");
    assert.ok(result.agent.includes("当前名称：阿澈"));
    assert.ok(!result.agent.includes("当前名称：小墨"));
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), result.agent,
      "AGENT.md updates in the same round as the rename");
    // 改名不影响人格状态与 dreaming 进度。
    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), personalityBefore);
    assert.equal(system.currentAgentIdentity().displayName, "阿澈");

    // 无变化保存：不增加 revision、不创建事务。
    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };
    const noop = await system.updateAgentIdentity({ displayName: "阿澈", avatar: { kind: "default" } });
    assert.equal(noop.identity.revision, 2, "no-op save must not bump identity revision");
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision,
      "no-op save must not create a transaction");
  });
  console.log("PASS cognitive: rename bumps identity revision and rewrites AGENT.md same round");
}

async function scenarioAvatarOnlyChangeKeepsAgentAndPersonality(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: { kind: "default" } }
    });
    const agentBefore = await readFile(fixture.repository.layout.agent, "utf8");
    const personalityBefore = await readFile(fixture.repository.layout.personalityState, "utf8");
    const readDream = () => readFile(fixture.repository.layout.dreamState, "utf8").catch(() => null);
    const dreamBefore = await readDream();

    const result = await system.updateAgentIdentity({
      displayName: "小墨",
      avatar: TEST_CUSTOM_AVATAR
    });

    assert.equal(result.identity.revision, 2);
    assert.equal(result.identity.avatar.kind, "custom");
    // 头像变化不改 AGENT.md、trait、learnedRequirements、processedSources、DreamState。
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), agentBefore);
    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), personalityBefore);
    assert.equal(await readDream(), dreamBefore);
    assert.ok(!agentBefore.includes("data:image"));
    const identityOnDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      avatar: { kind: string; dataUrl?: string };
    };
    assert.equal(identityOnDisk.avatar.kind, "custom");
    assert.equal(identityOnDisk.avatar.dataUrl, TEST_AVATAR_DATA_URL);
  });
  console.log("PASS cognitive: avatar-only change leaves AGENT.md, personality and dream state untouched");
}

async function scenarioResetKeepsIdentity(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: TEST_CUSTOM_AVATAR }
    });

    const result = await system.selectPersonalityTemplate("companion", { reset: true });

    assert.equal(result.state.templateId, "companion");
    assert.equal(result.identity.displayName, "小墨", "reset keeps the display name");
    assert.equal(result.identity.revision, 1, "reset must not bump identity revision");
    assert.equal(result.identity.avatar.kind, "custom", "reset keeps the avatar");
    assert.ok(result.agent.includes("当前名称：小墨"));
    const identityOnDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      revision: number; displayName: string;
    };
    assert.equal(identityOnDisk.revision, 1);
    assert.equal(identityOnDisk.displayName, "小墨");
  });
  console.log("PASS cognitive: personality reset keeps name, avatar and identity revision");
}

async function scenarioDreamPreservesIdentity(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      personalitySignals: [{
        dimension: "tempo",
        direction: "decrease",
        strength: 0.7,
        evidence: "记忆显示用户偏好简短回复"
      }]
    })));
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: TEST_CUSTOM_AVATAR }
    });
    const identityBefore = await readFile(fixture.repository.layout.agentIdentity, "utf8");
    await createMemory(fixture, {
      title: "偏好简短回复",
      content: "用户明确要求以后回复都保持简短。"
    });
    await system.settleDreamEnqueue();
    const run = await system.forceDreamRun();
    assert.ok(run);
    assert.equal(run!.committed, true);

    // 做梦重渲染 AGENT.md 时读取当前身份：名称不丢、不被改回 EchoInk。
    const agentAfter = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agentAfter.includes("当前名称：小墨"), "dream must keep the custom name in AGENT.md");
    assert.ok(!agentAfter.includes("当前名称：EchoInk"));
    assert.ok(!agentAfter.includes("data:image"), "avatar data must never reach AGENT.md");
    // 做梦无权修改身份：文件与 revision 均不变。
    assert.equal(await readFile(fixture.repository.layout.agentIdentity, "utf8"), identityBefore);
    assert.equal(system.currentAgentIdentity().revision, 1);
  });
  console.log("PASS cognitive: dreaming preserves agent name and never writes identity");
}

async function scenarioIdentitySurvivesRestart(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: TEST_CUSTOM_AVATAR }
    });

    // 插件重启 = 重建 CognitiveSystem。
    const restarted = await createSystem(fixture, () => null);
    const identity = await restarted.readAgentIdentity();
    assert.equal(identity.displayName, "小墨");
    assert.equal(identity.avatar.kind, "custom");
    assert.equal((identity.avatar as { dataUrl: string }).dataUrl, TEST_AVATAR_DATA_URL);
    // create 已预热缓存：同步快照同样可用。
    assert.equal(restarted.currentAgentIdentity().displayName, "小墨");
  });
  console.log("PASS cognitive: agent identity survives plugin restart");
}

async function scenarioLegacyVaultIdentityFallback(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    // 旧 Vault 没有 identity 文件：回退 EchoInk/default，且不创建文件。
    const identity = await system.readAgentIdentity();
    assert.equal(identity.displayName, "EchoInk");
    assert.equal(identity.avatar.kind, "default");
    assert.equal(identity.revision, 0);
    await assert.rejects(readFile(fixture.repository.layout.agentIdentity, "utf8"),
      "reading identity must not auto-create the file");
  });
  console.log("PASS cognitive: legacy vault without identity falls back without writing");
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
  await scenarioDreamStateRestartMergesEnqueues();
  await scenarioSecondaryCacheImmediateAndConsistent();
  await scenarioPartialFailureRedreamsOnlyFailed();
  await scenarioRecallBudgetFinalPayloadOnce();
  await scenarioObservedProfileKeyAggregation();
  await scenarioUserEditedLowConfidenceRecallable();
  await scenarioDecayRevisionAndNoOpWrites();
  await scenarioSecondaryDedupeTitleOrTerms();
  await scenarioFirstTemplateRequiresIdentity();
  await scenarioFirstTemplateIdentitySingleTransaction();
  await scenarioIdentityTransactionFailureKeepsOld();
  await scenarioRenameUpdatesAgentSameRound();
  await scenarioAvatarOnlyChangeKeepsAgentAndPersonality();
  await scenarioResetKeepsIdentity();
  await scenarioDreamPreservesIdentity();
  await scenarioIdentitySurvivesRestart();
  await scenarioLegacyVaultIdentityFallback();
}
