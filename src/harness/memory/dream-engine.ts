/**
 * dream-engine.ts — one dreaming round (做梦 PRD §5).
 *
 * Flow:
 *  1. Gates: dreaming enabled, long-term memory on, learning on, provider ready.
 *  2. Select ≤10 primary memories: pending/changed first, then backfill of
 *     existing memories without secondary facts (≤10 total per run).
 *  3. For each memory (concurrency 1): call the LLM once, parse strict JSON,
 *     produce ≤8 secondary facts (≤5 matchTerms each) plus optional
 *     personality signals / Agent requirements / user-profile items.
 *  4. Recompute personality state, user-profile state, AGENT.md, USER.md and
 *     the secondary lifecycle (hits handled by Recall, decay handled here).
 *  5. Commit EVERYTHING through one repository transaction. Only after the
 *     transaction succeeds do lastSuccessAt / processed revision advance.
 *
 * Failure rules (做梦 PRD §5): provider unavailable, invalid JSON, or a file
 * write failure keep the affected sources pending; empty results are never
 * written and lastSuccessAt is never advanced for a failed round.
 */

import { createHash } from "node:crypto";
import {
  SECONDARY_MAX_MATCH_TERMS,
  SECONDARY_MAX_PER_PARENT,
  isSecondaryRelation,
  type PersonalMemoryRecord,
  type SecondaryMemoryRecord,
  type SecondaryRelation
} from "./personal-memory-contracts";
import {
  applyDreamPersonalityUpdate,
  applyTemplateToState,
  emptyPersonalityState,
  personalityStateJson,
  type DreamPersonalityInput,
  type PersonalityState
} from "./personality-state";
import {
  applyDreamProfileUpdate,
  emptyUserProfileState,
  userProfileStateJson,
  type DreamProfileInput,
  type UserProfileSection,
  type UserProfileState
} from "./user-profile-state";
import { renderAgentMarkdown, renderUserMarkdown } from "./cognitive-projection";
import {
  applySecondaryDecay,
  createSecondaryRecord,
  serializeSecondaryRecord,
  type SecondaryMemoryStore
} from "./secondary-memory-store";
import type { DreamState, DreamStateStore } from "./dream-state";
import type { PersonalityStateStore } from "./personality-state";
import type { UserProfileStateStore } from "./user-profile-state";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface DreamLlmPort {
  call(input: Readonly<{
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
  }>): Promise<string>;
}

/** Repository surface the engine needs (keeps the engine testable). */
export interface DreamRepositoryPort {
  inspect(): Promise<Readonly<{ revision: number; records: readonly PersonalMemoryRecord[] }>>;
  readVaultId(): Promise<string>;
  readFixedFiles(): Promise<Readonly<{ agent: string; user: string }>>;
  applyCognitiveUpdate(input: Readonly<{
    agentContent?: string;
    userContent?: string;
    secondaryRecords: readonly SecondaryMemoryRecord[];
    extraChanges: readonly Readonly<{ relativePath: string; content: string }>[];
    detail: string;
  }>): Promise<Readonly<{ revision: number }>>;
  writeSystemMemory(input: Readonly<{
    kind: PersonalMemoryRecord["kind"];
    title: string;
    content: string;
    recallWhen: string;
    basis: PersonalMemoryRecord["basis"];
  }>): Promise<Readonly<{ id: string; revision: number }>>;
}

export interface DreamEngineConfig {
  /** 单次最多处理一级记忆，默认 10。 */
  readonly maxMemoriesPerRun: number;
  /** 单条最多生成二级事实，默认 8。 */
  readonly maxFactsPerMemory: number;
  /** 单条二级事实最多匹配词，默认 5。 */
  readonly maxMatchTermsPerFact: number;
  /** 单次 Token 预算，默认 20,000。 */
  readonly tokenBudget: number;
  /** 单条输入上限，默认 2,000 字符。 */
  readonly maxInputChars: number;
  /** LLM 并发固定为 1。 */
  readonly llmConcurrency: 1;
}

export const DEFAULT_DREAM_ENGINE_CONFIG: DreamEngineConfig = Object.freeze({
  maxMemoriesPerRun: 10,
  maxFactsPerMemory: SECONDARY_MAX_PER_PARENT,
  maxMatchTermsPerFact: SECONDARY_MAX_MATCH_TERMS,
  tokenBudget: 20_000,
  maxInputChars: 2_000,
  llmConcurrency: 1
});

export interface DreamEngineDeps {
  readonly repository: DreamRepositoryPort;
  readonly personalityStore: PersonalityStateStore;
  readonly profileStore: UserProfileStateStore;
  readonly secondaryStore: SecondaryMemoryStore;
  readonly dreamStateStore: DreamStateStore;
  /** null → Provider 不可用，本轮不产生模型结果。 */
  readonly llm: () => DreamLlmPort | null;
  readonly now?: () => number;
  readonly config?: Partial<DreamEngineConfig>;
}

export interface DreamRunResult {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly processedMemoryIds: readonly string[];
  readonly failedMemoryIds: readonly string[];
  readonly factsCreated: number;
  readonly factsReplaced: number;
  readonly decayed: number;
  readonly autoDisabled: number;
  readonly agentUpdated: boolean;
  readonly userUpdated: boolean;
  readonly providerUnavailable: boolean;
  readonly committed: boolean;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DreamEngine {
  private readonly config: DreamEngineConfig;
  private running = false;

  constructor(private readonly deps: DreamEngineDeps) {
    this.config = { ...DEFAULT_DREAM_ENGINE_CONFIG, ...(deps.config ?? {}) };
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<DreamRunResult> {
    if (this.running) {
      throw new Error("dream_engine_already_running");
    }
    this.running = true;
    const startedAt = this.now();
    try {
      return await this.execute(startedAt);
    } finally {
      this.running = false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async execute(startedAt: number): Promise<DreamRunResult> {
    const { repository, personalityStore, profileStore, secondaryStore, dreamStateStore } = this.deps;
    const dreamState = await dreamStateStore.read();
    const personalityState = (await personalityStore.read()) ?? emptyPersonalityState(startedAt);
    const profileState = (await profileStore.read()) ?? emptyUserProfileState(startedAt);
    const secondaryRecords = [...(await secondaryStore.loadAll())];
    const inspected = await repository.inspect();
    const currentRecords = inspected.records.filter((record) => record.status === "current");

    const failedMemoryIds: string[] = [];
    const processedMemoryIds: string[] = [];
    let factsCreated = 0;
    let factsReplaced = 0;
    let agentUpdated = false;
    let userUpdated = false;

    // --- Legacy USER.md migration (草案 §12.3) ---------------------------
    let workingProfileState = profileState;
    const fixedFiles = await repository.readFixedFiles();
    const userHash = sha256Text(fixedFiles.user);
    const defaultUserHash = sha256Text(DEFAULT_USER_PROFILE_TEXT);
    if (workingProfileState.revision === 0 && workingProfileState.legacyUserMigration === null) {
      workingProfileState = Object.freeze({
        ...workingProfileState,
        revision: workingProfileState.revision + 1,
        legacyUserMigration: userHash !== defaultUserHash ? "pending" as const : "done" as const,
        lastProjectedUserHash: userHash !== defaultUserHash ? "" : userHash,
        updatedAt: startedAt
      });
    }
    if (workingProfileState.legacyUserMigration === "pending") {
      try {
        const migrated = await repository.writeSystemMemory({
          kind: "fact",
          title: "迁移自 USER.md 的用户画像",
          content: fixedFiles.user.trim(),
          recallWhen: "需要用户稳定画像、身份或长期合作方式时",
          basis: "explicit"
        });
        workingProfileState = Object.freeze({
          ...workingProfileState,
          revision: workingProfileState.revision + 1,
          legacyUserMigration: "done" as const,
          updatedAt: startedAt
        });
        await dreamStateStore.write(enqueuePending(dreamStateStore.peek(), [migrated.id], startedAt));
      } catch {
        // Migration stays pending; the old USER.md is never overwritten.
      }
    }

    // --- Select memories to process ---------------------------------------
    const selected = this.selectMemories(currentRecords, dreamState, personalityState, secondaryRecords);

    // --- Provider gate -----------------------------------------------------
    const llm = this.deps.llm();
    const providerUnavailable = llm === null;
    const processable = providerUnavailable ? [] : selected;
    if (providerUnavailable) {
      failedMemoryIds.push(...selected.map((record) => record.id));
    }

    // --- Per-memory LLM work (concurrency fixed at 1) ---------------------
    const signals: Array<DreamPersonalityInput["signals"][number]> = [];
    const requirements: Array<DreamPersonalityInput["requirements"][number]> = [];
    const profileItems: Array<DreamProfileInput["items"][number]> = [];
    const processedSources: Array<{ memoryId: string; memoryRevision: number }> = [];
    let tokensUsed = 0;
    const newSecondary: SecondaryMemoryRecord[] = [];

    for (const record of processable) {
      if (!llm) break;
      const promptInput = buildDreamPrompts(record, this.config.maxInputChars);
      const estimated = estimateTokens(promptInput.systemPrompt) + estimateTokens(promptInput.userPrompt);
      if (tokensUsed + estimated > this.config.tokenBudget && processedMemoryIds.length > 0) {
        failedMemoryIds.push(record.id);
        continue;
      }
      tokensUsed += estimated;
      try {
        const raw = await llm.call({
          systemPrompt: promptInput.systemPrompt,
          userPrompt: promptInput.userPrompt,
          maxTokens: 4_000
        });
        tokensUsed += estimateTokens(raw);
        const parsed = parseDreamOutput(raw);
        if (!parsed) {
          failedMemoryIds.push(record.id);
          continue;
        }

        // Replace existing llm_inferred facts for this parent; keep user edits.
        const keptForParent: SecondaryMemoryRecord[] = [];
        let replaced = 0;
        for (const existing of secondaryRecords) {
          if (existing.parentId !== record.id) continue;
          if (existing.basis === "user_edited_inference" || existing.status === "disabled") {
            keptForParent.push(existing);
          } else if (existing.status === "current") {
            replaced += 1;
          }
        }
        const generated: SecondaryMemoryRecord[] = [];
        for (const fact of parsed.facts.slice(0, this.config.maxFactsPerMemory)) {
          generated.push(createSecondaryRecord({
            parentId: record.id,
            title: fact.title,
            content: fact.content,
            recallWhen: fact.recallWhen,
            matchTerms: fact.matchTerms.slice(0, this.config.maxMatchTermsPerFact),
            relation: fact.relation,
            reason: fact.reason,
            basis: "llm_inferred",
            sourceMemoryRevision: inspected.revision,
            now: this.now()
          }));
        }
        const allowed = Math.max(
          0,
          SECONDARY_MAX_PER_PARENT - keptForParent.filter((kept) => kept.status === "current").length
        );
        const added = generated.slice(0, allowed);
        factsCreated += added.length;
        factsReplaced += replaced;
        newSecondary.push(...added);

        if (isSignalEligible(record)) {
          const seenDimensions = new Set<string>();
          for (const signal of parsed.signals.slice(0, 2)) {
            if (seenDimensions.has(signal.dimension)) continue;
            seenDimensions.add(signal.dimension);
            signals.push({ ...signal, sourceMemoryId: record.id, sourceMemoryRevision: inspected.revision });
          }
          if (record.basis === "explicit") {
            for (const text of parsed.requirements.slice(0, 2)) {
              requirements.push({ text, basis: "explicit_memory", sourceMemoryId: record.id });
            }
          } else {
            for (const text of parsed.requirements.slice(0, 2)) {
              requirements.push({ text, basis: "observed_memory", sourceMemoryId: record.id });
            }
          }
        }
        if (isProfileEligible(record)) {
          for (const item of parsed.profileItems.slice(0, 2)) {
            profileItems.push({
              ...item,
              basis: record.basis === "explicit" ? "explicit_memory" : "observed_memory",
              sourceMemoryId: record.id
            });
          }
        }

        processedSources.push({ memoryId: record.id, memoryRevision: inspected.revision });
        processedMemoryIds.push(record.id);
      } catch {
        failedMemoryIds.push(record.id);
      }
    }

    // --- Apply personality / profile updates -------------------------------
    let nextPersonality = personalityState;
    if (signals.length > 0 || requirements.length > 0 || processedSources.length > 0) {
      nextPersonality = applyDreamPersonalityUpdate(personalityState, {
        signals,
        requirements,
        processedSources,
        now: this.now()
      });
    }
    let nextProfile = workingProfileState;
    if (profileItems.length > 0 || processedSources.length > 0) {
      nextProfile = applyDreamProfileUpdate(workingProfileState, {
        items: profileItems,
        processedSources,
        now: this.now()
      });
    }

    // --- Decay pass (idempotent via lastDecayAt) ---------------------------
    let decayed = 0;
    let autoDisabled = 0;
    const allSecondary = [...secondaryRecords, ...newSecondary];
    const decayedSecondary: SecondaryMemoryRecord[] = [];
    for (const record of allSecondary) {
      const result = applySecondaryDecay(record, this.now());
      if (result.decayed) decayed += 1;
      if (result.autoDisabled) autoDisabled += 1;
      decayedSecondary.push(result.record);
    }

    // --- Projections ---------------------------------------------------------
    let agentContent: string | undefined;
    let userContent: string | undefined;
    if (nextPersonality.templateId && nextPersonality !== personalityState) {
      agentContent = renderAgentMarkdown(nextPersonality);
      agentUpdated = agentContent !== fixedFiles.agent;
      if (!agentUpdated) agentContent = undefined;
    } else if (nextPersonality.templateId && personalityState.revision === 0 && nextPersonality.revision === 0) {
      // Never fabricate AGENT.md before a template exists.
    }
    const currentItems = nextProfile.items.filter((item) => item.status === "current");
    const userCustom = fixedFiles.user.trim() !== DEFAULT_USER_PROFILE_TEXT.trim();
    const projectionAllowed = currentItems.length > 0
      || nextProfile.lastProjectedUserHash === userHash
      || !userCustom;
    if (nextProfile !== workingProfileState && projectionAllowed) {
      userContent = renderUserMarkdown(nextProfile);
      userUpdated = userContent !== fixedFiles.user;
      if (!userUpdated) userContent = undefined;
      else nextProfile = Object.freeze({
        ...nextProfile,
        lastProjectedUserHash: sha256Text(userContent)
      });
    }

    const hasWork = processedMemoryIds.length > 0
      || decayed > 0
      || Boolean(agentContent)
      || Boolean(userContent)
      || workingProfileState !== profileState
      || nextPersonality !== personalityState;
    if (!hasWork) {
      return this.finish({
        startedAt,
        processedMemoryIds: [],
        failedMemoryIds,
        factsCreated: 0,
        factsReplaced: 0,
        decayed: 0,
        autoDisabled: 0,
        agentUpdated: false,
        userUpdated: false,
        providerUnavailable,
        committed: false,
        error: providerUnavailable ? "provider_unavailable" : null
      });
    }

    // --- Commit all files through one transaction --------------------------
    const extraChanges: Array<{ relativePath: string; content: string }> = [];
    for (const record of newSecondary) {
      extraChanges.push({ relativePath: record.file, content: serializeSecondaryRecord(record) });
    }
    for (const record of decayedSecondary) {
      if (record.lastDecayAt !== null && !newSecondary.includes(record)) {
        extraChanges.push({ relativePath: record.file, content: serializeSecondaryRecord(record) });
      }
    }
    extraChanges.push({
      relativePath: "agents/echoink/personality-state.json",
      content: personalityStateJson(nextPersonality)
    });
    extraChanges.push({
      relativePath: "shared-user/user-profile-state.json",
      content: userProfileStateJson(nextProfile)
    });

    try {
      await repository.applyCognitiveUpdate({
        ...(agentContent ? { agentContent } : {}),
        ...(userContent ? { userContent } : {}),
        secondaryRecords: decayedSecondary,
        extraChanges,
        detail: `dream: processed=${processedMemoryIds.length} facts=${factsCreated} decayed=${decayed}`
      });
    } catch (error) {
      // Transaction failed → nothing persisted; pending sources stay pending.
      return this.finish({
        startedAt,
        processedMemoryIds: [],
        failedMemoryIds: [...new Set([...failedMemoryIds, ...processedMemoryIds])],
        factsCreated: 0,
        factsReplaced: 0,
        decayed: 0,
        autoDisabled: 0,
        agentUpdated: false,
        userUpdated: false,
        providerUnavailable,
        committed: false,
        error: errorMessage(error)
      });
    }

    // --- Transaction succeeded: advance durable dream progress --------------
    await secondaryStore.refresh();
    const processedSet = new Set(processedMemoryIds);
    const remainingPending = dreamState.pendingMemoryIds.filter((id) => !processedSet.has(id));
    await dreamStateStore.write(Object.freeze({
      ...dreamState,
      revision: dreamState.revision + 1,
      lastRunAt: this.now(),
      lastSuccessAt: this.now(),
      lastProcessedMemoryRevision: inspected.revision,
      pendingMemoryIds: Object.freeze(remainingPending),
      updatedAt: this.now()
    }));

    return this.finish({
      startedAt,
      processedMemoryIds,
      failedMemoryIds,
      factsCreated,
      factsReplaced,
      decayed,
      autoDisabled,
      agentUpdated,
      userUpdated,
      providerUnavailable,
      committed: true,
      error: null
    });
  }

  /**
   * Select ≤ maxMemoriesPerRun memories: pending/changed first, then backfill
   * for existing memories without secondary facts.
   */
  private selectMemories(
    currentRecords: readonly PersonalMemoryRecord[],
    dreamState: DreamState,
    personalityState: PersonalityState,
    secondaryRecords: readonly SecondaryMemoryRecord[]
  ): PersonalMemoryRecord[] {
    const cap = this.config.maxMemoriesPerRun;
    const byId = new Map(currentRecords.map((record) => [record.id, record]));
    const selected: PersonalMemoryRecord[] = [];
    const picked = new Set<string>();

    const processedRevisions = new Map(
      personalityState.processedSources.map((source) => [source.memoryId, source.memoryRevision])
    );
    const parentsWithFacts = new Set(
      secondaryRecords
        .filter((record) => record.status === "current")
        .map((record) => record.parentId)
    );

    const consider = (record: PersonalMemoryRecord): void => {
      if (selected.length >= cap || picked.has(record.id)) return;
      picked.add(record.id);
      selected.push(record);
    };

    // 1. Explicit pending queue (new writes enqueue here).
    for (const id of dreamState.pendingMemoryIds) {
      const record = byId.get(id);
      if (record) consider(record);
    }
    // 2. Changed since the last processed manifest revision.
    for (const record of currentRecords) {
      if (record.revision > dreamState.lastProcessedMemoryRevision) consider(record);
    }
    // 3. Unprocessed (e.g. after a reset cleared processedSources).
    for (const record of currentRecords) {
      const processedAt = processedRevisions.get(record.id);
      if (processedAt === undefined || processedAt < record.revision) consider(record);
    }
    // 4. Backfill: existing memories without secondary facts, cursor-ordered.
    if (selected.length < cap) {
      const backfill = currentRecords
        .filter((record) => !parentsWithFacts.has(record.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      const cursor = dreamState.backfillCursor;
      const start = cursor ? backfill.findIndex((record) => record.id > cursor) : 0;
      for (const record of backfill.slice(Math.max(0, start))) {
        if (selected.length >= cap) break;
        consider(record);
      }
    }
    return selected.slice(0, cap);
  }

  private finish(result: Omit<DreamRunResult, "finishedAt">): DreamRunResult {
    return Object.freeze({ ...result, finishedAt: this.now() });
  }
}

// ---------------------------------------------------------------------------
// Eligibility rules (做梦 PRD §7)
// ---------------------------------------------------------------------------

function isSignalEligible(record: PersonalMemoryRecord): boolean {
  const origin = record.contentOrigin;
  if (origin && ["quotation", "code", "hypothesis", "knowledge", "tool_output", "current_instruction"].includes(origin)) {
    return false;
  }
  return record.basis === "explicit" || record.basis === "observed";
}

function isProfileEligible(record: PersonalMemoryRecord): boolean {
  if (record.basis === "explicit") {
    return record.kind === "fact" || record.kind === "view" || record.kind === "decision";
  }
  return record.basis === "observed" && record.kind === "view";
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildDreamPrompts(
  record: PersonalMemoryRecord,
  maxInputChars: number
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "你是 EchoInk 的离线记忆整理模块。你只基于给定的一条长期记忆做保守推理，输出严格 JSON。",
    "规则：",
    "1. 只输出一个 JSON 对象，键为 secondaryFacts、personalitySignals、agentRequirements、userProfileItems；不要 Markdown 围栏、注释或解释。",
    `2. secondaryFacts：0-${SECONDARY_MAX_PER_PARENT} 条二级事实，作为未来相关查询召回这条记忆的桥梁概念（上位类别、具体实例、属性、场景、常见联想）。`,
    `3. 每条 secondaryFact 形如 {\"title\":≤30字, \"content\":≤120字且使用不确定语气如\"可能/也许相关\", \"recallWhen\":何时可能想起, \"matchTerms\":≤${SECONDARY_MAX_MATCH_TERMS}个完整词或短语（禁止单个汉字）, \"relation\":\"category|instance|attribute|context|associated\", \"reason\":≤80字}。`,
    "4. 禁止推断：疾病或医疗建议、财务或投资建议、法律结论、未说明的人际态度、一次性事件细节、政治敏感立场。",
    "5. personalitySignals：仅当这条记忆体现用户对 Agent 表达方式或处事方式的长期偏好时给出 0-2 条，形如 {\"dimension\":\"tempo|energy|mind|warmth|order|stance\", \"direction\":\"increase|decrease\", \"strength\":0-1, \"evidence\":≤80字}；否则空数组。",
    "6. agentRequirements：仅当记忆是用户对 Agent 的明确长期要求（如\"以后回复简短\"）时给出 0-2 条短语；否则空数组。",
    "7. userProfileItems：仅当记忆包含稳定、当前有效的用户画像（身份、长期偏好、合作方式）时给出 0-2 条 {\"section\":\"identity|preference|collaboration\", \"text\":≤120字}；一次性任务、临时指令、引用、假设不得进入。",
    "8. 不得声称用户亲口说过记忆之外的话；不得生成三级或更深的推理；语言与记忆保持一致。"
  ].join("\n");
  const content = record.content.slice(0, maxInputChars);
  const userPrompt = JSON.stringify({
    memory: {
      kind: record.kind,
      basis: record.basis,
      title: record.title,
      recallWhen: record.recallWhen,
      content
    }
  });
  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Output parsing / validation
// ---------------------------------------------------------------------------

export interface ParsedDreamFact {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly reason: string;
}

export interface ParsedDreamOutput {
  readonly facts: readonly ParsedDreamFact[];
  readonly signals: Array<{
    dimension: "tempo" | "energy" | "mind" | "warmth" | "order" | "stance";
    direction: "increase" | "decrease";
    strength: number;
    evidence: string;
  }>;
  readonly requirements: string[];
  readonly profileItems: Array<{ section: UserProfileSection; text: string }>;
}

export function parseDreamOutput(raw: string): ParsedDreamOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;

  const facts: ParsedDreamFact[] = [];
  if (Array.isArray(root.secondaryFacts)) {
    for (const entry of root.secondaryFacts) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const fact = entry as Record<string, unknown>;
      const title = boundedString(fact.title, 60);
      const content = boundedString(fact.content, 300);
      if (!title || !content) continue;
      const matchTerms = Array.isArray(fact.matchTerms)
        ? fact.matchTerms
            .filter((term): term is string => typeof term === "string")
            .map((term) => term.trim())
            .filter((term) => term.length >= 1 && term.length <= 40)
            .slice(0, SECONDARY_MAX_MATCH_TERMS)
        : [];
      if (matchTerms.length === 0) continue;
      const relation = isSecondaryRelation(fact.relation) ? fact.relation : "associated";
      facts.push(Object.freeze({
        title,
        content,
        recallWhen: boundedString(fact.recallWhen, 500) || title,
        matchTerms: Object.freeze(matchTerms),
        relation,
        reason: boundedString(fact.reason, 300)
      }));
    }
  }

  const dimensions = new Set(["tempo", "energy", "mind", "warmth", "order", "stance"]);
  const signals: ParsedDreamOutput["signals"] = [];
  if (Array.isArray(root.personalitySignals)) {
    for (const entry of root.personalitySignals) {
      if (!entry || typeof entry !== "object") continue;
      const signal = entry as Record<string, unknown>;
      if (!dimensions.has(signal.dimension as string)) continue;
      if (signal.direction !== "increase" && signal.direction !== "decrease") continue;
      signals.push(Object.freeze({
        dimension: signal.dimension as ParsedDreamOutput["signals"][number]["dimension"],
        direction: signal.direction,
        strength: typeof signal.strength === "number" ? Math.max(0, Math.min(1, signal.strength)) : 0.5,
        evidence: boundedString(signal.evidence, 300)
      }));
    }
  }

  const requirements: string[] = [];
  if (Array.isArray(root.agentRequirements)) {
    for (const entry of root.agentRequirements) {
      const text = boundedString(entry, 500);
      if (text) requirements.push(text);
    }
  }

  const profileItems: ParsedDreamOutput["profileItems"] = [];
  const sections = new Set(["identity", "preference", "collaboration"]);
  if (Array.isArray(root.userProfileItems)) {
    for (const entry of root.userProfileItems) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (!sections.has(item.section as string)) continue;
      const text = boundedString(item.text, 800);
      if (!text) continue;
      profileItems.push(Object.freeze({
        section: item.section as UserProfileSection,
        text
      }));
    }
  }

  return Object.freeze({ facts, signals, requirements, profileItems });
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enqueuePending(
  state: DreamState,
  ids: readonly string[],
  now: number
): DreamState {
  const known = new Set(state.pendingMemoryIds);
  const merged = [...state.pendingMemoryIds, ...ids.filter((id) => !known.has(id))];
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    pendingMemoryIds: Object.freeze(merged),
    updatedAt: now
  });
}

/**
 * The canonical default USER.md text; kept in sync with the repository's
 * defaultUserProfile() so legacy-migration can detect custom content.
 */
export const DEFAULT_USER_PROFILE_TEXT = [
  "# USER",
  "",
  "这里保存用户明确确认的当前稳定画像与合作方式。",
  "",
  "- 尚无已确认内容。",
  ""
].join("\n");

// Re-export for callers that build a template-less empty state.
export { applyTemplateToState };
