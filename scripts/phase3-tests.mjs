import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "knowledge-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runPhase3KnowledgeRetrieverTests } from "./src/tests/phase3-knowledge-retriever";',
      'import { runKnowledgeAgentIndexTests } from "./src/tests/knowledge-agent-index";',
      'import { runKnowledgeMaintenancePreferenceTests } from "./src/tests/knowledge-maintenance-preferences";',
      'import { runPiKnowledgeReadToolTests } from "./src/tests/pi-native/knowledge-read-tools";',
      'import { runPhase3KnowledgeMaintenanceServiceTests } from "./src/tests/pi-native/phase3-maintenance-service";',
      'import { runKnowledgeInitializationTests } from "./src/tests/knowledge-initialization";',
      'import { runHomeWorkbenchTests } from "./src/tests/home-workbench";',
      "await runHomeWorkbenchTests();",
      "await runKnowledgeAgentIndexTests();",
      "await runKnowledgeMaintenancePreferenceTests();",
      "await runPiKnowledgeReadToolTests();",
      "await runPhase3KnowledgeRetrieverTests();",
      "await runPhase3KnowledgeMaintenanceServiceTests();",
      "await runKnowledgeInitializationTests();",
      'console.log("Current Knowledge query and maintenance acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "knowledge-test-entry.ts",
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
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  plugins: [{
    name: "knowledge-test-shims",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
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
