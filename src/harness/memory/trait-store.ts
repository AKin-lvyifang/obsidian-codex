/**
 * TraitStore — persistence layer for personality trait records.
 *
 * Stores trait records in a JSON file (traits.json) alongside the memory manifest.
 * Provides CRUD operations and renders AGENT.md from current trait state.
 *
 * Key design decisions (per 人格系统重构草案 §3.1):
 * - Trait records are the TRUE SOURCE; AGENT.md is a projection
 * - User cannot directly edit AGENT.md; reconcileMarkdownTruth is reversed
 * - Memory Tool CAN write observed traits (self-evolution)
 * - Fixed (explicit) traits come from cold-start / settings UI
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TRAIT_DIMENSIONS,
  type TraitBasis,
  type TraitDimension,
  type TraitRecord,
  type PersonalityTemplate,
  PERSONALITY_TEMPLATES
} from "./personal-memory-contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TraitStoreFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly traits: readonly TraitRecord[];
}

export interface TraitSnapshot {
  readonly revision: number;
  readonly current: Readonly<Record<TraitDimension, TraitRecord | null>>;
  readonly all: readonly TraitRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAITS_FILENAME = "traits.json";

// ---------------------------------------------------------------------------
// TraitStore class
// ---------------------------------------------------------------------------

export class TraitStore {
  private readonly filePath: string;
  private cache: TraitStoreFile | null = null;

  constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, TRAITS_FILENAME);
  }

  // --- Read ---

  async read(): Promise<TraitSnapshot> {
    const store = await this.load();
    return buildSnapshot(store);
  }

  /** Get current scores as a simple Record for hexagon rendering. */
  async getCurrentScores(): Promise<Readonly<Record<TraitDimension, number>>> {
    const snapshot = await this.read();
    const scores: Record<string, number> = {};
    for (const dim of TRAIT_DIMENSIONS) {
      const record = snapshot.current[dim];
      scores[dim] = record ? record.score : 0.5; // default to midpoint
    }
    return Object.freeze(scores) as Readonly<Record<TraitDimension, number>>;
  }

  // --- Write ---

  async upsertTrait(record: TraitRecord): Promise<number> {
    const store = await this.load();
    const newRevision = store.revision + 1;

    // If superseding, mark the old record
    let traits = [...store.traits];
    if (record.supersedes) {
      traits = traits.map((t) =>
        t.id === record.supersedes && t.status === "current"
          ? { ...t, status: "superseded" as const }
          : t
      );
    }

    // Replace or append
    const existingIndex = traits.findIndex(
      (t) => t.dimension === record.dimension && t.basis === record.basis && t.status === "current"
    );
    if (existingIndex >= 0) {
      traits[existingIndex] = record;
    } else {
      traits.push(record);
    }

    const newStore: TraitStoreFile = {
      schemaVersion: 1,
      revision: newRevision,
      traits: Object.freeze(traits)
    };
    await this.save(newStore);
    return newRevision;
  }

  /** Apply a template as initial explicit traits. */
  async applyTemplate(templateId: string, source: string): Promise<number> {
    const template = PERSONALITY_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      throw new Error(`Unknown personality template: ${templateId}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    let revision = 0;
    for (const dim of TRAIT_DIMENSIONS) {
      const record: TraitRecord = {
        id: `trait_${dim}_initial`,
        dimension: dim,
        basis: "explicit",
        status: "current",
        score: template.scores[dim],
        date,
        source,
        evidence: `Applied template "${template.label}"`,
        revision: 0
      };
      revision = await this.upsertTrait(record);
    }
    return revision;
  }

  // --- AGENT.md Rendering ---

  /** Render AGENT.md content from current trait state. */
  async renderAgentProfile(): Promise<string> {
    const snapshot = await this.read();
    return renderAgentMarkdown(snapshot);
  }

  // --- Internal ---

  private async load(): Promise<TraitStoreFile> {
    if (this.cache) return this.cache;
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as Partial<TraitStoreFile>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.traits)) {
        throw new Error("Invalid traits.json schema");
      }
      this.cache = {
        schemaVersion: 1,
        revision: parsed.revision ?? 0,
        traits: Object.freeze(parsed.traits)
      };
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty: TraitStoreFile = {
          schemaVersion: 1,
          revision: 0,
          traits: Object.freeze([])
        };
        this.cache = empty;
        return empty;
      }
      throw error;
    }
  }

  private async save(store: TraitStoreFile): Promise<void> {
    this.cache = store;
    await writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }

  /** Invalidate cache to force re-read on next access. */
  invalidateCache(): void {
    this.cache = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshot(store: TraitStoreFile): TraitSnapshot {
  const current: Record<string, TraitRecord | null> = {};
  for (const dim of TRAIT_DIMENSIONS) {
    current[dim] = null;
  }
  for (const trait of store.traits) {
    if (trait.status === "current") {
      current[trait.dimension] = trait;
    }
  }
  return Object.freeze({
    revision: store.revision,
    current: Object.freeze(current) as Readonly<Record<TraitDimension, TraitRecord | null>>,
    all: Object.freeze(store.traits)
  });
}

function renderAgentMarkdown(snapshot: TraitSnapshot): string {
  const lines: string[] = [];
  lines.push("# Agent Profile");
  lines.push("");
  lines.push("> This file is auto-generated from trait records. Do not edit manually.");
  lines.push("> Changes are made through personality settings or conversation self-evolution.");
  lines.push("");

  // Explicit traits section
  const explicitTraits = TRAIT_DIMENSIONS
    .map((dim) => snapshot.current[dim])
    .filter((t): t is TraitRecord => t !== null && t.basis === "explicit");

  if (explicitTraits.length > 0) {
    lines.push("## 人格特质");
    lines.push("");
    for (const trait of explicitTraits) {
      const poleLabel = getScoreLabel(trait.dimension, trait.score);
      lines.push(`- **${getDimensionDisplayName(trait.dimension)}**：${poleLabel}（${Math.round(trait.score * 100)}%）`);
    }
    lines.push("");
  }

  // Observed traits section
  const observedTraits = TRAIT_DIMENSIONS
    .map((dim) => snapshot.current[dim])
    .filter((t): t is TraitRecord => t !== null && t.basis === "observed");

  if (observedTraits.length > 0) {
    lines.push("## 自进化观测");
    lines.push("");
    for (const trait of observedTraits) {
      const poleLabel = getScoreLabel(trait.dimension, trait.score);
      lines.push(`- ${getDimensionDisplayName(trait.dimension)}：${poleLabel}（${trait.evidence}）`);
    }
    lines.push("");
  }

  // Expression style placeholder
  lines.push("## 表达方式");
  lines.push("");
  lines.push("- 先给结论，再展开依据");
  lines.push("- 语言自然克制，不堆砌修饰");
  lines.push("");

  return lines.join("\n");
}

function getDimensionDisplayName(dim: TraitDimension): string {
  const labels: Record<TraitDimension, string> = {
    tempo: "节奏",
    energy: "能量",
    mind: "思维",
    warmth: "温度",
    order: "秩序",
    stance: "立场"
  };
  return labels[dim];
}

function getScoreLabel(dim: TraitDimension, score: number): string {
  const poles: Record<TraitDimension, [string, string]> = {
    tempo: ["风风火火、短平快", "慢条斯理、深思熟虑"],
    energy: ["外向热烈、主动起话题", "内向安静、专注独处"],
    mind: ["天马行空、爱发散", "脚踏实地、就事论事"],
    warmth: ["理性冷静、对事不对人", "感性共情、先照顾感受"],
    order: ["规矩严谨、计划控", "随性灵活、不拘小节"],
    stance: ["随和配合、以你为准", "坚持主见、爱挑战反驳"]
  };
  const [left, right] = poles[dim];
  if (score <= 0.35) return left;
  if (score >= 0.65) return right;
  return `${left} ↔ ${right}（居中）`;
}
