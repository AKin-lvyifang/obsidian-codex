export interface EchoInkOnboardingCoachmarkOptions {
  readonly anchor: HTMLElement;
  readonly stepClass: string;
  readonly stepLabel: string;
  readonly title: string;
  readonly description: string;
  readonly dismissLabel?: string | null;
  readonly actionLabel?: string | null;
  readonly restoreFocusEl?: HTMLElement | null;
  readonly initialFocus?: "coachmark" | "anchor";
  readonly onDismiss?: () => void | Promise<void>;
  readonly onDismissError?: (error: unknown) => void;
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
  anchor.scrollIntoView({ block: "center", inline: "nearest" });
  coachmark.createDiv({ cls: "echoink-onboarding-step", text: options.stepLabel });
  coachmark.createDiv({
    cls: "echoink-onboarding-title",
    text: options.title,
    attr: { role: "heading", "aria-level": "3" }
  });
  coachmark.createDiv({ cls: "echoink-onboarding-copy", text: options.description });
  const actions = coachmark.createDiv({ cls: "echoink-onboarding-actions" });
  const dismiss = options.dismissLabel && options.onDismiss
    ? actions.createEl("button", {
        text: options.dismissLabel,
        attr: { type: "button" }
      })
    : null;

  let destroyed = false;
  const position = () => positionOnboardingCoachmark(coachmark, anchor, ownerWindow);
  const ResizeObserverCtor = ownerWindow.ResizeObserver;
  const observer = typeof ResizeObserverCtor === "undefined"
    ? null
    : new ResizeObserverCtor(position);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (dismiss) void dismissCoachmark();
    else destroy(true);
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
  const dismissCoachmark = async () => {
    if (!options.onDismiss) return;
    try {
      await options.onDismiss();
      destroy(true);
    } catch (error) {
      options.onDismissError?.(error);
    }
  };
  if (dismiss) dismiss.onclick = () => void dismissCoachmark();

  if (options.actionLabel && options.onAction) {
    const action = actions.createEl("button", {
      cls: "mod-cta",
      text: options.actionLabel,
      attr: { type: "button" }
    });
    action.onclick = () => {
      if (action.disabled) return;
      action.disabled = true;
      void Promise.resolve(options.onAction?.()).catch((error) => {
        options.onActionError?.(error);
      }).finally(() => {
        if (action.isConnected) action.disabled = false;
      });
    };
  }

  observer?.observe(anchor);
  observer?.observe(coachmark);
  ownerWindow.addEventListener("resize", position);
  ownerDocument.addEventListener("scroll", position, true);
  ownerDocument.addEventListener("keydown", onKeyDown, true);
  position();
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
