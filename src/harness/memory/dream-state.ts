/**
 * dream-state.ts — persisted dreaming progress (做梦 PRD §5).
 *
 * Stored at `.echoink/shared-user/.runtime/dream-state.json`.
 * pendingMemoryIds、回填进度和已处理 revision 必须落盘，不能只在内存里。
 */

import path from "node:path";
import { DREAM_STATE_SCHEMA } from "./personal-memory-contracts";
import {
  cognitiveReadJsonOrNull,
  cognitiveWriteJson
} from "./cognitive-file-utils";

export interface DreamState {
  readonly schema: typeof DREAM_STATE_SCHEMA;
  readonly revision: number;
  readonly lastRunAt: number;
  readonly lastSuccessAt: number;
  readonly lastProcessedMemoryRevision: number;
  readonly pendingMemoryIds: readonly string[];
  readonly backfillCursor: string | null;
  readonly updatedAt: number;
}

export const DREAM_STATE_RELATIVE_PATH = path.posix.join(
  "shared-user", ".runtime", "dream-state.json"
);

/** Hard cap so the pending queue cannot grow unboundedly. */
export const DREAM_PENDING_CAP = 500;

export function defaultDreamState(): DreamState {
  return Object.freeze({
    schema: DREAM_STATE_SCHEMA,
    revision: 0,
    lastRunAt: 0,
    lastSuccessAt: 0,
    lastProcessedMemoryRevision: 0,
    pendingMemoryIds: Object.freeze([]),
    backfillCursor: null,
    updatedAt: 0
  });
}

export class DreamStateStore {
  readonly filePath: string;
  private cache: DreamState | null = null;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, DREAM_STATE_RELATIVE_PATH);
  }

  async read(): Promise<DreamState> {
    if (this.cache) return this.cache;
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    this.cache = raw ? parseDreamState(raw) ?? defaultDreamState() : defaultDreamState();
    return this.cache;
  }

  /** Persist a new state (atomic). Updates the cache. */
  async write(state: DreamState): Promise<void> {
    this.cache = state;
    await cognitiveWriteJson(this.filePath, state);
  }

  /** Current cached state without disk IO (after at least one read). */
  peek(): DreamState {
    return this.cache ?? defaultDreamState();
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Update the cache after the state was committed through a transaction. */
  updateCache(state: DreamState): void {
    this.cache = state;
  }
}

export function parseDreamState(raw: Record<string, unknown>): DreamState | null {
  if (raw.schema !== DREAM_STATE_SCHEMA) return null;
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const pending = Array.isArray(raw.pendingMemoryIds)
    ? raw.pendingMemoryIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, DREAM_PENDING_CAP)
    : [];
  return Object.freeze({
    schema: DREAM_STATE_SCHEMA,
    revision: numberOr(raw.revision, 0),
    lastRunAt: numberOr(raw.lastRunAt, 0),
    lastSuccessAt: numberOr(raw.lastSuccessAt, 0),
    lastProcessedMemoryRevision: numberOr(raw.lastProcessedMemoryRevision, 0),
    pendingMemoryIds: Object.freeze(pending),
    backfillCursor: typeof raw.backfillCursor === "string" ? raw.backfillCursor : null,
    updatedAt: numberOr(raw.updatedAt, 0)
  });
}

/** Add ids to the pending queue (deduped, capped). Pure helper. */
export function enqueuePendingMemoryIds(
  state: DreamState,
  ids: readonly string[],
  now: number
): DreamState {
  const merged = [...state.pendingMemoryIds];
  const known = new Set(merged);
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      merged.push(id);
    }
  }
  const trimmed = merged.slice(Math.max(0, merged.length - DREAM_PENDING_CAP));
  if (
    trimmed.length === state.pendingMemoryIds.length
    && trimmed.every((id, index) => id === state.pendingMemoryIds[index])
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    pendingMemoryIds: Object.freeze(trimmed),
    updatedAt: now
  });
}
