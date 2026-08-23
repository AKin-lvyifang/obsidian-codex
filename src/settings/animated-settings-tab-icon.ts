/**
 * Native-DOM ports of the matching Animate Icons Lucide components.
 *
 * Source: https://animateicons.in/icons/lucide
 * Local reference commit: e19861bd8e1e214105221040aefb27644fd1362f
 * License: MIT
 *
 * EchoInk does not ship React or Motion. These renderers preserve the source
 * SVG layers and expose the same independently animated parts to styles.css.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const ANIMATED_SETTINGS_TAB_ICON_NAMES = [
  "settings",
  "key-round",
  "layout-list",
  "book-open-check",
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

  container.appendChild(ICON_RENDERERS[iconName]());
}

const ICON_RENDERERS: Record<
  AnimatedSettingsTabIconName,
  () => SVGSVGElement
> = {
  settings: renderSettingsIcon,
  "key-round": renderKeyRoundIcon,
  "layout-list": renderLayoutListIcon,
  "book-open-check": renderBookOpenCheckIcon,
  "clipboard-check": renderClipboardCheckIcon
};

function renderSettingsIcon(): SVGSVGElement {
  const svg = createIconSvg("settings");
  const motion = appendSvg(svg, "g", {}, "settings-motion");
  const base = appendSvg(motion, "g", {}, "settings-base");
  appendSvg(base, "path", { d: SETTINGS_GEAR_PATH });
  appendSvg(base, "circle", { cx: 12, cy: 12, r: 3 });
  appendSvg(motion, "path", {
    d: SETTINGS_GEAR_PATH,
    pathLength: 1
  }, "settings-gear-draw");
  appendSvg(motion, "circle", {
    cx: 12,
    cy: 12,
    r: 3,
    pathLength: 1
  }, "settings-core-draw");

  [
    [12, 4.6, 0.8],
    [19, 8, 0.7],
    [18.5, 16.5, 0.7],
    [8, 18, 0.7],
    [5.5, 9, 0.7]
  ].forEach(([cx, cy, r], index) => {
    appendSvg(motion, "circle", {
      cx,
      cy,
      r,
      fill: "currentColor"
    }, "settings-spark", index);
  });
  return svg;
}

function renderKeyRoundIcon(): SVGSVGElement {
  const svg = createIconSvg("key-round");
  const motion = appendSvg(svg, "g", {}, "key-motion");
  appendSvg(motion, "path", {
    d: KEY_ROUND_PATH,
    "stroke-dasharray": 140,
    "stroke-dashoffset": 0
  }, "key-path");
  const bite = appendSvg(motion, "g", {}, "key-bite");
  appendSvg(bite, "path", { d: KEY_ROUND_BITE_PATH });
  appendSvg(motion, "circle", {
    cx: 16.5,
    cy: 7.5,
    r: 0.5,
    fill: "currentColor"
  }, "key-head");
  return svg;
}

function renderLayoutListIcon(): SVGSVGElement {
  const svg = createIconSvg("layout-list");
  [3, 14].forEach((y, index) => {
    appendSvg(svg, "rect", {
      width: 7,
      height: 7,
      x: 3,
      y,
      rx: 1
    }, "layout-box", index);
  });
  [4, 9, 15, 20].forEach((y, index) => {
    appendSvg(svg, "path", { d: `M14 ${y}h7` }, "layout-line", index);
  });
  return svg;
}

function renderBookOpenCheckIcon(): SVGSVGElement {
  const svg = createIconSvg("book-open-check");
  appendSvg(svg, "path", {
    d: "M12 21V7",
    pathLength: 1
  }, "book-spine");
  appendSvg(svg, "path", {
    d: "m16 12 2 2 4-4",
    pathLength: 1
  }, "book-check");
  appendSvg(svg, "path", {
    d: "M22 6V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4 4 4 0 0 0-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6a1 1 0 0 0 1-1v-1.3"
  }, "book-body");
  return svg;
}

function renderClipboardCheckIcon(): SVGSVGElement {
  const svg = createIconSvg("clipboard-check");
  appendSvg(svg, "rect", {
    width: 8,
    height: 4,
    x: 8,
    y: 2,
    rx: 1,
    ry: 1,
    "stroke-dasharray": 60,
    "stroke-dashoffset": 0
  }, "clipboard-clip");
  appendSvg(svg, "path", {
    d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "stroke-dasharray": 240,
    "stroke-dashoffset": 0
  }, "clipboard-body");
  appendSvg(svg, "path", {
    d: "m9 14 2 2 4-4",
    pathLength: 1
  }, "clipboard-check");
  return svg;
}

function createIconSvg(iconName: AnimatedSettingsTabIconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  setSvgAttributes(svg, {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    "data-animateicons-source": "lucide",
    "data-animateicons-icon": iconName
  });
  return svg;
}

function appendSvg<K extends keyof SVGElementTagNameMap>(
  parent: SVGElement,
  tagName: K,
  attributes: Readonly<Record<string, string | number>>,
  part?: string,
  index?: number
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tagName);
  setSvgAttributes(element, attributes);
  if (part) element.setAttribute("data-part", part);
  if (index !== undefined) element.setAttribute("data-index", String(index));
  parent.appendChild(element);
  return element;
}

function setSvgAttributes(
  element: SVGElement,
  attributes: Readonly<Record<string, string | number>>
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

const SETTINGS_GEAR_PATH =
  "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915";

const KEY_ROUND_PATH =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z";

const KEY_ROUND_BITE_PATH =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172";
