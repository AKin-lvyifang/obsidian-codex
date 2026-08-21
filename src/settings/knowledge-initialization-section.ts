import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import {
  isKnowledgeInitializationRole,
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

type KnowledgeInitDirectoryRole = Exclude<KnowledgeInitializationRole, "keep">;

interface KnowledgeInitDirectoryDef {
  readonly role: KnowledgeInitDirectoryRole;
  readonly labelZh: string;
  readonly labelEn: string;
}

/**
 * 自定义分配的十个固定目录。前九个可分配 Markdown；assets 是附件目录，
 * 只展示、不参与笔记分配。
 */
export const KNOWLEDGE_INIT_DIRECTORIES: readonly KnowledgeInitDirectoryDef[] = Object.freeze([
  { role: "raw", labelZh: "Raw", labelEn: "Raw" },
  { role: "wiki", labelZh: "Wiki", labelEn: "Wiki" },
  { role: "projects", labelZh: "Projects", labelEn: "Projects" },
  { role: "outputs", labelZh: "Outputs", labelEn: "Outputs" },
  { role: "inbox", labelZh: "Inbox", labelEn: "Inbox" },
  { role: "journal", labelZh: "Journal", labelEn: "Journal" },
  { role: "work", labelZh: "Work", labelEn: "Work" },
  { role: "archive", labelZh: "Archive", labelEn: "Archive" },
  { role: "templates", labelZh: "Templates", labelEn: "Templates" }
]);

const KNOWLEDGE_INIT_ASSETS_LABEL_ZH = "附件目录";
const KNOWLEDGE_INIT_ASSETS_LABEL_EN = "Attachments folder";

const PLAN_COPY_ZH =
  "参考卡帕西式的分层知识整理思路，EchoInk 会创建 Raw、Wiki、Projects 等固定目录。"
  + "体系外的 Markdown 笔记会移动到 Raw，随后按最多 20 篇一批调用 /maintain 提炼为 Wiki。"
  + "已有笔记不会被改写或删除，附件保持原位；中途暂停后可以继续。";

const PLAN_COPY_EN =
  "Inspired by Karpathy-style layered knowledge organization, EchoInk creates fixed folders "
  + "such as Raw, Wiki, and Projects. Markdown notes outside the structure move into Raw, then "
  + "/maintain distills them into Wiki in batches of up to 20. Existing notes are never rewritten "
  + "or deleted, attachments stay in place, and you can resume after pausing.";

const FOCUS_KEY = "knowledge:initialize";

interface KnowledgeInitProgressRefs {
  readonly rootEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly barEl: HTMLElement;
  readonly percentEl: HTMLElement;
  readonly stepEl: HTMLElement;
  readonly countEl: HTMLElement;
}

/**
 * 知识库初始化体验的唯一渲染入口。settings-tab.ts 只负责创建本类、
 * 调用 render() 并在 hide() 时 dispose()；全部初始化 UI 状态在这里维护。
 *
 * 普通主界面不暴露 revision/hash、冻结计划、Provider/model 快照、WAL、CAS、
 * Readback 等内部概念；它们保留在后台 job 中，仅出现在「查看技术详情」折叠区。
 *
 * 渲染优先级：当前作业优先，历史完成标记兜底。settings 里的 initialized
 * 历史事实不会被清除，但只要存在未完成作业（preview/active/可恢复态），
 * 就显示作业界面，不会被「知识库已就绪」遮住。
 */
export class KnowledgeInitializationSection {
  private job: Readonly<KnowledgeInitializationJob> | null = null;
  private loaded = false;
  private loading = false;
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
  private actionErrorDetail = "";
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
  }

  render(page: HTMLElement, zh: boolean): void {
    this.pageEl = page;
    this.zh = zh;
    this.progressRefs = null;
    const section = createSettingsSection(page, {
      title: zh ? "知识库管理" : "Knowledge management",
      surface: "flat"
    });
    const panel = section.createDiv({
      cls: "echoink-settings-feature-card echoink-knowledge-init-panel"
    });
    if (!this.loaded && !this.loading && !this.loadError) void this.load();
    if (this.loading && !this.loaded) {
      panel.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在读取初始化状态…" : "Loading initialization state…"
      });
      return;
    }
    const settingsInitialized =
      this.plugin.settings.knowledgeBase.initialization.status === "initialized";
    const job = this.job;
    if (this.loadError && !job) {
      createSettingsState(panel, this.loadError, "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.load()
      });
      return;
    }
    // 用户动作失败提示：所有面板共用，成功或重新执行时清除。
    this.renderActionError(panel);
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
    if (!job) {
      // 不存在任何作业：历史完成标记兜底，否则进入方案选择。
      if (settingsInitialized) {
        this.renderDonePanel(panel);
      } else {
        this.renderTabsPanel(panel);
      }
      return;
    }
    if (job.status === "initialized") {
      this.renderDonePanel(panel);
      return;
    }
    // 可恢复态优先于历史完成标记：settings 已 initialized 但出现新的
    // 未完成作业（paused/cancelled/failed/blocked/write_uncertain）时，
    // 不能被「知识库已就绪」遮住。
    this.renderPausedPanel(panel, job);
  }

  // ---------------------------------------------------------------- loading

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = "";
    try {
      this.job = await this.plugin.getEchoInkKnowledgeInitializationState();
      this.loaded = true;
      if (this.job?.mode === "custom") this.selectedTab = "custom";
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.scheduleRender();
    }
  }

  private async reloadAfterActionError(): Promise<void> {
    try {
      this.job = await this.plugin.getEchoInkKnowledgeInitializationState();
      this.loaded = true;
    } catch {
      // 保留当前界面状态；由下一次渲染展示可重试的状态。
    }
  }

  // ------------------------------------------------------------ action errors

  /** 记录面向用户的短文案；原始错误只出现在「查看技术详情」里。 */
  private recordActionError(error: unknown): void {
    this.actionErrorDetail = error instanceof Error ? error.message : String(error);
    this.actionError = this.zh
      ? "操作没有完成，可以再试一次。"
      : "The action didn't complete. You can try again.";
  }

  private clearActionError(): void {
    this.actionError = "";
    this.actionErrorDetail = "";
  }

  private renderActionError(panel: HTMLElement): void {
    if (!this.actionError) return;
    const box = panel.createDiv({
      cls: "echoink-knowledge-init-action-error",
      attr: { role: "alert" }
    });
    box.createDiv({ cls: "echoink-knowledge-init-action-error-text", text: this.actionError });
    const details = box.createEl("details", { cls: "echoink-knowledge-init-tech" });
    details.createEl("summary", {
      text: this.zh ? "查看技术详情" : "View technical details"
    });
    details.createDiv({
      cls: "echoink-knowledge-init-tech-value",
      text: this.actionErrorDetail
    });
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
        ? "一次点击：体系外的 Markdown 收进 Raw，再分批提炼成 Wiki。"
        : "One click moves stray Markdown into Raw, then distills it into Wiki in batches."
    });
    const details = body.createEl("details", { cls: "echoink-knowledge-init-plan-details" });
    details.createEl("summary", { text: zh ? "方案说明" : "Plan details" });
    details.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh ? PLAN_COPY_ZH : PLAN_COPY_EN
    });
    const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
    const cta = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "开始初始化" : "Start initialization",
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    }) as HTMLButtonElement;
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
    }) as HTMLButtonElement;
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
      }) as HTMLButtonElement;
      add.disabled = this.busy;
      add.onclick = () => this.openNotePicker(dir.role, add);
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
            }) as HTMLButtonElement;
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

  private openNotePicker(role: KnowledgeInitDirectoryRole, triggerEl: HTMLElement): void {
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

  // ---------------------------------------------------------------- progress

  private renderProgressPanel(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    panel.createDiv({
      cls: "echoink-knowledge-init-heading",
      text: zh ? "正在初始化知识库" : "Initializing your knowledge base"
    });
    // 进度只来自真实 job 字段；运行中不会出现 100%（完成即切换完成态）。
    const progress = buildKnowledgeInitializationProgress(job, false);
    const step = progressStepLabel(progress.stage, zh);
    const rootEl = panel.createDiv({ cls: "echoink-knowledge-init-progress" });
    // 稳定存在的 live region；后续只更新文本，不设置 tabindex。
    const statusEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    statusEl.setText(progressStatusSentence(progress.stage, progress, zh));
    const barRow = rootEl.createDiv({ cls: "echoink-knowledge-init-bar-row" });
    const barEl = barRow.createEl("progress", {
      cls: "echoink-knowledge-init-bar",
      attr: {
        max: "100",
        value: String(progress.percent),
        "aria-label": zh ? "初始化进度" : "Initialization progress"
      }
    });
    const percentEl = barRow.createSpan({
      cls: "echoink-knowledge-init-percent",
      text: `${progress.percent}%`
    });
    const stepEl = rootEl.createDiv({ cls: "echoink-knowledge-init-step", text: step });
    const countEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-count",
      text: progress.total > 0 ? `${progress.completed} / ${progress.total}` : ""
    });
    this.progressRefs = { rootEl, statusEl, barEl, percentEl, stepEl, countEl };
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
      this.job = await this.plugin.getEchoInkKnowledgeInitializationState();
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
    refs.barEl.setAttr("value", String(progress.percent));
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
      reselect.onclick = () => this.enterPlanSelection(job.mode);
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
      reselect.onclick = () => this.enterPlanSelection(job.mode);
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
      reselect.onclick = () => this.enterPlanSelection(job.mode);
    }
    this.renderTechnicalDetails(panel, job);
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
  private enterPlanSelection(_mode: KnowledgeInitializationMode): void {
    this.reselecting = true;
    this.clearActionError();
    this.scheduleRender();
  }

  private renderTechnicalDetails(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    const details = panel.createEl("details", { cls: "echoink-knowledge-init-tech" });
    details.createEl("summary", { text: zh ? "查看技术详情" : "View technical details" });
    const rows = details.createDiv({ cls: "echoink-knowledge-init-tech-list" });
    const addRow = (label: string, value: string): void => {
      const row = rows.createDiv({ cls: "echoink-knowledge-init-tech-row" });
      row.createDiv({ cls: "echoink-knowledge-init-tech-label", text: label });
      row.createDiv({ cls: "echoink-knowledge-init-tech-value", text: value || "-" });
    };
    addRow(zh ? "内部状态" : "Internal status", `${job.status} · ${job.phase}`);
    addRow("lastError", job.lastError);
    addRow("recoveryAction", job.recoveryAction);
    addRow("Provider", job.provider ? `${job.provider.providerId} · ${job.provider.model}` : "");
    addRow("planDigest", job.planDigest);
    addRow(
      zh ? "内部计数" : "Internal counts",
      `move ${job.counts.move} · keep ${job.counts.keep} · conflict ${job.counts.conflict}`
      + ` · ignored ${job.counts.ignored} · extraction ${job.counts.extraction}`
      + ` · batches ${job.expectedBatches}`
    );
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
    const previous = this.job;
    const preserved = (previous?.items ?? [])
      .filter((item) => item.role !== "keep" && item.role !== "raw")
      .map((item) => ({ sourcePath: item.sourcePath, role: item.role }));
    this.reselecting = false;
    await this.runAction(async () => {
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
    });
  }

  // ------------------------------------------------------------------- done

  private renderDonePanel(panel: HTMLElement): void {
    const zh = this.zh;
    panel.createDiv({
      cls: "echoink-knowledge-init-heading",
      text: zh ? "知识库已就绪" : "Knowledge is ready"
    });
    panel.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "固定目录、指南与 Wiki 索引已生成；已有内容不会被改写。"
        : "Fixed folders, the guide, and the Wiki index are ready; existing content is never rewritten."
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
