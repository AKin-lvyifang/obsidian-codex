import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  KnowledgeAgentIndex,
  KnowledgeAgentIndexError,
  formatKnowledgeRawSourceMarker
} from "../knowledge-base/knowledge-agent-index";
import { KnowledgeRetriever } from "../knowledge-base/query";
import { isRawMarkdownPath } from "../knowledge-base/raw-digest";

export async function runKnowledgeAgentIndexTests(): Promise<void> {
  assertRawMarkdownExtensionContract();
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-knowledge-index-vault-"));
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-knowledge-index-state-"));
  try {
    const rawText = [
      "# Raw Source",
      "RAW_ORIGIN_TOKEN",
      "PRIVATE_FULL_BODY_SENTENCE must never be copied into the derived index.",
      ""
    ].join("\n");
    await writeFixture(vaultPath, "raw/source.md", rawText);
    await writeFixture(
      vaultPath,
      "wiki/source-chain.md",
      [
        "# Derived Knowledge",
        "SOURCE_CHAIN_TOKEN",
        "来源：[[raw/source.md|原始材料]]",
        formatKnowledgeRawSourceMarker("raw/source.md", revision(rawText)),
        ""
      ].join("\n")
    );
    await writeFixture(
      vaultPath,
      "projects/active.md",
      "# Active Project\nPROJECT_SCOPE_TOKEN\n"
    );
    for (let index = 1; index <= 100; index += 1) {
      await writeFixture(
        vaultPath,
        `wiki/deep-${String(index).padStart(3, "0")}.md`,
        `# Deep ${index}\nCOMMON_DEEP_TOKEN item ${index}\n`
      );
    }
    await writeFixture(vaultPath, "journal/ignored.md", "COMMON_DEEP_TOKEN\n");
    await writeFixture(vaultPath, "notes/ignored.md", "COMMON_DEEP_TOKEN\n");

    const beforeVault = await snapshotTree(vaultPath);
    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath });
    const firstRefresh = await index.refresh();
    assert.equal(firstRefresh.entries, 103);
    assert.equal(firstRefresh.indexed, 103);
    assert.equal(firstRefresh.reused, 0);
    assert.ok(firstRefresh.changedPaths.includes("wiki/source-chain.md"));
    assert.ok(firstRefresh.changedPaths.includes("projects/active.md"));
    assert.ok(firstRefresh.changedPaths.includes("raw/source.md"));

    const secondRefresh = await index.refresh();
    assert.equal(secondRefresh.generation, firstRefresh.generation);
    assert.equal(secondRefresh.indexed, 0);
    assert.equal(secondRefresh.reused, 103);

    const visited: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await index.search({
        query: "COMMON_DEEP_TOKEN",
        limit: 8,
        ...(cursor ? { cursor } : {})
      });
      pageCount += 1;
      assert.equal(page.total, 100);
      assert.equal(page.returned, page.hits.length);
      assert.equal(page.exhausted, !page.hasMore);
      visited.push(...page.hits.map((hit) => hit.vaultRelativePath));
      cursor = page.continuationCursor;
    } while (cursor);
    assert.equal(pageCount, 13);
    assert.equal(visited[8], "wiki/deep-009.md");
    assert.equal(visited[36], "wiki/deep-037.md");
    assert.equal(visited[87], "wiki/deep-088.md");
    assert.equal(new Set(visited).size, 100);

    const project = await index.search({ query: "PROJECT_SCOPE_TOKEN", limit: 5 });
    assert.deepEqual(project.hits.map((hit) => hit.kind), ["projects"]);
    const raw = await index.search({ query: "RAW_ORIGIN_TOKEN", limit: 5 });
    assert.deepEqual(raw.hits.map((hit) => hit.kind), ["raw"]);
    const rawEntry = raw.hits[0];
    assert.ok(rawEntry);
    const rawRead = await index.read({
      vaultRelativePath: rawEntry.vaultRelativePath,
      expectedContentRevision: rawEntry.contentRevision
    });
    assert.match(rawRead.content, /RAW_ORIGIN_TOKEN/u);

    const retriever = new KnowledgeRetriever(vaultPath, { agentIndex: index });
    const noEvidence = await retriever.retrieve({
      question: "TOKEN_THAT_DOES_NOT_EXIST"
    });
    assert.equal(noEvidence.status, "no_evidence");
    assert.equal(noEvidence.shouldInvokePi, true);
    assert.equal(noEvidence.total, 0);
    const retrieved = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      limit: 8
    });
    assert.equal(retrieved.status, "ready");
    assert.equal(retrieved.total, 100);
    assert.equal(retrieved.returned, 8);
    assert.equal(retrieved.hasMore, true);
    assert.equal(retrieved.exhausted, false);
    assert.ok(retrieved.continuationCursor);
    const retrievedNext = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      limit: 8,
      cursor: retrieved.continuationCursor
    });
    assert.equal(retrievedNext.status, "ready");
    assert.equal(retrievedNext.references[0]?.vaultRelativePath, "wiki/deep-009.md");

    const explicitFirst = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      explicitPaths: ["wiki/deep-001.md"],
      limit: 8
    });
    assert.equal(explicitFirst.status, "ready");
    assert.equal(explicitFirst.total, 100);
    assert.equal(explicitFirst.returned, 8);
    assert.equal(explicitFirst.references[0]?.vaultRelativePath, "wiki/deep-001.md");
    assert.ok(explicitFirst.continuationCursor);
    const explicitNext = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      explicitPaths: ["wiki/deep-001.md"],
      limit: 8,
      cursor: explicitFirst.continuationCursor
    });
    assert.equal(explicitNext.status, "ready");
    assert.equal(explicitNext.total, 100);
    assert.equal(explicitNext.returned, 8);
    assert.ok(explicitNext.references.every(
      (reference) => reference.vaultRelativePath !== "wiki/deep-001.md"
    ));
    const explicitPathOnly = await retriever.retrieve({
      question: "wiki/deep-001.md",
      explicitPaths: ["wiki/deep-001.md"],
      limit: 8
    });
    assert.equal(explicitPathOnly.status, "ready");
    assert.equal(explicitPathOnly.total, 1);
    assert.deepEqual(
      explicitPathOnly.references.map((reference) =>
        reference.vaultRelativePath
      ),
      ["wiki/deep-001.md"]
    );

    const explicitOnlyPage = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      explicitPaths: ["wiki/deep-001.md"],
      limit: 1
    });
    assert.equal(explicitOnlyPage.status, "ready");
    assert.equal(explicitOnlyPage.total, 100);
    assert.deepEqual(
      explicitOnlyPage.references.map((reference) => reference.vaultRelativePath),
      ["wiki/deep-001.md"]
    );
    assert.ok(explicitOnlyPage.continuationCursor);
    const afterExplicitOnlyPage = await retriever.retrieve({
      question: "COMMON_DEEP_TOKEN",
      explicitPaths: ["wiki/deep-001.md"],
      limit: 1,
      cursor: explicitOnlyPage.continuationCursor
    });
    assert.equal(afterExplicitOnlyPage.status, "ready");
    assert.equal(afterExplicitOnlyPage.total, 100);
    assert.equal(
      afterExplicitOnlyPage.references[0]?.vaultRelativePath,
      "wiki/deep-002.md"
    );

    const source = await index.search({ query: "SOURCE_CHAIN_TOKEN", limit: 5 });
    assert.equal(source.hits.length, 1);
    assert.deepEqual(source.hits[0]?.rawSources, [{
      vaultRelativePath: "raw/source.md",
      contentRevision: revision(rawText),
      status: "available"
    }]);
    const reliable = await index.readReliableKnowledgeForRaw("raw/source.md");
    assert.equal(reliable?.rawContentRevision, revision(rawText));
    assert.deepEqual(reliable?.entries.map((entry) => ({
      path: entry.vaultRelativePath,
      title: entry.title
    })), [{
      path: "wiki/source-chain.md",
      title: "Derived Knowledge"
    }]);
    assert.match(reliable?.entries[0]?.content ?? "", /SOURCE_CHAIN_TOKEN/u);

    const firstPage = await index.search({ query: "COMMON_DEEP_TOKEN", limit: 8 });
    assert.ok(firstPage.continuationCursor);
    const changedRawText = `${rawText}changed\n`;
    await writeFixture(vaultPath, "raw/source.md", changedRawText);
    const changedRefresh = await index.refresh();
    assert.notEqual(changedRefresh.generation, firstRefresh.generation);
    await assert.rejects(
      index.read({
        vaultRelativePath: rawEntry.vaultRelativePath,
        expectedContentRevision: rawEntry.contentRevision
      }),
      (error) => error instanceof KnowledgeAgentIndexError
        && error.code === "source_changed"
    );
    const originalSearch = index.search.bind(index);
    index.search = async () => raw;
    try {
      await assert.rejects(
        retriever.retrieve({ question: "RAW_ORIGIN_TOKEN", limit: 5 }),
        (error) => error instanceof Error
          && "code" in error
          && error.code === "source-changed"
      );
    } finally {
      index.search = originalSearch;
    }
    await assert.rejects(
      index.search({
        query: "COMMON_DEEP_TOKEN",
        limit: 8,
        cursor: firstPage.continuationCursor
      }),
      (error) => error instanceof KnowledgeAgentIndexError
        && error.code === "cursor_stale"
    );
    const changedSource = await index.search({ query: "SOURCE_CHAIN_TOKEN", limit: 5 });
    assert.deepEqual(changedSource.hits[0]?.rawSources, [{
      vaultRelativePath: "raw/source.md",
      contentRevision: revision(rawText),
      currentContentRevision: revision(changedRawText),
      status: "changed"
    }]);
    assert.equal(
      await index.readReliableKnowledgeForRaw("raw/source.md"),
      null,
      "changed Raw must never reuse stale derived knowledge"
    );

    await rm(path.join(storageRootPath, "index-v1.json"), { force: true });
    const rebuilt = new KnowledgeAgentIndex({ vaultPath, storageRootPath });
    await rebuilt.refresh();
    const rebuiltSource = await rebuilt.search({
      query: "SOURCE_CHAIN_TOKEN",
      limit: 5
    });
    assert.deepEqual(rebuiltSource.hits[0]?.rawSources, [{
      vaultRelativePath: "raw/source.md",
      contentRevision: revision(rawText),
      currentContentRevision: revision(changedRawText),
      status: "changed"
    }]);

    assert.deepEqual(await snapshotTree(vaultPath), beforeVault.map((entry) =>
      entry.path === "raw/source.md"
        ? { ...entry, revision: revision(changedRawText).slice("sha256:".length) }
        : entry
    ));
    const persisted = await readFile(
      path.join(storageRootPath, "index-v1.json"),
      "utf8"
    );
    assert.doesNotMatch(persisted, /PRIVATE_FULL_BODY_SENTENCE/iu);
    assert.match(persisted, /wiki\/source-chain\.md/u);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

function assertRawMarkdownExtensionContract(): void {
  assert.equal(isRawMarkdownPath("raw/source.md"), true);
  assert.equal(isRawMarkdownPath("raw/source.markdown"), true);
  assert.equal(isRawMarkdownPath("raw/source.mdown"), false);
}

async function writeFixture(
  vaultPath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = path.join(vaultPath, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function snapshotTree(vaultPath: string): Promise<Array<{
  path: string;
  kind: "directory" | "file";
  revision?: string;
}>> {
  const result: Array<{
    path: string;
    kind: "directory" | "file";
    revision?: string;
  }> = [];
  const walk = async (directoryPath: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(vaultPath, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        result.push({ path: relativePath, kind: "directory" });
        await walk(absolutePath);
      } else if (entry.isFile()) {
        result.push({
          path: relativePath,
          kind: "file",
          revision: createHash("sha256").update(await readFile(absolutePath)).digest("hex")
        });
      }
    }
  };
  await walk(vaultPath);
  return result;
}

function revision(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
