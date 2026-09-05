import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".tmp", "developer-mode-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
try {
  await esbuild.build({
    entryPoints: ["src/tests/developer-mode.ts"], absWorkingDir: root,
    bundle: true, platform: "node", target: "node22", format: "esm",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
    plugins: [{ name: "obsidian-fixture", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    } }], outfile: output, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], {
    cwd: root, env: { ...process.env, PI_OFFLINE: "1", ECHOINK_DISABLE_ACP: "1" }, stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { force: true }); }
