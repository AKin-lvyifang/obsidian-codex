import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { App } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  HOME_CONTRIBUTION_DAYS,
  HOME_CONTRIBUTION_WEEKS,
  HOME_ENTRY_IDS,
  applyJournalTemplate,
  buildHomeActivityDays,
  buildHomeContributionGrid,
  buildHomeJournalDays,
  decodeImportedMarkdown,
  extractFirstLocalImageTarget,
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
import {
  buildDailyConversationDraft,
  buildRevisitConversationDraft,
  HOME_DAILY_TITLES,
  HOME_REVISIT_TITLES,
  homeConversationTitle
} from "../home/home-conversation-actions";
import { openTestNoticeMessages } from "./obsidian-shim";

export async function runHomeWorkbenchTests(): Promise<void> {
  assertFixedEntryAndTemplateContracts();
  assertActivityAndJournalCalendar();
  assertSmoothUiContributionGrid();
  assertImageExtraction();
  assertTemplateImportAndPlaceholderPreservation();
  assertReviewRecognitionAndUtf8Import();
  assertHomeConversationActions();
  assertHomeWorkbenchRemovalAndMagicUiContracts();
  await assertNativeGraphBehavior();
}

function assertHomeConversationActions(): void {
  const now = new Date(2026, 8, 2, 9, 7);
  const dailyDraft = buildDailyConversationDraft(now);
  const revisitDraft = buildRevisitConversationDraft();

  assert.equal(HOME_DAILY_TITLES.length, 6);
  assert.equal(HOME_REVISIT_TITLES.length, 6);
  assert.equal(
    homeConversationTitle("daily", "EchoInk 测试库", now),
    homeConversationTitle("daily", "EchoInk 测试库", new Date(2026, 8, 2, 22, 30))
  );
  assert.ok(HOME_DAILY_TITLES.includes(
    homeConversationTitle("daily", "EchoInk 测试库", now) as (typeof HOME_DAILY_TITLES)[number]
  ));
  assert.ok(HOME_REVISIT_TITLES.includes(
    homeConversationTitle("revisit", "EchoInk 测试库", now) as (typeof HOME_REVISIT_TITLES)[number]
  ));

  assert.match(dailyDraft, /^\/daily\n/u);
  assert.match(dailyDraft, /2026-09-02 此刻速记/u);
  assert.match(dailyDraft, /在我明确确认生成前，不要创建或改写任何文件/u);
  assert.match(dailyDraft, /目标文件已经存在，先读取并保留原内容/u);
  assert.match(revisitDraft, /^\/revisit\n/u);
  assert.match(revisitDraft, /3–5 个仍未完成的 goal、task 或 open_loop/u);
  assert.match(revisitDraft, /在我选择前不要修改 Memory/u);
  assert.match(revisitDraft, /Memory 已关闭、不可用或没有结果/u);
}

function assertHomeWorkbenchRemovalAndMagicUiContracts(): void {
  const view = readFileSync("src/home/home-view.ts", "utf8");
  const data = readFileSync("src/home/home-workbench-data.ts", "utf8");
  const model = readFileSync("src/home/home-workbench-model.ts", "utf8");
  const nativeGraph = readFileSync("src/home/open-native-graph.ts", "utf8");
  const viewService = readFileSync("src/plugin/view-service.ts", "utf8");
  const brandIcons = readFileSync("src/home/home-brand-icons.ts", "utf8");
  const bentoIsland = readFileSync("src/home/home-bento-island.tsx", "utf8");
  const conversationActions = readFileSync("src/home/home-conversation-actions.ts", "utf8");
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
    overrides?: Record<string, Record<string, string>>;
  };
  const packageLock = readFileSync("package-lock.json", "utf8");
  const fixedCommit = "2d671cc6c0e0f40e28682c9cbddd16694dcfe627";
  const smoothUiCommit = "1143ba66738566e8acb9a3f8a7db9eab3f10f2d4";
  const heatmapSource = view.match(/private renderHeatmap\(\): void \{[\s\S]*?private renderCalendar/u)?.[0] ?? "";
  const shellSource = view.match(/private renderShell\(\): void \{[\s\S]*?private renderHeader/u)?.[0] ?? "";
  const desktopEntryStyles = styles.slice(
    styles.indexOf(".echoink-home-entry {"),
    styles.indexOf("@container echoink-home (max-width: 1100px)")
  );
  const mobile520EntryStart = styles.indexOf("@container echoink-home (max-width: 520px)");
  const mobile520EntryStyles = styles.slice(
    mobile520EntryStart,
    styles.indexOf("@media (prefers-reduced-motion: reduce)", mobile520EntryStart)
  );

  for (const deletedPath of [
    "src/home/home-graph-controller.ts",
    "src/home/home-recent-island.tsx",
    "src/home/magic-ui/marquee.tsx",
    "src/home/magic-ui/provenance/marquee-demo.tsx"
  ]) assert.equal(existsSync(deletedPath), false, deletedPath + " should be removed");

  const homeSourceFiles = sourceFilesUnder("src/home").filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
  const createRootFiles = homeSourceFiles.filter((path) => /\bcreateRoot\b/u.test(readFileSync(path, "utf8")));
  assert.deepEqual(createRootFiles.sort(), [
    "src/home/home-bento-island.tsx",
    "src/home/home-conversation-actions-island.tsx"
  ]);

  assert.doesNotMatch(
    [view, data, model].join("\n"),
    /HomeGraph|recentThoughts|sortRecentHomeRecords|createHomeRecentIsland|is-document-hidden/u
  );
  assert.doesNotMatch(data, /resolvedLinks|getAllTags|frontmatter|flattenPropertyValues/u);
  assert.doesNotMatch(model, /EMPTY_HOME_GRAPH_FILTERS|buildHomeGraph|filterHomeGraph|selectHomeGraphNeighborhood|aggregateHomeGraph|homeGraphNodeVisualValue|isHomeSystemPath/u);
  assert.doesNotMatch(model, /\bctime:\s*number|\btags:\s*string\[\]|\bproperties:\s*Record/u);
  assert.match(data, /const cache = journalDateFromPath\(file\.path\)[\s\S]*?metadataCache\.getFileCache\(file\)[\s\S]*?: null/u);
  assert.match(data, /path: file\.path,[\s\S]*title: file\.basename,[\s\S]*folder: file\.parent\?\.path \|\| "根目录",[\s\S]*mtime: file\.stat\.mtime/u);

  assert.match(view, /this\.registerEvent\(this\.app\.vault\.on\("rename", \(\) => this\.scheduleHomeRefresh\(\)\)\)/u);
  assert.match(view, /this\.registerEvent\(this\.app\.vault\.on\("delete", \(\) => this\.scheduleHomeRefresh\(\)\)\)/u);
  assert.doesNotMatch(view, /metadataCache\.on\("resolved"|workspace\.on\("css-change"|visibilitychange/u);
  assert.match(view, /entry\.targetPath[\s\S]*this\.data\?\.records\.find\(\(record\) => record\.path === entry\.targetPath\)/u);
  assert.match(view, /formatRelativeTime\(target\.mtime\)/u);
  assert.ok(shellSource.indexOf("this.renderHeader();") < shellSource.indexOf("echoink-home-entries-section"));
  assert.ok(shellSource.indexOf("echoink-home-conversation-section") < shellSource.indexOf("echoink-home-rhythm-grid"));
  assert.ok(shellSource.indexOf("echoink-home-rhythm-grid") < shellSource.indexOf("echoink-home-entries-section"));
  assert.doesNotMatch(shellSource, /overview|graph|recent|marquee|thought/u);
  assert.match(view, /await this\.plugin\.activateView\(\)[\s\S]*this\.plugin\.getCodexView\(\)[\s\S]*view\.createDraftSession\(title, draft\)/u);
  assert.doesNotMatch(
    view.match(/private async openConversationAction\([\s\S]*?\n  \}/u)?.[0] ?? "",
    /sendMessage|Provider|\.create\(|\.modify\(/u
  );
  assert.doesNotMatch(conversationActions, /app\.vault|adapter\.|\.create\(|\.modify\(|sendMessage|Provider/u);

  assert.match(bootstrap, /addRibbonIcon\("feather"/u);
  assert.match(codexView, /getIcon\(\): string \{\s*return "feather";/u);
  assert.match(settingsTab, /echoink-about-logo[\s\S]*setIcon\(logoWrap, "feather"\)/u);
  for (const icon of ["wiki", "outputs", "projects", "inbox", "journal", "review"]) {
    assert.match(brandIcons, new RegExp(icon + ": \\[", "u"));
  }
  assert.match(brandIcons, /stroke-width", "1\.5"/u);
  assert.match(brandIcons, /stroke-linecap", "round"/u);
  assert.doesNotMatch(brandIcons, /createElementNS\(SVG_NS, "use"\)|innerHTML/u);

  assert.equal(packageJson.dependencies?.["3d-force-graph"], undefined);
  assert.doesNotMatch(packageLock, /3d-force-graph/u);
  assert.match(view, /try \{[\s\S]*openFile\(file, \{ active: true \}\)[\s\S]*暂时无法打开/u);
  assert.doesNotMatch(view + data + model, /internalPlugins|dataEngine|GraphView|iframe/u);

  assert.match(view, new RegExp(fixedCommit, "u"));
  assert.equal(magicSource.commit, fixedCommit);
  const expectedMagicUiHashes = new Map([
    ["bento-grid.tsx", "9c2abcb2a4e51519e56d510299771a2d0e170ab9927a9a792a58614b1837ed47"],
    ["animated-shiny-text.tsx", "3743a0a0b4894840a96bacd839e493872bac484a940684f91fd23a1784c00fbb"],
    ["utils.ts", "7c8c3dfc0cdd370d44932828eb067ef771c8fe7996693221d5d4b90af6d54f2d"],
    ["button.tsx", "881fabaf889450b7c671ffabe455bd4b4d101c36f80868f1bf4819ba5f4f4886"],
    ["provenance/globals.css", "b290ad71358829d043a8453924e0b97878596294849de34ea08451412fd760f2"],
    ["LICENSE.md", "0147b84235ed916b8b4e89c1f80655351c5afe7d211b629be61f553a227b34ba"]
  ]);
  assert.equal(magicSource.files.length, expectedMagicUiHashes.size);
  for (const source of magicSource.files) {
    assert.equal(source.sha256, expectedMagicUiHashes.get(source.localPath));
    const actual = createHash("sha256")
      .update(readFileSync("src/home/magic-ui/" + source.localPath))
      .digest("hex");
    assert.equal(actual, source.sha256);
    assert.match(thirdPartyNotices, new RegExp(escapeRegex(source.upstreamPath) + "[^\\n]*" + source.sha256, "u"));
  }
  assert.doesNotMatch(JSON.stringify(magicSource) + thirdPartyNotices + magicCssBuild, /Marquee|marquee-demo|marquee-vertical|animate-marquee/u);
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
  assert.match(view, /this\.bentoIsland\?\.unmount\(\)/u);
  assert.match(view, /kicker: entry\.description/u);
  assert.doesNotMatch(view, /entry\.id !== "review"/u);
  assert.match(data, /projects: \{ label: "Projects", description: "正在推进的项目知识"/u);
  assert.match(data, /inbox: \{ label: "Inbox", description: "等待归类的输入"/u);
  assert.match(data, /review: \{ label: "Review", description: "知识库复盘与报告"/u);
  assert.match(view, /可在 Projects 目录建立项目/u);
  assert.match(view, /当前没有待整理输入/u);

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
    "framer-motion": "12.23.24",
    "@radix-ui/react-icons": "1.3.2",
    "@radix-ui/react-slot": "1.2.3",
    "class-variance-authority": "0.7.1"
  })) assert.equal(packageJson.dependencies?.[name], version);
  assert.match(packageLock, /"framer-motion": "12\.23\.24"/u);
  assert.deepEqual(packageJson.overrides?.["framer-motion"], {
    "motion-dom": "12.23.23",
    "motion-utils": "12.23.6"
  });
  assert.match(packageLock, /"node_modules\/framer-motion\/node_modules\/motion-dom": \{[\s\S]*?"version": "12\.23\.23"/u);
  assert.match(packageLock, /"node_modules\/framer-motion\/node_modules\/motion-utils": \{[\s\S]*?"version": "12\.23\.6"/u);

  const amicroCommit = "86b55340bfb939b8e93bb53aa46ba017c3449f1c";
  const amicroSource = JSON.parse(readFileSync("src/home/amicro/SOURCE.json", "utf8")) as {
    commit: string;
    files: Array<{
      upstreamPath: string;
      localPath: string;
      upstreamSha256: string;
      localSha256: string;
    }>;
  };
  const expectedAmicroHashes = new Map([
    ["text-shimmer-wave.tsx", ["30c3d97fb98214283b760734c4331677bfccba77e02a5ba09b5fea42183ea489", "04e9f7914a6ec82d21b21bf7651dfe38d97c3e55771e3be3eb4af244d5a38601"]],
    ["morphing-shape.tsx", ["ad2bb3627d8c332a199f656413aa8dc2604ea39226011d5bb326518c4522f317", "5cf2101ae48601e247e46774ee3808ed97f022d2539e7f209e532a57f5cc9dfa"]],
    ["typing.tsx", ["0cc94473f7b97885f64a946a189a8c1d641bb6efccdc75ac05607606013faa83", "a83ff8833ce11374441f982ba74b08fcf34e8963f44bdcb251660f479f62c955"]],
    ["origami-shape.tsx", ["7800305ad25cb6962aef752a8dc57fba28fed3544ba2dbfdb2a4752eb912baa5", "2e0bb583a734b79d357b0a56184e089b1f677b4f8b0fc0fc65a14c5abd12791b"]],
    ["LICENSE.md", ["4b2e0abfc3fdc8722545c3772ee7c6fd0bcdbe8af76112af50066689fca4a9c2", "4b2e0abfc3fdc8722545c3772ee7c6fd0bcdbe8af76112af50066689fca4a9c2"]]
  ]);
  assert.equal(amicroSource.commit, amicroCommit);
  assert.equal(amicroSource.files.length, expectedAmicroHashes.size);
  for (const source of amicroSource.files) {
    const expected = expectedAmicroHashes.get(source.localPath);
    assert.deepEqual([source.upstreamSha256, source.localSha256], expected);
    const actual = createHash("sha256")
      .update(readFileSync(`src/home/amicro/${source.localPath}`))
      .digest("hex");
    assert.equal(actual, source.localSha256);
    assert.match(thirdPartyNotices, new RegExp(escapeRegex(source.upstreamPath) + "[^\\n]*" + source.upstreamSha256, "u"));
    assert.match(thirdPartyNotices, new RegExp(escapeRegex(source.localPath) + "[^\\n]*" + source.localSha256, "u"));
  }
  const actionIsland = readFileSync("src/home/home-conversation-actions-island.tsx", "utf8");
  assert.match(actionIsland, /createRoot\(host\)/u);
  assert.match(actionIsland, /root\.unmount\(\)/u);
  assert.match(actionIsland, /new IntersectionObserver/u);
  assert.match(actionIsland, /observer\.disconnect\(\)/u);
  assert.match(actionIsland, /document\.addEventListener\("visibilitychange"/u);
  assert.match(actionIsland, /document\.removeEventListener\("visibilitychange"/u);
  assert.match(actionIsland, /prefers-reduced-motion: reduce/u);
  assert.match(actionIsland, /aria-label=\{action\.accessibleName\}/u);
  assert.match(actionIsland, /echoink-home-conversation-action-art" aria-hidden="true"/u);
  assert.equal((actionIsland.match(/<button\b/gu) ?? []).length, 1);
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
  assert.match(styles, /ECHOINK_HOME_MAGIC_UI_CSS_START/u);
  assert.match(styles, /\.echoink-home-magic-ui \.animate-shiny-text/u);
  assert.match(styles, /@keyframes shiny-text/u);
  assert.doesNotMatch(styles, /echoink-home-(?:overview|graph|recent|marquee|thought)|animate-marquee|@keyframes marquee/u);
  assert.match(styles, /\.echoink-home-entries-section\s*\{[^}]*margin-top: 56px;/u);
  assert.match(styles, /\.echoink-home-rhythm-grid\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/u);
  assert.match(styles, /\.echoink-home-rhythm-grid\s*\{[^}]*align-items: start;[^}]*gap: 24px;[^}]*margin-top: 40px;/u);
  assert.match(styles, /\.echoink-home-heatmap,[\s\S]*\.echoink-home-calendar-panel\s*\{[^}]*padding: 20px;[^}]*border: 1px solid/u);
  assert.match(view, /echoink-home-calendar-summary[\s\S]*有日记 · \$\{journalCount\} 天/u);
  assert.doesNotMatch(styles, /\.echoink-home-magic-ui &/u);
  assert.match(
    desktopEntryStyles,
    /\.echoink-home-entry\.is-outputs \.echoink-home-entry-copy,[\s\S]*\.echoink-home-entry\.is-review \.echoink-home-entry-copy\s*\{[^}]*margin-top: auto;/u
  );
  assert.match(
    desktopEntryStyles,
    /\.echoink-home-entry\.is-outputs \.echoink-home-entry-icon,[\s\S]*\.echoink-home-entry\.is-projects \.echoink-home-entry-icon,[\s\S]*\.echoink-home-entry\.is-inbox \.echoink-home-entry-icon,[\s\S]*\.echoink-home-entry\.is-journal \.echoink-home-entry-icon,[\s\S]*\.echoink-home-entry\.is-review \.echoink-home-entry-icon\s*\{[^}]*align-self: flex-end;/u
  );
  assert.match(desktopEntryStyles, /\.echoink-home-entry\.is-projects \.echoink-home-entry-copy\s*\{[^}]*margin-top: auto;/u);
  assert.doesNotMatch(
    desktopEntryStyles,
    /\.echoink-home-entry\.is-projects \.echoink-home-entry-copy\s*\{[^}]*(?:padding-left|border-left)/u
  );
  assert.doesNotMatch(desktopEntryStyles, /\.echoink-home-entry\.is-review:(?:hover|focus-visible)/u);
  assert.doesNotMatch(desktopEntryStyles, /\.echoink-home-entry\.is-review \.echoink-home-entry-cta\s*\{/u);
  assert.match(desktopEntryStyles, /\.echoink-home-entry:hover \.echoink-home-entry-icon,[\s\S]*translateY\(-40px\) scale\(0\.75\)/u);
  assert.match(desktopEntryStyles, /\.echoink-home-entry:hover \.echoink-home-entry-copy,[\s\S]*translateY\(-40px\)/u);
  assert.match(desktopEntryStyles, /\.echoink-home-entry-cta\s*\{[^}]*position: absolute;[^}]*opacity: 0;[^}]*translateY\(40px\)/u);
  assert.doesNotMatch(view + bentoIsland, /onMouseEnter|onMouseLeave|mouseenter|mouseleave|pointerenter|pointerleave/u);

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

  assert.match(styles, /\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*grid-auto-rows: auto;[\s\S]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 1100px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*repeat\(6, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 800px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /@container echoink-home \(max-width: 520px\)[\s\S]*\.echoink-home-magic-ui \.echoink-home-bento-grid[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(view, /今日日记已建立|默认使用“此刻速记”/u);
  assert.doesNotMatch(view, /最近维护 \$\{formatRelativeTime\(this\.snapshot\.lastRun\.at\)\}|尚无维护记录，可开始一次复盘/u);
  assert.match(view, /echoink-home-entry-review-row[\s\S]*echoink-home-entry-number[\s\S]*health\.label/u);
  assert.match(bentoIsland, /shimmerWidth = 100|AnimatedShinyText/u);
  assert.doesNotMatch(styles, /@keyframes echoink-home-shiny-text|animation: echoink-home-shiny-text/u);
  assert.match(styles, /@container echoink-home \(max-width: 800px\)[\s\S]*\.echoink-home-entry-cta\s*\{[^}]*opacity: 1;[^}]*transform: translateY\(0\);/u);
  assert.doesNotMatch(mobile520EntryStyles, /\.echoink-home-entry\.is-review\s*\{[^}]*(?:display: grid|grid-template-columns)/u);
  assert.doesNotMatch(mobile520EntryStyles, /\.echoink-home-entry\.is-review \.echoink-home-entry-(?:copy|cta)\s*\{/u);
  assert.match(mobile520EntryStyles, /\.echoink-home-entry-cta\s*\{[^}]*position: static;[^}]*opacity: 1;[^}]*transform: none;/u);
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

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = `${directory}/${name}`;
      return statSync(path).isDirectory() ? sourceFilesUnder(path) : [path];
    })
    .sort();
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
    mtime: now.getTime(),
    firstImagePath: "assets/today.png",
    firstImageUrl: "app://local/assets/today.png"
  }, {
    path: "journal/2026-09-01.md",
    title: "2026-09-01",
    folder: "journal",
    mtime: now.getTime()
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
      mtime: day("2026-08-31")
    },
    {
      path: "projects/b.md",
      title: "Workbench",
      folder: "projects",
      mtime: day("2026-08-31")
    },
    {
      path: "wiki/c.md",
      title: "Reference",
      folder: "wiki",
      mtime: day("2026-08-30")
    },
    {
      path: "inbox/d.md",
      title: "Unsorted",
      folder: "inbox",
      mtime: day("2026-08-29")
    }
  ];
}
