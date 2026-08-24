import { Notice } from "obsidian";
import type {
  PiChatPreparedImage,
  PiChatRuntimeEvent,
  PiConversationMemoryMode,
  PiConversationProjection,
  PiProductRunRecord,
  PiProductRunTerminalState,
  PiTaskPlanTransitionRequest
} from "../../harness/pi-native/contracts";
import { PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE } from "../../harness/pi-native/contracts";
import {
  PiChatUiProjector,
  piEntryIdFromProjectedMessageId,
  piProjectedEntryMessageId,
  type PiChatUiRunState,
  type PiChatUiViewModel
} from "../../harness/pi-native/pi-chat-ui-projector";
import type {
  ChatMessage,
  StoredAttachment,
  StoredSession
} from "../../settings/settings";
import { newId } from "../../settings/settings";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { enabledSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { CodexViewTurnContext, MessageRenderFollowContext, QueuedTurnOutcome, QueuedTurnSource } from "./runner-context";
import {
  projectPiImageAttachments,
  recordPiImageAttachmentsForEntry,
  rememberPiConversationProjection,
  selectedPiConversationDraftId
} from "./pi-conversation-support";
import { routeKnowledgeConversationCommand } from "../../knowledge-base/commands";
import { preparePiChatImages } from "./pi-image-input";

const activeComposerTransfers = new WeakMap<
  CodexViewTurnContext,
  Readonly<QueuedTurnItem>
>();

export async function sendMessage(view: CodexViewTurnContext): Promise<void> {
  const session = view.ensureSession();
  const action = composerPrimaryActionForState(view.composerStateForSession(session));
  if (
    view.turnQueue.isSessionRecoveryRequired(session.id)
    && action !== "stop-turn"
    && action !== "cancel-knowledge-task"
  ) {
    new Notice("本地生命周期记录待恢复，暂不能开始新任务。");
    return;
  }
  if (action === "enqueue") {
    await view.enqueueComposerDraft();
    return;
  }
  if (action === "resume-queue") {
    await view.resumeQueuedTurns(session.id);
    return;
  }
  if (action === "stop-turn") {
    await view.stopTurn();
    return;
  }
  if (action === "cancel-knowledge-task") {
    new Notice("旧知识库 Agent 运行时已退场；请在普通 EchoInk 会话中使用 /maintain。");
    return;
  }
  const item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: true });
  if (!item) return;
  const outcome = await view.startQueuedTurnItemSafely(item, "composer");
  if (outcome !== "running") {
    await view.afterTurnSettled(item.sessionId, outcome === "completed");
  }
}

export function piChatMemoryModeForGlobalSetting(
  useLongTermMemory: boolean
): PiConversationMemoryMode {
  return useLongTermMemory ? "normal" : "no_memory";
}

export async function enqueueComposerDraft(view: CodexViewTurnContext): Promise<void> {
  const item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: false });
  if (!item) return;
  const session = view.sessionById(item.sessionId);
  if (isActivePiChatRun(view, session)) {
    if (
      routeKnowledgeConversationCommand(item.text.trim()).kind === "maintain"
      && item.attachments.length
    ) {
      new Notice("运行中的 Pi Follow-up 只支持文字；附件或 Skill 请留到下一轮发送。");
      return;
    }
    if (item.attachments.some((attachment) => attachment.type !== "image")) {
      new Notice("普通 Pi Chat 只支持图片附件；其他文件请移除后再发送。");
      return;
    }
    if (item.attachments.length) {
      if (hasMatchingQueuedComposerTransfer(view, item)) {
        new Notice("这条图片消息已在队列中，等待当前 Pi 任务结束后发送");
        return;
      }
      item.clearComposerAfterPiAcceptance = true;
      view.turnQueue.enqueue(item);
      view.renderQueue();
      view.renderToolbar();
      new Notice("图片消息已加入队列，将在当前 Pi 任务结束后发送");
      return;
    }
    if (!item.text.trim() || item.skill) {
      new Notice("运行中的 Pi Follow-up 只支持文字；附件或 Skill 请留到下一轮发送。");
      return;
    }
    try {
      await view.plugin.followUpPiConversation(session.id, item.text.trim());
      view.clearComposerDraft();
      view.renderQueue();
      view.renderToolbar();
      new Notice("已加入当前 Pi 任务的后续消息");
    } catch (error) {
      new Notice(`加入 Pi Follow-up 失败：${normalizePiChatError(error).message}`);
    }
    return;
  }
  view.turnQueue.enqueue(item);
  view.clearComposerDraft();
  view.renderQueue();
  view.renderToolbar();
  new Notice("已加入队列");
  if (
    !view.running
    && !view.turnQueue.isSessionQueuePaused(item.sessionId)
    && !view.turnQueue.isSessionRecoveryRequired(item.sessionId)
  ) {
    void view.startNextQueuedTurn(item.sessionId);
  }
}

export async function steerPiChatFromComposer(
  view: CodexViewTurnContext
): Promise<void> {
  const session = view.ensureSession();
  if (!isActivePiChatRun(view, session)) {
    new Notice("当前没有可调整方向的 Pi Chat 任务。");
    return;
  }
  const text = view.inputEl.value.trim();
  if (!text) return;
  if (view.attachments.length || view.selectedSkill) {
    new Notice("调整方向只支持文字；附件或 Skill 请留到下一轮发送。");
    return;
  }
  try {
    await view.plugin.steerPiConversation(session.id, text);
    view.clearComposerDraft();
    view.renderQueue();
    view.renderToolbar();
    new Notice("已调整当前 Pi 任务方向");
  } catch (error) {
    new Notice(`调整 Pi 任务方向失败：${normalizePiChatError(error).message}`);
  }
}

export async function handlePiTaskPlanAction(
  view: CodexViewTurnContext,
  planId: string,
  action: PiTaskPlanTransitionRequest["action"]
): Promise<void> {
  const session = view.ensureSession();
  if (
    session.bodyAuthority !== "pi_session_only"
  ) {
    new Notice("任务计划只属于当前 Pi Conversation。");
    return;
  }
  if (view.running && action !== "pause") {
    new Notice("当前计划正在执行，请先暂停。");
    return;
  }
  try {
    await view.plugin.transitionPiTaskPlan({
      conversationId: session.id,
      planId,
      action
    });
    const projection = await view.plugin.readPiConversationProjection(
      session.id
    );
    rememberPiConversationProjection(view.plugin, projection);
    applyPiConversationProjection(session, projection);
    view.renderMessagesIfActive(session);

    if (action === "pause") {
      new Notice("任务计划已暂停");
      return;
    }
    if (action === "cancel") {
      new Notice("任务计划已取消");
      return;
    }

    const item: QueuedTurnItem = {
      id: newId("queued-turn"),
      sessionId: session.id,
      text: action === "execute"
        ? `执行任务计划 ${planId}，从当前步骤开始，并用 task_update 持续写入结构化状态。`
        : `继续执行任务计划 ${planId}，从暂停的当前步骤继续，并用 task_update 持续写入结构化状态。`,
      attachments: [],
      skill: null,
      turnOptions: {
        ...view.currentTurnOptions(session),
        mode: "agent"
      },
      kind: "chat",
      createdAt: Date.now()
    };
    const outcome = await view.startQueuedTurnItemSafely(item, "queue");
    if (outcome === "failed" || outcome === "cancelled") {
      let latest = await view.plugin.readPiConversationProjection(session.id);
      const activePlan = latest.messages.find(
        (message) => message.taskPlan?.planId === planId
      )?.taskPlan;
      if (activePlan?.status === "in_progress") {
        await view.plugin.transitionPiTaskPlan({
          conversationId: session.id,
          planId,
          action: "pause"
        });
        latest = await view.plugin.readPiConversationProjection(session.id);
      }
      rememberPiConversationProjection(view.plugin, latest);
      applyPiConversationProjection(session, latest);
      view.renderMessagesIfActive(session);
    }
    if (outcome !== "running") {
      await view.afterTurnSettled(session.id, outcome === "completed");
    }
  } catch (error) {
    new Notice(
      `任务计划操作失败：${normalizePiChatError(error).message}`
    );
  }
}

export async function resumeQueuedTurns(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  if (view.turnQueue.isSessionRecoveryRequired(sessionId)) {
    new Notice("本地生命周期记录待恢复，队列暂不能继续。");
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.turnQueue.resumeSessionQueue(sessionId);
  view.renderQueue();
  view.renderToolbar();
  await view.startNextQueuedTurn(sessionId);
}

export async function afterTurnSettled(view: CodexViewTurnContext, sessionId: string, succeeded: boolean): Promise<void> {
  const settlement = view.turnQueue.settleSessionQueue(sessionId, succeeded);
  if (settlement === "continue") {
    await view.startNextQueuedTurn(sessionId);
  }
  view.renderQueue();
  view.renderToolbar();
}

export function messageRenderOptionsForRunUpdate(view: MessageRenderFollowContext): { forceBottom: boolean; preserveScroll: boolean } {
  const forceBottom = !view.messagesBottomFollowPaused;
  return { forceBottom, preserveScroll: !forceBottom };
}

export function selectFirstNonBlankText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

export async function startNextQueuedTurn(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  if (!canStartQueuedTurn({
    queueStartInProgress: view.queueStartInProgress,
    viewRunning: view.running,
    knowledgeTaskRunning: false
  })) return;
  const item = view.turnQueue.dequeueNext(sessionId);
  if (!item) {
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.queueStartInProgress = true;
  view.renderQueue();
  view.renderToolbar();
  let outcome: QueuedTurnOutcome = "failed";
  if (item.clearComposerAfterPiAcceptance === true) {
    activeComposerTransfers.set(view, item);
  }
  try {
    outcome = await view.startQueuedTurnItemSafely(item, "queue");
  } finally {
    if (activeComposerTransfers.get(view)?.id === item.id) {
      activeComposerTransfers.delete(view);
    }
    view.queueStartInProgress = false;
  }
  if (outcome === "failed" && item.piUserEntryAccepted !== true) {
    view.turnQueue.enqueueFront(item);
  }
  if (outcome !== "running") {
    await view.afterTurnSettled(item.sessionId, outcome === "completed");
  }
}

export async function createQueuedTurnFromComposer(view: CodexViewTurnContext, options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
  let session = view.ensureSession();
  const text = view.inputEl.value.trim();
  const attachments = view.attachments.map((attachment) => ({ ...attachment }));
  const skill = view.selectedSkill ? { ...view.selectedSkill } : null;
  if (!text && !attachments.length && !skill) return null;
  const workspaceReady = await view.ensureChatWorkspaceSelected(session);
  if (!workspaceReady) return null;
  session = view.ensureSession();
  const piDraftId = session.bodyAuthority === "pi_session_only"
    ? selectedPiConversationDraftId(view.plugin, session.id)
    : undefined;
  return {
    id: newId("queued-turn"),
    sessionId: session.id,
    text,
    attachments,
    skill,
    turnOptions: view.currentTurnOptions(session),
    kind: "chat",
    createdAt: Date.now(),
    ...(piDraftId ? { piDraftId } : {})
  };
}

export async function startQueuedTurnItem(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const session = view.sessionById(item.sessionId);
  if (!session) {
    new Notice("队列所属会话已不存在");
    return "failed";
  }
  return await view.startChatTurn(session, item, source);
}

export async function startQueuedTurnItemSafely(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  try {
    return await view.startQueuedTurnItem(item, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`任务收口失败：${message}`);
    return "failed";
  }
}

export async function startChatTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const submittedText = item.text.trim();
  const knowledgeCommand = routeKnowledgeConversationCommand(submittedText);
  let maintenanceScope: Awaited<
    ReturnType<CodexViewTurnContext["plugin"]["prepareEchoInkKnowledgeMaintenanceScope"]>
  > | undefined;
  let preparedImages: Awaited<ReturnType<typeof preparePiChatImages>> = [];
  if (knowledgeCommand.kind === "maintain") {
    if (item.turnOptions.mode === "plan") {
      new Notice("/maintain 只在 Agent 模式执行；请先退出 Plan 模式。");
      return "failed";
    }
    try {
      maintenanceScope = await view.plugin.prepareEchoInkKnowledgeMaintenanceScope({
        request: knowledgeCommand.request,
        attachmentPaths: item.attachments.map((attachment) => attachment.path)
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  } else if (item.attachments.length) {
    try {
      preparedImages = await preparePiChatImages(item.attachments);
    } catch (error) {
      new Notice(normalizePiChatError(error).message);
      return "failed";
    }
  }
  let currentSkill: EchoInkResource | null = null;
  if (item.skill) {
    try {
      currentSkill = enabledSkillResources(
        await view.plugin.buildRuntimeEchoInkResourceCatalog()
      ).find((skill) => skill.id === item.skill?.id) ?? null;
    } catch {
      new Notice("无法确认所选 Vault Skill 的当前启用状态，本轮没有发送。");
      return "failed";
    }
    if (!currentSkill) {
      new Notice("所选 Vault Skill 已禁用或不存在，本轮没有发送。");
      return "failed";
    }
  }
  const skillPath = currentSkill?.contentPath?.trim();
  const skillName = currentSkill?.name.trim();
  if (currentSkill && (!skillPath || !skillName)) {
    new Notice("所选 Vault Skill 缺少可加载的 contentPath 或名称，本轮没有发送。");
    return "failed";
  }
  if (!submittedText && !preparedImages.length) return "failed";
  const projector = new PiChatUiProjector();
  let handle: Awaited<
    ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>
  > | null = null;
  let subscription: ReturnType<
    CodexViewTurnContext["plugin"]["subscribePiRun"]
  > | null = null;
  let approvalSubscription: ReturnType<
    CodexViewTurnContext["plugin"]["subscribePiAgentApproval"]
  > | null = null;
  let approvalProjectionFlight: Promise<void> = Promise.resolve();
  let approvalProjectionRefreshFailed = false;
  let liveProjection: PiChatUiViewModel | null = null;
  let agentSettledObserved = false;
  let terminalObserved = false;
  let finalizingProjectionError: unknown = null;
  let finalizingProjectionFlight: Promise<void> = Promise.resolve();

  view.running = true;
  view.activeRunKind = "chat";
  view.activeRunSessionId = session.id;
  view.turnStartedAt = Date.now();
  view.renderTabs();
  view.renderToolbar();
  view.applyStatus();
  try {
    const submittedAt = Date.now();
    handle = await view.plugin.submitPiChat({
      conversationId: session.id,
      text: submittedText,
      submittedAt,
      mode: item.turnOptions.mode === "plan" ? "plan" : "agent",
      memoryMode: piChatMemoryModeForGlobalSetting(
        view.plugin.settings?.memory?.useLongTermMemory !== false
      ),
      ...(skillPath && skillName ? { skillPath, skillName } : {}),
      ...(item.piDraftId ? { draftId: item.piDraftId } : {}),
      ...(maintenanceScope ? { maintenanceScope } : {}),
      ...(preparedImages.length ? { images: preparedImages } : {})
    });
    item.piUserEntryAccepted = true;
    if (preparedImages.length) {
      recordPiImageAttachmentsForEntry(
        session,
        handle.userEntryId,
        preparedImages
      );
      await view.plugin.persistPiNativeSettings().catch(() => {
        new Notice("图片已发送，但本地缩略图信息保存失败；重启后可能无法打开原图。");
      });
    }
    view.activeRunId = handle.productRunId;
    view.activeRunKind = "chat";
    view.activeRunSessionId = session.id;
    view.activeTurnId = handle.productRunId;
    liveProjection = piChatLiveProjectionFromSession(
      session,
      handle,
      submittedText,
      preparedImages,
      submittedAt
    );
    applyPiChatLiveProjection(session, liveProjection);
    approvalSubscription = view.plugin.subscribePiAgentApproval({
      conversationId: handle.conversationId,
      piSessionId: handle.piSessionId,
      productRunId: handle.productRunId
    }, () => {
      // The live broker can become ready just after Tool start. Re-render once
      // immediately for the pending fallback, then project the durable Ticket.
      view.renderMessagesIfActive(session);
      approvalProjectionFlight = approvalProjectionFlight
        .then(async () => {
          if (!handle || terminalObserved) return;
          const projection = await view.plugin.readPiConversationProjection(
            handle.conversationId
          );
          if (terminalObserved) return;
          rememberPiConversationProjection(view.plugin, projection);
          liveProjection = piChatLiveProjectionFromDurable(
            projection,
            handle,
            "running"
          );
          applyPiConversationProjection(session, projection);
          applyPiChatLiveProjection(session, liveProjection);
          view.renderMessagesIfActive(session);
          view.renderToolbar();
          view.applyStatus();
        })
        .catch(() => {
          if (approvalProjectionRefreshFailed) return;
          approvalProjectionRefreshFailed = true;
          new Notice("审批状态刷新失败，请等待当前工具状态更新。");
        });
    });
    clearComposerAfterPiAcceptance(view, item, source);
    view.renderTabs();
    view.renderMessagesIfActive(session);
    view.renderToolbar();
    view.applyStatus();
    view.armTurnWatchdog();

    type ProductRunSettledEvent = Extract<
      PiChatRuntimeEvent,
      { type: "product_run_settled" }
    >;
    let resolveTerminal!: (value: Readonly<ProductRunSettledEvent>) => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<Readonly<ProductRunSettledEvent>>(
      (resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      }
    );
    subscription = view.plugin.subscribePiRun(
      handle.productRunId,
      (event) => {
        try {
          assertPiChatRuntimeEventIdentity(event, handle!);
          liveProjection = projector.projectRuntimeEvent({
            current: liveProjection!,
            event,
            vaultPath: view.plugin.getVaultPath()
          });
          applyPiChatLiveProjection(session, liveProjection);
          view.renderMessagesIfActive(session);
          view.renderToolbar();
          view.applyStatus();

          if (event.type === "agent_settled" && !agentSettledObserved) {
            agentSettledObserved = true;
            finalizingProjectionFlight = view.plugin
              .readPiConversationProjection(session.id)
              .then((projection) => {
                if (terminalObserved) return;
                rememberPiConversationProjection(view.plugin, projection);
                liveProjection = piChatLiveProjectionFromDurable(
                  projection,
                  handle!,
                  "finalizing"
                );
                applyPiConversationProjection(session, projection);
                applyPiChatLiveProjection(session, liveProjection);
                view.renderMessagesIfActive(session);
                view.renderToolbar();
                view.applyStatus();
              })
              .catch((error: unknown) => {
                finalizingProjectionError = error;
              });
            return;
          }

          if (event.type === "product_run_settled" && !terminalObserved) {
            if (!agentSettledObserved) {
              throw new Error(
                "Pi Chat ProductRun 在 agent_settled 之前进入正式终态。"
              );
            }
            terminalObserved = true;
            resolveTerminal(event);
          }
        } catch (error) {
          rejectTerminal(normalizePiChatError(error));
        }
      }
    );

    const [settledEvent, settledRun] = await Promise.all([
      terminal,
      handle.result
    ]);
    await finalizingProjectionFlight;
    if (finalizingProjectionError) {
      throw normalizePiChatError(finalizingProjectionError);
    }
    assertPiChatSettlementIdentity(settledEvent, settledRun);
    const committedFinalProjection =
      await view.plugin.readPiConversationProjection(session.id);
    rememberPiConversationProjection(view.plugin, committedFinalProjection);
    applyPiConversationProjection(session, committedFinalProjection);
    view.renderMessagesIfActive(session);

    if (settledEvent.terminalState === "failed") {
      new Notice(settledRun.error || "EchoInk Pi Chat 执行失败。");
    }
    return queuedTurnOutcomeForPiTerminal(settledEvent.terminalState);
  } catch (error) {
    if (piUserEntryWasAccepted(error)) {
      item.piUserEntryAccepted = true;
      const acceptedEntryId = piAcceptedUserEntryId(error);
      if (preparedImages.length && acceptedEntryId) {
        recordPiImageAttachmentsForEntry(
          session,
          acceptedEntryId,
          preparedImages
        );
        await view.plugin.persistPiNativeSettings().catch(() => {
          new Notice("图片已发送，但本地缩略图信息保存失败；重启后可能无法打开原图。");
        });
      }
      clearComposerAfterPiAcceptance(view, item, source);
    }
    if (handle) {
      await view.plugin.abortPiConversation(session.id).catch(() => undefined);
      await handle.result.catch(() => undefined);
    }
    const projection = await view.plugin
      .readPiConversationProjection(session.id)
      .catch(() => null);
    if (projection) {
      rememberPiConversationProjection(view.plugin, projection);
      applyPiConversationProjection(session, projection);
      view.renderMessagesIfActive(session);
    }
    const message = normalizePiChatError(error).message;
    new Notice(
      message === PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE
        ? message
        : `EchoInk Pi Chat 发送失败：${message}`
    );
    return "failed";
  } finally {
    try {
      approvalSubscription?.unsubscribe();
    } catch {
      // The durable Ticket and Tool projection remain authoritative.
    }
    await approvalProjectionFlight.catch(() => undefined);
    try {
      subscription?.unsubscribe();
    } catch {
      // The canonical terminal/readback above remains authoritative.
    }
    if (handle) {
      view.plugin.releasePiProductionRun(handle.productRunId);
    }
    view.running = false;
    view.activeTurnId = "";
    view.clearTurnWatchdog();
    if (!handle || view.activeRunId === handle.productRunId) {
      view.clearActiveRun();
    }
    view.renderTabs();
    view.renderMessages(messageRenderOptionsForRunUpdate(view));
    view.renderToolbar();
    view.applyStatus();
  }
}

function assertPiChatRuntimeEventIdentity(
  event: Readonly<PiChatRuntimeEvent>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >
): void {
  if (
    event.productRunId !== handle.productRunId
    || event.conversationId !== handle.conversationId
    || event.piSessionId !== handle.piSessionId
  ) {
    throw new Error("Pi Chat 事件身份与当前运行不一致。");
  }
}

function assertPiChatSettlementIdentity(
  event: Readonly<Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>>,
  run: Readonly<PiProductRunRecord>
): void {
  if (
    run.productRunId !== event.productRunId
    || run.conversationId !== event.conversationId
    || run.piSessionId !== event.piSessionId
    || run.state !== "product_run_settled"
    || run.terminalState !== event.terminalState
  ) {
    throw new Error("Pi Chat ProductRun 终态与耐久回读不一致。");
  }
}

function applyPiConversationProjection(
  target: StoredSession,
  projection: Readonly<PiConversationProjection>
): void {
  target.title = projection.catalog.title;
  target.piSessionId = projection.catalog.piSessionId;
  target.defaultMemoryMode = projection.catalog.defaultMemoryMode;
  target.messages = projectPiImageAttachments(
    target,
    clonePiChatMessages(projection.messages)
  );
  if (projection.contextLedger) {
    target.contextLedger = structuredClone(projection.contextLedger);
  } else {
    delete target.contextLedger;
  }
  target.createdAt = projection.catalog.createdAt;
  target.updatedAt = projection.catalog.updatedAt;
}

function applyPiChatLiveProjection(
  session: StoredSession,
  projection: Readonly<PiChatUiViewModel>
): void {
  session.piSessionId = projection.piSessionId;
  session.messages = projectPiImageAttachments(
    session,
    clonePiChatMessages(projection.messages)
  );
}

function piChatLiveProjectionFromSession(
  session: Readonly<StoredSession>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >,
  submittedText: string,
  preparedImages: readonly Readonly<PiChatPreparedImage>[],
  submittedAt: number
): PiChatUiViewModel {
  const messages = clonePiChatMessages(session.messages);
  if (preparedImages.length) {
    const acceptedUserMessage: ChatMessage = {
      id: piProjectedEntryMessageId(
        handle.piSessionId,
        null,
        handle.userEntryId
      ),
      role: "user",
      itemType: "user",
      text: submittedText,
      images: preparedImages.map(({ attachment }) => ({ ...attachment })),
      status: "completed",
      runId: handle.productRunId,
      turnId: handle.productRunId,
      createdAt: submittedAt,
      completedAt: submittedAt
    };
    const existingIndex = messages.findIndex((message) =>
      piEntryIdFromProjectedMessageId(message.id) === handle.userEntryId
    );
    if (existingIndex >= 0) messages[existingIndex] = acceptedUserMessage;
    else messages.push(acceptedUserMessage);
  }
  return {
    piSessionId: handle.piSessionId,
    activeLeafId: null,
    productRunId: handle.productRunId,
    runState: "running",
    messages,
    diagnostics: [],
    queuedSteering: [],
    queuedFollowUp: [],
    provisionalMessageIds: [],
    pendingToolCallIds: [],
    updatedAt: Date.now()
  };
}

function piChatLiveProjectionFromDurable(
  projection: Readonly<PiConversationProjection>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >,
  runState: PiChatUiRunState
): PiChatUiViewModel {
  return {
    piSessionId: projection.catalog.piSessionId,
    activeLeafId: projection.activeLeafId,
    productRunId: handle.productRunId,
    runState,
    messages: clonePiChatMessages(projection.messages),
    diagnostics: projection.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    queuedSteering: [],
    queuedFollowUp: [],
    provisionalMessageIds: [],
    pendingToolCallIds: [],
    updatedAt: Date.now()
  };
}

function clonePiChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.approval ? { approval: { ...message.approval } } : {}),
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.images
      ? { images: message.images.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.files
      ? { files: message.files.map((file) => ({ ...file })) }
      : {}),
    ...(message.personalMemorySources
      ? {
          personalMemorySources: message.personalMemorySources.map(
            (source) => ({ ...source })
          )
        }
      : {}),
    ...(message.taskPlan
      ? {
        taskPlan: {
          ...message.taskPlan,
          steps: message.taskPlan.steps.map((step) => ({ ...step }))
        }
      }
      : {}),
    ...(message.reasoningSummary
      ? {
          reasoningSummary: {
            ...message.reasoningSummary,
            activities: message.reasoningSummary.activities.map(
              (activity) => ({ ...activity })
            )
          }
        }
      : {})
  }));
}

function queuedTurnOutcomeForPiTerminal(
  terminalState: PiProductRunTerminalState
): QueuedTurnOutcome {
  if (terminalState === "completed") return "completed";
  return terminalState === "cancelled" ? "cancelled" : "failed";
}

function normalizePiChatError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function piUserEntryWasAccepted(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { piUserEntryAccepted?: unknown }).piUserEntryAccepted === true
  );
}

function piAcceptedUserEntryId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { piUserEntryId?: unknown }).piUserEntryId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clearComposerAfterPiAcceptance(
  view: CodexViewTurnContext,
  item: Readonly<QueuedTurnItem>,
  source: QueuedTurnSource
): void {
  if (
    (source === "composer" || item.clearComposerAfterPiAcceptance === true)
    && composerStillMatchesQueuedTurn(view, item)
  ) {
    view.clearComposerDraft();
  }
}

function hasMatchingQueuedComposerTransfer(
  view: CodexViewTurnContext,
  item: Readonly<QueuedTurnItem>
): boolean {
  const active = activeComposerTransfers.get(view);
  return Boolean(
    active
    && active.sessionId === item.sessionId
    && queuedTurnDraftsMatch(active, item)
  ) || view.turnQueue.itemsForSession(item.sessionId).some((queued) =>
    queued.clearComposerAfterPiAcceptance === true
    && queuedTurnDraftsMatch(queued, item)
  );
}

function composerStillMatchesQueuedTurn(
  view: CodexViewTurnContext,
  item: Readonly<QueuedTurnItem>
): boolean {
  return view.plugin.settings.activeSessionId === item.sessionId
    && view.inputEl.value.trim() === item.text
    && attachmentListsMatch(view.attachments, item.attachments)
    && (view.selectedSkill?.id ?? null) === (item.skill?.id ?? null);
}

function queuedTurnDraftsMatch(
  left: Readonly<QueuedTurnItem>,
  right: Readonly<QueuedTurnItem>
): boolean {
  return left.text === right.text
    && attachmentListsMatch(left.attachments, right.attachments)
    && (left.skill?.id ?? null) === (right.skill?.id ?? null);
}

function attachmentListsMatch(
  left: readonly Readonly<StoredAttachment>[],
  right: readonly Readonly<StoredAttachment>[]
): boolean {
  return left.length === right.length
    && left.every((attachment, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && attachment.type === candidate.type
        && attachment.name === candidate.name
        && attachment.path === candidate.path
        && attachment.mimeType === candidate.mimeType;
    });
}

function isActivePiChatRun(
  view: Pick<
    CodexViewTurnContext,
    "running" | "activeRunKind" | "activeRunSessionId"
  >,
  session: StoredSession | null
): session is StoredSession {
  return Boolean(
    session
    && session.bodyAuthority === "pi_session_only"
    && view.running
    && view.activeRunKind === "chat"
    && view.activeRunSessionId === session.id
  );
}

export async function runKnowledgeBaseShortcut(view: CodexViewTurnContext, label: string, runner: () => Promise<string>): Promise<void> {
  const active = view.ensureSession();
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: label,
    createdAt: Date.now()
  };
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    title: "知识库管理",
    itemType: "knowledgeBase",
    status: "running",
    text: "正在执行...",
    createdAt: Date.now()
  };
  await withConversationMutation(view, active.id, async () => {
    active.messages.push(userMessage, assistantMessage);
    active.updatedAt = Date.now();
    view.running = true;
    view.renderTabs();
    view.renderMessages({ forceBottom: true });
    view.renderToolbar();
    await view.plugin.saveSettings(true);
  });
  let terminalStatus = "completed";
  let terminalText = "";
  try {
    terminalText = await runner();
    new Notice(label);
  } catch (error) {
    terminalStatus = "failed";
    terminalText = error instanceof Error ? error.message : String(error);
    new Notice(`知识库管理失败：${terminalText}`);
  } finally {
    await withConversationMutation(view, active.id, async () => {
      assistantMessage.status = terminalStatus;
      assistantMessage.text = terminalText;
      active.updatedAt = Date.now();
      try {
        await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
        await view.plugin.saveSettings(true);
      } finally {
        view.running = false;
      }
    });
    view.renderMessages(messageRenderOptionsForRunUpdate(view));
    view.renderToolbar();
    view.applyStatus();
  }
}

async function withConversationMutation<T>(
  view: CodexViewTurnContext,
  conversationId: string,
  action: () => Promise<T>
): Promise<T> {
  return await view.plugin.withEchoInkConversationMutation(
    conversationId,
    action
  );
}
