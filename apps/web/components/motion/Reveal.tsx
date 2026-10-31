"use client";

import { createElement, useEffect, useRef, useState } from "react";

interface Props {
  children: React.ReactNode;
  /** Delay in ms once it scrolls into view. */
  delay?: number;
  /** Where it comes from. */
  from?: "below" | "left" | "right" | "scale";
  className?: string;
  style?: React.CSSProperties;
  as?: "div" | "section" | "li" | "span";
}

const HIDDEN: Record<NonNullable<Props["from"]>, string> = {
  below: "translateY(28px)",
  left: "translateX(-32px)",
  right: "translateX(32px)",
  scale: "scale(0.92)",
};

/** Reveals its children when they scroll into view. Visible straight away with reduced motion or no observer. */
export function Reveal({ children, delay = 0, from = "below", className, style, as: Tag = "div" }: Props) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"static" | "hidden" | "shown">("static");

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) return; // already on screen: leave it be
    setState("hidden");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setState("shown");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const motion: React.CSSProperties =
    state === "hidden"
      ? { opacity: 0, transform: HIDDEN[from] }
      : state === "shown"
        ? { opacity: 1, transform: "none", transition: `opacity 0.7s cubic-bezier(0.2,0.8,0.2,1) ${delay}ms, transform 0.7s cubic-bezier(0.2,0.8,0.2,1) ${delay}ms` }
        : {};
  return createElement(Tag, { ref, className, style: { ...style, ...motion } }, children);
}
