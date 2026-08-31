import {
  EMPTY_HOME_GRAPH_FILTERS,
  aggregateHomeGraph,
  filterHomeGraph,
  selectHomeGraphNeighborhood,
  type HomeGraphData,
  type HomeGraphAggregateNode,
  type HomeGraphFilterResult,
  type HomeGraphFilters,
  type HomeGraphLink,
  type HomeGraphNode
} from "./home-workbench-model";

export type HomeGraphFallback = "none" | "list";
export type HomeGraphScope = "local" | "global";
export type HomeGraphMotionMode = "stable" | "breathe" | "free";
export type HomeGraphRuntimeState = "running" | "paused" | "sleeping";

export interface HomeGraphRuntimeStats {
  nodes: number;
  links: number;
  totalNotes: number;
  fps: number;
  scope: HomeGraphScope;
  hops: 1 | 2 | 3;
  state: HomeGraphRuntimeState;
  status: string;
  sleepStatus: string;
}

export interface HomeGraphControllerOptions {
  onSelect: (nodeId: string | null) => void;
  onFallbackChange?: (fallback: HomeGraphFallback, reason: string) => void;
  onStatsChange?: (stats: HomeGraphRuntimeStats) => void;
}

export interface HomeGraphSidebarItem {
  id: string;
  title: string;
  detail: string;
  noteId: string;
  aggregate: boolean;
}

export interface HomeGraphSleepStep {
  fade: number;
  deepSleep: boolean;
}

interface VisualNode {
  id: string;
  title: string;
  path: string;
  cluster: string;
  degree: number;
  count: number;
  noteIds: string[];
  aggregate: boolean;
  depth: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

interface VisualLink {
  source: VisualNode;
  target: VisualNode;
  count: number;
}

const EMPTY_GRAPH: HomeGraphData = {
  nodes: [], links: [], nodeById: new Map(), options: { folders: [], properties: [], tags: [] }
};
const ALPHA_DECAY = 0.984;
const ALPHA_STOP = 0.004;
const SLEEP_FADE_MS = 2_000;

/** Dependency-free Canvas graph with bounded force simulation and real sleep. */
export class HomeGraphController {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private graphData: HomeGraphData = EMPTY_GRAPH;
  private filters: HomeGraphFilters = cloneFilters(EMPTY_HOME_GRAPH_FILTERS);
  private filterResult = filterHomeGraph(EMPTY_GRAPH, this.filters);
  private visualNodes: VisualNode[] = [];
  private visualLinks: VisualLink[] = [];
  private visualNodeById = new Map<string, VisualNode>();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private fallback: HomeGraphFallback = "none";
  private fallbackReason = "";
  private scope: HomeGraphScope = "local";
  private hops: 1 | 2 | 3 = 2;
  private motionMode: HomeGraphMotionMode = "breathe";
  private amplitude = 1;
  private sleepAfterMs = 180_000;
  private pauseOnHover = true;
  private blurSleep = true;
  private blurred = false;
  private focusGraceUntil = 0;
  private sleepFade = 1;
  private deepSleep = false;
  private alpha = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private rafId: number | null = null;
  private lastFrame = 0;
  private lastInteraction = performance.now();
  private frameCount = 0;
  private fpsWindowStarted = performance.now();
  private fps = 0;
  private runtimeState: HomeGraphRuntimeState = "running";
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private reducedMotion: MediaQueryList | null = null;
  private visible = document.visibilityState !== "hidden";
  private inViewport = true;
  private disposed = false;
  private pointerId: number | null = null;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private startOffsetX = 0;
  private startOffsetY = 0;
  private draggedNode: VisualNode | null = null;
  private pointerMoved = false;
  private sleepTimer: number | null = null;
  private sleepReason = "长时间无操作";

  constructor(private readonly options: HomeGraphControllerOptions) {}

  async mount(host: HTMLElement): Promise<HomeGraphFallback> {
    if (this.host === host && this.canvas) return this.fallback;
    if (this.host && this.host !== host) this.dispose();
    this.disposed = false;
    this.host = host;
    host.empty();
    host.addClass("echoink-home-graph-runtime");
    const canvas = host.createEl("canvas", {
      cls: "echoink-home-graph-canvas",
      attr: {
        role: "img",
        "aria-label": "当前 Vault 的知识图谱。可拖动画布、滚轮缩放、选择节点，并从右侧真实笔记入口打开文件。"
      }
    });
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      this.failToList("浏览器没有提供 Canvas 2D 上下文");
      return this.fallback;
    }
    this.canvas = canvas;
    this.context = context;
    this.bindLifecycle();
    this.bindPointerEvents();
    this.resize();
    this.rebuildProjection();
    this.setFallback("none", "");
    this.wake();
    return this.fallback;
  }

  updateData(data: HomeGraphData): HomeGraphFilterResult {
    this.graphData = data;
    this.filterResult = filterHomeGraph(data, this.filters);
    this.rebuildProjection();
    return this.filterResult;
  }

  updateFilters(filters: HomeGraphFilters): HomeGraphFilterResult {
    this.filters = cloneFilters(filters);
    this.filterResult = filterHomeGraph(this.graphData, this.filters);
    this.rebuildProjection();
    return this.filterResult;
  }

  setScope(scope: HomeGraphScope): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = scope === "global" ? 0.85 : 1;
    this.rebuildProjection();
  }

  setHops(hops: 1 | 2 | 3): void {
    if (hops === this.hops) return;
    this.hops = hops;
    if (this.scope === "local") this.rebuildProjection();
    else this.emitStats();
  }

  setMotionMode(mode: HomeGraphMotionMode): void {
    this.motionMode = mode;
    this.alpha = Math.max(this.alpha, mode === "free" ? 0.6 : 0.35);
    this.wake();
  }

  setAmplitude(amplitude: number): void {
    this.amplitude = Math.max(0, Math.min(3, amplitude));
    this.wake();
  }

  setSleepAfter(ms: number): void {
    this.sleepAfterMs = Math.max(0, ms);
    this.wake();
  }

  setPauseOnHover(enabled: boolean): void {
    this.pauseOnHover = enabled;
    if (!enabled && this.runtimeState === "paused") this.wake();
  }

  setBlurSleep(enabled: boolean): void {
    this.blurSleep = enabled;
    if (!enabled && this.blurred) this.wake();
  }

  setSelected(nodeId: string | null): void {
    this.selectedId = nodeId && this.filterResult.matchedIds.has(nodeId) ? nodeId : null;
    if (this.scope === "local") this.rebuildProjection();
    else this.draw();
  }

  focusNode(nodeId: string): boolean {
    if (!this.filterResult.matchedIds.has(nodeId)) return false;
    this.selectedId = nodeId;
    this.scope = "local";
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;
    this.rebuildProjection();
    this.options.onSelect(nodeId);
    this.wake();
    return true;
  }

  resetCamera(): void {
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.seedPositions(true);
    this.alpha = Math.max(this.alpha, 0.55);
    this.wake();
  }

  refreshTheme(): void { this.draw(); }
  getFilterResult(): HomeGraphFilterResult { return this.filterResult; }
  getFallback(): HomeGraphFallback { return this.fallback; }
  getFallbackReason(): string { return this.fallbackReason; }
  getScope(): HomeGraphScope { return this.scope; }

  getSidebarItems(): HomeGraphSidebarItem[] {
    if (this.scope === "global") {
      return aggregateHomeGraph(this.filterResult.nodes, this.filterResult.links).nodes
        .slice(0, 14)
        .map((node: HomeGraphAggregateNode) => ({
          id: node.id,
          title: node.title,
          detail: `${node.count} 篇`,
          noteId: node.noteIds[0] ?? "",
          aggregate: true
        }))
        .filter((item) => item.noteId);
    }
    return this.getRelatedNodes().slice(0, 16).map((node) => ({
      id: node.id,
      title: node.title,
      detail: node.cluster,
      noteId: node.id,
      aggregate: false
    }));
  }

  getRelatedNodes(nodeId: string | null = this.selectedId): HomeGraphNode[] {
    if (!nodeId) return [];
    const related = new Map<string, number>();
    for (const link of this.filterResult.links) {
      if (link.source === nodeId) related.set(link.target, (related.get(link.target) ?? 0) + link.count);
      if (link.target === nodeId) related.set(link.source, (related.get(link.source) ?? 0) + link.count);
    }
    return [...related.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([id]) => this.graphData.nodeById.get(id))
      .filter((node): node is HomeGraphNode => Boolean(node));
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver = null;
    if (this.sleepTimer !== null) window.clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.reducedMotion?.removeEventListener("change", this.handleReducedMotionChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("blur", this.handleWindowBlur);
    window.removeEventListener("focus", this.handleWindowFocus);
    for (const eventName of ["mousemove", "mousedown", "wheel", "keydown"] as const) {
      window.removeEventListener(eventName, this.handleActivity);
    }
    this.unbindPointerEvents();
    this.canvas?.remove();
    this.host?.removeClass("echoink-home-graph-runtime");
    this.host = null;
    this.canvas = null;
    this.context = null;
    this.visualNodes = [];
    this.visualLinks = [];
    this.visualNodeById.clear();
  }

  private rebuildProjection(): void {
    const previous = this.visualNodeById;
    const previousSelectedId = this.selectedId;
    const projected: Array<Omit<VisualNode, "x" | "y" | "vx" | "vy" | "fx" | "fy">> = [];
    let links: readonly HomeGraphLink[];
    if (this.scope === "local") {
      if (!this.selectedId || !this.filterResult.matchedIds.has(this.selectedId)) {
        this.selectedId = [...this.filterResult.nodes]
          .sort((left, right) => right.degree - left.degree || right.mtime - left.mtime)[0]?.id ?? null;
      }
      const local = selectHomeGraphNeighborhood(
        this.filterResult.nodes, this.filterResult.links, this.selectedId, this.hops, 260
      );
      const depths = calculateDepths(local.nodes, local.links, this.selectedId);
      for (const node of local.nodes) {
        projected.push({
          id: node.id, title: node.title, path: node.path, cluster: node.cluster,
          degree: node.degree, count: 1, noteIds: [node.id], aggregate: false,
          depth: depths.get(node.id) ?? this.hops
        });
      }
      links = local.links;
    } else {
      const aggregate = aggregateHomeGraph(this.filterResult.nodes, this.filterResult.links);
      for (const node of aggregate.nodes) {
        projected.push({
          id: node.id, title: node.title, path: `${node.count} 篇笔记`, cluster: node.cluster,
          degree: node.count, count: node.count, noteIds: node.noteIds, aggregate: true,
          depth: indexDepth(aggregate.nodes.indexOf(node))
        });
      }
      links = aggregate.links;
    }
    this.visualNodes = projected.map((node, index) => {
      const old = previous.get(node.id);
      const angle = this.scope === "global"
        ? index / Math.max(1, projected.length) * Math.PI * 2
        : seededUnit(node.id) * Math.PI * 2;
      const spread = this.scope === "global"
        ? 260 + seededUnit(`${node.id}:radius`) * 90
        : node.depth === 0 ? 0 : 60 + seededUnit(`${node.id}:radius`) * 90;
      return {
        ...node,
        x: old?.x ?? Math.cos(angle) * spread,
        y: old?.y ?? Math.sin(angle) * spread,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      };
    });
    this.visualNodeById = new Map(this.visualNodes.map((node) => [node.id, node]));
    this.visualLinks = links.flatMap((link) => {
      const source = this.visualNodeById.get(link.source);
      const target = this.visualNodeById.get(link.target);
      return source && target ? [{ source, target, count: link.count }] : [];
    });
    this.alpha = 1;
    if (previousSelectedId !== this.selectedId) this.options.onSelect(this.selectedId);
    this.emitStats();
    this.wake();
  }

  private seedPositions(force: boolean): void {
    this.visualNodes.forEach((node, index) => {
      if (!force && Number.isFinite(node.x) && Number.isFinite(node.y)) return;
      const angle = this.scope === "global"
        ? index / Math.max(1, this.visualNodes.length) * Math.PI * 2
        : seededUnit(node.id) * Math.PI * 2;
      const radius = this.scope === "global"
        ? 260 + seededUnit(`${node.id}:reset`) * 90
        : node.depth === 0 ? 0 : 60 + seededUnit(`${node.id}:reset`) * 90;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
      node.fx = null;
      node.fy = null;
    });
  }

  private stepSimulation(): void {
    if (this.alpha < ALPHA_STOP || this.prefersReducedMotion()) return;
    const kRep = this.scope === "local" ? 1400 : 9000;
    let rest = this.scope === "local" ? 74 : 150;
    let kSpr = 0.045;
    let kCen = 0.010;
    const damp = 0.84;
    if (this.motionMode === "free") {
      kSpr = 0.014;
      rest = this.scope === "local" ? 100 : 190;
      kCen = 0.004;
    }
    for (let leftIndex = 0; leftIndex < this.visualNodes.length; leftIndex += 1) {
      const left = this.visualNodes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < this.visualNodes.length; rightIndex += 1) {
        const right = this.visualNodes[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1) {
          distanceSquared = 1;
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = kRep / distanceSquared;
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        left.vx -= fx; left.vy -= fy; right.vx += fx; right.vy += fy;
      }
    }
    for (const link of this.visualLinks) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - rest) * kSpr;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      link.source.vx += fx; link.source.vy += fy; link.target.vx -= fx; link.target.vy -= fy;
    }
    const floor = this.motionMode === "stable" ? 0 : this.motionMode === "breathe" ? 0.05 : 0.15;
    const jitter = (this.motionMode === "stable" ? 0 : this.motionMode === "breathe" ? 0.46 : 1.40)
      * this.amplitude * this.sleepFade;
    const bound = this.scope === "local" ? 330 : 430;
    for (const node of this.visualNodes) {
      node.vx -= node.x * kCen;
      node.vy -= node.y * kCen;
      const distance = Math.hypot(node.x, node.y);
      if (distance > bound) {
        node.vx -= node.x / distance * (distance - bound) * 0.03;
        node.vy -= node.y / distance * (distance - bound) * 0.03;
      }
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= damp;
      node.vy *= damp;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > 24) {
        node.vx = node.vx / speed * 24;
        node.vy = node.vy / speed * 24;
      }
      node.x += node.vx * this.alpha + (Math.random() - 0.5) * jitter;
      node.y += node.vy * this.alpha + (Math.random() - 0.5) * jitter;
    }
    this.alpha = this.motionMode === "stable"
      ? this.alpha * ALPHA_DECAY
      : Math.max(this.alpha * ALPHA_DECAY, floor);
  }

  private draw(): void {
    if (!this.context) return;
    const theme = readGraphTheme(this.host);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
    const screenX = (x: number) => (x - this.offsetX) * this.scale + this.width / 2;
    const screenY = (y: number) => (y - this.offsetY) * this.scale + this.height / 2;
    const neighbors = new Set<string>();
    if (this.hoveredId) {
      neighbors.add(this.hoveredId);
      const hovered = this.visualNodeById.get(this.hoveredId);
      if (hovered && !hovered.aggregate) {
        for (const link of this.visualLinks) {
          if (link.source.id === hovered.id) neighbors.add(link.target.id);
          if (link.target.id === hovered.id) neighbors.add(link.source.id);
        }
      }
    }
    this.context.lineWidth = Math.max(0.4, 0.7 * this.scale);
    for (const link of this.visualLinks) {
      const lit = Boolean(this.hoveredId && neighbors.has(link.source.id) && neighbors.has(link.target.id));
      this.context.beginPath();
      this.context.moveTo(screenX(link.source.x), screenY(link.source.y));
      this.context.lineTo(screenX(link.target.x), screenY(link.target.y));
      this.context.strokeStyle = theme.link;
      this.context.globalAlpha = this.hoveredId ? lit ? 0.55 : 0.05 : 0.13;
      this.context.stroke();
    }
    for (const node of this.visualNodes) {
      const radius = ((this.scope === "local" ? 3.2 : 6)
        + Math.sqrt(node.degree) * (this.scope === "local" ? 1.5 : 2.6))
        * Math.max(0.55, Math.min(1.5, this.scale));
      const x = screenX(node.x);
      const y = screenY(node.y);
      const dimmed = Boolean(this.hoveredId && !neighbors.has(node.id));
      this.context.globalAlpha = dimmed ? 0.18 : 1;
      const depthColors = [theme.vermilion, theme.tealDeep, theme.teal, theme.tealMid];
      this.context.fillStyle = node.id === this.selectedId && this.scope === "local"
        ? depthColors[0]
        : depthColors[Math.min(3, node.depth)];
      this.context.beginPath();
      this.context.arc(x, y, radius, 0, Math.PI * 2);
      this.context.fill();
      if (node.fx !== null) {
        this.context.strokeStyle = theme.vermilion;
        this.context.lineWidth = 1.5;
        this.context.stroke();
      }
      if (this.scale > 0.75 && !dimmed && (radius > 4.5 || node.depth === 0 || this.scope === "global")) {
        this.context.fillStyle = node.depth === 0 && this.scope === "local" ? theme.vermilion : theme.label;
        this.context.font = `${node.depth === 0 ? "500 " : ""}${node.depth === 0 ? 12 : 11}px -apple-system, "PingFang SC", sans-serif`;
        this.context.textAlign = "center";
        this.context.textBaseline = "alphabetic";
        this.context.fillText(node.title + (this.scope === "global" ? `  ${node.degree}` : ""), x, y - radius - 5);
      }
      this.context.globalAlpha = 1;
    }
  }

  private readonly frame = (now: number): void => {
    this.rafId = null;
    if (this.disposed) return;
    const delta = Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;
    this.frameCount += 1;
    if (now - this.fpsWindowStarted >= 500) {
      this.fps = Math.round(this.frameCount * 1000 / Math.max(1, now - this.fpsWindowStarted));
      this.frameCount = 0;
      this.fpsWindowStarted = now;
      this.emitStats();
    }
    const drowsy = this.isDrowsy(now);
    const sleepStep = advanceHomeGraphSleep(this.sleepFade, delta, drowsy, this.prefersReducedMotion());
    this.sleepFade = sleepStep.fade;
    if (drowsy) this.ensureSleepTimer();
    else this.clearSleepTimer();
    if (sleepStep.deepSleep) {
      this.enterDeepSleep();
      return;
    }
    this.deepSleep = false;
    if (!this.visible || !this.inViewport) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    if (this.prefersReducedMotion()) {
      this.runtimeState = "paused";
      this.draw();
      this.emitStats();
      return;
    }
    const frozen = this.pauseOnHover && Boolean(this.hoveredId || this.draggedNode);
    if (!frozen && this.alpha > ALPHA_STOP) this.stepSimulation();
    this.draw();
    this.runtimeState = frozen || (this.motionMode === "stable" && this.alpha <= ALPHA_STOP) ? "paused" : "running";
    this.rafId = requestAnimationFrame(this.frame);
  };

  private wake(): void {
    if (this.disposed) return;
    this.lastInteraction = performance.now();
    this.clearSleepTimer();
    this.deepSleep = false;
    this.runtimeState = "running";
    const now = performance.now();
    if (shouldRestartHomeGraphLoop(this.rafId, this.lastFrame, now)) {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.lastFrame = now;
      this.fpsWindowStarted = now;
      this.frameCount = 0;
      this.rafId = requestAnimationFrame(this.frame);
    }
    this.emitStats();
  }

  private isDrowsy(now: number): boolean {
    if (!this.visible) {
      this.sleepReason = "页面不可见";
      return true;
    }
    if (!this.inViewport) {
      this.sleepReason = "图谱离开可视区";
      return true;
    }
    if (now < this.focusGraceUntil) return false;
    if (this.blurSleep && this.blurred) {
      this.sleepReason = "窗口未激活";
      return true;
    }
    if (this.sleepAfterMs > 0 && now - this.lastInteraction > this.sleepAfterMs) {
      this.sleepReason = "长时间无操作";
      return true;
    }
    return false;
  }

  private ensureSleepTimer(): void {
    if (this.sleepTimer !== null || this.deepSleep) return;
    this.sleepTimer = window.setTimeout(() => {
      this.sleepTimer = null;
      if (this.isDrowsy(performance.now())) this.enterDeepSleep();
    }, SLEEP_FADE_MS);
  }

  private clearSleepTimer(): void {
    if (this.sleepTimer === null) return;
    window.clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  private enterDeepSleep(): void {
    this.clearSleepTimer();
    this.stopAnimation();
    this.deepSleep = true;
    this.sleepFade = 0;
    this.runtimeState = "sleeping";
    this.fps = 0;
    this.draw();
    this.emitStats();
  }

  private stopAnimation(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }


  private emitStats(): void {
    this.options.onStatsChange?.({
      nodes: this.visualNodes.length,
      links: this.visualLinks.length,
      totalNotes: this.filterResult.totalCount,
      fps: this.fps,
      scope: this.scope,
      hops: this.hops,
      state: this.runtimeState,
      status: this.runtimeStatus(),
      sleepStatus: formatHomeGraphSleepStatus(
        this.sleepAfterMs,
        this.lastInteraction,
        performance.now(),
        this.deepSleep
      )
    });
  }

  private runtimeStatus(): string {
    if (this.deepSleep) return `已休眠（${this.sleepReason}）· 任意输入唤醒`;
    if (this.pauseOnHover && this.hoveredId) return "已暂停 · 移开节点恢复";
    if (this.motionMode === "stable" && this.alpha <= ALPHA_STOP) {
      return `已凝固 · ${this.visualNodes.length} 节点 · 停止计算`;
    }
    const warm = this.motionMode === "stable" ? 0.05 : this.motionMode === "breathe" ? 0.055 : 0.16;
    if (this.alpha > warm) return `降温排列中 ${Math.round((1 - this.alpha) * 100)}%`;
    return `${this.motionMode === "breathe" ? "恒温呼吸中" : "自由飘动中"} · ${this.visualNodes.length} 节点`;
  }

  private bindLifecycle(): void {
    if (!this.host) return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.inViewport = Boolean(entry?.isIntersecting);
      if (this.inViewport) this.wake();
      else this.ensureSleepTimer();
    }, { threshold: 0 });
    this.intersectionObserver.observe(this.host);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.handleReducedMotionChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("blur", this.handleWindowBlur);
    window.addEventListener("focus", this.handleWindowFocus);
    for (const eventName of ["mousemove", "mousedown", "wheel", "keydown"] as const) {
      window.addEventListener(eventName, this.handleActivity, { passive: true });
    }
  }

  private resize(): void {
    if (!this.canvas || !this.host) return;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.seedPositions(false);
    this.draw();
    this.alpha = Math.max(this.alpha, 0.2);
    this.wake();
  }

  private bindPointerEvents(): void {
    if (!this.canvas) return;
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("pointerenter", this.handlePointerEnter);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private unbindPointerEvents(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("pointerenter", this.handlePointerEnter);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.canvas) return;
    this.pointerId = event.pointerId;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
    this.startOffsetX = this.offsetX;
    this.startOffsetY = this.offsetY;
    this.pointerMoved = false;
    const hit = this.hitNode(event);
    this.draggedNode = hit && event.shiftKey ? hit : null;
    if (this.draggedNode) {
      this.draggedNode.fx = this.draggedNode.x;
      this.draggedNode.fy = this.draggedNode.y;
      this.alpha = Math.max(this.alpha, 0.4);
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.wake();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.wake();
    const hit = this.hitNode(event);
    if (!this.draggedNode && this.pointerId === null) this.hoveredId = hit?.id ?? null;
    if (this.canvas) this.canvas.style.cursor = hit ? "pointer" : this.pointerId === null ? "grab" : "grabbing";
    if (this.pointerId !== event.pointerId) { this.draw(); return; }
    const dx = event.clientX - this.pointerStartX;
    const dy = event.clientY - this.pointerStartY;
    if (Math.hypot(dx, dy) >= 6) this.pointerMoved = true;
    if (this.draggedNode) {
      const point = this.toWorld(event);
      this.draggedNode.fx = point.x; this.draggedNode.fy = point.y;
      this.alpha = Math.max(this.alpha, 0.35);
    } else {
      this.offsetX = this.startOffsetX - dx / this.scale;
      this.offsetY = this.startOffsetY - dy / this.scale;
    }
    this.wake();
    this.draw();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    const hit = this.hitNode(event);
    if (!this.pointerMoved && hit) {
      const nextId = hit.aggregate ? hit.noteIds[0] : hit.id;
      if (nextId && (this.scope === "global" || nextId !== this.selectedId)) {
        this.scope = "local";
        this.selectedId = nextId;
        this.offsetX = 0;
        this.offsetY = 0;
        this.scale = 1;
        this.rebuildProjection();
        this.options.onSelect(nextId);
      }
    }
    this.pointerId = null;
    this.draggedNode = null;
    if (this.canvas?.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.wake();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    const before = this.toWorld(event);
    this.scale *= event.deltaY < 0 ? 1.12 : 0.89;
    this.scale = Math.max(0.25, Math.min(4, this.scale));
    const after = this.toWorld(event);
    this.offsetX += before.x - after.x;
    this.offsetY += before.y - after.y;
    this.wake();
    this.draw();
  };

  private readonly handlePointerEnter = (): void => {
    this.wake();
  };

  private readonly handlePointerLeave = (): void => {
    this.hoveredId = null;
    this.pointerId = null;
    this.draggedNode = null;
    this.wake();
  };

  private toWorld(event: MouseEvent | PointerEvent): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left - this.width / 2) / this.scale + this.offsetX,
      y: (event.clientY - rect.top - this.height / 2) / this.scale + this.offsetY
    };
  }

  private hitNode(event: MouseEvent | PointerEvent): VisualNode | null {
    const point = this.toWorld(event);
    for (let index = this.visualNodes.length - 1; index >= 0; index -= 1) {
      const node = this.visualNodes[index];
      const radius = ((this.scope === "local" ? 3.2 : 6)
        + Math.sqrt(node.degree) * (this.scope === "local" ? 1.5 : 2.6))
        * Math.max(0.55, Math.min(1.5, this.scale));
      if (Math.hypot(point.x - node.x, point.y - node.y) * this.scale <= radius + 7) return node;
    }
    return null;
  }

  private prefersReducedMotion(): boolean { return Boolean(this.reducedMotion?.matches); }

  private failToList(reason: string): void {
    if (reason) console.warn("[EchoInk] Home graph switched to the accessible list:", reason);
    this.setFallback("list", "已切换到可筛选的笔记列表，仍可继续选择和打开笔记。");
    this.canvas?.hide();
  }

  private setFallback(fallback: HomeGraphFallback, reason: string): void {
    if (this.fallback === fallback && this.fallbackReason === reason) return;
    this.fallback = fallback;
    this.fallbackReason = reason;
    this.options.onFallbackChange?.(fallback, reason);
    if (fallback === "none") this.canvas?.show();
  }

  private readonly handleVisibilityChange = (): void => {
    this.visible = document.visibilityState !== "hidden";
    this.blurred = !this.visible;
    if (this.visible) {
      this.focusGraceUntil = performance.now() + 2_500;
      this.wake();
    } else {
      this.ensureSleepTimer();
    }
  };
  private readonly handleWindowBlur = (): void => {
    this.blurred = true;
    this.ensureSleepTimer();
  };
  private readonly handleWindowFocus = (): void => {
    this.blurred = false;
    this.focusGraceUntil = performance.now() + 2_500;
    this.wake();
  };
  private readonly handleActivity = (): void => this.wake();
  private readonly handleReducedMotionChange = (): void => {
    if (this.prefersReducedMotion()) {
      this.alpha = 0;
    } else if (this.motionMode !== "stable") {
      this.alpha = Math.max(this.alpha, this.motionMode === "breathe" ? 0.05 : 0.15);
      this.wake();
    }
    this.draw();
  };
}

export function advanceHomeGraphSleep(
  fade: number,
  deltaMs: number,
  drowsy: boolean,
  reducedMotion: boolean
): HomeGraphSleepStep {
  if (reducedMotion) return { fade: drowsy ? 0 : 1, deepSleep: drowsy };
  const delta = Math.max(0, deltaMs) / SLEEP_FADE_MS;
  const next = drowsy ? Math.max(0, fade - delta) : Math.min(1, fade + delta);
  return { fade: next, deepSleep: drowsy && next <= 0.002 };
}

export function shouldRestartHomeGraphLoop(
  rafId: number | null,
  lastFrame: number,
  now: number
): boolean {
  return rafId === null || now - lastFrame > 250;
}

export function formatHomeGraphSleepStatus(
  sleepAfterMs: number,
  lastInteraction: number,
  now: number,
  deepSleep: boolean
): string {
  if (sleepAfterMs <= 0) return "关闭";
  if (deepSleep) return "休眠中";
  const seconds = Math.max(0, Math.ceil((sleepAfterMs - (now - lastInteraction)) / 1_000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : `${seconds}s`;
}

function cloneFilters(filters: HomeGraphFilters): HomeGraphFilters {
  return {
    search: filters.search,
    folders: [...filters.folders],
    properties: filters.properties.map((filter) => ({ ...filter })),
    tags: [...filters.tags]
  };
}

function seededUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function calculateDepths(
  nodes: readonly HomeGraphNode[],
  links: readonly HomeGraphLink[],
  centerId: string | null
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  const depths = new Map<string, number>();
  if (!centerId || !adjacency.has(centerId)) return depths;
  const queue = [centerId];
  depths.set(centerId, 0);
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const neighbor of adjacency.get(current) ?? []) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, (depths.get(current) ?? 0) + 1);
      queue.push(neighbor);
    }
  }
  return depths;
}

function indexDepth(index: number): number {
  return index % 4;
}

function readGraphTheme(host: HTMLElement | null): {
  vermilion: string; tealDeep: string; teal: string; tealMid: string; link: string; label: string;
} {
  const style = getComputedStyle(host ?? document.body);
  const fallback = style.color || "#57544f";
  return {
    vermilion: style.getPropertyValue("--echoink-home-vermilion").trim() || fallback,
    tealDeep: style.getPropertyValue("--echoink-home-teal-deep").trim() || fallback,
    teal: style.getPropertyValue("--echoink-home-teal").trim() || fallback,
    tealMid: style.getPropertyValue("--echoink-home-teal-mid").trim() || fallback,
    link: style.getPropertyValue("--echoink-home-ink").trim() || fallback,
    label: style.getPropertyValue("--echoink-home-body").trim() || fallback
  };
}
