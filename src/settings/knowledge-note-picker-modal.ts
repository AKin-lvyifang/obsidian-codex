import { Modal, type App } from "obsidian";
import type {
  KnowledgeInitializationAssignment,
  KnowledgeInitializationRole
} from "../knowledge-base/initializer";
import { applyAmicroButton } from "./amicro-buttons";

export interface KnowledgeNotePickerNote {
  readonly sourcePath: string;
  readonly role: KnowledgeInitializationRole;
}

export interface KnowledgeNotePickerOptions {
  readonly zh: boolean;
  /** 本次「添加笔记」的目标目录角色。 */
  readonly targetRole: Exclude<KnowledgeInitializationRole, "keep">;
  readonly targetLabel: string;
  /** 当前 preview 中全部可分配笔记（keep 等遗留状态由调用方过滤）。 */
  readonly notes: readonly KnowledgeNotePickerNote[];
  /**
   * 确认后回传变更集合；未变化时不会调用。
   * 抛错 = 保存失败：Modal 保持打开、不锁死、显示内联错误，允许再次提交。
   */
  readonly onConfirm: (
    assignments: readonly KnowledgeInitializationAssignment[]
  ) => void | Promise<void>;
  /** 触发该 Modal 的「添加笔记」按钮；仅在未提供 restoreFocus 时使用。 */
  readonly triggerEl?: HTMLElement | null;
  /**
   * 稳定的焦点恢复回调。目录列表提交后会被重建，旧 triggerEl 可能脱离 DOM；
   * 调用方应在这里按 role 重新找到重建后的按钮，并只在 isConnected 时 focus。
   * 取消、Escape、提交成功、提交失败后取消四条路径都会走这里。
   */
  readonly restoreFocus?: () => void;
}

const KNOWLEDGE_NOTE_NAME_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

export function sortKnowledgeNotePickerNotes(
  notes: readonly KnowledgeNotePickerNote[]
): KnowledgeNotePickerNote[] {
  return [...notes].sort((left, right) => {
    const leftName = left.sourcePath.split("/").at(-1) ?? left.sourcePath;
    const rightName = right.sourcePath.split("/").at(-1) ?? right.sourcePath;
    return KNOWLEDGE_NOTE_NAME_COLLATOR.compare(leftName, rightName)
      || KNOWLEDGE_NOTE_NAME_COLLATOR.compare(left.sourcePath, right.sourcePath);
  });
}

/**
 * 知识库初始化的多选笔记 Modal：
 * - 真实 checkbox 多选，整行 label 与 checkbox 同一点击区域；
 * - 勾选过程只在内存中更新，确认（选好了）才一次性回传；
 * - 取消或 Escape 零写入；关闭后焦点恢复到触发按钮；
 * - 提交期间防重复提交；onConfirm 抛错时保持打开并显示内联错误。
 *
 * targetRole === "raw" 时语义为「把其他目录的笔记移回 Raw」：
 * 已在 Raw 的笔记显示为不可编辑的「已在 Raw」，不允许取消勾选后
 * 确认时再静默分配回 Raw。
 */
export class KnowledgeNotePickerModal extends Modal {
  private readonly notes: readonly KnowledgeNotePickerNote[];
  private readonly checked = new Set<string>();
  private query = "";
  private searchEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private confirmEl: HTMLButtonElement | null = null;
  private cancelEl: HTMLButtonElement | null = null;
  private errorEl: HTMLElement | null = null;
  private confirmed = false;
  private submitting = false;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(
    app: App,
    private readonly options: KnowledgeNotePickerOptions
  ) {
    super(app);
    this.notes = Object.freeze(sortKnowledgeNotePickerNotes(options.notes));
    // Raw 目标是「移回 Raw」：没有预勾选；其他目录预勾选当前已在该目录的笔记。
    if (options.targetRole !== "raw") {
      for (const note of this.notes) {
        if (note.role === options.targetRole) this.checked.add(note.sourcePath);
      }
    }
  }

  get selectedCount(): number {
    return this.checked.size;
  }

  /** 测试与调用方可读取：onConfirm 成功后才为 true。 */
  get wasConfirmed(): boolean {
    return this.confirmed;
  }

  get isSubmitting(): boolean {
    return this.submitting;
  }

  onOpen(): void {
    const { zh, targetLabel, targetRole } = this.options;
    this.modalEl.addClass("echoink-knowledge-note-picker");
    this.titleEl.setText(
      targetRole === "raw"
        ? (zh ? "移回 Raw" : "Move notes back to Raw")
        : (zh ? `添加笔记到 ${targetLabel}` : `Add notes to ${targetLabel}`)
    );
    const body = this.contentEl.createDiv({ cls: "echoink-knowledge-note-picker-body" });
    this.searchEl = body.createEl("input", {
      cls: "echoink-knowledge-note-picker-search",
      attr: {
        type: "search",
        placeholder: zh ? "搜索 Vault 中的 Markdown" : "Search Markdown in the Vault",
        "aria-label": zh ? "搜索可分配的笔记" : "Search assignable notes"
      }
    });
    this.searchEl.oninput = () => {
      this.query = this.searchEl?.value ?? "";
      this.renderList();
    };
    this.listEl = body.createDiv({
      cls: "echoink-knowledge-note-picker-list",
      attr: { role: "group", "aria-label": zh ? "可分配的笔记" : "Assignable notes" }
    });
    this.renderList();
    const footer = this.contentEl.createDiv({ cls: "echoink-knowledge-note-picker-footer" });
    this.errorEl = footer.createDiv({
      cls: "echoink-knowledge-note-picker-error",
      attr: { role: "alert", "aria-live": "assertive" }
    });
    this.cancelEl = footer.createEl("button", {
      cls: "echoink-knowledge-note-picker-cancel",
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    applyAmicroButton(this.cancelEl, { variant: "secondary" });
    this.cancelEl.onclick = () => this.close();
    this.confirmEl = footer.createEl("button", {
      cls: "mod-cta echoink-knowledge-note-picker-confirm",
      text: this.confirmLabel(),
      attr: { type: "button" }
    });
    applyAmicroButton(this.confirmEl, { variant: "primary", motion: "complete" });
    this.confirmEl.onclick = () => void this.confirm();
    this.keydownHandler = (event) => this.handleKeydown(event);
    this.modalEl.addEventListener("keydown", this.keydownHandler as EventListener);
    this.searchEl.focus();
  }

  onClose(): void {
    if (this.keydownHandler) {
      this.modalEl.removeEventListener("keydown", this.keydownHandler as EventListener);
      this.keydownHandler = null;
    }
    // 取消 / Escape / 提交成功 / 提交失败后再取消：统一走稳定的焦点恢复。
    this.restoreTriggerFocus();
  }

  private restoreTriggerFocus(): void {
    if (this.options.restoreFocus) {
      this.options.restoreFocus();
      return;
    }
    const trigger = this.options.triggerEl;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  private confirmLabel(): string {
    const { zh, targetRole } = this.options;
    if (targetRole === "raw") {
      return zh ? `移回 Raw（${this.checked.size}）` : `Move to Raw (${this.checked.size})`;
    }
    return zh
      ? `选好了（${this.checked.size}）`
      : `Done (${this.checked.size})`;
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const { zh, targetRole } = this.options;
    const rawTarget = targetRole === "raw";
    list.empty();
    const query = this.query.trim().toLocaleLowerCase();
    const visible = this.notes.filter((note) =>
      !query || note.sourcePath.toLocaleLowerCase().includes(query)
    );
    if (visible.length === 0) {
      list.createDiv({
        cls: "echoink-knowledge-note-picker-empty",
        text: query
          ? (zh ? "没有匹配的笔记。" : "No matching notes.")
          : (zh
              ? "Vault 中还没有可分配的 Markdown 笔记。"
              : "There are no assignable Markdown notes in this Vault yet.")
      });
      return;
    }
    for (const note of visible) {
      // Raw 目标：已在 Raw 的笔记只读展示，不参与勾选，避免「取消勾选后
      // 确认时又静默分配回 Raw」的无效交互。
      if (rawTarget && note.role === "raw") {
        const readonlyRow = list.createDiv({
          cls: "echoink-knowledge-note-picker-row is-readonly"
        });
        const readonlyCopy = readonlyRow.createDiv({ cls: "echoink-knowledge-note-picker-copy" });
        readonlyCopy.createDiv({
          cls: "echoink-knowledge-note-picker-path",
          text: note.sourcePath,
          attr: { title: note.sourcePath }
        });
        readonlyCopy.createDiv({
          cls: "echoink-knowledge-note-picker-badge",
          text: zh ? "已在 Raw" : "Already in Raw"
        });
        continue;
      }
      const row = list.createEl("label", { cls: "echoink-knowledge-note-picker-row" });
      const copy = row.createDiv({ cls: "echoink-knowledge-note-picker-copy" });
      copy.createDiv({
        cls: "echoink-knowledge-note-picker-path",
        text: note.sourcePath,
        attr: { title: note.sourcePath }
      });
      const checkbox = row.createEl("input", {
        cls: "echoink-knowledge-note-picker-checkbox",
        attr: { type: "checkbox" }
      }) as HTMLInputElement;
      checkbox.checked = this.checked.has(note.sourcePath);
      checkbox.onchange = () => {
        if (checkbox.checked) this.checked.add(note.sourcePath);
        else this.checked.delete(note.sourcePath);
        if (this.confirmEl && !this.submitting) this.confirmEl.setText(this.confirmLabel());
      };
    }
  }

  private collectAssignments(): KnowledgeInitializationAssignment[] {
    const { targetRole } = this.options;
    const assignments: KnowledgeInitializationAssignment[] = [];
    for (const note of this.notes) {
      const isChecked = this.checked.has(note.sourcePath);
      if (targetRole === "raw") {
        // 移回 Raw：只有被勾选且当前不在 Raw 的笔记产生写入。
        if (isChecked && note.role !== "raw") {
          assignments.push({ sourcePath: note.sourcePath, role: "raw" });
        }
        continue;
      }
      if (isChecked && note.role !== targetRole) {
        assignments.push({ sourcePath: note.sourcePath, role: targetRole });
      } else if (!isChecked && note.role === targetRole) {
        // 从当前目录取消勾选 → 回到默认 raw。
        assignments.push({ sourcePath: note.sourcePath, role: "raw" });
      }
    }
    return assignments;
  }

  private setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
    if (this.confirmEl) {
      this.confirmEl.disabled = submitting;
      this.confirmEl.setText(
        submitting
          ? (this.options.zh ? "正在保存…" : "Saving…")
          : this.confirmLabel()
      );
    }
    if (this.cancelEl) this.cancelEl.disabled = submitting;
  }

  private showError(message: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message);
  }

  private clearError(): void {
    this.errorEl?.setText("");
  }

  private async confirm(): Promise<void> {
    if (this.confirmed || this.submitting) return;
    const assignments = this.collectAssignments();
    this.setSubmitting(true);
    this.clearError();
    try {
      if (assignments.length > 0) await this.options.onConfirm(Object.freeze(assignments));
      // 只有 onConfirm 成功后才允许关闭；失败时 confirmed 保持 false。
      this.confirmed = true;
      this.close();
    } catch (error) {
      // 保持 Modal 打开、恢复按钮、显示内联错误，允许再次点击。
      this.setSubmitting(false);
      this.showError(
        this.options.zh
          ? "没有保存成功，请再试一次。"
          : "Changes weren't saved. Try again."
      );
    }
  }

  /** Tab 在 Modal 内循环，Escape 关闭（零写入）。 */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.submitting) return;
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = this.focusables();
    if (focusables.length === 0) return;
    const active = this.modalEl.ownerDocument?.activeElement ?? null;
    const index = focusables.indexOf(active as HTMLElement);
    const shift = (event as KeyboardEvent).shiftKey;
    let next: HTMLElement;
    if (index === -1) next = focusables[0] as HTMLElement;
    else if (shift) next = focusables[(index - 1 + focusables.length) % focusables.length] as HTMLElement;
    else next = focusables[(index + 1) % focusables.length] as HTMLElement;
    event.preventDefault();
    next.focus();
  }

  private focusables(): HTMLElement[] {
    const list = this.listEl;
    const focusables: HTMLElement[] = [];
    if (this.searchEl) focusables.push(this.searchEl);
    if (list) {
      list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
        .forEach((checkbox) => focusables.push(checkbox));
    }
    const cancel = this.modalEl.querySelector(".echoink-knowledge-note-picker-cancel");
    if (cancel) focusables.push(cancel as HTMLElement);
    if (this.confirmEl) focusables.push(this.confirmEl);
    return focusables;
  }
}
