import { Notice } from "obsidian";
import type {
  PiChatPreparedImage,
  PiChatPreparedDocument,
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
  ApiProviderConfig,
  ApiProviderModelConfig,
  ChatMessage,
  StoredAttachment,
  StoredSession
} from "../../settings/settings";
import {
  activateApiProviderModel,
  apiProviderModelSupportsImage,
  apiProviderHasUsableCredential,
  getApiProviderModel,
  newId,
  validateApiProvider
} from "../../settings/settings";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { enabledSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { CodexViewTurnContext, MessageRenderFollowContext, QueuedTurnOutcome, QueuedTurnSource } from "./runner-context";
import {
  projectPiImageAttachments,
  recordPiDocumentReplayForEntry,
  recordPiImageAttachmentsForEntry,
  rememberPiConversationProjection,
  selectedPiConversationDraftId
} from "./pi-conversation-support";
import { routeKnowledgeConversationCommand } from "../../knowledge-base/commands";
import { preparePiChatImages } from "./pi-image-input";
import {
  PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER,
  type PiDocumentCapabilityTarget
} from "../../harness/pi-native/pi-document-context";
import {
  buildPiDocumentContext,
  preparePiChatDocuments,
  reconcilePiDocumentTransports,
  type PiChatPreparedDocumentSet
} from "./pi-document-input";
import {
  calculatePiEffectiveInputBudget,
  estimatePiContextTokens
} from "../../harness/pi-native/pi-context-budget";
import {
  cloneEchoInkAssistantTurn
} from "../../types/conversation-turn";
import {
  isEchoInkPiReasoningEffortSupported,
  resolveEchoInkPiReasoningCapabilities
} from "../../settings/pi-model-catalog";
import type { TurnOptions } from "../turn-options";
import {
  composerNoteMentionSelections,
  snapshotComposerNoteMentions
} from "./note-mentions";

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
    if (item.noteMentions?.length) {
      if (hasMatchingQueuedComposerTransfer(view, item)) {
        new Notice("这条笔记提及消息已在队列中，等待当前 Pi 任务结束后发送");
        return;
      }
      item.clearComposerAfterPiAcceptance = true;
      view.turnQueue.enqueue(item);
      view.renderQueue();
      view.renderToolbar();
      new Notice("含笔记提及的消息已加入队列，将在当前 Pi 任务结束后发送");
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
      new Notice("附件消息已加入队列，将在当前 Pi 任务结束后发送");
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
  if (
    view.attachments.length
    || composerNoteMentionSelections(view.inputEl).length
    || view.selectedSkill
  ) {
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
  const item = view.turnQueue.peekNext(sessionId);
  if (!item) {
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.queueStartInProgress = true;
  view.renderQueue();
  view.renderToolbar();
  let outcome: QueuedTurnOutcome = "failed";
  let headChangedDuringActivation = false;
  if (item.clearComposerAfterPiAcceptance === true) {
    activeComposerTransfers.set(view, item);
  }
  try {
    if (!await prepareTurnProviderModel(view, item, true)) {
      view.turnQueue.pauseSessionQueue(sessionId);
      return;
    }
    const current = view.turnQueue.peekNext(sessionId);
    if (!current || current.id !== item.id) {
      headChangedDuringActivation = true;
    } else {
      outcome = await startPreparedQueuedTurnItemSafely(view, item, "queue");
    }
  } finally {
    if (activeComposerTransfers.get(view)?.id === item.id) {
      activeComposerTransfers.delete(view);
    }
    view.queueStartInProgress = false;
    view.renderQueue();
    view.renderToolbar();
  }
  if (headChangedDuringActivation) {
    if (
      view.turnQueue.hasQueuedItems(sessionId)
      && !view.turnQueue.isSessionQueuePaused(sessionId)
    ) await view.startNextQueuedTurn(sessionId);
    return;
  }
  if (outcome !== "running") {
    const retainedBeforePiAcceptance = view.turnQueue
      .itemsForSession(item.sessionId)
      .some((candidate) => candidate.id === item.id);
    await view.afterTurnSettled(item.sessionId, outcome === "completed");
    if (retainedBeforePiAcceptance && outcome !== "completed") {
      new Notice(
        "队列任务在 Pi 接收前失败；队首仅保留一份且队列已暂停，请处理错误后手动继续。"
      );
    }
  }
}

export async function createQueuedTurnFromComposer(view: CodexViewTurnContext, options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
  let session = view.ensureSession();
  const text = view.inputEl.value.trim();
  const attachments = view.attachments.map((attachment) => ({ ...attachment }));
  const skill = view.selectedSkill ? { ...view.selectedSkill } : null;
  const selectedNoteMentions = composerNoteMentionSelections(view.inputEl);
  if (!text && !attachments.length && !selectedNoteMentions.length && !skill) return null;
  const workspaceReady = await view.ensureChatWorkspaceSelected(session);
  if (!workspaceReady) return null;
  session = view.ensureSession();
  let noteMentions: Awaited<ReturnType<typeof snapshotComposerNoteMentions>>;
  try {
    noteMentions = await snapshotComposerNoteMentions(view.app, view.inputEl);
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
    return null;
  }
  const piDraftId = session.bodyAuthority === "pi_session_only"
    ? selectedPiConversationDraftId(view.plugin, session.id)
    : undefined;
  const turnOptions = view.currentTurnOptions(session);
  if (!frozenTurnReasoningSelectionIsValid(
    view.plugin.settings,
    turnOptions
  )) {
    new Notice(
      "当前 Provider、模型或思考强度已失效，本轮没有入队；请重新选择后发送。"
    );
    return null;
  }
  let preparedDocuments: readonly Readonly<PiChatPreparedDocument>[] = Object.freeze([]);
  const documentAttachments = attachments.filter(
    (attachment) => attachment.type === "file"
  );
  const submittedText = text
    || (noteMentions.length
      ? "请结合我提及的笔记继续。"
      : documentAttachments.length
        ? "请阅读我附加的文档，并根据文档内容回应。"
        : "");
  if (
    documentAttachments.length
    && routeKnowledgeConversationCommand(submittedText).kind !== "maintain"
  ) {
    const provider = view.plugin.settings.apiProviders.find(
      (candidate) => candidate.id === turnOptions.providerSettingsId
    );
    if (!provider) {
      new Notice("当前 Provider 已不可用，本轮文档没有入队；请重新选择后发送。");
      return null;
    }
    try {
      const prepared = await preparePiChatDocuments(documentAttachments, {
        availableInputTokens: availableDocumentInputTokens(
          view,
          session,
          { turnOptions, noteMentions },
          submittedText
        ),
        capabilityTarget: piDocumentCapabilityTarget(provider, turnOptions.model)
      });
      preparedDocuments = prepared.documents;
    } catch (error) {
      new Notice(normalizePiChatError(error).message);
      return null;
    }
  }
  return {
    id: newId("queued-turn"),
    sessionId: session.id,
    text,
    attachments,
    ...(preparedDocuments.length ? { preparedDocuments } : {}),
    noteMentions,
    skill,
    turnOptions,
    kind: "chat",
    createdAt: Date.now(),
    ...(piDraftId ? { piDraftId } : {})
  };
}

export async function startQueuedTurnItem(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  if (!await prepareTurnProviderModel(view, item, false)) return "failed";
  return await startPreparedQueuedTurnItem(view, item, source);
}

async function startPreparedQueuedTurnItem(
  view: CodexViewTurnContext,
  item: QueuedTurnItem,
  source: QueuedTurnSource
): Promise<QueuedTurnOutcome> {
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

async function startPreparedQueuedTurnItemSafely(
  view: CodexViewTurnContext,
  item: QueuedTurnItem,
  source: QueuedTurnSource
): Promise<QueuedTurnOutcome> {
  try {
    return await startPreparedQueuedTurnItem(view, item, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`任务收口失败：${message}`);
    return "failed";
  }
}

async function prepareTurnProviderModel(
  view: CodexViewTurnContext,
  item: Pick<QueuedTurnItem, "turnOptions" | "text" | "attachments">,
  retainQueueHead: boolean
): Promise<boolean> {
  const selection = item.turnOptions;
  const settings = view.plugin.settings;
  const target = settings.apiProviders.find(
    (provider) => provider.id === selection.providerSettingsId
  );
  const targetModel = target && getApiProviderModel(target, selection.model);
  if (
    !target
    || !targetModel
    || !apiProviderHasUsableCredential(target, settings.openAICodexCredential)
    || validateApiProvider(target).length > 0
  ) {
    new Notice(retainQueueHead
      ? "队列所选 Provider 或模型已不可用；队首已保留并暂停，请检查 Provider 设置后继续。"
      : "所选 Provider 或模型已不可用，请检查 Provider 设置后重试。");
    return false;
  }
  if (!frozenTurnReasoningSelectionIsValid(settings, selection)) {
    new Notice(retainQueueHead
      ? "队列冻结的 Provider、模型或思考强度已与当前 Pi 能力不一致；队首已保留并暂停，请删除后重新发送。"
      : "当前思考强度已不可用，请重新选择后重试。");
    return false;
  }
  if (
    item.attachments.some((attachment) => attachment.type === "image")
    && routeKnowledgeConversationCommand(item.text.trim()).kind !== "maintain"
    && !apiProviderModelSupportsImage(targetModel)
  ) {
    new Notice(PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
    return false;
  }
  if (
    settings.providerMode === "custom-api"
    && settings.activeApiProviderId === selection.providerSettingsId
    && settings.defaultModel === selection.model
  ) {
    view.selectedProviderSettingsId = selection.providerSettingsId;
    view.selectedModel = selection.model;
    return true;
  }
  try {
    await view.plugin.activateApiProviderSettings((candidateSettings) => {
      const candidate = candidateSettings.apiProviders.find(
        (provider) => provider.id === selection.providerSettingsId
      );
      if (
        !candidate
        || !apiProviderHasUsableCredential(
          candidate,
          candidateSettings.openAICodexCredential
        )
      ) {
        throw new Error("Provider authentication unavailable");
      }
      activateApiProviderModel(candidateSettings, candidate, selection.model);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    new Notice(retainQueueHead
      ? `切换队列 Provider/模型失败；队首已保留并暂停：${detail}`
      : `切换 Provider/模型失败：${detail}`);
    return false;
  }
  view.selectedProviderSettingsId = selection.providerSettingsId;
  view.selectedModel = selection.model;
  view.renderToolbar();
  return true;
}

export async function startChatTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const submittedText = item.text.trim()
    || (item.noteMentions?.length
      ? "请结合我提及的笔记继续。"
      : item.attachments.some((attachment) => attachment.type === "file")
        ? "请阅读我附加的文档，并根据文档内容回应。"
        : "");
  const knowledgeCommand = routeKnowledgeConversationCommand(submittedText);
  let maintenanceScope: Awaited<
    ReturnType<CodexViewTurnContext["plugin"]["prepareEchoInkKnowledgeMaintenanceScope"]>
  > | undefined;
  let preparedImages: Awaited<ReturnType<typeof preparePiChatImages>> = [];
  let preparedDocumentSet: Readonly<PiChatPreparedDocumentSet> = Object.freeze({
    documents: Object.freeze((item.preparedDocuments ?? []).map((document) => Object.freeze({
      ...document,
      bytes: new Uint8Array(document.bytes),
      attachment: Object.freeze({ ...document.attachment })
    }))),
    contextText: "",
    estimatedInputTokens: 0,
    totalBytes: (item.preparedDocuments ?? []).reduce(
      (sum, document) => sum + document.attachment.sizeBytes,
      0
    )
  });
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
      const imageAttachments = item.attachments.filter(
        (attachment) => attachment.type === "image"
      );
      const documentAttachments = item.attachments.filter(
        (attachment) => attachment.type === "file"
      );
      preparedImages = await preparePiChatImages(imageAttachments);
      if (documentAttachments.length) {
        if (
          preparedDocumentSet.documents.length !== documentAttachments.length
          || !preparedDocumentsMatchAttachments(
            preparedDocumentSet.documents,
            documentAttachments
          )
        ) {
          throw new Error(
            "文档冻结快照缺失或与附件不一致；为避免读取后来变化的磁盘内容，请保留草稿并重新发送。"
          );
        }
        const provider = view.plugin.settings.apiProviders.find(
          (candidate) => candidate.id === item.turnOptions.providerSettingsId
        );
        if (!provider) {
          throw new Error(
            "入队后 Provider 已不可用；冻结快照仍保留，请恢复原 Provider 配置或重新发送。"
          );
        }
        const reconciledDocuments = reconcilePiDocumentTransports(
          preparedDocumentSet.documents,
          piDocumentCapabilityTarget(provider, item.turnOptions.model)
        );
        const contextText = buildPiDocumentContext(reconciledDocuments);
        const estimatedInputTokens = estimatePiContextTokens(contextText).tokens;
        const availableInputTokens = availableDocumentInputTokens(
          view,
          session,
          item,
          submittedText
        );
        if (estimatedInputTokens > availableInputTokens) {
          throw new Error(
            `文档冻结文本预计需要 ${estimatedInputTokens} tokens，超过当前模型剩余的 ${availableInputTokens} tokens；请减少文档、新开会话或切换容量更大的模型。`
          );
        }
        preparedDocumentSet = Object.freeze({
          documents: reconciledDocuments,
          contextText,
          estimatedInputTokens,
          totalBytes: reconciledDocuments.reduce(
            (sum, document) => sum + document.attachment.sizeBytes,
            0
          )
        });
      }
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
  if (
    !submittedText
    && !preparedImages.length
    && !preparedDocumentSet.documents.length
  ) return "failed";
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
      runtimeProviderId: item.turnOptions.runtimeProviderId,
      modelId: item.turnOptions.model,
      reasoning: item.turnOptions.reasoning,
      memoryMode: piChatMemoryModeForGlobalSetting(
        view.plugin.settings?.memory?.useLongTermMemory !== false
      ),
      ...(skillPath && skillName ? { skillPath, skillName } : {}),
      ...(item.piDraftId ? { draftId: item.piDraftId } : {}),
      ...(maintenanceScope ? { maintenanceScope } : {}),
      ...(preparedImages.length ? { images: preparedImages } : {}),
      ...(preparedDocumentSet.documents.length
        ? { documents: preparedDocumentSet.documents }
        : {}),
      ...(item.noteMentions?.length ? { noteMentions: item.noteMentions } : {})
    });
    item.piUserEntryAccepted = true;
    if (preparedImages.length) {
      recordPiImageAttachmentsForEntry(
        session,
        handle.userEntryId,
        preparedImages
      );
    }
    if (preparedDocumentSet.documents.length) {
      recordPiDocumentReplayForEntry(
        session,
        handle.userEntryId,
        preparedDocumentSet.documents
      );
    }
    if (preparedImages.length || preparedDocumentSet.documents.length) {
      await view.plugin.persistPiNativeSettings().catch(() => {
        new Notice("附件已发送，但本地重放信息保存失败；重启后可能无法恢复附件。");
      });
    }
    if (source === "queue") {
      view.turnQueue.acceptPiUserEntry(session.id, item.id);
      view.renderQueue();
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
      preparedDocumentSet.documents,
      item.noteMentions ?? [],
      submittedAt
    );
    applyPiChatLiveProjection(view, session, liveProjection);
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
          applyPiChatLiveProjection(view, session, liveProjection);
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
          applyPiChatLiveProjection(view, session, liveProjection);
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
                applyPiChatLiveProjection(view, session, liveProjection);
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
      if (acceptedEntryId) {
        if (preparedImages.length) {
          recordPiImageAttachmentsForEntry(
            session,
            acceptedEntryId,
            preparedImages
          );
        }
        if (preparedDocumentSet.documents.length) {
          recordPiDocumentReplayForEntry(
            session,
            acceptedEntryId,
            preparedDocumentSet.documents
          );
        }
      }
      if (
        acceptedEntryId
        && (preparedImages.length || preparedDocumentSet.documents.length)
      ) {
        await view.plugin.persistPiNativeSettings().catch(() => {
          new Notice("附件已发送，但本地重放信息保存失败；重启后可能无法恢复附件。");
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
      view.setPendingInteraction(session.id, null, handle.productRunId);
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

function frozenTurnReasoningSelectionIsValid(
  settings: CodexViewTurnContext["plugin"]["settings"],
  selection: Pick<
    TurnOptions,
    "providerSettingsId" | "runtimeProviderId" | "model" | "reasoning"
  >
): boolean {
  const provider: ApiProviderConfig | undefined = settings.apiProviders.find(
    (candidate) => candidate.id === selection.providerSettingsId
  );
  const model: ApiProviderModelConfig | null = provider
    ? getApiProviderModel(provider, selection.model)
    : null;
  if (
    !provider
    || !model
    || provider.runtimeProviderId !== selection.runtimeProviderId
  ) return false;
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    selection.runtimeProviderId,
    selection.model,
    model.reasoning
  );
  return isEchoInkPiReasoningEffortSupported(
    capabilities,
    selection.reasoning
  );
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
  view: CodexViewTurnContext,
  session: StoredSession,
  projection: Readonly<PiChatUiViewModel>
): void {
  session.piSessionId = projection.piSessionId;
  session.messages = projectPiImageAttachments(
    session,
    clonePiChatMessages(projection.messages)
  );
  view.setPendingInteraction(
    session.id,
    projection.pendingInteraction ?? null,
    projection.productRunId
  );
}

function piChatLiveProjectionFromSession(
  session: Readonly<StoredSession>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >,
  submittedText: string,
  preparedImages: readonly Readonly<PiChatPreparedImage>[],
  preparedDocuments: readonly Readonly<PiChatPreparedDocument>[],
  noteMentions: readonly Readonly<NonNullable<QueuedTurnItem["noteMentions"]>[number]>[],
  submittedAt: number
): PiChatUiViewModel {
  const messages = clonePiChatMessages(session.messages);
  if (preparedImages.length || preparedDocuments.length || noteMentions.length) {
    const acceptedUserMessage: ChatMessage = {
      id: piProjectedEntryMessageId(
        handle.piSessionId,
        null,
        handle.userEntryId
      ),
      role: "user",
      itemType: "user",
      text: submittedText,
      ...(preparedImages.length
        ? { images: preparedImages.map(({ attachment }) => ({ ...attachment })) }
        : {}),
      ...(preparedDocuments.length
        ? {
            attachments: preparedDocuments.map(({ attachment }) => ({
              ...attachment
            }))
          }
        : {}),
      ...(noteMentions.length
        ? {
            noteMentions: noteMentions.map(({ vaultRelativePath, fileName }) => ({
              vaultRelativePath,
              fileName
            }))
          }
        : {}),
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
    ...(message.noteMentions
      ? { noteMentions: message.noteMentions.map((mention) => ({ ...mention })) }
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
      : {}),
    ...(message.assistantTurn
      ? { assistantTurn: cloneEchoInkAssistantTurn(message.assistantTurn) }
      : {}),
    ...(message.interactionRecord
      ? { interactionRecord: Object.freeze({ ...message.interactionRecord }) }
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
    && noteMentionPathsMatch(
      composerNoteMentionSelections(view.inputEl),
      item.noteMentions ?? []
    )
    && (view.selectedSkill?.id ?? null) === (item.skill?.id ?? null);
}

function queuedTurnDraftsMatch(
  left: Readonly<QueuedTurnItem>,
  right: Readonly<QueuedTurnItem>
): boolean {
  return left.text === right.text
    && attachmentListsMatch(left.attachments, right.attachments)
    && noteMentionPathsMatch(left.noteMentions ?? [], right.noteMentions ?? [])
    && (left.skill?.id ?? null) === (right.skill?.id ?? null);
}

function noteMentionPathsMatch(
  left: readonly Readonly<{ vaultRelativePath: string }>[],
  right: readonly Readonly<{ vaultRelativePath: string }>[]
): boolean {
  return left.length === right.length
    && left.every((mention, index) =>
      mention.vaultRelativePath === right[index]?.vaultRelativePath
    );
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
        && attachment.mimeType === candidate.mimeType
        && attachment.sizeBytes === candidate.sizeBytes;
    });
}

function availableDocumentInputTokens(
  view: CodexViewTurnContext,
  session: Readonly<StoredSession>,
  item: Pick<QueuedTurnItem, "turnOptions" | "noteMentions">,
  submittedText: string
): number {
  const provider = view.plugin.settings.apiProviders.find(
    (candidate) => candidate.id === item.turnOptions.providerSettingsId
  );
  const model = provider
    ? getApiProviderModel(provider, item.turnOptions.model)
    : null;
  if (!provider || !model) return 0;
  const effective = calculatePiEffectiveInputBudget({
    contextWindow: model.contextWindow,
    maxOutputReserve: Math.min(model.maxOutputTokens, model.modelMaxTokens)
  });
  const ledger = session.contextLedger;
  const baseline = ledger
    && ledger.model.provider === item.turnOptions.runtimeProviderId
    && ledger.model.id === item.turnOptions.model
    && ledger.budget.contextWindow === model.contextWindow
    ? ledger.remainingInputTokens
    : effective.effectiveInputBudget - Math.max(
      4_096,
      Math.floor(effective.effectiveInputBudget * 0.15)
    );
  const currentTurnTokens = estimatePiContextTokens({
    text: submittedText,
    noteMentions: item.noteMentions?.map((mention) => mention.content) ?? []
  }).tokens;
  return Math.max(0, baseline - currentTurnTokens);
}

function piDocumentCapabilityTarget(
  provider: Readonly<ApiProviderConfig>,
  modelId: string
): Readonly<PiDocumentCapabilityTarget> {
  return Object.freeze({
    providerId: provider.providerId ?? "",
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    modelId,
    adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER
  });
}

function preparedDocumentsMatchAttachments(
  documents: readonly Readonly<PiChatPreparedDocument>[],
  attachments: readonly Readonly<StoredAttachment>[]
): boolean {
  return documents.length === attachments.length
    && documents.every((document, index) => {
      const attachment = attachments[index];
      return attachment?.type === "file"
        && document.attachment.path === attachment.path
        && document.attachment.name === attachment.name.trim();
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
