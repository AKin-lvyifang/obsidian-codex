import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizePath,
  Platform,
  TFile,
  type App
} from "obsidian";
import type { StoredAttachment } from "../../settings/settings";

export type EchoInkAttachmentAvailability = "available" | "unavailable";

export interface EchoInkAttachmentResourceView {
  readonly attachment: Readonly<StoredAttachment>;
  readonly displayName: string;
  readonly availability: EchoInkAttachmentAvailability;
  readonly resourceUri?: string;
  readonly vaultRelativePath?: string;
}

export interface EchoInkAttachmentResourceResolver {
  resolve(
    attachment: Readonly<StoredAttachment>,
    displayIndex?: number
  ): Readonly<EchoInkAttachmentResourceView>;
}

/** Shared resource resolver used by Composer and durable message attachments. */
export function createAttachmentResourceResolver(
  app: App,
  vaultPath: string
): EchoInkAttachmentResourceResolver {
  const normalizedVaultPath = normalizeAbsolutePath(vaultPath);
  return Object.freeze({
    resolve: (attachment, displayIndex = 0) => resolveAttachmentResource(
      app,
      normalizedVaultPath,
      attachment,
      displayIndex
    )
  });
}

export function attachmentDisplayName(
  attachment: Readonly<StoredAttachment>,
  displayIndex = 0
): string {
  const supplied = attachment.name.trim();
  const fallback = fileNameFromPath(attachment.path) || "附件";
  const name = supplied || fallback;
  if (!/^clipboard-[0-9]+-[0-9]+(?:\.[A-Za-z0-9]+)?$/u.test(name)) {
    return name;
  }
  const extension = fileExtension(name);
  const ordinal = Math.max(0, Math.trunc(displayIndex)) + 1;
  return `粘贴图片 ${ordinal}${extension ? `.${extension}` : ""}`;
}

function resolveAttachmentResource(
  app: App,
  vaultPath: string,
  attachment: Readonly<StoredAttachment>,
  displayIndex: number
): Readonly<EchoInkAttachmentResourceView> {
  const displayName = attachmentDisplayName(attachment, displayIndex);
  const base = {
    attachment: Object.freeze({ ...attachment }),
    displayName
  };
  const source = attachment.path.trim();
  if (!source || /^data:/iu.test(source)) {
    return Object.freeze({ ...base, availability: "unavailable" as const });
  }
  if (/^(?:blob:|https?:)/iu.test(source)) {
    return Object.freeze({
      ...base,
      availability: "available" as const,
      resourceUri: source
    });
  }

  const vaultRelativePath = toVaultRelativePath(source, vaultPath);
  if (vaultRelativePath) {
    const file = app.vault.getAbstractFileByPath(vaultRelativePath);
    if (file instanceof TFile) {
      return Object.freeze({
        ...base,
        availability: "available" as const,
        resourceUri: app.vault.getResourcePath(file),
        vaultRelativePath
      });
    }
    return Object.freeze({
      ...base,
      availability: "unavailable" as const,
      vaultRelativePath
    });
  }

  if (/^file:/iu.test(source)) {
    const localPath = localPathFromFileUri(source);
    const available = Boolean(
      Platform.isDesktopApp
      && localPath
      && existsSync(localPath)
    );
    return Object.freeze({
      ...base,
      availability: available ? "available" as const : "unavailable" as const,
      ...(available ? { resourceUri: source } : {})
    });
  }
  if (isAbsolutePath(source) && Platform.isDesktopApp) {
    if (!existsSync(source)) {
      return Object.freeze({ ...base, availability: "unavailable" as const });
    }
    return Object.freeze({
      ...base,
      availability: "available" as const,
      resourceUri: localFileUri(source)
    });
  }
  return Object.freeze({ ...base, availability: "unavailable" as const });
}

function toVaultRelativePath(source: string, vaultPath: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) return null;
  const normalizedSource = normalizeAbsolutePath(source);
  if (!isAbsolutePath(normalizedSource)) {
    const relative = normalizePath(normalizedSource.replace(/^\/+/, ""));
    return relative || null;
  }
  if (!vaultPath) return null;
  if (normalizedSource === vaultPath) return null;
  const prefix = `${vaultPath}/`;
  if (!normalizedSource.startsWith(prefix)) return null;
  const relative = normalizePath(normalizedSource.slice(prefix.length));
  return relative || null;
}

function normalizeAbsolutePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function localFileUri(filePath: string): string {
  const encoded = encodeURI(filePath).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
  return `file://${encoded}`;
}

function localPathFromFileUri(source: string): string | null {
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

function fileNameFromPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).trim();
}

function fileExtension(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot > 0 ? value.slice(dot + 1).toLowerCase() : "";
}
