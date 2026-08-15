import type {
  SecretStorageReaderPort
} from "./device-credential-registry";

const SECRET_ID_PATTERN =
  /^codex-echoink-secret-[a-f0-9]{32}$/u;

export interface SecretStorageWriterPort
extends SecretStorageReaderPort {
  setSecret(secretId: string, secret: string): void | Promise<void>;
  listSecrets(): readonly string[] | Promise<readonly string[]>;
}

interface ObsidianSecretStorageApi {
  setSecret(secretId: string, secret: string): void;
  getSecret(secretId: string): string | null;
  listSecrets(): string[];
}

interface ObsidianSecretStorageHost {
  readonly secretStorage?: ObsidianSecretStorageApi;
}

export class ObsidianSecretStorageAdapter
implements SecretStorageWriterPort {
  readonly #secretStorage: ObsidianSecretStorageApi;

  constructor(app: ObsidianSecretStorageHost) {
    if (
      !app?.secretStorage
      || typeof app.secretStorage.setSecret !== "function"
      || typeof app.secretStorage.getSecret !== "function"
      || typeof app.secretStorage.listSecrets !== "function"
    ) {
      throw new Error(
        "Obsidian SecretStorage requires Obsidian 1.11.4 or newer."
      );
    }
    this.#secretStorage = app.secretStorage;
  }

  setSecret(secretId: string, secret: string): void {
    assertSecretId(secretId);
    assertSecretValue(secret);
    this.#secretStorage.setSecret(secretId, secret);
  }

  getSecret(secretId: string): string | null {
    assertSecretId(secretId);
    const secret = this.#secretStorage.getSecret(secretId);
    if (secret === null) return null;
    assertSecretValue(secret);
    return secret;
  }

  listSecrets(): readonly string[] {
    const ids = this.#secretStorage.listSecrets();
    if (
      !Array.isArray(ids)
      || ids.some((id) => typeof id !== "string")
    ) {
      throw new Error("Obsidian SecretStorage returned an invalid index.");
    }
    return Object.freeze(
      ids
        .filter((id) => SECRET_ID_PATTERN.test(id))
        .sort()
    );
  }

  async setAndReadback(
    secretId: string,
    secret: string
  ): Promise<void> {
    this.setSecret(secretId, secret);
    const readback = this.getSecret(secretId);
    if (readback !== secret) {
      throw new Error("Obsidian SecretStorage readback failed.");
    }
  }
}

function assertSecretId(secretId: string): void {
  if (!SECRET_ID_PATTERN.test(secretId)) {
    throw new Error("EchoInk SecretStorage ID is invalid.");
  }
}

function assertSecretValue(secret: string): void {
  if (
    typeof secret !== "string"
    || secret.length < 8
    || secret.length > 4_096
    || secret.includes("\r")
    || secret.includes("\n")
    || secret.includes("\u0000")
  ) {
    throw new Error("EchoInk SecretStorage value is invalid.");
  }
}
