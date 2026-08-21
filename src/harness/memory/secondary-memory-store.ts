/**
 * secondary-memory-store.ts — 二级事实 (secondary facts) file store.
 *
 * 做梦 PRD §6.2：二级事实使用独立记录，存储在
 * `.echoink/shared-user/memory/secondary/<parent-id>/<secondary-id>.md`
 * （schema `echoink.memory-secondary.v1`）。绝不把二级事实塞进一级 Manifest。
 *
 * Lifecycle rules implemented here (做梦 PRD §9):
 * - 命中：hitCount += 1、lastHitAt = now、confidence = min(1, confidence + 0.05)。
 * - 衰减：30 天保护期；每完整 30 天未命中 confidence *= 0.8；用 lastDecayAt 保证幂等。
 * - confidence < 0.1 的 llm_inferred 可自动禁用；user_edited_inference 永不自动禁用。
 */

import { createHash } from "node:crypto";
import path from "node:path";
import {
  isSecondaryDisabledReason,
  SECONDARY_DECAY_FACTOR,
  SECONDARY_DECAY_GRACE_DAYS,
  SECONDARY_HIT_CONFIDENCE_STEP,
  SECONDARY_MAX_MATCH_TERMS,
  SECONDARY_MAX_PER_PARENT,
  SECONDARY_MEMORY_SCHEMA,
  SECONDARY_MIN_CONFIDENCE,
  isSecondaryRelation,
  isSecondarySupportLevel,
  type PersonalMemoryBasis,
  type SecondaryBasis,
  type SecondaryMemoryRecord,
  type SecondaryRelation,
  type SecondaryDisabledReason,
  type SecondaryStatus,
  type SecondarySupportLevel
} from "./personal-memory-contracts";
import { cognitivePathExists, newCognitiveId } from "./cognitive-file-utils";
import { mkdir, readdir, readFile } from "node:fs/promises";

const MS_PER_DAY = 86_400_000;
const SAFE_SECONDARY_ID = /^[a-zA-Z0-9_-]{3,96}$/u;

export const SECONDARY_MEMORY_DIRNAME = "secondary";

export function secondaryRelativePath(parentId: string, secondaryId: string): string {
  return path.posix.join("shared-user", "memory", SECONDARY_MEMORY_DIRNAME, parentId, `${secondaryId}.md`);
}

// ---------------------------------------------------------------------------
// Markdown serialization (frontmatter style identical to primary records)
// ---------------------------------------------------------------------------

export function serializeSecondaryRecord(record: Readonly<SecondaryMemoryRecord>): string {
  const fields: Array<readonly [string, string | number | readonly string[] | null]> = [
    ["schema", record.schema],
    ["id", record.id],
    ["parent_id", record.parentId],
    ["status", record.status],
    ["disabled_reason", record.disabledReason],
    ["title", record.title],
    ["recall_when", record.recallWhen],
    ["match_terms", record.matchTerms],
    ["relation", record.relation],
    ["reason", record.reason],
    ["support_level", record.supportLevel],
    ["evidence", record.evidence],
    ["basis", record.basis],
    ["source_memory_revision", record.sourceMemoryRevision],
    ["confidence", record.confidence],
    ["hit_count", record.hitCount],
    ["last_hit_at", record.lastHitAt],
    ["last_decay_at", record.lastDecayAt],
    ["created_at", record.createdAt],
    ["updated_at", record.updatedAt],
    ["revision", record.revision]
  ];
  return [
    "---",
    ...fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    record.content.trim(),
    ""
  ].join("\n");
}

export function parseSecondaryRecord(text: string, file: string): SecondaryMemoryRecord {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new Error(`Secondary record ${file} has no frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`Secondary record ${file} frontmatter is incomplete`);
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Secondary record ${file} frontmatter line is invalid`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      throw new Error(`Secondary record ${file} frontmatter value is invalid`);
    }
  }
  const requireString = (key: string, max: number): string => {
    const value = fields.get(key);
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    return value.trim();
  };
  const requireNumber = (key: string): number => {
    const value = fields.get(key);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    return value;
  };
  const nullableNumber = (key: string): number | null => {
    const value = fields.get(key);
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Secondary record ${file} field ${key} is invalid`);
    }
    return value;
  };
  const id = requireString("id", 96);
  const parentId = requireString("parent_id", 96);
  if (!SAFE_SECONDARY_ID.test(id) || !SAFE_SECONDARY_ID.test(parentId)) {
    throw new Error(`Secondary record ${file} id is unsafe`);
  }
  if (fields.get("schema") !== SECONDARY_MEMORY_SCHEMA) {
    throw new Error(`Secondary record ${file} schema is invalid`);
  }
  const status = fields.get("status") === "disabled" ? "disabled" : "current";
  const basis = fields.get("basis") === "user_edited_inference"
    ? "user_edited_inference"
    : "llm_inferred";
  const relation = fields.get("relation");
  const matchTermsRaw = fields.get("match_terms");
  const matchTerms = Array.isArray(matchTermsRaw)
    ? matchTermsRaw.filter((term): term is string => typeof term === "string" && term.trim().length > 0)
        .map((term) => term.trim().slice(0, 40))
        .slice(0, SECONDARY_MAX_MATCH_TERMS)
    : [];
  return Object.freeze({
    schema: SECONDARY_MEMORY_SCHEMA,
    id,
    parentId,
    status: status as SecondaryStatus,
    disabledReason: status === "disabled"
      ? (isSecondaryDisabledReason(fields.get("disabled_reason"))
          ? (fields.get("disabled_reason") as SecondaryDisabledReason)
          : "parent_lifecycle")
      : null,
    title: requireString("title", 200),
    content: lines.slice(end + 1).join("\n").trim().slice(0, 24_000),
    recallWhen: requireString("recall_when", 500),
    matchTerms: Object.freeze(matchTerms),
    relation: isSecondaryRelation(relation) ? relation : "associated",
    reason: typeof fields.get("reason") === "string" ? (fields.get("reason") as string).slice(0, 500) : "",
    supportLevel: isSecondarySupportLevel(fields.get("support_level"))
      ? (fields.get("support_level") as SecondarySupportLevel)
      : "strong_inference",
    evidence: typeof fields.get("evidence") === "string" ? (fields.get("evidence") as string).slice(0, 800) : "",
    basis: basis as SecondaryBasis,
    sourceMemoryRevision: requireNumber("source_memory_revision"),
    confidence: Math.max(0, Math.min(1, requireNumber("confidence"))),
    hitCount: Math.max(0, Math.floor(requireNumber("hit_count"))),
    lastHitAt: nullableNumber("last_hit_at"),
    lastDecayAt: nullableNumber("last_decay_at"),
    createdAt: requireNumber("created_at"),
    updatedAt: requireNumber("updated_at"),
    revision: Math.floor(requireNumber("revision")),
    file
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SecondaryMemoryStore {
  private readonly directory: string;
  private cache: readonly SecondaryMemoryRecord[] | null = null;

  constructor(historyRoot: string) {
    this.directory = path.join(historyRoot, SECONDARY_MEMORY_DIRNAME);
  }

  get rootDirectory(): string {
    return this.directory;
  }

  /** Load (and cache) every secondary record on disk. Invalid files are skipped. */
  async loadAll(): Promise<readonly SecondaryMemoryRecord[]> {
    if (this.cache) return this.cache;
    const records: SecondaryMemoryRecord[] = [];
    if (await cognitivePathExists(this.directory)) {
      const parentEntries = await readdir(this.directory, { withFileTypes: true });
      for (const parentEntry of parentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!parentEntry.isDirectory()) continue;
        const parentDir = path.join(this.directory, parentEntry.name);
        const fileEntries = await readdir(parentDir, { withFileTypes: true });
        for (const fileEntry of fileEntries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".md")) continue;
          const target = path.join(parentDir, fileEntry.name);
          try {
            const text = await readFile(target, "utf8");
            const relative = secondaryRelativePath(parentEntry.name, fileEntry.name.replace(/\.md$/u, ""));
            records.push(parseSecondaryRecord(text, relative));
          } catch {
            // A damaged secondary file never blocks primary memory.
          }
        }
      }
    }
    records.sort((left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id));
    this.cache = Object.freeze(records);
    return this.cache;
  }

  /** Refresh the cache from disk. */
  async refresh(): Promise<readonly SecondaryMemoryRecord[]> {
    this.cache = null;
    return await this.loadAll();
  }

  /** Update the in-memory cache after a transaction committed new files. */
  setCache(records: readonly SecondaryMemoryRecord[]): void {
    this.cache = Object.freeze([...records].sort(
      (left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id)
    ));
  }

  async listForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    const all = await this.loadAll();
    return all.filter((record) => record.parentId === parentId);
  }

  async ensureDirectory(parentId: string): Promise<string> {
    const target = path.join(this.directory, parentId);
    await mkdir(target, { recursive: true });
    return target;
  }

  absolutePathFor(relativePath: string): string {
    return path.join(this.directory, "..", "..", relativePath);
  }
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

export interface NewSecondaryFactInput {
  readonly parentId: string;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly reason: string;
  readonly basis: SecondaryBasis;
  /** 代码计算的准入 confidence（不做真实概率解释）。 */
  readonly confidence: number;
  readonly supportLevel: SecondarySupportLevel;
  readonly evidence: string;
  readonly sourceMemoryRevision: number;
  readonly now: number;
  readonly idFactory?: () => string;
}

/** Normalize a match term; returns null when unusable (single CJK char etc.). */
export function normalizeMatchTerm(raw: string): string | null {
  const term = raw.normalize("NFKC").trim();
  if (!term || term.length > 40) return null;
  // 单个汉字不能独立作为匹配词（做梦 PRD §8.2）。
  if (/^\p{Script=Han}$/u.test(term)) return null;
  if (/^[\s\p{P}\p{S}]+$/u.test(term)) return null;
  return term;
}

export function createSecondaryRecord(input: NewSecondaryFactInput): SecondaryMemoryRecord {
  const makeId = input.idFactory ?? (() => newCognitiveId("sec"));
  const id = makeId();
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.matchTerms) {
    const term = normalizeMatchTerm(raw);
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= SECONDARY_MAX_MATCH_TERMS) break;
  }
  return Object.freeze({
    schema: SECONDARY_MEMORY_SCHEMA,
    id,
    parentId: input.parentId,
    status: "current",
    disabledReason: null,
    title: input.title.trim().slice(0, 200),
    content: input.content.trim().slice(0, 2_000),
    recallWhen: (input.recallWhen.trim() || input.title.trim()).slice(0, 500),
    matchTerms: Object.freeze(terms),
    relation: input.relation,
    reason: input.reason.trim().slice(0, 500),
    supportLevel: input.supportLevel,
    evidence: input.evidence.trim().slice(0, 800),
    basis: input.basis,
    sourceMemoryRevision: input.sourceMemoryRevision,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    hitCount: 0,
    lastHitAt: null,
    lastDecayAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 1,
    file: secondaryRelativePath(input.parentId, id)
  });
}

// ---------------------------------------------------------------------------
// Candidate pipeline: 候选生成 → 字段验证 → 置信度计算 → 去重 → 多样性选择
// → 动态落盘（做梦 PRD 最新决定；8 条是硬上限，不是生成目标）
// ---------------------------------------------------------------------------

/** supportLevel 基础分（不用 LLM 自评数字）。 */
export const SECONDARY_SUPPORT_BASE_SCORE: Readonly<Record<SecondarySupportLevel, number>> = Object.freeze({
  direct: 0.85,
  strong_inference: 0.70,
  weak_inference: 0.45
});

/** 一级 Memory basis 系数。 */
export const SECONDARY_BASIS_WEIGHT: Readonly<Record<PersonalMemoryBasis, number>> = Object.freeze({
  explicit: 1.00,
  observed: 0.90,
  inferred: 0.75
});

/** relation 调整项。 */
export const SECONDARY_RELATION_ADJUSTMENT: Readonly<Record<SecondaryRelation, number>> = Object.freeze({
  category: 0,
  instance: 0,
  attribute: -0.05,
  context: -0.05,
  associated: -0.15
});

/** confidence 准入阈值：低于它的候选不落盘、不索引、不等待凑数。 */
export const SECONDARY_CONFIDENCE_THRESHOLD = 0.60 as const;
/** 同一 relation 最多保留的 current 二级事实数。 */
export const SECONDARY_MAX_PER_RELATION = 2 as const;

/**
 * confidence = clamp(baseScore × basisWeight + relationAdjustment, 0, 1)。
 * 它只是「是否值得进入召回系统」的准入分，不宣称是真实概率。
 */
export function computeSecondaryConfidence(
  supportLevel: SecondarySupportLevel,
  parentBasis: PersonalMemoryBasis,
  relation: SecondaryRelation
): number {
  const score = SECONDARY_SUPPORT_BASE_SCORE[supportLevel]
    * SECONDARY_BASIS_WEIGHT[parentBasis]
    + SECONDARY_RELATION_ADJUSTMENT[relation];
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/** 语义身份指纹：规范化 title + 排序后的匹配词（content 允许重新表述）。 */
export function secondaryFingerprint(title: string, matchTerms: readonly string[]): string {
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase().trim();
  const normalizedTerms = matchTerms
    .map((term) => term.normalize("NFKC").toLocaleLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join("|");
  return createHash("sha256").update(`${normalizedTitle}\n${normalizedTerms}`).digest("hex");
}

export interface SecondaryFactCandidate {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly supportLevel: SecondarySupportLevel;
  readonly reason: string;
  readonly evidence: string;
}

export interface SecondaryReconcileInput {
  readonly parentId: string;
  readonly parentBasis: PersonalMemoryBasis;
  readonly parentRevision: number;
  /** 该父节点名下全部二级记录（含 disabled）。 */
  readonly existing: readonly SecondaryMemoryRecord[];
  /** 本轮通过字段验证的临时候选（尚未落盘）。 */
  readonly candidates: readonly SecondaryFactCandidate[];
  readonly now: number;
  readonly idFactory?: () => string;
}

export interface SecondaryReconcileResult {
  /** 该父节点名下全部最终记录（含未改动的 disabled 历史）。 */
  readonly records: readonly SecondaryMemoryRecord[];
  /** 需要写盘的二级文件（新建 / 复用更新 / 停用）。 */
  readonly fileChanges: readonly Readonly<{ relativePath: string; content: string }>[];
  readonly factsCreated: number;
  readonly factsReused: number;
  readonly factsRetired: number;
}

/**
 * 父 Memory 做梦（含重新做梦）的统一 dedupe + reconcile：
 *
 * 1. user_edited_inference 永远保留，做梦不得覆盖；
 * 2. 本轮候选重新评分筛选（confidence ≥ 阈值）；
 * 3. 入选结果替换旧 llm_inferred：语义相同（fingerprint）复用旧 ID、
 *    hitCount、lastHitAt 与历史 confidence；
 * 4. 不再入选的旧 llm_inferred 标记 disabled；
 * 5. 最终 current 集合重新满足：阈值、relation 多样性、每 relation ≤2、
 *    硬上限 8 条。禁止 append。
 */
export function reconcileSecondaryForParent(
  input: SecondaryReconcileInput
): SecondaryReconcileResult {
  const makeId = input.idFactory ?? (() => newCognitiveId("sec"));
  const fileChanges: Array<{ relativePath: string; content: string }> = [];

  const userEdited = input.existing.filter(
    (record) => record.basis === "user_edited_inference" && record.status === "current"
  );
  const oldLlm = input.existing.filter(
    (record) => record.basis === "llm_inferred" && record.status === "current"
  );
  const untouched = input.existing.filter(
    (record) => record.status !== "current"
      || (record.basis !== "llm_inferred" && record.basis !== "user_edited_inference")
  );

  // --- 1. Confidence + threshold ------------------------------------------
  const scored = input.candidates
    .filter((candidate) => candidate.title.trim() && candidate.content.trim()
      && candidate.evidence.trim() && candidate.matchTerms.length > 0)
    .map((candidate) => ({
      candidate,
      confidence: computeSecondaryConfidence(
        candidate.supportLevel, input.parentBasis, candidate.relation
      ),
      fingerprint: secondaryFingerprint(candidate.title, candidate.matchTerms)
    }))
    .filter((entry) => entry.confidence >= SECONDARY_CONFIDENCE_THRESHOLD);

  // --- 2. Dedupe（有界本地去重，不做 embedding）：同一父节点内，标题相同
  //    或非空匹配词集合相同即视为重复，保留 confidence 更高的一条；与
  //    user_edited_inference 冲突时始终保留用户编辑版本，丢弃 LLM 候选。
  const normalizeTitleKey = (value: string): string =>
    value.normalize("NFKC").toLocaleLowerCase().trim();
  const normalizeTermSetKey = (terms: readonly string[]): string => {
    const normalized = terms
      .map((term) => normalizeMatchTerm(term))
      .filter((term): term is string => term !== null)
      .map((term) => term.normalize("NFKC").toLocaleLowerCase())
      .sort();
    return [...new Set(normalized)].join("|");
  };
  const userTitleKeys = new Set(userEdited.map((record) => normalizeTitleKey(record.title)));
  const userTermKeys = new Set(
    userEdited.map((record) => normalizeTermSetKey(record.matchTerms)).filter((key) => key.length > 0)
  );
  // 既有 llm 事实也按宽 key 参与去重：每个 key 只对应一条旧记录。
  const oldLlmByTitleKey = new Map<string, SecondaryMemoryRecord>();
  const oldLlmByTermKey = new Map<string, SecondaryMemoryRecord>();
  for (const record of oldLlm) {
    const titleKey = normalizeTitleKey(record.title);
    if (titleKey && !oldLlmByTitleKey.has(titleKey)) oldLlmByTitleKey.set(titleKey, record);
    const termKey = normalizeTermSetKey(record.matchTerms);
    if (termKey && !oldLlmByTermKey.has(termKey)) oldLlmByTermKey.set(termKey, record);
  }
  const keptOldIds = new Set<string>();
  const deduped: typeof scored = [];
  const keptTitleKeys = new Set<string>();
  const keptTermKeys = new Set<string>();
  // Round 6 修复六（问题 2）：宽 key 命中且候选 confidence 更高时，记录
  // 「候选 → 被替换旧记录」，第 4 步做原地更新（保留旧 ID 与命中历史），
  // 不再走 retire+新建。
  const wideKeyReplacement = new Map<typeof scored[number], SecondaryMemoryRecord>();
  for (const entry of scored.sort((left, right) => right.confidence - left.confidence)) {
    const titleKey = normalizeTitleKey(entry.candidate.title);
    const termKey = normalizeTermSetKey(entry.candidate.matchTerms);
    // 与 user_edited_inference 冲突：始终保留用户编辑版本。
    if (userTitleKeys.has(titleKey)) continue;
    if (termKey && userTermKeys.has(termKey)) continue;
    if (keptTitleKeys.has(titleKey)) continue;
    if (termKey && keptTermKeys.has(termKey)) continue;
    const oldMatch = (titleKey ? oldLlmByTitleKey.get(titleKey) : undefined)
      ?? (termKey ? oldLlmByTermKey.get(termKey) : undefined);
    if (oldMatch) {
      if (oldMatch.confidence >= entry.confidence) {
        // 既有事实 confidence 不低于候选：原样保留旧记录
        // （ID / hitCount / lastHitAt 不变，不重复写盘），丢弃候选。
        keptOldIds.add(oldMatch.id);
        oldLlmByTitleKey.delete(titleKey);
        if (termKey) oldLlmByTermKey.delete(termKey);
        // Round 6 修复六（问题 1）：被保留旧事实自己的标题/匹配词宽 key
        // 必须进入 reserved，否则同轮后来者会再次匹配不到旧记录而新建重复。
        const keptTitleKey = normalizeTitleKey(oldMatch.title);
        if (keptTitleKey) keptTitleKeys.add(keptTitleKey);
        const keptTermKey = normalizeTermSetKey(oldMatch.matchTerms);
        if (keptTermKey) keptTermKeys.add(keptTermKey);
        continue;
      }
      // 候选 confidence 更高：原地替换既有记录（第 4 步保留旧 ID/命中历史）。
      oldLlmByTitleKey.delete(titleKey);
      if (termKey) oldLlmByTermKey.delete(termKey);
      wideKeyReplacement.set(entry, oldMatch);
    }
    keptTitleKeys.add(titleKey);
    if (termKey) keptTermKeys.add(termKey);
    deduped.push(entry);
  }

  // --- 3. Diversity: one best per relation first, then fill by confidence --
  const relationCount = new Map<SecondaryRelation, number>();
  for (const record of userEdited) {
    relationCount.set(record.relation, (relationCount.get(record.relation) ?? 0) + 1);
  }
  let slots = SECONDARY_MAX_PER_PARENT - userEdited.length;
  const selected: typeof scored = [];
  const picked = new Set<typeof scored[number]>();
  const tryTake = (entry: typeof scored[number]): boolean => {
    if (slots <= 0) return false;
    const count = relationCount.get(entry.candidate.relation) ?? 0;
    if (count >= SECONDARY_MAX_PER_RELATION) return false;
    relationCount.set(entry.candidate.relation, count + 1);
    slots -= 1;
    selected.push(entry);
    picked.add(entry);
    return true;
  };
  const relationsInOrder: SecondaryRelation[] = [];
  for (const entry of deduped) {
    if (!relationsInOrder.includes(entry.candidate.relation)) {
      relationsInOrder.push(entry.candidate.relation);
    }
  }
  for (const relation of relationsInOrder) {
    const best = deduped.find((entry) => entry.candidate.relation === relation && !picked.has(entry));
    if (best) tryTake(best);
  }
  for (const entry of deduped) {
    if (!picked.has(entry)) tryTake(entry);
  }

  // --- 4. Replace: reuse ids for fingerprint-equal old llm facts ------------
  const oldByFingerprint = new Map(
    oldLlm.map((record) => [secondaryFingerprint(record.title, record.matchTerms), record])
  );
  const finalRecords: SecondaryMemoryRecord[] = [...userEdited, ...untouched];
  let factsCreated = 0;
  let factsReused = 0;
  let factsRetired = 0;
  const reusedIds = new Set<string>();
  for (const entry of selected) {
    const previous = oldByFingerprint.get(entry.fingerprint);
    if (previous) {
      const reused: SecondaryMemoryRecord = Object.freeze({
        ...previous,
        title: entry.candidate.title.trim().slice(0, 200),
        content: entry.candidate.content.trim().slice(0, 2_000),
        recallWhen: (entry.candidate.recallWhen.trim() || entry.candidate.title.trim()).slice(0, 500),
        matchTerms: Object.freeze(entry.candidate.matchTerms
          .map((term) => normalizeMatchTerm(term))
          .filter((term): term is string => term !== null)
          .slice(0, SECONDARY_MAX_MATCH_TERMS)),
        relation: entry.candidate.relation,
        reason: entry.candidate.reason.trim().slice(0, 500),
        supportLevel: entry.candidate.supportLevel,
        evidence: entry.candidate.evidence.trim().slice(0, 800),
        // 历史 confidence / hitCount / lastHitAt 原样复用。
        sourceMemoryRevision: input.parentRevision,
        updatedAt: input.now,
        revision: previous.revision + 1
      });
      reusedIds.add(previous.id);
      finalRecords.push(reused);
      fileChanges.push({ relativePath: reused.file, content: serializeSecondaryRecord(reused) });
      factsReused += 1;
      continue;
    }
    // Round 6 修复六（问题 2）：宽 key（标题或匹配词相同、指纹不同）替换
    // 必须原地更新——保留旧 ID / hitCount / lastHitAt / createdAt，只更新
    // 内容与 confidence，绝不 retire+新建（新建会丢失全部命中历史）。
    const replaced = wideKeyReplacement.get(entry);
    if (replaced) {
      const updated: SecondaryMemoryRecord = Object.freeze({
        ...replaced,
        title: entry.candidate.title.trim().slice(0, 200),
        content: entry.candidate.content.trim().slice(0, 2_000),
        recallWhen: (entry.candidate.recallWhen.trim() || entry.candidate.title.trim()).slice(0, 500),
        matchTerms: Object.freeze(entry.candidate.matchTerms
          .map((term) => normalizeMatchTerm(term))
          .filter((term): term is string => term !== null)
          .slice(0, SECONDARY_MAX_MATCH_TERMS)),
        relation: entry.candidate.relation,
        reason: entry.candidate.reason.trim().slice(0, 500),
        supportLevel: entry.candidate.supportLevel,
        evidence: entry.candidate.evidence.trim().slice(0, 800),
        // 宽 key 替换更新 confidence 到获胜候选；命中历史原样保留。
        confidence: entry.confidence,
        sourceMemoryRevision: input.parentRevision,
        updatedAt: input.now,
        revision: replaced.revision + 1
      });
      reusedIds.add(replaced.id);
      finalRecords.push(updated);
      fileChanges.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      factsReused += 1;
      continue;
    }
    const created = createSecondaryRecord({
      parentId: input.parentId,
      title: entry.candidate.title,
      content: entry.candidate.content,
      recallWhen: entry.candidate.recallWhen,
      matchTerms: entry.candidate.matchTerms,
      relation: entry.candidate.relation,
      reason: entry.candidate.reason,
      basis: "llm_inferred",
      confidence: entry.confidence,
      supportLevel: entry.candidate.supportLevel,
      evidence: entry.candidate.evidence,
      sourceMemoryRevision: input.parentRevision,
      now: input.now,
      idFactory: makeId
    });
    finalRecords.push(created);
    fileChanges.push({ relativePath: created.file, content: serializeSecondaryRecord(created) });
    factsCreated += 1;
  }
  // 去重保留下来的既有事实：原样留在最终集合中（无文件变更）。
  for (const record of oldLlm) {
    if (!keptOldIds.has(record.id)) continue;
    finalRecords.push(record);
    factsReused += 1;
  }
  for (const record of oldLlm) {
    if (reusedIds.has(record.id) || keptOldIds.has(record.id)) continue;
    const retired: SecondaryMemoryRecord = Object.freeze({
      ...record,
      status: "disabled",
      disabledReason: "redream_replaced",
      updatedAt: input.now,
      revision: record.revision + 1
    });
    finalRecords.push(retired);
    fileChanges.push({ relativePath: retired.file, content: serializeSecondaryRecord(retired) });
    factsRetired += 1;
  }

  finalRecords.sort(
    (left, right) => left.id.localeCompare(right.id)
  );
  return Object.freeze({
    records: Object.freeze(finalRecords),
    fileChanges: Object.freeze(fileChanges),
    factsCreated,
    factsReused,
    factsRetired
  });
}

// ---------------------------------------------------------------------------
// Hit-driven lifecycle (做梦 PRD §9)
// ---------------------------------------------------------------------------

export function applySecondaryHit(
  record: SecondaryMemoryRecord,
  now: number
): SecondaryMemoryRecord {
  return Object.freeze({
    ...record,
    hitCount: record.hitCount + 1,
    lastHitAt: now,
    confidence: Math.min(1, record.confidence + SECONDARY_HIT_CONFIDENCE_STEP),
    updatedAt: now,
    revision: record.revision + 1
  });
}

export interface SecondaryDecayResult {
  readonly record: SecondaryMemoryRecord;
  readonly decayed: boolean;
  readonly autoDisabled: boolean;
}

/**
 * Idempotent decay. A full 30-day no-hit period decays once and advances
 * lastDecayAt; running again inside the same period (e.g. day 31 right after
 * day 30) does NOT decay twice.
 */
/**
 * 进入 Recall Index 的二级事实（做梦 PRD §11）：confidence 低于准入阈值
 * 0.60 后从索引移除（不再参与召回），但历史文件与记录保留。
 */
export function indexableSecondaryRecords(
  records: readonly SecondaryMemoryRecord[]
): readonly SecondaryMemoryRecord[] {
  return records.filter(
    (record) => record.status === "current"
      // 用户主动修改过的事实持续参与索引，不再被低置信阈值移出；
      // 只有删除或父 Memory 生命周期失效才停止召回。
      && (record.basis === "user_edited_inference" || record.confidence >= SECONDARY_CONFIDENCE_THRESHOLD)
  );
}

export function applySecondaryDecay(
  record: SecondaryMemoryRecord,
  now: number
): SecondaryDecayResult {
  if (record.status !== "current") {
    return { record, decayed: false, autoDisabled: false };
  }
  // 用户编辑过的事实不再自动衰减（做梦 PRD §11 / 低置信召回修复）。
  if (record.basis === "user_edited_inference") {
    return { record, decayed: false, autoDisabled: false };
  }
  const graceMs = SECONDARY_DECAY_GRACE_DAYS * MS_PER_DAY;
  const anchor = Math.max(
    record.lastHitAt ?? record.createdAt,
    record.lastDecayAt ?? 0,
    record.createdAt
  );
  const elapsed = now - anchor;
  if (elapsed < graceMs) return { record, decayed: false, autoDisabled: false };
  const periods = Math.floor(elapsed / graceMs);
  const confidence = Math.max(0, record.confidence * Math.pow(SECONDARY_DECAY_FACTOR, periods));
  // 真正发生衰减才 revision +1；跨多个周期一次计算也只算一次持久化变更，
  // 自动 disabled 与衰减在同一次 revision 变化中完成。
  let next: SecondaryMemoryRecord = Object.freeze({
    ...record,
    confidence,
    lastDecayAt: anchor + periods * graceMs,
    updatedAt: now,
    revision: record.revision + 1
  });
  let autoDisabled = false;
  if (next.basis === "llm_inferred" && next.confidence < SECONDARY_MIN_CONFIDENCE) {
    next = Object.freeze({ ...next, status: "disabled", disabledReason: "low_confidence" });
    autoDisabled = true;
  }
  return { record: next, decayed: true, autoDisabled };
}
