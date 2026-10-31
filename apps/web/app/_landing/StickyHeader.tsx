"use client";

import { useEffect, useState } from "react";

/** The landing header: sticks to the top and takes a frosted background once the page has scrolled. */
export function StickyHeader({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    // In-page links glide instead of jumping, unless the visitor asked for less motion.
    const root = document.documentElement;
    const before = root.style.scrollBehavior;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) root.style.scrollBehavior = "smooth";
    return () => {
      window.removeEventListener("scroll", onScroll);
      root.style.scrollBehavior = before;
    };
  }, []);

  return (
    <header className="l-header" data-scrolled={scrolled}>
      {children}
    </header>
  );
}
