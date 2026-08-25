export type EchoInkAnimateIconName =
  | "upload"
  | "send-horizontal"
  | "circle-stop"
  | "mic";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Dependency-free DOM rendering of the pinned Animate Icons lucide sources.
 * Motion is supplied by styles.css so hover, keyboard focus, and reduced-motion
 * behavior stay consistent in Obsidian's plain DOM UI.
 */
export function renderAnimateIcon(
  container: HTMLElement,
  name: EchoInkAnimateIconName
): SVGSVGElement {
  container.classList.add("echoink-animate-icon-host", `is-${name}-icon`);
  const svg = document.createElementNS(SVG_NS, "svg");
  setAttributes(svg, {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: `echoink-animate-icon echoink-animate-icon-${name}`
  });

  if (name === "upload") {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "echoink-animate-upload-group");
    group.append(
      path("M12 3v12", "echoink-animate-upload-shaft"),
      path("m17 8-5-5-5 5", "echoink-animate-upload-head"),
      path("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "echoink-animate-upload-tray")
    );
    svg.append(group);
  } else if (name === "send-horizontal") {
    svg.append(
      path(
        "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z",
        "echoink-animate-send-horizontal-shell"
      ),
      path("M6 12h16", "echoink-animate-send-horizontal-line")
    );
  } else if (name === "circle-stop") {
    svg.append(
      circle("12", "12", "10", "echoink-animate-circle-stop-ring"),
      rect("9", "9", "6", "6", "1", "echoink-animate-circle-stop-symbol")
    );
  } else {
    svg.append(
      path("M12 19v3"),
      path("M19 10v2a7 7 0 0 1-14 0v-2"),
      rect("9", "2", "6", "13", "3")
    );
  }

  container.append(svg);
  return svg;
}

function path(data: string, className?: string): SVGPathElement {
  const element = document.createElementNS(SVG_NS, "path");
  element.setAttribute("d", data);
  if (className) element.setAttribute("class", className);
  return element;
}

function circle(
  cx: string,
  cy: string,
  r: string,
  className?: string
): SVGCircleElement {
  const element = document.createElementNS(SVG_NS, "circle");
  setAttributes(element, { cx, cy, r });
  if (className) element.setAttribute("class", className);
  return element;
}

function rect(
  x: string,
  y: string,
  width: string,
  height: string,
  rx: string,
  className?: string
): SVGRectElement {
  const element = document.createElementNS(SVG_NS, "rect");
  setAttributes(element, { x, y, width, height, rx });
  if (className) element.setAttribute("class", className);
  return element;
}

function setAttributes(element: Element, attributes: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}
