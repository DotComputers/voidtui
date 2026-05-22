import { BoxRenderable, TextRenderable } from "@opentui/core";
import { COLORS } from "../scene.ts";
import { openExternal } from "../browser.ts";
import type { Modal, ModalContext, ModalKeyEvent } from "./index.ts";

const SPLASH_HOLD_MS = 1500;

export class LaunchBrowserModal implements Modal {
  private url: string;
  private headline: string;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private statusLine: TextRenderable | null = null;
  private urlLine: TextRenderable | null = null;
  private ctx: ModalContext | null = null;

  constructor(opts: { url: string; headline: string }) {
    this.url = opts.url;
    this.headline = opts.headline;
  }

  mount(container: BoxRenderable, ctx: ModalContext): void {
    this.ctx = ctx;

    const inner = new BoxRenderable(ctx.renderer, {
      id: "launch-inner",
      flexDirection: "column",
      alignItems: "center",
    });
    container.add(inner);

    inner.add(new TextRenderable(ctx.renderer, {
      id: "launch-headline",
      content: this.headline,
      fg: COLORS.text,
    }));
    inner.add(new TextRenderable(ctx.renderer, {
      id: "launch-blank-1",
      content: "",
    }));
    this.statusLine = new TextRenderable(ctx.renderer, {
      id: "launch-status",
      content: "opening browser...",
      fg: COLORS.textDim,
    });
    inner.add(this.statusLine);

    this.urlLine = new TextRenderable(ctx.renderer, {
      id: "launch-url",
      content: "",
      fg: COLORS.text,
      visible: false,
    });
    inner.add(this.urlLine);

    void this.tryLaunch(ctx);
  }

  private async tryLaunch(ctx: ModalContext): Promise<void> {
    const ok = await openExternal(this.url);
    if (ok) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        ctx.dismiss();
      }, SPLASH_HOLD_MS);
      return;
    }
    if (this.statusLine) this.statusLine.content = "can't open browser";
    if (this.urlLine) {
      this.urlLine.content = this.url;
      this.urlLine.visible = true;
    }
  }

  unmount(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  onKey(_event: ModalKeyEvent): boolean {
    return false;
  }
}
