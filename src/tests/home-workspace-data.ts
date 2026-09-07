import { TFile, WorkspaceLeaf } from "obsidian";
import { EchoInkHomeView } from "../home/home-view";
import { homeWorkspaceMarkup } from "../home/home-workspace-template";
import { HomeSearchService } from "../home/home-search";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HomeActivityService } from "../home/home-activity-service";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { recordProductionMaintenanceTerminal } from "../plugin/knowledge-maintenance-history";
import { ProductionPiKnowledgeMaintenanceToolPort, type KnowledgeMaintenanceTerminalEvent } from "../plugin/pi-knowledge-maintenance-production";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";

export async function runHomeWorkspaceDataTests(): Promise<void> {
  assert.match(homeWorkspaceMarkup("en"), /What stayed with you this week/);
  assert.match(homeWorkspaceMarkup("en"), /About activity/);
  assert.doesNotMatch(homeWorkspaceMarkup("en"), /这一周，留下的足迹|了解足迹记录/);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-home-data-"));
  try {
    let now = new Date(2026, 8, 6, 10).getTime();
    const file = path.join(root, "plugin", "home-activity.json");
    const activity = new HomeActivityService(file, () => now);
    await activity.initialize();
    activity.record("inbox/a.md", "created");
    activity.open("inbox/a.md");
    activity.open("inbox/a.md");
    assert.equal(activity.snapshot().events.filter((e) => e.kind === "reopened").length, 0);
    activity.open(null);
    activity.open("inbox/a.md");
    activity.record("inbox/a.md", "modified");
    now += 1000;
    activity.record("inbox/a.md", "modified");
    let refreshes = 0;
    const stop1 = activity.subscribe(() => refreshes++);
    const stop2 = activity.subscribe(() => refreshes++);
    await activity.flush();
    assert.equal(activity.snapshot().events.length, 3);
    assert.equal(refreshes, 2);
    stop1(); stop2();
    await activity.dispose();
    const restored = new HomeActivityService(file, () => now);
    await restored.initialize();
    const before = restored.snapshot().events.map((e) => ({ ...e }));
    restored.restoreOpen("inbox/a.md");
    restored.open("inbox/a.md");
    assert.deepEqual(restored.snapshot().events, before, "reload is not a reopen");
    now += 86_400_000;
    restored.open(null); restored.open("inbox/a.md");
    assert.equal(restored.snapshot().events.filter((e) => e.kind === "reopened").length, 2);
    restored.rename("inbox", "notes");
    assert(restored.snapshot().events.every((e) => e.path === "notes/a.md"));
    restored.delete("notes/a.md");
    assert.equal(restored.snapshot().events.length, 0);
    await restored.dispose();

    const settings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
    let snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.assessment, "uninitialized");
    assert.equal(snapshot.checkFreshness.status, "missing");
    for (const folder of ["raw", "wiki", "outputs", "inbox"]) await fsp.mkdir(path.join(root, folder));
    await fsp.writeFile(path.join(root, "wiki/index.md"), "# Index");
    await fsp.writeFile(path.join(root, "outputs/.ingest-tracker.md"), "# Tracker\n- raw/a.md");
    await fsp.writeFile(path.join(root, "raw/a.md"), "# Source");
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.assessment, "local-structure", "real structure is assessable without a historical initialization flag");
    assert.equal(snapshot.health.score, 96);
    assert.equal(settings.initialization.status, "not-started", "assessment does not write an initialization receipt");
    settings.initialization.status = "initialized";
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 96);
    assert.equal(snapshot.health.scoreReasons[0]?.count, 1);
    assert.equal(snapshot.health.scoreReasons[0]?.penalty, 4);
    for (let i = 0; i < 35; i++) await fsp.writeFile(path.join(root, `inbox/${i}.md`), "input");
    settings.lastRunStatus = "failed"; settings.lastError = "failed run";
    await fsp.writeFile(path.join(root, "outputs/kb-check-untrusted.md"), "# Agent says verified\n断链：99\n孤儿页面：42\nwiki/index.md 无效\n");
    settings.lastReportPath = "outputs/kb-check-untrusted.md";
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 96, "queue size, execution failure and model report are not structural deductions");
    assert.equal(snapshot.checkFreshness.status, "missing");
    assert(snapshot.checkHeatmap.every((d) => d.status === "none"));
    const yesterday = Date.now() - 86_400_000;
    settings.healthHistory = [{ date: new Date(yesterday).toLocaleDateString("en-CA"), status: "success", at: yesterday }, { date: new Date().toLocaleDateString("en-CA"), status: "failed", at: Date.now() }];
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.checkFreshness.lastCheckAt, yesterday, "failed checks do not refresh last successful confirmation");
    assert.equal(snapshot.health.lastCheckAt, yesterday);
    settings.healthHistory = [];
    const limited = await buildKnowledgeBaseDashboardSnapshot(root, settings, { maxTotalRawFingerprintBytes: 1 });
    assert.equal(limited.health.assessment, "limited");
    await fsp.writeFile(path.join(root, "outputs/.raw-digest-registry.json"), "invalid json");
    assert.equal((await buildKnowledgeBaseDashboardSnapshot(root, settings)).health.assessment, "unavailable");
    await fsp.unlink(path.join(root, "outputs/.raw-digest-registry.json"));
    await fsp.unlink(path.join(root, "wiki/index.md"));
    snapshot = await buildKnowledgeBaseDashboardSnapshot(root, settings);
    assert.equal(snapshot.health.score, 72);
    assert.equal(snapshot.health.status, "bad", "missing core entry overrides score threshold");

    const terminalSettings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
    for (const terminal of ["completed", "partial", "noop", "failed", "write_uncertain", "cancelled"] as const) {
      const event: KnowledgeMaintenanceTerminalEvent = {
        at: now++,
        input: { vaultId: "vault", conversationId: "conversation", piSessionId: "session", productRunId: "run", toolCallId: terminal, request: "/maintain", mode: "maintain" },
        result: {
          status: terminal === "cancelled" ? "cancelled" : terminal === "completed" || terminal === "noop" ? "completed" : "failed",
          message: terminal,
          ...(terminal === "cancelled" ? {} : { maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: terminal,
            notes: terminal === "completed" || terminal === "partial" ? [{ operation: "created", path: "wiki/test.md", title: "Test", summary: "Readback" }] : [] }) })
        }
      };
      assert(recordProductionMaintenanceTerminal(terminalSettings, event));
      assert(!recordProductionMaintenanceTerminal(terminalSettings, event));
      assert.equal(terminalSettings.maintenanceHistory.at(-1)?.resultStatus, terminal);
    }
    assert.equal(terminalSettings.maintenanceHistory.length, 6);
    assert.equal(terminalSettings.healthHistory.length, 0);
    const withMaintenance = await buildKnowledgeBaseDashboardSnapshot(root, terminalSettings);
    assert(withMaintenance.checkHeatmap.every((day) => day.status === "none"));
    assert.equal(withMaintenance.activity.days.reduce((sum, day) => sum + (day.maintenance ?? 0), 0), 5, "maintenance activity stays separate from checks and excludes cancellation");
    assert.equal(normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), knowledgeBase: terminalSettings }).settings.knowledgeBase.maintenanceHistory.length, 6);

    const received: KnowledgeMaintenanceTerminalEvent[] = [];
    const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: root, privateKnowledgeRootPath: path.join(root, "private"), vaultId: "vault", userId: "user", deviceId: "device", domainService: {} as never, onTerminal: (event) => { received.push(event); } });
    const aborted = new AbortController(); aborted.abort();
    const input = { vaultId: "vault", conversationId: "conversation", piSessionId: "session", productRunId: "run", toolCallId: "cancel", request: "/maintain", mode: "maintain" as const, signal: aborted.signal };
    assert.equal((await port.execute(input)).status, "cancelled");
    assert.equal(received[0]?.result.status, "cancelled");
    await port.execute({ ...input, signal: undefined, toolCallId: "invalid" });
    assert.equal(received[1]?.result.maintenanceResult?.status, "failed");
    await assertInboxAndSearch();
    await assertHomeCaptureAndPendingSearch();
    console.log("Home activity, health evidence, search, empty Inbox and maintenance terminal: PASS");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}

async function assertHomeCaptureAndPendingSearch(): Promise<void> {
  const calls: unknown[] = [];
  const file = new TFile("inbox/未命名.md");
  let finishCreate!: (file: TFile) => void;
  const leaf = { openFile: async (...args: unknown[]) => { calls.push(["open", ...args]); } };
  const workspace = {
    getLeaf: (kind: string) => { calls.push(["leaf", kind]); return leaf; },
    setActiveLeaf: (...args: unknown[]) => { calls.push(["active", ...args]); }
  };
  const home = new EchoInkHomeView(new WorkspaceLeaf(), { app: {}, settings: { settingsLanguage: "zh-CN" } } as never);
  const mutable = home as any;
  mutable.app = { workspace };
  mutable.dataService = { createBlankInboxNote: () => { calls.push(["create"]); return new Promise<TFile>((resolve) => { finishCreate = resolve; }); } };
  mutable.refresh = async () => { calls.push(["refresh"]); };
  const first = mutable.capture();
  await mutable.capture();
  assert.deepEqual(calls, [["create"]], "a second click cannot create another note while capture is pending");
  finishCreate(file); await first;
  assert.deepEqual(calls, [["create"], ["leaf", "tab"], ["open", file, { active: true }], ["active", leaf, { focus: true }], ["refresh"]]);

  const input = { value: "new query", dataset: { home: "search-input" }, removeAttribute: () => undefined };
  const fields: Record<string, unknown> = {
    "search-input": input,
    "search-results": { empty: () => undefined },
    "search-empty": { hidden: false },
    "search-results-heading": { setText: () => undefined }
  };
  let scheduled = false;
  mutable.contentEl = { ownerDocument: { defaultView: { setTimeout: () => { scheduled = true; return 1; }, clearTimeout: () => undefined } } };
  mutable.field = (name: string) => fields[name];
  mutable.searchOpen = true;
  mutable.searchResolvedQuery = "old query";
  mutable.searchMatches = [{ path: "old.md" }];
  const opened: string[] = [];
  mutable.openNote = async (path: string) => { opened.push(path); };
  mutable.closeSearch = () => undefined;
  const enter = { key: "Enter", target: input, preventDefault: () => undefined };
  mutable.handleKeys(enter);
  assert.deepEqual(opened, [], "Enter cannot open a result for a different input query");
  mutable.scheduleSearch();
  mutable.handleKeys(enter);
  assert.equal(scheduled, true);
  assert.deepEqual(opened, [], "Enter remains inert while the new query is pending");
  mutable.searchResolvedQuery = input.value;
  mutable.searchMatches = [{ path: "new.md" }];
  mutable.handleKeys(enter);
  assert.deepEqual(opened, ["new.md"], "Enter opens the matching completed query");
  const options = [0, 1, 2].map((i) => ({ id: `option-${i}`, setAttribute: () => undefined, scrollIntoView: () => undefined }));
  Object.assign(input, { setAttribute: () => undefined });
  Object.assign(fields["search-results"] as object, { querySelectorAll: () => options });
  mutable.searchMatches = options.map((option) => ({ path: option.id }));
  mutable.searchIndex = -1;
  mutable.handleKeys({ key: "ArrowUp", target: input, preventDefault: () => undefined });
  assert.equal(mutable.searchIndex, 2, "first ArrowUp selects the last result");
  let preventedCaret = false;
  mutable.handleKeys({ key: "Home", target: input, preventDefault: () => { preventedCaret = true; } });
  assert.equal(preventedCaret, false, "Home remains native text-caret navigation in the search input");
  assert.equal(mutable.searchIndex, 2);
  mutable.selectSearchIndex(1, false);
  mutable.handleKeys(enter);
  assert.equal(opened.at(-1), "option-1", "Enter follows the pointer-selected result");
}

async function assertInboxAndSearch(): Promise<void> {
  const files = new Map<string, TFile>();
  const bodies = new Map<string, string>();
  const make = (path: string, text: string) => {
    const file = new TFile(path);
    Object.assign(file, { basename: path.split("/").at(-1)!.replace(/\.md$/, ""), stat: { mtime: 1, ctime: 1, size: text.length } });
    files.set(path, file); bodies.set(path, text); return file;
  };
  make("inbox/未命名.md", "preserve existing content");
  let race = true;
  let reads = 0;
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? (path === "inbox" ? { path } : null),
    getMarkdownFiles: () => [...files.values()],
    create: async (path: string, content: string) => {
      if (race) { race = false; make(path, "another creator"); throw new Error("already exists"); }
      return make(path, content);
    },
    cachedRead: async (file: TFile) => { reads++; return bodies.get(file.path)!; }
  }, metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["fixture-alias"] } }) } };
  const service = new HomeWorkbenchDataService(app as never);
  const created = await service.createBlankInboxNote();
  assert.equal(created.path, "inbox/未命名 2.md");
  assert.equal(bodies.get(created.path), "");
  assert.equal(bodies.get("inbox/未命名.md"), "preserve existing content");
  assert.equal(bodies.get("inbox/未命名 1.md"), "another creator");
  const target = make("notes/meaning.md", `${"Unrelated introduction. ".repeat(15)}This phrase exists only in body content.`);
  const search = new HomeSearchService(app as never);
  const controller = new AbortController();
  const found = (await search.search("only in body", controller.signal)).matches[0];
  assert.equal(found?.path, target.path);
  assert.match(found?.snippet ?? "", /This phrase exists only in body content/u);
  assert.ok(found?.snippet.startsWith("…"), "the snippet is taken around the body match, not the note opening");
  const firstReads = reads;
  await search.search("body content", controller.signal);
  assert.equal(reads, firstReads, "unchanged note bodies are cached across input");
  bodies.set(target.path, "changed source"); target.stat.mtime = 2;
  assert.equal((await search.search("changed source", controller.signal)).matches[0]?.path, target.path);
  assert.equal(reads, firstReads + 1, "only a changed file invalidates its content cache");
  controller.abort();
  assert.deepEqual((await search.search("changed source", controller.signal)).matches, []);
  let finish!: (body: string) => void;
  const delayed = new HomeSearchService({ ...app, vault: { ...app.vault, getMarkdownFiles: () => [target], cachedRead: () => new Promise<string>((resolve) => { finish = resolve; }) } } as never);
  const aborted = new AbortController(); const running = delayed.search("source", aborted.signal);
  aborted.abort(); finish("source");
  assert.deepEqual((await running).matches, [], "cancel during final file read does not return stale matches");
}
