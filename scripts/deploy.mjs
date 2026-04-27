import fs from "fs";
import path from "path";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const pluginId = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8")).id;
const vaultPath = readArg("--vault") || process.env.OBSIDIAN_VAULT;
const explicitPluginDir = readArg("--plugin-dir") || process.env.OBSIDIAN_PLUGIN_DIR;
const targetDir = explicitPluginDir || (vaultPath ? path.join(vaultPath, ".obsidian", "plugins", pluginId) : "");

if (!targetDir) {
  console.error("Missing target. Use: OBSIDIAN_VAULT=/path/to/vault npm run deploy");
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const files = [
  ["dist/main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"]
];

for (const [from, to] of files) {
  fs.copyFileSync(path.join(projectRoot, from), path.join(targetDir, to));
}

console.log(`Deployed to ${targetDir}`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}
