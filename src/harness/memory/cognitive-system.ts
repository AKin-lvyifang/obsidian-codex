/**
 * cognitive-system.ts — facade wiring 人格(personality) / 做梦(dreaming) /
 * 二级事实(secondary facts) / Recall into one product main-chain.
 *
 * Truth sources (never plugin settings):
 * - .echoink/agents/echoink/personality-state.json
 * - .echoink/shared-user/user-profile-state.json
 * - .echoink/shared-user/.runtime/dream-state.json
 * - .echoink/shared-user/memory/secondary/<parent>/<id>.md
 * - AGENT.md / USER.md / Search Index v3
 *
 * Template selection and reset run as ONE local transaction with NO Provider.
 */

import path from "node:path";
import {
  PERSONALITY_STATE_RELATIVE_PATH,
  PersonalityStateStore,
  applyTemplateToState,
  personalityStateJson,
  type PersonalityState
} from "./personality-state";
import { UserProfileStateStore } from "./user-profile-state";
import {
  DREAM_STATE_RELATIVE_PATH,
  DreamStateStore,
  enqueuePendingMemoryIds,
  type DreamState
} from "./dream-state";
import { cognitiveJsonText } from "./cognitive-file-utils";
import {
  SecondaryMemoryStore,
  serializeSecondaryRecord
} from "./secondary-memory-store";
import {
  getPersonalityTemplate,
  PERSONALITY_TEMPLATES,
  type PersonalityTemplate
} from "./personality-templates";
import { renderAgentMarkdown, renderPersonalitySummary } from "./cognitive-projection";
import {
  DreamEngine,
  type DreamLlmPort,
  type DreamRepositoryPort,
  type DreamRunResult
} from "./dream-engine";
import { DreamScheduler, type DreamSchedulerConfig } from "./dream-scheduler";
import type {
  PersonalMemoryRecord,
  SecondaryMemoryRecord
} from "./personal-memory-contracts";
import { defaultAgentProfile, type PersonalMemoryRepository } from "./personal-memory-repository";

export interface CognitiveSystemLlmOptions {
  /** null → Provider 未配置：做梦当轮不产生模型结果，队列保持 pending。 */
  readonly llm: () => DreamLlmPort | null;
}

export interface CognitiveSystemOptions {
  readonly repository: PersonalMemoryRepository;
  readonly llm: () => DreamLlmPort | null;
  readonly getDreamConfig: () => DreamSchedulerConfig;
  readonly isForegroundBusy: () => boolean;
  readonly registerInterval: (handle: number) => void;
  readonly now?: () => number;
}

class RepositoryDreamPort implements DreamRepositoryPort {
  constructor(private readonly repository: PersonalMemoryRepository) {}

  async inspect(): Promise<Readonly<{ revision: number; records: readonly PersonalMemoryRecord[] }>> {
    const state = await this.repository.readUserControlState();
    return Object.freeze({ revision: state.revision, records: state.records });
  }

  async readVaultId(): Promise<string> {
    return await this.repository.readVaultId();
  }

  async readFixedFiles(): Promise<Readonly<{ agent: string; user: string }>> {
    const state = await this.repository.readUserControlState();
    return Object.freeze({ agent: state.agent, user: state.user });
  }

  async applyCognitiveUpdate(input: Readonly<{
    agentContent?: string;
    userContent?: string;
    secondaryRecords: readonly SecondaryMemoryRecord[];
    extraChanges: readonly Readonly<{ relativePath: string; content: string }>[];
    detail: string;
  }>): Promise<Readonly<{ revision: number }>> {
    return await this.repository.applyCognitiveUpdate(input);
  }

  async writeSystemMemory(input: Readonly<{
    kind: PersonalMemoryRecord["kind"];
    title: string;
    content: string;
    recallWhen: string;
    basis: PersonalMemoryRecord["basis"];
  }>): Promise<Readonly<{ id: string; revision: number }>> {
    const vaultId = await this.repository.readVaultId();
    const result = await this.repository.write({
      operation: "create",
      kind: input.kind,
      title: input.title,
      content: input.content,
      recallWhen: input.recallWhen,
      basis: input.basis,
      contentOrigin: "user_statement"
    } as never, {
      vaultId,
      conversationId: "echoink-dream",
      piSessionId: "echoink-dream",
      productRunId: "echoink-dream-migration",
      userEntryId: "dream",
      memoryMode: "normal",
      learningEnabled: true,
      explicitlyAuthorized: true
    });
    return Object.freeze({ id: result.record!.id, revision: result.revision });
  }
}

export class CognitiveSystem {
  readonly repository: PersonalMemoryRepository;
  readonly personalityStore: PersonalityStateStore;
  readonly profileStore: UserProfileStateStore;
  readonly dreamStateStore: DreamStateStore;
  readonly secondaryStore: SecondaryMemoryStore;
  readonly engine: DreamEngine;
  readonly scheduler: DreamScheduler;
  private readonly now: () => number;

  private constructor(options: CognitiveSystemOptions, parts: Readonly<{
    personalityStore: PersonalityStateStore;
    profileStore: UserProfileStateStore;
    dreamStateStore: DreamStateStore;
    secondaryStore: SecondaryMemoryStore;
    engine: DreamEngine;
    scheduler: DreamScheduler;
  }>) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.personalityStore = parts.personalityStore;
    this.profileStore = parts.profileStore;
    this.dreamStateStore = parts.dreamStateStore;
    this.secondaryStore = parts.secondaryStore;
    this.engine = parts.engine;
    this.scheduler = parts.scheduler;
  }

  /** 设置页展开时需要重新读取做梦投影后的 AGENT.md / USER.md。 */
  async readFixedFiles(): Promise<Readonly<{ agent: string; user: string }>> {
    const state = await this.repository.readUserControlState();
    return Object.freeze({ agent: state.agent, user: state.user });
  }

  /** Build the system against an initialized repository and attach hooks. */
  static async create(options: CognitiveSystemOptions): Promise<CognitiveSystem> {
    const layout = await options.repository.initialize();
    const root = layout.root;
    const personalityStore = new PersonalityStateStore(root);
    const profileStore = new UserProfileStateStore(root);
    const dreamStateStore = new DreamStateStore(root);
    const secondaryStore = new SecondaryMemoryStore(path.join(root, "shared-user", "memory"));

    options.repository.setSecondaryRecords(await secondaryStore.loadAll());

    const engine = new DreamEngine({
      repository: new RepositoryDreamPort(options.repository),
      personalityStore,
      profileStore,
      secondaryStore,
      dreamStateStore,
      llm: options.llm,
      ...(options.now ? { now: options.now } : {})
    });

    const system = new CognitiveSystem(options, {
      personalityStore,
      profileStore,
      dreamStateStore,
      secondaryStore,
      engine,
      scheduler: null as unknown as DreamScheduler
    });

    const scheduler = new DreamScheduler({
      engine,
      getConfig: options.getDreamConfig,
      isForegroundBusy: options.isForegroundBusy,
      readLastRunAt: async () => (await dreamStateStore.read()).lastRunAt,
      registerInterval: options.registerInterval,
      ...(options.now ? { now: options.now } : {})
    });
    (system as { scheduler: DreamScheduler }).scheduler = scheduler;

    options.repository.setSecondaryLifecycleHandler(async (input) =>
      await system.handleSecondaryLifecycle(input.operation, input.parentId)
    );
    options.repository.setMemoryCommittedHook((event) => {
      void system.enqueueForDream([event.recordId]).catch(() => {});
    });
    options.repository.setSecondaryChangedHook(() => {
      void secondaryStore.refresh().catch(() => {});
    });

    return system;
  }

  // -------------------------------------------------------------------------
  // Personality templates (settings → one local transaction, NO Provider)
  // -------------------------------------------------------------------------

  listTemplates(): readonly PersonalityTemplate[] {
    return PERSONALITY_TEMPLATES;
  }

  async readPersonalityState(): Promise<PersonalityState> {
    return (await this.personalityStore.read()) ?? emptyPersonalityShape(this.now());
  }

  async renderPersonalitySummary(language: "zh" | "en"): Promise<string> {
    return renderPersonalitySummary(await this.personalityStore.read(), language);
  }

  /**
   * 选择人格模板（含「重置人格」后重新选择）：单事务完成全部写入，
   * 不调用任何 Provider（人格草案 §4.2 / §10.3 + 最新决定）。
   *
   * reset=true（重置流程的第二步）时，同一事务还会：
   * - 将旧 observed 与 learnedRequirements 以 reason=reset 标记 superseded；
   * - 清空尚未成立的候选；
   * - 把当前有效 Memory 重新标记为待做梦来源（清空 processedSources、
   *   重置 lastProcessedMemoryRevision 并入队 pending）；
   * - 重写 AGENT.md、更新人格状态与六边形。
   *
   * 取消选择零写入：本方法只在用户真正选中新模板后被调用。
   */
  async selectPersonalityTemplate(
    templateId: string,
    options?: Readonly<{ reset?: boolean }>
  ): Promise<Readonly<{
    revision: number;
    state: PersonalityState;
    agent: string;
  }>> {
    const template = getPersonalityTemplate(templateId);
    if (!template) throw new Error(`Unknown personality template: ${templateId}`);
    const now = this.now();
    const previous = (await this.personalityStore.read()) ?? emptyPersonalityShape(now);
    const next = applyTemplateToState(previous, {
      templateId: template.id,
      now,
      reset: Boolean(options?.reset)
    });
    const agentContent = renderAgentMarkdown(next);

    const extraChanges: Array<{ relativePath: string; content: string }> = [{
      relativePath: PERSONALITY_STATE_RELATIVE_PATH,
      content: personalityStateJson(next)
    }];

    // 首次选择模板覆盖自定义 AGENT.md 前，保存一份持久、可恢复的本地
    // 历史版本（事务临时备份提交后会删除，不能冒充历史备份；草案 §12.2）。
    const controlState = await this.repository.readUserControlState();
    const fixedAgent = controlState.agent;
    if (previous.revision === 0
      && fixedAgent.trim().length > 0
      && fixedAgent !== defaultAgentProfile()) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      extraChanges.push({
        relativePath: `agents/echoink/history/AGENT-${stamp}.md`,
        content: fixedAgent.endsWith("\n") ? fixedAgent : `${fixedAgent}\n`
      });
    }

    // 重置：把当前有效 Memory 重新标记为待做梦来源（同一事务）。
    let resultRevision: number;
    if (options?.reset) {
      const inspected = await this.repository.readUserControlState();
      const currentIds = inspected.records
        .filter((record) => record.status === "current")
        .map((record) => record.id);
      const dreamState = await this.dreamStateStore.read();
      let nextDream: DreamState = Object.freeze({
        ...dreamState,
        revision: dreamState.revision + 1,
        lastProcessedMemoryRevision: 0,
        backfillCursor: null,
        updatedAt: now
      });
      nextDream = enqueuePendingMemoryIds(nextDream, currentIds, now);
      extraChanges.push({
        relativePath: DREAM_STATE_RELATIVE_PATH,
        content: cognitiveJsonText(nextDream)
      });
      const result = await this.repository.applyCognitiveUpdate({
        agentContent,
        secondaryRecords: await this.secondaryStore.loadAll(),
        extraChanges,
        detail: `personality-reset-template:${template.id}`
      });
      resultRevision = result.revision;
      this.dreamStateStore.updateCache(nextDream);
    } else {
      const result = await this.repository.applyCognitiveUpdate({
        agentContent,
        secondaryRecords: await this.secondaryStore.loadAll(),
        extraChanges,
        detail: `personality-template:${template.id}`
      });
      resultRevision = result.revision;
    }
    return Object.freeze({ revision: resultRevision, state: next, agent: agentContent });
  }

  // -------------------------------------------------------------------------
  // Secondary facts: user editing / deletion (复盘 → 记忆修正)
  // -------------------------------------------------------------------------

  async listSecondaryForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.listForParent(parentId);
  }

  /** All secondary facts (current + disabled), cached by the store. */
  async listAllSecondary(): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.loadAll();
  }

  /** User edits a secondary fact locally (no Provider). */
  async updateSecondaryFact(secondaryId: string, edits: Readonly<{
    title?: string;
    content?: string;
    recallWhen?: string;
    matchTerms?: readonly string[];
    reason?: string;
  }>): Promise<Readonly<{ revision: number; record: SecondaryMemoryRecord }>> {
    const all = [...(await this.secondaryStore.loadAll())];
    const position = all.findIndex((record) => record.id === secondaryId && record.status === "current");
    if (position < 0) throw new Error(`Secondary fact ${secondaryId} not found`);
    const current = all[position];
    const updated: SecondaryMemoryRecord = Object.freeze({
      ...current,
      ...(edits.title !== undefined ? { title: edits.title.trim() || current.title } : {}),
      ...(edits.content !== undefined ? { content: edits.content.trim() || current.content } : {}),
      ...(edits.recallWhen !== undefined
        ? { recallWhen: edits.recallWhen.trim() || current.recallWhen }
        : {}),
      ...(edits.matchTerms !== undefined
        ? { matchTerms: Object.freeze(edits.matchTerms.map((term) => term.trim()).filter(Boolean).slice(0, 5)) }
        : {}),
      ...(edits.reason !== undefined ? { reason: edits.reason } : {}),
      basis: "user_edited_inference",
      revision: current.revision + 1,
      updatedAt: this.now()
    });
    all[position] = updated;
    const result = await this.repository.applyCognitiveUpdate({
      secondaryRecords: all,
      extraChanges: [{ relativePath: updated.file, content: serializeSecondaryRecord(updated) }],
      detail: `secondary-user-edit:${secondaryId}`
    });
    await this.secondaryStore.refresh();
    return Object.freeze({ revision: result.revision, record: updated });
  }

  /** User deletes a secondary fact locally (file removed in the transaction). */
  async deleteSecondaryFact(secondaryId: string): Promise<Readonly<{ revision: number }>> {
    const all = [...(await this.secondaryStore.loadAll())];
    const position = all.findIndex((record) => record.id === secondaryId && record.status === "current");
    if (position < 0) throw new Error(`Secondary fact ${secondaryId} not found`);
    const removed = all.splice(position, 1)[0];
    const result = await this.repository.applyCognitiveUpdate({
      secondaryRecords: all,
      extraChanges: [{ relativePath: removed.file }],
      detail: `secondary-user-delete:${secondaryId}`
    });
    await this.secondaryStore.refresh();
    return Object.freeze({ revision: result.revision });
  }

  // -------------------------------------------------------------------------
  // Dreaming
  // -------------------------------------------------------------------------

  startDreamScheduler(): void {
    this.scheduler.start();
  }

  async forceDreamRun(): Promise<DreamRunResult | null> {
    return await this.scheduler.forceRun();
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  private async enqueueForDream(memoryIds: readonly string[]): Promise<void> {
    const state = this.dreamStateStore.peek();
    const next = enqueuePendingMemoryIds(state, memoryIds, this.now());
    if (next !== state) await this.dreamStateStore.write(next);
  }

  /**
   * Supersede/forget/close disable the parent's secondary facts; restore
   * re-enables them. Runs inside the parent write's transaction.
   */
  private async handleSecondaryLifecycle(
    operation: "supersede" | "forget" | "restore" | "close",
    parentId: string
  ): Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>> {
    const records = [...(await this.secondaryStore.loadAll())];
    const changedFiles: Array<{ relativePath: string; content: string }> = [];
    const now = this.now();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.parentId !== parentId) continue;
      if (operation === "restore") {
        if (record.status !== "disabled") continue;
        // 因低 confidence 自动停用或被重新做梦替换的事实不随 restore 复活。
        if (record.disabledReason !== null && record.disabledReason !== "parent_lifecycle") {
          continue;
        }
        const updated: SecondaryMemoryRecord = Object.freeze({
          ...record,
          status: "current",
          disabledReason: null,
          revision: record.revision + 1,
          updatedAt: now
        });
        records[index] = updated;
        changedFiles.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      } else {
        if (record.status !== "current") continue;
        const updated: SecondaryMemoryRecord = Object.freeze({
          ...record,
          status: "disabled",
          // restore 只能重新启用 parent forget/close 连带停用的事实。
          disabledReason: "parent_lifecycle",
          revision: record.revision + 1,
          updatedAt: now
        });
        records[index] = updated;
        changedFiles.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      }
    }
    return Object.freeze({ records: Object.freeze(records), changedFiles: Object.freeze(changedFiles) });
  }
}


/** Empty personality shape for vaults that never selected a template. */
function emptyPersonalityShape(now: number): PersonalityState {
  return {
    schema: "echoink.personality.v1",
    revision: 0,
    templateId: null,
    explicit: Object.freeze({ tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null }),
    observed: Object.freeze({ tempo: null, energy: null, mind: null, warmth: null, order: null, stance: null }),
    history: Object.freeze([]),
    candidates: Object.freeze([]),
    learnedRequirements: Object.freeze([]),
    processedSources: Object.freeze([]),
    updatedAt: now
  } as PersonalityState;
}
