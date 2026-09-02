import { motion } from "framer-motion";

export interface TypingProps {
  text: string;
  active?: boolean;
  reducedMotion?: boolean;
}

/** Adapted from Amicro Typing; the upstream text-and-blinking-cursor composition is unchanged. */
export function Typing({ text, active = true, reducedMotion = false }: TypingProps) {
  return (
    <span className="echoink-home-amicro-title" aria-hidden="true">
      <span>{text}</span>
      <motion.span
        className="echoink-home-amicro-cursor"
        animate={active && !reducedMotion ? { opacity: [1, 0, 1] } : { opacity: 1 }}
        transition={active && !reducedMotion
          ? { duration: 0.8, repeat: Infinity, ease: "linear" }
          : { duration: 0 }}
      />
    </span>
  );
}
