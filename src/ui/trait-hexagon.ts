/**
 * TraitHexagon — SVG radar/hexagon chart for six personality dimensions.
 *
 * Adapted from amicro MonoRoundedRadarChart visual language:
 * - Monochrome palette following Obsidian theme
 * - Rounded container with inset stage
 * - Polar grid rings + axis spokes + filled polygon
 * - Axis labels at each vertex
 *
 * Pure vanilla TS + SVG. No React, no charting library.
 */

import type { TraitDimension } from "../harness/memory/personal-memory-contracts";
import { TRAIT_DIMENSIONS } from "../harness/memory/personal-memory-contracts";

export interface TraitHexagonData {
  readonly dimension: TraitDimension;
  readonly score: number; // 0-1
  readonly label: string;
}

export interface TraitHexagonOptions {
  /** Size of the SVG in pixels (square). Default 240. */
  readonly size?: number;
  /** Number of concentric grid rings. Default 4. */
  readonly rings?: number;
  /** Whether to show the baseline overlay (initial template scores). */
  readonly baselineScores?: Readonly<Record<TraitDimension, number>>;
}

const DEFAULT_SIZE = 240;
const DEFAULT_RINGS = 4;
const PADDING = 36; // space for labels around the hexagon

/** Dimension labels in Chinese for display. */
const DIMENSION_LABELS: Record<TraitDimension, string> = {
  tempo: "节奏",
  energy: "能量",
  mind: "思维",
  warmth: "温度",
  order: "秩序",
  stance: "立场",
};

/** Left-pole and right-pole labels for each dimension. */
const DIMENSION_POLES: Record<TraitDimension, [string, string]> = {
  tempo: ["急性子", "慢条斯理"],
  energy: ["外向热烈", "内向安静"],
  mind: ["天马行空", "脚踏实地"],
  warmth: ["理性冷静", "感性共情"],
  order: ["规矩严谨", "随性灵活"],
  stance: ["随和配合", "坚持主见"],
};

export function getDimensionLabel(dim: TraitDimension): string {
  return DIMENSION_LABELS[dim];
}

export function getDimensionPoles(dim: TraitDimension): readonly [string, string] {
  return DIMENSION_POLES[dim];
}

/**
 * Render the trait hexagon into a container element.
 * Returns the SVG element for further manipulation if needed.
 */
export function renderTraitHexagon(
  container: HTMLElement,
  scores: Readonly<Record<TraitDimension, number>>,
  options: TraitHexagonOptions = {}
): SVGSVGElement {
  const size = options.size ?? DEFAULT_SIZE;
  const rings = options.rings ?? DEFAULT_RINGS;
  const center = size / 2;
  const radius = center - PADDING;
  const dims = TRAIT_DIMENSIONS;
  const n = dims.length;
  const angleStep = (2 * Math.PI) / n;
  // Start from top (-π/2) so first dimension is at 12 o'clock
  const startAngle = -Math.PI / 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass("echoink-trait-hexagon");

  // --- Grid rings ---
  for (let ring = 1; ring <= rings; ring++) {
    const r = (radius * ring) / rings;
    const points = dims
      .map((_, i) => {
        const angle = startAngle + i * angleStep;
        return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
      })
      .join(" ");
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", points);
    polygon.addClass("echoink-trait-hexagon-grid");
    svg.appendChild(polygon);
  }

  // --- Axis spokes ---
  for (let i = 0; i < n; i++) {
    const angle = startAngle + i * angleStep;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(center));
    line.setAttribute("y1", String(center));
    line.setAttribute("x2", String(center + radius * Math.cos(angle)));
    line.setAttribute("y2", String(center + radius * Math.sin(angle)));
    line.addClass("echoink-trait-hexagon-spoke");
    svg.appendChild(line);
  }

  // --- Baseline polygon (optional, from template) ---
  if (options.baselineScores) {
    const baselinePoints = dims
      .map((dim, i) => {
        const score = clamp01(options.baselineScores![dim]);
        const r = radius * score;
        const angle = startAngle + i * angleStep;
        return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
      })
      .join(" ");
    const baselinePoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    baselinePoly.setAttribute("points", baselinePoints);
    baselinePoly.addClass("echoink-trait-hexagon-baseline");
    svg.appendChild(baselinePoly);
  }

  // --- Current score polygon ---
  const scorePoints = dims
    .map((dim, i) => {
      const score = clamp01(scores[dim]);
      const r = radius * score;
      const angle = startAngle + i * angleStep;
      return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
    })
    .join(" ");
  const scorePoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  scorePoly.setAttribute("points", scorePoints);
  scorePoly.addClass("echoink-trait-hexagon-score");
  svg.appendChild(scorePoly);

  // --- Score dots at vertices ---
  for (let i = 0; i < n; i++) {
    const dim = dims[i];
    const score = clamp01(scores[dim]);
    const r = radius * score;
    const angle = startAngle + i * angleStep;
    const cx = center + r * Math.cos(angle);
    const cy = center + r * Math.sin(angle);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "3");
    dot.addClass("echoink-trait-hexagon-dot");
    svg.appendChild(dot);
  }

  // --- Axis labels ---
  for (let i = 0; i < n; i++) {
    const dim = dims[i];
    const angle = startAngle + i * angleStep;
    const labelR = radius + 18;
    const lx = center + labelR * Math.cos(angle);
    const ly = center + labelR * Math.sin(angle);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(lx));
    text.setAttribute("y", String(ly));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.addClass("echoink-trait-hexagon-label");
    text.textContent = DIMENSION_LABELS[dim];
    svg.appendChild(text);
  }

  container.appendChild(svg);
  return svg;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
