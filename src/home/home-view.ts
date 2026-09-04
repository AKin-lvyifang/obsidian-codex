import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { SettingsLanguage } from "../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import {
  homeEntryIndexPath,
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
  buildReviewConversationDraft,
  buildRevisitConversationDraft,
  homeConversationTitle,
  type HomeConversationAction
} from "./home-conversation-actions";
import {
  createHomeConversationActionsIsland,
  type HomeConversationActionsIsland
} from "./home-conversation-actions-island";
import { JournalTemplateModal } from "./journal-template-modal";
import {
  formatHomeFullDate,
  formatHomeMonth,
  formatHomeRelativeTime,
  homeCopy,
  type HomeCopy
} from "./home-i18n";
import { openObsidianLocalGraphLeaf } from "./open-native-graph";

export const VIEW_TYPE_ECHOINK_HOME = "codex-echoink-home";

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
    return this.copy.viewTitle;
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
    this.unmountIslands();
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
      manager ? manager.getDashboardSnapshot() : Promise.reject(new Error(this.copy.knowledgeServiceUnavailable))
    ]);
    if (dataResult.status === "fulfilled") {
      this.data = dataResult.value;
    } else {
      this.error = this.copy.localKnowledgeLoadFailed(errorMessage(dataResult.reason));
    }
    if (snapshotResult.status === "fulfilled") {
      this.snapshot = snapshotResult.value;
    } else if (!this.error) {
      this.error = this.copy.maintenanceSnapshotUnavailable(errorMessage(snapshotResult.reason));
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

  async refreshLanguage(): Promise<void> {
    this.unmountIslands();
    this.renderShell();
    await this.refresh();
  }

  private renderShell(): void {
    this.unmountIslands();
    this.contentEl.empty();
    this.pageEl = this.contentEl.createDiv({ cls: "echoink-home-page" });
    this.renderHeader();

    const conversationSection = this.pageEl.createEl("section", { cls: "echoink-home-conversation-section" });
    const conversationHead = this.sectionTitle(conversationSection, this.copy.conversationHeading);
    conversationHead.createSpan({ cls: "echoink-home-section-note", text: this.copy.conversationNote });
    const rhythm = conversationSection.createDiv({ cls: "echoink-home-rhythm-grid" });
    const conversationHost = rhythm.createDiv({ cls: "echoink-home-conversation-island" });
    this.conversationActionsIsland = createHomeConversationActionsIsland(conversationHost);
    this.renderConversationActions();

    this.heatmapEl = rhythm.createEl("section", { cls: "echoink-home-heatmap" });
    this.calendarEl = rhythm.createEl("section", { cls: "echoink-home-calendar-panel" });

    this.entriesEl = this.pageEl.createEl("section", { cls: "echoink-home-entries-section" });
    const entriesHead = this.sectionTitle(this.entriesEl, this.copy.entriesHeading);
    entriesHead.createSpan({ cls: "echoink-home-section-note", text: this.copy.entriesNote });
    const bentoHost = this.entriesEl.createDiv({ cls: "echoink-home-magic-ui" });
    this.bentoIsland = createHomeBentoIsland(bentoHost);
  }

  private renderHeader(): void {
    const header = this.pageEl.createEl("header", { cls: "echoink-home-header" });
    const brand = header.createDiv({ cls: "echoink-home-brand" });
    const mark = brand.createSpan({ cls: "echoink-home-brand-mark" });
    setIcon(mark, "feather");
    const text = brand.createDiv();
    text.createEl("h1", { text: this.copy.workbenchTitle });
    this.headerStatusEl = header.createDiv({ cls: "echoink-home-header-status" });
    const actions = header.createDiv({ cls: "echoink-home-header-actions" });
    this.iconButton(actions, "refresh-cw", this.copy.refreshLocalData, () => void this.refresh());
    this.iconButton(actions, "settings", this.copy.pluginSettings, () => void this.plugin.openWorkspaceResourceSettings());
  }

  private renderHeaderState(): void {
    if (!this.headerStatusEl) return;
    this.headerStatusEl.empty();
    const vault = this.snapshot?.vaultName || this.app.vault.getName?.() || this.copy.currentKnowledgeBase;
    this.headerStatusEl.createSpan({ cls: "echoink-home-vault", text: vault });
    const state = this.headerStatusEl.createSpan({
      cls: `echoink-home-health is-${this.snapshot?.health.status ?? "unknown"}`,
      attr: { role: "status", "aria-live": "polite" },
      text: this.loading
        ? this.copy.loadingLocalKnowledge
        : this.snapshot
          ? `${this.copy.healthStatus(this.snapshot.health.status)} ${this.snapshot.health.score}/100`
          : this.copy.localMode
    });
    if (this.error) {
      state.addClass("is-error");
      state.setAttribute("role", "alert");
      state.setText(this.error);
    }
  }

  private renderConversationActions(): void {
    const vaultName = this.snapshot?.vaultName || this.app.vault.getName?.() || this.copy.currentKnowledgeBase;
    const now = new Date();
    this.conversationActionsIsland?.render([
      {
        id: "daily",
        accessibleName: this.copy.conversation.dailyAccessibleName,
        title: homeConversationTitle("daily", vaultName, now, this.language),
        description: this.copy.conversation.dailyDescription,
        onActivate: () => void this.openConversationAction("daily")
      },
      {
        id: "revisit",
        accessibleName: this.copy.conversation.revisitAccessibleName,
        title: homeConversationTitle("revisit", vaultName, now, this.language),
        description: this.copy.conversation.revisitDescription,
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
        label: this.copy.entry.label(entry.id),
        ariaLabel: this.copy.entry.ariaLabel(entry.id),
        kicker: this.copy.entry.description(entry.id),
        details: this.entryDetailNodes(entry),
        cta: this.copy.entry.action(entry.id),
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
            { tag: "span", text: this.copy.entry.wikiKnowledgeCount(entry.count) },
            { tag: "span", text: this.copy.entry.wikiUpdatedToday(this.snapshot?.wiki.todayCount ?? 0) }
          ]
        },
        { tag: "small", className: "echoink-home-entry-path", text: target?.path ?? this.copy.entry.waitingForWikiIndex }
      ];
    }
    if (entry.id === "outputs") {
      return [
        { tag: "span", className: "echoink-home-entry-value", text: target?.title ?? this.copy.entry.noLocalOutputs },
        { tag: "small", text: target ? this.copy.entry.updatedRecently(formatHomeRelativeTime(target.mtime, this.language)) : this.copy.entry.outputsAfterMaintenance }
      ];
    }
    if (entry.id === "projects") {
      return [
        { tag: "span", className: "echoink-home-entry-value", text: target?.title ?? this.copy.entry.noProjectNotes },
        { tag: "small", text: target ? this.copy.entry.continueFromRecentProject : this.copy.entry.createProjectInProjects }
      ];
    }
    if (entry.id === "inbox") {
      return [
        { tag: "span", className: "echoink-home-entry-number", text: String(entry.count) },
        { tag: "small", text: entry.count ? this.copy.entry.recentInput(target?.title ?? this.copy.entry.pendingOrganization) : this.copy.entry.noPendingInputs }
      ];
    }
    if (entry.id === "journal") {
      return [
        { tag: "span", className: "echoink-home-entry-date", text: formatHomeFullDate(today, this.language) },
        { tag: "span", className: "echoink-home-entry-value", text: journalExists ? this.copy.entry.journalCreated : this.copy.entry.journalDefaultTemplate },
        { tag: "small", text: journalExists ? this.copy.entry.journalContinueWithoutOverwrite : this.copy.entry.journalTemplateOption }
      ];
    }
    const score = this.snapshot?.health.score;
    return [
      {
        tag: "div",
        className: "echoink-home-entry-review-row",
        children: [
          { tag: "span", className: "echoink-home-entry-number", text: score === undefined ? "—" : String(score) },
          { tag: "span", text: this.snapshot ? this.copy.healthStatus(this.snapshot.health.status) : this.copy.entry.waitingForMaintenanceSnapshot }
        ]
      }
    ];
  }

  private renderHeatmap(): void {
    this.heatmapEl.empty();
    const head = this.sectionTitle(this.heatmapEl, this.copy.heatmap.heading);
    const year = new Date().getFullYear();
    const contribution = buildHomeContributionGrid(this.data?.activity ?? [], year, this.language);
    const activityDays = contribution.weeks.flat().filter((day) => day.count > 0).length;
    head.createSpan({ cls: "echoink-home-section-note", text: this.copy.heatmap.note(activityDays) });

    /**
     * Native SmoothUI Contribution Graph adapter.
     * Upstream: https://github.com/educlopez/smoothui/blob/1143ba66738566e8acb9a3f8a7db9eab3f10f2d4/packages/smoothui/components/contribution-graph/index.tsx
     * Mapping: semantic table/caption/axes, 53x7 cells, 10px five-level squares,
     * native title tooltips and legend. Cells are informational, not buttons.
     */
    const scroll = this.heatmapEl.createDiv({ cls: "echoink-home-heatmap-scroll" });
    const table = scroll.createEl("table", { cls: "echoink-home-heatmap-table" });
    table.createEl("caption", { text: this.copy.heatmap.caption(year) });
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
    const weekdays = this.copy.heatmap.weekdays;
    for (let dayIndex = 0; dayIndex < HOME_CONTRIBUTION_DAYS; dayIndex += 1) {
      const row = tbody.createEl("tr");
      row.createEl("th", {
        text: weekdays[dayIndex],
        attr: { scope: "row", title: this.copy.heatmap.weekdayTitle(weekdays[dayIndex]) }
      });
      for (let weekIndex = 0; weekIndex < HOME_CONTRIBUTION_WEEKS; weekIndex += 1) {
        const day = contribution.weeks[weekIndex][dayIndex];
        const description = this.copy.heatmap.dayDescription(day.date, day.fileCount, day.checkCount);
        const cell = row.createEl("td", { attr: { title: description, "aria-label": description } });
        cell.createSpan({
          cls: `echoink-home-heatmap-cell is-level-${day.level}`,
          attr: { "aria-hidden": "true" }
        });
      }
    }
    const legend = this.heatmapEl.createDiv({ cls: "echoink-home-heatmap-legend" });
    legend.createSpan({ text: this.copy.heatmap.less });
    for (const level of [0, 1, 2, 3, 4]) {
      legend.createSpan({ cls: `echoink-home-heatmap-cell is-level-${level}`, attr: { "aria-hidden": "true" } });
    }
    legend.createSpan({ text: this.copy.heatmap.more });
  }

  private renderCalendar(): void {
    this.calendarEl.empty();
    const visibleMonth = this.visibleMonth();
    const head = this.sectionTitle(this.calendarEl, this.copy.calendar.heading);
    const nav = head.createDiv({ cls: "echoink-home-calendar-nav" });
    this.iconButton(nav, "chevron-left", this.copy.calendar.previousMonth, () => this.shiftCalendar(-1));
    nav.createSpan({ text: formatHomeMonth(visibleMonth, this.language) });
    this.iconButton(nav, "chevron-right", this.copy.calendar.nextMonth, () => this.shiftCalendar(1));
    const weekdays = this.calendarEl.createDiv({ cls: "echoink-home-calendar-weekdays" });
    const calendarWeekdays = this.language === "en"
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["一", "二", "三", "四", "五", "六", "日"];
    for (const day of calendarWeekdays) weekdays.createSpan({ text: day });
    const grid = this.calendarEl.createDiv({ cls: "echoink-home-calendar-grid", attr: { "aria-label": this.copy.calendar.ariaLabel } });
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
          "aria-label": this.copy.calendar.dayDescription(formatHomeFullDate(date, this.language), Boolean(record?.exists), activity),
          title: this.copy.calendar.dayTitle(formatHomeFullDate(date, this.language), Boolean(record?.exists), activity)
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
      text: this.copy.calendar.summary(journalCount)
    });
  }

  private async openConversationAction(action: HomeConversationAction): Promise<void> {
    try {
      await this.plugin.activateView();
      const view = this.plugin.getCodexView();
      if (!view) throw new Error(this.copy.conversation.sidebarNotReady);
      const now = new Date();
      const title = action === "daily"
        ? this.copy.conversation.dailySessionTitle(dateKey(now))
        : this.copy.conversation.revisitSessionTitle(dateKey(now));
      const draft = action === "daily"
        ? buildDailyConversationDraft(now, this.language)
        : buildRevisitConversationDraft(this.language);
      await view.createDraftSession(title, draft);
    } catch (error) {
      console.warn("[EchoInk] Failed to prepare Home conversation draft:", error);
      new Notice(this.copy.conversation.cannotCreateSession(errorMessage(error)));
    }
  }

  private async openEntry(entry: HomeEntrySummary): Promise<void> {
    const indexPath = homeEntryIndexPath(entry.id);
    if (indexPath) {
      await openObsidianLocalGraphLeaf(this.app, indexPath, this.language);
      return;
    }
    if (entry.id === "journal") {
      this.openJournalTemplate(new Date());
      return;
    }
    if (entry.id === "review") {
      await this.openReviewConversation();
      return;
    }
  }

  private async openReviewConversation(): Promise<void> {
    try {
      await this.plugin.activateView();
      const view = this.plugin.getCodexView();
      if (!view) throw new Error(this.copy.conversation.sidebarNotReady);
      const now = new Date();
      await view.createDraftSession(this.copy.conversation.reviewSessionTitle(dateKey(now)), buildReviewConversationDraft(now));
    } catch (error) {
      console.warn("[EchoInk] Failed to prepare Home review draft:", error);
      new Notice(this.copy.conversation.cannotCreateReviewSession(errorMessage(error)));
    }
  }

  private async openJournal(date: Date): Promise<void> {
    const path = normalizePath(journalPathForDate(date));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(existing, { active: true });
      return;
    }
    this.openJournalTemplate(date);
  }

  private openJournalTemplate(date: Date): void {
    const customTemplates = this.dataService.listCustomTemplates();
    if (this.data) this.data.customTemplates = customTemplates;
    new JournalTemplateModal(this.app, {
      service: this.dataService,
      customTemplates: [...customTemplates],
      date,
      language: this.language,
      onCreated: () => void this.refresh()
    }).open();
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

  private get language(): SettingsLanguage {
    return this.plugin.settings.settingsLanguage;
  }

  private get copy(): HomeCopy {
    return homeCopy(this.language);
  }

  private unmountIslands(): void {
    this.conversationActionsIsland?.unmount();
    this.conversationActionsIsland = null;
    this.bentoIsland?.unmount();
    this.bentoIsland = null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
