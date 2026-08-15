import {
  CREDENTIAL_REF_PATTERN,
  ECHOINK_CREDENTIAL_OWNER_NAMESPACE,
  createCredentialRef,
  createDeviceCredentialRegistry,
  createSecretId,
  parseDeviceCredentialRegistry,
  type CredentialAudience,
  type CredentialPurpose,
  type DeviceCredentialRegistryEntry,
  type DeviceCredentialRegistryV1,
  type DeviceCredentialState
} from "./device-credential-registry";
import {
  canonicalizeProviderEndpoint,
  jcsCanonicalize
} from "./provider-target-identity";

const SETTINGS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DEVICE_SCOPE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CredentialCommitCheckpoint =
  | "registry_prepared"
  | "secret_collision_checked"
  | "write_intent_committed"
  | "secret_storage_written"
  | "secret_written_committed"
  | "secret_readback_verified"
  | "registry_active"
  | "settings_ref_staged"
  | "settings_plaintext_cleared"
  | "restart_verified";

export interface CredentialCommitInput {
  commitId: string;
  sourceId: string;
  deviceIdDigest: string;
  vaultIdDigest: string;
  purpose: "provider_api_key" | "proxy_auth";
  audience: CredentialAudience;
}

export interface CredentialSettingsSnapshot {
  sourceId: string;
  revision: number;
  digest: string;
  sourceSecret: string | null;
  stagedCredentialRef: string | null;
  proxyEndpoint: string | null;
}

export interface CredentialSettingsCasInput {
  expectedRevision: number;
  expectedDigest: string;
  sourceId: string;
  credentialRef: string;
  proxyEndpoint: string | null;
  clearSourceSecret: boolean;
}

export interface CredentialSettingsPort {
  read(): Promise<unknown>;
  compareAndSwap(input: CredentialSettingsCasInput): Promise<void>;
}

export interface CredentialRegistryCasInput {
  expectedRevision: number | null;
  expectedDigest: string | null;
  credentialRef: string;
  target: DeviceCredentialRegistryV1;
}

export interface CredentialRegistryPort {
  readRegistry(input: {
    deviceIdDigest: string;
    vaultIdDigest: string;
  }): Promise<unknown>;
  compareAndSwap(input: CredentialRegistryCasInput): Promise<void>;
}

export interface CredentialSecretStoragePort {
  listSecrets(): readonly string[] | Promise<readonly string[]>;
  setSecret(
    secretId: string,
    value: string
  ): void | Promise<void>;
  getSecret(
    secretId: string
  ): string | null | undefined | Promise<string | null | undefined>;
}

export interface CredentialReadbackVerifierPort {
  verify(input: {
    credentialRef: string;
    deviceIdDigest: string;
    vaultIdDigest: string;
    purpose: CredentialPurpose;
    audience: CredentialAudience;
    registryRevision: number;
    registryDigest: string;
  }): boolean | Promise<boolean>;
}

export interface CredentialCommitResult {
  status: "complete";
  credentialRef: string;
}

export type CredentialCommitErrorCode =
  | "credential_commit_invalid"
  | "credential_registry_poisoned"
  | "credential_settings_poisoned"
  | "credential_secret_storage_failed"
  | "credential_readback_verification_failed";

export class CredentialCommitError extends Error {
  constructor(readonly code: CredentialCommitErrorCode) {
    super(code);
    this.name = "CredentialCommitError";
  }
}

/**
 * Commits a credential through durable, strictly read-back boundaries.
 * The coordinator never exposes a Secret ID and clears its transient source
 * only after the active reference has been persisted.
 */
export class CredentialCommitCoordinator {
  private readonly registry: CredentialRegistryPort;
  private readonly settings: CredentialSettingsPort;
  private readonly secretStorage: CredentialSecretStoragePort;
  private readonly restartVerifier: CredentialReadbackVerifierPort;
  private readonly afterCheckpoint:
    | ((
        checkpoint: CredentialCommitCheckpoint
      ) => void | Promise<void>)
    | undefined;
  private readonly credentialRefFactory: () => string;
  private readonly secretIdFactory: () => string;
  private readonly now: () => number;

  constructor(options: {
    registry: CredentialRegistryPort;
    settings: CredentialSettingsPort;
    secretStorage: CredentialSecretStoragePort;
    restartVerifier: CredentialReadbackVerifierPort;
    afterCheckpoint?: (
      checkpoint: CredentialCommitCheckpoint
    ) => void | Promise<void>;
    credentialRefFactory?: () => string;
    secretIdFactory?: () => string;
    now?: () => number;
  }) {
    if (
      typeof options?.registry?.readRegistry !== "function"
      || typeof options?.registry?.compareAndSwap !== "function"
      || typeof options?.settings?.read !== "function"
      || typeof options?.settings?.compareAndSwap !== "function"
      || typeof options?.secretStorage?.listSecrets !== "function"
      || typeof options?.secretStorage?.setSecret !== "function"
      || typeof options?.secretStorage?.getSecret !== "function"
      || typeof options?.restartVerifier?.verify !== "function"
    ) {
      throw commitError("credential_commit_invalid");
    }
    this.registry = options.registry;
    this.settings = options.settings;
    this.secretStorage = options.secretStorage;
    this.restartVerifier = options.restartVerifier;
    this.afterCheckpoint = options.afterCheckpoint;
    this.credentialRefFactory =
      options.credentialRefFactory ?? createCredentialRef;
    this.secretIdFactory = options.secretIdFactory ?? createSecretId;
    this.now = options.now ?? Date.now;
  }

  async commit(
    input: CredentialCommitInput
  ): Promise<CredentialCommitResult> {
    validateCommitInput(input);
    let settings = await this.readSettings(input);
    const readbackVerificationRequired = settings.sourceSecret !== null;
    let registry = await this.readRegistry(input);
    let entry: DeviceCredentialRegistryEntry;

    if (settings.stagedCredentialRef) {
      if (!registry) throw commitError("credential_registry_poisoned");
      entry = requireMatchingEntry(
        registry,
        settings.stagedCredentialRef,
        input
      );
    } else if (registry?.commitId === input.commitId) {
      entry = requireUniqueCommitEntry(registry, input);
    } else {
      if (settings.sourceSecret === null) {
        throw commitError("credential_settings_poisoned");
      }
      ({ registry, entry } = await this.prepareRegistryEntry(
        registry,
        input
      ));
      await this.checkpoint("registry_prepared");
    }

    if (entry.state === "poisoned") {
      throw commitError("credential_registry_poisoned");
    }
    if (!isMigratableState(entry.state)) {
      throw commitError("credential_registry_poisoned");
    }

    if (entry.state === "prepared") {
      const exists = await this.secretIdExists(entry.secretId);
      if (exists) {
        await this.poisonRegistryEntry(registry, entry, input);
      }
      await this.checkpoint("secret_collision_checked");
      registry = await this.transitionRegistryEntry(
        registry,
        entry,
        "write_intent",
        input
      );
      entry = requireMatchingEntry(registry, entry.credentialRef, input);
      await this.checkpoint("write_intent_committed");
    }

    if (entry.state === "write_intent") {
      const sourceSecret = requireSourceSecret(settings);
      const exists = await this.secretIdExists(entry.secretId);
      if (exists) {
        const recovered = await this.readSecret(entry.secretId);
        if (recovered !== sourceSecret) {
          await this.poisonRegistryEntry(registry, entry, input);
        }
      } else {
        await this.writeSecret(entry.secretId, sourceSecret);
        await this.checkpoint("secret_storage_written");
      }
      registry = await this.transitionRegistryEntry(
        registry,
        entry,
        "secret_written",
        input
      );
      entry = requireMatchingEntry(registry, entry.credentialRef, input);
      await this.checkpoint("secret_written_committed");
    }

    if (entry.state === "secret_written") {
      const sourceSecret = requireSourceSecret(settings);
      const readback = await this.readSecret(entry.secretId);
      if (readback !== sourceSecret) {
        await this.poisonRegistryEntry(registry, entry, input);
      }
      registry = await this.transitionRegistryEntry(
        registry,
        entry,
        "secret_readback_verified",
        input
      );
      entry = requireMatchingEntry(registry, entry.credentialRef, input);
      await this.checkpoint("secret_readback_verified");
    }

    if (entry.state === "secret_readback_verified") {
      registry = await this.transitionRegistryEntry(
        registry,
        entry,
        "active",
        input
      );
      entry = requireMatchingEntry(registry, entry.credentialRef, input);
      await this.checkpoint("registry_active");
    }
    if (entry.state !== "active") {
      throw commitError("credential_registry_poisoned");
    }

    const proxyEndpoint = expectedProxyEndpoint(settings, input);
    if (settings.stagedCredentialRef === null) {
      settings = await this.updateSettings(
        settings,
        entry.credentialRef,
        proxyEndpoint,
        false
      );
      await this.checkpoint("settings_ref_staged");
    } else {
      assertSettingsReference(
        settings,
        entry.credentialRef,
        proxyEndpoint
      );
    }

    if (settings.sourceSecret !== null) {
      const activeSecret = await this.readSecret(entry.secretId);
      if (activeSecret !== settings.sourceSecret) {
        await this.poisonRegistryEntry(registry, entry, input);
      }
      settings = await this.updateSettings(
        settings,
        entry.credentialRef,
        proxyEndpoint,
        true
      );
      await this.checkpoint("settings_plaintext_cleared");
    }

    if (readbackVerificationRequired) {
      await this.verifyReadback(registry, entry, input);
      await this.checkpoint("restart_verified");
    }
    return Object.freeze({
      status: "complete",
      credentialRef: entry.credentialRef
    });
  }

  private async readSettings(
    input: CredentialCommitInput
  ): Promise<CredentialSettingsSnapshot> {
    let raw: unknown;
    try {
      raw = await this.settings.read();
    } catch {
      throw commitError("credential_settings_poisoned");
    }
    const snapshot = parseSettingsSnapshot(raw);
    if (snapshot.sourceId !== input.sourceId) {
      throw commitError("credential_settings_poisoned");
    }
    expectedProxyEndpoint(snapshot, input);
    return snapshot;
  }

  private async readRegistry(
    input: CredentialCommitInput
  ): Promise<DeviceCredentialRegistryV1 | null> {
    const registry = await this.readRegistryScope(
      input.deviceIdDigest,
      input.vaultIdDigest
    );
    if (registry) assertRegistryScope(registry, input);
    return registry;
  }

  private async readRegistryScope(
    deviceIdDigest: string,
    vaultIdDigest: string
  ): Promise<DeviceCredentialRegistryV1 | null> {
    let raw: unknown;
    try {
      raw = await this.registry.readRegistry({
        deviceIdDigest,
        vaultIdDigest
      });
    } catch {
      throw commitError("credential_registry_poisoned");
    }
    if (raw === null || raw === undefined) return null;
    let registry: DeviceCredentialRegistryV1;
    try {
      registry = parseDeviceCredentialRegistry(raw);
    } catch {
      throw commitError("credential_registry_poisoned");
    }
    if (
      registry.ownerNamespace !== ECHOINK_CREDENTIAL_OWNER_NAMESPACE
      || registry.deviceIdDigest !== deviceIdDigest
      || registry.vaultIdDigest !== vaultIdDigest
    ) {
      throw commitError("credential_registry_poisoned");
    }
    return registry;
  }

  private async prepareRegistryEntry(
    current: DeviceCredentialRegistryV1 | null,
    input: CredentialCommitInput
  ): Promise<{
    registry: DeviceCredentialRegistryV1;
    entry: DeviceCredentialRegistryEntry;
  }> {
    const createdAt = new Date(this.now()).toISOString();
    if (!validIsoTime(createdAt)) {
      throw commitError("credential_commit_invalid");
    }
    const entry: DeviceCredentialRegistryEntry = {
      credentialRef: this.credentialRefFactory(),
      secretId: this.secretIdFactory(),
      purpose: input.purpose,
      audience: input.audience,
      state: "prepared",
      createdAt,
      rotatedAt: null
    };
    let target: DeviceCredentialRegistryV1;
    try {
      target = createDeviceCredentialRegistry({
        deviceIdDigest: input.deviceIdDigest,
        vaultIdDigest: input.vaultIdDigest,
        revision: (current?.revision ?? 0) + 1,
        previousDigest: current?.digest ?? null,
        commitId: input.commitId,
        entries: [...(current?.entries ?? []), entry]
      });
    } catch {
      throw commitError("credential_commit_invalid");
    }
    const registry = await this.commitRegistry(current, target, entry.credentialRef);
    return {
      registry,
      entry: requireMatchingEntry(registry, entry.credentialRef, input)
    };
  }

  private async transitionRegistryEntry(
    current: DeviceCredentialRegistryV1,
    entry: DeviceCredentialRegistryEntry,
    state: DeviceCredentialState,
    input: CredentialCommitInput
  ): Promise<DeviceCredentialRegistryV1> {
    const targetEntry: DeviceCredentialRegistryEntry = {
      ...entry,
      state
    };
    let target: DeviceCredentialRegistryV1;
    try {
      target = createDeviceCredentialRegistry({
        deviceIdDigest: current.deviceIdDigest,
        vaultIdDigest: current.vaultIdDigest,
        revision: current.revision + 1,
        previousDigest: current.digest,
        commitId: input.commitId,
        entries: current.entries.map((candidate) => (
          candidate.credentialRef === entry.credentialRef
            ? targetEntry
            : candidate
        ))
      });
    } catch {
      throw commitError("credential_registry_poisoned");
    }
    return this.commitRegistry(current, target, entry.credentialRef);
  }

  private async commitRegistry(
    current: DeviceCredentialRegistryV1 | null,
    target: DeviceCredentialRegistryV1,
    credentialRef: string
  ): Promise<DeviceCredentialRegistryV1> {
    let writeFailed = false;
    try {
      await this.registry.compareAndSwap({
        expectedRevision: current?.revision ?? null,
        expectedDigest: current?.digest ?? null,
        credentialRef,
        target
      });
    } catch {
      writeFailed = true;
    }

    let readback: DeviceCredentialRegistryV1 | null;
    try {
      readback = await this.readRegistryScope(
        target.deviceIdDigest,
        target.vaultIdDigest
      );
    } catch {
      throw commitError("credential_registry_poisoned");
    }
    if (readback && sameRegistry(readback, target)) return readback;
    if (
      writeFailed
      && (
        (current === null && readback === null)
        || (current !== null && readback && sameRegistry(readback, current))
      )
    ) {
      throw commitError("credential_registry_poisoned");
    }
    throw commitError("credential_registry_poisoned");
  }

  private async poisonRegistryEntry(
    registry: DeviceCredentialRegistryV1,
    entry: DeviceCredentialRegistryEntry,
    input: CredentialCommitInput
  ): Promise<never> {
    if (entry.state !== "poisoned") {
      try {
        await this.transitionRegistryEntry(
          registry,
          entry,
          "poisoned",
          input
        );
      } catch {
        // The externally visible result remains fail-closed even if the
        // poison marker itself cannot be durably committed.
      }
    }
    throw commitError("credential_registry_poisoned");
  }

  private async secretIdExists(secretId: string): Promise<boolean> {
    let ids: readonly string[];
    try {
      ids = await this.secretStorage.listSecrets();
    } catch {
      throw commitError("credential_secret_storage_failed");
    }
    if (
      !Array.isArray(ids)
      || ids.some((candidate) => typeof candidate !== "string")
    ) {
      throw commitError("credential_secret_storage_failed");
    }
    return ids.some((candidate) => candidate === secretId);
  }

  private async writeSecret(
    secretId: string,
    secret: string
  ): Promise<void> {
    try {
      await this.secretStorage.setSecret(secretId, secret);
    } catch {
      throw commitError("credential_secret_storage_failed");
    }
  }

  private async readSecret(secretId: string): Promise<string | null> {
    let value: string | null | undefined;
    try {
      value = await this.secretStorage.getSecret(secretId);
    } catch {
      throw commitError("credential_secret_storage_failed");
    }
    return typeof value === "string" ? value : null;
  }

  private async updateSettings(
    current: CredentialSettingsSnapshot,
    credentialRef: string,
    proxyEndpoint: string | null,
    clearSourceSecret: boolean
  ): Promise<CredentialSettingsSnapshot> {
    let writeFailed = false;
    try {
      await this.settings.compareAndSwap({
        expectedRevision: current.revision,
        expectedDigest: current.digest,
        sourceId: current.sourceId,
        credentialRef,
        proxyEndpoint,
        clearSourceSecret
      });
    } catch {
      writeFailed = true;
    }

    let rawReadback: unknown;
    try {
      rawReadback = await this.settings.read();
    } catch {
      throw commitError("credential_settings_poisoned");
    }
    const readback = parseSettingsSnapshot(rawReadback);
    const targetState = {
      sourceId: current.sourceId,
      revision: current.revision + 1,
      sourceSecret: clearSourceSecret ? null : current.sourceSecret,
      stagedCredentialRef: credentialRef,
      proxyEndpoint
    };
    if (sameSettingsState(readback, targetState)) return readback;
    if (writeFailed && sameSettingsSnapshot(readback, current)) {
      throw commitError("credential_settings_poisoned");
    }
    throw commitError("credential_settings_poisoned");
  }

  private async verifyReadback(
    registry: DeviceCredentialRegistryV1,
    entry: DeviceCredentialRegistryEntry,
    input: CredentialCommitInput
  ): Promise<void> {
    let verified = false;
    try {
      verified = await this.restartVerifier.verify({
        credentialRef: entry.credentialRef,
        deviceIdDigest: input.deviceIdDigest,
        vaultIdDigest: input.vaultIdDigest,
        purpose: input.purpose,
        audience: input.audience,
        registryRevision: registry.revision,
        registryDigest: registry.digest
      });
    } catch {
      verified = false;
    }
    if (!verified) {
      throw commitError("credential_readback_verification_failed");
    }
  }

  private async checkpoint(
    checkpoint: CredentialCommitCheckpoint
  ): Promise<void> {
    await this.afterCheckpoint?.(checkpoint);
  }
}

function validateCommitInput(input: CredentialCommitInput): void {
  if (
    !isPlainRecord(input)
    || typeof input.commitId !== "string"
    || !SAFE_SOURCE_ID_PATTERN.test(input.commitId)
    || typeof input.sourceId !== "string"
    || !SAFE_SOURCE_ID_PATTERN.test(input.sourceId)
    || !DEVICE_SCOPE_DIGEST_PATTERN.test(input.deviceIdDigest)
    || !DEVICE_SCOPE_DIGEST_PATTERN.test(input.vaultIdDigest)
    || (
      input.purpose !== "provider_api_key"
      && input.purpose !== "proxy_auth"
    )
    || !isPlainRecord(input.audience)
  ) {
    throw commitError("credential_commit_invalid");
  }
  try {
    createDeviceCredentialRegistry({
      deviceIdDigest: input.deviceIdDigest,
      vaultIdDigest: input.vaultIdDigest,
      revision: 1,
      previousDigest: null,
      commitId: input.commitId,
      entries: [{
        credentialRef: `cred-${"0".repeat(32)}`,
        secretId: `codex-echoink-secret-${"0".repeat(32)}`,
        purpose: input.purpose,
        audience: input.audience,
        state: "prepared",
        createdAt: "2000-01-01T00:00:00.000Z",
        rotatedAt: null
      }]
    });
  } catch {
    throw commitError("credential_commit_invalid");
  }
}

function parseSettingsSnapshot(
  value: unknown
): CredentialSettingsSnapshot {
  if (!isPlainRecord(value)) {
    throw commitError("credential_settings_poisoned");
  }
  const expectedKeys = new Set([
    "sourceId",
    "revision",
    "digest",
    "sourceSecret",
    "stagedCredentialRef",
    "proxyEndpoint"
  ]);
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.size
    || keys.some((key) => !expectedKeys.has(key))
    || typeof value.sourceId !== "string"
    || !SAFE_SOURCE_ID_PATTERN.test(value.sourceId)
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || typeof value.digest !== "string"
    || !SETTINGS_DIGEST_PATTERN.test(value.digest)
    || !(
      value.sourceSecret === null
      || (
        typeof value.sourceSecret === "string"
        && value.sourceSecret.length > 0
      )
    )
    || !(
      value.stagedCredentialRef === null
      || (
        typeof value.stagedCredentialRef === "string"
        && CREDENTIAL_REF_PATTERN.test(value.stagedCredentialRef)
      )
    )
    || !(
      value.proxyEndpoint === null
      || (
        typeof value.proxyEndpoint === "string"
        && canonicalProxyEndpoint(value.proxyEndpoint)
      )
    )
  ) {
    throw commitError("credential_settings_poisoned");
  }
  return Object.freeze({
    sourceId: value.sourceId,
    revision: value.revision as number,
    digest: value.digest,
    sourceSecret: value.sourceSecret,
    stagedCredentialRef: value.stagedCredentialRef,
    proxyEndpoint: value.proxyEndpoint
  });
}

function expectedProxyEndpoint(
  settings: CredentialSettingsSnapshot,
  input: CredentialCommitInput
): string | null {
  if (input.purpose !== "proxy_auth") return settings.proxyEndpoint;
  if (
    settings.proxyEndpoint === null
    || settings.proxyEndpoint !== input.audience.canonicalOrigin
  ) {
    throw commitError("credential_settings_poisoned");
  }
  return settings.proxyEndpoint;
}

function requireSourceSecret(
  settings: CredentialSettingsSnapshot
): string {
  if (settings.sourceSecret === null) {
    throw commitError("credential_registry_poisoned");
  }
  return settings.sourceSecret;
}

function assertRegistryScope(
  registry: DeviceCredentialRegistryV1,
  input: CredentialCommitInput
): void {
  if (
    registry.ownerNamespace !== ECHOINK_CREDENTIAL_OWNER_NAMESPACE
    || registry.deviceIdDigest !== input.deviceIdDigest
    || registry.vaultIdDigest !== input.vaultIdDigest
  ) {
    throw commitError("credential_registry_poisoned");
  }
}

function requireUniqueCommitEntry(
  registry: DeviceCredentialRegistryV1,
  input: CredentialCommitInput
): DeviceCredentialRegistryEntry {
  const candidates = registry.entries.filter((entry) =>
    entry.purpose === input.purpose
    && sameAudience(entry.audience, input.audience)
  );
  if (candidates.length !== 1) {
    throw commitError("credential_registry_poisoned");
  }
  return candidates[0];
}

function requireMatchingEntry(
  registry: DeviceCredentialRegistryV1,
  credentialRef: string,
  input: CredentialCommitInput
): DeviceCredentialRegistryEntry {
  const entry = registry.entries.find(
    (candidate) => candidate.credentialRef === credentialRef
  );
  if (
    !entry
    || entry.purpose !== input.purpose
    || !sameAudience(entry.audience, input.audience)
  ) {
    throw commitError("credential_registry_poisoned");
  }
  return entry;
}

function isMigratableState(state: DeviceCredentialState): boolean {
  return (
    state === "prepared"
    || state === "write_intent"
    || state === "secret_written"
    || state === "secret_readback_verified"
    || state === "active"
  );
}

function sameAudience(
  left: CredentialAudience,
  right: CredentialAudience
): boolean {
  try {
    return jcsCanonicalize(left) === jcsCanonicalize(right);
  } catch {
    return false;
  }
}

function sameRegistry(
  left: DeviceCredentialRegistryV1,
  right: DeviceCredentialRegistryV1
): boolean {
  try {
    return jcsCanonicalize(left) === jcsCanonicalize(right);
  } catch {
    return false;
  }
}

function assertSettingsReference(
  settings: CredentialSettingsSnapshot,
  credentialRef: string,
  proxyEndpoint: string | null
): void {
  if (
    settings.stagedCredentialRef !== credentialRef
    || settings.proxyEndpoint !== proxyEndpoint
  ) {
    throw commitError("credential_settings_poisoned");
  }
}

function sameSettingsSnapshot(
  left: CredentialSettingsSnapshot,
  right: CredentialSettingsSnapshot
): boolean {
  return (
    left.sourceId === right.sourceId
    && left.revision === right.revision
    && left.digest === right.digest
    && left.sourceSecret === right.sourceSecret
    && left.stagedCredentialRef === right.stagedCredentialRef
    && left.proxyEndpoint === right.proxyEndpoint
  );
}

function sameSettingsState(
  snapshot: CredentialSettingsSnapshot,
  expected: {
    sourceId: string;
    revision: number;
    sourceSecret: string | null;
    stagedCredentialRef: string | null;
    proxyEndpoint: string | null;
  }
): boolean {
  return (
    snapshot.sourceId === expected.sourceId
    && snapshot.revision === expected.revision
    && snapshot.sourceSecret === expected.sourceSecret
    && snapshot.stagedCredentialRef === expected.stagedCredentialRef
    && snapshot.proxyEndpoint === expected.proxyEndpoint
  );
}

function canonicalProxyEndpoint(value: string): boolean {
  try {
    const parsed = canonicalizeProviderEndpoint(value);
    return parsed.canonicalOrigin === value
      && parsed.canonicalPathPrefix === "/";
  } catch {
    return false;
  }
}

function validIsoTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function commitError(code: CredentialCommitErrorCode): CredentialCommitError {
  return new CredentialCommitError(code);
}
