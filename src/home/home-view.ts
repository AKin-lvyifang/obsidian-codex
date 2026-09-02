import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import {
  HomeWorkbenchDataService,
  type HomeEntrySummary,
  type HomeWorkbenchData
} from "./home-workbench-data";
import {
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  buildHomeContributionGrid,
  buildHomeJournalDays,
  dateKey,
  journalPathForDate,
  mergeHomeActivityDays
} from "./home-workbench-model";
import {
  createHomeBentoIsland,
  type HomeBentoDetailNode,
  type HomeBentoIsland
} from "./home-bento-island";
import {
  buildDailyConversationDraft,
  buildRevisitConversationDraft,
  homeConversationTitle,
  type HomeConversationAction
} from "./home-conversation-actions";
import {
  createHomeConversationActionsIsland,
  type HomeConversationActionsIsland
} from "./home-conversation-actions-island";
import { JournalTemplateModal } from "./journal-template-modal";

export const VIEW_TYPE_ECHOINK_HOME = "codex-echoink-home";

const ENTRY_ACTION: Record<HomeEntrySummary["id"], string> = {
  wiki: "打开 Wiki",
  outputs: "查看成果",
  projects: "继续项目",
  inbox: "处理输入",
  journal: "写日记",
  review: "开始复盘"
};

export class EchoInkHomeView extends ItemView {
  private readonly dataService: HomeWorkbenchDataService;
  private snapshot: KnowledgeBaseDashboardSnapshot | null = null;
  private data: HomeWorkbenchData | null = null;
  private loading = false;
  private error = "";
  private calendarMonthOffset = 0;

  private pageEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private conversationActionsIsland: HomeConversationActionsIsland | null = null;
  private entriesEl!: HTMLElement;
  private bentoIsland: HomeBentoIsland | null = null;
  private heatmapEl!: HTMLElement;
  private calendarEl!: HTMLElement;
  private homeRefreshTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.dataService = new HomeWorkbenchDataService(plugin.app);
  }

  getViewType(): string {
    return VIEW_TYPE_ECHOINK_HOME;
  }

  getDisplayText(): string {
    return "EchoInk 首页";
  }

  getIcon(): string {
    return "feather";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("codex-home-view", "echoink-home-view");
    this.renderShell();
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleHomeRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleHomeRefresh()));
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.homeRefreshTimer !== null) window.clearTimeout(this.homeRefreshTimer);
    this.homeRefreshTimer = null;
    this.conversationActionsIsland?.unmount();
    this.conversationActionsIsland = null;
    this.bentoIsland?.unmount();
    this.bentoIsland = null;
    this.contentEl.removeClass("codex-home-view", "echoink-home-view");
    this.contentEl.empty();
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    this.renderHeaderState();
    const visibleMonth = this.visibleMonth();
    const manager = this.plugin.getKnowledgeSurfaceService();
    const [dataResult, snapshotResult] = await Promise.allSettled([
      this.dataService.build(visibleMonth),
      manager ? manager.getDashboardSnapshot() : Promise.reject(new Error("知识库管理器尚未准备好"))
    ]);
    if (dataResult.status === "fulfilled") {
      this.data = dataResult.value;
    } else {
      this.error = `本地知识数据读取失败：${errorMessage(dataResult.reason)}`;
    }
    if (snapshotResult.status === "fulfilled") {
      this.snapshot = snapshotResult.value;
    } else if (!this.error) {
      this.error = `维护快照暂不可用：${errorMessage(snapshotResult.reason)}`;
    }
    if (this.data && snapshotResult.status === "fulfilled") {
      this.data.activity = mergeHomeActivityDays(this.data.activity, snapshotResult.value.activity.days);
      this.data.journalDays = buildHomeJournalDays(this.data.records, this.data.activity, visibleMonth);
    }
    this.loading = false;
    this.renderHeaderState();
    this.renderConversationActions();
    this.renderEntries();
    this.renderHeatmap();
    this.renderCalendar();
  }

  private scheduleHomeRefresh(): void {
    if (this.homeRefreshTimer !== null) window.clearTimeout(this.homeRefreshTimer);
    this.homeRefreshTimer = window.setTimeout(() => {
      this.homeRefreshTimer = null;
      void this.refresh();
    }, 180);
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.pageEl = this.contentEl.createDiv({ cls: "echoink-home-page" });
    this.renderHeader();

    const conversationSection = this.pageEl.createEl("section", { cls: "echoink-home-conversation-section" });
    const conversationHead = this.sectionTitle(conversationSection, "从一段对话开始");
    conversationHead.createSpan({ cls: "echoink-home-section-note", text: "先说出来，再决定要不要留下" });
    const rhythm = conversationSection.createDiv({ cls: "echoink-home-rhythm-grid" });
    const conversationHost = rhythm.createDiv({ cls: "echoink-home-conversation-island" });
    this.conversationActionsIsland = createHomeConversationActionsIsland(conversationHost);
    this.renderConversationActions();

    this.heatmapEl = rhythm.createEl("section", { cls: "echoink-home-heatmap" });
    this.calendarEl = rhythm.createEl("section", { cls: "echoink-home-calendar-panel" });

    this.entriesEl = this.pageEl.createEl("section", { cls: "echoink-home-entries-section" });
    const entriesHead = this.sectionTitle(this.entriesEl, "知识工作入口");
    entriesHead.createSpan({ cls: "echoink-home-section-note", text: "从真实状态继续阅读、整理、写作与复盘" });
    const bentoHost = this.entriesEl.createDiv({ cls: "echoink-home-magic-ui" });
    this.bentoIsland = createHomeBentoIsland(bentoHost);
  }

  private renderHeader(): void {
    const header = this.pageEl.createEl("header", { cls: "echoink-home-header" });
    const brand = header.createDiv({ cls: "echoink-home-brand" });
    const mark = brand.createSpan({ cls: "echoink-home-brand-mark" });
    setIcon(mark, "feather");
    const text = brand.createDiv();
    text.createEl("h1", { text: "个人知识工作台" });
    this.headerStatusEl = header.createDiv({ cls: "echoink-home-header-status" });
    const actions = header.createDiv({ cls: "echoink-home-header-actions" });
    this.iconButton(actions, "refresh-cw", "刷新本地数据", () => void this.refresh());
    this.iconButton(actions, "settings", "插件设置", () => void this.plugin.openWorkspaceResourceSettings());
  }

  private renderHeaderState(): void {
    if (!this.headerStatusEl) return;
    this.headerStatusEl.empty();
    const vault = this.snapshot?.vaultName || this.app.vault.getName?.() || "当前知识库";
    this.headerStatusEl.createSpan({ cls: "echoink-home-vault", text: vault });
    const state = this.headerStatusEl.createSpan({
      cls: `echoink-home-health is-${this.snapshot?.health.status ?? "unknown"}`,
      attr: { role: "status", "aria-live": "polite" },
      text: this.loading
        ? "正在读取本地知识…"
        : this.snapshot
          ? `${this.snapshot.health.label} ${this.snapshot.health.score}/100`
          : "本地模式"
    });
    if (this.error) {
      state.addClass("is-error");
      state.setAttribute("role", "alert");
      state.setText(this.error);
    }
  }

  private renderConversationActions(): void {
    const vaultName = this.snapshot?.vaultName || this.app.vault.getName?.() || "当前知识库";
    const now = new Date();
    this.conversationActionsIsland?.render([
      {
        id: "daily",
        accessibleName: "写日记：新建会话并预填日记草稿",
        title: homeConversationTitle("daily", vaultName, now),
        description: "把今天说出来，确认后再整理成日记",
        onActivate: () => void this.openConversationAction("daily")
      },
      {
        id: "revisit",
        accessibleName: "未完想法：新建会话并寻找一件未完成的事",
        title: homeConversationTitle("revisit", vaultName, now),
        description: "从长期记忆里，捡起一件还没说完的事",
        onActivate: () => void this.openConversationAction("revisit")
      }
    ]);
  }

  /**
   * Official Magic UI BentoGrid and AnimatedShinyText React island.
   * Upstream Bento: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/bento-grid.tsx
   * Upstream Shiny Text: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/animated-shiny-text.tsx
   * Mapping: BentoGrid receives six business buttons as direct children; each
   * card keeps one native button and renders the official text animation.
   */
  private renderEntries(): void {
    this.bentoIsland?.render((this.data?.entries ?? []).map((entry) => {
      return {
        id: entry.id,
        label: entry.label,
        ariaLabel: `${ENTRY_ACTION[entry.id]}：${entry.label}`,
        kicker: entry.description,
        details: this.entryDetailNodes(entry),
        cta: ENTRY_ACTION[entry.id],
        onActivate: () => this.openEntry(entry)
      };
    }));
  }

  private entryDetailNodes(entry: HomeEntrySummary): readonly HomeBentoDetailNode[] {
    const target = entry.targetPath
      ? this.data?.records.find((record) => record.path === entry.targetPath)
      : null;
    const today = new Date();
    const journalExists = this.app.vault.getAbstractFileByPath(journalPathForDate(today)) instanceof TFile;
    if (entry.id === "wiki") {
      return [
        {
          tag: "div",
          className: "echoink-home-entry-stat-row",
          children: [
            { tag: "span", text: `${entry.count} 篇知识` },
            { tag: "span", text: `今日更新 ${this.snapshot?.wiki.todayCount ?? 0}` }
          ]
        },
        { tag: "small", className: "echoink-home-entry-path", text: target?.path ?? "等待建立 Wiki 索引" }
      ];
    }
    if (entry.id === "outputs") {
      return [
        { tag: "span", className: "echoink-home-entry-value", text: target?.title ?? "还没有本地成果" },
        { tag: "small", text: target ? `最近更新 ${formatRelativeTime(target.mtime)}` : "完成一次知识维护后会在这里出现" }
      ];
    }
    if (entry.id === "projects") {
      return [
        { tag: "span", className: "echoink-home-entry-value", text: target?.title ?? "还没有项目笔记" },
        { tag: "small", text: target ? "从最近项目继续下一步" : "可在 Projects 目录建立项目" }
      ];
    }
    if (entry.id === "inbox") {
      return [
        { tag: "span", className: "echoink-home-entry-number", text: String(entry.count) },
        { tag: "small", text: entry.count ? `最近输入：${target?.title ?? "待整理"}` : "当前没有待整理输入" }
      ];
    }
    if (entry.id === "journal") {
      return [
        { tag: "span", className: "echoink-home-entry-date", text: formatFullDate(today) },
        { tag: "span", className: "echoink-home-entry-value", text: journalExists ? "今日日记已建立" : "默认使用“此刻速记”" },
        { tag: "small", text: journalExists ? "继续打开，不覆盖已有内容" : "也可进入模板选择或导入 Markdown" }
      ];
    }
    const score = this.snapshot?.health.score;
    return [
      {
        tag: "div",
        className: "echoink-home-entry-review-row",
        children: [
          { tag: "span", className: "echoink-home-entry-number", text: score === undefined ? "—" : String(score) },
          { tag: "span", text: this.snapshot?.health.label ?? "等待本地维护快照" }
        ]
      }
    ];
  }

  private renderHeatmap(): void {
    this.heatmapEl.empty();
    const head = this.sectionTitle(this.heatmapEl, "本地维护活动");
    const year = new Date().getFullYear();
    const contribution = buildHomeContributionGrid(this.data?.activity ?? [], year);
    const activityDays = contribution.weeks.flat().filter((day) => day.count > 0).length;
    head.createSpan({ cls: "echoink-home-section-note", text: `${activityDays} 个活动日 · 文件最后修改时间 + 维护检查` });

    /**
     * Native SmoothUI Contribution Graph adapter.
     * Upstream: https://github.com/educlopez/smoothui/blob/1143ba66738566e8acb9a3f8a7db9eab3f10f2d4/packages/smoothui/components/contribution-graph/index.tsx
     * Mapping: semantic table/caption/axes, 53x7 cells, 10px five-level squares,
     * native title tooltips and legend. Cells are informational, not buttons.
     */
    const scroll = this.heatmapEl.createDiv({ cls: "echoink-home-heatmap-scroll" });
    const table = scroll.createEl("table", { cls: "echoink-home-heatmap-table" });
    table.createEl("caption", { text: `${year} 年本地 Markdown 修改与知识维护活动` });
    const thead = table.createEl("thead");
    const monthRow = thead.createEl("tr");
    monthRow.createEl("th", { cls: "echoink-home-heatmap-corner", attr: { scope: "col" } });
    const firstMonthStartWeek = contribution.months[0]?.startWeek ?? 0;
    if (firstMonthStartWeek > 0) {
      monthRow.createEl("th", {
        attr: { colspan: String(firstMonthStartWeek), "aria-hidden": "true" }
      });
    }
    for (const month of contribution.months) {
      monthRow.createEl("th", {
        text: month.label,
        attr: { scope: "colgroup", colspan: String(month.colSpan) }
      });
    }
    const tbody = table.createEl("tbody");
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    for (let dayIndex = 0; dayIndex < HOME_CONTRIBUTION_DAYS; dayIndex += 1) {
      const row = tbody.createEl("tr");
      row.createEl("th", { text: weekdays[dayIndex], attr: { scope: "row", title: `星期${weekdays[dayIndex]}` } });
      for (let weekIndex = 0; weekIndex < HOME_CONTRIBUTION_WEEKS; weekIndex += 1) {
        const day = contribution.weeks[weekIndex][dayIndex];
        const description = `${day.date}：${day.fileCount} 个文件最后修改，${day.checkCount} 次维护检查`;
        const cell = row.createEl("td", { attr: { title: description, "aria-label": description } });
        cell.createSpan({
          cls: `echoink-home-heatmap-cell is-level-${day.level}`,
          attr: { "aria-hidden": "true" }
        });
      }
    }
    const legend = this.heatmapEl.createDiv({ cls: "echoink-home-heatmap-legend" });
    legend.createSpan({ text: "少" });
    for (const level of [0, 1, 2, 3, 4]) {
      legend.createSpan({ cls: `echoink-home-heatmap-cell is-level-${level}`, attr: { "aria-hidden": "true" } });
    }
    legend.createSpan({ text: "多" });
  }

  private renderCalendar(): void {
    this.calendarEl.empty();
    const visibleMonth = this.visibleMonth();
    const head = this.sectionTitle(this.calendarEl, "日记日历");
    const nav = head.createDiv({ cls: "echoink-home-calendar-nav" });
    this.iconButton(nav, "chevron-left", "上个月", () => this.shiftCalendar(-1));
    nav.createSpan({ text: `${visibleMonth.getFullYear()}年${visibleMonth.getMonth() + 1}月` });
    this.iconButton(nav, "chevron-right", "下个月", () => this.shiftCalendar(1));
    const weekdays = this.calendarEl.createDiv({ cls: "echoink-home-calendar-weekdays" });
    for (const day of ["一", "二", "三", "四", "五", "六", "日"]) weekdays.createSpan({ text: day });
    const grid = this.calendarEl.createDiv({ cls: "echoink-home-calendar-grid", attr: { "aria-label": "日记月历" } });
    const journalByDate = new Map((this.data?.journalDays ?? []).map((day) => [day.date, day]));
    const activityByDate = new Map((this.data?.activity ?? []).map((day) => [day.date, day.count]));
    const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(first.getFullYear(), first.getMonth(), index - offset + 1);
      const key = dateKey(date);
      const currentMonth = date.getMonth() === visibleMonth.getMonth();
      const record = journalByDate.get(key);
      const activity = activityByDate.get(key) ?? 0;
      const button = grid.createEl("button", {
        cls: `echoink-home-calendar-day ${currentMonth ? "" : "is-outside"} ${record?.exists ? "has-journal" : ""} ${key === dateKey(new Date()) ? "is-today" : ""}`,
        attr: {
          type: "button",
          "aria-label": `${formatFullDate(date)}，${record?.exists ? "已有日记" : "没有日记"}，${activity} 条更新`,
          title: `${formatFullDate(date)} · ${record?.exists ? "已有日记" : "没有日记"} · ${activity} 条更新`
        }
      });
      button.createSpan({ cls: "echoink-home-calendar-number", text: String(date.getDate()) });
      if (record?.firstImageUrl) {
        const image = button.createEl("img", { cls: "echoink-home-calendar-image", attr: { src: record.firstImageUrl, alt: "" } });
        image.onerror = () => image.remove();
      }
      if (record?.exists) button.createSpan({ cls: "echoink-home-calendar-journal-dot", attr: { "aria-hidden": "true" } });
      button.onclick = () => void this.openJournal(date);
    }
    const monthPrefix = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}-`;
    const journalCount = [...journalByDate.values()].filter(
      (day) => day.exists && day.date.startsWith(monthPrefix)
    ).length;
    this.calendarEl.createDiv({
      cls: "echoink-home-calendar-summary",
      text: `有日记 · ${journalCount} 天`
    });
  }

  private async openConversationAction(action: HomeConversationAction): Promise<void> {
    try {
      await this.plugin.activateView();
      const view = this.plugin.getCodexView();
      if (!view) throw new Error("右侧会话视图尚未准备好");
      const now = new Date();
      const title = action === "daily" ? `写日记 · ${dateKey(now)}` : `未完想法 · ${dateKey(now)}`;
      const draft = action === "daily"
        ? buildDailyConversationDraft(now)
        : buildRevisitConversationDraft();
      await view.createDraftSession(title, draft);
    } catch (error) {
      console.warn("[EchoInk] Failed to prepare Home conversation draft:", error);
      new Notice(`暂时无法新建会话：${errorMessage(error)}`);
    }
  }

  private async openEntry(entry: HomeEntrySummary): Promise<void> {
    if (entry.id === "journal") {
      await this.openJournal(new Date());
      return;
    }
    if (entry.targetPath) {
      await this.openVaultFile(entry.targetPath);
      return;
    }
    if (entry.id === "review") {
      const manager = this.plugin.getReviewManager();
      if (!manager) {
        new Notice("Review 还没有准备好，请稍后再试");
        return;
      }
      const result = await manager.runReview("knowledge-base");
      if (result.status === "success" && result.markdownPath) await this.openVaultFile(result.markdownPath);
      return;
    }
    const message: Record<HomeEntrySummary["id"], string> = {
      wiki: "Wiki 还没有索引，请先在知识库设置中完成初始化。",
      outputs: "Outputs 还没有成果；运行一次知识维护后会在这里出现。",
      projects: "Projects 还没有项目笔记，可在当前 Vault 的 projects 目录创建。",
      inbox: "Inbox 目前为空，可通过现有记录流程收集新输入。",
      journal: "",
      review: ""
    };
    new Notice(message[entry.id]);
  }

  private async openJournal(date: Date): Promise<void> {
    const path = normalizePath(journalPathForDate(date));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(existing, { active: true });
      return;
    }
    const customTemplates = this.dataService.listCustomTemplates();
    if (this.data) this.data.customTemplates = customTemplates;
    new JournalTemplateModal(this.app, {
      service: this.dataService,
      customTemplates: [...customTemplates],
      date,
      onCreated: () => void this.refresh()
    }).open();
  }

  private async openVaultFile(relativePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(relativePath));
    if (!(file instanceof TFile)) {
      new Notice(`没有在当前 Vault 找到：${relativePath}`);
      return;
    }
    try {
      await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
    } catch (error) {
      console.warn("[EchoInk] Failed to open a Home workbench note:", error);
      new Notice(`暂时无法打开“${file.basename}”，请稍后重试。`);
    }
  }

  private shiftCalendar(offset: number): void {
    this.calendarMonthOffset += offset;
    if (this.data) {
      this.data.journalDays = buildHomeJournalDays(this.data.records, this.data.activity, this.visibleMonth());
    }
    this.renderCalendar();
  }

  private visibleMonth(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + this.calendarMonthOffset, 1);
  }

  private sectionTitle(container: HTMLElement, title: string): HTMLElement {
    const head = container.createDiv({ cls: "echoink-home-section-head" });
    const copy = head.createDiv();
    copy.createEl("h2", { text: title });
    return head;
  }

  private iconButton(container: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "echoink-home-icon-button",
      attr: { type: "button", title: label, "aria-label": label }
    });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.onclick = onClick;
    return button;
  }
}

function formatRelativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
