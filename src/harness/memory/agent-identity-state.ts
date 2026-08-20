/**
 * agent-identity-state.ts — Agent 身份（名称 + 头像）数据模型。
 *
 * 身份与人格是两套状态（人格系统重构草案 §8 最新决定）：
 * - 名称和头像属于「Agent 身份」，不是人格 trait，也不是 Memory。
 * - 只有用户可以在设置中修改；做梦、对话、Memory、Provider 一律无权修改。
 * - 存储于 `.echoink/agents/echoink/agent-identity.json`
 *   （schema `echoink.agent-identity.v1`）。
 * - 身份不写入 settings.json，也不塞进 personality-state.json。
 */

import path from "node:path";
import {
  cognitiveJsonText,
  cognitiveReadJsonOrNull
} from "./cognitive-file-utils";

export const AGENT_IDENTITY_STATE_SCHEMA = "echoink.agent-identity.v1" as const;

export const AGENT_IDENTITY_RELATIVE_PATH = path.posix.join(
  "agents", "echoink", "agent-identity.json"
);

export const DEFAULT_AGENT_DISPLAY_NAME = "EchoInk";

/** 名称按 Unicode 字符计数的上限（不是字节数）。 */
export const AGENT_DISPLAY_NAME_MAX_CHARS = 24;

/** custom 头像 Data URL 持久化上限，防止身份 JSON 无限膨胀。 */
export const AGENT_AVATAR_DATA_URL_MAX_CHARS = 400_000;

export type AgentAvatarState =
  | Readonly<{
      kind: "default";
    }>
  | Readonly<{
      kind: "preset";
      presetId: string;
    }>
  | Readonly<{
      kind: "custom";
      mimeType: "image/webp" | "image/png";
      dataUrl: string;
      width: 256;
      height: 256;
    }>;

export interface AgentIdentityState {
  readonly schema: typeof AGENT_IDENTITY_STATE_SCHEMA;
  readonly revision: number;
  readonly displayName: string;
  readonly avatar: AgentAvatarState;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

/** 按 Unicode 码点计数（Emoji 等组合字符不按字节/UTF-16 单元计算）。 */
export function countUnicodeChars(value: string): number {
  return [...value].length;
}

/**
 * 规范化 Agent 名称：去首尾空白；禁止换行、制表符、空名称；
 * 1–24 个 Unicode 字符。非法时返回 null。
 */
export function normalizeAgentDisplayName(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[\r\n\t]/u.test(trimmed)) return null;
  const length = countUnicodeChars(trimmed);
  if (length < 1 || length > AGENT_DISPLAY_NAME_MAX_CHARS) return null;
  return trimmed;
}

/** 校验头像状态；非法时返回 null（读取端回退 default，不让整份状态失败）。 */
export function normalizeAgentAvatar(avatar: unknown): AgentAvatarState | null {
  if (!avatar || typeof avatar !== "object") return null;
  const candidate = avatar as Record<string, unknown>;
  if (candidate.kind === "default") {
    return Object.freeze({ kind: "default" });
  }
  if (candidate.kind === "preset") {
    const presetId = typeof candidate.presetId === "string" ? candidate.presetId.trim() : "";
    if (!presetId) return null;
    // presetId 只保存字符串；素材缺失时由渲染端回退 default。
    return Object.freeze({ kind: "preset", presetId });
  }
  if (candidate.kind === "custom") {
    const mimeType = candidate.mimeType;
    const dataUrl = typeof candidate.dataUrl === "string" ? candidate.dataUrl : "";
    if (mimeType !== "image/webp" && mimeType !== "image/png") return null;
    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) return null;
    if (dataUrl.length > AGENT_AVATAR_DATA_URL_MAX_CHARS) return null;
    return Object.freeze({
      kind: "custom",
      mimeType,
      dataUrl,
      width: 256,
      height: 256
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

export function defaultAgentIdentityState(now = 0): AgentIdentityState {
  return Object.freeze({
    schema: AGENT_IDENTITY_STATE_SCHEMA,
    revision: 0,
    displayName: DEFAULT_AGENT_DISPLAY_NAME,
    avatar: Object.freeze({ kind: "default" }),
    updatedAt: now
  });
}

/**
 * 解析身份 JSON。任何字段非法都回退到安全默认值而不是整体失败：
 * 旧 Vault 没有文件、或将来某个 preset 不存在时，读取都不能崩。
 */
export function parseAgentIdentityState(raw: Record<string, unknown>): AgentIdentityState | null {
  if (raw.schema !== AGENT_IDENTITY_STATE_SCHEMA) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    return null;
  }
  const displayName = normalizeAgentDisplayName(
    typeof raw.displayName === "string" ? raw.displayName : ""
  ) ?? DEFAULT_AGENT_DISPLAY_NAME;
  const avatar = normalizeAgentAvatar(raw.avatar) ?? Object.freeze({ kind: "default" as const });
  return Object.freeze({
    schema: AGENT_IDENTITY_STATE_SCHEMA,
    revision: raw.revision,
    displayName,
    avatar,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
  });
}

export function agentIdentityStateJson(state: AgentIdentityState): string {
  return cognitiveJsonText(state);
}

// ---------------------------------------------------------------------------
// Store (read + cache; writes go through the repository transaction)
// ---------------------------------------------------------------------------

export class AgentIdentityStateStore {
  readonly filePath: string;
  private cache: AgentIdentityState | null = null;

  constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, AGENT_IDENTITY_RELATIVE_PATH);
  }

  /** 读取落盘身份；文件不存在时返回默认运行状态（不自动写文件）。 */
  async read(): Promise<AgentIdentityState> {
    if (this.cache) return this.cache;
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    this.cache = raw ? parseAgentIdentityState(raw) ?? defaultAgentIdentityState() : defaultAgentIdentityState();
    return this.cache;
  }

  /** 当前缓存快照（未读取过时返回默认状态），供同步 UI 使用。 */
  peek(): AgentIdentityState {
    return this.cache ?? defaultAgentIdentityState();
  }

  /** 事务提交成功后更新缓存。 */
  updateCache(state: AgentIdentityState): void {
    this.cache = state;
  }

  invalidate(): void {
    this.cache = null;
  }
}
