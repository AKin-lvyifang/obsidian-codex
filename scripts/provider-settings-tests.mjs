import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "provider-settings-tests.mjs");
const obsidianShimPath = path.join(
  rootDir,
  "src",
  "tests",
  "obsidian-shim.ts"
);

await mkdir(outputDir, { recursive: true });
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "native-dom") {
  const directory = path.join(outputDir, "settings-native-dom");
  await mkdir(directory, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: 'import {runSettingsNativeDomRegression} from "./src/tests/settings-native-dom"; try { runSettingsNativeDomRegression(document.querySelector("#fixture")); } catch(error) { document.querySelector("#fixture").textContent=String(error); document.querySelector("#fixture").dataset.nativeDomRegression="failed"; }',
      resolveDir: rootDir, loader: "ts"
    },
    bundle: true, format: "esm", platform: "browser",
    outfile: path.join(directory, "regression.js"), logLevel: "silent",
    plugins: [{ name: "native-dom-host-services", setup(build) {
      // Only non-DOM host services are stubbed; classList stays browser-native.
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "icons", namespace: "fixture" }));
      build.onResolve({ filter: /settings\/settings$/ }, () => ({ path: "ids", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({
        contents: name === "icons" ? "export function setIcon() {}" : "export const newId = () => crypto.randomUUID();", loader: "js"
      }));
    } }]
  });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Native settings DOM regression</title><link rel="stylesheet" href="../../styles.css"><style>:root{--font-text-size:16px;--font-interface:sans-serif;--background-primary:white;--text-normal:#333}main{width:790px;max-width:100%;margin:auto}</style><main class="echoink-settings-demo"><div id="fixture"></div><div class="codex-resource-body"><div class="codex-resource-row"><div class="codex-resource-row-content">Skill enabled</div><input class="codex-resource-toggle" type="checkbox" checked aria-label="Enabled skill"></div><div class="codex-resource-row"><div class="codex-resource-row-content">MCP disabled</div><input class="codex-resource-toggle" type="checkbox" aria-label="Disabled MCP"></div></div></main><script type="module" src="regression.js"></script>');
  console.log(`Open ${path.join(directory, "index.html")} in a real browser; #fixture[data-native-dom-regression=passed] is the result.`);
  process.exit(0);
}
await esbuild.build({
  entryPoints: ["src/tests/provider-settings-behavior.ts"],
  absWorkingDir: rootDir,
  bundle: true,
  loader: {
    ".md": "text",
    ".svg": "dataurl",
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
    name: "provider-settings-test-shims",
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
    ECHOINK_DISABLE_ACP: "1",
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
