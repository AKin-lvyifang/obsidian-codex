import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const failures = [];
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const workflowPath = path.join(rootDir, ".github", "workflows", "release.yml");
const workflowDocument = parseWorkflow(workflowPath);
const workflow = workflowDocument?.toJS() ?? {};

validateManifest(manifest);
check(packageJson.version === manifest.version, "package.json version must match manifest.json.");
check(versions[manifest.version] === manifest.minAppVersion, "versions.json must map the manifest version to its minimum app version.");
if (args.tag) {
  const tag = args.allowVTag ? args.tag.replace(/^v/, "") : args.tag;
  check(args.allowVTag || !args.tag.startsWith("v"), "New Obsidian release tags must not use a v prefix.");
  check(tag === manifest.version, "Release tag must match manifest.json version.");
}

checkPinnedWorkflowActions();
validateReleaseWorkflow(workflow);
validateArtifacts();

if (failures.length > 0) {
  console.error("Obsidian release contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Obsidian release contract passed for ${manifest.version}`
  + `${args.tag ? ` (tag ${args.tag})` : ""}`
  + `${args.artifacts ? ` with assets from ${args.artifacts}` : ""}.`
);

function validateManifest(value) {
  check(isRecord(value), "manifest.json must be an object.");
  if (!isRecord(value)) return;
  for (const key of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) {
    check(key in value, `manifest.json is missing ${key}.`);
  }
  check(typeof value.id === "string" && /^[a-z]+(?:-[a-z]+)*$/.test(value.id), "manifest id must use lowercase hyphenated words.");
  check(typeof value.version === "string" && semver.test(value.version), "manifest version must use x.y.z SemVer.");
  check(typeof value.minAppVersion === "string" && semver.test(value.minAppVersion), "manifest minAppVersion must use x.y.z SemVer.");
  check(value.isDesktopOnly === true, "manifest must declare isDesktopOnly while EchoInk depends on Node APIs.");
}

function validateReleaseWorkflow(config) {
  const steps = Array.isArray(config?.jobs?.release?.steps) ? config.jobs.release.steps : [];
  check(steps.length > 0, "release workflow must contain a release job with steps.");
  const draftIndex = steps.findIndex(isDraftReleaseStep);
  const verificationIndex = steps.findIndex(isPublishedAssetVerificationStep);
  const publishIndex = steps.findIndex(isPublishStep);
  const guardIndex = steps.findIndex(isExistingReleaseGuard);
  const attestIndex = steps.findIndex((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/attest@"));

  check(attestIndex >= 0, "release workflow must attest the release assets.");
  check(draftIndex >= 0, "release workflow must create a draft release without overwriting files.");
  check(guardIndex >= 0, "release workflow must reject mutation of an existing public release.");
  check(verificationIndex >= 0, "release workflow must download and verify the draft assets before publishing.");
  check(publishIndex >= 0, "release workflow must publish only after verification.");
  check(
    attestIndex >= 0 && guardIndex > attestIndex && draftIndex > guardIndex
      && verificationIndex > draftIndex && publishIndex > verificationIndex,
    "release workflow must follow attest → guard → draft → verify → publish."
  );

  const draft = steps[draftIndex];
  const attestation = steps[attestIndex];
  if (draft) {
    check(draft.with?.draft === true, "the uploaded release must remain a draft until verification completes.");
    check(draft.with?.overwrite_files === false, "release assets must never overwrite existing assets.");
    check(draft.with?.make_latest === false, "an unverified draft must not become latest.");
    checkSameAssetSet(blockValues(draft.with?.files), "draft release assets");
  }
  if (attestation) checkSameAssetSet(blockValues(attestation.with?.["subject-path"]), "attested release assets");

  const commands = steps.map((step) => typeof step?.run === "string" ? step.run : "").join("\n");
  for (const forbidden of ["gh release delete", "gh release delete-asset", "gh release upload", "--clobber"]) {
    check(!commands.includes(forbidden), `release workflow must not use destructive or overwriting command: ${forbidden}.`);
  }
}

function isDraftReleaseStep(step) {
  return typeof step?.uses === "string"
    && step.uses.startsWith("softprops/action-gh-release@")
    && step.with?.draft === true
    && step.with?.overwrite_files === false;
}

function isExistingReleaseGuard(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh api")
    && run.includes("public")
    && run.includes("exit 1");
}

function isPublishedAssetVerificationStep(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh release download")
    && run.includes("cmp ")
    && run.includes("gh attestation verify");
}

function isPublishStep(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh release edit")
    && run.includes("--draft=false")
    && run.includes("--latest");
}

function validateArtifacts() {
  if (!args.artifacts) return;
  const directory = path.resolve(rootDir, args.artifacts);
  check(fs.existsSync(directory), `artifact directory does not exist: ${directory}.`);
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
  checkSameAssetSet(files, "prepared release assets");
  for (const asset of expectedAssets) {
    const assetPath = path.join(directory, asset);
    check(fs.existsSync(assetPath) && fs.statSync(assetPath).size > 0, `release asset must be non-empty: ${asset}.`);
  }
}

function checkPinnedWorkflowActions() {
  const workflowDir = path.join(rootDir, ".github", "workflows");
  for (const name of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/iu.test(file)).sort()) {
    const config = parseWorkflow(path.join(workflowDir, name))?.toJS();
    for (const job of Object.values(config?.jobs ?? {})) {
      checkPinnedAction(job?.uses, `${name} job`);
      for (const step of Array.isArray(job?.steps) ? job.steps : []) checkPinnedAction(step?.uses, `${name} step`);
    }
  }
}

function parseWorkflow(filename) {
  if (!fs.existsSync(filename)) {
    failures.push(`missing workflow: ${path.relative(rootDir, filename)}.`);
    return null;
  }
  const document = parseDocument(fs.readFileSync(filename, "utf8"), { uniqueKeys: true });
  for (const issue of [...document.errors, ...document.warnings]) failures.push(`invalid workflow ${path.basename(filename)}: ${issue.message}`);
  return document.errors.length === 0 ? document : null;
}

function checkPinnedAction(action, label) {
  if (action === undefined || (typeof action === "string" && action.startsWith("./"))) return;
  check(typeof action === "string" && /^[^/\s]+\/[^@\s]+@[a-f0-9]{40}$/u.test(action), `${label} must pin external actions to a full commit SHA.`);
}

function checkSameAssetSet(values, label) {
  const assets = values.map((value) => value.replace(/^release-assets\//u, "")).sort();
  check(JSON.stringify(assets) === JSON.stringify(expectedAssets), `${label} must be exactly ${expectedAssets.join(", ")}.`);
}

function blockValues(value) {
  return typeof value === "string" ? value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) : [];
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function parseArgs(values) {
  const parsed = { tag: "", artifacts: "", allowVTag: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--tag") parsed.tag = values[++index] ?? "";
    else if (value === "--artifacts") parsed.artifacts = values[++index] ?? "";
    else if (value === "--allow-v-tag") parsed.allowVTag = true;
    else {
      console.error(`Unknown argument: ${value}`);
      process.exit(1);
    }
  }
  return parsed;
}
