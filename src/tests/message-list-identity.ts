/**
 * message-list-identity.ts — Conversation UI: reply header renders the
 * current Agent identity (name + avatar) from the cached snapshot.
 */

import assert from "node:assert/strict";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import type { AgentIdentityView } from "../ui/codex-view/message-list";

// ---------------------------------------------------------------------------
// Minimal fake element (Obsidian-style DOM extensions used by renderAgentHeader)
// ---------------------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  attributes = new Map<string, string>();

  constructor(readonly tag: string) {}

  createEl(tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): FakeElement {
    const child = new FakeElement(tag);
    if (options.cls) child.className = options.cls;
    if (options.text !== undefined) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) child.attributes.set(name, value);
    this.children.push(child);
    return child;
  }

  createDiv(options: { cls?: string; text?: string } | string = {}): FakeElement {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: { cls?: string; text?: string } | string = {}): FakeElement {
    return this.createEl("span", typeof options === "string" ? { cls: options } : options);
  }

  addClass(cls: string): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    classes.add(cls);
    this.className = [...classes].join(" ");
  }

  toggleClass(cls: string, enabled: boolean): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    if (enabled) classes.add(cls);
    else classes.delete(cls);
    this.className = [...classes].join(" ");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  findByClass(cls: string): FakeElement | null {
    for (const child of this.children) {
      if (child.className.split(/\s+/u).includes(cls)) return child;
      const found = child.findByClass(cls);
      if (found) return found;
    }
    return null;
  }

  findAllByClass(cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.className.split(/\s+/u).includes(cls)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  findByTag(tag: string): FakeElement | null {
    for (const child of this.children) {
      if (child.tag === tag) return child;
      const found = child.findByTag(tag);
      if (found) return found;
    }
    return null;
  }
}

function headerParts(container: FakeElement): {
  name: string;
  avatarImg: FakeElement | null;
  avatar: FakeElement | null;
  pill: FakeElement | null;
} {
  const nameEl = container.findByClass("codex-agent-name");
  assert.ok(nameEl, "agent header must render a name span");
  return {
    name: nameEl!.textContent,
    avatarImg: container.findByTag("img"),
    avatar: container.findByClass("codex-agent-avatar"),
    pill: container.findByClass("codex-agent-model-pill")
  };
}

const fakeMessage = {
  id: "msg-1",
  role: "agent",
  backendId: "deepseek-chat"
} as never;

export async function runMessageListIdentityTests(): Promise<void> {
  const renderer = new CodexMessageListRenderer();
  const render = (input: { agentIdentity?: AgentIdentityView; message?: unknown }) => {
    const container = new FakeElement("div");
    (renderer as unknown as {
      renderAgentHeader(
        container: unknown,
        input: { message?: unknown; statusLabel: string; compact: boolean; agentIdentity?: AgentIdentityView }
      ): void;
    }).renderAgentHeader(container, {
      ...(input.message ? { message: input.message } : {}),
      statusLabel: "",
      compact: false,
      ...(input.agentIdentity ? { agentIdentity: input.agentIdentity } : {})
    });
    return container;
  };

  // 1. No identity snapshot → default EchoInk + bot icon (no <img>).
  const baseline = headerParts(render({}));
  assert.equal(baseline.name, "EchoInk");
  assert.equal(baseline.avatarImg, null, "default identity must not render an img");
  assert.ok(baseline.avatar, "avatar container still renders for the bot icon");
  assert.equal(baseline.avatar!.attributes.get("aria-hidden"), "true");

  // 2. Custom name replaces the hardcoded EchoInk.
  const renamed = headerParts(render({ agentIdentity: { displayName: "小墨", avatarUrl: null } }));
  assert.equal(renamed.name, "小墨");
  assert.equal(renamed.avatarImg, null);

  // 3. Custom avatar renders an <img> instead of the bot SVG.
  const avatarUrl = "data:image/webp;base64,UkVE";
  const custom = headerParts(render({ agentIdentity: { displayName: "阿澈", avatarUrl } }));
  assert.equal(custom.name, "阿澈");
  assert.ok(custom.avatarImg, "custom avatar must render an img");
  assert.equal(custom.avatarImg!.attributes.get("src"), avatarUrl);
  assert.ok(custom.avatar!.className.includes("has-image"));

  // 4. Empty/blank identity falls back to EchoInk + bot; bubble layout untouched.
  const blank = headerParts(render({ agentIdentity: { displayName: "   ", avatarUrl: null } }));
  assert.equal(blank.name, "EchoInk");
  assert.equal(blank.avatarImg, null);

  // 5. Provider/model pill is independent of identity.
  const withPillA = headerParts(render({ message: fakeMessage, agentIdentity: { displayName: "小墨", avatarUrl: null } }));
  const withPillB = headerParts(render({ message: fakeMessage, agentIdentity: { displayName: "阿澈", avatarUrl } }));
  assert.equal(withPillA.pill?.textContent, "· deepseek-chat");
  assert.equal(withPillB.pill?.textContent, "· deepseek-chat");
  assert.equal(withPillA.pill?.textContent, withPillB.pill?.textContent,
    "identity changes must not touch the provider/model pill");

  // 6. Identity change + refresh: re-rendering with the new snapshot updates
  //    the displayed header (uniform current identity across history).
  const first = headerParts(render({ agentIdentity: { displayName: "小墨", avatarUrl: null } }));
  const second = headerParts(render({ agentIdentity: { displayName: "新名字", avatarUrl } }));
  assert.equal(first.name, "小墨");
  assert.equal(second.name, "新名字");
  assert.ok(second.avatarImg, "refreshed header picks up the new avatar");

  // 7. env fallback: headers rendered without an explicit snapshot read the
  //    renderer's current identity (what refreshPersonalizationUi relies on).
  (renderer as unknown as { env: { agentIdentity?: AgentIdentityView } | null }).env = {
    agentIdentity: { displayName: "缓存身份", avatarUrl: null }
  };
  const fromEnv = headerParts(render({}));
  assert.equal(fromEnv.name, "缓存身份");

  console.log("PASS conversation-ui: message header renders cached agent identity");
}
