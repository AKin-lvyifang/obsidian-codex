import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { PiNativeFileStoreError } from "../../harness/pi-native/file-store-utils";
import {
  PiNativeConversationRuntime,
  PiNativeConversationRuntimeError,
  type PiNativeAgentSessionFactoryInput,
  type PiNativeConversationRuntimeOptions,
  type PiNativeKnowledgeTurnContext,
  type PiNativeMemoryTurnContext,
  type PiNativeTaskPlanTurnContext
} from "../../harness/pi-native/pi-native-conversation-runtime";
import type {
  PiChatRuntimeEvent,
  PiKnowledgeRuntimePort,
  PiKnowledgeReference
} from "../../harness/pi-native/contracts";
import {
  PiSessionDurabilityError,
  type PiSessionManagerApi
} from "../../harness/pi-native/pi-session-durability";
import {
  appendTaskPlanEntry
} from "../../harness/pi-native/pi-task-plan";
import {
  closeReasoningSummary,
  completeReasoningAtFirstText,
  createReasoningSummary,
  updateReasoningActivity
} from "../../harness/pi-native/pi-reasoning-summary";
import { routeKnowledgeConversationCommand } from "../../knowledge-base/commands";
import {
  createKnowledgeMaintenanceResultEnvelope
} from "../../knowledge-base/knowledge-maintenance-result";
import {
  PI_CONTEXT_LEDGER_CUSTOM_TYPE,
  buildPiContextLedger,
  calculatePiEffectiveInputBudget
} from "../../harness/pi-native/pi-context-budget";
import {
  ECHOINK_TASK_PLAN_SCHEMA_VERSION,
  freezeEchoInkTaskPlan,
  latestTaskPlanFromBranch
} from "../../types/task-plan";
import {
  reasoningSummaryFromSessionEntry,
  type EchoInkReasoningSummarySnapshot
} from "../../types/reasoning-summary";

const API: PiSessionManagerApi = {
  codingAgentVersion: VERSION,
  currentSessionVersion: CURRENT_SESSION_VERSION,
  open: (sessionFile, sessionRoot, cwdOverride) =>
    SessionManager.open(sessionFile, sessionRoot, cwdOverride)
};

const QUERY_MAINTENANCE_SCOPE = Object.freeze({
  mode: "query" as const,
  candidatePaths: Object.freeze(["raw/a.md"])
});

export async function runPiNativeConversationRuntimeTests(): Promise<void> {
  assertReasoningSummaryLifecycleSemantics();
  await assertReasoningSummaryRuntimeLifecycle();
  assertKnowledgeMaintenanceRequiresExplicitCommand();
  await assertProjectionAndCatalogManagementStayAgentSessionFree();
  await assertKnowledgeAskUsesAgentAndReadOnlyTools();
  await assertAskSourceAttributionCapturesOnlyInjectedPrimaryMemory();
  await assertKnowledgeObservationAndProgressArePrivacySafe();
  await assertKnowledgeMaintenancePreferenceSnapshotIsTurnBound();
  await assertKnowledgeMaintenanceSettlementRequiresUniqueDurableResult();
  await assertTrustedKnowledgeMaintenanceResultsSurviveSettlementAndReopen();
  await runPiNativeDurableSettlementProjectionRegressionTest();
  await assertAgentSessionWarningsUseConversationSupport();
  await assertSkillPromptAndBindingValidation();
  await assertDurableDraftRequiresExplicitSuccessfulResubmission();
  await assertVerifiedPrefixRecoveryIsExplicitAndFailClosed();
  await assertExperienceSourceRefsArePointerOnlyAndDeleteAware();
  await assertMemoryTurnIsAvailableBeforeUserEntryPersistence();
  await assertProductRunCreateFailureCleansRuntime();
  await assertProductRunUpdateFailureCleansRuntime();
  await assertSubscriberFailuresAreIsolated();
  await assertSettlementFailureIsDiagnosedAndReleasesRun();
  await assertPromptStartFailureReleasesSettlementBarrier();
  await assertConversationTeardownWaitsForSettlement("release");
  await assertConversationTeardownWaitsForSettlement("shutdown");
  await assertConversationDerivationCreatesIndependentDurablePrefixes();
  await assertDerivationExcludesIdentityBoundOperationalState();
  await assertDerivedActivationFailureRemainsAVisibleDurableConversation();
  await runPiNativeTaskPlanRuntimeTests();
}

function assertReasoningSummaryLifecycleSemantics(): void {
  const started = createReasoningSummary({
    conversationId: "conversation-reasoning",
    piSessionId: "session-reasoning",
    productRunId: "run-reasoning",
    startedAt: 10
  });
  const answered = completeReasoningAtFirstText({
    summary: started,
    observedAt: 20
  });
  const updatedAfterAnswer = updateReasoningActivity({
    summary: answered,
    activity: {
      id: "tool-call-1",
      kind: "tool",
      status: "completed",
      name: "task_update",
      startedAt: 18,
      updatedAt: 25
    }
  });
  assert.equal(updatedAfterAnswer.status, "completed");
  assert.equal(updatedAfterAnswer.firstAssistantTextAt, 20);
  assert.equal(updatedAfterAnswer.updatedAt, 25);
  assert.deepEqual(updatedAfterAnswer.activities.map((activity) => activity.id), [
    "tool-call-1"
  ]);

  const completedWithoutText = closeReasoningSummary({
    summary: createReasoningSummary({
      conversationId: "conversation-no-text",
      piSessionId: "session-no-text",
      productRunId: "run-no-text",
      startedAt: 30
    }),
    status: "completed",
    terminalAt: 45
  });
  assert.equal(completedWithoutText.status, "completed");
  assert.equal(completedWithoutText.firstAssistantTextAt, undefined);
  assert.equal(completedWithoutText.terminalAt, 45);
}

async function assertReasoningSummaryRuntimeLifecycle(): Promise<void> {
  await withFixture([
    "run-reasoning-task",
    "run-reasoning-no-text",
    "run-reasoning-failed",
    "run-reasoning-interrupted",
    "run-reasoning-cancelled"
  ], async (fixture) => {
    fixture.configureFactoryTools({
      registered: ["task_update"],
      defaults: ["task_update"],
      planAllowed: []
    });
    const conversationId = "reasoning-runtime-lifecycle";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Reasoning runtime lifecycle",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();

    const taskRun = await fixture.runtime.submit({
      conversationId,
      text: "执行结构化任务",
      submittedAt: 2
    });
    const taskEvents: PiChatRuntimeEvent[] = [];
    fixture.runtime.subscribeProductRun(taskRun.productRunId, (event) => {
      taskEvents.push(structuredClone(event));
    });
    session.beginProviderRequest();
    session.emitAssistantText("首段公开回答");
    const plan = freezeEchoInkTaskPlan({
      schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
      planId: "reasoning-plan",
      title: "PRIVATE_TASK_TITLE_CANARY",
      status: "completed",
      version: 1,
      steps: [{
        stepId: "step-1",
        text: "PRIVATE_TASK_STEP_CANARY",
        status: "completed"
      }],
      source: "agent",
      productRunId: taskRun.productRunId,
      createdAt: 3,
      updatedAt: 4
    });
    session.finishTool("reasoning-task-update", "task_update", {
      details: { source: "echoink-task-plan", plan }
    }, false);
    assert.equal(
      reasoningSummariesForRun(session.sessionManager, taskRun.productRunId).length,
      1,
      "streaming Provider, first text, Tool, and Task updates never append custom entries"
    );
    session.finishSuccessful("最终公开回答");
    await taskRun.result;
    const taskSummaries = reasoningSummariesForRun(
      session.sessionManager,
      taskRun.productRunId
    );
    assert.equal(taskSummaries.length, 2);
    assert.equal(taskSummaries[0]?.terminalAt, undefined);
    assert.equal(taskSummaries[1]?.status, "completed");
    assert.ok(taskSummaries[1]?.firstAssistantTextAt);
    assert.ok(taskSummaries[1]?.terminalAt);
    assert.deepEqual(
      new Set(taskSummaries[1]?.activities.map((activity) => activity.kind)),
      new Set(["provider", "tool", "task"])
    );
    assert.doesNotMatch(
      JSON.stringify(taskSummaries),
      /PRIVATE_TASK_(?:TITLE|STEP)_CANARY/u
    );
    const taskReasoningEvents = taskEvents.filter(
      (event): event is Extract<PiChatRuntimeEvent, { type: "reasoning_summary" }> =>
        event.type === "reasoning_summary"
    );
    assert.equal(taskReasoningEvents[0]?.summary.status, "running");
    assert.ok(taskReasoningEvents.some((event) =>
      event.summary.firstAssistantTextAt !== undefined
      && event.summary.activities.some((activity) => activity.kind === "task")
    ), "post-answer Task updates remain visible in the same live snapshot");

    const noTextRun = await fixture.runtime.submit({
      conversationId,
      text: "合法无文本完成",
      submittedAt: 5
    });
    session.finishSuccessful("");
    await noTextRun.result;
    const noText = reasoningSummariesForRun(
      session.sessionManager,
      noTextRun.productRunId
    ).at(-1);
    assert.equal(noText?.status, "completed");
    assert.equal(noText?.firstAssistantTextAt, undefined);
    assert.ok(noText?.terminalAt);

    const failedRun = await fixture.runtime.submit({
      conversationId,
      text: "失败收口",
      submittedAt: 6
    });
    session.finishFailed("fixture failure");
    await failedRun.result;
    assert.equal(
      reasoningSummariesForRun(session.sessionManager, failedRun.productRunId).at(-1)?.status,
      "failed"
    );

    const interruptedRun = await fixture.runtime.submit({
      conversationId,
      text: "非 runtime abort 中断",
      submittedAt: 7
    });
    session.finishAborted();
    await interruptedRun.result;
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        interruptedRun.productRunId
      ).at(-1)?.status,
      "interrupted"
    );

    const cancelledRun = await fixture.runtime.submit({
      conversationId,
      text: "runtime abort 取消",
      submittedAt: 8
    });
    await fixture.runtime.abort(conversationId);
    await cancelledRun.result;
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        cancelledRun.productRunId
      ).at(-1)?.status,
      "cancelled"
    );
  });
}

function reasoningSummariesForRun(
  sessionManager: SessionManager,
  productRunId: string
): Readonly<EchoInkReasoningSummarySnapshot>[] {
  return sessionManager.getBranch().flatMap((entry) => {
    const summary = reasoningSummaryFromSessionEntry(
      entry,
      sessionManager.getSessionId()
    );
    return summary?.productRunId === productRunId ? [summary] : [];
  });
}

async function assertProjectionAndCatalogManagementStayAgentSessionFree():
Promise<void> {
  await withFixture([], async (fixture) => {
    for (const conversationId of ["history-a", "history-b", "history-managed"]) {
      await fixture.runtime.createConversation({
        conversationId,
        title: conversationId,
        cwd: fixture.root
      });
    }

    const projection = await fixture.runtime.readProjection("history-a");
    assert.equal(projection.catalog.conversationId, "history-a");
    assert.equal(fixture.sessions.length, 0, "readProjection must stay AgentSession-free");

    assert.equal((await fixture.runtime.listConversations()).length, 3);
    await fixture.runtime.setConversationStatus("history-managed", "archived");
    await fixture.runtime.setConversationStatus("history-managed", "deleted");
    assert.equal(
      fixture.sessions.length,
      0,
      "list, archive, and delete must stay AgentSession-free"
    );

    await fixture.runtime.activateConversation("history-a");
    assert.equal(fixture.sessions.length, 1, "opening must activate its AgentSession");
    await fixture.runtime.switchConversation("history-a", "history-b");
    assert.equal(fixture.sessions.length, 2, "switching must activate the target AgentSession");
  });
}

function assertKnowledgeMaintenanceRequiresExplicitCommand(): void {
  assert.deepEqual(routeKnowledgeConversationCommand("/maintain raw/a.md"), {
    kind: "maintain",
    originalText: "/maintain raw/a.md",
    request: "raw/a.md"
  });
  for (const text of [
    "请帮我整理知识库",
    "维护一下 Raw 和 Wiki",
    "把这些内容沉淀成知识笔记"
  ]) {
    assert.deepEqual(routeKnowledgeConversationCommand(text), {
      kind: "chat",
      originalText: text
    });
  }
}

async function assertKnowledgeMaintenancePreferenceSnapshotIsTurnBound():
Promise<void> {
  let finalizeCalls = 0;
  let currentPreference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    providerResourceText: string;
  }> = Object.freeze({
    profileVersion: "echoink-knowledge-preference-profile-v1",
    state: "custom" as const,
    revision: `sha256:${"a".repeat(64)}`,
    providerResourceText: "PREFERENCE_SNAPSHOT_A"
  });
  const knowledge: PiKnowledgeRuntimePort = {
    async prepareMaintenancePreferences() {
      return currentPreference;
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async finalizeMaintenance() {
      finalizeCalls += 1;
    }
  };
  await withFixture(["run-knowledge-maintain-snapshot"], async (fixture) => {
    fixture.configureFactoryTools({
      registered: ["vault_search", "note_read", "knowledge_maintain"],
      defaults: [],
      planAllowed: []
    });
    const conversationId = "knowledge-maintain-preference-snapshot";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Knowledge preference snapshot",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    const handle = await fixture.runtime.submit({
      conversationId,
      text: "/maintain raw/a.md",
      maintenanceScope: QUERY_MAINTENANCE_SCOPE,
      submittedAt: 3
    });

    currentPreference = Object.freeze({
      profileVersion: "echoink-knowledge-preference-profile-v1",
      state: "default" as const,
      revision: `sha256:${"b".repeat(64)}`,
      providerResourceText: "PREFERENCE_SNAPSHOT_B"
    });

    const turn = session.knowledgeTurnsBeforeUserEntryAppend.at(-1);
    assert.equal(turn?.kind, "maintain");
    const command = turn?.kind === "maintain"
      ? turn.command as unknown as Readonly<{
          mode: string;
          request: string;
          preference: typeof currentPreference;
        }>
      : null;
    if (!command || command.mode !== "maintain") {
      assert.fail("expected one direct maintenance turn snapshot");
    }
    assert.deepEqual(command.preference, {
      profileVersion: "echoink-knowledge-preference-profile-v1",
      state: "custom",
      revision: `sha256:${"a".repeat(64)}`,
      providerResourceText: "PREFERENCE_SNAPSHOT_A"
    });
    assert.deepEqual(
      fixture.currentKnowledgeTurn(),
      turn,
      "the active turn must retain its captured preference after settings change"
    );
    assert.deepEqual(
      new Set(session.activeToolSelections.at(-1)),
      new Set(["vault_search", "note_read", "knowledge_maintain"])
    );
    session.finishSuccessful("知识维护已完成。");
    assert.equal((await handle.result).terminalState, "failed");
    assert.equal(finalizeCalls, 0);
  }, { knowledge });
}

async function assertKnowledgeMaintenanceSettlementRequiresUniqueDurableResult():
Promise<void> {
  const finalizedProductRunIds: string[] = [];
  const knowledge: PiKnowledgeRuntimePort = {
    async prepareMaintenancePreferences() {
      return Object.freeze({
        profileVersion: "echoink-knowledge-preference-profile-v1",
        state: "default" as const,
        revision: `sha256:${"c".repeat(64)}`,
        providerResourceText: ""
      });
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async finalizeMaintenance(input) {
      finalizedProductRunIds.push(input.productRunId);
    }
  };
  const validEnvelope = createKnowledgeMaintenanceResultEnvelope({
    status: "completed",
    notes: [{
      operation: "created",
      path: "wiki/readback.md",
      title: "回读标题",
      summary: "来自知识维护最终回读的摘要"
    }],
    systemPaths: [".echoink/knowledge-maintenance/report.md"]
  });
  await withFixture(
    [
      "run-knowledge-maintain-valid-result",
      "run-knowledge-maintain-duplicate-result",
      "run-knowledge-maintain-missing-terminal-result",
      "run-knowledge-maintain-malformed-result",
      "run-knowledge-maintain-failed-result",
      "run-knowledge-maintain-mismatched-result",
      "run-knowledge-maintain-error-completed-result",
      "run-knowledge-maintain-error-noop-result"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["vault_search", "note_read", "knowledge_maintain"],
        defaults: [],
        planAllowed: []
      });
      const conversationId = "knowledge-maintain-settlement";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Knowledge maintenance settlement",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      let session = fixture.latestSession();

      const valid = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 3
      });
      session.finishTool(
        "maintain-valid",
        "knowledge_maintain",
        { details: { status: "completed", maintenanceResult: validEnvelope } },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await valid.result).terminalState, "completed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);

      const duplicate = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 4
      });
      for (const suffix of ["one", "two"]) {
        session.finishTool(
          `maintain-duplicate-${suffix}`,
          "knowledge_maintain",
          { details: { status: "completed", maintenanceResult: validEnvelope } },
          false
        );
      }
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await duplicate.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);
      session = await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId
      );

      const failedResult = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 7
      });
      session.finishTool(
        "maintain-failed",
        "knowledge_maintain",
        {
          details: {
            status: "failed",
            maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
              status: "failed",
              issues: [{
                code: "write_failed",
                message: "知识维护写入失败"
              }]
            })
          }
        },
        true
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await failedResult.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);

      const missingTerminal = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 5
      });
      session.startTool(
        "maintain-without-result",
        "knowledge_maintain",
        { request: "raw/a.md" }
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await missingTerminal.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);
      session = await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId
      );

      for (const [index, status] of (["completed", "noop"] as const).entries()) {
        const errorSuccess = await fixture.runtime.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 9 + index
        });
        session.finishTool(
          `maintain-error-${status}`,
          "knowledge_maintain",
          {
            details: {
              status: "completed",
              maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
                status,
                ...(status === "completed"
                  ? {
                      notes: [{
                        operation: "created" as const,
                        path: "wiki/error-success.md",
                        title: "错误结果不得伪装成功",
                        summary: "isError=true 与成功信封冲突"
                      }]
                    }
                  : {})
              })
            }
          },
          true
        );
        session.finishSuccessful("知识维护已完成。");
        assert.equal((await errorSuccess.result).terminalState, "failed");
        assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);
        session = await assertInvalidMaintenanceResultSurvivesReopen(
          fixture,
          conversationId
        );
      }

      const malformed = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 6
      });
      session.finishTool(
        "maintain-malformed",
        "knowledge_maintain",
        {
          details: {
            status: "completed",
            maintenanceResult: { ...validEnvelope, schema: "forged.v1" }
          }
        },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await malformed.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);
      session = await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId
      );

      const mismatched = await fixture.runtime.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 8
      });
      session.finishTool(
        "same-run-note-read",
        "note_read",
        { details: { status: "completed" } },
        false
      );
      session.startTool(
        "maintain-mismatched-call",
        "knowledge_maintain",
        { request: "raw/a.md" }
      );
      session.finishToolResult(
        "maintain-mismatched-result",
        "knowledge_maintain",
        { details: { status: "completed", maintenanceResult: validEnvelope } },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await mismatched.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);
      await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId,
        "same-run-note-read"
      );
    },
    { knowledge }
  );
}

async function assertInvalidMaintenanceResultSurvivesReopen(
  fixture: RuntimeFixture,
  conversationId: string,
  expectedOtherToolCallId?: string
): Promise<ControlledAgentSession> {
  const currentRunId = (await fixture.productRuns.list(conversationId)).at(-1)
    ?.productRunId;
  const assertProjection = async (label: string): Promise<void> => {
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.knowledgeBaseUi !== undefined
      ),
      false,
      label
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.text === "知识维护已完成。"
      ),
      true,
      `${label} must retain the Agent response without projecting a failure card`
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.text === "未取得唯一且可信的知识维护结果。"
      ),
      false,
      `${label} must not project the temporary invalid-result failure card`
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.title === "知识维护失败"
      ),
      false,
      `${label} must not rewrite Agent messages as repeated failure cards`
    );
    if (expectedOtherToolCallId) {
      assert.equal(
        projection.messages.some((message) =>
          message.runId === currentRunId
          && message.id.endsWith(`:tool:${expectedOtherToolCallId}`)
          && message.status === "completed"
        ),
        true,
        `${label} must retain the other Tool result`
      );
    }
  };
  await assertProjection("live projection");
  await fixture.runtime.releaseConversation(conversationId);
  await assertProjection("reopened projection");
  await fixture.runtime.activateConversation(conversationId);
  await assertProjection("reactivated projection");
  return fixture.latestSession();
}

async function assertTrustedKnowledgeMaintenanceResultsSurviveSettlementAndReopen():
Promise<void> {
  const knowledge = maintenanceKnowledgeFixture();
  const cases = [
    { status: "partial", isError: true },
    { status: "failed", isError: true },
    { status: "write_uncertain", isError: true }
  ] as const;
  await withFixture(
    [
      ...cases.map(({ status }) => `run-maintain-trusted-${status}`),
      "run-maintain-completed-agent-failed",
      "run-maintain-noop-agent-failed"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["vault_search", "note_read", "knowledge_maintain"],
        defaults: [],
        planAllowed: []
      });

      for (const [index, testCase] of cases.entries()) {
        const conversationId = `maintain-trusted-${testCase.status}`;
        await createAndActivateMaintenanceConversation(
          fixture,
          conversationId
        );
        const handle = await fixture.runtime.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 10 + index
        });
        const envelope = createKnowledgeMaintenanceResultEnvelope({
          status: testCase.status,
          notes: [{
            operation: "created",
            path: `wiki/${testCase.status}.md`,
            title: `${testCase.status} 回读标题`,
            summary: `${testCase.status} 回读摘要`
          }],
          issues: [{
            code: `${testCase.status}_issue`,
            message: `${testCase.status} 真实问题`,
            path: `raw/${testCase.status}.md`
          }],
          systemPaths: [`.echoink/${testCase.status}-report.md`]
        });
        fixture.latestSession().finishTool(
          `maintain-trusted-${testCase.status}`,
          "knowledge_maintain",
          { details: { status: "failed", maintenanceResult: envelope } },
          testCase.isError
        );
        fixture.latestSession().finishSuccessful("维护结果见卡片。");
        assert.equal((await handle.result).terminalState, "failed");
        await assertMaintenanceCardSurvivesReopen({
          fixture,
          conversationId,
          productRunId: handle.productRunId,
          expectedTitle: testCase.status === "partial"
            ? "知识维护部分完成"
            : testCase.status === "write_uncertain"
              ? "知识写入状态不确定"
              : "知识维护失败",
          expectedStatus: "failed",
          expectedNotePath: `wiki/${testCase.status}.md`,
          expectedNoteDescription: `${testCase.status} 回读摘要`,
          expectedIssuePath: `raw/${testCase.status}.md`,
          expectedIssueDescription: `${testCase.status} 真实问题`
        });
      }

      for (const [index, status] of (["completed", "noop"] as const).entries()) {
        const conversationId = `maintain-${status}-agent-failed`;
        await createAndActivateMaintenanceConversation(
          fixture,
          conversationId
        );
        const handle = await fixture.runtime.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 20 + index
        });
        const envelope = createKnowledgeMaintenanceResultEnvelope({
          status,
          ...(status === "completed"
            ? {
                notes: [{
                  operation: "created" as const,
                  path: "wiki/completed-before-agent-failure.md",
                  title: "已完成的知识动作",
                  summary: "Tool 已回读成功，后续 Agent 回答失败"
                }]
              }
            : {}),
          systemPaths: [`.echoink/${status}-report.md`]
        });
        fixture.latestSession().finishTool(
          `maintain-${status}-agent-failed`,
          "knowledge_maintain",
          { details: { status: "completed", maintenanceResult: envelope } },
          false
        );
        fixture.latestSession().finishFailed("后续 Agent 回答失败");
        assert.equal((await handle.result).terminalState, "failed");
        await assertMaintenanceCardSurvivesReopen({
          fixture,
          conversationId,
          productRunId: handle.productRunId,
          expectedTitle: status === "completed"
            ? "知识维护完成"
            : "没有需要提炼的知识",
          expectedStatus: "success",
          ...(status === "completed"
            ? { expectedNotePath: "wiki/completed-before-agent-failure.md" }
            : {})
        });
      }
    },
    { knowledge }
  );
}

function maintenanceKnowledgeFixture(): PiKnowledgeRuntimePort {
  return {
    async prepareMaintenancePreferences() {
      return Object.freeze({
        profileVersion: "echoink-knowledge-preference-profile-v1",
        state: "default" as const,
        revision: `sha256:${"d".repeat(64)}`,
        providerResourceText: ""
      });
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    }
  };
}

async function createAndActivateMaintenanceConversation(
  fixture: RuntimeFixture,
  conversationId: string
): Promise<void> {
  await fixture.runtime.createConversation({
    conversationId,
    title: conversationId,
    cwd: fixture.root,
    createdAt: 2
  });
  await fixture.runtime.activateConversation(conversationId);
}

async function assertMaintenanceCardSurvivesReopen(input: Readonly<{
  fixture: RuntimeFixture;
  conversationId: string;
  productRunId: string;
  expectedTitle: string;
  expectedStatus: "success" | "failed";
  expectedNotePath?: string;
  expectedNoteDescription?: string;
  expectedIssuePath?: string;
  expectedIssueDescription?: string;
}>): Promise<void> {
  const assertProjection = async (label: string): Promise<void> => {
    const projection = await input.fixture.runtime.readProjection(
      input.conversationId
    );
    const card = projection.messages.find((message) =>
      message.runId === input.productRunId && message.knowledgeBaseUi
    )?.knowledgeBaseUi;
    assert.ok(card, `${label} must retain the trusted maintenance card`);
    assert.equal(card.title, input.expectedTitle, label);
    assert.equal(card.status, input.expectedStatus, label);
    if (input.expectedNotePath) {
      const note = card.sections.flatMap((section) => section.items).find(
        (item) => item.path === input.expectedNotePath
      );
      assert.ok(note, `${label} must retain the readback note path`);
      if (input.expectedNoteDescription) {
        assert.match(note.description ?? "", new RegExp(
          input.expectedNoteDescription
        ));
      }
    }
    if (input.expectedIssuePath) {
      const issue = card.sections.flatMap((section) => section.items).find(
        (item) => item.path === input.expectedIssuePath
      );
      assert.ok(issue, `${label} must retain the issue path`);
      if (input.expectedIssueDescription) {
        assert.equal(issue.description, input.expectedIssueDescription, label);
      }
    }
  };
  await assertProjection("live projection");
  await input.fixture.runtime.releaseConversation(input.conversationId);
  await assertProjection("reopened projection");
}

async function assertKnowledgeAskUsesAgentAndReadOnlyTools(): Promise<void> {
  const verified: PiKnowledgeReference[][] = [];
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "当前没有找到可引用的 Vault 依据；仍由 Agent 回答。",
        retrieval: Object.freeze({
          elapsedMs: 7,
          total: 0,
          returned: 0,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      verified.push([...input.references]);
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    }
  };
  await withFixture(
    ["run-knowledge-ask-normal", "run-knowledge-ask-no-memory"],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: [
          "knowledge_search",
          "knowledge_read",
          "vault_search",
          "note_read",
          "note_create",
          "knowledge_maintain",
          "memory_search",
          "memory_read",
          "memory_write"
        ],
        defaults: [
          "vault_search",
          "note_read",
          "note_create",
          "memory_search",
          "memory_read",
          "memory_write"
        ],
        planAllowed: ["vault_search", "note_read"]
      });
      fixture.setMemoryToolNames([
        "memory_search",
        "memory_read",
        "memory_write"
      ]);
      const conversationId = "knowledge-ask-agent";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Knowledge ask agent",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();

      const normal = await fixture.runtime.submit({
        conversationId,
        text: "/ask 空库也请解释这个概念",
        memoryMode: "normal",
        submittedAt: 3
      });
      assert.equal(session.promptTexts.at(-1), "/ask 空库也请解释这个概念");
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set([
          "knowledge_search",
          "knowledge_read",
          "note_read",
          "memory_search",
          "memory_read"
        ])
      );
      for (const forbidden of [
        "memory_write",
        "note_create",
        "knowledge_maintain",
        "vault_search"
      ]) {
        assert.equal(session.activeToolSelections.at(-1)?.includes(forbidden), false);
      }
      session.finishSuccessful("当前没有 Vault 依据；这是模型分析。");
      assert.equal((await normal.result).terminalState, "completed");

      const noMemory = await fixture.runtime.submit({
        conversationId,
        text: "/ask 不使用 Memory 回答",
        memoryMode: "no_memory",
        submittedAt: 4
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set(["knowledge_search", "knowledge_read", "note_read"])
      );
      assert.equal(
        session.activeToolSelections.at(-1)?.some((name) =>
          name.startsWith("memory_")
        ),
        false
      );
      session.finishSuccessful("no_memory 模式回答。");
      assert.equal((await noMemory.result).terminalState, "completed");
      assert.deepEqual(verified, [[], []]);
    },
    { knowledge }
  );
}

async function assertAskSourceAttributionCapturesOnlyInjectedPrimaryMemory(): Promise<void> {
  const reference: PiKnowledgeReference = Object.freeze({
    referenceId: "vault-reference-a",
    vaultRelativePath: "wiki/attribution.md",
    title: "Vault attribution",
    excerpt: "实际注入的 Vault 参考",
    contentRevision: `sha256:${"a".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1
  });
  const usage: Array<Parameters<NonNullable<
    PiKnowledgeRuntimePort["recordUsage"]
  >>[0]> = [];
  let askCount = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      const references = askCount++ === 0 ? [reference] : [];
      return Object.freeze({
        status: references.length ? "ready" as const : "no_evidence" as const,
        references: Object.freeze(references),
        providerResourceText: "attribution fixture",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 1,
          returned: 1,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    },
    async recordUsage(input) {
      usage.push(structuredClone(input));
    }
  };
  await withFixture(
    ["run-ask-source-attribution", "run-ask-source-attribution-empty"],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["knowledge_search", "knowledge_read", "note_read"],
        defaults: ["knowledge_search", "knowledge_read", "note_read"],
        planAllowed: []
      });
      const conversationId = "ask-source-attribution";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Ask source attribution",
        cwd: fixture.root,
        createdAt: 1
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();
      const first = await fixture.runtime.submit({
        conversationId,
        text: "/ask 请用已注入来源回答",
        submittedAt: 2
      });
      const sources = [
        { id: "memory-primary-a", title: "一级 Memory A" },
        { id: "memory-primary-a", title: "重复 Memory 不应再次展示" },
        { id: "memory-primary-b", title: "一级 Memory B" }
      ];
      await fixture.reportAskPersonalMemorySources({
        productRunId: first.productRunId,
        sources
      });
      sources[0]!.title = "外部突变不能进入 usage";
      session.finishSuccessful("已完成来源归属回答。");
      await first.result;

      assert.equal(usage.length, 1);
      assert.deepEqual(usage[0]?.event, {
        sourceEventId: usage[0]?.event.sourceEventId,
        vaultId: usage[0]?.event.vaultId,
        conversationId,
        piSessionId: usage[0]?.event.piSessionId,
        piEntryId: usage[0]?.event.piEntryId,
        productRunId: first.productRunId,
        referenceIds: [reference.referenceId],
        workflow: "ask",
        producedPaths: [],
        personalMemorySources: [
          { id: "memory-primary-a", title: "一级 Memory A" },
          { id: "memory-primary-b", title: "一级 Memory B" }
        ]
      });

      const empty = await fixture.runtime.submit({
        conversationId,
        text: "/ask 本轮没有可展示来源",
        submittedAt: 3
      });
      session.finishSuccessful("没有来源的回答。");
      await empty.result;
      assert.deepEqual(usage[1]?.event.personalMemorySources, []);
      assert.deepEqual(usage[1]?.event.referenceIds, []);
    },
    { knowledge }
  );
}

async function assertKnowledgeObservationAndProgressArePrivacySafe(): Promise<void> {
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "PRIVATE_RESOURCE_CANARY",
        retrieval: Object.freeze({
          elapsedMs: 11,
          total: 120,
          returned: 8,
          remaining: 112,
          hasMore: true,
          exhausted: false
        })
      });
    },
    async verifyAskReferences(input) {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    }
  };
  await withFixture(["run-knowledge-observation"], async (fixture) => {
    fixture.configureFactoryTools({
      registered: [
        "knowledge_search",
        "knowledge_read",
        "note_read",
        "memory_search",
        "memory_read"
      ],
      defaults: ["memory_search", "memory_read"],
      planAllowed: []
    });
    fixture.setMemoryToolNames(["memory_search", "memory_read"]);
    const conversationId = "knowledge-observation-private";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Knowledge observation",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    const handle = await fixture.runtime.submit({
      conversationId,
      text: "/ask PRIVATE_QUERY_CANARY",
      submittedAt: 3
    });
    const events: PiChatRuntimeEvent[] = [];
    fixture.runtime.subscribeProductRun(handle.productRunId, (event) => {
      events.push(structuredClone(event));
    });
    await fixture.reportMemoryRecall({
      status: "active",
      stage: "loading",
      elapsedMs: 0
    });
    await fixture.reportMemoryRecall({
      status: "completed",
      stage: "assembling",
      elapsedMs: 7,
      recall: {
        result: "completed",
        stage: "assembling",
        elapsedMs: 7,
        scanned: 12,
        candidates: 4,
        injected: 2,
        remaining: 2,
        exhausted: false
      }
    });

    session.emitToolStart(
      "knowledge-search-continuation",
      "knowledge_search",
      { query: "PRIVATE_QUERY_CANARY", cursor: "PRIVATE_CURSOR_CANARY" }
    );
    session.emitToolEnd(
      "knowledge-search-continuation",
      "knowledge_search",
      {
        content: [{ type: "text", text: "PRIVATE_SEARCH_RESULT_CANARY" }],
        details: {
          source: "echoink-knowledge",
          status: "completed",
          elapsedMs: 5,
          total: 120,
          returned: 10,
          remaining: 102,
          hasMore: true,
          exhausted: false,
          continuation: true
        }
      },
      false
    );
    session.emitToolStart(
      "knowledge-read-one",
      "knowledge_read",
      {
        vaultRelativePath: "wiki/PRIVATE_PATH_CANARY.md",
        expectedContentRevision: `sha256:${"b".repeat(64)}`
      }
    );
    session.emitToolEnd(
      "knowledge-read-one",
      "knowledge_read",
      {
        content: [{ type: "text", text: "PRIVATE_NOTE_CANARY" }],
        details: { source: "echoink-knowledge", status: "completed" }
      },
      false
    );
    session.emitToolStart(
      "memory-search-one",
      "memory_search",
      { query: "PRIVATE_MEMORY_QUERY_CANARY" }
    );
    session.emitToolEnd(
      "memory-search-one",
      "memory_search",
      {
        content: [{ type: "text", text: "PRIVATE_MEMORY_RESULT_CANARY" }],
        details: { source: "echoink-personal-memory", status: "completed" }
      },
      false
    );
    session.beginProviderRequest();
    session.emitAssistantText("首个非空回答");
    session.finishSuccessful("当前没有 Vault 依据；这是模型分析。");
    const settled = await handle.result;
    assert.equal(settled.terminalState, "completed");
    assert.ok(settled.knowledge?.modelFirstTextLatencyMs);
    assert.deepEqual({
      ...settled.knowledge,
      modelFirstTextLatencyMs: undefined
    }, {
      workflow: "ask",
      localRetrievalElapsedMs: 16,
      candidates: 120,
      returned: 18,
      remaining: 102,
      hasMore: true,
      exhausted: false,
      continuationCount: 1,
      knowledgeReadCount: 1,
      memoryRecallUsed: true,
      memorySearchUsed: true,
      memoryReadUsed: false,
      conflictOrFreshnessTriggered: false,
      modelFirstTextLatencyMs: undefined
    });
    const serializedEvents = JSON.stringify(events);
    assert.doesNotMatch(
      serializedEvents,
      /PRIVATE_(?:QUERY|CURSOR|SEARCH_RESULT|PATH|NOTE|MEMORY_QUERY|MEMORY_RESULT)_CANARY/u
    );
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "continuing_search"
      && event.status === "active"
    ));
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "reading_knowledge"
      && event.status === "active"
    ));
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "comparing_memory"
      && event.status === "active"
    ));
    const terminalReasoning = events.filter(
      (event): event is Extract<PiChatRuntimeEvent, { type: "reasoning_summary" }> =>
        event.type === "reasoning_summary"
    ).at(-1)?.summary;
    assert.ok(terminalReasoning);
    assert.deepEqual(
      new Set(terminalReasoning!.activities.map((activity) => activity.kind)),
      new Set(["knowledge", "memory", "tool", "provider"])
    );
    assert.equal(
      terminalReasoning!.activities.find((activity) =>
        activity.kind === "memory" && activity.stage === "assembling"
      )?.total,
      4
    );
    assert.doesNotMatch(JSON.stringify(settled.knowledge), /sha256|PRIVATE_/u);
  }, { knowledge });
}

async function assertMemoryTurnIsAvailableBeforeUserEntryPersistence(): Promise<void> {
  await withFixture(["run-memory-preappend-normal", "run-memory-preappend-no-memory"], async (fixture) => {
    const conversationId = "memory-preappend-timing";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Memory preappend timing",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    for (const memoryMode of ["normal", "no_memory"] as const) {
      const text = `preappend-${memoryMode}`;
      const handle = await fixture.runtime.submit({
        conversationId,
        text,
        memoryMode,
        submittedAt: 3
      });
      const turn = fixture.latestSession().memoryTurnsBeforeUserEntryAppend.at(-1);
      assert.ok(turn, `${memoryMode} submit 必须在 user Entry 落盘前提供 Recall 身份`);
      assert.equal(turn.query, text);
      assert.equal(turn.memoryMode, memoryMode);
      assert.equal(turn.productRunId, handle.productRunId);
      assert.equal(turn.userEntryId, undefined);
      const recall = {
        result: memoryMode === "normal" ? "completed" as const : "skipped_no_memory" as const,
        stage: "assembling" as const,
        elapsedMs: 12,
        scanned: memoryMode === "normal" ? 10 : 0,
        candidates: memoryMode === "normal" ? 3 : 0,
        injected: memoryMode === "normal" ? 2 : 0,
        remaining: memoryMode === "normal" ? 8 : 0,
        exhausted: memoryMode === "no_memory"
      };
      await fixture.reportMemoryRecall({
        status: "completed",
        stage: "assembling",
        elapsedMs: 12,
        recall
      });
      assert.deepEqual((await fixture.productRuns.read(handle.productRunId))?.memoryRecall, recall);
      fixture.latestSession().finishSuccessful("timing checked");
      await handle.result;
    }
  });
}

async function assertConversationDerivationCreatesIndependentDurablePrefixes():
Promise<void> {
  await withFixture(["run-prefix-first", "run-prefix-future"], async (fixture) => {
    const sourceConversationId = "derive-source-conversation";
    const sourceCatalog = await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "源会话",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(sourceConversationId);

    const first = await fixture.runtime.submit({
      conversationId: sourceConversationId,
      text: "第一条提问",
      submittedAt: 3
    });
    fixture.latestSession().finishSuccessful("第一条回复");
    const firstSettled = await first.result;
    assert.ok(firstSettled.assistantEntryId);

    const future = await fixture.runtime.submit({
      conversationId: sourceConversationId,
      text: "需要重新编辑的第二条提问",
      submittedAt: 4
    });
    fixture.latestSession().finishSuccessful("锚点之后不得继承的未来回复");
    await future.result;

    const sourceBefore = await fixture.runtime.readProjection(sourceConversationId);
    const sourceMessageIdsBefore = sourceBefore.messages.map((message) => message.id);
    const sourceSessionFileBefore = sourceCatalog.sessionFile;

    const fromUser = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-from-user",
      anchorEntryId: future.userEntryId,
      title: "重新编辑第二条提问",
      createdAt: 5
    });
    assert.equal(fromUser.anchorRole, "user");
    assert.equal(fromUser.editorText, "需要重新编辑的第二条提问");
    assert.notEqual(fromUser.projection.catalog.piSessionId, sourceCatalog.piSessionId);
    assert.notEqual(fromUser.projection.catalog.sessionFile, sourceSessionFileBefore);
    assert.deepEqual(
      visibleConversationText(fromUser.projection),
      ["user:第一条提问", "assistant:第一条回复"],
      "a user anchor inherits only the durable prefix before that user Entry"
    );

    const fromAssistant = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-from-assistant",
      anchorEntryId: firstSettled.assistantEntryId,
      title: "从第一条回复继续",
      createdAt: 6
    });
    assert.equal(fromAssistant.anchorRole, "assistant");
    assert.equal(fromAssistant.editorText, "");
    assert.deepEqual(
      visibleConversationText(fromAssistant.projection),
      ["user:第一条提问", "assistant:第一条回复"],
      "an assistant anchor includes that reply but excludes every later Entry"
    );

    const sourceAfter = await fixture.runtime.readProjection(sourceConversationId);
    assert.deepEqual(sourceAfter.messages.map((message) => message.id), sourceMessageIdsBefore);
    assert.equal(sourceAfter.activeLeafId, sourceBefore.activeLeafId);
    assert.equal(sourceAfter.catalog.sessionFile, sourceSessionFileBefore);
    assert.equal(sourceAfter.catalog.piSessionId, sourceCatalog.piSessionId);
    assert.equal((await fixture.runtime.listConversations(["active"])).length, 3);

    await fixture.runtime.shutdown();
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId
    });
    const reopenedRuns = new FileProductRunStore({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId,
      catalog: reopenedCatalog
    });
    const reopened = new PiNativeConversationRuntime({
      catalog: reopenedCatalog,
      productRuns: reopenedRuns,
      sessionApi: API,
      resolveConversationCwd: () => fixture.root,
      createAgentSession: async (input) => ({
        session: new ControlledAgentSession(input.sessionManager).asAgentSession(),
        planToolNames: []
      })
    });
    await reopened.initialize();
    try {
      assert.equal((await reopened.listConversations(["active"])).length, 3);
      assert.deepEqual(
        visibleConversationText(
          await reopened.activateConversation("derive-from-user")
        ),
        ["user:第一条提问", "assistant:第一条回复"],
        "the user-anchor Conversation must survive a full runtime restart"
      );
      assert.deepEqual(
        visibleConversationText(
          await reopened.activateConversation("derive-from-assistant")
        ),
        ["user:第一条提问", "assistant:第一条回复"],
        "a fresh runtime must restore the independently cataloged Pi Session prefix"
      );
    } finally {
      await reopened.shutdown();
    }
  });
}

async function assertDerivedActivationFailureRemainsAVisibleDurableConversation():
Promise<void> {
  await withFixture(["run-derived-activation-source"], async (fixture) => {
    const sourceConversationId = "derive-activation-failure-source";
    await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "激活失败来源",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(sourceConversationId);
    const sourceRun = await fixture.runtime.submit({
      conversationId: sourceConversationId,
      text: "需要保留的来源提问",
      submittedAt: 3
    });
    fixture.latestSession().finishSuccessful("需要保留的来源回复");
    const settled = await sourceRun.result;
    assert.ok(settled.assistantEntryId);

    fixture.failNextActivation(new Error("injected-derived-activation-failure"));
    const derived = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-activation-failure-target",
      anchorEntryId: settled.assistantEntryId,
      title: "已创建但暂未激活",
      createdAt: 4
    });

    assert.deepEqual((derived as any).activation, {
      status: "failed",
      message: "injected-derived-activation-failure"
    });
    assert.equal(
      derived.projection.catalog.conversationId,
      "derive-activation-failure-target"
    );
    assert.deepEqual(
      visibleConversationText(derived.projection),
      ["user:需要保留的来源提问", "assistant:需要保留的来源回复"]
    );
    assert.equal((await fixture.runtime.listConversations(["active"])).length, 2);
    assert.ok(
      await readFile(derived.projection.catalog.sessionFile!, "utf8"),
      "the cataloged JSONL must exist after activation failure"
    );

    await fixture.runtime.shutdown();
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId
    });
    const reopenedRuns = new FileProductRunStore({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId,
      catalog: reopenedCatalog
    });
    const reopened = new PiNativeConversationRuntime({
      catalog: reopenedCatalog,
      productRuns: reopenedRuns,
      sessionApi: API,
      resolveConversationCwd: () => fixture.root,
      createAgentSession: async (input) => ({
        session: new ControlledAgentSession(
          input.sessionManager,
          [],
          [],
          input.currentTaskPlanTurnContext
        ).asAgentSession(),
        planToolNames: []
      })
    });
    await reopened.initialize();
    try {
      assert.equal((await reopened.listConversations(["active"])).length, 2);
      assert.deepEqual(
        visibleConversationText(
          await reopened.activateConversation(
            "derive-activation-failure-target"
          )
        ),
        ["user:需要保留的来源提问", "assistant:需要保留的来源回复"]
      );
    } finally {
      await reopened.shutdown();
    }
  });
}

async function assertDerivationExcludesIdentityBoundOperationalState():
Promise<void> {
  await withFixture(["run-derived-clean-context"], async (fixture) => {
    const sourceConversationId = "derive-operational-state-source";
    const sourceCatalog = await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "带运行状态的来源",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(sourceConversationId);
    const sourceAgent = fixture.latestSession();
    sourceAgent.sessionManager.appendMessage({
      role: "user",
      content: "继承的第一条提问",
      timestamp: 10
    });
    sourceAgent.sessionManager.appendMessage(assistantMessage(
      "继承的第一条回复",
      11
    ));
    appendTaskPlanEntry(
      sourceAgent.sessionManager,
      sourceCatalog,
      freezeEchoInkTaskPlan({
        schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
        planId: "source-only-plan",
        title: "不得注入派生会话的来源计划",
        status: "in_progress",
        version: 1,
        steps: [{
          stepId: "source-step",
          text: "来源会话中的未完成步骤",
          status: "in_progress"
        }],
        currentStepId: "source-step",
        source: "agent",
        productRunId: "source-product-run",
        createdAt: 12,
        updatedAt: 12
      })
    );
    const contextEntries = sourceAgent.sessionManager.buildContextEntries();
    sourceAgent.sessionManager.appendCustomEntry(
      PI_CONTEXT_LEDGER_CUSTOM_TYPE,
      buildPiContextLedger({
        conversationId: sourceConversationId,
        piSessionId: sourceCatalog.piSessionId,
        productRunId: "source-ledger-run",
        requestSequence: 1,
        requestLeafId: sourceAgent.sessionManager.getLeafId(),
        recordedAt: 13,
        model: { provider: "fixture-provider", id: "fixture-model" },
        budget: calculatePiEffectiveInputBudget({
          contextWindow: 32_768,
          maxOutputReserve: 4_096
        }),
        context: {
          systemPrompt: "source ledger",
          messages: [],
          tools: []
        },
        contextEntries,
        vaultToolNames: new Set(),
        mcpToolNames: new Set()
      })
    );
    sourceAgent.sessionManager.appendMessage({
      role: "user",
      content: "运行状态之后仍应继承的提问",
      timestamp: 14
    });
    const anchorEntryId = sourceAgent.sessionManager.appendMessage(
      assistantMessage("运行状态之后仍应继承的回复", 15)
    );

    const derived = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-operational-state-target",
      anchorEntryId,
      title: "干净的派生上下文",
      createdAt: 16
    });
    assert.deepEqual((derived as any).activation, { status: "activated" });
    assert.equal(
      derived.projection.messages.some((message) =>
        message.itemType === "taskPlan" || Boolean(message.taskPlan)
      ),
      false,
      "the derived UI must not expose source Task Plan state"
    );
    assert.equal(
      derived.projection.contextLedger,
      undefined,
      "the derived projection must not return the source Context Ledger"
    );
    const derivedAgent = fixture.latestSession();
    assert.equal(
      derivedAgent.sessionManager.getBranch().some((entry) =>
        entry.type === "custom"
        && (
          entry.customType === "echoink.task-plan.v1"
          || entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
        )
      ),
      false,
      "identity-bound operational entries must be absent from the durable prefix"
    );
    assert.equal(
      sourceAgent.sessionManager.getBranch().filter((entry) =>
        entry.type === "custom"
        && (
          entry.customType === "echoink.task-plan.v1"
          || entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
        )
      ).length,
      2,
      "the source Conversation must retain its Task Plan and Context Ledger"
    );

    await fixture.runtime.releaseConversation(
      derived.projection.catalog.conversationId
    );
    const reopenedProjection = await fixture.runtime.activateConversation(
      derived.projection.catalog.conversationId
    );
    assert.deepEqual(
      visibleConversationText(reopenedProjection),
      [
        "user:继承的第一条提问",
        "assistant:继承的第一条回复",
        "user:运行状态之后仍应继承的提问",
        "assistant:运行状态之后仍应继承的回复"
      ],
      "filtering operational Entries must preserve the remaining history after reopen"
    );
    assert.equal(reopenedProjection.contextLedger, undefined);
    const reopenedDerivedAgent = fixture.latestSession();

    const continued = await fixture.runtime.submit({
      conversationId: derived.projection.catalog.conversationId,
      text: "验证派生会话的 Provider Context",
      submittedAt: 17
    });
    assert.deepEqual(reopenedDerivedAgent.taskPlanTurns.at(-1), {
      mode: "agent",
      plan: null
    });
    reopenedDerivedAgent.finishSuccessful("派生会话继续成功");
    await continued.result;
  });
}

function visibleConversationText(
  projection: Awaited<ReturnType<PiNativeConversationRuntime["readProjection"]>>
): string[] {
  return projection.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}:${message.text}`);
}

export async function runPiNativeMemoryProjectIdentityTests(): Promise<void> {
  await assertNormalMemoryTurnResolvesExplicitProjectIdentity();
}

export async function runPiNativeTaskPlanRuntimeTests(): Promise<void> {
  await withFixture(
    [
      "run-task-plan-missing-update",
      "run-task-plan-mode",
      "run-task-plan-execution",
      "run-task-plan-auto-pause"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: [
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ],
        defaults: [
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ],
        planAllowed: ["vault_search", "note_read", "task_update"]
      });
      const conversationId = "task-plan-runtime";
      const catalog = await fixture.runtime.createConversation({
        conversationId,
        title: "Task plan runtime",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();
      const pending = freezeEchoInkTaskPlan({
        schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
        planId: "plan-runtime",
        title: "验证同一 Pi Session 的计划",
        status: "pending",
        version: 1,
        steps: [
          { stepId: "step-read", text: "只读规划", status: "pending" },
          { stepId: "step-write", text: "获准后执行", status: "pending" }
        ],
        source: "agent",
        createdAt: 3,
        updatedAt: 3
      });
      appendTaskPlanEntry(session.sessionManager, catalog, pending);

      const missingUpdate = await fixture.runtime.submit({
        conversationId,
        text: "故意遗漏结构化计划更新",
        mode: "plan",
        submittedAt: 4
      });
      session.finishSuccessful("只有文本计划");
      await assert.rejects(
        missingUpdate.result,
        (error: unknown) => error instanceof PiNativeConversationRuntimeError
          && error.code === "projection_unsettled"
          && /task_update/u.test(error.message)
      );
      assert.equal(
        fixture.runtime.releaseProductRun(missingUpdate.productRunId),
        true
      );

      const planned = await fixture.runtime.submit({
        conversationId,
        text: "修改当前计划",
        mode: "plan",
        submittedAt: 5
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set(["vault_search", "note_read", "task_update"])
      );
      assert.equal(
        session.activeToolSelections.at(-1)?.includes("note_create"),
        false,
        "Plan mode must not activate a registered write Tool"
      );
      appendTaskPlanEntry(
        session.sessionManager,
        catalog,
        freezeEchoInkTaskPlan({
          ...pending,
          version: 2,
          productRunId: planned.productRunId,
          updatedAt: 5
        })
      );
      session.finishSuccessful("计划已修改");
      await planned.result;
      fixture.runtime.releaseProductRun(planned.productRunId);

      const executed = await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "execute"
      });
      assert.equal(executed.plan.status, "in_progress");
      assert.equal(executed.plan.currentStepId, "step-read");
      assert.equal(session.sessionManager.getSessionId(), catalog.piSessionId);

      const run = await fixture.runtime.submit({
        conversationId,
        text: "执行当前计划",
        mode: "agent",
        submittedAt: 6
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set([
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ])
      );
      await fixture.runtime.steer(conversationId, "先完成只读核对");
      await fixture.runtime.followUp(conversationId, "计划结束后总结结果");
      assert.deepEqual(session.steering, ["先完成只读核对"]);
      assert.deepEqual(session.followUps, ["计划结束后总结结果"]);
      await fixture.runtime.abort(conversationId);
      assert.equal((await run.result).terminalState, "cancelled");
      const paused = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.steps[0]?.status, "paused");
      assert.equal(paused?.steps[1]?.status, "pending");
      assert.equal(fixture.runtime.releaseProductRun(run.productRunId), true);

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const autoPauseRun = await fixture.runtime.submit({
        conversationId,
        text: "本轮结束时没有写终态",
        mode: "agent",
        submittedAt: 7
      });
      session.finishSuccessful("本轮回答结束");
      assert.equal((await autoPauseRun.result).terminalState, "completed");
      assert.equal(
        latestTaskPlanFromBranch(
          session.sessionManager.getBranch(),
          pending.planId
        )?.status,
        "paused"
      );
      assert.equal(
        fixture.runtime.releaseProductRun(autoPauseRun.productRunId),
        true
      );

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const abortedRun = await fixture.runtime.submit({
        conversationId,
        text: "Provider 自行中断时收口计划",
        mode: "agent",
        submittedAt: 8
      });
      session.finishAborted();
      assert.equal((await abortedRun.result).terminalState, "cancelled");
      const interrupted = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(interrupted?.status, "paused");
      assert.equal(interrupted?.steps[0]?.status, "paused");
      assert.match(interrupted?.lastUpdateSummary ?? "", /已中断/u);
      assert.equal(
        fixture.runtime.releaseProductRun(abortedRun.productRunId),
        true
      );

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const failedRun = await fixture.runtime.submit({
        conversationId,
        text: "本轮 Provider 失败时收口计划",
        mode: "agent",
        submittedAt: 9
      });
      session.finishFailed("fixture provider failure");
      assert.equal((await failedRun.result).terminalState, "failed");
      const failed = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.currentStepId, undefined);
      assert.equal(failed?.steps[0]?.status, "interrupted");
      assert.equal(failed?.steps[1]?.status, "pending");
      assert.equal(
        failed?.steps.some((step) => step.status === "failed"),
        false,
        "whole-run failure must not fabricate a failed step"
      );
      assert.equal(
        fixture.runtime.releaseProductRun(failedRun.productRunId),
        true
      );

      await fixture.runtime.releaseConversation(conversationId);
      const reopened = await fixture.runtime.activateConversation(conversationId);
      const reopenedPlan = reopened.messages.find((message) =>
        message.taskPlan?.planId === pending.planId
      )?.taskPlan;
      assert.equal(reopenedPlan?.status, "failed");
      assert.equal(reopenedPlan?.steps[0]?.status, "interrupted");
    }
  );
}

async function assertAgentSessionWarningsUseConversationSupport(): Promise<void> {
  await withFixture([], async (fixture) => {
    const conversationId = "agent-session-resource-warning";
    const catalog = await fixture.runtime.createConversation({
      conversationId,
      title: "Agent session resource warning",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.catalog.appendDiagnostic({
      diagnosticId: "existing-runtime-diagnostic",
      conversationId,
      piSessionId: catalog.piSessionId,
      code: "runtime_interrupted",
      message: "existing diagnostic",
      createdAt: 3
    });
    fixture.setFactoryWarnings([
      "Fixture MCP Server 已断线。",
      "Fixture MCP\nServer 已断线。"
    ]);
    await fixture.runtime.activateConversation(conversationId);

    const support = await fixture.runtime.readConversationSupportState(conversationId);
    const resourceWarnings = support.diagnostics.filter((diagnostic) =>
      diagnostic.code === "runtime_resource_warning"
    );
    assert.equal(resourceWarnings.length, 1);
    assert.equal(resourceWarnings[0]?.message, "Fixture MCP Server 已断线。");
    assert.ok(support.diagnostics.some((diagnostic) =>
      diagnostic.diagnosticId === "existing-runtime-diagnostic"
    ));
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(
      projection.messages.some((message) =>
        message.text === "Fixture MCP Server 已断线。"
      ),
      false,
      "resource warnings stay in the existing support panel instead of duplicating timeline messages"
    );

    await fixture.runtime.releaseConversation(conversationId);
    fixture.setFactoryWarnings([]);
    await fixture.runtime.activateConversation(conversationId);
    const recovered = await fixture.runtime.readConversationSupportState(conversationId);
    assert.equal(
      recovered.diagnostics.some((diagnostic) =>
        diagnostic.code === "runtime_resource_warning"
      ),
      false,
      "resolved runtime warnings must not remain stale after AgentSession rebuild"
    );
    assert.ok(recovered.diagnostics.some((diagnostic) =>
      diagnostic.diagnosticId === "existing-runtime-diagnostic"
    ));
  });
}

export async function runPiNativeDurableSettlementProjectionRegressionTest():
Promise<void> {
  await withFixture(["run-durable-settlement-projection"], async (fixture) => {
    const conversationId = "durable-settlement-projection";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Durable settlement projection",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    session.enableRuntimeMessageTimestampDrift();

    const handle = await fixture.runtime.submit({
      conversationId,
      text: "durable user message",
      submittedAt: 3
    });
    session.finishSuccessful("durable assistant message");

    const settled = await handle.result;
    assert.equal(settled.state, "product_run_settled");
    assert.equal(settled.terminalState, "completed");
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.ok(projection.messages.some((message) =>
      message.role === "user" && message.text === "durable user message"
    ));
    assert.ok(projection.messages.some((message) =>
      message.role === "assistant" && message.text === "durable assistant message"
    ));
    assert.equal(
      projection.messages.some((message) => message.id.includes("provisional")),
      false,
      "agent_settled must rebuild from durable Pi Entries even when live timestamps drift"
    );
    assert.equal(
      (await fixture.catalog.diagnostics(conversationId)).some(
        (diagnostic) => diagnostic.message.includes("provisional entries")
      ),
      false
    );
  });
}

async function assertNormalMemoryTurnResolvesExplicitProjectIdentity():
Promise<void> {
  const cases = [{
    id: "punctuated-line-directive",
    query: "PROFILE-P01-ON-20C8-R2.\nProject: EchoInk.\nEvidence: provider preflight passed.",
    expectedProjectId: "EchoInk"
  }, {
    id: "line-directive",
    query: "Check the project binding.\nProject：EchoInk\nContinue with the request.",
    expectedProjectId: "EchoInk"
  }, {
    id: "repeated-same-directive",
    query: "Project: EchoInk.\nProject: EchoInk.",
    expectedProjectId: "EchoInk"
  }, {
    id: "conflicting-directives",
    query: "Project: EchoInk.\nProject: Garden.",
    expectedProjectId: undefined
  }, {
    id: "wrong-project",
    query: "Project: Garden.\nShould EchoInk memory be excluded?",
    expectedProjectId: "Garden"
  }, {
    id: "invalid-suffix",
    query: "Project: EchoInk/Other.",
    expectedProjectId: undefined
  }, {
    id: "invalid-character",
    query: "Project: Echo@Ink.",
    expectedProjectId: undefined
  }, {
    id: "overlong-project",
    query: `Project: ${"A".repeat(81)}.`,
    expectedProjectId: undefined
  }, {
    id: "not-project-prefix",
    query: "notProject: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "quoted-literal",
    query: "Quote this literal: Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "fenced-code",
    query: "```text\nProject: EchoInk.\n```",
    expectedProjectId: undefined
  }, {
    id: "indented-code",
    query: "    Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "numbered-example",
    query: "1. Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "blockquote-example",
    query: "> Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "ordinary-chinese-prose",
    query: "项目 EchoInk 的普通正文，不是身份指令。",
    expectedProjectId: undefined
  }, {
    id: "missing-directive",
    query: "Draft a Project plan for EchoInk without an explicit identity label.",
    expectedProjectId: undefined
  }, {
    id: "directive-before-memory-boundary",
    query: `${"x".repeat(3_950)}.\nProject: EchoInk.\nBOUNDARY_SENTINEL`,
    expectedProjectId: "EchoInk"
  }, {
    id: "directive-after-memory-boundary",
    query: `${"x".repeat(4_010)}.\nProject: EchoInk.\nBOUNDARY_SENTINEL`,
    expectedProjectId: "EchoInk"
  }] as const;
  await withFixture(
    cases.map((testCase) => `run-memory-project-${testCase.id}`),
    async (fixture) => {
      const conversationId = "memory-project-identity";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Memory project identity",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);

      for (const testCase of cases) {
        const handle = await fixture.runtime.submit({
          conversationId,
          text: testCase.query,
          submittedAt: 3
        });
        const turn = fixture.currentMemoryTurn();
        assert.ok(turn, "ordinary Pi Chat must bind a current Memory Turn");
        assert.equal(turn.query, testCase.query);
        const actualProjectId = "projectId" in turn
          ? turn.projectId
          : undefined;
        assert.equal(
          actualProjectId,
          testCase.expectedProjectId,
          testCase.id
        );
        fixture.latestSession().finishSuccessful(
          "memory project identity checked"
        );
        await handle.result;
      }
    }
  );
}

async function assertDurableDraftRequiresExplicitSuccessfulResubmission():
Promise<void> {
  await withFixture(["run-draft-resubmit"], async (fixture) => {
    const conversationId = "draft-resubmit-conversation";
    const catalog = await fixture.runtime.createConversation({
      conversationId,
      title: "Draft resubmission",
      cwd: fixture.root,
      createdAt: 2
    });
    const draft = await fixture.catalog.upsertDraft({
      draftId: "draft-restart-1",
      conversationId,
      piSessionId: catalog.piSessionId,
      source: "restart",
      text: "unconsumed follow-up",
      createdAt: 3
    });
    const supportBefore = await fixture.runtime.readConversationSupportState(
      conversationId
    );
    assert.deepEqual(supportBefore.drafts, [draft]);
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await reopenedCatalog.initialize();
    assert.deepEqual(
      await reopenedCatalog.drafts(conversationId),
      [draft],
      "a fresh Catalog instance must recover the draft without executing it"
    );

    await fixture.runtime.activateConversation(conversationId);
    fixture.latestSession().failNextPrompt(new Error("prompt start rejected"));
    await assert.rejects(
      fixture.runtime.submit({
        conversationId,
        text: "edited but not durably submitted",
        draftId: draft.draftId,
        submittedAt: 4
      }),
      /prompt start rejected/u
    );
    assert.deepEqual(
      (await fixture.runtime.readConversationSupportState(conversationId)).drafts,
      [draft],
      "a prompt that never durably appends its user Entry must retain the draft"
    );

    const handle = await fixture.runtime.submit({
      conversationId,
      text: "edited and explicitly resubmitted",
      draftId: draft.draftId,
      submittedAt: 5
    });
    assert.deepEqual(
      (await fixture.runtime.readConversationSupportState(conversationId)).drafts,
      [],
      "the draft must be consumed only after the user Entry is durable"
    );
    assert.ok(fixture.latestSession().sessionManager.getEntries().some(
      (entry) =>
        entry.type === "message"
        && entry.message.role === "user"
        && entry.message.content === "edited and explicitly resubmitted"
    ));
    fixture.latestSession().finishSuccessful("draft accepted");
    assert.equal((await handle.result).terminalState, "completed");

    const disposable = await fixture.catalog.upsertDraft({
      draftId: "draft-discard-1",
      conversationId,
      piSessionId: catalog.piSessionId,
      source: "abort",
      text: "delete me",
      createdAt: 6
    });
    assert.equal(
      await fixture.runtime.discardDraft(conversationId, disposable.draftId),
      true
    );
    assert.equal(
      await fixture.runtime.discardDraft(conversationId, disposable.draftId),
      false
    );
    const reopenedAfterDiscard = new FileConversationCatalog({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await reopenedAfterDiscard.initialize();
    assert.deepEqual(
      await reopenedAfterDiscard.drafts(conversationId),
      [],
      "a discarded draft must not reappear after a fresh Catalog open"
    );
  });
}

async function assertVerifiedPrefixRecoveryIsExplicitAndFailClosed():
Promise<void> {
  await withFixture(["run-recovery"], async (fixture) => {
    const conversationId = "recovery-conversation";
    const userText = "durable user entry before JSONL corruption";
    const handle = await fixture.runtime.submit({
      conversationId,
      text: userText,
      submittedAt: 3
    });
    await assert.rejects(
      fixture.runtime.recoverConversationFromVerifiedPrefix({
        conversationId,
        recoveryPath: path.join(
          fixture.catalog.sessionRootPath,
          "must-not-recover-while-running.jsonl"
        )
      }),
      conversationBusyError
    );

    fixture.latestSession().finishSuccessful("durable assistant entry");
    assert.equal((await handle.result).terminalState, "completed");
    const expectedActiveLeafId = fixture.latestSession()
      .sessionManager.getLeafId();
    assert.ok(expectedActiveLeafId);
    assert.equal(fixture.runtime.releaseProductRun(handle.productRunId), true);
    await fixture.runtime.releaseConversation(conversationId);

    const beforeCorruption = await fixture.catalog.get(conversationId);
    assert.ok(beforeCorruption?.sessionFile);
    assert.equal(beforeCorruption.piSessionId, handle.piSessionId);
    const sourcePath = beforeCorruption.sessionFile;
    await appendFile(sourcePath, "not-json\n");
    const corruptSourceBytes = await readFile(sourcePath);

    await assert.rejects(
      fixture.runtime.readProjection(conversationId),
      sessionJsonlInvalidError
    );
    await assert.rejects(
      fixture.runtime.readProjection(conversationId),
      sessionJsonlInvalidError
    );
    const diagnosticsBeforeRecovery = await fixture.catalog.diagnostics(
      conversationId
    );
    assert.equal(
      diagnosticsBeforeRecovery.filter(
        (diagnostic) => diagnostic.code === "session_jsonl_malformed"
      ).length,
      1,
      "repeated opens must dedupe the same corruption diagnostic"
    );
    const recoveryDiagnostics = diagnosticsBeforeRecovery.filter(
      (diagnostic) => diagnostic.code === "session_recovered_prefix"
    );
    assert.equal(
      recoveryDiagnostics.length,
      2,
      "each generated recovery file must retain its own provenance"
    );
    const recoveryDiagnostic = recoveryDiagnostics.at(-1);
    assert.ok(recoveryDiagnostic?.recoveryPath);
    assert.equal(recoveryDiagnostic.sourcePath, sourcePath);
    const recoveryPath = recoveryDiagnostic.recoveryPath;

    const unprovenRecoveryPath = path.join(
      fixture.catalog.sessionRootPath,
      "unproven-recovery-copy.jsonl"
    );
    await copyFile(recoveryPath, unprovenRecoveryPath);
    await assert.rejects(
      fixture.runtime.recoverConversationFromVerifiedPrefix({
        conversationId,
        recoveryPath: unprovenRecoveryPath
      }),
      sessionRecoveryInvalidError
    );
    assert.equal(
      await fixture.catalog.sessionFile(conversationId),
      sourcePath,
      "an unproven copy must not change the Catalog pointer"
    );

    const recovered = await fixture.runtime.recoverConversationFromVerifiedPrefix({
      conversationId,
      recoveryPath
    });
    assert.equal(recovered.catalog.piSessionId, handle.piSessionId);
    assert.equal(recovered.catalog.sessionFile, recoveryPath);
    assert.equal(recovered.sourcePath, sourcePath);
    assert.equal(recovered.recoveryPath, recoveryPath);
    assert.ok(recovered.recoveredEntryCount >= 1);
    assert.equal(recovered.activeLeafId, expectedActiveLeafId);
    assert.deepEqual(
      await readFile(sourcePath),
      corruptSourceBytes,
      "verified-prefix recovery must preserve the corrupt source byte-for-byte"
    );
    assert.equal(await fixture.catalog.sessionFile(conversationId), recoveryPath);

    const pointerBeforeStaleCas = await fixture.catalog.sessionFile(
      conversationId
    );
    await assert.rejects(
      fixture.catalog.adoptVerifiedRecoverySessionFile({
        conversationId,
        piSessionId: handle.piSessionId,
        expectedSessionFile: sourcePath,
        recoverySessionFile: unprovenRecoveryPath
      }),
      mappingConflictError
    );
    assert.equal(
      await fixture.catalog.sessionFile(conversationId),
      pointerBeforeStaleCas,
      "a stale recovery CAS must leave the Catalog pointer unchanged"
    );

    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(projection.catalog.piSessionId, handle.piSessionId);
    assert.equal(projection.catalog.sessionFile, recoveryPath);
    assert.equal(projection.activeLeafId, expectedActiveLeafId);
    assert.ok(projection.messages.some(
      (message) => message.role === "user" && message.text === userText
    ));
    assert.deepEqual(
      (await fixture.catalog.diagnostics(conversationId)).map(
        (diagnostic) => diagnostic.diagnosticId
      ),
      diagnosticsBeforeRecovery.map((diagnostic) => diagnostic.diagnosticId),
      "recovery must retain the original corruption diagnostics"
    );
  });
}

async function assertExperienceSourceRefsArePointerOnlyAndDeleteAware():
Promise<void> {
  await withFixture(
    ["run-experience-normal", "run-experience-no-memory"],
    async (fixture) => {
      assert.equal(
        await fixture.runtime.readExperienceSourceRef("run-missing"),
        null
      );

      const normal = await fixture.runtime.submit({
        conversationId: "experience-normal",
        text: "normal source",
        submittedAt: 4,
        memoryMode: "normal"
      });
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        null,
        "an unsettled ProductRun must not expose an Experience source"
      );
      fixture.latestSession().finishSuccessful("normal answer");
      await normal.result;

      const first = await fixture.runtime.readExperienceSourceRef(
        normal.productRunId
      );
      const repeated = await fixture.runtime.readExperienceSourceRef(
        normal.productRunId
      );
      assert.ok(first);
      assert.deepEqual(repeated, first);
      assert.deepEqual(Object.keys(first).sort(), [
        "assistantEntryId",
        "conversationId",
        "memoryMode",
        "piSessionId",
        "productRunId",
        "sourceEventId",
        "terminalState",
        "userEntryId",
        "vaultId"
      ]);
      assert.equal(first.memoryMode, "normal");
      assert.equal(first.terminalState, "completed");
      assert.equal(first.productRunId, normal.productRunId);
      assert.equal(first.userEntryId, normal.userEntryId);
      assert.equal(first.piSessionId, normal.piSessionId);
      assert.match(first.sourceEventId, /^experience-source-[a-f0-9]{32}$/u);

      await fixture.runtime.setConversationStatus(
        normal.conversationId,
        "archived"
      );
      assert.deepEqual(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        first,
        "archiving must retain the source pointer"
      );
      await fixture.runtime.setConversationStatus(
        normal.conversationId,
        "deleted"
      );
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        null,
        "deleting the Conversation must invalidate the source pointer"
      );

      const noMemory = await fixture.runtime.submit({
        conversationId: "experience-no-memory",
        text: "ephemeral source",
        submittedAt: 5,
        memoryMode: "no_memory"
      });
      fixture.latestSession().finishSuccessful("ephemeral answer");
      await noMemory.result;
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(noMemory.productRunId),
        null,
        "no_memory ProductRuns must not publish Experience source pointers"
      );
    }
  );
}

async function assertSkillPromptAndBindingValidation(): Promise<void> {
  await withFixture(
    ["run-skill", "run-plain"],
    async (fixture) => {
      await assert.rejects(
        fixture.runtime.submit({
          conversationId: "invalid-submit",
          text: "must not create",
          submittedAt: 1,
          skillPath: path.join(fixture.root, "review", "SKILL.md")
        }),
        skillBindingError
      );
      assert.equal(await fixture.catalog.get("invalid-submit"), null);

      await fixture.runtime.createConversation({
        conversationId: "invalid-activate",
        title: "Invalid activate",
        cwd: fixture.root
      });
      await assert.rejects(
        fixture.runtime.activateConversation("invalid-activate", {
          skillName: "review"
        }),
        skillBindingError
      );

      const skillHandle = await fixture.runtime.submit({
        conversationId: "skill-conversation",
        text: "hello",
        submittedAt: 2,
        skillPath: path.join(fixture.root, "review", "SKILL.md"),
        skillName: "Phase 1 Acceptance"
      });
      const skillSession = fixture.latestSession();
      assert.deepEqual(skillSession.promptTexts, [
        "/skill:echoink-selected-skill hello"
      ]);
      assert.equal(fixture.runtime.releaseProductRun(skillHandle.productRunId), false);
      skillSession.finishSuccessful("skill answer");
      assert.equal((await skillHandle.result).state, "product_run_settled");
      assert.equal(fixture.runtime.releaseProductRun(skillHandle.productRunId), true);

      const plainHandle = await fixture.runtime.submit({
        conversationId: "plain-conversation",
        text: "plain text",
        submittedAt: 3
      });
      const plainSession = fixture.latestSession();
      assert.deepEqual(plainSession.promptTexts, ["plain text"]);
      plainSession.finishSuccessful("plain answer");
      assert.equal((await plainHandle.result).terminalState, "completed");
      assert.equal(fixture.runtime.releaseProductRun(plainHandle.productRunId), true);
    }
  );
}

async function assertProductRunCreateFailureCleansRuntime(): Promise<void> {
  await assertProductRunPersistenceFailure("create");
}

async function assertProductRunUpdateFailureCleansRuntime(): Promise<void> {
  await assertProductRunPersistenceFailure("update");
}

async function assertProductRunPersistenceFailure(
  stage: "create" | "update"
): Promise<void> {
  const failedRunId = `run-${stage}-failure`;
  await withFixture(
    [failedRunId, `run-${stage}-retry`],
    async (fixture) => {
      const storageError = new Error(`${stage} storage failure`);
      const store = fixture.productRuns;
      const originalCreate = store.create.bind(store);
      const originalUpdate = store.update.bind(store);
      if (stage === "create") {
        let fail = true;
        store.create = async (input) => {
          if (fail) {
            fail = false;
            throw storageError;
          }
          return await originalCreate(input);
        };
      } else {
        let fail = true;
        store.update = async (productRunId, update) => {
          if (fail) {
            fail = false;
            throw storageError;
          }
          return await originalUpdate(productRunId, update);
        };
      }

      await assert.rejects(
        fixture.runtime.submit({
          conversationId: `${stage}-failure-conversation`,
          text: "first attempt",
          submittedAt: 10
        }),
        (error: unknown) => error === storageError
      );
      const session = fixture.latestSession();
      assert.deepEqual(session.lifecycleCalls, [
        "clearQueue",
        "abort",
        "waitForIdle"
      ]);
      assert.throws(
        () => fixture.runtime.subscribeProductRun(failedRunId, () => undefined),
        unavailableRunError
      );

      const retry = await fixture.runtime.submit({
        conversationId: `${stage}-failure-conversation`,
        text: "second attempt",
        submittedAt: 11
      });
      session.finishSuccessful("retry answer");
      assert.equal((await retry.result).terminalState, "completed");
      assert.equal(fixture.runtime.releaseProductRun(retry.productRunId), true);
    }
  );
}

async function assertSubscriberFailuresAreIsolated(): Promise<void> {
  await withFixture(["run-subscriber"], async (fixture) => {
    const handle = await fixture.runtime.submit({
      conversationId: "subscriber-conversation",
      text: "subscriber isolation",
      submittedAt: 20
    });
    const orderedEvents: string[] = [];
    let failingSubscriberCalls = 0;
    fixture.runtime.subscribeProductRun(handle.productRunId, async (event) => {
      await Promise.resolve();
      orderedEvents.push(event.type);
    });
    fixture.runtime.subscribeProductRun(handle.productRunId, () => {
      failingSubscriberCalls += 1;
      throw new Error("fixture subscriber failure");
    });

    fixture.latestSession().finishSuccessful("subscriber answer");
    const result = await handle.result;
    assert.equal(result.terminalState, "completed");
    assert.deepEqual(orderedEvents, [
      "reasoning_summary",
      "agent_settled",
      "reasoning_summary",
      "product_run_settled"
    ]);
    assert.equal(failingSubscriberCalls, 4);
    assert.equal(fixture.runtime.releaseProductRun(handle.productRunId), true);
  });
}

async function assertSettlementFailureIsDiagnosedAndReleasesRun(): Promise<void> {
  await withFixture(
    ["run-unsettled", "run-after-unsettled"],
    async (fixture) => {
      const first = await fixture.runtime.submit({
        conversationId: "unsettled-conversation",
        text: "first unsettled run",
        submittedAt: 30
      });
      assert.equal(fixture.runtime.releaseProductRun(first.productRunId), false);
      fixture.latestSession().finishSuccessful("first answer");
      await assert.rejects(first.result, pendingProductWorkError);

      const diagnostics = await fixture.catalog.diagnostics(
        "unsettled-conversation"
      );
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, "runtime_interrupted");
      assert.equal(
        diagnostics[0]?.message,
        "pi_native_projection_unsettled",
        "persisted diagnostics must keep a safe code instead of exception text"
      );
      assert.equal(fixture.runtime.releaseProductRun(first.productRunId), true);

      const second = await fixture.runtime.submit({
        conversationId: "unsettled-conversation",
        text: "lock was released",
        submittedAt: 31
      });
      assert.equal(fixture.runtime.releaseProductRun(second.productRunId), false);
      fixture.latestSession().finishSuccessful("second answer");
      await assert.rejects(second.result, pendingProductWorkError);
      assert.equal(fixture.runtime.releaseProductRun(second.productRunId), true);
    },
    {
      hasPendingProductWork: async () => true
    }
  );
}

async function assertPromptStartFailureReleasesSettlementBarrier(): Promise<void> {
  await withFixture(["run-prompt-start-failure"], async (fixture) => {
    await fixture.runtime.createConversation({
      conversationId: "prompt-start-failure",
      title: "Prompt start failure",
      cwd: fixture.root
    });
    await fixture.runtime.activateConversation("prompt-start-failure");
    const session = fixture.latestSession();
    const promptStartError = new Error("fixture synchronous prompt failure");
    session.failNextPrompt(promptStartError);

    await assert.rejects(
      fixture.runtime.submit({
        conversationId: "prompt-start-failure",
        text: "must fail before the first Entry",
        submittedAt: 40
      }),
      (error: unknown) => error === promptStartError
    );
    assert.deepEqual(session.lifecycleCalls.slice(0, 3), [
      "clearQueue",
      "abort",
      "waitForIdle"
    ]);
    assert.throws(
      () => fixture.runtime.subscribeProductRun(
        "run-prompt-start-failure",
        () => undefined
      ),
      unavailableRunError
    );
    await withTimeout(
      fixture.runtime.releaseConversation("prompt-start-failure"),
      "prompt-start failure release"
    );
    assert.equal(session.disposed, true);
  });
}

async function assertConversationTeardownWaitsForSettlement(
  mode: "release" | "shutdown"
): Promise<void> {
  await withFixture([`run-${mode}-barrier`], async (fixture) => {
    const diagnosticStarted = deferred();
    const allowDiagnostic = deferred();
    const originalAppendDiagnostic = fixture.catalog.appendDiagnostic.bind(
      fixture.catalog
    );
    fixture.catalog.appendDiagnostic = async (diagnostic) => {
      diagnosticStarted.resolve();
      await allowDiagnostic.promise;
      return await originalAppendDiagnostic(diagnostic);
    };

    const conversationId = `${mode}-barrier-conversation`;
    const handle = await fixture.runtime.submit({
      conversationId,
      text: `${mode} must await settlement`,
      submittedAt: 50
    });
    const session = fixture.latestSession();
    session.omitAgentSettledOnAbort();
    const resultFailure = assert.rejects(
      handle.result,
      agentSettledMissingError
    );
    const teardown = mode === "release"
      ? fixture.runtime.releaseConversation(conversationId)
      : fixture.runtime.shutdown();
    let teardownFinished = false;
    void teardown.then(
      () => {
        teardownFinished = true;
      },
      () => {
        teardownFinished = true;
      }
    );

    await withTimeout(
      diagnosticStarted.promise,
      `${mode} diagnostic start`
    );
    await Promise.resolve();
    assert.equal(teardownFinished, false);
    assert.equal(session.disposed, false);

    allowDiagnostic.resolve();
    await resultFailure;
    await withTimeout(teardown, `${mode} durable settlement`);
    assert.equal(session.disposed, true);
    const flushIndex = session.lifecycleCalls.indexOf("flush");
    const disposeIndex = session.lifecycleCalls.indexOf("dispose");
    assert.ok(flushIndex > session.lifecycleCalls.lastIndexOf("waitForIdle"));
    assert.ok(disposeIndex > flushIndex);

    const diagnostics = await fixture.catalog.diagnostics(conversationId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "runtime_interrupted");
    assert.match(diagnostics[0]?.message ?? "", /agent_settled/u);
  });
}

function skillBindingError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "skill_binding_invalid";
}

function conversationBusyError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "conversation_busy";
}

function sessionRecoveryInvalidError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "session_recovery_invalid";
}

function sessionJsonlInvalidError(error: unknown): boolean {
  return error instanceof PiSessionDurabilityError
    && error.code === "pi_session_jsonl_invalid";
}

function mappingConflictError(error: unknown): boolean {
  return error instanceof PiNativeFileStoreError
    && error.code === "mapping-conflict";
}

function unavailableRunError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "conversation_not_found";
}

function pendingProductWorkError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "projection_unsettled"
    && /pending Approval, Receipt, or product work/u.test(error.message);
}

function agentSettledMissingError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "agent_settled_missing";
}

interface RuntimeFixture {
  root: string;
  catalog: FileConversationCatalog;
  productRuns: FileProductRunStore;
  runtime: PiNativeConversationRuntime;
  sessions: ControlledAgentSession[];
  failNextActivation(error: Error): void;
  setFactoryWarnings(warnings: readonly string[]): void;
  setMemoryToolNames(names: readonly string[]): void;
  configureFactoryTools(input: Readonly<{
    registered: readonly string[];
    defaults: readonly string[];
    planAllowed: readonly string[];
  }>): void;
  currentMemoryTurn(): Readonly<PiNativeMemoryTurnContext> | null;
  currentKnowledgeTurn(): Readonly<PiNativeKnowledgeTurnContext> | null;
  reportMemoryRecall(input: Parameters<NonNullable<
    PiNativeAgentSessionFactoryInput["reportMemoryRecallProgress"]
  >>[0]): Promise<void>;
  reportAskPersonalMemorySources(input: Parameters<NonNullable<
    PiNativeAgentSessionFactoryInput["reportAskPersonalMemorySources"]
  >>[0]): Promise<void>;
  latestSession(): ControlledAgentSession;
}

async function withFixture(
  runIds: readonly string[],
  assertion: (fixture: RuntimeFixture) => Promise<void>,
  runtimeOptions: Pick<
    PiNativeConversationRuntimeOptions,
    "hasPendingProductWork" | "knowledge"
  > = {}
): Promise<void> {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), "echoink-pi-native-runtime-")
  ));
  const sessions: ControlledAgentSession[] = [];
  let currentMemoryTurnReader:
    (() => Readonly<PiNativeMemoryTurnContext> | null) | null = null;
  let currentKnowledgeTurnReader:
    (() => Readonly<PiNativeKnowledgeTurnContext> | null) | null = null;
  let memoryRecallReporter: PiNativeAgentSessionFactoryInput["reportMemoryRecallProgress"] = undefined;
  let askPersonalMemorySourcesReporter:
    PiNativeAgentSessionFactoryInput["reportAskPersonalMemorySources"] = undefined;
  let nextActivationError: Error | null = null;
  let factoryWarnings: readonly string[] = [];
  let memoryToolNames: readonly string[] = [];
  let factoryTools = {
    registered: [] as readonly string[],
    defaults: [] as readonly string[],
    planAllowed: [] as readonly string[]
  };
  let now = 100_000;
  let runIdIndex = 0;
  const catalog = new FileConversationCatalog({
    storageRootPath: path.join(root, "pi-native"),
    vaultId: `vault-${path.basename(root)}`,
    now: () => ++now
  });
  const productRuns = new FileProductRunStore({
    storageRootPath: path.join(root, "pi-native"),
    vaultId: catalog.vaultId,
    catalog,
    now: () => ++now
  });
  const runtime = new PiNativeConversationRuntime({
    catalog,
    productRuns,
    sessionApi: API,
    resolveConversationCwd: () => root,
    createAgentSession: async (input) => {
      currentMemoryTurnReader = input.currentMemoryTurnContext ?? null;
      currentKnowledgeTurnReader = input.currentKnowledgeTurnContext ?? null;
      memoryRecallReporter = input.reportMemoryRecallProgress;
      askPersonalMemorySourcesReporter = input.reportAskPersonalMemorySources;
      if (nextActivationError) {
        const error = nextActivationError;
        nextActivationError = null;
        throw error;
      }
      const session = new ControlledAgentSession(
        input.sessionManager,
        factoryTools.registered,
        factoryTools.defaults,
        input.currentTaskPlanTurnContext,
        () => currentMemoryTurnReader?.() ?? null,
        () => currentKnowledgeTurnReader?.() ?? null,
        input.currentExecutionContext
      );
      sessions.push(session);
      return {
        session: session.asAgentSession(),
        planToolNames: [...factoryTools.planAllowed],
        memoryToolNames: [...memoryToolNames],
        ...(factoryWarnings.length ? { warnings: [...factoryWarnings] } : {}),
        ...(input.skillName
          ? {
              skillCommandName: input.skillName.includes(" ")
                ? "echoink-selected-skill"
                : input.skillName
            }
          : {})
      };
    },
    idFactory: () => runIds[runIdIndex++] ?? `run-extra-${runIdIndex}`,
    now: () => ++now,
    ...runtimeOptions
  });
  await runtime.initialize();
  try {
    await assertion({
      root,
      catalog,
      productRuns,
      runtime,
      sessions,
      failNextActivation: (error) => {
        nextActivationError = error;
      },
      setFactoryWarnings: (warnings) => {
        factoryWarnings = [...warnings];
      },
      setMemoryToolNames: (names) => {
        memoryToolNames = [...names];
      },
      configureFactoryTools: (input) => {
        factoryTools = {
          registered: [...input.registered],
          defaults: [...input.defaults],
          planAllowed: [...input.planAllowed]
        };
      },
      currentMemoryTurn: () => currentMemoryTurnReader?.() ?? null,
      currentKnowledgeTurn: () => currentKnowledgeTurnReader?.() ?? null,
      reportMemoryRecall: async (input) => {
        assert.ok(memoryRecallReporter);
        await memoryRecallReporter(input);
      },
      reportAskPersonalMemorySources: async (input) => {
        assert.ok(askPersonalMemorySourcesReporter);
        await askPersonalMemorySourcesReporter(input);
      },
      latestSession: () => {
        const session = sessions.at(-1);
        assert.ok(session, "expected an activated AgentSession fixture");
        return session;
      }
    });
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledAgentSession {
  readonly promptTexts: string[] = [];
  readonly taskPlanTurns: Array<Readonly<PiNativeTaskPlanTurnContext> | null> = [];
  readonly lifecycleCalls: string[] = [];
  readonly activeToolSelections: string[][] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly memoryTurnsBeforeUserEntryAppend: Array<Readonly<PiNativeMemoryTurnContext> | null> = [];
  readonly knowledgeTurnsBeforeUserEntryAppend: Array<Readonly<PiNativeKnowledgeTurnContext> | null> = [];
  readonly settingsManager = {
    flush: async (): Promise<void> => {
      this.lifecycleCalls.push("flush");
    }
  };
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private promptSequence = 0;
  private toolSequence = 0;
  private resolvePrompt: (() => void) | null = null;
  private rejectPrompt: ((error: unknown) => void) | null = null;
  private idlePromise: Promise<void> = Promise.resolve();
  private nextPromptError: Error | null = null;
  private runtimeMessageTimestampDrift = false;
  private emitSettledOnAbort = true;
  isStreaming = false;
  disposed = false;

  private activeToolNames: string[];

  constructor(
    readonly sessionManager: SessionManager,
    private readonly registeredToolNames: readonly string[] = [],
    defaultToolNames: readonly string[] = [],
    private readonly currentTaskPlanTurn: () =>
      Readonly<PiNativeTaskPlanTurnContext> | null = () => null,
    private readonly currentMemoryTurn: () =>
      Readonly<PiNativeMemoryTurnContext> | null = () => null,
    private readonly currentKnowledgeTurn: () =>
      Readonly<PiNativeKnowledgeTurnContext> | null = () => null,
    private readonly currentProviderExecution: () => unknown = () => null
  ) {
    this.activeToolNames = [...defaultToolNames];
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  asAgentSession(): AgentSession {
    return this as unknown as AgentSession;
  }

  failNextPrompt(error: Error): void {
    this.nextPromptError = error;
  }

  enableRuntimeMessageTimestampDrift(): void {
    this.runtimeMessageTimestampDrift = true;
  }

  omitAgentSettledOnAbort(): void {
    this.emitSettledOnAbort = false;
  }

  prompt(text: string, options: { source?: string }): Promise<void> {
    assert.equal(options.source, "interactive");
    assert.equal(this.isStreaming, false);
    this.promptTexts.push(text);
    this.taskPlanTurns.push(this.currentTaskPlanTurn());
    this.memoryTurnsBeforeUserEntryAppend.push(this.currentMemoryTurn());
    this.knowledgeTurnsBeforeUserEntryAppend.push(
      this.currentKnowledgeTurn()
    );
    if (this.nextPromptError) {
      const error = this.nextPromptError;
      this.nextPromptError = null;
      throw error;
    }
    this.promptSequence += 1;
    const userMessage = {
      role: "user",
      content: text,
      timestamp: 200_000 + this.promptSequence
    } as const;
    this.sessionManager.appendMessage(userMessage);
    if (this.runtimeMessageTimestampDrift) {
      const runtimeUserMessage = {
        ...userMessage,
        timestamp: userMessage.timestamp + 10_000
      };
      this.emit({ type: "message_start", message: runtimeUserMessage });
      this.emit({ type: "message_end", message: runtimeUserMessage });
    }
    this.isStreaming = true;
    const prompt = new Promise<void>((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
    });
    this.idlePromise = prompt.catch(() => undefined);
    return prompt;
  }

  finishSuccessful(text: string): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    const durableAssistantMessage = assistantMessage(
      text,
      300_000 + this.promptSequence
    );
    this.sessionManager.appendMessage(durableAssistantMessage);
    if (this.runtimeMessageTimestampDrift) {
      const runtimeAssistantMessage = {
        ...durableAssistantMessage,
        timestamp: durableAssistantMessage.timestamp + 10_000
      };
      this.emit({ type: "message_start", message: runtimeAssistantMessage });
      this.emit({ type: "message_end", message: runtimeAssistantMessage });
    }
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  finishFailed(errorMessage: string): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    this.sessionManager.appendMessage({
      ...assistantMessage("", 300_000 + this.promptSequence),
      stopReason: "error",
      errorMessage
    });
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  finishAborted(): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    this.sessionManager.appendMessage({
      ...assistantMessage("", 300_000 + this.promptSequence),
      stopReason: "aborted"
    });
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  emitAssistantText(delta: string): void {
    const message = assistantMessage(
      delta,
      300_000 + this.promptSequence
    );
    this.emit({ type: "message_start", message });
    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta,
        contentIndex: 0
      }
    } as AgentSessionEvent);
  }

  beginProviderRequest(): void {
    this.currentProviderExecution();
  }

  emitToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args
    });
  }

  emitToolEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean
  ): void {
    this.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result,
      isError
    });
  }

  finishTool(
    toolCallId: string,
    toolName: string,
    result: Readonly<Record<string, unknown>>,
    isError: boolean
  ): void {
    this.startTool(toolCallId, toolName, {});
    this.finishToolResult(toolCallId, toolName, result, isError);
  }

  finishToolResult(
    toolCallId: string,
    toolName: string,
    result: Readonly<Record<string, unknown>>,
    isError: boolean
  ): void {
    this.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: isError ? "failed" : "completed" }],
      details: result.details,
      isError,
      timestamp: 250_000 + this.toolSequence
    });
    this.emitToolEnd(toolCallId, toolName, result, isError);
  }

  startTool(toolCallId: string, toolName: string, args: unknown): void {
    this.emitToolStart(toolCallId, toolName, args);
    this.toolSequence += 1;
    this.sessionManager.appendMessage({
      ...assistantMessage("", 240_000 + this.toolSequence),
      content: [{
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: {}
      }],
      stopReason: "toolUse"
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.lifecycleCalls.push("unsubscribe");
      this.listeners.delete(listener);
    };
  }

  getActiveToolNames(): string[] {
    return [...this.activeToolNames];
  }

  getAllTools(): Array<{ name: string }> {
    return this.registeredToolNames.map((name) => ({ name }));
  }

  setActiveToolsByName(names: readonly string[]): void {
    assert.equal(
      names.every((name) => this.registeredToolNames.includes(name)),
      true
    );
    this.activeToolNames = [...names];
    this.activeToolSelections.push([...names]);
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.lifecycleCalls.push("clearQueue");
    const cleared = {
      steering: [...this.steering],
      followUp: [...this.followUps]
    };
    this.steering.length = 0;
    this.followUps.length = 0;
    return cleared;
  }

  abortCompaction(): void {}

  async abort(): Promise<void> {
    this.lifecycleCalls.push("abort");
    const reject = this.rejectPrompt;
    if (reject && this.emitSettledOnAbort) {
      this.emit({ type: "agent_settled" });
    }
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    reject?.(new Error("fixture prompt aborted"));
  }

  async waitForIdle(): Promise<void> {
    this.lifecycleCalls.push("waitForIdle");
    await this.idlePromise;
  }

  dispose(): void {
    this.lifecycleCalls.push("dispose");
    this.disposed = true;
    this.listeners.clear();
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, 1_000);
  });
  try {
    return await Promise.race([promise, timeoutFailure]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "stop",
    timestamp
  };
  return message;
}
