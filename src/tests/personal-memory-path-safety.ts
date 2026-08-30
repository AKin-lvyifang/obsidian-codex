import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  inspectManagedTreeNodeSafety,
  PersonalMemoryAccessError,
  type ManagedTreeNodeSafetyFileSystem
} from "../harness/memory/personal-memory-repository";

export async function runPersonalMemoryPathSafetyScenarios(): Promise<void> {
  await assertDisappearingRecursiveChildIsSkipped();
  await assertRequiredNodeDisappearanceRemainsFatal();
  await assertReplacementSymlinkRemainsFatal();
  await assertPathEscapeRemainsFatal();
  await assertPersistentRealpathChurnFailsClosed();
  console.log("PASS Personal Memory managed-tree atomic-write race remains fail-closed");
}

async function assertDisappearingRecursiveChildIsSkipped(): Promise<void> {
  const fixture = safetyFixture();
  let lstatCalls = 0;
  const missing = errno("ENOENT");
  const fileSystem: ManagedTreeNodeSafetyFileSystem = {
    lstat: async () => {
      lstatCalls += 1;
      if (lstatCalls === 1) return regularFileStat();
      throw missing;
    },
    realpath: async () => { throw missing; }
  };
  assert.equal(await inspectManagedTreeNodeSafety(
    fixture.target,
    fixture.vaultRealPath,
    { allowMissing: true, fileSystem }
  ), null);
  assert.equal(lstatCalls, 2, "realpath ENOENT must be confirmed by a second lstat");
}

async function assertRequiredNodeDisappearanceRemainsFatal(): Promise<void> {
  const fixture = safetyFixture();
  let lstatCalls = 0;
  const missing = errno("ENOENT");
  const fileSystem: ManagedTreeNodeSafetyFileSystem = {
    lstat: async () => {
      lstatCalls += 1;
      if (lstatCalls === 1) return regularFileStat();
      throw missing;
    },
    realpath: async () => { throw missing; }
  };
  await assert.rejects(
    inspectManagedTreeNodeSafety(fixture.target, fixture.vaultRealPath, { fileSystem }),
    (error) => error === missing
  );
}

async function assertReplacementSymlinkRemainsFatal(): Promise<void> {
  const fixture = safetyFixture();
  let lstatCalls = 0;
  const missing = errno("ENOENT");
  const fileSystem: ManagedTreeNodeSafetyFileSystem = {
    lstat: async () => {
      lstatCalls += 1;
      return lstatCalls === 1 ? regularFileStat() : symbolicLinkStat();
    },
    realpath: async () => { throw missing; }
  };
  await assert.rejects(
    inspectManagedTreeNodeSafety(
      fixture.target,
      fixture.vaultRealPath,
      { allowMissing: true, fileSystem }
    ),
    (error) => error instanceof PersonalMemoryAccessError && error.code === "unsafe_path"
  );
}

async function assertPathEscapeRemainsFatal(): Promise<void> {
  const fixture = safetyFixture();
  const outside = path.resolve(fixture.vaultRealPath, "..", "outside", "record.md");
  await assert.rejects(
    inspectManagedTreeNodeSafety(
      fixture.target,
      fixture.vaultRealPath,
      {
        allowMissing: true,
        fileSystem: {
          lstat: async () => regularFileStat(),
          realpath: async () => outside
        }
      }
    ),
    (error) => error instanceof PersonalMemoryAccessError && error.code === "unsafe_path"
  );
}

async function assertPersistentRealpathChurnFailsClosed(): Promise<void> {
  const fixture = safetyFixture();
  let realpathCalls = 0;
  const missing = errno("ENOENT");
  await assert.rejects(
    inspectManagedTreeNodeSafety(
      fixture.target,
      fixture.vaultRealPath,
      {
        allowMissing: true,
        fileSystem: {
          lstat: async () => regularFileStat(),
          realpath: async () => {
            realpathCalls += 1;
            throw missing;
          }
        }
      }
    ),
    (error) => error === missing
  );
  assert.equal(realpathCalls, 2, "an extant but unstable node gets one complete retry only");
}

function safetyFixture(): Readonly<{ vaultRealPath: string; target: string }> {
  const vaultRealPath = path.resolve(path.sep, "vault");
  return Object.freeze({
    vaultRealPath,
    target: path.join(
      vaultRealPath,
      ".echoink",
      "shared-user",
      ".runtime",
      ".search-index.json.fixture.tmp"
    )
  });
}

function regularFileStat(): Stats {
  return {
    isDirectory: () => false,
    isSymbolicLink: () => false
  } as Stats;
}

function symbolicLinkStat(): Stats {
  return {
    isDirectory: () => false,
    isSymbolicLink: () => true
  } as Stats;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
