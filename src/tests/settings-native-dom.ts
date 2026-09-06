import { renderSettingsKnowledgeDashboard } from "../settings/knowledge-dashboard";

/** Run in a real browser: addClass forwards tokens to its native DOMTokenList. */
export function runSettingsNativeDomRegression(host: HTMLElement): void {
  const create = function (this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
    this.appendChild(el);
    return el;
  };
  const prototype = host.ownerDocument.defaultView!.HTMLElement.prototype;
  Object.assign(prototype, {
    empty() { this.replaceChildren(); },
    addClass(...tokens: string[]) { this.classList.add(...tokens); },
    setAttr(name: string, value: string) { this.setAttribute(name, value); },
    createEl: create,
    createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); },
    createSpan(options: Parameters<typeof create>[1]) { return create.call(this, "span", options); }
  });
  let rejected = false;
  try { host.classList.add("invalid class-token"); } catch (error) {
    rejected = error instanceof DOMException && error.name === "InvalidCharacterError";
  }
  if (!rejected) throw new Error("This regression requires the browser's native classList semantics");
  const dashboard = host.createDiv();
  renderSettingsKnowledgeDashboard(dashboard, {
    language: "en", visible: true, snapshot: null, expanded: true,
    loading: false, error: "", recovery: { state: "ready", message: "" }
  }, { onRefresh() {}, onToggleExpanded() {}, onOpenHistory() {} });
  const next = host.createEl("section", { text: "Model and maintenance preferences" });
  if (!dashboard.classList.contains("settings-knowledge-dashboard")
    || !dashboard.classList.contains("dashboard-section")
    || !dashboard.querySelector("h3") || !next.isConnected) {
    throw new Error("Dashboard or following settings failed to mount");
  }
  host.dataset.nativeDomRegression = "passed";
}
