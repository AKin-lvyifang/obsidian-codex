import { setIcon } from "obsidian";

/**
 * Settings keeps Amicro's interaction language without importing its React,
 * Motion, or Tailwind runtime.  These helpers only add semantic classes and
 * small, accessible icon pairs; all animation lives in styles.css.
 */
export type AmicroButtonVariant = "primary" | "secondary" | "tertiary" | "danger" | "icon";
export type AmicroButtonMotion = "complete" | "slide" | "rotate" | "none";

export interface AmicroButtonOptions {
  readonly variant: AmicroButtonVariant;
  readonly motion?: AmicroButtonMotion;
  readonly icon?: string;
  readonly successIcon?: string;
}

export function applyAmicroButton(
  button: HTMLButtonElement,
  options: AmicroButtonOptions
): HTMLButtonElement {
  const motion = options.motion ?? "none";
  button.addClass(
    "echoink-amicro-button",
    `is-${options.variant}`,
    `motion-${motion}`
  );

  if (!options.icon || button.querySelector(".echoink-amicro-button-icon")) return button;
  const icon = button.createSpan({
    cls: "echoink-amicro-button-icon",
    attr: { "aria-hidden": "true" }
  });
  const idle = icon.createSpan({ cls: "echoink-amicro-button-icon-idle" });
  setIcon(idle, options.icon);

  if (motion === "complete") {
    const success = icon.createSpan({ cls: "echoink-amicro-button-icon-success" });
    setIcon(success, options.successIcon ?? "check");
  } else if (motion === "slide") {
    const arrow = icon.createSpan({ cls: "echoink-amicro-button-icon-arrow" });
    setIcon(arrow, "arrow-right");
  }
  return button;
}

export function setAmicroButtonPending(
  button: HTMLButtonElement,
  pending: boolean
): void {
  button.toggleClass("is-amicro-pending", pending);
  button.setAttr("aria-busy", String(pending));
}

export function confirmAmicroButton(
  button: HTMLButtonElement,
  durationMs = 1200
): void {
  button.removeClass("is-amicro-pending");
  button.setAttr("aria-busy", "false");
  button.addClass("is-amicro-confirmed");
  window.setTimeout(() => {
    if (button.isConnected) button.removeClass("is-amicro-confirmed");
  }, durationMs);
}
