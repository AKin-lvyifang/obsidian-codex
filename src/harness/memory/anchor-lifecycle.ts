/**
 * AnchorLifecycle — hit-driven lifecycle management for memory anchors.
 *
 * Responsibilities:
 * 1. Record hits when an anchor contributes to a successful recall
 * 2. Decay confidence of unused anchors after grace period
 * 3. Prune anchors below minimum confidence threshold
 * 4. Enforce per-record anchor count limits
 * 5. Protect newly generated anchors from premature decay (cold-start grace)
 *
 * Design principle: anchors that prove useful by being hit survive and strengthen;
 * anchors that never get hit gradually fade away. This is "hit-driven" — real user
 * queries vote on which anchors live or die.
 */

import {
  MEMORY_ANCHOR_DECAY_FACTOR,
  MEMORY_ANCHOR_DECAY_GRACE_DAYS,
  MEMORY_ANCHOR_MAX_PER_RECORD,
  MEMORY_ANCHOR_MIN_CONFIDENCE,
  type MemoryAnchor
} from "./personal-memory-contracts";

// ---------------------------------------------------------------------------
// Hit recording
// ---------------------------------------------------------------------------

/**
 * Record a hit on specific anchors within a memory record.
 * Returns updated anchors array with incremented hitCount and lastHitAt.
 */
export function recordAnchorHits(
  anchors: readonly MemoryAnchor[],
  hitTerms: readonly string[],
  nowMs: number
): readonly MemoryAnchor[] {
  const hitSet = new Set(hitTerms.map((t) => t.normalize("NFKC").toLocaleLowerCase()));
  return Object.freeze(
    anchors.map((anchor) => {
      const normalizedTerm = anchor.term.normalize("NFKC").toLocaleLowerCase();
      if (hitSet.has(normalizedTerm)) {
        return Object.freeze({
          ...anchor,
          hitCount: anchor.hitCount + 1,
          lastHitAt: nowMs,
          // Hits boost confidence slightly, capped at 1.0
          confidence: Math.min(1.0, anchor.confidence + 0.05)
        });
      }
      return anchor;
    })
  );
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Apply time-based decay to anchors that haven't been hit recently.
 * Anchors within the grace period (newly generated or recently hit) are protected.
 */
export function applyAnchorDecay(
  anchors: readonly MemoryAnchor[],
  nowMs: number
): readonly MemoryAnchor[] {
  const graceMs = MEMORY_ANCHOR_DECAY_GRACE_DAYS * MS_PER_DAY;

  return Object.freeze(
    anchors.map((anchor) => {
      const lastActivity = anchor.lastHitAt ?? anchor.generatedAt;
      const elapsed = nowMs - lastActivity;

      // Within grace period → no decay
      if (elapsed < graceMs) return anchor;

      // Calculate how many decay periods have passed
      const periodsElapsed = Math.floor(elapsed / graceMs);
      const decayedConfidence = anchor.confidence * Math.pow(MEMORY_ANCHOR_DECAY_FACTOR, periodsElapsed);

      return Object.freeze({
        ...anchor,
        confidence: Math.max(0, decayedConfidence)
      });
    })
  );
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Remove anchors whose confidence has decayed below the minimum threshold.
 */
export function pruneLowConfidenceAnchors(
  anchors: readonly MemoryAnchor[]
): readonly MemoryAnchor[] {
  return Object.freeze(
    anchors.filter((anchor) => anchor.confidence >= MEMORY_ANCHOR_MIN_CONFIDENCE)
  );
}

/**
 * Enforce per-record anchor count limit.
 * Keeps the highest-scoring anchors (confidence × recency).
 */
export function enforceAnchorLimit(
  anchors: readonly MemoryAnchor[],
  maxCount: number = MEMORY_ANCHOR_MAX_PER_RECORD
): readonly MemoryAnchor[] {
  if (anchors.length <= maxCount) return anchors;

  // Sort by composite score: confidence weighted by recency
  const sorted = [...anchors].sort((a, b) => {
    const scoreA = anchorRetentionScore(a);
    const scoreB = anchorRetentionScore(b);
    return scoreB - scoreA; // descending
  });

  return Object.freeze(sorted.slice(0, maxCount));
}

/**
 * Composite retention score for ranking anchors during pruning.
 * Higher = more worth keeping.
 */
function anchorRetentionScore(anchor: MemoryAnchor): number {
  // Confidence is primary signal; hitCount is secondary tiebreaker
  return anchor.confidence * 1000 + anchor.hitCount;
}

// ---------------------------------------------------------------------------
// Full lifecycle pass
// ---------------------------------------------------------------------------

/**
 * Run a complete lifecycle pass on a set of anchors:
 * 1. Apply time-based decay
 * 2. Prune below-threshold anchors
 * 3. Enforce count limit
 *
 * Call this periodically (e.g., weekly health check in dream scheduler).
 */
export function runAnchorLifecycle(
  anchors: readonly MemoryAnchor[],
  nowMs: number,
  maxCount?: number
): readonly MemoryAnchor[] {
  const decayed = applyAnchorDecay(anchors, nowMs);
  const pruned = pruneLowConfidenceAnchors(decayed);
  return enforceAnchorLimit(pruned, maxCount);
}

// ---------------------------------------------------------------------------
// Statistics (for monitoring / debugging)
// ---------------------------------------------------------------------------

export interface AnchorHealthStats {
  readonly total: number;
  readonly alive: number;
  readonly pruned: number;
  readonly avgConfidence: number;
  readonly totalHits: number;
  readonly oldestAgeDays: number;
  readonly newestAgeDays: number;
}

export function computeAnchorHealthStats(
  anchors: readonly MemoryAnchor[],
  nowMs: number
): AnchorHealthStats {
  if (anchors.length === 0) {
    return {
      total: 0, alive: 0, pruned: 0,
      avgConfidence: 0, totalHits: 0,
      oldestAgeDays: 0, newestAgeDays: 0
    };
  }

  const alive = anchors.filter((a) => a.confidence >= MEMORY_ANCHOR_MIN_CONFIDENCE);
  const ages = anchors.map((a) => (nowMs - a.generatedAt) / MS_PER_DAY);

  return {
    total: anchors.length,
    alive: alive.length,
    pruned: anchors.length - alive.length,
    avgConfidence: anchors.reduce((sum, a) => sum + a.confidence, 0) / anchors.length,
    totalHits: anchors.reduce((sum, a) => sum + a.hitCount, 0),
    oldestAgeDays: Math.round(Math.max(...ages)),
    newestAgeDays: Math.round(Math.min(...ages))
  };
}
