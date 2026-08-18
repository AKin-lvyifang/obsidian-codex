/**
 * MemoryExpansionService — orchestrates LLM-based divergent expansion for memories.
 *
 * Flow:
 *   1. Take a memory record's content
 *   2. Build prompt from templates (memory-expansion-prompt.ts)
 *   3. Call the active Provider LLM
 *   4. Parse JSON response into structured anchors
 *   5. Score each anchor by relation_type
 *   6. Deduplicate, truncate to max count
 *   7. Return validated MemoryAnchor[] ready for storage
 *
 * This module does NOT call the LLM directly — it accepts a `callLlm` port
 * so it stays decoupled from any specific Provider implementation.
 */

import {
  MEMORY_ANCHOR_MAX_PER_RECORD,
  type AnchorRelationType,
  type MemoryAnchor
} from "./personal-memory-contracts";
import {
  EXPANSION_SYSTEM_PROMPT,
  buildExpansionUserPrompt,
  truncateForExpansion
} from "./memory-expansion-prompt";

// ---------------------------------------------------------------------------
// Port interface (decouples from Provider)
// ---------------------------------------------------------------------------

/** Minimal LLM call port. The caller provides the actual Provider integration. */
export interface ExpansionLlmPort {
  call(input: Readonly<{
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
  }>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExpansionConfig {
  /** Max tokens for the LLM response. Default 1024. */
  readonly maxResponseTokens?: number;
  /** Override max anchors per record. Default MEMORY_ANCHOR_MAX_PER_RECORD. */
  readonly maxAnchors?: number;
}

const DEFAULT_MAX_RESPONSE_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Confidence scoring by relation_type
// ---------------------------------------------------------------------------

const RELATION_CONFIDENCE: Record<AnchorRelationType, number> = {
  hypernym: 0.8,
  hyponym: 0.7,
  attribute: 0.6,
  associated: 0.5,
  contextual: 0.4
};

function scoreByRelationType(relationType: string): number {
  const valid = relationType as AnchorRelationType;
  return RELATION_CONFIDENCE[valid] ?? 0.3; // unknown types get low confidence
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawAnchorEntry {
  term?: unknown;
  relation_type?: unknown;
}

const VALID_RELATION_TYPES: ReadonlySet<string> = new Set([
  "hypernym", "hyponym", "attribute", "associated", "contextual"
]);

function parseExpansionResponse(raw: string): readonly RawAnchorEntry[] {
  // Try to extract JSON array from response (LLM may wrap in markdown fences)
  const jsonMatch = raw.match(/\[[\s\S]*\]/u);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RawAnchorEntry =>
        item !== null && typeof item === "object" && !Array.isArray(item)
    );
  } catch {
    return [];
  }
}

function isValidAnchorTerm(term: unknown): term is string {
  return typeof term === "string"
    && term.trim().length > 0
    && term.trim().length <= 20;
}

function isValidRelationType(rt: unknown): rt is AnchorRelationType {
  return typeof rt === "string" && VALID_RELATION_TYPES.has(rt);
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

export interface ExpansionResult {
  readonly anchors: readonly MemoryAnchor[];
  readonly rawCount: number;
  readonly validCount: number;
  readonly truncated: boolean;
}

/**
 * Expand a single memory record into anchor terms via LLM.
 */
export async function expandMemory(
  llm: ExpansionLlmPort,
  memoryContent: string,
  memoryKind: string,
  config: ExpansionConfig = {}
): Promise<ExpansionResult> {
  const maxTokens = config.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS;
  const maxAnchors = config.maxAnchors ?? MEMORY_ANCHOR_MAX_PER_RECORD;
  const truncatedContent = truncateForExpansion(memoryContent);

  // 1. Call LLM
  const rawResponse = await llm.call({
    systemPrompt: EXPANSION_SYSTEM_PROMPT,
    userPrompt: buildExpansionUserPrompt(truncatedContent, memoryKind),
    maxTokens
  });

  // 2. Parse
  const rawEntries = parseExpansionResponse(rawResponse);
  const rawCount = rawEntries.length;

  // 3. Validate and score
  const nowMs = Date.now();
  const seen = new Set<string>();
  const validAnchors: MemoryAnchor[] = [];

  for (const entry of rawEntries) {
    if (!isValidAnchorTerm(entry.term)) continue;
    if (!isValidRelationType(entry.relation_type)) continue;

    const normalizedTerm = entry.term.trim().normalize("NFKC");
    const lowerTerm = normalizedTerm.toLocaleLowerCase();

    // Deduplicate
    if (seen.has(lowerTerm)) continue;
    seen.add(lowerTerm);

    validAnchors.push(Object.freeze({
      term: normalizedTerm,
      relationType: entry.relation_type,
      confidence: scoreByRelationType(entry.relation_type),
      generatedAt: nowMs,
      lastHitAt: null,
      hitCount: 0
    }));
  }

  // 4. Sort by confidence descending, truncate to limit
  validAnchors.sort((a, b) => b.confidence - a.confidence);
  const truncated = validAnchors.length > maxAnchors;
  const finalAnchors = Object.freeze(validAnchors.slice(0, maxAnchors));

  return Object.freeze({
    anchors: finalAnchors,
    rawCount,
    validCount: validAnchors.length,
    truncated
  });
}
