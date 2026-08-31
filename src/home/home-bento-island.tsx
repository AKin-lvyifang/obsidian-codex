import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedShinyText } from "./magic-ui/animated-shiny-text";
import { BentoGrid } from "./magic-ui/bento-grid";
import { HOME_ENTRY_ICON_SHAPES } from "./home-brand-icons";
import type { HomeEntryId } from "./home-workbench-model";

export interface HomeBentoDetailNode {
  tag: "div" | "small" | "span";
  className?: string;
  text?: string;
  children?: readonly HomeBentoDetailNode[];
}

export interface HomeBentoEntryViewModel {
  id: HomeEntryId;
  label: string;
  ariaLabel: string;
  kicker?: string;
  details: readonly HomeBentoDetailNode[];
  cta: string;
  onActivate: () => void | Promise<void>;
}

export interface HomeBentoIsland {
  render(entries: readonly HomeBentoEntryViewModel[]): void;
  unmount(): void;
}

export function createHomeBentoIsland(host: HTMLElement): HomeBentoIsland {
  const root = createRoot(host);
  return {
    render: (entries) => root.render(<HomeBentoEntries entries={entries} />),
    unmount: () => root.unmount()
  };
}

function HomeBentoEntries({ entries }: { entries: readonly HomeBentoEntryViewModel[] }) {
  return (
    <BentoGrid className="echoink-home-bento-grid">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`echoink-home-entry is-${entry.id}`}
          aria-label={entry.ariaLabel}
          onClick={() => void entry.onActivate()}
        >
          <span className="echoink-home-entry-icon">
            <HomeBrandIcon id={entry.id} />
          </span>
          <div className="echoink-home-entry-copy">
            {entry.kicker ? <span className="echoink-home-entry-kicker">{entry.kicker}</span> : null}
            <strong>{entry.label}</strong>
            {entry.details.map((node, index) => renderDetailNode(node, `${entry.id}-${index}`))}
          </div>
          <span className="echoink-home-entry-cta">
            <AnimatedShinyText className="echoink-home-shiny-text mx-0">
              {entry.cta} →
            </AnimatedShinyText>
          </span>
        </button>
      ))}
    </BentoGrid>
  );
}

function HomeBrandIcon({ id }: { id: HomeEntryId }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {HOME_ENTRY_ICON_SHAPES[id].map((shape, index) => createElement(shape.tag, {
        ...shape.attrs,
        key: `${shape.tag}-${index}`
      }))}
    </svg>
  );
}

function renderDetailNode(node: HomeBentoDetailNode, key: string): ReactElement {
  return createElement(
    node.tag,
    { key, className: node.className },
    node.children?.length
      ? node.children.map((child, index) => renderDetailNode(child, `${key}-${index}`))
      : node.text
  );
}
