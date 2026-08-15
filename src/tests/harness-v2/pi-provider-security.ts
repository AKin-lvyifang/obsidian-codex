import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createProviderTargetIdentity,
  createProxyTargetIdentity,
  jcsCanonicalize,
  type ProviderTargetIdentityResult
} from "../../harness/pi/provider-target-identity";
import {
  DeviceCredentialResolver,
  createCredentialRef,
  createDeviceCredentialRegistry,
  createSecretId,
  deviceCredentialRegistryDigest,
  type CredentialAudience,
  type DeviceCredentialRegistryV1
} from "../../harness/pi/device-credential-registry";

const DEVICE_ID_DIGEST = `sha256:${"d".repeat(64)}`;
const VAULT_ID_DIGEST = `sha256:${"e".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"f".repeat(64)}`;

export async function runHarnessV2PiProviderSecurityTests(): Promise<void> {
  assertTargetIdentityIsCanonicalAndScopeSensitive();
  assertTargetIdentityRejectsNonPublicAndMappedAddresses();
  await assertActiveRegistryReadsTheExactSecretOnce();
  await assertOwnershipAndAudienceMismatchNeverReadsSecret();
  await assertCasDamageAndChangedTargetNeverReadSecret();
}

function assertTargetIdentityRejectsNonPublicAndMappedAddresses(): void {
  for (const endpoint of [
    "https://192.168.1.10/v1/",
    "https://169.254.169.254/v1/",
    "https://[::ffff:127.0.0.1]/v1/",
    "https://[fc00::1]/v1/",
    "https://[fe80::1]/v1/",
    "https://[2001:db8::1]/v1/"
  ]) {
    assert.throws(
      () => providerTarget({ endpoint }),
      /provider_target_incomplete/u,
      endpoint
    );
  }
  assert.doesNotThrow(() => providerTarget({
    endpoint: "https://8.8.8.8/v1/"
  }));
  assert.doesNotThrow(() => providerTarget({
    endpoint: "https://[2606:4700:4700::1111]/v1/"
  }));
  assert.doesNotThrow(() => createProviderTargetIdentity({
    providerId: "local-model",
    endpointRevision: 1,
    endpoint: "http://127.0.0.2:8080/v1/",
    networkClass: "local_loopback",
    transport: "http",
    redirectMode: "deny",
    redirectMaxHops: 0,
    routeMode: "direct"
  }));
  assert.throws(
    () => createProxyTargetIdentity({
      endpoint: "http://169.254.169.254:8080/",
      endpointRevision: 1,
      networkClass: "cloud_public",
      transport: "http",
      tunnelMode: "http_connect_pinned"
    }),
    /proxy_target_incomplete/u
  );
}

function assertTargetIdentityIsCanonicalAndScopeSensitive(): void {
  assert.equal(
    jcsCanonicalize({ z: 1, a: "EchoInk", nullable: null }),
    "{\"a\":\"EchoInk\",\"nullable\":null,\"z\":1}"
  );

  const direct = providerTarget();
  const same = createProviderTargetIdentity({
    providerId: "deepseek",
    endpointRevision: 1,
    endpoint: "HTTPS://API.DeepSeek.COM.:443/v1/",
    networkClass: "cloud_public",
    transport: "https",
    redirectMode: "deny",
    redirectMaxHops: 0,
    routeMode: "direct"
  });
  assert.deepEqual(same, direct);
  assert.equal(direct.identity.canonicalOrigin, "https://api.deepseek.com:443");
  assert.equal(direct.canonicalPathPrefix, "/v1/");
  assert.equal(
    direct.identity.pathScopeDigest,
    "a3daa6b8cf1d477502b9801ac4c80b7c302fe6c3bb4337b12a439769a820a1f1"
  );
  assert.equal(
    direct.digest,
    "9407540c3c1e2e90db9e5bad7201cf9cc4c742da46b6f77f215ae6e9bac274f6"
  );

  const expectedDigest = createHash("sha256")
    .update(
      `echoink-target-identity-v1\0${jcsCanonicalize(direct.identity)}`,
      "utf8"
    )
    .digest("hex");
  assert.equal(direct.digest, expectedDigest);

  const proxy = createProxyTargetIdentity({
    endpoint: "http://proxy.example:8080/",
    endpointRevision: 1,
    networkClass: "cloud_public",
    transport: "http",
    tunnelMode: "http_connect_pinned"
  });
  const variants = [
    providerTarget({ providerId: "deepseek-secondary" }),
    providerTarget({ endpointRevision: 2 }),
    providerTarget({ endpoint: "https://api.deepseek.com/v2/" }),
    providerTarget({ transport: "sse" }),
    providerTarget({
      redirectMode: "same_origin_manual",
      redirectMaxHops: 2
    }),
    providerTarget({
      routeMode: "proxy",
      proxyTargetIdentityDigest: proxy.digest
    })
  ];
  for (const variant of variants) {
    assert.notEqual(variant.digest, direct.digest);
  }

  const changedProxy = createProxyTargetIdentity({
    endpoint: "http://proxy.example:8080/",
    endpointRevision: 2,
    networkClass: "cloud_public",
    transport: "http",
    tunnelMode: "http_connect_pinned"
  });
  assert.notEqual(changedProxy.digest, proxy.digest);
  assert.throws(
    () => createProviderTargetIdentity({
      providerId: "deepseek",
      endpointRevision: 1,
      endpoint: "https://api.deepseek.com/v1/%2fescape",
      networkClass: "cloud_public",
      transport: "https",
      redirectMode: "deny",
      redirectMaxHops: 0,
      routeMode: "direct"
    }),
    /endpoint_path_ambiguous/u
  );
  assert.throws(
    () => providerTarget({
      endpoint: "http://api.deepseek.com/v1/"
    }),
    /provider_target_incomplete/u
  );
  assert.throws(
    () => providerTarget({
      networkClass: "local_loopback"
    }),
    /provider_target_incomplete/u
  );
  assert.throws(
    () => createProxyTargetIdentity({
      endpoint: "http://proxy.example:8080/",
      endpointRevision: 1,
      networkClass: "cloud_public",
      transport: "https",
      tunnelMode: "https_connect_pinned"
    }),
    /proxy_target_incomplete/u
  );
}

async function assertActiveRegistryReadsTheExactSecretOnce(): Promise<void> {
  const fixture = registryFixture();
  let getSecretCalls = 0;
  const resolver = new DeviceCredentialResolver({
    registryReader: {
      async readRegistry() {
        return fixture.registry;
      }
    },
    secretStorage: {
      getSecret(secretId) {
        getSecretCalls += 1;
        assert.equal(secretId, fixture.secretId);
        return "phase0-provider-secret";
      }
    }
  });

  const secret = await resolver.resolve({
    credentialRef: fixture.credentialRef,
    deviceIdDigest: DEVICE_ID_DIGEST,
    vaultIdDigest: VAULT_ID_DIGEST,
    purpose: "provider_api_key",
    audience: fixture.audience,
    expectedRegistryRevision: fixture.registry.revision,
    expectedRegistryDigest: fixture.registry.digest
  });

  assert.equal(secret, "phase0-provider-secret");
  assert.equal(getSecretCalls, 1);
  assert.match(fixture.credentialRef, /^cred-[a-f0-9]{32}$/u);
  assert.match(
    fixture.secretId,
    /^codex-echoink-secret-[a-f0-9]{32}$/u
  );
}

async function assertOwnershipAndAudienceMismatchNeverReadsSecret():
Promise<void> {
  const fixture = registryFixture();
  const cases: Array<{
    name: string;
    registry?: DeviceCredentialRegistryV1;
    input?: Partial<ResolveFixtureInput>;
  }> = [
    {
      name: "owner",
      registry: registryWithPatch(fixture.registry, {
        ownerNamespace: "another-plugin"
      })
    },
    {
      name: "device",
      input: { deviceIdDigest: OTHER_DIGEST }
    },
    {
      name: "vault",
      input: { vaultIdDigest: OTHER_DIGEST }
    },
    {
      name: "purpose",
      input: { purpose: "proxy_auth" }
    },
    {
      name: "audience",
      input: {
        audience: {
          ...fixture.audience,
          endpointRevision: fixture.audience.endpointRevision + 1
        }
      }
    }
  ];

  for (const mismatch of cases) {
    let getSecretCalls = 0;
    const resolver = resolverFor(
      mismatch.registry ?? fixture.registry,
      () => {
        getSecretCalls += 1;
        return "must-not-be-read";
      }
    );
    await assert.rejects(
      resolver.resolve({
        ...resolveInput(fixture),
        ...mismatch.input
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && [
          "credential_owner_mismatch",
          "credential_audience_mismatch"
        ].includes(String(error.code))
      ),
      mismatch.name
    );
    assert.equal(getSecretCalls, 0, mismatch.name);
  }
}

async function assertCasDamageAndChangedTargetNeverReadSecret():
Promise<void> {
  const fixture = registryFixture();
  const changedTarget = providerTarget({ endpointRevision: 2 });
  const changedAudience: CredentialAudience = {
    ...fixture.audience,
    bindingIdDigest: changedTarget.digest,
    endpointRevision: changedTarget.identity.endpointRevision,
    credentialTargetIdentityDigest: changedTarget.digest
  };
  const changedProxy = createProxyTargetIdentity({
    endpoint: "http://proxy.example:8080/",
    endpointRevision: 2,
    networkClass: "cloud_public",
    transport: "http",
    tunnelMode: "http_connect_pinned"
  });
  const changedProxiedTarget = providerTarget({
    routeMode: "proxy",
    proxyTargetIdentityDigest: changedProxy.digest
  });
  const changedProxiedAudience: CredentialAudience = {
    ...fixture.audience,
    bindingIdDigest: changedProxiedTarget.digest,
    credentialTargetIdentityDigest: changedProxiedTarget.digest
  };
  const revokedRegistry = createDeviceCredentialRegistry({
    deviceIdDigest: DEVICE_ID_DIGEST,
    vaultIdDigest: VAULT_ID_DIGEST,
    revision: 1,
    previousDigest: null,
    commitId: "phase0-provider-security-revoked",
    entries: fixture.registry.entries.map((entry) => ({
      ...entry,
      state: "revoked"
    }))
  });
  const damaged = {
    ...fixture.registry,
    commitId: "tampered-without-new-digest"
  } as DeviceCredentialRegistryV1;
  const cases: Array<{
    name: string;
    registry?: DeviceCredentialRegistryV1;
    input?: Partial<ResolveFixtureInput>;
  }> = [
    {
      name: "registry digest mismatch",
      registry: damaged
    },
    {
      name: "CAS revision mismatch",
      input: {
        expectedRegistryRevision: fixture.registry.revision + 1
      }
    },
    {
      name: "CAS digest mismatch",
      input: { expectedRegistryDigest: OTHER_DIGEST }
    },
    {
      name: "changed Provider Target Identity",
      input: { audience: changedAudience }
    },
    {
      name: "changed Proxy Target Identity and route",
      input: { audience: changedProxiedAudience }
    },
    {
      name: "inactive Registry entry",
      registry: revokedRegistry,
      input: {
        expectedRegistryRevision: revokedRegistry.revision,
        expectedRegistryDigest: revokedRegistry.digest
      }
    }
  ];

  for (const mismatch of cases) {
    let getSecretCalls = 0;
    const resolver = resolverFor(
      mismatch.registry ?? fixture.registry,
      () => {
        getSecretCalls += 1;
        return "must-not-be-read";
      }
    );
    await assert.rejects(
      resolver.resolve({
        ...resolveInput(fixture),
        ...mismatch.input
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && [
          "credential_registry_poisoned",
          "credential_audience_mismatch"
        ].includes(String(error.code))
      ),
      mismatch.name
    );
    assert.equal(getSecretCalls, 0, mismatch.name);
  }
}

interface RegistryFixture {
  credentialRef: string;
  secretId: string;
  target: ProviderTargetIdentityResult;
  audience: CredentialAudience;
  registry: DeviceCredentialRegistryV1;
}

type ResolveFixtureInput = Parameters<DeviceCredentialResolver["resolve"]>[0];

function registryFixture(): RegistryFixture {
  const target = providerTarget();
  const audience: CredentialAudience = {
    kind: "provider",
    bindingIdDigest: target.digest,
    endpointId: "deepseek-production",
    endpointRevision: target.identity.endpointRevision,
    canonicalOrigin: target.identity.canonicalOrigin,
    pathPrefixDigest: target.identity.pathScopeDigest,
    transport: target.identity.transport,
    credentialTargetIdentityDigest: target.digest,
    proxyTargetIdentityDigest: null
  };
  const credentialRef = createCredentialRef();
  const secretId = createSecretId();
  const registry = createDeviceCredentialRegistry({
    deviceIdDigest: DEVICE_ID_DIGEST,
    vaultIdDigest: VAULT_ID_DIGEST,
    revision: 1,
    previousDigest: null,
    commitId: "phase0-provider-security-commit",
    entries: [{
      credentialRef,
      secretId,
      purpose: "provider_api_key",
      audience,
      state: "active",
      createdAt: "2026-07-30T00:00:00.000Z",
      rotatedAt: null
    }]
  });
  return {
    credentialRef,
    secretId,
    target,
    audience,
    registry
  };
}

function resolveInput(fixture: RegistryFixture): ResolveFixtureInput {
  return {
    credentialRef: fixture.credentialRef,
    deviceIdDigest: DEVICE_ID_DIGEST,
    vaultIdDigest: VAULT_ID_DIGEST,
    purpose: "provider_api_key",
    audience: fixture.audience,
    expectedRegistryRevision: fixture.registry.revision,
    expectedRegistryDigest: fixture.registry.digest
  };
}

function resolverFor(
  registry: DeviceCredentialRegistryV1,
  getSecret: (secretId: string) => string
): DeviceCredentialResolver {
  return new DeviceCredentialResolver({
    registryReader: {
      async readRegistry() {
        return registry;
      }
    },
    secretStorage: { getSecret }
  });
}

function registryWithPatch(
  registry: DeviceCredentialRegistryV1,
  patch: Partial<Omit<DeviceCredentialRegistryV1, "digest">>
): DeviceCredentialRegistryV1 {
  const { digest: _digest, ...withoutDigest } = {
    ...registry,
    ...patch
  };
  return {
    ...withoutDigest,
    digest: deviceCredentialRegistryDigest(withoutDigest)
  };
}

function providerTarget(
  patch: Partial<Parameters<typeof createProviderTargetIdentity>[0]> = {}
): ProviderTargetIdentityResult {
  return createProviderTargetIdentity({
    providerId: "deepseek",
    endpointRevision: 1,
    endpoint: "https://api.deepseek.com/v1/",
    networkClass: "cloud_public",
    transport: "https",
    redirectMode: "deny",
    redirectMaxHops: 0,
    routeMode: "direct",
    ...patch
  });
}
