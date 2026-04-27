export const VIRTUAL_ROW_ESTIMATE_PX = 96;
export const VIRTUAL_OVERSCAN_PX = 600;
export const VIRTUAL_BOTTOM_FOLLOW_PX = 64;

export interface VirtualRow {
  id: string;
  index: number;
  top: number;
  height: number;
}

export interface VirtualWindowState {
  rowIds: readonly string[];
  rowHeights?: ReadonlyMap<string, number>;
  estimatedRowHeight?: number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
}

export interface VirtualWindowResult {
  rows: VirtualRow[];
  totalHeight: number;
  startIndex: number;
  endIndex: number;
}

export function calculateVirtualWindow(state: VirtualWindowState): VirtualWindowResult {
  const estimate = Math.max(1, state.estimatedRowHeight ?? VIRTUAL_ROW_ESTIMATE_PX);
  const overscan = Math.max(0, state.overscanPx ?? VIRTUAL_OVERSCAN_PX);
  const viewportHeight = Math.max(0, state.viewportHeight);
  const scrollTop = Math.max(0, state.scrollTop);
  const minTop = Math.max(0, scrollTop - overscan);
  const maxBottom = scrollTop + viewportHeight + overscan;
  const rows: VirtualRow[] = [];
  let top = 0;
  let startIndex = -1;
  let endIndex = -1;

  for (let index = 0; index < state.rowIds.length; index += 1) {
    const id = state.rowIds[index];
    const measured = state.rowHeights?.get(id);
    const height = measured && measured > 0 ? measured : estimate;
    const bottom = top + height;
    if (bottom >= minTop && top <= maxBottom) {
      if (startIndex < 0) startIndex = index;
      endIndex = index + 1;
      rows.push({ id, index, top, height });
    }
    top = bottom;
  }

  if (!rows.length && state.rowIds.length) {
    const fallbackIndex = nearestRowIndex(state.rowIds, state.rowHeights, estimate, scrollTop);
    const fallbackTop = topForRow(state.rowIds, state.rowHeights, estimate, fallbackIndex);
    const id = state.rowIds[fallbackIndex];
    const measured = state.rowHeights?.get(id);
    rows.push({
      id,
      index: fallbackIndex,
      top: fallbackTop,
      height: measured && measured > 0 ? measured : estimate
    });
    startIndex = fallbackIndex;
    endIndex = fallbackIndex + 1;
  }

  return {
    rows,
    totalHeight: top,
    startIndex: Math.max(0, startIndex),
    endIndex: Math.max(0, endIndex)
  };
}

export function isNearVirtualBottom(scrollTop: number, viewportHeight: number, scrollHeight: number, threshold = VIRTUAL_BOTTOM_FOLLOW_PX): boolean {
  return Math.max(0, scrollTop) + Math.max(0, viewportHeight) >= Math.max(0, scrollHeight) - Math.max(0, threshold);
}

export function scrollTopForVirtualBottom(totalHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.max(0, totalHeight) - Math.max(0, viewportHeight));
}

function nearestRowIndex(rowIds: readonly string[], rowHeights: ReadonlyMap<string, number> | undefined, estimate: number, scrollTop: number): number {
  let top = 0;
  for (let index = 0; index < rowIds.length; index += 1) {
    const height = rowHeights?.get(rowIds[index]) ?? estimate;
    if (top + height >= scrollTop) return index;
    top += height;
  }
  return Math.max(0, rowIds.length - 1);
}

function topForRow(rowIds: readonly string[], rowHeights: ReadonlyMap<string, number> | undefined, estimate: number, targetIndex: number): number {
  let top = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    top += rowHeights?.get(rowIds[index]) ?? estimate;
  }
  return top;
}
