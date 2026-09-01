import { motion } from "framer-motion";

export interface TextShimmerWaveProps {
  text: string;
  active?: boolean;
  reducedMotion?: boolean;
}

/**
 * Adapted from Amicro Text Shimmer Wave at the pinned commit recorded in SOURCE.json.
 * The upstream opacity/y wave is unchanged; props only provide product copy and lifecycle control.
 */
export function TextShimmerWave({
  text,
  active = true,
  reducedMotion = false
}: TextShimmerWaveProps) {
  const animate = active && !reducedMotion
    ? { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }
    : { opacity: 1, y: 0 };
  return (
    <span className="echoink-home-amicro-title" aria-hidden="true">
      {Array.from(text).map((char, index) => (
        <motion.span
          key={`${char}-${index}`}
          animate={animate}
          transition={active && !reducedMotion
            ? { duration: 1.5, repeat: Infinity, delay: index * 0.1, ease: "easeInOut" }
            : { duration: 0 }}
        >
          {char}
        </motion.span>
      ))}
    </span>
  );
}
