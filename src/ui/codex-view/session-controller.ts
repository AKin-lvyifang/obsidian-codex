import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type {
  PiConversationCatalogEntry,
  PiConversationProjection
} from "../../harness/pi-native/contracts";
import { newId, selectActiveConversationSession, type StoredAttachment, type StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue } from "../turn-queue";
import { confirmModal, textInputModal } from "../modals";
import { openSessionMenu as showSessionMenu } from "./menus";
import { renderCodexTabs } from "./tabs";
import type { EchoInkResource } from "../../resources/types";
import {
  refreshPiConversationSupport,
  rememberPiConversationProjection
} from "./pi-conversation-support";
import { piEntryIdFromProjectedMessageId } from "../../harness/pi-native/pi-chat-ui-projector";

export interface CodexSessionHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  readonly turnQueue: RuntimeTurnQueue;
  tabBarEl: HTMLElement;
  running: boolean;
  activeRunSessionId: string;
  inputEl: HTMLTextAreaElement;
  attachments: StoredAttachment[];
  selectedSkill: EchoInkResource | null;
  resetVirtualWindow(): void;
  renderTabs(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  renderToolbar(): void;
  updateInputPlaceholder(): void;
  closeComposerMenus(): void;
  renameSession(session: StoredSession): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createSession(title?: string): Promise<StoredSession>;
}

const conversationTransitionLanes = new WeakMap<
  CodexSessionHost,
  Promise<void>
>();
const conversationSelectionGenerations = new WeakMap<
  CodexSessionHost,
  number
>();
const conversationSelectionTargets = new WeakMap<
  CodexSessionHost,
  string
>();

export function renderTabsView(host: CodexSessionHost): void {
  ensureSession(host);
  releaseInactiveConversationBodies(host);
  renderCodexTabs(
    host.tabBarEl,
    host.plugin.settings.sessions,
    host.plugin.settings.activeSessionId,
    {
      onActivate: (session) => void (async () => {
        try {
          await activateSession(host, session);
        } catch (error) {
          new Notice(`打开会话失败：${errorMessage(error)}`);
        } finally {
          renderConversationShellChange(host);
        }
      })(),
      onContextMenu: (event, session) => openSessionMenuView(host, event, session),
      onRename: (session) => void host.renameSession(session),
      onDeleteSessions: (sessionIds) => void confirmDeleteSessions(host, sessionIds),
      onCreateSession: () => void (async () => {
        try {
          await host.createSession();
        } catch (error) {
          new Notice(`新建会话失败：${errorMessage(error)}`);
        } finally {
          renderConversationShellChange(host);
        }
      })()
    },
    host.running ? host.activeRunSessionId : ""
  );
}

export function openSessionMenuView(host: CodexSessionHost, event: MouseEvent, session: StoredSession): void {
  showSessionMenu(
    event,
    {
      onRename: () => void host.renameSession(session),
      onArchive: () => void host.archiveSession(session.id),
      onResetCache: () => void resetSessionNativeCache(host, session),
      onDelete: () => void confirmDeleteSessions(host, [session.id])
    }
  );
}

export async function resetSessionNativeCache(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (host.running && host.activeRunSessionId === session.id) {
    new Notice("当前会话正在运行，结束后再重置 Agent 缓存");
    return;
  }
  try {
    await host.plugin.releasePiConversation(session.id);
    delete session.tokenUsage;
    await persistPiConversationShells(host);
    new Notice("Agent 运行实例已释放，下次打开会从同一会话记录恢复");
  } catch (error) {
    new Notice(`重置 Agent 缓存失败：${errorMessage(error)}`);
  }
}

export async function refreshPiConversationShells(
  host: CodexSessionHost
): Promise<void> {
  const before = conversationShellFingerprint(host);
  let catalogEntries = await host.plugin.listPiConversations(["active"]);
  if (catalogEntries.length === 0) {
    catalogEntries = [await host.plugin.createPiConversation({
      conversationId: newId("conversation"),
      title: "新会话",
      cwd: host.plugin.getVaultPath(),
      defaultMemoryMode: "normal"
    })];
  }
  const existingChatShells = new Map(
    host.plugin.settings.sessions.map((session) => [session.id, session])
  );
  const chatShells = catalogEntries.map((entry) =>
    applyPiCatalogEntryToShell(
      existingChatShells.get(entry.conversationId)
        ?? createPiConversationShell(host, entry),
      entry
    )
  );
  host.plugin.settings.sessions = chatShells;
  selectActiveConversationSession(host.plugin.settings);
  releaseInactiveConversationBodies(host);
  if (before !== conversationShellFingerprint(host)) {
    await persistPiConversationShells(host);
  }
}

export function activateSession(
  host: CodexSessionHost,
  session: StoredSession
): Promise<void> {
  const generation = beginConversationSelection(host, session.id);
  // Keep projection reads and activation intent ordering in one short lane so
  // a late read cannot enqueue an obsolete AgentSession after a newer choice.
  // Settings persistence happens after this lane and has its own save queue.
  return completeSessionActivation(
    host,
    enqueueConversationTransition(
      host,
      async () => await activateSessionInTransitionLane(
        host,
        session,
        generation
      )
    )
  );
}

type ConversationSelectionOutcome =
  | Readonly<{ status: "stale" }>
  | Readonly<{ status: "selected"; error?: unknown }>;

async function completeSessionActivation(
  host: CodexSessionHost,
  selection: Promise<ConversationSelectionOutcome>
): Promise<void> {
  const outcome = await selection;
  if (outcome.status === "stale") return;
  await persistPiConversationShells(host);
  if ("error" in outcome) throw outcome.error;
}

async function activateSessionInTransitionLane(
  host: CodexSessionHost,
  session: StoredSession,
  generation: number
): Promise<ConversationSelectionOutcome> {
  if (!isCurrentConversationSelection(host, generation)) {
    return { status: "stale" };
  }
  const previous = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === host.plugin.settings.activeSessionId
  );
  try {
    const projection = await host.plugin.switchPiConversation(
      previous?.id ?? null,
      session.id,
      {
        isStillCurrent: () =>
          isCurrentConversationSelection(host, generation)
      }
    );
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    applyPiConversationProjectionToShell(host, session, projection);
    host.plugin.settings.activeSessionId = session.id;
    releaseInactiveConversationBodies(host);
    host.updateInputPlaceholder();
    renderConversationShellChange(host);
    return { status: "selected" };
  } catch (error) {
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    await refreshPiConversationSupport(host.plugin, session.id)
      .catch(() => undefined);
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    host.plugin.settings.activeSessionId = session.id;
    releaseInactiveConversationBodies(host);
    host.updateInputPlaceholder();
    renderConversationShellChange(host);
    return { status: "selected", error };
  }
}

function isCurrentConversationSelection(
  host: CodexSessionHost,
  generation: number
): boolean {
  return conversationSelectionGenerations.get(host) === generation;
}

function beginConversationSelection(
  host: CodexSessionHost,
  targetConversationId?: string
): number {
  const generation = (conversationSelectionGenerations.get(host) ?? 0) + 1;
  conversationSelectionGenerations.set(host, generation);
  if (targetConversationId) {
    conversationSelectionTargets.set(host, targetConversationId);
  } else {
    conversationSelectionTargets.delete(host);
  }
  return generation;
}

function bindConversationSelectionTarget(
  host: CodexSessionHost,
  generation: number,
  targetConversationId: string
): boolean {
  if (!isCurrentConversationSelection(host, generation)) return false;
  conversationSelectionTargets.set(host, targetConversationId);
  return true;
}

function isConversationSelectionTarget(
  host: CodexSessionHost,
  conversationId: string
): boolean {
  return conversationSelectionTargets.get(host) === conversationId;
}

export function derivePiConversationFromMessage(
  host: CodexSessionHost,
  session: StoredSession,
  targetEntryId: string
): Promise<void> {
  return enqueueConversationTransition(
    host,
    async () => await derivePiConversationInTransitionLane(
      host,
      session,
      targetEntryId
    )
  );
}

async function derivePiConversationInTransitionLane(
  host: CodexSessionHost,
  session: StoredSession,
  targetEntryId: string
): Promise<void> {
  if (session.bodyAuthority !== "pi_session_only") return;
  if (host.running) {
    new Notice("当前任务运行中，结束后再新建会话");
    return;
  }
  const entryId = targetEntryId.trim();
  if (!entryId) return;

  let derivation: Awaited<
    ReturnType<CodexForObsidianPlugin["derivePiConversation"]>
  >;
  try {
    derivation = await host.plugin.derivePiConversation({
      sourceConversationId: session.id,
      targetConversationId: newId("conversation"),
      anchorEntryId: entryId,
      title: derivedConversationTitle(session, entryId)
    });
  } catch (error) {
    new Notice(`新建会话失败：${errorMessage(error)}`);
    return;
  }
  if (
    derivation.sourceConversationId !== session.id
    || derivation.projection.catalog.conversationId === session.id
  ) {
    new Notice("新建会话失败：派生结果没有独立会话身份");
    return;
  }

  const targetId = derivation.projection.catalog.conversationId;
  let derived = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === targetId
  );
  if (!derived) {
    derived = createPiConversationShell(host, derivation.projection.catalog);
    host.plugin.settings.sessions.push(derived);
  }
  applyPiConversationProjectionToShell(host, derived, derivation.projection);
  host.plugin.settings.activeSessionId = derived.id;
  host.inputEl.value = derivation.editorText;
  host.closeComposerMenus();
  host.attachments = [];
  host.selectedSkill = null;
  host.inputEl.focus();
  host.inputEl.setSelectionRange(
    derivation.editorText.length,
    derivation.editorText.length
  );
  renderConversationShellChange(host);
  try {
    await persistPiConversationShells(host);
  } catch (error) {
    new Notice(`新会话已创建，但界面状态保存失败：${errorMessage(error)}`);
  }
  if (derivation.activation.status === "failed") {
    new Notice(
      `会话已创建，但 Agent 暂未激活：${derivation.activation.message}`
    );
    return;
  }
  new Notice(derivation.anchorRole === "user"
    ? "已新建会话，可编辑原提问后发送"
    : "已从所选回复新建会话");
}

function enqueueConversationTransition<T>(
  host: CodexSessionHost,
  transition: () => Promise<T>
): Promise<T> {
  const previous = conversationTransitionLanes.get(host);
  let result: Promise<T>;
  try {
    result = previous ? previous.then(transition) : transition();
  } catch (error) {
    result = Promise.reject(error instanceof Error
      ? error
      : new Error(String(error)));
  }
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  conversationTransitionLanes.set(host, settled);
  void settled.then(() => {
    if (conversationTransitionLanes.get(host) === settled) {
      conversationTransitionLanes.delete(host);
    }
  });
  return result;
}

export async function renameSession(host: CodexSessionHost, session: StoredSession): Promise<void> {
  const name = await textInputModal(host.app, "重命名会话", "名称", session.title);
  const title = name?.trim();
  if (!title) return;
  const catalogEntry = await host.plugin.renamePiConversation(
    session.id,
    title
  );
  applyPiCatalogEntryToShell(session, catalogEntry);
  await persistPiConversationShells(host);
  host.renderTabs();
}

export async function archiveSession(
  host: CodexSessionHost,
  sessionId: string,
  options: ConversationRecordMutationUiOptions = {}
): Promise<void> {
  const session = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === sessionId
  );
  if (!session) return;
  if (host.running && host.activeRunSessionId === session.id) {
    new Notice("当前会话正在运行，结束后再归档");
    return;
  }
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  const accepted = await confirm(
    `归档会话“${session.title}”？`,
    "会话会从当前列表隐藏，但 Pi Session JSONL 和完整时间线会保留。",
    "归档",
    "取消"
  );
  if (!accepted) return;
  const fallbackGeneration =
    host.plugin.settings.activeSessionId === session.id
      || isConversationSelectionTarget(host, session.id)
      ? beginConversationSelection(host)
      : undefined;
  await host.plugin.setPiConversationStatus(session.id, "archived");
  host.turnQueue.clearSessionQueue(session.id);
  removeConversationShell(host, session.id);
  const fallbackError = await activateFallbackConversation(
    host,
    fallbackGeneration
  );
  await persistPiConversationShells(host);
  renderConversationShellChange(host);
  new Notice(
    fallbackError
      ? `会话已归档；打开后续会话失败：${errorMessage(fallbackError)}`
      : "会话已归档，Pi Session 记录已保留"
  );
}

export async function deleteSession(host: CodexSessionHost, sessionId: string): Promise<void> {
  await deleteSessions(host, [sessionId]);
}

export async function restoreArchivedConversation(
  host: CodexSessionHost,
  entry: Readonly<PiConversationCatalogEntry>
): Promise<boolean> {
  const restored = await host.plugin.setPiConversationStatus(entry.conversationId, "active");
  const existing = host.plugin.settings.sessions.find(
    (session) => session.id === restored.conversationId
  );
  if (existing) applyPiCatalogEntryToShell(existing, restored);
  else host.plugin.settings.sessions.push(createPiConversationShell(host, restored));
  await persistPiConversationShells(host);
  new Notice(`已恢复会话“${entry.title}”`);
  return true;
}

export async function deleteArchivedConversation(
  host: CodexSessionHost,
  entry: Readonly<PiConversationCatalogEntry>,
  options: ConversationRecordMutationUiOptions = {}
): Promise<boolean> {
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  const accepted = await confirm(
    `删除已归档会话“${entry.title}”？`,
    "会话会从 EchoInk 列表移除，但 Pi Session JSONL 不会删除。",
    "删除",
    "取消"
  );
  if (!accepted) return false;
  await host.plugin.setPiConversationStatus(entry.conversationId, "deleted");
  new Notice(`已删除“${entry.title}”；Pi Session JSONL 已保留`);
  return true;
}

type ConversationRecordMutationConfirm = (
  title: string,
  body: string,
  acceptText: string,
  declineText: string
) => Promise<boolean>;

interface ConversationRecordMutationUiOptions {
  confirm?: ConversationRecordMutationConfirm;
}

export async function confirmDeleteSessions(host: CodexSessionHost, sessionIds: string[]): Promise<void> {
  await deleteSessions(host, sessionIds);
}

export async function deleteSessions(
  host: CodexSessionHost,
  sessionIds: string[],
  options: ConversationRecordMutationUiOptions = {}
): Promise<void> {
  const candidates = deletableSessions(host, sessionIds);
  if (!candidates.length) {
    new Notice("所选会话不可删除；知识库和运行中会话会被保留");
    return;
  }
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  let committedCount = 0;
  let fallbackGeneration: number | undefined;
  for (const session of candidates) {
    try {
      const accepted = await confirm(
        `删除会话“${session.title}”？`,
        "会话会从 EchoInk 列表移除，但 Pi Session JSONL 不会删除。",
        "删除",
        "取消"
      );
      if (!accepted) continue;
      if (
        host.running
        && host.activeRunSessionId === session.id
      ) {
        new Notice(`“${session.title}”正在运行，已跳过删除`);
        continue;
      }
      if (
        host.plugin.settings.activeSessionId === session.id
        || isConversationSelectionTarget(host, session.id)
      ) {
        fallbackGeneration = beginConversationSelection(host);
      }
      await host.plugin.setPiConversationStatus(session.id, "deleted");
      committedCount += 1;
      host.turnQueue.clearSessionQueue(session.id);
      removeConversationShell(host, session.id);
    } catch (error) {
      new Notice(
        `删除“${session.title}”失败：${errorMessage(error)}`
      );
    }
  }
  if (committedCount) {
    const fallbackError = await activateFallbackConversation(
      host,
      fallbackGeneration
    );
    await persistPiConversationShells(host);
    renderConversationShellChange(host);
    new Notice(
      fallbackError
        ? `已删除 ${committedCount} 个会话并保留 Pi Session；打开后续会话失败：${errorMessage(fallbackError)}`
        : `已删除 ${committedCount} 个会话；Pi Session JSONL 已保留`
    );
  }
}

function defaultRecordMutationConfirm(
  host: CodexSessionHost
): ConversationRecordMutationConfirm {
  return async (title, body, acceptText, declineText) =>
    await confirmModal(
      host.app,
      title,
      body,
      acceptText,
      declineText
    );
}

function renderConversationShellChange(
  host: CodexSessionHost
): void {
  releaseInactiveConversationBodies(host);
  host.resetVirtualWindow();
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  host.updateInputPlaceholder();
}

/**
 * Pi Session JSONL is the durable authority for every conversation body.
 * Keep only the currently open shell and an in-flight run resident so a long
 * history cannot retain every projected message array in the UI process.
 */
function releaseInactiveConversationBodies(host: CodexSessionHost): void {
  const retainedSessionIds = new Set<string>();
  if (host.plugin.settings.activeSessionId) {
    retainedSessionIds.add(host.plugin.settings.activeSessionId);
  }
  if (host.running && host.activeRunSessionId) {
    retainedSessionIds.add(host.activeRunSessionId);
  }
  for (const session of host.plugin.settings.sessions) {
    if (!retainedSessionIds.has(session.id) && session.messages.length > 0) {
      session.messages = [];
    }
  }
}

function deletableSessions(host: CodexSessionHost, sessionIds: string[]): StoredSession[] {
  const requested = new Set(sessionIds);
  return host.plugin.settings.sessions.filter((session) => {
    if (!requested.has(session.id)) return false;
    return !(host.running && host.activeRunSessionId === session.id);
  });
}

export function ensureSession(host: CodexSessionHost): StoredSession {
  const session = selectActiveConversationSession(host.plugin.settings);
  if (session) return session;
  throw new Error("Pi Conversation Catalog 中没有可打开的普通会话");
}

export async function ensureInitialConversation(
  host: CodexSessionHost
): Promise<{ session: StoredSession; created: boolean }> {
  const existing = selectActiveConversationSession(host.plugin.settings);
  if (existing) return { session: existing, created: false };
  return {
    session: await createSession(host),
    created: true
  };
}

export async function createSession(
  host: CodexSessionHost,
  title = "新会话"
): Promise<StoredSession> {
  return await createSessionForSelection(
    host,
    title,
    beginConversationSelection(host)
  );
}

async function createSessionForSelection(
  host: CodexSessionHost,
  title: string,
  generation: number
): Promise<StoredSession> {
  const conversationId = newId("conversation");
  bindConversationSelectionTarget(host, generation, conversationId);
  const catalogEntry = await host.plugin.createPiConversation({
    conversationId,
    title,
    cwd: host.plugin.getVaultPath(),
    defaultMemoryMode: "normal"
  });
  const session = createPiConversationShell(host, catalogEntry);
  host.plugin.settings.sessions.push(session);
  const outcome = await enqueueConversationTransition(
    host,
    async () => await activateSessionInTransitionLane(
      host,
      session,
      generation
    )
  );
  await persistPiConversationShells(host);
  if (outcome.status === "selected" && "error" in outcome) {
    throw outcome.error;
  }
  return session;
}

function derivedConversationTitle(
  source: StoredSession,
  anchorEntryId: string
): string {
  const anchorIndex = source.messages.findIndex(
    (message) => piEntryIdFromProjectedMessageId(message.id) === anchorEntryId
  );
  const anchor = source.messages[anchorIndex];
  const intent = anchor?.role === "user"
    ? anchor
    : source.messages
      .slice(0, Math.max(0, anchorIndex + 1))
      .reverse()
      .find((message) => message.role === "user");
  const preview = (intent?.text || intent?.previewText || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (preview) {
    const clipped = preview.length > 28
      ? `${preview.slice(0, 27)}…`
      : preview;
    return `新会话 · ${clipped}`;
  }
  const sourceTitle = source.title.trim();
  return !sourceTitle || sourceTitle === "新会话"
    ? "新会话"
    : `继续 · ${sourceTitle}`;
}

export function sessionById(host: CodexSessionHost, sessionId: string): StoredSession | null {
  return host.plugin.settings.sessions.find((session) => session.id === sessionId) ?? null;
}

export function activeRunSession(host: CodexSessionHost): StoredSession {
  const active = host.activeRunSessionId ? host.plugin.settings.sessions.find((session) => session.id === host.activeRunSessionId) : null;
  return active ?? ensureSession(host);
}

function createPiConversationShell(
  host: CodexSessionHost,
  catalogEntry: Readonly<PiConversationCatalogEntry>
): StoredSession {
  return applyPiCatalogEntryToShell({
    id: catalogEntry.conversationId,
    title: catalogEntry.title,
    cwd: host.plugin.getVaultPath(),
    messages: [],
    createdAt: catalogEntry.createdAt,
    updatedAt: catalogEntry.updatedAt
  }, catalogEntry);
}

function applyPiCatalogEntryToShell(
  shell: StoredSession,
  catalogEntry: Readonly<PiConversationCatalogEntry>
): StoredSession {
  shell.title = catalogEntry.title;
  shell.piSessionId = catalogEntry.piSessionId;
  shell.defaultMemoryMode = catalogEntry.defaultMemoryMode;
  shell.bodyAuthority = "pi_session_only";
  shell.createdAt = catalogEntry.createdAt;
  shell.updatedAt = catalogEntry.updatedAt;
  return shell;
}

function applyPiConversationProjectionToShell(
  host: CodexSessionHost,
  shell: StoredSession,
  projection: Readonly<PiConversationProjection>
): void {
  rememberPiConversationProjection(host.plugin, projection);
  applyPiCatalogEntryToShell(shell, projection.catalog);
  shell.messages = structuredClone(projection.messages);
  if (projection.contextLedger) {
    shell.contextLedger = structuredClone(projection.contextLedger);
  } else {
    delete shell.contextLedger;
  }
}

function removeConversationShell(
  host: CodexSessionHost,
  conversationId: string
): void {
  host.plugin.settings.sessions = host.plugin.settings.sessions.filter(
    (session) => session.id !== conversationId
  );
}

async function activateFallbackConversation(
  host: CodexSessionHost,
  selectionGeneration?: number
): Promise<Error | null> {
  const active = host.plugin.settings.sessions.find(
    (session) => session.id === host.plugin.settings.activeSessionId
  );
  if (active) return null;
  const generation = selectionGeneration
    ?? beginConversationSelection(host);
  if (!isCurrentConversationSelection(host, generation)) return null;
  const fallback = host.plugin.settings.sessions[0];
  if (!fallback) {
    try {
      await createSessionForSelection(host, "新会话", generation);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!bindConversationSelectionTarget(host, generation, fallback.id)) {
    return null;
  }
  const outcome = await enqueueConversationTransition(
    host,
    async () => await activateSessionInTransitionLane(
      host,
      fallback,
      generation
    )
  );
  if (outcome.status === "stale" || !("error" in outcome)) return null;
  return outcome.error instanceof Error
    ? outcome.error
    : new Error(String(outcome.error));
}

async function persistPiConversationShells(
  host: CodexSessionHost
): Promise<void> {
  await host.plugin.saveSettings(true, {
    flushConversationStore: false
  });
}

function conversationShellFingerprint(host: CodexSessionHost): string {
  return JSON.stringify({
    activeSessionId: host.plugin.settings.activeSessionId,
    sessions: host.plugin.settings.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      piSessionId: session.piSessionId,
      defaultMemoryMode: session.defaultMemoryMode,
      bodyAuthority: session.bodyAuthority,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    }))
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
