import { dateKey } from "./home-workbench-model";

export type HomeConversationAction = "daily" | "revisit";

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

export const HOME_DAILY_MESSAGE = "想把今天发生的事记下来。";
export const HOME_REVISIT_MESSAGE =
  "从我的长期记忆里，找一件没说完的事，我们接着聊。";

export function homeConversationTitle(
  action: HomeConversationAction,
  vaultName: string,
  now = new Date()
): string {
  const titles = action === "daily" ? HOME_DAILY_TITLES : HOME_REVISIT_TITLES;
  const seed = `${dateKey(now)}\u0000${vaultName.trim()}\u0000${action}`;
  return titles[stableTextHash(seed) % titles.length];
}

export function buildReviewConversationDraft(now = new Date()): string {
  return [
    "/review",
    "",
    "请先从我最近积累和修改的知识中，推荐 3 个值得复盘的知识主题，并让我只选择一个继续。",
    "在我选择主题并明确确认写入前，不要创建、改写或追加任何文件。",
    `确认后，默认把复盘结论写入 journal/${dateKey(now)}.md 的“知识复盘”部分；如果文件已存在，先读取并保留原内容。`,
    "是否另外整理到 outputs 由我决定；没有获得我的选择时，不要擅自创建 outputs 文件。"
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
