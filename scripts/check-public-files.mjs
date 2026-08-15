#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const stagedOnly = process.argv.includes("--staged");

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => existsSync(file));
}

function stagedFiles() {
  const output = execFileSync("git", ["ls-files", "--cached", "-z"], {
    encoding: "utf8"
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

const rules = [
  {
    reason: "private local collaboration or memory state",
    matches: (file) =>
      /(?:^|\/)(?:AGENT|AGENTS|USER|MEMORY|CONTEXT)\.md$/i.test(file)
      || file.startsWith(".codex-memory/")
      || file.startsWith(".omx/")
  },
  {
    reason: "private project documentation",
    matches: (file) => file.startsWith("docs/")
  },
  {
    reason: "private experiment material",
    matches: (file) => file.startsWith("experiments/")
  },
  {
    reason: "private Agent Evals material",
    matches: (file) =>
      /^scripts\/agent-evals-.*\.mjs$/i.test(file)
      || file.startsWith("src/tests/agent-evals/")
      || file.startsWith("src/tests/fixtures/agent-evals-v1/")
  },
  {
    reason: "internal prototype source or artifact",
    matches: (file) => /(?:^|\/)prototypes?\//i.test(file)
  }
];

const hardCodedSecretPattern =
  /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITHUB|GH|HERMES|OPENCODE)[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)\b\s*[:=]\s*['"](?!\$\{\{)[^'"\n]{8,}['"]/i;

if (!hardCodedSecretPattern.test("GH_" + "TOKEN = '" + "abcdefgh'")) {
  throw new Error("Public repository guard must reject literal secret assignments.");
}
if (hardCodedSecretPattern.test('GH_TOKEN: "${{ github.token }}"')) {
  throw new Error("Public repository guard must allow GitHub Actions secret expressions.");
}

const contentRules = [
  {
    reason: "local absolute user path",
    pattern: /\/Users\/lyuakin\//
  },
  {
    reason: "local macOS temporary path",
    pattern: /\/(?:private\/tmp|var\/folders)\//
  },
  {
    reason: "private vault path or name",
    pattern: new RegExp("AKin-" + "note-management")
  },
  {
    reason: "raw Authorization bearer token",
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i
  },
  {
    reason: "hard-coded secret or API key assignment",
    pattern: hardCodedSecretPattern
  }
];

function readTextFile(file) {
  const buffer = stagedOnly
    ? execFileSync("git", ["show", `:${file}`], { maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(file);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

const files = stagedOnly ? stagedFiles() : trackedFiles();
const blocked = [];

for (const file of files) {
  const rule = rules.find((candidate) => candidate.matches(file));
  if (rule) blocked.push({ file, reason: rule.reason });

  const text = readTextFile(file);
  if (!text) continue;
  const contentRule = contentRules.find((candidate) => candidate.pattern.test(text));
  if (contentRule) blocked.push({ file, reason: contentRule.reason });
}

if (blocked.length > 0) {
  console.error(`Public repository guard failed for ${stagedOnly ? "staged changes" : "tracked files"}.`);
  for (const item of blocked) {
    console.error(`- ${item.file} (${item.reason})`);
  }
  process.exit(1);
}

console.log(`Public repository guard passed: ${files.length} ${stagedOnly ? "staged" : "tracked"} file(s) checked.`);
