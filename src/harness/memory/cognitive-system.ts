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
  buildPersonalityV2FromLegacy,
  detectPersonalityStateSchema,
  emptyPersonalityState,
  parseLegacyPersonalityStateV1,
  personalityStateJson,
  type LegacyPersonalityStateV1,
  type PersonalityState
} from "./personality-state";
import { cognitiveReadJsonOrNull } from "./cognitive-file-utils";
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
import {
  AGENT_IDENTITY_RELATIVE_PATH,
  AgentIdentityStateStore,
  agentIdentityStateJson,
  defaultAgentIdentityState,
  normalizeAgentAvatar,
  normalizeAgentDisplayName,
  type AgentAvatarState,
  type AgentIdentityState
} from "./agent-identity-state";

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
  readonly agentIdentityStore: AgentIdentityStateStore;
  readonly engine: DreamEngine;
  readonly scheduler: DreamScheduler;
  private readonly now: () => number;

  private constructor(options: CognitiveSystemOptions, parts: Readonly<{
    personalityStore: PersonalityStateStore;
    profileStore: UserProfileStateStore;
    dreamStateStore: DreamStateStore;
    secondaryStore: SecondaryMemoryStore;
    agentIdentityStore: AgentIdentityStateStore;
    engine: DreamEngine;
    scheduler: DreamScheduler;
  }>) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.personalityStore = parts.personalityStore;
    this.profileStore = parts.profileStore;
    this.dreamStateStore = parts.dreamStateStore;
    this.secondaryStore = parts.secondaryStore;
    this.agentIdentityStore = parts.agentIdentityStore;
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
    const agentIdentityStore = new AgentIdentityStateStore(root);

    options.repository.setSecondaryRecords(await secondaryStore.loadAll());
    // 启动时读取一次身份（文件不存在则返回默认运行状态，不写文件），
    // 让 peek/current 快照可以同步供给 UI；不调用 Provider。
    await agentIdentityStore.read();

    // 人格状态 v1 → v2 一次性本地迁移（单事务、无 Provider）。
    // 迁移失败不阻断启动：v1 文件原样保留，下次启动重试。
    try {
      await migratePersonalityV1ToV2({
        repository: options.repository,
        personalityStore,
        dreamStateStore,
        agentIdentityStore,
        secondaryStore,
        now: (options.now ?? Date.now)()
      });
    } catch (error) {
      console.error("[EchoInk] personality v1→v2 migration failed; keeping v1", error);
    }

    const engine = new DreamEngine({
      repository: new RepositoryDreamPort(options.repository),
      personalityStore,
      profileStore,
      secondaryStore,
      dreamStateStore,
      agentIdentityStore,
      llm: options.llm,
      ...(options.now ? { now: options.now } : {})
    });

    const system = new CognitiveSystem(options, {
      personalityStore,
      profileStore,
      dreamStateStore,
      secondaryStore,
      agentIdentityStore,
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
    // 事务提交后同步 SecondaryMemoryStore 缓存（携带已提交 records），
    // 不做 fire-and-forget 异步刷新，避免界面读到旧状态的窗口期。
    options.repository.setSecondaryChangedHook((records) => {
      secondaryStore.setCache(records);
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
    options?: Readonly<{
      reset?: boolean;
      /** 首次选择模板时必须随同提交身份（命名步骤的结果）。 */
      initialIdentity?: Readonly<{
        displayName: string;
        avatar: AgentAvatarState;
      }>;
    }>
  ): Promise<Readonly<{
    revision: number;
    state: PersonalityState;
    agent: string;
    identity: AgentIdentityState;
  }>> {
    const template = getPersonalityTemplate(templateId);
    if (!template) throw new Error(`Unknown personality template: ${templateId}`);
    const now = this.now();
    const previous = (await this.personalityStore.read()) ?? emptyPersonalityShape(now);
    const currentIdentity = await this.agentIdentityStore.read();

    // 首次选择 = 尚无模板且身份仍为默认 revision 0。此时必须携带
    // initialIdentity，否则拒绝写入（UI 取消命名时根本不会调用到这里，
    // 因此取消 = 零写入）。
    const firstTime = previous.templateId === null
      && previous.revision === 0
      && currentIdentity.revision === 0;
    if (firstTime && !options?.reset && !options?.initialIdentity) {
      throw new Error("agent_identity_required");
    }

    let nextIdentity = currentIdentity;
    if (firstTime && !options?.reset && options?.initialIdentity) {
      const displayName = normalizeAgentDisplayName(options.initialIdentity.displayName);
      if (!displayName) throw new Error("agent_identity_invalid_name");
      const avatar = normalizeAgentAvatar(options.initialIdentity.avatar)
        ?? Object.freeze({ kind: "default" as const });
      nextIdentity = Object.freeze({
        schema: currentIdentity.schema,
        revision: currentIdentity.revision + 1,
        displayName,
        avatar,
        updatedAt: now
      });
    }
    // reset 或非首次选择：身份原样保留，revision 不变。

    const next = applyTemplateToState(previous, {
      templateId: template.id,
      now,
      reset: Boolean(options?.reset)
    });
    const agentContent = renderAgentMarkdown(next, nextIdentity);

    const extraChanges: Array<{ relativePath: string; content: string }> = [{
      relativePath: PERSONALITY_STATE_RELATIVE_PATH,
      content: personalityStateJson(next)
    }];
    if (nextIdentity !== currentIdentity) {
      // 首次命名与模板在同一个 Repository 事务中落盘，避免「人格已选但
      // 名字没保存」的半状态。
      extraChanges.push({
        relativePath: AGENT_IDENTITY_RELATIVE_PATH,
        content: agentIdentityStateJson(nextIdentity)
      });
    }

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
    // 事务成功后才更新身份缓存；失败时保持旧身份与旧 AGENT.md。
    if (nextIdentity !== currentIdentity) {
      this.agentIdentityStore.updateCache(nextIdentity);
    }
    return Object.freeze({
      revision: resultRevision,
      state: next,
      agent: agentContent,
      identity: nextIdentity
    });
  }

  // -------------------------------------------------------------------------
  // Agent identity (名称 + 头像；只能由用户在设置中修改，全程无 Provider)
  // -------------------------------------------------------------------------

  /** 读取正式身份状态（文件不存在时回退默认 EchoInk/default）。 */
  async readAgentIdentity(): Promise<AgentIdentityState> {
    return await this.agentIdentityStore.read();
  }

  /** 同步快照（create 时已预热缓存），供 UI 即时读取。 */
  currentAgentIdentity(): AgentIdentityState {
    return this.agentIdentityStore.peek();
  }

  /**
   * 用户修改名称 / 头像：一个 applyCognitiveUpdate 事务保存身份 JSON 与
   * 必要的 AGENT.md。内容没有变化时不增加 revision、不创建事务；
   * 头像变化不影响 trait、learnedRequirements、processedSources、Memory
   * 或 DreamState；全程不调用 Provider。
   */
  async updateAgentIdentity(
    draft: Readonly<{
      displayName: string;
      avatar: AgentAvatarState;
    }>
  ): Promise<Readonly<{
    revision: number;
    identity: AgentIdentityState;
    agent: string;
  }>> {
    const displayName = normalizeAgentDisplayName(draft.displayName);
    if (!displayName) throw new Error("agent_identity_invalid_name");
    const avatar = normalizeAgentAvatar(draft.avatar)
      ?? Object.freeze({ kind: "default" as const });

    const current = await this.agentIdentityStore.read();
    const personality = await this.readPersonalityState();
    const fixedBefore = await this.repository.readUserControlState();
    const nameChanged = displayName !== current.displayName;
    const avatarChanged = avatar.kind !== current.avatar.kind
      || JSON.stringify(avatar) !== JSON.stringify(current.avatar);
    if (!nameChanged && !avatarChanged) {
      // 内容没有变化：不增加 identity revision，也不创建事务。
      return Object.freeze({
        revision: fixedBefore.revision,
        identity: current,
        agent: fixedBefore.agent
      });
    }

    const now = this.now();
    const nextIdentity: AgentIdentityState = Object.freeze({
      schema: current.schema,
      revision: current.revision + 1,
      displayName,
      avatar,
      updatedAt: now
    });
    // 名称变化才需要重写 AGENT.md；头像绝不进入模型上下文。
    const agentContent = nameChanged
      ? renderAgentMarkdown(personality, nextIdentity)
      : undefined;
    const result = await this.repository.applyCognitiveUpdate({
      ...(agentContent ? { agentContent } : {}),
      secondaryRecords: await this.secondaryStore.loadAll(),
      extraChanges: [{
        relativePath: AGENT_IDENTITY_RELATIVE_PATH,
        content: agentIdentityStateJson(nextIdentity)
      }],
      detail: `agent-identity:${nameChanged ? "rename" : "avatar"}`
    });
    this.agentIdentityStore.updateCache(nextIdentity);
    return Object.freeze({
      revision: result.revision,
      identity: nextIdentity,
      agent: agentContent ?? fixedBefore.agent
    });
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

  /** 串行合并连续/并发入队，防止互相覆盖。 */
  private enqueueLane: Promise<void> = Promise.resolve();

  /** 等待异步入队落定（测试与 UI 的同步点）。 */
  async settleDreamEnqueue(): Promise<void> {
    await this.enqueueLane;
  }

  private async enqueueForDream(memoryIds: readonly string[]): Promise<void> {
    const run = async (): Promise<void> => {
      // 入队前必须读取真实持久状态：插件重启后 peek() 可能仍是默认值，
      // 直接写会用空队列覆盖已有 pendingMemoryIds/lastRunAt/lastSuccessAt。
      // enqueuePendingMemoryIds 只追加 pending，不动时间戳和 backfillCursor。
      const state = await this.dreamStateStore.read();
      const next = enqueuePendingMemoryIds(state, memoryIds, this.now());
      if (next !== state) await this.dreamStateStore.write(next);
    };
    const lane = this.enqueueLane.then(run, run);
    this.enqueueLane = lane.catch(() => undefined);
    return lane;
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
  return emptyPersonalityState(now);
}

// ---------------------------------------------------------------------------
// Personality v1 → v2 migration (one local transaction, NO Provider)
//
// 旧六维（tempo/energy/…）与新六维语义不兼容，不做机械分数映射：
// - templateId 保留，explicit 用同模板新六维基线重建；
// - learnedRequirements 保留；observed/history/candidates/processedSources 置空；
// - 完整旧 v1 JSON 备份到 agents/echoink/history/personality-state-v1-<ts>.json；
// - dream-state.lastProcessedMemoryRevision 归 0、backfillCursor 置 null，
//   当前有效一级 Memory 重新进入 pending 队列（每轮仍最多处理 10 条）；
// - 已选择模板时用当前身份名称重写 AGENT.md；未选择模板不覆盖自定义 AGENT.md；
// - 身份的 revision、名称和头像不受迁移影响。
// ---------------------------------------------------------------------------

export interface PersonalityMigrationInput {
  readonly repository: PersonalMemoryRepository;
  readonly personalityStore: PersonalityStateStore;
  readonly dreamStateStore: DreamStateStore;
  readonly agentIdentityStore: AgentIdentityStateStore;
  readonly secondaryStore: SecondaryMemoryStore;
  readonly now: number;
}

export async function migratePersonalityV1ToV2(
  input: PersonalityMigrationInput
): Promise<Readonly<{ migrated: boolean; legacy?: LegacyPersonalityStateV1 }>> {
  const { repository, personalityStore, dreamStateStore, agentIdentityStore, secondaryStore } = input;
  const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(personalityStore.filePath);
  if (!raw) return Object.freeze({ migrated: false });
  if (detectPersonalityStateSchema(raw) !== "v1") return Object.freeze({ migrated: false });
  const legacy = parseLegacyPersonalityStateV1(raw);
  if (!legacy) return Object.freeze({ migrated: false });

  const next = buildPersonalityV2FromLegacy(legacy, { now: input.now });

  // 模板尚未选择时，不得因迁移覆盖现有自定义 AGENT.md。
  let agentContent: string | undefined;
  if (next.templateId) {
    const identity = await agentIdentityStore.read();
    agentContent = renderAgentMarkdown(next, identity);
  }

  const inspected = await repository.readUserControlState();
  const currentIds = inspected.records
    .filter((record) => record.status === "current")
    .map((record) => record.id);
  const dreamState = await dreamStateStore.read();
  let nextDream: DreamState = Object.freeze({
    ...dreamState,
    revision: dreamState.revision + 1,
    lastProcessedMemoryRevision: 0,
    backfillCursor: null,
    updatedAt: input.now
    // lastRunAt / lastSuccessAt 保留
  });
  nextDream = enqueuePendingMemoryIds(nextDream, currentIds, input.now);

  const stamp = new Date(input.now).toISOString().replace(/[:.]/g, "-");
  const result = await repository.applyCognitiveUpdate({
    ...(agentContent ? { agentContent } : {}),
    secondaryRecords: await secondaryStore.loadAll(),
    extraChanges: [
      {
        relativePath: `agents/echoink/history/personality-state-v1-${stamp}.json`,
        content: cognitiveJsonText(legacy.raw)
      },
      {
        relativePath: PERSONALITY_STATE_RELATIVE_PATH,
        content: personalityStateJson(next)
      },
      {
        relativePath: DREAM_STATE_RELATIVE_PATH,
        content: cognitiveJsonText(nextDream)
      }
    ],
    detail: "personality-v1-v2-migration"
  });
  void result;
  // 事务成功后才更新缓存；失败时原 v1 与旧 AGENT.md 全部保留。
  dreamStateStore.updateCache(nextDream);
  return Object.freeze({ migrated: true, legacy });
}
