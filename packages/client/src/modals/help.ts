import { BoxRenderable, TextRenderable } from "@opentui/core";
import { COLORS } from "../scene.ts";
import type { Modal, ModalContext, ModalKeyEvent } from "./index.ts";

const LINES: Array<{ text: string; dim?: boolean }> = [
  { text: "void" },
  { text: "" },
  { text: "type a message and press enter to post (280 chars max)." },
  { text: "" },
  { text: "  TAB             toggle ghost mode" },
  { text: "  ENTER           send post" },
  { text: "  ESC             clear input / return" },
  { text: "  CTRL+C          quit" },
  { text: "" },
  { text: "slash commands:" },
  { text: "  /help           show this" },
  { text: "  /config         view & edit your config" },
  { text: "  /donate         support the void" },
  { text: "  /merch          wear the void" },
  { text: "  /quit           leave" },
  { text: "" },
  { text: "posts vanish from the server after 24 hours.", dim: true },
  { text: "your identity is at ~/.config/void/identity.json", dim: true },
  { text: "" },
  { text: "press esc to return", dim: true },
];

export class HelpModal implements Modal {
  mount(container: BoxRenderable, ctx: ModalContext): void {
    const inner = new BoxRenderable(ctx.renderer, {
      id: "help-inner",
      flexDirection: "column",
    });
    container.add(inner);

    for (let i = 0; i < LINES.length; i++) {
      const line = LINES[i]!;
      inner.add(
        new TextRenderable(ctx.renderer, {
          id: `help-line-${i}`,
          content: line.text,
          fg: line.dim ? COLORS.textDim : COLORS.text,
        }),
      );
    }
  }

  unmount(): void {
    // Container destruction handled by ModalLayer
  }

  onKey(_event: ModalKeyEvent): boolean {
    // Esc handled centrally by ModalLayer
    return false;
  }
}
