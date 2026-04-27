import esbuild from "esbuild";
import process from "process";

const isProd = process.argv[2] === "production";
const isWatch = process.argv[2] === "watch";

const context = await esbuild.context({
  banner: {
    js: "/* Codex for Obsidian */"
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
  target: "es2022",
  logLevel: "info",
  sourcemap: isProd ? false : "inline",
  treeShaking: true,
  outfile: "dist/main.js"
});

if (isWatch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
