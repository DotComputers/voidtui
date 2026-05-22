import { BoxRenderable, TextRenderable, type RGBA } from "@opentui/core";
import { COLORS } from "../scene.ts";
import { CLIENT_VERSION } from "../version.ts";
import { runUpdate, detectPlatform, type UpdateProgress } from "../updater.ts";
import type { Modal, ModalContext, ModalKeyEvent } from "./index.ts";

type State =
  | { kind: "checking" }
  | { kind: "downloading"; size: number }
  | { kind: "verifying" }
  | { kind: "installing" }
  | { kind: "already-current"; version: string }
  | { kind: "done"; version: string }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

/**
 * /update modal. Reuses the existing modal infrastructure.
 *
 * On mount, kicks off the same runUpdate() flow as the background task,
 * but with visible progress lines. Esc dismisses (the underlying update
 * keeps running to completion; we just stop watching).
 *
 * For PROTOCOL_MISMATCH path, see ProtocolMismatchModal — it has a red
 * border and "quit and relaunch" on Esc instead of "back to void."
 */
export class UpdateModal implements Modal {
  protected state: State = { kind: "checking" };
  protected line: TextRenderable | null = null;
  protected manifestUrl: string;

  constructor(manifestUrl?: string) {
    this.manifestUrl =
      manifestUrl ??
      process.env.VOID_MANIFEST_URL ??
      "https://void-relay.com/release/latest.json";
  }

  mount(container: BoxRenderable, ctx: ModalContext): void {
    const inner = new BoxRenderable(ctx.renderer, {
      id: "update-inner",
      flexDirection: "column",
      borderStyle: "rounded",
      borderColor: this.borderColor(),
      padding: 1,
    });
    container.add(inner);

    inner.add(
      new TextRenderable(ctx.renderer, {
        id: "update-title",
        content: this.titleText(),
        fg: COLORS.text,
      }),
    );
    inner.add(
      new TextRenderable(ctx.renderer, {
        id: "update-spacer",
        content: "",
        fg: COLORS.text,
      }),
    );
    this.line = new TextRenderable(ctx.renderer, {
      id: "update-line",
      content: this.renderState(),
      fg: COLORS.text,
    });
    inner.add(this.line);
    inner.add(
      new TextRenderable(ctx.renderer, {
        id: "update-spacer2",
        content: "",
        fg: COLORS.text,
      }),
    );
    inner.add(
      new TextRenderable(ctx.renderer, {
        id: "update-hint",
        content: "press esc to return",
        fg: COLORS.textDim,
      }),
    );

    void this.kickoff();
  }

  unmount(): void {
    // No-op; the underlying update runs to completion in the background
  }

  onKey(_event: ModalKeyEvent): boolean {
    return false;
  }

  protected borderColor(): RGBA {
    return COLORS.border;
  }
  protected titleText(): string {
    return "update";
  }

  protected onProgress = (p: UpdateProgress): void => {
    if (p.phase === "downloading") {
      this.state = { kind: "downloading", size: p.size };
    } else if (p.phase === "verifying") {
      this.state = { kind: "verifying" };
    } else if (p.phase === "installing") {
      this.state = { kind: "installing" };
    } else if (p.phase === "done") {
      this.state = { kind: "done", version: p.newVersion };
    } else if (p.phase === "failed") {
      this.state = { kind: "failed", reason: p.reason };
    }
    if (this.line) this.line.content = this.renderState();
  };

  protected async kickoff(): Promise<void> {
    const platform = detectPlatform();
    if (!platform) {
      this.state = { kind: "unsupported" };
      if (this.line) this.line.content = this.renderState();
      return;
    }
    const result = await runUpdate({
      manifestUrl: this.manifestUrl,
      currentVersion: CLIENT_VERSION,
      execPath: process.execPath,
      platform,
      onProgress: this.onProgress,
    });
    if (result.kind === "already-current") {
      this.state = { kind: "already-current", version: CLIENT_VERSION };
    } else if (result.kind === "unsupported-platform") {
      this.state = { kind: "unsupported" };
    } else if (result.kind === "failed") {
      this.state = { kind: "failed", reason: result.reason };
    } else {
      this.state = { kind: "done", version: result.newVersion };
    }
    if (this.line) this.line.content = this.renderState();
  }

  protected renderState(): string {
    switch (this.state.kind) {
      case "checking":
        return "checking for updates...";
      case "downloading":
        return `downloading... (${formatSize(this.state.size)})`;
      case "verifying":
        return "verifying...";
      case "installing":
        return "installing...";
      case "already-current":
        return `you're on the latest (${this.state.version}) — see you in the void`;
      case "done":
        return `updated to ${this.state.version} — quit and relaunch when ready`;
      case "unsupported":
        return "this platform isn't supported by auto-update";
      case "failed":
        return "couldn't update right now — will retry on next launch";
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * PROTOCOL_MISMATCH variant. Same internals as UpdateModal but:
 *   - red border (signals: must-update)
 *   - title text says "void can't talk to the server on this version"
 *   - after success / failure, Esc *quits void entirely* rather than returning
 *     to the void (which can't function without server connectivity).
 */
export class ProtocolMismatchModal extends UpdateModal {
  protected borderColor(): RGBA {
    return COLORS.error;
  }
  protected titleText(): string {
    return "void can't talk to the server on this version. updating now...";
  }

  onKey(event: ModalKeyEvent): boolean {
    if (event.name === "escape") {
      process.exit(0);
    }
    return true;
  }
}
