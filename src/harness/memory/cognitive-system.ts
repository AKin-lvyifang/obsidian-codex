/**
 * cognitive-system.ts — facade wiring Agent Self, dreaming, secondary facts
 * and Recall into one product main-chain.
 *
 * Current runtime truth:
 * - AGENT.md current-self block
 * - agents/echoink/agent-self-meta.json (template/revision metadata only)
 * - shared-user/user-profile-state.json
 * - shared-user/.runtime/dream-state.json
 * - shared-user/memory/secondary/<parent>/<id>.md
 *
 * The legacy personality-state.json is read only when agent-self metadata is
 * absent. It is never changed or used after migration succeeds.
 */

import { createHash } from "node:crypto";
import {
  inspectUserProfileStateFile,
  userProfileStateJson,
  UserProfileStateStore
} from "./user-profile-state";
import {
  DreamStateStore,
  enqueuePendingMemoryIds
} from "./dream-state";
import { DreamExperienceInboxStore } from "./dream-experience-inbox";
import {
  SecondaryMemoryStore,
  serializeSecondaryRecord
} from "./secondary-memory-store";
import {
  AGENT_TEMPLATES,
  getAgentTemplate,
  type AgentTemplate,
  type AgentTemplateId
} from "./agent-templates";
import {
  applyAgentSelfOperations as applyStructuredAgentSelfOperations,
  agentSelfFromTemplate,
  parseAgentCurrentSelf,
  publicAgentSelfProfile,
  renderAgentMarkdown,
  replaceAgentCurrentSelf,
  stableSelfKey,
  type AgentSelfHabit,
  type AgentSelfOperation,
  type AgentSelfState,
  type PublicAgentSelfProfile
} from "./agent-self";
import { BUILTIN_SKILLS } from "../resources/builtin-skills";
import {
  AGENT_SELF_METADATA_RELATIVE_PATH,
  AgentSelfMetadataStore,
  agentSelfMetadataJson,
  emptyAgentSelfMetadata,
  type AgentSelfDerivation,
  type AgentSelfDerivationSource,
  type AgentSelfDerivationTarget,
  type AgentSelfMetadata
} from "./agent-self-metadata";
import {
  inspectLegacyAgentMarkdown,
  inspectLegacyPersonalityFile,
  legacyAgentBackupRelativePath
} from "./legacy-personality-reader";
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
import { memorySourceGroup } from "./dream-source-group";
import { defaultAgentProfile, type PersonalMemoryRepository } from "./personal-memory-repository";
import {
  AGENT_IDENTITY_RELATIVE_PATH,
  AgentIdentityStateStore,
  agentIdentityStateJson,
  normalizeAgentAvatar,
  normalizeAgentDisplayName,
  type AgentAvatarState,
  type AgentIdentityState
} from "./agent-identity-state";

export interface CognitiveSystemLlmOptions {
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

export interface AgentSelfSnapshot {
  readonly revision: number;
  readonly metadata: AgentSelfMetadata;
  readonly state: AgentSelfState;
  readonly agent: string;
}

export interface AgentProfileView {
  readonly revision: number;
  readonly templateId: AgentTemplateId | null;
  readonly preferredSkillNames: readonly string[];
  readonly currentSelf: PublicAgentSelfProfile;
}

class RepositoryDreamPort implements DreamRepositoryPort {
  constructor(private readonly repository: PersonalMemoryRepository) {}

  async inspect(): Promise<Readonly<{ revision: number; records: readonly PersonalMemoryRecord[] }>> {
    const state = await this.repository.inspect();
    return Object.freeze({ revision: state.revision, records: state.records });
  }

  async readVaultId(): Promise<string> {
    return await this.repository.readVaultId();
  }

  async readFixedFiles(): Promise<Readonly<{
    agent: string;
    agentHash: string;
    user: string;
    userHash: string;
    userBytes: number;
  }>> {
    return await this.repository.inspectCognitiveFixedFiles();
  }

  async applyCognitiveUpdate(input: Readonly<{
    agentContent?: string;
    userContent?: string;
    secondaryRecords: readonly SecondaryMemoryRecord[];
    extraChanges: readonly Readonly<{ relativePath: string; content: string }>[];
    detail: string;
    expectedMemoryRevision: number;
    expectedAgentIdentityRevision?: number;
    expectedAgentProjectionHash?: string;
    expectedUserProjectionHash?: string;
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
      explicitlyAuthorized: true
    });
    return Object.freeze({ id: result.record!.id, revision: result.revision });
  }
}

export class CognitiveSystem {
  readonly repository: PersonalMemoryRepository;
  readonly agentSelfMetadataStore: AgentSelfMetadataStore;
  readonly profileStore: UserProfileStateStore;
  readonly dreamStateStore: DreamStateStore;
  readonly secondaryStore: SecondaryMemoryStore;
  readonly agentIdentityStore: AgentIdentityStateStore;
  readonly engine: DreamEngine;
  readonly scheduler: DreamScheduler;
  private readonly now: () => number;
  private agentTemplateId: AgentTemplateId | null;

  private constructor(options: CognitiveSystemOptions, parts: Readonly<{
    agentSelfMetadataStore: AgentSelfMetadataStore;
    profileStore: UserProfileStateStore;
    dreamStateStore: DreamStateStore;
    secondaryStore: SecondaryMemoryStore;
    agentIdentityStore: AgentIdentityStateStore;
    engine: DreamEngine;
    scheduler: DreamScheduler;
    agentTemplateId: AgentTemplateId | null;
  }>) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.agentSelfMetadataStore = parts.agentSelfMetadataStore;
    this.profileStore = parts.profileStore;
    this.dreamStateStore = parts.dreamStateStore;
    this.secondaryStore = parts.secondaryStore;
    this.agentIdentityStore = parts.agentIdentityStore;
    this.engine = parts.engine;
    this.scheduler = parts.scheduler;
    this.agentTemplateId = parts.agentTemplateId;
  }

  async readFixedFiles(): Promise<Readonly<{ agent: string; user: string }>> {
    const state = await this.repository.readUserControlState();
    return Object.freeze({ agent: state.agent, user: state.user });
  }

  static async create(options: CognitiveSystemOptions): Promise<CognitiveSystem> {
    const secondaryStore = new SecondaryMemoryStore(options.repository.layout.history);
    options.repository.setSecondaryRecords(await secondaryStore.loadAll());
    const layout = await options.repository.initialize();
    await options.repository.ensureSecondaryIndexFresh();

    const root = layout.root;
    const agentSelfMetadataStore = new AgentSelfMetadataStore(root);
    const profileStore = new UserProfileStateStore(root);
    const dreamStateStore = new DreamStateStore(root);
    const experienceInboxStore = new DreamExperienceInboxStore(root);
    const agentIdentityStore = new AgentIdentityStateStore(root);
    await agentIdentityStore.read();

    const metadataInspection = await agentSelfMetadataStore.inspect();
    if (metadataInspection.kind === "invalid") {
      throw new Error(`agent_self_metadata_invalid:${metadataInspection.reason}`);
    }
    if (metadataInspection.kind === "missing") {
      await migrateLegacyPersonalityToAgentSelf({
        repository: options.repository,
        metadataStore: agentSelfMetadataStore,
        secondaryStore,
        agentIdentityStore,
        now: (options.now ?? Date.now)()
      });
    }

    const fixed = await options.repository.readUserControlState();
    const parsedSelf = parseAgentCurrentSelf(fixed.agent);
    if (parsedSelf.kind !== "ok") {
      throw new Error(`agent_self_invalid:${parsedSelf.reason}`);
    }
    const metadata = await agentSelfMetadataStore.read() ?? emptyAgentSelfMetadata();

    const profileInspection = await inspectUserProfileStateFile(profileStore.filePath);
    if (profileInspection.kind === "invalid") {
      throw new Error(`user_profile_state_invalid:${profileInspection.reason}`);
    }
    if (profileInspection.kind === "v1") {
      try {
        await options.repository.applyCognitiveUpdate({
          secondaryRecords: await secondaryStore.loadAll(),
          extraChanges: [{
            relativePath: "shared-user/user-profile-state.json",
            content: userProfileStateJson(profileInspection.state)
          }],
          detail: "user-profile-v1-to-v2-migration"
        });
      } catch {
        throw new Error("user_profile_migration_blocked:transaction_failed");
      }
    }

    const engine = new DreamEngine({
      repository: new RepositoryDreamPort(options.repository),
      profileStore,
      secondaryStore,
      dreamStateStore,
      experienceInboxStore,
      agentSelfMetadataStore,
      agentIdentityStore,
      llm: options.llm,
      ...(options.now ? { now: options.now } : {})
    });

    const system = new CognitiveSystem(options, {
      agentSelfMetadataStore,
      profileStore,
      dreamStateStore,
      secondaryStore,
      agentIdentityStore,
      engine,
      scheduler: null as unknown as DreamScheduler,
      agentTemplateId: metadata.templateId
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
    options.repository.setSecondaryRefreshProvider(async () =>
      await secondaryStore.refresh()
    );
    options.repository.setMemoryCommittedHook((event) => {
      void system.enqueueForDream([event.recordId]).catch(() => {});
    });
    options.repository.setSecondaryChangedHook((records) => {
      secondaryStore.setCache(records);
    });

    return system;
  }

  listTemplates(): readonly AgentTemplate[] {
    return AGENT_TEMPLATES;
  }

  async readAgentSelfState(): Promise<AgentSelfSnapshot> {
    const control = await this.repository.readAgentSelfControlSnapshot();
    const parsed = parseAgentCurrentSelf(control.agent);
    if (parsed.kind !== "ok") {
      throw new Error(`agent_self_invalid:${parsed.reason}`);
    }
    const metadata = control.metadata ?? emptyAgentSelfMetadata();
    this.agentSelfMetadataStore.updateCache(metadata);
    this.agentTemplateId = metadata.templateId;
    return Object.freeze({
      revision: control.revision,
      metadata,
      state: parsed.state,
      agent: control.agent
    });
  }

  async readAgentProfile(): Promise<AgentProfileView> {
    const snapshot = await this.readAgentSelfState();
    const template = getAgentTemplate(snapshot.metadata.templateId);
    return Object.freeze({
      revision: snapshot.revision,
      templateId: snapshot.metadata.templateId,
      preferredSkillNames: templatePreferredSkillNames(template),
      currentSelf: publicAgentSelfProfile(snapshot.state)
    });
  }

  async applyAgentSelfOperations(
    operations: readonly AgentSelfOperation[],
    expectedRevision?: number
  ): Promise<AgentSelfSnapshot> {
    const snapshot = await this.readAgentSelfState();
    if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
      throw new Error(`agent_self_revision_conflict:expected=${expectedRevision}:disk=${snapshot.revision}`);
    }
    const nextState = applyStructuredAgentSelfOperations(snapshot.state, operations);
    const nextAgent = replaceAgentCurrentSelf(snapshot.agent, nextState);
    if (nextAgent === snapshot.agent) return snapshot;

    const identity = await this.agentIdentityStore.read();
    const now = this.now();
    const manuallyTouched = new Set<AgentSelfDerivationTarget>(operations.map((operation): AgentSelfDerivationTarget =>
      operation.operation === "replace"
        ? operation.field
        : `habit:${operation.operation === "habit_add"
          ? stableSelfKey(operation.key || operation.text)
          : operation.key}`
    ));
    const nextMetadata: AgentSelfMetadata = Object.freeze({
      ...snapshot.metadata,
      revision: snapshot.metadata.revision + 1,
      derivations: Object.freeze(snapshot.metadata.derivations.filter(
        (derivation) => !manuallyTouched.has(derivation.target)
      )),
      updatedAt: now
    });
    const result = await this.repository.applyCognitiveUpdate({
      agentContent: nextAgent,
      secondaryRecords: await this.secondaryStore.loadAll(),
      extraChanges: [
        {
          relativePath: `agents/echoink/history/AGENT-self-r${snapshot.metadata.revision}.md`,
          content: snapshot.agent
        },
        {
          relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
          content: agentSelfMetadataJson(nextMetadata)
        }
      ],
      expectedMemoryRevision: snapshot.revision,
      expectedAgentIdentityRevision: identity.revision,
      expectedAgentProjectionHash: agentProjectionHash(snapshot.agent),
      detail: `agent-self-controlled-update:${operations.map((operation) => operation.operation).join(",")}`
    });
    this.agentSelfMetadataStore.updateCache(nextMetadata);
    return Object.freeze({
      revision: result.revision,
      metadata: nextMetadata,
      state: nextState,
      agent: nextAgent
    });
  }

  currentPersonalityTemplateId(): AgentTemplateId | null {
    return this.agentTemplateId;
  }

  async selectPersonalityTemplate(
    templateId: string,
    options?: Readonly<{
      initialIdentity?: Readonly<{
        displayName: string;
        avatar: AgentAvatarState;
      }>;
    }>
  ): Promise<Readonly<{
    revision: number;
    state: AgentSelfState;
    metadata: AgentSelfMetadata;
    agent: string;
    identity: AgentIdentityState;
  }>> {
    const template = getAgentTemplate(templateId);
    if (!template) throw new Error(`Unknown personality template: ${templateId}`);

    const now = this.now();
    const snapshot = await this.readAgentSelfState();
    const currentIdentity = await this.agentIdentityStore.read();
    const selection = initialTemplateSelectionStatus(snapshot.metadata, currentIdentity);
    if (selection.requiresFirstNaming && !options?.initialIdentity) {
      throw new Error("agent_identity_required");
    }

    let nextIdentity = currentIdentity;
    if (selection.isInitialTemplateSelection && options?.initialIdentity) {
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

    if (snapshot.metadata.templateId === template.id && nextIdentity === currentIdentity) {
      return Object.freeze({
        revision: snapshot.revision,
        state: snapshot.state,
        metadata: snapshot.metadata,
        agent: snapshot.agent,
        identity: currentIdentity
      });
    }

    const nextState = agentSelfFromTemplate(template, snapshot.state.currentLearnedHabits);
    const agentContent = renderAgentMarkdown({
      identity: nextIdentity,
      styleName: template.labelZh,
      self: nextState
    });
    const nextMetadata: AgentSelfMetadata = Object.freeze({
      ...snapshot.metadata,
      revision: snapshot.metadata.revision + 1,
      templateId: template.id,
      derivations: Object.freeze(snapshot.metadata.derivations.filter(
        (derivation) => derivation.target.startsWith("habit:")
      )),
      updatedAt: now
    });
    const extraChanges: Array<{ relativePath: string; content: string }> = [{
      relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
      content: agentSelfMetadataJson(nextMetadata)
    }];

    if (nextIdentity !== currentIdentity) {
      extraChanges.push({
        relativePath: AGENT_IDENTITY_RELATIVE_PATH,
        content: agentIdentityStateJson(nextIdentity)
      });
    }

    if (selection.isInitialTemplateSelection
      && snapshot.agent.trim().length > 0
      && snapshot.agent !== defaultAgentProfile(currentIdentity)) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      extraChanges.push({
        relativePath: `agents/echoink/history/AGENT-${stamp}.md`,
        content: snapshot.agent.endsWith("\n") ? snapshot.agent : `${snapshot.agent}\n`
      });
    }

    const result = await this.repository.applyCognitiveUpdate({
      agentContent,
      secondaryRecords: await this.secondaryStore.loadAll(),
      extraChanges,
      expectedMemoryRevision: snapshot.revision,
      expectedAgentIdentityRevision: currentIdentity.revision,
      expectedAgentProjectionHash: agentProjectionHash(snapshot.agent),
      detail: selection.isInitialTemplateSelection
        ? `agent-self-initial-template:${template.id}`
        : `agent-self-template:${template.id}`
    });

    if (nextIdentity !== currentIdentity) this.agentIdentityStore.updateCache(nextIdentity);
    this.agentSelfMetadataStore.updateCache(nextMetadata);
    this.agentTemplateId = nextMetadata.templateId;
    return Object.freeze({
      revision: result.revision,
      state: nextState,
      metadata: nextMetadata,
      agent: agentContent,
      identity: nextIdentity
    });
  }

  async readAgentIdentity(): Promise<AgentIdentityState> {
    return await this.agentIdentityStore.read();
  }

  currentAgentIdentity(): AgentIdentityState {
    return this.agentIdentityStore.peek();
  }

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
    const snapshot = await this.readAgentSelfState();
    const nameChanged = displayName !== current.displayName;
    const avatarChanged = JSON.stringify(avatar) !== JSON.stringify(current.avatar);
    if (!nameChanged && !avatarChanged) {
      return Object.freeze({
        revision: snapshot.revision,
        identity: current,
        agent: snapshot.agent
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
    const agentContent = nameChanged
      ? renderAgentMarkdown({
          identity: nextIdentity,
          styleName: templateStyleName(snapshot.metadata.templateId),
          self: snapshot.state
        })
      : undefined;
    const result = await this.repository.applyCognitiveUpdate({
      ...(agentContent ? { agentContent } : {}),
      secondaryRecords: await this.secondaryStore.loadAll(),
      extraChanges: [{
        relativePath: AGENT_IDENTITY_RELATIVE_PATH,
        content: agentIdentityStateJson(nextIdentity)
      }],
      expectedMemoryRevision: snapshot.revision,
      expectedAgentIdentityRevision: current.revision,
      expectedAgentProjectionHash: agentProjectionHash(snapshot.agent),
      detail: `agent-identity:${nameChanged ? "rename" : "avatar"}`
    });
    this.agentIdentityStore.updateCache(nextIdentity);
    return Object.freeze({
      revision: result.revision,
      identity: nextIdentity,
      agent: agentContent ?? snapshot.agent
    });
  }

  async listSecondaryForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.listForParent(parentId);
  }

  async listAllSecondary(): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.loadAll();
  }

  async updateSecondaryFact(parentId: string, secondaryId: string, edits: Readonly<{
    title?: string;
    content?: string;
    recallWhen?: string;
    matchTerms?: readonly string[];
    reason?: string;
  }>, expectedRevision: number): Promise<Readonly<{
    revision: number;
    record: SecondaryMemoryRecord;
  }>> {
    const result = await this.repository.applySecondaryUserMutation({
      operation: "edit",
      parentId,
      secondaryId,
      expectedRevision,
      edits
    });
    if (!result.record) throw new Error("secondary_edit_missing_result");
    return Object.freeze({ revision: result.revision, record: result.record });
  }

  async deleteSecondaryFact(
    parentId: string,
    secondaryId: string,
    expectedRevision: number
  ): Promise<Readonly<{ revision: number }>> {
    const result = await this.repository.applySecondaryUserMutation({
      operation: "delete",
      parentId,
      secondaryId,
      expectedRevision
    });
    return Object.freeze({ revision: result.revision });
  }

  startDreamScheduler(): void {
    this.scheduler.start();
  }

  async forceDreamRun(): Promise<DreamRunResult | null> {
    return await this.scheduler.forceRun();
  }

  async dispose(): Promise<void> {
    this.scheduler.dispose();
    await this.repository.dispose();
    await this.settleDreamEnqueue();
  }

  private enqueueLane: Promise<void> = Promise.resolve();

  async settleDreamEnqueue(): Promise<void> {
    await this.enqueueLane;
  }

  async enqueueForDream(memoryIds: readonly string[]): Promise<void> {
    const run = async (): Promise<void> => {
      const state = await this.dreamStateStore.read();
      const next = enqueuePendingMemoryIds(state, memoryIds, this.now());
      if (next !== state) await this.dreamStateStore.write(next);
    };
    const lane = this.enqueueLane.then(run, run);
    this.enqueueLane = lane.catch(() => undefined);
    return lane;
  }

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
        if (record.disabledReason !== null && record.disabledReason !== "parent_lifecycle") continue;
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

export function initialTemplateSelectionStatus(
  metadata: Readonly<{ templateId: string | null }>,
  identity: Readonly<{ revision: number }>
): Readonly<{
  isInitialTemplateSelection: boolean;
  needsInitialIdentity: boolean;
  requiresFirstNaming: boolean;
}> {
  const isInitialTemplateSelection = metadata.templateId === null;
  const needsInitialIdentity = isInitialTemplateSelection && identity.revision === 0;
  return Object.freeze({
    isInitialTemplateSelection,
    needsInitialIdentity,
    requiresFirstNaming: needsInitialIdentity
  });
}

export async function migrateLegacyPersonalityToAgentSelf(input: Readonly<{
  repository: PersonalMemoryRepository;
  metadataStore: AgentSelfMetadataStore;
  secondaryStore: SecondaryMemoryStore;
  agentIdentityStore: AgentIdentityStateStore;
  now: number;
}>): Promise<Readonly<{ migrated: boolean }>> {
  const fixed = await input.repository.readUserControlState();
  const personality = await inspectLegacyPersonalityFile(input.repository.layout.personalityState);
  if (personality.kind === "invalid") {
    throw new Error(`legacy_personality_invalid:${personality.reason}`);
  }

  const personalityTemplate = personality.kind === "valid" && personality.state.templateId
    ? getAgentTemplate(personality.state.templateId)
    : null;
  if (personality.kind === "valid" && personality.state.templateId && !personalityTemplate) {
    throw new Error("legacy_personality_template_invalid");
  }

  const currentSelf = parseAgentCurrentSelf(fixed.agent);
  if (currentSelf.kind === "ok") {
    const renderedTemplateId = inspectRenderedAgentTemplateId(fixed.agent);
    if (renderedTemplateId.kind === "invalid") {
      throw new Error(`agent_self_metadata_recovery_blocked:${renderedTemplateId.reason}`);
    }
    if (renderedTemplateId.templateId && personalityTemplate
      && renderedTemplateId.templateId !== personalityTemplate.id) {
      throw new Error("legacy_agent_template_conflict");
    }
    const legacyImport = importLegacyRequirements(
      currentSelf.state.currentLearnedHabits,
      personality.kind === "valid" ? personality.state.learnedRequirements : [],
      fixed.records,
      input.now
    );
    const habits = legacyImport.habits;
    const agentContent = habits.length === currentSelf.state.currentLearnedHabits.length
      ? undefined
      : replaceAgentCurrentSelf(fixed.agent, {
          ...currentSelf.state,
          currentLearnedHabits: habits
        });
    const identity = await input.agentIdentityStore.read();
    const metadata: AgentSelfMetadata = Object.freeze({
      ...emptyAgentSelfMetadata(input.now),
      revision: 1,
      templateId: personalityTemplate?.id ?? renderedTemplateId.templateId,
      legacyPersonalityImported: personality.kind === "valid",
      derivations: legacyImport.derivations
    });
    const extraChanges: Array<{ relativePath: string; content: string }> = [];
    if (agentContent !== undefined) {
      extraChanges.push({
        relativePath: legacyAgentBackupRelativePath(fixed.agent),
        content: fixed.agent
      });
    }
    extraChanges.push({
      relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
      content: agentSelfMetadataJson(metadata)
    });
    try {
      await input.repository.applyCognitiveUpdate({
        ...(agentContent === undefined ? {} : { agentContent }),
        secondaryRecords: await input.secondaryStore.loadAll(),
        extraChanges,
        expectedMemoryRevision: fixed.revision,
        expectedAgentIdentityRevision: identity.revision,
        expectedAgentProjectionHash: agentProjectionHash(fixed.agent),
        detail: personality.kind === "valid"
          ? "agent-self-current-metadata-with-legacy-import"
          : "agent-self-current-metadata-recovery"
      });
    } catch (error) {
      const reason = error instanceof Error && /identity_revision_conflict/u.test(error.message)
        ? "identity_revision_conflict"
        : "transaction_failed";
      throw new Error(`agent_self_migration_blocked:${reason}`);
    }
    input.metadataStore.updateCache(metadata);
    return Object.freeze({ migrated: true });
  }

  const legacyAgent = inspectLegacyAgentMarkdown(fixed.agent);
  if (legacyAgent.kind === "invalid") {
    throw new Error(`legacy_agent_invalid:${legacyAgent.reason}`);
  }
  if (personality.kind === "valid" && legacyAgent.state.format !== "static_default") {
    const expectedFormat = personality.state.schema === "echoink.personality.v1"
      ? "personality_projection_v1"
      : "personality_projection_v2";
    if (legacyAgent.state.format !== expectedFormat) {
      throw new Error("legacy_agent_personality_schema_mismatch");
    }
  }
  if (legacyAgent.state.templateId && personalityTemplate
    && legacyAgent.state.templateId !== personalityTemplate.id) {
    throw new Error("legacy_agent_template_conflict");
  }

  const template = personalityTemplate
    ?? getAgentTemplate(legacyAgent.state.templateId);
  const seedTemplate = template ?? getAgentTemplate("advisor")!;
  const legacyImport = importLegacyProjectionRequirements(
    legacyAgent.state.habits,
    personality.kind === "valid" ? personality.state.learnedRequirements : [],
    fixed.records,
    input.now
  );
  const habits = legacyImport.habits;
  const self = agentSelfFromTemplate(seedTemplate, habits);
  const identity = await input.agentIdentityStore.read();
  const agentContent = renderAgentMarkdown({
    identity,
    styleName: template?.labelZh ?? "尚未选择",
    self
  });
  const metadata: AgentSelfMetadata = Object.freeze({
    ...emptyAgentSelfMetadata(input.now),
    revision: 1,
    templateId: template?.id ?? null,
    legacyPersonalityImported: personality.kind === "valid",
    derivations: legacyImport.derivations
  });

  try {
    await input.repository.applyCognitiveUpdate({
      agentContent,
      secondaryRecords: await input.secondaryStore.loadAll(),
      extraChanges: [
        {
          relativePath: legacyAgentBackupRelativePath(fixed.agent),
          content: fixed.agent
        },
        {
          relativePath: AGENT_SELF_METADATA_RELATIVE_PATH,
          content: agentSelfMetadataJson(metadata)
        }
      ],
      expectedMemoryRevision: fixed.revision,
      expectedAgentIdentityRevision: identity.revision,
      expectedAgentProjectionHash: agentProjectionHash(fixed.agent),
      detail: personality.kind === "valid"
        ? "agent-self-legacy-personality-import"
        : "agent-self-legacy-agent-import"
    });
  } catch (error) {
    const reason = error instanceof Error && /identity_revision_conflict/u.test(error.message)
      ? "identity_revision_conflict"
      : "transaction_failed";
    throw new Error(`agent_self_migration_blocked:${reason}`);
  }

  input.metadataStore.updateCache(metadata);
  return Object.freeze({ migrated: true });
}

function inspectRenderedAgentTemplateId(markdown: string):
  | Readonly<{ kind: "valid"; templateId: AgentTemplateId | null }>
  | Readonly<{ kind: "invalid"; reason: string }> {
  const matches = [...markdown.matchAll(/^我的初始风格来自「(.+?)」。$/gmu)];
  if (matches.length !== 1) return Object.freeze({ kind: "invalid", reason: "style_source_count" });
  const label = matches[0][1];
  if (label === "尚未选择") return Object.freeze({ kind: "valid", templateId: null });
  const template = AGENT_TEMPLATES.find((candidate) => candidate.labelZh === label);
  return template
    ? Object.freeze({ kind: "valid", templateId: template.id })
    : Object.freeze({ kind: "invalid", reason: "style_source_unknown" });
}

function importLegacyRequirements(
  initial: readonly AgentSelfHabit[],
  requirements: readonly Readonly<{
    text: string;
    basis: "explicit_memory" | "observed_memory";
    status: "current" | "superseded";
    sourceMemoryIds: readonly string[];
  }>[],
  records: readonly PersonalMemoryRecord[],
  now: number
): Readonly<{
  habits: readonly AgentSelfHabit[];
  derivations: readonly AgentSelfDerivation[];
}> {
  const byKey = new Map(initial.map((habit) => [habit.key, habit]));
  const seenRequirementTexts = new Map<string, string>();
  const currentRecords = new Map(records
    .filter((record) => record.status === "current")
    .map((record) => [record.id, record]));
  const derivations: AgentSelfDerivation[] = [];
  for (const requirement of requirements) {
    if (requirement.status !== "current") continue;
    let key: string;
    try {
      key = stableSelfKey(requirement.text);
    } catch {
      throw new Error("legacy_personality_requirement_invalid");
    }
    const seenText = seenRequirementTexts.get(key);
    if (seenText !== undefined && seenText !== requirement.text) {
      throw new Error("legacy_personality_requirement_conflict");
    }
    const existing = byKey.get(key);
    if (existing && existing.text !== requirement.text) {
      throw new Error("legacy_personality_requirement_conflict");
    }
    if (seenText !== undefined || existing) continue;
    seenRequirementTexts.set(key, requirement.text);

    const sources = legacyRequirementSources(requirement, currentRecords);
    const supported = requirement.basis === "explicit_memory"
      ? sources.length >= 1
      : new Set(sources.map((source) => source.contextId)).size >= 2;
    if (!supported) continue;

    byKey.set(key, Object.freeze({ key, text: requirement.text }));
    derivations.push(Object.freeze({
      target: `habit:${key}`,
      operation: "habit_add",
      basis: requirement.basis === "explicit_memory" ? "explicit" : "inferred",
      sources,
      previousValue: null,
      currentValue: requirement.text,
      updatedAt: now
    }));
  }
  return Object.freeze({
    habits: Object.freeze([...byKey.values()]),
    derivations: Object.freeze(derivations)
  });
}

function importLegacyProjectionRequirements(
  initial: readonly AgentSelfHabit[],
  requirements: readonly Readonly<{
    text: string;
    basis: "explicit_memory" | "observed_memory";
    status: "current" | "superseded";
    sourceMemoryIds: readonly string[];
  }>[],
  records: readonly PersonalMemoryRecord[],
  now: number
): Readonly<{
  habits: readonly AgentSelfHabit[];
  derivations: readonly AgentSelfDerivation[];
}> {
  type RequirementGroup = {
    key: string;
    text: string;
    explicitSourceMemoryIds: string[];
    observedSourceMemoryIds: string[];
  };

  const matchedRequirementTexts = new Map<string, string>();
  const groups = new Map<string, RequirementGroup>();
  for (const requirement of requirements) {
    let key: string;
    try {
      key = stableSelfKey(requirement.text);
    } catch {
      throw new Error("legacy_personality_requirement_invalid");
    }
    const matchedText = matchedRequirementTexts.get(key);
    if (matchedText !== undefined && matchedText !== requirement.text) {
      throw new Error("legacy_personality_requirement_conflict");
    }
    matchedRequirementTexts.set(key, requirement.text);
    if (requirement.status !== "current") continue;
    const existing = groups.get(key);
    if (existing && existing.text !== requirement.text) {
      throw new Error("legacy_personality_requirement_conflict");
    }
    const group = existing ?? {
      key,
      text: requirement.text,
      explicitSourceMemoryIds: [],
      observedSourceMemoryIds: []
    };
    const target = requirement.basis === "explicit_memory"
      ? group.explicitSourceMemoryIds
      : group.observedSourceMemoryIds;
    target.push(...requirement.sourceMemoryIds);
    if (!existing) groups.set(key, group);
  }

  const currentRecords = new Map(records
    .filter((record) => record.status === "current")
    .map((record) => [record.id, record]));
  const habits: AgentSelfHabit[] = [];
  const derivations: AgentSelfDerivation[] = [];
  const processedKeys = new Set<string>();

  const importGroup = (
    group: RequirementGroup,
    initialHabit: AgentSelfHabit | null
  ): void => {
    if (initialHabit && initialHabit.text !== group.text) {
      throw new Error("legacy_personality_requirement_conflict");
    }
    const explicitSources = legacyRequirementSources({
      basis: "explicit_memory",
      sourceMemoryIds: group.explicitSourceMemoryIds
    }, currentRecords);
    const observedSources = explicitSources.length > 0
      ? []
      : legacyRequirementSources({
          basis: "observed_memory",
          sourceMemoryIds: group.observedSourceMemoryIds
        }, currentRecords);
    const basis = explicitSources.length > 0
      ? "explicit"
      : observedSources.length >= 2
        ? "inferred"
        : null;
    if (!basis) return;
    const sources = basis === "explicit" ? explicitSources : observedSources;
    habits.push(initialHabit ?? Object.freeze({ key: group.key, text: group.text }));
    derivations.push(Object.freeze({
      target: `habit:${group.key}`,
      operation: "habit_add",
      basis,
      sources,
      previousValue: null,
      currentValue: group.text,
      updatedAt: now
    }));
  };

  for (const habit of initial) {
    const group = groups.get(habit.key);
    if (!group) {
      const matchedText = matchedRequirementTexts.get(habit.key);
      if (matchedText !== undefined) {
        if (matchedText !== habit.text) {
          throw new Error("legacy_personality_requirement_conflict");
        }
        continue;
      }
      habits.push(habit);
      continue;
    }
    processedKeys.add(habit.key);
    importGroup(group, habit);
  }
  for (const group of groups.values()) {
    if (processedKeys.has(group.key)) continue;
    importGroup(group, null);
  }

  return Object.freeze({
    habits: Object.freeze(habits),
    derivations: Object.freeze(derivations)
  });
}

function legacyRequirementSources(
  requirement: Readonly<{
    basis: "explicit_memory" | "observed_memory";
    sourceMemoryIds: readonly string[];
  }>,
  currentRecords: ReadonlyMap<string, PersonalMemoryRecord>
): readonly AgentSelfDerivationSource[] {
  const sources: AgentSelfDerivationSource[] = [];
  const seenMemoryIds = new Set<string>();
  const seenContexts = new Set<string>();
  for (const memoryId of requirement.sourceMemoryIds) {
    if (seenMemoryIds.has(memoryId)) continue;
    seenMemoryIds.add(memoryId);
    const record = currentRecords.get(memoryId);
    if (!record) continue;
    const group = memorySourceGroup(record.source, record.id);
    if (requirement.basis === "observed_memory") {
      if (!group.independentContext || seenContexts.has(group.contextId)) continue;
      seenContexts.add(group.contextId);
    }
    sources.push(Object.freeze({
      kind: "memory",
      id: record.id,
      revision: record.revision,
      contextId: group.contextId,
      evidence: legacyRequirementEvidence(record.content)
    }));
    if (sources.length >= 32) break;
  }
  return Object.freeze(sources);
}

function legacyRequirementEvidence(content: string): string {
  return content.trim().replace(/\s+/gu, " ").slice(0, 1_000).trim();
}

function templateStyleName(templateId: AgentTemplateId | null): string {
  return getAgentTemplate(templateId)?.labelZh ?? "尚未选择";
}

function templatePreferredSkillNames(template: AgentTemplate | null): readonly string[] {
  if (!template) return Object.freeze([]);
  return Object.freeze(template.preferredSkillIds.map((skillId) => {
    const skill = BUILTIN_SKILLS.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error(`agent_profile_unknown_builtin_skill:${skillId}`);
    return skill.title;
  }));
}

function agentProjectionHash(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
