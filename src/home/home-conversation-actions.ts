import {
  applyJournalTemplate,
  BUILT_IN_JOURNAL_TEMPLATES,
  dateKey,
  DEFAULT_JOURNAL_TEMPLATE_ID
} from "./home-workbench-model";
import type { SettingsLanguage } from "../settings/settings";
import { homeCopy } from "./home-i18n";

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

export function buildDailyConversationDraft(now = new Date(), language: SettingsLanguage = "zh-CN"): string {
  const template = BUILT_IN_JOURNAL_TEMPLATES.find(
    (candidate) => candidate.id === DEFAULT_JOURNAL_TEMPLATE_ID
  );
  if (!template) throw new Error(homeCopy(language).template.defaultTemplateUnavailable);
  const renderedTemplate = applyJournalTemplate(template.content, now);
  if (language === "en") {
    return [
      "/daily",
      "",
      `Please help me make a journal entry for ${dateKey(now)}. Listen to what I want to share about today first, and ask follow-up questions only when useful; do not invent experiences or feelings I did not describe.`,
      "Do not create or edit any files until I explicitly confirm that the journal should be generated. After I confirm, organize it with the original template shown below in journal/YYYY-MM-DD.md; if the target file already exists, read it first, keep its original content, then append or organize only what I confirm this time.",
      "",
      "--- Default template preview ---",
      renderedTemplate
    ].join("\n");
  }
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

export function buildRevisitConversationDraft(language: SettingsLanguage = "zh-CN"): string {
  if (language === "en") {
    return [
      "/revisit",
      "",
      "First, recommend 3–5 unfinished goals, tasks, or open loops from my long-term Memory. Give enough context for each one, then let me choose just one to continue.",
      "Do not change Memory before I choose. Once I choose, stay with me like a friend and finish by helping me define one concrete next step.",
      "If Memory is off, unavailable, or has no results, say so honestly and invite me to share what has been on my mind lately; do not fabricate recommendations."
    ].join("\n");
  }
  return [
    "/revisit",
    "",
    "请优先从长期 Memory 中推荐 3–5 个仍未完成的 goal、task 或 open_loop，并逐项提供足够上下文，让我先只选一个继续。",
    "在我选择前不要修改 Memory；选择后像朋友一样陪我继续聊，最后收束出一个具体、可执行的下一步。",
    "如果 Memory 已关闭、不可用或没有结果，请诚实说明，并邀请我直接说出最近一直放不下的事；不要伪造推荐。"
  ].join("\n");
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
