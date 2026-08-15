import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/run-phase1-tests.mjs"], {
  env: {
    ...process.env,
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
