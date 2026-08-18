/**
 * Personality Signal Detection Service.
 *
 * Determines whether a memory record contains a preference about Agent behavior,
 * and if so, extracts the personality dimension, direction, and evidence.
 *
 * Uses LLM for nuanced detection but short-circuits ineligible kinds (fact/goal/task)
 * without making any API call.
 */

import { TRAIT_DIMENSIONS, type TraitDimension } from "./personal-memory-contracts";
import {
  SIGNAL_DETECTION_SYSTEM_PROMPT,
  buildSignalDetectionUserPrompt,
  isSignalEligibleKind,
  truncateForSignalDetection
} from "./memory-personality-signal-prompt";
import type { ExpansionLlmPort } from "./memory-expansion-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalitySignal {
  readonly dimension: TraitDimension;
  readonly direction: "increase" | "decrease";
  readonly evidence: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_DIMENSIONS = new Set<string>(TRAIT_DIMENSIONS);
const VALID_DIRECTIONS = new Set(["increase", "decrease"]);

function parseSignalResponse(raw: string): PersonalitySignal | null {
  const trimmed = raw.trim();

  // Explicit null response
  if (trimmed === "null") return null;

  // Try to extract JSON object
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate dimension
    if (typeof parsed.dimension !== "string" || !VALID_DIMENSIONS.has(parsed.dimension)) {
      return null;
    }

    // Validate direction
    if (typeof parsed.direction !== "string" || !VALID_DIRECTIONS.has(parsed.direction)) {
      return null;
    }

    // Validate evidence
    if (typeof parsed.evidence !== "string" || parsed.evidence.trim().length === 0) {
      return null;
    }

    return Object.freeze({
      dimension: parsed.dimension as TraitDimension,
      direction: parsed.direction as "increase" | "decrease",
      evidence: parsed.evidence.trim()
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

const SIGNAL_DETECTION_MAX_TOKENS = 256;

/**
 * Detect whether a memory contains a personality signal.
 *
 * @returns PersonalitySignal if detected, null if not.
 *          Returns null immediately for ineligible kinds (no LLM call).
 */
export async function detectPersonalitySignal(
  llm: ExpansionLlmPort,
  memoryContent: string,
  memoryKind: string
): Promise<PersonalitySignal | null> {
  // Short-circuit: fact/goal/task/open_loop never contain personality signals
  if (!isSignalEligibleKind(memoryKind)) return null;

  // Empty content → no signal
  if (!memoryContent.trim()) return null;

  const truncatedContent = truncateForSignalDetection(memoryContent);

  const rawResponse = await llm.call({
    systemPrompt: SIGNAL_DETECTION_SYSTEM_PROMPT,
    userPrompt: buildSignalDetectionUserPrompt(truncatedContent, memoryKind),
    maxTokens: SIGNAL_DETECTION_MAX_TOKENS
  });

  return parseSignalResponse(rawResponse);
}

/**
 * Batch-detect personality signals across multiple memories.
 * Returns only non-null results with their source memory IDs.
 */
export async function detectPersonalitySignalsBatch(
  llm: ExpansionLlmPort,
  memories: readonly Readonly<{ id: string; content: string; kind: string }>[]
): Promise<readonly Readonly<{ memoryId: string; signal: PersonalitySignal }>[]> {
  const results: { memoryId: string; signal: PersonalitySignal }[] = [];

  for (const memory of memories) {
    const signal = await detectPersonalitySignal(llm, memory.content, memory.kind);
    if (signal) {
      results.push(Object.freeze({ memoryId: memory.id, signal }));
    }
  }

  return Object.freeze(results);
}
