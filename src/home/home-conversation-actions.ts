import {
  applyJournalTemplate,
  BUILT_IN_JOURNAL_TEMPLATES,
  dateKey,
  DEFAULT_JOURNAL_TEMPLATE_ID
} from "./home-workbench-model";

export type HomeConversationAction = "daily" | "revisit";

export const HOME_REVIEW_PROMPT =
  "请从我最近积累和修改的知识中，找出 3 个值得重新思考的主题。先说明它们为什么值得回看，等我选择后再带我逐步复盘；未经我确认，不要写入笔记。";

export const HOME_DAILY_TITLES = Object.freeze([
  "今天，想留下些什么？",
  "把今天说给我听",
  "这一日，值得记下什么？",
  "从此刻，写下今天",
  "今天发生了什么？",
  "留一封信给今天"
] as const);

export const HOME_REVISIT_TITLES = Object.freeze([
  "还惦记哪件事？",
  "有哪个念头没说完？",
  "哪件事，还没有想清楚？",
  "要不要捡起一个旧念头？",
  "最近，有什么一直放不下？",
  "我们接着想哪一件？"
] as const);

export function homeConversationTitle(
  action: HomeConversationAction,
  vaultName: string,
  now = new Date()
): string {
  const titles = action === "daily" ? HOME_DAILY_TITLES : HOME_REVISIT_TITLES;
  const seed = `${dateKey(now)}\u0000${vaultName.trim()}\u0000${action}`;
  return titles[stableTextHash(seed) % titles.length];
}

export function buildDailyConversationDraft(now = new Date()): string {
  const template = BUILT_IN_JOURNAL_TEMPLATES.find(
    (candidate) => candidate.id === DEFAULT_JOURNAL_TEMPLATE_ID
  );
  if (!template) throw new Error("默认日记模板不可用");
  const renderedTemplate = applyJournalTemplate(template.content, now);
  return [
    "/daily",
    "",
    `请陪我完成 ${dateKey(now)} 的日记。先倾听我今天想说的内容，必要时再追问；不要虚构我没有说过的经历或感受。`,
    "在我明确确认生成前，不要创建或改写任何文件。确认后，请以以下“此刻速记”模板整理到 journal/YYYY-MM-DD.md；若目标文件已经存在，先读取并保留原内容，再追加或整理本次确认的内容。",
    "",
    "--- 默认模板预览 ---",
    renderedTemplate
  ].join("\n");
}

export function buildRevisitConversationDraft(): string {
  return [
    "/revisit",
    "",
    "请优先从长期 Memory 中推荐 3–5 个仍未完成的 goal、task 或 open_loop，并逐项提供足够上下文，让我先只选一个继续。",
    "在我选择前不要修改 Memory；选择后像朋友一样陪我继续聊，最后收束出一个具体、可执行的下一步。",
    "如果 Memory 已关闭、不可用或没有结果，请诚实说明，并邀请我直接说出最近一直放不下的事；不要伪造推荐。"
  ].join("\n");
}

function stableTextHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
