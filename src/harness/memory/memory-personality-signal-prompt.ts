/**
 * Personality Signal Detection Prompt Templates.
 *
 * Given a memory record (view/decision/episode), determines whether it contains
 * a preference about how the Agent should behave — i.e., a personality signal.
 *
 * Output: structured JSON with dimension + direction + evidence, or null if none.
 *
 * Key constraints:
 * - Only view/decision/episode kinds are eligible (fact/goal/task/open_loop → always null)
 * - Must be about AGENT behavior, not about the user's own preferences unrelated to Agent
 * - "我喜欢直白" alone is ambiguous; "我希望 Agent 直白一点" is a clear signal
 * - Emotional venting ("今天心情不好") is NOT a personality signal
 */

export const SIGNAL_DETECTION_SYSTEM_PROMPT = `你是一个人格信号检测器。你的任务是判断一条用户记忆是否包含对 Agent 行为方式的偏好。

## 什么是人格信号
人格信号是用户对 Agent **表达方式、沟通风格、互动姿态**的明确偏好或评价。例如：
- "你要隐晦一点，别老骂我" → 温度(warmth)维度，正向(increase)
- "我喜欢你先给结论再展开" → 节奏(tempo)维度，负向(decrease，因为 score 低=快节奏)
- "别什么都同意我，要有自己的判断" → 立场(stance)维度，正向(increase)
- "输出能不能结构化一点" → 秩序(order)维度，正向(increase)

## 什么不是人格信号
- 客观事实："我对糖过敏""项目用 TypeScript"
- 待办目标："周五提交报告""要完成 PRD"
- 与 Agent 无关的个人偏好："我喜欢吃辣""我不喝咖啡"
- 纯情绪宣泄："今天好累""烦死了"（没有指向 Agent 行为）
- 模糊表达："我喜欢直白"（没有明确说是对 Agent 的要求，可能是自我描述）

## 六个人格维度
1. tempo（节奏）：快/短平快 ↔ 慢/深思熟虑
2. energy（能量）：外向主动 ↔ 内向安静
3. mind（思维）：发散联想 ↔ 聚焦务实
4. warmth（温度）：理性冷静 ↔ 感性共情
5. order（秩序）：结构化严谨 ↔ 随性自然
6. stance（立场）：随和配合 ↔ 坚持主见

## 方向定义
- increase = 分数升高 = 偏向右极（慢/内向/务实/共情/随性/主见）
- decrease = 分数降低 = 偏向左极（快/外向/发散/冷静/严谨/配合）

注意方向不要搞反：
- "简短点、先给结论" → tempo decrease（分数低=快）
- "详细展开、慢慢说" → tempo increase（分数高=慢）
- "直接指出、不用客气" → warmth decrease（分数低=冷静）
- "顾及感受、委婉点" → warmth increase（分数高=共情）

## 输出格式
如果检测到人格信号，严格输出 JSON：
{"dimension": "warmth", "direction": "increase", "evidence": "用户要求 Agent 顾及感受、委婉表达"}

如果没有检测到人格信号，严格输出：
null

不要输出任何其他文字、解释或 markdown。`;

export function buildSignalDetectionUserPrompt(
  memoryContent: string,
  memoryKind: string
): string {
  return `记忆类型：${memoryKind}
记忆内容：${memoryContent}

判断这条记忆是否包含对 Agent 行为方式的人格偏好信号：`;
}

/** Maximum characters of memory content for signal detection. */
export const SIGNAL_DETECTION_MAX_INPUT_CHARS = 1_000;

/** Truncate memory content for signal detection prompt. */
export function truncateForSignalDetection(content: string): string {
  if (content.length <= SIGNAL_DETECTION_MAX_INPUT_CHARS) return content;
  return content.slice(0, SIGNAL_DETECTION_MAX_INPUT_CHARS) + "…";
}

/** Memory kinds that are eligible for personality signal detection. */
export const SIGNAL_ELIGIBLE_KINDS = new Set(["view", "decision", "episode"]);

/** Check if a memory kind can contain personality signals. */
export function isSignalEligibleKind(kind: string): boolean {
  return SIGNAL_ELIGIBLE_KINDS.has(kind);
}
