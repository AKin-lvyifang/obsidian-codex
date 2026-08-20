/**
 * agent-identity-modal.ts — 「给你的 Agent 起个名字」/ 身份编辑弹窗。
 *
 * 首次选择人格模板后必须经过这里确认名字；取消时零写入（调用方在确认前
 * 根本不会调用 selectPersonalityTemplate）。基础设置中的「编辑身份」
 * 复用同一个弹窗，保存时调用 CognitiveSystem.updateAgentIdentity()。
 */

import { Modal, Notice } from "obsidian";
import {
  AGENT_DISPLAY_NAME_MAX_CHARS,
  countUnicodeChars,
  normalizeAgentDisplayName,
  type AgentAvatarState
} from "../harness/memory/agent-identity-state";
import {
  processAgentAvatar,
  AvatarProcessingError,
  createBrowserAvatarRenderer,
  type AvatarRenderer
} from "./agent-avatar-processor";
import {
  resolveAgentAvatarUrl,
  type AgentAvatarPreset
} from "./agent-avatar-presets";

export interface AgentIdentityDraft {
  readonly displayName: string;
  readonly avatar: AgentAvatarState;
}

export interface AgentIdentityModalOptions {
  readonly initialName: string;
  readonly initialAvatar: AgentAvatarState;
  readonly language: "zh" | "en";
  /** first-run = 首次命名（完成设置）；edit = 设置页修改（保存）。 */
  readonly mode: "first-run" | "edit";
  readonly presets?: readonly AgentAvatarPreset[];
  /** 测试注入：文件 → custom 头像状态。默认使用浏览器 Canvas 渲染器。 */
  readonly avatarRenderer?: AvatarRenderer;
  /** preset 资源解析；解析失败回退默认 bot 图标。 */
  readonly resolvePresetAsset?: (presetId: string) => string | null;
  readonly onConfirm: (draft: AgentIdentityDraft) => Promise<void>;
}

export class AgentIdentityModal extends Modal {
  private readonly options: AgentIdentityModalOptions;
  private nameValue: string;
  private avatarValue: AgentAvatarState;
  private nameInputEl: HTMLInputElement | null = null;
  private nameErrorEl: HTMLElement | null = null;
  private confirmButtonEl: HTMLButtonElement | null = null;
  private previewEl: HTMLElement | null = null;
  private presetListEl: HTMLElement | null = null;
  private busy = false;

  constructor(app: unknown, options: AgentIdentityModalOptions) {
    super(app as never);
    this.options = options;
    this.nameValue = options.initialName;
    this.avatarValue = options.initialAvatar;
  }

  onOpen(): void {
    const zh = this.options.language !== "en";
    const content = this.contentEl;
    content.empty();
    content.addClass("echoink-agent-identity-modal");

    content.createEl("h2", {
      text: zh ? "给你的 Agent 起个名字" : "Name your Agent"
    });
    content.createDiv({
      cls: "echoink-agent-identity-modal-desc",
      text: this.options.mode === "first-run"
        ? (zh
            ? "这个名称和头像会显示在 Agent 的回复旁。以后可以在「基础设置 → 身份与用户画像」中修改。"
            : "This name and avatar appear next to the Agent's replies. You can change them later in Settings → Identity and user profile.")
        : (zh
            ? "修改身份不会重置人格或 Memory。"
            : "Changing identity does not reset personality or Memory.")
    });

    // --- Name field ---------------------------------------------------------
    const nameField = content.createDiv({ cls: "echoink-agent-identity-field" });
    nameField.createDiv({ cls: "echoink-agent-identity-label", text: zh ? "Agent 名称" : "Agent name" });
    this.nameInputEl = nameField.createEl("input", {
      type: "text",
      attr: {
        placeholder: zh ? "例如：小墨" : "e.g. Xiaomo",
        maxlength: String(AGENT_DISPLAY_NAME_MAX_CHARS * 4)
      }
    }) as unknown as HTMLInputElement;
    this.nameInputEl.value = this.nameValue;
    this.nameErrorEl = nameField.createDiv({ cls: "echoink-agent-identity-error" });
    this.nameInputEl.addEventListener("input", () => {
      this.nameValue = this.nameInputEl?.value ?? "";
      this.refreshConfirmState();
    });

    // --- Avatar area --------------------------------------------------------
    const avatarArea = content.createDiv({ cls: "echoink-agent-identity-avatar-area" });
    this.previewEl = avatarArea.createDiv({ cls: "echoink-agent-identity-modal-preview" });
    this.renderPreview();

    const avatarActions = avatarArea.createDiv({ cls: "echoink-agent-identity-avatar-actions" });
    const uploadButton = avatarActions.createEl("button", {
      type: "button",
      cls: "echoink-agent-identity-upload",
      text: zh ? "上传头像" : "Upload avatar"
    });
    const fileInput = avatarArea.createEl("input", {
      type: "file",
      cls: "echoink-agent-identity-file",
      attr: { accept: "image/png,image/jpeg,image/webp" }
    }) as unknown as HTMLInputElement;
    uploadButton.addEventListener("click", () => {
      (fileInput as unknown as { click?: () => void }).click?.();
    });
    fileInput.addEventListener("change", () => {
      void this.handleFilePicked(fileInput);
    });
    const removeButton = avatarActions.createEl("button", {
      type: "button",
      cls: "echoink-agent-identity-remove",
      text: zh ? "移除头像" : "Remove avatar"
    });
    removeButton.addEventListener("click", () => {
      this.avatarValue = Object.freeze({ kind: "default" });
      this.renderPreview();
    });

    // --- Preset list (hidden entirely when the catalog is empty) ------------
    const presets = this.options.presets ?? [];
    if (presets.length > 0) {
      this.presetListEl = content.createDiv({ cls: "echoink-agent-avatar-preset-list" });
      this.presetListEl.createDiv({
        cls: "echoink-agent-identity-label",
        text: zh ? "选择头像" : "Choose an avatar"
      });
      for (const preset of presets) {
        const chip = this.presetListEl.createDiv({ cls: "echoink-agent-avatar-preset" });
        chip.setAttr("data-preset-id", preset.id);
        chip.setText(zh ? preset.labelZh : preset.labelEn);
        chip.addEventListener("click", () => {
          this.avatarValue = Object.freeze({ kind: "preset", presetId: preset.id });
          this.renderPreview();
        });
      }
    }

    // --- Footer --------------------------------------------------------------
    const footer = content.createDiv({ cls: "echoink-agent-identity-footer" });
    const cancelButton = footer.createEl("button", {
      type: "button",
      cls: "echoink-agent-identity-cancel",
      text: zh ? "取消" : "Cancel"
    });
    cancelButton.addEventListener("click", () => this.close());
    this.confirmButtonEl = footer.createEl("button", {
      type: "button",
      cls: "echoink-agent-identity-confirm mod-cta",
      text: this.options.mode === "first-run"
        ? (zh ? "完成设置" : "Finish setup")
        : (zh ? "保存" : "Save")
    }) as unknown as HTMLButtonElement;
    this.confirmButtonEl.addEventListener("click", () => {
      void this.handleConfirm();
    });

    this.refreshConfirmState();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // Internals (public enough for UI tests)
  // -------------------------------------------------------------------------

  nameValidationError(): string | null {
    const zh = this.options.language !== "en";
    const trimmed = this.nameValue.trim();
    if (!trimmed) return zh ? "请输入名称。" : "Please enter a name.";
    if (countUnicodeChars(trimmed) > AGENT_DISPLAY_NAME_MAX_CHARS) {
      return zh
        ? `名称不能超过 ${AGENT_DISPLAY_NAME_MAX_CHARS} 个字符。`
        : `The name must be at most ${AGENT_DISPLAY_NAME_MAX_CHARS} characters.`;
    }
    if (!normalizeAgentDisplayName(this.nameValue)) {
      return zh ? "名称不能包含换行或制表符。" : "The name cannot contain newlines or tabs.";
    }
    return null;
  }

  currentDraft(): AgentIdentityDraft {
    return Object.freeze({
      displayName: this.nameValue.trim(),
      avatar: this.avatarValue
    });
  }

  private refreshConfirmState(): void {
    const error = this.nameValidationError();
    if (this.nameErrorEl) this.nameErrorEl.setText(error ?? "");
    if (this.confirmButtonEl) {
      this.confirmButtonEl.disabled = Boolean(error) || this.busy;
    }
  }

  private renderPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    const url = this.avatarValue.kind === "preset"
      ? (this.options.resolvePresetAsset?.(this.avatarValue.presetId) ?? null)
      : resolveAgentAvatarUrl(this.avatarValue);
    if (url) {
      this.previewEl.createEl("img", { attr: { src: url, alt: "" } });
    } else {
      // 没有头像（或 preset 解析失败）时显示默认 bot 占位。
      this.previewEl.addClass("is-default");
      this.previewEl.setText("🤖");
    }
    if (this.presetListEl) {
      const selectedId = this.avatarValue.kind === "preset" ? this.avatarValue.presetId : null;
      const chips = this.presetListEl.querySelectorAll<HTMLElement>(".echoink-agent-avatar-preset");
      chips.forEach((chip) => {
        const id = chip.getAttribute("data-preset-id");
        (chip as unknown as { toggleClass: (cls: string, on: boolean) => void })
          .toggleClass("is-selected", id !== null && id === selectedId);
      });
    }
  }

  private async handleFilePicked(fileInput: HTMLInputElement): Promise<void> {
    const zh = this.options.language !== "en";
    const files = (fileInput as unknown as { files?: FileList | null }).files;
    const file = files && files.length > 0 ? files[0] : null;
    if (!file) return;
    const renderer = this.options.avatarRenderer ?? createBrowserAvatarRenderer();
    try {
      const avatar = await processAgentAvatar(
        file as unknown as Blob,
        file.type,
        file.size,
        renderer
      );
      this.avatarValue = avatar;
      this.renderPreview();
    } catch (error) {
      const code = error instanceof AvatarProcessingError ? error.code : "decode_failed";
      const message = avatarErrorMessage(code, zh);
      new Notice(message);
      if (this.nameErrorEl && !this.nameValidationError()) {
        // 上传错误不占用名称错误行；Notice 已提示。
      }
    } finally {
      (fileInput as unknown as { value: string }).value = "";
    }
  }

  private async handleConfirm(): Promise<void> {
    if (this.busy) return;
    if (this.nameValidationError()) {
      this.refreshConfirmState();
      return;
    }
    this.busy = true;
    this.refreshConfirmState();
    try {
      await this.options.onConfirm(this.currentDraft());
      this.close();
    } catch (error) {
      const zh = this.options.language !== "en";
      const message = error instanceof Error && error.message === "agent_identity_invalid_name"
        ? (zh ? "名称无效，请检查后重试。" : "Invalid name. Please check and retry.")
        : (zh ? "身份保存失败，请重试。" : "Failed to save identity. Please retry.");
      new Notice(message);
    } finally {
      this.busy = false;
      this.refreshConfirmState();
    }
  }
}

function avatarErrorMessage(code: string, zh: boolean): string {
  switch (code) {
    case "unsupported_type":
      return zh ? "只支持 PNG、JPEG 或 WebP 图片。" : "Only PNG, JPEG or WebP images are supported.";
    case "source_too_large":
      return zh ? "图片文件不能超过 4MB。" : "The image file must be under 4MB.";
    case "image_too_large":
      return zh ? "图片尺寸过大（任一边不能超过 4096px）。" : "The image is too large (max 4096px per edge).";
    case "output_too_large":
      return zh ? "处理后的头像仍然过大，请换一张图片。" : "The processed avatar is still too large. Try another image.";
    default:
      return zh ? "头像处理失败，请换一张图片。" : "Failed to process the avatar. Try another image.";
  }
}
