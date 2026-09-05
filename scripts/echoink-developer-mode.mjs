import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const action = process.argv[2];
const marker = path.join(homedir(), ".echoink", "developer-mode.json");
if (action === "enable" || action === "disable") {
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ enabled: action === "enable" })}\n`, { mode: 0o600 });
  await rename(temporary, marker);
  console.log(`${action === "enable" ? "Enabled" : "Disabled"}: ${marker}`);
  if (action === "enable") console.log("Desktop EchoInk: hold Option/Alt and click the About version 7 times within 5 seconds. No Vault was accessed.");
} else if (action === "status") {
  let enabled = false;
  try { enabled = JSON.parse(await readFile(marker, "utf8")).enabled === true; } catch { /* disabled */ }
  console.log(`${enabled ? "Enabled" : "Disabled"}: ${marker}`);
} else {
  console.error("Usage: node scripts/echoink-developer-mode.mjs enable|disable|status");
  process.exitCode = 1;
}
