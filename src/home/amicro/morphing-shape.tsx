import { motion } from "framer-motion";

export interface MorphingShapeProps {
  active?: boolean;
  reducedMotion?: boolean;
}

/** Adapted from Amicro Morphing Shape; the upstream radius/rotate/scale sequence is unchanged. */
export function MorphingShape({ active = true, reducedMotion = false }: MorphingShapeProps) {
  const animate = active && !reducedMotion
    ? {
        borderRadius: ["10%", "50%", "10%"],
        rotate: [0, 90, 180],
        scale: [1, 0.8, 1]
      }
    : { borderRadius: "24%", rotate: 0, scale: 1 };
  return (
    <motion.span
      className="echoink-home-amicro-morphing-shape"
      aria-hidden="true"
      animate={animate}
      transition={active && !reducedMotion
        ? { duration: 2, repeat: Infinity, ease: "easeInOut" }
        : { duration: 0 }}
    />
  );
}
