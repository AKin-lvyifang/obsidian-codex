/**
 * agent-avatar-processor.ts — 自定义头像上传处理。
 *
 * 方案（本轮）：处理后的头像 Data URL 直接存入 agent-identity.json，
 * 不扩展 PersonalMemoryRepository 事务系统去支持二进制文件。
 *
 * 文件校验与 Canvas 处理拆开：文件类型 / 大小 / Data URL 上限是纯函数，
 * 可以在普通 Node 测试中验证；Canvas 解码部分通过注入的 renderer 完成，
 * UI 测试可以使用 mock processor。不新增 sharp/jimp 等图片依赖。
 */

import type { AgentAvatarState } from "../harness/memory/agent-identity-state";

export const AGENT_AVATAR_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_AVATAR_SOURCE_MAX_EDGE = 4096;
export const AGENT_AVATAR_OUTPUT_EDGE = 256;
export const AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS = 400_000;
/** WebP 导出质量；环境不支持 WebP 时回退 PNG。 */
export const AGENT_AVATAR_WEBP_QUALITY = 0.82;

export const AGENT_AVATAR_ACCEPTED_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

export type AvatarRejectionCode =
  | "unsupported_type"
  | "source_too_large"
  | "image_too_large"
  | "output_too_large"
  | "output_invalid"
  | "decode_failed";

export class AvatarProcessingError extends Error {
  readonly code: AvatarRejectionCode;
  constructor(code: AvatarRejectionCode) {
    super(`avatar_processing:${code}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Pure validation (Node-testable, no DOM)
// ---------------------------------------------------------------------------

/** 只接受 png/jpeg/webp；SVG/GIF/HEIC/BMP/PDF 等一律拒绝。 */
export function validateAvatarSourceType(type: string): boolean {
  return AGENT_AVATAR_ACCEPTED_TYPES.includes(type);
}

export function validateAvatarSourceSize(size: number): boolean {
  return Number.isFinite(size) && size > 0 && size <= AGENT_AVATAR_SOURCE_MAX_BYTES;
}

/** 处理结果必须是 256×256 的 webp/png Data URL，且不超持久化上限。 */
export function validateAvatarDataUrl(
  dataUrl: string
): { ok: true; mimeType: "image/webp" | "image/png" } | { ok: false; code: AvatarRejectionCode } {
  if (typeof dataUrl !== "string" || !dataUrl) return { ok: false, code: "output_invalid" };
  if (dataUrl.startsWith("data:image/webp;base64,")) {
    if (dataUrl.length > AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS) return { ok: false, code: "output_too_large" };
    return { ok: true, mimeType: "image/webp" };
  }
  if (dataUrl.startsWith("data:image/png;base64,")) {
    if (dataUrl.length > AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS) return { ok: false, code: "output_too_large" };
    return { ok: true, mimeType: "image/png" };
  }
  return { ok: false, code: "output_invalid" };
}

// ---------------------------------------------------------------------------
// Rendering port (Canvas 在浏览器实现；测试注入 fake)
// ---------------------------------------------------------------------------

export interface AvatarRenderResult {
  /** 原始图片尺寸（用于 4096px 上限检查）。 */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /**
   * 居中裁剪为正方形、缩放为 256×256、优先 WebP(0.82) 回退 PNG 后的
   * Data URL。所有 object URL 由实现方在 finally 中 revoke。
   */
  readonly dataUrl: string;
}

export type AvatarRenderer = (file: Blob) => Promise<AvatarRenderResult>;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * 校验 + 渲染 + 二次校验，产出可持久化的 custom 头像状态。
 * 任何一步失败都抛 AvatarProcessingError（含稳定 code），不落盘任何内容。
 */
export async function processAgentAvatar(
  file: Blob,
  type: string,
  size: number,
  renderer: AvatarRenderer
): Promise<Extract<AgentAvatarState, { kind: "custom" }>> {
  if (!validateAvatarSourceType(type)) throw new AvatarProcessingError("unsupported_type");
  if (!validateAvatarSourceSize(size)) throw new AvatarProcessingError("source_too_large");

  let rendered: AvatarRenderResult;
  try {
    rendered = await renderer(file);
  } catch (error) {
    if (error instanceof AvatarProcessingError) throw error;
    throw new AvatarProcessingError("decode_failed");
  }

  const maxEdge = Math.max(rendered.sourceWidth, rendered.sourceHeight);
  if (!Number.isFinite(maxEdge) || maxEdge > AGENT_AVATAR_SOURCE_MAX_EDGE) {
    throw new AvatarProcessingError("image_too_large");
  }

  const validated = validateAvatarDataUrl(rendered.dataUrl);
  if (!validated.ok) throw new AvatarProcessingError(validated.code);

  return Object.freeze({
    kind: "custom",
    mimeType: validated.mimeType,
    dataUrl: rendered.dataUrl,
    width: 256,
    height: 256
  });
}

// ---------------------------------------------------------------------------
// Browser renderer (Obsidian / Chromium)
// ---------------------------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("avatar_read_failed"));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 浏览器实现：createImageBitmap 解码 → 居中裁剪正方形 → 缩放 256×256 →
 * 优先 WebP(0.82)，环境不支持时回退 PNG。
 */
export function createBrowserAvatarRenderer(): AvatarRenderer {
  return async (file: Blob): Promise<AvatarRenderResult> => {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const sourceWidth = bitmap.width;
      const sourceHeight = bitmap.height;
      const cropEdge = Math.min(sourceWidth, sourceHeight);
      const cropX = Math.floor((sourceWidth - cropEdge) / 2);
      const cropY = Math.floor((sourceHeight - cropEdge) / 2);

      const canvas = document.createElement("canvas");
      canvas.width = AGENT_AVATAR_OUTPUT_EDGE;
      canvas.height = AGENT_AVATAR_OUTPUT_EDGE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("avatar_canvas_unavailable");
      context.drawImage(
        bitmap,
        cropX, cropY, cropEdge, cropEdge,
        0, 0, AGENT_AVATAR_OUTPUT_EDGE, AGENT_AVATAR_OUTPUT_EDGE
      );

      let blob = await canvasToBlob(canvas, "image/webp", AGENT_AVATAR_WEBP_QUALITY);
      // toBlob 对不支持的类型返回 null（部分环境不支持 WebP 编码）。
      if (!blob) blob = await canvasToBlob(canvas, "image/png");
      if (!blob) throw new Error("avatar_export_failed");

      const dataUrl = await blobToDataUrl(blob);
      return { sourceWidth, sourceHeight, dataUrl };
    } finally {
      bitmap?.close();
    }
  };
}
