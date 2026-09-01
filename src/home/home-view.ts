import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import {
  HomeWorkbenchDataService,
  type HomeEntrySummary,
  type HomeWorkbenchData
} from "./home-workbench-data";
import {
  EMPTY_HOME_GRAPH_FILTERS,
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  buildHomeContributionGrid,
  buildHomeJournalDays,
  dateKey,
  hasActiveHomeGraphFilters,
  homePropertyFilterIdentity,
  journalPathForDate,
  mergeHomeActivityDays,
  toggleHomeFilterValue,
  toggleHomePropertyFilter,
  type HomeGraphFilters,
  type HomePropertyFilter,
} from "./home-workbench-model";
import {
  HomeGraphController,
  type HomeGraphFallback,
  type HomeGraphRuntimeStats
} from "./home-graph-controller";
import {
  createHomeBentoIsland,
  type HomeBentoDetailNode,
  type HomeBentoIsland
} from "./home-bento-island";
import { createHomeRecentIsland, type HomeRecentIsland } from "./home-recent-island";
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
  private graphFilters: HomeGraphFilters = cloneGraphFilters(EMPTY_HOME_GRAPH_FILTERS);
  private selectedGraphNodeId: string | null = null;
  private graphFallback: HomeGraphFallback = "none";
  private graphFallbackReason = "";
  private readonly graphController: HomeGraphController;

  private pageEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private overviewEl!: HTMLElement;
  private graphFiltersEl!: HTMLElement;
  private graphCountEl!: HTMLElement;
  private graphFallbackEl!: HTMLElement;
  private graphRuntimeHudEl!: HTMLElement;
  private graphRuntimeEl!: HTMLElement;
  private graphSelectionEl!: HTMLElement;
  private graphRelatedEl!: HTMLElement;
  private graphSelectionStatusEl!: HTMLElement;
  private graphScopeButtons = new Map<"local" | "global", HTMLButtonElement>();
  private graphHopsButtons = new Map<"1" | "2" | "3", HTMLButtonElement>();
  private graphNodesStatEl!: HTMLElement;
  private graphLinksStatEl!: HTMLElement;
  private graphTotalStatEl!: HTMLElement;
  private graphFpsStatEl!: HTMLElement;
  private recentEl!: HTMLElement;
  private recentIsland: HomeRecentIsland | null = null;
  private entriesEl!: HTMLElement;
  private bentoIsland: HomeBentoIsland | null = null;
  private heatmapEl!: HTMLElement;
  private calendarEl!: HTMLElement;
  private graphRefreshTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.dataService = new HomeWorkbenchDataService(plugin.app);
    this.graphController = new HomeGraphController({
      onSelect: (nodeId) => {
        this.selectedGraphNodeId = nodeId;
        this.renderGraphSelection();
      },
      onFallbackChange: (fallback, reason) => {
        this.graphFallback = fallback;
        this.graphFallbackReason = reason;
        this.renderGraphState();
      },
      onStatsChange: (stats) => {
        this.renderGraphRuntimeStats(stats);
      }
    });
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
    this.registerDomEvent(document, "visibilitychange", () => {
      this.pageEl.toggleClass("is-document-hidden", document.visibilityState === "hidden");
    });
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (!(event.target instanceof Node)) return;
      const openMenu = this.graphFiltersEl.querySelector<HTMLDetailsElement>(".echoink-home-graph-filter[open]");
      if (!openMenu || openMenu.contains(event.target)) return;
      this.closeGraphFilterMenus();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key !== "Escape" || !this.closeGraphFilterMenus(true)) return;
      event.preventDefault();
    });
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleGraphRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleGraphRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleGraphRefresh()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.graphController.refreshTheme()));
    await this.graphController.mount(this.graphRuntimeEl);
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.graphRefreshTimer !== null) window.clearTimeout(this.graphRefreshTimer);
    this.graphRefreshTimer = null;
    this.recentIsland?.unmount();
    this.recentIsland = null;
    this.bentoIsland?.unmount();
    this.bentoIsland = null;
    this.graphController.dispose();
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
    this.renderOverview();
    this.renderRecentThoughts();
    this.renderEntries();
    this.renderHeatmap();
    this.renderCalendar();
  }

  private scheduleGraphRefresh(): void {
    if (this.graphRefreshTimer !== null) window.clearTimeout(this.graphRefreshTimer);
    this.graphRefreshTimer = window.setTimeout(() => {
      this.graphRefreshTimer = null;
      void this.refresh();
    }, 180);
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.pageEl = this.contentEl.createDiv({ cls: "echoink-home-page" });
    this.renderHeader();

    this.overviewEl = this.pageEl.createEl("section", {
      cls: "echoink-home-overview",
      attr: { "aria-labelledby": "echoink-home-overview-title" }
    });
    this.renderOverviewShell();

    this.recentEl = this.pageEl.createEl("section", { cls: "echoink-home-recent" });
    this.sectionTitle(this.recentEl, "继续最近的思路");
    const recentHost = this.recentEl.createDiv({ cls: "echoink-home-magic-ui" });
    this.recentIsland = createHomeRecentIsland(recentHost, (path) => this.openVaultFile(path));
    this.entriesEl = this.pageEl.createEl("section", { cls: "echoink-home-entries-section" });
    const entriesHead = this.sectionTitle(this.entriesEl, "知识工作入口");
    entriesHead.createSpan({ cls: "echoink-home-section-note", text: "从真实状态继续阅读、整理、写作与复盘" });
    const bentoHost = this.entriesEl.createDiv({ cls: "echoink-home-magic-ui" });
    this.bentoIsland = createHomeBentoIsland(bentoHost);
    const rhythm = this.pageEl.createDiv({ cls: "echoink-home-rhythm-grid" });
    this.heatmapEl = rhythm.createEl("section", { cls: "echoink-home-heatmap" });
    this.calendarEl = rhythm.createEl("section", { cls: "echoink-home-calendar-panel" });
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

  private renderOverviewShell(): void {
    const head = this.overviewEl.createDiv({ cls: "echoink-home-section-head" });
    const copy = head.createDiv();
    copy.createEl("h2", { text: "知识图谱", attr: { id: "echoink-home-overview-title" } });
    copy.createDiv({
      cls: "echoink-home-section-note",
      text: "来自当前 Vault 的 Markdown 与已解析双链"
    });
    const actions = head.createDiv({ cls: "echoink-home-graph-head-actions" });
    this.graphScopeButtons = this.graphButtonGroup(actions, [
      ["local", "局部图谱"],
      ["global", "全局聚合"]
    ], "local", "图谱层级", (scope) => {
      this.graphController.setScope(scope);
      this.renderGraphSelection();
    }, "is-scope");
    const reset = actions.createEl("button", {
      cls: "echoink-home-graph-secondary",
      attr: { type: "button" }
    });
    setIcon(reset.createSpan(), "scan");
    reset.createSpan({ text: "重置视角" });
    reset.onclick = () => this.graphController.resetCamera();

    this.graphFiltersEl = this.overviewEl.createDiv({ cls: "echoink-home-graph-filters" });
    const status = this.overviewEl.createDiv({ cls: "echoink-home-graph-status" });
    this.graphCountEl = status.createDiv({
      cls: "echoink-home-graph-count",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.graphFallbackEl = status.createDiv({ cls: "echoink-home-graph-fallback", attr: { role: "status" } });

    const frame = this.overviewEl.createDiv({ cls: "echoink-home-graph-frame" });
    const stage = frame.createDiv({ cls: "echoink-home-graph-stage" });
    this.graphRuntimeEl = stage.createDiv({ cls: "echoink-home-graph-host" });
    this.graphRuntimeHudEl = stage.createDiv({ cls: "echoink-home-graph-runtime-hud", attr: { "aria-live": "polite" } });
    const side = frame.createEl("aside", { cls: "echoink-home-graph-side", attr: { "aria-label": "图谱当前节点与关联笔记" } });
    this.renderGraphControls(side);
  }

  private renderGraphControls(side: HTMLElement): void {
    const depthSection = side.createDiv({ cls: "echoink-home-graph-side-section" });
    depthSection.createEl("h3", { text: "邻居深度" });
    this.graphHopsButtons = this.graphButtonGroup(depthSection, [
      ["1", "1 跳"],
      ["2", "2 跳"],
      ["3", "3 跳"]
    ], "2", "邻居深度", (value) => {
      this.graphController.setHops(Number(value) as 1 | 2 | 3);
      if (this.graphController.getScope() !== "local") this.graphController.setScope("local");
      this.renderGraphSelection();
    });

    const stats = side.createDiv({ cls: "echoink-home-graph-side-section" });
    stats.createEl("h3", { text: "当前视图" });
    this.graphNodesStatEl = this.graphStat(stats, "渲染节点");
    this.graphLinksStatEl = this.graphStat(stats, "渲染连线");
    this.graphTotalStatEl = this.graphStat(stats, "全库笔记");
    this.graphFpsStatEl = this.graphStat(stats, "帧率");

    const legendSection = side.createDiv({ cls: "echoink-home-graph-side-section" });
    legendSection.createEl("h3", { text: "图例" });
    const legend = legendSection.createDiv({ cls: "echoink-home-graph-legend" });
    legend.createSpan({ cls: "is-current", text: "当前笔记" });
    legend.createSpan({ cls: "is-one-hop", text: "1 跳邻居" });
    legend.createSpan({ cls: "is-two-hop", text: "2 跳邻居" });
    legend.createSpan({ cls: "is-three-hop", text: "3 跳邻居" });

    const selectionSection = side.createDiv({ cls: "echoink-home-graph-side-section is-selection" });
    this.graphSelectionStatusEl = selectionSection.createDiv({
      cls: "echoink-home-graph-selection-status",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" }
    });
    this.graphSelectionEl = selectionSection.createDiv({ cls: "echoink-home-graph-selection" });
    this.graphRelatedEl = selectionSection.createDiv({ cls: "echoink-home-graph-related" });
  }

  private graphStat(container: HTMLElement, label: string): HTMLElement {
    const row = container.createDiv({ cls: "echoink-home-graph-stat" });
    row.createSpan({ text: label });
    return row.createEl("b", { text: "0" });
  }

  private graphButtonGroup<T extends string>(
    container: HTMLElement,
    options: readonly (readonly [T, string])[],
    selected: T,
    label: string,
    onSelect: (value: T) => void,
    extraClass = ""
  ): Map<T, HTMLButtonElement> {
    const group = container.createDiv({
      cls: `echoink-home-graph-segment ${extraClass}`.trim(),
      attr: { role: "group", "aria-label": label }
    });
    const buttons = new Map<T, HTMLButtonElement>();
    for (const [value, text] of options) {
      const button = group.createEl("button", {
        cls: value === selected ? "is-on" : "",
        text,
        attr: { type: "button", "aria-pressed": String(value === selected) }
      });
      button.onclick = () => {
        this.syncGraphButtons(buttons, value);
        onSelect(value);
      };
      buttons.set(value, button);
    }
    return buttons;
  }

  private syncGraphButtons<T extends string>(buttons: Map<T, HTMLButtonElement>, selected: T): void {
    for (const [value, button] of buttons) {
      const active = value === selected;
      button.toggleClass("is-on", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  private renderGraphRuntimeStats(stats: HomeGraphRuntimeStats): void {
    if (this.graphCountEl) {
      this.graphCountEl.setText(`${stats.nodes} 节点 · ${stats.links} 连线 · ${stats.totalNotes} 全库笔记 · ${stats.fps} FPS`);
    }
    if (this.graphRuntimeHudEl) {
      this.graphRuntimeHudEl.setText(stats.status);
      this.graphRuntimeHudEl.toggleClass("is-sleeping", stats.state === "sleeping");
    }
    this.graphNodesStatEl?.setText(String(stats.nodes));
    this.graphLinksStatEl?.setText(String(stats.links));
    this.graphTotalStatEl?.setText(String(stats.totalNotes));
    this.graphFpsStatEl?.setText(String(stats.fps));
    this.syncGraphButtons(this.graphScopeButtons, stats.scope);
    this.syncGraphButtons(this.graphHopsButtons, String(stats.hops) as "1" | "2" | "3");
  }

  private renderOverview(): void {
    const graph = this.data?.graph;
    if (graph) this.graphController.updateData(graph);
    this.renderGraphFilters();
    this.renderGraphState();
  }

  private renderGraphFilters(): void {
    this.graphFiltersEl.empty();
    const searchLabel = this.graphFiltersEl.createEl("label", { cls: "echoink-home-graph-search" });
    searchLabel.createSpan({ text: "搜索" });
    const search = searchLabel.createEl("input", {
      attr: {
        type: "search",
        value: this.graphFilters.search,
        placeholder: "文件名或路径",
        autocomplete: "off"
      }
    });
    search.addEventListener("input", () => {
      this.graphFilters.search = search.value;
      this.applyGraphFilters();
    });

    const options = this.data?.graph.options ?? { folders: [], properties: [], tags: [] };
    this.renderGraphChecklist(
      "文件夹",
      options.folders.map((value) => ({ label: value, identity: value })),
      new Set(this.graphFilters.folders),
      (identity, checked) => {
        this.graphFilters.folders = toggleHomeFilterValue(this.graphFilters.folders, identity, checked);
        this.applyGraphFilters();
      }
    );
    this.renderGraphPropertyChecklist(options.properties);
    this.renderGraphChecklist(
      "标签",
      options.tags.map((value) => ({ label: `#${value}`, identity: value })),
      new Set(this.graphFilters.tags),
      (identity, checked) => {
        this.graphFilters.tags = toggleHomeFilterValue(this.graphFilters.tags, identity, checked);
        this.applyGraphFilters();
      }
    );
    const clear = this.graphFiltersEl.createEl("button", {
      cls: "echoink-home-graph-clear",
      text: "清空筛选",
      attr: { type: "button" }
    });
    clear.disabled = !hasActiveHomeGraphFilters(this.graphFilters);
    clear.onclick = () => {
      this.graphFilters = cloneGraphFilters(EMPTY_HOME_GRAPH_FILTERS);
      this.renderGraphFilters();
      this.applyGraphFilters();
    };
  }

  private renderGraphChecklist(
    label: string,
    options: readonly { label: string; identity: string }[],
    selected: ReadonlySet<string>,
    onChange: (identity: string, checked: boolean) => void
  ): void {
    const details = this.graphFiltersEl.createEl("details", { cls: "echoink-home-graph-filter" });
    const summary = details.createEl("summary", { text: selected.size ? `${label} ${selected.size}` : label });
    this.bindGraphFilterMenu(details);
    const panel = details.createDiv({ cls: "echoink-home-graph-filter-panel" });
    if (!options.length) {
      panel.createDiv({ cls: "echoink-home-empty", text: `当前没有可筛选的${label}` });
      return;
    }
    for (const option of options) {
      const row = panel.createEl("label");
      const input = row.createEl("input", { attr: { type: "checkbox" } });
      input.checked = selected.has(option.identity);
      input.onchange = () => {
        onChange(option.identity, input.checked);
        const count = panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked').length;
        summary.setText(count ? `${label} ${count}` : label);
        details.open = false;
        summary.focus();
      };
      row.createSpan({ text: option.label });
    }
  }

  private renderGraphPropertyChecklist(options: readonly HomePropertyFilter[]): void {
    const selected = new Set(this.graphFilters.properties.map(homePropertyFilterIdentity));
    const details = this.graphFiltersEl.createEl("details", { cls: "echoink-home-graph-filter" });
    const summary = details.createEl("summary", { text: selected.size ? `属性 ${selected.size}` : "属性" });
    this.bindGraphFilterMenu(details);
    const panel = details.createDiv({ cls: "echoink-home-graph-filter-panel" });
    if (!options.length) {
      panel.createDiv({ cls: "echoink-home-empty", text: "当前没有可筛选的属性" });
      return;
    }
    for (const option of options) {
      const row = panel.createEl("label");
      const input = row.createEl("input", { attr: { type: "checkbox" } });
      input.checked = selected.has(homePropertyFilterIdentity(option));
      input.onchange = () => {
        this.graphFilters.properties = toggleHomePropertyFilter(this.graphFilters.properties, option, input.checked);
        const count = this.graphFilters.properties.length;
        summary.setText(count ? `属性 ${count}` : "属性");
        this.applyGraphFilters();
        details.open = false;
        summary.focus();
      };
      row.createSpan({ text: option.value ? `${option.key}: ${option.value}` : option.key });
    }
  }

  private bindGraphFilterMenu(details: HTMLDetailsElement): void {
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      for (const other of Array.from(
        this.graphFiltersEl.querySelectorAll<HTMLDetailsElement>(".echoink-home-graph-filter[open]")
      )) {
        if (other !== details) other.open = false;
      }
    });
  }

  private closeGraphFilterMenus(restoreFocus = false): boolean {
    const openMenus = Array.from(
      this.graphFiltersEl.querySelectorAll<HTMLDetailsElement>(".echoink-home-graph-filter[open]")
    );
    if (!openMenus.length) return false;
    const focusTarget = restoreFocus ? openMenus[openMenus.length - 1]?.querySelector("summary") : null;
    for (const details of openMenus) details.open = false;
    if (focusTarget instanceof HTMLElement) focusTarget.focus();
    return true;
  }

  private applyGraphFilters(): void {
    this.graphController.updateFilters(this.graphFilters);
    const clear = this.graphFiltersEl.querySelector<HTMLButtonElement>(".echoink-home-graph-clear");
    if (clear) clear.disabled = !hasActiveHomeGraphFilters(this.graphFilters);
    this.renderGraphState();
  }

  private renderGraphState(): void {
    if (!this.graphCountEl) return;
    const result = this.graphController.getFilterResult();
    if (!this.graphCountEl.textContent) this.graphCountEl.setText(`${result.nodes.length} / ${result.totalCount} 篇笔记`);
    this.graphFallbackEl.setText(
      this.graphFallback === "error"
        ? `互动图谱暂不可用。${this.graphFallbackReason || "仍可从右栏选择和打开笔记。"}`
        : ""
    );
    this.graphFallbackEl.toggleClass("is-error", this.graphFallback === "error");
    this.renderGraphSelection();
  }

  private renderGraphSelection(): void {
    if (!this.graphSelectionEl) return;
    this.graphSelectionEl.empty();
    this.graphRelatedEl?.empty();
    const result = this.graphController.getFilterResult();
    const global = this.graphController.getScope() === "global";
    const node = this.selectedGraphNodeId
      ? this.data?.graph.nodeById.get(this.selectedGraphNodeId)
      : null;
    const sidebarItems = this.graphController.getSidebarItems();
    this.graphRelatedEl.toggleClass("is-note", !global && Boolean(node));
    if (global) {
      this.graphSelectionStatusEl.setText(`全局主题簇，共 ${sidebarItems.length} 个主题簇。`);
      this.graphSelectionEl.createEl("strong", { text: "全局主题簇" });
      this.graphSelectionEl.createSpan({ text: "按顶层目录聚合当前筛选结果" });
      this.graphRelatedEl.createEl("strong", { text: `主题簇 ${sidebarItems.length}` });
      const list = this.graphRelatedEl.createEl("ul");
      for (const itemData of sidebarItems) {
        const item = list.createEl("li", { cls: "is-cluster" });
        const focus = item.createEl("button", {
          cls: "echoink-home-graph-related-focus",
          attr: { type: "button", title: `进入 ${itemData.title}` }
        });
        focus.createSpan({ text: itemData.title });
        focus.createEl("em", { text: itemData.detail });
        focus.onclick = () => this.graphController.focusNode(itemData.noteId);
      }
      return;
    }
    if (!node) {
      const emptyMessage = result.totalCount
        ? "当前筛选没有匹配笔记。可取消一项条件或清空筛选。"
        : "当前 Vault 还没有 Markdown 笔记。";
      this.graphSelectionStatusEl.setText(emptyMessage);
      this.graphSelectionEl.createSpan({
        cls: "echoink-home-empty",
        text: emptyMessage
      });
      return;
    }
    const currentLabel = formatGraphRelationLabel(node.cluster, node.title);
    this.graphSelectionStatusEl.setText(`当前：${currentLabel}。关联笔记 ${sidebarItems.length} 篇。`);
    const current = this.graphSelectionEl.createDiv({ cls: "echoink-home-graph-related-row is-current is-note" });
    const currentFocus = current.createEl("button", {
      cls: "echoink-home-graph-related-focus",
      text: `当前： ${currentLabel}`,
      attr: { type: "button", "aria-current": "true", title: node.path }
    });
    currentFocus.onclick = () => this.graphController.focusNode(node.id);
    this.renderGraphPopoutButton(current, node.id, node.title);
    if (!sidebarItems.length) {
      this.graphRelatedEl.createSpan({ cls: "echoink-home-empty", text: "当前节点没有已解析关联。" });
      return;
    }
    const list = this.graphRelatedEl.createEl("ul", {
      attr: { "aria-label": `关联笔记 ${sidebarItems.length}` }
    });
    for (const itemData of sidebarItems) {
      const item = list.createEl("li", { cls: "is-note" });
      const relationLabel = formatGraphRelationLabel(itemData.detail, itemData.title);
      const focus = item.createEl("button", {
        cls: "echoink-home-graph-related-focus",
        attr: { type: "button", title: relationLabel },
        text: relationLabel
      });
      focus.onclick = () => {
        const shouldRestoreFocus = document.activeElement === focus;
        const selected = this.graphController.focusNode(itemData.noteId);
        if (selected && shouldRestoreFocus) this.focusCurrentGraphNode();
      };
      item.createSpan({
        cls: "echoink-home-graph-related-cluster",
        text: itemData.detail,
        attr: { "aria-hidden": "true" }
      });
      this.renderGraphPopoutButton(item, itemData.noteId, itemData.title);
    }
  }

  private focusCurrentGraphNode(): void {
    this.graphSelectionEl.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.focus();
  }

  private renderGraphPopoutButton(container: HTMLElement, noteId: string, title: string): void {
    const button = container.createEl("button", {
      cls: "echoink-home-graph-related-open",
      attr: { type: "button", "aria-label": `在 Popout 打开：${title}`, title: `在 Popout 打开：${title}` }
    });
    setIcon(button, "arrow-up-right");
    button.onclick = () => void this.openGraphPopout(noteId);
  }

  /**
   * Official Magic UI Marquee React island.
   * Upstream: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/marquee.tsx
   * Demo behavior: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/example/marquee-demo.tsx
   * Mapping: two horizontal tracks, reverse second row, repeat=4, 1rem gap,
   * 20s linear loop and the upstream Demo's paired 25% edge fades.
   */
  private renderRecentThoughts(): void {
    this.recentIsland?.render((this.data?.recentThoughts ?? []).map((record) => ({
      path: record.path,
      folder: record.folder,
      title: record.title,
      relativeTime: formatRelativeTime(record.mtime)
    })));
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
      let kicker: string | undefined;
      if (entry.id !== "review") kicker = entry.description;
      return {
        id: entry.id,
        label: entry.label,
        ariaLabel: `${ENTRY_ACTION[entry.id]}：${entry.label}`,
        kicker,
        details: this.entryDetailNodes(entry),
        cta: ENTRY_ACTION[entry.id],
        onActivate: () => this.openEntry(entry)
      };
    }));
  }

  private entryDetailNodes(entry: HomeEntrySummary): readonly HomeBentoDetailNode[] {
    const target = entry.targetPath ? this.data?.graph.nodeById.get(entry.targetPath) : null;
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
      },
      {
        tag: "small",
        text: this.snapshot?.lastRun.at
          ? `最近维护 ${formatRelativeTime(this.snapshot.lastRun.at)}`
          : "尚无维护记录，可开始一次复盘"
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

  private async openGraphPopout(relativePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(relativePath));
    if (!(file instanceof TFile)) {
      new Notice(`没有在当前 Vault 找到：${relativePath}`);
      return;
    }
    try {
      await this.app.workspace.getLeaf("window").openFile(file, { active: true });
    } catch (error) {
      console.warn("[EchoInk] Failed to open a Home graph Popout:", error);
      new Notice(`暂时无法在 Popout 打开“${file.basename}”，请稍后重试。`);
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

  private metric(container: HTMLElement, label: string, value: string | number, detail: string): void {
    const metric = container.createDiv({ cls: "echoink-home-metric" });
    metric.createSpan({ text: label });
    metric.createEl("strong", { text: String(value) });
    metric.createEl("small", { text: detail });
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

function formatGraphRelationLabel(cluster: string, title: string): string {
  const parent = cluster.trim();
  const child = title.trim();
  if (!parent || parent === "根目录" || parent === child) return child || parent;
  if (!child) return parent;
  return `${parent} · ${child}`;
}

function cloneGraphFilters(filters: HomeGraphFilters): HomeGraphFilters {
  return {
    search: filters.search,
    folders: [...filters.folders],
    properties: filters.properties.map((filter) => ({ ...filter })),
    tags: [...filters.tags]
  };
}
