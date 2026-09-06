import type { CognitiveSystem } from "../../harness/memory/cognitive-system";
import { DeveloperModeAccess } from "./access";
import { seedDeveloperMemories } from "./seed";
import type { DeveloperMemoryChange } from "./memory-backups";

export type DeveloperAction = "seed" | "dream" | "reset" | "restore";

export interface DeveloperModeHost {
  getSystem(): Promise<CognitiveSystem>;
  vaultName(): string;
  foregroundBusy(): boolean;
  writable(): boolean;
  withLocalActivity<T>(action: () => Promise<T>): Promise<T>;
  changeMemory(action: "reset" | "restore"): Promise<DeveloperMemoryChange>;
  latestBackup(): Promise<string | null>;
}

export class DeveloperModeService {
  busy = false;

  constructor(readonly access: DeveloperModeAccess, private readonly host: DeveloperModeHost) {}

  async status() {
    this.access.require();
    const system = await this.host.getSystem();
    const memory = await system.repository.readUserControlState();
    const dream = await system.dreamStateStore.read();
    return {
      vault: this.host.vaultName(),
      memoryCount: memory.records.filter((record) => record.status === "current").length,
      pending: dream.pendingMemoryIds.length,
      lastRunAt: dream.lastRunAt,
      lastSuccessAt: dream.lastSuccessAt,
      lastResult: system.scheduler.lastResult,
      busy: this.busy || system.engine.isRunning || this.host.foregroundBusy(),
      backup: await this.host.latestBackup()
    };
  }

  async execute(action: DeveloperAction) {
    this.access.require();
    if (this.busy || this.host.foregroundBusy()) throw new Error("developer_mode_busy");
    if (!this.host.writable()) throw new Error("developer_mode_read_only");
    this.busy = true;
    try {
      const system = await this.host.getSystem();
      this.access.require();
      if (this.host.foregroundBusy() || system.engine.isRunning) throw new Error("developer_mode_busy");
      if (action === "dream") {
        const result = await system.forceDreamRun();
        if (!result) throw new Error("developer_dream_unavailable");
        return { action, result } as const;
      }
      if (action === "seed") {
        return await this.host.withLocalActivity(async () => {
          this.access.require();
          return { action, ...await seedDeveloperMemories(system) } as const;
        });
      }
      return { action, ...await this.host.changeMemory(action) } as const;
    } finally { this.busy = false; }
  }
}

export type DeveloperStatus = Awaited<ReturnType<DeveloperModeService["status"]>>;
export type DeveloperResult = Awaited<ReturnType<DeveloperModeService["execute"]>>;
