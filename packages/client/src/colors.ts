import type { AccentName } from "@void/shared";

// AccentName is the canonical type defined in @void/shared and used on the
// wire. We re-export here for backwards compatibility with existing client
// imports (most client code imports it from "./colors.ts").
export type { AccentName };

export const ACCENT_PALETTE: Record<AccentName, string> = {
  cyan:    "#22d3ee",
  amber:   "#fbbf24",
  magenta: "#e879f9",
  violet:  "#a78bfa",
  white:   "#ffffff",
};

/** Cycle order used by the accent picker (matches palette declaration). */
export const ACCENT_NAMES: AccentName[] = [
  "cyan",
  "amber",
  "magenta",
  "violet",
  "white",
];
