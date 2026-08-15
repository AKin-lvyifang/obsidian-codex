export const ECHOINK_PI_DURABLE_AUTHORITY_ID =
  "echoink.pi-durable-authority.v1" as const;

export interface DevicePiCanonicalStoreRoots {
  pluginDataRootPath: string;
}

export interface DevicePiStoreSetBindingScope {
  pluginDataRootPath: string;
  vaultRootPath: string;
  deviceControlRootPath: string;
  vaultIdDigest: string;
  deviceIdDigest: string;
}

export interface PiRuntimeRootBindingProof {
  rootPath: string;
  rootBindingDigest: string;
  rootIdentity: {
    dev: number;
    ino: number;
  };
}

export interface VerifiedPiRuntimeBinding {
  schemaVersion: 1;
  authorityId: string;
  vaultIdDigest: string;
  deviceIdDigest: string;
  pluginData: PiRuntimeRootBindingProof;
}

export interface PiRuntimeBindingAuthorityPort {
  verify(input: {
    pluginDataRootPath: string;
  }): Promise<VerifiedPiRuntimeBinding>;
}

export function assertSameVerifiedPiRuntimeBinding(
  expected: VerifiedPiRuntimeBinding,
  actual: VerifiedPiRuntimeBinding
): void {
  if (
    actual.schemaVersion !== expected.schemaVersion
    || actual.authorityId !== expected.authorityId
    || actual.vaultIdDigest !== expected.vaultIdDigest
    || actual.deviceIdDigest !== expected.deviceIdDigest
    || actual.pluginData.rootPath !== expected.pluginData.rootPath
    || actual.pluginData.rootBindingDigest
      !== expected.pluginData.rootBindingDigest
    || actual.pluginData.rootIdentity.dev
      !== expected.pluginData.rootIdentity.dev
    || actual.pluginData.rootIdentity.ino
      !== expected.pluginData.rootIdentity.ino
  ) {
    throw new Error("Pi Runtime binding changed after production admission.");
  }
}

export function devicePiCanonicalStoreRoots(
  pluginDataRootPath: string
): DevicePiCanonicalStoreRoots {
  return {
    pluginDataRootPath
  };
}
