import { BoxRenderable, TextRenderable } from "@opentui/core";
import { COLORS } from "../scene.ts";
import { ACCENT_NAMES, ACCENT_PALETTE, type AccentName } from "../colors.ts";
import { getAccent, saveAccent, setAccent } from "../accent.ts";
import { identityPath } from "../identity.ts";
import { configPath } from "../config.ts";
import type { Modal, ModalContext, ModalKeyEvent } from "./index.ts";

const VERSION = "0.1.0";

export class ConfigModal implements Modal {
  private accentSavedOriginal: AccentName = "cyan";
  private staged: AccentName = "cyan";
  private accentLine: TextRenderable | null = null;
  private ctx: ModalContext | null = null;
  private committed = false;

  mount(container: BoxRenderable, ctx: ModalContext): void {
    this.ctx = ctx;
    this.accentSavedOriginal = getAccent();
    this.staged = this.accentSavedOriginal;

    const inner = new BoxRenderable(ctx.renderer, {
      id: "config-inner",
      flexDirection: "column",
    });
    container.add(inner);

    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-title",
      content: "config",
      fg: COLORS.text,
    }));
    inner.add(new TextRenderable(ctx.renderer, { id: "config-blank-1", content: "" }));

    const handle = ctx.scene.getHandle() ?? "?";
    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-handle",
      content: `handle:        @${handle}`,
      fg: COLORS.text,
    }));

    this.accentLine = new TextRenderable(ctx.renderer, {
      id: "config-accent",
      content: this.accentLineText(this.staged),
      fg: COLORS.text,
    });
    inner.add(this.accentLine);

    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-identity",
      content: `identity:      ${identityPath()}`,
      fg: COLORS.text,
    }));
    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-version",
      content: `version:       v${VERSION}`,
      fg: COLORS.text,
    }));

    inner.add(new TextRenderable(ctx.renderer, { id: "config-blank-2", content: "" }));
    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-hint",
      content: `edit ${configPath()} for more settings.`,
      fg: COLORS.textDim,
    }));
    inner.add(new TextRenderable(ctx.renderer, { id: "config-blank-3", content: "" }));
    inner.add(new TextRenderable(ctx.renderer, {
      id: "config-keys",
      content: "↑↓ or ←→ change color · enter save · esc cancel",
      fg: COLORS.textDim,
    }));
  }

  unmount(): void {
    // If the user dismissed via Esc without saving, restore the original.
    if (!this.committed) {
      setAccent(this.accentSavedOriginal);
    }
  }

  onKey(event: ModalKeyEvent): boolean {
    if (event.eventType === "release") return false;
    const idx = ACCENT_NAMES.indexOf(this.staged);
    if (event.name === "down" || event.name === "right") {
      const next = ACCENT_NAMES[(idx + 1) % ACCENT_NAMES.length]!;
      this.applyStaged(next);
      return true;
    }
    if (event.name === "up" || event.name === "left") {
      const prev = ACCENT_NAMES[(idx - 1 + ACCENT_NAMES.length) % ACCENT_NAMES.length]!;
      this.applyStaged(prev);
      return true;
    }
    if (event.name === "return" || event.name === "enter" || event.name === "kpenter") {
      this.committed = true;
      saveAccent().catch(() => {
        // best-effort
      });
      this.ctx?.dismiss();
      return true;
    }
    return false;
  }

  private applyStaged(name: AccentName): void {
    this.staged = name;
    setAccent(name);
    if (this.accentLine) {
      this.accentLine.content = this.accentLineText(name);
    }
  }

  private accentLineText(name: AccentName): string {
    return `accent color:  < ${name} >      ${ACCENT_PALETTE[name]}`;
  }
}
