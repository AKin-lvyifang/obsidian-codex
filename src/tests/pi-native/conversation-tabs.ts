import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { StoredSession } from "../../settings/settings";
import {
  buildCodexSessionNavigatorModel,
  clampSessionTrackScrollLeft,
  minimallyRevealSessionTrackOffset,
  nextSessionPickerVisibleCount,
  nextHiddenSessionTrackOffset,
  previousHiddenSessionTrackOffset,
  retainSessionTabUiStateIds,
  sessionTrackMouseDragExceededThreshold,
  sessionTrackOverflowState,
  shouldSuppressSessionTrackClick,
  visibleSessionPickerRows
} from "../../ui/codex-view/tabs";

export async function runPiConversationTabsTests(): Promise<void> {
  stableNumberedTabsIgnoreUpdatedAtWhileThePickerRemainsRecentFirst();
  tabUiStateUsesBoundedLeastRecentlyUsedEviction();
  sessionPickerLoadsTheFullCatalogInBatches();
  trackNavigationReportsBothBoundariesAndMovesInBothDirections();
  redrawOffsetsClampAndOnlyRevealAClippedSelectedTab();
  mouseDragThresholdSuppressesOnlyTheReleaseClick();
  fullConversationPickerDoesNotOwnArchivedState();
}

function tabUiStateUsesBoundedLeastRecentlyUsedEviction(): void {
  const sessions = Array.from({ length: 45 }, (_value, index) =>
    session(`tab-${index}`, `Tab ${index}`, index, index)
  );
  const first = retainSessionTabUiStateIds(sessions, [], "tab-0");
  assert.equal(first.length, 40);
  assert.ok(first.includes("tab-0"));
  assert.equal(first.includes("tab-5"), false);
  assert.deepEqual(
    sessions.map((session) => session.id),
    Array.from({ length: 45 }, (_value, index) => `tab-${index}`),
    "Tab eviction must not delete or reorder durable conversation shells"
  );

  const next = retainSessionTabUiStateIds(
    sessions,
    first,
    "tab-5",
    "tab-4"
  );
  assert.equal(next.length, 40);
  assert.ok(next.includes("tab-5"));
  assert.ok(next.includes("tab-4"));
  assert.equal(next.includes("tab-6"), false);
  assert.equal(next.includes("tab-7"), false);
}

function sessionPickerLoadsTheFullCatalogInBatches(): void {
  const sessions = Array.from({ length: 120 }, (_value, index) =>
    session(`conversation-${index}`, `会话 ${index}`, index, index)
  );
  const firstBatch = visibleSessionPickerRows(sessions, 50);
  assert.equal(firstBatch.length, 50);
  assert.equal(firstBatch.at(-1)?.id, "conversation-49");

  const secondCount = nextSessionPickerVisibleCount(50, sessions.length);
  const secondBatch = visibleSessionPickerRows(sessions, secondCount);
  assert.equal(secondCount, 100);
  assert.equal(secondBatch.length, 100);
  assert.equal(secondBatch.at(-1)?.id, "conversation-99");

  const finalCount = nextSessionPickerVisibleCount(secondCount, sessions.length);
  assert.equal(finalCount, sessions.length);
  assert.equal(
    visibleSessionPickerRows(sessions, finalCount).at(-1)?.id,
    "conversation-119"
  );

  const searched = buildCodexSessionNavigatorModel(
    sessions,
    "",
    "",
    "会话 119"
  );
  assert.deepEqual(searched.chatSessions.map((session) => session.id), [
    "conversation-119"
  ]);
  assert.equal(
    searched.chatSessions[0],
    sessions[119],
    "rows from later batches must retain the original catalog session identity"
  );
  assert.equal(
    searched.chatCount,
    sessions.length,
    "search must filter the full durable catalog, not only the first batch"
  );
}

function fullConversationPickerDoesNotOwnArchivedState(): void {
  const source = readFileSync("src/ui/codex-view/tabs.ts", "utf8");
  assert.doesNotMatch(source, /onLoadArchived|archivedEntries|已归档/u);
}

function stableNumberedTabsIgnoreUpdatedAtWhileThePickerRemainsRecentFirst(): void {
  const sessions = [
    session("first", "第一会话", 10, 10),
    session("second", "第二会话", 20, 20),
    session("third", "第三会话", 30, 30)
  ];

  const initial = buildCodexSessionNavigatorModel(sessions, "second");
  assert.deepEqual(initial.tabSessions.map((entry) => entry.id), ["first", "second", "third"]);
  assert.deepEqual(initial.chatSessions.map((entry) => entry.id), ["third", "second", "first"]);

  sessions[1]!.unreadAnswerAt = 40;
  const afterUnread = buildCodexSessionNavigatorModel(sessions, "second");
  assert.deepEqual(
    afterUnread.chatSessions.map((entry) => entry.id),
    ["third", "second", "first"],
    "marking an answer unread must not change recent-use ordering"
  );
  assert.equal(sessions[1]!.updatedAt, 20);

  sessions[0]!.updatedAt = 99;
  const afterUpdate = buildCodexSessionNavigatorModel(sessions, "second");
  assert.deepEqual(
    afterUpdate.tabSessions.map((entry) => entry.id),
    ["first", "second", "third"],
    "stable tab numbers must continue following creation order"
  );
  assert.deepEqual(
    afterUpdate.chatSessions.map((entry) => entry.id),
    ["first", "third", "second"],
    "the full picker must remain recent-first"
  );

  const afterCatalogRestart = buildCodexSessionNavigatorModel(
    [sessions[2]!, sessions[0]!, sessions[1]!],
    "second"
  );
  assert.deepEqual(
    afterCatalogRestart.tabSessions.map((entry) => entry.id),
    ["first", "second", "third"],
    "stable tab numbers must not depend on Catalog return order"
  );
  assert.deepEqual(
    afterCatalogRestart.chatSessions.map((entry) => entry.id),
    ["first", "third", "second"],
    "the full picker must remain recent-first after a Catalog restart"
  );
}

function trackNavigationReportsBothBoundariesAndMovesInBothDirections(): void {
  assert.deepEqual(
    sessionTrackOverflowState({ scrollLeft: 0, clientWidth: 100, scrollWidth: 300 }),
    { hasOverflow: true, canRetreat: false, canAdvance: true, atStart: true, atEnd: false }
  );
  assert.deepEqual(
    sessionTrackOverflowState({ scrollLeft: 200, clientWidth: 100, scrollWidth: 300 }),
    { hasOverflow: true, canRetreat: true, canAdvance: false, atStart: false, atEnd: true }
  );
  assert.deepEqual(
    sessionTrackOverflowState({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 }),
    { hasOverflow: false, canRetreat: false, canAdvance: false, atStart: true, atEnd: true }
  );

  const items = [
    { offsetLeft: 0, offsetWidth: 40 },
    { offsetLeft: 45, offsetWidth: 40 },
    { offsetLeft: 90, offsetWidth: 40 },
    { offsetLeft: 135, offsetWidth: 40 }
  ];
  assert.equal(nextHiddenSessionTrackOffset({ scrollLeft: 0, clientWidth: 100 }, items), 90);
  assert.equal(previousHiddenSessionTrackOffset({ scrollLeft: 90 }, items), 45);
  assert.equal(previousHiddenSessionTrackOffset({ scrollLeft: 0 }, items), null);
}

function redrawOffsetsClampAndOnlyRevealAClippedSelectedTab(): void {
  const viewport = { scrollLeft: 155, clientWidth: 100, scrollWidth: 220 };
  assert.equal(clampSessionTrackScrollLeft(155, viewport), 120);
  assert.equal(
    minimallyRevealSessionTrackOffset(viewport, { offsetLeft: 130, offsetWidth: 30 }),
    null,
    "a visible selected tab must not move the restored position"
  );
  assert.equal(
    minimallyRevealSessionTrackOffset(viewport, { offsetLeft: 80, offsetWidth: 30 }),
    80,
    "a tab clipped on the left must move only to its left edge"
  );
  assert.equal(
    minimallyRevealSessionTrackOffset({ scrollLeft: 40, clientWidth: 100, scrollWidth: 220 }, { offsetLeft: 120, offsetWidth: 40 }),
    60,
    "a tab clipped on the right must move only enough to reveal its right edge"
  );
}

function mouseDragThresholdSuppressesOnlyTheReleaseClick(): void {
  assert.equal(sessionTrackMouseDragExceededThreshold(100, 105), false);
  assert.equal(sessionTrackMouseDragExceededThreshold(100, 106), true);
  assert.equal(sessionTrackMouseDragExceededThreshold(100, 94), true);
  assert.equal(shouldSuppressSessionTrackClick(200, 199), true);
  assert.equal(shouldSuppressSessionTrackClick(200, 200), false);
}

function session(id: string, title: string, createdAt: number, updatedAt: number): StoredSession {
  return {
    id,
    title,
    kind: "chat",
    piSessionId: `pi-${id}`,
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [],
    createdAt,
    updatedAt
  };
}
