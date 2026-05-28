import { RGBA } from "@opentui/core";

/**
 * Linearly interpolate between two RGBA colors.
 *
 * Used by the post / ambient layers to fade text toward the theme background
 * without relying on opentui's `opacity` property — which composites against
 * the renderer's internal bg (transparent black), giving wrong-looking fades
 * on light terminals. By lerping fg directly toward `COLORS.bg`, the fade
 * lands on whatever the active theme considers "invisible," and the renderer
 * never has to paint a solid background (so terminal translucency survives).
 *
 * `t` is clamped to [0, 1]. Alpha is lerped too, in case callers ever need it
 * (currently both endpoints are opaque so this is a no-op).
 */
export function lerpRgba(from: RGBA, to: RGBA, t: number): RGBA {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return RGBA.fromValues(
    from.r + (to.r - from.r) * clamped,
    from.g + (to.g - from.g) * clamped,
    from.b + (to.b - from.b) * clamped,
    from.a + (to.a - from.a) * clamped,
  );
}
