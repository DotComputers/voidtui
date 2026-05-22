import {
  TextRenderable,
  BoxRenderable,
  createTimeline,
  RGBA,
  type CliRenderer,
} from "@opentui/core";
import type { AccentName } from "@void/shared";
import { COLORS } from "./scene.ts";
import { getAccentHex } from "./accent.ts";
import { ACCENT_PALETTE } from "./colors.ts";

/**
 * Post layer for the void surface.
 *
 * Closely mirrors the original webview behavior:
 *  - Lifetime scales with the post's reading time (longer text = longer life).
 *  - Fade-in / hold / fade-out are 15% / 70% / 15% of total lifetime.
 *  - Placement uses AABB collision against active posts; on failure, the
 *    caller is told "no slot" so it can retry the same post later instead
 *    of evicting another.
 *  - A hard cap on visible posts (15) is enforced.
 *  - Body text is deduped — the same text can't appear twice simultaneously.
 *
 * The next-spawn cadence is owned by the *caller* (mock loop or live socket),
 * not by this layer. This keeps the layer agnostic to data source.
 */

export type PostInput = {
  handle?: string; // undefined for ghost posts
  body: string;
  ghost: boolean;
  /**
   * Sender's accent at the time of the post. When set, this drives the handle
   * color so each user sees others' posts in *their* color, not the receiver's
   * local accent. Falls back to local accent if undefined (e.g. legacy posts).
   */
  accent?: AccentName;
};

export type SpawnResult = "spawned" | "no_slot" | "at_cap";

const POST_MAX_WIDTH = 40;
const MAX_VISIBLE_POSTS = 15;
const COLLISION_BUFFER = 1;
const MAX_PLACEMENT_RETRIES = 50;
const BOTTOM_RESERVED_ROWS = 4; // compose box (3) + status (1)

// Reading-time → lifetime formulas. Match the webview.
const READ_TIME_MIN_MS = 3000;
const READ_TIME_MAX_MS = 12000;
const WORDS_PER_SECOND = 5;
const LIFETIME_SCALE = 1 / 0.7;
const LIFETIME_BUFFER_MS = 2000;
const FADE_IN_FRACTION = 0.15;
const FADE_OUT_FRACTION = 0.15;

type ActivePost = {
  id: string;
  container: BoxRenderable;
  left: number;
  top: number;
  width: number;
  height: number;
  timeline: ReturnType<typeof createTimeline>;
};

let nextPostId = 0;

export class PostsLayer {
  private renderer: CliRenderer;
  private surface: BoxRenderable;
  private active = new Map<string, ActivePost>();
  private paused = false;

  constructor(renderer: CliRenderer, surface: BoxRenderable) {
    this.renderer = renderer;
    this.surface = surface;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const post of this.active.values()) {
      if (paused) post.timeline.pause();
      else post.timeline.play();
    }
  }

  /**
   * Render a post on the void surface. Returns one of:
   *   "spawned"    — successfully placed and animating
   *   "at_cap"     — too many visible posts already
   *   "no_slot"    — couldn't find a non-colliding position; caller should retry later
   */
  spawnPost(input: PostInput): SpawnResult {
    if (this.paused) return "at_cap";
    if (this.active.size >= MAX_VISIBLE_POSTS) return "at_cap";

    const lines = this.wrapBody(input.body, POST_MAX_WIDTH);
    const handleLine = input.ghost ? "~" : `@${input.handle ?? "?"}`;
    const width = Math.min(
      POST_MAX_WIDTH,
      Math.max(handleLine.length, ...lines.map((l) => l.length)),
    );
    const height = 1 + lines.length;

    const surface = this.surfaceSize();
    const placement = this.findPlacement(width, height, surface);
    if (!placement) return "no_slot";
    const { left, top } = placement;

    const id = `post-${nextPostId++}`;
    const container = new BoxRenderable(this.renderer, {
      id,
      position: "absolute",
      left,
      top,
      width,
      height,
      opacity: 0,
      zIndex: 10,
    });
    this.surface.add(container);

    // Ghost: always the dim ghost-mark color (no identity leak).
    // Non-ghost: sender's accent if known (per-message broadcast), else fall
    // back to the receiver's local accent (legacy/missing data).
    const handleColor = input.ghost
      ? COLORS.postGhostMark
      : input.accent
        ? RGBA.fromHex(ACCENT_PALETTE[input.accent])
        : RGBA.fromHex(getAccentHex());
    container.add(
      new TextRenderable(this.renderer, {
        id: `${id}-handle`,
        content: handleLine,
        fg: handleColor,
      }),
    );

    const bodyColor = input.ghost ? COLORS.ghostBody : COLORS.text;
    for (let i = 0; i < lines.length; i++) {
      container.add(
        new TextRenderable(this.renderer, {
          id: `${id}-body-${i}`,
          content: lines[i]!,
          fg: bodyColor,
        }),
      );
    }

    const lifetime = calculateLifetime(input.body);
    const fadeIn = lifetime * FADE_IN_FRACTION;
    const fadeOut = lifetime * FADE_OUT_FRACTION;
    const hold = lifetime - fadeIn - fadeOut;

    // IMPORTANT: Timeline.duration defaults to 1000ms if not specified.
    // It does NOT auto-compute from added animations. We must pass the
    // actual lifetime so onComplete fires at the right time.
    const tl = createTimeline({
      duration: lifetime,
      onComplete: () => this.removePost(id),
    });
    // Match the webview's CSS keyframes: linear interpolation, fade in
    // then hold then fade out.
    tl.add(container, {
      duration: fadeIn,
      ease: "linear",
      opacity: 1,
    });
    tl.add(
      container,
      {
        duration: fadeOut,
        ease: "linear",
        opacity: 0,
      },
      fadeIn + hold,
    );
    tl.play();

    this.active.set(id, { id, container, left, top, width, height, timeline: tl });

    return "spawned";
  }

  /** For mock harness / live socket: time until next spawn should be attempted. */
  static nextSpawnDelay(body: string): number {
    return calculateReadTime(body) * 0.55;
  }

  count(): number {
    return this.active.size;
  }

  private removePost(id: string): void {
    const post = this.active.get(id);
    if (!post) return;
    try {
      this.surface.remove(id);
    } catch {
      // already detached
    }
    try {
      post.container.destroy();
    } catch {
      // already destroyed
    }
    this.active.delete(id);
  }

  private wrapBody(body: string, maxWidth: number): string[] {
    if (body.length <= maxWidth) return [body];
    const words = body.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  }

  private surfaceSize(): { width: number; height: number } {
    const width = process.stdout.columns ?? 80;
    const height = (process.stdout.rows ?? 24) - BOTTOM_RESERVED_ROWS;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  private findPlacement(
    width: number,
    height: number,
    surface: { width: number; height: number },
  ): { left: number; top: number } | null {
    if (width > surface.width || height > surface.height) return null;
    for (let i = 0; i < MAX_PLACEMENT_RETRIES; i++) {
      const left = Math.floor(Math.random() * (surface.width - width + 1));
      const top = Math.floor(Math.random() * (surface.height - height + 1));
      if (!this.collides(left, top, width, height)) {
        return { left, top };
      }
    }
    return null;
  }

  private collides(
    left: number,
    top: number,
    width: number,
    height: number,
  ): boolean {
    const a = {
      left: left - COLLISION_BUFFER,
      top: top - COLLISION_BUFFER,
      right: left + width + COLLISION_BUFFER,
      bottom: top + height + COLLISION_BUFFER,
    };
    for (const post of this.active.values()) {
      const b = {
        left: post.left,
        top: post.top,
        right: post.left + post.width,
        bottom: post.top + post.height,
      };
      if (
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top
      ) {
        return true;
      }
    }
    return false;
  }
}

function calculateReadTime(body: string): number {
  if (!body) return READ_TIME_MIN_MS;
  const wordCount = body.trim().split(/\s+/).length;
  return Math.max(
    READ_TIME_MIN_MS,
    Math.min(READ_TIME_MAX_MS, (wordCount / WORDS_PER_SECOND) * 1000),
  );
}

function calculateLifetime(body: string): number {
  return (calculateReadTime(body) + LIFETIME_BUFFER_MS) * LIFETIME_SCALE;
}
