import {
  KNOWLEDGE_INITIALIZATION_ROOTS,
  type KnowledgeInitializationJob
} from "./initializer";

export type KnowledgeInitializationProgressStage =
  | "idle" | "plan" | "directories" | "moving" | "extracting" | "guide" | "done";

export interface KnowledgeInitializationProgress {
  /** 当前所处的人话阶段。 */
  readonly stage: KnowledgeInitializationProgressStage;
  /** 0–100 的整数百分比，只来自真实 job 字段，禁止假进度。 */
  readonly percent: number;
  /** 当前阶段已完成计数。 */
  readonly completed: number;
  /** 当前阶段总计数；为 0 时 UI 不显示计数。 */
  readonly total: number;
}

/**
 * 进度口径（权重区间）：
 * - 扫描与冻结计划：0–5%
 * - createdDirectories / 10：5–20%
 * - moveCursor / items.length：20–45%
 * - extractionCursor / extractionQueue.length：45–90%
 * - generate_guide / readback：90–95%
 * - 正式完成（settings 已 initialized，或 job.status/phase 已完成）即 100%。
 *   运行中的任何阶段都不会提前显示 100%；完成判定一旦成立就直接进入完成态，
 *   不存在永远无法展示的 99→100 中间态。
 * 0 个目录、0 篇移动、0 篇提炼时视为该区间已完成，不产生 NaN。
 */
export function buildKnowledgeInitializationProgress(
  job: Readonly<KnowledgeInitializationJob> | null,
  settingsInitialized: boolean
): KnowledgeInitializationProgress {
  if (!job) return { stage: "idle", percent: 0, completed: 0, total: 0 };
  if (settingsInitialized || job.status === "initialized" || job.phase === "complete") {
    return { stage: "done", percent: 100, completed: 0, total: 0 };
  }
  switch (job.phase) {
    case "scan":
    case "preview":
    case "confirmed":
      return { stage: "plan", percent: 5, completed: 0, total: 0 };
    case "create_directories": {
      const total = KNOWLEDGE_INITIALIZATION_ROOTS.length;
      const completed = Math.min(job.createdDirectories.length, total);
      return {
        stage: "directories",
        percent: percentWithin(5, 15, ratio(completed, total)),
        completed,
        total
      };
    }
    case "move_notes": {
      const total = job.items.length;
      const completed = Math.min(job.moveCursor, total);
      return {
        stage: "moving",
        percent: percentWithin(20, 25, ratio(completed, total)),
        completed,
        total
      };
    }
    case "batch_extraction": {
      const total = job.extractionQueue.length;
      const completed = Math.min(job.extractionCursor, total);
      return {
        stage: "extracting",
        percent: percentWithin(45, 45, ratio(completed, total)),
        completed,
        total
      };
    }
    case "generate_guide":
      return { stage: "guide", percent: 95, completed: 0, total: 0 };
    default:
      return { stage: "plan", percent: 5, completed: 0, total: 0 };
  }
}

function ratio(completed: number, total: number): number {
  if (!Number.isFinite(completed) || !Number.isFinite(total)) return 1;
  if (total <= 0) return 1;
  return clamp01(completed / total);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percentWithin(base: number, span: number, ratioValue: number): number {
  return Math.min(100, Math.max(0, Math.round(base + span * ratioValue)));
}
