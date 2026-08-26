import { setIcon } from "obsidian";
import type { StoredSession } from "../../settings/settings";

export interface CodexTabsCallbacks {
  onActivate: (session: StoredSession) => void;
  onContextMenu: (event: MouseEvent, session: StoredSession) => void;
  onRename: (session: StoredSession) => void;
  onDeleteSessions: (sessionIds: string[]) => void;
  onCreateSession: () => void;
}

export interface CodexSessionNavigatorModel {
  activeSession: StoredSession | null;
  /** Stable creation order for the compact numeric tabs. */
  tabSessions: StoredSession[];
  /** Most-recent-first order for the full session picker. */
  chatSessions: StoredSession[];
  chatCount: number;
  runningSessionId: string;
}

interface CodexSessionNavigatorState {
  open: boolean;
  managing: boolean;
  query: string;
  selectedIds: Set<string>;
  focusedIndex: number;
  /** Least-recently-used to most-recently-used compact Tab UI state. */
  tabUiStateIds: string[];
  visibleSessionCount: number;
  trackRovingSessionId: string;
  backwardFocused: boolean;
  forwardFocused: boolean;
  trackScrollLeft: number;
  trackScrollRestored: boolean;
  suppressTrackClickUntil: number;
  activationDismissedSummarySessionId: string;
  lastActiveSessionId: string;
  renderGeneration: number;
  focusRequestSequence: number;
  pendingFocusRequest: SessionNavigatorFocusRequest | null;
  trackCleanup?: () => void;
}

type SessionNavigatorFocusTarget =
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ kind: "backward" }>
  | Readonly<{ kind: "forward" }>;

interface SessionNavigatorFocusRequest {
  readonly token: number;
  readonly target: SessionNavigatorFocusTarget;
}

export interface SessionTrackGeometry {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface SessionTrackItemGeometry {
  offsetLeft: number;
  offsetWidth: number;
}

interface SessionTrackMouseDrag {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  dragged: boolean;
}

const SESSION_TRACK_MOUSE_DRAG_THRESHOLD = 6;
const SESSION_TRACK_CLICK_SUPPRESSION_MS = 250;
export const MAX_SESSION_TAB_UI_STATES = 40;
export const SESSION_PICKER_BATCH_SIZE = 50;

const navigatorStates = new WeakMap<HTMLElement, CodexSessionNavigatorState>();

/**
 * Retain presentation state for at most the recent Tab budget. The durable
 * session catalog is never changed here; callers use the result only to
 * decide which compact Tab controls to render.
 */
export function retainSessionTabUiStateIds(
  sessions: readonly Pick<StoredSession, "id" | "createdAt" | "updatedAt">[],
  previousIds: readonly string[],
  activeSessionId: string,
  runningSessionId = "",
  maximum = MAX_SESSION_TAB_UI_STATES
): string[] {
  const liveIds = new Set(sessions.map((session) => session.id));
  const limit = Math.max(1, Math.floor(maximum));
  let retained = [...new Set(previousIds.filter((id) => liveIds.has(id)))];
  if (retained.length === 0 && sessions.length > 0) {
    retained = [...sessions]
      .sort(compareSessionUseAscending)
      .slice(-limit)
      .map((session) => session.id);
  }
  for (const sessionId of [runningSessionId, activeSessionId]) {
    if (!sessionId || !liveIds.has(sessionId)) continue;
    retained = retained.filter((id) => id !== sessionId);
    retained.push(sessionId);
  }
  const protectedIds = new Set(
    [activeSessionId, runningSessionId].filter((id) => liveIds.has(id))
  );
  while (retained.length > limit) {
    const evictedIndex = retained.findIndex((id) => !protectedIds.has(id));
    if (evictedIndex < 0) break;
    retained.splice(evictedIndex, 1);
  }
  return retained;
}

export function visibleSessionPickerRows<T>(
  sessions: readonly T[],
  requestedCount: number
): T[] {
  const normalizedCount = Number.isFinite(requestedCount)
    ? Math.max(SESSION_PICKER_BATCH_SIZE, Math.floor(requestedCount))
    : SESSION_PICKER_BATCH_SIZE;
  return sessions.slice(0, Math.min(sessions.length, normalizedCount));
}

export function nextSessionPickerVisibleCount(
  requestedCount: number,
  totalCount: number
): number {
  const total = Number.isFinite(totalCount)
    ? Math.max(0, Math.floor(totalCount))
    : 0;
  const visibleCount = Number.isFinite(requestedCount)
    ? Math.max(SESSION_PICKER_BATCH_SIZE, Math.floor(requestedCount))
    : SESSION_PICKER_BATCH_SIZE;
  return Math.min(
    total,
    visibleCount + SESSION_PICKER_BATCH_SIZE
  );
}

export function buildCodexSessionNavigatorModel(
  sessions: StoredSession[],
  activeSessionId: string,
  runningSessionId = "",
  query = ""
): CodexSessionNavigatorModel {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const matchingSessions = sessions.filter((session) =>
    !normalizedQuery || session.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
  );
  const tabSessions = [...matchingSessions]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id, "zh-CN"));
  const chatSessions = [...matchingSessions]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.title.localeCompare(right.title, "zh-CN"));
  return {
    activeSession: sessions.find((session) =>
      session.id === activeSessionId
    ) ?? null,
    tabSessions,
    chatSessions,
    chatCount: sessions.length,
    runningSessionId
  };
}

function compareSessionUseAscending(
  left: Pick<StoredSession, "id" | "createdAt" | "updatedAt">,
  right: Pick<StoredSession, "id" | "createdAt" | "updatedAt">
): number {
  return left.updatedAt - right.updatedAt
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id, "zh-CN");
}

export function formatSessionUpdatedAt(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "较早";
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;

  const updated = new Date(updatedAt);
  const current = new Date(now);
  if (sameLocalDate(updated, current)) return `今天 ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;

  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameLocalDate(updated, yesterday)) return "昨天";
  if (updated.getFullYear() === current.getFullYear()) return `${updated.getMonth() + 1} 月 ${updated.getDate()} 日`;
  return `${updated.getFullYear()}/${updated.getMonth() + 1}/${updated.getDate()}`;
}

/**
 * Local-only session preview used by the host tooltip. Tool, process, system,
 * and hidden Pi content are deliberately excluded.
 */
export function sessionSummaryTooltip(
  session: Pick<
    StoredSession,
    "title" | "messages" | "updatedAt"
  >,
  now = Date.now()
): string {
  const title = normalizedSessionPreviewLine(session.title) || "未命名会话";
  const firstUserIntent = session.messages.find((message) =>
    message.role === "user"
    && Boolean(normalizedSessionPreviewLine(message.text || message.previewText || ""))
  );
  const intent = firstUserIntent
    ? clippedSessionPreviewLine(
      normalizedSessionPreviewLine(
        firstUserIntent.text || firstUserIntent.previewText || ""
      ),
      120
    )
    : "尚无用户提问";
  return `${title}\n首条提问：${intent}\n更新：${formatSessionUpdatedAt(session.updatedAt, now)}`;
}

export function sessionTrackOverflowState(
  geometry: SessionTrackGeometry
): Readonly<{
  hasOverflow: boolean;
  canRetreat: boolean;
  canAdvance: boolean;
  atStart: boolean;
  atEnd: boolean;
}> {
  const scrollLeft = finiteNonNegativeGeometry(geometry.scrollLeft);
  const clientWidth = finiteNonNegativeGeometry(geometry.clientWidth);
  const scrollWidth = finiteNonNegativeGeometry(geometry.scrollWidth);
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const hasOverflow = maxScrollLeft > 1;
  const atStart = !hasOverflow || scrollLeft <= 1;
  const atEnd = maxScrollLeft <= 1 || scrollLeft >= maxScrollLeft - 1;
  return Object.freeze({
    hasOverflow,
    canRetreat: hasOverflow && !atStart,
    canAdvance: hasOverflow && !atEnd,
    atStart,
    atEnd
  });
}

/** Return the stable left edge of the next item clipped by the right edge. */
export function nextHiddenSessionTrackOffset(
  viewport: Pick<SessionTrackGeometry, "scrollLeft" | "clientWidth">,
  items: readonly SessionTrackItemGeometry[]
): number | null {
  const scrollLeft = finiteNonNegativeGeometry(viewport.scrollLeft);
  const clientWidth = finiteNonNegativeGeometry(viewport.clientWidth);
  if (clientWidth <= 0) return null;
  const visibleRight = scrollLeft + clientWidth;
  const hidden = items.find((item) => {
    const offsetLeft = finiteNonNegativeGeometry(item.offsetLeft);
    const offsetWidth = finiteNonNegativeGeometry(item.offsetWidth);
    return offsetWidth > 0 && offsetLeft + offsetWidth > visibleRight + 1;
  });
  if (!hidden) return null;
  const hiddenLeft = finiteNonNegativeGeometry(hidden.offsetLeft);
  if (hiddenLeft > scrollLeft + 1) return hiddenLeft;
  return scrollLeft + Math.max(1, Math.floor(clientWidth * 0.8));
}

/** Return the stable left edge of the previous item clipped by the left edge. */
export function previousHiddenSessionTrackOffset(
  viewport: Pick<SessionTrackGeometry, "scrollLeft">,
  items: readonly SessionTrackItemGeometry[]
): number | null {
  const scrollLeft = finiteNonNegativeGeometry(viewport.scrollLeft);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const offsetLeft = finiteNonNegativeGeometry(item.offsetLeft);
    const offsetWidth = finiteNonNegativeGeometry(item.offsetWidth);
    if (offsetWidth > 0 && offsetLeft < scrollLeft - 1) return offsetLeft;
  }
  return null;
}

export function clampSessionTrackScrollLeft(
  scrollLeft: number,
  geometry: Pick<SessionTrackGeometry, "clientWidth" | "scrollWidth">
): number {
  const maxScrollLeft = Math.max(
    0,
    finiteNonNegativeGeometry(geometry.scrollWidth)
      - finiteNonNegativeGeometry(geometry.clientWidth)
  );
  return Math.min(maxScrollLeft, finiteNonNegativeGeometry(scrollLeft));
}

/** Return the shortest offset that makes a clipped item visible, if needed. */
export function minimallyRevealSessionTrackOffset(
  viewport: SessionTrackGeometry,
  item: SessionTrackItemGeometry
): number | null {
  const scrollLeft = clampSessionTrackScrollLeft(viewport.scrollLeft, viewport);
  const clientWidth = finiteNonNegativeGeometry(viewport.clientWidth);
  const offsetLeft = finiteNonNegativeGeometry(item.offsetLeft);
  const offsetWidth = finiteNonNegativeGeometry(item.offsetWidth);
  if (clientWidth <= 0 || offsetWidth <= 0) return null;

  const visibleRight = scrollLeft + clientWidth;
  if (offsetLeft < scrollLeft - 1) {
    return clampSessionTrackScrollLeft(offsetLeft, viewport);
  }
  const offsetRight = offsetLeft + offsetWidth;
  if (offsetRight > visibleRight + 1) {
    return clampSessionTrackScrollLeft(offsetRight - clientWidth, viewport);
  }
  return null;
}

export function sessionTrackMouseDragExceededThreshold(
  startX: number,
  currentX: number,
  threshold = SESSION_TRACK_MOUSE_DRAG_THRESHOLD
): boolean {
  if (!Number.isFinite(startX) || !Number.isFinite(currentX)) return false;
  return Math.abs(currentX - startX) >= Math.max(0, threshold);
}

export function shouldSuppressSessionTrackClick(
  suppressUntil: number,
  now = Date.now()
): boolean {
  return Number.isFinite(suppressUntil) && suppressUntil > now;
}

export function renderCodexTabs(
  container: HTMLElement,
  sessions: StoredSession[],
  activeSessionId: string,
  callbacks: CodexTabsCallbacks,
  runningSessionId = ""
): void {
  const state = navigatorStateFor(container);
  state.backwardFocused = false;
  state.forwardFocused = false;
  captureSessionTrackFocus(container, state);
  captureSessionTrackScrollPosition(container, state);
  state.trackScrollRestored = false;
  state.trackCleanup?.();
  state.trackCleanup = undefined;
  const renderGeneration = state.renderGeneration + 1;
  state.renderGeneration = renderGeneration;
  const allModel = buildCodexSessionNavigatorModel(sessions, activeSessionId, runningSessionId);
  state.tabUiStateIds = retainSessionTabUiStateIds(
    sessions,
    state.tabUiStateIds,
    activeSessionId,
    runningSessionId
  );
  const retainedTabIds = new Set(state.tabUiStateIds);
  allModel.tabSessions = allModel.tabSessions.filter((session) =>
    retainedTabIds.has(session.id)
  );
  const validSessionIds = new Set(sessions.map((session) => session.id));
  const validTabIds = new Set(allModel.tabSessions.map((session) => session.id));
  state.selectedIds = new Set([...state.selectedIds].filter((sessionId) =>
    validSessionIds.has(sessionId) && sessionId !== runningSessionId
  ));
  const activeChanged = state.lastActiveSessionId !== activeSessionId;
  state.lastActiveSessionId = activeSessionId;
  if (
    !validTabIds.has(state.trackRovingSessionId)
    || (
      activeChanged
      && state.pendingFocusRequest?.target.kind !== "session"
    )
  ) {
    state.trackRovingSessionId = validTabIds.has(activeSessionId)
      ? activeSessionId
      : allModel.tabSessions[0]?.id ?? "";
  }

  const rerender = () => renderCodexTabs(
    container,
    sessions,
    activeSessionId,
    callbacks,
    runningSessionId
  );
  const activate = (session: StoredSession) => {
    markSessionTabUiStateUsed(state, session.id);
    state.trackRovingSessionId = session.id;
    callbacks.onActivate(session);
    state.open = false;
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
  };
  const createSession = () => {
    callbacks.onCreateSession();
    state.open = false;
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
    rerender();
  };

  container.empty();
  container.addClass("codex-session-navigator");

  const summaryTooltip = container.createDiv({
    cls: "codex-session-summary-tooltip",
    attr: {
      role: "tooltip",
      "aria-hidden": "true"
    }
  });
  let tooltipAnchor: HTMLElement | null = null;
  const showSummary = (tab: HTMLElement, summary: string) => {
    tooltipAnchor = tab;
    showSessionSummaryTooltip(container, summaryTooltip, tab, summary);
  };
  const hideSummary = (tab: HTMLElement) => {
    if (tooltipAnchor !== tab) return;
    tooltipAnchor = null;
    summaryTooltip.removeClass("is-visible");
    summaryTooltip.setAttribute("aria-hidden", "true");
  };

  const track = container.createDiv({
    cls: "codex-session-track",
    attr: {
      role: "tablist",
      "aria-label": "会话切换",
      "aria-orientation": "horizontal"
    }
  });
  const tabElements: HTMLElement[] = [];
  for (const [index, session] of allModel.tabSessions.entries()) {
    const active = session.id === activeSessionId;
    const tabStop = session.id === state.trackRovingSessionId;
    const running = session.id === runningSessionId;
    const summary = sessionSummaryTooltip(session);
    const tab = track.createEl("button", {
      cls: [
        "codex-session-tab",
        active ? "is-active" : "",
        running ? "is-running" : ""
      ].filter(Boolean).join(" "),
      attr: {
        type: "button",
        role: "tab",
        "data-session-id": session.id,
        "aria-selected": String(active),
        "aria-label": session.title || "未命名会话",
        "aria-description": summary,
        tabindex: tabStop ? "0" : "-1"
      }
    });
    let pointerActivationPending = false;
    tab.onmouseenter = () => {
      if (state.activationDismissedSummarySessionId === session.id) return;
      state.activationDismissedSummarySessionId = "";
      showSummary(tab, summary);
    };
    tab.onmouseleave = () => {
      pointerActivationPending = false;
      if (state.activationDismissedSummarySessionId === session.id) {
        state.activationDismissedSummarySessionId = "";
      }
      if (!tab.matches(":focus-visible")) {
        hideSummary(tab);
      }
    };
    tab.onfocus = () => {
      state.backwardFocused = false;
      state.forwardFocused = false;
      reconcileFocusedSessionNavigatorTarget(state, {
        kind: "session",
        sessionId: session.id
      });
      setSessionTabStop(tabElements, tab, state);
      revealSessionTrackItemMinimally(track, tab, state);
      if (
        tab.matches(":focus-visible")
        && state.activationDismissedSummarySessionId !== session.id
      ) {
        state.activationDismissedSummarySessionId = "";
        showSummary(tab, summary);
      }
    };
    tab.onblur = () => hideSummary(tab);
    tab.onpointerdown = (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      pointerActivationPending = true;
      state.activationDismissedSummarySessionId = session.id;
      hideSummary(tab);
    };
    tab.onpointercancel = () => {
      pointerActivationPending = false;
      if (state.activationDismissedSummarySessionId === session.id) {
        state.activationDismissedSummarySessionId = "";
      }
    };
    tab.createSpan({ cls: "codex-session-tab-title", text: String(index + 1) });
    tab.onclick = (event) => {
      if (!shouldSuppressSessionTrackClick(state.suppressTrackClickUntil)) {
        const pointerActivation = pointerActivationPending || event.detail > 0;
        pointerActivationPending = false;
        if (pointerActivation) {
          state.activationDismissedSummarySessionId = session.id;
          hideSummary(tab);
        } else {
          state.activationDismissedSummarySessionId = "";
        }
        activate(session);
        return;
      }
      pointerActivationPending = false;
      if (state.activationDismissedSummarySessionId === session.id) {
        state.activationDismissedSummarySessionId = "";
      }
      event.preventDefault();
      event.stopPropagation();
    };
    tab.oncontextmenu = (event) => callbacks.onContextMenu(event, session);
    tab.ondblclick = (event) => {
      if (shouldSuppressSessionTrackClick(state.suppressTrackClickUntil)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      callbacks.onRename(session);
    };
    tab.onkeydown = (event) => handleSessionTabKeyDown(
      event,
      tabElements,
      index,
      state
    );
    tabElements.push(tab);
  }

  const trackControls = container.createDiv({
    cls: "codex-session-track-controls",
    attr: {
      role: "group",
      "aria-label": "会话导航",
      "aria-hidden": "true"
    }
  });
  const backwardButton = trackControls.createEl("button", {
    cls: "codex-session-track-control codex-session-backward",
    attr: {
      type: "button",
      "aria-label": "向左查看更多会话",
      title: "向左查看更多会话"
    }
  });
  setIcon(backwardButton, "chevron-left");
  backwardButton.disabled = true;
  backwardButton.onfocus = () => {
    state.backwardFocused = true;
    state.forwardFocused = false;
    reconcileFocusedSessionNavigatorTarget(state, { kind: "backward" });
  };
  backwardButton.onblur = () => {
    state.backwardFocused = false;
  };

  const forwardButton = trackControls.createEl("button", {
    cls: "codex-session-track-control codex-session-forward",
    attr: {
      type: "button",
      "aria-label": "向右查看更多会话",
      title: "向右查看更多会话"
    }
  });
  setIcon(forwardButton, "chevron-right");
  forwardButton.disabled = true;
  forwardButton.onfocus = () => {
    state.backwardFocused = false;
    state.forwardFocused = true;
    reconcileFocusedSessionNavigatorTarget(state, { kind: "forward" });
  };
  forwardButton.onblur = () => {
    state.forwardFocused = false;
  };

  const updateTrackOverflow = () => {
    if (!state.trackScrollRestored) {
      state.trackScrollRestored = restoreSessionTrackScrollPosition(track, state);
    }
    if (state.trackScrollRestored) {
      rememberSessionTrackScrollPosition(track, state);
    }
    const overflow = sessionTrackOverflowState(track);
    if ((!overflow.hasOverflow || !overflow.canRetreat) && state.backwardFocused) {
      const fallback = tabElements[0];
      if (fallback) {
        state.pendingFocusRequest = null;
        setSessionTabStop(tabElements, fallback, state);
        state.backwardFocused = false;
        revealSessionTrackItemMinimally(track, fallback, state);
        fallback.focus();
      }
    }
    if (!overflow.canAdvance && state.forwardFocused) {
      const fallback = tabElements.at(-1);
      if (fallback) {
        state.pendingFocusRequest = null;
        setSessionTabStop(tabElements, fallback, state);
        state.forwardFocused = false;
        revealSessionTrackItemMinimally(track, fallback, state);
        fallback.focus();
      }
    }
    trackControls.toggleClass("is-visible", overflow.hasOverflow);
    trackControls.setAttribute("aria-hidden", String(!overflow.hasOverflow));
    backwardButton.disabled = !overflow.canRetreat;
    forwardButton.disabled = !overflow.canAdvance;
    if (tooltipAnchor) {
      showSessionSummaryTooltip(
        container,
        summaryTooltip,
        tooltipAnchor,
        summaryTooltip.textContent ?? ""
      );
    }
  };
  backwardButton.onclick = () => {
    const target = previousHiddenSessionTrackOffset(
      track,
      sessionTrackItemGeometries(track, tabElements)
    );
    if (target === null) {
      updateTrackOverflow();
      return;
    }
    scrollSessionTrackTo(track, target);
    updateTrackOverflow();
  };
  forwardButton.onclick = () => {
    const target = nextHiddenSessionTrackOffset(
      track,
      sessionTrackItemGeometries(track, tabElements)
    );
    if (target === null) {
      updateTrackOverflow();
      return;
    }
    scrollSessionTrackTo(track, target);
    updateTrackOverflow();
  };
  track.onscroll = updateTrackOverflow;
  track.onwheel = (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const before = track.scrollLeft;
    track.scrollLeft += event.deltaY;
    if (track.scrollLeft !== before) event.preventDefault();
    updateTrackOverflow();
  };

  let mouseDrag: SessionTrackMouseDrag | null = null;
  const finishMouseDrag = (event: PointerEvent) => {
    if (!mouseDrag || mouseDrag.pointerId !== event.pointerId) return;
    const dragged = mouseDrag.dragged;
    mouseDrag = null;
    track.removeClass("is-dragging");
    if (dragged) {
      state.suppressTrackClickUntil = Date.now() + SESSION_TRACK_CLICK_SUPPRESSION_MS;
    }
  };
  track.onpointerdown = (event) => {
    if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0) return;
    mouseDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: track.scrollLeft,
      dragged: false
    };
  };
  track.onpointermove = (event) => {
    if (!mouseDrag || mouseDrag.pointerId !== event.pointerId) return;
    if (!mouseDrag.dragged && !sessionTrackMouseDragExceededThreshold(mouseDrag.startX, event.clientX)) {
      return;
    }
    if (!mouseDrag.dragged) {
      mouseDrag.dragged = true;
      track.addClass("is-dragging");
      if (typeof track.setPointerCapture === "function") {
        track.setPointerCapture(event.pointerId);
      }
    }
    const before = track.scrollLeft;
    track.scrollLeft = mouseDrag.startScrollLeft - (event.clientX - mouseDrag.startX);
    if (track.scrollLeft !== before) event.preventDefault();
    updateTrackOverflow();
  };
  track.onpointerup = finishMouseDrag;
  track.onpointercancel = finishMouseDrag;
  track.onlostpointercapture = finishMouseDrag;

  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(updateTrackOverflow);
    resizeObserver.observe(track);
  }
  state.trackCleanup = () => {
    resizeObserver?.disconnect();
    track.onscroll = null;
    track.onwheel = null;
    track.onpointerdown = null;
    track.onpointermove = null;
    track.onpointerup = null;
    track.onpointercancel = null;
    track.onlostpointercapture = null;
  };

  const allButton = container.createEl("button", {
    cls: `codex-session-all ${state.open ? "is-active" : ""}`.trim(),
    attr: {
      type: "button",
      title: "查看全部会话",
      "aria-label": `查看全部 ${allModel.chatCount} 个会话`,
      "aria-expanded": state.open ? "true" : "false"
    }
  });
  const allIcon = allButton.createSpan({ cls: "codex-session-all-icon" });
  setIcon(allIcon, "list");
  allButton.createSpan({ cls: "codex-session-all-text", text: "全部" });
  allButton.createSpan({ cls: "codex-session-count", text: String(allModel.chatCount) });
  allButton.onfocus = () => {
    state.pendingFocusRequest = null;
    state.backwardFocused = false;
    state.forwardFocused = false;
  };
  allButton.onclick = () => toggleSessionPicker(state, rerender);

  const newButton = container.createEl("button", {
    cls: "codex-tab-new codex-session-new",
    attr: {
      type: "button",
      "aria-label": "新建会话",
      title: "新建会话"
    }
  });
  setIcon(newButton, "plus");
  newButton.onfocus = () => {
    state.pendingFocusRequest = null;
    state.backwardFocused = false;
    state.forwardFocused = false;
  };
  newButton.onclick = createSession;

  scheduleSessionTrackSync({
    state,
    renderGeneration,
    track,
    activeTab: tabElements.find((tab) =>
      tab.getAttribute("aria-selected") === "true"
    ) ?? null,
    tabs: tabElements,
    backwardButton,
    forwardButton,
    allButton,
    newButton,
    updateOverflow: updateTrackOverflow
  });

  if (state.open) {
    renderSessionPicker(container, sessions, activeSessionId, runningSessionId, callbacks, state, activate, rerender);
  }
}

function renderSessionPicker(
  container: HTMLElement,
  sessions: StoredSession[],
  activeSessionId: string,
  runningSessionId: string,
  callbacks: CodexTabsCallbacks,
  state: CodexSessionNavigatorState,
  activate: (session: StoredSession) => void,
  rerender: () => void
): void {
  const backdrop = container.createEl("button", {
    cls: "codex-session-picker-backdrop",
    attr: {
      type: "button",
      "aria-label": "关闭全部会话"
    }
  });
  backdrop.onclick = () => closeSessionPicker(state, rerender);

  const picker = container.createDiv({
    cls: "codex-session-picker",
    attr: {
      role: "dialog",
      "aria-label": "全部会话",
      "aria-modal": "false"
    }
  });
  const header = picker.createDiv({ cls: "codex-session-picker-header" });
  const heading = header.createDiv({ cls: "codex-session-picker-heading" });
  const headingLine = heading.createDiv({ cls: "codex-session-picker-title-line" });
  headingLine.createEl("h2", { text: "全部会话" });
  const totalCount = sessions.length;
  headingLine.createSpan({ cls: "codex-session-count", text: String(totalCount) });
  heading.createDiv({ cls: "codex-session-picker-subtitle", text: "按最近使用排序" });

  const headerActions = header.createDiv({ cls: "codex-session-picker-header-actions" });
  const manageButton = headerActions.createEl("button", {
    cls: `codex-session-manage ${state.managing ? "is-active" : ""}`.trim(),
    text: state.managing ? "完成" : "管理",
    attr: {
      type: "button",
      "aria-pressed": state.managing ? "true" : "false"
    }
  });
  manageButton.onclick = () => {
    state.managing = !state.managing;
    state.selectedIds.clear();
    state.focusedIndex = 0;
    rerender();
  };
  const closeButton = headerActions.createEl("button", {
    cls: "codex-session-picker-close",
    attr: {
      type: "button",
      "aria-label": "关闭全部会话",
      title: "关闭"
    }
  });
  setIcon(closeButton, "x");
  closeButton.onclick = () => closeSessionPicker(state, rerender);

  const searchWrap = picker.createDiv({ cls: "codex-session-search" });
  const searchIcon = searchWrap.createSpan({ cls: "codex-session-search-icon" });
  setIcon(searchIcon, "search");
  const searchInput = searchWrap.createEl("input", {
    cls: "codex-session-search-input",
    attr: {
      type: "search",
      placeholder: "搜索会话",
      "aria-label": "搜索会话",
      autocomplete: "off"
    }
  });
  searchInput.value = state.query;
  const searchHint = searchWrap.createEl("kbd", { text: "/" });
  const body = picker.createDiv({ cls: "codex-session-picker-body" });
  const footer = picker.createDiv({ cls: "codex-session-picker-footer" });

  let focusedRow: HTMLElement | null = null;
  const renderBody = () => {
    body.empty();
    footer.empty();
    focusedRow = null;
    const model = buildCodexSessionNavigatorModel(sessions, activeSessionId, runningSessionId, state.query);
    const selectableIds = model.chatSessions.filter((session) => session.id !== runningSessionId).map((session) => session.id);
    const selectableSet = new Set(selectableIds);
    state.selectedIds = new Set([...state.selectedIds].filter((sessionId) => selectableSet.has(sessionId)));
    const visibleSessions = visibleSessionPickerRows(
      model.chatSessions,
      state.visibleSessionCount
    );
    state.focusedIndex = Math.min(
      Math.max(0, state.focusedIndex),
      Math.max(0, visibleSessions.length - 1)
    );

    const sectionHeading = body.createDiv({ cls: "codex-session-section-heading" });
    sectionHeading.createDiv({ cls: "codex-session-section-label", text: "最近会话" });
    if (state.managing && selectableIds.length > 0) {
      const allSelected = selectableIds.every((sessionId) => state.selectedIds.has(sessionId));
      const selectAllButton = sectionHeading.createEl("button", {
        cls: "codex-session-select-all",
        text: allSelected ? "取消全选" : `全选可删除 ${selectableIds.length} 项`,
        attr: { type: "button" }
      });
      selectAllButton.onclick = () => {
        state.selectedIds = allSelected ? new Set() : new Set(selectableIds);
        renderBody();
      };
    }

    const list = body.createDiv({
      cls: "codex-session-list",
      attr: {
        role: "listbox",
        "aria-label": "会话列表",
        "aria-multiselectable": state.managing ? "true" : "false"
      }
    });
    for (const [index, session] of visibleSessions.entries()) {
      const running = session.id === runningSessionId;
      const active = session.id === activeSessionId;
      const selected = state.selectedIds.has(session.id);
      const row = list.createDiv({
        cls: [
          "codex-session-row",
          active ? "is-active" : "",
          index === state.focusedIndex ? "is-focused" : "",
          running ? "is-running" : ""
        ].filter(Boolean).join(" "),
        attr: {
          role: "option",
          tabindex: "-1",
          title: session.title,
          "data-session-id": session.id,
          "aria-selected": state.managing ? (selected ? "true" : "false") : (active ? "true" : "false")
        }
      });
      if (index === state.focusedIndex) focusedRow = row;

      if (state.managing) {
        const checkbox = row.createEl("button", {
          cls: `codex-session-checkbox ${selected ? "is-selected" : ""}`.trim(),
          attr: {
            type: "button",
            "aria-label": running ? `${session.title} 正在运行，不能选择` : `选择 ${session.title}`,
            "aria-pressed": selected ? "true" : "false"
          }
        });
        checkbox.disabled = running;
        if (selected) setIcon(checkbox, "check");
        checkbox.onclick = (event) => {
          event.stopPropagation();
          if (!running) toggleSelectedSession(state, session.id, renderBody);
        };
      } else {
        const leading = row.createSpan({ cls: "codex-session-row-leading" });
        if (running) {
          setIcon(leading, "loader-circle");
          leading.addClass("is-spinning");
        } else {
          leading.createSpan({ cls: active ? "codex-session-active-dot" : "codex-session-dot" });
        }
      }

      const copy = row.createDiv({ cls: "codex-session-row-copy" });
      copy.createDiv({ cls: "codex-session-row-title", text: session.title });
      const meta = copy.createDiv({ cls: "codex-session-row-meta" });
      meta.createSpan({ text: running ? "Agent 正在运行" : formatSessionUpdatedAt(session.updatedAt) });
      if (active) meta.createSpan({ cls: "codex-session-current-badge", text: "当前" });

      if (!state.managing) {
        const actions = row.createDiv({ cls: "codex-session-row-actions" });
        const renameButton = actions.createEl("button", {
          cls: "codex-session-row-action",
          attr: {
            type: "button",
            "aria-label": `重命名 ${session.title}`,
            title: "重命名"
          }
        });
        setIcon(renameButton, "pencil");
        renameButton.onclick = (event) => {
          event.stopPropagation();
          callbacks.onRename(session);
        };
        const deleteButton = actions.createEl("button", {
          cls: "codex-session-row-action is-danger",
          attr: {
            type: "button",
            "aria-label": running ? "运行中的会话不能删除" : `删除 ${session.title}`,
            title: running ? "运行中的会话不能删除" : "删除"
          }
        });
        deleteButton.disabled = running;
        setIcon(deleteButton, "trash-2");
        deleteButton.onclick = (event) => {
          event.stopPropagation();
          if (!running) callbacks.onDeleteSessions([session.id]);
        };
      }

      row.onclick = () => {
        state.focusedIndex = index;
        if (state.managing) {
          if (!running) toggleSelectedSession(state, session.id, renderBody);
        } else {
          activate(session);
        }
      };
      row.oncontextmenu = (event) => callbacks.onContextMenu(event, session);
      row.ondblclick = () => {
        if (!state.managing) callbacks.onRename(session);
      };
    }

    if (visibleSessions.length === 0) {
      const empty = list.createDiv({ cls: "codex-session-empty" });
      const emptyIcon = empty.createSpan();
      setIcon(emptyIcon, "search");
      empty.createDiv({ cls: "codex-session-empty-title", text: "没有找到会话" });
      empty.createDiv({ cls: "codex-session-empty-copy", text: "换一个关键词试试" });
    }

    if (visibleSessions.length < model.chatSessions.length) {
      const remaining = model.chatSessions.length - visibleSessions.length;
      const batchSize = Math.min(SESSION_PICKER_BATCH_SIZE, remaining);
      const loadMore = footer.createEl("button", {
        cls: "codex-session-load-more",
        text: `加载更多 ${batchSize} 条（剩余 ${remaining}）`,
        attr: {
          type: "button",
          "aria-label": `加载更多会话，剩余 ${remaining} 条`
        }
      });
      loadMore.onclick = () => {
        state.visibleSessionCount = nextSessionPickerVisibleCount(
          state.visibleSessionCount,
          model.chatSessions.length
        );
        renderBody();
      };
    }

    if (state.managing) {
      footer.addClass("is-managing");
      footer.createSpan({
        cls: "codex-session-selection-summary",
        text: state.selectedIds.size ? `已选 ${state.selectedIds.size} 个` : "选择要删除的会话"
      });
      const deleteSelected = footer.createEl("button", {
        cls: "codex-session-delete-selected",
        attr: {
          type: "button",
          "aria-label": state.selectedIds.size ? `删除 ${state.selectedIds.size} 个会话` : "删除会话"
        }
      });
      const deleteIcon = deleteSelected.createSpan();
      setIcon(deleteIcon, "trash-2");
      deleteSelected.createSpan({ text: state.selectedIds.size ? `删除 ${state.selectedIds.size}` : "删除" });
      deleteSelected.disabled = state.selectedIds.size === 0;
      deleteSelected.onclick = () => callbacks.onDeleteSessions([...state.selectedIds]);
    } else {
      footer.removeClass("is-managing");
      renderShortcut(footer, ["↑", "↓"], "选择");
      renderShortcut(footer, ["Enter"], "打开");
      renderShortcut(footer, ["Esc"], "关闭");
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const model = buildCodexSessionNavigatorModel(sessions, activeSessionId, runningSessionId, state.query);
    if (event.key === "/") {
      if (event.target !== searchInput) {
        event.preventDefault();
        searchInput.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.query) {
        state.query = "";
        searchInput.value = "";
        state.focusedIndex = 0;
        state.visibleSessionCount = SESSION_PICKER_BATCH_SIZE;
        renderBody();
      } else if (state.managing) {
        state.managing = false;
        state.selectedIds.clear();
        rerender();
      } else {
        closeSessionPicker(state, rerender);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!model.chatSessions.length) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.min(
        model.chatSessions.length - 1,
        Math.max(0, state.focusedIndex + direction)
      );
      const visibleCount = visibleSessionPickerRows(
        model.chatSessions,
        state.visibleSessionCount
      ).length;
      if (nextIndex >= visibleCount) {
        state.visibleSessionCount = nextSessionPickerVisibleCount(
          state.visibleSessionCount,
          model.chatSessions.length
        );
      }
      state.focusedIndex = nextIndex;
      renderBody();
      focusedRow?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      const session = model.chatSessions[state.focusedIndex];
      if (!session) return;
      event.preventDefault();
      if (state.managing) {
        if (session.id !== runningSessionId) toggleSelectedSession(state, session.id, renderBody);
      } else {
        activate(session);
      }
    }
  };
  picker.onkeydown = handleKeyDown;
  searchInput.oninput = () => {
    state.query = searchInput.value;
    state.focusedIndex = 0;
    state.visibleSessionCount = SESSION_PICKER_BATCH_SIZE;
    renderBody();
  };
  searchHint.onclick = () => searchInput.focus();
  renderBody();

  if (typeof window !== "undefined") {
    window.setTimeout(() => searchInput.focus(), 0);
  }
}

function navigatorStateFor(container: HTMLElement): CodexSessionNavigatorState {
  const existing = navigatorStates.get(container);
  if (existing) return existing;
  const state: CodexSessionNavigatorState = {
    open: false,
    managing: false,
    query: "",
    selectedIds: new Set(),
    focusedIndex: 0,
    tabUiStateIds: [],
    visibleSessionCount: SESSION_PICKER_BATCH_SIZE,
    trackRovingSessionId: "",
    backwardFocused: false,
    forwardFocused: false,
    trackScrollLeft: 0,
    trackScrollRestored: false,
    suppressTrackClickUntil: 0,
    activationDismissedSummarySessionId: "",
    lastActiveSessionId: "",
    renderGeneration: 0,
    focusRequestSequence: 0,
    pendingFocusRequest: null
  };
  navigatorStates.set(container, state);
  return state;
}

function markSessionTabUiStateUsed(
  state: CodexSessionNavigatorState,
  sessionId: string
): void {
  if (!sessionId) return;
  state.tabUiStateIds = [
    ...state.tabUiStateIds.filter((id) => id !== sessionId),
    sessionId
  ];
}

function handleSessionTabKeyDown(
  event: KeyboardEvent,
  tabs: readonly HTMLElement[],
  currentIndex: number,
  state: CodexSessionNavigatorState
): void {
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = Math.min(tabs.length - 1, currentIndex + 1);
  else if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = Math.max(0, tabs.length - 1);
  else return;
  event.preventDefault();
  const next = tabs[nextIndex];
  if (!next) return;
  setSessionTabStop(tabs, next, state);
  next.focus();
}

function scheduleSessionTrackSync(input: Readonly<{
  state: CodexSessionNavigatorState;
  renderGeneration: number;
  track: HTMLElement;
  activeTab: HTMLElement | null;
  tabs: readonly HTMLElement[];
  backwardButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
  allButton: HTMLButtonElement;
  newButton: HTMLButtonElement;
  updateOverflow: () => void;
}>): void {
  const sync = () => {
    if (input.state.renderGeneration !== input.renderGeneration) return;
    if (!input.state.trackScrollRestored) {
      input.state.trackScrollRestored = restoreSessionTrackScrollPosition(
        input.track,
        input.state
      );
    }
    if (input.state.trackScrollRestored && input.activeTab) {
      revealSessionTrackItemMinimally(input.track, input.activeTab, input.state);
    }
    input.updateOverflow();
    commitPendingSessionNavigatorFocus(input);
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(sync);
  } else {
    sync();
  }
}

function commitPendingSessionNavigatorFocus(input: Readonly<{
  state: CodexSessionNavigatorState;
  renderGeneration: number;
  track: HTMLElement;
  tabs: readonly HTMLElement[];
  backwardButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
  allButton: HTMLButtonElement;
  newButton: HTMLButtonElement;
}>): void {
  const request = input.state.pendingFocusRequest;
  if (!request || input.state.renderGeneration !== input.renderGeneration) {
    return;
  }
  let target: HTMLElement | null = null;
  if (request.target.kind === "session") {
    const sessionId = request.target.sessionId;
    target = input.tabs.find((tab) =>
      tab.getAttribute("data-session-id") === sessionId
    ) ?? null;
  } else if (
    request.target.kind === "backward"
    && !input.backwardButton.disabled
    && input.backwardButton.getAttribute("aria-hidden") !== "true"
  ) {
    target = input.backwardButton;
  } else if (
    request.target.kind === "forward"
    && !input.forwardButton.disabled
    && input.forwardButton.getAttribute("aria-hidden") !== "true"
  ) {
    target = input.forwardButton;
  }
  if (!target) {
    target = sessionNavigatorFocusFallback(
      input.state,
      input.tabs,
      input.newButton,
      input.allButton
    );
  }
  if (!target) return;
  if (target.getAttribute("data-session-id")) {
    setSessionTabStop(input.tabs, target, input.state);
    revealSessionTrackItemMinimally(input.track, target, input.state);
  }
  target.focus();
  if (
    input.state.pendingFocusRequest?.token === request.token
    && (
      typeof document === "undefined"
      || document.activeElement === target
    )
  ) {
    input.state.pendingFocusRequest = null;
  }
}

function sessionNavigatorFocusFallback(
  state: CodexSessionNavigatorState,
  tabs: readonly HTMLElement[],
  newButton: HTMLButtonElement,
  allButton: HTMLButtonElement
): HTMLElement | null {
  return tabs.find((tab) =>
    tab.getAttribute("data-session-id") === state.trackRovingSessionId
  )
    ?? tabs.find((tab) => tab.getAttribute("aria-selected") === "true")
    ?? tabs[0]
    ?? [newButton, allButton].find((control) => !control.disabled)
    ?? null;
}

function requestSessionNavigatorFocus(
  state: CodexSessionNavigatorState,
  target: SessionNavigatorFocusTarget
): void {
  state.focusRequestSequence += 1;
  state.pendingFocusRequest = Object.freeze({
    token: state.focusRequestSequence,
    target
  });
}

function reconcileFocusedSessionNavigatorTarget(
  state: CodexSessionNavigatorState,
  target: SessionNavigatorFocusTarget
): void {
  const pending = state.pendingFocusRequest;
  if (!pending || sameSessionNavigatorFocusTarget(pending.target, target)) {
    return;
  }
  state.pendingFocusRequest = null;
}

function sameSessionNavigatorFocusTarget(
  left: SessionNavigatorFocusTarget,
  right: SessionNavigatorFocusTarget
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "forward"
    || left.kind === "backward"
    || (
      right.kind === "session"
      && left.sessionId === right.sessionId
    );
}

function setSessionTabStop(
  tabs: readonly HTMLElement[],
  target: HTMLElement,
  state: CodexSessionNavigatorState
): void {
  for (const tab of tabs) {
    tab.setAttribute("tabindex", tab === target ? "0" : "-1");
  }
  state.trackRovingSessionId = target.getAttribute("data-session-id") ?? "";
}

function captureSessionTrackFocus(
  container: HTMLElement,
  state: CodexSessionNavigatorState
): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return;
  const sessionId = active.getAttribute("data-session-id");
  if (sessionId) {
    state.trackRovingSessionId = sessionId;
    requestSessionNavigatorFocus(state, { kind: "session", sessionId });
    return;
  }
  if (active.hasClass("codex-session-backward")) {
    state.backwardFocused = true;
    requestSessionNavigatorFocus(state, { kind: "backward" });
    return;
  }
  if (active.hasClass("codex-session-forward")) {
    state.forwardFocused = true;
    requestSessionNavigatorFocus(state, { kind: "forward" });
  }
}

function captureSessionTrackScrollPosition(
  container: HTMLElement,
  state: CodexSessionNavigatorState
): void {
  const track = container.querySelector<HTMLElement>(".codex-session-track");
  if (track) rememberSessionTrackScrollPosition(track, state);
}

function rememberSessionTrackScrollPosition(
  track: HTMLElement,
  state: CodexSessionNavigatorState
): void {
  state.trackScrollLeft = finiteNonNegativeGeometry(track.scrollLeft);
}

function restoreSessionTrackScrollPosition(
  track: HTMLElement,
  state: CodexSessionNavigatorState
): boolean {
  const clientWidth = finiteNonNegativeGeometry(track.clientWidth);
  const scrollWidth = finiteNonNegativeGeometry(track.scrollWidth);
  if (clientWidth <= 0 || scrollWidth <= 0) return false;
  const target = clampSessionTrackScrollLeft(state.trackScrollLeft, track);
  if (Math.abs(track.scrollLeft - target) > 1) {
    track.scrollLeft = target;
  }
  state.trackScrollLeft = target;
  return true;
}

function revealSessionTrackItemMinimally(
  track: HTMLElement,
  item: HTMLElement,
  state: CodexSessionNavigatorState
): void {
  if (!state.trackScrollRestored) return;
  const target = minimallyRevealSessionTrackOffset(
    track,
    sessionTrackItemGeometry(track, item)
  );
  if (target === null || Math.abs(track.scrollLeft - target) <= 1) return;
  track.scrollLeft = target;
  state.trackScrollLeft = target;
}

function sessionTrackItemGeometries(
  track: HTMLElement,
  items: readonly HTMLElement[]
): SessionTrackItemGeometry[] {
  return items.map((item) => sessionTrackItemGeometry(track, item));
}

function sessionTrackItemGeometry(
  track: HTMLElement,
  item: HTMLElement
): SessionTrackItemGeometry {
  const trackRect = track.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (trackRect.width > 0 && itemRect.width > 0) {
    return {
      offsetLeft: itemRect.left - trackRect.left + track.scrollLeft,
      offsetWidth: itemRect.width
    };
  }
  return {
    offsetLeft: Math.max(0, item.offsetLeft - track.offsetLeft),
    offsetWidth: item.offsetWidth
  };
}

function showSessionSummaryTooltip(
  container: HTMLElement,
  tooltip: HTMLElement,
  anchor: HTMLElement,
  summary: string
): void {
  tooltip.setText(summary);
  tooltip.addClass("is-visible");
  tooltip.setAttribute("aria-hidden", "false");
  const position = () => {
    if (!tooltip.hasClass("is-visible")) return;
    const containerRect = container.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const edge = 8;
    const centered = anchorRect.left - containerRect.left
      + (anchorRect.width - tooltip.offsetWidth) / 2;
    const maxLeft = Math.max(edge, container.clientWidth - tooltip.offsetWidth - edge);
    tooltip.style.left = `${Math.min(maxLeft, Math.max(edge, centered))}px`;
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(position);
  } else {
    position();
  }
}

function scrollSessionTrackTo(track: HTMLElement, left: number): void {
  const reducedMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof track.scrollTo === "function") {
    track.scrollTo({
      left,
      behavior: reducedMotion ? "auto" : "smooth"
    });
  } else {
    track.scrollLeft = left;
  }
}

function normalizedSessionPreviewLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clippedSessionPreviewLine(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength
    ? value
    : `${characters.slice(0, maxLength - 1).join("")}…`;
}

function finiteNonNegativeGeometry(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toggleSessionPicker(state: CodexSessionNavigatorState, rerender: () => void): void {
  state.open = !state.open;
  if (state.open) {
    state.managing = false;
    state.query = "";
    state.selectedIds.clear();
    state.focusedIndex = 0;
    state.visibleSessionCount = SESSION_PICKER_BATCH_SIZE;
  }
  rerender();
}

function closeSessionPicker(state: CodexSessionNavigatorState, rerender: () => void): void {
  state.open = false;
  state.managing = false;
  state.query = "";
  state.selectedIds.clear();
  state.focusedIndex = 0;
  state.visibleSessionCount = SESSION_PICKER_BATCH_SIZE;
  rerender();
}

function toggleSelectedSession(state: CodexSessionNavigatorState, sessionId: string, rerenderBody: () => void): void {
  if (state.selectedIds.has(sessionId)) state.selectedIds.delete(sessionId);
  else state.selectedIds.add(sessionId);
  rerenderBody();
}

function renderShortcut(container: HTMLElement, keys: string[], label: string): void {
  const shortcut = container.createSpan({ cls: "codex-session-shortcut" });
  for (const key of keys) shortcut.createEl("kbd", { text: key });
  shortcut.createSpan({ text: label });
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
