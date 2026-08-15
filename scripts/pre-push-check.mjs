import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const updates = await readUpdates();
const changed = changedFiles(updates);

run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);
for (const command of affectedTests(changed)) run("npm", ["run", command]);

async function readUpdates() {
  const input = await readStdin();
  return input.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((update) => update.localSha && !/^0+$/u.test(update.localSha));
}

function changedFiles(updates) {
  const files = new Set();
  for (const update of updates) {
    const range = /^0+$/u.test(update.remoteSha)
      ? ["diff-tree", "--no-commit-id", "--name-only", "-r", update.localSha]
      : ["diff", "--name-only", `${update.remoteSha}...${update.localSha}`];
    const output = execFileSync("git", range, { encoding: "utf8" });
    for (const file of output.split(/\r?\n/u).filter(Boolean)) files.add(file);
  }
  return files;
}

function affectedTests(files) {
  const paths = [...files];
  const commands = [];
  if (paths.some((file) => /^(src\/(settings|plugin)\/|src\/harness\/pi\/|src\/harness\/pi-native\/|src\/resources\/)/u.test(file))) {
    commands.push("test:provider-settings", "test:conversation-ui");
  }
  if (paths.some((file) => /^src\/harness\/memory\//u.test(file))) {
    commands.push("test:personal-memory");
  }
  if (paths.some((file) => /^src\/knowledge-base\//u.test(file) || /pi-knowledge/u.test(file))) {
    commands.push("test:knowledge");
  }
  if (paths.some((file) => /^src\/resources\/mcp/u.test(file) || /pi-mcp/u.test(file))) {
    commands.push("test:mcp-vault");
  }
  return [...new Set(commands)];
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}
