export type AIElementsStatus = "pending" | "running" | "success" | "error";

export interface AIElementsDisclosure {
  readonly body: HTMLElement;
  readonly root: HTMLDetailsElement;
  readonly summary: HTMLElement;
}

export interface AIElementsSourcesList {
  readonly root: HTMLElement;
  readonly list: HTMLElement;
}

export function markAIElementsMessage(
  container: HTMLElement,
  role: "user" | "assistant" | "system" | "tool"
): void {
  container.addClass("codex-ai-elements-message");
  container.addClass(`is-${role}`);
  container.setAttribute("data-ai-elements-pattern", "message");
  container.setAttribute("data-message-role", role);
}

export function createAIElementsMessageContent(
  container: HTMLElement
): HTMLElement {
  return container.createDiv({
    cls: "codex-ai-elements-message-content",
    attr: { "data-ai-elements-pattern": "message-content" }
  });
}

export function markAIElementsResponse(
  container: HTMLElement,
  streaming: boolean
): void {
  container.addClass("codex-ai-elements-response");
  container.toggleClass("is-streaming", streaming);
  container.setAttribute("data-ai-elements-pattern", "response");
  container.setAttribute("data-streaming", String(streaming));
  container.setAttribute("aria-busy", String(streaming));
}

export function createAIElementsChainOfThought(
  container: HTMLElement,
  options: Readonly<{
    bodyId: string;
    open: boolean;
    status: AIElementsStatus;
  }>
): AIElementsDisclosure {
  return createDisclosure(container, {
    ...options,
    pattern: "chain-of-thought",
    rootClass: "codex-ai-elements-chain-of-thought",
    triggerClass: "codex-ai-elements-chain-of-thought-trigger",
    contentClass: "codex-ai-elements-chain-of-thought-content"
  });
}

export function createAIElementsReasoning(
  container: HTMLElement,
  options: Readonly<{
    bodyId: string;
    open: boolean;
    status: AIElementsStatus;
    summary: string;
  }>
): AIElementsDisclosure {
  const elements = createDisclosure(container, {
    ...options,
    pattern: "reasoning",
    rootClass: "codex-ai-elements-reasoning",
    triggerClass: "codex-ai-elements-reasoning-trigger",
    contentClass: "codex-ai-elements-reasoning-content"
  });
  elements.summary.createSpan({
    cls: "codex-ai-elements-reasoning-caret",
    attr: { "aria-hidden": "true" }
  });
  elements.summary.createSpan({
    cls: "codex-ai-elements-reasoning-label",
    text: options.summary
  });
  return elements;
}

export function markAIElementsTool(
  container: HTMLElement,
  status?: string
): AIElementsStatus {
  const mapped = aiElementsStatus(status);
  container.addClass("codex-ai-elements-tool");
  applyAIElementsStatus(container, mapped);
  container.setAttribute("data-ai-elements-pattern", "tool");
  container.setAttribute("data-tool-status", mapped);
  return mapped;
}

export function renderAIElementsToolStatus(
  container: HTMLElement,
  status?: string
): HTMLElement {
  const mapped = aiElementsStatus(status);
  return container.createSpan({
    cls: `codex-ai-elements-tool-status is-${mapped}`,
    attr: {
      "aria-hidden": "true",
      "data-tool-status": mapped
    }
  });
}

export function createAIElementsArtifactSources(
  container: HTMLElement,
  label: string,
  showLabel: boolean
): AIElementsSourcesList {
  const root = container.createDiv({
    cls: "codex-ai-elements-artifact-sources",
    attr: {
      "data-ai-elements-pattern": "sources",
      "data-source-kind": "artifacts",
      "aria-label": label
    }
  });
  if (showLabel) {
    root.createSpan({
      cls: "codex-ai-elements-artifact-sources-label",
      text: label
    });
  }
  const list = root.createDiv({ cls: "codex-ai-elements-artifact-sources-list" });
  return { root, list };
}

export function aiElementsStatus(status?: string): AIElementsStatus {
  if (
    status === "running"
    || status === "in_progress"
    || status === "inProgress"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying"
    || status === "blocked"
  ) return "running";
  if (
    status === "completed"
    || status === "success"
    || status === "done"
  ) return "success";
  if (
    status === "error"
    || status === "failed"
    || status === "denied"
    || status === "cancelled"
    || status === "interrupted"
    || status === "uncertain"
    || status === "recovery-blocked"
  ) return "error";
  return "pending";
}

export function applyAIElementsStatus(
  container: HTMLElement,
  status: AIElementsStatus
): void {
  for (const candidate of ["pending", "running", "success", "error"] as const) {
    container.toggleClass(`is-${candidate}`, candidate === status);
  }
  container.setAttribute("data-ai-elements-status", status);
}

function createDisclosure(
  container: HTMLElement,
  options: Readonly<{
    bodyId: string;
    open: boolean;
    status: AIElementsStatus;
    pattern: "chain-of-thought" | "reasoning";
    rootClass: string;
    triggerClass: string;
    contentClass: string;
  }>
): AIElementsDisclosure {
  const root = container.createEl("details", {
    cls: options.rootClass,
    attr: {
      "data-ai-elements-pattern": options.pattern,
      "data-ai-elements-status": options.status
    }
  });
  applyAIElementsStatus(root, options.status);
  root.open = options.open;
  const summary = root.createEl("summary", {
    cls: options.triggerClass,
    attr: {
      "aria-controls": options.bodyId,
      "aria-expanded": String(options.open)
    }
  });
  const body = root.createDiv({
    cls: options.contentClass,
    attr: { id: options.bodyId }
  });
  return { body, root, summary };
}
