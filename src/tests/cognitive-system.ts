/**
 * cognitive-system.ts — main-chain regression tests:
 * 人格 / 做梦 / 二级事实 / Recall / 来源失效回收 / 重置 / 门控 / 事务语义。
 *
 * The test Vault has no Provider API key, so dreaming is verified with fake
 * LLM ports; the real Provider path stays unverified by design.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import path from "node:path";
import {
  buildDreamPrompts,
  parseDreamOutput,
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
  serializeSecondaryRecord,
  type SecondaryFactCandidate
} from "../harness/memory/secondary-memory-store";
import {
  measureFinalInjectionTokens,
  measurePrimaryInjectionTokens,
  PersonalMemoryRecallHarness,
  serializeRecallBlocks
} from "../harness/memory/personal-memory-recall-harness";
import { estimatePiContextTokens } from "../harness/pi-native/pi-context-budget";
import type { PersonalMemoryTurnCatalogCandidate } from "../harness/memory/personal-memory-repository";
import {
  applyDreamPersonalityUpdate,
  applyTemplateToState,
  currentPersonalityScores,
  emptyPersonalityState,
  PERSONALITY_HISTORY_PER_DIMENSION_CAP,
  parsePersonalityState,
  personalityStateJson,
  PersonalityStateStore,
  reconcilePersonalitySources,
  revokeReprocessedPersonalitySources,
  type DreamPersonalityInput,
  type PersonalityState,
  type PersonalityTraitRecord
} from "../harness/memory/personality-state";
import {
  applyDreamProfileUpdate,
  emptyUserProfileState,
  parseUserProfileState,
  profileKeyPromptCatalog,
  PROFILE_KEY_PROMPT_CAP,
  USER_PROFILE_SLOTS,
  USER_OBSERVED_MIN_SOURCES,
  userProfileStateJson,
  type UserProfileState
} from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import {
  getPersonalityTemplate,
  isTraitDimension,
  PERSONALITY_TEMPLATES,
  renderTraitLine,
  TRAIT_DIMENSIONS,
  TRAIT_DIMENSION_META,
  traitBehaviorBand
} from "../harness/memory/personality-templates";
import {
  defaultUserProfile,
  PersonalMemoryAccessError,
  PersonalMemoryRepository
} from "../harness/memory/personal-memory-repository";
import {
  lexicalTokens,
  scorePrimaryEntry,
  scoreSecondaryEntry
} from "../harness/memory/search-index-v3";
import {
  PERSONALITY_STATE_SCHEMA,
  SECONDARY_CONTENT_MAX_CHARS,
  SECONDARY_MAX_PER_PARENT,
  SECONDARY_TITLE_MAX_CHARS,
  USER_PROFILE_STATE_SCHEMA,
  type PersonalMemoryRecord,
  type SecondaryMatchView
} from "../harness/memory/personal-memory-contracts";
import {
  AGENT_IDENTITY_STATE_SCHEMA,
  AgentIdentityStateStore,
  agentIdentityStateJson,
  type AgentAvatarState
} from "../harness/memory/agent-identity-state";
import { DreamStateStore } from "../harness/memory/dream-state";
import { SecondaryMemoryStore } from "../harness/memory/secondary-memory-store";
import { migratePersonalityV1ToV2 } from "../harness/memory/cognitive-system";
import { cognitivePathExists } from "../harness/memory/cognitive-file-utils";

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
      dimension: "sharpness",
      direction: "decrease",
      strength: 0.7,
      evidence: "用户希望语气温和一点"
    }],
    agentRequirements: ["回复保持简短直接"],
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.interests",
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
  input: {
    title: string;
    content: string;
    kind?: string;
    basis?: string;
    recallWhen?: string;
    scope?: string;
  }
): Promise<PersonalMemoryRecord> {
  const result = await fixture.repository.write({
    operation: "create",
    kind: input.kind ?? "fact",
    title: input.title,
    content: input.content,
    recallWhen: input.recallWhen ?? "相关话题出现时",
    basis: input.basis ?? "explicit",
    ...(input.scope ? { scope: input.scope } : {})
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
    for (const dimension of ["sharpness", "dominance", "rigor", "structure", "boldness", "creativity"] as const) {
      assert.equal(explicit[dimension]?.score, template.scores[dimension]);
    }
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /执行人|执行/);
    const after = await readJson(fixture.repository.layout.manifest);
    assert.equal(after.revision, (before.revision as number) + 1);
    const scores = currentPersonalityScores(result.state);
    assert.equal(scores.sharpness, template.scores.sharpness);
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
    const explicit = result.state.explicit.sharpness!;
    assert.equal(explicit.score, template.scores.sharpness);

    // Old observed + learnedRequirements superseded with reason=reset, history kept.
    for (const requirement of result.state.learnedRequirements) {
      assert.equal(requirement.status, "superseded");
      assert.equal(requirement.reason, "reset");
    }
    for (const dimension of ["sharpness", "dominance", "rigor", "structure", "boldness", "creativity"] as const) {
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
      candidate.dimension === "sharpness" && candidate.direction === "decrease"
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
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "shared-user/USER.md"
    });

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
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "agents/echoink/AGENT.md"
    });
    await writeFile(fixture.repository.layout.user, customUser);
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "shared-user/USER.md"
    });

    const system = await createSystem(fixture, () => fakeDreamLlm(() => JSON.stringify({
      ...EMPTY_DREAM_OUTPUT,
      userProfileItems: [{ section: "identity", profileKey: "identity.role", text: "用户是一名长期远程工作的设计师" }]
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
        return { ...EMPTY_DREAM_OUTPUT, userProfileItems: [{ section: "preference", profileKey: "preference.interests", text: "用户喜欢手冲咖啡" }] };
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
      if (memory.title.includes("温和")) {
        return {
          ...EMPTY_DREAM_OUTPUT,
          personalitySignals: [{
            dimension: "sharpness", direction: "decrease", strength: 0.8, evidence: memory.title
          }]
        };
      }
      return EMPTY_DREAM_OUTPUT;
    }));
    await system.selectPersonalityTemplate("advisor", { // explicit sharpness = 0.50
      initialIdentity: { displayName: "小问", avatar: { kind: "default" } }
    });

    const sources: PersonalMemoryRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      sources.push(await createMemory(fixture, {
        title: `用户希望语气温和 ${index + 1}`,
        content: `第 ${index + 1} 条：用户多次要求说话温和一点，不要太冲。`,
        kind: "view",
        basis: "observed"
      }));
    }
    await system.forceDreamRun();

    const evolved = await system.readPersonalityState();
    const observedSharpness = evolved.observed.sharpness;
    assert.ok(observedSharpness, "3 consistent observed sources must create an observed trait");
    assert.ok(observedSharpness!.score < 0.50, "sharpness decrease lowers the trait score");
    const evolvedScores = currentPersonalityScores(evolved);
    assert.ok(evolvedScores.sharpness < 0.50);

    // All evidence forgotten → observed must fall back to explicit baseline.
    for (const record of sources) {
      await fixture.repository.forgetFromUserControl(record.id, "测试");
    }
    await system.forceDreamRun();
    const fallen = await system.readPersonalityState();
    assert.equal(fallen.observed.sharpness, null);
    assert.equal(currentPersonalityScores(fallen).sharpness, 0.50);
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /锋利度/);
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
  for (const dimension of TRAIT_DIMENSIONS) {
    const meta = TRAIT_DIMENSION_META[dimension];
    assert.ok(systemPrompt.includes(`${dimension}（${meta.labelZh}）`),
      `prompt must explain ${dimension} meaning`);
    assert.ok(systemPrompt.includes(meta.summaryZh),
      `prompt must use meta summary for ${dimension}`);
  }
  // 单向语义：increase=更多该特质，decrease=更少该特质；不再出现左右极。
  assert.ok(systemPrompt.includes("increase=该特质表现更多"));
  assert.ok(systemPrompt.includes("decrease=该特质表现更少"));
  assert.ok(!systemPrompt.includes("左极") && !systemPrompt.includes("右极"));
  assert.ok(!systemPrompt.includes("偏左") && !systemPrompt.includes("偏右"));
  // 人格信号与长期行为要求的区分必须写进 Prompt。
  assert.ok(systemPrompt.includes("只进入 agentRequirements"));
  assert.ok(systemPrompt.includes("不得从以下内容推断人格"));
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
    profileKey: "preference.workflow",
    basis: "observed_memory" as const, status: "current" as const,
    sourceMemoryIds: Object.freeze(Array.from({ length: sources }, (_, i) => `mem_${i}`)),
    revision: 1
  });
  const stateWith = (sources: number): UserProfileState => Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA, revision: 1,
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

  const oneCandidate = parseDreamOutput(JSON.stringify({
    ...EMPTY_DREAM_OUTPUT,
    userProfileItems: [
      { section: "preference", profileKey: "preference.language", text: "用户偏好中文" },
      { section: "preference", profileKey: "preference.tone", text: "用户偏好直接表达" }
    ]
  }));
  assert.equal(oneCandidate?.profileItems.length, 1,
    "one primary Memory response yields at most one profile candidate");
  const oversizedCandidate = parseDreamOutput(JSON.stringify({
    ...EMPTY_DREAM_OUTPUT,
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.language",
      text: "甲".repeat(121)
    }]
  }));
  assert.equal(oversizedCandidate?.profileItems.length, 0,
    "profile text over 120 chars is rejected rather than truncated");

  const fullProjectionState: UserProfileState = Object.freeze({
    ...emptyUserProfileState(1),
    revision: 2,
    items: Object.freeze(USER_PROFILE_SLOTS.map((slot, index) => Object.freeze({
      id: `profile_projection_${index}`,
      section: slot.section,
      profileKey: slot.profileKey,
      text: `完整条目${index}-` + "甲".repeat(90),
      basis: "explicit_memory" as const,
      status: "current" as const,
      sourceMemoryIds: Object.freeze([`mem_projection_${index}`]),
      revision: index + 1,
      updatedAt: index + 1
    })))
  });
  const boundedProjection = renderUserMarkdown(fullProjectionState);
  assert.ok(boundedProjection.length <= 2_000);
  for (const item of fullProjectionState.items) {
    if (boundedProjection.includes(item.text.slice(0, 12))) {
      assert.ok(boundedProjection.includes(item.text), "projected items are never truncated");
    }
  }

  // End-to-end: 3 consistent observed views → enters USER.md with marker.
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => ({
      ...EMPTY_DREAM_OUTPUT,
      userProfileItems: [{ section: "preference", profileKey: "preference.workflow", text: "用户习惯清晨散步" }]
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
    const beforeOversized = await readJson(fixture.repository.layout.manifest);
    await assert.rejects(async () => await fixture.repository.updateIdentityFile(
      "user",
      "甲".repeat(8_001),
      beforeOversized.revision as number
    ), /8000|too large|exceeds/u);
    const afterOversized = await readJson(fixture.repository.layout.manifest);
    assert.equal(afterOversized.revision, beforeOversized.revision,
      "oversized USER.md is rejected before any transaction begins");
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
              matchTerms: ["含糖食物", "奶茶"],
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
    // Round 6 修复二后：reset 只在已有 templateId 时成立，先完成首次选择。
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小糖", avatar: { kind: "default" } }
    });
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
    await system.updateSecondaryFact(
      sugar.parentId,
      sugar.id,
      { content: "用户手工修正：含糖食物需要留意。" },
      sugar.revision
    );

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
    assert.deepEqual(new Set(lexicalTokens("A 7")), new Set(["a", "7"]));
    assert.equal(scorePrimaryEntry({
      routeTokens: ["cart"],
      contentTokens: [],
      title: "cart",
      recallWhen: "cart"
    }, "art", new Set(["art"])), 0, "Latin tokens must not prefix/substring match");
    assert.equal(scoreSecondaryEntry({
      id: "sec_match_terms_only",
      parentId: memoryId,
      title: "art title",
      content: "art content",
      recallWhen: "art recall",
      matchTerms: ["painting"],
      relation: "associated",
      basis: "llm_inferred",
      routeTokens: ["art", "painting"],
      contentTokens: ["art"]
    }, "art", new Set(["art"])), 0,
    "secondary title/content cannot qualify a parent without matchTerms");

    const punctuation = await fixture.repository.search({ query: "!!!" }, fixture.runtime());
    assert.equal(punctuation.total, 0, "non-empty zero-token queries return no results");

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

    const edited = await system.updateSecondaryFact(fact.parentId, fact.id, {
      title: "周末山地徒步",
      matchTerms: ["徒步", "山地运动"],
      reason: "用户手工修正"
    }, fact.revision);
    assert.equal(edited.record.title, "周末山地徒步");
    assert.equal(edited.record.basis, "user_edited_inference");
    const onDisk = await readFile(
      `${fixture.vaultPath}/.echoink/${secondaryRelativePath(memoryId, fact.id)}`,
      "utf8"
    );
    assert.match(onDisk, /user_edited_inference/);

    await system.deleteSecondaryFact(fact.parentId, fact.id, edited.record.revision);
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
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "agents/echoink/AGENT.md"
    });
    await writeFile(fixture.repository.layout.user, customUser);
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "shared-user/USER.md"
    });
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
    // Round 6 修复二后：reset 只在已有 templateId 时成立，先完成首次选择。
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小复", avatar: { kind: "default" } }
    });
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
    await system.updateSecondaryFact(
      editedFact.parentId,
      editedFact.id,
      { content: "用户手工修正后的内容。" },
      editedFact.revision
    );

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

    // The shared block serializer is the ONLY final-context entry: the budget
    // must equal the real combined text token count, not an approximation.
    const secondaryFacts: Array<{
      parentId: string;
      parentTitle: string;
      fact: SecondaryMatchView;
    }> = [];
    for (const candidate of exact.recall!.candidates) {
      for (const view of candidate.secondaryMatches ?? []) {
        secondaryFacts.push({ parentId: candidate.id, parentTitle: candidate.title, fact: view });
      }
    }
    const blocks = serializeRecallBlocks({
      candidates: exact.recall!.candidates,
      secondaryFacts,
      exhaustive: exact.recall!.exhaustive,
      hasMore: exact.recall!.hasMore,
      total: exact.recall!.total,
      injected: exact.recall!.injected,
      remaining: exact.recall!.remaining
    });
    assert.equal(estimatePiContextTokens(blocks.combined).tokens, exactBudget,
      "budget must equal the real final combined payload token count");

    // One token less drops association-clue payload first, never a primary.
    const tight = await harness.prepareTurnContext({ ...common, tokenBudget: exactBudget - 1 });
    assert.equal(tight.recall?.injected, 2,
      "primary Memory candidates claim budget before association clues");
    assert.ok(measureFinalInjectionTokens(tight.recall!.candidates, tight.recall!.total) <= exactBudget - 1);

    const primaryOnlyBudget = measurePrimaryInjectionTokens(
      plenty.recall!.candidates,
      plenty.recall!.total
    );
    const primaryOnly = await harness.prepareTurnContext({ ...common, tokenBudget: primaryOnlyBudget });
    assert.equal(primaryOnly.recall?.injected, 2);
    assert.equal(primaryOnly.recall!.candidates.reduce(
      (sum, candidate) => sum + (candidate.secondaryMatches?.length ?? 0), 0
    ), 0, "association clues are omitted when only the primary block fits");
  });
  console.log("PASS cognitive: recall budget measures the real final payload once");
}

// ---------------------------------------------------------------------------
// R3-5. Observed profile aggregation by stable profileKey + claim value (§5)
// ---------------------------------------------------------------------------

async function scenarioObservedProfileKeyAggregation(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const texts: Record<string, string> = {
      矛盾画像一: "用户偏好中文",
      矛盾画像二: "用户偏好英文",
      矛盾画像三: "用户偏好日文",
      一致画像一: "用户习惯清晨散步",
      一致画像二: "用户习惯清晨散步",
      一致画像三: "用户习惯清晨散步",
      晋升后矛盾画像: "用户从不清晨散步",
      显式画像: "用户只在周末散步"
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
            profileKey: "preference.workflow",
            text: texts[parsed.memory.title] ?? "用户习惯清晨散步"
          }]
        });
      }
    };
    const system = await createSystem(fixture, () => llm);
    for (const title of ["矛盾画像一", "矛盾画像二", "矛盾画像三"]) {
      await createMemory(fixture, {
        title, content: `${title}的内容。`,
        kind: "view",
        basis: "observed"
      });
    }
    await system.settleDreamEnqueue();
    await system.forceDreamRun();

    const raw = await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>;
    let profileState = parseUserProfileState(raw);
    assert.ok(profileState);
    let currentItems = profileState!.items.filter((item) => item.status === "current");
    assert.equal(currentItems.length, 1,
      "one closed slot retains at most one bounded observed candidate");
    assert.equal(currentItems[0].sourceMemoryIds.length, 1,
      "each contradictory claim resets the candidate instead of pooling sources");
    let userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(!userMd.includes("用户偏好中文")
      && !userMd.includes("用户偏好英文")
      && !userMd.includes("用户偏好日文"),
    "three contradictory values cannot pool sources or render");

    for (const title of ["一致画像一", "一致画像二", "一致画像三"]) {
      await createMemory(fixture, {
        title, content: `${title}的内容。`,
        kind: "view",
        basis: "observed"
      });
    }
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    profileState = parseUserProfileState(
      await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>
    );
    currentItems = profileState!.items.filter((item) => item.status === "current");
    const consistent = currentItems.find((item) => item.text === "用户习惯清晨散步");
    assert.ok(consistent);
    assert.equal(consistent!.sourceMemoryIds.length, 3,
      "three consistent independent sources accumulate in one claim group");
    assert.ok(prompts.every((prompt) => prompt.includes("preference:preference.workflow")),
      "every prompt receives the same closed 24-slot catalog");

    userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(userMd.includes(consistent!.text), "consistent claim must reach USER.md");

    await createMemory(fixture, {
      title: "晋升后矛盾画像",
      content: "一条新的 observed 与已成立值矛盾。",
      kind: "view",
      basis: "observed"
    });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    profileState = parseUserProfileState(
      await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>
    );
    const established = profileState!.items.find((item) =>
      item.status === "current" && item.profileKey === "preference.workflow"
      && item.basis === "observed_memory"
    );
    assert.equal(established?.text, "用户习惯清晨散步");
    assert.equal(established?.sourceMemoryIds.length, 3,
      "one contradictory observation cannot replace or support an established three-source value");
    userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(userMd.includes("用户习惯清晨散步"));
    assert.ok(!userMd.includes("用户从不清晨散步"));

    await createMemory(fixture, {
      title: "显式画像",
      content: "用户明确说自己只在周末散步。",
      basis: "explicit"
    });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(userMd.includes("用户只在周末散步"), "explicit claim renders immediately");
    assert.ok(!userMd.includes("用户习惯清晨散步"), "explicit claim wins the shared slot display");

  });
  console.log("PASS cognitive: observed profile aggregates by slot and consistent claim value");
}

async function scenarioUserProfileProcessedSourcesStayBounded(): Promise<void> {
  let state = emptyUserProfileState(1);
  for (let index = 0; index < 60; index += 1) {
    const memoryId = `mem_profile_round_${index}`;
    state = applyDreamProfileUpdate(state, {
      items: index < 3 ? [{
        section: "preference",
        profileKey: "preference.workflow",
        text: "用户保持同一稳定工作流",
        basis: "observed_memory",
        sourceMemoryId: memoryId
      }] : [],
      processedSources: [{ memoryId, memoryRevision: index + 1 }],
      now: 100 + index
    });
  }
  assert.deepEqual(
    state.processedSources.map((source) => source.memoryId),
    ["mem_profile_round_0", "mem_profile_round_1", "mem_profile_round_2"],
    "unrelated historical Dream sources do not accumulate in user-profile state"
  );
  const referenced = new Set(state.items
    .filter((item) => item.status === "current")
    .flatMap((item) => item.sourceMemoryIds));
  assert.ok(state.processedSources.every((source) => referenced.has(source.memoryId)));

  const raw = JSON.parse(userProfileStateJson({
    ...state,
    processedSources: Object.freeze([
      ...state.processedSources,
      { memoryId: "mem_unrelated_legacy", memoryRevision: 1, processedAt: 1 }
    ])
  })) as Record<string, unknown>;
  const parsed = parseUserProfileState(raw);
  assert.ok(parsed);
  assert.equal(parsed!.processedSources.some(
    (source) => source.memoryId === "mem_unrelated_legacy"
  ), false, "startup parsing also bounds old accumulated processedSources");
  console.log("PASS cognitive: user-profile processedSources stay referenced and bounded");
}

async function scenarioUserProfileV1MigrationFailsClosed(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const customUser = "# USER\n\n必须保留的旧画像正文。\n";
    await writeFile(fixture.repository.layout.user, customUser);
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "shared-user/USER.md"
    });
    const legacy = JSON.stringify({
      schema: "echoink.user-profile.v1",
      revision: 4,
      items: [{
        id: "profile_legacy_freeform",
        section: "preference",
        profileKey: "morning-walk-habit",
        text: "用户喜欢清晨散步",
        basis: "observed_memory",
        status: "current",
        sourceMemoryIds: ["mem_legacy_source"],
        revision: 4,
        updatedAt: 4
      }],
      processedSources: [],
      legacyUserMigration: "done",
      lastProjectedUserHash: "legacy-hash",
      updatedAt: 4
    }, null, 2) + "\n";
    await writeFile(fixture.repository.layout.userProfileState, legacy);
    const manifestBefore = await readFile(fixture.repository.layout.manifest, "utf8");
    await assert.rejects(() => CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => null,
      getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: fixture.now
    }), /user_profile_state_invalid:legacy_profile_key_unmappable/u);
    assert.equal(await readFile(fixture.repository.layout.userProfileState, "utf8"), legacy,
      "unmappable legacy state remains byte-for-byte untouched");
    assert.equal(await readFile(fixture.repository.layout.user, "utf8"), customUser,
      "fail-closed migration preserves USER.md");
    assert.equal(await readFile(fixture.repository.layout.manifest, "utf8"), manifestBefore,
      "failed migration commits no repository transaction");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const source = await createMemory(fixture, {
      title: "旧画像来源",
      content: "用户明确偏好中文。"
    });
    const userBefore = await readFile(fixture.repository.layout.user, "utf8");
    await writeFile(fixture.repository.layout.userProfileState, JSON.stringify({
      schema: "echoink.user-profile.v1",
      revision: 2,
      items: [{
        id: "profile_legacy_mappable",
        section: "preference",
        profileKey: "preference:preference.language",
        text: "用户明确偏好中文",
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: [source.id],
        revision: 2,
        updatedAt: 2
      }],
      processedSources: [{ memoryId: source.id, memoryRevision: source.revision, processedAt: 2 }],
      legacyUserMigration: "done",
      lastProjectedUserHash: "",
      updatedAt: 2
    }, null, 2) + "\n");
    const system = await createSystem(fixture, () => null);
    const migrated = await readJson(fixture.repository.layout.userProfileState) as Record<string, any>;
    assert.equal(migrated.schema, USER_PROFILE_STATE_SCHEMA);
    assert.equal(migrated.items[0].profileKey, "preference.language");
    assert.equal(await readFile(fixture.repository.layout.user, "utf8"), userBefore,
      "deterministic state migration does not rewrite USER.md");
    void system;
  });
  console.log("PASS cognitive: user-profile v1 migration maps deterministically or fails closed");
}

async function scenarioUserProjectionCasAndProfileUpdate(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm(() => EMPTY_DREAM_OUTPUT));
    const manifest = await readJson(fixture.repository.layout.manifest) as { revision: number };
    const updated = await fixture.repository.write({
      operation: "profile_update",
      profileKey: "preference.language",
      text: "用户明确偏好中文",
      basis: "explicit",
      contentOrigin: "user_statement",
      expectedRevision: manifest.revision
    }, fixture.runtime());
    assert.ok(updated.record, "profile_update creates one explicit primary Memory source");
    let user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(user.includes("用户明确偏好中文"));

    await system.settleDreamEnqueue();
    const afterToolDream = await system.forceDreamRun();
    assert.equal(afterToolDream?.committed, true);
    user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(user.includes("用户明确偏好中文"),
      "approved profile_update truth survives a successful Dream");

    await createMemory(fixture, {
      title: "外部编辑后的做梦来源",
      content: "这条 Memory 只用于触发一次成功 Dream。"
    });
    const externalUser = "# USER\n\n这是用户或工具在系统外修改的内容。\n";
    await writeFile(fixture.repository.layout.user, externalUser);
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "shared-user/USER.md"
    });
    await system.settleDreamEnqueue();
    const afterExternalDream = await system.forceDreamRun();
    assert.equal(afterExternalDream?.committed, true,
      "external USER edit does not block unrelated Dream state work");
    assert.equal(await readFile(fixture.repository.layout.user, "utf8"), externalUser,
      "Dream never silently overwrites an external USER.md edit");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    let mutateDuringProvider = false;
    const concurrentUser = "# USER\n\nProvider 运行期间发生的外部修改。\n";
    const llm: DreamLlmPort = {
      call: async () => {
        if (mutateDuringProvider) {
          mutateDuringProvider = false;
          await writeFile(fixture.repository.layout.user, concurrentUser);
        }
        return JSON.stringify({
          ...EMPTY_DREAM_OUTPUT,
          userProfileItems: [{
            section: "preference",
            profileKey: "preference.tone",
            text: "用户明确偏好温和语气"
          }]
        });
      }
    };
    const system = await createSystem(fixture, () => llm);
    const manifest = await readJson(fixture.repository.layout.manifest) as { revision: number };
    await fixture.repository.write({
      operation: "profile_update",
      profileKey: "preference.language",
      text: "用户明确偏好中文",
      basis: "explicit",
      contentOrigin: "user_statement",
      expectedRevision: manifest.revision
    }, fixture.runtime());
    const beforeState = await readFile(fixture.repository.layout.userProfileState, "utf8");
    await createMemory(fixture, {
      title: "USER CAS 并发来源",
      content: "用户明确偏好温和语气。"
    });
    await system.settleDreamEnqueue();
    mutateDuringProvider = true;
    const conflicted = await system.forceDreamRun();
    assert.equal(conflicted?.committed, false);
    assert.match(conflicted?.error ?? "", /USER\.md|fixed file|projection conflict|changed after initialization/iu);
    assert.equal(await readFile(fixture.repository.layout.user, "utf8"), concurrentUser,
      "hash conflict leaves concurrent USER.md bytes untouched");
    assert.equal(await readFile(fixture.repository.layout.userProfileState, "utf8"), beforeState,
      "failed USER projection CAS commits no unbacked profile state");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    await createSystem(fixture, () => null);
    for (const slot of USER_PROFILE_SLOTS) {
      const before = await fixture.repository.inspect();
      const updated = await fixture.repository.write({
        operation: "profile_update",
        profileKey: slot.profileKey,
        text: "甲".repeat(120),
        basis: "explicit",
        contentOrigin: "user_statement",
        expectedRevision: before.revision
      }, fixture.runtime());
      assert.equal(updated.revision, before.revision + 1);
    }
    const profileState = parseUserProfileState(
      await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>
    );
    assert.ok(profileState);
    assert.equal(profileState!.items.filter((item) => item.basis === "explicit_memory").length, 24,
      "each closed profile slot retains exactly one explicit item");
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(user.length <= 8_000, "closed-slot profile updates cannot generate USER.md above 8000");

    const beforeRejected = await fixture.repository.inspect();
    await assert.rejects(fixture.repository.write({
      operation: "profile_update",
      profileKey: "preference.language",
      text: "乙".repeat(121),
      basis: "explicit",
      contentOrigin: "user_statement",
      expectedRevision: beforeRejected.revision
    }, fixture.runtime()), /too large|120|invalid_request/iu);
    assert.equal((await fixture.repository.inspect()).revision, beforeRejected.revision,
      "121-character profile item is rejected before any committed change");
  });
  console.log("PASS cognitive: USER projection CAS + closed-slot profile_update truth");
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
    await system.updateSecondaryFact(
      decayedFact.parentId,
      decayedFact.id,
      { content: "用户确认丙类关联。" },
      decayedFact.revision
    );
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

async function scenarioFirstQueryUsesMountedSecondaryRecords(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const memory = await createMemory(fixture, {
      title: "无关的一级记忆标题",
      content: "一级正文不包含用于召回的联想词。"
    });
    const fact = createSecondaryRecord({
      parentId: memory.id,
      title: "冷启动联想线索",
      content: "这条线索只存在于重启时从磁盘挂载的 secondary record。",
      recallWhen: "聊到冷启动桥接词时",
      matchTerms: ["冷启动桥接词"],
      relation: "associated",
      reason: "验证启动顺序",
      basis: "user_edited_inference",
      confidence: 0.7,
      supportLevel: "direct",
      evidence: "测试直接写入磁盘的既有联想线索",
      sourceMemoryRevision: memory.revision,
      now: fixture.now(),
      idFactory: () => "sec_startup_first_query"
    });
    const factFile = path.join(fixture.repository.layout.root, fact.file);
    await mkdir(path.dirname(factFile), { recursive: true });
    await writeFile(factFile, serializeSecondaryRecord(fact));

    // withPersonalMemoryFixture 已经 initialize() 过 Repository，复现产品的
    // initialize → CognitiveSystem.create 启动顺序。create() 返回时索引必须已
    // 同步包含磁盘线索，不能依赖第二次查询、Dream 或 watcher 才生效。
    await createSystem(fixture, () => null);
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query: "冷启动桥接词"
    }, fixture.runtime());
    assert.ok(snapshot.search);
    assert.equal(snapshot.search!.items[0]?.id, memory.id);
    assert.equal(snapshot.search!.items[0]?.matchedSecondaryId, fact.id);
  });
  console.log("PASS cognitive: first query uses mounted disk secondary records");
}

async function scenarioDecisiveHitUsesProductionBudgetCounterfactual(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const query = "预算桥接主题词反例";
    const pad = (prefix: string, size: number, fill: string): string =>
      `${prefix}${fill.repeat(Math.max(0, size - prefix.length))}`;
    const a = await createMemory(fixture, {
      title: pad(query, 200, "甲"),
      content: "甲".repeat(24_000),
      recallWhen: pad(query, 500, "乙"),
      scope: "丙".repeat(240)
    });
    const b = await createMemory(fixture, {
      title: "预算桥接",
      content: "B 是能够装进预算的小型一级记忆。",
      recallWhen: "相关主题出现时"
    });
    const c = await createMemory(fixture, {
      title: "C 的低分一级记忆",
      content: "预算",
      recallWhen: "仅靠一级字段只能排在 A B 后面"
    });
    const fact = createSecondaryRecord({
      parentId: c.id,
      title: "C 的预算联想线索",
      content: "C 通过 secondary matchTerms 排到组合排序第一。",
      recallWhen: "命中预算桥接反例时",
      matchTerms: [query, "预算桥接", "桥接主题", "主题词反例", "反例"],
      relation: "associated",
      reason: "验证 decisive hit 的预算反事实",
      basis: "user_edited_inference",
      confidence: 0.7,
      supportLevel: "direct",
      evidence: "测试构造的稳定排序",
      sourceMemoryRevision: c.revision,
      now: fixture.now(),
      idFactory: () => "sec_budget_counterfactual_c"
    });
    fixture.repository.setSecondaryRecords([fact]);
    await fixture.repository.ensureSecondaryIndexFresh();

    const selectorInputs: Array<readonly PersonalMemoryTurnCatalogCandidate[]> = [];
    const productionBudgetSelector = (
      candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
    ): readonly string[] => {
      selectorInputs.push(candidates);
      const selected: PersonalMemoryTurnCatalogCandidate[] = [];
      for (const candidate of candidates) {
        const next = [...selected, candidate];
        if (measurePrimaryInjectionTokens(next, candidates.length) > 1_200) continue;
        selected.push(candidate);
      }
      return selected.map((candidate) => candidate.id);
    };
    const snapshot = await fixture.repository.prepareTurnSnapshot({
      memoryMode: "normal",
      query,
      selectCandidateIds: productionBudgetSelector
    }, fixture.runtime());
    assert.ok(snapshot.search);
    assert.deepEqual(selectorInputs[0].map((candidate) => candidate.id), [c.id, a.id, b.id],
      "combined ranking is the C A B counterexample");
    assert.deepEqual(selectorInputs[1].map((candidate) => candidate.id), [a.id, b.id, c.id],
      "counterfactual ranks the same catalog by primary score only");
    const combinedById = new Map(selectorInputs[0].map((candidate) => [candidate.id, candidate]));
    assert.ok(measurePrimaryInjectionTokens([combinedById.get(a.id)!], 3) > 1_200,
      "oversized primary A cannot fit the 1200-token budget");
    assert.deepEqual(snapshot.search!.items.map((item) => item.id), [c.id, b.id],
      "production selector skips A and still admits small primary B");
    assert.equal(snapshot.search!.pendingSecondaryHits.length, 0,
      "C also fits the exact primary-only budget selection, so its clue is not decisive");
    assert.equal(snapshot.search!.items[0].matchedSecondaryId, undefined,
      "a non-decisive clue must not be marked for hit attribution");
  });
  console.log("PASS cognitive: decisive hit uses the 1200-token production counterfactual");
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

  // 1) Same title, different terms, higher candidate confidence → in-place
  //    update ON THE OLD RECORD: id / hitCount / lastHitAt survive, revision
  //    +1. Retire+create is forbidden (Round 6 §9).
  const oldFact = makeExisting(0.75, "llm_inferred");
  let result = reconcile([oldFact], [candidate("手冲咖啡", ["手冲", "器具"])]);
  let current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, oldFact.id, "broad-key replace must keep the old id");
  assert.equal(current[0].hitCount, oldFact.hitCount, "hitCount survives replacement");
  assert.equal(current[0].lastHitAt, oldFact.lastHitAt, "lastHitAt survives replacement");
  assert.equal(current[0].createdAt, oldFact.createdAt, "createdAt survives replacement");
  assert.equal(current[0].revision, oldFact.revision + 1);
  assert.equal(current[0].content, "新候选内容。", "content updated in place");
  assert.deepEqual([...current[0].matchTerms], ["手冲", "器具"], "terms updated in place");
  assert.equal(result.factsCreated, 0, "replacement must not create a new record");
  assert.equal(result.factsReused, 1, "replacement counts as reuse");
  assert.equal(result.factsRetired, 0, "replacement must not retire the old record");
  assert.ok(!result.records.some((record) => record.disabledReason === "redream_replaced"),
    "no retire+create residue");

  // 2) Same title, existing confidence higher → keep old record untouched.
  const boosted = applySecondaryHit(makeExisting(0.75, "llm_inferred"), now + 500);
  assert.ok(boosted.confidence >= 0.80);
  result = reconcile([boosted], [candidate("手冲咖啡", ["手冲", "器具"], "strong_inference")]);
  current = result.records.filter((record) => record.status === "current");
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
        dimension: "sharpness",
        direction: "decrease",
        strength: 0.7,
        evidence: "记忆显示用户希望语气温和"
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


// ---------------------------------------------------------------------------
// R5. 新六维人格：维度契约、五档边界、行为指令、演化规则、v1→v2 迁移
// ---------------------------------------------------------------------------

const NEW_DIMS = ["sharpness", "dominance", "rigor", "structure", "boldness", "creativity"] as const;
const OLD_DIMS = ["tempo", "energy", "mind", "warmth", "order", "stance"] as const;
const BAND_SCORES = [0, 0.20, 0.21, 0.40, 0.41, 0.59, 0.60, 0.79, 0.80, 1] as const;
const EXPECTED_BAND_INDEX = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4] as const;

async function scenarioTraitDimensionContract(): Promise<void> {
  // 1. TRAIT_DIMENSIONS 只包含六个新 ID，顺序冻结。
  assert.deepEqual([...TRAIT_DIMENSIONS], [...NEW_DIMS]);
  for (const dimension of NEW_DIMS) assert.ok(isTraitDimension(dimension));
  for (const dimension of OLD_DIMS) assert.ok(!isTraitDimension(dimension), `old id ${dimension} must be gone`);

  // 2. 八模板每个都有且只有六个新分数，templateId 保持兼容。
  const expectedIds = ["executor", "advisor", "butler", "companion", "steward", "enthusiast", "creative", "pragmatist"];
  assert.deepEqual(PERSONALITY_TEMPLATES.map((template) => template.id), expectedIds);
  for (const template of PERSONALITY_TEMPLATES) {
    assert.deepEqual(Object.keys(template.scores).sort(), [...NEW_DIMS].sort(),
      `${template.id} must have exactly the six new dimensions`);
    for (const dimension of NEW_DIMS) {
      const score = template.scores[dimension];
      assert.ok(score >= 0 && score <= 1, `${template.id}.${dimension} in [0,1]`);
    }
    for (const dimension of OLD_DIMS) {
      assert.ok(!(dimension in template.scores), `${template.id} must not carry ${dimension}`);
    }
    assert.ok(template.richDescZh.trim().length > 0 && template.richDescEn.trim().length > 0,
      `${template.id} descriptions must come from the shared constant`);
  }

  // 3. 旧 ID 不进入做梦 Prompt 与 AGENT.md 投影。
  const probeRecord = {
    schema: "echoink.memory.v1", id: "mem_contract_probe", kind: "view", status: "current",
    title: "风格", content: "用户偏好温和的表达。", recallWhen: "聊到风格时",
    basis: "explicit", source: "test", revision: 1, file: "views/mem_contract_probe.md"
  } as unknown as PersonalMemoryRecord;
  const { systemPrompt, userPrompt } = buildDreamPrompts(probeRecord, 2000);
  const asWord = (dimension: string) => new RegExp(`(^|[^a-zA-Z])${dimension}([^a-zA-Z]|$)`, "u");
  for (const dimension of OLD_DIMS) {
    assert.ok(!asWord(dimension).test(systemPrompt), `prompt must not mention ${dimension}`);
  }
  for (const dimension of NEW_DIMS) {
    assert.ok(asWord(dimension).test(systemPrompt), `prompt must mention ${dimension}`);
  }
  void userPrompt;
  for (const dimension of NEW_DIMS) {
    for (const score of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      const line = renderTraitLine(dimension, score);
      for (const legacy of OLD_DIMS) assert.ok(!line.includes(legacy));
      assert.ok(!line.includes("偏左") && !line.includes("偏右") && !line.includes("靠右极"));
      assert.ok(!line.includes("%"), "trait line must not carry percentages");
    }
  }
  console.log("PASS cognitive: trait dimension contract (six new ids only, no legacy residue)");
}

async function scenarioBandBoundaries(): Promise<void> {
  // 4/5. 每个维度五档，边界 0.20/0.21/0.40/0.41/0.59/0.60/0.79/0.80 全部逐项。
  for (const dimension of NEW_DIMS) {
    const bands = TRAIT_DIMENSION_META[dimension].bands;
    assert.equal(bands.length, 5, `${dimension} must have exactly five bands`);
    for (let i = 0; i < BAND_SCORES.length; i += 1) {
      const picked = traitBehaviorBand(dimension, BAND_SCORES[i]);
      assert.equal(picked, bands[EXPECTED_BAND_INDEX[i]],
        `${dimension} score ${BAND_SCORES[i]} must land in band ${EXPECTED_BAND_INDEX[i]} (${picked.labelZh})`);
    }
  }
  // 档位文案字段完整。
  for (const dimension of NEW_DIMS) {
    for (const current of TRAIT_DIMENSION_META[dimension].bands) {
      assert.ok(current.labelZh && current.labelEn);
      assert.ok(current.uiDescriptionZh && current.uiDescriptionEn);
      assert.ok(current.agentInstructionZh && current.agentInstructionEn);
      assert.ok(current.min <= current.max);
    }
  }
  console.log("PASS cognitive: five-band boundaries correct for every dimension");
}

async function scenarioBandBehaviorInstructions(): Promise<void> {
  const line = (dimension: (typeof NEW_DIMS)[number], score: number) =>
    renderTraitLine(dimension, score);

  // 7. 锋利度 0.10 → 恭敬指令。
  const respectful = line("sharpness", 0.10);
  assert.match(respectful, /恭敬/u);
  assert.match(respectful, /敬语/u);
  assert.match(respectful, /不吐槽用户/u);

  // 8. 锋利度 0.90 → 毒舌指令 + 行为边界（吐槽必须带改法；痛苦时不二次伤害）。
  const scathing = line("sharpness", 0.90);
  assert.match(scathing, /毒舌/u);
  assert.match(scathing, /错在哪里/u);
  assert.match(scathing, /怎么改/u);
  assert.match(scathing, /二次伤害/u);

  // 9. 主导度 0.90 → 强势带领 + 用户否决后服从。
  const dominant = line("dominance", 0.90);
  assert.match(dominant, /强势/u);
  assert.match(dominant, /尊重最终决定/u);

  // 10. 较真度 0.90 → 当前范围内真正闭环，不扩围。
  const exacting = line("rigor", 0.90);
  assert.match(exacting, /极致/u);
  assert.match(exacting, /闭环/u);
  assert.match(exacting, /不得为了追求完美扩展/u);

  // 11. 条理性 0.90 → 步骤、层级、验收 + 简单问题不机械结构化。
  const structured = line("structure", 0.90);
  assert.match(structured, /强结构/u);
  assert.match(structured, /编号步骤/u);
  assert.match(structured, /验收条件/u);
  assert.match(structured, /不得机械创建复杂结构/u);

  // 12. 果敢度 0.90 → 果敢推进，但保留不可逆/授权边界。
  const bold = line("boldness", 0.90);
  assert.match(bold, /果敢/u);
  assert.match(bold, /不可逆/u);
  assert.match(bold, /授权边界/u);

  // 13. 创意度 0.90 → 仅在允许多方案的任务上要求三个以上方向。
  const imaginative = line("creativity", 0.90);
  assert.match(imaginative, /天马行空/u);
  assert.match(imaginative, /3 个以上/u);
  assert.match(imaginative, /不得机械凑三个方案/u);

  console.log("PASS cognitive: band instructions encode behavior and hard boundaries");
}

async function scenarioSignalClassificationPrompt(): Promise<void> {
  const record = {
    schema: "echoink.memory.v1", id: "mem_class_probe", kind: "view", status: "current",
    title: "长期相处方式", content: "用户对 Agent 的风格要求。", recallWhen: "聊到风格时",
    basis: "explicit", source: "test", revision: 1, file: "views/mem_class_probe.md"
  } as unknown as PersonalMemoryRecord;
  const { systemPrompt } = buildDreamPrompts(record, 2000);

  // 只进入 requirement、不形成 trait signal 的例子必须写进 Prompt。
  for (const example of [
    "以后回答先给结论", "以后详细解释", "每次最多三段", "多举例",
    "少用表格", "使用中文", "称呼我为方哥", "每次附验收步骤"
  ]) {
    assert.ok(systemPrompt.includes(example), `requirement-only example missing: ${example}`);
  }
  // 可以同时形成 trait signal 的例子（六个维度各一）。
  assert.ok(systemPrompt.includes("以后说话毒舌一点」→sharpness increase"));
  assert.ok(systemPrompt.includes("以后你来替我收敛方案」→dominance increase"));
  assert.ok(systemPrompt.includes("不要能跑就算完成」→rigor increase"));
  assert.ok(systemPrompt.includes("输出习惯按第一、第二、第三」→structure increase"));
  assert.ok(systemPrompt.includes("低风险步骤别总问我」→boldness increase"));
  assert.ok(systemPrompt.includes("多给非传统方案」→creativity increase"));
  // 明确排除项。
  assert.ok(systemPrompt.includes("用户自己说话毒舌或说脏话"));
  assert.ok(systemPrompt.includes("reasoning 强度"));
  assert.ok(systemPrompt.includes("「思考深一点」不属于任何人格维度"));

  // parseDreamOutput：新维度接受，旧维度一律丢弃。
  const parsed = parseDreamOutput(JSON.stringify({
    secondaryFacts: [],
    personalitySignals: [
      { dimension: "sharpness", direction: "increase", strength: 0.8, evidence: "要求毒舌" },
      { dimension: "tempo", direction: "increase", strength: 0.8, evidence: "旧维度必须被丢弃" },
      { dimension: "warmth", direction: "decrease", strength: 0.5, evidence: "旧维度必须被丢弃" }
    ],
    agentRequirements: [],
    userProfileItems: []
  }));
  assert.ok(parsed);
  assert.equal(parsed!.signals.length, 1);
  assert.equal(parsed!.signals[0].dimension, "sharpness");
  console.log("PASS cognitive: signal vs requirement classification rules in prompt and parser");
}

function templateBaseState(): PersonalityState {
  return applyTemplateToState(emptyPersonalityState(0), {
    templateId: "executor", // sharpness baseline 0.75
    now: 1,
    reset: false
  });
}

function signalsFor(
  entries: ReadonlyArray<{ id: string; direction: "increase" | "decrease"; revision?: number }>
): DreamPersonalityInput["signals"] {
  return entries.map((entry) => ({
    dimension: "sharpness",
    direction: entry.direction,
    strength: 0.9,
    evidence: `来源 ${entry.id}`,
    sourceMemoryId: entry.id,
    sourceMemoryRevision: entry.revision ?? 1
  }));
}

async function scenarioEvolutionRulesOnNewDimensions(): Promise<void> {
  // 14. 三个 increase 来源推动新维度上升。
  let state = templateBaseState();
  state = applyDreamPersonalityUpdate(state, {
    signals: signalsFor([
      { id: "mem-inc-1", direction: "increase" },
      { id: "mem-inc-2", direction: "increase" },
      { id: "mem-inc-3", direction: "increase" }
    ]),
    requirements: [],
    processedSources: [],
    now: 2
  });
  const raised = state.observed.sharpness;
  assert.ok(raised, "3 increase sources must create observed sharpness");
  assert.ok(raised!.score > 0.75, "increase raises the trait score");

  // 15. 三个 decrease 来源推动下降。
  state = templateBaseState();
  state = applyDreamPersonalityUpdate(state, {
    signals: signalsFor([
      { id: "mem-dec-1", direction: "decrease" },
      { id: "mem-dec-2", direction: "decrease" },
      { id: "mem-dec-3", direction: "decrease" }
    ]),
    requirements: [],
    processedSources: [],
    now: 2
  });
  const lowered = state.observed.sharpness;
  assert.ok(lowered, "3 decrease sources must create observed sharpness");
  assert.ok(lowered!.score < 0.75, "decrease lowers the trait score");

  // 16. increase/decrease 平票不更新，候选保留。
  state = templateBaseState();
  state = applyDreamPersonalityUpdate(state, {
    signals: signalsFor([
      { id: "mem-tie-a", direction: "increase" },
      { id: "mem-tie-b", direction: "increase" },
      { id: "mem-tie-c", direction: "increase" },
      { id: "mem-tie-d", direction: "decrease" },
      { id: "mem-tie-e", direction: "decrease" },
      { id: "mem-tie-f", direction: "decrease" }
    ]),
    requirements: [],
    processedSources: [],
    now: 2
  });
  assert.equal(state.observed.sharpness, null, "a tie must not update personality");
  assert.equal(state.candidates.length, 6, "tie candidates stay for later evidence");

  // 17. 只有两个来源不更新。
  state = templateBaseState();
  state = applyDreamPersonalityUpdate(state, {
    signals: signalsFor([
      { id: "mem-two-1", direction: "increase" },
      { id: "mem-two-2", direction: "increase" }
    ]),
    requirements: [],
    processedSources: [],
    now: 2
  });
  assert.equal(state.observed.sharpness, null, "2 sources are not enough");
  assert.equal(state.candidates.length, 2);

  // 同一 source+dimension+revision 不重复进入 candidates。
  state = templateBaseState();
  const once = signalsFor([{ id: "mem-dup", direction: "increase" }]);
  state = applyDreamPersonalityUpdate(state, { signals: once, requirements: [], processedSources: [], now: 2 });
  state = applyDreamPersonalityUpdate(state, { signals: once, requirements: [], processedSources: [], now: 3 });
  assert.equal(state.candidates.length, 1, "same source+revision must not duplicate");

  // 同一来源 revision 变化时，旧 candidate 被替换而不是并存。
  state = applyDreamPersonalityUpdate(state, {
    signals: signalsFor([{ id: "mem-dup", direction: "decrease", revision: 2 }]),
    requirements: [],
    processedSources: [],
    now: 4
  });
  assert.equal(state.candidates.length, 1, "revised source replaces the old candidate");
  assert.equal(state.candidates[0].direction, "decrease");
  assert.equal(state.candidates[0].sourceMemoryRevision, 2);

  console.log("PASS cognitive: evolution rules (3 sources, tie, replace, dedupe) on new dimensions");
}

async function scenarioResetRestoresNewBaseline(): Promise<void> {
  // 19/20. 重置恢复新模板 baseline，templateId 兼容。
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小执", avatar: { kind: "default" } }
    });
    const result = await system.selectPersonalityTemplate("advisor", { reset: true });
    assert.equal(result.state.templateId, "advisor");
    const template = getPersonalityTemplate("advisor")!;
    for (const dimension of NEW_DIMS) {
      assert.equal(result.state.explicit[dimension]?.score, template.scores[dimension]);
      assert.equal(result.state.observed[dimension], null);
    }
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /锋利度/u);
    assert.match(agent, /较真度/u);
  });
  console.log("PASS cognitive: reset restores new-dimension template baseline");
}

// ---------------------------------------------------------------------------
// v1 → v2 migration scenarios
// ---------------------------------------------------------------------------

function legacyV1State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "echoink.personality.v1",
    revision: 5,
    templateId: "advisor",
    explicit: {
      tempo: { id: "trait-old-1", dimension: "tempo", basis: "explicit", status: "current", score: 0.75, sourceMemoryIds: [], evidence: "", createdAt: 1, updatedAt: 1, revision: 1 }
    },
    observed: {
      tempo: { id: "trait-old-2", dimension: "tempo", basis: "observed", status: "current", score: 0.6, sourceMemoryIds: ["mem-old"], evidence: "", createdAt: 2, updatedAt: 2, revision: 2 }
    },
    history: [],
    candidates: [{ id: "cand-old", dimension: "tempo", direction: "decrease", strength: 0.7, sourceMemoryId: "mem-old", sourceMemoryRevision: 1, evidence: "", createdAt: 3 }],
    learnedRequirements: [{
      id: "req-kept",
      text: "以后回答先给结论",
      basis: "explicit_memory",
      status: "current",
      sourceMemoryIds: ["mem-req-1"],
      revision: 3
    }],
    processedSources: [{ memoryId: "mem-old", memoryRevision: 1, processedAt: 4 }],
    updatedAt: 100,
    ...overrides
  };
}

async function seedLegacyPersonality(
  fixture: PersonalMemoryFixture,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await writeFile(
    fixture.repository.layout.personalityState,
    JSON.stringify(legacyV1State(overrides), null, 2),
    "utf8"
  );
}

async function listMigrationBackups(fixture: PersonalMemoryFixture): Promise<string[]> {
  const dir = path.join(fixture.repository.layout.root, "agents", "echoink", "history");
  try {
    const entries = await readdir(dir);
    return entries.filter((entry) => entry.startsWith("personality-state-v1-"));
  } catch {
    return [];
  }
}

async function scenarioPersonalityV1ToV2Migration(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    // Pre-seed: v1 personality + identity + one current memory.
    await seedLegacyPersonality(fixture);
    const identityPath = fixture.repository.layout.agentIdentity;
    await writeFile(identityPath, JSON.stringify({
      schema: "echoink.agent-identity.v1",
      revision: 1,
      displayName: "小墨",
      avatar: { kind: "default" },
      updatedAt: 50
    }), "utf8");
    const memory = await createMemory(fixture, {
      title: "用户喜欢早晨散步",
      content: "用户经常早晨散步。"
    });
    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };

    // create() runs the migration locally, no Provider.
    const system = await createSystem(fixture, () => null);

    // 1/2/3/4/5. v2 file: template + requirements kept, baseline rebuilt, rest emptied.
    const raw = await readJson(fixture.repository.layout.personalityState) as Record<string, any>;
    assert.equal(raw.schema, "echoink.personality.v2");
    assert.equal(raw.templateId, "advisor", "templateId preserved");
    assert.equal(raw.learnedRequirements.length, 1);
    assert.equal(raw.learnedRequirements[0].text, "以后回答先给结论");
    assert.deepEqual(raw.learnedRequirements[0].sourceMemoryIds, ["mem-req-1"]);
    assert.equal(raw.learnedRequirements[0].basis, "explicit_memory");
    assert.equal(raw.learnedRequirements[0].status, "current");
    const template = getPersonalityTemplate("advisor")!;
    for (const dimension of NEW_DIMS) {
      assert.equal(raw.explicit[dimension].score, template.scores[dimension],
        `explicit ${dimension} rebuilt from the new template baseline`);
    }
    for (const dimension of NEW_DIMS) assert.equal(raw.observed[dimension], null);
    assert.deepEqual(raw.candidates, []);
    assert.deepEqual(raw.processedSources, []);

    // 6. Complete v1 backup exists.
    const backups = await listMigrationBackups(fixture);
    assert.equal(backups.length, 1, "exactly one v1 backup");
    const backupRaw = await readJson(path.join(
      fixture.repository.layout.root, "agents", "echoink", "history", backups[0]
    )) as Record<string, unknown>;
    assert.equal(backupRaw.schema, "echoink.personality.v1");
    assert.ok(Array.isArray(backupRaw.candidates) && (backupRaw.candidates as unknown[]).length === 1,
      "backup keeps the full legacy JSON");

    // 7. Current memory re-queued for dreaming; progress reset.
    const dreamState = await readJson(fixture.repository.layout.dreamState) as Record<string, any>;
    assert.equal(dreamState.lastProcessedMemoryRevision, 0);
    assert.equal(dreamState.backfillCursor, null);
    const pending = dreamState.pendingMemoryIds as readonly string[];
    assert.ok(pending.includes(memory.id), "current memory re-enters the pending queue");

    // 8. AGENT.md uses the new six dimensions and keeps the identity name.
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.match(agent, /锋利度/u);
    assert.match(agent, /当前名称：小墨/u, "migration keeps the identity name");
    for (const dimension of OLD_DIMS) assert.ok(!agent.includes(`${dimension}（`));
    assert.ok(!agent.includes("偏右") && !agent.includes("靠右极"));

    // 9. ONE repository transaction.
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision + 1);

    // 11/13. Restart: no duplicate migration/backup; identity untouched.
    const systemAgain = await createSystem(fixture, () => null);
    const backupsAfterRestart = await listMigrationBackups(fixture);
    assert.equal(backupsAfterRestart.length, 1, "restart must not create a second backup");
    const manifestRestart = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestRestart.revision, manifestAfter.revision, "restart adds no transaction");
    const identity = await systemAgain.readAgentIdentity();
    assert.equal(identity.displayName, "小墨");
    assert.equal(identity.revision, 1);
    void system;
  });
  console.log("PASS cognitive: personality v1→v2 migration single transaction");
}

async function scenarioMigrationFailureKeepsV1(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await seedLegacyPersonality(fixture);
    const agentBefore = await readFile(fixture.repository.layout.agent, "utf8");

    // Deterministic failure: occupy the backup target for a fixed now.
    const fixedNow = 1_800_000_000_000;
    const stamp = new Date(fixedNow).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      fixture.repository.layout.root, "agents", "echoink", "history",
      `personality-state-v1-${stamp}.json`
    );
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(backupPath, { recursive: true });

    const { PersonalityStateStore } = await import("../harness/memory/personality-state");
    const { DreamStateStore } = await import("../harness/memory/dream-state");
    const { AgentIdentityStateStore } = await import("../harness/memory/agent-identity-state");
    const { SecondaryMemoryStore } = await import("../harness/memory/secondary-memory-store");
    const { migratePersonalityV1ToV2 } = await import("../harness/memory/cognitive-system");
    await assert.rejects(migratePersonalityV1ToV2({
      repository: fixture.repository,
      personalityStore: new PersonalityStateStore(fixture.repository.layout.root),
      dreamStateStore: new DreamStateStore(fixture.repository.layout.root),
      agentIdentityStore: new AgentIdentityStateStore(fixture.repository.layout.root),
      secondaryStore: new SecondaryMemoryStore(path.join(fixture.repository.layout.root, "shared-user", "memory")),
      now: fixedNow
    }));
    rmSync(backupPath, { recursive: true, force: true });

    // 10. Failure keeps the original v1 and old AGENT.md (no half migration).
    const raw = await readJson(fixture.repository.layout.personalityState) as Record<string, unknown>;
    assert.equal(raw.schema, "echoink.personality.v1", "failed migration keeps v1");
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), agentBefore);
    assert.equal((await listMigrationBackups(fixture)).length, 0);
  });
  console.log("PASS cognitive: failed migration keeps original v1 and AGENT.md");
}

async function scenarioMigrationWithoutTemplateKeepsCustomAgent(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    // 12. No template chosen: migration must not overwrite a custom AGENT.md.
    const customAgent = "# 我的自定义 Agent\n\n这是用户手写的画像。\n";
    await writeFile(fixture.repository.layout.agent, customAgent, "utf8");
    await fixture.repository.handleExternalChange({
      event: "change",
      relativePath: "agents/echoink/AGENT.md"
    });
    await seedLegacyPersonality(fixture, { templateId: null });

    await createSystem(fixture, () => null);

    const raw = await readJson(fixture.repository.layout.personalityState) as Record<string, any>;
    assert.equal(raw.schema, "echoink.personality.v2");
    assert.equal(raw.templateId, null);
    for (const dimension of NEW_DIMS) assert.equal(raw.explicit[dimension], null);
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), customAgent,
      "custom AGENT.md must survive migration when no template is selected");
    assert.equal((await listMigrationBackups(fixture)).length, 1);
  });
  console.log("PASS cognitive: migration without template keeps custom AGENT.md");
}

// ---------------------------------------------------------------------------
// R6. Round 6 集成回归（计划 §4–§11）
// ---------------------------------------------------------------------------

// R6-1（修复一）：二级事实在最终上下文中只注入一次，预算就是真实文本。
async function scenarioRecallSingleInjectionBlocks(): Promise<void> {
  const fact = Object.freeze({
    id: "sec_sentinel_fact",
    parentId: "mem_inject_a",
    title: "哨兵事实",
    content: "二级事实唯一注入哨兵 SENTINEL-SECONDARY-CONTENT",
    recallWhen: "测试时",
    matchTerms: ["哨兵"],
    relation: "instance",
    basis: "llm_inferred"
  }) as SecondaryMatchView;
  const makeCandidate = (id: string, title: string) => Object.freeze({
    id,
    kind: "fact",
    status: "current",
    title,
    recallWhen: "相关话题出现时",
    summary: `${title} 的摘要。`,
    date: "2026-08-21",
    basis: "explicit",
    sourceSummary: "",
    score: 0.9,
    matchedSecondaryId: fact.id,
    secondaryMatches: [fact],
    // 索引内部字段：绝不能泄漏进任一注入区块。
    routeTokens: ["route-token-leak"],
    contentTokens: ["content-token-leak"]
  }) as unknown as PersonalMemoryTurnCatalogCandidate;
  const candidates = [makeCandidate("mem_inject_a", "候选甲"), makeCandidate("mem_inject_b", "候选乙")];
  const secondaryFacts = candidates.map((candidate) => ({
    parentId: candidate.id,
    parentTitle: candidate.title,
    fact
  }));

  const blocks = serializeRecallBlocks({
    candidates,
    secondaryFacts,
    exhaustive: true,
    hasMore: false,
    total: 2,
    injected: 2,
    remaining: 0
  });

  // 1. 每条二级事实在最终 combined 中恰好出现一次。
  const sentinelCount = blocks.combined.split("SENTINEL-SECONDARY-CONTENT").length - 1;
  assert.equal(sentinelCount, 1, "each secondary fact must appear exactly once in the final context");
  assert.ok(blocks.secondaryBlock, "secondary block must exist when facts exist");
  assert.equal(blocks.secondaryBlock!.split("SENTINEL-SECONDARY-CONTENT").length - 1, 1,
    "the single occurrence lives in the secondary block");
  assert.ok(!blocks.recallBlock.includes("SENTINEL-SECONDARY-CONTENT"),
    "recall block must not carry full secondary facts");

  // 2. Recall JSON 不含 secondaryFacts；candidates 只保留 matchedSecondaryId。
  assert.ok(!blocks.recallBlock.includes("secondaryFacts"), "recall JSON must not embed secondaryFacts");
  assert.ok(!blocks.recallBlock.includes("secondaryMatches"), "candidates must drop secondaryMatches");
  const recallBody = blocks.recallBlock.slice(
    blocks.recallBlock.indexOf("\n") + 1,
    blocks.recallBlock.lastIndexOf("\n")
  );
  const recallParsed = JSON.parse(recallBody) as {
    candidates: Array<Record<string, unknown>>;
    total: number;
    injected: number;
    remaining: number;
  };
  assert.equal(recallParsed.total, 2);
  assert.equal(recallParsed.injected, 2);
  assert.equal(recallParsed.remaining, 0);
  for (const candidate of recallParsed.candidates) {
    assert.ok(!("secondaryMatches" in candidate));
    assert.equal(candidate.matchedSecondaryId, fact.id, "matchedSecondaryId must survive");
  }

  // 3. 索引字段不进入任一区块。
  assert.ok(!blocks.combined.includes("routeTokens"));
  assert.ok(!blocks.combined.includes("contentTokens"));
  assert.ok(!blocks.combined.includes("route-token-leak"));
  assert.ok(!blocks.combined.includes("content-token-leak"));

  // 4. secondary block 结构与信任标签。
  assert.ok(blocks.secondaryBlock!.startsWith("<echoink_memory_secondary trust=\"llm-inferred-reference\">"));
  assert.ok(blocks.secondaryBlock!.includes("\"secondaryFacts\""));
  assert.ok(blocks.recallBlock.startsWith("<echoink_memory_recall trust=\"user-owned-memory\""));

  // 5. 没有二级事实时完全省略 secondary block。
  const without = serializeRecallBlocks({
    candidates: [],
    secondaryFacts: [],
    exhaustive: true,
    hasMore: false,
    total: 0,
    injected: 0,
    remaining: 0
  });
  assert.equal(without.secondaryBlock, null);
  assert.equal(without.combined, without.recallBlock);

  // 6. 预算函数测量的就是 combined 真实文本。
  const measured = measureFinalInjectionTokens(candidates);
  assert.equal(measured, estimatePiContextTokens(blocks.combined).tokens,
    "budget must measure the exact combined final text");
  console.log("PASS cognitive: recall context injects each secondary fact exactly once");
}

// R6-2（修复二）：首次选择只由 templateId 判断；命名只在身份 revision 0 时必需。
async function scenarioInitialSelectionJudgedByTemplateIdOnly(): Promise<void> {
  // Case A：人格 revision > 0 但 templateId 仍为空、身份 revision 0
  // → 底层仍必须要求完成命名（旧实现误把人格 revision 当成「已初始化」）。
  await withPersonalMemoryFixture(async (fixture) => {
    const halfState: PersonalityState = Object.freeze({
      ...emptyPersonalityState(fixture.now()),
      revision: 3,
      updatedAt: fixture.now()
    });
    await writeFile(fixture.repository.layout.personalityState, personalityStateJson(halfState));
    const system = await createSystem(fixture, () => null);

    await assert.rejects(
      system.selectPersonalityTemplate("executor"),
      /agent_identity_required/u,
      "half-initialized personality must still require first naming"
    );

    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };
    const result = await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "新芽", avatar: { kind: "default" } }
    });
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision + 1,
      "identity + template still commit in ONE transaction");
    assert.equal(result.identity.displayName, "新芽");
    assert.equal(result.identity.revision, 1);
    assert.equal(result.state.templateId, "executor");
    const identityOnDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      revision: number; displayName: string;
    };
    assert.equal(identityOnDisk.displayName, "新芽", "identity must be persisted");
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agent.includes("新芽"), "AGENT.md must use the newly chosen name");
  });

  // Case B：身份已存在（revision > 0）但 templateId 为空
  // → 首次选择保留现有身份，不再要求命名，且预模板清理/重排队仍然生效。
  await withPersonalMemoryFixture(async (fixture) => {
    await writeFile(fixture.repository.layout.agentIdentity, agentIdentityStateJson({
      schema: AGENT_IDENTITY_STATE_SCHEMA,
      revision: 2,
      displayName: "已有身份",
      avatar: Object.freeze({ kind: "default" as const }),
      updatedAt: fixture.now()
    }));
    const halfState: PersonalityState = Object.freeze({
      ...emptyPersonalityState(fixture.now()),
      revision: 3,
      updatedAt: fixture.now()
    });
    await writeFile(fixture.repository.layout.personalityState, personalityStateJson(halfState));
    const system = await createSystem(fixture, () => null);
    const memory = await createMemory(fixture, {
      title: "半状态记忆",
      content: "首次选择必须把这条记忆重新排队做梦。"
    });

    const result = await system.selectPersonalityTemplate("executor");
    assert.equal(result.state.templateId, "executor");
    assert.equal(result.identity.displayName, "已有身份", "existing identity must be kept");
    assert.equal(result.identity.revision, 2, "kept identity must not gain a revision");
    const identityOnDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      revision: number; displayName: string;
    };
    assert.equal(identityOnDisk.revision, 2);
    assert.equal(identityOnDisk.displayName, "已有身份");
    assert.ok(result.agent.includes("已有身份"));

    const dreamState = await readJson(fixture.repository.layout.dreamState) as Record<string, any>;
    assert.ok((dreamState.pendingMemoryIds as string[]).includes(memory.id),
      "initial selection must requeue current memories even with existing identity");
    assert.equal(dreamState.lastProcessedMemoryRevision, 0);
  });

  // Case C：reset 只在已有 templateId 时成立。
  await withPersonalMemoryFixture(async (fixture) => {
    await writeFile(fixture.repository.layout.agentIdentity, agentIdentityStateJson({
      schema: AGENT_IDENTITY_STATE_SCHEMA,
      revision: 1,
      displayName: "小重置",
      avatar: Object.freeze({ kind: "default" as const }),
      updatedAt: fixture.now()
    }));
    const system = await createSystem(fixture, () => null);
    await assert.rejects(
      system.selectPersonalityTemplate("executor", { reset: true }),
      /personality_reset_requires_template/u,
      "reset must require an existing templateId"
    );
  });
  console.log("PASS cognitive: pre-template revision still requires first naming");
}

// R6-3（修复二）：首次选择必须清理模板前证据并重排队，保留 learnedRequirements。
async function scenarioInitialTemplateClearsPreTemplateEvidence(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => fakeDreamLlm(() => JSON.stringify({
      ...EMPTY_DREAM_OUTPUT,
      personalitySignals: [{
        dimension: "sharpness",
        direction: "decrease",
        strength: 0.8,
        evidence: "模板前信号"
      }],
      agentRequirements: ["模板前要求必须保留"],
      userProfileItems: [{ section: "preference", profileKey: "preference.workflow", text: "模板前画像条目" }]
    })));
    const memories: PersonalMemoryRecord[] = [];
    for (const title of ["模板前记忆甲", "模板前记忆乙", "模板前记忆丙"]) {
      memories.push(await createMemory(fixture, { title, content: `${title}的内容。` }));
    }
    await system.settleDreamEnqueue();
    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    assert.equal(run1!.processedMemoryIds.length, 3);

    const pre = await system.readPersonalityState();
    assert.equal(pre.templateId, null);
    assert.ok(pre.observed.sharpness, "pre-template observed trait must exist before cleanup");
    assert.equal(pre.observed.sharpness!.sourceMemoryIds.length, 3);
    assert.ok(pre.learnedRequirements.some(
      (requirement) => requirement.status === "current" && requirement.text === "模板前要求必须保留"
    ));
    assert.ok(pre.processedSources.length >= 3);

    const manifestBefore = await readJson(fixture.repository.layout.manifest) as { revision: number };
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "新芽", avatar: { kind: "default" } }
    });
    const manifestAfter = await readJson(fixture.repository.layout.manifest) as { revision: number };
    assert.equal(manifestAfter.revision, manifestBefore.revision + 1,
      "cleanup + template + identity must commit in ONE transaction");

    const post = await system.readPersonalityState();
    const template = getPersonalityTemplate("executor")!;
    assert.equal(post.templateId, "executor");
    // 1. explicit 基线 = 模板分数。
    for (const dimension of TRAIT_DIMENSIONS) {
      assert.equal(post.explicit[dimension]!.score, template.scores[dimension]);
    }
    // 2. 模板前 observed 标记 superseded 并保留历史。
    assert.equal(post.observed.sharpness, null, "pre-template observed must be superseded");
    assert.ok(post.history.some(
      (record) => record.dimension === "sharpness" && record.reason === "initial_template_selection"
    ));
    // 3. 候选与 processedSources 清空。
    assert.equal(post.candidates.length, 0, "pre-template candidates must be cleared");
    assert.equal(post.processedSources.length, 0, "processedSources must be cleared");
    // 4. learnedRequirements 保留。
    assert.ok(post.learnedRequirements.some(
      (requirement) => requirement.status === "current" && requirement.text === "模板前要求必须保留"
    ), "learnedRequirements must survive the initial selection");

    // 5. 有效 Memory 全部重新入队；进度归零；运行时间保留。
    const dreamState = await readJson(fixture.repository.layout.dreamState) as Record<string, any>;
    for (const memory of memories) {
      assert.ok((dreamState.pendingMemoryIds as string[]).includes(memory.id),
        `${memory.id} must be requeued`);
    }
    assert.equal(dreamState.lastProcessedMemoryRevision, 0);
    assert.equal(dreamState.backfillCursor, null);
    assert.ok((dreamState.lastRunAt as number) > 0, "lastRunAt preserved");
    assert.ok((dreamState.lastSuccessAt as number) > 0, "lastSuccessAt preserved");

    // 6. 模板后重新做梦会重新处理这些 Memory。
    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    assert.ok(run2!.processedMemoryIds.length > 0);
    const again = await system.readPersonalityState();
    assert.ok(again.processedSources.length > 0, "memories reprocessed after template selection");
  });
  console.log("PASS cognitive: initial template clears pre-template trait evidence and requeues memory");
}

// R6-4（修复三）：v1 迁移失败 → fail-closed；未知 schema / 损坏 JSON → 拒绝构造。
async function scenarioMigrationFailureBlocksCognitiveWriters(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await seedLegacyPersonality(fixture);
    const legacyText = await readFile(fixture.repository.layout.personalityState, "utf8");
    const agentBefore = await readFile(fixture.repository.layout.agent, "utf8");

    const { mkdirSync, rmSync } = await import("node:fs");
    const FIXED_NOW = 1_800_000_000_000;
    let repositoryCounter = 0;
    const repository = new PersonalMemoryRepository({
      vaultPath: fixture.vaultPath,
      vaultId: fixture.vaultId,
      now: () => FIXED_NOW,
      idFactory: () => `mem_r6_migration_${++repositoryCounter}`
    });
    await repository.initialize();
    const createAttempt = () => CognitiveSystem.create({
      repository,
      llm: () => null,
      getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      isForegroundBusy: () => false,
      registerInterval: () => {},
      now: () => FIXED_NOW
    });

    // 1. 确定性迁移失败（占用备份目标 → 事务真实失败并回滚）→ create()
    //    fail-closed 抛稳定错误；v1/AGENT.md 原样保留、无任何残留。
    const stamp = new Date(FIXED_NOW).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      fixture.repository.layout.root, "agents", "echoink", "history",
      `personality-state-v1-${stamp}.json`
    );
    mkdirSync(backupPath, { recursive: true });
    await assert.rejects(createAttempt(), /personality_migration_blocked/u);
    rmSync(backupPath, { recursive: true, force: true });
    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), legacyText,
      "failed migration must keep the v1 file untouched");
    assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), agentBefore,
      "failed migration must keep AGENT.md untouched");
    assert.equal((await listMigrationBackups(fixture)).length, 0, "no backup on failed migration");
    assert.ok(!(await cognitivePathExists(fixture.repository.layout.dreamState)),
      "no dream-state residue on failed migration");

    // 2. 未知 schema → personality_state_invalid（不得降级成空状态继续写）。
    await writeFile(fixture.repository.layout.personalityState,
      JSON.stringify({ schema: "echoink.personality.v9", revision: 1 }, null, 2));
    await assert.rejects(createAttempt(), /personality_state_invalid/u);
    assert.equal((await readJson(fixture.repository.layout.personalityState) as { schema: string }).schema,
      "echoink.personality.v9", "unknown schema file must stay untouched");

    // 3. 损坏 JSON → personality_state_invalid。
    await writeFile(fixture.repository.layout.personalityState, "{{{ 这不是 JSON");
    await assert.rejects(createAttempt(), /personality_state_invalid/u);

    // 4. 恢复 v1、解除故障后，重试必须成功（main.ts 不得缓存失败 flight）。
    await writeFile(fixture.repository.layout.personalityState, legacyText);
    const system = await createAttempt();
    const migrated = await system.readPersonalityState();
    assert.equal(migrated.schema, PERSONALITY_STATE_SCHEMA);
    assert.equal(migrated.templateId, "advisor", "v1 templateId survives migration");
    assert.equal((await listMigrationBackups(fixture)).length, 1, "retry writes the backup once");
  });

  // 5. 文件缺失仍是合法初始状态：create 成功且不落盘空人格文件。
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    assert.ok(!(await cognitivePathExists(fixture.repository.layout.personalityState)),
      "create must not write a personality file for a fresh vault");
    const state = await system.readPersonalityState();
    assert.equal(state.templateId, null);
  });
  console.log("PASS cognitive: migration failure blocks cognitive writers until retry succeeds");
}

// R6-5 + 全局 Memory CAS：做梦中改名推进全局 revision，本轮不得提交
// stale Provider 输出；来源保留到下一轮，新名称始终获胜。
async function scenarioRenameDuringDreamKeepsNewName(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    let providerCalls = 0;
    let systemRef: CognitiveSystem;
    const llm: DreamLlmPort = {
      call: async () => {
        providerCalls += 1;
        // 模型响应前用户在设置里改名：真实并发窗口。
        await systemRef.updateAgentIdentity({
          displayName: "梦中新名",
          avatar: { kind: "default" }
        });
        return JSON.stringify(EMPTY_DREAM_OUTPUT);
      }
    };
    const system = await createSystem(fixture, () => llm);
    systemRef = system;
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小墨", avatar: { kind: "default" } }
    });
    const memory = await createMemory(fixture, {
      title: "做梦改名记忆",
      content: "做梦期间的改名不能丢失。"
    });
    await system.settleDreamEnqueue();
    const run = await system.forceDreamRun();
    assert.equal(providerCalls, 1, "one Dream attempt calls Provider once");
    assert.ok(run);
    assert.equal(run!.committed, false, "rename revision conflict rejects stale Dream output");
    assert.match(run!.error ?? "", /Memory revision conflict/u);
    await system.settleDreamEnqueue();
    assert.ok(system.dreamStateStore.peek().pendingMemoryIds.includes(memory.id),
      "rename conflict keeps the source pending for a fresh round");
    const identity = await system.readAgentIdentity();
    assert.equal(identity.displayName, "梦中新名");
    assert.equal(identity.revision, 2);
    let agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agent.includes("梦中新名"), "final AGENT.md must use the new name");
    assert.ok(!agent.includes("小墨"), "AGENT.md must not revert to the old name");

    const retry = await system.forceDreamRun();
    assert.ok(retry?.committed, "next round commits against the latest Memory revision");
    assert.equal(providerCalls, 2, "a fresh global revision requires a fresh Provider round");
    assert.ok(retry!.processedMemoryIds.includes(memory.id));
    agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agent.includes("梦中新名"));
  });
  console.log("PASS cognitive: rename conflict keeps pending and preserves the new identity");
}

// R6-6（修复四）：两个身份编辑并发 → CAS 保证恰好一个成功，无静默覆盖。
async function scenarioIdentityCasConcurrentEdits(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "初始名", avatar: { kind: "default" } }
    });
    const results = await Promise.allSettled([
      system.updateAgentIdentity({ displayName: "并发甲", avatar: { kind: "default" } }),
      system.updateAgentIdentity({ displayName: "并发乙", avatar: { kind: "default" } })
    ]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    assert.equal(succeeded.length, 1, "exactly one concurrent identity edit may win");
    assert.equal(failed.length, 1);
    const reason = (failed[0] as PromiseRejectedResult).reason;
    assert.match(String(reason instanceof Error ? reason.message : reason), /identity_revision_conflict/u);
    const onDisk = await readJson(fixture.repository.layout.agentIdentity) as {
      revision: number; displayName: string;
    };
    assert.equal(onDisk.revision, 2, "identity revision must advance exactly once");
    // 哪个并发编辑获胜由串行 lane 的入队顺序决定（微任务调度不确定）；
    // 不变量是：落盘名称 = 获胜者提交的名称，失败者不留下任何痕迹。
    const winner = (succeeded[0] as PromiseFulfilledResult<{
      identity: Readonly<{ displayName: string }>;
    }>).value;
    assert.ok(winner.identity.displayName === "并发甲" || winner.identity.displayName === "并发乙");
    assert.equal(onDisk.displayName, winner.identity.displayName,
      "disk identity must match the winner, no silent overwrite by the loser");
    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agent.includes(onDisk.displayName), "AGENT.md must carry the winning name");
  });
  console.log("PASS cognitive: concurrent identity edits resolve via revision CAS");
}

// R6-7（修复四）：迁移与并发改名竞争 → 迁移干净失败，v1 原样保留。
async function scenarioIdentityCasMigrationRace(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await seedLegacyPersonality(fixture);
    const legacyText = await readFile(fixture.repository.layout.personalityState, "utf8");
    const root = fixture.repository.layout.root;
    const identityStore = new AgentIdentityStateStore(root);
    await identityStore.read(); // 尚无文件 → 缓存默认 revision 0

    // 并发写路径抢先落盘 revision 5 的身份。
    await writeFile(fixture.repository.layout.agentIdentity, agentIdentityStateJson({
      schema: AGENT_IDENTITY_STATE_SCHEMA,
      revision: 5,
      displayName: "并发改名",
      avatar: Object.freeze({ kind: "default" as const }),
      updatedAt: fixture.now()
    }));

    await assert.rejects(migratePersonalityV1ToV2({
      repository: fixture.repository,
      personalityStore: new PersonalityStateStore(root),
      dreamStateStore: new DreamStateStore(root),
      agentIdentityStore: identityStore,
      secondaryStore: new SecondaryMemoryStore(path.join(root, "shared-user", "memory")),
      now: fixture.now()
    }), /identity_revision_conflict/u);

    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), legacyText,
      "v1 must survive the lost race");
    assert.equal((await listMigrationBackups(fixture)).length, 0);
    assert.ok(!(await cognitivePathExists(fixture.repository.layout.dreamState)));
  });
  console.log("PASS cognitive: migration loses cleanly when identity changed mid-flight");
}

// R6-8（修复五）：同一 Memory 更高 revision 重新处理 → 先撤销旧派生，再应用新输出。
async function scenarioReprocessedRevisionRevokesDerivedSources(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const callsForA: number[] = [];
    const outputRound1A = {
      ...EMPTY_DREAM_OUTPUT,
      personalitySignals: [
        { dimension: "sharpness", direction: "decrease", strength: 0.9, evidence: "温和信号" },
        { dimension: "boldness", direction: "increase", strength: 0.9, evidence: "果敢信号" }
      ],
      agentRequirements: ["回答要更温和"],
      userProfileItems: [{ section: "preference", profileKey: "preference.tone", text: "用户偏好温和语气" }]
    };
    const outputRound2A = {
      ...EMPTY_DREAM_OUTPUT,
      personalitySignals: [
        { dimension: "creativity", direction: "increase", strength: 0.9, evidence: "创意信号" }
      ],
      agentRequirements: ["回答要更犀利"],
      userProfileItems: [{ section: "preference", profileKey: "preference.tone", text: "用户偏好犀利表达" }]
    };
    const outputOthers = {
      ...EMPTY_DREAM_OUTPUT,
      personalitySignals: [
        { dimension: "sharpness", direction: "decrease", strength: 0.9, evidence: "温和信号" }
      ]
    };
    const llm: DreamLlmPort = {
      call: async (input) => {
        const parsed = JSON.parse(input.userPrompt) as { memory: { title: string } };
        if (parsed.memory.title === "修订记忆") {
          callsForA.push(1);
          return JSON.stringify(callsForA.length === 1 ? outputRound1A : outputRound2A);
        }
        return JSON.stringify(outputOthers);
      }
    };
    const system = await createSystem(fixture, () => llm);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "小修", avatar: { kind: "default" } }
    });
    const memoryA = await createMemory(fixture, { title: "修订记忆", content: "第一版内容。" });
    await createMemory(fixture, { title: "佐证记忆乙", content: "乙的内容。" });
    await createMemory(fixture, { title: "佐证记忆丙", content: "丙的内容。" });
    await system.settleDreamEnqueue();
    const run1 = await system.forceDreamRun();
    assert.ok(run1);
    assert.equal(run1!.processedMemoryIds.length, 3);

    const pre = await system.readPersonalityState();
    assert.ok(pre.observed.sharpness, "observed established from three sources");
    assert.ok(pre.candidates.some(
      (candidate) => candidate.dimension === "boldness" && candidate.sourceMemoryId === memoryA.id
    ), "pre-revision boldness candidate from A");
    assert.ok(pre.learnedRequirements.some(
      (requirement) => requirement.status === "current" && requirement.text === "回答要更温和"
    ));
    const preProfile = parseUserProfileState(
      await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>
    );
    assert.ok(preProfile!.items.some(
      (item) => item.status === "current" && item.text === "用户偏好温和语气"
    ));
    assert.ok((await readFile(fixture.repository.layout.user, "utf8")).includes("用户偏好温和语气"));

    // 用户编辑 = forget + restore（同一 ID，更高 revision）。
    await fixture.repository.write({
      operation: "forget",
      targetId: memoryA.id,
      reason: "R6 修订测试",
      explicitForget: true
    }, fixture.runtime({ explicitlyAuthorized: true }));
    await fixture.repository.restoreForgotten(memoryA.id);
    await system.settleDreamEnqueue();

    const run2 = await system.forceDreamRun();
    assert.ok(run2);
    assert.ok(run2!.processedMemoryIds.includes(memoryA.id), "restored memory must be reprocessed");

    const post = await system.readPersonalityState();
    // 旧 revision 的贡献全部退出：
    assert.ok(!post.candidates.some((candidate) => candidate.sourceMemoryId === memoryA.id
      && candidate.dimension === "boldness"),
      "old boldness candidate from the old revision must be revoked");
    const sharpness = post.observed.sharpness;
    assert.ok(sharpness, "observed keeps the two untouched sources");
    assert.ok(!sharpness!.sourceMemoryIds.includes(memoryA.id),
      "old revision's id must leave observed sourceMemoryIds");
    assert.ok(sharpness!.sourceMemoryIds.length === 2);
    const mildRequirement = post.learnedRequirements.find(
      (requirement) => requirement.text === "回答要更温和"
    );
    assert.ok(mildRequirement && mildRequirement.status === "superseded",
      "requirement sourced only from A must be superseded");
    // 新 revision 的输出随后应用：
    assert.ok(post.candidates.some(
      (candidate) => candidate.dimension === "creativity" && candidate.sourceMemoryId === memoryA.id
    ), "new revision output applied after revocation");
    assert.ok(post.learnedRequirements.some(
      (requirement) => requirement.status === "current" && requirement.text === "回答要更犀利"
    ));

    const agent = await readFile(fixture.repository.layout.agent, "utf8");
    assert.ok(agent.includes("回答要更犀利"), "new requirement reaches AGENT.md");
    assert.ok(!agent.includes("回答要更温和"), "old requirement leaves AGENT.md");

    const postProfile = parseUserProfileState(
      await readJson(fixture.repository.layout.userProfileState) as Record<string, unknown>
    );
    assert.ok(!postProfile!.items.some((item) => item.text === "用户偏好温和语气"),
      "the closed slot does not retain a second stale profile object");
    assert.ok(postProfile!.items.some(
      (item) => item.status === "current" && item.text === "用户偏好犀利表达"
    ));
    const userMd = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(userMd.includes("用户偏好犀利表达"));
    assert.ok(!userMd.includes("用户偏好温和语气"), "old profile text leaves USER.md");
  });
  console.log("PASS cognitive: reprocessed memory revision removes stale personality and profile sources");
}

// R6-9（修复六）：宽 key 重做梦保留旧 ID 与命中历史；保留旧事实后同轮不再产生重复。
async function scenarioBroadKeyRedreamPreservesIdAndHitHistory(): Promise<void> {
  const now = 1_800_000_000_000;
  const makeOld = (confidence: number) => applySecondaryHit(createSecondaryRecord({
    parentId: "mem_r6_broad",
    title: "手冲咖啡",
    content: "旧内容。",
    recallWhen: "相关话题出现时",
    matchTerms: ["咖啡豆"],
    relation: "instance",
    reason: "测试",
    supportLevel: "strong_inference",
    evidence: "旧证据",
    basis: "llm_inferred",
    confidence,
    sourceMemoryRevision: 1,
    now
  }), now + 100);

  // (a) 宽 key 替换 = 原地更新：旧 ID / hitCount / lastHitAt / createdAt 保留。
  const old = makeOld(0.70);
  const result = reconcileSecondaryForParent({
    parentId: "mem_r6_broad",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [old],
    candidates: [Object.freeze({
      title: "手冲咖啡",
      content: "新内容。",
      recallWhen: "相关话题出现时",
      matchTerms: ["手冲", "滤纸"],
      relation: "instance" as const,
      supportLevel: "direct" as const,
      reason: "测试",
      evidence: "新证据"
    })],
    now: now + 200
  });
  const current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1);
  assert.equal(current[0].id, old.id, "broad-key replace keeps the old id");
  assert.equal(current[0].hitCount, old.hitCount, "hitCount survives");
  assert.equal(current[0].lastHitAt, old.lastHitAt, "lastHitAt survives");
  assert.equal(current[0].createdAt, old.createdAt, "createdAt survives");
  assert.equal(current[0].confidence, computeSecondaryConfidence("direct", "explicit", "instance"),
    "confidence updated to the winning candidate");
  assert.equal(current[0].content, "新内容。");
  assert.equal(current[0].revision, old.revision + 1);
  assert.equal(result.factsCreated, 0);
  assert.equal(result.factsReused, 1);
  assert.equal(result.factsRetired, 0);

  // (b) 旧事实被保留后，其宽 key 必须进入 reserved：同轮后来者不得再建重复。
  const kept = makeOld(0.80);
  const dupRound = reconcileSecondaryForParent({
    parentId: "mem_r6_broad",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [kept],
    candidates: [
      Object.freeze({
        title: "手冲咖啡",
        content: "低置信候选。",
        recallWhen: "相关话题出现时",
        matchTerms: ["甲词"],
        relation: "instance" as const,
        supportLevel: "strong_inference" as const,
        reason: "测试",
        evidence: "证据甲"
      }),
      Object.freeze({
        title: "手冲咖啡",
        content: "高置信候选。",
        recallWhen: "相关话题出现时",
        matchTerms: ["乙词"],
        relation: "instance" as const,
        supportLevel: "direct" as const,
        reason: "测试",
        evidence: "证据乙"
      })
    ],
    now: now + 300
  });
  const dupCurrent = dupRound.records.filter((record) => record.status === "current");
  assert.equal(dupCurrent.length, 1, "no same-round duplicate after a kept old fact");
  assert.equal(dupCurrent[0].id, kept.id, "the kept old fact owns the slot");
  assert.equal(dupRound.factsCreated, 0, "later candidates must not create duplicates");
  console.log("PASS cognitive: broad-key redream preserves secondary id and hit history");
}

// Closed 24-slot profileKey prompt catalog.
async function scenarioProfileKeyPromptCatalogBounded(): Promise<void> {
  const base = emptyUserProfileState(1_800_000_000_000);
  assert.equal(PROFILE_KEY_PROMPT_CAP, 24);
  assert.equal(USER_PROFILE_SLOTS.length, 24);
  const catalog = profileKeyPromptCatalog(base);
  assert.equal(catalog.length, 24);
  assert.deepEqual(
    catalog,
    USER_PROFILE_SLOTS.map(({ section, profileKey }) => ({ section, profileKey }))
  );
  assert.deepEqual(profileKeyPromptCatalog(base, [
    { section: "preference", profileKey: "arbitrary.dynamic.key" }
  ]), catalog, "same-round dynamic keys cannot expand the closed catalog");
  assert.equal(new Set(catalog.map((entry) => entry.profileKey)).size, 24);
  console.log("PASS cognitive: profile-key prompt catalog is the closed 24-slot taxonomy");
}

// ---------------------------------------------------------------------------
// Round 6.1 修复一：宽 key reconcile 的唯一消费、交叉别名封闭与统一预算
// ---------------------------------------------------------------------------

/** Round 6.1 测试用候选工厂。 */
function r61Candidate(input: {
  title: string;
  matchTerms: readonly string[];
  relation?: SecondaryFactCandidate["relation"];
  supportLevel?: SecondaryFactCandidate["supportLevel"];
  content?: string;
}): SecondaryFactCandidate {
  return Object.freeze({
    title: input.title,
    content: input.content ?? `${input.title} 的内容。`,
    recallWhen: "相关话题出现时",
    matchTerms: Object.freeze([...input.matchTerms]),
    relation: input.relation ?? "instance",
    supportLevel: input.supportLevel ?? "strong_inference",
    reason: "测试",
    evidence: `${input.title} 的证据`
  });
}

/** Round 6.1 测试用旧 llm 事实工厂。 */
function r61OldFact(input: {
  parentId: string;
  title: string;
  matchTerms: readonly string[];
  relation?: SecondaryFactCandidate["relation"];
  confidence: number;
  now: number;
  hit?: boolean;
}): ReturnType<typeof createSecondaryRecord> {
  const record = createSecondaryRecord({
    parentId: input.parentId,
    title: input.title,
    content: `${input.title} 的旧内容。`,
    recallWhen: "相关话题出现时",
    matchTerms: input.matchTerms,
    relation: input.relation ?? "instance",
    reason: "测试",
    supportLevel: "strong_inference",
    evidence: `${input.title} 的旧证据`,
    basis: "llm_inferred",
    confidence: input.confidence,
    sourceMemoryRevision: 1,
    now: input.now
  });
  return input.hit ? applySecondaryHit(record, input.now + 10) : record;
}

// 场景 1：交叉别名必须封闭——旧事实被一个候选消费后，旧记录与候选各自的
// title/terms 全部进入 reserved，后续候选不得借任一别名创建重复事实。
async function scenarioSecondaryCrossAliasClosed(): Promise<void> {
  const now = 1_800_000_000_000;

  // (a) 保留分支：旧事实 confidence 更高被原样保留。候选一带来新 terms [手冲]，
  //     候选二借 [手冲] 这个别名不得再建重复。
  const keptOld = r61OldFact({
    parentId: "mem_r61_alias", title: "咖啡偏好", matchTerms: ["咖啡豆"],
    confidence: 0.90, now
  });
  const keepRound = reconcileSecondaryForParent({
    parentId: "mem_r61_alias",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [keptOld],
    candidates: [
      // 候选一：title 命中旧事实，confidence 0.70 < 0.90 → 保留分支。
      r61Candidate({ title: "咖啡偏好", matchTerms: ["手冲"] }),
      // 候选二：借候选一带来的别名「手冲」试图另建。
      r61Candidate({ title: "饮品偏好", matchTerms: ["手冲"] })
    ],
    now: now + 100
  });
  const keepCurrent = keepRound.records.filter((record) => record.status === "current");
  assert.equal(keepCurrent.length, 1, "cross alias (keep branch) must not create a duplicate");
  assert.equal(keepCurrent[0].id, keptOld.id, "the old fact itself survives");
  assert.equal(keepCurrent[0].revision, keptOld.revision, "kept old fact is untouched");
  assert.equal(keepRound.factsCreated, 0, "no extra id may be created via cross alias");

  // (b) 替换分支：候选一 confidence 更高原地替换旧事实。旧记录自己的 terms
  //     [咖啡豆] 也必须进入 reserved，候选二借它不得再命中已消费的旧记录。
  const replacedOld = r61OldFact({
    parentId: "mem_r61_alias", title: "咖啡偏好", matchTerms: ["咖啡豆"],
    confidence: 0.70, now
  });
  const replaceRound = reconcileSecondaryForParent({
    parentId: "mem_r61_alias",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [replacedOld],
    candidates: [
      r61Candidate({ title: "咖啡偏好", matchTerms: ["手冲"], supportLevel: "direct" }),
      // 候选二：借旧记录自己的 terms 别名「咖啡豆」试图二次消费同一旧 ID。
      r61Candidate({ title: "茶饮偏好", matchTerms: ["咖啡豆"], supportLevel: "direct" })
    ],
    now: now + 200
  });
  const replaceCurrent = replaceRound.records.filter((record) => record.status === "current");
  assert.equal(replaceCurrent.length, 1, "cross alias (replace branch) must not create a duplicate");
  assert.equal(replaceCurrent[0].id, replacedOld.id, "in-place update keeps the old id");
  assert.equal(replaceRound.factsCreated, 0, "no extra id via the old record's own alias");
  assert.equal(replaceRound.factsReused, 1);
  console.log("PASS cognitive: secondary cross aliases stay closed within one reconcile round");
}

// 场景 2：同一旧 ID 被两个候选从不同入口（title / matchTerms）命中时，
// 只能消费一次：finalRecords 唯一 ID、命中历史保留、fileChange/计数唯一。
async function scenarioSecondaryOldIdConsumedOnce(): Promise<void> {
  const now = 1_800_000_000_000;
  const old = r61OldFact({
    parentId: "mem_r61_dual", title: "咖啡偏好", matchTerms: ["咖啡豆"],
    confidence: 0.70, now, hit: true
  });
  const result = reconcileSecondaryForParent({
    parentId: "mem_r61_dual",
    parentBasis: "explicit",
    parentRevision: 3,
    existing: [old],
    candidates: [
      // 候选一：通过旧 title 命中（confidence 更高 → 原地替换）。
      r61Candidate({ title: "咖啡偏好", matchTerms: ["滤纸"], supportLevel: "direct" }),
      // 候选二：通过旧 matchTerms 命中同一旧 ID。
      r61Candidate({ title: "茶饮偏好", matchTerms: ["咖啡豆"], supportLevel: "direct" })
    ],
    now: now + 100
  });
  const current = result.records.filter((record) => record.status === "current");
  assert.equal(current.length, 1, "one old id may be consumed only once");
  assert.equal(current[0].id, old.id);
  assert.equal(current[0].hitCount, old.hitCount, "hitCount survives");
  assert.equal(current[0].lastHitAt, old.lastHitAt, "lastHitAt survives");
  assert.equal(current[0].createdAt, old.createdAt, "createdAt survives");
  assert.equal(current[0].revision, old.revision + 1, "revision advances exactly once");
  const allIds = result.records.map((record) => record.id);
  assert.equal(new Set(allIds).size, allIds.length, "final records must carry unique ids");
  const fileWrites = result.fileChanges.filter((change) => change.relativePath === old.file);
  assert.equal(fileWrites.length, 1, "the same file changes at most once");
  assert.equal(result.factsReused, 1, "factsReused counts the fact once");
  assert.equal(result.factsCreated, 0);
  console.log("PASS cognitive: one old secondary id is consumed once per reconcile round");
}

// 场景 3：keptOld 必须先计入总数预算，剩余 slot 才交给新候选（7 keptOld +
// 8 合格候选 → 最终 10 条，而不是 15 条）。
async function scenarioSecondaryKeptOldOccupiesTotalBudget(): Promise<void> {
  const now = 1_800_000_000_000;
  // 7 条 keptOld：associated 调整 −0.15，其 matcher 用 direct（0.70）才能过
  // 0.60 门槛；其余 relation 用 strong_inference 即可。
  const relations = ["instance", "instance", "category", "category", "attribute", "context", "associated"] as const;
  const oldFacts = relations.map((relation, index) => r61OldFact({
    parentId: "mem_r61_total", title: `保留事实${index + 1}`,
    matchTerms: [`保留词${index + 1}`], relation, confidence: 0.90, now
  }));
  const keepMatchers = relations.map((relation, index) => r61Candidate({
    title: `保留事实${index + 1}`,
    matchTerms: [`保留词${index + 1}`],
    relation,
    supportLevel: relation === "associated" ? "direct" : "strong_inference"
  }));
  // 8 条新候选全部过门槛；keptOld 占满 instance/category 配额后，只剩
  // attribute/context/associated 各一个位置 → 最多再选 3 条。
  const newRelations = ["attribute", "context", "associated", "attribute", "context", "associated", "instance", "category"] as const;
  const newCandidates = newRelations.map((relation, index) => r61Candidate({
    title: `新候选${index + 1}`, matchTerms: [`新词${index + 1}`], relation,
    supportLevel: "direct"
  }));
  const result = reconcileSecondaryForParent({
    parentId: "mem_r61_total",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: oldFacts,
    candidates: [...keepMatchers, ...newCandidates],
    now: now + 100
  });
  const current = result.records.filter((record) => record.status === "current");
  assert.ok(current.length <= SECONDARY_MAX_PER_PARENT,
    `current secondaries must never exceed ${SECONDARY_MAX_PER_PARENT}, got ${current.length}`);
  const keptIds = new Set(oldFacts.map((record) => record.id));
  const keptCount = current.filter((record) => keptIds.has(record.id)).length;
  assert.equal(keptCount, 7, "all 7 matched old facts stay");
  assert.equal(current.length - keptCount, SECONDARY_MAX_PER_PARENT - 7,
    "only the remaining slots may go to new candidates");
  const ids = result.records.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids in final records");
  console.log("PASS cognitive: keptOld occupies the total budget before new candidates");
}

// 场景 4：keptOld 也占 relation 配额——某 relation 已被 2 条 keptOld 占满时，
// 同 relation 的高分新候选不得入选，位置让给其他 relation。
async function scenarioSecondaryKeptOldOccupiesRelationBudget(): Promise<void> {
  const now = 1_800_000_000_000;
  const oldA = r61OldFact({
    parentId: "mem_r61_relation", title: "旧实例甲", matchTerms: ["实甲"],
    relation: "instance", confidence: 0.90, now
  });
  const oldB = r61OldFact({
    parentId: "mem_r61_relation", title: "旧实例乙", matchTerms: ["实乙"],
    relation: "instance", confidence: 0.90, now
  });
  const result = reconcileSecondaryForParent({
    parentId: "mem_r61_relation",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [oldA, oldB],
    candidates: [
      // 两条低置信同名候选触发 keptOld 保留。
      r61Candidate({ title: "旧实例甲", matchTerms: ["实甲"], relation: "instance" }),
      r61Candidate({ title: "旧实例乙", matchTerms: ["实乙"], relation: "instance" }),
      // 高分新候选：instance 配额已满，不得入选；category 仍有位置。
      r61Candidate({ title: "高分新实例", matchTerms: ["新实"], relation: "instance", supportLevel: "direct" }),
      r61Candidate({ title: "高分新类别", matchTerms: ["新类"], relation: "category", supportLevel: "direct" })
    ],
    now: now + 100
  });
  const current = result.records.filter((record) => record.status === "current");
  const titles = current.map((record) => record.title);
  assert.ok(titles.includes("旧实例甲") && titles.includes("旧实例乙"),
    "both keptOld facts stay");
  assert.ok(!titles.includes("高分新实例"),
    "instance quota filled by keptOld blocks another instance candidate");
  assert.ok(titles.includes("高分新类别"),
    "remaining slot goes to an uncovered relation");
  assert.equal(current.filter((record) => record.relation === "instance").length, 2,
    "same relation never exceeds 2");
  assert.equal(result.factsCreated, 1, "only the category candidate is created");
  console.log("PASS cognitive: keptOld occupies relation quota before new candidates");
}

// 场景 5：父节点硬上限为 10（5 relation × 2）；门槛与 0 条语义不变。
async function scenarioSecondaryPerParentCapIsTen(): Promise<void> {
  const now = 1_800_000_000_000;
  assert.equal(SECONDARY_MAX_PER_PARENT, 10, "per-parent hard cap must be 10");

  // (a) 5 种 relation × 2 条合格候选 → 恰好全部保存 10 条。
  const relations = ["category", "instance", "attribute", "context", "associated"] as const;
  const tenCandidates: SecondaryFactCandidate[] = [];
  for (const relation of relations) {
    for (let index = 0; index < 2; index += 1) {
      tenCandidates.push(r61Candidate({
        title: `事实${relation}${index + 1}`,
        matchTerms: [`词${relation}${index + 1}`],
        relation,
        supportLevel: "direct"
      }));
    }
  }
  const full = reconcileSecondaryForParent({
    parentId: "mem_r61_cap", parentBasis: "explicit", parentRevision: 1,
    existing: [], candidates: tenCandidates, now
  });
  const fullCurrent = full.records.filter((record) => record.status === "current");
  assert.equal(fullCurrent.length, 10, "5 relations x 2 fits exactly under the cap");
  for (const relation of relations) {
    assert.equal(fullCurrent.filter((record) => record.relation === relation).length, 2);
  }

  // (b) 只有 2 条达到门槛时仍只保存 2 条。
  const partial = reconcileSecondaryForParent({
    parentId: "mem_r61_cap", parentBasis: "explicit", parentRevision: 1,
    existing: [],
    candidates: [
      r61Candidate({ title: "达标甲", matchTerms: ["达标甲"], supportLevel: "direct" }),
      r61Candidate({ title: "达标乙", matchTerms: ["达标乙"], relation: "category", supportLevel: "direct" }),
      r61Candidate({ title: "不达标丙", matchTerms: ["不达标丙"], relation: "attribute", supportLevel: "weak_inference" })
    ],
    now: now + 100
  });
  const partialCurrent = partial.records.filter((record) => record.status === "current");
  assert.equal(partialCurrent.length, 2, "only threshold-passing candidates persist");

  // (c) 全部低于门槛时保存 0 条。
  const none = reconcileSecondaryForParent({
    parentId: "mem_r61_cap", parentBasis: "explicit", parentRevision: 1,
    existing: [],
    candidates: [
      r61Candidate({ title: "弱甲", matchTerms: ["弱甲"], supportLevel: "weak_inference" }),
      r61Candidate({ title: "弱乙", matchTerms: ["弱乙"], relation: "category", supportLevel: "weak_inference" })
    ],
    now: now + 200
  });
  assert.equal(none.records.filter((record) => record.status === "current").length, 0,
    "all-below-threshold keeps zero facts");
  console.log("PASS cognitive: secondary per-parent cap is 10 with threshold and zero semantics");
}

// 场景 6：10 条 user_edited_inference 占满预算时——全部保留、不新增 LLM 事实、
// 不删除用户编辑内容，连 keptOld 也不再占用位置。
async function scenarioSecondaryUserEditedFillsBudget(): Promise<void> {
  const now = 1_800_000_000_000;
  const relations = ["category", "instance", "attribute", "context", "associated"] as const;
  const userFacts: ReturnType<typeof createSecondaryRecord>[] = [];
  for (const relation of relations) {
    for (let index = 0; index < 2; index += 1) {
      userFacts.push(createSecondaryRecord({
        parentId: "mem_r61_user",
        title: `用户事实${relation}${index + 1}`,
        content: `用户编辑内容${relation}${index + 1}。`,
        recallWhen: "相关话题出现时",
        matchTerms: [`用词${relation}${index + 1}`],
        relation,
        reason: "用户编辑",
        supportLevel: "direct",
        evidence: "用户证据",
        basis: "user_edited_inference",
        confidence: 0.80,
        sourceMemoryRevision: 1,
        now
      }));
    }
  }
  const oldLlm = r61OldFact({
    parentId: "mem_r61_user", title: "旧推断", matchTerms: ["旧词"],
    relation: "instance", confidence: 0.90, now
  });
  const result = reconcileSecondaryForParent({
    parentId: "mem_r61_user",
    parentBasis: "explicit",
    parentRevision: 2,
    existing: [...userFacts, oldLlm],
    candidates: [
      // 与旧推断宽 key 相遇的低置信候选（本应触发 keptOld 保留）。
      r61Candidate({ title: "旧推断", matchTerms: ["旧词"], relation: "instance" }),
      // 多个高分新候选。
      r61Candidate({ title: "新甲", matchTerms: ["新甲"], supportLevel: "direct" }),
      r61Candidate({ title: "新乙", matchTerms: ["新乙"], relation: "category", supportLevel: "direct" })
    ],
    now: now + 100
  });
  const current = result.records.filter((record) => record.status === "current");
  const userIds = new Set(userFacts.map((record) => record.id));
  assert.equal(current.filter((record) => userIds.has(record.id)).length, 10,
    "all 10 user-edited facts survive");
  assert.equal(current.length, 10, "no fact beyond the 10 user edits");
  assert.equal(result.factsCreated, 0, "no new LLM fact when user edits fill the budget");
  const oldAfter = result.records.find((record) => record.id === oldLlm.id)!;
  assert.equal(oldAfter.status, "disabled",
    "overflow matched old fact retires instead of pushing past the cap");
  for (const record of userFacts) {
    const after = result.records.find((candidate) => candidate.id === record.id)!;
    assert.equal(after.content, record.content, "user-edited content untouched");
    assert.equal(after.revision, record.revision, "user-edited revision untouched");
  }
  console.log("PASS cognitive: user-edited facts fill the budget without deletion or new LLM facts");
}

// ---------------------------------------------------------------------------
// Round 6.1 修复二：revoke observed 来源清空后必须走历史回退，而不是直接置空
// ---------------------------------------------------------------------------

/** Round 6.1 测试用 observed trait 记录工厂。 */
function r61TraitRecord(input: {
  id: string;
  dimension: PersonalityTraitRecord["dimension"];
  score: number;
  sourceMemoryIds: readonly string[];
  status?: "current" | "superseded";
  revision?: number;
  updatedAt?: number;
  reason?: string;
}): PersonalityTraitRecord {
  return Object.freeze({
    id: input.id,
    dimension: input.dimension,
    basis: "observed",
    status: input.status ?? "current",
    score: input.score,
    sourceMemoryIds: Object.freeze([...input.sourceMemoryIds]),
    evidence: "测试证据",
    createdAt: 10,
    updatedAt: input.updatedAt ?? 10,
    revision: input.revision ?? 1,
    reason: input.reason
  });
}

/** advisor 模板 explicit sharpness = 0.50 的 v2 状态，附 observed/history。 */
function r61PersonalityState(input: {
  observedSharpness: PersonalityTraitRecord | null;
  history?: readonly PersonalityTraitRecord[];
}): PersonalityState {
  const templated = applyTemplateToState(emptyPersonalityState(0), {
    templateId: "advisor",
    now: 1,
    reset: false
  });
  return Object.freeze({
    ...templated,
    observed: Object.freeze({ ...templated.observed, sharpness: input.observedSharpness }),
    history: Object.freeze([...(input.history ?? [])])
  });
}

// 场景 1：current observed 来源全部被撤销后，跳过来源已失效的较新历史，
// 恢复更早但仍有效的 historical observed（而不是直接回 explicit baseline）。
async function scenarioRevokeObservedFallsBackToValidHistory(): Promise<void> {
  const now = 1_800_000_000_000;
  const currentA = r61TraitRecord({
    id: "trait_obs_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  // history 按追加顺序存放：越早的在前。最新一条只来自已失效的 D，
  // 再早一条来自仍有效的 B、C。
  const histBC = r61TraitRecord({
    id: "trait_obs_hist_bc", dimension: "sharpness", score: 0.42,
    sourceMemoryIds: ["memB", "memC"], status: "superseded",
    updatedAt: 50, revision: 5, reason: "observed_update"
  });
  const histD = r61TraitRecord({
    id: "trait_obs_hist_d", dimension: "sharpness", score: 0.20,
    sourceMemoryIds: ["memD"], status: "superseded",
    updatedAt: 70, revision: 7, reason: "observed_update"
  });
  const state = r61PersonalityState({ observedSharpness: currentA, history: [histBC, histD] });

  // A 以更高 revision 重新处理；A 仍存在（valid），D 已失效。
  const result = revokeReprocessedPersonalitySources(
    state, new Set(["memA"]), now, new Set(["memA", "memB", "memC"])
  );

  // 旧 current 进入 history，reason=source_reprocessed。
  const supersededCurrent = result.history.find((record) => record.id === currentA.id);
  assert.ok(supersededCurrent, "current observed must move to history");
  assert.equal(supersededCurrent!.status, "superseded");
  assert.equal(supersededCurrent!.reason, "source_reprocessed");

  // 回退跳过来源无效的 D，恢复 B、C 对应的历史 observed。
  const restored = result.observed.sharpness;
  assert.ok(restored, "must fall back to a still-valid historical observed, not null");
  assert.equal(restored!.id, histBC.id, "the B/C historical record is restored");
  assert.equal(restored!.score, histBC.score, "historical score semantics preserved");
  assert.equal(restored!.basis, "observed");
  assert.deepEqual([...restored!.sourceMemoryIds], ["memB", "memC"],
    "restored sources keep exactly the valid ids");
  assert.equal(restored!.status, "current");
  assert.equal(restored!.revision, result.revision, "revision updated to this round");
  assert.equal(restored!.updatedAt, now, "updatedAt updated to this round");
  console.log("PASS cognitive: revoke observed falls back to the newest still-valid history");
}

async function scenarioPersonalityFallbackUsesPersistedRecency(): Promise<void> {
  const currentA = r61TraitRecord({
    id: "trait_persisted_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  const olderB = r61TraitRecord({
    id: "trait_persisted_older_b", dimension: "sharpness", score: 0.40,
    sourceMemoryIds: ["memB"], status: "superseded",
    updatedAt: 40, revision: 4, reason: "observed_update"
  });
  const newerC = r61TraitRecord({
    id: "trait_persisted_newer_c", dimension: "sharpness", score: 0.46,
    sourceMemoryIds: ["memC"], status: "superseded",
    updatedAt: 70, revision: 7, reason: "observed_update"
  });
  const before = r61PersonalityState({
    observedSharpness: currentA,
    history: [newerC, olderB]
  });
  const parsed = parsePersonalityState(
    JSON.parse(personalityStateJson(before)) as Record<string, unknown>
  );
  assert.ok(parsed, "serialized personality state must parse");

  const result = reconcilePersonalitySources(
    parsed!,
    new Set(["memB", "memC"]),
    1_800_000_000_000
  );
  assert.equal(result.observed.sharpness?.id, newerC.id,
    "fallback chooses newer C after JSON round-trip, not older B");
  assert.equal(result.observed.sharpness?.score, newerC.score);
  console.log("PASS cognitive: persisted personality fallback uses updatedAt and revision recency");
}

// 场景 2：历史记录部分来源有效 → 恢复时只保留仍有效的来源。
async function scenarioRevokeObservedFallbackFiltersPartialSources(): Promise<void> {
  const now = 1_800_000_000_000;
  const currentA = r61TraitRecord({
    id: "trait_obs_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  const histBCD = r61TraitRecord({
    id: "trait_obs_hist_bcd", dimension: "sharpness", score: 0.44,
    sourceMemoryIds: ["memB", "memC", "memD"], status: "superseded",
    updatedAt: 60, revision: 6, reason: "observed_update"
  });
  const state = r61PersonalityState({ observedSharpness: currentA, history: [histBCD] });

  const result = revokeReprocessedPersonalitySources(
    state, new Set(["memA"]), now, new Set(["memA", "memB", "memC"])
  );
  const restored = result.observed.sharpness;
  assert.ok(restored);
  assert.equal(restored!.id, histBCD.id);
  assert.deepEqual([...restored!.sourceMemoryIds], ["memB", "memC"],
    "dead source memD must be dropped on restore");
  assert.equal(restored!.score, histBCD.score);
  console.log("PASS cognitive: revoke observed fallback keeps only still-valid sources");
}

// 场景 3：没有任何有效历史记录 → observed 置空，分数回 explicit baseline，
// 且不创建伪造的 observed 记录。
async function scenarioRevokeObservedWithoutValidHistoryReturnsBaseline(): Promise<void> {
  const now = 1_800_000_000_000;
  const currentA = r61TraitRecord({
    id: "trait_obs_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  const histD = r61TraitRecord({
    id: "trait_obs_hist_d", dimension: "sharpness", score: 0.20,
    sourceMemoryIds: ["memD"], status: "superseded",
    updatedAt: 70, revision: 7, reason: "observed_update"
  });
  const state = r61PersonalityState({ observedSharpness: currentA, history: [histD] });

  const result = revokeReprocessedPersonalitySources(
    state, new Set(["memA"]), now, new Set(["memA"])
  );
  assert.equal(result.observed.sharpness, null, "no valid history → observed slot empties");
  // advisor explicit sharpness = 0.50。
  assert.equal(currentPersonalityScores(result).sharpness, 0.50,
    "score falls back to the explicit template baseline");
  const currentInHistory = result.history.filter(
    (record) => record.dimension === "sharpness" && record.status === "current"
  );
  assert.equal(currentInHistory.length, 0, "no fabricated observed record in history");
  console.log("PASS cognitive: revoke observed without valid history returns explicit baseline");
}

// 场景 4：本轮重新处理 Memory 的旧 revision 证据不得被当作有效来源恢复。
async function scenarioRevokeObservedNeverRestoresReprocessedEvidence(): Promise<void> {
  const now = 1_800_000_000_000;
  const currentA = r61TraitRecord({
    id: "trait_obs_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  // 历史 observed 仍然包含 A —— A 本身仍是 current Memory，但本轮正被重新
  // 处理，其旧 revision 证据不得参与回退。
  const histA = r61TraitRecord({
    id: "trait_obs_hist_a", dimension: "sharpness", score: 0.35,
    sourceMemoryIds: ["memA"], status: "superseded",
    updatedAt: 60, revision: 6, reason: "observed_update"
  });
  const state = r61PersonalityState({ observedSharpness: currentA, history: [histA] });

  const result = revokeReprocessedPersonalitySources(
    state, new Set(["memA"]), now, new Set(["memA", "memB"])
  );
  assert.equal(result.observed.sharpness, null,
    "reprocessed memory's stale evidence must not be restored");
  assert.equal(currentPersonalityScores(result).sharpness, 0.50,
    "falls back to explicit baseline instead of stale evidence");
  console.log("PASS cognitive: revoke observed never restores reprocessed memory evidence");
}

async function scenarioReprocessedEvidenceCannotReviveLater(): Promise<void> {
  const currentA = r61TraitRecord({
    id: "trait_reprocess_current_a", dimension: "sharpness", score: 0.30,
    sourceMemoryIds: ["memA"], updatedAt: 90, revision: 9
  });
  const historyAB = r61TraitRecord({
    id: "trait_reprocess_history_ab", dimension: "sharpness", score: 0.44,
    sourceMemoryIds: ["memA", "memB"], status: "superseded",
    updatedAt: 70, revision: 7, reason: "observed_update"
  });
  const historyA = r61TraitRecord({
    id: "trait_reprocess_history_a", dimension: "sharpness", score: 0.38,
    sourceMemoryIds: ["memA"], status: "superseded",
    updatedAt: 50, revision: 5, reason: "observed_update"
  });
  const state = r61PersonalityState({
    observedSharpness: currentA,
    history: [historyAB, historyA]
  });

  const afterReprocess = revokeReprocessedPersonalitySources(
    state,
    new Set(["memA"]),
    1_800_000_000_000,
    new Set(["memA", "memB"])
  );
  assert.equal(afterReprocess.observed.sharpness?.id, historyAB.id,
    "same round may restore only the still-valid B portion");
  assert.deepEqual(afterReprocess.observed.sharpness?.sourceMemoryIds, ["memB"]);
  assert.ok(afterReprocess.history.every((record) =>
    !record.sourceMemoryIds.includes("memA")
  ), "reprocessed source is permanently removed from every history candidate");

  const afterBLost = reconcilePersonalitySources(
    afterReprocess,
    new Set(["memA"]),
    1_800_000_000_100
  );
  assert.equal(afterBLost.observed.sharpness, null,
    "losing B later cannot revive A's prior-revision historical evidence");
  assert.equal(currentPersonalityScores(afterBLost).sharpness, 0.50);
  console.log("PASS cognitive: reprocessed personality evidence cannot revive in later rounds");
}

async function scenarioPersonalityHistoryCapAndDimensionRecovery(): Promise<void> {
  let state = emptyPersonalityState(1);
  let identifier = 0;
  for (let index = 0; index < 52; index += 1) {
    state = applyTemplateToState(state, {
      templateId: index % 2 === 0 ? "executor" : "advisor",
      now: 10 + index,
      reset: false,
      idFactory: () => `trait_history_${++identifier}`
    });
  }
  for (const dimension of TRAIT_DIMENSIONS) {
    assert.ok(
      state.history.filter((record) => record.dimension === dimension).length
        <= PERSONALITY_HISTORY_PER_DIMENSION_CAP,
      `${dimension} history must be capped at ${PERSONALITY_HISTORY_PER_DIMENSION_CAP}`
    );
  }

  await withPersonalMemoryFixture(async (fixture) => {
    const source = await createMemory(fixture, {
      title: "受损维度恢复来源",
      content: "这条来源应在局部恢复后重新入队。"
    });
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "恢复测试", avatar: { kind: "default" } }
    });
    const raw = await readJson(fixture.repository.layout.personalityState);
    const explicit = raw.explicit as Record<string, { id?: string }>;
    const preservedRigorId = explicit.rigor?.id;
    (raw.observed as Record<string, unknown>).sharpness = {
      id: "trait_corrupt_sharpness",
      dimension: "sharpness",
      basis: "observed",
      status: "current",
      score: "not-a-number",
      sourceMemoryIds: [source.id],
      evidence: "corrupt fixture",
      createdAt: 1,
      updatedAt: 1,
      revision: 1
    };
    raw.processedSources = [{ memoryId: source.id, memoryRevision: source.revision, processedAt: 1 }];
    await writeFile(fixture.repository.layout.personalityState, JSON.stringify(raw, null, 2) + "\n");
    const dream = await readJson(fixture.repository.layout.dreamState);
    dream.pendingMemoryIds = [];
    await writeFile(fixture.repository.layout.dreamState, JSON.stringify(dream, null, 2) + "\n");

    const recoveredSystem = await createSystem(fixture, () => null);
    const recovered = await recoveredSystem.readPersonalityState();
    assert.equal(recovered.explicit.rigor?.id, preservedRigorId,
      "unrelated dimensions survive local recovery");
    assert.ok(recovered.explicit.sharpness, "damaged dimension returns to template baseline");
    assert.equal(recovered.processedSources.some((item) => item.memoryId === source.id), false,
      "failed source is not left marked complete");
    const recoveredDream = await readJson(fixture.repository.layout.dreamState) as {
      pendingMemoryIds: string[];
    };
    assert.ok(recoveredDream.pendingMemoryIds.includes(source.id));
    const historyFiles = await readdir(path.join(
      fixture.repository.layout.root,
      "agents",
      "echoink",
      "history"
    ));
    assert.equal(historyFiles.filter((file) =>
      file.startsWith("personality-dimension-sharpness-")
    ).length, 1, "only the damaged dimension gets a recovery backup");
  });
  console.log("PASS cognitive: per-dimension history cap and local corruption recovery");
}

async function scenarioPersonalityStrictSlotValidation(): Promise<void> {
  const seedSelectedTemplate = async (fixture: Readonly<PersonalMemoryFixture>) => {
    const system = await createSystem(fixture, () => null);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: { displayName: "严格校验", avatar: { kind: "default" } }
    });
    return await readJson(fixture.repository.layout.personalityState) as Record<string, any>;
  };

  await withPersonalMemoryFixture(async (fixture) => {
    const raw = await seedSelectedTemplate(fixture);
    const rigorId = raw.explicit.rigor.id;
    raw.explicit.sharpness.dimension = "rigor";
    await writeFile(fixture.repository.layout.personalityState, JSON.stringify(raw, null, 2) + "\n");

    const recovered = await createSystem(fixture, () => null);
    const state = await recovered.readPersonalityState();
    assert.equal(state.explicit.rigor?.id, rigorId, "unrelated slot survives dimension-local recovery");
    assert.equal(state.explicit.sharpness?.dimension, "sharpness");
    assert.equal(state.explicit.sharpness?.basis, "explicit");
    assert.equal(state.explicit.sharpness?.status, "current");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const raw = await seedSelectedTemplate(fixture);
    delete raw.explicit.sharpness;
    await writeFile(fixture.repository.layout.personalityState, JSON.stringify(raw, null, 2) + "\n");

    const recovered = await createSystem(fixture, () => null);
    const state = await recovered.readPersonalityState();
    assert.equal(state.explicit.sharpness?.score, getPersonalityTemplate("executor")!.scores.sharpness,
      "selected template missing one explicit slot recovers that dimension baseline");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const raw = await seedSelectedTemplate(fixture);
    raw.explicit.sharpness.sourceMemoryIds = "mem_not_an_array";
    await writeFile(fixture.repository.layout.personalityState, JSON.stringify(raw, null, 2) + "\n");

    const recovered = await createSystem(fixture, () => null);
    const state = await recovered.readPersonalityState();
    assert.deepEqual(state.explicit.sharpness?.sourceMemoryIds, [],
      "dimension-attributable non-array sources use local recovery, not silent filtering");
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const raw = await seedSelectedTemplate(fixture);
    raw.learnedRequirements = [{
      id: "req_invalid_sources",
      text: "无法归属到单一维度的损坏",
      basis: "observed_memory",
      status: "current",
      sourceMemoryIds: "mem_not_an_array",
      revision: raw.revision
    }];
    const original = JSON.stringify(raw, null, 2) + "\n";
    await writeFile(fixture.repository.layout.personalityState, original);

    await assert.rejects(
      () => createSystem(fixture, () => null),
      /personality_state_invalid/u
    );
    assert.equal(await readFile(fixture.repository.layout.personalityState, "utf8"), original,
      "global source-array damage fails closed without rewriting the state");
  });

  console.log("PASS cognitive: personality slots and source arrays validate or recover strictly");
}

async function scenarioDreamGlobalRevisionConflictKeepsPending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    let mutated = false;
    const llm: DreamLlmPort = {
      call: async () => {
        if (!mutated) {
          mutated = true;
          await fixture.repository.write({
            operation: "create",
            kind: "fact",
            title: "Dream Provider 期间并发写入",
            content: "用于推进全局 Memory revision。",
            recallWhen: "验证 Dream CAS 时",
            basis: "explicit"
          }, fixture.runtime({ userEntryId: "dream-global-cas-concurrent" }));
        }
        return validDreamJson();
      }
    };
    const system = await createSystem(fixture, () => llm);
    const source = await createMemory(fixture, {
      title: "Dream 全局 CAS 来源",
      content: "这条来源在冲突后必须保持 pending。"
    });
    await system.settleDreamEnqueue();
    const run = await system.forceDreamRun();
    assert.ok(run);
    assert.equal(run!.committed, false);
    assert.match(run!.error ?? "", /Memory revision conflict/u);
    await system.settleDreamEnqueue();
    const dream = await readJson(fixture.repository.layout.dreamState) as {
      pendingMemoryIds: string[];
    };
    assert.ok(dream.pendingMemoryIds.includes(source.id),
      "global CAS conflict cannot consume the original source");
    assert.equal((await system.listSecondaryForParent(source.id)).length, 0,
      "stale Dream output never reaches disk or cache");
  });
  console.log("PASS cognitive: global Dream revision conflict preserves pending sources");
}

async function scenarioSecondaryLegacyRepairPreservesStructuralDamage(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const makeRecord = (parentId: string, id: string) => createSecondaryRecord({
      parentId,
      title: "旧版联想线索",
      content: "旧版联想线索正文",
      recallWhen: "聊到旧版记录时",
      matchTerms: ["旧版联想线索"],
      relation: "associated",
      reason: "旧版记录",
      basis: "llm_inferred",
      confidence: 0.7,
      supportLevel: "strong_inference",
      evidence: "旧版记录证据",
      sourceMemoryRevision: 1,
      now: fixture.now(),
      idFactory: () => id
    });

    const oversized = makeRecord("mem_legacy_oversized", "sec_legacy_oversized");
    const oversizedTitle = "题".repeat(SECONDARY_TITLE_MAX_CHARS + 17);
    const oversizedContent = "文".repeat(SECONDARY_CONTENT_MAX_CHARS + 19);
    const oversizedOriginal = serializeSecondaryRecord(oversized)
      .replace(
        `title: ${JSON.stringify(oversized.title)}`,
        `title: ${JSON.stringify(oversizedTitle)}`
      )
      .replace(`\n${oversized.content}\n`, `\n${oversizedContent}\n`);
    const oversizedDirectory = path.join(
      fixture.repository.layout.history,
      "secondary",
      oversized.parentId
    );
    const oversizedFile = path.join(oversizedDirectory, `${oversized.id}.md`);
    await mkdir(oversizedDirectory, { recursive: true });
    await writeFile(oversizedFile, oversizedOriginal);

    const damaged = makeRecord("mem_structurally_damaged", "sec_structurally_damaged");
    const damagedOriginal = serializeSecondaryRecord(damaged)
      .replace('relation: "associated"', 'relation: "unknown_relation"');
    const damagedDirectory = path.join(
      fixture.repository.layout.history,
      "secondary",
      damaged.parentId
    );
    const damagedFile = path.join(damagedDirectory, `${damaged.id}.md`);
    await mkdir(damagedDirectory, { recursive: true });
    await writeFile(damagedFile, damagedOriginal);

    const invalidUtf8 = makeRecord("mem_invalid_utf8", "sec_invalid_utf8");
    const invalidUtf8Directory = path.join(
      fixture.repository.layout.history,
      "secondary",
      invalidUtf8.parentId
    );
    const invalidUtf8File = path.join(invalidUtf8Directory, `${invalidUtf8.id}.md`);
    const invalidUtf8Bytes = Buffer.concat([
      Buffer.from(serializeSecondaryRecord(invalidUtf8), "utf8"),
      Buffer.from([0xc3, 0x28])
    ]);
    await mkdir(invalidUtf8Directory, { recursive: true });
    await writeFile(invalidUtf8File, invalidUtf8Bytes);

    const invalidSixthFiles: Array<{ file: string; original: string }> = [];
    for (const [suffix, invalid] of [
      ["object", {}],
      ["empty", ""],
      ["single-han", "项"]
    ] as const) {
      const record = makeRecord(`mem_invalid_sixth_${suffix}`, `sec_invalid_sixth_${suffix}`);
      const terms = ["有效一", "有效二", "有效三", "有效四", "有效五", invalid];
      const original = serializeSecondaryRecord(record).replace(
        `match_terms: ${JSON.stringify(record.matchTerms)}`,
        `match_terms: ${JSON.stringify(terms)}`
      );
      const directory = path.join(
        fixture.repository.layout.history,
        "secondary",
        record.parentId
      );
      const file = path.join(directory, `${record.id}.md`);
      await mkdir(directory, { recursive: true });
      await writeFile(file, original);
      invalidSixthFiles.push({ file, original });
    }

    const loaded = await new SecondaryMemoryStore(fixture.repository.layout.history).loadAll();
    assert.equal(loaded.length, 1, "only the purely oversized clue is recoverable");
    assert.equal(loaded[0].title, oversizedTitle.slice(0, SECONDARY_TITLE_MAX_CHARS));
    assert.equal(loaded[0].content, oversizedContent.slice(0, SECONDARY_CONTENT_MAX_CHARS));
    assert.equal(await readFile(oversizedFile, "utf8"), serializeSecondaryRecord(loaded[0]),
      "legacy oversize repair is deterministic");

    const backupDirectory = path.join(
      fixture.repository.layout.root,
      "shared-user",
      ".runtime",
      "backups",
      "association-clues"
    );
    const backups = await readdir(backupDirectory);
    assert.equal(backups.length, 1, "the original oversized clue is backed up once");
    assert.deepEqual(
      await readFile(path.join(backupDirectory, backups[0])),
      Buffer.from(oversizedOriginal, "utf8"),
      "oversized repair backup preserves the byte-identical original"
    );
    assert.deepEqual(await readFile(invalidUtf8File), invalidUtf8Bytes,
      "invalid UTF-8 stays byte-identical without lossy replacement");
    assert.equal(await readFile(damagedFile, "utf8"), damagedOriginal,
      "structural damage is skipped without guessed rewrites");
    for (const invalid of invalidSixthFiles) {
      assert.equal(await readFile(invalid.file, "utf8"), invalid.original,
        "a structurally invalid sixth match term is rejected before count truncation");
    }
  });
  console.log("PASS cognitive: legacy association clue repair preserves structural damage");
}

async function scenarioSecondaryIdentityIsBoundToPathAndParent(): Promise<void> {
  const make = (
    parentId: string,
    id: string,
    now: number
  ) => createSecondaryRecord({
    parentId,
    title: `身份线索 ${parentId}`,
    content: "用于验证 secondary 路径和 frontmatter 身份。",
    recallWhen: "检查联想线索身份时",
    matchTerms: ["身份线索"],
    relation: "associated",
    reason: "身份回归",
    basis: "user_edited_inference",
    confidence: 0.7,
    supportLevel: "direct",
    evidence: "测试构造",
    sourceMemoryRevision: 1,
    now,
    idFactory: () => id
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const record = make("mem_identity_expected", "sec_identity_path", fixture.now());
    const wrongParent = "mem_identity_wrong_directory";
    const directory = path.join(fixture.repository.layout.secondary, wrongParent);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${record.id}.md`), serializeSecondaryRecord(record));
    await assert.rejects(
      () => new SecondaryMemoryStore(fixture.repository.layout.history).loadAll(),
      /association_clue_identity_invalid/u
    );
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const id = "sec_duplicate_store_id";
    const first = make("mem_duplicate_parent_a", id, fixture.now());
    const second = make("mem_duplicate_parent_b", id, fixture.now());
    for (const record of [first, second]) {
      const file = path.join(fixture.repository.layout.root, record.file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, serializeSecondaryRecord(record));
    }
    await assert.rejects(
      () => new SecondaryMemoryStore(fixture.repository.layout.history).loadAll(),
      /duplicate-id/u
    );
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: `${memory.title} 的联想`,
        content: `${memory.title} 的联想内容。`,
        recallWhen: "相关话题出现时",
        matchTerms: [`${memory.title}词`],
        relation: "associated",
        supportLevel: "direct",
        reason: "测试",
        evidence: "记忆直接陈述"
      }]
    })));
    const parentA = await createMemory(fixture, { title: "身份父级甲", content: "甲内容。" });
    const parentB = await createMemory(fixture, { title: "身份父级乙", content: "乙内容。" });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    const factA = (await system.listSecondaryForParent(parentA.id))[0];
    const factB = (await system.listSecondaryForParent(parentB.id))[0];

    await assert.rejects(
      () => system.updateSecondaryFact(
        parentB.id,
        factA.id,
        { content: "不应写入" },
        factA.revision
      ),
      /not found/u
    );
    await assert.rejects(
      () => system.deleteSecondaryFact(parentA.id, factB.id, factB.revision),
      /not found/u
    );
    await fixture.repository.recordSecondaryRecallHits([{
      parentId: parentB.id,
      secondaryId: factA.id
    }]);
    assert.equal((await system.listSecondaryForParent(parentA.id))[0].hitCount, 0,
      "wrong-parent hit cannot update a clue with the requested id");

    await system.updateSecondaryFact(
      parentA.id,
      factA.id,
      { content: "只修改甲线索" },
      factA.revision
    );
    assert.equal((await system.listSecondaryForParent(parentA.id))[0].content, "只修改甲线索");
    assert.equal((await system.listSecondaryForParent(parentB.id))[0].content, factB.content,
      "dual-key edit leaves the other parent untouched");
    await fixture.repository.recordSecondaryRecallHits([{
      parentId: parentB.id,
      secondaryId: factB.id
    }]);
    assert.equal((await system.listSecondaryForParent(parentB.id))[0].hitCount, 1);
  });
  console.log("PASS cognitive: secondary identity binds path parent id and runtime mutations");
}

async function scenarioSecondaryConcurrentMutationsUseLatestSnapshot(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const system = await createSystem(fixture, () => scriptedDreamLlm((memory) => ({
      ...EMPTY_DREAM_OUTPUT,
      secondaryFacts: [{
        title: `${memory.title} 的并发线索`,
        content: `${memory.title} 的初始内容。`,
        recallWhen: "验证联想线索并发修改时",
        matchTerms: [`${memory.title}并发词`],
        relation: "associated",
        supportLevel: "direct",
        reason: "并发回归",
        evidence: "记忆直接陈述"
      }]
    })));
    const parentA = await createMemory(fixture, { title: "并发父级甲", content: "甲内容。" });
    const parentB = await createMemory(fixture, { title: "并发父级乙", content: "乙内容。" });
    await system.settleDreamEnqueue();
    await system.forceDreamRun();
    const factA = (await system.listSecondaryForParent(parentA.id))[0];
    const factB = (await system.listSecondaryForParent(parentB.id))[0];

    const [editedA, editedB] = await Promise.all([
      system.updateSecondaryFact(
        factA.parentId,
        factA.id,
        { content: "甲线索第一次并发编辑。" },
        factA.revision
      ),
      system.updateSecondaryFact(
        factB.parentId,
        factB.id,
        { content: "乙线索第一次并发编辑。" },
        factB.revision
      )
    ]);
    assert.equal((await system.listSecondaryForParent(parentA.id))[0].content, "甲线索第一次并发编辑。");
    assert.equal((await system.listSecondaryForParent(parentB.id))[0].content, "乙线索第一次并发编辑。");

    await Promise.all([
      system.updateSecondaryFact(
        editedA.record.parentId,
        editedA.record.id,
        { content: "甲线索第二次并发编辑。" },
        editedA.record.revision
      ),
      system.deleteSecondaryFact(
        editedB.record.parentId,
        editedB.record.id,
        editedB.record.revision
      )
    ]);
    assert.equal((await system.listSecondaryForParent(parentA.id))[0].content, "甲线索第二次并发编辑。");
    assert.equal((await system.listSecondaryForParent(parentB.id)).length, 0);

    const currentA = (await system.listSecondaryForParent(parentA.id))[0];
    const competing = await Promise.allSettled([
      system.updateSecondaryFact(
        currentA.parentId,
        currentA.id,
        { content: "同一线索保存版本一。" },
        currentA.revision
      ),
      system.updateSecondaryFact(
        currentA.parentId,
        currentA.id,
        { content: "同一线索保存版本二。" },
        currentA.revision
      )
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = competing.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    assert.ok(conflict?.reason instanceof PersonalMemoryAccessError);
    assert.equal(conflict.reason.code, "revision_conflict");
    assert.match(conflict.reason.message, /secondary_revision_conflict/u);
    assert.match(
      (await system.listSecondaryForParent(parentA.id))[0].content,
      /^同一线索保存版本[一二]。$/u
    );
  });
  console.log("PASS cognitive: concurrent secondary mutations preserve latest snapshot and CAS");
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
  await scenarioUserProfileProcessedSourcesStayBounded();
  await scenarioUserProfileV1MigrationFailsClosed();
  await scenarioUserProjectionCasAndProfileUpdate();
  await scenarioUserEditedLowConfidenceRecallable();
  await scenarioFirstQueryUsesMountedSecondaryRecords();
  await scenarioDecisiveHitUsesProductionBudgetCounterfactual();
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
  await scenarioTraitDimensionContract();
  await scenarioBandBoundaries();
  await scenarioBandBehaviorInstructions();
  await scenarioSignalClassificationPrompt();
  await scenarioEvolutionRulesOnNewDimensions();
  await scenarioResetRestoresNewBaseline();
  await scenarioPersonalityV1ToV2Migration();
  await scenarioMigrationFailureKeepsV1();
  await scenarioMigrationWithoutTemplateKeepsCustomAgent();
  // Round 6 integration regressions (先失败、后通过):
  await scenarioRecallSingleInjectionBlocks();
  await scenarioInitialSelectionJudgedByTemplateIdOnly();
  await scenarioInitialTemplateClearsPreTemplateEvidence();
  await scenarioMigrationFailureBlocksCognitiveWriters();
  await scenarioRenameDuringDreamKeepsNewName();
  await scenarioIdentityCasConcurrentEdits();
  await scenarioIdentityCasMigrationRace();
  await scenarioReprocessedRevisionRevokesDerivedSources();
  await scenarioBroadKeyRedreamPreservesIdAndHitHistory();
  await scenarioProfileKeyPromptCatalogBounded();
  // Round 6.1 regressions (先失败、后通过):
  await scenarioSecondaryCrossAliasClosed();
  await scenarioSecondaryOldIdConsumedOnce();
  await scenarioSecondaryKeptOldOccupiesTotalBudget();
  await scenarioSecondaryKeptOldOccupiesRelationBudget();
  await scenarioSecondaryPerParentCapIsTen();
  await scenarioSecondaryUserEditedFillsBudget();
  await scenarioRevokeObservedFallsBackToValidHistory();
  await scenarioPersonalityFallbackUsesPersistedRecency();
  await scenarioRevokeObservedFallbackFiltersPartialSources();
  await scenarioRevokeObservedWithoutValidHistoryReturnsBaseline();
  await scenarioRevokeObservedNeverRestoresReprocessedEvidence();
  await scenarioReprocessedEvidenceCannotReviveLater();
  await scenarioPersonalityHistoryCapAndDimensionRecovery();
  await scenarioPersonalityStrictSlotValidation();
  await scenarioDreamGlobalRevisionConflictKeepsPending();
  await scenarioSecondaryConcurrentMutationsUseLatestSnapshot();
  await scenarioSecondaryIdentityIsBoundToPathAndParent();
  await scenarioSecondaryLegacyRepairPreservesStructuralDamage();
}
