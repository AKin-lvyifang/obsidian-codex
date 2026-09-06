/** Hidden UI state for one plugin session. Nothing is read from or saved to disk. */
export class DeveloperModeAccess {
  private shown = false;
  private on = false;
  private clicks: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get revealed(): boolean { return this.shown; }
  get enabled(): boolean { return this.on; }

  /** Returns true only when the gesture first reveals the settings switch. */
  click(altKey: boolean): boolean {
    if (!altKey) { this.clicks = []; return false; }
    if (this.shown) return false;
    const now = this.now();
    this.clicks = this.clicks.filter((at) => now >= at && now - at <= 5_000);
    this.clicks.push(now);
    if (this.clicks.length < 7) return false;
    this.shown = true;
    this.clicks = [];
    return true;
  }

  setEnabled(enabled: boolean): void { this.on = this.shown && enabled; }

  require(): void {
    if (!this.shown || !this.on) throw new Error("developer_mode_locked");
  }

  reset(): void { this.shown = false; this.on = false; this.clicks = []; }
}
