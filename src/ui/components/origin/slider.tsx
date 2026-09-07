// Adapted from MIT Origin UI; see third-party/origin-ui/LICENSE.md.
import { Slider as SliderPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./utils";

/** Origin's primitive composition, without its optional tooltip branch. */
function Slider({ className, defaultValue, value, min = 0, max = 100, ...props }:
  React.ComponentProps<typeof SliderPrimitive.Root>) {
  const values = value ?? defaultValue ?? [min];
  return (
    <SliderPrimitive.Root
      className={cn("relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50", className)}
      data-slot="slider" defaultValue={defaultValue} value={value} min={min} max={max} {...props}
    >
      <SliderPrimitive.Track className="relative grow overflow-hidden rounded-full bg-muted" data-slot="slider-track">
        <SliderPrimitive.Range className="absolute bg-primary" data-slot="slider-range" />
      </SliderPrimitive.Track>
      {values.map((_, index) => <SliderPrimitive.Thumb key={index}
        className="block shrink-0 rounded-full border border-primary bg-background outline-none"
        data-slot="slider-thumb" />)}
    </SliderPrimitive.Root>
  );
}
export { Slider };
