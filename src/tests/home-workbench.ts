import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { App } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  EMPTY_HOME_GRAPH_FILTERS,
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  HOME_ENTRY_IDS,
  applyJournalTemplate,
  aggregateHomeGraph,
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
  selectHomeGraphNeighborhood,
  type HomeVaultFileRecord
} from "../home/home-workbench-model";
import { openObsidianGraphLeaf } from "../home/open-native-graph";
import {
  HomeGraphController,
  shouldRestartHomeGraphLoop
} from "../home/home-graph-controller";
import { openTestNoticeMessages } from "./obsidian-shim";

export async function runHomeWorkbenchTests(): Promise<void> {
  assertFixedEntryAndTemplateContracts();
  assertActivityAndJournalCalendar();
  assertSmoothUiContributionGrid();
  assertImageExtraction();
  assertTemplateImportAndPlaceholderPreservation();
  assertReviewRecognitionAndUtf8Import();
  assertHomeGraphFiltering();
  assertHomeGraphProjection();
  assertHomeGraphLifecycleBehavior();
  assertHomeGraphStatsTruth();
  assertHomeGraphAndMagicUiContracts();
  await assertNativeGraphBehavior();
}

function assertHomeGraphProjection(): void {
  const graph = buildHomeGraph(fixtureRecords(), {
    "projects/a.md": { "wiki/c.md": 1, "projects/b.md": 2 },
    "projects/b.md": { "projects/a.md": 3 },
    "wiki/c.md": { "inbox/d.md": 1 }
  });
  const oneHop = selectHomeGraphNeighborhood(graph.nodes, graph.links, "projects/a.md", 1);
  assert.deepEqual(oneHop.nodes.map((node) => node.id), ["projects/a.md", "wiki/c.md", "projects/b.md"]);
  const twoHops = selectHomeGraphNeighborhood(graph.nodes, graph.links, "projects/a.md", 2);
  assert.deepEqual(twoHops.nodes.map((node) => node.id), [
    "projects/a.md", "wiki/c.md", "projects/b.md", "inbox/d.md"
  ]);
  const bounded = selectHomeGraphNeighborhood(graph.nodes, graph.links, "projects/a.md", 3, 2);
  assert.deepEqual(bounded.nodes.map((node) => node.id), ["projects/a.md", "wiki/c.md"]);
  const aggregate = aggregateHomeGraph(graph.nodes, graph.links);
  assert.equal(aggregate.totalNotes, 4);
  assert.deepEqual(aggregate.nodes.map((node) => [node.title, node.count]), [
    ["projects", 2],
    ["inbox", 1],
    ["wiki", 1]
  ]);
  assert.ok(aggregate.links.some((link) => link.source === "cluster:projects" && link.target === "cluster:wiki"));
}

function assertHomeGraphLifecycleBehavior(): void {
  assert.equal(shouldRestartHomeGraphLoop(null, 1_000, 1_010), true);
  assert.equal(shouldRestartHomeGraphLoop(7, 1_000, 1_249), false);
  assert.equal(shouldRestartHomeGraphLoop(7, 1_000, 1_251), true);
  const controller = Object.create(HomeGraphController.prototype) as {
    visible: boolean;
    inViewport: boolean;
    blurred: boolean;
    lastInteraction: number;
    sleepReason: string;
    shouldDeepSleep: (now: number) => boolean;
  };
  controller.visible = true;
  controller.inViewport = true;
  controller.blurred = false;
  controller.lastInteraction = 1_000;
  controller.sleepReason = "";
  assert.equal(controller.shouldDeepSleep(3_999), false);
  assert.equal(controller.shouldDeepSleep(4_000), true);
  assert.equal(controller.sleepReason, "长时间无操作");
  controller.lastInteraction = 4_000;
  controller.blurred = true;
  assert.equal(controller.shouldDeepSleep(4_001), true);
  assert.equal(controller.sleepReason, "窗口未激活");
  controller.blurred = false;
  controller.inViewport = false;
  assert.equal(controller.shouldDeepSleep(4_001), true);
  assert.equal(controller.sleepReason, "图谱离开可视区");
  controller.inViewport = true;
  controller.visible = false;
  assert.equal(controller.shouldDeepSleep(4_001), true);
  assert.equal(controller.sleepReason, "页面不可见");
}

function assertHomeGraphStatsTruth(): void {
  let emitted: { nodes: number; links: number; totalNotes: number } | undefined;
  const controller = Object.create(HomeGraphController.prototype) as {
    options: { onStatsChange: (stats: { nodes: number; links: number; totalNotes: number }) => void };
    graphData: { nodes: unknown[] };
    filterResult: { totalCount: number };
    visualNodes: unknown[];
    visualLinks: unknown[];
    fps: number;
    scope: "local";
    hops: 2;
    runtimeState: "running";
    runtimeStatus: () => string;
    emitStats: () => void;
  };
  controller.options = { onStatsChange: (stats) => { emitted = stats; } };
  controller.graphData = { nodes: [{}, {}, {}] };
  controller.filterResult = { totalCount: 41 };
  controller.visualNodes = [{}, {}];
  controller.visualLinks = [{}];
  controller.fps = 60;
  controller.scope = "local";
  controller.hops = 2;
  controller.runtimeState = "running";
  controller.runtimeStatus = () => "运行中";

  controller.emitStats();

  assert.equal(controller.graphData.nodes.length, 3);
  assert.equal(controller.filterResult.totalCount, 41);
  assert.deepEqual(emitted, {
    nodes: 2,
    links: 1,
    totalNotes: 41,
    fps: 60,
    scope: "local",
    hops: 2,
    state: "running",
    status: "运行中"
  });
}

function assertHomeGraphFiltering(): void {
  const records = fixtureRecords();
  const graph = buildHomeGraph(records, {
    "projects/a.md": { "projects/b.md": 2, "wiki/c.md": 1 },
    "projects/b.md": { "projects/a.md": 3 },
    "inbox/d.md": { "missing.md": 3 }
  });
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.links, [
    {
      source: "projects/a.md",
      target: "projects/b.md",
      count: 5,
      directions: [
        { source: "projects/a.md", target: "projects/b.md", count: 2 },
        { source: "projects/b.md", target: "projects/a.md", count: 3 }
      ]
    },
    {
      source: "projects/a.md",
      target: "wiki/c.md",
      count: 1,
      directions: [{ source: "projects/a.md", target: "wiki/c.md", count: 1 }]
    }
  ]);
  assert.equal(graph.nodeById.get("projects/a.md")?.degree, 2);
  assert.equal(graph.nodeById.get("projects/b.md")?.degree, 1);
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
  const nativeGraph = readFileSync("src/home/open-native-graph.ts", "utf8");
  const viewService = readFileSync("src/plugin/view-service.ts", "utf8");
  const brandIcons = readFileSync("src/home/home-brand-icons.ts", "utf8");
  const bentoIsland = readFileSync("src/home/home-bento-island.tsx", "utf8");
  const recentIsland = readFileSync("src/home/home-recent-island.tsx", "utf8");
  const magicSource = JSON.parse(readFileSync("src/home/magic-ui/SOURCE.json", "utf8")) as {
    commit: string;
    files: Array<{ upstreamPath: string; localPath: string; sha256: string }>;
  };
  const thirdPartyNotices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  const magicCssBuild = readFileSync("scripts/build-home-magic-ui-css.mjs", "utf8");
  const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as {
    compilerOptions: { jsx?: string; paths?: Record<string, string[]> };
    include?: string[];
    exclude?: string[];
  };
  const bootstrap = readFileSync("src/plugin/bootstrap.ts", "utf8");
  const codexView = readFileSync("src/ui/codex-view.ts", "utf8");
  const settingsTab = readFileSync("src/settings/settings-tab.ts", "utf8");
  const styles = readFileSync("styles.css", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = readFileSync("package-lock.json", "utf8");
  const fixedCommit = "2d671cc6c0e0f40e28682c9cbddd16694dcfe627";
  const smoothUiCommit = "1143ba66738566e8acb9a3f8a7db9eab3f10f2d4";
  const heatmapSource = view.match(/private renderHeatmap\(\): void \{[\s\S]*?private renderCalendar/u)?.[0] ?? "";
  const wakeSource = controller.match(/private wake\(\): void \{[\s\S]*?private shouldDeepSleep/u)?.[0] ?? "";

  assert.match(bootstrap, /addRibbonIcon\("feather"/u);
  assert.match(codexView, /getIcon\(\): string \{\s*return "feather";/u);
  assert.match(settingsTab, /echoink-about-logo[\s\S]*setIcon\(logoWrap, "feather"\)/u);
  for (const icon of ["wiki", "outputs", "projects", "inbox", "journal", "review"]) {
    assert.match(brandIcons, new RegExp(`${icon}: \\[`, "u"));
  }
  assert.match(brandIcons, /stroke-width", "1\.5"/u);
  assert.match(brandIcons, /stroke-linecap", "round"/u);
  assert.doesNotMatch(brandIcons, /createElementNS\(SVG_NS, "use"\)|innerHTML/u);
  for (const color of ["#f7f6f3", "#fdfcfa", "#f1efea", "#1a1917", "#57544f", "#8b877e", "#c44620", "#fae4d9", "#dce9e6", "#8fb8b1", "#2e7a74", "#1f5b57", "#123835"]) {
    assert.match(styles.toLowerCase(), new RegExp(color, "u"));
  }
  assert.match(styles, /\.theme-dark \.codex-home-view\.echoink-home-view/u);

  assert.equal(packageJson.dependencies?.["3d-force-graph"], undefined);
  assert.doesNotMatch(packageLock, /3d-force-graph/u);
  assert.match(data, /buildHomeGraph\(records, this\.app\.metadataCache\.resolvedLinks\)/u);
  assert.match(view, /HomeGraphController/u);
  assert.doesNotMatch(view, /NativeFlickeringGrid|FlickeringGrid/u);
  assert.doesNotMatch(view, /syncGraphListSelection|graphListEl|graphListBodyEl|浏览筛选后的笔记/u);
  assert.match(view, /知识图谱/u);
  for (const label of ["搜索", "文件夹", "属性", "标签", "清空筛选"]) assert.match(view, new RegExp(label, "u"));
  assert.doesNotMatch(view, /打开 Obsidian 原生图谱/u);
  assert.match(controller, /getContext\("2d"/u);
  assert.match(controller, /new ResizeObserver/u);
  assert.match(controller, /new IntersectionObserver/u);
  assert.doesNotMatch(controller, /new MutationObserver|window\.addEventListener\("css-change"/u);
  assert.match(view, /this\.registerEvent\(this\.app\.metadataCache\.on\("resolved"/u);
  assert.match(view, /this\.registerEvent\(this\.app\.vault\.on\("rename"/u);
  assert.match(view, /this\.registerEvent\(this\.app\.vault\.on\("delete"/u);
  assert.match(view, /this\.registerEvent\(this\.app\.workspace\.on\("css-change"/u);
  assert.doesNotMatch(controller, /3d-force-graph|WebGL|webglcontextlost|_destructor/u);
  assert.match(controller, /setFallback\("error"/u);
  assert.match(controller, /Canvas 暂不可用，仍可从右栏选择和打开笔记/u);
  assert.doesNotMatch(controller, /this\.options\.onOpen/u);
  for (const contract of [
    /this\.scope === "local" \? 1400 : 9000/u,
    /this\.scope === "local" \? 74 : 150/u,
    /const kSpr = 0\.045/u,
    /const kCen = 0\.010/u,
    /const damp = 0\.84/u,
    /speed > 24/u,
    /ALPHA_DECAY = 0\.984/u,
    /IDLE_SLEEP_MS = 3_000/u,
    /MAX_JITTER_CSS_PX = 1/u,
    /Math\.min\(1, this\.alpha\) \/ Math\.max\(1, this\.scale\)/u,
    /\(Math\.random\(\) \* 2 - 1\) \* jitter/u,
    /now - this\.lastInteraction >= IDLE_SLEEP_MS/u,
    /this\.scope === "local" \? 330 : 430/u,
    /event\.shiftKey/u,
    /event\.deltaY < 0 \? 1\.12 : 0\.89/u,
    /Math\.max\(0\.25, Math\.min\(4/u,
    /now - lastFrame > 250/u
  ]) assert.match(controller, contract);
  assert.doesNotMatch(controller, /HomeGraphMotionMode|motionMode|"breathe"|"free"|setMotionMode|setAmplitude|setSleepAfter|setPauseOnHover|setBlurSleep|sleepFade|SLEEP_FADE_MS/u);
  assert.match(controller, /totalNotes: this\.filterResult\.totalCount/u);
  assert.doesNotMatch(controller, /totalNotes: this\.graphData\.nodes\.length/u);
  assert.match(controller, /\["mousemove", "mousedown", "wheel", "keydown"\]/u);
  assert.doesNotMatch(wakeSource, /this\.alpha\s*=/u);
  assert.doesNotMatch(controller, /setCssProps\(\{ opacity/u);
  assert.doesNotMatch(controller, /old\?\.fx|old\?\.fy/u);
  assert.match(view, /details\.open = false;[\s\S]*summary\.focus\(\)/u);
  assert.match(view, /bindGraphFilterMenu\(details\)/u);
  assert.match(view, /\.echoink-home-graph-filter\[open\]/u);
  assert.match(view, /this\.registerDomEvent\(document, "pointerdown"[\s\S]*closeGraphFilterMenus\(\)/u);
  assert.match(view, /this\.registerDomEvent\(document, "keydown"[\s\S]*event\.key !== "Escape"[\s\S]*closeGraphFilterMenus\(true\)/u);
  assert.doesNotMatch(view, /运动模式|恒温呼吸|自由飘动|图谱运动幅度|图谱无操作休眠|悬停节点时暂停|窗口失焦即休眠/u);
  assert.match(view, /echoink-home-graph-related-open/u);
  for (const label of ["图谱层级", "邻居深度", "当前视图", "图例", "当前笔记", "1 跳邻居", "2 跳邻居", "3 跳邻居"]) {
    assert.match(view, new RegExp(label, "u"));
  }
  assert.match(view, /graphButtonGroup\(actions,[\s\S]*\["local", "局部图谱"\][\s\S]*\["global", "全局聚合"\]/u);
  assert.match(view, /text: "邻居深度"[\s\S]*\["1", "1 跳"\][\s\S]*\["2", "2 跳"\][\s\S]*\["3", "3 跳"\]/u);
  assert.match(view, /setHops\(Number\(value\)[\s\S]*getScope\(\) !== "local"[\s\S]*setScope\("local"\)/u);
  assert.match(view, /formatGraphRelationLabel\(node\.cluster, node\.title\)/u);
  assert.match(view, /formatGraphRelationLabel\(itemData\.detail, itemData\.title\)/u);
  assert.match(view, /echoink-home-graph-related-row is-current is-note[\s\S]*text: `当前： \$\{currentLabel\}`[\s\S]*renderGraphPopoutButton\(current, node\.id, node\.title\)/u);
  assert.match(view, /graphRelatedEl\.toggleClass\("is-note", !global && Boolean\(node\)\)/u);
  assert.match(view, /echoink-home-graph-selection-status[\s\S]*role: "status", "aria-live": "polite", "aria-atomic": "true"/u);
  assert.match(view, /graphSelectionStatusEl\.setText\(`当前：\$\{currentLabel\}。关联笔记 \$\{sidebarItems\.length\} 篇。`\)/u);
  assert.match(view, /graphSelectionStatusEl\.setText\(`全局主题簇，共 \$\{sidebarItems\.length\} 个主题簇。`\)/u);
  assert.match(view, /graphSelectionStatusEl\.setText\(emptyMessage\)/u);
  assert.doesNotMatch(view, /createEl\("strong", \{ text: `关联笔记/u);
  assert.match(view, /createEl\("ul", \{[\s\S]*"aria-label": `关联笔记 \$\{sidebarItems\.length\}`/u);
  assert.match(view, /const relationLabel = formatGraphRelationLabel\(itemData\.detail, itemData\.title\)[\s\S]*title: relationLabel[\s\S]*text: relationLabel/u);
  assert.match(view, /const shouldRestoreFocus = document\.activeElement === focus;[\s\S]*const selected = this\.graphController\.focusNode\(itemData\.noteId\);[\s\S]*if \(selected && shouldRestoreFocus\) this\.focusCurrentGraphNode\(\)/u);
  assert.match(view, /focusCurrentGraphNode\(\): void \{[\s\S]*button\[aria-current="true"\][\s\S]*\.focus\(\)/u);
  assert.match(controller, /focusNode\(nodeId: string\): boolean \{[\s\S]*this\.options\.onSelect\(nodeId\)/u);
  assert.match(view, /onSelect: \(nodeId\) => \{[\s\S]*this\.selectedGraphNodeId = nodeId;[\s\S]*this\.renderGraphSelection\(\)/u);
  assert.match(view, /setIcon\(button, "arrow-up-right"\)/u);
  assert.match(view, /getLeaf\("window"\)\.openFile\(file, \{ active: true \}\)/u);
  assert.match(view, /暂时无法在 Popout 打开/u);
  assert.match(view, /getLeaf\("tab"\)\.openFile\(file, \{ active: true \}\)/u);
  assert.doesNotMatch(view, /echoink-home-graph-side-note|Shift \+ 拖节点固定|浏览筛选后的笔记/u);
  assert.match(view, /button\.toggleClass\("is-on", active\)[\s\S]*button\.setAttribute\("aria-pressed", String\(active\)\)/u);
  assert.doesNotMatch(view, /graphScopeSelectEl|graphHopsSelectEl|private graphSelect\(/u);
  assert.match(styles, /\.echoink-home-graph-segment\s*\{[^}]*display: flex;/u);
  assert.match(styles, /\.echoink-home-graph-segment button\.is-on\s*\{[^}]*border-color: var\(--echoink-home-teal\);/u);
  assert.match(styles, /\.echoink-home-graph-related button,[\s\S]*\.echoink-home-graph-related-row button\s*\{[^}]*border: 0;[^}]*background: transparent;/u);
  assert.match(styles, /\.echoink-home-graph-side-section\.is-selection\s*\{[^}]*padding: 16px 18px 18px;/u);
  assert.match(styles, /\.echoink-home-graph-selection-status\s*\{[^}]*position: absolute;[^}]*width: 1px;[^}]*height: 1px;[^}]*overflow: hidden;[^}]*clip: rect\(0, 0, 0, 0\);/u);
  assert.match(styles, /\.echoink-home-graph-related\.is-note\s*\{[^}]*margin-top: 9px;/u);
  assert.match(styles, /\.echoink-home-graph-related ul\s*\{[^}]*gap: 2px;/u);
  assert.match(styles, /\.echoink-home-graph-related\.is-note ul\s*\{[^}]*gap: 0;/u);
  assert.match(styles, /\.echoink-home-graph-related li\.is-note\s*\{[^}]*min-height: 33px;[^}]*grid-template-columns: minmax\(0, 1fr\) fit-content\(72px\) 28px;[^}]*margin-inline-start: 0;[^}]*width: 100%;/u);
  assert.match(styles, /\.echoink-home-graph-related-row\.is-note\s*\{[^}]*min-height: 32px;[^}]*grid-template-columns: minmax\(0, 1fr\) 28px;/u);
  assert.match(styles, /\.echoink-home-graph-side-section\s*\{[^}]*gap: 9px;/u);
  assert.match(styles, /\.echoink-home-graph-related li\.is-note > \.echoink-home-graph-related-focus,[\s\S]*display: flex;[^}]*min-width: 0;[^}]*align-items: center;[^}]*justify-content: flex-start;[^}]*text-align: left;/u);
  assert.match(styles, /\.echoink-home-graph-related li\.is-note > \.echoink-home-graph-related-focus\s*\{[^}]*padding: 7px 10px;[^}]*font-size: 12px;[^}]*font-weight: 400;[^}]*line-height: 1\.6;/u);
  assert.match(styles, /\.echoink-home-graph-related-row\.is-current \.echoink-home-graph-related-focus\s*\{[^}]*padding: 0;[^}]*font-size: 11px;[^}]*font-weight: 500;[^}]*line-height: 1\.6;[^}]*letter-spacing: 0\.04em;/u);
  assert.match(styles, /\.echoink-home-graph-related-cluster\s*\{[^}]*overflow: hidden;[^}]*font-size: 11px;[^}]*font-weight: 400;[^}]*line-height: 1\.6;[^}]*text-align: end;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/u);
  assert.match(styles, /\.echoink-home-graph-related \.echoink-home-graph-related-open,[\s\S]*min-width: 28px;/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-graph-related li\.is-note\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 28px;[^}]*margin-inline-start: 0;[^}]*\}[\s\S]*\.echoink-home-graph-related li\.is-note > \.echoink-home-graph-related-focus\s*\{[^}]*padding-inline-start: 0;[^}]*\}[\s\S]*\.echoink-home-graph-related li\.is-note \.echoink-home-graph-related-cluster\s*\{[^}]*display: none;/u);
  assert.match(styles, /\.echoink-home-graph-related li\.is-cluster\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/u);
  assert.doesNotMatch(styles, /echoink-home-graph-control|echoink-home-graph-side-note|echoink-home-graph-list/u);
  assert.match(view, /try \{[\s\S]*openFile\(file, \{ active: true \}\)[\s\S]*暂时无法打开/u);
  assert.doesNotMatch(view + data + controller, /internalPlugins|dataEngine|GraphView|iframe/u);

  assert.match(view, new RegExp(fixedCommit, "u"));
  assert.equal(magicSource.commit, fixedCommit);
  const expectedMagicUiHashes = new Map([
    ["marquee.tsx", "779f360a107409bfa35cda13bcef7d54cd620a15ab4a0ee50412442a4dd6b9c7"],
    ["bento-grid.tsx", "9c2abcb2a4e51519e56d510299771a2d0e170ab9927a9a792a58614b1837ed47"],
    ["animated-shiny-text.tsx", "3743a0a0b4894840a96bacd839e493872bac484a940684f91fd23a1784c00fbb"],
    ["utils.ts", "7c8c3dfc0cdd370d44932828eb067ef771c8fe7996693221d5d4b90af6d54f2d"],
    ["button.tsx", "881fabaf889450b7c671ffabe455bd4b4d101c36f80868f1bf4819ba5f4f4886"],
    ["provenance/marquee-demo.tsx", "7ed4e929bbf6c54b6464cea98cc29fd1b4da16f1ab4cdcc7a49e2ef98ec19536"],
    ["provenance/globals.css", "b290ad71358829d043a8453924e0b97878596294849de34ea08451412fd760f2"],
    ["LICENSE.md", "0147b84235ed916b8b4e89c1f80655351c5afe7d211b629be61f553a227b34ba"]
  ]);
  assert.equal(magicSource.files.length, expectedMagicUiHashes.size);
  for (const source of magicSource.files) {
    assert.equal(source.sha256, expectedMagicUiHashes.get(source.localPath));
    const actual = createHash("sha256")
      .update(readFileSync(`src/home/magic-ui/${source.localPath}`))
      .digest("hex");
    assert.equal(actual, source.sha256);
    assert.match(thirdPartyNotices, new RegExp(`${escapeRegex(source.upstreamPath)}[^\\n]*${source.sha256}`, "u"));
  }
  assert.equal(existsSync("src/home/magic-ui-adapters.ts"), false);
  assert.match(bentoIsland, /import \{ AnimatedShinyText \} from "\.\/magic-ui\/animated-shiny-text"/u);
  assert.match(bentoIsland, /import \{ BentoGrid \} from "\.\/magic-ui\/bento-grid"/u);
  assert.match(bentoIsland, /createRoot\(host\)/u);
  assert.match(bentoIsland, /<BentoGrid className="echoink-home-bento-grid">[\s\S]*entries\.map[\s\S]*<button/u);
  assert.match(bentoIsland, /<AnimatedShinyText className="echoink-home-shiny-text mx-0">/u);
  assert.equal((bentoIsland.match(/<button\b/gu) ?? []).length, 1);
  assert.doesNotMatch(bentoIsland, /BentoCard|<Button\b/u);
  assert.match(view, /createHomeBentoIsland\(bentoHost\)/u);
  assert.match(view, /this\.bentoIsland\?\.render/u);
  assert.ok(view.indexOf("this.bentoIsland?.unmount()") < view.indexOf("this.graphController.dispose()"));
  assert.equal(tsconfig.compilerOptions.jsx, "react-jsx");
  assert.deepEqual(tsconfig.compilerOptions.paths, {
    "@/lib/utils": ["src/home/magic-ui/utils.ts"],
    "@/components/ui/button": ["src/home/magic-ui/button.tsx"]
  });
  assert.ok(tsconfig.include?.includes("src/**/*.tsx"));
  assert.ok(tsconfig.exclude?.includes("src/home/magic-ui/provenance/**"));
  for (const [name, version] of Object.entries({
    react: "19.1.1",
    "react-dom": "19.1.1",
    clsx: "2.1.1",
    "tailwind-merge": "3.3.1",
    "@radix-ui/react-icons": "1.3.2",
    "@radix-ui/react-slot": "1.2.3",
    "class-variance-authority": "0.7.1"
  })) assert.equal(packageJson.dependencies?.[name], version);
  for (const [name, version] of Object.entries({
    "@types/react": "19.1.1",
    "@types/react-dom": "19.1.1",
    tailwindcss: "4.1.13",
    "@tailwindcss/postcss": "4.1.13",
    postcss: "8.5.6",
    "postcss-prefix-selector": "2.1.1"
  })) assert.equal(packageJson.devDependencies?.[name], version);
  assert.match(magicCssBuild, /tailwindcss\/theme\.css/u);
  assert.match(magicCssBuild, /tailwindcss\/utilities\.css/u);
  assert.match(magicCssBuild, /source\(none\)/u);
  assert.match(magicCssBuild, /@theme inline/u);
  assert.doesNotMatch(magicCssBuild, /preflight\.css|@import "tailwindcss";/u);
  assert.match(magicCssBuild, /test\(selector\)\) return selector;/u);
  assert.match(magicCssBuild, /Nested Magic UI selector was prefixed twice/u);
  assert.match(styles, /ECHOINK_HOME_MAGIC_UI_CSS_START/u);
  assert.match(styles, /\.echoink-home-magic-ui \.animate-shiny-text/u);
  assert.match(styles, /@keyframes shiny-text/u);
  assert.doesNotMatch(styles, /\.echoink-home-magic-ui &/u);
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

  assert.match(recentIsland, /import \{ Marquee \} from "\.\/magic-ui\/marquee"/u);
  assert.match(recentIsland, /createRoot\(host\)/u);
  assert.match(recentIsland, /rows\.map\(\(row, rowIndex\)[\s\S]*<Marquee/u);
  assert.match(recentIsland, /reverse=\{rowIndex === 1\}/u);
  assert.match(recentIsland, /pauseOnHover/u);
  assert.match(recentIsland, /repeat=\{reducedMotion \? 1 : 4\}/u);
  assert.match(recentIsland, /\[--duration:20s\] \[--gap:1rem\]/u);
  assert.match(recentIsland, /data-path=\{record\.path\}/u);
  assert.doesNotMatch(view, /recentPaused|echoink-home-marquee-toggle|来自本地最近编辑/u);
  assert.doesNotMatch(styles, /echoink-home-marquee-toggle|is-user-paused/u);
  assert.match(recentIsland, /records\.length === 1[\s\S]*tabbable: false/u);
  assert.match(recentIsland, /const accessible = Boolean\(tabbableRows\[rowIndex\]\) && repeatIndex === 0/u);
  assert.match(recentIsland, /group\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(recentIsland, /button\.tabIndex = accessible \? 0 : -1/u);
  assert.match(recentIsland, /tabIndex=\{-1\}[\s\S]*onClick=\{\(\) => void onOpen\(record\.path\)\}/u);
  assert.doesNotMatch(recentIsland, /setAttribute\("inert"|disabled/u);
  assert.match(recentIsland, /Math\.abs\(distance\) >= 6/u);
  assert.match(recentIsland, /Math\.abs\(distance\) >= 6[\s\S]*setPointerCapture\(event\.pointerId\)/u);
  assert.match(recentIsland, /const onPointerDown[\s\S]*moved = false;\s*\};\s*const onPointerMove/u);
  assert.match(recentIsland, /window\.addEventListener\("pointermove", onPointerMove\)/u);
  assert.match(recentIsland, /suppressClick = moved/u);
  assert.match(recentIsland, /event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);/u);
  assert.match(recentIsland, /addEventListener\("click", onClickCapture, \{ capture: true \}\)/u);
  assert.match(styles, /\.echoink-home-marquee:focus-within \.animate-marquee,[\s\S]*\.echoink-home-marquee\.is-dragging \.animate-marquee,[\s\S]*\.is-document-hidden \.echoink-home-marquee \.animate-marquee[\s\S]*animation-play-state: paused/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.echoink-home-marquee \.animate-marquee[\s\S]*animation: none !important/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.echoink-home-marquee[\s\S]*overflow-x: auto/u);
  assert.doesNotMatch(styles, /echoink-home-marquee-group|@keyframes echoink-home-marquee|animation: echoink-home-marquee/u);
  assert.match(view, /createHomeRecentIsland\(recentHost/u);
  assert.match(view, /this\.recentIsland\?\.render/u);
  assert.ok(view.indexOf("this.recentIsland?.unmount()") < view.indexOf("this.bentoIsland?.unmount()"));

  assert.match(styles, /\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*grid-auto-rows: auto;[\s\S]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /\.echoink-home-entry\.is-wiki[\s\S]*grid-column: 1 \/ 5;[\s\S]*grid-row: 1 \/ 3/u);
  assert.match(styles, /\.echoink-home-entry\.is-journal[\s\S]*grid-column: 9 \/ 13;[\s\S]*grid-row: 2 \/ 4/u);
  assert.match(styles, /\.echoink-home-entry\.is-review[\s\S]*grid-column: 1 \/ 9;[\s\S]*grid-row: 3/u);
  assert.match(styles, /@container echoink-home \(max-width: 1100px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*repeat\(6, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 800px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry\.is-review\s*\{[^}]*display: grid;[^}]*grid-template-columns: 40px minmax\(0, 1fr\);/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry\.is-review \.echoink-home-entry-cta\s*\{[^}]*grid-column: 1 \/ -1;/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-entry-cta,[\s\S]*justify-content: flex-end;/u);
  assert.doesNotMatch(styles, /grid-auto-flow:\s*dense/u);
  assert.match(view, /今日日记已建立|默认使用“此刻速记”/u);
  assert.doesNotMatch(view, /private renderToday/u);
  assert.match(view, /if \(entry\.id !== "review"\)/u);
  assert.match(view, /最近维护 \$\{formatRelativeTime\(this\.snapshot\.lastRun\.at\)\}/u);
  assert.match(view, /尚无维护记录，可开始一次复盘/u);
  assert.match(styles, /\.echoink-home-entry\.is-inbox \.echoink-home-entry-number\s*\{[^}]*position: static;/u);
  assert.match(styles, /\.echoink-home-entry\.is-journal\s*\{[^}]*--echoink-home-entry-tint:[^;]*--echoink-home-vermilion-soft[^;]*;[^}]*--echoink-home-entry-icon-color: var\(--echoink-home-vermilion\);/u);
  assert.match(styles, /\.echoink-home-entry\.is-review\s*\{[^}]*--echoink-home-entry-tint:[^;]*--echoink-home-teal-soft[^;]*;[^}]*--echoink-home-entry-icon-color: var\(--echoink-home-teal-deep\);/u);
  assert.match(styles, /\.echoink-home-entry\.is-review:hover \.echoink-home-entry-icon,[\s\S]*transform: translateY\(-40px\);/u);
  assert.match(styles, /\.echoink-home-entry\.is-review:hover \.echoink-home-entry-copy,[\s\S]*transform: none;/u);
  assert.match(styles, /\.echoink-home-entry\.is-review \.echoink-home-entry-cta\s*\{[^}]*position: static;[^}]*opacity: 1;[^}]*transform: none;/u);
  assert.match(styles, /\.echoink-about-logo\s*\{[^}]*width: 38px;[^}]*height: 38px;[^}]*color: var\(--text-normal\);[^}]*background: var\(--background-secondary\);/u);
  assert.match(styles, /\.echoink-about-logo svg\s*\{[^}]*width: 20px;[^}]*height: 20px;/u);

  assert.match(styles, /--echoink-home-canvas: var\(--background-primary\)/u);
  assert.match(styles, /--echoink-home-ink: var\(--text-normal\)/u);
  assert.match(styles, /font-family: var\(--font-interface\)/u);
  assert.doesNotMatch(styles, /--echoink-home-canvas: #07080a|font-family: Inter/u);
  assert.match(styles, /\.echoink-home-graph-canvas/u);
  assert.doesNotMatch(styles, /echoink-home-graph-grid|echoink-home-graph-webgl|echoink-home-flickering-grid-canvas/u);
  assert.match(styles, /\.echoink-home-graph-frame\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 268px;[^}]*border-radius: 0;[^}]*box-shadow: none;/u);
  assert.match(styles, /\.echoink-home-graph-runtime-hud\s*\{[^}]*bottom: 12px;/u);
  assert.doesNotMatch(styles, /\.echoink-home-graph-stage\s*\{[^}]*radial-gradient/u);
  assert.match(styles, /font-variant-numeric: tabular-nums/u);
  assert.match(styles, /\.echoink-home-marquee-fade[\s\S]*width: 25%/u);
  assert.match(styles, /\.echoink-home-magic-ui \.animate-marquee\s*\{[\s\S]*animation: marquee var\(--duration\) infinite linear/u);
  assert.match(bentoIsland, /shimmerWidth = 100|AnimatedShinyText/u);
  assert.doesNotMatch(styles, /@keyframes echoink-home-shiny-text|animation: echoink-home-shiny-text/u);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
