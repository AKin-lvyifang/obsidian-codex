import esbuild from "esbuild";
import fs from "node:fs";
import process from "process";

const isProd = process.argv[2] === "production";
const isWatch = process.argv[2] === "watch";

const PI_HTTP_DISPATCHER_MODULE =
  "/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js";
const PI_DEFAULT_HTTP_TRANSPORT_DISABLED =
  "EchoInk disables Pi default undici transport; controlled provider egress is required.";

/**
 * Pi 0.82.1's SDK entry imports undici@8.5.0 through SettingsManager even when
 * its CLI HTTP dispatcher is never configured. Obsidian 1.13.4 embeds Node
 * 20.14, while that undici build requires Node >=22.19 and throws during
 * module evaluation. EchoInk never uses Pi's default dispatcher: Provider
 * traffic is admitted and streamed by the controlled EchoInk transport.
 *
 * Replace only that exact dormant Pi import with a fail-closed module. If a
 * future code path tries to enable Pi's default HTTP transport, it throws
 * instead of escaping the EchoInk Egress boundary.
 */
const piControlledEgressPlugin = {
  name: "echoink-pi-controlled-egress",
  setup(build) {
    build.onResolve({ filter: /^undici$/ }, (args) => {
      const importer = args.importer.replaceAll("\\", "/");
      if (!importer.endsWith(PI_HTTP_DISPATCHER_MODULE)) return undefined;
      return {
        path: "pi-default-http-transport-disabled",
        namespace: "echoink-pi-controlled-egress",
        sideEffects: false
      };
    });
    build.onLoad(
      {
        filter: /.*/,
        namespace: "echoink-pi-controlled-egress"
      },
      () => ({
        loader: "js",
        contents: `
const fail = () => {
  throw new Error(${JSON.stringify(PI_DEFAULT_HTTP_TRANSPORT_DISABLED)});
};
export class Client { constructor() { fail(); } }
export class Pool { constructor() { fail(); } }
export class EnvHttpProxyAgent { constructor() { fail(); } }
export const setGlobalDispatcher = fail;
export const getGlobalDispatcher = fail;
export const install = fail;
`
      })
    );
  }
};

/**
 * pi-ai checks credential files for its bundled Providers through two dynamic
 * `import("node:...")` helpers. Obsidian's renderer supports Node builtins
 * through the plugin CommonJS `require`, but rejects that dynamic ESM request
 * from its `app://` origin before pi-ai can handle a missing credential. Keep
 * the upstream helpers' asynchronous contracts while routing only their Node
 * builtin lookups through the supported Obsidian bridge.
 */
const piRendererNodeImportShimPlugin = {
  name: "echoink-pi-renderer-node-import-shim",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/](?:auth[\\/]context|env-api-keys)\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const rewrittenAuthContext = source.replace(
          "importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));",
          "importNodeModule = (specifier) => Promise.resolve(require(__rewriteRelativeImportExtension(specifier)));"
        );
        const rewritten = rewrittenAuthContext.replace(
          "const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));",
          "const dynamicImport = (specifier) => Promise.resolve(require(__rewriteRelativeImportExtension(specifier)));"
        );
        if (rewritten === source) {
          throw new Error(
            `Pi dynamic Node import helper changed: ${args.path}`
          );
        }
        return { loader: "js", contents: rewritten };
      }
    );
  }
};

const context = await esbuild.context({
  banner: {
    js: "/* Codex for Obsidian */"
  },
  // Pi publishes one ESM entry for its SDK and dormant CLI/TUI utilities.
  // Obsidian loads a CJS bundle, so preserve a deterministic module URL for
  // those ESM helpers; controlled Chat never uses their package-relative CLI
  // resources, extensions, clipboard, or image workers.
  define: {
    "import.meta.url": JSON.stringify(
      "file:///__echoink_pi_runtime__/main.js"
    )
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "os",
    "path",
    "readline",
    "node:*",
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
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: isProd ? false : "inline",
  treeShaking: true,
  plugins: [
    piControlledEgressPlugin,
    piRendererNodeImportShimPlugin
  ],
  outfile: "dist/main.js"
});

if (isWatch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
