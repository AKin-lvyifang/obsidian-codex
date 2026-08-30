import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "system-prompt-tests.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runSystemPromptContractScenarios } from "./src/tests/system-prompt-contract";',
      'import { runPersonalMemoryToolContractScenarios } from "./src/tests/personal-memory-tools";',
      "runSystemPromptContractScenarios();",
      "await runPersonalMemoryToolContractScenarios();",
      'console.log("PASS EchoInk runtime System Prompt contract");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "system-prompt-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
