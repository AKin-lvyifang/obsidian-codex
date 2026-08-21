/**
 * user-profile-state.ts — durable user profile truth source.
 *
 * Stored at `.echoink/shared-user/user-profile-state.json`
 * (schema `echoink.user-profile.v1`, 人格系统重构草案 §8).
 *
 * USER.md 是该状态的纯文本投影，只包含稳定、当前有效且有一级 Memory 来源的画像。
 * 二级事实不能进入 USER 投影。
 */

import path from "node:path";
import { USER_PROFILE_STATE_SCHEMA } from "./personal-memory-contracts";
import {
  cognitiveJsonText,
  cognitiveReadJsonOrNull,
  newCognitiveId,
  normalizeTextForDedupe
} from "./cognitive-file-utils";

export type UserProfileSection = "identity" | "preference" | "collaboration";
export type UserProfileItemBasis = "explicit_memory" | "observed_memory" | "legacy_import";

export const PROFILE_KEY_MAX_CHARS = 40;

/**
 * 做梦 Prompt 携带的已有 profileKey 目录上限（Round 6 修复七）：
 * Prompt 只给「section:key」目录供模型复用稳定主题，绝不允许无界增长。
 */
export const PROFILE_KEY_PROMPT_CAP = 40 as const;

export interface ProfileKeyCatalogEntry {
  readonly section: UserProfileSection;
  readonly profileKey: string;
}

/**
 * Round 6 修复七：生成做梦 Prompt 用的有界 profileKey 目录。
 * - 只取 current 画像项，按 section + key 去重；
 * - 总数不超过 PROFILE_KEY_PROMPT_CAP；需要裁剪时优先保留最近新增
 *   （item.revision 更大者），同 revision 按 section、key 字典序，
 *   输出顺序稳定可复现；
 * - `sameRoundEntries`（本轮已经产生、尚未落盘的新 key）视为最新，
 *   同样计入上限。
 */
export function profileKeyPromptCatalog(
  state: UserProfileState,
  sameRoundEntries: readonly Readonly<{ section: UserProfileSection; profileKey: string }>[] = []
): readonly ProfileKeyCatalogEntry[] {
  const revisionByKey = new Map<string, number>();
  for (const item of state.items) {
    if (item.status !== "current") continue;
    const dedupeKey = `${item.section}\u0000${normalizeTextForDedupe(item.profileKey)}`;
    const existing = revisionByKey.get(dedupeKey);
    if (existing === undefined || item.revision > existing) {
      revisionByKey.set(dedupeKey, item.revision);
    }
  }
  const entries: Array<{ section: UserProfileSection; profileKey: string; revision: number }> = [];
  for (const item of state.items) {
    if (item.status !== "current") continue;
    const dedupeKey = `${item.section}\u0000${normalizeTextForDedupe(item.profileKey)}`;
    if (!revisionByKey.has(dedupeKey)) continue;
    revisionByKey.delete(dedupeKey);
    entries.push({ section: item.section, profileKey: item.profileKey, revision: item.revision });
  }
  for (const entry of sameRoundEntries) {
    const profileKey = normalizeTextForDedupe(entry.profileKey).slice(0, PROFILE_KEY_MAX_CHARS);
    if (!profileKey) continue;
    const dedupeKey = `${entry.section}\u0000${profileKey}`;
    if (entries.some((existing) =>
      `${existing.section}\u0000${normalizeTextForDedupe(existing.profileKey)}` === dedupeKey
    )) continue;
    // 本轮新增 key 视为最新（revision = Infinity），裁剪时最后被丢弃。
    entries.push({ section: entry.section, profileKey, revision: Number.POSITIVE_INFINITY });
  }
  entries.sort((left, right) =>
    right.revision - left.revision
    || left.section.localeCompare(right.section)
    || left.profileKey.localeCompare(right.profileKey)
  );
  return Object.freeze(entries.slice(0, PROFILE_KEY_PROMPT_CAP).map((entry) => Object.freeze({
    section: entry.section,
    profileKey: entry.profileKey
  })));
}

/** 兼容旧 state / 模型未给 key：从 text 生成有界 fallback key。 */
export function fallbackProfileKey(text: string): string {
  const normalized = normalizeTextForDedupe(text);
  return normalized.slice(0, PROFILE_KEY_MAX_CHARS) || "unknown";
}

export interface UserProfileItem {
  readonly id: string;
  readonly section: UserProfileSection;
  /** 稳定主题 key（如「清晨散步」）：按 section + key 聚合近义来源。 */
  readonly profileKey: string;
  readonly text: string;
  readonly basis: UserProfileItemBasis;
  readonly status: "current" | "superseded";
  readonly sourceMemoryIds: readonly string[];
  readonly revision: number;
}

export interface ProcessedProfileSource {
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly processedAt: number;
}

export interface UserProfileState {
  readonly schema: typeof USER_PROFILE_STATE_SCHEMA;
  readonly revision: number;
  readonly items: readonly UserProfileItem[];
  readonly processedSources: readonly ProcessedProfileSource[];
  /**
   * Legacy USER.md migration marker (草案 §12.3): "pending" → custom USER.md
   * still needs to be converted into an explicit primary Memory before the
   * projection may replace it; "done" → migration finished.
   */
  readonly legacyUserMigration: "pending" | "done" | null;
  /** Content hash of the last USER.md projection written by the system. */
  readonly lastProjectedUserHash: string;
  readonly updatedAt: number;
}

export const USER_PROFILE_STATE_RELATIVE_PATH = path.posix.join(
  "shared-user", "user-profile-state.json"
);

/**
 * observed 画像至少需要多少个独立、方向一致的有效一级 Memory 来源，
 * 才能进入 USER.md（人格草案 §9.2 / 最新决定）。一条 observed view
 * 绝不能直接写入 USER.md。
 */
export const USER_OBSERVED_MIN_SOURCES = 3 as const;

export class UserProfileStateStore {
  readonly filePath: string;

  constructor(sharedUserRoot: string) {
    this.filePath = path.join(sharedUserRoot, USER_PROFILE_STATE_RELATIVE_PATH);
  }

  async read(): Promise<UserProfileState | null> {
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    if (!raw) return null;
    return parseUserProfileState(raw);
  }
}

export function emptyUserProfileState(now: number): UserProfileState {
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision: 0,
    items: Object.freeze([]),
    processedSources: Object.freeze([]),
    legacyUserMigration: null,
    lastProjectedUserHash: "",
    updatedAt: now
  });
}

export function userProfileStateJson(state: UserProfileState): string {
  return cognitiveJsonText(state);
}

export interface DreamProfileInput {
  readonly items: readonly Readonly<{
    section: UserProfileSection;
    text: string;
    /** 模型输出的稳定主题 key；缺省时从 text 生成 fallback。 */
    profileKey?: string;
    basis: UserProfileItemBasis;
    sourceMemoryId: string;
  }>[];
  readonly processedSources: readonly Readonly<{
    memoryId: string;
    memoryRevision: number;
  }>[];
  readonly now: number;
  readonly lastProjectedUserHash?: string;
  readonly legacyUserMigration?: "pending" | "done" | null;
}

/** Apply one dreaming round's user-profile work (pure). */
export function applyDreamProfileUpdate(
  previous: UserProfileState,
  input: DreamProfileInput
): UserProfileState {
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [...previous.items];

  for (const incoming of input.items) {
    const text = incoming.text.trim();
    if (!text) continue;
    // 按 section + 稳定主题 key 聚合近义来源（不再按整句 text 相等），
    // 真实 Provider 的近义表述才能累计到三来源阈值。
    const key = (incoming.profileKey && incoming.profileKey.trim())
      ? normalizeTextForDedupe(incoming.profileKey).slice(0, PROFILE_KEY_MAX_CHARS)
      : fallbackProfileKey(text);
    const existing = items.find(
      (item) => item.status === "current" && item.section === incoming.section
        && normalizeTextForDedupe(item.profileKey) === key
    );
    if (existing) {
      if (!existing.sourceMemoryIds.includes(incoming.sourceMemoryId)) {
        const index = items.indexOf(existing);
        items[index] = {
          ...existing,
          sourceMemoryIds: Object.freeze([...existing.sourceMemoryIds, incoming.sourceMemoryId]),
          revision
        };
      }
      continue;
    }
    items.push(Object.freeze({
      id: newCognitiveId("profile"),
      section: incoming.section,
      profileKey: key,
      text: text.slice(0, 800),
      basis: incoming.basis,
      status: "current",
      sourceMemoryIds: Object.freeze([incoming.sourceMemoryId]),
      revision
    }));
  }

  const processedMap = new Map<string, ProcessedProfileSource>(
    previous.processedSources.map((source) => [source.memoryId, source])
  );
  for (const source of input.processedSources) {
    processedMap.set(source.memoryId, Object.freeze({
      memoryId: source.memoryId,
      memoryRevision: source.memoryRevision,
      processedAt: input.now
    }));
  }

  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze([...processedMap.values()]
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId))),
    legacyUserMigration: input.legacyUserMigration !== undefined
      ? input.legacyUserMigration
      : previous.legacyUserMigration,
    lastProjectedUserHash: input.lastProjectedUserHash ?? previous.lastProjectedUserHash,
    updatedAt: input.now
  });
}

/**
 * Memory 来源失效回收：USER 画像项失去全部有效一级 Memory 来源后标记
 * superseded；已处理来源同步清理。纯函数：无变化时返回原引用。
 */
export function reconcileProfileSources(
  previous: UserProfileState,
  validMemoryIds: ReadonlySet<string>,
  now: number
): UserProfileState {
  let changed = false;
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [];
  for (const item of previous.items) {
    if (item.status !== "current") {
      items.push(item);
      continue;
    }
    const alive = item.sourceMemoryIds.filter((id) => validMemoryIds.has(id));
    if (alive.length === item.sourceMemoryIds.length) {
      items.push(item);
      continue;
    }
    changed = true;
    if (alive.length === 0) {
      items.push(Object.freeze({
        ...item,
        status: "superseded" as const,
        sourceMemoryIds: Object.freeze([]),
        revision
      }));
    } else {
      items.push(Object.freeze({
        ...item,
        sourceMemoryIds: Object.freeze(alive),
        revision
      }));
    }
  }
  const processedSources = previous.processedSources.filter(
    (source) => validMemoryIds.has(source.memoryId)
  );
  if (processedSources.length !== previous.processedSources.length) changed = true;
  if (!changed) return previous;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(processedSources),
    legacyUserMigration: previous.legacyUserMigration,
    lastProjectedUserHash: previous.lastProjectedUserHash,
    updatedAt: now
  });
}

/**
 * Round 6 修复五：找出本轮以「更高 revision」重新处理的同一批 Memory
 * （与人格侧 computeReprocessedMemoryIds 同一判断标准）。
 */
export function computeReprocessedProfileMemoryIds(
  previous: UserProfileState,
  incoming: readonly Readonly<{ memoryId: string; memoryRevision: number }>[]
): ReadonlySet<string> {
  const previousRevisionById = new Map<string, number>(
    previous.processedSources.map((source) => [source.memoryId, source.memoryRevision])
  );
  const reprocessed = new Set<string>();
  for (const source of incoming) {
    const before = previousRevisionById.get(source.memoryId);
    if (before !== undefined && source.memoryRevision > before) reprocessed.add(source.memoryId);
  }
  return reprocessed;
}

/**
 * Round 6 修复五：在应用新一轮做梦输出之前，撤销旧 revision 画像项对该
 * Memory 的来源引用；来源清空则标记 superseded。纯函数；无撤销对象时
 * 返回原引用。与新一轮输出在同一事务内提交。
 */
export function revokeReprocessedProfileSources(
  previous: UserProfileState,
  reprocessedIds: ReadonlySet<string>,
  now: number
): UserProfileState {
  if (reprocessedIds.size === 0) return previous;
  let changed = false;
  const revision = previous.revision + 1;
  const items: UserProfileItem[] = [];
  for (const item of previous.items) {
    if (item.status !== "current"
      || !item.sourceMemoryIds.some((id) => reprocessedIds.has(id))) {
      items.push(item);
      continue;
    }
    changed = true;
    const alive = item.sourceMemoryIds.filter((id) => !reprocessedIds.has(id));
    if (alive.length === 0) {
      items.push(Object.freeze({
        ...item,
        status: "superseded" as const,
        sourceMemoryIds: Object.freeze([]),
        revision
      }));
    } else {
      items.push(Object.freeze({
        ...item,
        sourceMemoryIds: Object.freeze(alive),
        revision
      }));
    }
  }
  if (!changed) return previous;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision,
    items: Object.freeze(items),
    processedSources: previous.processedSources,
    legacyUserMigration: previous.legacyUserMigration,
    lastProjectedUserHash: previous.lastProjectedUserHash,
    updatedAt: now
  });
}

/** Whether an observed profile item has earned the right to enter USER.md. */
export function isProfileItemRenderable(item: UserProfileItem): boolean {
  if (item.status !== "current") return false;
  if (item.basis === "observed_memory") {
    return item.sourceMemoryIds.length >= USER_OBSERVED_MIN_SOURCES;
  }
  return true;
}

export function parseUserProfileState(raw: Record<string, unknown>): UserProfileState | null {
  if (raw.schema !== USER_PROFILE_STATE_SCHEMA) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) return null;
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => Object.freeze({
          id: typeof item.id === "string" ? item.id : newCognitiveId("profile"),
          section: (["identity", "preference", "collaboration"].includes(item.section as string)
            ? item.section
            : "preference") as UserProfileSection,
          profileKey: typeof item.profileKey === "string" && item.profileKey.trim()
            ? item.profileKey.trim().slice(0, PROFILE_KEY_MAX_CHARS)
            : fallbackProfileKey(typeof item.text === "string" ? item.text : ""),
          text: typeof item.text === "string" ? item.text : "",
          basis: (item.basis === "observed_memory" || item.basis === "legacy_import"
            ? item.basis
            : "explicit_memory") as UserProfileItemBasis,
          status: item.status === "superseded" ? "superseded" as const : "current" as const,
          sourceMemoryIds: Object.freeze(
            Array.isArray(item.sourceMemoryIds)
              ? item.sourceMemoryIds.filter((id): id is string => typeof id === "string")
              : []
          ),
          revision: typeof item.revision === "number" ? item.revision : 0
        }))
        .filter((item) => item.text.length > 0)
    : [];
  const processedSources = Array.isArray(raw.processedSources)
    ? raw.processedSources
        .filter((source): source is Record<string, unknown> =>
          Boolean(source) && typeof source === "object"
          && typeof (source as Record<string, unknown>).memoryId === "string"
          && typeof (source as Record<string, unknown>).memoryRevision === "number")
        .map((source) => Object.freeze({
          memoryId: source.memoryId as string,
          memoryRevision: source.memoryRevision as number,
          processedAt: typeof source.processedAt === "number" ? source.processedAt : 0
        }))
    : [];
  const migration = raw.legacyUserMigration === "pending" || raw.legacyUserMigration === "done"
    ? raw.legacyUserMigration
    : null;
  return Object.freeze({
    schema: USER_PROFILE_STATE_SCHEMA,
    revision: raw.revision,
    items: Object.freeze(items),
    processedSources: Object.freeze(processedSources),
    legacyUserMigration: migration,
    lastProjectedUserHash: typeof raw.lastProjectedUserHash === "string" ? raw.lastProjectedUserHash : "",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
  });
}
