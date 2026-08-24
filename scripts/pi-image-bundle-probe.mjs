import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = path.join(
  rootDir,
  ".tmp",
  "pi-image-production-bundle-probe.cjs"
);

const build = spawnSync(
  process.execPath,
  ["esbuild.config.mjs", "pi-image-bundle-probe"],
  { cwd: rootDir, stdio: "inherit" }
);
if (build.status !== 0) process.exit(build.status ?? 1);

const externalModules = new Set([
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr"
]);
const bundledOnlyModulePrefixes = [
  "@earendil-works/pi-coding-agent",
  "@silvia-odwyer/photon-node"
];
const proxy = new Proxy({}, {
  get(_target, property) {
    if (property === "__esModule") return true;
    if (property === "default") return proxy;
    return class {};
  }
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (bundledOnlyModulePrefixes.some((prefix) =>
    request === prefix || request.startsWith(`${prefix}/`)
  )) {
    throw new Error(`Pi image bundle escaped to external module: ${request}`);
  }
  if (externalModules.has(request)) return proxy;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const require = createRequire(import.meta.url);
  const bundle = require(bundlePath);
  const result = await bundle.runPiImageProductionBundleProbe();
  console.log(
    `Pi image production bundle probe: OK `
      + `(resize=${result.originalSize}->${result.resizedSize} `
      + `${result.resizedMimeType}, convert=${result.convertedMimeType})`
  );
} finally {
  Module._load = originalLoad;
}
