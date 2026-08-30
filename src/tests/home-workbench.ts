import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { App } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  EMPTY_HOME_GRAPH_FILTERS,
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  HOME_ENTRY_IDS,
  applyJournalTemplate,
  buildHomeActivityDays,
  buildHomeContributionGrid,
  buildHomeGraph,
  buildHomeJournalDays,
  decodeImportedMarkdown,
  extractFirstLocalImageTarget,
  filterHomeGraph,
  homeContributionLevel,
  importedTemplatePath,
  isKnowledgeBaseReviewPath,
  journalPathForDate,
  mergeHomeActivityDays,
  nextAvailableImportedTemplatePath,
  parseImportedJournalTemplate,
  type HomeVaultFileRecord
} from "../home/home-workbench-model";
import { openObsidianGraphLeaf } from "../home/open-native-graph";
import { openTestNoticeMessages } from "./obsidian-shim";

export async function runHomeWorkbenchTests(): Promise<void> {
  assertFixedEntryAndTemplateContracts();
  assertActivityAndJournalCalendar();
  assertSmoothUiContributionGrid();
  assertImageExtraction();
  assertTemplateImportAndPlaceholderPreservation();
  assertReviewRecognitionAndUtf8Import();
  assertHomeGraphFiltering();
  assertHomeGraphAndMagicUiContracts();
  await assertNativeGraphBehavior();
}

function assertHomeGraphFiltering(): void {
  const records = fixtureRecords();
  const graph = buildHomeGraph(records, {
    "projects/a.md": { "projects/b.md": 2, "wiki/c.md": 1 },
    "inbox/d.md": { "missing.md": 3 }
  });
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.links, [
    { source: "projects/a.md", target: "projects/b.md", count: 2 },
    { source: "projects/a.md", target: "wiki/c.md", count: 1 }
  ]);
  assert.equal(graph.nodeById.get("projects/a.md")?.degree, 3);
  assert.equal(graph.nodeById.get("projects/b.md")?.degree, 2);
  assert.ok(graph.options.folders.includes("projects"));
  assert.ok(graph.options.tags.includes("product"));
  assert.ok(graph.options.properties.some((option) => option.key === "status" && option.value === "active"));
  assert.ok(graph.options.properties.some((option) => option.key === "owner" && option.value === undefined));

  const bySearch = filterHomeGraph(graph, { ...EMPTY_HOME_GRAPH_FILTERS, search: "knowledge map" });
  assert.deepEqual(bySearch.nodes.map((node) => node.id), ["projects/a.md"]);
  const withinCategoryUnion = filterHomeGraph(graph, {
    ...EMPTY_HOME_GRAPH_FILTERS,
    properties: [{ key: "status", value: "active" }, { key: "owner", value: "fang" }]
  });
  assert.deepEqual(withinCategoryUnion.nodes.map((node) => node.id), ["projects/a.md", "wiki/c.md"]);
  const acrossCategoryIntersection = filterHomeGraph(graph, {
    search: "",
    folders: ["projects"],
    properties: [{ key: "status", value: "active" }],
    tags: ["product"]
  });
  assert.deepEqual(acrossCategoryIntersection.nodes.map((node) => node.id), ["projects/a.md"]);
  assert.equal(acrossCategoryIntersection.links.length, 0);
  const zero = filterHomeGraph(graph, { ...EMPTY_HOME_GRAPH_FILTERS, tags: ["not-present"] });
  assert.equal(zero.nodes.length, 0);
  assert.equal(zero.totalCount, 4);
}

function assertHomeGraphAndMagicUiContracts(): void {
  const view = readFileSync("src/home/home-view.ts", "utf8");
  const data = readFileSync("src/home/home-workbench-data.ts", "utf8");
  const controller = readFileSync("src/home/home-graph-controller.ts", "utf8");
  const gridAdapter = readFileSync("src/home/magic-ui-adapters.ts", "utf8");
  const nativeGraph = readFileSync("src/home/open-native-graph.ts", "utf8");
  const viewService = readFileSync("src/plugin/view-service.ts", "utf8");
  const styles = readFileSync("styles.css", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> };
  const fixedCommit = "2d671cc6c0e0f40e28682c9cbddd16694dcfe627";
  const smoothUiCommit = "1143ba66738566e8acb9a3f8a7db9eab3f10f2d4";
  const heatmapSource = view.match(/private renderHeatmap\(\): void \{[\s\S]*?private renderCalendar/u)?.[0] ?? "";

  assert.equal(packageJson.dependencies?.["3d-force-graph"], "1.80.0");
  assert.match(data, /buildHomeGraph\(records, this\.app\.metadataCache\.resolvedLinks\)/u);
  assert.match(view, /HomeGraphController/u);
  assert.match(view, /NativeFlickeringGrid/u);
  assert.match(view, /syncGraphListSelection/u);
  assert.match(view, /"data-node-id": node\.id/u);
  assert.match(view, /知识图谱/u);
  for (const label of ["搜索", "文件夹", "属性", "标签", "清空筛选"]) assert.match(view, new RegExp(label, "u"));
  assert.match(view, /打开 Obsidian 原生图谱/u);
  assert.match(controller, /await import\("3d-force-graph"\)/u);
  assert.match(controller, /new ResizeObserver/u);
  assert.match(controller, /new IntersectionObserver/u);
  assert.match(controller, /new MutationObserver/u);
  assert.match(controller, /webglcontextlost/u);
  assert.match(controller, /graph\._destructor\(\)/u);
  assert.match(controller, /setFallback\("list"/u);
  assert.match(controller, /已切换到可筛选的笔记列表，仍可继续选择和打开笔记/u);
  assert.match(controller, /this\.options\.onOpen\(node\.id\)/u);
  assert.match(view, /try \{[\s\S]*openFile\(file, \{ active: true \}\)[\s\S]*暂时无法打开/u);
  assert.doesNotMatch(view + data + controller, /internalPlugins|dataEngine|GraphView|iframe/u);

  assert.match(view, new RegExp(fixedCommit, "u"));
  assert.match(gridAdapter, new RegExp(fixedCommit, "u"));
  assert.match(view, new RegExp(smoothUiCommit, "u"));
  assert.match(heatmapSource, /createEl\("table"/u);
  assert.match(heatmapSource, /createEl\("caption"/u);
  assert.match(heatmapSource, /scope: "colgroup"/u);
  assert.match(heatmapSource, /scope: "row"/u);
  assert.doesNotMatch(heatmapSource, /createEl\("button"|new Notice|tabindex|moveHeatmapFocus/u);

  assert.match(nativeGraph, /getLeavesOfType\("graph"\)\[0\]/u);
  assert.match(nativeGraph, /getLeaf\("tab"\)/u);
  assert.match(nativeGraph, /setViewState\(\{ type: "graph", active: true, state: \{\} \}\)/u);
  assert.match(nativeGraph, /revealLeaf\(leaf\)/u);
  assert.doesNotMatch(nativeGraph, /internalPlugins|renderer|dataEngine|iframe/u);
  assert.match(viewService, /async openObsidianGraph\(\): Promise<boolean>/u);

  assert.match(view, /"data-path": record\.path/u);
  assert.doesNotMatch(view, /setAttribute\("inert"/u);
  assert.match(view, /closest<HTMLElement>\("\.echoink-home-thought\[data-path\]"/u);
  assert.match(view, /Math\.abs\(distance\) >= 6/u);
  assert.doesNotMatch(styles, /\.echoink-home-thought\.is-duplicate\s*\{[^}]*pointer-events:\s*none/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.echoink-home-marquee-group:first-child[\s\S]*display: flex/u);

  assert.match(styles, /\.echoink-home-bento-grid[\s\S]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /\.echoink-home-entry\.is-wiki[\s\S]*grid-column: 1 \/ 5;[\s\S]*grid-row: 1 \/ 3/u);
  assert.match(styles, /\.echoink-home-entry\.is-journal[\s\S]*grid-column: 9 \/ 13;[\s\S]*grid-row: 2 \/ 4/u);
  assert.match(styles, /\.echoink-home-entry\.is-review[\s\S]*grid-column: 1 \/ 9;[\s\S]*grid-row: 3/u);
  assert.match(styles, /@container echoink-home \(max-width: 1100px\)[\s\S]*repeat\(6, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 800px\)[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry\.is-review\s*\{[^}]*display: grid;[^}]*grid-template-columns: 40px minmax\(0, 1fr\);/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry\.is-review \.echoink-home-entry-cta\s*\{[^}]*grid-column: 1 \/ -1;/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry-cta,[\s\S]*justify-content: flex-end;/u);
  assert.doesNotMatch(styles, /grid-auto-flow:\s*dense/u);
  assert.match(view, /今日日记已建立|默认使用“此刻速记”/u);
  assert.doesNotMatch(view, /private renderToday/u);

  assert.match(styles, /--echoink-home-canvas: var\(--background-primary\)/u);
  assert.match(styles, /--echoink-home-ink: var\(--text-normal\)/u);
  assert.match(styles, /font-family: var\(--font-interface\)/u);
  assert.doesNotMatch(styles, /--echoink-home-canvas: #07080a|font-family: Inter/u);
  assert.match(styles, /\.echoink-home-graph-grid[\s\S]*pointer-events: none/u);
  assert.match(styles, /font-variant-numeric: tabular-nums/u);
  assert.match(styles, /\.echoink-home-marquee-fade[\s\S]*width: 25%/u);
  assert.match(styles, /animation: echoink-home-marquee var\(--echoink-home-marquee-duration, 20s\) linear infinite/u);
  assert.match(styles, /--shiny-width: 100px/u);
  assert.match(styles, /animation: echoink-home-shiny-text 8s infinite/u);
  assert.match(styles, /background-image: linear-gradient\(90deg, transparent, color-mix\(in srgb, var\(--text-normal\) 80%, transparent\) 50%, transparent\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.echoink-home-entry-cta[\s\S]*opacity: 1/u);
  assert.match(styles, /@container echoink-home \(min-width: 1260px\)[\s\S]*minmax\(760px, 1fr\) minmax\(340px, 0\.44fr\)/u);
}

function assertSmoothUiContributionGrid(): void {
  const day = (date: string, count: number) => ({
    date,
    count,
    fileCount: count,
    checkCount: 0,
    level: count > 0 ? "low" as const : "none" as const
  });
  const grid = buildHomeContributionGrid([
    day("2026-01-02", 1),
    day("2026-07-01", 2),
    day("2026-12-31", 6)
  ], 2026);
  const cells = grid.weeks.flat();
  assert.equal(grid.weeks.length, HOME_CONTRIBUTION_WEEKS);
  assert.ok(grid.weeks.every((week) => week.length === HOME_CONTRIBUTION_DAYS));
  assert.equal(cells.length, 371);
  assert.equal(cells.filter((cell) => cell.count > 0).length, 3);
  assert.equal(grid.months[0]?.label, "1月");
  assert.equal(grid.months[0]?.startWeek, 1);
  assert.equal(grid.months.some((month) => month.label === "12月" && month.startWeek === 0), false);
  assert.equal(grid.months.reduce((total, month) => total + month.colSpan, 0), 52);
  assert.deepEqual([0, 1, 2, 3, 6].map(homeContributionLevel), [0, 1, 2, 3, 4]);
}

async function assertNativeGraphBehavior(): Promise<void> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    openTestNoticeMessages.length = 0;
    const reusedLeaf = createGraphLeaf("graph");
    const reused = createGraphApp([reusedLeaf], createGraphLeaf("empty"));
    assert.equal(await openObsidianGraphLeaf(reused.app), true);
    assert.equal(reused.getLeafCalls(), 0);
    assert.deepEqual(reused.revealed, [reusedLeaf]);
    assert.deepEqual(openTestNoticeMessages, []);

    openTestNoticeMessages.length = 0;
    const createdLeaf = createGraphLeaf("empty");
    const created = createGraphApp([], createdLeaf);
    assert.equal(await openObsidianGraphLeaf(created.app), true);
    assert.equal(created.getLeafCalls(), 1);
    assert.deepEqual(createdLeaf.setViewStates, ["graph"]);
    assert.deepEqual(created.revealed, [createdLeaf]);
    assert.deepEqual(openTestNoticeMessages, []);

    openTestNoticeMessages.length = 0;
    const rejectedLeaf = createGraphLeaf("empty", "reject");
    const rejected = createGraphApp([], rejectedLeaf);
    assert.equal(await openObsidianGraphLeaf(rejected.app), false);
    assert.equal(rejected.revealed.length, 0);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);

    openTestNoticeMessages.length = 0;
    const revealRejected = createGraphApp([createGraphLeaf("graph")], createGraphLeaf("empty"), true);
    assert.equal(await openObsidianGraphLeaf(revealRejected.app), false);
    assert.equal(revealRejected.getLeafCalls(), 0);
    assert.equal(revealRejected.revealed.length, 0);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);

    openTestNoticeMessages.length = 0;
    const wrongTypeLeaf = createGraphLeaf("empty", "ignore");
    const wrongType = createGraphApp([], wrongTypeLeaf);
    assert.equal(await openObsidianGraphLeaf(wrongType.app), false);
    assert.deepEqual(wrongType.revealed, [wrongTypeLeaf]);
    assert.match(openTestNoticeMessages.at(-1) ?? "", /暂时无法打开 Obsidian 原生图谱/u);
  } finally {
    console.warn = originalWarn;
    openTestNoticeMessages.length = 0;
  }
}

interface GraphLeafMock {
  setViewStates: string[];
  setViewState(state: { type: string }): Promise<void>;
  getViewState(): { type: string; state: Record<string, never> };
}

function createGraphLeaf(
  initialType: string,
  behavior: "accept" | "reject" | "ignore" = "accept"
): GraphLeafMock {
  let currentType = initialType;
  const setViewStates: string[] = [];
  return {
    setViewStates,
    async setViewState(state): Promise<void> {
      setViewStates.push(state.type);
      if (behavior === "reject") throw new Error("setViewState rejected");
      if (behavior === "accept") currentType = state.type;
    },
    getViewState: () => ({ type: currentType, state: {} })
  };
}

function createGraphApp(existing: GraphLeafMock[], created: GraphLeafMock, rejectReveal = false): {
  app: App;
  revealed: GraphLeafMock[];
  getLeafCalls: () => number;
} {
  const revealed: GraphLeafMock[] = [];
  let getLeafCallCount = 0;
  return {
    app: {
      workspace: {
        getLeavesOfType: (type: string) => {
          assert.equal(type, "graph");
          return existing;
        },
        getLeaf: (mode: string) => {
          assert.equal(mode, "tab");
          getLeafCallCount += 1;
          return created;
        },
        revealLeaf: async (leaf: GraphLeafMock) => {
          if (rejectReveal) throw new Error("revealLeaf rejected");
          revealed.push(leaf);
        }
      }
    } as unknown as App,
    revealed,
    getLeafCalls: () => getLeafCallCount
  };
}

function assertFixedEntryAndTemplateContracts(): void {
  assert.deepEqual(HOME_ENTRY_IDS, ["wiki", "outputs", "projects", "inbox", "journal", "review"]);
  assert.equal(HOME_ENTRY_IDS.includes("raw" as never), false);
  assert.equal(DEFAULT_JOURNAL_TEMPLATE_ID, "quick");
  assert.deepEqual(BUILT_IN_JOURNAL_TEMPLATES.map((template) => template.id), ["quick", "morning", "evening", "blank"]);
  assert.equal(BUILT_IN_JOURNAL_TEMPLATES[0]?.name, "此刻速记");
}

function assertActivityAndJournalCalendar(): void {
  const records = fixtureRecords();
  const now = new Date(2026, 7, 31, 12, 0, 0);
  const activity = buildHomeActivityDays(records, { now, days: 3 });
  assert.deepEqual(activity.map((day) => day.date), ["2026-08-29", "2026-08-30", "2026-08-31"]);
  assert.equal(activity.at(-1)?.count, 2);
  const journalRecords: HomeVaultFileRecord[] = [{
    path: "journal/2026-08-31.md",
    title: "2026-08-31",
    folder: "journal",
    ctime: now.getTime(),
    mtime: now.getTime(),
    tags: ["journal"],
    properties: {},
    firstImagePath: "assets/today.png",
    firstImageUrl: "app://local/assets/today.png"
  }, {
    path: "journal/2026-09-01.md",
    title: "2026-09-01",
    folder: "journal",
    ctime: now.getTime(),
    mtime: now.getTime(),
    tags: ["journal"],
    properties: {}
  }];
  const days = buildHomeJournalDays(journalRecords, activity, now);
  assert.equal(days.length, 42);
  assert.deepEqual(days.find((day) => day.date === "2026-08-31"), {
    date: "2026-08-31",
    path: "journal/2026-08-31.md",
    exists: true,
    activityCount: 2,
    firstImagePath: "assets/today.png",
    firstImageUrl: "app://local/assets/today.png"
  });
  assert.equal(days.find((day) => day.date === "2026-09-01")?.exists, true);
  const merged = mergeHomeActivityDays(activity, [{ date: "2026-08-31", checks: 2 }]);
  assert.deepEqual(
    merged.find((day) => day.date === "2026-08-31"),
    { date: "2026-08-31", count: 4, fileCount: 2, checkCount: 2, level: "mid" }
  );
  assert.equal(journalPathForDate(now), "journal/2026-08-31.md");
}

function assertImageExtraction(): void {
  assert.equal(extractFirstLocalImageTarget("![[assets/first.webp|300]]"), "assets/first.webp");
  assert.equal(extractFirstLocalImageTarget("![封面](assets/cover.png \"标题\")"), "assets/cover.png");
  assert.equal(extractFirstLocalImageTarget("![远程](https://example.com/image.png)"), null);
  assert.equal(extractFirstLocalImageTarget("普通文本"), null);
}

function assertTemplateImportAndPlaceholderPreservation(): void {
  const source = [
    "---",
    "mood: calm",
    "custom-field: keep",
    "---",
    "# {{date}}",
    "",
    "```ts",
    "const token = '{{unknown}}';",
    "```",
    "{{time}} / {{custom-placeholder}}"
  ].join("\n");
  const parsed = parseImportedJournalTemplate("我的/模板.md", source);
  assert.equal(parsed.name, "我的-模板");
  assert.deepEqual(parsed.frontmatterKeys, ["mood", "custom-field"]);
  assert.equal(importedTemplatePath(parsed.name), "templates/journal/我的-模板.md");
  assert.throws(() => parseImportedJournalTemplate("template.txt", source), /只支持本地 \.md/u);
  assert.throws(() => parseImportedJournalTemplate("template.md", "bad\0value"), /空字符/u);

  const applied = applyJournalTemplate(source, new Date(2026, 7, 31, 9, 7, 0));
  assert.match(applied, /# 2026-08-31/u);
  assert.match(applied, /09:07 \/ \{\{custom-placeholder\}\}/u);
  assert.match(applied, /const token = '\{\{unknown\}\}'/u);
  assert.match(applied, /custom-field: keep/u);

  const existing = new Set(["templates/journal/我的-模板.md", "templates/journal/我的-模板-副本-2.md"]);
  assert.equal(nextAvailableImportedTemplatePath(parsed.name, existing), "templates/journal/我的-模板-副本-3.md");
}

function assertReviewRecognitionAndUtf8Import(): void {
  assert.equal(isKnowledgeBaseReviewPath("outputs/knowledge-base-review-2026-08-31.md"), true);
  assert.equal(isKnowledgeBaseReviewPath("outputs/reviews/knowledge-base-review-2026-08-24.md"), true);
  assert.equal(isKnowledgeBaseReviewPath("outputs/agent-chat-review-2026-08-31.md"), false);
  const crlf = "---\r\ntitle: test\r\n---\r\n\r\n# {{date}}\r\n";
  const encoded = new TextEncoder().encode(crlf);
  assert.equal(decodeImportedMarkdown(encoded.buffer), crlf);
  assert.equal(parseImportedJournalTemplate("blank.md", "").content, "");
  assert.throws(
    () => decodeImportedMarkdown(new Uint8Array([0xc3, 0x28]).buffer),
    /UTF-8/u
  );
}

function fixtureRecords(): HomeVaultFileRecord[] {
  const day = (date: string) => new Date(`${date}T12:00:00`).getTime();
  return [
    {
      path: "projects/a.md",
      title: "Knowledge Map",
      folder: "projects",
      ctime: day("2026-08-28"),
      mtime: day("2026-08-31"),
      tags: ["#product"],
      properties: { status: ["active"], owner: ["fang"] }
    },
    {
      path: "projects/b.md",
      title: "Workbench",
      folder: "projects",
      ctime: day("2026-08-28"),
      mtime: day("2026-08-31"),
      tags: ["product"],
      properties: { status: ["paused"], owner: ["team"] }
    },
    {
      path: "wiki/c.md",
      title: "Reference",
      folder: "wiki",
      ctime: day("2026-08-29"),
      mtime: day("2026-08-30"),
      tags: ["reference"],
      properties: { status: ["active"], owner: ["team"] }
    },
    {
      path: "inbox/d.md",
      title: "Unsorted",
      folder: "inbox",
      ctime: day("2026-08-29"),
      mtime: day("2026-08-29"),
      tags: ["capture"],
      properties: { status: ["new"] }
    }
  ];
}
