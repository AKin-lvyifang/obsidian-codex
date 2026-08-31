import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = path.join(rootDir, "src", "home", "magic-ui");
const stylesPath = path.join(rootDir, "styles.css");
const checkOnly = process.argv.includes("--check");
const scope = ".echoink-home-magic-ui";
const startMarker = "/* ECHOINK_HOME_MAGIC_UI_CSS_START */";
const endMarker = "/* ECHOINK_HOME_MAGIC_UI_CSS_END */";

const officialFiles = [
  ["marquee.tsx", "779f360a107409bfa35cda13bcef7d54cd620a15ab4a0ee50412442a4dd6b9c7"],
  ["bento-grid.tsx", "9c2abcb2a4e51519e56d510299771a2d0e170ab9927a9a792a58614b1837ed47"],
  ["animated-shiny-text.tsx", "3743a0a0b4894840a96bacd839e493872bac484a940684f91fd23a1784c00fbb"],
  ["utils.ts", "7c8c3dfc0cdd370d44932828eb067ef771c8fe7996693221d5d4b90af6d54f2d"],
  ["button.tsx", "881fabaf889450b7c671ffabe455bd4b4d101c36f80868f1bf4819ba5f4f4886"],
  ["provenance/marquee-demo.tsx", "7ed4e929bbf6c54b6464cea98cc29fd1b4da16f1ab4cdcc7a49e2ef98ec19536"],
  ["provenance/globals.css", "b290ad71358829d043a8453924e0b97878596294849de34ea08451412fd760f2"],
  ["LICENSE.md", "0147b84235ed916b8b4e89c1f80655351c5afe7d211b629be61f553a227b34ba"]
];

for (const [relativePath, expected] of officialFiles) {
  const content = await readFile(path.join(sourceDir, relativePath));
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expected) throw new Error(`Magic UI source hash mismatch: ${relativePath}`);
}

const upstreamCss = await readFile(path.join(sourceDir, "provenance", "globals.css"), "utf8");
const animationNames = ["marquee", "marquee-vertical", "shiny-text"];
const animationVariables = animationNames.map((name) => extractDeclaration(upstreamCss, `--animate-${name}`));
const keyframes = animationNames.map((name) => extractKeyframes(upstreamCss, name));
const inputCss = [
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
  '@source "../src/home/magic-ui/marquee.tsx";',
  '@source "../src/home/magic-ui/bento-grid.tsx";',
  '@source "../src/home/magic-ui/animated-shiny-text.tsx";',
  '@source "../src/home/magic-ui/button.tsx";',
  '@source "../src/home/home-*-island.tsx";',
  '@custom-variant dark (&:where(.theme-dark, .theme-dark *));',
  "@theme inline {",
  ...animationVariables.map((value) => `  ${value}`),
  ...keyframes.map((value) => indent(value, 2)),
  "}",
  ""
].join("\n");

const result = await postcss([
  tailwindcss(),
  prefixSelector({
    prefix: scope,
    exclude: [/^(?:from|to|\d+(?:\.\d+)?%)$/u],
    transform(prefix, selector, prefixedSelector) {
      if (/(^|[^\\])&/u.test(selector)) return selector;
      if (selector === ":root" || selector === ":host") return prefix;
      return prefixedSelector;
    }
  })
]).process(inputCss, {
  from: path.join(rootDir, ".tmp", "home-magic-ui.css")
});

assertScopedSelectors(result.root);
if (result.css.includes(`${scope} &`)) throw new Error("Nested Magic UI selector was prefixed twice");
const generated = [
  startMarker,
  "/* Generated from fixed Magic UI sources. Run: node scripts/build-home-magic-ui-css.mjs */",
  result.css.trim(),
  endMarker
].join("\n");
const styles = await readFile(stylesPath, "utf8");
const current = extractGeneratedBlock(styles);

if (checkOnly) {
  if (current !== generated) throw new Error("Generated Magic UI CSS is stale. Run node scripts/build-home-magic-ui-css.mjs");
  console.log("Home Magic UI CSS: PASS");
} else {
  const next = styles.replace(current, generated);
  if (next !== styles) await writeFile(stylesPath, next, "utf8");
  console.log("Home Magic UI CSS: updated");
}

function extractDeclaration(css, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`^[ \\t]*${escaped}:[^;]+;`, "mu"));
  if (!match) throw new Error(`Missing upstream animation declaration: ${name}`);
  return match[0].trim();
}

function extractKeyframes(css, name) {
  const token = `@keyframes ${name}`;
  const start = css.indexOf(token);
  if (start < 0) throw new Error(`Missing upstream keyframes: ${name}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`Unclosed upstream keyframes: ${name}`);
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function assertScopedSelectors(root) {
  root.walkRules((rule) => {
    const insideKeyframes = rule.parent?.type === "atrule" && /keyframes$/u.test(rule.parent.name);
    if (insideKeyframes) return;
    for (const selector of rule.selectors ?? []) {
      if (/(^|[^\\])&/u.test(selector) && hasScopedParent(rule)) continue;
      if (!selector.includes(scope)) throw new Error(`Unscoped Magic UI selector: ${selector}`);
    }
  });
}

function hasScopedParent(rule) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "rule" && parent.selectors?.some((selector) => selector.includes(scope))) return true;
    parent = parent.parent;
  }
  return false;
}

function extractGeneratedBlock(styles) {
  const start = styles.indexOf(startMarker);
  const end = styles.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error("Missing Magic UI CSS markers in styles.css");
  return styles.slice(start, end + endMarker.length);
}
