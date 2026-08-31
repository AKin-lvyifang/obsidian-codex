import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marquee } from "./magic-ui/marquee";

export interface HomeRecentThoughtViewModel {
  path: string;
  folder: string;
  title: string;
  relativeTime: string;
}

export interface HomeRecentIsland {
  render(records: readonly HomeRecentThoughtViewModel[]): void;
  unmount(): void;
}

export function createHomeRecentIsland(
  host: HTMLElement,
  onOpen: (path: string) => void | Promise<void>
): HomeRecentIsland {
  const root = createRoot(host);
  return {
    render: (records) => root.render(<HomeRecentThoughts records={records} onOpen={onOpen} />),
    unmount: () => root.unmount()
  };
}

function HomeRecentThoughts({
  records,
  onOpen
}: {
  records: readonly HomeRecentThoughtViewModel[];
  onOpen: (path: string) => void | Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const split = Math.max(1, Math.ceil(records.length / 2));
  const firstRow = records.slice(0, split);
  const secondRow = records.slice(split);
  const rows = records.length === 1
    ? [{ records: firstRow, tabbable: true }, { records: firstRow, tabbable: false }]
    : [{ records: firstRow, tabbable: true }, { records: secondRow, tabbable: true }];

  useMarqueeAccessibility(viewportRef, rows.map((row) => row.tabbable), reducedMotion);
  useHorizontalDrag(viewportRef);

  if (!records.length) {
    return <div className="echoink-home-empty">还没有可继续的 Markdown 思路。</div>;
  }

  return (
    <div ref={viewportRef} className="echoink-home-marquee" aria-label="最近编辑的本地思路">
      {rows.map((row, rowIndex) => (
        <Marquee
          key={rowIndex}
          reverse={rowIndex === 1}
          pauseOnHover
          repeat={reducedMotion ? 1 : 4}
          className="echoink-home-marquee-track w-full [--duration:20s] [--gap:1rem]"
        >
          {row.records.map((record) => (
            <button
              key={record.path}
              type="button"
              className="echoink-home-thought"
              title={record.title}
              data-path={record.path}
              tabIndex={-1}
              onClick={() => void onOpen(record.path)}
            >
              <span className="echoink-home-thought-folder">{record.folder}</span>
              <strong>{record.title}</strong>
              <span>{record.relativeTime}</span>
            </button>
          ))}
        </Marquee>
      ))}
      <div className="echoink-home-marquee-fade is-left" aria-hidden="true" />
      <div className="echoink-home-marquee-fade is-right" aria-hidden="true" />
    </div>
  );
}

function useMarqueeAccessibility(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  tabbableRows: readonly boolean[],
  reducedMotion: boolean
): void {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const tracks = viewport.querySelectorAll<HTMLElement>(".echoink-home-marquee-track");
    tracks.forEach((track, rowIndex) => {
      Array.from(track.children).forEach((group, repeatIndex) => {
        const accessible = Boolean(tabbableRows[rowIndex]) && repeatIndex === 0;
        if (accessible) group.removeAttribute("aria-hidden");
        else group.setAttribute("aria-hidden", "true");
        group.querySelectorAll<HTMLButtonElement>("button[data-path]").forEach((button) => {
          button.tabIndex = accessible ? 0 : -1;
        });
      });
    });
  }, [reducedMotion, tabbableRows, viewportRef]);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useHorizontalDrag(viewportRef: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let pointerId: number | null = null;
    let startX = 0;
    let startScroll = 0;
    let moved = false;
    let suppressClick = false;
    const onPointerDown = (event: PointerEvent) => {
      pointerId = event.pointerId;
      startX = event.clientX;
      startScroll = viewport.scrollLeft;
      moved = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const distance = event.clientX - startX;
      if (!moved && Math.abs(distance) >= 6) {
        moved = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add("is-dragging");
      }
      if (moved) {
        event.preventDefault();
        viewport.scrollLeft = startScroll - distance;
      }
    };
    const stop = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      suppressClick = moved;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      pointerId = null;
      viewport.classList.remove("is-dragging");
      window.setTimeout(() => { suppressClick = false; }, 0);
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    };
    viewport.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    viewport.addEventListener("click", onClickCapture, { capture: true });
    return () => {
      if (pointerId !== null && viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      viewport.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      viewport.removeEventListener("click", onClickCapture, { capture: true });
    };
  }, [viewportRef]);
}
