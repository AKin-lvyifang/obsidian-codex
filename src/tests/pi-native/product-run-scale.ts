import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  PiConversationCatalogEntry,
  PiProductRunRecord
} from "../../harness/pi-native/contracts";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { stablePathToken } from "../../harness/pi-native/file-store-utils";

const SCALE_RUN_COUNT = 2_000;
const TARGET_CONVERSATION_ID = "conversation-scale-target";
const TARGET_RUN_ID = "scale-run-1000";
const VAULT_ID = "vault-scale";

export async function runProductRunScaleTests(): Promise<void> {
  const storageRootPath = await mkdtemp(
    path.join(os.tmpdir(), "echoink-product-run-scale-")
  );
  try {
    const catalog = {
      get: async (conversationId: string): Promise<PiConversationCatalogEntry> => ({
        conversationId,
        piSessionId: `pi-${conversationId}`,
        vaultId: VAULT_ID,
        title: conversationId,
        status: "active",
        defaultMemoryMode: "normal",
        createdAt: 0,
        updatedAt: 0
      })
    };
    const writer = new FileProductRunStore({
      storageRootPath,
      vaultId: VAULT_ID,
      catalog
    });
    await writer.initialize();
    for (let index = 0; index < SCALE_RUN_COUNT; index += 1) {
      await writer.create(scaleRun(index));
    }

    const store = new FileProductRunStore({
      storageRootPath,
      vaultId: VAULT_ID,
      catalog,
      now: () => 10_000
    });
    await store.initialize();

    assert.deepEqual(
      (await store.list(TARGET_CONVERSATION_ID)).map((run) => run.productRunId),
      [TARGET_RUN_ID],
      "the startup metadata index must narrow a conversation list to its run"
    );

    // A warm target lookup must not parse unrelated ProductRun files again.
    // If it did, this intentionally corrupted unrelated body would fail it.
    const unrelatedRunId = "scale-run-1999";
    await writeFile(
      path.join(store.rootPath, `${stablePathToken(unrelatedRunId)}.json`),
      "{ deliberately invalid JSON",
      "utf8"
    );
    assert.deepEqual(
      (await store.list(TARGET_CONVERSATION_ID)).map((run) => run.productRunId),
      [TARGET_RUN_ID]
    );
    assert.equal(
      (await store.read(TARGET_RUN_ID))?.productRunId,
      TARGET_RUN_ID,
      "a warm ID lookup must use its index entry rather than scan every run"
    );

    const updated = await store.update(TARGET_RUN_ID, {
      state: "running",
      activeLeafId: "entry-scale-1000",
      updatedAt: 10_000
    });
    assert.equal(updated.state, "running");
    assert.equal(
      (await store.list(TARGET_CONVERSATION_ID))[0]?.state,
      "running",
      "updates must refresh the indexed run"
    );

    const created = await store.create({
      productRunId: "scale-run-created",
      conversationId: TARGET_CONVERSATION_ID,
      piSessionId: `pi-${TARGET_CONVERSATION_ID}`,
      userEntryId: "entry-scale-created",
      toolCallIds: [],
      memoryMode: "normal",
      state: "accepted",
      activeLeafId: null,
      createdAt: 10_001,
      updatedAt: 10_001
    });
    assert.equal(created.productRunId, "scale-run-created");
    assert.deepEqual(
      (await store.list(TARGET_CONVERSATION_ID)).map((run) => run.productRunId),
      [TARGET_RUN_ID, "scale-run-created"],
      "creates must refresh the conversation index"
    );

    await unlink(
      path.join(store.rootPath, `${stablePathToken(created.productRunId)}.json`)
    );
    assert.deepEqual(
      (await store.list(TARGET_CONVERSATION_ID)).map((run) => run.productRunId),
      [TARGET_RUN_ID],
      "removed durable files must be evicted from the warm metadata index"
    );
    assert.equal(await store.read(created.productRunId), null);
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

function scaleRun(index: number): PiProductRunRecord {
  const conversationId = index === 1_000
    ? TARGET_CONVERSATION_ID
    : `conversation-scale-${index}`;
  return {
    productRunId: `scale-run-${index}`,
    conversationId,
    piSessionId: `pi-${conversationId}`,
    userEntryId: `entry-scale-${index}`,
    toolCallIds: [],
    memoryMode: "normal",
    state: "accepted",
    activeLeafId: null,
    createdAt: index + 1,
    updatedAt: index + 1
  };
}
