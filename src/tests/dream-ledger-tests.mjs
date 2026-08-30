import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "dream-ledger-tests.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runDreamLedgerScenarios } from "./src/tests/dream-ledger";',
      "await runDreamLedgerScenarios();"
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "dream-ledger-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
