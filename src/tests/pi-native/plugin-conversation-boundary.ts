import assert from "node:assert/strict";
import CodexForObsidianPlugin from "../../main";
import type {
  PiConversationCatalogEntry,
  PiConversationProjection
} from "../../harness/pi-native/contracts";
import {
  PiProductionConfigurationError
} from "../../plugin/pi-production-runtime-composition";

const pluginPrototype = CodexForObsidianPlugin.prototype as any;

export async function runPiPluginConversationBoundaryTests(): Promise<void> {
  await missingProviderKeepsHistoryReadableWithoutActivation();
  await localHistoryDoesNotWaitForProductionRuntimeInitialization();
  await openingReturnsHistoryBeforeActivationCompletes();
  await sendingWaitsForTheExistingActivationTask();
  await supersededSendDoesNotReactivateTheEarlierConversation();
  await latestRapidSwitchWinsAndReleasesTheStaleSession();
  await staleConcurrentSelectionDoesNotCreateAnObsoleteAgentSession();
  await archivingPendingSelectionDoesNotWaitForRuntimeInitialization();
  await switchingWithoutAKeyKeepsTargetHistoryReadable();
  await readOnlyProjectionDoesNotCreateAnAgentSession();
  await localManagementAndMemoryStayProviderIndependent();
  await releaseClearsPluginActivationStateEvenWhenRuntimeReleaseFails();
  await chatPropagatesTheMissingApiKeyError();
}

async function localHistoryDoesNotWaitForProductionRuntimeInitialization():
Promise<void> {
  const local = conversationProjection("history-before-runtime");
  const localReady = deferred<PiConversationProjection>();
  const runtimeReady = deferred<{ runtime: Record<string, unknown> }>();
  const events: string[] = [];
  const host = pluginHost({
    settings: {
      sessions: [{
        id: local.catalog.conversationId,
        cwd: "/disposable-vault"
      }],
      activeSessionId: local.catalog.conversationId
    },
    ensurePiLocalData: async () => ({
      vaultRootPath: "/disposable-vault",
      readConversationProjection: async (conversationId: string) => {
        events.push(`local:start:${conversationId}`);
        return await localReady.promise;
      }
    }),
    ensurePiProductionRuntime: async () => {
      events.push("runtime:start");
      return await runtimeReady.promise;
    },
    piProviderCanActivateAgentSession: () => true
  });
  let settled = false;
  const opening = pluginPrototype.activatePiConversation.call(
    host,
    local.catalog.conversationId
  ).then((projection: PiConversationProjection) => {
    settled = true;
    return projection;
  });

  await flushMicrotasks();
  assert.deepEqual(events, [
    `local:start:${local.catalog.conversationId}`,
    "runtime:start"
  ], "local history and AgentSession activation must start together");
  assert.equal(settled, false);

  localReady.resolve(local);
  await flushMicrotasks();
  assert.equal(
    settled,
    true,
    "local history must settle while Production Runtime is still initializing"
  );
  assert.equal(await opening, local);

  runtimeReady.resolve({
    runtime: {
      activateConversation: async () => local
    }
  });
  await host.piConversationActivationLane;

  const initializationError = new Error("Production Runtime initialization failed");
  const failingHost = pluginHost({
    settings: {
      sessions: [{
        id: local.catalog.conversationId,
        cwd: "/disposable-vault"
      }],
      activeSessionId: local.catalog.conversationId
    },
    ensurePiLocalData: async () => ({
      vaultRootPath: "/disposable-vault",
      readConversationProjection: async () => local
    }),
    ensurePiProductionRuntime: async () => { throw initializationError; },
    piProviderCanActivateAgentSession: () => true
  });
  assert.equal(
    await pluginPrototype.activatePiConversation.call(
      failingHost,
      local.catalog.conversationId
    ),
    local,
    "a failed Production Runtime must not replace local history with an error"
  );
  await failingHost.piConversationActivationLane;
  assert.equal(failingHost.piActivatedConversationId, null);
}

async function missingProviderKeepsHistoryReadableWithoutActivation():
Promise<void> {
  const projection = conversationProjection("history-without-key");
  const events: string[] = [];
  const host = runtimeHost({
    canActivate: false,
    runtime: {
      readProjection: async (conversationId: string) => {
        events.push(`read:${conversationId}`);
        return projection;
      },
      activateConversation: async () => {
        events.push("activate");
        throw new Error("must not activate without a Provider API Key");
      }
    }
  });

  assert.equal(
    await pluginPrototype.activatePiConversation.call(
      host,
      projection.catalog.conversationId
    ),
    projection
  );
  await host.piConversationActivationLane;
  assert.deepEqual(events, ["read:history-without-key"]);
}

async function openingReturnsHistoryBeforeActivationCompletes(): Promise<void> {
  const local = conversationProjection("history-open");
  const activated = conversationProjection("history-open", "activated");
  const activation = deferred<PiConversationProjection>();
  const events: string[] = [];
  const host = runtimeHost({
    canActivate: true,
    runtime: {
      readProjection: async (conversationId: string) => {
        events.push(`read:${conversationId}`);
        return local;
      },
      activateConversation: async (conversationId: string) => {
        events.push(`activate:${conversationId}`);
        return await activation.promise;
      }
    }
  });

  assert.equal(
    await pluginPrototype.activatePiConversation.call(
      host,
      local.catalog.conversationId
    ),
    local,
    "opening must return the local projection without waiting for AgentSession"
  );
  await flushMicrotasks();
  assert.deepEqual(events, ["read:history-open", "activate:history-open"]);
  assert.equal(host.piActivatedConversationId, null);
  activation.resolve(activated);
  await host.piConversationActivationLane;
  assert.equal(host.piActivatedConversationId, local.catalog.conversationId);

  const missingKey = new PiProductionConfigurationError(
    "provider_api_key_missing",
    "Provider API Key 尚未填写，请回到设置页输入后保存。"
  );
  const fallbackHost = runtimeHost({
    canActivate: true,
    runtime: {
      readProjection: async () => local,
      activateConversation: async () => { throw missingKey; }
    }
  });
  assert.equal(
    await pluginPrototype.activatePiConversation.call(
      fallbackHost,
      local.catalog.conversationId
    ),
    local,
    "an activation-only Provider error must not hide local history"
  );
  await fallbackHost.piConversationActivationLane;
}

async function sendingWaitsForTheExistingActivationTask(): Promise<void> {
  const local = conversationProjection("history-send-during-activation");
  const activation = deferred<PiConversationProjection>();
  let activations = 0;
  let submissions = 0;
  const handle = {
    productRunId: "run-after-activation",
    conversationId: local.catalog.conversationId,
    piSessionId: local.catalog.piSessionId,
    userEntryId: "user-after-activation",
    result: Promise.resolve({})
  };
  const host = runtimeHost({
    canActivate: true,
    runtime: {
      readProjection: async () => local,
      activateConversation: async () => {
        activations += 1;
        return await activation.promise;
      },
      submit: async () => {
        submissions += 1;
        return handle;
      }
    }
  });

  assert.equal(
    await pluginPrototype.activatePiConversation.call(
      host,
      local.catalog.conversationId
    ),
    local
  );
  await flushMicrotasks();
  const sending = pluginPrototype.submitPiChat.call(host, {
    conversationId: local.catalog.conversationId,
    text: "继续聊天",
    submittedAt: 2
  });
  await flushMicrotasks();
  assert.equal(activations, 1, "send must reuse the opening activation task");
  assert.equal(submissions, 0, "send must wait until that activation settles");

  activation.resolve(conversationProjection(
    local.catalog.conversationId,
    "activated-before-send"
  ));
  assert.equal(await sending, handle);
  assert.equal(activations, 1);
  assert.equal(submissions, 1);
}

async function supersededSendDoesNotReactivateTheEarlierConversation():
Promise<void> {
  const first = conversationProjection("history-send-first");
  const second = conversationProjection("history-send-second");
  const firstActivation = deferred<PiConversationProjection>();
  const events: string[] = [];
  let firstActivationCalls = 0;
  const host = runtimeHost({
    canActivate: true,
    runtime: {
      readProjection: async (conversationId: string) =>
        conversationId === first.catalog.conversationId ? first : second,
      activateConversation: async (conversationId: string) => {
        events.push(`activate:${conversationId}`);
        if (conversationId === first.catalog.conversationId) {
          firstActivationCalls += 1;
          if (firstActivationCalls === 1) {
            return await firstActivation.promise;
          }
        }
        return conversationProjection(conversationId, "unexpected-reactivation");
      },
      switchConversation: async (previous: string, next: string) => {
        events.push(`switch:${previous}->${next}`);
        return conversationProjection(next, "activated-latest");
      },
      releaseConversation: async (conversationId: string) => {
        events.push(`release:${conversationId}`);
      },
      submit: async () => {
        events.push("submit");
        throw new Error("a superseded send must not reach submit");
      }
    }
  });

  await pluginPrototype.activatePiConversation.call(
    host,
    first.catalog.conversationId
  );
  await flushMicrotasks();
  const sending = pluginPrototype.submitPiChat.call(host, {
    conversationId: first.catalog.conversationId,
    text: "切换前立即发送",
    submittedAt: 3
  });
  await flushMicrotasks();
  await pluginPrototype.switchPiConversation.call(
    host,
    first.catalog.conversationId,
    second.catalog.conversationId
  );

  firstActivation.resolve(conversationProjection(
    first.catalog.conversationId,
    "activated-too-late"
  ));
  await assert.rejects(
    sending,
    /会话已切换或关闭.*当前会话重试/u
  );
  await host.piConversationActivationLane;

  assert.equal(firstActivationCalls, 1);
  assert.equal(events.includes("submit"), false);
  assert.equal(
    host.piActivatedConversationId,
    second.catalog.conversationId
  );
}

async function latestRapidSwitchWinsAndReleasesTheStaleSession(): Promise<void> {
  const firstLocal = conversationProjection("history-first");
  const secondLocal = conversationProjection("history-second");
  const firstActivation = deferred<PiConversationProjection>();
  const events: string[] = [];
  const host = runtimeHost({
    canActivate: true,
    runtime: {
      readProjection: async (conversationId: string) => {
        events.push(`read:${conversationId}`);
        return conversationId === firstLocal.catalog.conversationId
          ? firstLocal
          : secondLocal;
      },
      switchConversation: async (previous: string, next: string) => {
        events.push(`switch:${previous}->${next}`);
        if (next === firstLocal.catalog.conversationId) {
          return await firstActivation.promise;
        }
        return conversationProjection(next, "activated-second");
      },
      releaseConversation: async (conversationId: string) => {
        events.push(`release:${conversationId}`);
      }
    }
  });

  assert.equal(
    await pluginPrototype.switchPiConversation.call(
      host,
      "history-previous",
      firstLocal.catalog.conversationId
    ),
    firstLocal
  );
  await flushMicrotasks();
  assert.equal(
    await pluginPrototype.switchPiConversation.call(
      host,
      firstLocal.catalog.conversationId,
      secondLocal.catalog.conversationId
    ),
    secondLocal
  );
  firstActivation.resolve(conversationProjection(
    firstLocal.catalog.conversationId,
    "activated-first-late"
  ));
  await host.piConversationActivationLane;

  assert.deepEqual(events, [
    "read:history-first",
    "switch:history-previous->history-first",
    "read:history-second",
    "release:history-first",
    "switch:history-first->history-second"
  ]);
  assert.equal(
    host.piActivatedConversationId,
    secondLocal.catalog.conversationId,
    "only the final switch intent may remain active"
  );
}

async function staleConcurrentSelectionDoesNotCreateAnObsoleteAgentSession():
Promise<void> {
  const local = conversationProjection("history-stale-before-activation");
  const localRead = deferred<PiConversationProjection>();
  const runtimeReady = deferred<{ runtime: Record<string, unknown> }>();
  let selectionCurrent = true;
  let runtimeInitializations = 0;
  let agentSessionActivations = 0;
  const host = pluginHost({
    settings: {
      sessions: [{
        id: local.catalog.conversationId,
        cwd: "/disposable-vault"
      }],
      activeSessionId: "history-previous"
    },
    ensurePiLocalData: async () => ({
      vaultRootPath: "/disposable-vault",
      readConversationProjection: async () => await localRead.promise
    }),
    ensurePiProductionRuntime: async () => {
      runtimeInitializations += 1;
      return await runtimeReady.promise;
    },
    piProviderCanActivateAgentSession: () => true
  });

  const switching = pluginPrototype.switchPiConversation.call(
    host,
    "history-previous",
    local.catalog.conversationId,
    { isStillCurrent: () => selectionCurrent }
  );
  await flushMicrotasks();
  assert.equal(
    runtimeInitializations,
    1,
    "activation initialization must start without waiting for local history"
  );
  selectionCurrent = false;
  localRead.resolve(local);
  runtimeReady.resolve({
    runtime: {
      switchConversation: async () => {
        agentSessionActivations += 1;
        return local;
      }
    }
  });

  assert.equal(await switching, local);
  await host.piConversationActivationLane;
  assert.equal(runtimeInitializations, 1);
  assert.equal(agentSessionActivations, 0);
  assert.equal(host.piConversationActivationTasks.size, 0);
  assert.equal(host.piActivatedConversationId, null);
}

async function archivingPendingSelectionDoesNotWaitForRuntimeInitialization():
Promise<void> {
  const local = conversationProjection("history-archive-during-runtime");
  const archived: PiConversationCatalogEntry = {
    ...local.catalog,
    status: "archived"
  };
  const localRead = deferred<PiConversationProjection>();
  const runtimeReady = deferred<{ runtime: Record<string, unknown> }>();
  const events: string[] = [];
  let selectionCurrent = true;
  let agentSessionActivations = 0;
  const localData = {
    vaultRootPath: "/disposable-vault",
    readConversationProjection: async () => {
      events.push("local:read");
      return await localRead.promise;
    },
    setConversationStatus: async () => {
      events.push("local:archive");
      return archived;
    }
  };
  const host = pluginHost({
    settings: {
      sessions: [{
        id: local.catalog.conversationId,
        cwd: "/disposable-vault"
      }],
      activeSessionId: "history-previous"
    },
    ensurePiLocalData: async () => localData,
    ensurePiProductionRuntime: async () => {
      events.push("runtime:start");
      return await runtimeReady.promise;
    },
    piProviderCanActivateAgentSession: () => true
  });

  const switching = pluginPrototype.switchPiConversation.call(
    host,
    "history-previous",
    local.catalog.conversationId,
    { isStillCurrent: () => selectionCurrent }
  );
  await flushMicrotasks();
  assert.deepEqual(events, ["local:read", "runtime:start"]);

  selectionCurrent = false;
  let archiveSettled = false;
  const archiving = pluginPrototype.setPiConversationStatus.call(
    host,
    local.catalog.conversationId,
    "archived"
  ).then((result: PiConversationCatalogEntry) => {
    archiveSettled = true;
    return result;
  });
  await flushMicrotasks();

  assert.equal(
    archiveSettled,
    true,
    "archiving must cancel a pre-session activation without waiting for Runtime initialization"
  );
  assert.equal(await archiving, archived);
  assert.deepEqual(events, ["local:read", "runtime:start", "local:archive"]);

  localRead.resolve(local);
  runtimeReady.resolve({
    runtime: {
      switchConversation: async () => {
        agentSessionActivations += 1;
        return local;
      }
    }
  });
  assert.equal(await switching, local);
  await host.piConversationActivationLane;
  assert.equal(agentSessionActivations, 0);
  assert.equal(host.piActivatedConversationId, null);
}

async function switchingWithoutAKeyKeepsTargetHistoryReadable(): Promise<void> {
  const local = conversationProjection("history-next");
  const noKeyEvents: string[] = [];
  const noKeyHost = runtimeHost({
    canActivate: false,
    runtime: {
      readProjection: async (conversationId: string) => {
        noKeyEvents.push(`read:${conversationId}`);
        return local;
      },
      switchConversation: async () => {
        noKeyEvents.push("switch");
        throw new Error("must not activate without a Provider API Key");
      },
      releaseConversation: async (conversationId: string) => {
        noKeyEvents.push(`release:${conversationId}`);
      }
    }
  });
  assert.equal(
    await pluginPrototype.switchPiConversation.call(
      noKeyHost,
      "history-previous",
      local.catalog.conversationId
    ),
      local
  );
  await noKeyHost.piConversationActivationLane;
  assert.deepEqual(noKeyEvents, ["read:history-next"]);
}

async function readOnlyProjectionDoesNotCreateAnAgentSession(): Promise<void> {
  const local = conversationProjection("history-read-only");
  const events: string[] = [];
  const host = pluginHost({
    settings: {
      sessions: [{
        id: local.catalog.conversationId,
        cwd: "/disposable-vault"
      }],
      activeSessionId: local.catalog.conversationId
    },
    ensurePiLocalData: async () => ({
      vaultRootPath: "/disposable-vault",
      readConversationProjection: async (conversationId: string) => {
        events.push(`read:${conversationId}`);
        return local;
      }
    }),
    ensurePiProductionRuntime: async () => {
      events.push("runtime");
      throw new Error("read-only history must not initialize Production Runtime");
    },
    piProviderCanActivateAgentSession: () => true
  });

  assert.equal(
    await pluginPrototype.readPiConversationProjection.call(
      host,
      local.catalog.conversationId
    ),
    local
  );
  assert.deepEqual(events, ["read:history-read-only"]);
  assert.equal(host.piConversationActivationTasks.size, 0);
}

async function localManagementAndMemoryStayProviderIndependent(): Promise<void> {
  const archived = catalogEntry("history-managed", "archived");
  const deleted = catalogEntry("history-managed", "deleted");
  const statusEvents: string[] = [];
  const localData = {
    listConversations: async () => [archived],
    setConversationStatus: async (
      conversationId: string,
      status: "archived" | "deleted"
    ) => {
      statusEvents.push(`${conversationId}:${status}`);
      return status === "archived" ? archived : deleted;
    },
    personalMemory: {
      readUserControlState: async () => ({
        identity: { agent: "Agent", user: "User" },
        records: [{ id: "memory-local" }]
      })
    }
  };
  const host = pluginHost({
    settings: { memory: { enabled: true } },
    piRuntimeBundle: null,
    piRuntimeFlight: null,
    piActivatedConversationId: "history-managed",
    settlePiRuntimeFlight: async () => undefined,
    ensurePiLocalData: async () => localData,
    ensurePiProductionRuntime: async () => {
      throw new Error("local management must not require the production runtime");
    }
  });

  assert.deepEqual(
    await pluginPrototype.listPiConversations.call(host),
    [archived]
  );
  assert.equal(
    await pluginPrototype.setPiConversationStatus.call(
      host,
      "history-managed",
      "archived"
    ),
    archived
  );
  assert.equal(host.piActivatedConversationId, null);
  assert.equal(
    await pluginPrototype.setPiConversationStatus.call(
      host,
      "history-managed",
      "deleted"
    ),
    deleted
  );
  assert.deepEqual(statusEvents, [
    "history-managed:archived",
    "history-managed:deleted"
  ]);
  assert.deepEqual(
    await pluginPrototype.getEchoInkPersonalMemoryState.call(host),
    {
      identity: { agent: "Agent", user: "User" },
      records: [{ id: "memory-local" }],
      learningEnabled: true
    }
  );
}

async function releaseClearsPluginActivationStateEvenWhenRuntimeReleaseFails():
Promise<void> {
  const releaseError = new Error("release failed after disposing the session");
  const host = pluginHost({
    piRuntimeBundle: {
      runtime: {
        releaseConversation: async () => { throw releaseError; }
      }
    },
    piActivatedConversationId: "history-release-error"
  });

  await assert.rejects(
    () => pluginPrototype.releasePiConversation.call(
      host,
      "history-release-error"
    ),
    (error: unknown) => error === releaseError
  );
  assert.equal(host.piActivatedConversationId, null);
}

async function chatPropagatesTheMissingApiKeyError(): Promise<void> {
  const missingKey = new PiProductionConfigurationError(
    "provider_api_key_missing",
    "Provider API Key 尚未填写，请回到设置页输入后保存。"
  );
  const host = runtimeHost({
    canActivate: false,
    runtime: {
      submit: async () => { throw missingKey; }
    }
  });

  await assert.rejects(
    () => pluginPrototype.submitPiChat.call(host, {
      conversationId: "history-without-key",
      text: "继续聊天",
      submittedAt: 1
    }),
    (error: unknown) => error === missingKey
      && (error as PiProductionConfigurationError).code === "provider_api_key_missing"
      && /API Key 尚未填写/u.test((error as Error).message)
  );
}

function runtimeHost(input: Readonly<{
  canActivate: boolean;
  runtime: Record<string, unknown>;
}>): any {
  const readProjection = input.runtime.readProjection as
    | ((conversationId: string) => Promise<PiConversationProjection>)
    | undefined;
  return pluginHost({
    settings: {
      sessions: [],
      activeSessionId: ""
    },
    ensurePiLocalData: async () => ({
      vaultRootPath: "/disposable-vault",
      readConversationProjection: async (conversationId: string) => {
        if (!readProjection) {
          throw new Error("local projection reader is not configured");
        }
        return await readProjection(conversationId);
      }
    }),
    ensurePiProductionRuntime: async () => ({ runtime: input.runtime }),
    piProviderCanActivateAgentSession: () => input.canActivate
  });
}

function pluginHost(overrides: Record<string, unknown>): any {
  return Object.assign(Object.create(pluginPrototype), {
    settings: { sessions: [], activeSessionId: "" },
    piRuntimeBundle: null,
    piRuntimeFlight: null,
    piConversationActivationGeneration: 0,
    piConversationActivationLane: Promise.resolve(),
    piConversationActivationTasks: new Map(),
    piActivatedConversationId: null,
    piRunConversations: new Map<string, string>(),
    withProductActivity: async (action: () => Promise<unknown>) => await action()
  }, overrides);
}

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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function conversationProjection(
  conversationId: string,
  messageId = "local"
): PiConversationProjection {
  return {
    catalog: catalogEntry(conversationId, "active"),
    activeLeafId: null,
    messages: [{ id: messageId } as PiConversationProjection["messages"][number]],
    diagnostics: [],
    drafts: []
  };
}

function catalogEntry(
  conversationId: string,
  status: PiConversationCatalogEntry["status"]
): PiConversationCatalogEntry {
  return {
    conversationId,
    piSessionId: `pi-${conversationId}`,
    title: conversationId,
    status,
    defaultMemoryMode: "normal",
    createdAt: 1,
    updatedAt: 1
  };
}
