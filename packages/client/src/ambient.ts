import {
  TextRenderable,
  BoxRenderable,
  createTimeline,
  type CliRenderer,
} from "@opentui/core";
import { COLORS } from "./scene.ts";

/**
 * Persistent star field with per-star aging.
 *
 * The field starts populated. Each star has its own lifetime; when it ends
 * the star fades out and is replaced by a new one at a fresh position with a
 * fresh glyph. Lifetimes are randomized so deaths are staggered — the field
 * always looks full moment-to-moment, but evolves over minutes.
 *
 * During the middle of its life, each star twinkles: opacity oscillates
 * between MIN and MAX on a randomized period (so stars are never in sync).
 *
 * Opacity stays in 0.85-1.0 — even at trough, white still reads as white.
 */

const STAR_GLYPHS = ["★", "✦", "✶", "✷", "✧", "*", "·"];
const STAR_COUNT = 25;

const FADE_IN_MS = 2500;
const FADE_OUT_MS = 2500;

// Star lifetimes — drawn uniformly from this range. Includes fade phases.
const LIFETIME_MIN_MS = 30_000;
const LIFETIME_MAX_MS = 90_000;

// Twinkle period = half-cycle duration; alternate+loop ping-pongs.
const TWINKLE_MIN_PERIOD_MS = 3000;
const TWINKLE_MAX_PERIOD_MS = 7000;

const MIN_OPACITY = 0.85;
const MAX_OPACITY = 1.0;

const BOTTOM_RESERVED_ROWS = 4; // compose box (3) + status (1)

let nextStarId = 0;

type StarSlot = {
  id: string;
  star: TextRenderable;
  fadeTl?: ReturnType<typeof createTimeline>;
  twinkleTl?: ReturnType<typeof createTimeline>;
  deathTimer?: ReturnType<typeof setTimeout>;
  replaceTimer?: ReturnType<typeof setTimeout>;
};

export class Ambient {
  private renderer: CliRenderer;
  private surface: BoxRenderable;
  private slots = new Map<string, StarSlot>();
  private started = false;
  private paused = false;

  constructor(renderer: CliRenderer, surface: BoxRenderable) {
    this.renderer = renderer;
    this.surface = surface;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const slot of this.slots.values()) {
      if (paused) {
        slot.fadeTl?.pause();
        slot.twinkleTl?.pause();
      } else {
        slot.fadeTl?.play();
        slot.twinkleTl?.play();
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { width, height } = this.surfaceSize();
    if (width <= 1 || height <= 1) return;

    for (let i = 0; i < STAR_COUNT; i++) {
      // Stagger initial births slightly so first wave doesn't all-die together.
      const initialAge = Math.random() * LIFETIME_MAX_MS * 0.5;
      this.spawnStar(initialAge);
    }
  }

  stop(): void {
    for (const slot of this.slots.values()) {
      this.teardownSlot(slot);
    }
    this.slots.clear();
    this.started = false;
  }

  private surfaceSize(): { width: number; height: number } {
    const width = process.stdout.columns ?? 80;
    const height = (process.stdout.rows ?? 24) - BOTTOM_RESERVED_ROWS;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  /**
   * Spawn a new star. If `bornAgedMs` is set, the star is treated as if it
   * has already lived that many ms — used at startup to stagger the field so
   * the initial 25 don't all die at once.
   */
  private spawnStar(bornAgedMs = 0): void {
    if (!this.started) return;
    const { width, height } = this.surfaceSize();
    if (width <= 1 || height <= 1) return;

    const id = `star-${nextStarId++}`;
    const x = Math.floor(Math.random() * width);
    const y = Math.floor(Math.random() * height);
    const glyph = STAR_GLYPHS[Math.floor(Math.random() * STAR_GLYPHS.length)]!;

    const lifetime =
      LIFETIME_MIN_MS + Math.random() * (LIFETIME_MAX_MS - LIFETIME_MIN_MS);
    const twinklePeriod =
      TWINKLE_MIN_PERIOD_MS +
      Math.random() * (TWINKLE_MAX_PERIOD_MS - TWINKLE_MIN_PERIOD_MS);
    const initialOpacity =
      MIN_OPACITY + Math.random() * (MAX_OPACITY - MIN_OPACITY);

    const star = new TextRenderable(this.renderer, {
      id,
      content: glyph,
      fg: COLORS.star,
      position: "absolute",
      left: x,
      top: y,
      opacity: bornAgedMs > FADE_IN_MS ? initialOpacity : 0,
      zIndex: 1,
    });
    this.surface.add(star);

    const slot: StarSlot = { id, star };
    this.slots.set(id, slot);

    // Skip the fade-in for stars that "started life" already past it.
    if (bornAgedMs >= FADE_IN_MS) {
      this.beginTwinkle(slot, initialOpacity, twinklePeriod, lifetime, bornAgedMs);
    } else {
      this.beginFadeIn(slot, initialOpacity, twinklePeriod, lifetime);
    }
  }

  private beginFadeIn(
    slot: StarSlot,
    targetOpacity: number,
    twinklePeriod: number,
    lifetime: number,
  ): void {
    // OpenTUI Timeline.duration defaults to 1000ms — must pass explicitly
    // so the animation can finish before onComplete fires.
    const tl = createTimeline({
      duration: FADE_IN_MS,
      onComplete: () => {
        slot.fadeTl = undefined;
        this.beginTwinkle(slot, targetOpacity, twinklePeriod, lifetime, FADE_IN_MS);
      },
    });
    tl.add(slot.star, {
      duration: FADE_IN_MS,
      ease: "inOutSine",
      opacity: targetOpacity,
    });
    slot.fadeTl = tl;
    tl.play();
  }

  private beginTwinkle(
    slot: StarSlot,
    currentOpacity: number,
    twinklePeriod: number,
    lifetime: number,
    consumedMs: number,
  ): void {
    // Target the opposite end so the first half-cycle has a direction to go.
    const targetOpacity =
      currentOpacity >= (MIN_OPACITY + MAX_OPACITY) / 2
        ? MIN_OPACITY
        : MAX_OPACITY;

    // Timeline duration must be larger than any realistic session for the
    // looping twinkle animation to keep running. (Default 1000ms would stop
    // after a single second.)
    const tl = createTimeline({ duration: Number.MAX_SAFE_INTEGER });
    tl.add(slot.star, {
      duration: twinklePeriod,
      ease: "inOutSine",
      opacity: targetOpacity,
      loop: true,
      alternate: true,
    });
    slot.twinkleTl = tl;
    tl.play();

    const remaining = Math.max(0, lifetime - consumedMs - FADE_OUT_MS);
    slot.deathTimer = setTimeout(() => {
      slot.deathTimer = undefined;
      this.beginFadeOut(slot);
    }, remaining);
  }

  private beginFadeOut(slot: StarSlot): void {
    slot.twinkleTl?.pause();
    slot.twinkleTl = undefined;

    const tl = createTimeline({
      duration: FADE_OUT_MS,
      onComplete: () => {
        slot.fadeTl = undefined;
        this.replaceSlot(slot);
      },
    });
    tl.add(slot.star, {
      duration: FADE_OUT_MS,
      ease: "inOutSine",
      opacity: 0,
    });
    slot.fadeTl = tl;
    tl.play();
  }

  private replaceSlot(slot: StarSlot): void {
    // Tear down the dying slot.
    try {
      this.surface.remove(slot.id);
    } catch {
      // ignore
    }
    try {
      slot.star.destroy();
    } catch {
      // ignore
    }
    this.slots.delete(slot.id);

    // Spawn replacement after a short pause so respawns don't strobe.
    slot.replaceTimer = setTimeout(() => {
      if (this.started) this.spawnStar(0);
    }, 200 + Math.random() * 600);
  }

  private teardownSlot(slot: StarSlot): void {
    if (slot.deathTimer) clearTimeout(slot.deathTimer);
    if (slot.replaceTimer) clearTimeout(slot.replaceTimer);
    try {
      slot.fadeTl?.pause();
    } catch {}
    try {
      slot.twinkleTl?.pause();
    } catch {}
    try {
      slot.star.destroy();
    } catch {}
  }
}
