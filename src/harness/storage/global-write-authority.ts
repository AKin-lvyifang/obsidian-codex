import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delayTimer } from "node:timers/promises";
import {
  durableLstatOrNull,
  readDurableRegularFile,
  resolveDurablePlainRoot,
  syncDurableDirectory
} from "./durable-append-only-cas";

export const GLOBAL_WRITE_AUTHORITY_LOCK_FILE =
  ".echoink-global-write-authority.lock" as const;

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 16 * 1024;
const LOCK_PUBLICATION_GRACE_MS = 1_000;
const LOCK_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const authorityTails = new Map<string, Promise<void>>();
const authorityContext = new AsyncLocalStorage<string>();

interface GlobalWriteAuthorityLockPayload {
  version: typeof LOCK_VERSION;
  pid: number;
  token: string;
  createdAt: number;
}

interface AcquiredGlobalWriteAuthorityLock {
  handle: fsp.FileHandle;
  lockPath: string;
  dev: number;
  ino: number;
}

class LockPublicationPending extends Error {}

export type GlobalWriteAuthorityErrorCode =
  | "authority_locked"
  | "authority_corrupt";

export class GlobalWriteAuthorityError extends Error {
  constructor(
    public readonly code: GlobalWriteAuthorityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GlobalWriteAuthorityError";
  }
}

export async function withGlobalWriteAuthority<T>(
  storageRootPathInput: string,
  action: () => Promise<T>
): Promise<T> {
  const storageRootPath = await resolveDurablePlainRoot(
    storageRootPathInput,
    "global write authority storage root"
  );
  if (authorityContext.getStore() === storageRootPath) {
    return await action();
  }
  return await withAuthorityLane(storageRootPath, async () => {
    const lock = await acquireAuthorityLock(
      path.join(storageRootPath, GLOBAL_WRITE_AUTHORITY_LOCK_FILE),
      {
        version: LOCK_VERSION,
        pid: process.pid,
        token: randomUUID(),
        createdAt: Date.now()
      }
    );
    try {
      return await authorityContext.run(storageRootPath, action);
    } finally {
      await releaseAuthorityLock(lock);
    }
  });
}

async function acquireAuthorityLock(
  lockPath: string,
  payload: GlobalWriteAuthorityLockPayload
): Promise<AcquiredGlobalWriteAuthorityLock> {
  const parentPath = path.dirname(lockPath);
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let acquired: AcquiredGlobalWriteAuthorityLock | null = null;
    try {
      const handle = await fsp.open(
        lockPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | noFollowFlag(),
        0o600
      );
      const stat = await handle.stat();
      acquired = {
        handle,
        lockPath,
        dev: Number(stat.dev),
        ino: Number(stat.ino)
      };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      await syncDurableDirectory(parentPath);
      return acquired;
    } catch (error) {
      if (acquired) await releaseAuthorityLock(acquired);
      if (!isAlreadyExists(error)) throw error;
      let owner: GlobalWriteAuthorityLockPayload;
      try {
        owner = await readAuthorityLockOwner(lockPath);
      } catch (readError) {
        if (readError instanceof LockPublicationPending) {
          await delay(10);
          continue;
        }
        throw readError;
      }
      if (isProcessAlive(owner.pid)) {
        await delay(10);
        continue;
      }
      const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fsp.rename(lockPath, quarantinePath);
        await syncDurableDirectory(parentPath);
        await fsp.rm(quarantinePath, { force: true });
        await syncDurableDirectory(parentPath);
      } catch (renameError) {
        if (!isNotFound(renameError)) throw renameError;
      }
    }
  }
  throw new GlobalWriteAuthorityError(
    "authority_locked",
    "全局写权限正被另一个存活进程持有"
  );
}

async function readAuthorityLockOwner(
  lockPath: string
): Promise<GlobalWriteAuthorityLockPayload> {
  try {
    const { content } = await readDurableRegularFile(lockPath, MAX_LOCK_BYTES);
    const parsed = JSON.parse(content.toString("utf8")) as unknown;
    if (!isPlainRecord(parsed)) throw new Error("lock 不是对象");
    assertExactKeys(parsed, ["version", "pid", "token", "createdAt"]);
    if (
      parsed.version !== LOCK_VERSION
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.token !== "string"
      || !LOCK_TOKEN_PATTERN.test(parsed.token)
      || !Number.isSafeInteger(parsed.createdAt)
      || Number(parsed.createdAt) < 0
    ) {
      throw new Error("lock 字段非法");
    }
    return {
      version: LOCK_VERSION,
      pid: Number(parsed.pid),
      token: parsed.token,
      createdAt: Number(parsed.createdAt)
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        version: LOCK_VERSION,
        pid: -1,
        token: randomUUID(),
        createdAt: 0
      };
    }
    const stat = await durableLstatOrNull(lockPath).catch(() => null);
    const publicationAge = stat
      ? Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs)
      : Number.POSITIVE_INFINITY;
    if (
      stat
      && !stat.isSymbolicLink()
      && stat.isFile()
      && publicationAge >= -LOCK_PUBLICATION_GRACE_MS
      && publicationAge <= LOCK_PUBLICATION_GRACE_MS
    ) {
      throw new LockPublicationPending();
    }
    throw new GlobalWriteAuthorityError(
      "authority_corrupt",
      `全局写权限 lock 损坏，拒绝自动删除：${errorMessage(error)}`
    );
  }
}

async function releaseAuthorityLock(
  lock: AcquiredGlobalWriteAuthorityLock
): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const stat = await durableLstatOrNull(lock.lockPath);
  if (
    stat
    && !stat.isSymbolicLink()
    && stat.isFile()
    && Number(stat.dev) === lock.dev
    && Number(stat.ino) === lock.ino
  ) {
    await fsp.rm(lock.lockPath, { force: true });
    await syncDurableDirectory(path.dirname(lock.lockPath));
  }
}

async function withAuthorityLane<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = authorityTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  authorityTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (authorityTails.get(key) === tail) authorityTails.delete(key);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("lock 字段集合非法");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "missing";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await delayTimer(milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
