import { setIcon } from "obsidian";

/**
 * The glyphs stay on Obsidian's bundled Lucide set so their idle appearance
 * remains unchanged.  The matching Animate Icons motion is adapted in CSS and
 * is only enabled for a real settings-tab transition.
 *
 * Motion reference (MIT): https://animateicons.in/icons/lucide
 */
export const ANIMATED_SETTINGS_TAB_ICON_NAMES = [
  "settings",
  "key-round",
  "blocks",
  "book-open",
  "clipboard-check"
] as const;

export type AnimatedSettingsTabIconName =
  typeof ANIMATED_SETTINGS_TAB_ICON_NAMES[number];

export function renderAnimatedSettingsTabIcon(
  container: HTMLElement,
  iconName: AnimatedSettingsTabIconName,
  animationElapsedMs: number | null
): void {
  container.replaceChildren();
  container.setAttr("data-animated-icon", iconName);
  container.toggleClass("is-animating", animationElapsedMs !== null);
  if (animationElapsedMs === null) {
    container.style.removeProperty("--echoink-tab-icon-delay");
  } else {
    container.style.setProperty(
      "--echoink-tab-icon-delay",
      `${-Math.max(0, Math.round(animationElapsedMs))}ms`
    );
  }
  setIcon(container, iconName);

  const svg = container.querySelector<SVGSVGElement>("svg");
  if (!svg) return;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
}
