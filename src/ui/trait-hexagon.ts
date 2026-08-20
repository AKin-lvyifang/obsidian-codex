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
import { TRAIT_DIMENSION_META, traitBehaviorBand } from "../harness/memory/personality-templates";

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

/**
 * 图表、文字、模板和 Prompt 共享同一份维度常量（TRAIT_DIMENSION_META），
 * 不再维护重复的方向说明（做梦 PRD §13）。
 */
export function getDimensionLabel(dim: TraitDimension): string {
  return TRAIT_DIMENSION_META[dim].labelZh;
}

/** 六边形短标签（锋利/主导/较真/条理/果敢/创意）。 */
export function getDimensionShortLabel(dim: TraitDimension): string {
  return TRAIT_DIMENSION_META[dim].shortLabelZh;
}

/**
 * 当前行为档帮助函数（替代旧 getDimensionPoles）：返回该维度在当前分数下
 * 的行为档标签，例如 sharpness 0.75 → 「犀利」。
 */
export function getDimensionBandLabel(dim: TraitDimension, score: number): string {
  return traitBehaviorBand(dim, score).labelZh;
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
    // 短标签（锋利/主导/…）：中心=该特质表现较少，外圈=表现更多；
    // 面积不代表能力、智力或人格好坏。
    text.textContent = TRAIT_DIMENSION_META[dim].shortLabelZh;
    svg.appendChild(text);
  }

  container.appendChild(svg);
  return svg;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
