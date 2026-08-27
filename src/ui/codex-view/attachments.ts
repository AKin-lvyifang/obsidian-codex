import { Notice, TFile, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { extractClipboardImageFiles, saveClipboardImageAttachments } from "../../core/clipboard-images";
import { openPathInElectron } from "../../core/electron";
import { normalizeProcessFileRef } from "../../core/mapping";
import type { StoredAttachment } from "../../settings/settings";
import type { EchoInkResource } from "../../resources/types";
import { renderComposerAttachments } from "./composer";
import { createAttachmentResourceResolver } from "./attachment-resource";
import { absoluteVaultPath, isImagePath } from "./workspace-utils";
import {
  addComposerNoteMentionSelection,
  composerNoteMentionSelections,
  removeComposerNoteMentionSelection
} from "./note-mentions";
import {
  PI_DOCUMENT_ACCEPT,
  piDocumentKindForAttachment
} from "./pi-document-input";

export interface CodexAttachmentHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  attachmentsEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  attachments: StoredAttachment[];
  selectedSkill: EchoInkResource | null;
  renderToolbar(): void;
  renderAttachments(): void;
  runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void>;
}

export function renderAttachmentsView(host: CodexAttachmentHost): void {
  if (!host.attachmentsEl) return;
  renderComposerAttachments(host.attachmentsEl, {
    selectedSkill: host.selectedSkill,
    noteMentions: composerNoteMentionSelections(host.inputEl),
    attachments: host.attachments,
    attachmentResolver: createAttachmentResourceResolver(
      host.app,
      host.plugin.getVaultPath()
    )
  }, {
    onRemoveSkill: () => {
      host.selectedSkill = null;
      host.renderAttachments();
      host.renderToolbar();
    },
    onRemoveNoteMention: (vaultRelativePath) => {
      removeComposerNoteMentionSelection(host.inputEl, vaultRelativePath);
      host.renderAttachments();
      host.renderToolbar();
    },
    onRemoveAttachment: (attachmentPath) => {
      host.attachments = host.attachments.filter((attachment) => attachment.path !== attachmentPath);
      host.renderAttachments();
    },
    onOpenAttachment: (attachment) => {
      void openComposerAttachment(host, attachment);
    }
  });
}

export async function openComposerAttachment(
  host: CodexAttachmentHost,
  attachment: Readonly<StoredAttachment>
): Promise<void> {
  const ref = normalizeProcessFileRef(attachment.path, host.plugin.getVaultPath());
  if (!ref.openable) {
    new Notice("这个文件路径无法打开");
    return;
  }
  const absolutePath = ref.absolutePath
    ?? (ref.kind === "vault"
      ? absoluteVaultPath(host.plugin.getVaultPath(), ref.path)
      : ref.kind === "external" ? ref.path : "");
  if (await openPathInElectron(absolutePath)) return;
  new Notice(`无法使用系统默认应用打开：${ref.displayPath}`);
}

export function attachActiveFile(host: CodexAttachmentHost): void {
  const file = currentDisplayedMarkdownFile(host.app);
  if (!file) {
    new Notice("没有当前笔记");
    return;
  }
  addComposerNoteMentionSelection(host.inputEl, {
    vaultRelativePath: file.path,
    fileName: file.name
  });
  host.renderAttachments();
  host.renderToolbar();
}

export function currentDisplayedMarkdownFile(app: App): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile || !/\.md$/iu.test(activeFile.path)) return null;
  const displayed = app.workspace.getLeavesOfType("markdown").some((leaf) => {
    const view = leaf.view as typeof leaf.view & Readonly<{
      file?: TFile | null;
      containerEl?: HTMLElement;
    }>;
    if (view.file?.path !== activeFile.path) return false;
    const container = view.containerEl as (HTMLElement & { isShown?: () => boolean }) | undefined;
    return container?.isShown ? container.isShown() : Boolean(container?.isConnected);
  });
  return displayed ? activeFile : null;
}

export function pickFiles(host: CodexAttachmentHost, imagesOnly: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = imagesOnly
    ? "image/*"
    : `image/*,${PI_DOCUMENT_ACCEPT}`;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      appendPiChatFile(host, file);
    }
    host.renderAttachments();
  };
  input.click();
}

export function pickKnowledgeBaseFiles(host: CodexAttachmentHost): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    const attachments: StoredAttachment[] = [];
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) continue;
      attachments.push({
        type: "file",
        name: file.name,
        path: filePath
      });
    }
    void host.runKnowledgeBaseShortcut("文件收藏", async () => {
      const paths = await host.plugin.getKnowledgeSurfaceService()?.captureExternalFiles(attachments);
      return paths?.length ? `已收藏文件：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未选择文件。";
    });
  };
  input.click();
}

export function handleDroppedFiles(host: CodexAttachmentHost, event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    appendPiChatFile(host, file);
  }
  host.renderAttachments();
}

function appendPiChatFile(host: CodexAttachmentHost, file: File): void {
  const filePath = (file as File & { path?: string }).path;
  if (!filePath) {
    new Notice(`无法读取附件“${file.name || "未命名文件"}”的本地路径。`);
    return;
  }
  const type = classifyLocalAttachmentType(filePath, file.type);
  const attachment: StoredAttachment = {
    type,
    name: file.name,
    path: filePath,
    ...(file.type ? { mimeType: file.type } : {}),
    sizeBytes: file.size,
    availability: "available"
  };
  if (type === "file" && !piDocumentKindForAttachment(attachment)) {
    new Notice(
      `不支持附件“${file.name}”。普通 Pi Chat 仅支持 PDF、Word、Markdown、HTML 和图片。`
    );
    return;
  }
  host.attachments.push(attachment);
}

export function classifyLocalAttachmentType(
  filePath: string,
  mimeType?: string
): StoredAttachment["type"] {
  const normalizedMimeType = mimeType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const imageMimeType = Boolean(
    normalizedMimeType
    && normalizedMimeType.startsWith("image/")
    && normalizedMimeType.length > "image/".length
  );
  return imageMimeType || isImagePath(filePath) || /\.heif$/iu.test(filePath)
    ? "image"
    : "file";
}

export async function handlePastedFiles(host: CodexAttachmentHost, event: ClipboardEvent): Promise<void> {
  const files = extractClipboardImageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  try {
    const pasted = await saveClipboardImageAttachments(files, { vaultPath: host.plugin.getVaultPath(), pluginDir: host.plugin.getPluginDataDirName() });
    host.attachments.push(...pasted);
    host.renderAttachments();
  } catch (error) {
    console.error("Codex paste image failed", error);
    new Notice("粘贴图片失败");
  }
}
