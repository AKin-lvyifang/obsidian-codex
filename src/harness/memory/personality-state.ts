/**
 * personality-state.ts — durable personality truth source and evolution rules.
 *
 * Stored at `.echoink/agents/echoink/personality-state.json`
 * (schema `echoink.personality.v1`, 人格系统重构草案 §6).
 *
 * Hard rules implemented here:
 * - explicit 与 observed 是两个独立槽位，绝不互相覆盖。
 * - observed 更新只能 supersede 上一个 observed，不能 supersede explicit。
 * - 当前六维值优先读 observed；没有 observed 时回退 explicit。
 * - candidates / sourceMemoryIds / processedSources 全部持久化在状态文件里。
 * - 普通 observed 信号至少需要 3 个独立来源、方向一致才更新 trait。
 * - 单次变化最大 0.1，强度参与实际增量计算。
 */

import path from "node:path";
import {
  PERSONALITY_STATE_SCHEMA,
  type PersonalMemoryBasis
} from "./personal-memory-contracts";
import {
  TRAIT_DIMENSIONS,
  clampTraitScore,
  getPersonalityTemplate,
  type TraitDimension
} from "./personality-templates";
import {
  cognitiveJsonText,
  cognitiveReadJsonOrNull,
  newCognitiveId,
  normalizeTextForDedupe
} from "./cognitive-file-utils";

// ---------------------------------------------------------------------------
// Types (草案 §6)
// ---------------------------------------------------------------------------

export type PersonalityTraitBasis = "explicit" | "observed";

export interface PersonalityTraitRecord {
  readonly id: string;
  readonly dimension: TraitDimension;
  readonly basis: PersonalityTraitBasis;
  readonly status: "current" | "superseded";
  readonly score: number;
  readonly sourceMemoryIds: readonly string[];
  readonly evidence: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  /** Why this record was superseded ("reset" | "observed_update" | ...). */
  readonly reason?: string;
}

export interface TraitCandidateRecord {
  readonly id: string;
  readonly dimension: TraitDimension;
  readonly direction: "increase" | "decrease";
  readonly strength: number;
  readonly sourceMemoryId: string;
  readonly sourceMemoryRevision: number;
  readonly evidence: string;
  readonly createdAt: number;
}

export type AgentRequirementBasis = "explicit_memory" | "observed_memory";

export interface AgentRequirementRecord {
  readonly id: string;
  readonly text: string;
  readonly basis: AgentRequirementBasis;
  readonly status: "current" | "superseded";
  readonly sourceMemoryIds: readonly string[];
  readonly revision: number;
  readonly reason?: string;
}

export interface ProcessedMemorySource {
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly processedAt: number;
}

export interface PersonalityState {
  readonly schema: typeof PERSONALITY_STATE_SCHEMA;
  readonly revision: number;
  readonly templateId: string | null;
  readonly explicit: Readonly<Record<TraitDimension, PersonalityTraitRecord | null>>;
  readonly observed: Readonly<Record<TraitDimension, PersonalityTraitRecord | null>>;
  readonly history: readonly PersonalityTraitRecord[];
  readonly candidates: readonly TraitCandidateRecord[];
  readonly learnedRequirements: readonly AgentRequirementRecord[];
  readonly processedSources: readonly ProcessedMemorySource[];
  readonly updatedAt: number;
}

/** 至少需要多少个方向一致的独立来源才允许更新 observed trait。 */
export const PERSONALITY_OBSERVED_MIN_SOURCES = 3;
/** 单次 observed 变化的最大幅度。 */
export const PERSONALITY_MAX_STEP = 0.1;
/** AGENT.md 渲染时最多保留的 current 长期要求条数。 */
export const PERSONALITY_MAX_RENDERED_REQUIREMENTS = 12;

const HISTORY_CAP = 240;

// ---------------------------------------------------------------------------
// Store (read + validate; writes go through the repository transaction)
// ---------------------------------------------------------------------------

export const PERSONALITY_STATE_RELATIVE_PATH = path.posix.join(
  "agents", "echoink", "personality-state.json"
);

export class PersonalityStateStore {
  readonly filePath: string;

  constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, PERSONALITY_STATE_RELATIVE_PATH);
  }

  async read(): Promise<PersonalityState | null> {
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    if (!raw) return null;
    return parsePersonalityState(raw);
  }
}

export function emptyPersonalityState(now: number): PersonalityState {
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision: 0,
    templateId: null,
    explicit: emptyTraitSlots(),
    observed: emptyTraitSlots(),
    history: Object.freeze([]),
    candidates: Object.freeze([]),
    learnedRequirements: Object.freeze([]),
    processedSources: Object.freeze([]),
    updatedAt: now
  });
}

export function personalityStateJson(state: PersonalityState): string {
  return cognitiveJsonText(state);
}

// ---------------------------------------------------------------------------
// Pure state transitions
// ---------------------------------------------------------------------------

/** Current six scores for the hexagon: observed 优先，回退 explicit，缺省 0.5。 */
export function currentPersonalityScores(
  state: PersonalityState | null
): Readonly<Record<TraitDimension, number>> {
  const scores: Record<TraitDimension, number> = {
    tempo: 0.5, energy: 0.5, mind: 0.5, warmth: 0.5, order: 0.5, stance: 0.5
  };
  if (!state) return Object.freeze(scores);
  for (const dimension of TRAIT_DIMENSIONS) {
    const observed = state.observed[dimension];
    const explicit = state.explicit[dimension];
    const record = observed ?? explicit;
    if (record) scores[dimension] = clampTraitScore(record.score);
  }
  return Object.freeze(scores);
}

/** Explicit template baseline scores (for the hexagon baseline overlay). */
export function templateBaselineScores(
  state: PersonalityState | null
): Readonly<Record<TraitDimension, number>> | null {
  const template = getPersonalityTemplate(state?.templateId);
  if (!template) return null;
  return template.scores;
}

export interface ApplyTemplateInput {
  readonly templateId: string;
  readonly now: number;
  /** true 表示「重置人格」：supersede observed 与长期要求，并清空候选与已处理来源。 */
  readonly reset: boolean;
  readonly idFactory?: () => string;
}

/**
 * Apply (or reset to) a template. Pure: returns the next state.
 *
 * Per 草案 §4.2 / §10.3 this is done in one local transaction by the caller —
 * no Provider involved, so it must succeed without any model.
 */
export function applyTemplateToState(
  previous: PersonalityState,
  input: ApplyTemplateInput
): PersonalityState {
  const template = getPersonalityTemplate(input.templateId);
  if (!template) throw new Error(`Unknown personality template: ${input.templateId}`);
  const makeId = input.idFactory ?? (() => newCognitiveId("trait"));
  const revision = previous.revision + 1;
  const history: PersonalityTraitRecord[] = [...previous.history];

  const explicit: Record<TraitDimension, PersonalityTraitRecord | null> = { ...previous.explicit };
  for (const dimension of TRAIT_DIMENSIONS) {
    const old = explicit[dimension];
    if (old && old.status === "current") {
      const superseded: PersonalityTraitRecord = {
        ...old,
        status: "superseded",
        updatedAt: input.now,
        revision,
        reason: input.reset ? "reset" : "template_replaced"
      };
      explicit[dimension] = null;
      history.push(superseded);
    }
    explicit[dimension] = Object.freeze({
      id: makeId(),
      dimension,
      basis: "explicit",
      status: "current",
      score: clampTraitScore(template.scores[dimension]),
      sourceMemoryIds: Object.freeze([]),
      evidence: `用户选择模板「${template.labelZh}」`,
      createdAt: input.now,
      updatedAt: input.now,
      revision
    });
  }

  let observed: Record<TraitDimension, PersonalityTraitRecord | null> = { ...previous.observed };
  let learnedRequirements: AgentRequirementRecord[] = [...previous.learnedRequirements];
  let candidates: readonly TraitCandidateRecord[] = previous.candidates;
  let processedSources: readonly ProcessedMemorySource[] = previous.processedSources;

  if (input.reset) {
    // observed 与 learnedRequirements 以 reason=reset 标记 superseded，历史保留。
    for (const dimension of TRAIT_DIMENSIONS) {
      const old = observed[dimension];
      if (old && old.status === "current") {
        history.push({
          ...old,
          status: "superseded",
          updatedAt: input.now,
          revision,
          reason: "reset"
        });
        observed[dimension] = null;
      }
    }
    learnedRequirements = learnedRequirements.map((requirement) =>
      requirement.status === "current"
        ? { ...requirement, status: "superseded", revision, reason: "reset" }
        : requirement
    );
    // 清空尚未成立的候选；把有效 Memory 重新标记为待做梦来源。
    candidates = Object.freeze([]);
    processedSources = Object.freeze([]);
  }

  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision,
    templateId: template.id,
    explicit: Object.freeze(explicit),
    observed: Object.freeze(observed),
    history: Object.freeze(pruneHistory(history)),
    candidates: Object.freeze(candidates),
    learnedRequirements: Object.freeze(learnedRequirements),
    processedSources: Object.freeze(processedSources),
    updatedAt: input.now
  });
}

export interface DreamPersonalityInput {
  readonly signals: readonly Readonly<{
    dimension: TraitDimension;
    direction: "increase" | "decrease";
    strength: number;
    evidence: string;
    sourceMemoryId: string;
    sourceMemoryRevision: number;
  }>[];
  readonly requirements: readonly Readonly<{
    text: string;
    basis: AgentRequirementBasis;
    sourceMemoryId: string;
  }>[];
  readonly processedSources: readonly Readonly<{
    memoryId: string;
    memoryRevision: number;
  }>[];
  readonly now: number;
}

/**
 * Apply one dreaming round's personality work to the state (pure).
 *
 * - signals become persisted candidates; a dimension only changes after
 *   PERSONALITY_OBSERVED_MIN_SOURCES consistent independent sources;
 * - observed never supersedes explicit;
 * - explicit Agent requirements go straight into learnedRequirements;
 * - processedSources are persisted so restarts never reprocess blindly.
 */
export function applyDreamPersonalityUpdate(
  previous: PersonalityState,
  input: DreamPersonalityInput
): PersonalityState {
  const revision = previous.revision + 1;
  const history: PersonalityTraitRecord[] = [...previous.history];
  let candidates: TraitCandidateRecord[] = [...previous.candidates];

  // 1. Persist incoming candidates (dedupe by source+dimension).
  for (const signal of input.signals) {
    if (!TRAIT_DIMENSIONS.includes(signal.dimension)) continue;
    const duplicate = candidates.some((candidate) =>
      candidate.dimension === signal.dimension
      && candidate.sourceMemoryId === signal.sourceMemoryId
    );
    if (duplicate) continue;
    candidates.push(Object.freeze({
      id: newCognitiveId("cand"),
      dimension: signal.dimension,
      direction: signal.direction === "decrease" ? "decrease" : "increase",
      strength: Math.max(0, Math.min(1, signal.strength)),
      sourceMemoryId: signal.sourceMemoryId,
      sourceMemoryRevision: signal.sourceMemoryRevision,
      evidence: signal.evidence.slice(0, 500),
      createdAt: input.now
    }));
  }

  // 2. Evolve each dimension that has enough consistent independent sources.
  const observed: Record<TraitDimension, PersonalityTraitRecord | null> = { ...previous.observed };
  for (const dimension of TRAIT_DIMENSIONS) {
    const dimensionCandidates = candidates.filter((candidate) => candidate.dimension === dimension);
    if (dimensionCandidates.length === 0) continue;
    const byDirection = (direction: "increase" | "decrease") => {
      const sources = new Map<string, TraitCandidateRecord>();
      for (const candidate of dimensionCandidates.filter((c) => c.direction === direction)) {
        if (!sources.has(candidate.sourceMemoryId)) sources.set(candidate.sourceMemoryId, candidate);
      }
      return [...sources.values()];
    };
    const increases = byDirection("increase");
    const decreases = byDirection("decrease");
    const dominant = increases.length >= decreases.length ? increases : decreases;
    const direction: "increase" | "decrease" = dominant === increases ? "increase" : "decrease";
    if (dominant.length < PERSONALITY_OBSERVED_MIN_SOURCES) continue;

    const baseRecord = observed[dimension] ?? previous.explicit[dimension];
    const baseScore = baseRecord ? clampTraitScore(baseRecord.score) : 0.5;
    const averageStrength = dominant.reduce((sum, c) => sum + c.strength, 0) / dominant.length;
    const delta = Math.min(PERSONALITY_MAX_STEP, averageStrength * PERSONALITY_MAX_STEP);
    const nextScore = clampTraitScore(baseScore + (direction === "increase" ? delta : -delta));
    if (Math.abs(nextScore - baseScore) < 0.005) {
      candidates = candidates.filter((candidate) => candidate.dimension !== dimension);
      continue;
    }

    const oldObserved = observed[dimension];
    if (oldObserved && oldObserved.status === "current") {
      history.push({
        ...oldObserved,
        status: "superseded",
        updatedAt: input.now,
        revision,
        reason: "observed_update"
      });
    }
    observed[dimension] = Object.freeze({
      id: newCognitiveId("trait"),
      dimension,
      basis: "observed",
      status: "current",
      score: nextScore,
      sourceMemoryIds: Object.freeze(dominant.map((candidate) => candidate.sourceMemoryId)),
      evidence: dominant.slice(0, 3).map((candidate) => candidate.evidence).join("；").slice(0, 800),
      createdAt: input.now,
      updatedAt: input.now,
      revision
    });
    candidates = candidates.filter((candidate) => candidate.dimension !== dimension);
  }

  // 3. Learned requirements (dedupe by normalized text).
  const learnedRequirements: AgentRequirementRecord[] = [...previous.learnedRequirements];
  for (const requirement of input.requirements) {
    const text = requirement.text.trim();
    if (!text) continue;
    const normalized = normalizeTextForDedupe(text);
    const existing = learnedRequirements.find(
      (item) => item.status === "current" && normalizeTextForDedupe(item.text) === normalized
    );
    if (existing) {
      if (!existing.sourceMemoryIds.includes(requirement.sourceMemoryId)) {
        const index = learnedRequirements.indexOf(existing);
        learnedRequirements[index] = {
          ...existing,
          sourceMemoryIds: Object.freeze([...existing.sourceMemoryIds, requirement.sourceMemoryId]),
          revision
        };
      }
      continue;
    }
    learnedRequirements.push(Object.freeze({
      id: newCognitiveId("req"),
      text: text.slice(0, 500),
      basis: requirement.basis,
      status: "current",
      sourceMemoryIds: Object.freeze([requirement.sourceMemoryId]),
      revision
    }));
  }

  // 4. Persist processed sources (dedupe by memoryId, keep latest revision).
  const processedMap = new Map<string, ProcessedMemorySource>(
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
    schema: PERSONALITY_STATE_SCHEMA,
    revision,
    templateId: previous.templateId,
    explicit: previous.explicit,
    observed: Object.freeze(observed),
    history: Object.freeze(pruneHistory(history)),
    candidates: Object.freeze(candidates),
    learnedRequirements: Object.freeze(learnedRequirements),
    processedSources: Object.freeze([...processedMap.values()]
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId))),
    updatedAt: input.now
  });
}

/** Requirements that should render into AGENT.md (current, max 12). */
export function renderableRequirements(
  state: PersonalityState
): readonly AgentRequirementRecord[] {
  return state.learnedRequirements
    .filter((requirement) => requirement.status === "current")
    .slice(0, PERSONALITY_MAX_RENDERED_REQUIREMENTS);
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

export function parsePersonalityState(raw: Record<string, unknown>): PersonalityState | null {
  if (raw.schema !== PERSONALITY_STATE_SCHEMA) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) return null;
  const explicit = parseTraitSlots(raw.explicit);
  const observed = parseTraitSlots(raw.observed);
  if (!explicit || !observed) return null;
  const history = Array.isArray(raw.history)
    ? raw.history.map(parseTraitRecord).filter((record): record is PersonalityTraitRecord => record !== null)
    : [];
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(parseCandidate).filter((candidate): candidate is TraitCandidateRecord => candidate !== null)
    : [];
  const learnedRequirements = Array.isArray(raw.learnedRequirements)
    ? raw.learnedRequirements.map(parseRequirement).filter((requirement): requirement is AgentRequirementRecord => requirement !== null)
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
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision: raw.revision,
    templateId: typeof raw.templateId === "string" ? raw.templateId : null,
    explicit,
    observed,
    history: Object.freeze(history),
    candidates: Object.freeze(candidates),
    learnedRequirements: Object.freeze(learnedRequirements),
    processedSources: Object.freeze(processedSources),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyTraitSlots(): Readonly<Record<TraitDimension, PersonalityTraitRecord | null>> {
  const slots: Record<TraitDimension, PersonalityTraitRecord | null> = {
    tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null
  };
  return Object.freeze(slots);
}

function parseTraitSlots(
  raw: unknown
): Readonly<Record<TraitDimension, PersonalityTraitRecord | null>> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const slots: Record<TraitDimension, PersonalityTraitRecord | null> = {
    tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null
  };
  for (const dimension of TRAIT_DIMENSIONS) {
    const value = record[dimension];
    if (value === null || value === undefined) {
      slots[dimension] = null;
      continue;
    }
    const parsed = parseTraitRecord(value);
    if (!parsed) return null;
    slots[dimension] = parsed;
  }
  return Object.freeze(slots);
}

function parseTraitRecord(raw: unknown): PersonalityTraitRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (!TRAIT_DIMENSIONS.includes(record.dimension as TraitDimension)) return null;
  if (record.basis !== "explicit" && record.basis !== "observed") return null;
  if (record.status !== "current" && record.status !== "superseded") return null;
  if (typeof record.score !== "number") return null;
  return Object.freeze({
    id: record.id,
    dimension: record.dimension as TraitDimension,
    basis: record.basis as PersonalityTraitBasis,
    status: record.status as "current" | "superseded",
    score: clampTraitScore(record.score),
    sourceMemoryIds: Object.freeze(
      Array.isArray(record.sourceMemoryIds)
        ? record.sourceMemoryIds.filter((id): id is string => typeof id === "string")
        : []
    ),
    evidence: typeof record.evidence === "string" ? record.evidence : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    revision: typeof record.revision === "number" ? record.revision : 0,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {})
  });
}

function parseCandidate(raw: unknown): TraitCandidateRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (!TRAIT_DIMENSIONS.includes(record.dimension as TraitDimension)) return null;
  if (record.direction !== "increase" && record.direction !== "decrease") return null;
  if (typeof record.sourceMemoryId !== "string") return null;
  return Object.freeze({
    id: record.id,
    dimension: record.dimension as TraitDimension,
    direction: record.direction,
    strength: typeof record.strength === "number" ? Math.max(0, Math.min(1, record.strength)) : 0.5,
    sourceMemoryId: record.sourceMemoryId,
    sourceMemoryRevision: typeof record.sourceMemoryRevision === "number" ? record.sourceMemoryRevision : 0,
    evidence: typeof record.evidence === "string" ? record.evidence : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0
  });
}

function parseRequirement(raw: unknown): AgentRequirementRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.text !== "string") return null;
  const basis = record.basis === "observed_memory" ? "observed_memory" : "explicit_memory";
  return Object.freeze({
    id: record.id,
    text: record.text,
    basis: basis as AgentRequirementBasis,
    status: record.status === "superseded" ? "superseded" : "current",
    sourceMemoryIds: Object.freeze(
      Array.isArray(record.sourceMemoryIds)
        ? record.sourceMemoryIds.filter((id): id is string => typeof id === "string")
        : []
    ),
    revision: typeof record.revision === "number" ? record.revision : 0,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {})
  });
}

function pruneHistory(history: PersonalityTraitRecord[]): PersonalityTraitRecord[] {
  if (history.length <= HISTORY_CAP) return history;
  const current = history.filter((record) => record.status === "current");
  const superseded = history
    .filter((record) => record.status !== "current")
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return [...current, ...superseded.slice(0, Math.max(0, HISTORY_CAP - current.length))];
}

/** Convenience for tests: whether a memory source has been processed. */
export function isMemoryProcessedByPersonality(
  state: PersonalityState | null,
  memoryId: string,
  memoryRevision: number
): boolean {
  if (!state) return false;
  const processed = state.processedSources.find((source) => source.memoryId === memoryId);
  return Boolean(processed && processed.memoryRevision >= memoryRevision);
}

export type PersonalityRequirementBasisInput = PersonalMemoryBasis;
