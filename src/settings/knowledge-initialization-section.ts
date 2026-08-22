import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import {
  isKnowledgeInitializationRole,
  knowledgeInitializationSourceDefaultRole,
  type KnowledgeBaseStructureRepairProgress,
  type KnowledgeBaseStructureSnapshot,
  type KnowledgeInitializationAssignment,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationMode,
  type KnowledgeInitializationProviderSnapshot,
  type KnowledgeInitializationRole
} from "../knowledge-base/initializer";
import {
  buildKnowledgeInitializationProgress,
  type KnowledgeInitializationProgressStage
} from "../knowledge-base/initialization-progress";
import {
  deriveKnowledgeInitializationRecovery,
  type KnowledgeInitializationRecovery
} from "./knowledge-initialization-recovery";
import {
  apiProviderHasUsableApiKey,
  getActiveApiProvider,
  validateApiProvider
} from "./settings";
import { createSettingsSection, createSettingsState } from "./settings-v2";
import { KnowledgeNotePickerModal } from "./knowledge-note-picker-modal";
import { applyAmicroButton } from "./amicro-buttons";

type KnowledgeInitDirectoryRole = Exclude<KnowledgeInitializationRole, "keep">;

interface KnowledgeInitDirectoryDef {
  readonly role: KnowledgeInitDirectoryRole;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
}

/**
 * 自定义分配的十个固定目录。前九个可分配 Markdown；assets 是附件目录，
 * 只展示、不参与笔记分配。
 */
export const KNOWLEDGE_INIT_DIRECTORIES: readonly KnowledgeInitDirectoryDef[] = Object.freeze([
  { role: "raw", labelZh: "Raw", labelEn: "Raw", descriptionZh: "现有原始笔记和后续待提炼资料", descriptionEn: "Original notes and new material waiting to be distilled" },
  { role: "wiki", labelZh: "Wiki", labelEn: "Wiki", descriptionZh: "AI 提炼后的长期知识与索引", descriptionEn: "Long-term knowledge and indexes distilled by AI" },
  { role: "projects", labelZh: "Projects", labelEn: "Projects", descriptionZh: "按项目组织的资料与知识", descriptionEn: "Notes and knowledge organized by project" },
  { role: "outputs", labelZh: "Outputs", labelEn: "Outputs", descriptionZh: "整理过程记录与生成结果", descriptionEn: "Processing records and generated results" },
  { role: "inbox", labelZh: "Inbox", labelEn: "Inbox", descriptionZh: "暂时还没分类的新笔记", descriptionEn: "New notes that have not been sorted yet" },
  { role: "journal", labelZh: "Journal", labelEn: "Journal", descriptionZh: "日记、复盘与时间记录", descriptionEn: "Journals, reviews, and time-based notes" },
  { role: "work", labelZh: "Work", labelEn: "Work", descriptionZh: "正在处理的工作资料", descriptionEn: "Active working material" },
  { role: "archive", labelZh: "Archive", labelEn: "Archive", descriptionZh: "已结束或暂时不用的内容", descriptionEn: "Completed or inactive material" },
  { role: "templates", labelZh: "Templates", labelEn: "Templates", descriptionZh: "可重复使用的笔记模板", descriptionEn: "Reusable note templates" }
]);

const KNOWLEDGE_INIT_ASSETS_LABEL_ZH = "附件目录";
const KNOWLEDGE_INIT_ASSETS_LABEL_EN = "Attachments folder";

const FOCUS_KEY = "knowledge:initialize";

interface KnowledgeInitProgressRefs {
  readonly rootEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly barEl: HTMLElement;
  readonly indicatorEl: HTMLElement;
  readonly percentEl: HTMLElement;
  readonly stepEl: HTMLElement;
  readonly countEl: HTMLElement;
}

/**
 * 知识库初始化体验的唯一渲染入口。settings-tab.ts 只负责创建本类、
 * 调用 render() 并在 hide() 时 dispose()；全部初始化 UI 状态在这里维护。
 *
 * 普通主界面不暴露 revision/hash、冻结计划、Provider/model 快照、WAL、CAS、
 * Readback 等内部概念；它们只保留在后台 job 中。
 *
 * 渲染优先级：当前作业优先；没有待处理作业时，以实时 Vault 目录结构
 * 为准。settings 里的 initialized 只保留历史，不再决定当前状态。
 */
export class KnowledgeInitializationSection {
  private job: Readonly<KnowledgeInitializationJob> | null = null;
  private loaded = false;
  private loading = false;
  private loadGeneration = 0;
  private loadError = "";
  private busy = false;
  private customPreviewLoading = false;
  private selectedTab: KnowledgeInitializationMode = "recommended";
  private reselecting = false;
  private expandedDirs = new Set<KnowledgeInitDirectoryRole>();
  private pollTimer: number | null = null;
  private pageEl: HTMLElement | null = null;
  private zh = true;
  private actionError = "";
  private actionErrorEl: HTMLElement | null = null;
  private structure: Readonly<KnowledgeBaseStructureSnapshot> | null = null;
  private structureRepairProgress: Readonly<KnowledgeBaseStructureRepairProgress> | null = null;
  private tabButtonEls: Record<KnowledgeInitializationMode, HTMLElement | null> = {
    recommended: null,
    custom: null
  };
  private tabBodyEl: HTMLElement | null = null;
  private dirListEl: HTMLElement | null = null;
  private dirAddButtons = new Map<KnowledgeInitDirectoryRole, HTMLButtonElement>();
  private progressRefs: KnowledgeInitProgressRefs | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly scheduleRender: () => void
  ) {}

  dispose(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pageEl = null;
    this.progressRefs = null;
    this.actionErrorEl = null;
    this.invalidate();
  }

  /** 离开再进入知识库设置时强制重新读取真实 Vault 结构。 */
  invalidate(): void {
    this.loadGeneration += 1;
    this.loaded = false;
    this.loading = false;
    this.loadError = "";
    this.structure = null;
  }

  render(page: HTMLElement, zh: boolean): void {
    this.pageEl = page;
    this.zh = zh;
    this.progressRefs = null;
    this.actionErrorEl = null;
    const section = createSettingsSection(page, {
      title: zh ? "知识库管理" : "Knowledge management",
      surface: "flat"
    });
    const panel = section.createDiv({
      cls: "echoink-settings-feature-card echoink-knowledge-init-panel",
      // Stable tutorial anchor: unlike the initialization CTA, this remains in
      // the DOM after the knowledge base is already initialized.
      attr: { "data-echoink-focus-key": "knowledge:onboarding" }
    });
    if (!this.loaded && !this.loading && !this.loadError) void this.load();
    if (this.loading && !this.loaded) {
      panel.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在读取初始化状态…" : "Loading initialization state…"
      });
      return;
    }
    const job = this.job;
    if (this.loadError && !this.loaded) {
      createSettingsState(panel, this.loadError, "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.load()
      });
      return;
    }
    // 用户动作失败提示：所有面板共用，成功或重新执行时清除。
    this.renderActionError(panel);
    if (this.structureRepairProgress) {
      this.renderStructureRepairProgress(panel, this.structureRepairProgress);
      return;
    }
    // 当前作业优先：运行中 > 重新选择方案 > 预览 > 可恢复态。
    if (job && job.status === "active") {
      this.renderProgressPanel(panel, job);
      this.schedulePoll();
      return;
    }
    if (this.reselecting) {
      this.renderTabsPanel(panel);
      return;
    }
    if (job && job.status === "preview") {
      this.renderTabsPanel(panel);
      return;
    }
    if (job && job.status !== "initialized") {
      this.renderPausedPanel(panel, job);
      return;
    }
    const structure = this.structure;
    if (!structure) {
      createSettingsState(
        panel,
        zh ? "无法确认知识库目录状态，请重试。" : "Unable to verify the Knowledge folder structure. Try again.",
        "error",
        { label: zh ? "重试" : "Retry", onActivate: () => void this.load() }
      );
      return;
    }
    if (structure.state === "uninitialized") {
      this.renderTabsPanel(panel);
      return;
    }
    if (structure.state === "incomplete") {
      this.renderStructureWarningPanel(panel, structure);
      return;
    }
    this.renderDonePanel(panel);
  }

  // ---------------------------------------------------------------- loading

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.loadError = "";
    try {
      const [job, structure] = await Promise.all([
        this.plugin.getEchoInkKnowledgeInitializationState(),
        this.plugin.getEchoInkKnowledgeBaseStructure()
      ]);
      if (generation !== this.loadGeneration) return;
      this.job = job;
      this.structure = structure;
      this.loaded = true;
      this.selectedTab = this.job?.mode === "custom"
        && this.job.status !== "initialized"
        ? "custom"
        : "recommended";
    } catch {
      if (generation !== this.loadGeneration) return;
      this.loadError = this.zh
        ? "无法读取初始化状态，请重试。"
        : "Unable to load initialization status. Try again.";
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
        this.scheduleRender();
      }
    }
  }

  private async reloadAfterActionError(): Promise<void> {
    try {
      const [job, structure] = await Promise.all([
        this.plugin.getEchoInkKnowledgeInitializationState(),
        this.plugin.getEchoInkKnowledgeBaseStructure()
      ]);
      this.job = job;
      this.structure = structure;
      this.loaded = true;
    } catch {
      // 保留当前界面状态；由下一次渲染展示可重试的状态。
    }
  }

  // ------------------------------------------------------------ action errors

  /** 只记录面向用户的恢复提示；内部异常不进入普通设置界面。 */
  private recordActionError(_error: unknown, message?: string): void {
    this.actionError = message ?? (this.zh
      ? "操作没有完成，可以再试一次。"
      : "The action didn't complete. You can try again.");
  }

  private clearActionError(): void {
    this.actionError = "";
    if (this.actionErrorEl?.isConnected) this.actionErrorEl.remove();
    this.actionErrorEl = null;
  }

  private renderActionError(panel: HTMLElement): void {
    if (!this.actionError) return;
    const box = panel.createDiv({
      cls: "echoink-knowledge-init-action-error",
      attr: { role: "alert" }
    });
    this.actionErrorEl = box;
    box.createDiv({ cls: "echoink-knowledge-init-action-error-text", text: this.actionError });
  }

  /** 统一的动作包装：开始清错误、失败记错误并刷新状态、绝不静默。 */
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.clearActionError();
    try {
      await action();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
    } finally {
      this.busy = false;
      this.scheduleRender();
    }
  }

  private renderStatusHeading(
    panel: HTMLElement,
    iconName: string,
    title: string,
    tone: "ready" | "warning" | "loading"
  ): void {
    const row = panel.createDiv({
      cls: `echoink-knowledge-init-status-heading is-${tone}`
    });
    const icon = row.createSpan({
      cls: "echoink-knowledge-init-status-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, iconName);
    row.createDiv({ cls: "echoink-knowledge-init-heading", text: title });
  }

  private mountProgress(
    panel: HTMLElement,
    data: Readonly<{
      percent: number;
      completed: number;
      total: number;
      status: string;
      step: string;
      ariaLabel: string;
    }>
  ): KnowledgeInitProgressRefs {
    const rootEl = panel.createDiv({ cls: "echoink-knowledge-init-progress" });
    const statusEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-status",
      text: data.status,
      attr: { role: "status", "aria-live": "polite" }
    });
    const barRow = rootEl.createDiv({ cls: "echoink-knowledge-init-bar-row" });
    const barEl = barRow.createDiv({
      cls: "echoink-knowledge-init-bar",
      attr: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(data.percent),
        "aria-label": data.ariaLabel
      }
    });
    const indicatorEl = barEl.createDiv({
      cls: "echoink-knowledge-init-bar-indicator",
      attr: { "aria-hidden": "true" }
    });
    indicatorEl.style.setProperty(
      "--echoink-knowledge-init-progress",
      `${data.percent}%`
    );
    const percentEl = barRow.createSpan({
      cls: "echoink-knowledge-init-percent",
      text: `${data.percent}%`
    });
    const stepEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-step",
      text: data.step
    });
    const countEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-count",
      text: data.total > 0 ? `${data.completed} / ${data.total}` : ""
    });
    return {
      rootEl,
      statusEl,
      barEl,
      indicatorEl,
      percentEl,
      stepEl,
      countEl
    };
  }

  // ------------------------------------------------------------------- tabs

  private renderTabsPanel(panel: HTMLElement): void {
    const zh = this.zh;
    panel.createDiv({
      cls: "echoink-knowledge-init-heading",
      text: zh ? "初始化知识库" : "Initialize your knowledge base"
    });
    const tablist = panel.createDiv({
      cls: "echoink-knowledge-init-tabs",
      attr: {
        role: "tablist",
        "aria-label": zh ? "知识库初始化方案" : "Knowledge initialization plans"
      }
    });
    this.tabButtonEls = { recommended: null, custom: null };
    for (const mode of ["recommended", "custom"] as const) {
      const tab = tablist.createEl("button", {
        cls: "echoink-knowledge-init-tab",
        text: mode === "recommended"
          ? (zh ? "默认方案" : "Default plan")
          : (zh ? "自定义方案" : "Custom plan"),
        attr: {
          type: "button",
          role: "tab",
          id: `echoink-knowledge-init-tab-${mode}`,
          "aria-controls": "echoink-knowledge-init-tabpanel",
          "aria-selected": String(this.selectedTab === mode),
          tabindex: this.selectedTab === mode ? "0" : "-1"
        }
      });
      tab.onclick = () => this.selectTab(mode);
      tab.onkeydown = (event: KeyboardEvent) => this.handleTabKeydown(event, mode);
      this.tabButtonEls[mode] = tab;
    }
    this.tabBodyEl = panel.createDiv({
      cls: "echoink-knowledge-init-tabpanel",
      attr: {
        role: "tabpanel",
        id: "echoink-knowledge-init-tabpanel",
        "aria-labelledby": `echoink-knowledge-init-tab-${this.selectedTab}`
      }
    });
    this.renderTabBody();
    if (this.selectedTab === "custom") this.ensureCustomPreview();
  }

  private handleTabKeydown(
    event: KeyboardEvent,
    mode: KnowledgeInitializationMode
  ): void {
    // 两个 Tab：左右方向键切换并聚焦（roving tabindex，自动激活）。
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: KnowledgeInitializationMode =
      mode === "recommended" ? "custom" : "recommended";
    this.selectTab(next);
    this.tabButtonEls[next]?.focus();
  }

  private selectTab(mode: KnowledgeInitializationMode): void {
    if (this.selectedTab === mode) return;
    this.selectedTab = mode;
    for (const candidate of ["recommended", "custom"] as const) {
      const tab = this.tabButtonEls[candidate];
      if (!tab) continue;
      tab.setAttr("aria-selected", String(candidate === mode));
      tab.setAttr("tabindex", candidate === mode ? "0" : "-1");
    }
    this.tabBodyEl?.setAttr(
      "aria-labelledby",
      `echoink-knowledge-init-tab-${mode}`
    );
    // Tab 切换只替换同一面板主体，不移动文件、不调用 Provider。
    this.renderTabBody();
    if (mode === "custom") this.ensureCustomPreview();
  }

  private renderTabBody(): void {
    const body = this.tabBodyEl;
    if (!body) return;
    body.empty();
    if (this.selectedTab === "recommended") this.renderRecommendedBody(body);
    else this.renderCustomBody(body);
  }

  // -------------------------------------------------------------- default tab

  private renderRecommendedBody(body: HTMLElement): void {
    const zh = this.zh;
    body.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "默认方案采用 Karpathy（卡帕西）的分层知识库管理方法。EchoInk 会先整理目录，再用 AI 把原始笔记提炼成便于长期使用的 Wiki。"
        : "The default plan follows Karpathy-style layered knowledge management. EchoInk first organizes the folder structure, then uses AI to distill original notes into a durable Wiki."
    });
    body.createDiv({
      cls: "echoink-knowledge-init-plan-lead",
      text: zh ? "初始化会创建这些目录：" : "Initialization creates these folders:"
    });
    const folderList = body.createEl("dl", {
      cls: "echoink-knowledge-init-folder-purposes"
    });
    for (const directory of KNOWLEDGE_INIT_DIRECTORIES) {
      const row = folderList.createDiv({ cls: "echoink-knowledge-init-folder-purpose" });
      row.createEl("dt", { text: directory.labelEn });
      row.createEl("dd", {
        text: zh ? directory.descriptionZh : directory.descriptionEn
      });
    }
    const assetsRow = folderList.createDiv({ cls: "echoink-knowledge-init-folder-purpose" });
    assetsRow.createEl("dt", { text: "Assets" });
    assetsRow.createEl("dd", {
      text: zh ? "图片、PDF 等附件，保持原位" : "Images, PDFs, and other attachments, kept in place"
    });
    body.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh
        ? "现有 Markdown 笔记会原样移入 Raw，并保留原来的相对路径；EchoInk 不会删除或改写原笔记。随后，AI 会最多每 20 篇分批提炼并生成 Wiki，文件多时会自动分批处理。"
        : "Existing Markdown notes move into Raw unchanged while keeping their relative paths; EchoInk never deletes or rewrites the originals. AI then distills them into Wiki in batches of up to 20, automatically splitting larger Vaults into multiple batches."
    });
    body.createDiv({
      cls: "echoink-knowledge-init-plan-confirm",
      text: zh
        ? "确认无误后，点击“开始初始化”。"
        : "When this looks right, select “Start initialization”."
    });
    const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
    const cta = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "开始初始化" : "Start initialization",
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(cta, { variant: "primary", motion: "complete" });
    cta.disabled = this.busy;
    cta.onclick = () => void this.startRecommended();
  }

  private async startRecommended(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      // 单次明确确认：UI 内部依次生成推荐 preview 并立即确认执行。
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
      this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // --------------------------------------------------------------- custom tab

  private renderCustomBody(body: HTMLElement): void {
    const zh = this.zh;
    if (this.customPreviewLoading) {
      body.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在扫描可分配的笔记…" : "Scanning assignable notes…"
      });
      return;
    }
    const job = this.job;
    if (!job || job.mode !== "custom" || job.status !== "preview") {
      body.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在准备自定义分配…" : "Preparing custom assignments…"
      });
      return;
    }
    body.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "把体系外的笔记分配到固定目录；未指定的笔记默认归入 Raw。"
        : "Assign stray notes to fixed folders; unspecified notes default to Raw."
    });
    const conflicts = job.items.filter((item) => item.state === "conflict").length;
    if (conflicts > 0) {
      const warning = body.createDiv({ cls: "echoink-knowledge-init-warning" });
      const icon = warning.createSpan({ cls: "echoink-knowledge-init-warning-icon" });
      setIcon(icon, "alert-triangle");
      icon.setAttr("aria-hidden", "true");
      warning.createSpan({
        cls: "echoink-knowledge-init-warning-text",
        text: zh
          ? `有 ${conflicts} 篇笔记的目标位置已存在文件，需要先处理这些冲突。`
          : `${conflicts} notes have existing files at their targets; resolve these conflicts first.`
      });
    }
    this.dirListEl = body.createDiv({ cls: "echoink-knowledge-init-dirs" });
    this.renderDirectoryList();
    const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
    const cta = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "开始初始化" : "Start initialization",
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(cta, { variant: "primary", motion: "complete" });
    cta.disabled = this.busy;
    cta.onclick = () => void this.confirmCustom();
  }

  private ensureCustomPreview(): void {
    const job = this.job;
    if (job?.mode === "custom" && job.status === "preview") return;
    if (this.busy || this.customPreviewLoading) return;
    void this.generateCustomPreview();
  }

  private async generateCustomPreview(): Promise<void> {
    // 本地扫描并持久化 preview；不移动文件、不调用 Provider。
    this.customPreviewLoading = true;
    this.renderTabBody();
    try {
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("custom");
      this.loaded = true;
      this.clearActionError();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
    } finally {
      this.customPreviewLoading = false;
      this.scheduleRender();
    }
  }

  private async confirmCustom(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // ----------------------------------------------------------- directory list

  private renderDirectoryList(): void {
    const list = this.dirListEl;
    const job = this.job;
    if (!list || !job) return;
    const zh = this.zh;
    list.empty();
    this.dirAddButtons.clear();
    const notesByRole = new Map<KnowledgeInitDirectoryRole, string[]>();
    for (const dir of KNOWLEDGE_INIT_DIRECTORIES) notesByRole.set(dir.role, []);
    for (const item of job.items) {
      if (item.role === "keep") continue;
      notesByRole.get(item.role)?.push(item.sourcePath);
    }
    for (const dir of KNOWLEDGE_INIT_DIRECTORIES) {
      const notes = notesByRole.get(dir.role) ?? [];
      const label = this.dirLabel(dir.role);
      const expanded = this.expandedDirs.has(dir.role);
      const row = list.createDiv({ cls: "echoink-knowledge-init-dir-row" });
      const toggle = row.createEl("button", {
        cls: "echoink-knowledge-init-dir-toggle",
        attr: {
          type: "button",
          "aria-expanded": String(expanded),
          "aria-label": zh
            ? `${expanded ? "收起" : "展开"} ${label}`
            : `${expanded ? "Collapse" : "Expand"} ${label}`
        }
      });
      setIcon(toggle, expanded ? "chevron-down" : "chevron-right");
      row.createDiv({ cls: "echoink-knowledge-init-dir-name", text: label });
      row.createDiv({
        cls: "echoink-knowledge-init-dir-count",
        text: String(notes.length),
        attr: { "aria-label": zh ? `${label} 已分配 ${notes.length} 篇` : `${notes.length} notes in ${label}` }
      });
      const addLabel = dir.role === "raw"
        ? (zh ? "移回 Raw" : "Move back to Raw")
        : (zh ? "添加笔记" : "Add notes");
      const add = row.createEl("button", {
        cls: "echoink-knowledge-init-dir-add",
        text: addLabel,
        attr: {
          type: "button",
          "aria-label": dir.role === "raw"
            ? (zh ? "把其他目录的笔记移回 Raw" : "Move notes back to Raw")
            : (zh ? `添加笔记到 ${label}` : `Add notes to ${label}`)
        }
      });
      applyAmicroButton(add, { variant: "secondary", motion: "slide", icon: "folder-plus" });
      add.disabled = this.busy;
      add.onclick = () => void this.openNotePicker(dir.role, add);
      this.dirAddButtons.set(dir.role, add);
      toggle.onclick = () => {
        if (expanded) this.expandedDirs.delete(dir.role);
        else this.expandedDirs.add(dir.role);
        this.renderDirectoryList();
      };
      if (expanded) {
        const notesEl = list.createDiv({ cls: "echoink-knowledge-init-note-list" });
        if (notes.length === 0) {
          notesEl.createDiv({
            cls: "echoink-knowledge-init-note-empty",
            text: zh ? "暂无分配的笔记。" : "No assigned notes yet."
          });
        }
        for (const sourcePath of notes) {
          const noteRow = notesEl.createDiv({ cls: "echoink-knowledge-init-note-row" });
          noteRow.createSpan({
            cls: "echoink-knowledge-init-note-path",
            text: sourcePath,
            attr: { title: sourcePath }
          });
          if (dir.role !== "raw") {
            const remove = noteRow.createEl("button", {
              cls: "echoink-knowledge-init-note-remove",
              text: zh ? "移回 Raw" : "Move back to Raw",
              attr: {
                type: "button",
                "aria-label": zh ? `把 ${sourcePath} 移回 Raw` : `Move ${sourcePath} back to Raw`
              }
            });
            remove.disabled = this.busy;
            remove.onclick = () => void this.applyAssignments([
              { sourcePath, role: "raw" }
            ]);
          }
        }
      }
    }
    const assetsRow = list.createDiv({ cls: "echoink-knowledge-init-dir-row is-assets" });
    assetsRow.createDiv({ cls: "echoink-knowledge-init-dir-name", text: "assets" });
    assetsRow.createDiv({
      cls: "echoink-knowledge-init-dir-badge",
      text: zh ? KNOWLEDGE_INIT_ASSETS_LABEL_ZH : KNOWLEDGE_INIT_ASSETS_LABEL_EN
    });
  }

  private async openNotePicker(
    role: KnowledgeInitDirectoryRole,
    triggerEl: HTMLElement
  ): Promise<void> {
    // 每次打开都重新读取当前 Vault，并恢复用户已明确做过的分配。这样用户
    // 在旧 preview 之后新建的笔记也会立刻出现在列表里；此步骤只更新预览，
    // 不移动文件，也不调用 Provider。
    if (!await this.rebuildCustomPreviewPreservingAssignments()) return;
    if (this.dirListEl?.isConnected) this.renderDirectoryList();
    const job = this.job;
    if (!job) return;
    const notes = job.items
      .filter((item) => item.role !== "keep")
      .map((item) => ({ sourcePath: item.sourcePath, role: item.role }));
    const modal = new KnowledgeNotePickerModal(this.plugin.app, {
      zh: this.zh,
      targetRole: role,
      targetLabel: this.dirLabel(role),
      notes,
      roleLabel: (candidate) => this.dirLabel(candidate),
      triggerEl,
      // 目录列表提交后会被重建：按 role 找重建后的按钮，且只在 isConnected
      // 时 focus；取消 / Escape / 提交成功 / 失败后再取消四条路径都走这里。
      restoreFocus: () => this.focusDirAddButton(role),
      onConfirm: (assignments) => this.applyAssignments(assignments, role, true)
    });
    modal.open();
  }

  private focusDirAddButton(role: KnowledgeInitDirectoryRole): void {
    const button = this.dirAddButtons.get(role);
    if (button?.isConnected) button.focus();
  }

  private async applyAssignments(
    assignments: readonly KnowledgeInitializationAssignment[],
    focusRole?: KnowledgeInitDirectoryRole,
    rethrow = false
  ): Promise<void> {
    if (this.busy || assignments.length === 0) return;
    this.busy = true;
    this.clearActionError();
    try {
      this.job = await this.plugin.assignManyEchoInkKnowledgeInitializationNotes(assignments);
      this.loaded = true;
      // 原地刷新目录列表，避免整页重渲染；重建后把焦点还给对应目录的
      // 「添加笔记」按钮，保持键盘用户的位置。
      if (this.dirListEl?.isConnected) {
        this.renderDirectoryList();
        if (focusRole) this.focusDirAddButton(focusRole);
      } else this.scheduleRender();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
      this.scheduleRender();
      // Modal 路径：把错误抛回，让 Modal 保持打开并显示自己的内联错误。
      if (rethrow) throw error;
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------- structure recovery

  private renderStructureWarningPanel(
    panel: HTMLElement,
    structure: Readonly<KnowledgeBaseStructureSnapshot>
  ): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "alert-triangle",
      zh ? "知识库文件夹结构不完整" : "Knowledge folders need attention",
      "warning"
    );
    panel.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "EchoInk 需要完整的固定目录来存放原始笔记、Wiki 和附件。目录缺失时，整理和提炼功能可能无法正常工作。"
        : "EchoInk needs the complete fixed folder structure for original notes, Wiki content, and attachments. Missing folders can interrupt organization and distillation."
    });
    if (structure.missingRoots.length > 0) {
      panel.createDiv({
        cls: "echoink-knowledge-init-structure-detail",
        text: zh
          ? `缺少目录：${structure.missingRoots.join("、")}`
          : `Missing folders: ${structure.missingRoots.join(", ")}`
      });
    }
    if (structure.conflictingRoots.length > 0) {
      const warning = panel.createDiv({ cls: "echoink-knowledge-init-warning" });
      const icon = warning.createSpan({ cls: "echoink-knowledge-init-warning-icon" });
      setIcon(icon, "alert-triangle");
      icon.setAttr("aria-hidden", "true");
      warning.createSpan({
        cls: "echoink-knowledge-init-warning-text",
        text: zh
          ? `这些路径已被同名文件占用：${structure.conflictingRoots.join("、")}。EchoInk 不会覆盖或移动它们，请先重命名这些文件。`
          : `These paths are occupied by files: ${structure.conflictingRoots.join(", ")}. EchoInk will not overwrite or move them; rename those files first.`
      });
    }
    panel.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh
        ? "恢复只会补建缺少的文件夹，不会移动、删除或改写任何笔记，也不会调用模型。"
        : "Recovery only creates missing folders. It never moves, deletes, or rewrites notes and does not call a model."
    });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    const restore = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: structure.missingRoots.length > 0
        ? (zh ? "恢复文件夹体系" : "Restore folder structure")
        : (zh ? "重新检查" : "Check again"),
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(restore, { variant: "primary", motion: "complete" });
    restore.disabled = this.busy;
    restore.onclick = () => void this.restoreStructure();
  }

  private async restoreStructure(): Promise<void> {
    if (this.busy) return;
    const generation = this.loadGeneration;
    this.busy = true;
    this.clearActionError();
    const total = Math.max(1,
      (this.structure?.existingRoots.length ?? 0)
      + (this.structure?.missingRoots.length ?? 0)
      + (this.structure?.conflictingRoots.length ?? 0));
    this.structureRepairProgress = Object.freeze({
      completed: 0,
      total,
      percent: 0,
      currentRoot: null
    });
    this.scheduleRender();
    try {
      const result = await this.plugin.restoreEchoInkKnowledgeBaseStructure((progress) => {
        if (generation !== this.loadGeneration) return;
        this.structureRepairProgress = progress;
        this.scheduleRender();
      });
      if (generation !== this.loadGeneration) return;
      this.structure = result.structure;
      this.loaded = true;
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.recordActionError(
        error,
        this.zh
          ? "文件夹体系没有恢复完成。已有笔记没有被移动或删除，请检查 Vault 是否可写后重试。"
          : "The folder structure was not fully restored. Existing notes were not moved or deleted; check that the Vault is writable and try again."
      );
      await this.reloadAfterActionError();
    } finally {
      this.structureRepairProgress = null;
      this.busy = false;
      if (generation === this.loadGeneration) this.scheduleRender();
    }
  }

  private renderStructureRepairProgress(
    panel: HTMLElement,
    progress: Readonly<KnowledgeBaseStructureRepairProgress>
  ): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "loader-circle",
      zh ? "正在恢复文件夹体系" : "Restoring folder structure",
      "loading"
    );
    panel.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh
        ? "正在检查并补齐固定目录；现有笔记保持原样。"
        : "Checking and restoring fixed folders; existing notes remain unchanged."
    });
    const current = progress.currentRoot
      ? (zh ? `正在处理 ${progress.currentRoot}` : `Checking ${progress.currentRoot}`)
      : (zh ? "准备检查目录" : "Preparing to check folders");
    this.progressRefs = this.mountProgress(panel, {
      percent: progress.percent,
      completed: progress.completed,
      total: progress.total,
      status: zh
        ? `恢复文件夹体系 · ${progress.completed} / ${progress.total} · ${progress.percent}%`
        : `Restoring folders · ${progress.completed} / ${progress.total} · ${progress.percent}%`,
      step: current,
      ariaLabel: zh ? "文件夹恢复进度" : "Folder recovery progress"
    });
  }

  // ---------------------------------------------------------------- progress

  private renderProgressPanel(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "loader-circle",
      zh ? "正在初始化知识库" : "Initializing your knowledge base",
      "loading"
    );
    // 进度只来自真实 job 字段；运行中不会出现 100%（完成即切换完成态）。
    const progress = buildKnowledgeInitializationProgress(job, false);
    const step = progressStepLabel(progress.stage, zh);
    this.progressRefs = this.mountProgress(panel, {
      percent: progress.percent,
      completed: progress.completed,
      total: progress.total,
      status: progressStatusSentence(progress.stage, progress, zh),
      step,
      ariaLabel: zh ? "初始化进度" : "Initialization progress"
    });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    const pause = actions.createEl("button", {
      cls: "echoink-knowledge-init-secondary",
      text: zh ? "暂停初始化" : "Pause initialization",
      attr: { type: "button" }
    });
    pause.onclick = () => void this.pauseRun();
  }

  private async pollTick(): Promise<void> {
    this.pollTimer = null;
    const page = this.pageEl;
    if (!page || !page.isConnected) return;
    if (this.plugin.settings.settingsTab !== "knowledgeBase") return;
    try {
      const job = await this.plugin.getEchoInkKnowledgeInitializationState();
      const structure = job?.status === "active"
        ? this.structure
        : await this.plugin.getEchoInkKnowledgeBaseStructure();
      this.job = job;
      this.structure = structure;
      this.loaded = true;
    } catch {
      // 保留上一次状态，下一轮再试。
    }
    if (this.job?.status === "active" && this.updateProgressInPlace()) {
      this.schedulePoll();
      return;
    }
    this.scheduleRender();
  }

  private updateProgressInPlace(): boolean {
    const refs = this.progressRefs;
    if (!refs || !refs.rootEl.isConnected || !this.job) return false;
    const progress = buildKnowledgeInitializationProgress(this.job, false);
    refs.barEl.setAttr("aria-valuenow", String(progress.percent));
    refs.indicatorEl.style.setProperty(
      "--echoink-knowledge-init-progress",
      `${progress.percent}%`
    );
    refs.percentEl.setText(`${progress.percent}%`);
    refs.stepEl.setText(progressStepLabel(progress.stage, this.zh));
    refs.countEl.setText(progress.total > 0 ? `${progress.completed} / ${progress.total}` : "");
    refs.statusEl.setText(progressStatusSentence(progress.stage, progress, this.zh));
    return true;
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) return;
    if (this.job?.status !== "active") return;
    this.pollTimer = window.setTimeout(() => void this.pollTick(), 750);
  }

  private async pauseRun(): Promise<void> {
    await this.runAction(async () => {
      // 复用现有 cancel API；后台 cancelled 状态仍可通过「继续初始化」恢复。
      this.job = await this.plugin.cancelEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // -------------------------------------------------------------- paused/error

  private renderPausedPanel(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    // 恢复方式完全由结构化字段派生（status / 两个 digest / Provider 快照），
    // 不解析 lastError 中文字符串。
    const recovery = deriveKnowledgeInitializationRecovery({
      job,
      currentProvider: this.currentProviderSnapshot()
    });
    panel.createDiv({
      cls: "echoink-knowledge-init-heading",
      text: recovery.kind === "recheck-conflict"
        ? (zh ? "初始化遇到冲突" : "Initialization hit a conflict")
        : (zh ? "初始化暂停了" : "Initialization paused")
    });
    const notice = panel.createDiv({
      cls: "echoink-knowledge-init-pause",
      attr: { role: "status", "aria-live": "polite" }
    });
    const icon = notice.createSpan({ cls: "echoink-knowledge-init-pause-icon" });
    setIcon(icon, "alert-triangle");
    icon.setAttr("aria-hidden", "true");
    notice.createDiv({
      cls: "echoink-knowledge-init-pause-text",
      text: this.pauseNoticeText(recovery, job, zh)
    });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    if (recovery.kind === "recheck-conflict") {
      // blocked_conflict：禁止展示必然失败的「继续初始化」。
      const recheck = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "重新检查冲突" : "Recheck conflicts",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      recheck.onclick = () => void this.recheckConflict();
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: job.mode === "custom"
          ? (zh ? "修改分配" : "Edit assignments")
          : (zh ? "重新选择方案" : "Choose a different plan"),
        attr: { type: "button" }
      });
      reselect.onclick = () => {
        if (job.mode === "custom") {
          void this.rescanCustomPreservingAssignments();
          return;
        }
        this.enterPlanSelection();
      };
    } else if (recovery.kind === "recheck-preview") {
      // Provider 缺失/变化或 digest 不一致：不能直接 continueJob()，
      // 必须重新生成 preview。
      const recheck = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "重新检查并继续" : "Recheck and continue",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      recheck.onclick = () => void this.recheckPreviewAndContinue();
      // 保留「重新选择方案」出口：计划已失效时用户也可以直接回到方案选择。
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: zh ? "重新选择方案" : "Choose a different plan",
        attr: { type: "button" }
      });
      reselect.onclick = () => this.enterPlanSelection();
    } else {
      const resume = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "继续初始化" : "Continue initialization",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      resume.onclick = () => void this.resumeRun();
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: zh ? "重新选择方案" : "Choose a different plan",
        attr: { type: "button" }
      });
      reselect.onclick = () => this.enterPlanSelection();
    }
  }

  private pauseNoticeText(
    recovery: KnowledgeInitializationRecovery,
    job: Readonly<KnowledgeInitializationJob>,
    zh: boolean
  ): string {
    if (recovery.kind === "recheck-conflict") {
      return zh
        ? "有些笔记的目标位置已存在文件，EchoInk 不会覆盖。处理冲突或修改分配后，重新检查即可。"
        : "Some notes have existing files at their targets, and EchoInk will not overwrite them. Resolve the conflicts or edit the assignments, then recheck.";
    }
    if (recovery.kind === "recheck-preview") {
      // 作业快照本身没有 Provider（创建时就没配）且还有待提炼内容：
      // 直接说「先设置模型」，而不是「模型已变化」。
      const jobLacksProvider =
        job.provider === null && job.extractionQueue.length > 0;
      if (jobLacksProvider || this.currentProviderSnapshot() === null) {
        return zh
          ? "需要先设置可用模型，才能把 Raw 笔记提炼成 Wiki。"
          : "Set up an available model first so Raw notes can be distilled into Wiki.";
      }
      return zh
        ? "模型或计划已经变化，原来的确认不再有效。重新检查并确认新的计划后即可继续。"
        : "The model or plan has changed, so the previous confirmation is no longer valid. Recheck and confirm the new plan to continue.";
    }
    return zh
      ? "初始化暂停了。已经完成的内容会保留，解决问题后可以继续。"
      : "Initialization paused. Completed work is kept; you can continue after fixing the issue.";
  }

  /**
   * 通用「重新选择方案」：直接回到 Tab 选择界面，不做任何后台调用。
   * custom 预览由 renderTabsPanel → ensureCustomPreview 自动重建
   * （只产生一次 start:custom，不移动文件、不调用 Provider）。
   * 保留旧分配的一次性恢复只发生在恢复按钮的 recheck 路径里。
   */
  private enterPlanSelection(): void {
    this.reselecting = true;
    this.clearActionError();
    this.scheduleRender();
  }

  private async resumeRun(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      this.job = await this.plugin.continueEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  /** blocked_conflict 的重新检查：绝不直接调用 continue。 */
  private async recheckConflict(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.mode === "recommended") {
      // 推荐模式：重新扫描后立即确认；若冲突仍在，confirm 会再次停在冲突态。
      this.reselecting = false;
      await this.runAction(async () => {
        this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
        this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
        this.loaded = true;
      });
      return;
    }
    // 自定义模式：回到可修改的 preview，不直接移动文件。
    await this.rescanCustomPreservingAssignments();
  }

  /** Provider/digest 变化后的重新检查：必须重新生成 preview，不直接 continueJob。 */
  private async recheckPreviewAndContinue(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.mode === "recommended") {
      // 推荐模式：用户点击后重新 preview + confirm。
      this.reselecting = false;
      await this.runAction(async () => {
        this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
        this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
        this.loaded = true;
      });
      return;
    }
    // 自定义模式：重新扫描、保留合法旧分配，然后停在 preview 让用户再确认。
    await this.rescanCustomPreservingAssignments();
  }

  /**
   * 自定义模式重新扫描：按 sourcePath 保留仍然存在且合法的旧目录分配，
   * 用一次 assignMany() 恢复，然后停在 preview 让用户再次确认。
   * 重新 preview 阶段不移动文件、不调用 Provider。
   */
  private async rescanCustomPreservingAssignments(): Promise<void> {
    this.reselecting = false;
    if (await this.rebuildCustomPreviewPreservingAssignments()) {
      this.scheduleRender();
    }
  }

  private customAssignmentsToPreserve(
    job: Readonly<KnowledgeInitializationJob> | null
  ): KnowledgeInitializationAssignment[] {
    return (job?.items ?? [])
      .filter((item) => item.role === "keep"
        || item.role !== knowledgeInitializationSourceDefaultRole(item.sourcePath))
      .map((item) => ({ sourcePath: item.sourcePath, role: item.role }));
  }

  private async rebuildCustomPreviewPreservingAssignments(): Promise<boolean> {
    if (this.busy) return false;
    const previous = this.job;
    const preserved = this.customAssignmentsToPreserve(previous);
    this.busy = true;
    this.clearActionError();
    try {
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("custom");
      this.loaded = true;
      const validPaths = new Set((this.job?.items ?? []).map((item) => item.sourcePath));
      const restorable = preserved.filter(
        (assignment) => validPaths.has(assignment.sourcePath)
          && isKnowledgeInitializationRole(assignment.role)
      );
      if (restorable.length > 0) {
        this.job = await this.plugin.assignManyEchoInkKnowledgeInitializationNotes(
          Object.freeze(restorable)
        );
      }
      this.selectedTab = "custom";
      return true;
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
      this.scheduleRender();
      return false;
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------- done

  private renderDonePanel(panel: HTMLElement): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "circle-check",
      zh ? "知识库状态正常" : "Knowledge folders are ready",
      "ready"
    );
    panel.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "固定目录完整，EchoInk 可以正常整理原始笔记、Wiki 和附件。"
        : "The fixed folder structure is complete, so EchoInk can organize original notes, Wiki content, and attachments."
    });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    const open = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "打开 Wiki 首页" : "Open Wiki home",
      attr: { type: "button" }
    });
    open.onclick = () => void this.openFile("wiki/index.md");
    const maintain = actions.createEl("button", {
      cls: "echoink-knowledge-init-secondary",
      text: zh ? "整理新增笔记" : "Maintain new notes",
      attr: { type: "button" }
    });
    maintain.onclick = () => void this.startRecommended();
  }

  // ---------------------------------------------------------------- helpers

  private dirLabel(role: KnowledgeInitializationRole): string {
    const dir = KNOWLEDGE_INIT_DIRECTORIES.find((candidate) => candidate.role === role);
    if (dir) return this.zh ? dir.labelZh : dir.labelEn;
    return this.zh ? "保持原位" : "Keep in place";
  }

  /** 当前设置派生的可用 Provider 快照；不可用时为 null。 */
  private currentProviderSnapshot(): KnowledgeInitializationProviderSnapshot | null {
    const provider = getActiveApiProvider(this.plugin.settings);
    if (!provider || !apiProviderHasUsableApiKey(provider)) return null;
    if (validateApiProvider(provider).length > 0) return null;
    return { providerId: provider.id, model: provider.model };
  }

  private currentProviderReady(): boolean {
    return this.currentProviderSnapshot() !== null;
  }

  private async openFile(relativePath: string): Promise<void> {
    const file = this.plugin.app.vault.getFileByPath(relativePath);
    if (!file) {
      new Notice(this.zh ? "知识库文件暂不可用。" : "The Knowledge file is unavailable.");
      return;
    }
    await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

function progressStepLabel(
  stage: KnowledgeInitializationProgressStage,
  zh: boolean
): string {
  const labels: Record<KnowledgeInitializationProgressStage, [string, string]> = {
    idle: ["准备中", "Preparing"],
    plan: ["正在准备计划", "Preparing the plan"],
    directories: ["正在创建固定目录", "Creating fixed folders"],
    moving: ["正在移动笔记", "Moving notes"],
    extracting: ["正在提炼 Wiki", "Distilling into Wiki"],
    guide: ["正在生成指南并回读", "Writing and verifying the guide"],
    done: ["即将完成", "Finishing up"]
  };
  return labels[stage][zh ? 0 : 1];
}

function progressStatusSentence(
  stage: KnowledgeInitializationProgressStage,
  progress: { percent: number; completed: number; total: number },
  zh: boolean
): string {
  const step = progressStepLabel(stage, zh);
  if (progress.total <= 0) return `${step} · ${progress.percent}%`;
  return `${step} · ${progress.completed} / ${progress.total} · ${progress.percent}%`;
}
