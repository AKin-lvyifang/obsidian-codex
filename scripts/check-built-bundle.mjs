/**
 * Post-build gate for the EchoInk Obsidian bundle.
 *
 * Guards three Obsidian community-review requirements that a plain `npm run
 * build` cannot express:
 *
 *   1. `dist/main.js` must stay below the 5 MiB limit that the Obsidian Sync
 *      Standard plan can synchronize (5 * 1024 * 1024 bytes).
 *   2. The bundle must not contain Pi CLI / self-update / tool-download code
 *      (ZIP extraction, `Expand-Archive`, `windows-self-update`, the fd/rg
 *      downloader). EchoInk ships a narrowed Pi runtime; see esbuild.config.mjs.
 *   3. `dist/main.js` must complete module evaluation under Node with the
 *      browser-side externals stubbed — a top-level `ReferenceError` or similar
 *      from a shim would otherwise pass typecheck/build yet crash the plugin on
 *      startup.
 *
 * It intentionally does NOT flag the generic strings `main.js`, `manifest.json`,
 * `fs`, or `child_process` — the plugin entry is legitimately named `main.js`,
 * and Memory/Resource state contains a legitimate `manifest.json`.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const DIST_MAIN_JS = path.join(process.cwd(), "dist", "main.js");

/** Official Obsidian Sync Standard syncable size cap (5 MiB). */
const OFFICIAL_LIMIT_BYTES = 5 * 1024 * 1024; // 5,242,880
/** Internal target ceiling (4.5 MiB); reported, never used to relax the cap. */
const TARGET_LIMIT_BYTES = 4.5 * 1024 * 1024; // 4,718,592

/**
 * Definitive violation markers. These name the actual ZIP / self-update /
 * tool-download machinery, not the `// node_modules/...` module-boundary
 * comments esbuild emits for every bundled module, and not unrelated strings
 * such as `Failed to extract accountId from token`.
 */
const VIOLATION_MARKERS = [
  "extractZipArchive",
  "Expand-Archive",
  "windows-self-update",
  "downloadTool",
  "Downloading... fd",
  "Downloading... ripgrep"
];

/** Browser-side modules the production bundle keeps external. */
const EXTERNAL_MODULES = [
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
];

const failures = [];

function checkSize() {
  if (!existsSync(DIST_MAIN_JS)) {
    failures.push(`missing bundle: ${DIST_MAIN_JS}`);
    return;
  }
  const bytes = readFileSync(DIST_MAIN_JS).length;
  const sizeMiB = (bytes / 1024 / 1024).toFixed(2);

  console.log(`dist/main.js: ${bytes} bytes (${sizeMiB} MiB)`);

  if (bytes >= OFFICIAL_LIMIT_BYTES) {
    failures.push(
      `dist/main.js is ${bytes} bytes (${sizeMiB} MiB), which exceeds the `
        + `5 MiB Obsidian Sync Standard limit (${OFFICIAL_LIMIT_BYTES} bytes).`
    );
  } else if (bytes > TARGET_LIMIT_BYTES) {
    console.log(
      `note: above the ${TARGET_LIMIT_BYTES}-byte internal target but below `
        + "the official 5 MiB limit."
    );
  }
}

function checkMarkers() {
  if (!existsSync(DIST_MAIN_JS)) return;
  const contents = readFileSync(DIST_MAIN_JS, "utf8");
  for (const marker of VIOLATION_MARKERS) {
    if (contents.includes(marker)) {
      failures.push(`forbidden marker present in bundle: ${marker}`);
    }
  }
}

/**
 * Evaluate the CJS bundle in a throwaway module graph. The bundle is built with
 * `platform: "node"` and keeps Obsidian/Electron/CodeMirror/Lezer external, so
 * stub those with a Proxy module whose every named export is an empty class
 * (the plugin only extends/references them at runtime, not at module load).
 * This is the cheapest reliable way to catch a shim that throws during module
 * evaluation while typecheck and build both pass.
 */
function checkLoad() {
  if (!existsSync(DIST_MAIN_JS)) return;

  const require = createRequire(import.meta.url);
  const proxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return proxy;
      return class {};
    }
  });

  const originalLoad = Module._load;
  const externalSet = new Set(EXTERNAL_MODULES);
  Module._load = function (request, parent, isMain) {
    if (externalSet.has(request)) return proxy;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    require(DIST_MAIN_JS);
    console.log("bundle module load: OK");
  } catch (error) {
    failures.push(
      `dist/main.js threw during module load: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    Module._load = originalLoad;
  }
}

checkSize();
checkMarkers();
checkLoad();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-built-bundle: ${failure}`);
  }
  process.exit(1);
}

console.log("check-built-bundle: OK");
