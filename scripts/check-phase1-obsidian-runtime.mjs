import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = path.join(rootDir, "dist", "main.js");
const bundle = await readFile(bundlePath, "utf8");

assert.match(
  bundle,
  /EchoInk disables Pi default undici transport/,
  "production bundle must keep the fail-closed Pi HTTP transport boundary"
);
assert.doesNotMatch(
  bundle,
  /@earendil-works\/pi-coding-agent\/node_modules\/undici/,
  "production bundle must not evaluate Pi's Node 22-only undici dependency"
);
assert.doesNotMatch(
  bundle,
  /require\(["']node:sqlite["']\)/,
  "production bundle must not load node:sqlite on Obsidian Node 20"
);
assert.doesNotMatch(
  bundle,
  /Promise\.withResolvers\s*\(/,
  "production bundle must not call Node 22-only Promise.withResolvers"
);

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let shim;
shim = new Proxy(function shimmedObsidianModule() {
  return shim;
}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive) return () => "";
    if (property === "then") return undefined;
    if (property === "prototype") return {};
    return shim;
  },
  apply() {
    return shim;
  },
  construct() {
    return shim;
  }
});

Module._load = function echoInkNode20Probe(request, parent, isMain) {
  if (request === "node:sqlite") {
    throw new Error("node:sqlite is unavailable in the Obsidian Node runtime");
  }
  if (
    request === "obsidian"
    || request === "electron"
    || request.startsWith("@codemirror/")
    || request.startsWith("@lezer/")
  ) {
    return shim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const loaded = require(bundlePath);
  assert.equal(typeof loaded, "object");
} finally {
  Module._load = originalLoad;
}

console.log(`Phase 1 Obsidian runtime bundle: ok (${process.version})`);
