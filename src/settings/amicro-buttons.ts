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

const particleButtonTimers = new WeakMap<HTMLButtonElement, number>();

/**
 * Native DOM adaptation of Kokonut UI's Particle Button. The plugin keeps the
 * same press + six-particle burst without importing React, Motion, or Tailwind.
 */
export function applyParticleButton(
  button: HTMLButtonElement,
  iconName = "refresh-cw"
): HTMLButtonElement {
  const label = button.textContent ?? "";
  applyAmicroButton(button, { variant: "primary" });
  button.addClass("echoink-particle-button");
  button.empty();
  button.createSpan({ cls: "echoink-particle-button-label", text: label });
  const icon = button.createSpan({
    cls: "echoink-particle-button-icon",
    attr: {
      "aria-hidden": "true",
      "data-echoink-icon": iconName
    }
  });
  setIcon(icon, iconName);
  const burst = button.createSpan({
    cls: "echoink-particle-button-burst",
    attr: { "aria-hidden": "true" }
  });
  for (let index = 0; index < 6; index += 1) {
    burst.createSpan({ cls: "echoink-particle-button-dot" });
  }
  return button;
}

export function triggerParticleButton(button: HTMLButtonElement): void {
  const ownerWindow = button.ownerDocument.defaultView ?? window;
  const previousTimer = particleButtonTimers.get(button);
  if (previousTimer !== undefined) ownerWindow.clearTimeout(previousTimer);
  button.removeClass("is-particle-bursting");
  // Restart the keyframes when the same recoverable action is tried again.
  void button.offsetWidth;
  button.addClass("is-particle-bursting");
  const timer = ownerWindow.setTimeout(() => {
    button.removeClass("is-particle-bursting");
    particleButtonTimers.delete(button);
  }, 820);
  particleButtonTimers.set(button, timer);
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
