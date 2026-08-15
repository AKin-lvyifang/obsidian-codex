import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
  KnowledgeMaintenancePreferenceError,
  KnowledgeMaintenancePreferenceRepository
} from "../knowledge-base/knowledge-maintenance-preferences";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
} from "../knowledge-base/knowledge-maintenance-protocol";
import type {
  Phase3MaintenancePreview,
  Phase3MaintenanceWalRecord
} from "../knowledge-base/phase3-maintenance-service";
import {
  FilePhase3MaintenanceStateStore
} from "../plugin/pi-knowledge-maintenance-production";
import {
  beginSavingKnowledgeMaintenancePreference,
  createKnowledgeMaintenancePreferenceEditor,
  editKnowledgeMaintenancePreference,
  failSavingKnowledgeMaintenancePreference,
  knowledgeMaintenancePreferenceDraftState,
  knowledgeMaintenancePreferenceIsDirty,
  restoreDefaultKnowledgeMaintenancePreference
} from "../settings/knowledge-maintenance-preference-editor";

export async function runKnowledgeMaintenancePreferenceTests(): Promise<void> {
  await assertRepositoryDefaultSaveCasAndRestore();
  await assertRepositoryRejectsInvalidAndLinkedPaths();
  await assertWalReloadRetainsRunPreferenceRevision();
  assertPreferenceEditorStates();
}

async function assertRepositoryDefaultSaveCasAndRestore(): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "echoink-knowledge-preferences-"
  )));
  const rootPath = path.join(parent, "knowledge");
  try {
    const repository = new KnowledgeMaintenancePreferenceRepository(rootPath);
    const initial = await repository.read();
    assert.equal(initial.state, "default");
    assert.equal(
      initial.profileVersion,
      ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION
    );
    assert.equal(
      initial.content,
      ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    );
    await assert.rejects(lstat(rootPath), nodeError("ENOENT"));

    const customContent = "# 自定义偏好\n\n优先保留反例和决策边界。\n";
    const custom = await repository.save({
      content: customContent,
      expectedRevision: initial.revision
    });
    assert.equal(custom.state, "custom");
    assert.equal(custom.content, customContent);
    assert.notEqual(custom.revision, initial.revision);
    assert.equal(await readFile(repository.filePath, "utf8"), customContent);
    const fileStat = await lstat(repository.filePath);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.mode & 0o077, 0);

    await assert.rejects(
      repository.save({
        content: "# stale writer\n",
        expectedRevision: initial.revision
      }),
      preferenceError("revision_conflict")
    );
    assert.equal(await readFile(repository.filePath, "utf8"), customContent);

    const restored = await repository.save({
      content: ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
      expectedRevision: custom.revision
    });
    assert.equal(restored.state, "default");
    assert.equal(restored.revision, initial.revision);
    assert.equal(
      await readFile(repository.filePath, "utf8"),
      ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertRepositoryRejectsInvalidAndLinkedPaths(): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "echoink-knowledge-preferences-unsafe-"
  )));
  try {
    const normalRoot = path.join(parent, "normal");
    const repository = new KnowledgeMaintenancePreferenceRepository(normalRoot);
    const initial = await repository.read();
    for (const content of ["", "bad\u0000content"] as const) {
      await assert.rejects(
        repository.save({ content, expectedRevision: initial.revision }),
        preferenceError("invalid_content")
      );
    }

    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, linkedRoot, "dir");
    await assert.rejects(
      new KnowledgeMaintenancePreferenceRepository(linkedRoot).read(),
      preferenceError("unsafe_path")
    );

    const linkedFileRoot = path.join(parent, "linked-file-root");
    const outsideFile = path.join(parent, "outside.md");
    await mkdir(linkedFileRoot, { recursive: true });
    await writeFile(outsideFile, "# outside\n", "utf8");
    await symlink(
      outsideFile,
      path.join(linkedFileRoot, "preferences.md"),
      "file"
    );
    await assert.rejects(
      new KnowledgeMaintenancePreferenceRepository(linkedFileRoot).read(),
      preferenceError("unsafe_path")
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertWalReloadRetainsRunPreferenceRevision():
Promise<void> {
  const rootPath = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "echoink-knowledge-wal-reload-"
  )));
  const vaultId = "preference-reload-vault";
  const preferenceRevision = `sha256:${"c".repeat(64)}`;
  const preview: Phase3MaintenancePreview = Object.freeze({
    protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
    preferenceProfileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    preferenceState: "custom",
    preferenceRevision,
    previewId: "preview-preference-reload",
    previewDigest: `sha256:${"d".repeat(64)}`,
    vaultId,
    dateKey: "2026-08-13",
    sourceMode: "explicit",
    selectedSources: Object.freeze([]),
    remainingRawPaths: Object.freeze([]),
    tracker: Object.freeze({
      binding: Object.freeze({ kind: "missing" as const }),
      changedRawPaths: Object.freeze([])
    }),
    shadowId: "shadow-preference-reload",
    shadowRevision: `sha256:${"e".repeat(64)}`,
    reportPath: "outputs/maintenance/kb-maintenance-2026-08-13.md",
    actions: Object.freeze([]),
    createdAt: 1_786_579_200_000
  });
  const wal: Phase3MaintenanceWalRecord = Object.freeze({
    version: 1,
    preview,
    authorization: Object.freeze({
      approvalId: "approval-preference-reload",
      operationIdentity: "operation-preference-reload",
      consumedAt: 1_786_579_200_100,
      contract: Object.freeze({
        productRunId: "run-preference-reload",
        toolCallId: "call-preference-reload",
        conversationId: "conversation-preference-reload",
        piSessionId: "session-preference-reload",
        vaultId,
        userId: "user-preference-reload",
        deviceId: "device-preference-reload",
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        preferenceProfileVersion: preview.preferenceProfileVersion,
        preferenceState: preview.preferenceState,
        preferenceRevision,
        orderedActions: Object.freeze([])
      })
    }),
    status: "prepared",
    sequence: 0,
    actions: Object.freeze([]),
    createdAt: 1_786_579_200_100,
    updatedAt: 1_786_579_200_100
  });
  try {
    const first = new FilePhase3MaintenanceStateStore({
      storageRootPath: rootPath,
      vaultId
    });
    await first.createWal(wal);

    const reloaded = new FilePhase3MaintenanceStateStore({
      storageRootPath: rootPath,
      vaultId
    });
    const storedWal = await reloaded.loadWal(preview.previewId);
    assert.equal(storedWal?.preview.preferenceRevision, preferenceRevision);
    assert.equal(
      storedWal?.authorization.contract.preferenceRevision,
      preferenceRevision
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

function assertPreferenceEditorStates(): void {
  const defaultEditor = createKnowledgeMaintenancePreferenceEditor({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "default",
    revision: `sha256:${"1".repeat(64)}`,
    content: ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
  });
  assert.equal(knowledgeMaintenancePreferenceIsDirty(defaultEditor), false);
  assert.equal(knowledgeMaintenancePreferenceDraftState(defaultEditor), "default");

  const edited = editKnowledgeMaintenancePreference(
    defaultEditor,
    "# 自定义\n"
  );
  assert.equal(knowledgeMaintenancePreferenceIsDirty(edited), true);
  assert.equal(knowledgeMaintenancePreferenceDraftState(edited), "custom");
  const saving = beginSavingKnowledgeMaintenancePreference(edited);
  assert.equal(saving.saving, true);
  const failed = failSavingKnowledgeMaintenancePreference(
    saving,
    "safe error"
  );
  assert.equal(failed.saving, false);
  assert.equal(failed.error, "safe error");
  assert.equal(knowledgeMaintenancePreferenceIsDirty(failed), true);

  const customSaved = createKnowledgeMaintenancePreferenceEditor({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "custom",
    revision: `sha256:${"2".repeat(64)}`,
    content: "# 已保存自定义\n"
  });
  const restoredDraft =
    restoreDefaultKnowledgeMaintenancePreference(customSaved);
  assert.equal(
    knowledgeMaintenancePreferenceDraftState(restoredDraft),
    "default"
  );
  assert.equal(
    knowledgeMaintenancePreferenceIsDirty(restoredDraft),
    true,
    "restore default changes only the draft until the user saves"
  );
}

function preferenceError(
  code: KnowledgeMaintenancePreferenceError["code"]
): (error: unknown) => boolean {
  return (error) => error instanceof KnowledgeMaintenancePreferenceError
    && error.code === code;
}

function nodeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
