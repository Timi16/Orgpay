const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7.5V12l3 2",
  draft: "M5 19h4L19.5 8.5a2.1 2.1 0 0 0-3-3L6 16v3zM14.5 7.5l2 2",
  pen: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 8.5l2 2",
  ban: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM5.6 5.6l12.8 12.8",
  alert: "M12 4l9 16H3zM12 10v4M12 17v.01",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v5M12 8v.01",
  send: "M4 12l16-8-6 16-3-7z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  people: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7M18 14a5 5 0 0 1 4 5v2",
  payroll: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 15.5h3",
  wallets: "M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM3 10h18M16 14.5h2",
  keys: "M8 11a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM11 12l8-8M16 7l2 2",
  settings: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  external: "M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5",
  back: "M15 6l-6 6 6 6",
  forward: "M9 6l6 6-6 6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16.5 16.5L21 21",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  shield: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
  folder: "M3 6h6l2 2h10v11H3z",
  archive: "M4 5h16v4H4zM5 9v10h14V9M10 13h4",
  restore: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
  freighter: "M12 3l7 4v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V7zM9 12l2 2 4-4",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
} as const;

export type AnyIcon = keyof typeof PATHS;

interface IconProps {
  name: AnyIcon;
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

/** Inline stroke icon, coloured by the surrounding text. Decorative: pair it with a label. */
export function Icon({ name, size = 18, strokeWidth = 2, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...style }}>
      <path d={PATHS[name]} />
    </svg>
  );
}
