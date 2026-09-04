import type { SettingsLanguage } from "../settings/settings";
import { dateKey } from "./home-workbench-model";

export type HomeConversationAction = "daily" | "revisit";

export const HOME_REVIEW_PROMPT =
  "请从我最近积累和修改的知识中，找出 3 个值得重新思考的主题。先说明它们为什么值得回看，等我选择后再带我逐步复盘；未经我确认，不要写入笔记。";

export const HOME_REVIEW_PROMPT_EN =
  "Review the knowledge I have recently accumulated and updated, and identify 3 topics worth reconsidering. Explain why each one is worth revisiting, then wait for me to choose before guiding me through the review; do not write to any note without my confirmation.";

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

export const HOME_DAILY_MESSAGE_EN = "I'd like to write down what happened today.";
export const HOME_REVISIT_MESSAGE_EN =
  "Find one unfinished thought in my long-term memory, and let's keep talking about it.";

export const HOME_DAILY_TITLES_EN = Object.freeze([
  "What would you like to keep from today?",
  "Tell me about your day",
  "What deserves a place in today's journal?",
  "Write today from this moment",
  "What happened today?",
  "Leave a note for today"
] as const);

export const HOME_REVISIT_TITLES_EN = Object.freeze([
  "What is still on your mind?",
  "Which thought was left unfinished?",
  "What have you not thought through yet?",
  "Want to pick up an earlier idea?",
  "What have you been carrying lately?",
  "What should we keep thinking about?"
] as const);

export function homeConversationMessage(
  action: HomeConversationAction,
  language: SettingsLanguage = "zh-CN"
): string {
  if (language === "en") {
    return action === "daily" ? HOME_DAILY_MESSAGE_EN : HOME_REVISIT_MESSAGE_EN;
  }
  return action === "daily" ? HOME_DAILY_MESSAGE : HOME_REVISIT_MESSAGE;
}

export function homeReviewPrompt(language: SettingsLanguage = "zh-CN"): string {
  return language === "en" ? HOME_REVIEW_PROMPT_EN : HOME_REVIEW_PROMPT;
}

export function homeConversationTitle(
  action: HomeConversationAction,
  vaultName: string,
  now = new Date(),
  language: SettingsLanguage = "zh-CN"
): string {
  const titles = language === "en"
    ? action === "daily" ? HOME_DAILY_TITLES_EN : HOME_REVISIT_TITLES_EN
    : action === "daily" ? HOME_DAILY_TITLES : HOME_REVISIT_TITLES;
  const seed = `${dateKey(now)}\u0000${vaultName.trim()}\u0000${action}`;
  return titles[stableTextHash(seed) % titles.length];
}

function stableTextHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
