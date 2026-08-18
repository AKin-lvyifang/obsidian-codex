/**
 * DreamScheduler — offline background task for memory consolidation.
 *
 * Runs on a configurable schedule (N times per day) while Obsidian is open.
 * Each run performs two tasks on recent memories:
 *   1. Personality signal detection (M1) → inject into TraitEvolution
 *   2. Divergent expansion / anchor generation (B2) → update search index
 *
 * Schedule design:
 *   - User configures "runs per day" (1-6)
 *   - Scheduler divides 24h into equal intervals
 *   - 60s heartbeat checks if the next interval has arrived
 *   - Tracks last run timestamp to avoid duplicate runs
 *   - Only runs when Obsidian is open (setInterval lifecycle)
 */

import type { ExpansionLlmPort } from "./memory-expansion-service";
import { expandMemory } from "./memory-expansion-service";
import { detectPersonalitySignal } from "./memory-personality-signal";
import type { TraitEvolution } from "./trait-evolution";
import type { PersonalMemoryRecord } from "./personal-memory-contracts";
import { isSignalEligibleKind } from "./memory-personality-signal-prompt";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DreamScheduleConfig {
  /** Whether dreaming is enabled. */
  readonly enabled: boolean;
  /** Number of dream runs per day (1-6). Default 3. */
  readonly runsPerDay: number;
  /** Max tokens budget per dream run. Default 50000. */
  readonly tokenBudget: number;
  /** How many days back to scan for new/changed memories. Default 7. */
  readonly lookbackDays: number;
}

export const DEFAULT_DREAM_CONFIG: DreamScheduleConfig = {
  enabled: false,
  runsPerDay: 3,
  tokenBudget: 50_000,
  lookbackDays: 7
};

const HEARTBEAT_INTERVAL_MS = 60_000; // 60 seconds
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Ports (decouple from plugin internals)
// ---------------------------------------------------------------------------

/** Port for reading recent memories that need processing. */
export interface DreamMemoryReaderPort {
  /** Get memories created or modified within the lookback window. */
  getRecentMemories(lookbackDays: number): Promise<readonly PersonalMemoryRecord[]>;
}

/** Port for persisting anchor results back to memory records. */
export interface DreamMemoryWriterPort {
  /** Update a memory record's anchors field. */
  updateAnchors(memoryId: string, anchors: readonly import("./personal-memory-contracts").MemoryAnchor[]): Promise<void>;
}

/** Port for checking/updating the last-run timestamp. */
export interface DreamStatePort {
  getLastRunAt(): number; // epoch ms, 0 if never run
  setLastRunAt(timestamp: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// DreamScheduler class
// ---------------------------------------------------------------------------

export class DreamScheduler {
  private timer: number | null = null;
  private running = false;
  private config: DreamScheduleConfig;

  constructor(
    private readonly llm: ExpansionLlmPort,
    private readonly traitEvolution: TraitEvolution,
    private readonly memoryReader: DreamMemoryReaderPort,
    private readonly memoryWriter: DreamMemoryWriterPort,
    private readonly state: DreamStatePort,
    private readonly registerInterval: (timer: number) => void,
    config?: Partial<DreamScheduleConfig>
  ) {
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
  }

  // --- Lifecycle ---

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => void this.tick(), HEARTBEAT_INTERVAL_MS);
    this.registerInterval(this.timer);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateConfig(config: Partial<DreamScheduleConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Force a run regardless of schedule (for testing / manual trigger). */
  async forceRun(): Promise<DreamRunResult> {
    return this.runDreamCycle();
  }

  // --- Heartbeat ---

  private async tick(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    if (!this.isDue()) return;
    await this.runDreamCycle();
  }

  private isDue(): boolean {
    const lastRun = this.state.getLastRunAt();
    if (lastRun === 0) return true; // never run before
    const intervalMs = MS_PER_DAY / Math.max(1, this.config.runsPerDay);
    return Date.now() - lastRun >= intervalMs;
  }

  // --- Dream cycle ---

  private async runDreamCycle(): Promise<DreamRunResult> {
    this.running = true;
    const startTime = Date.now();
    const result: DreamRunResult = {
      startedAt: startTime,
      memoriesScanned: 0,
      signalsDetected: 0,
      expansionsPerformed: 0,
      anchorsGenerated: 0,
      errors: []
    };

    try {
      // 1. Get recent memories
      const memories = await this.memoryReader.getRecentMemories(this.config.lookbackDays);
      result.memoriesScanned = memories.length;

      let tokensUsed = 0;

      for (const memory of memories) {
        // Budget check
        if (tokensUsed >= this.config.tokenBudget) break;

        // --- Task 1: Personality signal detection ---
        if (isSignalEligibleKind(memory.kind) && !this.traitEvolution.isMemoryProcessed(memory.id)) {
          try {
            const signal = await detectPersonalitySignal(this.llm, memory.content, memory.kind);
            if (signal) {
              // Weight by source: dream extraction = 0.5
              await this.traitEvolution.observeFromMemory(signal, "dream", 0.5, memory.id);
              result.signalsDetected++;
            }
            tokensUsed += 300; // rough estimate for signal detection call
          } catch (error) {
            result.errors.push(`signal detection failed for ${memory.id}: ${errorMessage(error)}`);
          }
        }

        // --- Task 2: Anchor expansion (only if no anchors yet) ---
        if (!memory.anchors || memory.anchors.length === 0) {
          try {
            const expansion = await expandMemory(this.llm, memory.content, memory.kind);
            if (expansion.anchors.length > 0) {
              await this.memoryWriter.updateAnchors(memory.id, expansion.anchors);
              result.expansionsPerformed++;
              result.anchorsGenerated += expansion.anchors.length;
            }
            tokensUsed += 1200; // rough estimate for expansion call
          } catch (error) {
            result.errors.push(`expansion failed for ${memory.id}: ${errorMessage(error)}`);
          }
        }
      }
    } catch (error) {
      result.errors.push(`dream cycle failed: ${errorMessage(error)}`);
    } finally {
      this.running = false;
      result.completedAt = Date.now();
      result.durationMs = result.completedAt - startTime;
      await this.state.setLastRunAt(result.completedAt);
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DreamRunResult {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  memoriesScanned: number;
  signalsDetected: number;
  expansionsPerformed: number;
  anchorsGenerated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
