export const ECHOINK_TASK_PLAN_ENTRY_TYPE = "echoink.task-plan.v1" as const;
export const ECHOINK_TASK_PLAN_SCHEMA_VERSION = 1 as const;

export const ECHOINK_TASK_PLAN_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "paused",
  "cancelled"
] as const;

export type EchoInkTaskPlanStatus =
  typeof ECHOINK_TASK_PLAN_STATUSES[number];

export interface EchoInkTaskPlanStep {
  readonly stepId: string;
  readonly text: string;
  readonly status: EchoInkTaskPlanStatus;
  readonly reason?: string;
}

export interface EchoInkTaskPlanSnapshot {
  readonly schemaVersion: typeof ECHOINK_TASK_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly title: string;
  readonly status: EchoInkTaskPlanStatus;
  readonly version: number;
  readonly steps: readonly Readonly<EchoInkTaskPlanStep>[];
  readonly currentStepId?: string;
  readonly reason?: string;
  readonly lastUpdateSummary?: string;
  readonly source: "agent" | "user";
  readonly productRunId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EchoInkTaskPlanSessionEntryData {
  readonly schemaVersion: typeof ECHOINK_TASK_PLAN_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly plan: Readonly<EchoInkTaskPlanSnapshot>;
}

export interface EchoInkTaskPlanDraft {
  readonly planId: string;
  readonly title: string;
  readonly status: EchoInkTaskPlanStatus;
  readonly steps: readonly Readonly<EchoInkTaskPlanStep>[];
  readonly currentStepId?: string;
  readonly reason?: string;
}

export interface EchoInkTaskPlanEntryView {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

const TASK_PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_PLAN_TITLE_LIMIT = 200;
const TASK_PLAN_STEP_TEXT_LIMIT = 2_000;
const TASK_PLAN_REASON_LIMIT = 500;
const TASK_PLAN_UPDATE_SUMMARY_LIMIT = 500;
const TASK_PLAN_MAX_STEPS = 64;

export function isEchoInkTaskPlanStatus(
  value: unknown
): value is EchoInkTaskPlanStatus {
  return typeof value === "string"
    && (ECHOINK_TASK_PLAN_STATUSES as readonly string[]).includes(value);
}

export function isEchoInkTaskPlanTerminal(
  status: EchoInkTaskPlanStatus
): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled";
}

export function normalizeEchoInkTaskPlanDraft(
  value: unknown
): Readonly<EchoInkTaskPlanDraft> {
  const record = strictRecord(value, "task_plan_arguments_invalid");
  assertExactKeys(
    record,
    ["planId", "title", "status", "steps"],
    ["currentStepId", "reason"],
    "task_plan_arguments_invalid"
  );
  const planId = taskPlanIdentifier(record.planId, "planId");
  const title = boundedRequiredText(
    record.title,
    TASK_PLAN_TITLE_LIMIT,
    "task_plan_title_invalid"
  );
  if (!isEchoInkTaskPlanStatus(record.status)) {
    throw new TypeError("task_plan_status_invalid");
  }
  const steps = normalizeTaskPlanSteps(record.steps);
  const currentStepId = optionalTaskPlanIdentifier(
    record.currentStepId,
    "currentStepId"
  );
  const reason = optionalBoundedText(
    record.reason,
    TASK_PLAN_REASON_LIMIT,
    "task_plan_reason_invalid"
  );
  const normalized = Object.freeze({
    planId,
    title,
    status: record.status,
    steps,
    ...(currentStepId ? { currentStepId } : {}),
    ...(reason ? { reason } : {})
  });
  assertTaskPlanState(normalized);
  return normalized;
}

export function normalizeEchoInkTaskPlanSnapshot(
  value: unknown
): Readonly<EchoInkTaskPlanSnapshot> {
  const record = strictRecord(value, "task_plan_snapshot_invalid");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "planId",
      "title",
      "status",
      "version",
      "steps",
      "source",
      "createdAt",
      "updatedAt"
    ],
    [
      "currentStepId",
      "reason",
      "lastUpdateSummary",
      "productRunId"
    ],
    "task_plan_snapshot_invalid"
  );
  if (record.schemaVersion !== ECHOINK_TASK_PLAN_SCHEMA_VERSION) {
    throw new TypeError("task_plan_snapshot_invalid");
  }
  const draft = normalizeEchoInkTaskPlanDraft({
    planId: record.planId,
    title: record.title,
    status: record.status,
    steps: record.steps,
    ...(record.currentStepId === undefined
      ? {}
      : { currentStepId: record.currentStepId }),
    ...(record.reason === undefined ? {} : { reason: record.reason })
  });
  if (!positiveSafeInteger(record.version)) {
    throw new TypeError("task_plan_version_invalid");
  }
  if (record.source !== "agent" && record.source !== "user") {
    throw new TypeError("task_plan_source_invalid");
  }
  if (
    !nonNegativeSafeTime(record.createdAt)
    || !nonNegativeSafeTime(record.updatedAt)
    || record.updatedAt < record.createdAt
  ) {
    throw new TypeError("task_plan_time_invalid");
  }
  const lastUpdateSummary = optionalBoundedText(
    record.lastUpdateSummary,
    TASK_PLAN_UPDATE_SUMMARY_LIMIT,
    "task_plan_update_summary_invalid"
  );
  const productRunId = optionalTaskPlanIdentifier(
    record.productRunId,
    "productRunId"
  );
  return freezeEchoInkTaskPlan({
    ...draft,
    schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
    version: record.version,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(lastUpdateSummary ? { lastUpdateSummary } : {}),
    ...(productRunId ? { productRunId } : {})
  });
}

export function taskPlanFromSessionEntry(
  entry: Readonly<EchoInkTaskPlanEntryView>,
  expectedPiSessionId?: string
): Readonly<EchoInkTaskPlanSnapshot> | null {
  if (
    entry.type !== "custom"
    || entry.customType !== ECHOINK_TASK_PLAN_ENTRY_TYPE
  ) return null;
  try {
    const data = strictRecord(entry.data, "task_plan_entry_invalid");
    assertExactKeys(
      data,
      ["schemaVersion", "conversationId", "piSessionId", "plan"],
      [],
      "task_plan_entry_invalid"
    );
    if (
      data.schemaVersion !== ECHOINK_TASK_PLAN_SCHEMA_VERSION
      || !isNonEmptyText(data.conversationId)
      || !isNonEmptyText(data.piSessionId)
      || (expectedPiSessionId !== undefined
        && data.piSessionId !== expectedPiSessionId)
    ) return null;
    return normalizeEchoInkTaskPlanSnapshot(data.plan);
  } catch {
    return null;
  }
}

export function taskPlanFromToolResult(
  value: unknown
): Readonly<EchoInkTaskPlanSnapshot> | null {
  try {
    const result = strictRecord(value, "task_plan_tool_result_invalid");
    const details = strictRecord(
      result.details,
      "task_plan_tool_result_invalid"
    );
    if (details.source !== "echoink-task-plan") return null;
    return normalizeEchoInkTaskPlanSnapshot(details.plan);
  } catch {
    return null;
  }
}

export function taskPlansFromBranch(
  entries: readonly Readonly<EchoInkTaskPlanEntryView>[]
): readonly Readonly<EchoInkTaskPlanSnapshot>[] {
  const latest = new Map<string, Readonly<EchoInkTaskPlanSnapshot>>();
  for (const entry of entries) {
    const plan = taskPlanFromSessionEntry(entry);
    if (!plan) continue;
    const previous = latest.get(plan.planId);
    if (!previous || taskPlanIsNewer(plan, previous)) {
      latest.set(plan.planId, plan);
    }
  }
  return Object.freeze([...latest.values()]);
}

export function latestTaskPlanFromBranch(
  entries: readonly Readonly<EchoInkTaskPlanEntryView>[],
  planId?: string
): Readonly<EchoInkTaskPlanSnapshot> | null {
  let latest: Readonly<EchoInkTaskPlanSnapshot> | null = null;
  for (const entry of entries) {
    const plan = taskPlanFromSessionEntry(entry);
    if (!plan || (planId && plan.planId !== planId)) continue;
    if (!latest || taskPlanIsNewer(plan, latest)) latest = plan;
  }
  return latest;
}

export function activeTaskPlanFromBranch(
  entries: readonly Readonly<EchoInkTaskPlanEntryView>[]
): Readonly<EchoInkTaskPlanSnapshot> | null {
  let active: Readonly<EchoInkTaskPlanSnapshot> | null = null;
  for (const plan of taskPlansFromBranch(entries)) {
    if (isEchoInkTaskPlanTerminal(plan.status)) continue;
    if (!active || taskPlanIsNewer(plan, active)) active = plan;
  }
  return active;
}

export function taskPlanCurrentStep(
  plan: Readonly<EchoInkTaskPlanSnapshot>
): Readonly<EchoInkTaskPlanStep> | null {
  if (plan.currentStepId) {
    const explicit = plan.steps.find(
      (step) => step.stepId === plan.currentStepId
    );
    if (explicit) return explicit;
  }
  return plan.steps.find((step) =>
    step.status !== "completed" && step.status !== "cancelled"
  ) ?? plan.steps.at(-1) ?? null;
}

export function taskPlanProgress(
  plan: Readonly<EchoInkTaskPlanSnapshot>
): Readonly<{
  current: number;
  total: number;
  completed: number;
}> {
  const currentStep = taskPlanCurrentStep(plan);
  const currentIndex = currentStep
    ? plan.steps.findIndex((step) => step.stepId === currentStep.stepId)
    : -1;
  return Object.freeze({
    current: plan.status === "completed"
      ? plan.steps.length
      : Math.max(1, currentIndex + 1),
    total: plan.steps.length,
    completed: plan.steps.filter((step) => step.status === "completed").length
  });
}

export function freezeEchoInkTaskPlan(
  value: EchoInkTaskPlanSnapshot
): Readonly<EchoInkTaskPlanSnapshot> {
  return Object.freeze({
    ...value,
    steps: Object.freeze(value.steps.map((step) => Object.freeze({ ...step })))
  });
}

export function taskPlanSessionEntryData(input: Readonly<{
  conversationId: string;
  piSessionId: string;
  plan: Readonly<EchoInkTaskPlanSnapshot>;
}>): Readonly<EchoInkTaskPlanSessionEntryData> {
  if (!isNonEmptyText(input.conversationId) || !isNonEmptyText(input.piSessionId)) {
    throw new TypeError("task_plan_entry_identity_invalid");
  }
  return Object.freeze({
    schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
    conversationId: input.conversationId,
    piSessionId: input.piSessionId,
    plan: normalizeEchoInkTaskPlanSnapshot(input.plan)
  });
}

function taskPlanIsNewer(
  candidate: Readonly<EchoInkTaskPlanSnapshot>,
  current: Readonly<EchoInkTaskPlanSnapshot>
): boolean {
  if (
    candidate.planId === current.planId
    && candidate.version !== current.version
  ) return candidate.version > current.version;
  return candidate.updatedAt > current.updatedAt
    || (
      candidate.updatedAt === current.updatedAt
      && candidate.version > current.version
    );
}

function normalizeTaskPlanSteps(
  value: unknown
): readonly Readonly<EchoInkTaskPlanStep>[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > TASK_PLAN_MAX_STEPS
  ) {
    throw new TypeError("task_plan_steps_invalid");
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((item) => {
    const record = strictRecord(item, "task_plan_step_invalid");
    assertExactKeys(
      record,
      ["stepId", "text", "status"],
      ["reason"],
      "task_plan_step_invalid"
    );
    const stepId = taskPlanIdentifier(record.stepId, "stepId");
    if (seen.has(stepId)) throw new TypeError("task_plan_step_id_duplicate");
    seen.add(stepId);
    if (!isEchoInkTaskPlanStatus(record.status)) {
      throw new TypeError("task_plan_step_status_invalid");
    }
    const reason = optionalBoundedText(
      record.reason,
      TASK_PLAN_REASON_LIMIT,
      "task_plan_step_reason_invalid"
    );
    if (record.status === "failed" && !reason) {
      throw new TypeError("task_plan_step_reason_required");
    }
    return Object.freeze({
      stepId,
      text: boundedRequiredText(
        record.text,
        TASK_PLAN_STEP_TEXT_LIMIT,
        "task_plan_step_text_invalid"
      ),
      status: record.status,
      ...(reason ? { reason } : {})
    });
  }));
}

function assertTaskPlanState(
  plan: Readonly<EchoInkTaskPlanDraft>
): void {
  const current = plan.currentStepId
    ? plan.steps.find((step) => step.stepId === plan.currentStepId)
    : undefined;
  if (plan.currentStepId && !current) {
    throw new TypeError("task_plan_current_step_invalid");
  }
  if (plan.steps.filter((step) => step.status === "in_progress").length > 1) {
    throw new TypeError("task_plan_multiple_current_steps");
  }
  if (plan.status === "pending") {
    if (
      plan.currentStepId
      || plan.steps.some((step) =>
        step.status === "in_progress"
        || step.status === "paused"
        || step.status === "failed"
      )
    ) throw new TypeError("task_plan_pending_state_invalid");
    return;
  }
  if (plan.status === "in_progress") {
    if (!current || current.status !== "in_progress") {
      throw new TypeError("task_plan_current_step_required");
    }
    return;
  }
  if (plan.status === "paused") {
    if (!current || current.status !== "paused") {
      throw new TypeError("task_plan_paused_step_required");
    }
    return;
  }
  if (plan.status === "completed") {
    if (
      plan.currentStepId
      || plan.steps.some((step) => step.status !== "completed")
    ) throw new TypeError("task_plan_completed_state_invalid");
    return;
  }
  if (plan.status === "failed") {
    if (!plan.reason || (current && current.status !== "failed")) {
      throw new TypeError("task_plan_failure_reason_required");
    }
    return;
  }
  if (plan.status === "cancelled" && plan.steps.some((step) =>
    step.status === "in_progress" || step.status === "paused"
  )) {
    throw new TypeError("task_plan_cancelled_state_invalid");
  }
}

function strictRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(error);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  error: string
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) throw new TypeError(error);
}

function taskPlanIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !TASK_PLAN_ID.test(value.trim())) {
    throw new TypeError(`task_plan_${field}_invalid`);
  }
  return value.trim();
}

function optionalTaskPlanIdentifier(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  return taskPlanIdentifier(value, field);
}

function boundedRequiredText(
  value: unknown,
  limit: number,
  error: string
): string {
  if (typeof value !== "string") throw new TypeError(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) throw new TypeError(error);
  return normalized;
}

function optionalBoundedText(
  value: unknown,
  limit: number,
  error: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) throw new TypeError(error);
  return normalized;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeTime(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
