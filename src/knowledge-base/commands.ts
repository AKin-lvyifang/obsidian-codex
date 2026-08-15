export interface KnowledgeBaseCommandOption {
  title: string;
  icon: string;
  text: string;
  description: string;
}

export const KNOWLEDGE_BASE_COMMAND_OPTIONS: KnowledgeBaseCommandOption[] = [
  { title: "提问", icon: "search", text: "/ask ", description: "对知识库发问" },
  { title: "维护知识库", icon: "library", text: "/maintain ", description: "提炼、写入并回读知识" }
];

export function getTrailingSlashQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function knowledgeCommandQueryForInput(text: string): string | null {
  return getTrailingSlashQuery(text);
}

export function knowledgeCommandOptions(query = ""): KnowledgeBaseCommandOption[] {
  const normalized = query.trim().toLowerCase();
  return KNOWLEDGE_BASE_COMMAND_OPTIONS.filter((item) => {
    if (!normalized) return true;
    const command = item.text.trim().replace(/^\//, "").toLowerCase();
    return command.includes(normalized)
      || item.title.toLowerCase().includes(normalized)
      || item.description.toLowerCase().includes(normalized);
  });
}

/** Phase 3 routes only commands that are valid inside an ordinary Conversation. */
export type KnowledgeConversationCommand =
  | Readonly<{
      kind: "chat";
      originalText: string;
    }>
  | Readonly<{
      kind: "ask";
      originalText: string;
      question: string;
      explicitPaths: readonly string[];
      includeUnrefined: boolean;
    }>
  | Readonly<{
      kind: "maintain";
      originalText: string;
      request: string;
    }>;

const EXPLICIT_MARKDOWN_PATH =
  /(?:^|[\s`"'（(])((?:raw|inbox|wiki|projects|notes|[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_. -]+)*)\/[\p{L}\p{N}_. -]+\.md)(?=$|[\s`"'，。；：、）)])/giu;

/**
 * Conservative Phase 3 command router.
 *
 * It intentionally does not reuse the legacy knowledge-channel parser above:
 * that parser recognizes many retired commands and treats generic words such
 * as “整理” as maintenance. Here “整理一下这个方案” remains normal chat.
 */
export class KnowledgeCommandRouter {
  route(text: string): KnowledgeConversationCommand {
    const originalText = String(text);
    const trimmed = originalText.trim();
    const ask = /^\/ask(?:\s+([\s\S]*))?$/iu.exec(trimmed);
    if (ask) {
      const question = (ask[1] ?? "").trim();
      const explicitPaths = extractExplicitMarkdownPaths(question);
      return Object.freeze({
        kind: "ask" as const,
        originalText,
        question,
        explicitPaths,
        includeUnrefined: explicitPaths.some((value) =>
          value.startsWith("raw/") || value.startsWith("inbox/")
        )
      });
    }

    const maintain = /^\/maintain(?:\s+([\s\S]*))?$/iu.exec(trimmed);
    if (maintain) {
      const request = (maintain[1] ?? "").trim();
      return Object.freeze({
        kind: "maintain" as const,
        originalText,
        request
      });
    }
    return Object.freeze({ kind: "chat" as const, originalText });
  }
}

export function routeKnowledgeConversationCommand(
  text: string
): KnowledgeConversationCommand {
  return new KnowledgeCommandRouter().route(text);
}

function extractExplicitMarkdownPaths(value: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of value.matchAll(EXPLICIT_MARKDOWN_PATH)) {
    const candidate = match[1]?.trim().replaceAll("\\", "/");
    if (candidate) paths.add(candidate);
  }
  return Object.freeze([...paths].sort((left, right) =>
    left.localeCompare(right, "en")
  ));
}
