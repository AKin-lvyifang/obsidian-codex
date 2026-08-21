/**
 * dream-engine.ts — one dreaming round (做梦 PRD §5 + 最新决定).
 *
 * Flow:
 *  1. Gates live in the scheduler (dreamEnabled + memory.enabled +
 *     useLongTermMemory + runsPerDay). Here we only detect Provider absence.
 *  2. 来源对账: USER items / learnedRequirements / observed traits /
 *     candidates / processedSources are reconciled against still-current
 *     primary memories BEFORE any LLM work.
 *  3. Legacy USER.md migration (local, no Provider).
 *  4. Select ≤10 primary memories: pending/changed first, then backfill.
 *  5. Per memory (concurrency 1): LLM → strict JSON → 0–12 临时候选
 *     (不落盘) → 字段验证 → 置信度计算 → 阈值 0.60 → 去重 → 多样性选择
 *     → 与旧 llm_inferred reconcile（复用 fingerprint 相同的旧 ID/hitCount）。
 *  6. Decay pass (idempotent via lastDecayAt).
 *  7. ONE repository transaction commits: personality-state, user-profile-state,
 *     AGENT.md, USER.md, secondary files, Search Index and dream-state
 *     (pendingMemoryIds / processed revision / backfillCursor / lastRunAt /
 *     lastSuccessAt). Never split.
 *  8. lastSuccessAt advances only when the round committed AND the Provider
 *     was available AND no memory failed. Provider unavailable, invalid JSON,
 *     token overflow or write failure: lastSuccessAt untouched, pending kept,
 *     no empty results. lastRunAt always records the real attempt so failed
 *     rounds are not re-paid every 60s.
 */

import { createHash } from "node:crypto";
import {
  SECONDARY_MAX_CANDIDATES,
  SECONDARY_MAX_MATCH_TERMS,
  SECONDARY_MAX_PER_PARENT,
  isSecondaryRelation,
  isSecondarySupportLevel,
  type PersonalMemoryRecord,
  type SecondaryMemoryRecord,
  type SecondaryRelation,
  type SecondarySupportLevel
} from "./personal-memory-contracts";
import {
  applyDreamPersonalityUpdate,
  computeReprocessedMemoryIds,
  emptyPersonalityState,
  reconcilePersonalitySources,
  revokeReprocessedPersonalitySources,
  type DreamPersonalityInput,
  type PersonalityState
} from "./personality-state";
import {
  applyDreamProfileUpdate,
  computeReprocessedProfileMemoryIds,
  reconcileProfileSources,
  revokeReprocessedProfileSources,
  fallbackProfileKey,
  isProfileItemRenderable,
  profileKeyPromptCatalog,
  PROFILE_KEY_MAX_CHARS,
  type DreamProfileInput,
  type ProfileKeyCatalogEntry,
  type UserProfileSection,
  type UserProfileState
} from "./user-profile-state";
import { renderAgentMarkdown, renderUserMarkdown } from "./cognitive-projection";
import {
  applySecondaryDecay,
  reconcileSecondaryForParent,
  serializeSecondaryRecord,
  type SecondaryFactCandidate,
  type SecondaryMemoryStore
} from "./secondary-memory-store";
import {
  cognitiveJsonText,
  normalizeTextForDedupe
} from "./cognitive-file-utils";
import {
  AgentIdentityStateStore,
  defaultAgentIdentityState
} from "./agent-identity-state";
import {
  DREAM_STATE_RELATIVE_PATH,
  enqueuePendingMemoryIds,
  type DreamState,
  type DreamStateStore
} from "./dream-state";
import type { PersonalityStateStore } from "./personality-state";
import type { UserProfileStateStore } from "./user-profile-state";
import {
  TRAIT_DIMENSION_META,
  TRAIT_DIMENSIONS,
  isTraitDimension,
  type TraitDimension
} from "./personality-templates";

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
    /** Round 6 修复四（身份 CAS）：决策时读到的身份 revision。 */
    expectedAgentIdentityRevision?: number;
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
  /** 每条一级记忆最终最多保存的二级事实（硬上限），默认 8。 */
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
  /** 做梦只读取 Agent 身份用于重渲染 AGENT.md，绝不修改身份。 */
  readonly agentIdentityStore?: AgentIdentityStateStore;
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
  readonly factsReused: number;
  readonly factsRetired: number;
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
    const personalityState = (await personalityStore.read())
      ?? this.emptyPersonality(startedAt);
    const profileState = (await profileStore.read())
      ?? this.emptyProfile(startedAt);
    const secondaryRecords = [...(await secondaryStore.loadAll())];
    // 身份只读：做梦重渲染 AGENT.md 时使用当前名称，不得改回默认值。
    const agentIdentity = this.deps.agentIdentityStore
      ? await this.deps.agentIdentityStore.read()
      : defaultAgentIdentityState();
    const inspected = await repository.inspect();
    const currentRecords = inspected.records.filter((record) => record.status === "current");
    const validMemoryIds = new Set(currentRecords.map((record) => record.id));
    const fixedFiles = await repository.readFixedFiles();

    const failedMemoryIds: string[] = [];
    const processedMemoryIds: string[] = [];
    let factsCreated = 0;
    let factsReused = 0;
    let factsRetired = 0;
    let agentUpdated = false;
    let userUpdated = false;
    let migrationError: string | null = null;
    const migrationEnqueue: string[] = [];

    // --- 1. 来源对账 (Memory 来源失效回收) ---------------------------------
    let workingPersonality = reconcilePersonalitySources(personalityState, validMemoryIds, startedAt);
    let workingProfile = reconcileProfileSources(profileState, validMemoryIds, startedAt);

    // --- 2. Legacy USER.md migration (草案 §12.3, local, no Provider) ------
    const userHash = sha256Text(fixedFiles.user);
    const defaultUserHash = sha256Text(DEFAULT_USER_PROFILE_TEXT);
    const userIsCustom = userHash !== defaultUserHash;
    if (workingProfile.revision === 0 && workingProfile.legacyUserMigration === null) {
      workingProfile = Object.freeze({
        ...workingProfile,
        revision: workingProfile.revision + 1,
        legacyUserMigration: userIsCustom ? "pending" as const : "done" as const,
        lastProjectedUserHash: userIsCustom ? "" : userHash,
        updatedAt: startedAt
      });
    }
    if (workingProfile.legacyUserMigration === "pending") {
      try {
        const alreadyMigrated = inspected.records.find(
          (record) => record.status === "current" && record.title === USER_MIGRATION_TITLE
        );
        if (alreadyMigrated) {
          workingProfile = Object.freeze({
            ...workingProfile,
            revision: workingProfile.revision + 1,
            legacyUserMigration: "done" as const,
            updatedAt: startedAt
          });
          migrationEnqueue.push(alreadyMigrated.id);
        } else {
          const migrated = await repository.writeSystemMemory({
            kind: "fact",
            title: USER_MIGRATION_TITLE,
            content: fixedFiles.user.trim(),
            recallWhen: "需要用户稳定画像、身份或长期合作方式时",
            basis: "explicit"
          });
          workingProfile = Object.freeze({
            ...workingProfile,
            revision: workingProfile.revision + 1,
            legacyUserMigration: "done" as const,
            updatedAt: startedAt
          });
          migrationEnqueue.push(migrated.id);
        }
      } catch (error) {
        // 迁移失败绝不静默标记成功：marker 保持 pending，下一轮重试，
        // 旧 USER.md 不会被覆盖。
        migrationError = errorMessage(error);
      }
    }

    // --- 3. Select memories to process --------------------------------------
    const selection = this.selectMemories(currentRecords, dreamState, workingPersonality, secondaryRecords);
    const selected = selection.selected;

    // --- 4. Provider gate ----------------------------------------------------
    const llm = this.deps.llm();
    const providerUnavailable = llm === null;
    const processable = providerUnavailable ? [] : selected;
    if (providerUnavailable) {
      failedMemoryIds.push(...selected.map((record) => record.id));
    }

    // --- 5. Per-memory LLM work (concurrency fixed at 1) --------------------
    const signals: Array<DreamPersonalityInput["signals"][number]> = [];
    const requirements: Array<DreamPersonalityInput["requirements"][number]> = [];
    const profileItems: Array<DreamProfileInput["items"][number]> = [];
    const processedSources: Array<{ memoryId: string; memoryRevision: number }> = [];
    const candidatesByParent = new Map<string, SecondaryFactCandidate[]>();
    let tokensUsed = 0;

    // 同一轮内前面 Memory 新产生的 profileKey 也要供后续 Memory 复用；
    // Prompt 携带的 key 目录有界（Round 6 修复七：PROFILE_KEY_PROMPT_CAP），
    // 持久 current 项 + 本轮新增项一起去重、稳定排序后截断。
    const sameRoundKeys: ProfileKeyCatalogEntry[] = [];
    for (const record of processable) {
      if (!llm) break;
      const promptInput = buildDreamPrompts(
        record,
        this.config.maxInputChars,
        profileKeyPromptCatalog(workingProfile, sameRoundKeys)
      );
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

        // 候选暂不落盘：字段验证在 parse 阶段完成，置信度/去重/多样性在
        // reconcileSecondaryForParent 中统一执行。
        candidatesByParent.set(record.id, parsed.facts.slice(0, SECONDARY_MAX_CANDIDATES)
          .map((fact) => ({
            title: fact.title,
            content: fact.content,
            recallWhen: fact.recallWhen,
            matchTerms: fact.matchTerms.slice(0, this.config.maxMatchTermsPerFact),
            relation: fact.relation,
            supportLevel: fact.supportLevel,
            reason: fact.reason,
            evidence: fact.evidence
          })));

        if (isSignalEligible(record)) {
          const seenDimensions = new Set<string>();
          for (const signal of parsed.signals.slice(0, 2)) {
            if (seenDimensions.has(signal.dimension)) continue;
            seenDimensions.add(signal.dimension);
            // 单条来源 revision 用对应 record.revision，不用整份 manifest revision。
            signals.push({ ...signal, sourceMemoryId: record.id, sourceMemoryRevision: record.revision });
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
            // 与 applyDreamProfileUpdate 同口径生成有效 key（缺省 fallback），
            // 供本轮后续 Memory 复用；目录有界在 profileKeyPromptCatalog 内截断。
            const effectiveKey = (item.profileKey && item.profileKey.trim())
              ? normalizeTextForDedupe(item.profileKey).slice(0, PROFILE_KEY_MAX_CHARS)
              : fallbackProfileKey(item.text);
            if (!sameRoundKeys.some((existing) =>
              existing.section === item.section && existing.profileKey === effectiveKey
            )) {
              sameRoundKeys.push({ section: item.section, profileKey: effectiveKey });
            }
          }
        }

        processedSources.push({ memoryId: record.id, memoryRevision: record.revision });
        processedMemoryIds.push(record.id);
      } catch {
        failedMemoryIds.push(record.id);
      }
    }

    // --- 6. Secondary reconcile per processed parent (no append) -------------
    let finalSecondary: SecondaryMemoryRecord[] = secondaryRecords.filter(
      (record) => !candidatesByParent.has(record.parentId)
    );
    const secondaryFileChanges: Array<{ relativePath: string; content: string }> = [];
    for (const [parentId, candidates] of candidatesByParent) {
      const parentRecord = currentRecords.find((record) => record.id === parentId);
      const result = reconcileSecondaryForParent({
        parentId,
        parentBasis: parentRecord?.basis ?? "inferred",
        parentRevision: parentRecord?.revision ?? 1,
        existing: secondaryRecords.filter((record) => record.parentId === parentId),
        candidates,
        now: this.now()
      });
      finalSecondary.push(...result.records);
      secondaryFileChanges.push(...result.fileChanges);
      factsCreated += result.factsCreated;
      factsReused += result.factsReused;
      factsRetired += result.factsRetired;
    }

    // --- 7. Apply personality / profile updates ------------------------------
    // Round 6 修复五 + Round 6.1 修复二：同一 Memory 以更高 revision 重新处理
    // 时，先撤销旧 revision 产生的派生证据（候选 / 长期要求 / observed / 画像项），
    // 再应用本轮新输出。撤销与新输出在同一事务提交，因此「只有成功重新
    // 处理才撤销」天然成立。传入 validMemoryIds：observed 证据清空后回退历史
    // 时只允许恢复仍 current 且未被本轮重新处理的来源，避免恢复过期证据。
    const reprocessedPersonalityIds = computeReprocessedMemoryIds(workingPersonality, processedSources);
    const personalityBase = reprocessedPersonalityIds.size > 0
      ? revokeReprocessedPersonalitySources(
          workingPersonality, reprocessedPersonalityIds, this.now(), validMemoryIds
        )
      : workingPersonality;
    const reprocessedProfileIds = computeReprocessedProfileMemoryIds(workingProfile, processedSources);
    const profileBase = reprocessedProfileIds.size > 0
      ? revokeReprocessedProfileSources(workingProfile, reprocessedProfileIds, this.now())
      : workingProfile;

    let nextPersonality = personalityBase;
    if (signals.length > 0 || requirements.length > 0 || processedSources.length > 0) {
      nextPersonality = applyDreamPersonalityUpdate(personalityBase, {
        signals,
        requirements,
        processedSources,
        now: this.now()
      });
    }
    let nextProfile = profileBase;
    if (profileItems.length > 0 || processedSources.length > 0) {
      nextProfile = applyDreamProfileUpdate(profileBase, {
        items: profileItems,
        processedSources,
        now: this.now()
      });
    }

    // --- 8. Decay pass (idempotent via lastDecayAt) --------------------------
    let decayed = 0;
    let autoDisabled = 0;
    const decayedSecondary: SecondaryMemoryRecord[] = [];
    const decayedThisRound = new Set<string>();
    for (const record of finalSecondary) {
      const result = applySecondaryDecay(record, this.now());
      if (result.decayed) {
        decayed += 1;
        decayedThisRound.add(result.record.id);
        decayedSecondary.push(result.record);
      } else {
        decayedSecondary.push(record);
      }
      if (result.autoDisabled) autoDisabled += 1;
    }
    // 只写本轮实际衰减的记录，不能把所有 lastDecayAt 非空记录每轮重复写盘。
    const decayedFileChanges = decayedSecondary
      .filter((record) => decayedThisRound.has(record.id))
      .map((record) => ({ relativePath: record.file, content: serializeSecondaryRecord(record) }));

    // --- 9. Projections -------------------------------------------------------
    let agentContent: string | undefined;
    let userContent: string | undefined;
    if (nextPersonality.templateId && nextPersonality !== personalityState) {
      const rendered = renderAgentMarkdown(nextPersonality, agentIdentity);
      if (rendered !== fixedFiles.agent) {
        agentContent = rendered;
        agentUpdated = true;
      }
    }
    const renderableItems = nextProfile.items.filter((item) => isProfileItemRenderable(item));
    const migrationDone = nextProfile.legacyUserMigration === "done";
    const projectionAllowed = (renderableItems.length > 0
      || nextProfile.lastProjectedUserHash === userHash
      || !userIsCustom)
      && (!userIsCustom || migrationDone);
    if (nextProfile !== profileState && projectionAllowed) {
      const rendered = renderUserMarkdown(nextProfile);
      if (rendered !== fixedFiles.user) {
        userContent = rendered;
        userUpdated = true;
        nextProfile = Object.freeze({
          ...nextProfile,
          lastProjectedUserHash: sha256Text(rendered.endsWith("\n") ? rendered : `${rendered}\n`)
        });
      }
    }

    // --- 10. Decide whether there is anything to commit ----------------------
    const hasWork = processedMemoryIds.length > 0
      || secondaryFileChanges.length > 0
      || decayed > 0
      || Boolean(agentContent)
      || Boolean(userContent)
      || workingProfile !== profileState
      || nextPersonality !== personalityState
      || migrationEnqueue.length > 0;
    if (!hasWork) {
      await this.recordAttemptOnly(dreamState);
      return this.finish({
        startedAt,
        processedMemoryIds: [],
        failedMemoryIds,
        factsCreated: 0,
        factsReused: 0,
        factsRetired: 0,
        decayed: 0,
        autoDisabled: 0,
        agentUpdated: false,
        userUpdated: false,
        providerUnavailable,
        committed: false,
        error: providerUnavailable ? "provider_unavailable" : null
      });
    }

    // --- 11. Next durable dream progress --------------------------------------
    const success = !providerUnavailable && failedMemoryIds.length === 0;
    const processedSet = new Set(processedMemoryIds);
    let nextDream: DreamState = Object.freeze({
      ...dreamState,
      revision: dreamState.revision + 1,
      lastRunAt: this.now(),
      lastSuccessAt: success ? this.now() : dreamState.lastSuccessAt,
      lastProcessedMemoryRevision: success ? inspected.revision : dreamState.lastProcessedMemoryRevision,
      pendingMemoryIds: Object.freeze(
        dreamState.pendingMemoryIds.filter((id) => !processedSet.has(id))
      ),
      backfillCursor: selection.backfillProcessed.length > 0
        ? selection.backfillProcessed[selection.backfillProcessed.length - 1]
        : dreamState.backfillCursor,
      updatedAt: this.now()
    });
    if (migrationEnqueue.length > 0) {
      nextDream = enqueuePendingMemoryIds(nextDream, migrationEnqueue, this.now());
    }

    // --- 12. ONE transaction: all cognitive files + dream-state --------------
    const extraChanges: Array<{ relativePath: string; content: string }> = [
      ...secondaryFileChanges,
      ...decayedFileChanges,
      {
        relativePath: "agents/echoink/personality-state.json",
        content: personalityJson(nextPersonality)
      },
      {
        relativePath: "shared-user/user-profile-state.json",
        content: userProfileJson(nextProfile)
      },
      {
        relativePath: DREAM_STATE_RELATIVE_PATH,
        content: cognitiveJsonText(nextDream)
      }
    ];

    // Round 6 修复四（身份 CAS）：做梦期间用户可能在设置页改名/换头像。
    // 提交携带本轮开始时读到的身份 revision；冲突时本地重试一次——重新读
    // 身份、用新身份重渲染 AGENT.md 后再提交——绝不第二次调用 Provider。
    let expectedIdentityRevision = agentIdentity.revision;
    let committed = false;
    let commitError: unknown = null;
    for (let attempt = 0; attempt < 2 && !committed; attempt += 1) {
      try {
        await repository.applyCognitiveUpdate({
          ...(agentContent ? { agentContent } : {}),
          ...(userContent ? { userContent } : {}),
          secondaryRecords: decayedSecondary,
          extraChanges,
          expectedAgentIdentityRevision: expectedIdentityRevision,
          detail: `dream: processed=${processedMemoryIds.length} facts=+${factsCreated}/~${factsReused}/-${factsRetired} decayed=${decayed}${migrationError ? ` migration_error=${migrationError}` : ""}`
        });
        committed = true;
      } catch (error) {
        commitError = error;
        if (!isIdentityRevisionConflict(error)) break;
        if (attempt >= 1) break; // 只允许一次本地重试
        if (this.deps.agentIdentityStore) this.deps.agentIdentityStore.invalidate();
        const freshIdentity = this.deps.agentIdentityStore
          ? await this.deps.agentIdentityStore.read()
          : defaultAgentIdentityState();
        expectedIdentityRevision = freshIdentity.revision;
        if (nextPersonality.templateId) {
          const rendered = renderAgentMarkdown(nextPersonality, freshIdentity);
          if (rendered !== fixedFiles.agent) {
            agentContent = rendered;
            agentUpdated = true;
          } else {
            agentContent = undefined;
            agentUpdated = false;
          }
        }
      }
    }
    if (!committed) {
      // Transaction failed → nothing persisted; still record the attempt so we
      // do not re-pay every heartbeat, but never advance success semantics.
      await this.recordAttemptOnly(dreamState);
      return this.finish({
        startedAt,
        processedMemoryIds: [],
        failedMemoryIds: [...new Set([...failedMemoryIds, ...processedMemoryIds])],
        factsCreated: 0,
        factsReused: 0,
        factsRetired: 0,
        decayed: 0,
        autoDisabled: 0,
        agentUpdated: false,
        userUpdated: false,
        providerUnavailable,
        committed: false,
        error: errorMessage(commitError)
      });
    }

    // --- 13. Transaction succeeded -------------------------------------------
    dreamStateStore.updateCache(nextDream);
    // 事务已提交：同步缓存为最终落盘内容（含衰减后的 records），
    // 不做异步磁盘刷新，避免窗口期。
    secondaryStore.setCache(decayedSecondary);

    return this.finish({
      startedAt,
      processedMemoryIds,
      failedMemoryIds,
      factsCreated,
      factsReused,
      factsRetired,
      decayed,
      autoDisabled,
      agentUpdated,
      userUpdated,
      providerUnavailable,
      committed: true,
      error: migrationError
    });
  }

  /** Persist lastRunAt when a round attempted but committed nothing. */
  private async recordAttemptOnly(dreamState: DreamState): Promise<void> {
    const next: DreamState = Object.freeze({
      ...dreamState,
      revision: dreamState.revision + 1,
      lastRunAt: this.now(),
      updatedAt: this.now()
    });
    await this.deps.dreamStateStore.write(next);
  }

  private emptyPersonality(now: number): PersonalityState {
    return emptyPersonalityState(now);
  }

  private emptyProfile(now: number): UserProfileState {
    return {
      schema: "echoink.user-profile.v1",
      revision: 0,
      items: Object.freeze([]),
      processedSources: Object.freeze([]),
      legacyUserMigration: null,
      lastProjectedUserHash: "",
      updatedAt: now
    } as UserProfileState;
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
  ): { selected: PersonalMemoryRecord[]; backfillProcessed: string[] } {
    const cap = this.config.maxMemoriesPerRun;
    const byId = new Map(currentRecords.map((record) => [record.id, record]));
    const selected: PersonalMemoryRecord[] = [];
    const picked = new Set<string>();
    const fromBackfill = new Set<string>();

    const processedRevisions = new Map(
      personalityState.processedSources.map((source) => [source.memoryId, source.memoryRevision])
    );
    const parentsWithFacts = new Set(
      secondaryRecords
        .filter((record) => record.status === "current")
        .map((record) => record.parentId)
    );

    const consider = (record: PersonalMemoryRecord, backfill: boolean): void => {
      if (selected.length >= cap || picked.has(record.id)) return;
      picked.add(record.id);
      selected.push(record);
      if (backfill) fromBackfill.add(record.id);
    };

    // 1. Explicit pending queue (failed items stay here and retry first).
    for (const id of dreamState.pendingMemoryIds) {
      const record = byId.get(id);
      if (record) consider(record, false);
    }
    // 2. 以每条记录的 processedSources.memoryRevision 为准：只处理尚未
    //    成功处理当前 record.revision 的记忆。部分失败时已成功项不会再被
    //    选中（它们的 memoryRevision 已登记），避免重复 Provider 调用。
    for (const record of currentRecords) {
      const processedAt = processedRevisions.get(record.id);
      if (processedAt === undefined || processedAt < record.revision) consider(record, false);
    }
    // 4. Backfill: existing memories without secondary facts, cursor-ordered.
    //    合法生成 0 条二级事实的记忆已被 processedSources 登记，不得因为
    //    「没有二级事实文件」而再次调用 Provider；只有 revision 变化、
    //    重置或手动重标才能重新进入队列。
    if (selected.length < cap) {
      const backfill = currentRecords
        .filter((record) => {
          if (parentsWithFacts.has(record.id)) return false;
          const processedAt = processedRevisions.get(record.id);
          return processedAt === undefined || processedAt < record.revision;
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      const cursor = dreamState.backfillCursor;
      const start = cursor ? backfill.findIndex((record) => record.id > cursor) : 0;
      for (const record of backfill.slice(Math.max(0, start))) {
        if (selected.length >= cap) break;
        consider(record, true);
      }
    }
    const backfillProcessed = selected
      .filter((record) => fromBackfill.has(record.id))
      .map((record) => record.id)
      .sort((left, right) => left.localeCompare(right));
    return { selected: selected.slice(0, cap), backfillProcessed };
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
// Prompts (六维单向语义：increase=该特质更多，decrease=该特质更少；
// 维度含义必须来自 TRAIT_DIMENSION_META，不允许各模块自行维护)
// ---------------------------------------------------------------------------

export function buildDreamPrompts(
  record: PersonalMemoryRecord,
  maxInputChars: number,
  knownProfileKeys: readonly Readonly<{ section: string; profileKey: string }>[] = []
): { systemPrompt: string; userPrompt: string } {
  const dimensionLines = TRAIT_DIMENSIONS.map((dimension) => {
    const meta = TRAIT_DIMENSION_META[dimension];
    return `- ${dimension}（${meta.labelZh}）：${meta.summaryZh}。increase=该特质表现更多，decrease=该特质表现更少。`;
  });
  const systemPrompt = [
    "你是 EchoInk 的离线记忆整理模块。你只基于给定的一条长期记忆做保守推理，输出严格 JSON。",
    "规则：",
    "1. 只输出一个 JSON 对象，键为 secondaryFacts、personalitySignals、agentRequirements、userProfileItems；不要 Markdown 围栏、注释或解释。",
    `2. secondaryFacts：0-${SECONDARY_MAX_CANDIDATES} 条临时候选（宁缺毋滥，没有可靠推理就输出空数组），作为未来相关查询召回这条记忆的桥梁概念（上位类别、具体实例、属性、场景、常见联想）。`,
    `3. 每条 secondaryFact 必须包含：{\"title\":≤30字, \"content\":≤120字且使用不确定语气如\"可能/也许相关/可参考\", \"recallWhen\":何时可能想起, \"matchTerms\":≤${SECONDARY_MAX_MATCH_TERMS}个完整词或短语（禁止单个汉字）, \"relation\":\"category|instance|attribute|context|associated\", \"supportLevel\":\"direct|strong_inference|weak_inference\"（direct=记忆直接陈述，strong_inference=强推理，weak_inference=弱联想）, \"reason\":≤80字, \"evidence\":≤120字，说明该事实如何由这条一级记忆推导}。缺少 supportLevel 或 evidence 的候选会被丢弃。`,
    "4. 允许带「可能、也许相关、可参考」等不确定口径的保守推理（包括饮食禁忌关联到相关食物类别这类生活化桥接）；但禁止：把推理表述为用户亲口说过的话；给出确定诊断、确定因果或确定身份结论；把二级事实写成一级事实口径；生成三级或更深的推理链。",
    `5. personalitySignals：0-2 条，形如 {\"dimension\":\"${TRAIT_DIMENSIONS.join("|")}\", \"direction\":\"increase|decrease\", \"strength\":0-1, \"evidence\":≤80字}。方向是单向语义：increase=该特质表现更多，decrease=该特质表现更少。六个维度的含义：`,
    ...dimensionLines,
    "5.1 人格信号只允许来自：用户对 Agent 长期相处方式的明确要求；用户多次一致表达的稳定合作偏好；修正后的 current 一级记忆；与 Agent 表达或做事风格直接相关的 explicit/observed view。",
    "5.2 不得从以下内容推断人格：用户自己说话毒舌或说脏话；当前任务内容；用户的职业、爱好或身份；Provider 或模型选择；reasoning 强度；用户临时要求「这次详细一点」这类单次指令；引用、代码、Tool 输出和 Knowledge；单次情绪。",
    "5.3 区分「人格信号」和「长期行为要求」：回答长度、举例数量、固定格式、称呼、语言习惯（如「以后回答先给结论」「以后详细解释」「每次最多三段」「多举例」「少用表格」「使用中文」「称呼我为方哥」「每次附验收步骤」）只进入 agentRequirements，不产生 personalitySignals；只有直接改变性格或工作方式稳定强度的表达才形成 trait signal，例如「以后说话毒舌一点」→sharpness increase、「以后你来替我收敛方案」→dominance increase、「不要能跑就算完成」→rigor increase、「输出习惯按第一、第二、第三」→structure increase、「低风险步骤别总问我」→boldness increase、「多给非传统方案」→creativity increase；这类表达可以同时进入 agentRequirements。「思考深一点」不属于任何人格维度。",
    "6. agentRequirements：仅当记忆是用户对 Agent 的明确长期要求（如\"以后回复简短\"）时给出 0-2 条短语；否则空数组。",
    `7. userProfileItems：仅当记忆包含稳定、当前有效的用户画像（身份、长期偏好、合作方式）时给出 0-2 条 {"section":"identity|preference|collaboration", "profileKey":≤${PROFILE_KEY_MAX_CHARS}字的稳定主题词（如"清晨散步"，同义表述必须复用同一 key）, "text":≤120字}；一次性任务、临时指令、引用、假设不得进入。${knownProfileKeys.length > 0 ? `已有 profileKey（格式 section:key，主题相同必须复用，不要新造近义 key）：${knownProfileKeys.map((entry) => `${entry.section}:${entry.profileKey}`).join("、")}` : ""}`,
    "8. 不得声称用户亲口说过记忆之外的话；语言与记忆保持一致。"
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
  readonly supportLevel: SecondarySupportLevel;
  readonly reason: string;
  readonly evidence: string;
}

export interface ParsedDreamOutput {
  readonly facts: readonly ParsedDreamFact[];
  readonly signals: Array<{
    dimension: TraitDimension;
    direction: "increase" | "decrease";
    strength: number;
    evidence: string;
  }>;
  readonly requirements: string[];
  readonly profileItems: Array<{ section: UserProfileSection; profileKey: string; text: string }>;
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
    for (const entry of root.secondaryFacts.slice(0, SECONDARY_MAX_CANDIDATES)) {
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
      // supportLevel 与 evidence 是候选必填项：缺失即丢弃。
      if (!isSecondarySupportLevel(fact.supportLevel)) continue;
      const evidence = boundedString(fact.evidence, 300);
      if (!evidence) continue;
      const relation = isSecondaryRelation(fact.relation) ? fact.relation : "associated";
      facts.push(Object.freeze({
        title,
        content,
        recallWhen: boundedString(fact.recallWhen, 500) || title,
        matchTerms: Object.freeze(matchTerms),
        relation,
        supportLevel: fact.supportLevel,
        reason: boundedString(fact.reason, 300),
        evidence
      }));
    }
  }

  const signals: ParsedDreamOutput["signals"] = [];
  if (Array.isArray(root.personalitySignals)) {
    for (const entry of root.personalitySignals) {
      if (!entry || typeof entry !== "object") continue;
      const signal = entry as Record<string, unknown>;
      if (!isTraitDimension(signal.dimension)) continue;
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
      const rawKey = typeof item.profileKey === "string" ? item.profileKey.trim() : "";
      profileItems.push(Object.freeze({
        section: item.section as UserProfileSection,
        profileKey: rawKey
          ? rawKey.slice(0, PROFILE_KEY_MAX_CHARS)
          : fallbackProfileKey(text),
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

/** Round 6 修复四：识别 Repository 身份 CAS 冲突（稳定标记）。 */
export function isIdentityRevisionConflict(error: unknown): boolean {
  return /identity_revision_conflict/u.test(errorMessage(error));
}

function personalityJson(state: PersonalityState): string {
  return cognitiveJsonText(state);
}

function userProfileJson(state: UserProfileState): string {
  return cognitiveJsonText(state);
}

const USER_MIGRATION_TITLE = "迁移自 USER.md 的用户画像";

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
