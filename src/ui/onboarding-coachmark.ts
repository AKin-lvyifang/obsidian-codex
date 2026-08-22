import { setIcon } from "obsidian";

export interface EchoInkOnboardingCoachmarkOptions {
  readonly anchor: HTMLElement;
  readonly stepClass: string;
  readonly stepLabel: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string | null;
  readonly restoreFocusEl?: HTMLElement | null;
  readonly initialFocus?: "coachmark" | "anchor";
  readonly onAction?: () => void | Promise<void>;
  readonly onActionError?: (error: unknown) => void;
}

export interface EchoInkOnboardingCoachmarkHandle {
  readonly element: HTMLElement;
  destroy(restoreFocus?: boolean): void;
}

/** Mount one accessible coachmark beside a real product control. */
export function mountEchoInkOnboardingCoachmark(
  options: Readonly<EchoInkOnboardingCoachmarkOptions>
): EchoInkOnboardingCoachmarkHandle {
  const { anchor } = options;
  const ownerDocument = anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const active = ownerDocument.activeElement;
  const restoreFocusEl = options.restoreFocusEl
    ?? (active instanceof HTMLElement ? active : null);
  const coachmark = ownerDocument.body.createDiv({
    cls: `echoink-onboarding-coachmark is-${options.stepClass}`,
    attr: {
      role: "dialog",
      "aria-modal": "false",
      "aria-label": options.title,
      tabindex: "-1"
    }
  });
  anchor.addClass("is-echoink-onboarding-target");
  coachmark.createDiv({ cls: "echoink-onboarding-step", text: options.stepLabel });
  coachmark.createDiv({
    cls: "echoink-onboarding-title",
    text: options.title,
    attr: { role: "heading", "aria-level": "3" }
  });
  coachmark.createDiv({ cls: "echoink-onboarding-copy", text: options.description });
  const actions = coachmark.createDiv({ cls: "echoink-onboarding-actions" });
  const action = options.actionLabel && options.onAction
    ? actions.createEl("button", {
        cls: "mod-cta echoink-amicro-button is-primary echoink-onboarding-action",
        attr: { type: "button", "aria-busy": "false" }
      })
    : null;
  if (action) {
    const icon = action.createSpan({
      cls: "echoink-onboarding-action-icon",
      attr: {
        "aria-hidden": "true",
        "data-echoink-icon": "arrow-right"
      }
    });
    setIcon(icon, "arrow-right");
    const labelWindow = action.createSpan({
      cls: "echoink-onboarding-action-label-window",
      attr: { "aria-hidden": "true" }
    });
    labelWindow.createSpan({
      cls: "echoink-onboarding-action-label",
      text: options.actionLabel ?? "",
      attr: { "data-label": options.actionLabel ?? "" }
    });
    action.setAttr("aria-label", options.actionLabel ?? "");
  }

  let destroyed = false;
  const position = () => positionOnboardingCoachmark(coachmark, anchor, ownerWindow);
  const ResizeObserverCtor = ownerWindow.ResizeObserver;
  const observer = typeof ResizeObserverCtor === "undefined"
    ? null
    : new ResizeObserverCtor(position);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    destroy(true);
  };
  const destroy = (restoreFocus = false) => {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    ownerWindow.removeEventListener("resize", position);
    ownerDocument.removeEventListener("scroll", position, true);
    ownerDocument.removeEventListener("keydown", onKeyDown, true);
    anchor.removeClass("is-echoink-onboarding-target");
    coachmark.remove();
    if (restoreFocus && restoreFocusEl?.isConnected) {
      restoreFocusEl.focus({ preventScroll: true });
    }
  };
  if (action) {
    action.onclick = () => {
      if (action.disabled) return;
      action.disabled = true;
      action.addClass("is-pending");
      action.setAttr("aria-busy", "true");
      void Promise.resolve(options.onAction?.()).catch((error) => {
        options.onActionError?.(error);
      }).finally(() => {
        if (action.isConnected) {
          action.disabled = false;
          action.removeClass("is-pending");
          action.setAttr("aria-busy", "false");
        }
      });
    };
  }

  observer?.observe(anchor);
  observer?.observe(coachmark);
  ownerWindow.addEventListener("resize", position);
  ownerDocument.addEventListener("scroll", position, true);
  ownerDocument.addEventListener("keydown", onKeyDown, true);
  // Settings restores its prior scroll snapshot after a tab render. A single
  // scrollIntoView can therefore be overwritten and leave later tutorial
  // targets below the fold. Recheck over two settled layout frames, then
  // position the coachmark against the final target rectangle.
  const revealAnchor = () => {
    if (destroyed || !anchor.isConnected) return;
    anchor.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    position();
  };
  revealAnchor();
  ownerWindow.requestAnimationFrame(() => {
    revealAnchor();
    ownerWindow.requestAnimationFrame(revealAnchor);
  });
  if (options.initialFocus === "anchor") anchor.focus({ preventScroll: true });
  else coachmark.focus({ preventScroll: true });
  return Object.freeze({ element: coachmark, destroy });
}

function positionOnboardingCoachmark(
  coachmark: HTMLElement,
  anchor: HTMLElement,
  ownerWindow: Window
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 12;
  const viewportWidth = ownerWindow.innerWidth;
  const viewportHeight = ownerWindow.innerHeight;
  if (viewportWidth <= 640) {
    coachmark.setCssStyles({
      left: `${margin}px`,
      right: `${margin}px`,
      top: "auto",
      bottom: `${margin}px`,
      width: "auto"
    });
    coachmark.dataset.placement = "bottom-sheet";
    return;
  }
  const width = Math.min(360, viewportWidth - margin * 2);
  const coachmarkHeight = Math.max(coachmark.offsetHeight, 180);
  const below = anchorRect.bottom + margin;
  const above = anchorRect.top - coachmarkHeight - margin;
  const top = below + coachmarkHeight <= viewportHeight - margin
    ? below
    : Math.max(margin, above);
  const left = Math.min(
    viewportWidth - width - margin,
    Math.max(margin, anchorRect.left)
  );
  coachmark.setCssStyles({
    left: `${left}px`,
    right: "auto",
    top: `${top}px`,
    bottom: "auto",
    width: `${width}px`
  });
  coachmark.dataset.placement = top === below ? "below" : "above";
}
