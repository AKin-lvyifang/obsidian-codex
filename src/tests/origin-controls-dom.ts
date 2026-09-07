import { createOriginButton, createOriginCheck, createOriginInput, createOriginRadioGroup, createOriginSelect, createOriginSlider, createOriginSwitch, disposeOriginControls, type OriginCheckElement } from "../settings/origin-controls";

type AsyncFixture = { runMcpToggleAction(toggle: OriginCheckElement, action: (checked: boolean) => Promise<void>): Promise<void> };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const key = (element: HTMLElement, value: string) => element.dispatchEvent(new (element.ownerDocument.defaultView!.KeyboardEvent)("keydown", { key: value, bubbles: true, cancelable: true }));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

export async function runOriginControlsDom(Fixture: new () => AsyncFixture) {
  const results: string[] = [];
  const main = document.querySelector<HTMLElement>("#fixture")!;
  const report = document.querySelector<HTMLElement>("#report")!;
  // Match the production page/group/row hierarchy so legacy action selectors
  // participate in the cascade, just as they do in Obsidian Settings.
  const body = document.createElement("div"); body.className = "codex-settings-body"; main.append(body);
  const page = document.createElement("div"); page.className = "echoink-settings-page"; body.append(page);
  const card = document.createElement("section"); card.className = "echoink-settings-section is-group settings-card"; page.append(card);
  const group = document.createElement("div"); group.className = "echoink-settings-group settings-stack"; card.append(group);
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  const section = (label: string) => {
    const row = document.createElement("div"); row.className = "setting-item echoink-settings-row setting-row";
    const copy = document.createElement("span"); copy.className = "setting-item-info setting-copy"; copy.textContent = label; row.append(copy);
    const controls = document.createElement("div"); controls.className = "setting-item-control setting-controls"; row.append(controls); group.append(row); return controls;
  };
  const run = async (name: string, test: () => void | Promise<void>) => {
    try { await test(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${String(error)}`); }
    report.textContent = results.join("\n");
  };
  await run("switch callback, authoritative rollback, disabled", async () => {
    const toggle = createOriginSwitch(section("Switch"), { attr: { "aria-label": "Switch" } });
    let calls = 0;
    toggle.onchange = () => { calls++; };
    toggle.click(); await frame();
    assert(toggle.checked && toggle.getAttribute("aria-checked") === "true" && calls === 1, "click did not update state/callback");
    toggle.checked = false;
    assert(toggle.getAttribute("aria-checked") === "false", "rollback did not update primitive");
    toggle.disabled = true; toggle.click();
    assert(calls === 1 && toggle.hasAttribute("disabled"), "disabled control changed");
    toggle.disabled = false;
  });
  await run("checkbox label click", async () => {
    const label = document.createElement("label"); label.textContent = "Choose model "; section("Checkbox").append(label);
    const check = createOriginCheck(label, { attr: { "aria-label": "Choose model" } });
    label.click(); await frame(); assert(check.checked, "label did not activate checkbox");
  });
  await run("one radio Root, arrow navigation, disabled item", async () => {
    let selected = "a";
    const group = createOriginRadioGroup(section("Default model"), "a", "Default model", (value) => { selected = value; });
    const targets = ["a", "b", "c"].map((value) => { const row = document.createElement("label"); row.textContent = value; group.element.append(row); return row; });
    const a = group.addItem(targets[0], "a", false);
    group.addItem(targets[1], "b", true);
    const c = group.addItem(targets[2], "c", false);
    a.focus(); key(a, "ArrowDown"); await frame();
    assert(selected === "c" && document.activeElement === c && c.getAttribute("aria-checked") === "true" && a.getAttribute("aria-checked") === "false", "radio collection did not skip disabled item or keep mutual exclusion");
  });
  await run("select empty label, arrow selection, Escape focus", async () => {
    const controls = section("Language / empty model");
    const empty = createOriginSelect(controls, { attr: { "aria-label": "No models" } }, [{ value: "", label: "No saved models" }]).element;
    await frame(); assert(empty.textContent?.includes("No saved models"), "empty option label disappeared");
    let selected = "zh";
    const select = createOriginSelect(controls, { attr: { "aria-label": "Language" } }, [{ value: "zh", label: "中文" }, { value: "en", label: "English" }], "zh").element;
    select.onchange = () => { selected = select.value; };
    select.focus(); key(select, "Enter"); await frame();
    const popup = document.getElementById(select.getAttribute("aria-controls")!)!;
    const option = popup?.querySelector<HTMLElement>('[role=option][data-state=checked]')!;
    assert(option && popup.ownerDocument === select.ownerDocument, "popup not mounted in owning document");
    const bounds = option.getBoundingClientRect();
    assert(bounds.width > 0 && bounds.height > 0 && popup.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)), "popup option is clipped or visually covered by the native settings hierarchy");
    key(option, "ArrowDown"); await frame();
    key(document.activeElement as HTMLElement, "Enter"); await frame();
    assert(selected === "en" && select.value === "en", "selected value did not reach callback");
    select.focus(); key(select, "Enter"); await frame();
    key(document.activeElement as HTMLElement, "Escape"); await frame();
    assert(!document.querySelector('[data-slot=select-content]') && document.activeElement === select, "Escape failed to close and restore focus");
  });
  await run("slider continuous keyboard commits and focus", async () => {
    const controls = section("Runs per day"); controls.classList.add("general-range");
    const output = document.createElement("output"); output.textContent = "3/day";
    const values: number[] = []; const commits: number[] = [];
    const slider = createOriginSlider(controls, { value: 3, min: 1, max: 6, step: 1, label: "Runs per day",
      onValueChange: (value) => { values.push(value); output.textContent = `${value}/day`; }, onValueCommit: (value) => commits.push(value) });
    controls.append(output);
    const thumb = slider.querySelector<HTMLElement>('[role=slider]')!; thumb.focus();
    for (const direction of ["ArrowRight", "ArrowRight", "ArrowLeft"]) { key(thumb, direction); await frame(); }
    assert(values.join() === "4,5,4" && commits.join() === "4,5,4" && document.activeElement === thumb, "continuous update/commit/focus failed");
  });
  await run("Input composition retains node, selection and value", async () => {
    const input = createOriginInput(section("Journal folder"), { attr: { "aria-label": "Journal folder" } });
    input.focus(); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "zhong"; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); await frame();
    assert(input.isConnected && document.activeElement === input && input.value === "zhong", "composition detached input");
    input.value = "中文"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
  });
  await run("production MCP async failure after page disposal", async () => {
    const page = document.createElement("div"); main.append(page);
    const toggle = createOriginSwitch(page); toggle.checked = true;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, onReject) => { reject = onReject; });
    const work = new Fixture().runMcpToggleAction(toggle, () => pending);
    disposeOriginControls(page); page.remove(); reject(new Error("expected save failure"));
    await work;
    assert(!toggle.checked && !toggle.disabled, "production rollback did not settle after unmount");
  });
  await run("independent ownerDocument and Select portal cleanup", async () => {
    const iframe = document.createElement("iframe"); iframe.title = "Independent document"; main.append(iframe);
    await new Promise<void>((resolve) => { iframe.onload = () => resolve(); iframe.srcdoc = '<main class="echoink-settings-demo"></main>'; });
    const other = iframe.contentDocument!; const host = other.querySelector<HTMLElement>("main")!;
    const toggle = createOriginSwitch(host); toggle.click();
    const select = createOriginSelect(host, { attr: { "aria-label": "Independent select" } }, [{ value: "a", label: "A" }, { value: "b", label: "B" }], "a").element;
    select.focus(); key(select, "Enter"); await frame();
    assert(toggle.checked && other.querySelector('[data-slot=select-content]'), "control or portal used the wrong document");
    assert(other.activeElement?.getAttribute("role") === "option", "popup focus did not enter the owning document");
    key(other.activeElement as HTMLElement, "ArrowDown"); await frame();
    key(other.activeElement as HTMLElement, "Enter"); await frame();
    assert(select.value === "b", "owning document keyboard selection failed");
    select.focus(); key(select, "Enter"); await frame();
    key(other.activeElement as HTMLElement, "Escape"); await frame();
    assert(!other.querySelector('[data-slot=select-content]') && other.activeElement === select, "owning document Escape/focus failed");
    let selected = "a";
    const radios = createOriginRadioGroup(host, "a", "Default model", (value) => { selected = value; });
    const radioItems = ["a", "b", "c"].map((value) => {
      const row = other.createElement("div"); row.className = "codex-provider-model-choice"; radios.element.append(row);
      const selection = other.createElement("div"); selection.className = "codex-provider-model-choice-selection"; row.append(selection);
      const label = other.createElement("label"); label.className = "codex-provider-model-choice-default"; label.textContent = value; selection.append(label);
      return radios.addItem(label, value, value === "b");
    });
    radioItems[0].focus(); key(radioItems[0], "ArrowDown"); await frame();
    assert(selected === "c" && other.activeElement === radioItems[2] && radioItems[2].getAttribute("aria-checked") === "true" && radioItems[0].getAttribute("aria-checked") === "false", "owning document radio ArrowDown/disabled skip failed");
    key(radioItems[2], "ArrowUp"); await frame();
    assert(selected === "a" && other.activeElement === radioItems[0] && radioItems[0].getAttribute("aria-checked") === "true" && radioItems[2].getAttribute("aria-checked") === "false", "owning document radio ArrowUp/mutual exclusion failed");
    disposeOriginControls(host);
    assert(!host.querySelector('[data-slot]') && !other.querySelector('[data-slot=select-content]'), "root cleanup left controls or popup");
    iframe.remove();
  });
  createOriginButton(section("Button"), { text: "Save", cls: "echoink-amicro-button mod-cta" });
  const failed = results.some((item) => item.startsWith("FAIL")) || errors.length > 0;
  report.dataset.result = failed ? "failed" : "passed";
  report.textContent = [...results, ...errors.map((error) => `ERROR ${error}`), "Boundary: native browser DOM, synthetic input; no Obsidian, OS IME, Provider or Vault."].join("\n");
}
