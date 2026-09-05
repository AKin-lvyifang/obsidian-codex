import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const localDeveloperMarkerPath = (): string =>
  path.join(homedir(), ".echoink", "developer-mode.json");

/** A local, per-plugin-session guard against accidental entry. */
export class LocalDeveloperAccess {
  private unlocked = false;
  private clicks: number[] = [];

  constructor(private readonly options: {
    isDesktop: () => boolean;
    readMarker?: () => string;
    now?: () => number;
  }) {}

  eligible(): boolean {
    try {
      if (!this.options.isDesktop()) return false;
      const text = this.options.readMarker?.()
        ?? readFileSync(localDeveloperMarkerPath(), "utf8");
      if (text.length > 4_096) return false;
      const marker: unknown = JSON.parse(text);
      return Boolean(marker && typeof marker === "object"
        && !Array.isArray(marker) && (marker as { enabled?: unknown }).enabled === true);
    } catch { return false; }
  }

  click(altKey: boolean): boolean {
    if (!this.eligible()) { this.lock(); return false; }
    if (!altKey) { this.clicks = []; return false; }
    if (this.unlocked) return true;
    const now = this.options.now?.() ?? Date.now();
    this.clicks = this.clicks.filter((at) => now >= at && now - at <= 5_000);
    this.clicks.push(now);
    if (this.clicks.length < 7) return false;
    this.unlocked = true;
    this.clicks = [];
    return true;
  }

  require(): void {
    if (!this.eligible()) this.lock();
    if (!this.unlocked) throw new Error("developer_mode_locked");
  }

  lock(): void { this.unlocked = false; this.clicks = []; }
}
