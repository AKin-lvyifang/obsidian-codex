/**
 * TraitEvolution — silent self-evolution of Agent personality traits.
 *
 * How it works (plain language):
 *   After each conversation turn, the main model observes whether the user's
 *   communication style suggests a preference shift on any personality dimension.
 *   Single signals go into a candidate buffer (in-memory only). When the same
 *   dimension accumulates enough consistent signals (threshold), the trait score
 *   is updated silently. The user never sees this happening during conversation —
 *   they only notice when they open settings and see the hexagon has shifted.
 *
 * Key design decisions:
 *   - NO correction mechanism in conversation (user doesn't say "this is wrong")
 *   - NO UI feedback during chat (completely silent)
 *   - Threshold-based: single observations don't change anything
 *   - Cold-start protection: first N turns are observation-only, no writes
 *   - Follows learning toggle: if learning is disabled, evolution is disabled
 *   - No second model, no background scheduler — runs inline after each turn
 */

import { randomUUID } from "node:crypto";
import {
  TRAIT_DIMENSIONS,
  type TraitDimension,
  type TraitRecord
} from "./personal-memory-contracts";
import type { TraitStore } from "./trait-store";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TraitEvolutionConfig {
  /** Number of consistent observations before updating a trait. Default 3. */
  readonly threshold: number;
  /** Number of initial turns to observe without writing. Default 5. */
  readonly coldStartProtectionRounds: number;
  /** Maximum magnitude of score change per evolution step. Default 0.1. */
  readonly maxStepSize: number;
}

const DEFAULT_CONFIG: TraitEvolutionConfig = {
  threshold: 3,
  coldStartProtectionRounds: 5,
  maxStepSize: 0.1
};

// ---------------------------------------------------------------------------
// Candidate observation
// ---------------------------------------------------------------------------

interface CandidateObservation {
  readonly dimension: TraitDimension;
  readonly direction: "increase" | "decrease"; // which pole the signal pushes toward
  readonly strength: number; // 0-1, how strong the signal is
  readonly evidence: string; // brief description of what was observed
  readonly turnIndex: number;
}

// ---------------------------------------------------------------------------
// TraitEvolution class
// ---------------------------------------------------------------------------

export class TraitEvolution {
  private candidates: CandidateObservation[] = [];
  private turnCount = 0;
  private readonly config: TraitEvolutionConfig;

  constructor(
    private readonly store: TraitStore,
    config?: Partial<TraitEvolutionConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a single observation from a conversation turn.
   * Called by the runtime after each turn if learning is enabled.
   *
   * @param dimension Which personality dimension was observed
   * @param direction Whether the signal pushes score up or down
   * @param strength How strong the signal is (0-1)
   * @param evidence Brief description for audit trail
   */
  async observe(
    dimension: TraitDimension,
    direction: "increase" | "decrease",
    strength: number,
    evidence: string
  ): Promise<void> {
    this.turnCount++;

    // Cold-start protection: accumulate but don't act
    if (this.turnCount <= this.config.coldStartProtectionRounds) return;

    this.candidates.push({
      dimension,
      direction,
      strength: Math.max(0, Math.min(1, strength)),
      evidence,
      turnIndex: this.turnCount
    });

    // Check if threshold is met for this dimension
    await this.checkAndEvolve(dimension);
  }

  /**
   * Batch-process multiple observations from a single turn.
   */
  async observeBatch(
    observations: readonly Readonly<{
      dimension: TraitDimension;
      direction: "increase" | "decrease";
      strength: number;
      evidence: string;
    }>[]
  ): Promise<void> {
    for (const obs of observations) {
      await this.observe(obs.dimension, obs.direction, obs.strength, obs.evidence);
    }
  }

  /** Get current candidate count per dimension (for debugging/monitoring). */
  getCandidateCounts(): Readonly<Record<TraitDimension, number>> {
    const counts: Record<string, number> = {};
    for (const dim of TRAIT_DIMENSIONS) counts[dim] = 0;
    for (const c of this.candidates) counts[c.dimension]++;
    return Object.freeze(counts) as Readonly<Record<TraitDimension, number>>;
  }

  /** Reset all candidates (e.g., when learning is toggled off). */
  resetCandidates(): void {
    this.candidates = [];
  }

  /** Reset turn counter (e.g., new session). */
  resetTurnCount(): void {
    this.turnCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async checkAndEvolve(dimension: TraitDimension): Promise<void> {
    // Gather all candidates for this dimension
    const dimCandidates = this.candidates.filter((c) => c.dimension === dimension);
    if (dimCandidates.length < this.config.threshold) return;

    // Check consistency: majority must agree on direction
    const increaseCount = dimCandidates.filter((c) => c.direction === "increase").length;
    const decreaseCount = dimCandidates.filter((c) => c.direction === "decrease").length;
    const dominantDirection = increaseCount >= decreaseCount ? "increase" : "decrease";
    const dominantCount = Math.max(increaseCount, decreaseCount);

    // Require at least threshold consistent signals in the same direction
    if (dominantCount < this.config.threshold) return;

    // Calculate average strength of dominant-direction signals
    const dominantSignals = dimCandidates.filter((c) => c.direction === dominantDirection);
    const avgStrength = dominantSignals.reduce((sum, c) => sum + c.strength, 0) / dominantSignals.length;

    // Compute score delta (capped by maxStepSize)
    const delta = Math.min(avgStrength, this.config.maxStepSize)
      * (dominantDirection === "increase" ? 1 : -1);

    // Read current trait
    const snapshot = await this.store.read();
    const currentTrait = snapshot.current[dimension];
    const currentScore = currentTrait?.score ?? 0.5;
    const newScore = Math.max(0, Math.min(1, currentScore + delta));

    // Skip if change is negligible
    if (Math.abs(newScore - currentScore) < 0.01) {
      // Clear consumed candidates even if no meaningful change
      this.clearCandidatesForDimension(dimension);
      return;
    }

    // Build evidence summary
    const evidenceSummary = dominantSignals
      .slice(0, 3)
      .map((c) => c.evidence)
      .join("; ");

    // Create new trait record
    const newRecord: TraitRecord = {
      id: `trait_${dimension}_obs_${randomUUID().slice(0, 8)}`,
      dimension,
      basis: "observed",
      status: "current",
      score: newScore,
      date: new Date().toISOString().slice(0, 10),
      source: `self-evolution:turn-${this.turnCount}`,
      evidence: evidenceSummary,
      supersedes: currentTrait?.id,
      revision: snapshot.revision + 1
    };

    // Persist
    await this.store.upsertTrait(newRecord);

    // Clear consumed candidates for this dimension
    this.clearCandidatesForDimension(dimension);
  }

  private clearCandidatesForDimension(dimension: TraitDimension): void {
    this.candidates = this.candidates.filter((c) => c.dimension !== dimension);
  }
}
