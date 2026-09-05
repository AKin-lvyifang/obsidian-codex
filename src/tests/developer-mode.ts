import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import Plugin from "../main";
import { PiLocalDataService } from "../plugin/pi-local-data-service";
import { ProductActivityGate } from "../plugin/api-provider-activation-service";
import { LocalDeveloperAccess } from "../plugin/developer-mode/access";
import { DeveloperModeService } from "../plugin/developer-mode/service";
import { MemoryDeveloperBackups } from "../plugin/developer-mode/memory-backups";
import { seedDeveloperMemories } from "../plugin/developer-mode/seed";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { DreamScheduler } from "../harness/memory/dream-scheduler";
import { cognitiveAtomicWrite } from "../harness/memory/cognitive-file-utils";
import { applyAgentSelfOperations, replaceAgentCurrentSelf } from "../harness/memory/agent-self";
import { createSecondaryRecord, serializeSecondaryRecord } from "../harness/memory/secondary-memory-store";
import { applyDreamProfileUpdate, emptyUserProfileState } from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";

function unlock(access: LocalDeveloperAccess): void {
  for (let i = 0; i < 6; i++) assert.equal(access.click(true), false);
  assert.equal(access.click(true), true);
}

async function accessAndScript(): Promise<void> {
  let marker = "";
  let now = 100;
  let desktop = true;
  const access = new LocalDeveloperAccess({ isDesktop: () => desktop, readMarker: () => marker, now: () => now });
  for (const invalid of ["", "{", "null", "[]", '{"enabled":"true"}', '{"enabled":false}']) {
    marker = invalid;
    for (let i = 0; i < 8; i++) assert.equal(access.click(true), false);
    assert.throws(() => access.require(), /locked/u);
  }
  marker = '{"enabled":true}';
  desktop = false;
  assert.equal(access.click(true), false);
  desktop = true;
  for (let i = 0; i < 6; i++) access.click(true);
  now += 5_001;
  assert.equal(access.click(true), false);
  access.click(false);
  unlock(access);
  access.require();
  marker = '{"enabled":false}';
  assert.throws(() => access.require(), /locked/u);
  marker = '{"enabled":true}';
  assert.throws(() => access.require(), /locked/u);
  const reloaded = new LocalDeveloperAccess({ isDesktop: () => true, readMarker: () => marker });
  assert.throws(() => reloaded.require(), /locked/u);
  unlock(reloaded);
  reloaded.lock();
  assert.throws(() => reloaded.require(), /locked/u);
  const home = await fs.mkdtemp(path.join(tmpdir(), "echoink-developer-home-"));
  try {
    for (const action of ["enable", "disable"]) {
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", [
        'import os from "node:os";',
        'import { syncBuiltinESMExports } from "node:module";',
        'os.homedir = () => process.env.ECHOINK_DEVELOPER_TEST_HOME;',
        'syncBuiltinESMExports();',
        'process.argv = [process.execPath, "scripts/echoink-developer-mode.mjs", process.argv[1]];',
        'await import("./scripts/echoink-developer-mode.mjs");'
      ].join("\n"), action], {
        env: { ...process.env, ECHOINK_DEVELOPER_TEST_HOME: home }, encoding: "utf8"
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(await fs.readFile(path.join(home, ".echoink/developer-mode.json"), "utf8")).enabled, action === "enable");
    }
    assert.deepEqual(await fs.readdir(home), [".echoink"]);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
  console.log("PASS local marker, revoke, desktop, gesture, reload, script isolation");
}

async function repositoryAndLifecycle(): Promise<void> {
  const vault = await fs.mkdtemp(path.join(tmpdir(), "echoink-developer-vault-"));
  const storage = path.join(vault, "plugin-data/pi-agent-product-v1");
  const systems: CognitiveSystem[] = [];
  let foregroundBusy = false;
  let enabled = true;
  let llmMode: "none" | "valid" | "invalid" = "none";
  let calls = 0;
  const makeRepository = async () => {
    const repository = new PersonalMemoryRepository({ vaultPath: storage, vaultId: "developer-fixture", watchExternalChanges: false });
    await repository.initialize();
    return repository;
  };
  const makeSystem = async (repository: PersonalMemoryRepository) => {
    const system = await CognitiveSystem.create({ repository,
      llm: () => llmMode === "none" ? null : { call: async () => { calls++; return llmMode === "valid" ? "no_change" : "{invalid"; } },
      getDreamConfig: () => ({ enabled, runsPerDay: 3 }),
      isForegroundBusy: () => foregroundBusy,
      registerInterval: () => undefined
    });
    systems.push(system);
    return system;
  };
  const reopen = async () => makeSystem(await makeRepository());
  const validateReopen = async () => { const system = await reopen(); await system.dispose(); };
  const recall = (repository: PersonalMemoryRepository) => new PersonalMemoryRecallHarness(repository).prepareTurnContext({
    memoryMode: "normal", query: "Lantern", tokenBudget: 2_000,
    vaultId: "developer-fixture", conversationId: "fixture", piSessionId: "fixture", productRunId: "fixture"
  });
  try {
    let system = await reopen();
    assert.deepEqual(await seedDeveloperMemories(system), { created: 7, existing: 0 });
    const first = await system.repository.readUserControlState();
    assert.equal(new Set(first.records.map((record) => record.kind)).size, 7);
    assert.ok(first.records.every((record) => record.contentOrigin === "hypothesis" && record.source.includes("developer-synthetic")));
    assert.equal((await system.dreamStateStore.read()).pendingMemoryIds.length, 7);
    assert.deepEqual(await seedDeveloperMemories(system), { created: 0, existing: 7 });
    assert.equal((await system.repository.readUserControlState()).revision, first.revision);
    assert.equal(calls, 0);
    assert.ok((await recall(system.repository)).recall!.total > 0);
    enabled = false;
    assert.equal(await system.forceDreamRun(), null);
    enabled = true;
    foregroundBusy = true;
    assert.equal(await system.forceDreamRun(), null);
    foregroundBusy = false;
    assert.equal((await system.forceDreamRun())?.providerUnavailable, true);
    assert.equal(calls, 0);
    llmMode = "invalid";
    const failed = await system.forceDreamRun();
    assert.ok(failed!.failedMemoryIds.length > 0 || failed!.error);
    llmMode = "valid";
    const dream = await system.forceDreamRun();
    assert.equal(dream?.committed, true);
    assert.ok(dream!.processedMemoryIds.length > 0);
    assert.ok(calls > 0);
    assert.deepEqual(system.scheduler.lastResult, dream);
    const access = new LocalDeveloperAccess({ isDesktop: () => true, readMarker: () => '{"enabled":true}' });
    unlock(access);
    const gate = new ProductActivityGate();
    let writable = true;
    const service = new DeveloperModeService(access, {
      getSystem: async () => system, vaultName: () => "Disposable fixture",
      foregroundBusy: () => foregroundBusy || gate.hasActivity, writable: () => writable,
      withLocalActivity: (action) => gate.run(action),
      changeMemory: async () => { throw new Error("unexpected direct change"); }, latestBackup: async () => null
    });
    writable = false;
    await assert.rejects(service.execute("seed"), /read_only/u);
    writable = true;
    foregroundBusy = true;
    await assert.rejects(service.execute("reset"), /busy/u);
    foregroundBusy = false;
    const queued = service.execute("seed");
    await assert.rejects(service.execute("restore"), /busy/u);
    await queued;
    access.lock();
    await assert.rejects(service.execute("seed"), /locked/u);

    // Install recognizable sentinels across independent stores and unknown files.
    const sentinels = ["note.md", "plugin-data/data.json", "plugin-data/pi-agent-product-v1/conversations/sentinel.json",
      "plugin-data/knowledge/sentinel.md", "plugin-data/skills/sentinel.md",
      "plugin-data/pi-agent-product-v1/.echoink/shared-user/unknown.txt",
      "plugin-data/pi-agent-product-v1/.echoink/shared-user/.runtime/backups/forgets/unknown-123.md"];
    for (const name of sentinels) {
      const target = path.join(vault, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `preserve:${name}`);
    }
    await system.selectPersonalityTemplate("advisor", { initialIdentity: { displayName: "Fixture Agent", avatar: { kind: "preset", presetId: "bot" } } } as never);
    await system.applyAgentSelfOperations([{ operation: "replace", field: "tone", value: "A manually chosen fixture tone" }]);
    const self = await system.readAgentSelfState();
    const parent = first.records[0];
    const learnedTone = "A learned fixture tone";
    const metadata = { ...self.metadata, revision: self.metadata.revision + 1, derivations: [{
      target: "tone", operation: "replace", basis: "explicit",
      sources: [{ kind: "memory", id: parent.id, revision: parent.revision, contextId: "fixture", evidence: parent.content }],
      previousValue: self.state.tone, currentValue: learnedTone, updatedAt: Date.now()
    }, {
      target: "habit:fixture-learned-habit", operation: "habit_add", basis: "explicit",
      sources: [{ kind: "memory", id: parent.id, revision: parent.revision, contextId: "fixture", evidence: parent.content }],
      previousValue: null, currentValue: "A sourced fixture habit", updatedAt: Date.now()
    }] };
    const profile = applyDreamProfileUpdate(emptyUserProfileState(Date.now()), {
      items: [{ section: "preference", profileKey: "preference.workflow", text: "A fixture-derived preference", basis: "explicit_memory", sourceMemoryId: parent.id }],
      processedSources: [{ memoryId: parent.id, memoryRevision: parent.revision }], now: Date.now()
    });
    const userContent = renderUserMarkdown(profile);
    const secondary = createSecondaryRecord({ parentId: parent.id, sourceMemoryRevision: parent.revision,
      title: "Fixture clue", content: "A synthetic association", recallWhen: "Lantern fixture",
      matchTerms: ["Lantern"], relation: "associated", reason: "Synthetic fixture", basis: "llm_inferred",
      confidence: 0.8, supportLevel: "direct", evidence: parent.content.slice(0, 80), now: Date.now()
    });
    await system.repository.applyCognitiveUpdate({
      agentContent: replaceAgentCurrentSelf(self.agent, applyAgentSelfOperations(self.state, [
        { operation: "replace", field: "tone", value: learnedTone },
        { operation: "habit_add", key: "fixture-learned-habit", text: "A sourced fixture habit" }
      ])),
      userContent,
      secondaryRecords: [secondary], detail: "developer-fixture-derived-state",
      extraChanges: [
        { relativePath: "agents/echoink/agent-self-meta.json", content: JSON.stringify(metadata) },
        { relativePath: "shared-user/user-profile-state.json", content: JSON.stringify({ ...profile, lastProjectedUserHash: createHash("sha256").update(userContent).digest("hex") }) },
        { relativePath: secondary.file, content: serializeSecondaryRecord(secondary) }
      ]
    });
    const forgotten = await system.repository.write({ operation: "create", kind: "fact", title: "Forget fixture", content: "Synthetic forgotten record", basis: "explicit" }, {
      vaultId: "developer-fixture", conversationId: "fixture", piSessionId: "fixture", productRunId: "fixture", userEntryId: "forgotten", memoryMode: "normal"
    });
    await system.repository.forgetFromUserControl(forgotten.record!.id, "fixture", forgotten.revision);
    const currentRevision = (await system.repository.readUserControlState()).revision;
    await system.repository.forgetFromUserControl(first.records[1].id, "forget then restore fixture", currentRevision);
    await system.repository.restoreForgotten(first.records[1].id, (await system.repository.readUserControlState()).revision);
    const identityBytes = await fs.readFile(system.repository.layout.agentIdentity);
    const beforeAgent = await fs.readFile(system.repository.layout.agent);
    const root = system.repository.layout.root;
    const backups = new MemoryDeveloperBackups(root);
    await system.dispose();
    const { backup } = await backups.change("reset", validateReopen);
    assert.equal(await backups.latestResetPath(), backup);
    await assert.rejects(system.repository.readUserControlState(), /disposed/u);
    system = await reopen();
    assert.equal((await system.repository.readUserControlState()).records.length, 0);
    assert.equal((await system.dreamStateStore.read()).pendingMemoryIds.length, 0);
    assert.equal((await system.repository.readUserControlState()).forgottenIds.length, 0);
    assert.equal((await system.listAllSecondary()).length, 0);
    assert.doesNotMatch((await system.repository.readUserControlState()).user, /fixture-derived/u);
    assert.equal((await system.readAgentSelfState()).metadata.derivations.length, 0);
    assert.equal((await system.readAgentSelfState()).state.currentLearnedHabits.length, 0);
    assert.equal((await recall(system.repository)).recall!.total, 0);
    assert.equal((await system.readAgentProfile()).templateId, "advisor");
    assert.equal((await system.readAgentSelfState()).state.tone, "A manually chosen fixture tone");
    assert.ok(identityBytes.equals(await fs.readFile(system.repository.layout.agentIdentity)));
    await system.dispose();
    const beforeBackup = await fs.readFile(backup);
    const { backup: protectedCurrent } = await backups.change("restore", validateReopen);
    assert.notEqual(protectedCurrent, backup);
    assert.ok(beforeBackup.equals(await fs.readFile(backup)));
    system = await reopen();
    assert.equal((await system.repository.readUserControlState()).records.length, 7);
    assert.equal((await system.repository.readUserControlState()).forgottenIds.length, 1);
    assert.equal((await system.listAllSecondary()).length, 1);
    assert.equal((await system.readAgentSelfState()).state.tone, learnedTone);
    assert.equal((await system.readAgentSelfState()).state.currentLearnedHabits[0].key, "fixture-learned-habit");
    assert.match((await system.repository.readUserControlState()).user, /fixture-derived/u);
    assert.ok((await recall(system.repository)).recall!.total > 0);
    assert.ok(beforeAgent.equals(await fs.readFile(system.repository.layout.agent)));
    for (const name of sentinels) assert.equal(await fs.readFile(path.join(vault, name), "utf8"), `preserve:${name}`);
    await system.dispose();

    const originalManifest = await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"));
    const brokenBackup = new MemoryDeveloperBackups(root, { atomicWrite: async () => { throw new Error("fixture_backup_failure"); } });
    await assert.rejects(brokenBackup.change("reset", validateReopen), /fixture_backup_failure/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    let failOnce = true;
    const partialFailure = new MemoryDeveloperBackups(root, { atomicWrite: async (target, bytes) => {
      if (target.endsWith("agent-self-meta.json") && failOnce) { failOnce = false; throw new Error("fixture_partial_write_failure"); }
      await cognitiveAtomicWrite(target, bytes);
    } });
    await assert.rejects(partialFailure.change("reset", validateReopen), /rolled_back/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    await assert.rejects(backups.change("reset", async () => { throw new Error("fixture_reopen_failure"); }), /rolled_back/u);
    assert.ok(originalManifest.equals(await fs.readFile(path.join(root, "shared-user/.runtime/manifest.json"))));
    // Simulate an interrupted transaction. Startup recovery uses the immutable snapshot.
    const snapshot = JSON.parse(beforeBackup.toString("utf8"));
    const journal = path.join(backups.directory, "active-change.json");
    await fs.writeFile(journal, JSON.stringify({ schema: "echoink.developer-memory-change.v1", before: path.basename(backup), paths: Object.keys(snapshot.files), committed: false }));
    const memoryPath = path.join(root, first.records[0].file);
    await fs.unlink(memoryPath);
    await backups.recoverInterruptedChange();
    assert.equal((await fs.stat(memoryPath)).isFile(), true);

    // Exercise the production plugin orchestration with disposable local stores.
    llmMode = "none";
    system = await reopen();
    await pluginResetLifecycle(system, reopen, vault);
    console.log("PASS real Repository seven kinds, dedupe, queue, Scheduler/Engine, backup/reset/restore, Recall, sentinels, rollback, startup recovery, plugin lifecycle");
  } finally {
    for (const system of systems) await system.dispose();
    await fs.rm(vault, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function pluginResetLifecycle(system: CognitiveSystem, reopen: () => Promise<CognitiveSystem>, vault: string): Promise<void> {
  const originalCreate = PiLocalDataService.create;
  const host = Object.create(Plugin.prototype) as any;
  const access = new LocalDeveloperAccess({ isDesktop: () => true, readMarker: () => '{"enabled":true}' });
  unlock(access);
  let shutdowns = 0;
  const local = (cognitive: CognitiveSystem) => ({ personalMemory: cognitive.repository, dispose: () => cognitive.repository.dispose() });
  Object.assign(host, {
    developerAccess: access, developerMemoryChanging: false,
    settings: { defaultPermission: "workspace-write", memory: { useLongTermMemory: true, dreamEnabled: true, dreamRunsPerDay: 3 } },
    productActivity: new ProductActivityGate(), piRunConversations: new Map(), piSubmittingConversations: new Set(),
    piConversationActivationTasks: new Map(), piConversationActivationLane: Promise.resolve(),
    piLocalData: local(system), piLocalDataFlight: null, cognitiveSystem: system, cognitiveSystemFlight: null,
    piRuntimeBundle: { runtime: { shutdown: async () => { shutdowns++; } } }, piRuntimeFlight: null,
    personalMemoryCorrection: { stale: true },
    createDreamLlmPort: () => null, registerInterval: () => undefined, getCodexView: () => null,
    getVaultPath: () => vault
  });
  (PiLocalDataService as any).create = async () => {
    assert.equal(host.developerMemoryChanging, true);
    await assert.rejects(host.ensurePiLocalData(), /changing/u);
    await assert.rejects(host.ensurePiProductionRuntime(), /changing/u);
    await assert.rejects(host.productActivity.run(async () => undefined), /切换/u);
    const next = await reopen();
    await next.dispose();
    const repository = new PersonalMemoryRepository({ vaultPath: path.dirname(next.repository.layout.root), vaultId: "developer-fixture", watchExternalChanges: false });
    await repository.initialize();
    return { personalMemory: repository, dispose: () => repository.dispose() };
  };
  try {
    host.piRunConversations.set("run", "chat");
    await assert.rejects(host.changeDeveloperMemory("reset"), /busy/u);
    host.piRunConversations.clear();
    await host.changeDeveloperMemory("reset");
    assert.equal(shutdowns, 1);
    assert.equal(host.piRuntimeBundle, null);
    assert.equal(host.personalMemoryCorrection, null);
    assert.notEqual(host.piLocalData.personalMemory, system.repository);
    assert.equal((await host.getEchoInkPersonalMemoryState()).records.length, 0);
    await host.cognitiveSystem.updateAgentIdentity({ displayName: "Renamed fixture", avatar: { kind: "default" } });
    await host.cognitiveSystem.selectPersonalityTemplate("creative");
    const manualSelf = await host.cognitiveSystem.readAgentSelfState();
    await host.cognitiveSystem.repository.updateIdentityFile("agent", `${manualSelf.agent}\nA manually kept identity note.\n`, manualSelf.revision);
    const changed = await host.changeDeveloperMemory("restore");
    assert.equal(changed.preservedLearningConflicts, 1);
    assert.equal((await host.cognitiveSystem.readAgentIdentity()).displayName, "Renamed fixture");
    const restoredSelf = await host.cognitiveSystem.readAgentSelfState();
    assert.equal(restoredSelf.metadata.templateId, "creative");
    assert.equal(restoredSelf.state.tone, manualSelf.state.tone);
    assert.match(restoredSelf.agent, /# Renamed fixture/u);
    assert.match(restoredSelf.agent, /A manually kept identity note/u);
    assert.equal(restoredSelf.state.currentLearnedHabits[0].key, "fixture-learned-habit");
    assert.equal((await host.getEchoInkPersonalMemoryState()).records.length, 7);
    assert.equal(host.developerMemoryChanging, false);
    assert.equal(host.piRuntimeBundle, null, "local operations never require Provider Runtime");
  } finally {
    PiLocalDataService.create = originalCreate;
    await host.cognitiveSystem?.dispose();
  }
}

async function schedulerDisposeDuringDueRead(): Promise<void> {
  let release!: (value: number) => void;
  let calls = 0;
  const scheduler = new DreamScheduler({
    engine: { isRunning: false, runOnce: async () => { calls++; } } as never,
    getConfig: () => ({ enabled: true, runsPerDay: 3 }), isForegroundBusy: () => false,
    readLastRunAt: () => new Promise((resolve) => { release = resolve; }), registerInterval: () => undefined
  });
  const pending = scheduler.tick();
  scheduler.dispose();
  release(0);
  await pending;
  assert.equal(calls, 0);
  assert.equal(await scheduler.forceRun(), null);
  console.log("PASS scheduler disposed during asynchronous due check");
}

await accessAndScript();
await repositoryAndLifecycle();
await schedulerDisposeDuringDueRead();
