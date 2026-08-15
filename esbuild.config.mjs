import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
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

/**
 * Pi 0.82.1 publishes one ESM entry (`dist/index.js`) that re-exports the whole
 * CLI (main, interactive mode, package-manager CLI, clipboard, image helpers,
 * shell config) alongside the SDK. esbuild therefore bundles every dormant CLI
 * module — including the ZIP extraction / tool download installer and Windows
 * self-update code — into EchoInk's `dist/main.js`. EchoInk only needs the
 * narrow Runtime surface below, verified against the production imports in
 * `src/` (see pi-production-runtime-composition.ts, pi-local-data-service.ts
 * and the pi-native harness). Replace the entry with that surface so the CLI
 * and its download/self-update machinery are never pulled in.
 *
 * The upstream entry structure is pinned by an anchor check plus a package
 * version guard: if either drifts, the build fails and asks for a re-audit
 * instead of silently shipping an unreviewed entry.
 */
const PI_CODING_AGENT_VERSION = "0.82.1";
const piCodingAgentPackagePath = path.join(
  process.cwd(),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json"
);
const piCodingAgentInstalledVersion = JSON.parse(
  fs.readFileSync(piCodingAgentPackagePath, "utf8")
).version;
if (piCodingAgentInstalledVersion !== PI_CODING_AGENT_VERSION) {
  throw new Error(
    `@earendil-works/pi-coding-agent version changed `
      + `(${piCodingAgentInstalledVersion} !== ${PI_CODING_AGENT_VERSION}); `
      + "re-audit the EchoInk Pi runtime surface before building."
  );
}

const piRuntimeSurfacePlugin = {
  name: "echoink-pi-runtime-surface",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]index\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const requiredAnchors = [
          'export { main } from "./main.js";',
          "SessionManager",
          "createAgentSession",
          "ModelRuntime"
        ];
        for (const anchor of requiredAnchors) {
          if (!source.includes(anchor)) {
            throw new Error(
              `Pi runtime entry changed; missing anchor: ${anchor}`
            );
          }
        }
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: `
export {
  CURRENT_SESSION_VERSION,
  SessionManager,
  sessionEntryToContextMessages
} from "./core/session-manager.js";

export { ModelRuntime } from "./core/model-runtime.js";
export { SettingsManager } from "./core/settings-manager.js";

export { createAgentSession } from "./core/sdk.js";

export {
  createExtensionRuntime,
  defineTool
} from "./core/extensions/index.js";

export { createSyntheticSourceInfo } from "./core/source-info.js";

export {
  loadSkills,
  formatSkillsForPrompt
} from "./core/skills.js";

export { convertToLlm } from "./core/messages.js";
`
        };
      }
    );
  }
};

/**
 * Even after narrowing the entry, `createAgentSession` (core/sdk.js) and
 * `createExtensionRuntime` (core/extensions/index.js) statically import the
 * default Coding Tools, `DefaultResourceLoader`, the interactive theme, HTML
 * export, and jiti. EchoInk replaces every one of those code paths with its
 * own controlled equivalents (custom tools, controlled vault resource loader,
 * inline extensions, no interactive/HTML/bash/find/grep), so the modules below
 * are unreachable at runtime — yet esbuild still bundles them because the
 * imports are static.
 *
 * Replace each unreachable leaf module with a fail-closed stub (same export
 * names, throw on invocation) or, for pure-presentation helpers, an identity
 * passthrough. Each replacement is pinned by an anchor check against the
 * upstream source so a structural drift fails the build instead of silently
 * shipping a stale shim. This mirrors the existing `piControlledEgressPlugin`
 * pattern and never touches `node_modules`.
 */
const PI_LEAF_SHIM_FAIL =
  "EchoInk bundles a narrowed Pi runtime; this module is not reachable in the EchoInk configuration.";

/**
 * Generate the source of a `fail` factory for a fail-closed shim module.
 *
 * The returned string is a self-contained `const fail = ...` statement whose
 * error text is baked in as a literal (via JSON.stringify) — it must NOT
 * capture any closure variable, because the string is inlined into a virtual
 * module whose scope has none of them. `fail(name)` returns a function that
 * throws only when invoked, so `export const x = fail("x")` evaluates safely at
 * module load and fails closed on the first real call.
 */
function failFactory(label) {
  const message = `${PI_LEAF_SHIM_FAIL} ${label}`;
  return `(name) => () => {
  throw new Error(${JSON.stringify(message)} + ": " + name);
}`;
}

const piLeafModuleShimsPlugin = {
  name: "echoink-pi-leaf-module-shims",
  setup(build) {
    const shims = [
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]utils[\\/]tools-manager\.js$/,
        anchor: "extractZipArchive",
        contents: `
const fail = ${failFactory("Pi fd/rg tool downloader (tools-manager)")};
export function getToolPath(...args) { return fail("getToolPath")(...args); }
export async function ensureTool(...args) { return fail("ensureTool")(...args); }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]modes[\\/]interactive[\\/]theme[\\/]theme\.js$/,
        anchor: "Theme not initialized",
        contents: `
const fail = ${failFactory("interactive theme")};
export const theme = new Proxy({}, {
  get(_t, prop) {
    if (prop === "then" || prop === Symbol.toPrimitive) return undefined;
    return (...args) => (typeof args[0] === "string" ? args[0] : args[0]);
  }
});
export class Theme {}
export function getThemeByName() { return undefined; }
export function loadThemeFromPath() { return null; }
export function getLanguageFromPath() { return undefined; }
export function highlightCode(code) { return code; }
export const getAvailableThemes = fail("getAvailableThemes");
export const getAvailableThemesWithPaths = fail("getAvailableThemesWithPaths");
export const parseAutoThemeSetting = fail("parseAutoThemeSetting");
export const resolveThemeSetting = fail("resolveThemeSetting");
export const getThemeForRgbColor = fail("getThemeForRgbColor");
export const detectTerminalBackgroundFromEnv = fail("detectTerminalBackgroundFromEnv");
export const detectTerminalBackgroundTheme = fail("detectTerminalBackgroundTheme");
export const detectTerminalThemeForAuto = fail("detectTerminalThemeForAuto");
export const getDefaultTheme = fail("getDefaultTheme");
export const setRegisteredThemes = fail("setRegisteredThemes");
export const initTheme = fail("initTheme");
export const setTheme = fail("setTheme");
export const setThemeInstance = fail("setThemeInstance");
export const onThemeChange = fail("onThemeChange");
export const stopThemeWatcher = fail("stopThemeWatcher");
export const getResolvedThemeColors = fail("getResolvedThemeColors");
export const isLightTheme = fail("isLightTheme");
export const getThemeExportColors = fail("getThemeExportColors");
export const getMarkdownTheme = fail("getMarkdownTheme");
export const getSelectListTheme = fail("getSelectListTheme");
export const getEditorTheme = fail("getEditorTheme");
export const getSettingsListTheme = fail("getSettingsListTheme");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]utils[\\/]syntax-highlight\.js$/,
        anchor: "renderHighlightedHtml",
        contents: `
export function renderHighlightedHtml(html) { return html; }
export function highlight(code) { return code; }
export function supportsLanguage() { return false; }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]export-html[\\/]index\.js$/,
        anchor: "exportSessionToHtml",
        contents: `
const fail = ${failFactory("HTML session export")};
export const exportSessionToHtml = fail("exportSessionToHtml");
export const exportFromFile = fail("exportFromFile");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]export-html[\\/]tool-renderer\.js$/,
        anchor: "createToolHtmlRenderer",
        contents: `
const fail = ${failFactory("HTML tool renderer")};
export const createToolHtmlRenderer = fail("createToolHtmlRenderer");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]package-manager\.js$/,
        anchor: "class DefaultPackageManager",
        contents: `
const fail = ${failFactory("default package manager")};
export const getExtensionTempFolder = fail("getExtensionTempFolder");
export class DefaultPackageManager { constructor() { fail("DefaultPackageManager")(); } }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]utils[\\/]photon\.js$/,
        anchor: "loadPhoton",
        contents: `
// EchoInk never processes images through Pi's default read tool, so the
// Photon WASM image backend is unreachable. Return null so the existing
// "image processing unavailable" path in image-convert/image-resize runs
// unchanged, and the native binding is never bundled.
export async function loadPhoton() { return null; }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]providers[\\/]all\.js$/,
        anchor: "getBuiltinModelDataGeneratedAt",
        contents: `
// EchoInk registers its own native provider and never streams through Pi's
// built-in provider catalog. Return an empty catalog so the built-in provider
// implementations (OpenAI/Anthropic/Mistral/Google API modules) and their model
// metadata are never bundled. Every export keeps the upstream return-type
// contract (arrays for provider/model lists, real empty Models/ImagesModels
// collections for the collection factories) so callers like compatModels
// never see a bare object. radiusProvider is unreachable because EchoInk loads
// no models.json radius config; fail closed if it is ever requested.
import { createModels } from "../models.js";
import { createImagesModels } from "../images-models.js";

const fail = ${failFactory("built-in provider catalog")};
export function getBuiltinModel() { return undefined; }
export function getBuiltinProviders() { return []; }
export function getBuiltinModelDataGeneratedAt() { return undefined; }
export function getBuiltinModels() { return []; }
export function builtinProviders() { return []; }
export function builtinModels(options) { return createModels(options); }
export function builtinImagesProviders() { return []; }
export function builtinImagesModels(options) { return createImagesModels(options); }
export function radiusProvider() { return fail("radiusProvider")(); }
`
      }
    ];

    for (const shim of shims) {
      build.onLoad({ filter: shim.filter }, async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        if (!source.includes(shim.anchor)) {
          throw new Error(
            `Pi module changed (${shim.filter}); missing anchor: ${shim.anchor}`
          );
        }
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: shim.contents
        };
      });
    }

    // jiti is pulled only by core/extensions/loader.js to compile TypeScript
    // extension files loaded from disk. EchoInk registers inline extensions
    // and never loads extension files, so the 2.3 MB jiti/babel dependency is
    // unreachable; fail closed if a future path tries to use it.
    build.onResolve({ filter: /^jiti\/static$/ }, () => ({
      path: "jiti-static",
      namespace: "echoink-pi-jiti-shim",
      sideEffects: false
    }));
    build.onLoad(
      { filter: /.*/, namespace: "echoink-pi-jiti-shim" },
      () => ({
        loader: "js",
        contents: `
const fail = ${failFactory("jiti TypeScript extension loader")};
export function createJiti(...args) { return fail("createJiti")(...args); }
`
      })
    );
  }
};

/**
 * Pi's built-in provider SDKs (Google GenAI, OpenAI, Anthropic, Mistral) are
 * only reached through `lazyApi(() => import(...))` — a dynamic import that
 * runs on the first stream through that provider. EchoInk never streams
 * through the built-in providers: it registers its own native provider
 * (createPiNativeControlledProvider) and uses the controlled EchoInk transport.
 * Replace each SDK package with a fail-closed stub so their multi-megabyte
 * transitive graphs (web-streams, OpenTelemetry, google-auth, node-fetch, ws,
 * yaml, bignumber) are never bundled or executed.
 */
const PI_PROVIDER_SDK_SHIMS = {
  "@google/genai": `
const fail = ${failFactory("Google GenAI provider SDK")};
export class GoogleGenAI { constructor(...args) { fail("GoogleGenAI")(...args); } }
export const FinishReason = new Proxy({}, { get: (_t, p) => p });
export const FunctionCallingConfigMode = new Proxy({}, { get: (_t, p) => p });
export const ResourceScope = new Proxy({}, { get: (_t, p) => p });
export const ThinkingLevel = new Proxy({}, { get: (_t, p) => p });
export default GoogleGenAI;
`,
  openai: `
const fail = ${failFactory("OpenAI provider SDK")};
export class OpenAI { constructor(...args) { fail("OpenAI")(...args); } }
export class AzureOpenAI { constructor(...args) { fail("AzureOpenAI")(...args); } }
export default OpenAI;
`,
  "@anthropic-ai/sdk": `
const fail = ${failFactory("Anthropic provider SDK")};
export class Anthropic { constructor(...args) { fail("Anthropic")(...args); } }
export default Anthropic;
`,
  "@mistralai/mistralai": `
const fail = ${failFactory("Mistral provider SDK")};
export class Mistral { constructor(...args) { fail("Mistral")(...args); } }
export default Mistral;
`,
  "@earendil-works/pi-tui": `
const fail = ${failFactory("Pi TUI rendering")};
export class Box { constructor(...args) { fail("Box")(...args); } }
export class Container { constructor(...args) { fail("Container")(...args); } }
export class Markdown { constructor(...args) { fail("Markdown")(...args); } }
export class Spacer { constructor(...args) { fail("Spacer")(...args); } }
export class Text { constructor(...args) { fail("Text")(...args); } }
export class Image { constructor(...args) { fail("Image")(...args); } }
export class Loader { constructor(...args) { fail("Loader")(...args); } }
export class CancellableLoader { constructor(...args) { fail("CancellableLoader")(...args); } }
export class SelectList { constructor(...args) { fail("SelectList")(...args); } }
export class SettingsList { constructor(...args) { fail("SettingsList")(...args); } }
export class Input { constructor(...args) { fail("Input")(...args); } }
export class Editor { constructor(...args) { fail("Editor")(...args); } }
export class ProcessTerminal { constructor(...args) { fail("ProcessTerminal")(...args); } }
export class TUI { constructor(...args) { fail("TUI")(...args); } }
export class TruncatedText { constructor(...args) { fail("TruncatedText")(...args); } }
export class CombinedAutocompleteProvider { constructor(...args) { fail("CombinedAutocompleteProvider")(...args); } }
export class KeybindingsManager { constructor(...args) { fail("KeybindingsManager")(...args); } }
export const getCapabilities = () => ({ hyperlinks: false, images: false, ansi: false, trueColor: false });
export const getKeybindings = fail("getKeybindings");
export const setKeybindings = fail("setKeybindings");
export const fuzzyFilter = fail("fuzzyFilter");
export const fuzzyMatch = fail("fuzzyMatch");
export const matchesKey = fail("matchesKey");
export const truncateToWidth = fail("truncateToWidth");
export const visibleWidth = fail("visibleWidth");
export const wrapTextWithAnsi = fail("wrapTextWithAnsi");
export const sliceByColumn = fail("sliceByColumn");
export const hyperlink = fail("hyperlink");
export const imageFallback = fail("imageFallback");
export const getImageDimensions = fail("getImageDimensions");
export const TUI_KEYBINDINGS = Object.freeze({});
export const Key = Object.freeze({});
export default {};
`
};

const piProviderSdkShimsPlugin = {
  name: "echoink-pi-provider-sdk-shims",
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(?:@google\/genai|openai|@anthropic-ai\/sdk|@mistralai\/mistralai|@earendil-works\/pi-tui)$/
      },
      (args) => ({
        path: args.path,
        namespace: "echoink-pi-provider-sdk-shim",
        sideEffects: false
      })
    );
    build.onLoad(
      { filter: /.*/, namespace: "echoink-pi-provider-sdk-shim" },
      (args) => {
        const contents = PI_PROVIDER_SDK_SHIMS[args.path];
        if (!contents) {
          throw new Error(`Unknown provider SDK shim requested: ${args.path}`);
        }
        return { loader: "js", contents };
      }
    );
  }
};

const context = await esbuild.context({
  banner: {
    js: "/* EchoInk Agent */"
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
    piRuntimeSurfacePlugin,
    piLeafModuleShimsPlugin,
    piProviderSdkShimsPlugin,
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
