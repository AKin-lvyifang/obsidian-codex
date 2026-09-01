import { motion } from "framer-motion";

export interface OrigamiShapeProps {
  active?: boolean;
  reducedMotion?: boolean;
}

/** Adapted from Amicro Origami Shape; the two opposing rotateY folds retain the upstream algorithm. */
export function OrigamiShape({ active = true, reducedMotion = false }: OrigamiShapeProps) {
  const animate = active && !reducedMotion ? { rotateY: [0, 180, 0] } : { rotateY: 0 };
  const transition = active && !reducedMotion
    ? { duration: 2, repeat: Infinity, ease: "easeInOut" as const }
    : { duration: 0 };
  return (
    <span className="echoink-home-amicro-origami" aria-hidden="true">
      <motion.span
        className="echoink-home-amicro-origami-fold is-first"
        animate={animate}
        style={{ transformOrigin: "right" }}
        transition={transition}
      />
      <motion.span
        className="echoink-home-amicro-origami-fold is-second"
        animate={animate}
        style={{ transformOrigin: "left" }}
        transition={transition}
      />
    </span>
  );
}
