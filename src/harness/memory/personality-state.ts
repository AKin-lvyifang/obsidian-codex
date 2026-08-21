/**
 * personality-state.ts — durable personality truth source and evolution rules.
 *
 * Stored at `.echoink/agents/echoink/personality-state.json`
 * (schema `echoink.personality.v2`, 人格系统重构草案 §6；v1→v2 迁移见
 * buildPersonalityV2FromLegacy 与 CognitiveSystem.create)。
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
  PERSONALITY_STATE_SCHEMA_V1,
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
  cognitivePathExists,
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
    return parsePersonalityStateV2(raw);
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
  const scores = {} as Record<TraitDimension, number>;
  for (const dimension of TRAIT_DIMENSIONS) scores[dimension] = 0.5;
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
  /**
   * true 表示「首次选择模板」（此前 templateId 为空，Round 6 修复二）：
   * 模板前产生的 observed 标记 superseded（reason=initial_template_selection），
   * 清空候选与 processedSources，但保留 learnedRequirements。
   */
  readonly initialSelection?: boolean;
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

  if (input.initialSelection) {
    // 首次选择模板（Round 6 修复二）：模板前做梦沉淀的 observed 不能作为模板
    // 之后的观测事实继续生效，以 initial_template_selection 标记退出并保留历史；
    // learnedRequirements（用户可见的长期要求）保留。
    for (const dimension of TRAIT_DIMENSIONS) {
      const old = observed[dimension];
      if (old && old.status === "current") {
        history.push({
          ...old,
          status: "superseded",
          updatedAt: input.now,
          revision,
          reason: "initial_template_selection"
        });
        observed[dimension] = null;
      }
    }
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

  // 1. Persist incoming candidates.
  //    同一 sourceMemoryId + dimension + sourceMemoryRevision 不重复进入；
  //    同一来源 revision 变化时，旧 candidate 必须被替换，不能继续占位。
  for (const signal of input.signals) {
    if (!TRAIT_DIMENSIONS.includes(signal.dimension)) continue;
    const existingIndex = candidates.findIndex((candidate) =>
      candidate.dimension === signal.dimension
      && candidate.sourceMemoryId === signal.sourceMemoryId
    );
    if (existingIndex >= 0) {
      const existing = candidates[existingIndex];
      if (existing.sourceMemoryRevision === signal.sourceMemoryRevision) continue;
      candidates.splice(existingIndex, 1);
    }
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
    // 必须方向占明显多数：dominantSources >= 3 且严格多于对立来源。
    // increase 与 decrease 平票时不更新，候选继续保留，不武断选 increase。
    const dominant = increases.length > decreases.length ? increases : decreases;
    const opposite = dominant === increases ? decreases : increases;
    const direction: "increase" | "decrease" = dominant === increases ? "increase" : "decrease";
    if (dominant.length < PERSONALITY_OBSERVED_MIN_SOURCES) continue;
    if (dominant.length <= opposite.length) continue;

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

/**
 * Round 6 修复五：找出本轮以「更高 revision」重新处理的同一批 Memory。
 * 判断标准只有一条：本轮 processedSources 条目的 memoryRevision 高于状态中
 * 同一 memoryId 的历史条目。supersede 会生成新 ID，但 forget+restore 保持
 * 同一 ID、revision 升高——那正是必须撤销旧派生的场景。
 */
export function computeReprocessedMemoryIds(
  previous: PersonalityState,
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
 * Round 6 修复五：在应用新一轮做梦输出之前，撤销旧 revision 产生的派生证据：
 * - candidates：按 sourceMemoryId 整体移除（新轮输出会重新生成）；
 * - learnedRequirements：从来源中移除该 Memory；来源清空则标记
 *   superseded（reason=source_reprocessed）；
 * - observed：从 sourceMemoryIds 移除该 Memory；仍有证据则保留记录，
 *   证据清空则标记 superseded（reason=source_reprocessed）、槽位置空。
 * 纯函数；无撤销对象时返回原引用。与新一轮输出在同一事务内提交，
 * 因此「只有成功重新处理才撤销」天然成立。
 */
export function revokeReprocessedPersonalitySources(
  previous: PersonalityState,
  reprocessedIds: ReadonlySet<string>,
  now: number
): PersonalityState {
  if (reprocessedIds.size === 0) return previous;
  let changed = false;

  // 1. Candidates sourced from the reprocessed memories leave entirely.
  const candidates = previous.candidates.filter(
    (candidate) => !reprocessedIds.has(candidate.sourceMemoryId)
  );
  if (candidates.length !== previous.candidates.length) changed = true;

  // 2. Learned requirements: drop the reprocessed sources; retire when empty.
  const revision = previous.revision + 1;
  const learnedRequirements: AgentRequirementRecord[] = [];
  for (const requirement of previous.learnedRequirements) {
    if (requirement.status !== "current"
      || !requirement.sourceMemoryIds.some((id) => reprocessedIds.has(id))) {
      learnedRequirements.push(requirement);
      continue;
    }
    changed = true;
    const alive = requirement.sourceMemoryIds.filter((id) => !reprocessedIds.has(id));
    if (alive.length === 0) {
      learnedRequirements.push({
        ...requirement,
        status: "superseded",
        sourceMemoryIds: Object.freeze([]),
        revision,
        reason: "source_reprocessed"
      });
    } else {
      learnedRequirements.push({
        ...requirement,
        sourceMemoryIds: Object.freeze(alive),
        revision
      });
    }
  }

  // 3. Observed traits: drop the reprocessed sources; retire when empty.
  const history: PersonalityTraitRecord[] = [...previous.history];
  const observed: Record<TraitDimension, PersonalityTraitRecord | null> = { ...previous.observed };
  for (const dimension of TRAIT_DIMENSIONS) {
    const record = observed[dimension];
    if (!record || record.status !== "current") continue;
    if (!record.sourceMemoryIds.some((id) => reprocessedIds.has(id))) continue;
    changed = true;
    const alive = record.sourceMemoryIds.filter((id) => !reprocessedIds.has(id));
    if (alive.length > 0) {
      observed[dimension] = Object.freeze({
        ...record,
        sourceMemoryIds: Object.freeze(alive),
        updatedAt: now,
        revision
      });
      continue;
    }
    history.push({
      ...record,
      status: "superseded",
      updatedAt: now,
      revision,
      reason: "source_reprocessed"
    });
    observed[dimension] = null;
  }

  if (!changed) return previous;
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision,
    templateId: previous.templateId,
    explicit: previous.explicit,
    observed: Object.freeze(observed),
    history: Object.freeze(pruneHistory(history)),
    candidates: Object.freeze(candidates),
    learnedRequirements: Object.freeze(learnedRequirements),
    processedSources: previous.processedSources,
    updatedAt: now
  });
}

/**
 * Memory 来源失效回收（人格草案 §10.1 + 做梦 PRD 最新决定）：
 * 用仍然 current 的一级 Memory 对账。失效来源从候选、已处理来源、长期要求
 * 和 observed trait 中移除；要求/候选失去全部来源后标记 superseded；
 * observed trait 证据全部失效时回退上一条仍有有效证据的 observed，
 * 再没有则回退 explicit 模板基线（observed 槽位置空）。
 * 纯函数：无变化时返回原引用。
 */
export function reconcilePersonalitySources(
  previous: PersonalityState,
  validMemoryIds: ReadonlySet<string>,
  now: number
): PersonalityState {
  let changed = false;

  // 1. Candidates whose source memory is no longer current.
  const candidates = previous.candidates.filter(
    (candidate) => validMemoryIds.has(candidate.sourceMemoryId)
  );
  if (candidates.length !== previous.candidates.length) changed = true;

  // 2. Processed sources for memories that no longer exist as current.
  const processedSources = previous.processedSources.filter(
    (source) => validMemoryIds.has(source.memoryId)
  );
  if (processedSources.length !== previous.processedSources.length) changed = true;

  // 3. Learned requirements: drop dead sources; retire when none remain.
  const revision = previous.revision + 1;
  const learnedRequirements: AgentRequirementRecord[] = [];
  for (const requirement of previous.learnedRequirements) {
    if (requirement.status !== "current") {
      learnedRequirements.push(requirement);
      continue;
    }
    const alive = requirement.sourceMemoryIds.filter((id) => validMemoryIds.has(id));
    if (alive.length === requirement.sourceMemoryIds.length) {
      learnedRequirements.push(requirement);
      continue;
    }
    changed = true;
    if (alive.length === 0) {
      learnedRequirements.push({
        ...requirement,
        status: "superseded",
        sourceMemoryIds: Object.freeze([]),
        revision,
        reason: "source_lost"
      });
    } else {
      learnedRequirements.push({
        ...requirement,
        sourceMemoryIds: Object.freeze(alive),
        revision
      });
    }
  }

  // 4. Observed traits: retire or fall back when all evidence dies.
  const history: PersonalityTraitRecord[] = [...previous.history];
  const observed: Record<TraitDimension, PersonalityTraitRecord | null> = { ...previous.observed };
  for (const dimension of TRAIT_DIMENSIONS) {
    const record = observed[dimension];
    if (!record || record.status !== "current") continue;
    const alive = record.sourceMemoryIds.filter((id) => validMemoryIds.has(id));
    if (alive.length === record.sourceMemoryIds.length) continue;
    changed = true;
    if (alive.length > 0) {
      observed[dimension] = Object.freeze({
        ...record,
        sourceMemoryIds: Object.freeze(alive),
        updatedAt: now,
        revision
      });
      continue;
    }
    // All evidence invalid → supersede current observed, then fall back to the
    // newest historical observed that still has valid evidence; otherwise the
    // slot empties and scores fall back to the explicit template baseline.
    history.push({
      ...record,
      status: "superseded",
      updatedAt: now,
      revision,
      reason: "source_lost"
    });
    const fallback = [...history]
      .reverse()
      .find((entry) =>
        entry.dimension === dimension
        && entry.basis === "observed"
        && entry.status === "superseded"
        && entry.id !== record.id
        && entry.sourceMemoryIds.some((id) => validMemoryIds.has(id))
      );
    if (fallback) {
      observed[dimension] = Object.freeze({
        ...fallback,
        status: "current",
        sourceMemoryIds: Object.freeze(
          fallback.sourceMemoryIds.filter((id) => validMemoryIds.has(id))
        ),
        updatedAt: now,
        revision
      });
    } else {
      observed[dimension] = null;
    }
  }

  if (!changed) return previous;
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision,
    templateId: previous.templateId,
    explicit: previous.explicit,
    observed: Object.freeze(observed),
    history: Object.freeze(pruneHistory(history)),
    candidates: Object.freeze(candidates),
    learnedRequirements: Object.freeze(learnedRequirements),
    processedSources: Object.freeze(processedSources),
    updatedAt: now
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

/** Parse a v2 personality state; v1 or unknown schemas return null. */
export function parsePersonalityStateV2(raw: Record<string, unknown>): PersonalityState | null {
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
  const slots = {} as Record<TraitDimension, PersonalityTraitRecord | null>;
  for (const dimension of TRAIT_DIMENSIONS) slots[dimension] = null;
  return Object.freeze(slots);
}

function parseTraitSlots(
  raw: unknown
): Readonly<Record<TraitDimension, PersonalityTraitRecord | null>> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const slots = {} as Record<TraitDimension, PersonalityTraitRecord | null>;
  for (const dimension of TRAIT_DIMENSIONS) slots[dimension] = null;
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

/** Compatibility alias: parsePersonalityState === parsePersonalityStateV2. */
export const parsePersonalityState = parsePersonalityStateV2;

export type PersonalityRequirementBasisInput = PersonalMemoryBasis;

// ---------------------------------------------------------------------------
// v1 → v2 migration (Round 5 冻结决定；草案 §6/§10)
//
// 旧六维（tempo/energy/mind/warmth/order/stance）与新六维语义不兼容：
// - 保留 templateId、learnedRequirements（含 sourceMemoryIds/basis/status/reason）。
// - 用同模板的新六维分数重建 explicit baseline。
// - 旧 observed、history、candidates、processedSources 一律不进入 v2 current。
// - 迁移落盘由 CognitiveSystem.create 的一个 Repository 事务完成
//   （v1 备份 + v2 状态 + dream-state 重置 + 必要 AGENT.md 重写）。
// ---------------------------------------------------------------------------

export interface LegacyPersonalityStateV1 {
  readonly schema: typeof PERSONALITY_STATE_SCHEMA_V1;
  readonly revision: number;
  readonly templateId: string | null;
  readonly learnedRequirements: readonly AgentRequirementRecord[];
  readonly updatedAt: number;
  /** 完整原始 JSON：只用于生成历史备份；observed/history/candidates 不进入 v2。 */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 识别落盘人格状态 schema；未知或损坏返回 null。 */
export function detectPersonalityStateSchema(
  raw: Record<string, unknown>
): "v2" | "v1" | null {
  if (raw.schema === PERSONALITY_STATE_SCHEMA) return "v2";
  if (raw.schema === PERSONALITY_STATE_SCHEMA_V1) return "v1";
  return null;
}

/** 解析旧 v1 状态（只取迁移需要的字段；旧维度分数不解析为 trait 记录）。 */
export function parseLegacyPersonalityStateV1(
  raw: Record<string, unknown>
): LegacyPersonalityStateV1 | null {
  if (raw.schema !== PERSONALITY_STATE_SCHEMA_V1) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) return null;
  const learnedRequirements = Array.isArray(raw.learnedRequirements)
    ? raw.learnedRequirements
        .map(parseRequirement)
        .filter((requirement): requirement is AgentRequirementRecord => requirement !== null)
    : [];
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA_V1,
    revision: raw.revision,
    templateId: typeof raw.templateId === "string" ? raw.templateId : null,
    learnedRequirements: Object.freeze(learnedRequirements),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    raw
  });
}

/**
 * 由 v1 状态构建 v2 状态（纯函数）。
 * explicit = 同模板新六维基线；observed/candidates/processedSources 置空；
 * learnedRequirements 原样保留（status/basis/sourceMemoryIds/reason 不变）。
 */
export function buildPersonalityV2FromLegacy(
  legacy: LegacyPersonalityStateV1,
  input: Readonly<{ now: number; idFactory?: () => string }>
): PersonalityState {
  const makeId = input.idFactory ?? (() => newCognitiveId("trait"));
  const revision = legacy.revision + 1;
  const template = getPersonalityTemplate(legacy.templateId);
  const explicit = {} as Record<TraitDimension, PersonalityTraitRecord | null>;
  for (const dimension of TRAIT_DIMENSIONS) {
    explicit[dimension] = template
      ? Object.freeze({
          id: makeId(),
          dimension,
          basis: "explicit",
          status: "current",
          score: clampTraitScore(template.scores[dimension]),
          sourceMemoryIds: Object.freeze([]),
          evidence: `v1→v2 迁移：用户选择模板「${template.labelZh}」，按新六维重建基线`,
          createdAt: input.now,
          updatedAt: input.now,
          revision
        })
      : null;
  }
  return Object.freeze({
    schema: PERSONALITY_STATE_SCHEMA,
    revision,
    templateId: template ? template.id : null,
    explicit: Object.freeze(explicit),
    observed: emptyTraitSlots(),
    history: Object.freeze([]),
    candidates: Object.freeze([]),
    learnedRequirements: legacy.learnedRequirements,
    processedSources: Object.freeze([]),
    updatedAt: input.now
  });
}

// ---------------------------------------------------------------------------
// Round 6 修复三：启动时对落盘人格文件的严格体检（fail-closed 的依据）
// ---------------------------------------------------------------------------

export type PersonalityFileInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "v2"; readonly state: PersonalityState }
  | { readonly kind: "v1"; readonly legacy: LegacyPersonalityStateV1 }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * 严格体检落盘人格状态文件（Round 6 修复三）：
 * - 文件不存在 → `missing`（合法初始状态，调用方不得写空文件）；
 * - v2 且可解析 → `v2`；
 * - v1 且可解析 → `v1`（需要一次性本地迁移）；
 * - 其余（损坏 JSON / 未知 schema / 字段解析失败）→ `invalid`，
 *   调用方必须拒绝构造认知系统（fail-closed），不得降级成空状态继续写。
 * 纯读取：不写任何文件。
 */
export async function inspectPersonalityFile(
  filePath: string
): Promise<PersonalityFileInspection> {
  const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(filePath);
  if (raw === null) {
    const exists = await cognitivePathExists(filePath);
    return exists
      ? { kind: "invalid", reason: "unparseable_json" }
      : { kind: "missing" };
  }
  const schema = detectPersonalityStateSchema(raw);
  if (schema === "v2") {
    const state = parsePersonalityStateV2(raw);
    return state === null
      ? { kind: "invalid", reason: "v2_field_parse_failed" }
      : { kind: "v2", state };
  }
  if (schema === "v1") {
    const legacy = parseLegacyPersonalityStateV1(raw);
    return legacy === null
      ? { kind: "invalid", reason: "v1_field_parse_failed" }
      : { kind: "v1", legacy };
  }
  return { kind: "invalid", reason: "unknown_schema" };
}
