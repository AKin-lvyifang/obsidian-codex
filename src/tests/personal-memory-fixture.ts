import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PersonalMemoryRepository,
  type PersonalMemoryRuntimeContext
} from "../harness/memory/personal-memory-repository";

export interface PersonalMemoryFixture {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly repository: PersonalMemoryRepository;
  readonly now: () => number;
  runtime(input?: Partial<PersonalMemoryRuntimeContext>): PersonalMemoryRuntimeContext;
  reopen(): Promise<PersonalMemoryRepository>;
}

export async function withPersonalMemoryFixture<T>(
  callback: (fixture: Readonly<PersonalMemoryFixture>) => Promise<T>
): Promise<T> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-personal-memory-"));
  const vaultId = `vault-${path.basename(vaultPath)}`;
  let timestamp = 1_800_000_000_000;
  let identifier = 0;
  const now = () => ++timestamp;
  const createRepository = () => new PersonalMemoryRepository({
    vaultPath,
    vaultId,
    now,
    idFactory: () => `mem_fixture_${++identifier}`
  });
  const repository = createRepository();
  await repository.initialize();
  const fixture: PersonalMemoryFixture = {
    vaultPath,
    vaultId,
    repository,
    now,
    runtime: (input = {}) => ({
      vaultId,
      conversationId: "conversation-fixture",
      piSessionId: "pi-session-fixture",
      productRunId: "product-run-fixture",
      userEntryId: "user-entry-fixture",
      memoryMode: "normal",
      learningEnabled: true,
      ...input
    }),
    reopen: async () => {
      const reopened = createRepository();
      await reopened.initialize();
      return reopened;
    }
  };
  try {
    return await callback(fixture);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
