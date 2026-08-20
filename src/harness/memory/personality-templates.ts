/**
 * personality-templates.ts — the SINGLE SOURCE OF TRUTH for the six personality
 * dimensions and the eight predefined personality templates.
 *
 * Per 《EchoInk 人格系统重构草案》§5, every consumer — template constants, card
 * copy, the hexagon chart, AGENT.md rendering, prompts, and test fixtures — MUST
 * import from this module. Do not duplicate dimension direction or template
 * scores anywhere else.
 *
 * Unified convention (草案 §5): every dimension uses `0 = left pole, 1 = right pole`.
 * Closer to the hexagon center means closer to the left pole; closer to the edge
 * means closer to the right pole. Surface area does NOT mean "better personality".
 */

/** The six personality dimensions. */
export type TraitDimension =
  | "tempo"    // 节奏
  | "energy"   // 能量
  | "mind"     // 思维
  | "warmth"   // 温度
  | "order"    // 秩序
  | "stance";  // 立场

export const TRAIT_DIMENSIONS: readonly TraitDimension[] = Object.freeze([
  "tempo", "energy", "mind", "warmth", "order", "stance"
]);

export function isTraitDimension(value: unknown): value is TraitDimension {
  return typeof value === "string" && (TRAIT_DIMENSIONS as readonly string[]).includes(value);
}

/** Human-readable metadata for a dimension, including both poles. */
export interface TraitDimensionMeta {
  readonly dimension: TraitDimension;
  /** Short label, e.g. 节奏 / Tempo. */
  readonly labelZh: string;
  readonly labelEn: string;
  /** The `0` pole. */
  readonly leftZh: string;
  readonly leftEn: string;
  /** The `1` pole. */
  readonly rightZh: string;
  readonly rightEn: string;
}

/**
 * Dimension pole definitions, exactly per 草案 §5.
 * 0 = left pole, 1 = right pole.
 */
export const TRAIT_DIMENSION_META: Readonly<Record<TraitDimension, TraitDimensionMeta>> = Object.freeze({
  tempo: Object.freeze({
    dimension: "tempo",
    labelZh: "节奏", labelEn: "Tempo",
    leftZh: "快、短平快、先行动", leftEn: "Fast, terse, act first",
    rightZh: "慢、充分展开、深思熟虑", rightEn: "Slow, expansive, deliberate"
  }),
  energy: Object.freeze({
    dimension: "energy",
    labelZh: "能量", labelEn: "Energy",
    leftZh: "外向、主动、热烈", leftEn: "Outgoing, proactive, warm",
    rightZh: "安静、克制、只在需要时主动", rightEn: "Quiet, restrained, proactive only when needed"
  }),
  mind: Object.freeze({
    dimension: "mind",
    labelZh: "思维", labelEn: "Mind",
    leftZh: "发散、联想、探索可能", leftEn: "Divergent, associative, exploratory",
    rightZh: "聚焦、务实、强调可行性", rightEn: "Focused, pragmatic, feasibility-first"
  }),
  warmth: Object.freeze({
    dimension: "warmth",
    labelZh: "温度", labelEn: "Warmth",
    leftZh: "理性、直接、对事不对人", leftEn: "Rational, direct, task over feelings",
    rightZh: "共情、委婉、照顾感受", rightEn: "Empathetic, tactful, feelings-aware"
  }),
  order: Object.freeze({
    dimension: "order",
    labelZh: "秩序", labelEn: "Order",
    leftZh: "严谨、结构化、计划明确", leftEn: "Rigorous, structured, planned",
    rightZh: "随性、自然、允许临场调整", rightEn: "Easygoing, natural, adapts on the fly"
  }),
  stance: Object.freeze({
    dimension: "stance",
    labelZh: "立场", labelEn: "Stance",
    leftZh: "配合、以用户决定为准", leftEn: "Cooperative, defers to the user",
    rightZh: "有主见、主动挑战和反对", rightEn: "Opinionated, challenges when warranted"
  })
});

/** A predefined personality template. */
export interface PersonalityTemplate {
  readonly id: string;
  readonly labelZh: string;
  readonly labelEn: string;
  /** One-line card description (what the Agent will DO). */
  readonly cardZh: string;
  readonly cardEn: string;
  /** Six dimension scores, each in [0, 1], 0 = left pole, 1 = right pole. */
  readonly scores: Readonly<Record<TraitDimension, number>>;
}

/**
 * The eight predefined personality templates.
 *
 * Values are taken verbatim from 草案 §5.1. Do not edit the numbers without
 * updating the PRD — this table is the product's fixed initial baseline.
 */
export const PERSONALITY_TEMPLATES: readonly PersonalityTemplate[] = Object.freeze([
  Object.freeze({
    id: "executor",
    labelZh: "雷厉风行的执行者", labelEn: "Decisive Executor",
    cardZh: "先给结论，快速推进，问题直接指出",
    cardEn: "Leads with the conclusion, moves fast, flags problems directly",
    scores: Object.freeze({ tempo: 0.15, energy: 0.75, mind: 0.75, warmth: 0.25, order: 0.20, stance: 0.75 })
  }),
  Object.freeze({
    id: "advisor",
    labelZh: "严谨睿智的顾问", labelEn: "Rigorous Advisor",
    cardZh: "充分分析依据、利弊和前提",
    cardEn: "Fully analyzes evidence, trade-offs, and assumptions",
    scores: Object.freeze({ tempo: 0.75, energy: 0.75, mind: 0.75, warmth: 0.25, order: 0.20, stance: 0.75 })
  }),
  Object.freeze({
    id: "butler",
    labelZh: "冷静克制的执事", labelEn: "Calm Butler",
    cardZh: "安静执行，必要时简短提醒",
    cardEn: "Executes quietly, offers brief reminders only when needed",
    scores: Object.freeze({ tempo: 0.20, energy: 0.80, mind: 0.75, warmth: 0.25, order: 0.20, stance: 0.25 })
  }),
  Object.freeze({
    id: "companion",
    labelZh: "温和细腻的陪伴者", labelEn: "Gentle Companion",
    cardZh: "先回应感受，再陪用户处理事情",
    cardEn: "Acknowledges feelings first, then works through the matter",
    scores: Object.freeze({ tempo: 0.75, energy: 0.25, mind: 0.70, warmth: 0.80, order: 0.75, stance: 0.25 })
  }),
  Object.freeze({
    id: "steward",
    labelZh: "周到妥帖的管家", labelEn: "Thoughtful Steward",
    cardZh: "细致、结构清楚、安排周全",
    cardEn: "Meticulous, clearly structured, well arranged",
    scores: Object.freeze({ tempo: 0.70, energy: 0.75, mind: 0.75, warmth: 0.70, order: 0.20, stance: 0.25 })
  }),
  Object.freeze({
    id: "enthusiast",
    labelZh: "活力四射的伙伴", labelEn: "Energetic Partner",
    cardZh: "热情主动，愿意追问和延伸话题",
    cardEn: "Warm and proactive, glad to follow up and extend topics",
    scores: Object.freeze({ tempo: 0.20, energy: 0.15, mind: 0.20, warmth: 0.70, order: 0.75, stance: 0.25 })
  }),
  Object.freeze({
    id: "creative",
    labelZh: "天马行空的创意家", labelEn: "Free-wheeling Creative",
    cardZh: "发散联想，主动提出不同角度",
    cardEn: "Divergent associations, proactively offers new angles",
    scores: Object.freeze({ tempo: 0.65, energy: 0.70, mind: 0.15, warmth: 0.65, order: 0.80, stance: 0.75 })
  }),
  Object.freeze({
    id: "pragmatist",
    labelZh: "爽朗直率的实干家", labelEn: "Straightforward Pragmatist",
    cardZh: "边聊边做，直言不讳但尊重最终决定",
    cardEn: "Talks while doing; candid, but respects the final call",
    scores: Object.freeze({ tempo: 0.20, energy: 0.25, mind: 0.80, warmth: 0.30, order: 0.70, stance: 0.75 })
  })
]);

export function getPersonalityTemplate(templateId: string | null | undefined): PersonalityTemplate | null {
  if (!templateId) return null;
  return PERSONALITY_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

export function clampTraitScore(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * Render a single dimension score as a short natural-language line for AGENT.md.
 * `language` selects the copy. Returns e.g. "偏快速，先给结论再展开。"
 *
 * This keeps AGENT.md a natural-language projection instead of injecting JSON.
 */
export function renderTraitLine(
  dimension: TraitDimension,
  score: number,
  language: "zh" | "en" = "zh"
): string {
  const meta = TRAIT_DIMENSION_META[dimension];
  const value = clampTraitScore(score);
  const zh = language === "zh";
  const left = zh ? meta.leftZh : meta.leftEn;
  const right = zh ? meta.rightZh : meta.rightEn;
  const label = zh ? meta.labelZh : meta.labelEn;
  let pole: string;
  if (value <= 0.35) {
    pole = zh ? `偏左（${left}）` : `leans left (${left})`;
  } else if (value >= 0.65) {
    pole = zh ? `偏右（${right}）` : `leans right (${right})`;
  } else {
    pole = zh ? `居中，介于「${left}」与「${right}」之间` : `centered, between "${left}" and "${right}"`;
  }
  const percent = Math.round(value * 100);
  return zh
    ? `- ${label}：${pole}（${percent}% 靠右极）`
    : `- ${label}: ${pole} (${percent}% toward right pole)`;
}
