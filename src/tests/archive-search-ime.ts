/** Browser-native composition events against the extracted production renderer. */
export async function runArchiveSearchImeRegression(Fixture: new (host: HTMLElement) => {
  renderSettingsContent(): void;
  archivedConversationQuery: string;
  renders: number;
}): Promise<void> {
  const create = function (this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.appendChild(element);
    return element;
  };
  Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); },
    addClass(...tokens: string[]) { this.classList.add(...tokens); },
    setAttr(key: string, value: string) { this.setAttribute(key, value); },
    createEl: create,
    createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); },
    createSpan(options: Parameters<typeof create>[1]) { return create.call(this, "span", options); }
  });
  const host = document.querySelector<HTMLElement>("#fixture")!;
  const fixture = new Fixture(host);
  fixture.renderSettingsContent();
  const input = host.querySelector<HTMLInputElement>("input[type=search]")!;
  input.focus();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.value = "zhong";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "zhong", inputType: "insertCompositionText" }));
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await nextFrame();
  const during = {
    sameNode: host.querySelector("input[type=search]") === input,
    connected: input.isConnected,
    focused: document.activeElement === input,
    query: fixture.archivedConversationQuery,
    renders: fixture.renders
  };
  input.value = "中文";
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
  await nextFrame();
  const after = {
    query: fixture.archivedConversationQuery,
    titles: Array.from(host.querySelectorAll(".echoink-settings-compact-title")).map((node) => node.textContent)
  };
  const passed = during.sameNode && during.connected && during.focused && during.query === "" && during.renders === 1
    && after.query === "中文" && after.titles.length === 1 && after.titles[0] === "中文归档会话";
  const report = document.querySelector<HTMLElement>("#report")!;
  report.dataset.result = passed ? "passed" : "failed";
  report.textContent = JSON.stringify({ status: report.dataset.result, during, after, boundary: "Browser DOM with synthetic composition events; no OS IME, Obsidian or Vault access" }, null, 2);
}
