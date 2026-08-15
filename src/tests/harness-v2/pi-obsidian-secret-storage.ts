import * as assert from "node:assert/strict";
import {
  ObsidianSecretStorageAdapter
} from "../../harness/pi/obsidian-secret-storage";

export async function runHarnessV2PiObsidianSecretStorageTests():
Promise<void> {
  const values = new Map<string, string>();
  const adapter = new ObsidianSecretStorageAdapter({
    secretStorage: {
      setSecret(id: string, secret: string) {
        values.set(id, secret);
      },
      getSecret(id: string) {
        return values.get(id) ?? null;
      },
      listSecrets() {
        return [
          ...values.keys(),
          "another-plugin-secret"
        ];
      }
    }
  } as never);
  const secretId =
    "codex-echoink-secret-00000000000000000000000000000000";
  await adapter.setAndReadback(secretId, "phase0-secret-value");
  assert.equal(adapter.getSecret(secretId), "phase0-secret-value");
  assert.deepEqual(adapter.listSecrets(), [secretId]);
  assert.throws(
    () => adapter.setSecret(
      "another-plugin-secret",
      "must-not-be-written"
    ),
    /ID is invalid/u
  );
  assert.equal(values.has("another-plugin-secret"), false);

  const failedReadback = new ObsidianSecretStorageAdapter({
    secretStorage: {
      setSecret() {},
      getSecret() {
        return null;
      },
      listSecrets() {
        return [];
      }
    }
  } as never);
  await assert.rejects(
    failedReadback.setAndReadback(
      "codex-echoink-secret-11111111111111111111111111111111",
      "phase0-secret-value"
    ),
    /readback failed/u
  );
}
