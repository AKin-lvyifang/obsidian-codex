import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "personal-memory-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import assert from "node:assert/strict";',
      'import { withPersonalMemoryFixture } from "./src/tests/personal-memory-fixture";',
      'import { runMemoryRecallHarnessContractScenarios } from "./src/tests/memory-recall-harness";',
      'import { runPersonalMemoryToolContractScenarios } from "./src/tests/personal-memory-tools";',
      'import { runPersonalMemoryCorrectionTests } from "./src/tests/personal-memory-correction";',
      'import { runCognitiveSystemScenarios } from "./src/tests/cognitive-system";',
      'import { buildEchoInkSystemConstitutionPrompt, buildPersonalMemorySystemPrompt } from "./src/harness/memory/personal-memory-contracts";',
      "await runMemoryRecallHarnessContractScenarios();",
      "await runPersonalMemoryToolContractScenarios();",
      "await runPersonalMemoryCorrectionTests();",
      "await runCognitiveSystemScenarios();",
      "await withPersonalMemoryFixture(async (fixture) => {",
      "  const fixed = await fixture.repository.loadFixedContext({ memoryMode: 'normal' });",
      "  assert.ok(fixed.agent && fixed.user && fixed.memory);",
      "  assert.match(fixture.repository.layout.agent, /AGENT\\.md$/u);",
      "  assert.match(fixture.repository.layout.user, /USER\\.md$/u);",
      "  assert.match(fixture.repository.layout.memory, /MEMORY\\.md$/u);",
      "  const files = await fixture.repository.listManagedFiles();",
      "  for (const kind of ['facts', 'views', 'decisions', 'active', 'episodes']) {",
      "    assert.ok(files.some((file) => file.includes('/' + kind + '/')) || files.every((file) => !file.includes('/records/')));",
      "  }",
      "});",
      "assert.match(buildEchoInkSystemConstitutionPrompt(), /真实高于迎合/u);",
      "assert.match(buildPersonalMemorySystemPrompt(), /memory_search/u);",
      'console.log("Current file-based Personal Memory acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "personal-memory-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: {
    ".md": "text",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  plugins: [{
    name: "personal-memory-obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: {
    ...process.env,
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
