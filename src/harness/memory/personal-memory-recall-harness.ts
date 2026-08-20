import { estimatePiContextTokens } from "../pi-native/pi-context-budget";
import type {
  PersonalMemoryMode,
  PersonalMemorySearchItem,
  SecondaryMatchView
} from "./personal-memory-contracts";
import { PersonalMemoryRepository } from "./personal-memory-repository";
import type { PersonalMemoryTurnCatalogCandidate } from "./personal-memory-repository";

export type PersonalMemoryRecallCandidate = Pick<PersonalMemorySearchItem,
  "id" | "kind" | "title" | "recallWhen" | "summary" | "date" | "scope" | "score"
> & Readonly<{
  /** Secondary fact that decisively pulled this Memory into the candidates. */
  matchedSecondaryId?: string;
  /** All secondary facts of this Memory that matched the turn query. */
  secondaryMatches?: readonly SecondaryMatchView[];
}>;

export interface PersonalMemoryPreparedTurnContext {
  readonly revision: number;
  readonly agent: string;
  readonly user: string;
  readonly memory: string | null;
  readonly recall: Readonly<{
    readonly candidates: readonly Readonly<PersonalMemoryRecallCandidate>[];
    readonly exhaustive: boolean;
    readonly hasMore: boolean;
    readonly total: number;
    readonly injected: number;
    readonly remaining: number;
  }> | null;
  readonly injectionKeys: readonly string[];
}

export const PERSONAL_MEMORY_RECALL_STAGES = Object.freeze([
  "loading",
  "catalog",
  "matching",
  "budgeting",
  "assembling"
] as const);
export type PersonalMemoryRecallStage = typeof PERSONAL_MEMORY_RECALL_STAGES[number];
export interface PersonalMemoryRecallSafeStats {
  readonly result: "completed" | "skipped_no_memory" | "failed";
  readonly scanned: number;
  readonly candidates: number;
  readonly injected: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export class PersonalMemoryRecallHarness {
  constructor(private readonly repository: PersonalMemoryRepository) {}

  async prepareTurnContext(input: Readonly<{
    memoryMode: PersonalMemoryMode;
    query: string;
    recentConversation?: readonly string[];
    tokenBudget: number;
    vaultId: string;
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    onProgress?(
      stage: PersonalMemoryRecallStage,
      stats?: Readonly<PersonalMemoryRecallSafeStats>
    ): void | Promise<void>;
  }>): Promise<Readonly<PersonalMemoryPreparedTurnContext>> {
    await input.onProgress?.("loading");
    const tokenBudget = normalizeTokenBudget(input.tokenBudget);
    const query = input.memoryMode === "normal"
      ? buildBoundedRecallQuery(
          input.query,
          input.recentConversation ?? [],
          tokenBudget
        )
      : "";
    await input.onProgress?.("catalog");
    const snapshot = await this.repository.prepareTurnSnapshot({
      memoryMode: input.memoryMode,
      ...(input.memoryMode === "normal"
        ? {
            query,
            selectCandidateIds: (
              candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
            ) => selectRecallCandidateIds(candidates, tokenBudget)
          }
        : {})
    }, input.memoryMode === "normal" ? {
      vaultId: input.vaultId,
      conversationId: input.conversationId,
      piSessionId: input.piSessionId,
      productRunId: input.productRunId,
      memoryMode: "normal"
    } : undefined);
    const { search, scanned, ...fixed } = snapshot;
    if (input.memoryMode === "no_memory") {
      await input.onProgress?.("assembling", {
        result: "skipped_no_memory",
        scanned: 0,
        candidates: 0,
        injected: 0,
        remaining: 0,
        exhausted: true
      });
      return Object.freeze({
        ...fixed,
        recall: null,
        injectionKeys: Object.freeze([...fixed.injectionKeys])
      });
    }
    if (!search) throw new Error("personal_memory_recall_snapshot_missing_search");
    // Stats-only, fire-and-forget: never blocks or fails the turn.
    const pendingSecondaryHits = search.pendingSecondaryHits ?? [];
    if (pendingSecondaryHits.length > 0) {
      void this.repository.recordSecondaryRecallHits(pendingSecondaryHits).catch(() => {});
    }
    await input.onProgress?.("matching");
    await input.onProgress?.("budgeting");
    const candidates = search.items.map(toRecallCandidate);
    const remaining = search.remaining;
    const exhaustive = search.exhausted;
    await input.onProgress?.("assembling", {
      result: "completed",
      scanned,
      candidates: search.total,
      injected: candidates.length,
      remaining,
      exhausted: exhaustive
    });
    return Object.freeze({
      ...fixed,
      recall: Object.freeze({
        candidates: Object.freeze(candidates),
        exhaustive,
        hasMore: !exhaustive,
        total: search.total,
        injected: candidates.length,
        remaining
      }),
      injectionKeys: Object.freeze([
        ...fixed.injectionKeys,
        "echoink.memory.recall"
      ])
    });
  }
}

/** XML envelope overhead of the recall + secondary blocks (counted once). */
const RECALL_ENVELOPE_OVERHEAD =
  '<echoink_memory_recall trust="user-owned-memory" exhaustive="" has_more="">' +
  "</echoink_memory_recall>" +
  '<echoink_memory_secondary trust="llm-inferred-reference">' +
  "</echoink_memory_secondary>";

export interface PersonalMemorySecondaryInjectionFact {
  readonly parentId: string;
  readonly parentTitle: string;
  readonly fact: SecondaryMatchView;
}

/**
 * 预算计算与实际注入（pi-production-runtime-composition）共用的纯序列化：
 * candidates 只保留 matchedSecondaryId（剥离 secondaryMatches），完整二级
 * 事实单独列出；routeTokens/contentTokens 等索引内部字段绝不进入 payload。
 */
export function serializeRecallInjection(input: Readonly<{
  candidates: readonly Readonly<PersonalMemoryRecallCandidate>[];
  secondaryFacts: readonly PersonalMemorySecondaryInjectionFact[];
}>): string {
  const stripped = input.candidates.map((candidate) => {
    const injected: Record<string, unknown> = { ...candidate };
    delete injected.secondaryMatches;
    return injected;
  });
  return JSON.stringify({
    candidates: stripped,
    secondaryFacts: input.secondaryFacts
  });
}

function secondaryFactsFor(
  items: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
): PersonalMemorySecondaryInjectionFact[] {
  const seen = new Set<string>();
  const facts: PersonalMemorySecondaryInjectionFact[] = [];
  for (const item of items) {
    for (const view of item.secondaryMatches ?? []) {
      if (seen.has(view.id)) continue;
      seen.add(view.id);
      facts.push({ parentId: item.id, parentTitle: item.title, fact: view });
    }
  }
  return facts;
}

/**
 * Token 预算必须按照最终真实注入内容计算（做梦/Recall PRD §12）：按
 * 「当前已选候选 + 新候选」累计构造完整最终 payload 后测量，包装开销
 * 只计算一次。先完成最终 payload，再根据预算选择候选。
 */
export function measureFinalInjectionTokens(
  items: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
): number {
  const payload = serializeRecallInjection({
    candidates: items.map((item) => toRecallCandidate(item)),
    secondaryFacts: secondaryFactsFor(items)
  });
  return estimatePiContextTokens(payload + RECALL_ENVELOPE_OVERHEAD).tokens;
}

function selectRecallCandidateIds(
  candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[],
  tokenBudget: number
): readonly string[] {
  const selected: PersonalMemoryTurnCatalogCandidate[] = [];
  for (const item of candidates) {
    const withCandidate = [...selected, item];
    // 与预算口径共用同一个测量函数：按「已选 + 新候选」的累计最终
    // payload 一次性测量（包装开销只算一次），避免口径漂移。
    if (measureFinalInjectionTokens(withCandidate) > tokenBudget) continue;
    selected.push(item);
  }
  return Object.freeze(selected.map((item) => item.id));
}

function toRecallCandidate(
  item: Readonly<Pick<PersonalMemorySearchItem,
    "id" | "kind" | "title" | "recallWhen" | "summary" | "date" | "scope" | "score"
  >> & Partial<Pick<PersonalMemorySearchItem, "matchedSecondaryId" | "secondaryMatches">>
): Readonly<PersonalMemoryRecallCandidate> {
  return Object.freeze({
    id: item.id,
    kind: item.kind,
    title: item.title,
    recallWhen: item.recallWhen,
    summary: item.summary,
    date: item.date,
    ...(item.scope ? { scope: item.scope } : {}),
    score: item.score,
    ...(item.matchedSecondaryId ? { matchedSecondaryId: item.matchedSecondaryId } : {}),
    ...(item.secondaryMatches && item.secondaryMatches.length > 0
      ? { secondaryMatches: Object.freeze(item.secondaryMatches.map((view) => Object.freeze({ ...view }))) }
      : {})
  });
}

const MAX_RECALL_QUERY_CHARS = 2_000;

function buildBoundedRecallQuery(
  currentQuery: string,
  recentConversation: readonly string[],
  maxTokens: number
): string {
  const segments = [
    currentQuery,
    ...recentConversation.slice(-6).reverse()
  ].map((value) => value.trim()).filter(Boolean);
  let result = "";
  for (const segment of segments) {
    const separator = result ? "\n" : "";
    const remainingChars = MAX_RECALL_QUERY_CHARS - result.length - separator.length;
    if (remainingChars <= 0) break;
    const prefix = `${result}${separator}`;
    const fitted = fitSegment(prefix, segment.slice(0, remainingChars), maxTokens);
    if (!fitted) continue;
    result = `${prefix}${fitted}`;
    if (fitted.length < segment.length) break;
  }
  return result;
}

function fitSegment(prefix: string, segment: string, maxTokens: number): string {
  if (estimatePiContextTokens(`${prefix}${segment}`).tokens <= maxTokens) return segment;
  let low = 0;
  let high = segment.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimatePiContextTokens(`${prefix}${segment.slice(0, middle)}`).tokens <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return segment.slice(0, low);
}

function normalizeTokenBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("personal_memory_recall_token_budget_invalid");
  }
  return value;
}
