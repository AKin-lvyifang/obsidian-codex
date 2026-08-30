import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DREAM_EXPERIENCE_MAX_BYTES,
  DREAM_EXPERIENCE_MAX_ITEMS,
  DreamExperienceInboxStore,
  appendDreamPublicExperience,
  defaultDreamExperienceInboxState,
  dreamExperienceInboxJson,
  markDreamExperiencesEvaluated,
  normalizeDreamPublicExperience
} from "../harness/memory/dream-experience-inbox";
import {
  buildDreamPrompts,
  buildDreamSelfPrompts,
  buildDreamSelfSources,
  parseDreamGrowthOutput,
  parseDreamSelfOutput
} from "../harness/memory/dream-engine";
import { buildDreamPublicExperienceFromRun } from "../harness/pi-native/pi-native-conversation-runtime";
import {
  applyAgentSelfOperations,
  parseAgentCurrentSelf,
  replaceAgentCurrentSelf,
  stableSelfKey
} from "../harness/memory/agent-self";
import {
  AGENT_SELF_METADATA_RELATIVE_PATH,
  AgentSelfMetadataStore,
  agentSelfMetadataJson,
  emptyAgentSelfMetadata,
  type AgentSelfMetadata
} from "../harness/memory/agent-self-metadata";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { PERSONAL_MEMORY_SCHEMA, type PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import {
  USER_PROFILE_STATE_RELATIVE_PATH,
  applyDreamProfileUpdate,
  emptyUserProfileState,
  reconcileProfileSources,
  userProfileStateJson
} from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { experienceProfileSourceId } from "../harness/memory/dream-source-group";

export async function runDreamGrowthScenarios(): Promise<void> {
  await scenarioInboxIsBoundedAndDeduplicated();
  scenarioRuntimeCaptureKeepsOnlyPublicMinimalData();
  scenarioSelfEvidenceThresholdsAreFailClosed();
  scenarioCurrentHabitCatalogForcesNearSynonymReplacement();
  scenarioDreamInputsAreUntrustedAndUserGrowthUsesPublicEvidence();
  await scenarioProductRunMemoryAndExperienceAreNotDoubleCounted();
  await scenarioSameRunProviderAndParseFailuresKeepExperiencePending();
  await scenarioSameRunExperienceStillRunsProvider();
  await scenarioDreamCommitsExperienceAndSelfTogether();
  await scenarioInvalidDreamLeavesExperiencePending();
  await scenarioDreamCasFailureLeavesExperiencePending();
  await scenarioForgottenMemoryRetiresDerivedHabitInSameTransaction();
  await scenarioCorrectedMemoryRetiresSameRunExperienceDerivation();
  console.log("PASS Dream public experience and Agent Self growth contracts");
}

function scenarioCurrentHabitCatalogForcesNearSynonymReplacement(): void {
  const existingText = "复杂问题先核对关键事实再行动";
  const existingKey = stableSelfKey(existingText);
  const currentSelf = Object.freeze({
    version: 1 as const,
    complexProblemMethod: "先理解问题",
    tone: "清晰",
    responseStructure: "结论后依据",
    currentLearnedHabits: Object.freeze([
      Object.freeze({ key: existingKey, text: existingText })
    ])
  });
  const experience = normalizeDreamPublicExperience(experienceInput(
    69,
    "以后默认先查清关键证据，再决定是否行动"
  ));
  const sources = buildDreamSelfSources([], [experience], 2_000);
  const prompt = buildDreamSelfPrompts(sources, currentSelf);
  assert.match(prompt.userPrompt, new RegExp(existingKey, "u"));
  assert.match(prompt.userPrompt, new RegExp(existingText, "u"));
  assert.match(prompt.systemPrompt, /近义、重叠或冲突.*habit_replace/u);

  const mechanicallyAdded = parseDreamGrowthOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "先查清关键证据再行动",
      basis: "explicit",
      sources: [{
        sourceId: sources[0]!.sourceId,
        evidenceQuote: "以后默认先查清关键证据，再决定是否行动"
      }]
    }]
  }), sources, currentSelf);
  assert.equal(mechanicallyAdded?.agentSelfOperations.length, 0,
    "an add that did not compare the current key catalog fails closed");

  const replaced = parseDreamGrowthOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_replace",
      key: existingKey,
      text: "复杂问题先查清关键证据，再决定行动",
      basis: "explicit",
      sources: [{
        sourceId: sources[0]!.sourceId,
        evidenceQuote: "以后默认先查清关键证据，再决定是否行动"
      }]
    }]
  }), sources, currentSelf);
  assert.equal(replaced?.agentSelfOperations.length, 1);
  assert.deepEqual(replaced?.agentSelfOperations[0]?.operation, {
    operation: "habit_replace",
    key: existingKey,
    text: "复杂问题先查清关键证据，再决定行动"
  });
}

async function scenarioSameRunProviderAndParseFailuresKeepExperiencePending(): Promise<void> {
  for (const failure of ["provider", "parse"] as const) {
    await withPersonalMemoryFixture(async (fixture) => {
      await fixture.repository.write({
        operation: "create",
        kind: "view",
        title: `同组 ${failure} 失败记忆`,
        content: "以后默认在复杂任务中先核对证据。",
        recallWhen: "处理复杂任务时",
        basis: "explicit",
        contentOrigin: "user_statement"
      }, fixture.runtime({ productRunId: `run-same-group-${failure}` }));
      const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
      await inbox.append(Object.freeze({
        ...experienceInput(failure === "provider" ? 70 : 71, "同轮还有未写入 Memory 的公开习惯证据"),
        productRunId: `run-same-group-${failure}`
      }), fixture.now());
      const system = await CognitiveSystem.create({
        repository: fixture.repository,
        llm: () => ({
          call: async (request) => {
            if (!request.systemPrompt.includes("本次只输出 Agent current-self")) {
              return JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
            }
            if (failure === "provider") throw new Error("same_group_provider_failed");
            return "{invalid-self-json";
          }
        }),
        getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
        isForegroundBusy: () => false,
        registerInterval: () => undefined,
        now: fixture.now
      });
      const result = await system.engine.runOnce();
      assert.equal(result.committed, false);
      assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null,
        `same-ProductRun ${failure} failure must keep Experience pending`);
    });
  }
}

async function scenarioProductRunMemoryAndExperienceAreNotDoubleCounted(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "同一次任务的长期观察",
      content: "复杂任务中先核对证据",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-covered-same-round" }));
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    const appended = await inbox.append(Object.freeze({
      ...experienceInput(42, "本次任务中先核对证据"),
      productRunId: "run-covered-same-round"
    }), fixture.now());
    const duplicateSourceId = `experience:${appended.entries[0]!.fingerprint}`;
    const sources = buildDreamSelfSources(
      (await fixture.repository.inspect()).records.filter((record) => record.status === "current"),
      [appended.entries[0]!],
      2_000
    );
    assert.equal(sources.length, 2);
    assert.deepEqual(
      [...new Set(sources.map((source) => source.contextId))],
      ["task:run-covered-same-round"],
      "Memory and Experience from one ProductRun remain visible but count as one independent context"
    );
    let selfPromptSeen = false;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({
        call: async (request) => {
          if (!request.systemPrompt.includes("本次只输出 Agent current-self")) {
            return JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
          }
          selfPromptSeen = true;
          assert.match(request.userPrompt, new RegExp(duplicateSourceId, "u"));
          assert.match(request.userPrompt, /run-covered-same-round/u);
          return "no_change";
        }
      }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, true);
    assert.equal(selfPromptSeen, true);
    assert.notEqual((await inbox.read()).entries[0]?.evaluatedAt, null,
      "same-ProductRun Experience is evaluated only after its own public evidence is analyzed");
  });
}

async function scenarioSameRunExperienceStillRunsProvider(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "先完成一级记忆",
      content: "复杂任务中保持结构",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-covered-later" }));
    let providerLookups = 0;
    let providerCalls = 0;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => {
        providerLookups += 1;
        return {
          call: async (request) => {
            providerCalls += 1;
            return request.systemPrompt.includes("本次只输出 Agent current-self")
              ? "no_change"
              : JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
          }
        };
      },
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    assert.equal((await system.engine.runOnce()).committed, true);
    assert.equal(providerLookups, 1);
    assert.equal(providerCalls, 2);

    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(Object.freeze({
      ...experienceInput(43, "同一任务的公开经历"),
      productRunId: "run-covered-later"
    }), fixture.now());
    const experienceOnly = await system.engine.runOnce();
    assert.equal(experienceOnly.committed, true);
    assert.equal(experienceOnly.providerUnavailable, false);
    assert.equal(experienceOnly.error, null);
    assert.equal(providerLookups, 2,
      "same-ProductRun public evidence must still enter the independent Self/USER analysis");
    assert.equal(providerCalls, 3);
    assert.notEqual((await inbox.read()).entries[0]?.evaluatedAt, null);
  });
}

async function scenarioDreamCommitsExperienceAndSelfTogether(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    const input = experienceInput(40, "以后默认在复杂任务中先核对证据");
    const appended = await inbox.append(input, fixture.now());
    const sourceId = `experience:${appended.entries[0]!.fingerprint}`;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({
        call: async (request) => request.systemPrompt.includes("本次只输出 Agent current-self")
          ? JSON.stringify({
              agentSelfOperations: [{
                operation: "habit_add",
                text: "复杂任务中先核对证据",
                basis: "explicit",
                sources: [{
                  sourceId,
                  evidenceQuote: "以后默认在复杂任务中先核对证据"
                }]
              }],
              userProfileItems: [{
                section: "collaboration",
                profileKey: "collaboration.quality_bar",
                text: "复杂任务默认先核对证据",
                basis: "explicit",
                sources: [{
                  sourceId,
                  evidenceQuote: "以后默认在复杂任务中先核对证据"
                }]
              }]
            })
          : "no_change"
      }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, true);
    assert.equal(result.agentUpdated, true);
    const control = await fixture.repository.readUserControlState();
    assert.match(control.agent, /复杂任务中先核对证据/u);
    assert.match(control.user, /复杂任务默认先核对证据/u);
    const metadata = await system.agentSelfMetadataStore.read();
    assert.equal(metadata?.derivations[0]?.sources[0]?.kind, "experience");
    assert.equal((await inbox.read()).entries[0]?.evaluatedAt === null, false);
    await system.engine.runOnce();
    assert.match((await fixture.repository.readUserControlState()).user, /复杂任务默认先核对证据/u,
      "an evaluated public Experience remains a valid USER provenance source");
  });
}

async function scenarioInvalidDreamLeavesExperiencePending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experienceInput(41, "以后默认保持清晰结构"), fixture.now());
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({ call: async () => "{invalid-json" }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, false);
    assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null);
    assert.equal((await system.agentSelfMetadataStore.read())?.derivations.length, 0);
  });
}

async function scenarioDreamCasFailureLeavesExperiencePending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experienceInput(44, "以后默认保持清晰结构"), fixture.now());
    let injectedConcurrentWrite = false;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({
        call: async () => {
          if (!injectedConcurrentWrite) {
            injectedConcurrentWrite = true;
            await fixture.repository.write({
              operation: "create",
              kind: "fact",
              title: "并发写入",
              content: "在 Dream Provider 调用后推进 Memory revision",
              recallWhen: "验证 Dream CAS 时",
              basis: "explicit",
              contentOrigin: "user_statement"
            }, fixture.runtime({ productRunId: "run-concurrent-write" }));
          }
          return "no_change";
        }
      }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, false);
    assert.match(result.error ?? "", /revision conflict/iu);
    assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null,
      "Repository CAS failure must leave the Experience retryable");
  });
}

async function scenarioInboxIsBoundedAndDeduplicated(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-dream-inbox-"));
  try {
    const store = new DreamExperienceInboxStore(root);
    const first = experienceInput(0, "以后默认先给结论");
    await store.append(first, 1);
    await store.append(first, 2);
    const deduped = await store.read();
    assert.equal(deduped.entries.length, 1);
    assert.equal(deduped.duplicateCount, 1);

    let state = defaultDreamExperienceInboxState();
    state = appendDreamPublicExperience(state, first, 1);
    state = markDreamExperiencesEvaluated(
      state,
      new Set([state.entries[0]!.fingerprint]),
      2
    );
    for (let index = 1; index <= DREAM_EXPERIENCE_MAX_ITEMS + 2; index += 1) {
      state = appendDreamPublicExperience(state, experienceInput(index, `公开输入 ${index}`), index + 2);
    }
    assert.equal(state.entries.length, DREAM_EXPERIENCE_MAX_ITEMS);
    assert.equal(state.droppedEvaluatedCount, 1, "oldest evaluated entries leave first");
    assert.equal(state.droppedUnevaluatedCount, 2, "overflow of pending entries stays diagnostic");

    const beforeOversizeDrops = state.droppedUnevaluatedCount;
    state = appendDreamPublicExperience(
      state,
      experienceInput(999, "大".repeat(DREAM_EXPERIENCE_MAX_BYTES)),
      999
    );
    assert.ok(Buffer.byteLength(dreamExperienceInboxJson(state), "utf8") <= DREAM_EXPERIENCE_MAX_BYTES);
    assert.ok(state.droppedUnevaluatedCount > beforeOversizeDrops);
    assert.equal(state.entries.some((entry) => entry.productRunId === "run-999"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scenarioRuntimeCaptureKeepsOnlyPublicMinimalData(): void {
  const entries = [
    {
      type: "message",
      id: "user-entry",
      message: {
        role: "user",
        content: [
          { type: "text", text: "公开问题" },
          { type: "image", data: "ATTACHMENT_BODY_SECRET" }
        ],
        timestamp: 1
      }
    },
    {
      type: "message",
      id: "assistant-entry",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "HIDDEN_REASONING_SECRET" },
          { type: "text", text: "公开答复" },
          { type: "toolCall", id: "call-1", name: "vault_write", arguments: { secret: "RAW_TOOL_SECRET" } }
        ],
        stopReason: "stop",
        timestamp: 2
      }
    },
    {
      type: "message",
      id: "tool-entry",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "vault_write",
        content: [{ type: "text", text: "RAW_TOOL_RESULT_SECRET" }],
        details: { secret: "RAW_TOOL_DETAILS_SECRET" },
        isError: false,
        timestamp: 3
      }
    }
  ] as never;
  const captured = buildDreamPublicExperienceFromRun({
    conversationId: "conversation-public",
    productRunId: "run-public",
    userEntryId: "user-entry",
    assistantEntryId: "assistant-entry",
    terminalState: "completed",
    occurredAt: 4,
    entries
  });
  assert.ok(captured);
  assert.equal(captured.userText, "公开问题");
  assert.equal(captured.assistantText, "公开答复");
  assert.deepEqual(captured.taskResult.successfulToolNames, ["vault_write"]);
  const json = JSON.stringify(captured);
  for (const secret of [
    "ATTACHMENT_BODY_SECRET",
    "HIDDEN_REASONING_SECRET",
    "RAW_TOOL_SECRET",
    "RAW_TOOL_RESULT_SECRET",
    "RAW_TOOL_DETAILS_SECRET"
  ]) assert.doesNotMatch(json, new RegExp(secret, "u"));
}

function scenarioSelfEvidenceThresholdsAreFailClosed(): void {
  const first = normalizeDreamPublicExperience(experienceInput(
    1,
    "以后默认先给结论，我在复杂任务中也会先核对证据"
  ));
  const second = normalizeDreamPublicExperience(experienceInput(
    2,
    "另一次复杂任务里，我仍然先核对证据"
  ));
  const sources = buildDreamSelfSources([], [first, second], 2_000);

  const explicit = parseDreamSelfOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "复杂任务先核对证据",
      basis: "explicit",
      sources: [{
        sourceId: sources[0]!.sourceId,
        evidenceQuote: "以后默认先给结论"
      }]
    }]
  }), sources);
  assert.equal(explicit?.length, 1, "one explicit long-term statement is sufficient");

  const temporaryExperience = normalizeDreamPublicExperience(experienceInput(
    3,
    "这次临时处理；以后默认这样只用于本次"
  ));
  const temporarySources = buildDreamSelfSources([], [temporaryExperience], 2_000);
  const temporary = parseDreamSelfOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "永久采用临时例外",
      basis: "explicit",
      sources: [{
        sourceId: temporarySources[0]!.sourceId,
        evidenceQuote: "这次临时处理；以后默认这样只用于本次"
      }]
    }]
  }), temporarySources);
  assert.equal(temporary?.length, 0, "a one-off exception cannot become durable Self");

  const oneInference = parseDreamSelfOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "复杂任务先核对证据",
      basis: "inferred",
      sources: [{
        sourceId: sources[0]!.sourceId,
        evidenceQuote: "复杂任务中也会先核对证据"
      }]
    }]
  }), sources);
  assert.equal(oneInference?.length, 0, "one behavioral observation cannot become durable Self");

  const twoInference = parseDreamSelfOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "复杂任务先核对证据",
      basis: "inferred",
      sources: sources.map((source, index) => ({
        sourceId: source.sourceId,
        evidenceQuote: index === 0 ? "复杂任务中也会先核对证据" : "仍然先核对证据"
      }))
    }]
  }), sources);
  assert.equal(twoInference?.length, 1);
}

function scenarioDreamInputsAreUntrustedAndUserGrowthUsesPublicEvidence(): void {
  const sameRunMemory: PersonalMemoryRecord = Object.freeze({
    schema: PERSONAL_MEMORY_SCHEMA,
    id: "memory-same-product-run",
    kind: "view",
    status: "current",
    date: "2026-08-30",
    source: "pi://vault/conversation-a/session-a/user-a?productRun=run-shared",
    basis: "observed",
    contentOrigin: "agent_inference",
    title: "同一任务观察",
    recallWhen: "验证来源分组时",
    content: "复杂任务先核对证据",
    revision: 1,
    file: "shared-user/memory/views/memory-same-product-run.md"
  });
  const sameRunExperience = normalizeDreamPublicExperience(Object.freeze({
    ...experienceInput(60, "复杂任务先核对证据"),
    productRunId: "run-shared"
  }));
  const sameRunSources = buildDreamSelfSources(
    [sameRunMemory],
    [sameRunExperience],
    2_000
  );
  assert.equal(sameRunSources[0]?.contextId, "task:run-shared");
  assert.equal(sameRunSources[1]?.contextId, "task:run-shared");
  assert.equal(parseDreamSelfOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "复杂任务先核对证据",
      basis: "inferred",
      sources: [
        { sourceId: sameRunSources[0]!.sourceId, evidenceQuote: "复杂任务先核对证据" },
        { sourceId: sameRunSources[1]!.sourceId, evidenceQuote: "复杂任务先核对证据" }
      ]
    }]
  }), sameRunSources)?.length, 0, "one ProductRun is one source group");

  const userFirst = normalizeDreamPublicExperience(experienceInput(
    61,
    "我偏好先看结论，再看详细依据"
  ));
  const userSecond = normalizeDreamPublicExperience(experienceInput(
    62,
    "遇到另一个任务时，我仍然偏好先看结论"
  ));
  const userSources = buildDreamSelfSources([], [userFirst, userSecond], 2_000);
  const inferredUser = parseDreamGrowthOutput(JSON.stringify({
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.format",
      text: "偏好先看结论，再看详细依据",
      basis: "inferred",
      sources: [
        { sourceId: userSources[0]!.sourceId, evidenceQuote: "我偏好先看结论，再看详细依据" },
        { sourceId: userSources[1]!.sourceId, evidenceQuote: "我仍然偏好先看结论" }
      ]
    }]
  }), userSources);
  assert.equal(inferredUser?.userProfileItems.length, 1);
  assert.equal(new Set(inferredUser?.userProfileItems[0]?.sourceIds).size, 2);

  const explicitUser = parseDreamGrowthOutput(JSON.stringify({
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.language",
      text: "长期使用中文",
      basis: "explicit",
      sources: [{
        sourceId: userSources[0]!.sourceId,
        evidenceQuote: "我偏好先看结论"
      }]
    }]
  }), userSources);
  assert.equal(explicitUser?.userProfileItems.length, 1,
    "one direct user statement may produce an explicit USER candidate");

  const assistantOnly = [70, 71].map((index) => normalizeDreamPublicExperience(Object.freeze({
    ...experienceInput(index, `公开问题 ${index}`),
    assistantText: "我会长期坚持先给结论"
  })));
  const assistantSources = buildDreamSelfSources([], assistantOnly, 2_000);
  const explicitWithAssistant = parseDreamGrowthOutput(JSON.stringify({
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.format",
      text: "偏好先看结论，再看详细依据",
      basis: "explicit",
      sources: [
        {
          sourceId: userSources[0]!.sourceId,
          evidenceQuote: "我偏好先看结论，再看详细依据"
        },
        {
          sourceId: assistantSources[0]!.sourceId,
          evidenceQuote: "我会长期坚持先给结论"
        }
      ]
    }]
  }), [...userSources, ...assistantSources]);
  assert.deepEqual(explicitWithAssistant?.userProfileItems[0]?.sourceIds, [
    userSources[0]!.profileSourceId
  ], "assistant evidence is analysis context, never persisted USER provenance");
  let explicitProfile = emptyUserProfileState(30);
  for (const sourceId of explicitWithAssistant?.userProfileItems[0]?.sourceIds ?? []) {
    explicitProfile = applyDreamProfileUpdate(explicitProfile, {
      items: [{
        section: "preference",
        profileKey: "preference.format",
        text: "偏好先看结论，再看详细依据",
        basis: "explicit_memory",
        sourceMemoryId: sourceId
      }],
      processedSources: [],
      now: 31
    });
  }
  assert.deepEqual(
    explicitProfile.items.find((item) => item.status === "current")?.sourceMemoryIds,
    [userSources[0]!.profileSourceId]
  );

  const inferredWithAssistant = parseDreamGrowthOutput(JSON.stringify({
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.format",
      text: "偏好先看结论，再看详细依据",
      basis: "inferred",
      sources: [
        {
          sourceId: userSources[0]!.sourceId,
          evidenceQuote: "我偏好先看结论，再看详细依据"
        },
        {
          sourceId: assistantSources[0]!.sourceId,
          evidenceQuote: "我会长期坚持先给结论"
        },
        {
          sourceId: userSources[1]!.sourceId,
          evidenceQuote: "我仍然偏好先看结论"
        }
      ]
    }]
  }), [...userSources, ...assistantSources]);
  assert.deepEqual(inferredWithAssistant?.userProfileItems[0]?.sourceIds, [
    userSources[0]!.profileSourceId,
    userSources[1]!.profileSourceId
  ], "inferred USER provenance contains only the two independent user votes");
  let inferredProfile = emptyUserProfileState(40);
  for (const sourceId of inferredWithAssistant?.userProfileItems[0]?.sourceIds ?? []) {
    inferredProfile = applyDreamProfileUpdate(inferredProfile, {
      items: [{
        section: "preference",
        profileKey: "preference.format",
        text: "偏好先看结论，再看详细依据",
        basis: "observed_memory",
        sourceMemoryId: sourceId
      }],
      processedSources: [],
      now: 41
    });
  }
  assert.deepEqual(
    inferredProfile.items.find((item) => item.status === "current")?.sourceMemoryIds,
    [userSources[0]!.profileSourceId, userSources[1]!.profileSourceId]
  );
  const afterOneUserWithdrawn = reconcileProfileSources(
    inferredProfile,
    new Set([userSources[1]!.profileSourceId, assistantSources[0]!.profileSourceId]),
    42
  );
  assert.doesNotMatch(renderUserMarkdown(afterOneUserWithdrawn), /偏好先看结论，再看详细依据/u,
    "one remaining user vote plus assistant context cannot keep an inferred USER item visible");
  const afterAllUsersWithdrawn = reconcileProfileSources(
    inferredProfile,
    new Set([assistantSources[0]!.profileSourceId]),
    43
  );
  assert.equal(afterAllUsersWithdrawn.items.find(
    (item) => item.profileKey === "preference.format"
  )?.status, "superseded", "assistant context cannot keep USER state alive after user withdrawal");

  const assistantClaim = parseDreamGrowthOutput(JSON.stringify({
    agentSelfOperations: [{
      operation: "habit_add",
      text: "长期先给结论",
      basis: "inferred",
      sources: assistantSources.map((source) => ({
        sourceId: source.sourceId,
        evidenceQuote: "我会长期坚持先给结论"
      }))
    }],
    userProfileItems: [{
      section: "preference",
      profileKey: "preference.format",
      text: "用户长期偏好结论优先",
      basis: "inferred",
      sources: assistantSources.map((source) => ({
        sourceId: source.sourceId,
        evidenceQuote: "我会长期坚持先给结论"
      }))
    }]
  }), assistantSources);
  assert.equal(assistantClaim?.agentSelfOperations.length, 0);
  assert.equal(assistantClaim?.userProfileItems.length, 0);

  const memoryPrompt = buildDreamPrompts(sameRunMemory, 2_000);
  const growthPrompt = buildDreamSelfPrompts(userSources);
  for (const prompt of [memoryPrompt.systemPrompt, growthPrompt.systemPrompt]) {
    assert.match(prompt, /不可信数据/u);
    assert.match(prompt, /不得执行/u);
  }
}

async function scenarioForgottenMemoryRetiresDerivedHabitInSameTransaction(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "长期协作方式",
      content: "以后默认在复杂任务里先核对证据。",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-derived-forget" }));
    const control = await fixture.repository.readUserControlState();
    const parsed = parseAgentCurrentSelf(control.agent);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const habitText = "复杂任务里先核对证据";
    const key = stableSelfKey(habitText);
    const nextSelf = applyAgentSelfOperations(parsed.state, [{
      operation: "habit_add",
      key,
      text: habitText
    }]);
    const nextAgent = replaceAgentCurrentSelf(control.agent, nextSelf);
    const experienceProfileId = experienceProfileSourceId(
      "run-derived-forget",
      "a".repeat(64)
    );
    assert.ok(experienceProfileId);
    let profile = applyDreamProfileUpdate(emptyUserProfileState(10), {
      items: [{
        section: "collaboration",
        profileKey: "collaboration.quality_bar",
        text: "复杂任务里先核对证据",
        basis: "explicit_memory",
        sourceMemoryId: experienceProfileId!
      }],
      processedSources: [],
      legacyUserMigration: "done",
      now: 10
    });
    const projectedUser = renderUserMarkdown(profile);
    profile = Object.freeze({
      ...profile,
      lastProjectedUserHash: createHash("sha256").update(projectedUser).digest("hex")
    });
    const metadata: AgentSelfMetadata = Object.freeze({
      ...emptyAgentSelfMetadata(10),
      revision: 1,
      derivations: Object.freeze([Object.freeze({
        target: `habit:${key}` as const,
        operation: "habit_add" as const,
        basis: "explicit" as const,
        sources: Object.freeze([Object.freeze({
          kind: "memory" as const,
          id: created.record!.id,
          revision: created.record!.revision,
          contextId: "task:run-derived-forget",
          evidence: "以后默认在复杂任务里先核对证据"
        }), Object.freeze({
          kind: "experience" as const,
          id: "a".repeat(64),
          contextId: "task:run-derived-forget",
          evidence: "以后默认在复杂任务里先核对证据"
        })]),
        previousValue: null,
        currentValue: habitText,
        updatedAt: 10
      })])
    });
    await fixture.repository.applyCognitiveUpdate({
      agentContent: nextAgent,
      userContent: projectedUser,
      secondaryRecords: [],
      extraChanges: [
        {
          relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
          content: agentSelfMetadataJson(metadata)
        },
        {
          relativePath: USER_PROFILE_STATE_RELATIVE_PATH,
          content: userProfileStateJson(profile)
        }
      ],
      expectedMemoryRevision: control.revision,
      expectedAgentProjectionHash: createHash("sha256").update(control.agent.endsWith("\n") ? control.agent : `${control.agent}\n`).digest("hex"),
      expectedUserProjectionHash: createHash("sha256").update(
        control.user.endsWith("\n") ? control.user : `${control.user}\n`
      ).digest("hex"),
      detail: "test-derived-habit"
    });
    const beforeForget = await fixture.repository.readUserControlState();
    assert.equal(parseAgentCurrentSelf(beforeForget.agent).kind, "ok");
    assert.match(beforeForget.agent, new RegExp(habitText, "u"));

    await fixture.repository.forgetFromUserControl(
      created.record!.id,
      "用户要求忘记来源",
      beforeForget.revision
    );
    const afterForget = await fixture.repository.readUserControlState();
    const afterSelf = parseAgentCurrentSelf(afterForget.agent);
    assert.equal(afterSelf.kind, "ok");
    if (afterSelf.kind === "ok") {
      assert.equal(afterSelf.state.currentLearnedHabits.some((habit) => habit.key === key), false);
    }
    const afterMetadata = await new AgentSelfMetadataStore(fixture.repository.layout.root).read();
    assert.deepEqual(afterMetadata?.derivations, []);
    assert.doesNotMatch(afterForget.user, /复杂任务里先核对证据/u,
      "forget also retires USER projection derived from the same ProductRun Experience");
  });
}

async function scenarioCorrectedMemoryRetiresSameRunExperienceDerivation(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "待纠正的长期协作方式",
      content: "以后默认在复杂任务里先快速行动。",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-derived-correction" }));
    const retained = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "同一任务仍然有效的另一条记忆",
      content: "该任务还确认了需要保留检查清单。",
      recallWhen: "处理同类任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-derived-correction" }));
    const control = await fixture.repository.readUserControlState();
    const parsed = parseAgentCurrentSelf(control.agent);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const habitText = "复杂任务里先快速行动";
    const key = stableSelfKey(habitText);
    const nextAgent = replaceAgentCurrentSelf(control.agent, applyAgentSelfOperations(
      parsed.state,
      [{ operation: "habit_add", key, text: habitText }]
    ));
    const experienceProfileId = experienceProfileSourceId(
      "run-derived-correction",
      "b".repeat(64)
    );
    assert.ok(experienceProfileId);
    let profile = applyDreamProfileUpdate(emptyUserProfileState(20), {
      items: [{
        section: "collaboration",
        profileKey: "collaboration.quality_bar",
        text: habitText,
        basis: "explicit_memory",
        sourceMemoryId: experienceProfileId!
      }],
      processedSources: [],
      legacyUserMigration: "done",
      now: 20
    });
    const projectedUser = renderUserMarkdown(profile);
    profile = Object.freeze({
      ...profile,
      lastProjectedUserHash: createHash("sha256").update(projectedUser).digest("hex")
    });
    const metadata: AgentSelfMetadata = Object.freeze({
      ...emptyAgentSelfMetadata(20),
      revision: 1,
      derivations: Object.freeze([Object.freeze({
        target: `habit:${key}` as const,
        operation: "habit_add" as const,
        basis: "explicit" as const,
        sources: Object.freeze([
          Object.freeze({
            kind: "memory" as const,
            id: created.record!.id,
            revision: created.record!.revision,
            contextId: "task:run-derived-correction",
            evidence: "以后默认在复杂任务里先快速行动"
          }),
          Object.freeze({
            kind: "experience" as const,
            id: "b".repeat(64),
            contextId: "task:run-derived-correction",
            evidence: "以后默认在复杂任务里先快速行动"
          })
        ]),
        previousValue: null,
        currentValue: habitText,
        updatedAt: 20
      })])
    });
    await fixture.repository.applyCognitiveUpdate({
      agentContent: nextAgent,
      userContent: projectedUser,
      secondaryRecords: [],
      extraChanges: [
        {
          relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
          content: agentSelfMetadataJson(metadata)
        },
        {
          relativePath: USER_PROFILE_STATE_RELATIVE_PATH,
          content: userProfileStateJson(profile)
        }
      ],
      expectedMemoryRevision: control.revision,
      expectedAgentProjectionHash: createHash("sha256").update(
        control.agent.endsWith("\n") ? control.agent : `${control.agent}\n`
      ).digest("hex"),
      expectedUserProjectionHash: createHash("sha256").update(
        control.user.endsWith("\n") ? control.user : `${control.user}\n`
      ).digest("hex"),
      detail: "test-corrected-derived-habit"
    });
    const beforeCorrection = await fixture.repository.readUserControlState();
    await fixture.repository.supersedeFromUserCorrection({
      targetId: created.record!.id,
      title: "已纠正的长期协作方式",
      content: "复杂任务应先核对关键证据，再决定行动。",
      recallWhen: "处理复杂任务时",
      reason: "用户纠正旧偏好",
      expectedRevision: beforeCorrection.revision
    });
    const afterCorrection = await fixture.repository.readUserControlState();
    const afterSelf = parseAgentCurrentSelf(afterCorrection.agent);
    assert.equal(afterSelf.kind, "ok");
    if (afterSelf.kind === "ok") {
      assert.equal(afterSelf.state.currentLearnedHabits.some((habit) => habit.key === key), false);
    }
    assert.deepEqual(
      (await new AgentSelfMetadataStore(fixture.repository.layout.root).read())?.derivations,
      []
    );
    assert.doesNotMatch(afterCorrection.user, new RegExp(habitText, "u"),
      "correction retires same-ProductRun Experience-derived USER items even when another Memory remains current");
    const currentIds = new Set((await fixture.repository.inspect()).records
      .filter((record) => record.status === "current")
      .map((record) => record.id));
    assert.equal(currentIds.has(retained.record!.id), true,
      "the unrelated current Memory from the same ProductRun remains intact");
  });
}

function experienceInput(index: number, userText: string) {
  return Object.freeze({
    conversationId: `conversation-${index}`,
    productRunId: `run-${index}`,
    userEntryId: `user-${index}`,
    assistantEntryId: `assistant-${index}`,
    occurredAt: index + 1,
    userText,
    assistantText: `公开答复 ${index}`,
    taskResult: Object.freeze({
      terminalState: "completed" as const,
      successfulToolNames: Object.freeze([`tool_${index}`]),
      failedToolNames: Object.freeze([])
    })
  });
}
