export type EchoInkAnimateIconName =
  | "upload"
  | "send-horizontal"
  | "circle-stop"
  | "mic"
  | "users"
  | "user-round-pen";

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
    focusable: "false",
    "data-animateicons-source": "lucide",
    "data-animateicons-icon": name,
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
  } else if (name === "mic") {
    svg.append(
      path("M12 19v3"),
      path("M19 10v2a7 7 0 0 1-14 0v-2"),
      rect("9", "2", "6", "13", "3")
    );
  } else if (name === "users") {
    const primary = document.createElementNS(SVG_NS, "g");
    primary.setAttribute("class", "echoink-animate-users-primary");
    const primaryArc = path(
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
      "echoink-animate-users-primary-arc"
    );
    setAttributes(primaryArc, { "stroke-dasharray": "50", "stroke-dashoffset": "50" });
    const primaryHead = circle("9", "7", "4", "echoink-animate-users-primary-head");
    primary.append(primaryArc, primaryHead);
    const secondary = document.createElementNS(SVG_NS, "g");
    secondary.setAttribute("class", "echoink-animate-users-secondary");
    const secondaryHead = path(
      "M16 3.128a4 4 0 0 1 0 7.744",
      "echoink-animate-users-secondary-head"
    );
    const secondaryArc = path(
      "M22 21v-2a4 4 0 0 0-3-3.87",
      "echoink-animate-users-secondary-arc"
    );
    setAttributes(secondaryHead, { "stroke-dasharray": "40", "stroke-dashoffset": "40" });
    setAttributes(secondaryArc, { "stroke-dasharray": "40", "stroke-dashoffset": "40" });
    secondary.append(secondaryHead, secondaryArc);
    svg.append(primary, secondary);
  } else {
    const person = document.createElementNS(SVG_NS, "g");
    person.setAttribute("class", "echoink-animate-user-round-pen-person");
    const body = path("M2 21a8 8 0 0 1 10.821-7.487", "echoink-animate-user-round-pen-body");
    setAttributes(body, { "stroke-dasharray": "60", "stroke-dashoffset": "60" });
    person.append(body, circle("10", "8", "5", "echoink-animate-user-round-pen-head"));
    const pen = path(
      "M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
      "echoink-animate-user-round-pen-tool"
    );
    svg.append(person, pen);
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
