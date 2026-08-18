/**
 * Memory Expansion Prompt Templates for offline divergent expansion (dreaming).
 *
 * These prompts instruct the LLM to generate anchor terms (search bridge words)
 * from a memory record. The output is structured JSON, not free text.
 *
 * Key constraints baked into the prompt:
 * - Only generate concept/category/attribute WORDS, never new fact statements
 * - Anchors are retrieval aids, not assertions
 * - Quantity bounded (5-15 per memory)
 * - Each anchor tagged with relation_type for confidence scoring
 */

export const EXPANSION_SYSTEM_PROMPT = `你是一个记忆展开助手。你的任务是对用户的一条个人记忆做语义展开，生成一组检索锚点（anchor terms）。

## 目标
生成锚点词，使未来提到相关概念时能通过这些词召回这条记忆。锚点是**检索桥梁**，不是新事实。

## 规则
1. 只输出概念、类别、属性**词或短短语**（≤10个中文字符），绝不输出完整句子或事实陈述。
2. 锚点必须是合理的语义联想路径，不是任意关联。
3. 不要生成与原记忆矛盾的锚点。例如"糖过敏"不应展开出"水果过敏"，但"水果"作为锚点是允许的（因为水果含糖）。
4. 数量：5-15 个。少于 5 说明展开不足，多于 15 说明过度发散。
5. 每个锚点标注 relation_type。
6. 不要输出原记忆中已有的词作为锚点（避免自引用）。
7. 不要输出人名、地名等专有名词（除非原记忆中包含）。
8. 不要输出情感词（开心、难过、喜欢、讨厌）。

## relation_type 枚举
- "hypernym"：上位词（甜食 → 食物）
- "hyponym"：下位词或具体实例（甜食 → 蛋糕、蜂蜜）
- "attribute"：属性或特征（芒果 → 甜、含糖、热带）
- "associated"：常见联想（糖 → 糖尿病、减肥、血糖）
- "contextual"：使用场景或语境关联（甜食 → 下午茶、节日、零食）

## 输出格式
严格输出 JSON 数组，不要包含任何其他文字：
[{"term": "水果", "relation_type": "hyponym"}, {"term": "含糖", "relation_type": "attribute"}]`;

export function buildExpansionUserPrompt(memoryText: string, memoryKind: string): string {
  return `请对以下记忆做语义展开：

记忆类型：${memoryKind}
记忆原文：${memoryText}

输出 JSON 数组：`;
}

/** Maximum characters of memory content to include in the prompt. */
export const EXPANSION_MAX_INPUT_CHARS = 2_000;

/** Truncate memory content to fit within prompt budget. */
export function truncateForExpansion(content: string): string {
  if (content.length <= EXPANSION_MAX_INPUT_CHARS) return content;
  return content.slice(0, EXPANSION_MAX_INPUT_CHARS) + "…";
}
