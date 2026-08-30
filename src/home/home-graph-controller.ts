import type { ForceGraph3DInstance } from "3d-force-graph";
import {
  EMPTY_HOME_GRAPH_FILTERS,
  filterHomeGraph,
  homeGraphNodeVisualValue,
  type HomeGraphData,
  type HomeGraphFilterResult,
  type HomeGraphFilters,
  type HomeGraphNode,
  type HomeGraphLink
} from "./home-workbench-model";

export type HomeGraphFallback = "none" | "list";

export interface HomeGraphControllerOptions {
  onSelect: (nodeId: string) => void;
  onOpen: (nodeId: string) => void;
  onFallbackChange?: (fallback: HomeGraphFallback, reason: string) => void;
}

interface VisualNode extends HomeGraphNode {
  index?: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

interface VisualLink extends Omit<HomeGraphLink, "source" | "target"> {
  source: string | VisualNode;
  target: string | VisualNode;
  index?: number;
}

const EMPTY_GRAPH: HomeGraphData = {
  nodes: [],
  links: [],
  nodeById: new Map(),
  options: { folders: [], properties: [], tags: [] }
};

/**
 * Obsidian-native lifecycle wrapper for 3d-force-graph@1.80.0 (MIT).
 * The renderer is mounted once per Home view. Data, filters, theme and size
 * update the existing instance; dispose owns every listener and WebGL resource.
 */
export class HomeGraphController {
  private host: HTMLElement | null = null;
  private graphLayer: HTMLElement | null = null;
  private graph: ForceGraph3DInstance<VisualNode, VisualLink> | null = null;
  private graphData: HomeGraphData = EMPTY_GRAPH;
  private filters: HomeGraphFilters = cloneFilters(EMPTY_HOME_GRAPH_FILTERS);
  private filterResult: HomeGraphFilterResult = filterHomeGraph(EMPTY_GRAPH, this.filters);
  private visualNodes = new Map<string, VisualNode>();
  private selectedId: string | null = null;
  private fallback: HomeGraphFallback = "none";
  private fallbackReason = "";
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private reducedMotion: MediaQueryList | null = null;
  private visible = document.visibilityState !== "hidden";
  private inViewport = true;
  private disposed = false;
  private mountGeneration = 0;
  private rendererCanvas: HTMLCanvasElement | null = null;

  constructor(private readonly options: HomeGraphControllerOptions) {}

  async mount(host: HTMLElement): Promise<HomeGraphFallback> {
    if (this.host === host && this.graph) return this.fallback;
    if (this.host && this.host !== host) this.dispose();
    this.disposed = false;
    this.host = host;
    host.empty();
    host.addClass("echoink-home-graph-runtime");
    this.graphLayer = host.createDiv({ cls: "echoink-home-graph-webgl" });
    this.bindLifecycle();
    const generation = ++this.mountGeneration;
    try {
      const { default: ForceGraph3D } = await import("3d-force-graph");
      if (this.disposed || generation !== this.mountGeneration || !this.graphLayer) return this.fallback;
      const graph = new ForceGraph3D(this.graphLayer, {
        controlType: "orbit",
        rendererConfig: { alpha: true, antialias: true, powerPreference: "high-performance" }
      }) as ForceGraph3DInstance<VisualNode, VisualLink>;
      this.graph = graph;
      graph
        .showNavInfo(false)
        .nodeId("id")
        .linkSource("source")
        .linkTarget("target")
        .numDimensions(3)
        .nodeLabel((node) => `${node.title}\n${node.path}`)
        .nodeVal((node) => homeGraphNodeVisualValue(node))
        .nodeResolution(12)
        .nodeOpacity(0.92)
        .linkOpacity(0.22)
        .linkWidth((link) => Math.min(2.2, 0.4 + Math.sqrt(link.count) * 0.3))
        .warmupTicks(36)
        .cooldownTicks(140)
        .enableNodeDrag(true)
        .enableNavigationControls(true)
        .onNodeClick((node) => {
          this.setSelected(node.id);
          this.options.onSelect(node.id);
          this.options.onOpen(node.id);
        });
      const canvas = this.graphLayer.querySelector<HTMLCanvasElement>("canvas");
      if (!canvas) throw new Error("图谱渲染器没有创建可用画布");
      this.rendererCanvas = canvas;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "知识图谱，可拖动旋转、滚动缩放并选择节点");
      canvas.addEventListener("webglcontextlost", this.handleContextLost, { passive: false });
      this.applyTheme();
      this.applyData();
      this.resize();
      this.syncVisibility();
      this.setFallback("none", "");
    } catch (error) {
      this.failToList(error instanceof Error ? error.message : String(error));
    }
    return this.fallback;
  }

  updateData(data: HomeGraphData): HomeGraphFilterResult {
    this.graphData = data;
    this.filterResult = filterHomeGraph(data, this.filters);
    this.applyData();
    return this.filterResult;
  }

  updateFilters(filters: HomeGraphFilters): HomeGraphFilterResult {
    this.filters = cloneFilters(filters);
    this.filterResult = filterHomeGraph(this.graphData, this.filters);
    this.applyData();
    return this.filterResult;
  }

  setSelected(nodeId: string | null): void {
    this.selectedId = nodeId && this.filterResult.matchedIds.has(nodeId) ? nodeId : null;
    this.applyTheme();
  }

  focusNode(nodeId: string): boolean {
    const node = this.visualNodes.get(nodeId);
    if (!node || !this.graph || node.x === undefined || node.y === undefined || node.z === undefined) return false;
    this.setSelected(nodeId);
    this.options.onSelect(nodeId);
    const distance = 88;
    const length = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + distance / length;
    this.graph.resumeAnimation();
    this.graph.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      { x: node.x, y: node.y, z: node.z },
      this.prefersReducedMotion() ? 0 : 650
    );
    return true;
  }

  resetCamera(): void {
    if (!this.graph) return;
    this.graph.resumeAnimation();
    this.graph.zoomToFit(this.prefersReducedMotion() ? 0 : 550, 48);
  }

  refreshTheme(): void {
    this.applyTheme();
  }

  getFilterResult(): HomeGraphFilterResult {
    return this.filterResult;
  }

  getFallback(): HomeGraphFallback {
    return this.fallback;
  }

  getFallbackReason(): string {
    return this.fallbackReason;
  }

  dispose(): void {
    this.disposed = true;
    this.mountGeneration += 1;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.themeObserver = null;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.reducedMotion?.removeEventListener("change", this.handleReducedMotionChange);
    this.reducedMotion = null;
    this.destroyGraph();
    this.graphLayer?.remove();
    this.host?.removeClass("echoink-home-graph-runtime");
    this.host = null;
    this.graphLayer = null;
    this.visualNodes.clear();
    this.selectedId = null;
    this.visible = document.visibilityState !== "hidden";
    this.inViewport = true;
  }

  private applyData(): void {
    if (!this.graph || this.fallback === "list") return;
    const nextIds = new Set(this.filterResult.nodes.map((node) => node.id));
    for (const id of this.visualNodes.keys()) {
      if (!nextIds.has(id)) this.visualNodes.delete(id);
    }
    const nodes = this.filterResult.nodes.map((node) => {
      const existing = this.visualNodes.get(node.id);
      if (existing) {
        Object.assign(existing, node);
        return existing;
      }
      const visual: VisualNode = { ...node };
      this.visualNodes.set(node.id, visual);
      return visual;
    });
    const links = this.filterResult.links.map<VisualLink>((link) => ({ ...link }));
    try {
      this.graph.graphData({ nodes, links });
      this.applyTheme();
      if (this.isVisible()) this.graph.resumeAnimation();
      else this.graph.pauseAnimation();
    } catch (error) {
      this.failToList(error instanceof Error ? error.message : String(error));
    }
  }

  private applyTheme(): void {
    if (!this.graph || !this.host) return;
    const theme = readGraphTheme(this.host);
    try {
      this.graph
        .backgroundColor("rgba(0,0,0,0)")
        .nodeColor((node) => node.id === this.selectedId ? theme.selected : theme.node)
        .linkColor(theme.link)
        .nodeLabel((node) => `${node.title}\n${node.path}`);
    } catch (error) {
      this.failToList(error instanceof Error ? error.message : String(error));
    }
  }

  private bindLifecycle(): void {
    if (!this.host) return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.inViewport = Boolean(entry?.isIntersecting);
      this.syncVisibility();
    }, { threshold: 0 });
    this.intersectionObserver.observe(this.host);
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.handleReducedMotionChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private resize(): void {
    if (!this.graph || !this.host) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    try {
      this.graph.width(width).height(height);
    } catch (error) {
      this.failToList(error instanceof Error ? error.message : String(error));
    }
  }

  private syncVisibility(): void {
    if (!this.graph) return;
    if (this.isVisible()) this.graph.resumeAnimation();
    else this.graph.pauseAnimation();
  }

  private isVisible(): boolean {
    return this.visible && this.inViewport && !this.disposed;
  }

  private prefersReducedMotion(): boolean {
    return Boolean(this.reducedMotion?.matches);
  }

  private failToList(reason: string): void {
    if (reason) console.warn("[EchoInk] Home graph switched to the accessible list:", reason);
    this.setFallback("list", "已切换到可筛选的笔记列表，仍可继续选择和打开笔记。");
    this.destroyGraph();
    this.graphLayer?.hide();
  }

  private setFallback(fallback: HomeGraphFallback, reason: string): void {
    if (this.fallback === fallback && this.fallbackReason === reason) return;
    this.fallback = fallback;
    this.fallbackReason = reason;
    this.options.onFallbackChange?.(fallback, reason);
    if (fallback === "none") this.graphLayer?.show();
  }

  private destroyGraph(): void {
    this.rendererCanvas?.removeEventListener("webglcontextlost", this.handleContextLost);
    this.rendererCanvas = null;
    if (!this.graph) return;
    const graph = this.graph;
    this.graph = null;
    try { graph.pauseAnimation(); } catch { /* best-effort cleanup */ }
    try { graph._destructor(); } catch { /* best-effort cleanup */ }
    this.graphLayer?.empty();
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.failToList("图谱运行环境已中断，已切换到笔记列表");
  };

  private readonly handleVisibilityChange = (): void => {
    this.visible = document.visibilityState !== "hidden";
    this.syncVisibility();
  };

  private readonly handleReducedMotionChange = (): void => {
    this.applyTheme();
  };
}

function cloneFilters(filters: HomeGraphFilters): HomeGraphFilters {
  return {
    search: filters.search,
    folders: [...filters.folders],
    properties: filters.properties.map((filter) => ({ ...filter })),
    tags: [...filters.tags]
  };
}

function readGraphTheme(host: HTMLElement): { node: string; selected: string; link: string } {
  const style = getComputedStyle(host);
  const text = style.getPropertyValue("--text-normal").trim() || style.color;
  return {
    node: style.getPropertyValue("--interactive-accent").trim() || text,
    selected: style.getPropertyValue("--text-accent").trim() || text,
    link: style.getPropertyValue("--background-modifier-border-hover").trim()
      || style.getPropertyValue("--background-modifier-border").trim()
      || text
  };
}
