import { setIcon } from "obsidian";
import type { StoredAttachment } from "../../settings/settings";
import {
  attachmentPresentationIcon,
  attachmentPresentationKind,
  type EchoInkAttachmentAvailability
} from "./attachment-resource";

export type EchoInkFileCardVariant = "compact" | "message";

export interface EchoInkFileCardOptions {
  readonly attachment: Readonly<StoredAttachment>;
  readonly displayName: string;
  readonly variant: EchoInkFileCardVariant;
  readonly availability: EchoInkAttachmentAvailability;
  readonly onOpen: () => void;
  readonly onRemove?: () => void;
}

export function renderFileCard(
  container: HTMLElement,
  options: EchoInkFileCardOptions
): HTMLElement {
  const kind = attachmentPresentationKind(options.attachment);
  const available = options.availability === "available";
  const root = container.createDiv({
    cls: `codex-file-card codex-file-card-${options.variant}`,
    attr: {
      "data-attachment-kind": kind,
      title: available
        ? options.displayName
        : `${options.displayName} · 文件不可用`
    }
  });
  root.toggleClass("is-unavailable", !available);

  const open = root.createEl("button", {
    cls: "codex-file-card-open",
    attr: {
      type: "button",
      "aria-label": available
        ? `打开附件：${options.displayName}`
        : `附件不可用：${options.displayName}`
    }
  });
  open.disabled = !available;
  open.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onOpen();
  };

  const iconShell = open.createSpan({
    cls: "codex-file-card-icon-shell",
    attr: { "aria-hidden": "true" }
  });
  const icon = iconShell.createSpan({ cls: "codex-file-card-icon" });
  setIcon(icon, attachmentPresentationIcon(options.attachment));
  iconShell.createSpan({
    cls: "codex-file-card-type",
    text: fileCardTypeLabel(options.attachment)
  });

  const copy = open.createSpan({ cls: "codex-file-card-copy" });
  copy.createSpan({
    cls: "codex-file-card-name",
    text: options.displayName
  });
  copy.createSpan({
    cls: "codex-file-card-meta",
    text: available
      ? formatFileSize(options.attachment.sizeBytes)
      : `${formatFileSize(options.attachment.sizeBytes)} · 文件不可用`
  });

  if (options.onRemove) {
    const remove = root.createEl("button", {
      cls: "codex-file-card-remove",
      attr: {
        type: "button",
        "aria-label": `移除文件：${options.displayName}`,
        title: `移除 ${options.displayName}`
      }
    });
    setIcon(remove, "x");
    remove.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onRemove?.();
    };
  }
  return root;
}

export function formatFileSize(sizeBytes: number | undefined): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes === undefined || sizeBytes < 0) {
    return "大小未知";
  }
  if (sizeBytes < 1024) return `${Math.trunc(sizeBytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = value >= 10 ? 0 : 1;
  return `${value.toFixed(fractionDigits).replace(/\.0$/u, "")} ${units[unitIndex]}`;
}

function fileCardTypeLabel(attachment: Readonly<StoredAttachment>): string {
  const source = attachment.name.trim() || attachment.path.trim();
  const match = source.match(/\.([^.\\/]+)$/u);
  const extension = match?.[1]?.toUpperCase();
  return extension && extension.length <= 8 ? extension : "FILE";
}
