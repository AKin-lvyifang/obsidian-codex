/**
 * Native Obsidian adapter for Magic UI Flickering Grid.
 * Upstream: https://github.com/magicuidesign/magicui/blob/2d671cc6c0e0f40e28682c9cbddd16694dcfe627/apps/www/registry/magicui/flickering-grid.tsx
 * Fixed commit: 2d671cc6c0e0f40e28682c9cbddd16694dcfe627
 * Mapping: canvas + DPR + ResizeObserver + IntersectionObserver + Float32Array,
 * with document visibility and reduced-motion pauses added for the host lifecycle.
 */

export interface FlickeringGridOptions {
  squareSize?: number;
  gridGap?: number;
  flickerChance?: number;
  maxOpacity?: number;
  color?: string;
}

interface GridState {
  cols: number;
  rows: number;
  squares: Float32Array;
  dpr: number;
  width: number;
  height: number;
}

export class NativeFlickeringGrid {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly motionQuery: MediaQueryList;
  private readonly squareSize: number;
  private readonly gridGap: number;
  private readonly flickerChance: number;
  private readonly maxOpacity: number;
  private colorPrefix: string;
  private readonly themeObserver: MutationObserver;
  private frame: number | null = null;
  private state: GridState | null = null;
  private inView = false;
  private lastTime = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement, options: FlickeringGridOptions = {}) {
    this.squareSize = options.squareSize ?? 4;
    this.gridGap = options.gridGap ?? 6;
    this.flickerChance = options.flickerChance ?? 0.3;
    this.maxOpacity = options.maxOpacity ?? 0.3;
    this.canvas = container.createEl("canvas", {
      cls: "echoink-home-flickering-grid-canvas",
      attr: { "aria-hidden": "true" }
    });
    this.context = this.canvas.getContext("2d");
    this.colorPrefix = this.toRgbaPrefix(options.color ?? this.hostGridColor());
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.resizeObserver = new ResizeObserver(() => this.setupCanvas());
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.inView = Boolean(entry?.isIntersecting);
      this.syncAnimation();
    }, { threshold: 0 });
    this.themeObserver = new MutationObserver(() => {
      if (options.color) return;
      this.colorPrefix = this.toRgbaPrefix(this.hostGridColor());
      this.draw();
    });
    this.resizeObserver.observe(container);
    this.intersectionObserver.observe(this.canvas);
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    this.motionQuery.addEventListener("change", this.handleMotionChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.setupCanvas();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.themeObserver.disconnect();
    this.motionQuery.removeEventListener("change", this.handleMotionChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.canvas.remove();
  }

  private readonly handleMotionChange = (): void => {
    this.draw();
    this.syncAnimation();
  };

  private readonly handleVisibilityChange = (): void => {
    this.syncAnimation();
  };

  private setupCanvas(): void {
    if (this.disposed || !this.context) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const cols = Math.ceil(width / (this.squareSize + this.gridGap));
    const rows = Math.ceil(height / (this.squareSize + this.gridGap));
    const squares = new Float32Array(cols * rows);
    for (let index = 0; index < squares.length; index += 1) {
      squares[index] = Math.random() * this.maxOpacity;
    }
    this.state = { cols, rows, squares, dpr, width, height };
    this.draw();
    this.syncAnimation();
  }

  private syncAnimation(): void {
    const shouldAnimate = !this.disposed
      && this.inView
      && document.visibilityState !== "hidden"
      && !this.motionQuery.matches;
    if (!shouldAnimate) {
      this.stop();
      this.draw();
      return;
    }
    if (this.frame !== null) return;
    this.lastTime = performance.now();
    this.frame = window.requestAnimationFrame(this.animate);
  }

  private readonly animate = (time: number): void => {
    this.frame = null;
    if (!this.state || this.disposed || !this.inView || document.visibilityState === "hidden" || this.motionQuery.matches) {
      this.syncAnimation();
      return;
    }
    const deltaTime = Math.max(0, (time - this.lastTime) / 1000);
    this.lastTime = time;
    for (let index = 0; index < this.state.squares.length; index += 1) {
      if (Math.random() < this.flickerChance * deltaTime) {
        this.state.squares[index] = Math.random() * this.maxOpacity;
      }
    }
    this.draw();
    this.frame = window.requestAnimationFrame(this.animate);
  };

  private stop(): void {
    if (this.frame === null) return;
    window.cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private draw(): void {
    if (!this.context || !this.state) return;
    const { cols, rows, squares, dpr } = this.state;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const index = col * rows + row;
        const opacity = squares[index];
        this.context.fillStyle = `${this.colorPrefix}${opacity})`;
        this.context.fillRect(
          col * (this.squareSize + this.gridGap) * dpr,
          row * (this.squareSize + this.gridGap) * dpr,
          this.squareSize * dpr,
          this.squareSize * dpr
        );
      }
    }
  }

  private toRgbaPrefix(color: string): string {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const context = probe.getContext("2d");
    if (!context) return "rgba(127, 127, 127,";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = Array.from(context.getImageData(0, 0, 1, 1).data);
    return `rgba(${red}, ${green}, ${blue},`;
  }

  private hostGridColor(): string {
    const style = getComputedStyle(this.container);
    return style.getPropertyValue("--text-muted").trim() || style.color;
  }
}
