import type { CliRenderer } from "@opentui/core";
import type { VoidScene } from "./scene.ts";
import { classifyInput, type CommandName } from "./commands.ts";

/**
 * Compose input glue.
 *
 * The actual text buffer, cursor, arrow nav, word-wrap, and Enter→submit
 * handling all live in OpenTUI's TextareaRenderable (owned by VoidScene).
 *
 * This module handles:
 *  - Tab          → toggle ghost mode (only in normal mode)
 *  - Escape       → clear the buffer + return to normal mode
 *  - Ctrl+C       → graceful quit (route via onCommand("quit"))
 *  - Slash commands: classify on every content change, route to onCommand on
 *    Enter when valid; no-op on incomplete/invalid.
 */

export type SubmitInput = {
  body: string;
  ghost: boolean;
};

type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  raw: string;
  eventType: "press" | "repeat" | "release";
};

export class InputHandler {
  private renderer: CliRenderer;
  private scene: VoidScene;
  private onSubmit: (input: SubmitInput) => void;
  private onCommand: (cmd: CommandName) => void;
  private ghostMode = false;

  constructor(
    renderer: CliRenderer,
    scene: VoidScene,
    onSubmit: (input: SubmitInput) => void,
    onCommand: (cmd: CommandName) => void,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.onSubmit = onSubmit;
    this.onCommand = onCommand;
  }

  start(): void {
    (this.renderer as unknown as {
      keyInput: { on: (event: string, cb: (e: KeypressEvent) => void) => void };
    }).keyInput.on("keypress", (event) => this.handle(event));

    this.scene.onComposeContentChange(() => this.refreshMode());
    this.scene.onComposeSubmit(() => this.submit());
  }

  private handle(event: KeypressEvent): void {
    if (event.eventType === "release") return;

    // Ctrl+C: graceful quit (route through the same path as /quit)
    if (event.ctrl && event.name === "c") {
      this.onCommand("quit");
      return;
    }

    if (event.ctrl || event.meta) return;

    const cls = classifyInput(this.scene.getComposeText());

    // Tab in command mode: no-op (autocomplete is v0.2+).
    // Tab in normal mode: toggle ghost.
    if (event.name === "tab" && !event.shift) {
      if (cls.kind === "not-command") this.toggleGhost();
      return;
    }
    if (event.name === "escape") {
      this.scene.clearComposeText();
      this.scene.setComposeMode("normal");
    }
  }

  private refreshMode(): void {
    const cls = classifyInput(this.scene.getComposeText());
    if (cls.kind === "not-command") {
      this.scene.setComposeMode("normal");
    } else if (cls.kind === "incomplete" || cls.kind === "valid") {
      this.scene.setComposeMode("command");
    } else {
      this.scene.setComposeMode("invalid");
    }
  }

  private toggleGhost(): void {
    this.ghostMode = !this.ghostMode;
    this.scene.setGhostMode(this.ghostMode);
  }

  private submit(): void {
    const text = this.scene.getComposeText();
    const cls = classifyInput(text);

    if (cls.kind === "valid") {
      this.scene.clearComposeText();
      this.scene.setComposeMode("normal");
      this.onCommand(cls.command);
      return;
    }
    if (cls.kind === "incomplete") {
      // Silently do nothing — user is still typing.
      return;
    }
    if (cls.kind === "invalid") {
      this.scene.setComposeRejected(
        "invalid command, use /help for a list of commands",
      );
      return;
    }

    const body = text.trim();
    if (body.length === 0) return;

    const submission: SubmitInput = { body, ghost: this.ghostMode };
    this.scene.clearComposeText();
    this.scene.setComposeMode("normal");
    this.ghostMode = false;
    this.scene.setGhostMode(false);
    this.onSubmit(submission);
  }
}
