import { Modal, type App } from "obsidian";
import type {
  KnowledgeInitializationAssignment,
  KnowledgeInitializationRole
} from "../knowledge-base/initializer";

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
  readonly roleLabel: (role: KnowledgeInitializationRole) => string;
  /** 确认后回传变更集合；未变化时不会调用。 */
  readonly onConfirm: (
    assignments: readonly KnowledgeInitializationAssignment[]
  ) => void | Promise<void>;
  /** 触发该 Modal 的「添加笔记」按钮；关闭后把焦点还给它。 */
  readonly triggerEl?: HTMLElement | null;
}

/**
 * 知识库初始化的多选笔记 Modal：
 * - 真实 checkbox 多选，整行 label 与 checkbox 同一点击区域；
 * - 勾选过程只在内存中更新，确认（选好了）才一次性回传；
 * - 取消或 Escape 零写入；关闭后焦点恢复到触发按钮。
 */
export class KnowledgeNotePickerModal extends Modal {
  private readonly checked = new Set<string>();
  private query = "";
  private searchEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private confirmEl: HTMLButtonElement | null = null;
  private confirmed = false;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(
    app: App,
    private readonly options: KnowledgeNotePickerOptions
  ) {
    super(app);
    for (const note of options.notes) {
      if (note.role === options.targetRole) this.checked.add(note.sourcePath);
    }
  }

  get selectedCount(): number {
    return this.checked.size;
  }

  onOpen(): void {
    const { zh, targetLabel } = this.options;
    this.modalEl.addClass("echoink-knowledge-note-picker");
    this.titleEl.setText(
      zh ? `添加笔记到 ${targetLabel}` : `Add notes to ${targetLabel}`
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
    const cancel = footer.createEl("button", {
      cls: "echoink-knowledge-note-picker-cancel",
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    cancel.onclick = () => this.close();
    this.confirmEl = footer.createEl("button", {
      cls: "mod-cta echoink-knowledge-note-picker-confirm",
      text: this.confirmLabel(),
      attr: { type: "button" }
    });
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
    if (!this.confirmed) {
      // 取消 / Escape：零写入，只恢复焦点。
      this.options.triggerEl?.focus();
      return;
    }
    this.options.triggerEl?.focus();
  }

  private confirmLabel(): string {
    return this.options.zh
      ? `选好了（${this.checked.size}）`
      : `Done (${this.checked.size})`;
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const { zh, notes, targetRole, targetLabel, roleLabel } = this.options;
    list.empty();
    const query = this.query.trim().toLocaleLowerCase();
    const visible = notes.filter((note) =>
      !query || note.sourcePath.toLocaleLowerCase().includes(query)
    );
    if (visible.length === 0) {
      list.createDiv({
        cls: "echoink-knowledge-note-picker-empty",
        text: zh ? "没有匹配的笔记。" : "No matching notes."
      });
      return;
    }
    for (const note of visible) {
      const row = list.createEl("label", { cls: "echoink-knowledge-note-picker-row" });
      const checkbox = row.createEl("input", {
        cls: "echoink-knowledge-note-picker-checkbox",
        attr: { type: "checkbox" }
      }) as HTMLInputElement;
      checkbox.checked = this.checked.has(note.sourcePath);
      const copy = row.createDiv({ cls: "echoink-knowledge-note-picker-copy" });
      copy.createDiv({
        cls: "echoink-knowledge-note-picker-path",
        text: note.sourcePath,
        attr: { title: note.sourcePath }
      });
      const badge = copy.createDiv({ cls: "echoink-knowledge-note-picker-badge" });
      const renderBadge = (): void => {
        const isChecked = this.checked.has(note.sourcePath);
        badge.setText(isChecked
          ? (note.role !== targetRole
              ? (zh ? `将移动到 ${targetLabel}` : `Moves to ${targetLabel}`)
              : "")
          : (note.role !== "raw" && note.role !== targetRole
              ? (zh ? `当前：${roleLabel(note.role)}` : `Now: ${roleLabel(note.role)}`)
              : ""));
      };
      renderBadge();
      checkbox.onchange = () => {
        if (checkbox.checked) this.checked.add(note.sourcePath);
        else this.checked.delete(note.sourcePath);
        renderBadge();
        if (this.confirmEl) this.confirmEl.setText(this.confirmLabel());
      };
    }
  }

  private async confirm(): Promise<void> {
    if (this.confirmed) return;
    const { targetRole, notes } = this.options;
    const assignments: KnowledgeInitializationAssignment[] = [];
    for (const note of notes) {
      const isChecked = this.checked.has(note.sourcePath);
      if (isChecked && note.role !== targetRole) {
        assignments.push({ sourcePath: note.sourcePath, role: targetRole });
      } else if (!isChecked && note.role === targetRole) {
        // 从当前目录取消勾选 → 回到默认 raw。
        assignments.push({ sourcePath: note.sourcePath, role: "raw" });
      }
    }
    this.confirmed = true;
    if (assignments.length > 0) await this.options.onConfirm(Object.freeze(assignments));
    this.close();
  }

  /** Tab 在 Modal 内循环，Escape 关闭（零写入）。 */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
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
