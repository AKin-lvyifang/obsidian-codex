import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(rootDir, "config", "obsidian-review-baseline.json");
const writeBaseline = process.argv.includes("--write-baseline");
const eslint = new ESLint({ cwd: rootDir });
const results = await eslint.lintFiles(["src", "manifest.json", "package.json", "versions.json"]);
const errors = collectErrors(results);
const hardErrors = errors.filter(isHardError);
const counts = countByPathAndRule(errors);

if (writeBaseline) {
  if (hardErrors.length > 0) failHardErrors(hardErrors);
  writeBaselineFile(counts);
  process.exit(0);
}

const baseline = readBaseline();
const regressions = findRegressions(counts, baseline.errors);
console.log(`Obsidian review lint: ${errors.length} error(s), baseline allows ${sumCounts(baseline.errors)}.`);
if (hardErrors.length > 0) failHardErrors(hardErrors);
if (regressions.length > 0) {
  console.error("New Obsidian review errors are not allowed:");
  for (const regression of regressions) {
    console.error(`- ${regression.key}: ${regression.actual} current error(s), baseline ${regression.allowed}.`);
  }
  process.exit(1);
}

console.log("Obsidian review lint: PASS");

function collectErrors(lintResults) {
  const findings = [];
  for (const result of lintResults) {
    const relativePath = path.relative(rootDir, result.filePath).split(path.sep).join("/");
    for (const message of result.messages) {
      if (message.severity !== 2) continue;
      findings.push({
        path: relativePath,
        rule: message.ruleId ?? "<parse>",
        line: message.line ?? 0,
        column: message.column ?? 0,
        message: message.message
      });
    }
  }
  return findings;
}

function isHardError(finding) {
  return finding.rule === "no-eval"
    || finding.rule === "no-implied-eval"
    || finding.rule === "@typescript-eslint/no-implied-eval"
    || finding.rule === "no-unsanitized/method"
    || finding.rule === "no-unsanitized/property"
    || (typeof finding.rule === "string" && finding.rule.startsWith("obsidianmd/"));
}

function countByPathAndRule(findings) {
  const counts = {};
  for (const finding of findings) {
    const key = `${finding.path}::${finding.rule}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function readBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    console.error(`Invalid or missing Obsidian review baseline: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (!parsed || parsed.schemaVersion !== 3 || !isCountRecord(parsed.errors)) {
    console.error("Obsidian review baseline must use schemaVersion 3. Run npm run lint:update-baseline after reviewing current errors.");
    process.exit(1);
  }
  return parsed;
}

function writeBaselineFile(errors) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  const baseline = {
    schemaVersion: 3,
    source: "eslint-plugin-obsidianmd production errors",
    errors
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`Obsidian review baseline written: ${sumCounts(errors)} error(s).`);
}

function isCountRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);
}

function findRegressions(current, allowed) {
  return Object.entries(current)
    .filter(([key, actual]) => actual > (allowed[key] ?? 0))
    .map(([key, actual]) => ({ key, actual, allowed: allowed[key] ?? 0 }));
}

function failHardErrors(findings) {
  console.error("Obsidian review hard errors: every ObsidianMD error and dangerous-DOM/eval rule must be zero:");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`);
  }
  process.exit(1);
}

function sumCounts(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}
