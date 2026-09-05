import type { CognitiveSystem } from "../../harness/memory/cognitive-system";
import type { PersonalMemoryKind } from "../../harness/memory/personal-memory-contracts";

const SAMPLES: readonly [PersonalMemoryKind, string, string][] = [
  ["fact", "Demo project", "The fictional Lantern project is a small offline reading notebook."],
  ["view", "Demo evaluation preference", "For this synthetic test, clear evidence is more useful than a long answer."],
  ["decision", "Demo local storage decision", "The fictional Lantern team chose local Markdown for its first prototype."],
  ["goal", "Demo reading goal", "The fictional Lantern project aims to connect three sample reading notes."],
  ["task", "Demo prototype task", "The fictional Lantern team needs to check the sample note search."],
  ["open_loop", "Demo open question", "The fictional Lantern team has not yet decided how to label reading themes."],
  ["episode", "Demo prototype review", "In a fictional review, the Lantern team found one sample note through search and recorded the result."]
];

/** Explicit local developer action. It does not create a conversation or use an LLM. */
export async function seedDeveloperMemories(system: CognitiveSystem): Promise<{
  created: number; existing: number;
}> {
  const repository = system.repository;
  const vaultId = await repository.readVaultId();
  let created = 0;
  let existing = 0;
  const ids: string[] = [];
  for (const [kind, title, text] of SAMPLES) {
    const result = await repository.write({
      operation: "create", kind,
      title: `[Developer sample] ${title}`,
      content: `[Synthetic developer test data; not a real user statement or experience.] ${text}`,
      recallWhen: "When testing EchoInk developer sample memory and the fictional Lantern project.",
      basis: "explicit",
      contentOrigin: "hypothesis",
      scope: "echoink-developer-synthetic-v1"
    }, {
      vaultId,
      conversationId: "developer-synthetic-v1",
      piSessionId: "developer-synthetic-v1",
      productRunId: "developer-synthetic-v1",
      userEntryId: `sample-${kind}`,
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    if (result.status) existing += 1;
    else created += 1;
    if (result.record) ids.push(result.record.id);
  }
  await system.settleDreamEnqueue();
  // Retry a failed queue write as well as a failed seed; report persistence errors.
  const state = await system.dreamStateStore.read();
  await system.enqueueForDream(ids.filter((id) => !state.processedMemorySources.some((source) => source.memoryId === id)));
  return { created, existing };
}
