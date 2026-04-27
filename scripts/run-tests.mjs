import esbuild from "esbuild";
import { spawnSync } from "child_process";
import fs from "fs";

fs.mkdirSync(".tmp", { recursive: true });

await esbuild.build({
  entryPoints: ["src/tests/run-tests.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: ".tmp/run-tests.mjs",
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [".tmp/run-tests.mjs"], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
