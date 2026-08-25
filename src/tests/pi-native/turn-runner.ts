import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PiChatSubmitRequest,
  PiChatRuntimeEvent,
  PiChatRuntimeEventListener,
  PiConversationProjection,
  PiProductRunRecord
} from "../../harness/pi-native/contracts";
import { PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE } from "../../harness/pi-native/contracts";
import {
  activateApiProviderModel,
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  type ChatMessage,
  type StoredSession
} from "../../settings/settings";
import {
  enqueueComposerDraft,
  piChatMemoryModeForGlobalSetting,
  startChatTurn,
  startQueuedTurnItem,
  startNextQueuedTurn
} from "../../ui/codex-view/turn-runner";
import { classifyLocalAttachmentType } from "../../ui/codex-view/attachments";
import { enabledSkillsForComposerMenu, removeTrailingSlashQuery } from "../../ui/codex-view/composer-controller";
import { compactBrandedModelLabel } from "../../ui/codex-view/composer";
import { buildActiveEchoInkResourceCatalog } from "../../resources/registry";
import { splitMessageTableRow } from "../../ui/render-message";
import { copyAnswerMarkdown } from "../../ui/codex-view/answer-copy";
import {
  personalMemorySourceCountLabel,
  personalMemorySourceEmptyStateLabel,
  piConversationDeriveActionLabel
} from "../../ui/codex-view/message-list";
import {
  activateSession,
  derivePiConversationFromMessage
} from "../../ui/codex-view/session-controller";
import {
  RuntimeTurnQueue,
  type QueuedTurnItem
} from "../../ui/turn-queue";
import {
  copyPiImageAttachmentsForProjection,
  piComposerImageAttachmentsForEntry,
  projectPiImageAttachments
} from "../../ui/codex-view/pi-conversation-support";
import { piProjectedEntryMessageId } from "../../harness/pi-native/pi-chat-ui-projector";
import { addComposerNoteMentionSelection } from "../../ui/codex-view/note-mentions";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export async function runPiNativeTurnRunnerTests(): Promise<void> {
  localAttachmentClassificationUsesMimeOrExtension();
  asyncSkillMenuOnlyReturnsEnabledSkills();
  composerModelLabelsOnlyRemoveKnownBrandPrefixes();
  globalMemoryModeOverridesEverySubmit();
  imageMetadataProjectsAndCopiesByPiEntryIdentity();
  tableRowsKeepVaultNoteAliasesInsideOneCell();
  emptyPersonalMemorySourceDisplayDoesNotClaimInjection();
  await messageActionContractsStayTruthful();
  await assistantImageDerivationCopiesMetadataWithoutInventingResend();
  await activeRunImagesUseTheNormalQueue();
  await activeRunNoteMentionsUseTheNormalQueue();
  await queuedImageFailuresAreRetainedOnlyBeforePiAcceptance();
  await inFlightComposerImageTransferCannotDuplicate();
  await imageCapabilityPreflightPreservesCompletedTurn();
  await imageCapabilityFailurePreservesComposerAndAcceptedFailureRecordsMetadata();
  await agentSettlementOnlyFinalizesPiChatTurn();
  await pendingSubmitKeepsRunningConversationResidentAcrossSessionSwitch();
  await disabledOrStaleSkillCannotStartTurn();
  await maintainScopeIsResolvedBeforeProviderSubmit();
  await queuedTurnsKeepExactProviderModelAndRetainUnavailableHead();
}

async function queuedTurnsKeepExactProviderModelAndRetainUnavailableHead(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = createApiProviderConfig("custom", "queue-provider-first");
  first.name = "Queue First";
  first.baseUrl = "https://queue-first.example/v1";
  first.apiKey = "fixture-first-key";
  first.models = [createApiProviderModelConfig("custom", "model-a")];
  first.defaultModelId = "model-a";
  const second = createApiProviderConfig("custom", "queue-provider-second");
  second.name = "Queue Second";
  second.baseUrl = "https://queue-second.example/v1";
  second.apiKey = "fixture-second-key";
  second.models = [createApiProviderModelConfig("custom", "model-b")];
  second.defaultModelId = "model-b";
  settings.apiProviders = [first, second];
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = first.id;
  settings.defaultModel = "model-a";
  const session: StoredSession = {
    id: "queue-exact-combinations",
    title: "Queue exact combinations",
    kind: "chat",
    piSessionId: "pi-queue-exact-combinations",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const queue = new RuntimeTurnQueue();
  const queued = (
    id: string,
    providerSettingsId: string,
    model: string
  ): QueuedTurnItem => ({
    id,
    sessionId: session.id,
    text: id,
    attachments: [],
    skill: null,
    turnOptions: {
      providerSettingsId,
      model,
      reasoning: "high",
      serviceTier: "fast",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 1
  });
  queue.enqueue(queued("turn-a", first.id, "model-a"));
  queue.enqueue(queued("turn-b", second.id, "model-b"));
  const activations: string[] = [];
  const sends: string[] = [];
  let failBeforePiAcceptance = false;
  const view: any = {
    plugin: {
      settings,
      activateApiProviderSettings: async (
        applyCandidate: (candidate: typeof settings) => void
      ) => {
        applyCandidate(settings);
        activations.push(`${settings.activeApiProviderId}:${settings.defaultModel}`);
      }
    },
    turnQueue: queue,
    queueStartInProgress: false,
    running: false,
    selectedProviderSettingsId: first.id,
    selectedModel: "model-a",
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    startChatTurn: async (_session: StoredSession, item: QueuedTurnItem) => {
      if (failBeforePiAcceptance) return "failed" as const;
      sends.push(`${item.turnOptions.providerSettingsId}:${item.turnOptions.model}`);
      queue.acceptPiUserEntry(item.sessionId, item.id);
      return "completed" as const;
    },
    afterTurnSettled: async (sessionId: string, succeeded: boolean) => {
      queue.settleSessionQueue(sessionId, succeeded);
    }
  };

  await startNextQueuedTurn(view, session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`
  ]);
  assert.deepEqual(activations, [`${second.id}:model-b`]);
  assert.equal(queue.hasQueuedItems(session.id), false);

  queue.enqueue(queued("turn-retained", first.id, "model-a"));
  first.apiKey = "";
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => item.id),
    ["turn-retained"]
  );
  assert.equal(sends.length, 2, "an unavailable selection must not send or fall back");
  assert.equal(settings.activeApiProviderId, second.id);
  assert.equal(settings.defaultModel, "model-b");

  first.apiKey = "fixture-first-key";
  queue.resumeSessionQueue(session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`,
    `${first.id}:model-a`
  ]);
  assert.equal(queue.hasQueuedItems(session.id), false);

  queue.enqueue(queued("turn-pre-accept-failure", second.id, "model-b"));
  failBeforePiAcceptance = true;
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => item.id),
    ["turn-pre-accept-failure"]
  );
  assert.equal(sends.length, 3, "a pre-accept failure must retain one unsent Prompt");

  failBeforePiAcceptance = false;
  queue.resumeSessionQueue(session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`,
    `${first.id}:model-a`,
    `${second.id}:model-b`
  ]);
  assert.equal(queue.hasQueuedItems(session.id), false);
  console.log("PASS conversation-ui: Queue switches exact combinations and retains an unavailable head");
}

function localAttachmentClassificationUsesMimeOrExtension(): void {
  assert.equal(
    classifyLocalAttachmentType("/fixture/camera-upload", "image/heif"),
    "image"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/camera.HEIF", "application/octet-stream"),
    "image"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/photo.png", "text/plain"),
    "image",
    "a known image extension remains sufficient when the host MIME is stale"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/note.md", "text/markdown"),
    "file"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/archive.bin", "application/octet-stream"),
    "file"
  );
}

function imageMetadataProjectsAndCopiesByPiEntryIdentity(): void {
  const entryId = "user-image-metadata";
  const source: StoredSession = {
    id: "conversation-image-metadata",
    title: "Image metadata",
    kind: "chat",
    piSessionId: "pi-image-metadata",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    piImageAttachments: {
      [entryId]: [
        {
          name: "clipboard-1720000000000-0.png",
          path: "/missing/ordered-one.png",
          mimeType: "image/png"
        },
        {
          name: "原图二.jpg",
          path: "/missing/ordered-two.jpg",
          mimeType: "image/jpeg"
        }
      ]
    },
    createdAt: 1,
    updatedAt: 1
  };
  const fallbackMessage: ChatMessage = {
    id: `pi:pi-image-metadata:leaf:leaf:entry:${entryId}`,
    role: "user",
    itemType: "user",
    text: "",
    images: [{
      type: "image",
      name: "图片 1",
      path: "",
      mimeType: "image/png",
      availability: "unavailable"
    }, {
      type: "image",
      name: "图片 2",
      path: "",
      mimeType: "image/jpeg",
      availability: "unavailable"
    }],
    createdAt: 2
  };

  const projected = projectPiImageAttachments(source, [fallbackMessage]);
  assert.equal(projected.length, 1, "missing local files must not drop the user message");
  assert.deepEqual(projected[0]?.images, [{
    type: "image",
    name: "粘贴图片 1.png",
    path: "/missing/ordered-one.png",
    mimeType: "image/png",
    availability: "unavailable"
  }, {
    type: "image",
    name: "原图二.jpg",
    path: "/missing/ordered-two.jpg",
    mimeType: "image/jpeg",
    availability: "unavailable"
  }]);

  const derived: StoredSession = {
    id: "conversation-image-derived",
    title: "Derived",
    kind: "chat",
    piSessionId: "pi-image-derived",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 3,
    updatedAt: 3
  };
  copyPiImageAttachmentsForProjection(source, derived, projected);
  assert.deepEqual(derived.piImageAttachments, source.piImageAttachments);
  assert.deepEqual(piComposerImageAttachmentsForEntry(source, entryId), [
    {
      type: "image",
      name: "粘贴图片 1.png",
      path: "/missing/ordered-one.png",
      mimeType: "image/png",
      availability: "unavailable"
    },
    {
      type: "image",
      name: "原图二.jpg",
      path: "/missing/ordered-two.jpg",
      mimeType: "image/jpeg",
      availability: "unavailable"
    }
  ]);
}

async function activeRunImagesUseTheNormalQueue(): Promise<void> {
  const session = piSessionShell("conversation-active-image-queue");
  const queue = new RuntimeTurnQueue();
  const item = queuedImageTurn(session.id, "/fixture/queued-image.png");
  let followUpCalls = 0;
  let composerClearCalls = 0;
  const view: any = {
    plugin: {
      followUpPiConversation: async () => { followUpCalls += 1; }
    },
    running: true,
    activeRunKind: "chat",
    activeRunSessionId: session.id,
    turnQueue: queue,
    createQueuedTurnFromComposer: async () => item,
    sessionById: () => session,
    clearComposerDraft: () => { composerClearCalls += 1; },
    renderQueue: () => undefined,
    renderToolbar: () => undefined
  };

  await enqueueComposerDraft(view);

  assert.equal(followUpCalls, 0, "image turns must not use text-only follow-up");
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.deepEqual(queue.itemsForSession(session.id)[0]?.attachments, item.attachments);
  assert.equal(queue.itemsForSession(session.id)[0]?.piUserEntryAccepted, undefined);
  assert.equal(
    queue.itemsForSession(session.id)[0]?.clearComposerAfterPiAcceptance,
    true
  );
  assert.equal(
    composerClearCalls,
    0,
    "Pi must durably accept the queued image turn before Composer clears"
  );

  await enqueueComposerDraft(view);
  assert.equal(
    queue.itemsForSession(session.id).length,
    1,
    "an unchanged Composer snapshot must not be duplicated while waiting"
  );
  assert.equal(followUpCalls, 0);
}

async function activeRunNoteMentionsUseTheNormalQueue(): Promise<void> {
  const session = piSessionShell("conversation-active-note-queue");
  const queue = new RuntimeTurnQueue();
  const item: QueuedTurnItem = {
    ...queuedImageTurn(session.id, "/fixture/unused.png"),
    id: "queued-note-mention",
    text: "总结提及笔记",
    attachments: [],
    noteMentions: [{
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      content: "# 已冻结正文"
    }]
  };
  let followUpCalls = 0;
  const view: any = {
    plugin: {
      followUpPiConversation: async () => { followUpCalls += 1; }
    },
    running: true,
    activeRunKind: "chat",
    activeRunSessionId: session.id,
    turnQueue: queue,
    createQueuedTurnFromComposer: async () => item,
    sessionById: () => session,
    clearComposerDraft: () => undefined,
    renderQueue: () => undefined,
    renderToolbar: () => undefined
  };

  await enqueueComposerDraft(view);
  assert.equal(followUpCalls, 0, "note mentions must not use text-only follow-up");
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.deepEqual(queue.peekNext(session.id)?.noteMentions, item.noteMentions);
  assert.equal(queue.peekNext(session.id)?.clearComposerAfterPiAcceptance, true);

  await enqueueComposerDraft(view);
  assert.equal(queue.itemsForSession(session.id).length, 1,
    "the same frozen note mention draft is not queued twice");
}

async function queuedImageFailuresAreRetainedOnlyBeforePiAcceptance():
Promise<void> {
  const runScenario = async (accepted: boolean) => {
    const sessionId = accepted
      ? "conversation-accepted-image-failure"
      : "conversation-pre-accept-image-failure";
    const session = piSessionShell(sessionId);
    const queue = new RuntimeTurnQueue();
    queue.enqueue(queuedImageTurn(sessionId, `/fixture/${sessionId}.png`));
    const view: any = {
      plugin: { settings: createQueueImageProviderSettings() },
      turnQueue: queue,
      queueStartInProgress: false,
      running: false,
      renderQueue: () => undefined,
      renderToolbar: () => undefined,
      sessionById: () => session,
      startChatTurn: async (_session: StoredSession, turn: QueuedTurnItem) => {
        if (accepted) {
          turn.piUserEntryAccepted = true;
          queue.acceptPiUserEntry(sessionId, turn.id);
        }
        return "failed" as const;
      },
      afterTurnSettled: async (id: string, succeeded: boolean) => {
        queue.settleSessionQueue(id, succeeded);
      }
    };
    await startNextQueuedTurn(view, sessionId);
    return { queue, sessionId };
  };

  const beforeAcceptance = await runScenario(false);
  assert.equal(beforeAcceptance.queue.itemsForSession(beforeAcceptance.sessionId).length, 1);
  assert.equal(
    beforeAcceptance.queue.isSessionQueuePaused(beforeAcceptance.sessionId),
    true,
    "a pre-acceptance failure must return the exact turn to the front and pause"
  );

  const afterAcceptance = await runScenario(true);
  assert.deepEqual(afterAcceptance.queue.itemsForSession(afterAcceptance.sessionId), []);
  assert.equal(
    afterAcceptance.queue.isSessionQueuePaused(afterAcceptance.sessionId),
    false,
    "a durable Pi user Entry must never be duplicated back into the queue"
  );
}

async function inFlightComposerImageTransferCannotDuplicate(): Promise<void> {
  const session = piSessionShell("conversation-in-flight-image-transfer");
  const queue = new RuntimeTurnQueue();
  const queued = queuedImageTurn(session.id, "/fixture/in-flight.png");
  queued.clearComposerAfterPiAcceptance = true;
  queue.enqueue(queued);
  const startGate = deferred<"failed">();
  let running = false;
  const view: any = {
    plugin: {
      settings: createQueueImageProviderSettings(),
      followUpPiConversation: async () => {
        throw new Error("image transfers must not use follow-up");
      }
    },
    turnQueue: queue,
    queueStartInProgress: false,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    sessionById: () => session,
    startChatTurn: async () => {
      running = true;
      view.activeRunKind = "chat";
      view.activeRunSessionId = session.id;
      return await startGate.promise;
    },
    afterTurnSettled: async (id: string, succeeded: boolean) => {
      queue.settleSessionQueue(id, succeeded);
    },
    createQueuedTurnFromComposer: async () =>
      queuedImageTurn(session.id, "/fixture/in-flight.png"),
    sessionById: () => session,
    clearComposerDraft: () => undefined
  };

  const flight = startNextQueuedTurn(view, session.id);
  await waitFor(() => view.queueStartInProgress === true && running);
  await enqueueComposerDraft(view);
  assert.equal(
    queue.itemsForSession(session.id).length,
    1,
    "the leased queue head must remain unique until Pi durably accepts it"
  );

  running = false;
  startGate.resolve("failed");
  await flight;
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
}

async function imageCapabilityFailurePreservesComposerAndAcceptedFailureRecordsMetadata():
Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-turn-runner-image-"));
  try {
    const imagePath = path.join(root, "composer.png");
    await writeFile(imagePath, PNG_1X1);
    const unsupportedSession = piSessionShell("conversation-image-unsupported");
    const unsupportedItem = queuedImageTurn(unsupportedSession.id, imagePath);
    let unsupportedClearCalls = 0;
    let unsupportedSubmit: PiChatSubmitRequest | null = null;
    const unsupportedView = imageFailureView({
      session: unsupportedSession,
      onSubmit: async (request) => {
        unsupportedSubmit = request;
        throw new Error(PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
      },
      onClearComposer: () => { unsupportedClearCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        unsupportedView,
        unsupportedSession,
        unsupportedItem,
        "composer"
      ),
      "failed"
    );
    assert.equal(unsupportedSubmit?.text, unsupportedItem.text);
    assert.equal(unsupportedSubmit?.images?.length, 1);
    assert.equal(unsupportedClearCalls, 0);
    assert.equal(unsupportedItem.piUserEntryAccepted, undefined);
    assert.equal(unsupportedSession.piImageAttachments, undefined);

    const acceptedSession = piSessionShell("conversation-image-accepted-failure");
    const acceptedItem = queuedImageTurn(acceptedSession.id, imagePath);
    acceptedItem.clearComposerAfterPiAcceptance = true;
    let acceptedClearCalls = 0;
    let persistenceCalls = 0;
    const acceptedError = Object.assign(
      new Error("Pi user Entry 已接受，但 ProductRun 持久化失败。"),
      {
        piUserEntryAccepted: true as const,
        piUserEntryId: "entry-image-accepted"
      }
    );
    const acceptedView = imageFailureView({
      session: acceptedSession,
      composerItem: acceptedItem,
      onSubmit: async () => { throw acceptedError; },
      onClearComposer: () => { acceptedClearCalls += 1; },
      onPersist: async () => { persistenceCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        acceptedView,
        acceptedSession,
        acceptedItem,
        "queue"
      ),
      "failed"
    );
    assert.equal(acceptedItem.piUserEntryAccepted, true);
    assert.equal(acceptedClearCalls, 1);
    assert.equal(persistenceCalls, 1);
    assert.deepEqual(
      acceptedSession.piImageAttachments?.["entry-image-accepted"],
      [{
        name: "composer.png",
        path: imagePath,
        mimeType: "image/png",
        availability: "available"
      }]
    );
    assert.doesNotMatch(
      JSON.stringify(acceptedSession.piImageAttachments),
      /iVBORw0KGgo/u
    );

    const switchedSession = piSessionShell("conversation-image-switch-target");
    const switchedItem = queuedImageTurn(acceptedSession.id, imagePath);
    switchedItem.clearComposerAfterPiAcceptance = true;
    let switchedClearCalls = 0;
    const switchedView = imageFailureView({
      session: acceptedSession,
      composerItem: switchedItem,
      onSubmit: async () => { throw acceptedError; },
      onClearComposer: () => { switchedClearCalls += 1; }
    });
    switchedView.plugin.settings.sessions.push(switchedSession);
    switchedView.plugin.settings.activeSessionId = switchedSession.id;

    assert.equal(
      await startChatTurn(
        switchedView,
        acceptedSession,
        switchedItem,
        "queue"
      ),
      "failed"
    );
    assert.equal(
      switchedClearCalls,
      0,
      "an accepted turn from session A must not clear an identical draft in active session B"
    );

    const editedSession = piSessionShell("conversation-image-edited-draft");
    const editedItem = queuedImageTurn(editedSession.id, imagePath);
    let editedClearCalls = 0;
    let editedView: any;
    editedView = imageFailureView({
      session: editedSession,
      composerItem: editedItem,
      onSubmit: async () => {
        editedView.inputEl.value = "这是用户等待期间输入的新草稿";
        throw acceptedError;
      },
      onClearComposer: () => { editedClearCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        editedView,
        editedSession,
        editedItem,
        "composer"
      ),
      "failed"
    );
    assert.equal(
      editedClearCalls,
      0,
      "direct Composer acceptance must not clear text edited while submit was pending"
    );
    assert.equal(
      editedView.inputEl.value,
      "这是用户等待期间输入的新草稿"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function imageCapabilityPreflightPreservesCompletedTurn(): Promise<void> {
  const session = piSessionShell("conversation-image-capability-preflight");
  session.messages = [{
    id: "assistant-completed-before-image-preflight",
    role: "assistant",
    itemType: "assistant",
    text: "上一轮已经完成",
    status: "completed",
    runId: "product-run-completed",
    turnId: "product-run-completed",
    assistantTurn: {
      viewVersion: 1,
      conversationId: session.id,
      turnId: "product-run-completed",
      status: "completed",
      startedAt: 2,
      updatedAt: 5,
      completedAt: 5,
      processNodes: [],
      interactionRecords: [],
      finalAnswerMessageId: "assistant-completed-before-image-preflight",
      summary: {
        completedSteps: 3,
        toolCount: 2,
        durationMs: 24_000
      }
    },
    createdAt: 2,
    completedAt: 5
  }];
  const beforeMessages = structuredClone(session.messages);
  const item = queuedImageTurn(session.id, "/fixture/unsupported.png");
  const settings = createQueueImageProviderSettings(false);
  let startCalls = 0;
  let clearCalls = 0;
  const view: any = {
    plugin: { settings },
    selectedProviderSettingsId: item.turnOptions.providerSettingsId,
    selectedModel: item.turnOptions.model,
    inputEl: { value: item.text },
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    selectedSkill: null,
    renderToolbar: () => undefined,
    clearComposerDraft: () => { clearCalls += 1; },
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    startChatTurn: async () => {
      startCalls += 1;
      return "completed" as const;
    }
  };

  assert.equal(await startQueuedTurnItem(view, item, "composer"), "failed");
  assert.equal(startCalls, 0, "unsupported images must not enter Pi submit");
  assert.equal(clearCalls, 0, "unsupported images must retain the Composer draft");
  assert.equal(view.inputEl.value, item.text);
  assert.deepEqual(view.attachments, item.attachments);
  assert.deepEqual(
    session.messages,
    beforeMessages,
    "capability preflight must not rewrite a completed Assistant Turn"
  );
}

function emptyPersonalMemorySourceDisplayDoesNotClaimInjection(): void {
  assert.equal(personalMemorySourceCountLabel(0), "Personal Memory 来源");
  assert.equal(
    personalMemorySourceEmptyStateLabel(),
    "未记录可展示的 Personal Memory 来源。"
  );
  assert.doesNotMatch(
    `${personalMemorySourceCountLabel(0)} ${personalMemorySourceEmptyStateLabel()}`,
    /(?:0 条|未注入)/u
  );
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
      providerSettingsId: "fixture-provider",
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

async function assistantImageDerivationCopiesMetadataWithoutInventingResend():
Promise<void> {
  const userEntryId = "user-image-derive";
  const assistantEntryId = "assistant-image-derive";
  const source = piSessionShell("conversation-image-derive-source");
  source.piImageAttachments = {
    [userEntryId]: [{
      name: "derive.png",
      path: "/missing/derive.png",
      mimeType: "image/png"
    }]
  };
  const targetId = "conversation-image-derive-target";
  let saveCalls = 0;
  const inputEl = {
    value: "",
    focus: () => undefined,
    setSelectionRange: () => undefined
  };
  const plugin: any = {
    settings: {
      sessions: [source],
      activeSessionId: source.id
    },
    getVaultPath: () => "/vault",
    derivePiConversation: async (input: Readonly<{
      anchorEntryId: string;
    }>) => {
      assert.equal(
        input.anchorEntryId,
        assistantEntryId,
        "the product UI exposes derivation only from an assistant reply"
      );
      return {
        sourceConversationId: source.id,
        anchorEntryId: assistantEntryId,
        anchorRole: "assistant" as const,
        editorText: "",
        activation: { status: "activated" as const },
        projection: {
          catalog: {
            conversationId: targetId,
            piSessionId: "pi-image-derive-target",
            vaultId: "vault-turn-runner",
            title: "Derived image conversation",
            status: "active" as const,
            defaultMemoryMode: "normal" as const,
            createdAt: 3,
            updatedAt: 3,
            sessionFile: "/sessions/pi-image-derive-target.jsonl"
          },
          activeLeafId: assistantEntryId,
          messages: [{
            id: piProjectedEntryMessageId(
              "pi-image-derive-target",
              assistantEntryId,
              userEntryId
            ),
            role: "user" as const,
            itemType: "user" as const,
            text: "",
            images: [{
              type: "image" as const,
              name: "图片 1",
              path: "",
              mimeType: "image/png",
              availability: "unavailable" as const
            }],
            createdAt: 2
          }],
          diagnostics: [],
          drafts: []
        }
      };
    },
    saveSettings: async () => { saveCalls += 1; }
  };
  const host: any = {
    app: {},
    plugin,
    turnQueue: new RuntimeTurnQueue(),
    tabBarEl: {},
    running: false,
    activeRunSessionId: "",
    inputEl,
    attachments: [],
    selectedSkill: null,
    closeComposerMenus: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    updateInputPlaceholder: () => undefined
  };

  await derivePiConversationFromMessage(host, source, assistantEntryId);

  assert.equal(plugin.settings.activeSessionId, targetId);
  assert.equal(inputEl.value, "");
  assert.deepEqual(
    host.attachments,
    [],
    "assistant derivation must not invent a user-message resend surface"
  );
  const derived = plugin.settings.sessions.find(
    (session: StoredSession) => session.id === targetId
  );
  assert.deepEqual(derived?.piImageAttachments, {
    [userEntryId]: [{
      name: "derive.png",
      path: "/missing/derive.png",
      mimeType: "image/png"
    }]
  });
  assert.deepEqual(derived?.messages[0]?.images, [{
    type: "image",
    name: "derive.png",
    path: "/missing/derive.png",
    mimeType: "image/png",
    availability: "unavailable"
  }]);
  assert.equal(saveCalls, 1);
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
      providerSettingsId: "fixture-provider",
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
    text: "请总结提及笔记",
    attachments: [{
      type: "image",
      name: "memory-personality-v1.webp",
      path: path.resolve(
        process.cwd(),
        "src/knowledge-base/assets/guide/memory-personality-v1.webp"
      ),
      mimeType: "image/webp"
    }],
    noteMentions: [{
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      content: "PRIVATE_WHOLE_NOTE_BODY"
    }],
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
      providerSettingsId: "fixture-provider",
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
  let approvalListener: (() => void) | null = null;
  let approvalSubscriptionIdentity: Readonly<{
    conversationId: string;
    piSessionId: string;
    productRunId: string;
  }> | null = null;
  let approvalRefreshPending = false;
  let projectionReads = 0;
  let settlementProjectionReads = 0;
  let releasedRunId = "";
  let composerCleared = false;
  let submittedRequest: PiChatSubmitRequest | null = null;
  const renderedAssistantStatuses: Array<string | undefined> = [];
  const plugin = {
    settings: {
      memory: { useLongTermMemory: true },
      sessions: [session],
      activeSessionId: session.id
    },
    getVaultPath: () => "/vault",
    persistPiNativeSettings: async () => undefined,
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
    subscribePiAgentApproval: (
      identity: Readonly<{
        conversationId: string;
        piSessionId: string;
        productRunId: string;
      }>,
      next: () => void
    ) => {
      approvalSubscriptionIdentity = identity;
      approvalListener = next;
      return { unsubscribe: () => { approvalListener = null; } };
    },
    readPiConversationProjection: async (): Promise<PiConversationProjection> => {
      projectionReads += 1;
      if (approvalRefreshPending) {
        approvalRefreshPending = false;
        return durableApprovalProjection(session);
      }
      settlementProjectionReads += 1;
      return durableProjection(
        session,
        settlementProjectionReads === 1 ? "running" : "completed"
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
    inputEl: { value: item.text },
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    selectedSkill: { ...item.skill! },
    setPendingInteraction: () => undefined,
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
  addComposerNoteMentionSelection(view.inputEl, item.noteMentions![0]!);

  let turnResolved = false;
  const turn = startChatTurn(view, session, item, "composer").then((outcome) => {
    turnResolved = true;
    return outcome;
  });
  await waitFor(() => listener !== null);
  assert.deepEqual(approvalSubscriptionIdentity, {
    conversationId: session.id,
    piSessionId: session.piSessionId,
    productRunId: "product-run-turn-runner"
  }, "turn runner subscribes to the exact active Approval run");
  assert.equal(submittedRequest?.skillPath, "skills/review/SKILL.md");
  assert.equal(submittedRequest?.skillName, "review");
  assert.equal(submittedRequest?.memoryMode, "normal");
  assert.equal(submittedRequest?.images?.length, 1);
  assert.deepEqual(submittedRequest?.noteMentions, item.noteMentions);
  assert.equal(projectionReads, 0);
  const liveUserMessage = session.messages.find((message) =>
    message.role === "user"
  );
  assert.equal(liveUserMessage?.text, item.text);
  assert.deepEqual(liveUserMessage?.images, [{
    type: "image",
    name: "memory-personality-v1.webp",
    path: item.attachments[0]!.path,
    mimeType: "image/webp",
    availability: "available"
  }]);
  assert.deepEqual(liveUserMessage?.noteMentions, [{
    vaultRelativePath: "projects/项目复盘.md",
    fileName: "项目复盘.md"
  }]);
  assert.equal(JSON.stringify(liveUserMessage).includes("PRIVATE_WHOLE_NOTE_BODY"), false,
    "live ChatMessage keeps note metadata only");
  const submittedImagePayload = submittedRequest?.images?.[0]?.content.data;
  assert.ok(submittedImagePayload);
  assert.equal(
    JSON.stringify(liveUserMessage).includes(submittedImagePayload),
    false,
    "the immediate live projection must keep metadata only, never a Base64 copy"
  );

  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "user-live",
    role: "user"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1,
    "a real user message_start must reuse the optimistic accepted image bubble"
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "user message_start must preserve the complete local thumbnail metadata"
  );
  await emit(listener, runtimeEvent({
    type: "message_end",
    messageKey: "user-live",
    role: "user",
    text: item.text,
    status: "completed"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1,
    "a user message_end without entryId must not create a second bubble"
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "user message_end without entryId must preserve path and availability"
  );
  await emit(listener, runtimeEvent({
    type: "message_entry_resolved",
    messageKey: "user-live",
    entryId: "entry-user"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "entry resolution must preserve ordered local image metadata"
  );

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
  approvalRefreshPending = true;
  assert.ok(approvalListener);
  approvalListener();
  await waitFor(() => projectionReads === 1);
  assert.equal(
    session.messages.find((message) => message.approval?.status === "pending")
      ?.approval?.target,
    "{\"relativePath\":\"Approval.md\"}",
    "a broker notification refreshes the durable Approval projection"
  );
  await emit(listener, runtimeEvent({ type: "agent_end", willRetry: false }));
  assert.equal(turnResolved, false, "agent_end must not settle the product turn");
  assert.equal(projectionReads, 1, "agent_end must not trigger a settlement readback");
  assert.equal(
    session.messages.find((message) => message.role === "assistant")?.status,
    "running"
  );

  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await waitFor(() => settlementProjectionReads === 1);
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
  assert.equal(projectionReads, 3,
    "Approval refresh, Agent settlement, and formal ProductRun settlement each read once");
  assert.equal(session.messages.at(-1)?.status, "completed");
  assert.equal(session.messages.at(-1)?.askSourceAttribution, true);
  assert.deepEqual(session.messages.at(-1)?.personalMemorySources, [
    { id: "memory-turn-runner", title: "Turn runner Memory" }
  ]);
  assert.equal(composerCleared, true, "durable user entry must clear the submitted draft");
  assert.equal(releasedRunId, "product-run-turn-runner");
  assert.equal(approvalListener, null, "the run-scoped Approval subscription is released");
  assert.equal(
    renderedAssistantStatuses.slice(0, -1).includes("completed"),
    true,
    "the formal ProductRun event must be the first event allowed to render terminal status"
  );
}

async function pendingSubmitKeepsRunningConversationResidentAcrossSessionSwitch():
Promise<void> {
  const runningSession: StoredSession = {
    id: "conversation-turn-runner",
    title: "Running conversation",
    kind: "chat",
    piSessionId: "pi-session-turn-runner",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [{ id: "history-before-submit" } as StoredSession["messages"][number]],
    createdAt: 1,
    updatedAt: 1
  };
  const targetSession: StoredSession = {
    id: "conversation-switch-target",
    title: "Other conversation",
    kind: "chat",
    piSessionId: "pi-session-switch-target",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-pending-submit",
    sessionId: runningSession.id,
    text: "keep the full history",
    attachments: [],
    skill: null,
    turnOptions: {
      providerSettingsId: "fixture-provider",
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
  const handle = {
    productRunId: "product-run-turn-runner",
    conversationId: runningSession.id,
    piSessionId: runningSession.piSessionId!,
    userEntryId: "entry-user",
    result: runResult.promise
  };
  const pendingSubmit = deferred<typeof handle>();
  let listener: PiChatRuntimeEventListener | null = null;
  let projectionReads = 0;
  const plugin = {
    settings: {
      memory: { useLongTermMemory: true },
      sessions: [runningSession, targetSession],
      activeSessionId: runningSession.id
    },
    getVaultPath: () => "/vault",
    submitPiChat: async () => await pendingSubmit.promise,
    subscribePiRun: (_productRunId: string, next: PiChatRuntimeEventListener) => {
      listener = next;
      return { unsubscribe: () => { listener = null; } };
    },
    subscribePiAgentApproval: () => ({ unsubscribe: () => undefined }),
    readPiConversationProjection: async (): Promise<PiConversationProjection> => {
      projectionReads += 1;
      return durableProjection(
        runningSession,
        projectionReads === 1 ? "running" : "completed"
      );
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: () => undefined,
    switchPiConversation: async (
      _previous: string | null,
      next: string
    ): Promise<PiConversationProjection> => ({
      catalog: {
        conversationId: next,
        piSessionId: targetSession.piSessionId!,
        vaultId: "vault-turn-runner",
        title: targetSession.title,
        status: "active",
        defaultMemoryMode: "normal",
        createdAt: 1,
        updatedAt: 1,
        sessionFile: "/sessions/pi-session-switch-target.jsonl"
      },
      activeLeafId: null,
      messages: [{ id: "target-history" } as PiConversationProjection["messages"][number]],
      diagnostics: [],
      drafts: []
    }),
    saveSettings: async () => undefined
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
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    setPendingInteraction: () => undefined,
    clearComposerDraft: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeTurnId = "";
    }
  };
  const sessionHost: any = {
    plugin,
    get running() { return view.running; },
    get activeRunSessionId() { return view.activeRunSessionId; },
    updateInputPlaceholder: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined
  };

  const turn = startChatTurn(view, runningSession, item, "composer");
  await waitFor(() =>
    view.running
    && view.activeRunKind === "chat"
    && view.activeRunSessionId === runningSession.id
  );
  await activateSession(sessionHost, targetSession);
  assert.equal(plugin.settings.activeSessionId, targetSession.id);
  assert.equal(
    runningSession.messages[0]?.id,
    "history-before-submit",
    "the running session must remain resident while submitPiChat is pending"
  );

  pendingSubmit.resolve(handle);
  await waitFor(() => listener !== null);
  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "assistant-pending",
    role: "assistant"
  }));
  await emit(listener, runtimeEvent({
    type: "message_update",
    messageKey: "assistant-pending",
    textDelta: "streaming after switch"
  }));
  assert.equal(
    runningSession.messages.some((message) =>
      message.id === "history-before-submit"
    ),
    true,
    "post-submit runtime events must build on the retained history, not an empty live projection"
  );

  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await waitFor(() => projectionReads === 1);
  await emit(listener, runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }));
  runResult.resolve({
    productRunId: handle.productRunId,
    conversationId: handle.conversationId,
    piSessionId: handle.piSessionId,
    userEntryId: handle.userEntryId,
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
  assert.equal(view.running, false);
  assert.equal(view.activeRunKind, "");
  assert.equal(view.activeRunSessionId, "");
}

function piSessionShell(id: string): StoredSession {
  return {
    id,
    title: id,
    kind: "chat",
    piSessionId: `pi-${id}`,
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function queuedImageTurn(sessionId: string, imagePath: string): QueuedTurnItem {
  return {
    id: `queued-${sessionId}`,
    sessionId,
    text: "请看图片",
    attachments: [{
      type: "image",
      name: path.basename(imagePath),
      path: imagePath,
      mimeType: "image/png"
    }],
    skill: null,
    turnOptions: {
      providerSettingsId: "queue-image-provider",
      model: "queue-image-model",
      reasoning: "high",
      serviceTier: "fast",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
}

function createQueueImageProviderSettings(imageInput = true) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("custom", "queue-image-provider");
  provider.name = "Queue image provider";
  provider.baseUrl = "https://queue-image.example/v1";
  provider.apiKey = "fixture-queue-image-key";
  const model = createApiProviderModelConfig("custom", "queue-image-model");
  model.input = imageInput ? ["text", "image"] : ["text"];
  provider.models = [model];
  provider.defaultModelId = "queue-image-model";
  settings.apiProviders = [provider];
  activateApiProviderModel(settings, provider, "queue-image-model");
  return settings;
}

function imageFailureView(input: Readonly<{
  session: StoredSession;
  composerItem?: Readonly<QueuedTurnItem>;
  onSubmit(request: PiChatSubmitRequest): Promise<never>;
  onClearComposer(): void;
  onPersist?(): Promise<void>;
}>): any {
  let running = false;
  let activeRunId = "";
  return {
    plugin: {
      settings: {
        memory: { useLongTermMemory: true },
        sessions: [input.session],
        activeSessionId: input.session.id
      },
      getVaultPath: () => "/vault",
      submitPiChat: input.onSubmit,
      persistPiNativeSettings: input.onPersist ?? (async () => undefined),
      readPiConversationProjection: async () => {
        throw new Error("no ProductRun projection for rejected submit");
      },
      abortPiConversation: async () => undefined,
      releasePiProductionRun: () => undefined
    },
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    inputEl: { value: input.composerItem?.text ?? "" },
    attachments: input.composerItem?.attachments.map((attachment) => ({
      ...attachment
    })) ?? [],
    selectedSkill: input.composerItem?.skill ?? null,
    clearComposerDraft: input.onClearComposer,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };
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
        id: piProjectedEntryMessageId(
          session.piSessionId!,
          "entry-assistant",
          "entry-user"
        ),
        role: "user",
        itemType: "user",
        text: session.piImageAttachments?.["entry-user"]?.length ? "" : "hello",
        ...(session.piImageAttachments?.["entry-user"]?.length
          ? {
              images: session.piImageAttachments["entry-user"].map(
                (image, index) => ({
                  type: "image" as const,
                  name: `图片 ${index + 1}`,
                  path: "",
                  mimeType: image.mimeType,
                  availability: "unavailable" as const
                })
              )
            }
          : {}),
        status: "completed",
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        createdAt: 2,
        completedAt: 2
      },
      {
        id: piProjectedEntryMessageId(
          session.piSessionId!,
          "entry-assistant",
          "entry-assistant"
        ),
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

function durableApprovalProjection(
  session: Readonly<StoredSession>
): PiConversationProjection {
  const projection = durableProjection(session, "running");
  return {
    ...projection,
    messages: [
      ...projection.messages,
      {
        id: "pi:tool:tool-call-approval",
        role: "tool",
        itemType: "dynamicToolCall",
        title: "等待确认",
        text: "pending approval",
        status: "waiting_approval",
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        approval: {
          status: "pending",
          target: "{\"relativePath\":\"Approval.md\"}",
          preview: "{\"operation\":\"note_create\"}",
          updatedAt: 6
        },
        createdAt: 3
      }
    ]
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
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
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
