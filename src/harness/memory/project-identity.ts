const PROJECT_DIRECTIVE_LINE_PATTERN =
  /^(?:Project|项目)[\t ]*[:：][\t ]*(.*)$/iu;
const COMPLETE_PROJECT_ID_PATTERN =
  /^[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,78}[\p{L}\p{N}_-]$/u;
const DIRECTIVE_TERMINATORS = new Set([
  ".",
  "!",
  "?",
  ";",
  "。",
  "！",
  "？",
  "；"
]);

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

/**
 * Resolve the one explicit project directive used by Memory reads and writes.
 *
 * A directive occupies one complete, unindented top-level line, uses an exact
 * `Project:` / `项目：` label, and contains one complete 2-80 character ID.
 * Markdown fences, indented code, lists, blockquotes, and inline prose are not
 * directive regions. Repeated identical directives are allowed. Any malformed
 * top-level directive or conflicting ID fails the whole request closed.
 */
export function resolveExplicitMemoryProjectId(text: string): string | undefined {
  const projectIds = new Set<string>();
  let fence: MarkdownFence | undefined;
  for (const line of text.split(/\r\n|[\n\r]/u)) {
    if (fence) {
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    const match = line.match(PROJECT_DIRECTIVE_LINE_PATTERN);
    if (!match) continue;
    const projectId = parseCompleteProjectDirectiveValue(match[1] ?? "");
    if (!projectId) return undefined;
    projectIds.add(projectId);
    if (projectIds.size > 1) return undefined;
  }
  return projectIds.size === 1 ? [...projectIds][0] : undefined;
}

function parseCompleteProjectDirectiveValue(value: string): string | undefined {
  const trimmed = value.trimEnd();
  const projectId = DIRECTIVE_TERMINATORS.has(trimmed.at(-1) ?? "")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  return COMPLETE_PROJECT_ID_PATTERN.test(projectId)
    ? projectId
    : undefined;
}

function parseOpeningFence(line: string): MarkdownFence | undefined {
  const marker = line.match(/^[\t ]{0,3}(`{3,}|~{3,})/u)?.[1];
  if (!marker) return undefined;
  return Object.freeze({
    marker: marker[0] as MarkdownFence["marker"],
    length: marker.length
  });
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const marker = line.match(/^[\t ]{0,3}(`{3,}|~{3,})[\t ]*$/u)?.[1];
  return Boolean(
    marker
    && marker[0] === fence.marker
    && marker.length >= fence.length
  );
}
