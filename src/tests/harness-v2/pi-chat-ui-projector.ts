import * as assert from "node:assert/strict";
import type { PiChatRuntimeEvent } from "../../harness/pi-native/contracts";
import { KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA } from "../../knowledge-base/knowledge-maintenance-result";
import {
  decorationsForBranch,
  knowledgeReferenceEntryDetails,
  knowledgeUsageMessageData,
  type KnowledgeUsageEvent
} from "../../knowledge-base/usage";
import {
  PiChatUiProjector,
  type PiChatUiToolApprovalView,
  type PiChatUiToolReceiptView,
  type PiChatUiViewModel,
  type PiSessionBranchEntryView
} from "../../harness/pi-native/pi-chat-ui-projector";
import {
  ECHOINK_TASK_PLAN_ENTRY_TYPE,
  ECHOINK_TASK_PLAN_SCHEMA_VERSION,
  freezeEchoInkTaskPlan,
  taskPlanSessionEntryData
} from "../../types/task-plan";
import {
  ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
  reasoningSummaryEntryData
} from "../../types/reasoning-summary";
import {
  closeReasoningSummary,
  completeReasoningAtFirstText,
  createReasoningSummary,
  updateReasoningActivity
} from "../../harness/pi-native/pi-reasoning-summary";
import { buildPiNoteMentionContextMessage } from "../../harness/pi-native/pi-note-mentions";

export async function runPiChatUiProjectorTests(): Promise<void> {
  assertReasoningSummariesProjectStableAndPrivate();
  assertTaskPlansProjectOneStableDurableMessage();
  assertLiveTaskUpdateResultsProjectOneStableHistoricalTask();
  assertAskSourceAttributionDecorationsAreTruthfulAndIsolated();
  assertDurableBranchRebuildsExistingUiCardsAndHidesReasoning();
  assertImageUserEntriesProjectWithoutPayloadDuplication();
  assertHiddenNoteMentionContextProjectsOntoItsUserMessage();
  assertLiveEventsMergeUntilTheProductSettlementBoundary();
  assertKnowledgeProgressAndToolPayloadsStayPrivate();
  assertKnowledgeMaintenanceResultCardIsLiveDurableAndStrict();
  assertDurableReadbackRekeysAndResolvesProvisionalItems();
  assertToolOnlyAssistantEntryResolvesFromDurableBranchPresence();
  assertPhaseTwoLiveToolProductStatesStayOnOneCard();
  assertPhaseTwoDurableToolProductStatesReopenWithoutLegacyEvents();
  assertPhaseTwoWriteTerminalStatesRemainDistinct();
  assertSessionRunAndBranchScopesDoNotCross();
  assertInterruptedReadbackNeverPretendsTheRunCompleted();
}

function assertHiddenNoteMentionContextProjectsOntoItsUserMessage(): void {
  const projector = new PiChatUiProjector();
  const hidden = buildPiNoteMentionContextMessage([{
    vaultRelativePath: "projects/项目复盘.md",
    fileName: "项目复盘.md",
    content: "PRIVATE_WHOLE_NOTE_BODY"
  }])!;
  const projected = projector.projectSessionBranch({
    piSessionId: "session-note-mentions",
    activeLeafId: "assistant-note-mentions",
    entries: [
      messageEntry("user-note-mentions", null, 1, {
        role: "user",
        content: "请总结"
      }),
      messageEntry("context-note-mentions", "user-note-mentions", 2, hidden),
      messageEntry("assistant-note-mentions", "context-note-mentions", 3, {
        role: "assistant",
        content: "公开回答"
      })
    ],
    runState: "completed",
    productRunId: "run-note-mentions",
    now: 4
  });
  const user = projected.messages.find((message) => message.role === "user");
  assert.deepEqual(user?.noteMentions, [{
    vaultRelativePath: "projects/项目复盘.md",
    fileName: "项目复盘.md"
  }]);
  assert.equal(projected.messages.some((message) =>
    message.text.includes("PRIVATE_WHOLE_NOTE_BODY")
  ), false, "hidden whole-note context never becomes a visible transcript message");
  assert.equal(user?.askSourceAttribution, undefined,
    "user note mentions are not projected as Knowledge attribution");
}

function assertReasoningSummariesProjectStableAndPrivate(): void {
  const projector = new PiChatUiProjector();
  const piSessionId = "session-reasoning-summary";
  const conversationId = "conversation-reasoning-summary";
  const productRunId = "run-reasoning-summary";
  const promptCanary = "PROMPT_PRIVATE_CANARY";
  const answerCanary = "ANSWER_PRIVATE_CANARY";
  const toolArgumentCanary = "TOOL_ARGUMENT_PRIVATE_CANARY";
  const toolResultCanary = "TOOL_RESULT_PRIVATE_CANARY";
  const privateReasoningCanary = "PRIVATE_REASONING_CANARY";
  const started = createReasoningSummary({
    conversationId,
    piSessionId,
    productRunId,
    startedAt: 1_000
  });
  const withProvider = updateReasoningActivity({
    summary: started,
    activity: {
      id: "provider",
      kind: "provider",
      status: "active",
      stage: "requesting",
      startedAt: 1_100,
      updatedAt: 1_100
    }
  });
  const answered = completeReasoningAtFirstText({
    summary: withProvider,
    observedAt: 2_500
  });
  const terminal = closeReasoningSummary({
    summary: answered,
    status: "completed",
    terminalAt: 4_000
  });
  const entries: PiSessionBranchEntryView[] = [
    {
      type: "custom",
      id: "reasoning-start",
      parentId: null,
      timestamp: isoTime(1_000),
      customType: ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
      data: reasoningSummaryEntryData({
        conversationId,
        piSessionId,
        summary: withProvider
      })
    },
    messageEntry("reasoning-user", "reasoning-start", 1_200, {
      role: "user",
      content: `请处理 ${promptCanary}`
    }),
    messageEntry("reasoning-tool-call", "reasoning-user", 1_800, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "reasoning-tool",
        name: "vault_search",
        arguments: { query: toolArgumentCanary }
      }]
    }),
    messageEntry("reasoning-tool-result", "reasoning-tool-call", 2_000, {
      role: "toolResult",
      toolCallId: "reasoning-tool",
      toolName: "vault_search",
      content: [{ type: "text", text: toolResultCanary }],
      isError: false
    }),
    messageEntry("reasoning-answer", "reasoning-tool-result", 3_000, {
      role: "assistant",
      content: `公开回答 ${answerCanary}`
    }),
    {
      type: "custom",
      id: "reasoning-invalid-private",
      parentId: "reasoning-answer",
      timestamp: isoTime(3_500),
      customType: ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
      data: {
        ...reasoningSummaryEntryData({
          conversationId,
          piSessionId,
          summary: terminal
        }),
        thinking: privateReasoningCanary
      }
    },
    {
      type: "custom",
      id: "reasoning-terminal",
      parentId: "reasoning-invalid-private",
      timestamp: isoTime(4_000),
      customType: ECHOINK_REASONING_SUMMARY_ENTRY_TYPE,
      data: reasoningSummaryEntryData({
        conversationId,
        piSessionId,
        summary: terminal
      })
    }
  ];
  const durable = projector.projectSessionBranch({
    piSessionId,
    activeLeafId: "reasoning-terminal",
    entries,
    runState: "completed",
    productRunId,
    runIdentities: [{
      productRunId,
      userEntryId: "reasoning-user",
      assistantEntryId: "reasoning-answer",
      toolCallIds: ["reasoning-tool"],
      updatedAt: 4_000
    }],
    now: 4_100
  });
  const durableReasoning = durable.messages.filter(
    (message) => message.reasoningSummary
  );
  assert.equal(durableReasoning.length, 1);
  assert.equal(durableReasoning[0]?.reasoningSummary?.terminalAt, 4_000);
  assert.equal(durableReasoning[0]?.title, "思考完成 · 2 秒");
  assert.doesNotMatch(JSON.stringify(durable), new RegExp(privateReasoningCanary, "u"));
  const projectedReasoning = JSON.stringify(durableReasoning[0]);
  for (const canary of [
    promptCanary,
    answerCanary,
    toolArgumentCanary,
    toolResultCanary,
    privateReasoningCanary
  ]) {
    assert.doesNotMatch(projectedReasoning, new RegExp(canary, "u"),
      `Reasoning projection excludes ${canary}`);
  }
  assert.equal(durable.messages.filter((message) => message.role === "tool").length, 1,
    "dedicated Tool remains a sibling of Reasoning");
  assert.deepEqual(
    durable.messages.filter((message) =>
      message.runId === productRunId
      && (message.role === "user" || message.reasoningSummary)
    ).map((message) => message.reasoningSummary ? "reasoning" : "user"),
    ["user", "reasoning"],
    "pre-prompt durable snapshot is positioned after its real user message"
  );

  let live = projector.createEmpty({
    piSessionId,
    activeLeafId: "reasoning-terminal",
    now: 900
  });
  live = project(projector, live, runtimeEvent("reasoning_summary", 1_000, {
    summary: withProvider
  }, piSessionId, productRunId, "reasoning-terminal"));
  const liveId = live.messages.find((message) => message.reasoningSummary)?.id;
  assert.equal(live.messages.find((message) => message.reasoningSummary)?.text.includes("请求模型"), true);
  live = project(projector, live, runtimeEvent("reasoning_summary", 4_000, {
    summary: terminal
  }, piSessionId, productRunId, "reasoning-terminal"));
  assert.equal(live.messages.filter((message) => message.reasoningSummary).length, 1);
  assert.equal(live.messages.find((message) => message.reasoningSummary)?.id, liveId);
  assert.equal(liveId, durableReasoning[0]?.id,
    "live and durable Reasoning share one stable message id");

  const reopenCases = [
    { runState: "completed", status: "completed", updatedAt: 5_000, title: "思考完成 · 4 秒" },
    { runState: "failed", status: "failed", updatedAt: 6_000, title: "处理失败 · 5 秒" },
    { runState: "cancelled", status: "cancelled", updatedAt: 7_000, title: "思考已取消 · 6 秒" },
    { runState: "interrupted", status: "interrupted", updatedAt: 8_000, title: "思考中断 · 7 秒" },
    { runState: "idle", status: "interrupted", updatedAt: 9_000, title: "思考中断 · 8 秒" }
  ] as const;
  for (const reopenCase of reopenCases) {
    const reopened = projector.projectSessionBranch({
      piSessionId,
      activeLeafId: "reasoning-user",
      entries: entries.slice(0, 2),
      runState: reopenCase.runState,
      productRunId,
      runIdentities: [{
        productRunId,
        userEntryId: "reasoning-user",
        updatedAt: reopenCase.updatedAt
      }],
      now: 99_999
    });
    const reopenedReasoning = reopened.messages.find(
      (message) => message.reasoningSummary
    );
    assert.equal(reopenedReasoning?.reasoningSummary?.status, reopenCase.status);
    assert.equal(reopenedReasoning?.reasoningSummary?.terminalAt, reopenCase.updatedAt,
      "reopen closeout uses the real ProductRun updatedAt boundary");
    assert.equal(reopenedReasoning?.title, reopenCase.title);
  }

  const missingRunBoundary = projector.projectSessionBranch({
    piSessionId,
    activeLeafId: "reasoning-user",
    entries: entries.slice(0, 2),
    runState: "failed",
    productRunId,
    runIdentities: [{ productRunId, userEntryId: "reasoning-user" }],
    now: 99_999
  });
  assert.equal(
    missingRunBoundary.messages.find((message) => message.reasoningSummary)
      ?.reasoningSummary?.terminalAt,
    undefined,
    "reopen never invents a terminal time without a real ProductRun updatedAt"
  );
}

function assertTaskPlansProjectOneStableDurableMessage(): void {
  const projector = new PiChatUiProjector();
  const piSessionId = "session-task-plan-history";
  const conversationId = "conversation-task-plan-history";
  const first = freezeEchoInkTaskPlan({
    schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
    planId: "durable-plan",
    title: "真实结构化计划",
    status: "in_progress",
    version: 1,
    steps: [{ stepId: "step-1", text: "第一步", status: "in_progress" }],
    currentStepId: "step-1",
    source: "agent",
    productRunId: "run-task-plan",
    createdAt: 10,
    updatedAt: 10
  });
  const second = freezeEchoInkTaskPlan({
    ...first,
    status: "completed",
    version: 2,
    steps: [{ stepId: "step-1", text: "第一步", status: "completed" }],
    currentStepId: undefined,
    updatedAt: 20
  });
  const entries: PiSessionBranchEntryView[] = [
    messageEntry("assistant-plan-copy", null, 5, {
      role: "assistant",
      content: "计划：第一步，然后完成。"
    }),
    {
      type: "custom",
      id: "task-plan-entry-v1",
      parentId: "assistant-plan-copy",
      timestamp: isoTime(10),
      customType: ECHOINK_TASK_PLAN_ENTRY_TYPE,
      data: taskPlanSessionEntryData({ conversationId, piSessionId, plan: first })
    },
    {
      type: "custom",
      id: "task-plan-entry-v2",
      parentId: "task-plan-entry-v1",
      timestamp: isoTime(20),
      customType: ECHOINK_TASK_PLAN_ENTRY_TYPE,
      data: taskPlanSessionEntryData({ conversationId, piSessionId, plan: second })
    }
  ];
  const projected = projector.projectSessionBranch({
    piSessionId,
    activeLeafId: "task-plan-entry-v2",
    entries,
    runState: "completed",
    productRunId: "run-task-plan",
    now: 30
  });
  const tasks = projected.messages.filter((message) => message.taskPlan);
  assert.equal(tasks.length, 1,
    "later versions update one stable history Task instead of adding another row");
  assert.equal(tasks[0]?.taskPlan?.version, 2);
  assert.equal(tasks[0]?.taskPlan?.status, "completed");
  assert.equal(tasks[0]?.id.includes("durable-plan"), true);
  assert.equal(
    projected.messages.filter((message) => message.taskPlan).length,
    1,
    "natural-language plan copy creates no additional taskPlan"
  );

  const reopened = projector.projectSessionBranch({
    piSessionId,
    activeLeafId: "task-plan-entry-v2",
    entries,
    runState: "completed",
    productRunId: "run-task-plan",
    now: 40
  });
  const reopenedTask = reopened.messages.find((message) => message.taskPlan);
  assert.equal(reopenedTask?.id, tasks[0]?.id);
  assert.equal(reopenedTask?.taskPlan?.version, 2,
    "reopen restores the latest durable version without regeneration");
}

function assertLiveTaskUpdateResultsProjectOneStableHistoricalTask(): void {
  const projector = new PiChatUiProjector();
  const first = freezeEchoInkTaskPlan({
    schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
    planId: "live-task-update-plan",
    title: "实时结构化计划",
    status: "pending",
    version: 1,
    steps: [
      { stepId: "step-1", text: "读取状态", status: "pending" },
      { stepId: "step-2", text: "更新结果", status: "pending" }
    ],
    source: "agent",
    productRunId: "run-task-update-live",
    createdAt: 10,
    updatedAt: 10
  });
  const second = freezeEchoInkTaskPlan({
    ...first,
    status: "in_progress",
    version: 2,
    steps: [
      { stepId: "step-1", text: "读取状态", status: "completed" },
      { stepId: "step-2", text: "更新结果", status: "in_progress" }
    ],
    currentStepId: "step-2",
    updatedAt: 20
  });
  let view = projector.createEmpty({
    piSessionId: "session-task-update-live",
    activeLeafId: "assistant-task-update-live",
    now: 1
  });
  view = project(projector, view, runtimeEvent("tool_execution_end", 10, {
    toolCallId: "task-update-v1",
    toolName: "task_update",
    result: {
      content: [{ type: "text", text: "task_plan_update_pending" }],
      details: { source: "echoink-task-plan", plan: first }
    },
    isError: false
  }, "session-task-update-live", "run-task-update-live", "task-plan-entry-v1"));
  const firstTasks = view.messages.filter((message) => message.taskPlan);
  assert.equal(firstTasks.length, 1,
    "the first valid live task_update immediately inserts one historical Task");
  assert.equal(firstTasks[0]?.taskPlan?.version, 1);
  const stableMessageId = firstTasks[0]?.id;
  assert.ok(stableMessageId,
    "the first live task_update assigns the historical Task a stable message ID");

  view = project(projector, view, runtimeEvent("tool_execution_end", 20, {
    toolCallId: "task-update-v2",
    toolName: "task_update",
    result: {
      content: [{ type: "text", text: "task_plan_update_pending" }],
      details: { source: "echoink-task-plan", plan: second }
    },
    isError: false
  }, "session-task-update-live", "run-task-update-live", "task-plan-entry-v2"));
  const updatedTasks = view.messages.filter((message) => message.taskPlan);
  assert.equal(updatedTasks.length, 1,
    "a same-plan live task_update replaces rather than duplicates the Task");
  assert.equal(updatedTasks[0]?.id, stableMessageId);
  assert.equal(updatedTasks[0]?.taskPlan?.version, 2);
  assert.equal(updatedTasks[0]?.taskPlan?.steps[0]?.status, "completed");
  assert.equal(updatedTasks[0]?.taskPlan?.steps[1]?.status, "in_progress");

  let invalid = projector.createEmpty({
    piSessionId: "session-task-update-invalid",
    activeLeafId: "assistant-task-update-invalid",
    now: 1
  });
  invalid = project(projector, invalid, runtimeEvent("tool_execution_end", 30, {
    toolCallId: "task-update-invalid",
    toolName: "task_update",
    result: {
      content: [{ type: "text", text: "task_plan_update_pending" }],
      details: {
        source: "echoink-task-plan",
        plan: { ...first, schemaVersion: 999 }
      }
    },
    isError: false
  }, "session-task-update-invalid", "run-task-update-invalid", null));
  assert.equal(invalid.messages.some((message) => message.taskPlan), false,
    "an invalid live task_update plan creates no historical Task");
  invalid = project(projector, invalid, runtimeEvent("tool_execution_end", 31, {
    toolCallId: "task-update-missing-plan",
    toolName: "task_update",
    result: {
      content: [{ type: "text", text: "task_plan_update_pending" }],
      details: { source: "echoink-task-plan" }
    },
    isError: false
  }, "session-task-update-invalid", "run-task-update-invalid", null));
  assert.equal(invalid.messages.some((message) => message.taskPlan), false,
    "a live task_update without plan data creates no historical Task");
}

function assertAskSourceAttributionDecorationsAreTruthfulAndIsolated(): void {
  const reference = {
    referenceId: "vault-source-a",
    vaultRelativePath: "wiki/source-a.md",
    title: "Vault Source A",
    excerpt: "实际注入的 Vault 片段",
    contentRevision: `sha256:${"a".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1
  };
  const sources = [
    { id: "memory-a", title: "一级 Memory A" },
    { id: "memory-a", title: "重复项不能覆盖首个标题" },
    { id: "memory-b", title: "一级 Memory B" }
  ];
  const entries = [
    {
      type: "custom_message",
      id: "ask-resource-source-attribution",
      details: knowledgeReferenceEntryDetails([reference])
    },
    messageEntry("assistant-source-attribution", "ask-resource-source-attribution", 2, {
      role: "assistant",
      content: "公开回答"
    })
  ];
  const usage: KnowledgeUsageEvent = {
    sourceEventId: "usage-source-attribution",
    vaultId: "vault-source-attribution",
    conversationId: "conversation-source-attribution",
    piSessionId: "session-source-attribution",
    piEntryId: "assistant-source-attribution",
    productRunId: "run-source-attribution",
    referenceIds: [reference.referenceId],
    workflow: "ask",
    producedPaths: [],
    personalMemorySources: sources
  };
  const decorations = decorationsForBranch(entries, [usage]);
  sources[0]!.title = "外部变化不能影响来源快照";
  assert.deepEqual(decorations, [{
    piSessionId: "session-source-attribution",
    entryId: "assistant-source-attribution",
    knowledgeReferences: [reference],
    askSourceAttribution: true,
    personalMemorySources: [
      { id: "memory-a", title: "一级 Memory A" },
      { id: "memory-b", title: "一级 Memory B" }
    ]
  }]);

  const projector = new PiChatUiProjector();
  const projected = projector.projectSessionBranch({
    piSessionId: "session-source-attribution",
    activeLeafId: "assistant-source-attribution",
    entries,
    runState: "completed",
    productRunId: "run-source-attribution",
    now: 3
  });
  const decorated = projector.decorate(projected, decorations);
  const answer = decorated.messages.find((message) => message.text === "公开回答");
  assert.equal(answer?.askSourceAttribution, true);
  assert.deepEqual(answer?.personalMemorySources, [
    { id: "memory-a", title: "一级 Memory A" },
    { id: "memory-b", title: "一级 Memory B" }
  ]);
  assert.deepEqual(knowledgeUsageMessageData(answer), {
    askSourceAttribution: true,
    references: [reference],
    producedPaths: [],
    personalMemorySources: [
      { id: "memory-a", title: "一级 Memory A" },
      { id: "memory-b", title: "一级 Memory B" }
    ]
  });

  const mutableDecorationSources = decorations[0]?.personalMemorySources as Array<{
    id: string;
    title: string;
  }>;
  mutableDecorationSources.push({ id: "memory-late", title: "不得穿透投影" });
  assert.equal(answer?.personalMemorySources?.length, 2);

  const emptyUsage: KnowledgeUsageEvent = {
    sourceEventId: "usage-source-attribution-empty",
    vaultId: "vault-source-attribution",
    conversationId: "conversation-source-attribution",
    piSessionId: "session-source-attribution-empty",
    piEntryId: "assistant-source-attribution-empty",
    productRunId: "run-source-attribution-empty",
    referenceIds: [],
    workflow: "ask",
    producedPaths: [],
    personalMemorySources: []
  };
  const emptyDecorations = decorationsForBranch([
    messageEntry("assistant-source-attribution-empty", null, 4, {
      role: "assistant",
      content: "没有来源的公开回答"
    })
  ], [emptyUsage]);
  assert.deepEqual(emptyDecorations, [{
    piSessionId: "session-source-attribution-empty",
    entryId: "assistant-source-attribution-empty",
    askSourceAttribution: true,
    personalMemorySources: []
  }]);

  const legacyAskUsage = { ...emptyUsage } as KnowledgeUsageEvent;
  delete legacyAskUsage.personalMemorySources;
  assert.deepEqual(
    decorationsForBranch([
      messageEntry("assistant-source-attribution-empty", null, 4, {
        role: "assistant",
        content: "旧版来源事件"
      })
    ], [legacyAskUsage]),
    [{
      piSessionId: "session-source-attribution-empty",
      entryId: "assistant-source-attribution-empty",
      askSourceAttribution: true,
      personalMemorySources: []
    }]
  );
}

function assertKnowledgeMaintenanceResultCardIsLiveDurableAndStrict(): void {
  const projector = new PiChatUiProjector();
  const completed = maintenanceResult("completed");
  let live = projector.createEmpty({
    piSessionId: "session-maintain-live",
    activeLeafId: "assistant-maintain-live",
    now: 1
  });
  live = project(projector, live, runtimeEvent("tool_execution_start", 2, {
    toolCallId: "maintain-live",
    toolName: "knowledge_maintain",
    privacySafe: true,
    args: {}
  }, "session-maintain-live", "run-maintain-live", "assistant-maintain-live"));
  assert.equal(onlyTool(live).status, "running");
  live = project(projector, live, runtimeEvent("tool_execution_end", 3, {
    toolCallId: "maintain-live",
    toolName: "knowledge_maintain",
    privacySafe: true,
    result: { status: "completed", maintenanceResult: completed },
    isError: false
  }, "session-maintain-live", "run-maintain-live", "tool-maintain-live"));
  const liveCard = onlyTool(live);
  assert.equal(liveCard.itemType, "knowledgeBase");
  assert.equal(liveCard.knowledgeBaseUi?.title, "知识维护完成");
  assert.equal(
    liveCard.knowledgeBaseUi?.sections[0]?.items[0]?.path,
    "wiki/Readback.md"
  );

  const durableInput = {
    piSessionId: "session-maintain-durable",
    activeLeafId: "tool-maintain-durable",
    entries: [
      messageEntry("assistant-maintain-durable", null, 1, {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: "maintain-durable",
          name: "knowledge_maintain",
          arguments: {}
        }]
      }),
      messageEntry("tool-maintain-durable", "assistant-maintain-durable", 2, {
        role: "toolResult" as const,
        toolCallId: "maintain-durable",
        toolName: "knowledge_maintain",
        content: [{ type: "text" as const, text: "completed" }],
        details: { status: "completed", maintenanceResult: completed },
        isError: false
      })
    ],
    runState: "completed" as const,
    productRunId: "run-maintain-durable",
    runIdentities: [{
      productRunId: "run-maintain-durable",
      userEntryId: "user-maintain-durable",
      assistantEntryId: "assistant-maintain-durable",
      toolCallIds: ["maintain-durable"],
      knowledgeWorkflow: "maintain" as const
    }],
    now: 3
  };
  const durable = projector.projectSessionBranch(durableInput);
  const reopened = projector.projectSessionBranch(durableInput);
  assert.deepEqual(onlyTool(durable).knowledgeBaseUi, liveCard.knowledgeBaseUi);
  assert.deepEqual(reopened.messages, durable.messages);

  let ordinaryLive = projector.createEmpty({
    piSessionId: "session-ordinary-maintenance-payload-live",
    activeLeafId: "assistant-ordinary-maintenance-payload-live",
    now: 1
  });
  ordinaryLive = project(projector, ordinaryLive, runtimeEvent(
    "tool_execution_start",
    2,
    {
      toolCallId: "ordinary-maintenance-payload-live",
      toolName: "note_read",
      args: { path: "notes/ordinary.md" }
    },
    "session-ordinary-maintenance-payload-live",
    "run-ordinary-maintenance-payload-live"
  ));
  ordinaryLive = project(projector, ordinaryLive, runtimeEvent(
    "tool_execution_end",
    3,
    {
      toolCallId: "ordinary-maintenance-payload-live",
      toolName: "note_read",
      result: { status: "completed", maintenanceResult: completed },
      isError: false
    },
    "session-ordinary-maintenance-payload-live",
    "run-ordinary-maintenance-payload-live"
  ));
  const ordinaryLiveTool = onlyTool(ordinaryLive);
  assert.equal(ordinaryLiveTool.role, "tool");
  assert.equal(ordinaryLiveTool.knowledgeBaseUi, undefined);
  assert.notEqual(ordinaryLiveTool.itemType, "knowledgeBase");
  assert.match(ordinaryLiveTool.processOutput ?? "", /maintenanceResult/u);

  const ordinaryDurableInput = {
    ...durableInput,
    piSessionId: "session-ordinary-maintenance-payload-durable",
    activeLeafId: "tool-ordinary-maintenance-payload-durable",
    productRunId: "run-ordinary-maintenance-payload-durable",
    entries: [
      messageEntry("assistant-ordinary-maintenance-payload-durable", null, 1, {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: "ordinary-maintenance-payload-durable",
          name: "note_read",
          arguments: { path: "notes/ordinary.md" }
        }]
      }),
      messageEntry(
        "tool-ordinary-maintenance-payload-durable",
        "assistant-ordinary-maintenance-payload-durable",
        2,
        {
          role: "toolResult" as const,
          toolCallId: "ordinary-maintenance-payload-durable",
          toolName: "note_read",
          content: [{ type: "text" as const, text: "ordinary result" }],
          details: { status: "completed", maintenanceResult: completed },
          isError: false
        }
      )
    ],
    runIdentities: [{
      productRunId: "run-ordinary-maintenance-payload-durable",
      userEntryId: "user-ordinary-maintenance-payload-durable",
      assistantEntryId: "assistant-ordinary-maintenance-payload-durable",
      toolCallIds: ["ordinary-maintenance-payload-durable"]
    }]
  };
  for (const ordinaryDurable of [
    projector.projectSessionBranch(ordinaryDurableInput),
    projector.projectSessionBranch(ordinaryDurableInput)
  ]) {
    const ordinaryTool = onlyTool(ordinaryDurable);
    assert.equal(ordinaryTool.role, "tool");
    assert.equal(ordinaryTool.knowledgeBaseUi, undefined);
    assert.notEqual(ordinaryTool.itemType, "knowledgeBase");
    assert.match(ordinaryTool.processOutput ?? "", /ordinary result/u);
  }

  const expected = [
    ["partial", "知识维护部分完成", "partial", "failed"],
    ["noop", "没有需要提炼的知识", "noop", "success"],
    ["failed", "知识维护失败", undefined, "failed"],
    ["write_uncertain", "知识写入状态不确定", undefined, "failed"]
  ] as const;
  for (const [status, title, completion, cardStatus] of expected) {
    const result = maintenanceResult(status);
    const view = projector.projectSessionBranch({
      ...durableInput,
      entries: [
        durableInput.entries[0],
        messageEntry("tool-maintain-durable", "assistant-maintain-durable", 2, {
          role: "toolResult",
          toolCallId: "maintain-durable",
          toolName: "knowledge_maintain",
          content: [{ type: "text", text: status }],
          details: { status: status === "noop" ? "completed" : "failed", maintenanceResult: result },
          isError: status === "failed" || status === "write_uncertain"
        })
      ]
    });
    const card = onlyTool(view).knowledgeBaseUi;
    assert.equal(card?.title, title);
    assert.equal(card?.completion, completion);
    assert.equal(card?.status, cardStatus);
  }

  for (const forged of [
    { ...completed, schema: "forged.v1" },
    {
      ...completed,
      notes: [{
        operation: "created",
        path: "raw/NotKnowledge.md",
        title: "伪造",
        summary: "不能成为成功卡"
      }]
    },
    { ...completed, unexpected: true }
  ]) {
    const view = projector.projectSessionBranch({
      ...durableInput,
      entries: [
        durableInput.entries[0],
        messageEntry("tool-maintain-durable", "assistant-maintain-durable", 2, {
          role: "toolResult",
          toolCallId: "maintain-durable",
          toolName: "knowledge_maintain",
          content: [{ type: "text", text: "malformed" }],
          details: { status: "completed", maintenanceResult: forged },
          isError: false
        })
      ]
    });
    assert.equal(onlyTool(view).knowledgeBaseUi, undefined);
    assert.notEqual(onlyTool(view).itemType, "knowledgeBase");
  }
}

function maintenanceResult(
  status: "completed" | "partial" | "noop" | "failed" | "write_uncertain"
) {
  const hasNote = status === "completed" || status === "partial";
  const hasIssue = status === "partial" || status === "failed"
    || status === "write_uncertain";
  return {
    schema: KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA,
    status,
    notes: hasNote ? [{
      operation: "created" as const,
      path: "wiki/Readback.md",
      title: "最终回读标题",
      summary: "最终回读摘要"
    }] : [],
    issues: hasIssue ? [{
      code: status === "write_uncertain" ? "write_uncertain" : "fixture_issue",
      message: status === "write_uncertain" ? "写入状态需要人工核对" : "只展示真实结果"
    }] : [],
    systemPaths: ["raw/index.md", ".echoink/knowledge/tracker.json"]
  };
}

function assertKnowledgeProgressAndToolPayloadsStayPrivate(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-knowledge-private",
    activeLeafId: "leaf-knowledge-private",
    now: 1
  });
  view = project(projector, view, runtimeEvent("knowledge_progress", 2, {
    status: "active",
    stage: "searching"
  }, "session-knowledge-private", "run-knowledge-private"));
  assert.ok(view.messages.some((message) =>
    message.title === "正在检索知识库" && message.itemType === "thinking"
  ));
  assert.doesNotMatch(JSON.stringify(view), /冲突与时效/u);

  view = project(projector, view, runtimeEvent("tool_execution_start", 3, {
    toolCallId: "knowledge-search-private",
    toolName: "knowledge_search",
    privacySafe: true,
    args: {
      query: "PRIVATE_QUERY_CANARY",
      cursor: "PRIVATE_CURSOR_CANARY"
    }
  }, "session-knowledge-private", "run-knowledge-private"));
  view = project(projector, view, runtimeEvent("tool_execution_end", 4, {
    toolCallId: "knowledge-search-private",
    toolName: "knowledge_search",
    privacySafe: true,
    result: {
      content: [{ type: "text", text: "PRIVATE_RESULT_CANARY" }],
      details: { path: "wiki/PRIVATE_PATH_CANARY.md" }
    },
    isError: false
  }, "session-knowledge-private", "run-knowledge-private"));
  const privateProjection = JSON.stringify(view);
  assert.doesNotMatch(
    privateProjection,
    /PRIVATE_(?:QUERY|CURSOR|RESULT|PATH)_CANARY/u
  );
  const tool = toolByCall(view, "knowledge-search-private");
  assert.equal(tool.title, "知识库检索完成");
  assert.equal(tool.processInputAvailability, "empty");
  assert.equal(tool.processOutputAvailability, "empty");

  view = project(projector, view, runtimeEvent("knowledge_progress", 5, {
    status: "active",
    stage: "checking_conflicts_freshness"
  }, "session-knowledge-private", "run-knowledge-private"));
  assert.ok(view.messages.some((message) =>
    message.title === "正在检查冲突与时效"
  ));
  view = project(projector, view, runtimeEvent("message_update", 6, {
    messageKey: "assistant-knowledge-private",
    textDelta: "首个非空回答"
  }, "session-knowledge-private", "run-knowledge-private"));
  assert.equal(view.messages.some((message) =>
    message.itemType === "thinking" && message.runId === "run-knowledge-private"
  ), false);

  const durable = projector.projectSessionBranch({
    piSessionId: "session-knowledge-durable-private",
    activeLeafId: "assistant-durable-private",
    entries: [
      messageEntry("user-durable-private", null, 1, {
        role: "user",
        content: "/ask fixture"
      }),
      messageEntry("assistant-tool-private", "user-durable-private", 2, {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "knowledge-read-private",
          name: "knowledge_read",
          arguments: {
            vaultRelativePath: "wiki/DURABLE_PATH_CANARY.md",
            expectedContentRevision: `sha256:${"a".repeat(64)}`
          }
        }]
      }),
      messageEntry("tool-result-private", "assistant-tool-private", 3, {
        role: "toolResult",
        toolCallId: "knowledge-read-private",
        toolName: "knowledge_read",
        content: [{ type: "text", text: "DURABLE_RESULT_CANARY" }],
        details: { source: "echoink-knowledge" },
        isError: false
      }),
      messageEntry("assistant-durable-private", "tool-result-private", 4, {
        role: "assistant",
        content: "公开回答"
      })
    ],
    runState: "completed",
    productRunId: "run-knowledge-durable-private",
    runIdentities: [{
      productRunId: "run-knowledge-durable-private",
      userEntryId: "user-durable-private",
      assistantEntryId: "assistant-durable-private",
      toolCallIds: ["knowledge-read-private"]
      ,knowledgeWorkflow: "ask"
    }],
    now: 5
  });
  assert.doesNotMatch(
    JSON.stringify(durable),
    /DURABLE_(?:PATH|RESULT)_CANARY/u
  );

  let ordinary = projector.createEmpty({
    piSessionId: "session-ordinary-note-read",
    activeLeafId: "leaf-ordinary-note-read",
    now: 1
  });
  ordinary = project(projector, ordinary, runtimeEvent("tool_execution_start", 2, {
    toolCallId: "ordinary-note-read",
    toolName: "note_read",
    args: { path: "notes/ORDINARY_VISIBLE_PATH.md" }
  }, "session-ordinary-note-read", "run-ordinary-note-read"));
  assert.match(JSON.stringify(ordinary), /ORDINARY_VISIBLE_PATH/u);

  ordinary = project(projector, ordinary, runtimeEvent("tool_execution_start", 3, {
    toolCallId: "ordinary-spoofed-note-read",
    toolName: "note_read",
    args: {
      privacySafe: true,
      path: "notes/SPOOFED_VISIBLE_PATH.md"
    }
  }, "session-ordinary-note-read", "run-ordinary-note-read"));
  assert.match(JSON.stringify(ordinary), /SPOOFED_VISIBLE_PATH/u);
}

function assertDurableBranchRebuildsExistingUiCardsAndHidesReasoning(): void {
  const projector = new PiChatUiProjector();
  const entries: PiSessionBranchEntryView[] = [
    messageEntry("user-1", null, 1, {
      role: "user",
      content: "查一下本地 Fixture"
    }),
    messageEntry("assistant-tool", "user-1", 2, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "HIDDEN_REASONING_CANARY" },
        { type: "text", text: "我来查询。" },
        {
          type: "toolCall",
          id: "fixture-call-1",
          name: "mcp.fixture.lookup",
          arguments: { key: "alpha" }
        }
      ],
      model: "fixture-model",
      stopReason: "toolUse",
      timestamp: 2
    }),
    messageEntry("tool-result", "assistant-tool", 3, {
      role: "toolResult",
      toolCallId: "fixture-call-1",
      toolName: "mcp.fixture.lookup",
      content: [{ type: "text", text: "fixture-ok" }],
      details: { source: "local-fixture" },
      isError: false,
      timestamp: 3
    }),
    messageEntry("assistant-final", "tool-result", 4, {
      role: "assistant",
      content: [{ type: "text", text: "查询结果是 fixture-ok。" }],
      model: "fixture-model",
      stopReason: "stop",
      timestamp: 4
    }),
    {
      type: "compaction",
      id: "compact-1",
      parentId: "assistant-final",
      timestamp: isoTime(5),
      summary: "较早对话摘要",
      firstKeptEntryId: "tool-result",
      tokensBefore: 1200
    },
    {
      type: "branch_summary",
      id: "branch-summary-1",
      parentId: "compact-1",
      timestamp: isoTime(6),
      fromId: "assistant-final",
      summary: "从查询结果继续"
    },
    messageEntry("assistant-error", "branch-summary-1", 7, {
      role: "assistant",
      content: [{ type: "thinking", thinking: "SECOND_HIDDEN_CANARY" }],
      stopReason: "error",
      errorMessage: "Provider fixture failure",
      timestamp: 7
    })
  ];

  const view = projector.projectSessionBranch({
    piSessionId: "session-A",
    activeLeafId: "assistant-error",
    entries,
    runState: "failed",
    productRunId: "run-1",
    runIdentities: [{
      productRunId: "run-1",
      userEntryId: "user-1",
      assistantEntryId: "assistant-final",
      toolCallIds: ["fixture-call-1"]
    }],
    now: 8
  });

  assert.equal(view.activeLeafId, "assistant-error");
  assert.equal(view.runState, "failed");
  assert.doesNotMatch(JSON.stringify(view), /HIDDEN_REASONING_CANARY|SECOND_HIDDEN_CANARY/u);
  assert.equal(view.messages.filter((message) => message.role === "tool").length, 1);
  const tool = view.messages.find((message) => message.role === "tool");
  assert.equal(tool?.itemType, "mcpToolCall");
  assert.equal(tool?.status, "completed");
  assert.match(tool?.text ?? "", /fixture-ok/u);
  assert.match(tool?.id ?? "", /session-A.*assistant-error.*fixture-call-1/u);
  assert.equal(view.messages.filter((message) => message.itemType === "contextCompaction").length, 2);
  assert.ok(view.messages.some((message) => message.title === "上下文已压缩"));
  assert.ok(view.messages.some((message) => message.title === "已切换对话分支"));
  assert.ok(view.messages.some((message) => message.text === "Provider fixture failure" && message.status === "failed"));
  assert.deepEqual(view.provisionalMessageIds, []);
  assert.deepEqual(view.pendingToolCallIds, []);

  const reloginEntries = entries.map((entry) =>
    entry.id === "assistant-error"
      ? messageEntry("assistant-error", "branch-summary-1", 7, {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider_oauth_relogin_required",
          timestamp: 7
        })
      : entry
  );
  const reloginView = projector.projectSessionBranch({
    piSessionId: "session-A",
    activeLeafId: "assistant-error",
    entries: reloginEntries,
    runState: "failed",
    productRunId: "run-1",
    runIdentities: [],
    now: 8
  });
  assert.ok(reloginView.messages.some((message) =>
    message.status === "failed"
    && message.text === "OpenAI Codex 授权已失效，请在设置中重新登录。"
  ));
}

function assertImageUserEntriesProjectWithoutPayloadDuplication(): void {
  const pngPayloadCanary = "PRIVATE_PNG_BASE64_CANARY";
  const jpegPayloadCanary = "PRIVATE_JPEG_BASE64_CANARY";
  const entries: PiSessionBranchEntryView[] = [
    messageEntry("user-image-only", null, 1, {
      role: "user",
      content: [
        { type: "text", text: "" },
        {
          type: "image",
          mimeType: "image/png",
          data: pngPayloadCanary
        }
      ]
    } as never),
    messageEntry("assistant-image-ack", "user-image-only", 2, {
      role: "assistant",
      content: [{ type: "text", text: "已看到第一张图。" }],
      stopReason: "stop",
      timestamp: 2
    }),
    messageEntry("user-image-ordered", "assistant-image-ack", 3, {
      role: "user",
      content: [
        { type: "text", text: "按顺序比较" },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: jpegPayloadCanary
        },
        {
          type: "image",
          mimeType: "image/png",
          data: pngPayloadCanary
        }
      ]
    } as never)
  ];
  const input = {
    piSessionId: "session-images",
    activeLeafId: "user-image-ordered",
    entries,
    runState: "completed" as const,
    productRunId: "run-images",
    runIdentities: [{
      productRunId: "run-images",
      userEntryId: "user-image-ordered",
      toolCallIds: []
    }],
    now: 4
  };

  const projected = new PiChatUiProjector().projectSessionBranch(input);
  const pureImage = projected.messages.find((message) =>
    message.id.endsWith(":entry:user-image-only")
  );
  assert.ok(pureImage, "a pure-image Pi user Entry must remain visible");
  assert.equal(pureImage.role, "user");
  assert.equal(pureImage.text, "");
  assert.deepEqual(pureImage.images, [{
    type: "image",
    name: "图片 1",
    path: "",
    mimeType: "image/png",
    availability: "unavailable"
  }]);

  const ordered = projected.messages.find((message) =>
    message.id.endsWith(":entry:user-image-ordered")
  );
  assert.equal(ordered?.text, "按顺序比较");
  assert.deepEqual(ordered?.images?.map((image) => image.mimeType), [
    "image/jpeg",
    "image/png"
  ]);
  assert.deepEqual(ordered?.images?.map((image) => image.name), [
    "图片 1",
    "图片 2"
  ]);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /PRIVATE_(?:PNG|JPEG)_BASE64_CANARY/u,
    "UI projection must never copy Pi image Base64"
  );

  const reopened = new PiChatUiProjector().projectSessionBranch(input);
  assert.deepEqual(reopened.messages, projected.messages);
  const earlierBranch = new PiChatUiProjector().projectSessionBranch({
    ...input,
    activeLeafId: "assistant-image-ack",
    entries: entries.slice(0, 2)
  });
  assert.ok(earlierBranch.messages.some((message) =>
    message.id.endsWith(":entry:user-image-only")
    && message.images?.[0]?.mimeType === "image/png"
  ));
}

function assertLiveEventsMergeUntilTheProductSettlementBoundary(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-live",
    activeLeafId: "leaf-at-run-start",
    now: 1
  });

  view = project(projector, view, runtimeEvent("message_start", 2, {
    messageKey: "assistant-visible",
    role: "assistant"
  }));
  view = project(projector, view, runtimeEvent("message_update", 3, {
    messageKey: "assistant-visible",
    textDelta: "公开"
  }));
  const hiddenReasoning = {
    ...runtimeEvent("message_update", 4, {
      messageKey: "assistant-reasoning",
      textDelta: "HIDDEN_LIVE_REASONING"
    }),
    contentKind: "reasoning"
  } as PiChatRuntimeEvent;
  view = project(projector, view, hiddenReasoning);
  view = project(projector, view, runtimeEvent("message_update", 5, {
    messageKey: "assistant-visible",
    textDelta: "答案"
  }));
  view = project(projector, view, runtimeEvent("message_end", 6, {
    messageKey: "assistant-visible",
    role: "assistant",
    text: "公开答案",
    status: "completed"
  }));
  view = project(projector, view, runtimeEvent("message_entry_resolved", 7, {
    messageKey: "assistant-visible",
    entryId: "assistant-live-entry"
  }));

  view = project(projector, view, runtimeEvent("tool_execution_start", 8, {
    toolCallId: "tool-live-1",
    toolName: "mcp.fixture.lookup",
    args: { key: "beta" }
  }));
  view = project(projector, view, runtimeEvent("tool_execution_start", 8, {
    toolCallId: "tool-live-1",
    toolName: "mcp.fixture.lookup",
    args: { key: "beta" }
  }));
  view = project(projector, view, runtimeEvent("tool_execution_update", 9, {
    toolCallId: "tool-live-1",
    toolName: "mcp.fixture.lookup",
    update: { text: "查询中" }
  }));
  view = project(projector, view, runtimeEvent("tool_execution_end", 10, {
    toolCallId: "tool-live-1",
    toolName: "mcp.fixture.lookup",
    result: { content: [{ type: "text", text: "live-fixture-ok" }] },
    isError: false
  }));
  view = project(projector, view, runtimeEvent("compaction_start", 10.1, {
    reason: "threshold"
  }));
  view = project(projector, view, runtimeEvent("compaction_end", 10.2, {
    reason: "threshold",
    entryId: "compact-live-entry",
    aborted: false,
    willRetry: false
  }));

  assert.equal(view.messages.filter((message) => message.role === "tool").length, 1);
  assert.ok(view.messages.some((message) =>
    message.itemType === "contextCompaction" && message.status === "completed"
  ));
  assert.doesNotMatch(JSON.stringify(view), /HIDDEN_LIVE_REASONING/u);
  assert.ok(view.provisionalMessageIds.length >= 2);
  assert.deepEqual(view.pendingToolCallIds, []);

  view = project(projector, view, runtimeEvent("agent_end", 11, { willRetry: true }));
  assert.equal(view.runState, "running", "agent_end must not settle the product run");
  view = project(projector, view, runtimeEvent("agent_settled", 12, {}));
  assert.equal(view.runState, "finalizing");
  assert.notEqual(view.runState, "completed");

  view = project(projector, view, runtimeEvent("product_run_settled", 13, {
    terminalState: "completed",
    assistantEntryId: "assistant-live-entry"
  }));
  assert.equal(view.runState, "completed");

  let failed = projector.createEmpty({ piSessionId: "session-failed", now: 1 });
  failed = project(projector, failed, runtimeEvent("product_run_settled", 2, {
    terminalState: "failed"
  }, "session-failed", "run-failed", null));
  assert.equal(failed.runState, "failed");
  assert.ok(failed.messages.some((message) => message.itemType === "error" && message.status === "failed"));

  let cancelled = projector.createEmpty({ piSessionId: "session-cancelled", now: 1 });
  cancelled = project(projector, cancelled, runtimeEvent("product_run_settled", 2, {
    terminalState: "cancelled"
  }, "session-cancelled", "run-cancelled", null));
  assert.equal(cancelled.runState, "cancelled");
  assert.ok(cancelled.messages.some((message) => message.status === "interrupted"));
}

function assertDurableReadbackRekeysAndResolvesProvisionalItems(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-reconcile",
    activeLeafId: "leaf-before-append",
    now: 1
  });
  view = project(projector, view, runtimeEvent("message_start", 2, {
    messageKey: "answer",
    role: "assistant"
  }, "session-reconcile", "run-reconcile", "leaf-before-append"));
  view = project(projector, view, runtimeEvent("message_update", 3, {
    messageKey: "answer",
    textDelta: "耐久答案"
  }, "session-reconcile", "run-reconcile", "leaf-before-append"));
  view = project(projector, view, runtimeEvent("message_end", 4, {
    messageKey: "answer",
    entryId: "assistant-durable",
    role: "assistant",
    text: "耐久答案",
    status: "completed"
  }, "session-reconcile", "run-reconcile", "assistant-durable"));
  view = project(projector, view, runtimeEvent("tool_execution_start", 5, {
    toolCallId: "tool-durable",
    toolName: "mcp.fixture.lookup",
    args: { key: "gamma" }
  }, "session-reconcile", "run-reconcile", "assistant-durable"));
  view = project(projector, view, runtimeEvent("tool_execution_end", 6, {
    toolCallId: "tool-durable",
    toolName: "mcp.fixture.lookup",
    result: "durable-tool-ok",
    isError: false
  }, "session-reconcile", "run-reconcile", "assistant-durable"));
  view = project(projector, view, runtimeEvent("agent_settled", 7, {},
    "session-reconcile", "run-reconcile", "tool-result-durable"));

  const reconciled = projector.reconcileSessionBranch({
    current: view,
    activeLeafId: "tool-result-durable",
    entries: [
      messageEntry("assistant-durable", null, 4, {
        role: "assistant",
        content: [{ type: "text", text: "耐久答案" }],
        stopReason: "stop",
        timestamp: 4
      }),
      messageEntry("tool-result-durable", "assistant-durable", 6, {
        role: "toolResult",
        toolCallId: "tool-durable",
        toolName: "mcp.fixture.lookup",
        content: [{ type: "text", text: "durable-tool-ok" }],
        isError: false,
        timestamp: 6
      })
    ],
    now: 8
  });

  assert.equal(reconciled.runState, "finalizing");
  assert.equal(reconciled.activeLeafId, "tool-result-durable");
  assert.deepEqual(reconciled.provisionalMessageIds, []);
  assert.deepEqual(reconciled.pendingToolCallIds, []);
  assert.equal(reconciled.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(reconciled.messages.filter((message) => message.role === "tool").length, 1);
  assert.ok(reconciled.messages.every((message) => message.id.includes("tool-result-durable")));

  const decorated = projector.decorate(reconciled, [{
    toolCallId: "tool-durable",
    status: "approval",
    details: "EchoInk approval decoration"
  }]);
  const decoratedTool = decorated.messages.find((message) => message.role === "tool");
  assert.equal(decoratedTool?.status, "approval");
  assert.equal(decoratedTool?.details, "EchoInk approval decoration");
  assert.equal(reconciled.messages.find((message) => message.role === "tool")?.status, "completed");
}

function assertToolOnlyAssistantEntryResolvesFromDurableBranchPresence(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-tool-chain",
    activeLeafId: "user-entry",
    now: 1
  });
  view = project(projector, view, runtimeEvent("message_start", 2, {
    messageKey: "assistant-tool-use",
    role: "assistant"
  }, "session-tool-chain", "run-tool-chain", "user-entry"));
  view = project(projector, view, runtimeEvent("message_end", 3, {
    messageKey: "assistant-tool-use",
    role: "assistant",
    text: "",
    status: "completed"
  }, "session-tool-chain", "run-tool-chain", "user-entry"));
  view = project(projector, view, runtimeEvent("tool_execution_start", 4, {
    toolCallId: "call_00_Vds",
    toolName: "mcp.fixture.lookup",
    args: { key: "runtime" }
  }, "session-tool-chain", "run-tool-chain", "4eb7b79b"));
  view = project(projector, view, runtimeEvent("tool_execution_end", 5, {
    toolCallId: "call_00_Vds",
    toolName: "mcp.fixture.lookup",
    result: { content: [{ type: "text", text: "fixture-result" }] },
    isError: false
  }, "session-tool-chain", "run-tool-chain", "c425a240"));
  view = project(projector, view, runtimeEvent("message_start", 6, {
    messageKey: "assistant-final",
    role: "assistant"
  }, "session-tool-chain", "run-tool-chain", "c425a240"));
  view = project(projector, view, runtimeEvent("message_update", 7, {
    messageKey: "assistant-final",
    textDelta: "最终回答"
  }, "session-tool-chain", "run-tool-chain", "c425a240"));
  view = project(projector, view, runtimeEvent("message_end", 8, {
    messageKey: "assistant-final",
    role: "assistant",
    text: "最终回答",
    status: "completed"
  }, "session-tool-chain", "run-tool-chain", "03720e2c"));
  view = project(projector, view, runtimeEvent("agent_settled", 9, {},
    "session-tool-chain", "run-tool-chain", "03720e2c"));
  view = project(projector, view, runtimeEvent("message_entry_resolved", 10, {
    messageKey: "assistant-tool-use",
    entryId: "4eb7b79b"
  }, "session-tool-chain", "run-tool-chain", "03720e2c"));
  view = project(projector, view, runtimeEvent("message_entry_resolved", 11, {
    messageKey: "assistant-final",
    entryId: "03720e2c"
  }, "session-tool-chain", "run-tool-chain", "03720e2c"));

  assert.ok(view.provisionalMessageIds.some((id) => id.endsWith(":entry:4eb7b79b")));
  assert.ok(view.provisionalMessageIds.some((id) => id.endsWith(":tool:call_00_Vds")));
  assert.ok(view.provisionalMessageIds.some((id) => id.endsWith(":entry:03720e2c")));
  assert.deepEqual(view.pendingToolCallIds, []);

  const reconciled = projector.reconcileSessionBranch({
    current: view,
    activeLeafId: "03720e2c",
    entries: [
      messageEntry("4eb7b79b", null, 3, {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_00_Vds",
          name: "mcp.fixture.lookup",
          arguments: { key: "runtime" }
        }],
        stopReason: "toolUse",
        timestamp: 3
      }),
      messageEntry("c425a240", "4eb7b79b", 5, {
        role: "toolResult",
        toolCallId: "call_00_Vds",
        toolName: "mcp.fixture.lookup",
        content: [{ type: "text", text: "fixture-result" }],
        isError: false,
        timestamp: 5
      }),
      messageEntry("03720e2c", "c425a240", 8, {
        role: "assistant",
        content: [{ type: "text", text: "最终回答" }],
        stopReason: "stop",
        timestamp: 8
      })
    ],
    now: 12
  });

  assert.equal(reconciled.runState, "finalizing");
  assert.deepEqual(reconciled.provisionalMessageIds, []);
  assert.deepEqual(reconciled.pendingToolCallIds, []);
  assert.equal(reconciled.messages.filter((message) => message.role === "tool").length, 1);
  assert.equal(reconciled.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(
    reconciled.messages.find((message) => message.role === "assistant")?.text,
    "最终回答"
  );
  assert.equal(reconciled.messages.find((message) => message.role === "tool")?.status, "completed");
}

function assertPhaseTwoLiveToolProductStatesStayOnOneCard(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-p2-live",
    activeLeafId: "user-p2-live",
    now: 1
  });
  view = project(projector, view, runtimeEvent("tool_execution_start", 2, {
    toolCallId: "write-live",
    toolName: "note_create",
    args: { path: "Inbox/Live.md", content: "live" }
  }, "session-p2-live", "run-p2-live", "assistant-write-live"));
  assert.equal(onlyTool(view).status, "waiting_approval");

  view = project(projector, view, runtimeEvent("tool_execution_update", 3, {
    toolCallId: "write-live",
    toolName: "note_create",
    update: { phase: "approved" }
  }, "session-p2-live", "run-p2-live", "assistant-write-live"));
  assert.equal(onlyTool(view).status, "approved");
  assert.match(onlyTool(view).details ?? "", /已批准/u);

  view = project(projector, view, runtimeEvent("tool_execution_update", 4, {
    toolCallId: "write-live",
    toolName: "note_create",
    update: { phase: "running" }
  }, "session-p2-live", "run-p2-live", "assistant-write-live"));
  assert.equal(onlyTool(view).status, "running");

  view = project(projector, view, runtimeEvent("tool_execution_end", 5, {
    toolCallId: "write-live",
    toolName: "note_create",
    result: { path: "Inbox/Live.md", status: "completed" },
    isError: false
  }, "session-p2-live", "run-p2-live", "tool-result-live"));
  assert.equal(onlyTool(view).status, "verifying");
  assert.equal(view.messages.filter((message) => message.role === "tool").length, 1);

  const approval: PiChatUiToolApprovalView = {
    piSessionId: "session-p2-live",
    toolCallId: "write-live",
    productRunId: "run-p2-live",
    operationIdentity: "operation-live",
    status: "approved",
    preview: "创建 Inbox/Live.md",
    updatedAt: 6
  };
  const receipt: PiChatUiToolReceiptView = {
    piSessionId: "session-p2-live",
    toolCallId: "write-live",
    productRunId: "run-p2-live",
    operationIdentity: "operation-live",
    status: "completed",
    readbackVerified: true,
    readbackSummary: "已读回 Inbox/Live.md",
    updatedAt: 7
  };
  view = projector.decorateToolProductState(view, {
    approvals: [approval],
    receipts: [receipt]
  });
  assert.deepEqual(onlyTool(view).approval, {
    status: "approved",
    preview: "创建 Inbox/Live.md",
    updatedAt: 6
  });
  assert.equal(
    "operationIdentity" in (onlyTool(view).approval ?? {}),
    false,
    "ChatMessage approval projection must not expose authorization identity"
  );
  assert.equal(
    onlyTool(view).status,
    "verifying",
    "Receipt arriving before the Pi Tool Result Entry must not complete the card"
  );

  const reconciled = projector.reconcileSessionBranch({
    current: view,
    activeLeafId: "assistant-final-live",
    entries: [
      messageEntry("assistant-write-live", null, 2, {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "write-live",
          name: "note_create",
          arguments: { path: "Inbox/Live.md", content: "live" }
        }],
        stopReason: "toolUse",
        timestamp: 2
      }),
      messageEntry("tool-result-live", "assistant-write-live", 5, {
        role: "toolResult",
        toolCallId: "write-live",
        toolName: "note_create",
        content: [{ type: "text", text: "created" }],
        isError: false,
        timestamp: 5
      }),
      messageEntry("assistant-final-live", "tool-result-live", 8, {
        role: "assistant",
        content: [{ type: "text", text: "创建完成。" }],
        stopReason: "stop",
        timestamp: 8
      })
    ],
    approvals: [approval],
    receipts: [receipt],
    now: 8
  });

  assert.equal(onlyTool(reconciled).status, "completed");
  assert.equal(reconciled.messages.filter((message) => message.role === "tool").length, 1);
  assert.deepEqual(reconciled.provisionalMessageIds, []);
  assert.deepEqual(reconciled.pendingToolCallIds, []);

  let cancelled = projector.createEmpty({
    piSessionId: "session-p2-cancelled",
    activeLeafId: "user-p2-cancelled",
    now: 1
  });
  cancelled = project(projector, cancelled, runtimeEvent("tool_execution_start", 2, {
    toolCallId: "delete-cancelled",
    toolName: "note_delete",
    args: { path: "Cancelled.md" }
  }, "session-p2-cancelled", "run-p2-cancelled", "assistant-delete-cancelled"));
  cancelled = project(projector, cancelled, runtimeEvent("product_run_settled", 3, {
    terminalState: "cancelled"
  }, "session-p2-cancelled", "run-p2-cancelled", "assistant-delete-cancelled"));
  assert.equal(onlyTool(cancelled).status, "cancelled");
}

function assertPhaseTwoDurableToolProductStatesReopenWithoutLegacyEvents(): void {
  const entries: PiSessionBranchEntryView[] = [
    messageEntry("user-p2-reopen", null, 1, {
      role: "user",
      content: "先读再创建",
      timestamp: 1
    }),
    messageEntry("assistant-read-p2", "user-p2-reopen", 2, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "read-p2",
        name: "note_read",
        arguments: { path: "Source.md" }
      }],
      stopReason: "toolUse",
      timestamp: 2
    }),
    messageEntry("tool-result-read-p2", "assistant-read-p2", 3, {
      role: "toolResult",
      toolCallId: "read-p2",
      toolName: "note_read",
      content: [{ type: "text", text: "source-content" }],
      isError: false,
      timestamp: 3
    }),
    messageEntry("assistant-write-p2", "tool-result-read-p2", 4, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-p2",
        name: "note_create",
        arguments: { path: "Created.md", content: "source-content" }
      }],
      stopReason: "toolUse",
      timestamp: 4
    }),
    messageEntry("tool-result-write-p2", "assistant-write-p2", 5, {
      role: "toolResult",
      toolCallId: "write-p2",
      toolName: "note_create",
      content: [{ type: "text", text: "created" }],
      isError: false,
      timestamp: 5
    }),
    messageEntry("assistant-final-p2", "tool-result-write-p2", 6, {
      role: "assistant",
      content: [{ type: "text", text: "已读取并创建。" }],
      stopReason: "stop",
      timestamp: 6
    })
  ];
  const approvals: PiChatUiToolApprovalView[] = [{
    piSessionId: "session-p2-reopen",
    toolCallId: "write-p2",
    productRunId: "run-p2-reopen",
    operationIdentity: "operation-p2-reopen",
    status: "approved",
    preview: "创建 Created.md",
    updatedAt: 7
  }];
  const receipts: PiChatUiToolReceiptView[] = [{
    piSessionId: "session-p2-reopen",
    toolCallId: "write-p2",
    productRunId: "run-p2-reopen",
    operationIdentity: "operation-p2-reopen",
    status: "completed",
    readbackVerified: true,
    readbackSummary: "Created.md 已读回验证",
    updatedAt: 8
  }];
  const input = {
    piSessionId: "session-p2-reopen",
    activeLeafId: "assistant-final-p2",
    entries,
    runState: "completed" as const,
    productRunId: "run-p2-reopen",
    runIdentities: [{
      productRunId: "run-p2-reopen",
      userEntryId: "user-p2-reopen",
      assistantEntryId: "assistant-final-p2",
      toolCallIds: ["read-p2", "write-p2"]
    }],
    approvals,
    receipts,
    now: 9
  };

  const receiptFirst = new PiChatUiProjector().decorateToolProductState(
    new PiChatUiProjector().createEmpty({
      piSessionId: "session-p2-reopen",
      activeLeafId: null,
      now: 0
    }),
    { approvals, receipts }
  );
  assert.deepEqual(receiptFirst.messages, [], "product records cannot create a Tool card without Pi");

  const first = new PiChatUiProjector().projectSessionBranch(input);
  const reopened = new PiChatUiProjector().projectSessionBranch(input);
  const tools = first.messages.filter((message) => message.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(toolByCall(first, "read-p2").status, "completed");
  assert.equal(toolByCall(first, "write-p2").status, "completed");
  assert.deepEqual(toolByCall(first, "write-p2").approval, {
    status: "approved",
    preview: "创建 Created.md",
    updatedAt: 7
  });
  assert.match(toolByCall(first, "write-p2").details ?? "", /读回验证/u);
  assert.deepEqual(reopened.messages, first.messages);
  assert.deepEqual(reopened.provisionalMessageIds, []);
  assert.deepEqual(reopened.pendingToolCallIds, []);

  const mismatchedReceipt = {
    ...receipts[0],
    operationIdentity: "different-operation"
  };
  const mismatch = new PiChatUiProjector().projectSessionBranch({
    ...input,
    receipts: [mismatchedReceipt]
  });
  assert.equal(toolByCall(mismatch, "write-p2").status, "verifying");
}

function assertPhaseTwoWriteTerminalStatesRemainDistinct(): void {
  const projector = new PiChatUiProjector();
  const entries: PiSessionBranchEntryView[] = [
    messageEntry("assistant-terminal-p2", null, 1, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "terminal-p2",
        name: "note_update",
        arguments: { path: "Target.md", content: "next" }
      }],
      stopReason: "toolUse",
      timestamp: 1
    }),
    messageEntry("tool-result-terminal-p2", "assistant-terminal-p2", 2, {
      role: "toolResult",
      toolCallId: "terminal-p2",
      toolName: "note_update",
      content: [{ type: "text", text: "tool-result" }],
      isError: false,
      timestamp: 2
    })
  ];
  const approval: PiChatUiToolApprovalView = {
    piSessionId: "session-terminal-p2",
    toolCallId: "terminal-p2",
    productRunId: "run-terminal-p2",
    operationIdentity: "operation-terminal-p2",
    status: "approved"
  };
  const projectReceipt = (receipt: PiChatUiToolReceiptView) =>
    projector.projectSessionBranch({
      piSessionId: "session-terminal-p2",
      activeLeafId: "tool-result-terminal-p2",
      entries,
      runState: "completed",
      productRunId: "run-terminal-p2",
      approvals: [approval],
      receipts: [receipt],
      now: 3
    });
  const receipt = (status: PiChatUiToolReceiptView["status"], readbackVerified = false):
    PiChatUiToolReceiptView => ({
      piSessionId: "session-terminal-p2",
      toolCallId: "terminal-p2",
      productRunId: "run-terminal-p2",
      operationIdentity: "operation-terminal-p2",
      status,
      readbackVerified
    });

  assert.equal(onlyTool(projectReceipt(receipt("failed"))).status, "failed");
  assert.equal(onlyTool(projectReceipt(receipt("cancelled"))).status, "cancelled");
  assert.equal(onlyTool(projectReceipt(receipt("uncertain"))).status, "uncertain");
  assert.equal(
    onlyTool(projectReceipt(receipt("completed", false))).status,
    "uncertain",
    "an unverified write Receipt must never be displayed as completed"
  );

  const denied = projector.projectSessionBranch({
    piSessionId: "session-terminal-p2",
    activeLeafId: "tool-result-terminal-p2",
    entries: [
      entries[0],
      messageEntry("tool-result-terminal-p2", "assistant-terminal-p2", 2, {
        role: "toolResult",
        toolCallId: "terminal-p2",
        toolName: "note_update",
        content: [{ type: "text", text: "用户拒绝本次写入" }],
        isError: true,
        timestamp: 2
      })
    ],
    runState: "completed",
    productRunId: "run-terminal-p2",
    approvals: [{ ...approval, status: "denied" }],
    now: 3
  });
  assert.equal(onlyTool(denied).status, "denied");
  assert.equal(onlyTool(denied).approval?.status, "denied");
  assert.deepEqual(denied.pendingToolCallIds, []);

  const expired = projector.projectSessionBranch({
    piSessionId: "session-terminal-p2",
    activeLeafId: "tool-result-terminal-p2",
    entries,
    runState: "completed",
    productRunId: "run-terminal-p2",
    approvals: [{ ...approval, status: "expired" }],
    now: 4
  });
  assert.equal(onlyTool(expired).status, "denied",
    "aggregate Tool status keeps its existing denied compatibility mapping");
  assert.equal(onlyTool(expired).approval?.status, "expired",
    "the display-only Approval snapshot must preserve expired distinctly");
}

function assertSessionRunAndBranchScopesDoNotCross(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({
    piSessionId: "session-left",
    activeLeafId: "leaf-left",
    now: 1
  });
  view = project(projector, view, runtimeEvent("message_start", 2, {
    messageKey: "answer-left",
    role: "assistant"
  }, "session-left", "run-left", "leaf-left"));
  view = project(projector, view, runtimeEvent("message_update", 3, {
    messageKey: "answer-left",
    textDelta: "left-only"
  }, "session-left", "run-left", "leaf-left"));

  const afterForeignSession = project(projector, view, runtimeEvent("message_update", 4, {
    messageKey: "answer-right",
    textDelta: "FOREIGN_SESSION_CANARY"
  }, "session-right", "run-right", "leaf-right"));
  assert.deepEqual(afterForeignSession, view);

  const afterForeignRun = project(projector, view, runtimeEvent("message_update", 5, {
    messageKey: "answer-old-run",
    textDelta: "FOREIGN_RUN_CANARY"
  }, "session-left", "run-old", "leaf-left"));
  assert.deepEqual(afterForeignRun, view);

  const changed = project(projector, view, runtimeEvent("branch_changed", 6, {
    previousLeafId: "leaf-left"
  }, "session-left", "run-left", "leaf-new"));
  assert.equal(changed.activeLeafId, "leaf-new");
  assert.equal(changed.messages.length, 1);
  assert.equal(changed.messages[0].title, "正在切换对话分支");
  assert.doesNotMatch(JSON.stringify(changed), /left-only|FOREIGN_SESSION_CANARY|FOREIGN_RUN_CANARY/u);
}

function assertInterruptedReadbackNeverPretendsTheRunCompleted(): void {
  const projector = new PiChatUiProjector();
  const view = projector.projectSessionBranch({
    piSessionId: "session-interrupted",
    activeLeafId: "user-only",
    entries: [messageEntry("user-only", null, 1, {
      role: "user",
      content: "首条消息已提交",
      timestamp: 1
    })],
    productRunId: "run-interrupted",
    runState: "interrupted",
    now: 2
  });

  assert.equal(view.runState, "interrupted");
  assert.ok(view.messages.some((message) =>
    message.role === "system"
    && message.itemType === "error"
    && message.status === "interrupted"
    && /尚未完成/u.test(message.text)
  ));
  assert.ok(!view.messages.some((message) => message.status === "running"));
  assert.ok(!view.messages.some((message) =>
    message.role === "assistant" && message.status === "completed"
  ));
}

function onlyTool(view: PiChatUiViewModel): PiChatUiViewModel["messages"][number] {
  const tools = view.messages.filter((message) => message.role === "tool");
  assert.equal(tools.length, 1);
  return tools[0];
}

function toolByCall(
  view: PiChatUiViewModel,
  toolCallId: string
): PiChatUiViewModel["messages"][number] {
  const message = view.messages.find((item) =>
    item.role === "tool" && item.id.endsWith(`:tool:${toolCallId}`)
  );
  assert.ok(message, `missing Tool card ${toolCallId}`);
  return message;
}

function project(
  projector: PiChatUiProjector,
  current: PiChatUiViewModel,
  event: PiChatRuntimeEvent
): PiChatUiViewModel {
  return projector.projectRuntimeEvent({ current, event });
}

function runtimeEvent<T extends PiChatRuntimeEvent["type"]>(
  type: T,
  occurredAt: number,
  payload: Omit<Extract<PiChatRuntimeEvent, { type: T }>,
    "type" | "occurredAt" | "productRunId" | "conversationId" | "piSessionId" | "activeLeafId">,
  piSessionId = "session-live",
  productRunId = "run-live",
  activeLeafId: string | null = "leaf-at-run-start"
): Extract<PiChatRuntimeEvent, { type: T }> {
  return {
    type,
    productRunId,
    conversationId: "conversation-fixture",
    piSessionId,
    activeLeafId,
    occurredAt,
    ...payload
  } as Extract<PiChatRuntimeEvent, { type: T }>;
}

function messageEntry(
  id: string,
  parentId: string | null,
  timestamp: number,
  message: NonNullable<PiSessionBranchEntryView["message"]>
): PiSessionBranchEntryView {
  return {
    type: "message",
    id,
    parentId,
    timestamp: isoTime(timestamp),
    message
  };
}

function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
