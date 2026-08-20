/**
 * agent-avatar-presets.ts — 默认头像 preset 预留（本轮不含任何素材）。
 *
 * 产品决定：默认头像素材暂未提供。本轮只预留 preset 数据模型、常量和
 * 选择入口；catalog 为空时 UI 不显示空白头像列表，也不生成头像。
 * 将来补素材时只需往 AGENT_AVATAR_PRESETS 添加条目和资源文件。
 */

import type { AgentAvatarState } from "../harness/memory/agent-identity-state";

export interface AgentAvatarPreset {
  readonly id: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly assetPath: string;
}

/** 当前为空：不添加临时图片，不使用 Emoji 冒充默认头像。 */
export const AGENT_AVATAR_PRESETS: readonly AgentAvatarPreset[] = Object.freeze([]);

/**
 * 按 id 解析 preset 资源路径；未知 preset（或 catalog 为空）返回 null。
 * 解析失败时由渲染端回退默认 bot 图标，绝不让身份读取失败。
 */
export function resolveAgentAvatarPresetAsset(
  presetId: string,
  catalog: readonly AgentAvatarPreset[] = AGENT_AVATAR_PRESETS
): string | null {
  const preset = catalog.find((entry) => entry.id === presetId);
  return preset ? preset.assetPath : null;
}

/**
 * 身份状态 → 可直接用于 <img src> 的 URL；null 表示继续使用默认 bot 图标。
 * custom → Data URL；preset → 资源路径（缺失时 null）；default → null。
 */
export function resolveAgentAvatarUrl(
  avatar: AgentAvatarState,
  catalog: readonly AgentAvatarPreset[] = AGENT_AVATAR_PRESETS
): string | null {
  if (avatar.kind === "custom") return avatar.dataUrl;
  if (avatar.kind === "preset") return resolveAgentAvatarPresetAsset(avatar.presetId, catalog);
  return null;
}
