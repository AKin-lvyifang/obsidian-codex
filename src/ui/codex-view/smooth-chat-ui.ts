export const SMOOTH_BLUR_OUT_UP_DURATION_MS = 560;
export const SMOOTH_BLUR_OUT_UP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const SMOOTH_BLUR_OUT_UP_STAGGER_MS = 28;

export type SmoothAIStatus = "pending" | "running" | "success" | "error";

interface SmoothBlurOutUpOptions {
  delay?: number;
  stagger?: number;
}

interface SmoothReasoningOptions {
  bodyId: string;
  open: boolean;
  status?: SmoothAIStatus;
  summary: string;
}

export interface SmoothReasoningElements {
  body: HTMLElement;
  root: HTMLDetailsElement;
  summary: HTMLElement;
}

export interface SmoothArtifactElements {
  body: HTMLElement;
  root: HTMLElement;
}

/**
 * Native DOM adaptations of the SmoothUI AI and Blur Out Up patterns.
 *
 * EchoInk keeps its existing Obsidian renderers and interactions; these
 * helpers only provide the small structural primitives shared by the
 * Conversation message body, reasoning, tool, task, and artifact surfaces.
 */
export function renderSmoothBlurOutUp(
  container: HTMLElement,
  text: string,
  options: SmoothBlurOutUpOptions = {}
): HTMLElement {
  const delay = finiteNonNegative(options.delay, 0);
  const stagger = finiteNonNegative(options.stagger, SMOOTH_BLUR_OUT_UP_STAGGER_MS);
  const root = container.createSpan({
    cls: "codex-smooth-blur-out-up",
    attr: {
      "aria-label": text,
      "data-duration-ms": String(SMOOTH_BLUR_OUT_UP_DURATION_MS),
      "data-easing": SMOOTH_BLUR_OUT_UP_EASING,
      "data-smooth-ui-pattern": "blur-out-up",
      "data-stagger-ms": String(stagger)
    }
  });

  let animatedIndex = 0;
  for (const unit of blurOutUpUnits(text)) {
    if (/^\s+$/u.test(unit)) {
      root.createSpan({
        cls: "codex-smooth-blur-out-up-space",
        text: unit,
        attr: { "aria-hidden": "true" }
      });
      continue;
    }
    root.createSpan({
      cls: "codex-smooth-blur-out-up-unit",
      text: unit,
      attr: {
        "aria-hidden": "true",
        style: `--codex-smooth-blur-delay: ${delay + animatedIndex * stagger}ms`
      }
    });
    animatedIndex += 1;
  }
  return root;
}

export function createSmoothAIMessageBody(container: HTMLElement): HTMLElement {
  markSmoothPattern(container, "ai-message", "codex-smooth-ai-message");
  return container.createDiv({ cls: "codex-smooth-ai-message-body" });
}

export function createSmoothAIReasoning(
  container: HTMLElement,
  options: SmoothReasoningOptions
): SmoothReasoningElements {
  const status = options.status ?? "pending";
  const root = container.createEl("details", {
    cls: `codex-smooth-ai-reasoning is-${status}`,
    attr: {
      "data-smooth-status": status,
      "data-smooth-ui-pattern": "ai-reasoning"
    }
  });
  root.open = options.open;
  const summary = root.createEl("summary", {
    cls: "codex-smooth-ai-reasoning-summary",
    attr: {
      "aria-controls": options.bodyId,
      "aria-expanded": String(options.open)
    }
  });
  summary.createSpan({
    cls: "codex-smooth-ai-reasoning-caret",
    attr: { "aria-hidden": "true" }
  });
  summary.createSpan({ cls: "codex-smooth-ai-reasoning-label", text: options.summary });
  const body = root.createDiv({
    cls: "codex-smooth-ai-reasoning-body",
    attr: { id: options.bodyId }
  });
  return { body, root, summary };
}

export function markSmoothAIReasoning(container: HTMLElement, status?: string): void {
  markSmoothPattern(container, "ai-reasoning", "codex-smooth-ai-reasoning");
  container.setAttribute("data-smooth-status", smoothAIStatus(status));
}

export function markSmoothAIToolCall(container: HTMLElement, status?: string): SmoothAIStatus {
  const mappedStatus = smoothAIStatus(status);
  markSmoothPattern(container, "ai-tool-call", "codex-smooth-ai-tool-call");
  container.setAttribute("data-smooth-status", mappedStatus);
  container.addClass(`is-${mappedStatus}`);
  return mappedStatus;
}

export function renderSmoothAIToolStatus(
  container: HTMLElement,
  status?: string
): HTMLElement {
  const mappedStatus = smoothAIStatus(status);
  return container.createSpan({
    cls: `codex-smooth-ai-tool-status is-${mappedStatus}`,
    attr: {
      "aria-hidden": "true",
      "data-smooth-status": mappedStatus
    }
  });
}

export function markSmoothAITaskList(container: HTMLElement): void {
  markSmoothPattern(container, "ai-task-list", "codex-smooth-ai-task-list");
}

export function createSmoothAIArtifact(
  container: HTMLElement,
  title: string
): SmoothArtifactElements {
  const root = container.createDiv({
    cls: "codex-smooth-ai-artifact",
    attr: { "data-smooth-ui-pattern": "ai-artifact" }
  });
  const header = root.createDiv({ cls: "codex-smooth-ai-artifact-header" });
  header.createSpan({ cls: "codex-smooth-ai-artifact-title", text: title });
  const body = root.createDiv({ cls: "codex-smooth-ai-artifact-body" });
  return { body, root };
}

export function markSmoothAIArtifact(container: HTMLElement): void {
  markSmoothPattern(container, "ai-artifact", "codex-smooth-ai-artifact");
}

export function smoothAIStatus(status?: string): SmoothAIStatus {
  if (status === "running" || status === "in_progress" || status === "inProgress"
    || status === "waiting_approval" || status === "approved" || status === "verifying"
    || status === "blocked") return "running";
  if (status === "completed" || status === "success" || status === "done") return "success";
  if (status === "error" || status === "failed" || status === "denied"
    || status === "uncertain" || status === "recovery-blocked") return "error";
  return "pending";
}

function markSmoothPattern(container: HTMLElement, pattern: string, className: string): void {
  container.addClass(className);
  container.setAttribute("data-smooth-ui-pattern", pattern);
}

function blurOutUpUnits(text: string): string[] {
  if (!text.trim() || !/\s/u.test(text.trim())) return [text];
  return text.split(/(\s+)/u).filter(Boolean);
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}
