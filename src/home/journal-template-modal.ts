import { Modal, Notice, TFile, type App } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  decodeImportedMarkdown,
  type ImportedJournalTemplate
} from "./home-workbench-model";
import {
  HomeWorkbenchDataService,
  type HomeCustomTemplateSummary,
  type HomeJournalTemplateChoice
} from "./home-workbench-data";

interface JournalTemplateModalOptions {
  service: HomeWorkbenchDataService;
  customTemplates: HomeCustomTemplateSummary[];
  date: Date;
  onCreated?: (file: TFile) => void;
}

export class JournalTemplateModal extends Modal {
  private selected: HomeJournalTemplateChoice = {
    kind: "built-in",
    template: BUILT_IN_JOURNAL_TEMPLATES.find((template) => template.id === DEFAULT_JOURNAL_TEMPLATE_ID)!
  };
  private imported: ImportedJournalTemplate | null = null;
  private importState: "idle" | "reading" | "ready" | "saving" | "saved" | "failed" | "conflict" = "idle";
  private status = "";
  private safeCopyPath = "";
  private submitting = false;

  constructor(app: App, private readonly options: JournalTemplateModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-journal-template-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(focusChoice?: string): void {
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createDiv({ cls: "echoink-journal-modal-head" });
    const copy = head.createDiv();
    copy.createEl("h2", { text: "今天想怎么写？" });
    copy.createEl("p", { text: "模板只决定新日记的初始内容；每次打开都默认“此刻速记”。" });
    const close = head.createEl("button", {
      cls: "echoink-journal-modal-close",
      text: "关闭",
      attr: { type: "button", "aria-label": "关闭日记模板选择器" }
    });
    close.onclick = () => this.close();

    contentEl.createEl("h3", { text: "内置模板" });
    const builtIns = contentEl.createDiv({ cls: "echoink-journal-template-grid" });
    for (const template of BUILT_IN_JOURNAL_TEMPLATES) {
      const active = this.selected.kind === "built-in" && this.selected.template.id === template.id;
      const button = builtIns.createEl("button", {
        cls: `echoink-journal-template-card ${active ? "is-selected" : ""}`,
        attr: { type: "button", "aria-pressed": String(active), "data-template-choice": `built-in:${template.id}` }
      });
      button.createEl("strong", { text: template.name });
      button.createSpan({ text: template.description });
      if (template.id === DEFAULT_JOURNAL_TEMPLATE_ID) button.createEl("small", { text: "系统默认" });
      button.onclick = () => {
        this.selected = { kind: "built-in", template };
        this.render(`built-in:${template.id}`);
      };
    }

    const customHead = contentEl.createDiv({ cls: "echoink-journal-custom-head" });
    customHead.createEl("h3", { text: "我的模板" });
    customHead.createSpan({ text: `${this.options.customTemplates.length} 个` });
    const custom = contentEl.createDiv({ cls: "echoink-journal-custom-list" });
    if (!this.options.customTemplates.length) {
      custom.createDiv({ cls: "echoink-journal-empty", text: "尚未导入本地 Markdown 模板。" });
    }
    for (const template of this.options.customTemplates) {
      const active = this.selected.kind === "custom" && this.selected.path === template.path;
      const button = custom.createEl("button", {
        cls: `echoink-journal-custom-template ${active ? "is-selected" : ""}`,
        attr: { type: "button", "aria-pressed": String(active), "data-template-choice": `custom:${template.path}` }
      });
      button.createEl("strong", { text: template.name });
      button.createSpan({ text: template.path });
      button.onclick = () => {
        this.selected = { kind: "custom", path: template.path, name: template.name };
        this.render(`custom:${template.path}`);
      };
    }

    const importPanel = contentEl.createDiv({ cls: "echoink-journal-import-panel" });
    const importCopy = importPanel.createDiv();
    importCopy.createEl("strong", { text: "导入 Markdown" });
    importCopy.createSpan({ text: "只读取本地 .md；源文件不修改、不上传。" });
    const choose = importPanel.createEl("button", {
      cls: "mod-cta",
      text: this.importState === "reading" ? "读取中…" : "选择 .md 文件",
      attr: { type: "button" }
    });
    choose.disabled = this.importState === "reading" || this.importState === "saving";
    const input = importPanel.createEl("input", {
      cls: "echoink-journal-file-input",
      attr: { type: "file", accept: ".md,text/markdown" }
    });
    choose.onclick = () => input.click();
    input.onchange = () => void this.readImport(input.files?.[0] ?? null);

    if (this.imported) this.renderImportPreview(contentEl);
    if (this.status) {
      contentEl.createDiv({
        cls: `echoink-journal-status is-${this.importState}`,
        text: this.status,
        attr: { role: this.importState === "failed" ? "alert" : "status", "aria-live": "polite" }
      });
    }

    const actions = contentEl.createDiv({ cls: "echoink-journal-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const use = actions.createEl("button", {
      cls: "mod-cta",
      text: this.submitting ? "创建中…" : `使用「${choiceName(this.selected)}」`,
      attr: { type: "button" }
    });
    use.disabled = this.submitting || this.importState === "reading" || this.importState === "saving";
    use.onclick = () => void this.createJournal();
    if (focusChoice) {
      window.requestAnimationFrame(() => {
        this.contentEl.querySelector<HTMLButtonElement>(`[data-template-choice="${CSS.escape(focusChoice)}"]`)?.focus();
      });
    }
  }

  private renderImportPreview(container: HTMLElement): void {
    if (!this.imported) return;
    const preview = container.createDiv({ cls: "echoink-journal-import-preview" });
    const meta = preview.createDiv({ cls: "echoink-journal-import-meta" });
    meta.createEl("strong", { text: this.imported.name });
    meta.createSpan({ text: `${this.imported.lineCount} 行 · frontmatter ${this.imported.frontmatterKeys.length} 项` });
    preview.createEl("pre", { text: this.imported.content.split(/\r?\n/u).slice(0, 12).join("\n") || "（空白模板）" });
    const save = preview.createEl("button", {
      text: this.importState === "saving" ? "保存中…" : "保存到“我的模板”",
      attr: { type: "button" }
    });
    save.disabled = this.importState === "saving" || this.importState === "saved";
    save.onclick = () => void this.saveImport("cancel");
    if (this.importState === "conflict" && this.safeCopyPath) {
      const copy = preview.createEl("button", {
        cls: "mod-cta",
        text: `保留为 ${basename(this.safeCopyPath)}`,
        attr: { type: "button" }
      });
      copy.onclick = () => void this.saveImport("safe-copy");
    }
  }

  private async readImport(file: File | null): Promise<void> {
    if (!file) return;
    this.importState = "reading";
    this.status = `正在读取 ${file.name}…`;
    this.imported = null;
    this.safeCopyPath = "";
    this.render();
    try {
      const content = decodeImportedMarkdown(await file.arrayBuffer());
      this.imported = this.options.service.previewImportedTemplate(file.name, content);
      this.importState = "ready";
      this.status = "读取完成。未知 frontmatter、正文结构、代码块和占位符会原样保留。";
    } catch (error) {
      this.importState = "failed";
      this.status = `读取失败：${errorMessage(error)}`;
    }
    this.render();
  }

  private async saveImport(resolution: "cancel" | "safe-copy"): Promise<void> {
    if (!this.imported) return;
    this.importState = "saving";
    this.status = "正在保存本地模板…";
    this.render();
    try {
      const result = await this.options.service.saveImportedTemplate(this.imported, resolution);
      if (result.status === "conflict") {
        this.importState = "conflict";
        this.safeCopyPath = result.safeCopyPath ?? "";
        this.status = `同名模板已存在，未覆盖：${result.path}`;
      } else {
        this.importState = "saved";
        this.status = `已保存：${result.path}`;
        this.safeCopyPath = "";
        this.selected = { kind: "custom", path: result.path, name: this.imported.name };
        if (!this.options.customTemplates.some((template) => template.path === result.path)) {
          this.options.customTemplates.push({ id: `custom:${result.path}`, name: basename(result.path), path: result.path });
        }
      }
    } catch (error) {
      this.importState = "failed";
      this.status = `保存失败：${errorMessage(error)}`;
    }
    this.render();
  }

  private async createJournal(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.status = "正在创建日记…";
    this.render();
    try {
      const result = await this.options.service.createOrOpenJournal(this.selected, this.options.date);
      await this.app.workspace.getLeaf("tab").openFile(result.file, { active: true });
      new Notice(result.created ? `已创建日记：${result.file.path}` : `今日日记已存在，已直接打开：${result.file.path}`);
      this.options.onCreated?.(result.file);
      this.close();
    } catch (error) {
      this.submitting = false;
      this.importState = "failed";
      this.status = `创建失败：${errorMessage(error)}`;
      this.render();
    }
  }
}

function choiceName(choice: HomeJournalTemplateChoice): string {
  return choice.kind === "built-in" ? choice.template.name : choice.name;
}

function basename(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/iu, "") ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
