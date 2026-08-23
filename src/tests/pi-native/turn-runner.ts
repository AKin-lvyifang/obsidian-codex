import * as assert from "node:assert/strict";
import type {
  PiChatSubmitRequest,
  PiChatRuntimeEvent,
  PiChatRuntimeEventListener,
  PiConversationProjection,
  PiProductRunRecord
} from "../../harness/pi-native/contracts";
import type { StoredSession } from "../../settings/settings";
import { piChatMemoryModeForGlobalSetting, startChatTurn } from "../../ui/codex-view/turn-runner";
import { enabledSkillsForComposerMenu, removeTrailingSlashQuery } from "../../ui/codex-view/composer-controller";
import { compactBrandedModelLabel } from "../../ui/codex-view/composer";
import { buildActiveEchoInkResourceCatalog } from "../../resources/registry";
import { splitMessageTableRow } from "../../ui/render-message";
import { copyAnswerMarkdown } from "../../ui/codex-view/answer-copy";
import { piConversationDeriveActionLabel } from "../../ui/codex-view/message-list";
import type { QueuedTurnItem } from "../../ui/turn-queue";

export async function runPiNativeTurnRunnerTests(): Promise<void> {
  asyncSkillMenuOnlyReturnsEnabledSkills();
  composerModelLabelsOnlyRemoveKnownBrandPrefixes();
  globalMemoryModeOverridesEverySubmit();
  tableRowsKeepVaultNoteAliasesInsideOneCell();
  await messageActionContractsStayTruthful();
  await agentSettlementOnlyFinalizesPiChatTurn();
  await disabledOrStaleSkillCannotStartTurn();
  await maintainScopeIsResolvedBeforeProviderSubmit();
}

async function maintainScopeIsResolvedBeforeProviderSubmit(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-maintain-scope",
    title: "Maintain scope",
    kind: "chat",
    piSessionId: "pi-maintain-scope",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const exactScope = Object.freeze({
    mode: "exact" as const,
    sourcePaths: Object.freeze(["raw/a.md"]) as readonly [string]
  });
  let preparedInput: Readonly<{
    request: string;
    attachmentPaths: readonly string[];
  }> | null = null;
  let submitted: PiChatSubmitRequest | null = null;
  const plugin = {
    settings: { memory: { useLongTermMemory: true } },
    prepareEchoInkKnowledgeMaintenanceScope: async (input: Readonly<{
      request: string;
      attachmentPaths: readonly string[];
    }>) => {
      preparedInput = input;
      if (input.attachmentPaths.length > 1) {
        throw new Error("/maintain 一次只支持一篇 Raw 笔记。");
      }
      return exactScope;
    },
    submitPiChat: async (request: PiChatSubmitRequest) => {
      submitted = request;
      throw new Error("stop after request capture");
    },
    readPiConversationProjection: async () => {
      throw new Error("no durable run in request-capture fixture");
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: () => undefined
  };
  const view: any = {
    plugin,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearComposerDraft: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined
  };
  const item = (attachments: QueuedTurnItem["attachments"]): QueuedTurnItem => ({
    id: "queued-maintain-scope",
    sessionId: session.id,
    text: "/maintain",
    attachments,
    skill: null,
    turnOptions: {
      model: "",
      reasoning: "high",
      serviceTier: "fast",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  });

  assert.equal(await startChatTurn(view, session, item([{
    type: "file",
    name: "a.md",
    path: "/vault/raw/a.md"
  }]), "composer"), "failed");
  assert.deepEqual(preparedInput, {
    request: "",
    attachmentPaths: ["/vault/raw/a.md"]
  });
  assert.deepEqual(submitted?.maintenanceScope, exactScope);

  submitted = null;
  assert.equal(await startChatTurn(view, session, item([{
    type: "file",
    name: "a.md",
    path: "/vault/raw/a.md"
  }, {
    type: "file",
    name: "b.md",
    path: "/vault/raw/b.md"
  }]), "composer"), "failed");
  assert.equal(submitted, null, "invalid maintain scope must stop before ProductRun");
}

function composerModelLabelsOnlyRemoveKnownBrandPrefixes(): void {
  assert.equal(compactBrandedModelLabel("DeepSeek-V4-Flash"), "V4-Flash");
  assert.equal(compactBrandedModelLabel("Kimi-K3"), "K3");
  assert.equal(compactBrandedModelLabel("qWeN-2.5-Coder"), "2.5-Coder");
  assert.equal(compactBrandedModelLabel("Qwen3-32B"), "3-32B");
  assert.equal(compactBrandedModelLabel("GPT-5.2-Codex"), "5.2-Codex");
  assert.equal(compactBrandedModelLabel("gPt4.1-mini"), "4.1-mini");
  assert.equal(compactBrandedModelLabel("Custom-GPT-Model"), "Custom-GPT-Model");
  assert.equal(compactBrandedModelLabel("gptastic-model"), "gptastic-model");
}

async function messageActionContractsStayTruthful(): Promise<void> {
  assert.equal(piConversationDeriveActionLabel({ role: "user" }), null);
  assert.equal(piConversationDeriveActionLabel({ role: "assistant" }), "从这条回复新建会话");

  let copiedText = "";
  const success = await copyAnswerMarkdown(
    { text: "用户消息原文" },
    async () => "unused",
    async (text) => { copiedText = text; }
  );
  assert.equal(success.status, "success");
  assert.equal(copiedText, "用户消息原文");

  const failure = await copyAnswerMarkdown(
    { text: "复制失败原文" },
    async () => "unused",
    async () => { throw new Error("clipboard unavailable"); }
  );
  assert.equal(failure.status, "failure");
}

function tableRowsKeepVaultNoteAliasesInsideOneCell(): void {
  assert.deepEqual(
    splitMessageTableRow("| 内链 | [[wiki/Long Note Name|长笔记]] 应保持完整 |"),
    ["内链", "[[wiki/Long Note Name|长笔记]] 应保持完整"]
  );
  assert.deepEqual(
    splitMessageTableRow("| 代码 | `left|right` 与 escaped\\|pipe |"),
    ["代码", "`left|right` 与 escaped|pipe"]
  );
}

function globalMemoryModeOverridesEverySubmit(): void {
  assert.equal(piChatMemoryModeForGlobalSetting(true), "normal");
  assert.equal(piChatMemoryModeForGlobalSetting(false), "no_memory");
  assert.equal(removeTrailingSlashQuery("/bet"), "");
  assert.equal(removeTrailingSlashQuery("保留前文 /bet"), "保留前文");
}

function asyncSkillMenuOnlyReturnsEnabledSkills(): void {
  const enabled = {
    id: "echoink-local:skill:enabled",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "enabled",
    description: "Enabled fixture",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/enabled/SKILL.md"
  };
  const savedDisabled = {
    ...enabled,
    enabled: false
  };
  const rediscoveredEnabled = {
    ...enabled,
    name: "rediscovered enabled",
    contentPath: "skills/rediscovered/SKILL.md"
  };
  const falseWinsCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [savedDisabled] },
    manual: [rediscoveredEnabled]
  });
  assert.equal(falseWinsCatalog[0]?.enabled, false);
  assert.deepEqual(enabledSkillsForComposerMenu(falseWinsCatalog), []);
  assert.deepEqual(
    enabledSkillsForComposerMenu([enabled]).map((skill) => skill.id),
    [enabled.id]
  );
}

async function disabledOrStaleSkillCannotStartTurn(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-disabled-skill",
    title: "Conversation",
    kind: "chat",
    piSessionId: "pi-session-disabled-skill",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const selectedSkill = {
    id: "echoink-local:skill:review",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "stale review",
    description: "Stale selected value",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/stale/SKILL.md"
  };
  const item: QueuedTurnItem = {
    id: "queued-disabled-skill",
    sessionId: session.id,
    text: "hello",
    attachments: [],
    skill: selectedSkill,
    turnOptions: {
      model: "",
      reasoning: "high",
      serviceTier: "fast",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  let submitted: PiChatSubmitRequest | null = null;
  const runtimeSkill = {
    ...selectedSkill,
    name: "current review",
    contentPath: "skills/current/SKILL.md"
  };
  const disabledCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [{ ...selectedSkill, enabled: false }] },
    manual: [runtimeSkill]
  });
  const removedCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [selectedSkill] },
    manual: []
  });
  assert.equal(disabledCatalog[0]?.enabled, false);
  assert.deepEqual(removedCatalog, []);
  const view: any = {
    plugin: {
      buildRuntimeEchoInkResourceCatalog: async () => disabledCatalog,
      submitPiChat: async (request: PiChatSubmitRequest) => {
        submitted = request;
        throw new Error("submission should not complete in this fixture");
      }
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearComposerDraft: () => undefined
  };

  assert.equal(await startChatTurn(view, session, item, "composer"), "failed");
  assert.equal(submitted, null, "disabled Skill must fail before Provider submit");

  view.plugin.buildRuntimeEchoInkResourceCatalog = async () => removedCatalog;
  assert.equal(await startChatTurn(view, session, item, "queue"), "failed");
  assert.equal(submitted, null, "removed Skill must fail before Provider submit");

}

async function agentSettlementOnlyFinalizesPiChatTurn(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-turn-runner",
    title: "Conversation",
    kind: "chat",
    piSessionId: "pi-session-turn-runner",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-turn-runner",
    sessionId: session.id,
    text: "hello",
    attachments: [],
    skill: {
      id: "echoink-local:skill:review",
      kind: "skill",
      source: "echoink-local",
      name: "review",
      description: "Review the current work",
      enabled: true,
      bridgeMode: "prompt-only",
      contentPath: "skills/review/SKILL.md"
    },
    turnOptions: {
      model: "",
      reasoning: "high",
      serviceTier: "fast",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  const runResult = deferred<Readonly<PiProductRunRecord>>();
  let listener: PiChatRuntimeEventListener | null = null;
  let projectionReads = 0;
  let releasedRunId = "";
  let composerCleared = false;
  let submittedRequest: PiChatSubmitRequest | null = null;
  const renderedAssistantStatuses: Array<string | undefined> = [];
  const plugin = {
    getVaultPath: () => "/vault",
    buildRuntimeEchoInkResourceCatalog: async () => [item.skill!],
    submitPiChat: async (request: PiChatSubmitRequest) => {
      submittedRequest = request;
      return {
        productRunId: "product-run-turn-runner",
        conversationId: session.id,
        piSessionId: session.piSessionId!,
        userEntryId: "entry-user",
        result: runResult.promise
      };
    },
    subscribePiRun: (_productRunId: string, next: PiChatRuntimeEventListener) => {
      listener = next;
      return { unsubscribe: () => { listener = null; } };
    },
    readPiConversationProjection: async (): Promise<PiConversationProjection> => {
      projectionReads += 1;
      return durableProjection(
        session,
        projectionReads === 1 ? "running" : "completed"
      );
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: (productRunId: string) => {
      releasedRunId = productRunId;
    }
  };
  let running = false;
  let activeRunId = "";
  const view: any = {
    plugin,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    activeRunNativeExecutionRecordIds: [],
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => { composerCleared = true; },
    renderTabs: () => undefined,
    renderMessagesIfActive: () => {
      renderedAssistantStatuses.push(
        session.messages.find((message) => message.role === "assistant")?.status
      );
    },
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };

  let turnResolved = false;
  const turn = startChatTurn(view, session, item, "composer").then((outcome) => {
    turnResolved = true;
    return outcome;
  });
  await waitFor(() => listener !== null);
  assert.equal(submittedRequest?.skillPath, "skills/review/SKILL.md");
  assert.equal(submittedRequest?.skillName, "review");
  assert.equal(submittedRequest?.memoryMode, "normal");

  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "assistant-1",
    role: "assistant"
  }));
  await emit(listener, runtimeEvent({
    type: "message_update",
    messageKey: "assistant-1",
    textDelta: "streaming"
  }));
  await emit(listener, runtimeEvent({ type: "agent_end", willRetry: false }));
  assert.equal(turnResolved, false, "agent_end must not settle the product turn");
  assert.equal(projectionReads, 0, "agent_end must not trigger final readback");
  assert.equal(
    session.messages.find((message) => message.role === "assistant")?.status,
    "running"
  );

  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await waitFor(() => projectionReads === 1);
  assert.equal(turnResolved, false, "agent_settled must only enter finalizing");
  assert.equal(
    session.messages.find((message) => message.role === "assistant")?.status,
    "running",
    "agent_settled readback must not fabricate a terminal UI state"
  );

  await emit(listener, runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }));
  runResult.resolve({
    productRunId: "product-run-turn-runner",
    conversationId: session.id,
    piSessionId: session.piSessionId!,
    userEntryId: "entry-user",
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "completed",
    activeLeafId: "entry-assistant",
    agentSettledAt: 7,
    settledAt: 8,
    createdAt: 2,
    updatedAt: 8
  });

  assert.equal(await turn, "completed");
  assert.equal(projectionReads, 2, "formal settlement must perform final durable readback");
  assert.equal(session.messages.at(-1)?.status, "completed");
  assert.equal(session.messages.at(-1)?.askSourceAttribution, true);
  assert.deepEqual(session.messages.at(-1)?.personalMemorySources, [
    { id: "memory-turn-runner", title: "Turn runner Memory" }
  ]);
  assert.equal(composerCleared, true, "durable user entry must clear the submitted draft");
  assert.equal(releasedRunId, "product-run-turn-runner");
  assert.equal(
    renderedAssistantStatuses.slice(0, -1).includes("completed"),
    true,
    "the formal ProductRun event must be the first event allowed to render terminal status"
  );
}

function runtimeEvent(
  patch: RuntimeEventPatch
): PiChatRuntimeEvent {
  return {
    productRunId: "product-run-turn-runner",
    conversationId: "conversation-turn-runner",
    piSessionId: "pi-session-turn-runner",
    activeLeafId: "entry-assistant",
    occurredAt: 6,
    ...patch
  } as PiChatRuntimeEvent;
}

interface RuntimeEventBase {
  productRunId: string;
  conversationId: string;
  piSessionId: string;
  activeLeafId: string | null;
  occurredAt: number;
}

type RuntimeEventPatch = PiChatRuntimeEvent extends infer Event
  ? Event extends RuntimeEventBase
    ? Omit<Event, keyof RuntimeEventBase>
    : never
  : never;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function durableProjection(
  session: Readonly<StoredSession>,
  assistantStatus: "running" | "completed"
): PiConversationProjection {
  return {
    catalog: {
      conversationId: session.id,
      piSessionId: session.piSessionId!,
      vaultId: "vault-turn-runner",
      title: session.title,
      status: "active",
      defaultMemoryMode: "normal",
      createdAt: 1,
      updatedAt: assistantStatus === "completed" ? 8 : 7,
      sessionFile: "/sessions/pi-session-turn-runner.jsonl"
    },
    activeLeafId: "entry-assistant",
    messages: [
      {
        id: "entry-user",
        role: "user",
        itemType: "user",
        text: "hello",
        status: "completed",
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        createdAt: 2,
        completedAt: 2
      },
      {
        id: "entry-assistant",
        role: "assistant",
        itemType: "assistant",
        text: assistantStatus === "completed" ? "done" : "streaming",
        status: assistantStatus,
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        createdAt: 3,
        ...(assistantStatus === "completed"
          ? {
              completedAt: 8,
              askSourceAttribution: true as const,
              personalMemorySources: [
                { id: "memory-turn-runner", title: "Turn runner Memory" }
              ]
            }
          : {})
      }
    ],
    diagnostics: [],
    drafts: []
  };
}

async function emit(
  listener: PiChatRuntimeEventListener | null,
  event: PiChatRuntimeEvent
): Promise<void> {
  assert.ok(listener, "Pi turn runner must subscribe before events are emitted");
  await listener(event);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Pi turn runner state");
}

if (process.env.ECHOINK_RUN_PI_TURN_RUNNER_TESTS === "1") {
  void runPiNativeTurnRunnerTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
