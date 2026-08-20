import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  PERSONAL_MEMORY_SCHEMA,
  SECONDARY_MEMORY_SCHEMA,
  type PersonalMemoryBasis,
  type PersonalMemoryContentOrigin,
  type PersonalMemoryKind,
  type PersonalMemoryRecord,
  type PersonalMemoryRuntimeContext,
  type PersonalMemorySearchItem,
  type PersonalMemorySearchRequest,
  type PersonalMemorySearchResult,
  type PersonalMemoryStatus,
  type PersonalMemoryWriteRequest,
  type PersonalMemoryWriteResult,
  type SecondaryMatchView,
  type SecondaryMemoryRecord
} from "./personal-memory-contracts";
import { applySecondaryHit, indexableSecondaryRecords, serializeSecondaryRecord } from "./secondary-memory-store";
import {
  buildSearchIndexV3,
  indexChecksum,
  lexicalTokens,
  scorePrimaryEntry,
  scoreSecondaryEntry,
  type BuildIndexCatalogInput,
  type SearchCatalogEntryV3,
  type SearchIndexV3,
  type SecondaryCatalogEntry
} from "./search-index-v3";

const MAX_PROFILE_CHARS = 16_000;
const MAX_OVERVIEW_CHARS = 20_000;
const MAX_RECORD_CONTENT_CHARS = 24_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_CURSOR_CHARS = 4_096;
const GENERATED_OVERVIEW_SENTINEL = "这是有上限的当前导航；完整内容按需通过 memory_search / memory_read 读取。";
const SAFE_ID = /^[a-zA-Z0-9_-]{3,96}$/u;
const MUTATION_AUDIT_TYPES = new Set([
  "created",
  "superseded",
  "closed",
  "profile_updated",
  "forgotten"
]);
const MAINTENANCE_AUDIT_TYPES = new Set([
  "identity_file_updated",
  "exported",
  "forget_restored",
  "source_deleted",
  "runtime_rebuilt_from_markdown",
  "external_markdown_reconciled",
  "cognitive_update",
  "secondary_memory_updated"
]);
const mutationLanes = new Map<string, Promise<unknown>>();

export interface PersonalMemoryRepositoryOptions {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Test-only crash seam: leaves the prepared transaction for startup recovery. */
  readonly failTransactionAfterChange?: (operation: string, appliedChanges: number) => boolean;
  /**
   * Optional provider of current secondary (二级事实) records so Search Index v3
   * can fold them into the derived index. Cognitive system wires this in
   * production; tests may inject fixtures. Defaults to no secondary records.
   */
  readonly secondaryRecordsProvider?: () => Promise<readonly SecondaryMemoryRecord[]>;
  /**
   * Lifecycle hook keeping secondary facts in sync with supersede / forget /
   * restore / close. Returns the full secondary record list after the change
   * plus the files that must be written inside the same transaction.
   */
  readonly secondaryLifecycle?: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>;
  /** Fired after a create/supersede/restore transaction commits (dream queue). */
  readonly onMemoryCommitted?: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void;
}

export interface PersonalMemoryRecallRuntimeContext {
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly memoryMode: "normal";
}

export interface PersonalMemoryLayout {
  readonly root: string;
  readonly agent: string;
  readonly sharedUser: string;
  readonly user: string;
  readonly memory: string;
  readonly history: string;
  readonly facts: string;
  readonly views: string;
  readonly decisions: string;
  readonly active: string;
  readonly episodes: string;
  readonly runtime: string;
  readonly manifest: string;
  readonly searchIndex: string;
  readonly audit: string;
  readonly sourceMap: string;
  readonly transactions: string;
  readonly backups: string;
  readonly secondary: string;
  readonly personalityState: string;
  readonly userProfileState: string;
  readonly dreamState: string;
}

export interface PersonalMemoryAuditObservation {
  readonly lineNumber: number;
  readonly type: string;
  readonly revision: number;
  readonly at: number;
  readonly productRunId: string;
  readonly toolCallId?: string;
}

export type PersonalMemoryAuditInspection =
  | Readonly<{
      status: "complete";
      events: readonly Readonly<PersonalMemoryAuditObservation>[];
    }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid"; invalidLine?: number }>;

interface ManifestRecord extends Omit<PersonalMemoryRecord, "content"> {
  readonly contentHash?: string;
}

interface PersonalMemoryFixedFileHashes {
  readonly agent: string;
  readonly user: string;
}

interface PersonalMemoryTombstone {
  readonly recordId: string;
  readonly forgottenAt: number;
  readonly reason: string;
  readonly backupFile: string;
  readonly source: string;
}

interface PersonalMemoryManifest {
  readonly schemaVersion: 1;
  readonly vaultId: string;
  revision: number;
  records: ManifestRecord[];
  tombstones: PersonalMemoryTombstone[];
  updatedAt: number;
  fixedFileHashes?: PersonalMemoryFixedFileHashes;
}

type SearchCatalogEntry = SearchCatalogEntryV3;

export interface PersonalMemoryTurnSnapshot {
  readonly revision: number;
  readonly scanned: number;
  readonly agent: string;
  readonly user: string;
  readonly memory: string | null;
  readonly injectionKeys: readonly string[];
  readonly search: Readonly<PersonalMemoryTurnSearchResult> | null;
}

export type PersonalMemoryTurnCatalogCandidate = Pick<PersonalMemorySearchItem,
  "id" | "kind" | "status" | "title" | "recallWhen" | "summary" | "date" | "basis" | "sourceSummary" | "scope" | "score"
> & Readonly<{
  /**
   * 该一级记忆命中查询的全部二级事实（Recall PRD §12）：预算选择必须
   * 按「一级候选 + 这些二级事实」的最终注入形态计算 Token。
   */
  secondaryMatches?: readonly SecondaryMatchView[];
}>;

export interface PersonalMemoryTurnSearchResult {
  readonly revision: number;
  readonly total: number;
  readonly returned: number;
  readonly remaining: number;
  readonly exhausted: boolean;
  readonly items: readonly Readonly<PersonalMemorySearchItem>[];
  /** Secondary facts that decisively pulled their parent into the candidates. */
  readonly pendingSecondaryHits: readonly Readonly<{ secondaryId: string; parentId: string }>[];
}

type SearchIndex = SearchIndexV3;

interface SourceMapFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sources: Readonly<Record<string, readonly string[]>>;
}

interface TransactionChange {
  readonly relativePath: string;
  readonly content?: string;
}

interface TransactionPlanEntry {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupFile?: string;
}

interface TransactionPlan {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly operation: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
  readonly entries: readonly TransactionPlanEntry[];
}

export class PersonalMemoryAccessError extends Error {
  constructor(
    readonly code:
      | "vault_mismatch"
      | "no_memory"
      | "learning_disabled"
      | "invalid_request"
      | "not_found"
      | "revision_conflict"
      | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "PersonalMemoryAccessError";
  }
}

export class PersonalMemoryRepository {
  readonly layout: PersonalMemoryLayout;
  private readonly vaultPath: string;
  private readonly vaultId: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly failTransactionAfterChange?: (operation: string, appliedChanges: number) => boolean;
  private initializationFingerprint: string | null = null;
  private secondaryCache: readonly SecondaryMemoryRecord[] = [];
  private readonly secondaryRecordsProvider?: () => Promise<readonly SecondaryMemoryRecord[]>;
  private secondaryLifecycleHook?: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>;
  private onMemoryCommittedHook?: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void;
  private secondaryChangedHook?: (records: readonly SecondaryMemoryRecord[]) => void;

  constructor(options: Readonly<PersonalMemoryRepositoryOptions>) {
    this.vaultPath = path.resolve(options.vaultPath);
    this.vaultId = cleanRequired(options.vaultId, "vaultId", 256);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `mem_${randomUUID().replaceAll("-", "")}`);
    this.failTransactionAfterChange = options.failTransactionAfterChange;
    this.secondaryRecordsProvider = options.secondaryRecordsProvider;
    this.secondaryLifecycleHook = options.secondaryLifecycle;
    this.onMemoryCommittedHook = options.onMemoryCommitted;
    const root = path.join(this.vaultPath, ".echoink");
    const sharedUser = path.join(root, "shared-user");
    const history = path.join(sharedUser, "memory");
    const runtime = path.join(sharedUser, ".runtime");
    this.layout = Object.freeze({
      root,
      agent: path.join(root, "agents", "echoink", "AGENT.md"),
      sharedUser,
      user: path.join(sharedUser, "USER.md"),
      memory: path.join(sharedUser, "MEMORY.md"),
      history,
      facts: path.join(history, "facts"),
      views: path.join(history, "views"),
      decisions: path.join(history, "decisions"),
      active: path.join(history, "active"),
      episodes: path.join(history, "episodes"),
      runtime,
      manifest: path.join(runtime, "manifest.json"),
      searchIndex: path.join(runtime, "search-index.json"),
      audit: path.join(runtime, "audit.jsonl"),
      sourceMap: path.join(runtime, "source-map.json"),
      transactions: path.join(runtime, "transactions"),
      backups: path.join(runtime, "backups"),
      secondary: path.join(history, "secondary"),
      personalityState: path.join(root, "agents", "echoink", "personality-state.json"),
      userProfileState: path.join(sharedUser, "user-profile-state.json"),
      dreamState: path.join(runtime, "dream-state.json")
    });
    for (const key of Object.keys(this.layout) as Array<keyof PersonalMemoryLayout>) {
      this.assertManagedPath(this.layout[key]);
    }
  }

  async initialize(): Promise<Readonly<PersonalMemoryLayout>> {
    await mkdir(this.vaultPath, { recursive: true });
    for (const component of [
      this.layout.root,
      path.join(this.layout.root, "agents"),
      path.dirname(this.layout.agent),
      this.layout.sharedUser,
      this.layout.history,
      this.layout.runtime
    ]) {
      await this.assertNotSymlink(component);
    }
    for (const directory of [
      path.dirname(this.layout.agent),
      this.layout.sharedUser,
      this.layout.facts,
      this.layout.views,
      this.layout.decisions,
      this.layout.active,
      this.layout.episodes,
      this.layout.secondary,
      this.layout.runtime,
      this.layout.transactions,
      this.layout.backups
    ]) {
      await this.assertNotSymlink(directory);
      await mkdir(directory, { recursive: true });
    }
    await this.assertManagedTreeSafe();
    await this.recoverPendingTransactions();
    await writeIfMissing(this.layout.agent, defaultAgentProfile());
    await writeIfMissing(this.layout.user, defaultUserProfile());
    await writeIfMissing(this.layout.memory, defaultMemoryOverview());
    await writeIfMissing(this.layout.audit, "");
    if (this.secondaryRecordsProvider) {
      this.secondaryCache = [...(await this.secondaryRecordsProvider())];
    }
    await this.assertManagedTreeSafe();
    const fingerprint = await this.captureInitializationFingerprint();
    if (fingerprint === this.initializationFingerprint) return this.layout;
    await this.reconcileMarkdownTruth();
    this.initializationFingerprint = await this.captureInitializationFingerprint();
    return this.layout;
  }

  async loadFixedContext(input: Readonly<{
    memoryMode: "normal" | "no_memory";
  }>): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: string | null;
    injectionKeys: readonly string[];
  }>> {
    if (input.memoryMode === "no_memory") return await this.loadIdentityOnlyContext();
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      return await this.loadFixedContextSnapshot(manifest, input.memoryMode);
    });
  }

  /**
   * Loads one immutable turn snapshot after a single initialization pass.
   * Fixed files, the v2 catalog, ranking, and selected record reads are all
   * bound to the same manifest revision inside the repository mutation lane.
   */
  async prepareTurnSnapshot(
    input: Readonly<{
      memoryMode: "normal" | "no_memory";
      query?: string;
      selectCandidateIds?(
        candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
      ): readonly string[];
    }>,
    runtime?: Readonly<PersonalMemoryRecallRuntimeContext>
  ): Promise<Readonly<PersonalMemoryTurnSnapshot>> {
    if (input.memoryMode === "no_memory") return await this.loadIdentityOnlyTurnSnapshot();
    if (input.memoryMode === "normal") {
      if (!runtime) {
        throw new PersonalMemoryAccessError("invalid_request", "Personal Memory turn runtime is required");
      }
      this.assertRecallRuntime(runtime);
    }
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const fixed = await this.loadFixedContextSnapshot(manifest, input.memoryMode);
      const index = await this.readSearchIndexSnapshot(manifest);
      const search = await this.prepareTurnSearchSnapshot(
        input.query ?? "",
        manifest,
        index,
        input.selectCandidateIds
      );
      return Object.freeze({ ...fixed, scanned: index.catalog.length, search });
    });
  }

  /** Reads and validates only the manifest identity; it never exposes Memory content. */
  async readVaultId(): Promise<string> {
    return (await this.readManifest()).vaultId;
  }

  /**
   * Reads only linkage metadata from audit.jsonl. It never returns Memory
   * content, Tool payloads, queries, exception text, or source URLs.
   */
  async readAuditByProductRun(
    productRunId: string
  ): Promise<readonly Readonly<PersonalMemoryAuditObservation>[]> {
    const inspection = await this.inspectAuditByProductRun(productRunId);
    if (inspection.status === "missing") {
      throw new Error("personal_memory_audit_missing");
    }
    if (inspection.status === "invalid") {
      throw new Error(
        inspection.invalidLine === undefined
          ? "personal_memory_audit_invalid"
          : `personal_memory_audit_invalid_line_${inspection.invalidLine}`
      );
    }
    return inspection.events;
  }

  async inspectAuditByProductRun(
    productRunId: string
  ): Promise<PersonalMemoryAuditInspection> {
    const expected = cleanRequired(productRunId, "productRunId", 512);
    const observations: PersonalMemoryAuditObservation[] = [];
    let text: string;
    try {
      text = await readFile(this.layout.audit, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({ status: "invalid" as const });
    }
    const lines = text.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        const event = parsed as Record<string, unknown>;
        const eventType = typeof event.type === "string" ? event.type : "";
        const mutation = MUTATION_AUDIT_TYPES.has(eventType);
        const maintenance = MAINTENANCE_AUDIT_TYPES.has(eventType);
        if (
          !eventType.trim()
          || eventType.length > 160
          || (!mutation && !maintenance)
          || !Number.isSafeInteger(event.revision)
          || (event.revision as number) < 0
          || !Number.isSafeInteger(event.at)
          || (event.at as number) < 0
          || (mutation && event.source === undefined)
          || (
            event.source !== undefined
            && !(
              typeof event.source === "string"
              && event.source.trim()
              && event.source.length <= 2_000
            )
          )
          || (
            event.toolCallId !== undefined
            && !(
              typeof event.toolCallId === "string"
              && event.toolCallId.trim()
              && event.toolCallId.length <= 512
            )
          )
        ) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        const sourceProductRunId = typeof event.source === "string"
          ? productRunIdFromRuntimeSource(event.source)
          : null;
        if (event.toolCallId !== undefined && sourceProductRunId === null) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        if (sourceProductRunId !== expected) continue;
        const toolCallId = typeof event.toolCallId === "string"
          ? event.toolCallId
          : undefined;
        observations.push(Object.freeze({
          lineNumber: index + 1,
          type: eventType,
          revision: event.revision as number,
          at: event.at as number,
          productRunId: expected,
          ...(toolCallId ? { toolCallId } : {})
        }));
      } catch {
        return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
      }
    }
    return Object.freeze({
      status: "complete" as const,
      events: Object.freeze(observations)
    });
  }

  async write(
    request: PersonalMemoryWriteRequest,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    this.assertRuntime(runtime, true);
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, request.expectedRevision);
      if (request.operation === "profile_update") {
        await this.assertFixedFilesMatchManifest(manifest);
      }
      const records = await this.readAllRecords(manifest);
      switch (request.operation) {
        case "create":
          return await this.createRecord(manifest, records, request, runtime);
        case "supersede":
          return await this.supersedeRecord(manifest, records, request, runtime);
        case "close":
          return await this.closeRecord(manifest, records, request, runtime);
        case "profile_update":
          return await this.updateUserProfile(manifest, records, request, runtime);
        case "forget":
          return await this.forgetRecord(manifest, records, request, runtime);
      }
    });
  }

  async search(
    request: Readonly<PersonalMemorySearchRequest>,
    runtime: Readonly<PersonalMemoryRuntimeContext>,
    options: Readonly<{ maxResultChars?: number }> = {}
  ): Promise<Readonly<PersonalMemorySearchResult>> {
    this.assertRuntime(runtime, false);
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const index = await this.readSearchIndexSnapshot(manifest);
      return await this.searchSnapshot(request, manifest, index, options);
    });
  }

  private async searchSnapshot(
    request: Readonly<PersonalMemorySearchRequest>,
    manifest: PersonalMemoryManifest,
    index: Readonly<SearchIndex>,
    options: Readonly<{ maxResultChars?: number }> = {}
  ): Promise<Readonly<PersonalMemorySearchResult>> {
    const query = cleanOptional(request.query, "query", 2_000) ?? "";
    const queryTokens = lexicalTokens(query);
    const queryTokenSet = new Set(queryTokens);
    const secondaryBest = bestSecondaryScores(index, query, queryTokenSet);
    const normalizedStatuses = [...new Set(request.statuses ?? ["current"])].sort(compareText);
    const normalizedKinds = request.kinds
      ? [...new Set(request.kinds)].sort(compareText)
      : [];
    const statuses = new Set(normalizedStatuses);
    const kinds = normalizedKinds.length ? new Set(normalizedKinds) : null;
    const scope = request.scope?.trim().toLocaleLowerCase();
    const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, request.limit ?? 12));
    const fingerprint = contentHash(stableJson({
      query: query.normalize("NFKC").toLocaleLowerCase(),
      kinds: normalizedKinds,
      scope: scope ?? null,
      statuses: normalizedStatuses,
      from: request.from ?? null,
      to: request.to ?? null
    }));
    const offset = request.cursor
      ? decodeSearchCursor(request.cursor, manifest.revision, fingerprint)
      : 0;
    const ranked = index.catalog
      .filter((record) => statuses.has(record.status))
      .filter((record) => !kinds || kinds.has(record.kind))
      .filter((record) => !scope || record.scope?.toLocaleLowerCase() === scope)
      .filter((record) => !request.from || record.date >= request.from)
      .filter((record) => !request.to || record.date <= request.to)
      .map((record) => {
        const primaryScore = scorePrimaryEntry(record, query, queryTokenSet);
        const secondary = secondaryBest.get(record.id);
        return {
          record,
          primaryScore,
          secondary,
          score: primaryScore + (secondary?.score ?? 0)
        };
      })
      .filter((entry) => queryTokens.length === 0 || entry.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      );
    if (offset > ranked.length) {
      throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor offset is invalid");
    }
    const selected = ranked.slice(offset, offset + limit);
    const metadataById = new Map(manifest.records.map((record) => [record.id, record]));
    const items = await Promise.all(selected.map(async ({ record, score, secondary }) => {
      const metadata = metadataById.get(record.id);
      if (!metadata) {
        throw new PersonalMemoryAccessError("invalid_request", "memory_search index contains an unavailable record");
      }
      const full = await this.readRecord(metadata);
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        status: record.status,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: summarize(full.content),
        date: record.date,
        basis: record.basis,
        sourceSummary: record.sourceSummary,
        ...(record.scope ? { scope: record.scope } : {}),
        score,
        ...(secondary ? { matchedSecondaryId: secondary.entry.id } : {})
      });
    }));
    const total = ranked.length;
    let returned = items.length;
    const maxResultChars = options.maxResultChars ?? Number.POSITIVE_INFINITY;
    const resultFor = (count: number): PersonalMemorySearchResult => {
      const remaining = total - offset - count;
      return Object.freeze({
        revision: manifest.revision,
        total,
        returned: count,
        remaining,
        exhausted: remaining === 0,
        nextCursor: remaining === 0
          ? null
          : encodeSearchCursor(manifest.revision, fingerprint, offset + count),
        items: Object.freeze(items.slice(0, count))
      });
    };
    while (returned > 1 && JSON.stringify(resultFor(returned)).length > maxResultChars) {
      returned -= 1;
    }
    const result = resultFor(returned);
    if (JSON.stringify(result).length > maxResultChars) {
      throw new PersonalMemoryAccessError("invalid_request", "memory_search result budget is too small");
    }
    return result;
  }

  private async prepareTurnSearchSnapshot(
    rawQuery: string,
    manifest: PersonalMemoryManifest,
    index: Readonly<SearchIndex>,
    selectCandidateIds: ((
      candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
    ) => readonly string[]) | undefined
  ): Promise<Readonly<PersonalMemoryTurnSearchResult>> {
    const query = cleanOptional(rawQuery, "query", 2_000) ?? "";
    const queryTokens = lexicalTokens(query);
    const queryTokenSet = new Set(queryTokens);
    const secondaryBest = bestSecondaryScores(index, query, queryTokenSet);
    const secondaryMatches = groupSecondaryMatches(index, query, queryTokenSet);
    const ranked = index.catalog
      .filter((record) => record.status === "current")
      .map((record) => {
        const primaryScore = scorePrimaryEntry(record, query, queryTokenSet);
        const secondary = secondaryBest.get(record.id);
        return {
          record,
          primaryScore,
          secondary,
          score: primaryScore + (secondary?.score ?? 0)
        };
      })
      .filter((entry) => queryTokens.length === 0 || entry.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      );
    const catalogCandidates = Object.freeze(ranked.map(({ record, score }) => {
      const matches = secondaryMatches.get(record.id);
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        status: record.status,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: record.summary,
        date: record.date,
        basis: record.basis,
        sourceSummary: record.sourceSummary,
        ...(record.scope ? { scope: record.scope } : {}),
        score,
        ...(matches && matches.length > 0
          ? { secondaryMatches: Object.freeze(matches.map(toSecondaryMatchView)) }
          : {})
      });
    }));
    const requestedIds = selectCandidateIds
      ? [...selectCandidateIds(catalogCandidates)]
      : catalogCandidates.slice(0, MAX_SEARCH_LIMIT).map((candidate) => candidate.id);
    const rankedById = new Map(ranked.map((entry) => [entry.record.id, entry]));
    const selectedIds = new Set<string>();
    for (const id of requestedIds) {
      if (selectedIds.has(id) || !rankedById.has(id)) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn candidate selection is invalid"
        );
      }
      selectedIds.add(id);
    }
    // A secondary match counts as "decisive" when its parent would NOT have
    // made the candidate set on primary-memory scores alone. Simulate that set:
    // rank EVERY current catalog entry by primary score (score > 0 required)
    // and keep the same candidate count as this turn requested.
    const cutoff = requestedIds.length;
    const primaryOnlyCandidateSet = new Set(index.catalog
      .filter((record) => record.status === "current")
      .map((record) => ({
        id: record.id,
        date: record.date,
        primaryScore: scorePrimaryEntry(record, query, queryTokenSet)
      }))
      .filter((entry) => queryTokens.length === 0 || entry.primaryScore > 0)
      .sort((left, right) =>
        right.primaryScore - left.primaryScore
        || right.date.localeCompare(left.date)
        || left.id.localeCompare(right.id)
      )
      .slice(0, cutoff)
      .map((entry) => entry.id));
    const pendingSecondaryHits: Array<Readonly<{ secondaryId: string; parentId: string }>> = [];
    const decisiveSecondaryId = new Map<string, string>();
    for (const id of requestedIds) {
      const entry = rankedById.get(id)!;
      if (!entry.secondary) continue;
      if (!primaryOnlyCandidateSet.has(id)) {
        decisiveSecondaryId.set(id, entry.secondary.entry.id);
        pendingSecondaryHits.push(Object.freeze({ secondaryId: entry.secondary.entry.id, parentId: id }));
      }
    }
    const metadataById = new Map(manifest.records.map((record) => [record.id, record]));
    const items = await Promise.all(requestedIds.map(async (id) => {
      const rankedEntry = rankedById.get(id)!;
      const metadata = metadataById.get(id);
      if (!metadata) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn index contains an unavailable record"
        );
      }
      const full = await this.readRecord(metadata);
      const record = rankedEntry.record;
      const matched = secondaryMatches.get(id) ?? [];
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        status: record.status,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: summarize(full.content),
        date: record.date,
        basis: record.basis,
        sourceSummary: record.sourceSummary,
        ...(record.scope ? { scope: record.scope } : {}),
        score: rankedEntry.score,
        ...(decisiveSecondaryId.has(id) ? { matchedSecondaryId: decisiveSecondaryId.get(id)! } : {}),
        ...(matched.length > 0 ? { secondaryMatches: Object.freeze(matched.map(toSecondaryMatchView)) } : {})
      });
    }));
    const total = ranked.length;
    const returned = items.length;
    return Object.freeze({
      revision: manifest.revision,
      total,
      returned,
      remaining: total - returned,
      exhausted: returned === total,
      items: Object.freeze(items),
      pendingSecondaryHits: Object.freeze(pendingSecondaryHits)
    });
  }

  private async loadIdentityOnlyTurnSnapshot(): Promise<Readonly<PersonalMemoryTurnSnapshot>> {
    const fixed = await this.loadIdentityOnlyContext();
    return Object.freeze({ ...fixed, scanned: 0, search: null });
  }

  private async loadIdentityOnlyContext(): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: null;
    injectionKeys: readonly string[];
  }>> {
    return await this.withMutation(async () => {
      await mkdir(this.vaultPath, { recursive: true });
      for (const directory of [
        this.layout.root,
        path.join(this.layout.root, "agents"),
        path.dirname(this.layout.agent),
        this.layout.sharedUser
      ]) {
        await this.assertNotSymlink(directory);
        await mkdir(directory, { recursive: true });
      }
      for (const file of [this.layout.agent, this.layout.user]) {
        await this.assertNotSymlink(file);
      }
      await writeIfMissing(this.layout.agent, defaultAgentProfile());
      await writeIfMissing(this.layout.user, defaultUserProfile());
      await this.assertIdentityPathsSafe();
      const [agent, user] = await Promise.all([
        readBounded(this.layout.agent, MAX_PROFILE_CHARS, "AGENT.md"),
        readBounded(this.layout.user, MAX_PROFILE_CHARS, "USER.md")
      ]);
      return Object.freeze({
        revision: 0,
        agent,
        user,
        memory: null,
        injectionKeys: Object.freeze(["echoink.agent", "echoink.user"])
      });
    });
  }

  private async loadFixedContextSnapshot(
    manifest: PersonalMemoryManifest,
    memoryMode: "normal" | "no_memory"
  ): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: string | null;
    injectionKeys: readonly string[];
  }>> {
    const [agent, user, memory] = await Promise.all([
      readBounded(this.layout.agent, MAX_PROFILE_CHARS, "AGENT.md"),
      readBounded(this.layout.user, MAX_PROFILE_CHARS, "USER.md"),
      memoryMode === "normal"
        ? readBounded(this.layout.memory, MAX_OVERVIEW_CHARS, "MEMORY.md")
        : Promise.resolve(null)
    ]);
    if (
      !validFixedFileHashes(manifest.fixedFileHashes)
      || manifest.fixedFileHashes.agent !== contentHash(agent)
      || manifest.fixedFileHashes.user !== contentHash(user)
      || (
        memory !== null
        && (
          parseGeneratedOverviewRevision(memory) !== manifest.revision
          || memory !== renderOverview(manifest, manifest.records)
        )
      )
    ) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "Personal Memory fixed context changed during snapshot loading"
      );
    }
    return Object.freeze({
      revision: manifest.revision,
      agent,
      user,
      memory,
      injectionKeys: Object.freeze([
        "echoink.agent",
        "echoink.user",
        ...(memory === null ? [] : ["echoink.memory.overview"])
      ])
    });
  }

  /** Replace the secondary records snapshot used for Search Index v3 building. */
  setSecondaryRecords(records: readonly SecondaryMemoryRecord[]): void {
    this.secondaryCache = [...records];
  }

  /** Current secondary records snapshot (cognitive system wiring). */
  currentSecondaryRecords(): readonly SecondaryMemoryRecord[] {
    return this.secondaryCache;
  }

  /**
   * Commit one cognitive update (dream result / personality template / user
   * correction) in a single transaction: secondary files, state JSONs and
   * AGENT.md / USER.md projections land together with the manifest revision
   * and the derived Search Index v3.
   */
  async applyCognitiveUpdate(input: Readonly<{
    agentContent?: string;
    userContent?: string;
    secondaryRecords: readonly SecondaryMemoryRecord[];
    /** content === undefined deletes the file inside the transaction. */
    extraChanges: readonly Readonly<{ relativePath: string; content?: string }>[];
    detail: string;
  }>): Promise<Readonly<{ revision: number }>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      await this.assertFixedFilesMatchManifest(manifest);
      const records = await this.readAllRecords(manifest);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      const extra: TransactionChange[] = [...input.extraChanges];
      if (input.agentContent !== undefined) {
        const normalized = input.agentContent.endsWith("\n") ? input.agentContent : `${input.agentContent}\n`;
        next.fixedFileHashes = {
          ...(next.fixedFileHashes ?? { agent: "", user: "" }),
          agent: contentHash(normalized)
        };
        extra.push({ relativePath: path.relative(this.layout.root, this.layout.agent), content: normalized });
      }
      if (input.userContent !== undefined) {
        const normalized = input.userContent.endsWith("\n") ? input.userContent : `${input.userContent}\n`;
        next.fixedFileHashes = {
          ...(next.fixedFileHashes ?? { agent: "", user: "" }),
          user: contentHash(normalized)
        };
        extra.push({ relativePath: path.relative(this.layout.root, this.layout.user), content: normalized });
      }
      // 事务成功前不改缓存：用局部快照构造索引与事务内容。
      const changes = await this.stateChanges(next, records, extra, {
        type: "cognitive_update",
        revision: targetRevision,
        at: this.now(),
        detail: cleanOptional(input.detail, "detail", 500) ?? ""
      }, input.secondaryRecords);
      await this.runTransaction("cognitive-update", manifest.revision, targetRevision, changes);
      this.commitSecondaryCache(input.secondaryRecords);
      return Object.freeze({ revision: targetRevision });
    });
  }

  /**
   * Record hit stats on secondary facts that decisively pulled their parent
   * into recall candidates (做梦 PRD §11)：confidence += 0.05（上限 1）、
   * hitCount += 1、更新 lastHitAt、增加二级事实自身 revision；保存必须走
   * Repository 事务，不允许直接裸写文件。
   */
  async recordSecondaryRecallHits(
    hits: readonly Readonly<{ secondaryId: string; parentId: string }>[]
  ): Promise<void> {
    if (hits.length === 0) return;
    await this.initialize();
    await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const now = this.now();
      const cache = [...this.secondaryCache];
      const updatedRecords: SecondaryMemoryRecord[] = [];
      for (const hit of hits) {
        const position = cache.findIndex(
          (record) => record.id === hit.secondaryId && record.status === "current"
        );
        if (position < 0) continue;
        const updated = applySecondaryHit(cache[position], now);
        cache[position] = updated;
        updatedRecords.push(updated);
      }
      if (updatedRecords.length === 0) return;
      // 与 applyCognitiveUpdate 相同的单事务提交（不能嵌套 withMutation）。
      const manifest = await this.readManifest();
      await this.assertFixedFilesMatchManifest(manifest);
      const records = await this.readAllRecords(manifest);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = now;
      const changes = await this.stateChanges(next, records, updatedRecords.map((record) => ({
        relativePath: record.file,
        content: serializeSecondaryRecord(record)
      })), {
        type: "cognitive_update",
        revision: targetRevision,
        at: now,
        detail: `secondary-recall-hits:${updatedRecords.length}`
      }, cache);
      await this.runTransaction("cognitive-update", manifest.revision, targetRevision, changes);
      this.commitSecondaryCache(cache);
    });
  }

  /** Rebuild the derived Search Index v3 when the secondary snapshot drifted. */
  async ensureSecondaryIndexFresh(): Promise<void> {
    await this.initialize();
    await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const records = await this.readAllRecords(manifest);
      const expected = buildSearchIndexV3(
        manifest.revision,
        records.map((record) => this.catalogInput(record)),
        indexableSecondaryRecords(this.secondaryCache)
      );
      const raw = await readJsonOrNull<Record<string, unknown>>(this.layout.searchIndex);
      if (raw && (raw as { checksum?: unknown }).checksum === expected.checksum) return;
      await atomicWrite(this.layout.searchIndex, jsonText(expected));
    });
  }

  private catalogInput(record: PersonalMemoryRecord): BuildIndexCatalogInput {
    return Object.freeze({
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      recallWhen: record.recallWhen,
      date: record.date,
      basis: record.basis,
      sourceSummary: summarizeSource(record.source),
      summary: summarize(record.content),
      ...(record.scope ? { scope: record.scope } : {}),
      content: record.content
    });
  }

  /** Attach/replace the secondary lifecycle handler after construction. */
  setSecondaryLifecycleHandler(handler: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>): void {
    this.secondaryLifecycleHook = handler;
  }

  /**
   * Fired synchronously AFTER a committed transaction changed secondary
   * records, carrying the committed records（双缓存一致性：调用方用它同步
   * setCache，不做 fire-and-forget 异步刷新）。
   */
  setSecondaryChangedHook(hook: (records: readonly SecondaryMemoryRecord[]) => void): void {
    this.secondaryChangedHook = hook;
  }

  /** Attach/replace the memory-committed hook (dream pending queue). */
  setMemoryCommittedHook(hook: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void): void {
    this.onMemoryCommittedHook = hook;
  }

  /**
   * 事务成功后同步两份缓存（Repository.secondaryCache 与 SecondaryMemoryStore
   * 经由 hook）；事务失败时任何缓存都不得改变。
   */
  private commitSecondaryCache(records: readonly SecondaryMemoryRecord[]): void {
    this.secondaryCache = [...records];
    try {
      this.secondaryChangedHook?.(Object.freeze([...records]));
    } catch { /* never break the writer */ }
  }

  private async applySecondaryLifecycle(
    operation: "supersede" | "forget" | "restore" | "close",
    parentId: string
  ): Promise<Readonly<{
    files: readonly Readonly<{ relativePath: string; content: string }>[];
    records: readonly SecondaryMemoryRecord[];
  }>> {
    if (!this.secondaryLifecycleHook) {
      return Object.freeze({ files: Object.freeze([]), records: this.secondaryCache });
    }
    const result = await this.secondaryLifecycleHook({ operation, parentId });
    // 事务提交前不得改缓存；records 由调用方在 runTransaction 成功后提交。
    return Object.freeze({ files: result.changedFiles, records: result.records });
  }

  private notifyMemoryCommitted(
    operation: "create" | "supersede" | "restore",
    recordId: string,
    revision: number
  ): void {
    try {
      this.onMemoryCommittedHook?.({ operation, recordId, revision });
    } catch {
      // Dream queueing must never break the write result.
    }
  }

  async read(
    id: string,
    runtime: Readonly<PersonalMemoryRuntimeContext>,
    options: Readonly<{ includeHistorical?: boolean }> = {}
  ): Promise<Readonly<{ revision: number; record: PersonalMemoryRecord }>> {
    this.assertRuntime(runtime, false);
    const safeId = assertSafeId(id);
    await this.initialize();
    const manifest = await this.readManifest();
    const metadata = manifest.records.find((record) => record.id === safeId);
    if (!metadata || (!options.includeHistorical && metadata.status !== "current")) {
      throw new PersonalMemoryAccessError("not_found", `Memory ${safeId} is unavailable`);
    }
    return Object.freeze({
      revision: manifest.revision,
      record: await this.readRecord(metadata)
    });
  }

  async inspect(): Promise<Readonly<{
    revision: number;
    records: readonly PersonalMemoryRecord[];
    tombstones: readonly PersonalMemoryTombstone[];
    backups: readonly string[];
  }>> {
    await this.initialize();
    const manifest = await this.readManifest();
    return Object.freeze({
      revision: manifest.revision,
      records: Object.freeze(await this.readAllRecords(manifest)),
      tombstones: Object.freeze(manifest.tombstones.map((item) => Object.freeze({ ...item }))),
      backups: Object.freeze(await listFilesRecursively(this.layout.backups))
    });
  }

  async readUserControlState(): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: string;
    records: readonly PersonalMemoryRecord[];
    forgottenIds: readonly string[];
  }>> {
    await this.initialize();
    const [manifest, agent, user, memory] = await Promise.all([
      this.readManifest(),
      readBounded(this.layout.agent, MAX_PROFILE_CHARS, "AGENT.md"),
      readBounded(this.layout.user, MAX_PROFILE_CHARS, "USER.md"),
      readBounded(this.layout.memory, MAX_OVERVIEW_CHARS, "MEMORY.md")
    ]);
    const activeRecordIds = new Set(manifest.records.map((item) => item.id));
    return Object.freeze({
      revision: manifest.revision,
      agent,
      user,
      memory,
      records: Object.freeze(await this.readAllRecords(manifest)),
      forgottenIds: Object.freeze([...new Set(manifest.tombstones
        .map((item) => item.recordId)
        .filter((id) => !activeRecordIds.has(id)))])
    });
  }

  async updateIdentityFile(
    profile: "agent" | "user",
    contentValue: string,
    expectedRevision: number
  ): Promise<Readonly<{ revision: number; profile: "agent" | "user" }>> {
    const content = cleanRequired(contentValue, `${profile} profile`, MAX_PROFILE_CHARS);
    const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      await this.assertFixedFilesMatchManifest(manifest);
      const records = await this.readAllRecords(manifest);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      next.fixedFileHashes = {
        ...manifest.fixedFileHashes!,
        [profile]: contentHash(normalizedContent)
      };
      const changes = await this.stateChanges(next, records, [{
        relativePath: path.relative(
          this.layout.root,
          profile === "agent" ? this.layout.agent : this.layout.user
        ),
        content: normalizedContent
      }], {
        type: "identity_file_updated",
        revision: targetRevision,
        at: this.now(),
        profile,
        source: "ui://personal-memory-control"
      });
      await this.runTransaction(`identity-${profile}`, manifest.revision, targetRevision, changes);
      return Object.freeze({ revision: targetRevision, profile });
    });
  }

  async forgetFromUserControl(
    recordId: string,
    reason: string,
    expectedRevision: number
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      const records = await this.readAllRecords(manifest);
      return await this.forgetRecordWithSource(
        manifest,
        records,
        recordId,
        reason,
        "ui://personal-memory-control"
      );
    });
  }

  async supersedeFromUserCorrection(input: Readonly<{
    targetId: string;
    title: string;
    content: string;
    recallWhen: string;
    reason: string;
    expectedRevision: number;
  }>): Promise<Readonly<PersonalMemoryWriteResult>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, input.expectedRevision);
      const records = await this.readAllRecords(manifest);
      const targetId = assertSafeId(input.targetId);
      const previous = records.find((record) =>
        record.id === targetId && record.status === "current"
      );
      if (!previous) {
        throw new PersonalMemoryAccessError(
          "not_found",
          `Current Memory ${targetId} does not exist`
        );
      }
      return await this.supersedeRecordWithSource(
        manifest,
        records,
        {
          operation: "supersede",
          targetId,
          title: input.title,
          content: input.content,
          recallWhen: input.recallWhen,
          basis: "explicit",
          contentOrigin: "user_edit",
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          ...(previous.scope ? { scope: previous.scope } : {}),
          ...(previous.asOf ? { asOf: previous.asOf } : {}),
          ...(previous.due ? { due: previous.due } : {}),
          ...(previous.remindAt ? { remindAt: previous.remindAt } : {})
        },
        "ui://personal-memory-correction",
        Object.freeze({}),
        true
      );
    });
  }

  async exportMemory(): Promise<Readonly<{ path: string; revision: number }>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      const records = await this.readAllRecords(manifest);
      const timestamp = new Date(this.now()).toISOString().replaceAll(/[:.]/gu, "-");
      const relativePath = path.posix.join("shared-user", ".runtime", "backups", "exports", `memory-export-${timestamp}.md`);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      const exportText = renderExport(records, targetRevision);
      const changes = await this.stateChanges(next, records, [{ relativePath, content: exportText }], {
        type: "exported",
        revision: targetRevision,
        at: this.now(),
        detail: relativePath
      });
      await this.runTransaction("export", manifest.revision, targetRevision, changes);
      return Object.freeze({ path: this.absoluteFromRelative(relativePath), revision: targetRevision });
    });
  }

  async restoreForgotten(
    recordId: string,
    expectedRevision?: number
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const safeId = assertSafeId(recordId);
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      if (manifest.records.some((record) => record.id === safeId)) {
        throw new PersonalMemoryAccessError("revision_conflict", `Memory ${safeId} already exists`);
      }
      const tombstone = [...manifest.tombstones].reverse().find((item) => item.recordId === safeId);
      if (!tombstone) throw new PersonalMemoryAccessError("not_found", `Forgotten Memory ${safeId} has no backup`);
      const backupPath = this.absoluteFromRelative(tombstone.backupFile);
      const backupText = await readFile(backupPath, "utf8");
      const temporary = parseRecord(backupText, tombstone.backupFile);
      const targetRevision = manifest.revision + 1;
      const restored: PersonalMemoryRecord = Object.freeze({
        ...temporary,
        revision: targetRevision,
        file: recordRelativePath(temporary.kind, temporary.id)
      });
      const records = await this.readAllRecords(manifest);
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      next.records.push(recordMetadata(restored));
      next.records.sort((a, b) => a.id.localeCompare(b.id));
      next.tombstones = next.tombstones.filter((item) =>
        item.recordId !== tombstone.recordId || item.backupFile !== tombstone.backupFile
      );
      const allRecords = [...records, restored];
      const lifecycle = await this.applySecondaryLifecycle("restore", safeId);
      const changes = await this.stateChanges(next, allRecords, [{
        relativePath: restored.file,
        content: serializeRecord(restored)
      }, ...lifecycle.files], {
        type: "forget_restored",
        revision: targetRevision,
        at: this.now(),
        recordId: safeId,
        backupFile: tombstone.backupFile
      }, lifecycle.records);
      await this.runTransaction("restore-forgotten", manifest.revision, targetRevision, changes);
      this.commitSecondaryCache(lifecycle.records);
      this.notifyMemoryCommitted("restore", restored.id, targetRevision);
      return Object.freeze({ revision: targetRevision, record: restored });
    });
  }

  async listManagedFiles(): Promise<readonly string[]> {
    await this.initialize();
    await this.assertManagedTreeSafe();
    const files = [
      ...(await listFilesRecursively(path.dirname(this.layout.agent))),
      ...(await listFilesRecursively(this.layout.sharedUser))
    ];
    return Object.freeze(files
      .map((file) => path.relative(this.vaultPath, file))
      .sort(compareText));
  }

  private async createRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "create" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    validateWriteContent(request.kind, request.basis, request.contentOrigin, runtime.explicitlyAuthorized === true);
    const targetRevision = manifest.revision + 1;
    const record = this.newRecord({ ...request, targetRevision, source: runtimeSource(runtime) });
    if (manifest.records.some((item) => item.id === record.id)) {
      throw new PersonalMemoryAccessError("revision_conflict", `Memory id ${record.id} already exists`);
    }
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records.push(recordMetadata(record));
    const allRecords = [...records, record];
    const changes = await this.stateChanges(next, allRecords, [{ relativePath: record.file, content: serializeRecord(record) }], {
      type: "created",
      revision: targetRevision,
      at: this.now(),
      recordId: record.id,
      source: record.source,
      ...runtimeAuditLink(runtime)
    });
    await this.runTransaction("create", manifest.revision, targetRevision, changes);
    this.notifyMemoryCommitted("create", record.id, targetRevision);
    return Object.freeze({ revision: targetRevision, record });
  }

  private async supersedeRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "supersede" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    return await this.supersedeRecordWithSource(
      manifest,
      records,
      request,
      runtimeSource(runtime),
      runtimeAuditLink(runtime),
      runtime.explicitlyAuthorized === true
    );
  }

  private async supersedeRecordWithSource(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "supersede" }>,
    source: string,
    auditLink: Readonly<{ toolCallId?: string }>,
    explicitlyAuthorized: boolean
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(request.targetId);
    const previous = records.find((record) => record.id === targetId && record.status === "current");
    if (!previous) throw new PersonalMemoryAccessError("not_found", `Current Memory ${targetId} does not exist`);
    validateWriteContent(previous.kind, request.basis, request.contentOrigin, explicitlyAuthorized);
    const targetRevision = manifest.revision + 1;
    const superseded: PersonalMemoryRecord = Object.freeze({
      ...previous,
      status: "superseded",
      reason: cleanRequired(request.reason, "reason", 2_000),
      revision: targetRevision
    });
    const replacement = this.newRecord({
      ...request,
      kind: previous.kind,
      targetRevision,
      source,
      supersedes: previous.id
    });
    const allRecords = records.map((record) => record.id === previous.id ? superseded : record).concat(replacement);
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = allRecords.map(recordMetadata);
    const lifecycle = await this.applySecondaryLifecycle("supersede", previous.id);
    const changes = await this.stateChanges(next, allRecords, [
      { relativePath: superseded.file, content: serializeRecord(superseded) },
      { relativePath: replacement.file, content: serializeRecord(replacement) },
      ...lifecycle.files
    ], {
      type: "superseded",
      revision: targetRevision,
      at: this.now(),
      recordId: replacement.id,
      targetId: previous.id,
      source: replacement.source,
      ...auditLink
    }, lifecycle.records);
    await this.runTransaction("supersede", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    this.notifyMemoryCommitted("supersede", replacement.id, targetRevision);
    return Object.freeze({ revision: targetRevision, record: replacement });
  }

  private async closeRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "close" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(request.targetId);
    const previous = records.find((record) => record.id === targetId && record.status === "current");
    if (!previous) throw new PersonalMemoryAccessError("not_found", `Current Memory ${targetId} does not exist`);
    const targetRevision = manifest.revision + 1;
    const closed: PersonalMemoryRecord = Object.freeze({
      ...previous,
      status: "closed",
      reason: cleanRequired(request.reason, "reason", 2_000),
      revision: targetRevision
    });
    const allRecords = records.map((record) => record.id === targetId ? closed : record);
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = allRecords.map(recordMetadata);
    const lifecycle = await this.applySecondaryLifecycle("close", targetId);
    const changes = await this.stateChanges(next, allRecords, [{ relativePath: closed.file, content: serializeRecord(closed) }, ...lifecycle.files], {
      type: "closed",
      revision: targetRevision,
      at: this.now(),
      recordId: targetId,
      source: runtimeSource(runtime),
      ...runtimeAuditLink(runtime)
    }, lifecycle.records);
    await this.runTransaction("close", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    return Object.freeze({ revision: targetRevision, record: closed });
  }

  private async updateUserProfile(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "profile_update" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const origin = request.contentOrigin ?? "confirmed_change";
    if (!["user_edit", "user_statement", "confirmed_change"].includes(origin)) {
      throw new PersonalMemoryAccessError("invalid_request", "USER.md requires an explicit stable user update");
    }
    const content = cleanRequired(request.content, "profile content", MAX_PROFILE_CHARS);
    const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
    const targetRevision = manifest.revision + 1;
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.fixedFileHashes = {
      agent: manifest.fixedFileHashes!.agent,
      user: contentHash(normalizedContent)
    };
    const changes = await this.stateChanges(next, records, [{
      relativePath: path.relative(this.layout.root, this.layout.user),
      content: normalizedContent
    }], {
      type: "profile_updated",
      revision: targetRevision,
      at: this.now(),
      profile: "user",
      source: runtimeSource(runtime),
      ...runtimeAuditLink(runtime)
    });
    await this.runTransaction("profile-update", manifest.revision, targetRevision, changes);
    return Object.freeze({ revision: targetRevision, profile: "user" });
  }

  private async forgetRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "forget" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    if (!request.explicitForget || runtime.explicitlyAuthorized !== true) {
      throw new PersonalMemoryAccessError("invalid_request", "Forget requires explicit user authorization");
    }
    return await this.forgetRecordWithSource(
      manifest,
      records,
      request.targetId,
      request.reason,
      runtimeSource(runtime),
      runtime.toolCallId
    );
  }

  private async forgetRecordWithSource(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    recordId: string,
    reason: string,
    source: string,
    toolCallId?: string
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(recordId);
    const target = records.find((record) => record.id === targetId);
    if (!target) throw new PersonalMemoryAccessError("not_found", `Memory ${targetId} does not exist`);
    const targetRevision = manifest.revision + 1;
    const backupFile = path.posix.join(
      "shared-user", ".runtime", "backups", "forgets",
      `${target.id}-${this.now()}.md`
    );
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = next.records.filter((record) => record.id !== targetId);
    next.tombstones.push({
      recordId: target.id,
      forgottenAt: this.now(),
      reason: cleanRequired(reason, "reason", 2_000),
      backupFile,
      source
    });
    const remaining = records.filter((record) => record.id !== targetId);
    const lifecycle = await this.applySecondaryLifecycle("forget", targetId);
    const changes = await this.stateChanges(next, remaining, [
      { relativePath: backupFile, content: serializeRecord(target) },
      { relativePath: target.file },
      ...lifecycle.files
    ], {
      type: "forgotten",
      revision: targetRevision,
      at: this.now(),
      recordId: targetId,
      source,
      ...(toolCallId
        ? { toolCallId: cleanRequired(toolCallId, "toolCallId", 512) }
        : {})
    });
    await this.runTransaction("forget", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    return Object.freeze({ revision: targetRevision, forgottenId: targetId });
  }

  private newRecord(input: Readonly<{
    kind: PersonalMemoryKind;
    title: string;
    content: string;
    recallWhen?: string;
    basis: PersonalMemoryBasis;
    targetRevision: number;
    source: string;
    scope?: string;
    asOf?: string;
    supersedes?: string;
    due?: string;
    remindAt?: string;
    reason?: string;
    contentOrigin?: PersonalMemoryContentOrigin;
  }>): PersonalMemoryRecord {
    const id = assertSafeId(this.idFactory());
    return Object.freeze({
      schema: PERSONAL_MEMORY_SCHEMA,
      id,
      kind: input.kind,
      status: "current",
      date: isoDate(this.now()),
      source: input.source,
      basis: input.basis,
      ...(input.contentOrigin ? { contentOrigin: input.contentOrigin } : {}),
      title: cleanRequired(input.title, "title", 200),
      recallWhen: cleanRequired(input.recallWhen ?? input.title, "recall_when", 500),
      content: cleanRequired(input.content, "content", MAX_RECORD_CONTENT_CHARS),
      ...(cleanOptional(input.scope, "scope", 240) ? { scope: cleanOptional(input.scope, "scope", 240)! } : {}),
      ...(input.asOf ? { asOf: validateDate(input.asOf, "as_of") } : {}),
      ...(input.supersedes ? { supersedes: assertSafeId(input.supersedes) } : {}),
      ...(input.due ? { due: validateDateTime(input.due, "due") } : {}),
      ...(input.remindAt ? { remindAt: validateDateTime(input.remindAt, "remind_at") } : {}),
      ...(cleanOptional(input.reason, "reason", 2_000) ? { reason: cleanOptional(input.reason, "reason", 2_000)! } : {}),
      revision: input.targetRevision,
      file: recordRelativePath(input.kind, id)
    });
  }

  private async reconcileMarkdownTruth(): Promise<void> {
    await this.assertManagedTreeSafe();
    const [agent, user, markdownRecords, current] = await Promise.all([
      readBounded(this.layout.agent, MAX_PROFILE_CHARS, "AGENT.md"),
      readBounded(this.layout.user, MAX_PROFILE_CHARS, "USER.md"),
      this.readMarkdownRecords(),
      this.readManifestForReconciliation()
    ]);
    const fixedFileHashes: PersonalMemoryFixedFileHashes = Object.freeze({
      agent: contentHash(agent),
      user: contentHash(user)
    });

    if (!current) {
      const recovered = await this.reconstructRuntimeMetadata(markdownRecords);
      const hasExistingContent = markdownRecords.length > 0
        || agent !== defaultAgentProfile()
        || user !== defaultUserProfile()
        || recovered.tombstones.length > 0
        || recovered.maxAuditRevision > 0
        || recovered.maxOverviewRevision > 0;
      const revision = hasExistingContent
        ? Math.max(
            0,
            recovered.maxBackupRevision,
            recovered.maxAuditRevision,
            recovered.maxOverviewRevision,
            ...markdownRecords.map((record) => record.revision)
          ) + 1
        : 0;
      const manifest: PersonalMemoryManifest = {
        schemaVersion: 1,
        vaultId: this.vaultId,
        revision,
        records: markdownRecords.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id)),
        tombstones: recovered.tombstones,
        updatedAt: this.now(),
        fixedFileHashes
      };
      await atomicWrite(this.layout.manifest, jsonText(manifest));
      await atomicWrite(this.layout.searchIndex, jsonText(buildSearchIndexV3(manifest.revision, markdownRecords.map((record) => this.catalogInput(record)), indexableSecondaryRecords(this.secondaryCache))));
      await atomicWrite(this.layout.sourceMap, jsonText(buildSourceMap(manifest)));
      await atomicWrite(this.layout.memory, renderOverview(manifest, markdownRecords));
      if (hasExistingContent) {
        const audit = await readTextOrEmpty(this.layout.audit);
        await atomicWrite(this.layout.audit, `${audit}${JSON.stringify({
          type: "runtime_rebuilt_from_markdown",
          revision,
          at: this.now(),
          recordIds: markdownRecords.map((record) => record.id),
          recoveredTombstoneIds: recovered.tombstones.map((item) => item.recordId)
        })}\n`);
      }
      return;
    }

    const currentById = new Map(current.records.map((record) => [record.id, record]));
    const markdownById = new Map(markdownRecords.map((record) => [record.id, record]));
    const fixedHashesKnown = validFixedFileHashes(current.fixedFileHashes);
    const fixedChanged = fixedHashesKnown && (
      current.fixedFileHashes!.agent !== fixedFileHashes.agent
      || current.fixedFileHashes!.user !== fixedFileHashes.user
    );
    const recordsChanged = current.records.length !== markdownRecords.length
      || markdownRecords.some((record) => {
        const metadata = currentById.get(record.id);
        if (!metadata) return true;
        const observed = recordMetadata(record);
        return stableJson(recordMetadataWithoutHash(observed))
          !== stableJson(recordMetadataWithoutHash(normalizeManifestRecord(metadata)))
          || (typeof metadata.contentHash === "string"
            && metadata.contentHash !== observed.contentHash);
      });
    const requiresMetadataUpgrade = !fixedHashesKnown
      || current.records.some((record) =>
        typeof record.contentHash !== "string"
        || typeof record.recallWhen !== "string"
      );

    if (!fixedChanged && !recordsChanged) {
      const upgraded = cloneManifest(current);
      upgraded.records = markdownRecords.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id));
      upgraded.fixedFileHashes = fixedFileHashes;
      if (requiresMetadataUpgrade) {
        await atomicWrite(this.layout.manifest, jsonText(upgraded));
      }
      await this.repairDerivedFiles(upgraded, markdownRecords);
      return;
    }

    const targetRevision = current.revision + 1;
    const changedRecords: PersonalMemoryRecord[] = [];
    const reconciled = markdownRecords.map((record) => {
      const previous = currentById.get(record.id);
      const observed = recordMetadata(record);
      const unchanged = previous
        && stableJson(recordMetadataWithoutHash(normalizeManifestRecord(previous)))
          === stableJson(recordMetadataWithoutHash(observed))
        && previous.contentHash === observed.contentHash;
      if (unchanged) return record;
      const external: PersonalMemoryRecord = Object.freeze({
        ...record,
        source: `user-edit://personal-memory/${encodeURIComponent(record.file)}`,
        basis: "explicit",
        contentOrigin: "user_edit",
        revision: targetRevision
      });
      changedRecords.push(external);
      return external;
    });
    const next = cloneManifest(current);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.fixedFileHashes = fixedFileHashes;
    next.records = reconciled.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id));
    const deletedIds = current.records
      .map((record) => record.id)
      .filter((id) => !markdownById.has(id));
    const changes = await this.stateChanges(
      next,
      reconciled,
      changedRecords.map((record) => ({
        relativePath: record.file,
        content: serializeRecord(record)
      })),
      {
        type: "external_markdown_reconciled",
        revision: targetRevision,
        at: this.now(),
        fixedFilesChanged: fixedChanged,
        recordIds: changedRecords.map((record) => record.id),
        deletedIds
      }
    );
    await this.runTransaction(
      "external-markdown-reconcile",
      current.revision,
      targetRevision,
      changes
    );
  }

  private async reconstructRuntimeMetadata(
    markdownRecords: readonly PersonalMemoryRecord[]
  ): Promise<Readonly<{
    tombstones: PersonalMemoryTombstone[];
    maxBackupRevision: number;
    maxAuditRevision: number;
    maxOverviewRevision: number;
  }>> {
    const activeIds = new Set(markdownRecords.map((record) => record.id));
    const maxOverviewRevision = parseGeneratedOverviewRevision(
      await readTextOrEmpty(this.layout.memory)
    );
    const tombstones: PersonalMemoryTombstone[] = [];
    let maxBackupRevision = 0;
    for (const [directoryName, reason] of [
      ["forgets", "Recovered from validated forget backup"],
      ["source-deletions", "Recovered from validated source-deletion backup"]
    ] as const) {
      const directory = path.join(this.layout.backups, directoryName);
      for (const backupPath of await listFilesRecursively(directory)) {
        const name = path.basename(backupPath);
        const timestampMatch = name.match(/-(\d+)\.md$/u);
        if (!timestampMatch) continue;
        const forgottenAt = Number(timestampMatch[1]);
        if (!Number.isSafeInteger(forgottenAt) || forgottenAt <= 0) continue;
        const backupFile = path.relative(this.layout.root, backupPath)
          .split(path.sep)
          .join(path.posix.sep);
        let record: PersonalMemoryRecord;
        try {
          record = parseRecord(await readFile(backupPath, "utf8"), backupFile);
        } catch {
          continue;
        }
        if (name !== `${record.id}-${forgottenAt}.md`) continue;
        maxBackupRevision = Math.max(maxBackupRevision, record.revision);
        if (activeIds.has(record.id)) continue;
        tombstones.push({
          recordId: record.id,
          forgottenAt,
          reason,
          backupFile,
          source: record.source
        });
      }
    }
    tombstones.sort((left, right) =>
      left.forgottenAt - right.forgottenAt
      || left.backupFile.localeCompare(right.backupFile)
    );

    let maxAuditRevision = 0;
    for (const line of (await readTextOrEmpty(this.layout.audit)).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const event = parsed as Record<string, unknown>;
        if (
          typeof event.revision === "number"
          && Number.isSafeInteger(event.revision)
          && event.revision >= 0
        ) {
          maxAuditRevision = Math.max(maxAuditRevision, event.revision);
        }
      } catch {
        // A damaged audit line is not reconstruction evidence.
      }
    }
    return Object.freeze({
      tombstones,
      maxBackupRevision,
      maxAuditRevision,
      maxOverviewRevision
    });
  }

  private async readManifestForReconciliation(): Promise<PersonalMemoryManifest | null> {
    if (!(await pathExists(this.layout.manifest))) return null;
    let value: Partial<PersonalMemoryManifest>;
    try {
      value = JSON.parse(await readFile(this.layout.manifest, "utf8")) as Partial<PersonalMemoryManifest>;
    } catch {
      return null;
    }
    if (value.schemaVersion !== 1 || value.vaultId !== this.vaultId) {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "Personal Memory manifest belongs to another Vault or schema"
      );
    }
    if (
      !Number.isSafeInteger(value.revision)
      || !Array.isArray(value.records)
      || !Array.isArray(value.tombstones)
      || value.records.some((record) =>
        !record
        || typeof record !== "object"
        || typeof record.id !== "string"
        || typeof record.file !== "string"
      )
    ) return null;
    return value as PersonalMemoryManifest;
  }

  private async readMarkdownRecords(): Promise<PersonalMemoryRecord[]> {
    const records: PersonalMemoryRecord[] = [];
    const ids = new Set<string>();
    for (const directory of [
      this.layout.facts,
      this.layout.views,
      this.layout.decisions,
      this.layout.active,
      this.layout.episodes
    ]) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new PersonalMemoryAccessError("unsafe_path", `Memory record must not be a symlink: ${target}`);
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const relativePath = path.relative(this.layout.root, target).split(path.sep).join(path.posix.sep);
        const parsed = parseRecord(await readFile(target, "utf8"), relativePath);
        if (recordRelativePath(parsed.kind, parsed.id) !== relativePath) {
          throw new PersonalMemoryAccessError(
            "invalid_request",
            `Memory ${relativePath} does not match its id and kind`
          );
        }
        if (ids.has(parsed.id)) {
          throw new PersonalMemoryAccessError("invalid_request", `Memory id ${parsed.id} is duplicated`);
        }
        ids.add(parsed.id);
        records.push(parsed);
      }
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async captureInitializationFingerprint(): Promise<string> {
    const observations: string[] = [];
    const observe = async (target: string) => {
      if (!(await pathExists(target))) {
        observations.push(`${path.relative(this.layout.root, target)}:missing`);
        return;
      }
      const stat = await lstat(target, { bigint: true });
      observations.push([
        path.relative(this.layout.root, target),
        stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs
      ].join(":"));
    };
    for (const target of [
      this.layout.agent,
      this.layout.user,
      this.layout.memory,
      this.layout.manifest,
      this.layout.searchIndex,
      this.layout.sourceMap
    ]) await observe(target);
    for (const directory of [
      this.layout.facts,
      this.layout.views,
      this.layout.decisions,
      this.layout.active,
      this.layout.episodes
    ]) {
      await observe(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await observe(path.join(directory, entry.name));
      }
    }
    return contentHash(observations.join("\n"));
  }

  private async assertIdentityPathsSafe(): Promise<void> {
    const vaultStat = await lstat(this.vaultPath);
    if (vaultStat.isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", "Active Vault root must not be a symlink");
    }
    const vaultRealPath = await realpath(this.vaultPath);
    for (const target of [
      this.layout.root,
      path.join(this.layout.root, "agents"),
      path.dirname(this.layout.agent),
      this.layout.agent,
      this.layout.sharedUser,
      this.layout.user
    ]) {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        throw new PersonalMemoryAccessError(
          "unsafe_path",
          `Managed Memory identity path must not be a symlink: ${target}`
        );
      }
      const targetRealPath = await realpath(target);
      const relative = path.relative(vaultRealPath, targetRealPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new PersonalMemoryAccessError(
          "unsafe_path",
          "Managed Memory identity realpath escapes the active Vault"
        );
      }
    }
  }

  private async assertManagedTreeSafe(): Promise<void> {
    const vaultStat = await lstat(this.vaultPath);
    if (vaultStat.isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", "Active Vault root must not be a symlink");
    }
    const vaultRealPath = await realpath(this.vaultPath);
    const assertSafeNode = async (target: string) => {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        throw new PersonalMemoryAccessError("unsafe_path", `Managed Memory path must not be a symlink: ${target}`);
      }
      const targetRealPath = await realpath(target);
      const relative = path.relative(vaultRealPath, targetRealPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new PersonalMemoryAccessError("unsafe_path", "Managed Memory realpath escapes the active Vault");
      }
      return stat;
    };
    const visit = async (target: string): Promise<void> => {
      const stat = await assertSafeNode(target);
      if (!stat.isDirectory()) return;
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) await visit(path.join(target, entry.name));
    };
    for (const parent of [this.layout.root, path.join(this.layout.root, "agents")]) {
      if (await pathExists(parent)) await assertSafeNode(parent);
    }
    for (const managedRoot of [path.dirname(this.layout.agent), this.layout.sharedUser]) {
      if (await pathExists(managedRoot)) await visit(managedRoot);
    }
  }

  private async stateChanges(
    manifest: PersonalMemoryManifest,
    records: readonly PersonalMemoryRecord[],
    extra: readonly TransactionChange[],
    audit: Readonly<Record<string, unknown>>,
    secondaryForIndex?: readonly SecondaryMemoryRecord[]
  ): Promise<TransactionChange[]> {
    const secondarySnapshot = secondaryForIndex ?? this.secondaryCache;
    const previousAudit = await readTextOrEmpty(this.layout.audit);
    return dedupeChanges([
      ...extra,
      { relativePath: path.relative(this.layout.root, this.layout.manifest), content: jsonText(manifest) },
      { relativePath: path.relative(this.layout.root, this.layout.searchIndex), content: jsonText(buildSearchIndexV3(manifest.revision, records.map((record) => this.catalogInput(record)), indexableSecondaryRecords(secondarySnapshot))) },
      { relativePath: path.relative(this.layout.root, this.layout.sourceMap), content: jsonText(buildSourceMap(manifest)) },
      { relativePath: path.relative(this.layout.root, this.layout.memory), content: renderOverview(manifest, records) },
      {
        relativePath: path.relative(this.layout.root, this.layout.audit),
        content: `${previousAudit}${JSON.stringify(audit)}\n`
      }
    ]);
  }

  private async runTransaction(
    operation: string,
    baseRevision: number,
    targetRevision: number,
    changes: readonly TransactionChange[]
  ): Promise<void> {
    const transactionId = `txn_${randomUUID().replaceAll("-", "")}`;
    const transactionRoot = path.join(this.layout.transactions, transactionId);
    const backupRoot = path.join(transactionRoot, "backup");
    await mkdir(backupRoot, { recursive: true });
    const entries: TransactionPlanEntry[] = [];
    for (const [index, change] of changes.entries()) {
      const target = this.absoluteFromRelative(change.relativePath);
      const existed = await pathExists(target);
      if (existed) {
        const backupFile = path.join("backup", `${index}.bak`);
        await copyFile(target, path.join(transactionRoot, backupFile));
        entries.push({ relativePath: change.relativePath, existed: true, backupFile });
      } else {
        entries.push({ relativePath: change.relativePath, existed: false });
      }
    }
    const plan: TransactionPlan = {
      schemaVersion: 1,
      transactionId,
      operation,
      baseRevision,
      targetRevision,
      entries
    };
    await atomicWrite(path.join(transactionRoot, "plan.json"), jsonText(plan));
    await atomicWrite(path.join(transactionRoot, "state"), "applying\n");
    let simulatedCrash = false;
    try {
      let appliedChanges = 0;
      for (const change of changes) {
        const target = this.absoluteFromRelative(change.relativePath);
        if (change.content === undefined) {
          if (await pathExists(target)) await unlink(target);
        } else {
          await atomicWrite(target, change.content);
        }
        appliedChanges += 1;
        if (this.failTransactionAfterChange?.(operation, appliedChanges)) {
          simulatedCrash = true;
          throw new Error("personal_memory_simulated_crash");
        }
      }
      await atomicWrite(path.join(transactionRoot, "state"), "committed\n");
      await rm(transactionRoot, { recursive: true, force: true });
    } catch (error) {
      if (!simulatedCrash) await this.rollbackTransaction(transactionRoot, plan);
      throw error;
    }
  }

  private async recoverPendingTransactions(): Promise<void> {
    if (!(await pathExists(this.layout.transactions))) return;
    const entries = await readdir(this.layout.transactions, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transactionRoot = path.join(this.layout.transactions, entry.name);
      const planPath = path.join(transactionRoot, "plan.json");
      if (!(await pathExists(planPath))) {
        await rm(transactionRoot, { recursive: true, force: true });
        continue;
      }
      const plan = JSON.parse(await readFile(planPath, "utf8")) as TransactionPlan;
      const state = (await readTextOrEmpty(path.join(transactionRoot, "state"))).trim();
      if (state === "committed") {
        await rm(transactionRoot, { recursive: true, force: true });
      } else {
        await this.rollbackTransaction(transactionRoot, plan);
      }
    }
  }

  private async rollbackTransaction(transactionRoot: string, plan: TransactionPlan): Promise<void> {
    for (const entry of [...plan.entries].reverse()) {
      const target = this.absoluteFromRelative(entry.relativePath);
      if (entry.existed && entry.backupFile) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(transactionRoot, entry.backupFile), target);
      } else if (await pathExists(target)) {
        await unlink(target);
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }

  private async repairDerivedFiles(manifest: PersonalMemoryManifest, records: readonly PersonalMemoryRecord[]): Promise<void> {
    const index = await readJsonOrNull<SearchIndex>(this.layout.searchIndex);
    const sourceMap = await readJsonOrNull<SourceMapFile>(this.layout.sourceMap);
    const expectedIndex = buildSearchIndexV3(manifest.revision, records.map((record) => this.catalogInput(record)), indexableSecondaryRecords(this.secondaryCache));
    const expectedSourceMap = buildSourceMap(manifest);
    if (!index || stableJson(index) !== stableJson(expectedIndex)) {
      await atomicWrite(this.layout.searchIndex, jsonText(expectedIndex));
    }
    if (!sourceMap || stableJson(sourceMap) !== stableJson(expectedSourceMap)) {
      await atomicWrite(this.layout.sourceMap, jsonText(expectedSourceMap));
    }
  }

  private async readSearchIndexSnapshot(
    manifest: PersonalMemoryManifest
  ): Promise<Readonly<SearchIndex>> {
    const raw = await readJsonOrNull<Record<string, unknown>>(this.layout.searchIndex);
    const index = raw as unknown as SearchIndex | null;
    const needsRebuild = !index
      || index.schemaVersion !== 3
      || index.revision !== manifest.revision
      || !isArrayValue(index.catalog)
      || !isArrayValue(index.secondaryCatalog)
      || !isArrayValue(index.secondaryIndex)
      || index.catalog.some((record) =>
        !Array.isArray(record.routeTokens)
        || !Array.isArray(record.contentTokens)
        || typeof record.summary !== "string"
      )
      || typeof index.checksum !== "string"
      || index.checksum !== indexChecksum(
        index.revision,
        index.catalog as SearchCatalogEntry[],
        index.secondaryCatalog,
        index.secondaryIndex
      );
    if (needsRebuild) {
      // v2 (and stale/corrupt v3) indexes are derived artifacts: rebuild as v3.
      return await this.rebuildSearchIndexForManifest(manifest);
    }
    const manifestIds = new Set(manifest.records.map((record) => record.id));
    if (
      index.catalog.length !== manifestIds.size
      || index.catalog.some((record) => !manifestIds.has(record.id))
      || index.secondaryCatalog.some((entry) => !manifestIds.has(entry.parentId))
    ) {
      return await this.rebuildSearchIndexForManifest(manifest);
    }
    return Object.freeze({
      ...index,
      catalog: Object.freeze(index.catalog.map((record) => Object.freeze({
        ...record,
        routeTokens: Object.freeze([...record.routeTokens]),
        contentTokens: Object.freeze([...record.contentTokens])
      }))),
      secondaryCatalog: Object.freeze(index.secondaryCatalog.map((entry) => Object.freeze({
        ...entry,
        matchTerms: Object.freeze([...entry.matchTerms]),
        routeTokens: Object.freeze([...entry.routeTokens]),
        contentTokens: Object.freeze([...entry.contentTokens])
      }))),
      secondaryIndex: Object.freeze(index.secondaryIndex.map((entry) => Object.freeze({ ...entry })))
    });
  }

  private async rebuildSearchIndexForManifest(
    manifest: PersonalMemoryManifest
  ): Promise<Readonly<SearchIndex>> {
    const records = await this.readAllRecords(manifest);
    const rebuilt = buildSearchIndexV3(
      manifest.revision,
      records.map((record) => this.catalogInput(record)),
      indexableSecondaryRecords(this.secondaryCache)
    );
    await atomicWrite(this.layout.searchIndex, jsonText(rebuilt));
    return rebuilt;
  }

  private async readManifest(): Promise<PersonalMemoryManifest> {
    const value = JSON.parse(await readFile(this.layout.manifest, "utf8")) as Partial<PersonalMemoryManifest>;
    if (value.schemaVersion !== 1 || value.vaultId !== this.vaultId || !Number.isSafeInteger(value.revision)) {
      throw new PersonalMemoryAccessError("invalid_request", "Personal Memory manifest is invalid or belongs to another Vault");
    }
    if (!Array.isArray(value.records) || !Array.isArray(value.tombstones)) {
      throw new PersonalMemoryAccessError("invalid_request", "Personal Memory manifest collections are invalid");
    }
    return {
      ...value,
      records: value.records.map((record) => normalizeManifestRecord(record))
    } as PersonalMemoryManifest;
  }

  private async readAllRecords(manifest: PersonalMemoryManifest): Promise<PersonalMemoryRecord[]> {
    const records = await Promise.all(manifest.records.map(async (record) => await this.readRecord(record)));
    records.sort((a, b) => a.id.localeCompare(b.id));
    return records;
  }

  private async readRecord(metadata: ManifestRecord): Promise<PersonalMemoryRecord> {
    const target = this.absoluteFromRelative(metadata.file);
    const parsed = parseRecord(await readFile(target, "utf8"), metadata.file);
    if (stableJson(recordMetadata(parsed)) !== stableJson(metadata)) {
      throw new PersonalMemoryAccessError("invalid_request", `Memory metadata drift detected for ${metadata.id}`);
    }
    return parsed;
  }

  private async assertFixedFilesMatchManifest(manifest: PersonalMemoryManifest): Promise<void> {
    if (!validFixedFileHashes(manifest.fixedFileHashes)) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "Identity file hashes are unavailable; reload before writing"
      );
    }
    const [agent, user] = await Promise.all([
      readBounded(this.layout.agent, MAX_PROFILE_CHARS, "AGENT.md"),
      readBounded(this.layout.user, MAX_PROFILE_CHARS, "USER.md")
    ]);
    if (
      contentHash(agent) !== manifest.fixedFileHashes.agent
      || contentHash(user) !== manifest.fixedFileHashes.user
    ) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "AGENT.md or USER.md changed after initialization; reload before writing"
      );
    }
  }

  private assertRuntime(runtime: Readonly<PersonalMemoryRuntimeContext>, writing: boolean): void {
    if (runtime.vaultId !== this.vaultId) {
      throw new PersonalMemoryAccessError("vault_mismatch", "Memory access is bound to another Vault");
    }
    for (const [name, value] of Object.entries({
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId,
      userEntryId: runtime.userEntryId
    })) cleanRequired(value, name, 512);
    if (runtime.memoryMode === "no_memory") {
      throw new PersonalMemoryAccessError("no_memory", "Historical Memory is disabled for this Conversation");
    }
    if (writing && !runtime.learningEnabled) {
      throw new PersonalMemoryAccessError("learning_disabled", "Long-term Memory learning is read-only");
    }
  }

  private assertRecallRuntime(runtime: Readonly<PersonalMemoryRecallRuntimeContext>): void {
    if (runtime.vaultId !== this.vaultId) {
      throw new PersonalMemoryAccessError("vault_mismatch", "Memory access is bound to another Vault");
    }
    for (const [name, value] of Object.entries({
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    })) cleanRequired(value, name, 512);
    if (runtime.memoryMode !== "normal") {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "Personal Memory Recall runtime must use normal mode"
      );
    }
  }

  private assertManagedPath(target: string): void {
    const relative = path.relative(this.vaultPath, path.resolve(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Managed Memory path escapes the active Vault");
    }
  }

  private absoluteFromRelative(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Memory relative path is invalid");
    }
    const target = path.resolve(this.layout.root, relativePath);
    const relative = path.relative(this.layout.root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Memory path escapes .echoink");
    }
    return target;
  }

  private async assertNotSymlink(target: string): Promise<void> {
    if (!(await pathExists(target))) return;
    if ((await lstat(target)).isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", `Managed Memory directory must not be a symlink: ${target}`);
    }
  }

  private async withMutation<T>(callback: () => Promise<T>): Promise<T> {
    const previous = mutationLanes.get(this.layout.root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    mutationLanes.set(this.layout.root, current);
    try {
      return await current;
    } finally {
      if (mutationLanes.get(this.layout.root) === current) mutationLanes.delete(this.layout.root);
    }
  }
}

function cloneManifest(manifest: PersonalMemoryManifest): PersonalMemoryManifest {
  return structuredClone(manifest);
}

export function defaultAgentProfile(): string {
  return [
    "# EchoInk Agent",
    "",
    "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。",
    "",
    "## 人格",
    "",
    "- 真诚、冷静、有主见，温和但不含糊。",
    "- 忠于事实、用户的长期目标和更好的结果；不以迎合用户或证明自己正确为目标。",
    "- 尊重用户的最终决定，同时保留独立判断。",
    "",
    "## 合作方式",
    "",
    "- 先理解当前目标，再决定是否需要历史。",
    "- 形成重要建议前，检查关键前提、相关经验、反例和信息时效。",
    "- 发现会影响结果的目标冲突或历史冲突时，先核对当前场景，再提醒、追问、纠正或反对。",
    "",
    "## 表达",
    "",
    "- 先给结论，再给依据、风险和下一步。",
    "- 语言自然、具体、克制；不奉承、不含糊、不抬杠。",
    "- 有证据时才提醒、纠正或反对；不确定时明确说明。",
    ""
  ].join("\n");
}

export function defaultUserProfile(): string {
  return [
    "# USER",
    "",
    "这里保存用户明确确认的当前稳定画像与合作方式。",
    "",
    "- 尚无已确认内容。",
    ""
  ].join("\n");
}

function defaultMemoryOverview(): string {
  return [
    "# Memory",
    "",
    "这里是长期 Memory 的有界 Overview。详细历史按需通过 Memory Tool 读取。",
    "",
    "- facts/",
    "- views/",
    "- decisions/",
    "- active/",
    "- episodes/",
    ""
  ].join("\n");
}

function renderOverview(
  manifest: PersonalMemoryManifest,
  records: readonly Readonly<Pick<
    PersonalMemoryRecord,
    "id" | "kind" | "status" | "title" | "date" | "basis"
  >>[]
): string {
  const current = records.filter((record) => record.status === "current");
  const groups: Array<readonly [string, readonly PersonalMemoryKind[]]> = [
    ["Facts", ["fact"]],
    ["Views", ["view"]],
    ["Decisions", ["decision"]],
    ["Active", ["goal", "task", "open_loop"]],
    ["Episodes", ["episode"]]
  ];
  const lines = [
    "# Memory",
    "",
    `Revision: ${manifest.revision}`,
    "",
    GENERATED_OVERVIEW_SENTINEL,
    ""
  ];
  for (const [heading, kinds] of groups) {
    lines.push(`## ${heading}`, "");
    const matches = current
      .filter((record) => kinds.includes(record.kind))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 8);
    if (!matches.length) lines.push("- 暂无");
    else for (const record of matches) lines.push(`- ${record.title}（${record.date}，${record.basis}，${record.id}）`);
    lines.push("");
  }
  return `${lines.join("\n").slice(0, MAX_OVERVIEW_CHARS - 1)}\n`;
}

function parseGeneratedOverviewRevision(
  value: string
): number {
  const lines = value.split("\n");
  if (
    lines[0] !== "# Memory"
    || lines[1] !== ""
    || lines[3] !== ""
    || lines[4] !== GENERATED_OVERVIEW_SENTINEL
    || lines[5] !== ""
  ) return 0;
  const revisionLines = lines.filter((line) => line.startsWith("Revision:"));
  if (revisionLines.length !== 1 || revisionLines[0] !== lines[2]) return 0;
  const match = /^Revision: (0|[1-9]\d*)$/u.exec(lines[2] ?? "");
  if (!match) return 0;
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 0) return 0;
  return revision;
}

function renderExport(records: readonly PersonalMemoryRecord[], revision: number): string {
  const lines = ["# EchoInk Memory Export", "", `Revision: ${revision}`, ""];
  for (const record of [...records].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))) {
    lines.push(`## ${record.title}`, "", `- ID: ${record.id}`, `- Kind: ${record.kind}`, `- Status: ${record.status}`, `- Basis: ${record.basis}`, `- Date: ${record.date}`, `- Source: ${record.source}`, "", record.content, "");
  }
  return `${lines.join("\n")}\n`;
}

function serializeRecord(record: Readonly<PersonalMemoryRecord>): string {
  const fields: Array<readonly [string, string | number | undefined]> = [
    ["schema", record.schema],
    ["id", record.id],
    ["kind", record.kind],
    ["status", record.status],
    ["date", record.date],
    ["source", record.source],
    ["basis", record.basis],
    ["content_origin", record.contentOrigin],
    ["title", record.title],
    ["recall_when", record.recallWhen],
    ["scope", record.scope],
    ["as_of", record.asOf],
    ["supersedes", record.supersedes],
    ["due", record.due],
    ["remind_at", record.remindAt],
    ["reason", record.reason],
    ["revision", record.revision]
  ];
  return [
    "---",
    ...fields.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    record.content.trim(),
    ""
  ].join("\n");
}

function parseRecord(text: string, file: string): PersonalMemoryRecord {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} has no frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} frontmatter is incomplete`);
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} frontmatter line is invalid`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} frontmatter value is invalid`);
    }
  }
  const kind = fields.get("kind");
  const status = fields.get("status");
  const basis = fields.get("basis");
  if (!isMemoryKind(kind) || !isMemoryStatus(status) || !isMemoryBasis(basis)) {
    throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} enum field is invalid`);
  }
  const content = lines.slice(end + 1).join("\n").trim();
  const revision = fields.get("revision");
  if (!Number.isSafeInteger(revision)) throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} revision is invalid`);
  const title = cleanRequired(requiredField(fields, "title"), "title", 200);
  return Object.freeze({
    schema: requiredField(fields, "schema") === PERSONAL_MEMORY_SCHEMA ? PERSONAL_MEMORY_SCHEMA : invalidField(file, "schema"),
    id: assertSafeId(requiredField(fields, "id")),
    kind,
    status,
    date: validateDate(requiredField(fields, "date"), "date"),
    source: cleanRequired(requiredField(fields, "source"), "source", 2_000),
    basis,
    ...(optionalField(fields, "content_origin") ? { contentOrigin: requireContentOrigin(optionalField(fields, "content_origin")!) } : {}),
    title,
    recallWhen: optionalField(fields, "recall_when")
      ? cleanRequired(optionalField(fields, "recall_when")!, "recall_when", 500)
      : title,
    content: cleanRequired(content, "content", MAX_RECORD_CONTENT_CHARS),
    ...(optionalField(fields, "scope") ? { scope: cleanRequired(optionalField(fields, "scope")!, "scope", 240) } : {}),
    ...(optionalField(fields, "as_of") ? { asOf: validateDate(optionalField(fields, "as_of")!, "as_of") } : {}),
    ...(optionalField(fields, "supersedes") ? { supersedes: assertSafeId(optionalField(fields, "supersedes")!) } : {}),
    ...(optionalField(fields, "due") ? { due: validateDateTime(optionalField(fields, "due")!, "due") } : {}),
    ...(optionalField(fields, "remind_at") ? { remindAt: validateDateTime(optionalField(fields, "remind_at")!, "remind_at") } : {}),
    ...(optionalField(fields, "reason") ? { reason: cleanRequired(optionalField(fields, "reason")!, "reason", 2_000) } : {}),
    revision: revision as number,
    file
  });
}

function recordMetadata(record: Readonly<PersonalMemoryRecord>): ManifestRecord {
  const { content: _content, ...metadata } = record;
  return { ...metadata, contentHash: contentHash(record.content) };
}

function normalizeManifestRecord(record: Readonly<ManifestRecord>): ManifestRecord {
  return typeof record.recallWhen === "string" && record.recallWhen.trim()
    ? record
    : { ...record, recallWhen: record.title };
}

function recordMetadataWithoutHash(
  record: Readonly<ManifestRecord>
): Omit<ManifestRecord, "contentHash"> {
  const { contentHash: _contentHash, ...metadata } = record;
  return metadata;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validFixedFileHashes(
  value: PersonalMemoryFixedFileHashes | undefined
): value is PersonalMemoryFixedFileHashes {
  return Boolean(
    value
    && /^[a-f0-9]{64}$/u.test(value.agent)
    && /^[a-f0-9]{64}$/u.test(value.user)
  );
}

function buildSourceMap(manifest: PersonalMemoryManifest): SourceMapFile {
  const sources = new Map<string, string[]>();
  for (const record of manifest.records) {
    const current = sources.get(record.source) ?? [];
    current.push(record.id);
    sources.set(record.source, current);
  }
  return {
    schemaVersion: 1,
    revision: manifest.revision,
    sources: Object.fromEntries([...sources.entries()].map(([source, ids]) => [source, ids.sort(compareText)]))
  };
}

function runtimeSource(runtime: Readonly<PersonalMemoryRuntimeContext>): string {
  const segments = [runtime.vaultId, runtime.conversationId, runtime.piSessionId, runtime.userEntryId]
    .map((value) => encodeURIComponent(value));
  return `pi://${segments.join("/")}?productRun=${encodeURIComponent(runtime.productRunId)}`;
}

function runtimeAuditLink(
  runtime: Readonly<PersonalMemoryRuntimeContext>
): Readonly<{ toolCallId?: string }> {
  return runtime.toolCallId
    ? Object.freeze({ toolCallId: cleanRequired(runtime.toolCallId, "toolCallId", 512) })
    : Object.freeze({});
}

function productRunIdFromRuntimeSource(source: string): string | null {
  if (!source.startsWith("pi://")) return null;
  const query = source.split("?", 2)[1];
  if (!query) return null;
  const productRunId = new URLSearchParams(query).get("productRun");
  return productRunId?.trim() || null;
}

function validateWriteContent(
  kind: PersonalMemoryKind,
  basis: PersonalMemoryBasis,
  origin: PersonalMemoryContentOrigin | undefined,
  explicitlyAuthorized: boolean
): void {
  if (basis !== "explicit" && kind !== "view") {
    throw new PersonalMemoryAccessError("invalid_request", "Observed and inferred content is limited to views");
  }
  const effectiveOrigin = origin ?? "user_statement";
  const unsafeAutomaticOrigins: readonly PersonalMemoryContentOrigin[] = [
    "current_instruction", "quotation", "code", "hypothesis", "knowledge", "tool_output"
  ];
  if (unsafeAutomaticOrigins.includes(effectiveOrigin) && !explicitlyAuthorized) {
    throw new PersonalMemoryAccessError("invalid_request", `${effectiveOrigin} cannot become durable Memory automatically`);
  }
  if (["knowledge", "tool_output"].includes(effectiveOrigin) && ["fact", "view", "decision"].includes(kind)) {
    throw new PersonalMemoryAccessError("invalid_request", `${effectiveOrigin} cannot become a user ${kind}`);
  }
}

function assertExpectedRevision(manifest: PersonalMemoryManifest, expected: number | undefined): void {
  if (expected !== undefined && expected !== manifest.revision) {
    throw new PersonalMemoryAccessError(
      "revision_conflict",
      `Memory revision conflict: expected ${expected}, current ${manifest.revision}`
    );
  }
}

function recordRelativePath(kind: PersonalMemoryKind, id: string): string {
  const directory = kind === "fact"
    ? "facts"
    : kind === "view"
      ? "views"
      : kind === "decision"
        ? "decisions"
        : kind === "episode"
          ? "episodes"
          : "active";
  return path.posix.join("shared-user", "memory", directory, `${assertSafeId(id)}.md`);
}

function bestSecondaryScores(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>
): Map<string, { score: number; entry: SecondaryCatalogEntry }> {
  const best = new Map<string, { score: number; entry: SecondaryCatalogEntry }>();
  if (!query.trim()) return best;
  for (const entry of index.secondaryCatalog) {
    const score = scoreSecondaryEntry(entry, query, queryTokens);
    if (score <= 0) continue;
    const current = best.get(entry.parentId);
    if (!current || score > current.score) best.set(entry.parentId, { score, entry });
  }
  return best;
}

function groupSecondaryMatches(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>
): Map<string, SecondaryCatalogEntry[]> {
  const matches = new Map<string, SecondaryCatalogEntry[]>();
  if (!query.trim()) return matches;
  for (const entry of index.secondaryCatalog) {
    if (scoreSecondaryEntry(entry, query, queryTokens) <= 0) continue;
    const list = matches.get(entry.parentId) ?? [];
    list.push(entry);
    matches.set(entry.parentId, list);
  }
  return matches;
}

function toSecondaryMatchView(entry: SecondaryCatalogEntry): SecondaryMatchView {
  return Object.freeze({
    id: entry.id,
    parentId: entry.parentId,
    title: entry.title,
    content: entry.content,
    recallWhen: entry.recallWhen,
    matchTerms: Object.freeze([...entry.matchTerms]),
    relation: entry.relation,
    basis: entry.basis
  });
}

function encodeSearchCursor(revision: number, fingerprint: string, offset: number): string {
  const payload = stableJson({ version: 1, revision, fingerprint, offset });
  const signature = contentHash(payload).slice(0, 24);
  return Buffer.from(stableJson({ payload, signature }), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string, revision: number, fingerprint: string): number {
  const encoded = cleanRequired(cursor, "cursor", MAX_CURSOR_CHARS);
  let payload: Record<string, unknown>;
  try {
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      payload?: unknown;
      signature?: unknown;
    };
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error();
    if (contentHash(envelope.payload).slice(0, 24) !== envelope.signature) throw new Error();
    payload = JSON.parse(envelope.payload) as Record<string, unknown>;
    if (
      payload.version !== 1
      || !Number.isSafeInteger(payload.offset)
      || (payload.offset as number) < 0
    ) throw new Error();
  } catch {
    throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor is invalid");
  }
  if (payload.revision !== revision) {
    throw new PersonalMemoryAccessError("revision_conflict", "memory_search cursor revision has changed");
  }
  if (payload.fingerprint !== fingerprint) {
    throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor does not match query or filters");
  }
  return payload.offset as number;
}

function summarize(content: string): string {
  const compact = content.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}…`;
}

function summarizeSource(source: string): string {
  if (source.startsWith("pi://")) {
    const [base] = source.split("?");
    const segments = base.split("/");
    return `pi://…/${segments.at(-2) ?? "session"}/${segments.at(-1) ?? "entry"}`;
  }
  return source;
}

function cleanRequired(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string") throw new PersonalMemoryAccessError("invalid_request", `${name} must be text`);
  const clean = value.trim();
  if (!clean || clean.length > maxChars || hasDisallowedControlCharacters(clean)) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} is empty, too large, or contains control characters`);
  }
  return clean;
}

function cleanOptional(value: unknown, name: string, maxChars: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return cleanRequired(value, name, maxChars);
}

function assertSafeId(value: unknown): string {
  const id = cleanRequired(value, "id", 96);
  if (!SAFE_ID.test(id)) throw new PersonalMemoryAccessError("invalid_request", "Memory id is unsafe");
  return id;
}

function validateDate(value: unknown, name: string): string {
  const date = cleanRequired(value, name, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} must be YYYY-MM-DD`);
  }
  return date;
}

function validateDateTime(value: unknown, name: string): string {
  const dateTime = cleanRequired(value, name, 64);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} must be an ISO date-time`);
  }
  return dateTime;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isMemoryKind(value: unknown): value is PersonalMemoryKind {
  return ["fact", "view", "decision", "goal", "task", "open_loop", "episode"].includes(String(value));
}

function isMemoryStatus(value: unknown): value is PersonalMemoryStatus {
  return ["current", "superseded", "closed"].includes(String(value));
}

function isMemoryBasis(value: unknown): value is PersonalMemoryBasis {
  return ["explicit", "observed", "inferred"].includes(String(value));
}

function requireContentOrigin(value: unknown): PersonalMemoryContentOrigin {
  const origin = cleanRequired(value, "content_origin", 64) as PersonalMemoryContentOrigin;
  if (!["user_statement", "user_edit", "confirmed_change", "current_instruction", "quotation", "code", "hypothesis", "knowledge", "tool_output"].includes(origin)) {
    throw new PersonalMemoryAccessError("invalid_request", "content_origin is invalid");
  }
  return origin;
}

function requiredField(fields: ReadonlyMap<string, unknown>, key: string): string {
  return cleanRequired(fields.get(key), key, 2_000);
}

function optionalField(fields: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = fields.get(key);
  return value === undefined ? undefined : cleanRequired(value, key, 2_000);
}

function invalidField(file: string, field: string): never {
  throw new PersonalMemoryAccessError("invalid_request", `Memory ${file} ${field} is invalid`);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function dedupeChanges(changes: readonly TransactionChange[]): TransactionChange[] {
  const byPath = new Map<string, TransactionChange>();
  for (const change of changes) byPath.set(change.relativePath, change);
  return [...byPath.values()];
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function writeIfMissing(target: string, content: string): Promise<void> {
  if (!(await pathExists(target))) await atomicWrite(target, content);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readTextOrEmpty(target: string): Promise<string> {
  return await pathExists(target) ? await readFile(target, "utf8") : "";
}

async function readBounded(target: string, maxChars: number, name: string): Promise<string> {
  const text = await readFile(target, "utf8");
  if (text.length > maxChars || hasDisallowedControlCharacters(text)) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} is too large or contains control characters`);
  }
  return text;
}

async function readJsonOrNull<T>(target: string): Promise<T | null> {
  if (!(await pathExists(target))) return null;
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

function hasDisallowedControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) return true;
  }
  return false;
}

function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function listFilesRecursively(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  };
  await visit(root);
  return output.sort(compareText);
}
