/**
 * cognitive-projection.ts — renders AGENT.md / USER.md pure-text projections.
 *
 * 草案 §7 / §8：
 * - AGENT.md = 当前六维人格（自然语言）+ 从一级 Memory 提炼的长期要求 + 表达方式。
 * - USER.md  = 稳定、当前有效且有一级 Memory 来源的用户画像。
 * 六维数值转成自然语言，不把 JSON 或完整历史注入上下文。
 */

import { TRAIT_DIMENSIONS, renderTraitLine, getPersonalityTemplate } from "./personality-templates";
import {
  renderableRequirements,
  type PersonalityState
} from "./personality-state";
import {
  isProfileItemRenderable,
  type UserProfileItem,
  type UserProfileState
} from "./user-profile-state";

export function renderAgentMarkdown(state: PersonalityState): string {
  const template = getPersonalityTemplate(state.templateId);
  const lines: string[] = ["# EchoInk Agent", ""];
  if (template) {
    lines.push(`> 初始模板：${template.labelZh}。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。`, "");
  } else {
    lines.push("> 人格由 EchoInk 依据有效长期 Memory 自动生成，不由用户直接编辑。", "");
  }

  lines.push("## 当前人格", "");
  for (const dimension of TRAIT_DIMENSIONS) {
    const observed = state.observed[dimension];
    const explicit = state.explicit[dimension];
    const record = observed ?? explicit;
    if (!record) continue;
    lines.push(renderTraitLine(dimension, record.score, "zh"));
  }
  lines.push("");

  const requirements = renderableRequirements(state);
  if (requirements.length > 0) {
    lines.push("## 从长期协作中学到的要求", "");
    for (const requirement of requirements) {
      lines.push(`- ${requirement.text}`);
    }
    lines.push("");
  }

  lines.push(
    "## 表达方式",
    "",
    "- 语言自然、具体、克制。",
    "- 详略服从当前任务，不固定成长短模板。",
    "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。",
    ""
  );
  return lines.join("\n");
}

/**
 * USER.md 投影。口径区分（最新决定）：
 * - explicit_memory / legacy_import：用户明确确认过的画像，直接渲染；
 * - observed_memory：系统长期观察，必须达到 USER_OBSERVED_MIN_SOURCES 个
 *   独立有效来源才允许进入 USER.md，且渲染时带「观察」标记。
 * 整份 USER.md 不再统一冒充「用户明确确认」。
 */
export function renderUserMarkdown(state: UserProfileState): string {
  const renderable = state.items.filter((item) => isProfileItemRenderable(item));
  const identity = renderable.filter((item) => item.section === "identity");
  const preferences = renderable.filter((item) => item.section !== "identity");

  const lines: string[] = [
    "# USER",
    "",
    "本文件是系统生成的用户画像投影：无标记条目来自用户明确确认的记忆；",
    "带「系统观察」标记的条目是做梦从长期记忆中归纳的参考信息，不等于用户亲口确认。",
    ""
  ];
  lines.push("## 当前稳定画像", "");
  if (identity.length === 0) lines.push("- 尚无已确认内容。");
  else for (const item of identity) lines.push(renderProfileItemLine(item));
  lines.push("");
  lines.push("## 长期偏好与合作方式", "");
  if (preferences.length === 0) lines.push("- 尚无已确认内容。");
  else for (const item of preferences) lines.push(renderProfileItemLine(item));
  lines.push("");
  return lines.join("\n");
}

function renderProfileItemLine(item: UserProfileItem): string {
  if (item.basis === "observed_memory") {
    return `- ${item.text}（系统观察，供参考）`;
  }
  return `- ${item.text}`;
}

/**
 * Generate the short personality summary shown on the settings page.
 * Reads the REAL personality state — never placeholder copy.
 */
export function renderPersonalitySummary(
  state: PersonalityState | null,
  language: "zh" | "en" = "zh"
): string {
  const zh = language === "zh";
  if (!state || !state.templateId) {
    return zh
      ? "尚未选择初始人格。选择模板后立即生成人格描述。"
      : "No initial personality yet. Pick a template to generate the description.";
  }
  const template = getPersonalityTemplate(state.templateId);
  const observedCount = TRAIT_DIMENSIONS.filter((dimension) => state.observed[dimension]).length;
  const requirementCount = renderableRequirements(state).length;
  if (zh) {
    const parts = [
      `当前基于「${template?.labelZh ?? state.templateId}」模板。`,
      template?.cardZh ? template.cardZh : ""
    ].filter(Boolean);
    if (observedCount > 0) {
      parts.push(`已有 ${observedCount} 个维度被长期协作观测微调。`);
    }
    if (requirementCount > 0) {
      parts.push(`并从长期 Memory 学到 ${requirementCount} 条处事要求。`);
    }
    return parts.join("");
  }
  const parts = [
    `Based on the "${template?.labelEn ?? state.templateId}" template.`,
    template?.cardEn ?? ""
  ].filter(Boolean);
  if (observedCount > 0) parts.push(`${observedCount} dimension(s) calibrated by long-term collaboration.`);
  if (requireCount(requirementCount)) parts.push(`Learned ${requirementCount} standing requirement(s) from Memory.`);
  return parts.join(" ");
}

function requireCount(count: number): boolean {
  return count > 0;
}
