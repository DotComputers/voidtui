export const ACCENT_PALETTE = {
  cyan:    "#22d3ee",
  amber:   "#fbbf24",
  magenta: "#e879f9",
  violet:  "#a78bfa",
  white:   "#ffffff",
} as const;

export type AccentName = keyof typeof ACCENT_PALETTE;

/** Cycle order used by the accent picker (matches palette declaration). */
export const ACCENT_NAMES: AccentName[] = [
  "cyan",
  "amber",
  "magenta",
  "violet",
  "white",
];
