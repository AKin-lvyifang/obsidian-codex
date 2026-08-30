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
import { HomeGraphController, type HomeGraphFallback } from "./home-graph-controller";
import { JournalTemplateModal } from "./journal-template-modal";
import { NativeFlickeringGrid } from "./magic-ui-adapters";
import { openObsidianGraphLeaf } from "./open-native-graph";

export const VIEW_TYPE_ECHOINK_HOME = "codex-echoink-home";

const ENTRY_ICON: Record<HomeEntrySummary["id"], string> = {
  wiki: "library",
  outputs: "package-open",
  projects: "kanban-square",
  inbox: "inbox",
  journal: "notebook-pen",
  review: "chart-no-axes-combined"
};
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
  private recentPaused = false;
  private graphFilters: HomeGraphFilters = cloneGraphFilters(EMPTY_HOME_GRAPH_FILTERS);
  private selectedGraphNodeId: string | null = null;
  private graphFallback: HomeGraphFallback = "none";
  private graphFallbackReason = "";
  private graphGrid: NativeFlickeringGrid | null = null;
  private readonly graphController: HomeGraphController;

  private pageEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private overviewEl!: HTMLElement;
  private graphFiltersEl!: HTMLElement;
  private graphCountEl!: HTMLElement;
  private graphFallbackEl!: HTMLElement;
  private graphRuntimeEl!: HTMLElement;
  private graphSelectionEl!: HTMLElement;
  private graphListEl!: HTMLDetailsElement;
  private graphListBodyEl!: HTMLElement;
  private recentEl!: HTMLElement;
  private entriesEl!: HTMLElement;
  private heatmapEl!: HTMLElement;
  private calendarEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.dataService = new HomeWorkbenchDataService(plugin.app);
    this.graphController = new HomeGraphController({
      onSelect: (nodeId) => {
        this.selectedGraphNodeId = nodeId;
        this.renderGraphSelection();
        this.syncGraphListSelection();
      },
      onOpen: (nodeId) => void this.openVaultFile(nodeId),
      onFallbackChange: (fallback, reason) => {
        this.graphFallback = fallback;
        this.graphFallbackReason = reason;
        this.renderGraphState();
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
    await this.graphController.mount(this.graphRuntimeEl);
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.graphGrid?.dispose();
    this.graphGrid = null;
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
    this.entriesEl = this.pageEl.createEl("section", { cls: "echoink-home-entries-section" });
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
    const reset = actions.createEl("button", {
      cls: "echoink-home-graph-secondary",
      attr: { type: "button" }
    });
    setIcon(reset.createSpan(), "scan");
    reset.createSpan({ text: "重置视角" });
    reset.onclick = () => this.graphController.resetCamera();
    const open = actions.createEl("button", {
      cls: "echoink-home-graph-secondary",
      attr: { type: "button" }
    });
    setIcon(open.createSpan(), "git-fork");
    open.createSpan({ text: "打开 Obsidian 原生图谱" });
    open.onclick = () => void openObsidianGraphLeaf(this.app);

    this.graphFiltersEl = this.overviewEl.createDiv({ cls: "echoink-home-graph-filters" });
    const status = this.overviewEl.createDiv({ cls: "echoink-home-graph-status" });
    this.graphCountEl = status.createDiv({
      cls: "echoink-home-graph-count",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.graphFallbackEl = status.createDiv({ cls: "echoink-home-graph-fallback", attr: { role: "status" } });

    const frame = this.overviewEl.createDiv({ cls: "echoink-home-graph-frame" });
    const grid = frame.createDiv({ cls: "echoink-home-graph-grid", attr: { "aria-hidden": "true" } });
    this.graphGrid = new NativeFlickeringGrid(grid, {
      squareSize: 4,
      gridGap: 7,
      flickerChance: 0.22,
      maxOpacity: 0.18
    });
    this.graphRuntimeEl = frame.createDiv({ cls: "echoink-home-graph-host" });
    this.graphSelectionEl = frame.createDiv({ cls: "echoink-home-graph-selection" });

    this.graphListEl = this.overviewEl.createEl("details", { cls: "echoink-home-graph-list" });
    this.graphListEl.createEl("summary", { text: "浏览筛选后的笔记" });
    this.graphListBodyEl = this.graphListEl.createDiv({ cls: "echoink-home-graph-list-body" });
  }

  private renderOverview(): void {
    const graph = this.data?.graph;
    if (graph) this.graphController.updateData(graph);
    this.renderGraphFilters();
    this.applyGraphFilters();
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
      };
      row.createSpan({ text: option.label });
    }
  }

  private renderGraphPropertyChecklist(options: readonly HomePropertyFilter[]): void {
    const selected = new Set(this.graphFilters.properties.map(homePropertyFilterIdentity));
    const details = this.graphFiltersEl.createEl("details", { cls: "echoink-home-graph-filter" });
    const summary = details.createEl("summary", { text: selected.size ? `属性 ${selected.size}` : "属性" });
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
      };
      row.createSpan({ text: option.value ? `${option.key}: ${option.value}` : option.key });
    }
  }

  private applyGraphFilters(): void {
    const result = this.graphController.updateFilters(this.graphFilters);
    if (this.selectedGraphNodeId && !result.matchedIds.has(this.selectedGraphNodeId)) {
      this.selectedGraphNodeId = null;
      this.graphController.setSelected(null);
    }
    const clear = this.graphFiltersEl.querySelector<HTMLButtonElement>(".echoink-home-graph-clear");
    if (clear) clear.disabled = !hasActiveHomeGraphFilters(this.graphFilters);
    this.renderGraphState();
  }

  private renderGraphState(): void {
    if (!this.graphCountEl || !this.graphListBodyEl) return;
    const result = this.graphController.getFilterResult();
    this.graphCountEl.setText(`${result.nodes.length} / ${result.totalCount} 篇笔记`);
    this.graphFallbackEl.setText(
      this.graphFallback === "list"
        ? `互动图谱暂不可用。${this.graphFallbackReason || "已切换到笔记列表。"}`
        : "拖动旋转 · 滚动缩放 · 选择节点打开笔记"
    );
    this.graphFallbackEl.toggleClass("is-error", this.graphFallback === "list");
    this.graphListEl.toggleClass("is-fallback", this.graphFallback === "list");
    this.graphListEl.open = this.graphFallback === "list";
    this.graphListBodyEl.empty();
    if (!result.nodes.length) {
      this.graphListBodyEl.createDiv({
        cls: "echoink-home-empty",
        text: result.totalCount ? "当前筛选没有匹配笔记。可取消一项条件或清空筛选。" : "当前 Vault 还没有 Markdown 笔记。"
      });
      this.renderGraphSelection();
      return;
    }
    const list = this.graphListBodyEl.createEl("ul");
    for (const node of result.nodes) {
      const item = list.createEl("li");
      const focus = item.createEl("button", {
        cls: "echoink-home-graph-list-focus",
        attr: {
          type: "button",
          "aria-pressed": String(node.id === this.selectedGraphNodeId),
          "data-node-id": node.id
        }
      });
      focus.createEl("strong", { text: node.title });
      focus.createSpan({ text: node.path });
      focus.onclick = () => {
        this.selectedGraphNodeId = node.id;
        if (!this.graphController.focusNode(node.id)) {
          this.graphController.setSelected(node.id);
          this.renderGraphSelection();
          this.syncGraphListSelection();
        }
      };
      const open = item.createEl("button", { text: "打开笔记", attr: { type: "button" } });
      open.onclick = () => void this.openVaultFile(node.id);
    }
    this.renderGraphSelection();
  }

  private syncGraphListSelection(): void {
    if (!this.graphListBodyEl) return;
    for (const button of Array.from(
      this.graphListBodyEl.querySelectorAll<HTMLButtonElement>(".echoink-home-graph-list-focus")
    )) {
      button.setAttribute("aria-pressed", String(button.dataset.nodeId === this.selectedGraphNodeId));
    }
  }

  private renderGraphSelection(): void {
    if (!this.graphSelectionEl) return;
    this.graphSelectionEl.empty();
    const node = this.selectedGraphNodeId
      ? this.data?.graph.nodeById.get(this.selectedGraphNodeId)
      : null;
    if (!node) {
      this.graphSelectionEl.createSpan({ text: "选择一个节点查看路径与连接数" });
      return;
    }
    this.graphSelectionEl.createEl("strong", { text: node.title });
    this.graphSelectionEl.createSpan({ text: node.path });
    this.graphSelectionEl.createEl("small", { text: `${node.degree} 个已解析连接` });
    const open = this.graphSelectionEl.createEl("button", { text: "打开笔记", attr: { type: "button" } });
    open.onclick = () => void this.openVaultFile(node.id);
  }

  /**
   * Native Magic UI Marquee adapter.
   * Upstream: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/marquee.tsx
   * Demo behavior: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/example/marquee-demo.tsx
   * Mapping: two horizontal tracks, reverse second row, repeat=4, 1rem gap,
   * 20s linear loop and 25% edge fades; host pauses add focus, drag and visibility.
   */
  private renderRecentThoughts(): void {
    this.recentEl.empty();
    const head = this.sectionTitle(this.recentEl, "继续最近的思路");
    const controls = head.createDiv({ cls: "echoink-home-section-controls" });
    controls.createSpan({ cls: "echoink-home-section-note", text: "来自本地最近编辑" });
    const pause = controls.createEl("button", {
      cls: "echoink-home-marquee-toggle",
      text: this.recentPaused ? "继续" : "暂停",
      attr: { type: "button", "aria-pressed": String(this.recentPaused) }
    });
    pause.onclick = () => {
      this.recentPaused = !this.recentPaused;
      this.recentEl.toggleClass("is-user-paused", this.recentPaused);
      pause.setAttribute("aria-pressed", String(this.recentPaused));
      pause.setText(this.recentPaused ? "继续" : "暂停");
    };
    this.recentEl.toggleClass("is-user-paused", this.recentPaused);
    const viewport = this.recentEl.createDiv({ cls: "echoink-home-marquee", attr: { "aria-label": "最近编辑的本地思路" } });
    const recent = this.data?.recentThoughts ?? [];
    if (!recent.length) {
      viewport.createDiv({ cls: "echoink-home-empty", text: "还没有可继续的 Markdown 思路。" });
      pause.disabled = true;
      return;
    }
    const split = Math.max(1, Math.ceil(recent.length / 2));
    const rows = [recent.slice(0, split), recent.slice(split)];
    if (!rows[1].length) rows[1] = [...rows[0]];
    rows.forEach((records, rowIndex) => {
      const track = viewport.createDiv({ cls: `echoink-home-marquee-track ${rowIndex === 1 ? "is-reverse" : ""}` });
      for (let repeat = 0; repeat < 4; repeat += 1) {
        const accessible = repeat === 0 && (rowIndex === 0 || recent.length > 1);
        const group = track.createDiv({ cls: "echoink-home-marquee-group" });
        if (!accessible) {
          group.setAttribute("aria-hidden", "true");
        }
        for (const record of records) {
          const item = accessible
            ? group.createEl("button", {
              cls: "echoink-home-thought",
              attr: { type: "button", title: record.title, "data-path": record.path }
            })
            : group.createDiv({ cls: "echoink-home-thought is-duplicate", attr: { "data-path": record.path } });
          item.createSpan({ cls: "echoink-home-thought-folder", text: record.folder });
          item.createEl("strong", { text: record.title });
          item.createSpan({ text: formatRelativeTime(record.mtime) });
        }
      }
    });
    viewport.createDiv({ cls: "echoink-home-marquee-fade is-left", attr: { "aria-hidden": "true" } });
    viewport.createDiv({ cls: "echoink-home-marquee-fade is-right", attr: { "aria-hidden": "true" } });
    bindHorizontalDrag(viewport);
    viewport.addEventListener("click", (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>(".echoink-home-thought[data-path]");
      const path = item?.dataset.path;
      if (path) void this.openVaultFile(path);
    });
  }

  /**
   * Native Magic UI Bento Grid and Animated Shiny Text adapter.
   * Upstream Bento: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/bento-grid.tsx
   * Upstream Shiny Text: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/animated-shiny-text.tsx
   * Mapping: one button per card, overflow clipping, 40px content/CTA motion,
   * icon scale, 100px shimmer width and the upstream 8s shiny-text animation.
   */
  private renderEntries(): void {
    this.entriesEl.empty();
    const head = this.sectionTitle(this.entriesEl, "知识工作入口");
    head.createSpan({ cls: "echoink-home-section-note", text: "从真实状态继续阅读、整理、写作与复盘" });
    const grid = this.entriesEl.createDiv({ cls: "echoink-home-bento-grid" });
    for (const entry of this.data?.entries ?? []) {
      const card = grid.createEl("button", {
        cls: `echoink-home-entry is-${entry.id}`,
        attr: { type: "button", "aria-label": `${ENTRY_ACTION[entry.id]}：${entry.label}` }
      });
      const icon = card.createSpan({ cls: "echoink-home-entry-icon" });
      setIcon(icon, ENTRY_ICON[entry.id]);
      const copy = card.createDiv({ cls: "echoink-home-entry-copy" });
      copy.createSpan({ cls: "echoink-home-entry-kicker", text: entry.description });
      copy.createEl("strong", { text: entry.label });
      this.renderEntryDetails(copy, entry);
      const cta = card.createSpan({ cls: "echoink-home-entry-cta" });
      cta.createSpan({ cls: "echoink-home-shiny-text", text: `${ENTRY_ACTION[entry.id]} →` });
      card.onclick = () => void this.openEntry(entry);
    }
  }

  private renderEntryDetails(container: HTMLElement, entry: HomeEntrySummary): void {
    const target = entry.targetPath ? this.data?.graph.nodeById.get(entry.targetPath) : null;
    const today = new Date();
    const journalExists = this.app.vault.getAbstractFileByPath(journalPathForDate(today)) instanceof TFile;
    if (entry.id === "wiki") {
      const row = container.createDiv({ cls: "echoink-home-entry-stat-row" });
      row.createSpan({ text: `${entry.count} 篇知识` });
      row.createSpan({ text: `今日更新 ${this.snapshot?.wiki.todayCount ?? 0}` });
      container.createEl("small", { cls: "echoink-home-entry-path", text: target?.path ?? "等待建立 Wiki 索引" });
      return;
    }
    if (entry.id === "outputs") {
      container.createSpan({ cls: "echoink-home-entry-value", text: target?.title ?? "还没有本地成果" });
      container.createEl("small", {
        text: target ? `最近更新 ${formatRelativeTime(target.mtime)}` : "完成一次知识维护后会在这里出现"
      });
      return;
    }
    if (entry.id === "projects") {
      container.createSpan({ cls: "echoink-home-entry-value", text: target?.title ?? "还没有项目笔记" });
      container.createEl("small", { text: target ? "从最近项目继续下一步" : "可在 Projects 目录建立项目" });
      return;
    }
    if (entry.id === "inbox") {
      container.createSpan({ cls: "echoink-home-entry-number", text: String(entry.count) });
      container.createEl("small", { text: entry.count ? `最近输入：${target?.title ?? "待整理"}` : "当前没有待整理输入" });
      return;
    }
    if (entry.id === "journal") {
      container.createSpan({ cls: "echoink-home-entry-date", text: formatFullDate(today) });
      container.createSpan({
        cls: "echoink-home-entry-value",
        text: journalExists ? "今日日记已建立" : "默认使用“此刻速记”"
      });
      container.createEl("small", { text: journalExists ? "继续打开，不覆盖已有内容" : "也可进入模板选择或导入 Markdown" });
      return;
    }
    const score = this.snapshot?.health.score;
    const row = container.createDiv({ cls: "echoink-home-entry-review-row" });
    row.createSpan({ cls: "echoink-home-entry-number", text: score === undefined ? "—" : String(score) });
    row.createSpan({ text: this.snapshot?.health.label ?? "等待本地维护快照" });
    container.createEl("small", {
      text: this.snapshot?.lastRun.at
        ? `最近维护 ${formatRelativeTime(this.snapshot.lastRun.at)}`
        : "尚无维护记录，可开始一次复盘"
    });
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

function cloneGraphFilters(filters: HomeGraphFilters): HomeGraphFilters {
  return {
    search: filters.search,
    folders: [...filters.folders],
    properties: filters.properties.map((filter) => ({ ...filter })),
    tags: [...filters.tags]
  };
}

function bindHorizontalDrag(viewport: HTMLElement): void {
  let pointerId: number | null = null;
  let startX = 0;
  let startScroll = 0;
  let moved = false;
  let suppressClick = false;
  viewport.addEventListener("pointerdown", (event) => {
    pointerId = event.pointerId;
    startX = event.clientX;
    startScroll = viewport.scrollLeft;
    moved = false;
    viewport.setPointerCapture(event.pointerId);
    viewport.addClass("is-dragging");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const distance = event.clientX - startX;
    if (Math.abs(distance) >= 6) moved = true;
    if (moved) viewport.scrollLeft = startScroll - distance;
  });
  const stop = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    suppressClick = moved;
    pointerId = null;
    viewport.removeClass("is-dragging");
    window.setTimeout(() => { suppressClick = false; }, 0);
  };
  viewport.addEventListener("pointerup", stop);
  viewport.addEventListener("pointercancel", stop);
  viewport.addEventListener("click", (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
}
