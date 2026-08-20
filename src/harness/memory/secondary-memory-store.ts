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
  SECONDARY_DECAY_FACTOR,
  SECONDARY_DECAY_GRACE_DAYS,
  SECONDARY_HIT_CONFIDENCE_STEP,
  SECONDARY_MAX_MATCH_TERMS,
  SECONDARY_MAX_PER_PARENT,
  SECONDARY_MEMORY_SCHEMA,
  SECONDARY_RELATION_INITIAL_CONFIDENCE,
  SECONDARY_MIN_CONFIDENCE,
  isSecondaryRelation,
  type SecondaryBasis,
  type SecondaryMemoryRecord,
  type SecondaryRelation,
  type SecondaryStatus
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
    ["title", record.title],
    ["recall_when", record.recallWhen],
    ["match_terms", record.matchTerms],
    ["relation", record.relation],
    ["reason", record.reason],
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
    title: requireString("title", 200),
    content: lines.slice(end + 1).join("\n").trim().slice(0, 24_000),
    recallWhen: requireString("recall_when", 500),
    matchTerms: Object.freeze(matchTerms),
    relation: isSecondaryRelation(relation) ? relation : "associated",
    reason: typeof fields.get("reason") === "string" ? (fields.get("reason") as string).slice(0, 500) : "",
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
  const confidence = input.basis === "user_edited_inference"
    ? 0.7
    : SECONDARY_RELATION_INITIAL_CONFIDENCE[input.relation] ?? 0.4;
  return Object.freeze({
    schema: SECONDARY_MEMORY_SCHEMA,
    id,
    parentId: input.parentId,
    status: "current",
    title: input.title.trim().slice(0, 200),
    content: input.content.trim().slice(0, 2_000),
    recallWhen: (input.recallWhen.trim() || input.title.trim()).slice(0, 500),
    matchTerms: Object.freeze(terms),
    relation: input.relation,
    reason: input.reason.trim().slice(0, 500),
    basis: input.basis,
    sourceMemoryRevision: input.sourceMemoryRevision,
    confidence,
    hitCount: 0,
    lastHitAt: null,
    lastDecayAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 1,
    file: secondaryRelativePath(input.parentId, id)
  });
}

/** Enforce max 8 facts per parent, dedupe by normalized title+content+terms. */
export function dedupeSecondaryFacts(
  existing: readonly SecondaryMemoryRecord[],
  incoming: readonly SecondaryMemoryRecord[]
): readonly SecondaryMemoryRecord[] {
  const kept: SecondaryMemoryRecord[] = [];
  const fingerprints = new Set<string>();
  for (const record of [...existing, ...incoming]) {
    if (kept.length >= SECONDARY_MAX_PER_PARENT && !existing.includes(record)) break;
    const fingerprint = fingerprintSecondary(record);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    kept.push(record);
  }
  return kept;
}

function fingerprintSecondary(record: SecondaryMemoryRecord): string {
  const payload = [
    record.title.normalize("NFKC").toLocaleLowerCase(),
    record.content.normalize("NFKC").toLocaleLowerCase(),
    record.matchTerms.map((term) => term.normalize("NFKC").toLocaleLowerCase()).sort().join("|")
  ].join("\n");
  return createHash("sha256").update(payload).digest("hex");
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
    updatedAt: now
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
export function applySecondaryDecay(
  record: SecondaryMemoryRecord,
  now: number
): SecondaryDecayResult {
  if (record.status !== "current") {
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
  let next: SecondaryMemoryRecord = Object.freeze({
    ...record,
    confidence,
    lastDecayAt: anchor + periods * graceMs,
    updatedAt: now
  });
  let autoDisabled = false;
  if (next.basis === "llm_inferred" && next.confidence < SECONDARY_MIN_CONFIDENCE) {
    next = Object.freeze({ ...next, status: "disabled" });
    autoDisabled = true;
  }
  return { record: next, decayed: true, autoDisabled };
}
