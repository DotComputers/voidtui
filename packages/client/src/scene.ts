import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  TextareaRenderable,
  ASCIIFontRenderable,
  StyledText,
  fg,
  RGBA,
  engine as timelineEngine,
  type CliRenderer,
} from "@opentui/core";
import { ACCENT_PALETTE, type AccentName } from "./colors.ts";
import { getAccent, subscribeAccent } from "./accent.ts";

const RAINBOW_COLORS = [
  RGBA.fromHex("#ff5252"),
  RGBA.fromHex("#ff9152"),
  RGBA.fromHex("#ffe452"),
  RGBA.fromHex("#52ff77"),
  RGBA.fromHex("#52d4ff"),
  RGBA.fromHex("#5252ff"),
  RGBA.fromHex("#ff52e4"),
];

function rainbowHandle(handle: string): StyledText {
  // No @ prefix here — the @ lives in pickerInputPrompt and renders
  // alongside this when in random mode.
  const chunks = [];
  for (let i = 0; i < handle.length; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length]!;
    chunks.push(fg(color)(handle[i]!));
  }
  return new StyledText(chunks);
}

// Dark theme — the original look; used when the terminal background is dark.
const DARK_COLORS = {
  bg: RGBA.fromHex("#000000"),
  text: RGBA.fromHex("#f0f0f0"),
  textDim: RGBA.fromHex("#888888"),
  border: RGBA.fromHex("#5a5a5a"),
  ghostBody: RGBA.fromHex("#a8a8a8"),
  star: RGBA.fromHex("#ffffff"),
  error: RGBA.fromHex("#ff6b6b"),

  // Identity name-tag — fg fixed at black, bg driven by accent module.
  handleTagFg: RGBA.fromHex("#000000"),
  ghostTagFg: RGBA.fromHex("#e0e0e0"),
  ghostTagBg: RGBA.fromHex("#444444"),

  postGhostMark: RGBA.fromHex("#888888"),

  // Command-mode (compose box turns green while typing a slash command;
  // red when the command is invalid).
  commandOk: RGBA.fromHex("#34d399"),
  commandError: RGBA.fromHex("#ff6b6b"),
};

// Light theme — inverted for users with light terminal backgrounds.
// Stars become dark gray (white stars are invisible on white); text becomes
// near-black; handle-tag fg becomes white so the accent-colored bg stays
// readable.
const LIGHT_COLORS: typeof DARK_COLORS = {
  bg: RGBA.fromHex("#ffffff"),
  text: RGBA.fromHex("#0a0a0a"),
  textDim: RGBA.fromHex("#666666"),
  border: RGBA.fromHex("#cccccc"),
  ghostBody: RGBA.fromHex("#666666"),
  star: RGBA.fromHex("#aaaaaa"),
  error: RGBA.fromHex("#dc2626"),

  handleTagFg: RGBA.fromHex("#ffffff"),
  ghostTagFg: RGBA.fromHex("#1a1a1a"),
  ghostTagBg: RGBA.fromHex("#d0d0d0"),

  postGhostMark: RGBA.fromHex("#666666"),

  commandOk: RGBA.fromHex("#059669"),
  commandError: RGBA.fromHex("#dc2626"),
};

/**
 * Active palette. Imported as `COLORS` everywhere; its property *values* are
 * swapped at startup by `applyTheme(theme)`. Defaults to dark (the original
 * aesthetic, what users got pre-v0.1.5).
 *
 * Don't destructure COLORS at module load — only access properties at render
 * time, otherwise consumers hold a stale reference past applyTheme().
 */
export const COLORS = { ...DARK_COLORS };

/** Swap the active palette in place. Call once at startup, before scene.init(). */
export function applyTheme(theme: "dark" | "light"): void {
  const src = theme === "light" ? LIGHT_COLORS : DARK_COLORS;
  for (const key of Object.keys(src) as Array<keyof typeof src>) {
    (COLORS as Record<string, RGBA>)[key] = src[key];
  }
}

export type SceneState = {
  handle: string | null;
  ghostMode: boolean;
  composeMode: "normal" | "command" | "invalid";
  connected: boolean;
  activeCount: number;
  composeText: string;
};

/**
 * Owns the OpenTUI scene graph.
 * The rest of the client (network, identity, input handling) calls into
 * setters on this object; the scene itself doesn't know about WebSockets.
 */
export class VoidScene {
  renderer!: CliRenderer;
  voidSurface!: BoxRenderable;
  composeBox!: BoxRenderable;
  composeRow!: BoxRenderable;
  statusLine!: BoxRenderable;

  composePrompt!: TextRenderable;
  composeInput!: TextareaRenderable;
  composeCount!: TextRenderable;
  private onComposeSubmitCallback?: () => void;
  private onComposeContentChangeCallback?: () => void;

  statusLeftGroup!: BoxRenderable;
  identityTag!: BoxRenderable;
  statusIdentity!: TextRenderable;
  statusHint!: TextRenderable;
  statusCount!: TextRenderable;

  // Handle picker (first-run only)
  pickerOverlay!: BoxRenderable;
  pickerLogoThe!: TextRenderable;
  pickerLogo!: ASCIIFontRenderable;
  pickerTagline!: TextRenderable;
  pickerPromptText!: TextRenderable;
  pickerInputBox!: BoxRenderable;
  pickerInputPrompt!: TextRenderable;
  pickerInput!: TextareaRenderable;
  pickerRandomPreview!: TextRenderable;
  pickerErrorText!: TextRenderable;
  pickerKeyHints!: TextRenderable;
  pickerFooterText!: TextRenderable;
  private onPickerSubmitCallback?: (handle: string) => void;
  private accentUnsubscribe: (() => void) | null = null;

  state: SceneState = {
    handle: null,
    ghostMode: false,
    composeMode: "normal",
    connected: false,
    activeCount: 0,
    composeText: "",
  };

  async init(): Promise<void> {
    this.renderer = await createCliRenderer({
      targetFps: 60,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      useMouse: false,
    });
    // Wire the timeline engine to the renderer so animations tick each frame.
    timelineEngine.attach(this.renderer);

    const root = this.renderer.root;

    // Void surface — no background, inherits the terminal's own.
    this.voidSurface = new BoxRenderable(this.renderer, {
      id: "void-surface",
      flexGrow: 1,
    });
    root.add(this.voidSurface);

    // Compose area — top + bottom horizontal rules only, no vertical sides.
    // Height auto-grows with content (textarea wraps), bounded by max.
    this.composeBox = new BoxRenderable(this.renderer, {
      id: "compose-box",
      minHeight: 3,
      maxHeight: 7,
      border: ["top", "bottom"],
      borderStyle: "single",
      borderColor: COLORS.border,
      marginLeft: 2,
      marginRight: 2,
      paddingLeft: 1,
      paddingRight: 1,
    });
    root.add(this.composeBox);

    // Inner row holds prompt, textarea, char counter.
    this.composeRow = new BoxRenderable(this.renderer, {
      id: "compose-row",
      flexDirection: "row",
      alignItems: "flex-start",
      flexGrow: 1,
    });
    this.composeBox.add(this.composeRow);

    this.composePrompt = new TextRenderable(this.renderer, {
      id: "compose-prompt",
      content: "▶ ",
      fg: COLORS.text,
    });
    this.composeRow.add(this.composePrompt);

    // Real multi-line input with cursor + word wrap + arrow nav.
    // Default bindings have Enter inserting a newline; we override it to
    // submit since a void post is a single message (no manual line breaks).
    this.composeInput = new TextareaRenderable(this.renderer, {
      id: "compose-input",
      flexGrow: 1,
      minHeight: 1,
      wrapMode: "word",
      showCursor: true,
      cursorStyle: { style: "block", blinking: true, color: COLORS.text },
      textColor: COLORS.text,
      focusable: true,
      keyBindings: [
        // Override Enter → submit (not newline).
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        // Inherit everything else from defaults (we don't list them, but
        // we want the standard arrow / home / end / word-nav bindings).
        // Default key bindings will be augmented for any name we don't list,
        // BUT the bindings prop REPLACES not augments — so we need full list.
        // We re-include the navigation we care about explicitly below.
        { name: "left", action: "move-left" },
        { name: "right", action: "move-right" },
        { name: "up", action: "move-up" },
        { name: "down", action: "move-down" },
        { name: "home", action: "line-home" },
        { name: "end", action: "line-end" },
        { name: "left", meta: true, action: "word-backward" },
        { name: "right", meta: true, action: "word-forward" },
        { name: "left", ctrl: true, action: "word-backward" },
        { name: "right", ctrl: true, action: "word-forward" },
        { name: "backspace", action: "backspace" },
        { name: "delete", action: "delete" },
        { name: "backspace", ctrl: true, action: "delete-word-backward" },
        { name: "backspace", meta: true, action: "delete-word-backward" },
        { name: "a", ctrl: true, action: "line-home" },
        { name: "e", ctrl: true, action: "line-end" },
        { name: "k", ctrl: true, action: "delete-to-line-end" },
        { name: "u", ctrl: true, action: "delete-to-line-start" },
      ],
      onSubmit: () => {
        if (this.onComposeSubmitCallback) this.onComposeSubmitCallback();
      },
      onContentChange: () => {
        this.refreshComposeCount();
        if (this.onComposeContentChangeCallback) this.onComposeContentChangeCallback();
      },
    });
    this.composeRow.add(this.composeInput);

    this.composeCount = new TextRenderable(this.renderer, {
      id: "compose-count",
      content: "",
      fg: COLORS.textDim,
      marginLeft: 1,
    });
    this.composeRow.add(this.composeCount);

    // Focus the input so keystrokes land in it from the start.
    this.composeInput.focus();

    this.statusLine = new BoxRenderable(this.renderer, {
      id: "status-line",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      marginLeft: 2,
      marginRight: 2,
    });
    root.add(this.statusLine);

    // Left group: identity tag + optional inline hint (e.g. invalid-command toast).
    this.statusLeftGroup = new BoxRenderable(this.renderer, {
      id: "status-left-group",
      flexDirection: "row",
      alignItems: "center",
    });
    this.statusLine.add(this.statusLeftGroup);

    // Identity is a "name tag" — backgrounded block, flush-left.
    this.identityTag = new BoxRenderable(this.renderer, {
      id: "identity-tag",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.fromHex(ACCENT_PALETTE[getAccent()]),
    });
    this.statusLeftGroup.add(this.identityTag);

    this.statusIdentity = new TextRenderable(this.renderer, {
      id: "status-identity",
      content: "",
      fg: COLORS.handleTagFg,
    });
    this.identityTag.add(this.statusIdentity);

    // Inline hint that appears next to the tag (e.g. "— invalid command, use /help —").
    // Hidden by default; populated/cleared via setComposeRejected.
    this.statusHint = new TextRenderable(this.renderer, {
      id: "status-hint",
      content: "",
      fg: COLORS.commandError,
      marginLeft: 2,
      visible: false,
    });
    this.statusLeftGroup.add(this.statusHint);

    this.statusCount = new TextRenderable(this.renderer, {
      id: "status-count",
      content: "",
      fg: COLORS.textDim,
    });
    this.statusLine.add(this.statusCount);

    this.refreshStatusLine();
    this.refreshComposeCount();

    // Picker overlay (hidden by default). Full-screen modal that sits over
    // the entire scene (not just the void surface) so the compose box and
    // status line below are also covered when the picker is visible.
    this.pickerOverlay = new BoxRenderable(this.renderer, {
      id: "picker-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 100,
      visible: false,
    });
    root.add(this.pickerOverlay);

    // Small "the" sits above the big VOID — reads as "the void".
    this.pickerLogoThe = new TextRenderable(this.renderer, {
      id: "picker-logo-the",
      content: "the",
      fg: COLORS.textDim,
    });
    this.pickerOverlay.add(this.pickerLogoThe);

    // Big block "VOID" logo — white. The cyan accent is reserved for the
    // identity tag in the status line.
    this.pickerLogo = new ASCIIFontRenderable(this.renderer, {
      id: "picker-logo",
      text: "VOID",
      font: "block",
      color: COLORS.text,
    });
    this.pickerOverlay.add(this.pickerLogo);

    this.pickerTagline = new TextRenderable(this.renderer, {
      id: "picker-tagline",
      content: "~ ham radio for the internet ~",
      fg: COLORS.textDim,
      marginTop: 1,
      marginBottom: 2,
    });
    this.pickerOverlay.add(this.pickerTagline);

    this.pickerPromptText = new TextRenderable(this.renderer, {
      id: "picker-prompt",
      content: "choose your callsign",
      fg: COLORS.text,
      marginBottom: 1,
    });
    this.pickerOverlay.add(this.pickerPromptText);

    // Bordered (rounded) box around the input — visual affordance.
    this.pickerInputBox = new BoxRenderable(this.renderer, {
      id: "picker-input-box",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      paddingLeft: 1,
      paddingRight: 1,
      width: 36,
      height: 3,
      flexDirection: "row",
    });
    this.pickerOverlay.add(this.pickerInputBox);

    // "@" prefix — reads as the start of "@handle". Color tracks the input
    // text so @bluefin renders as one unit (cyan valid / red invalid).
    this.pickerInputPrompt = new TextRenderable(this.renderer, {
      id: "picker-input-prompt",
      content: "@",
      fg: COLORS.text,
    });
    this.pickerInputBox.add(this.pickerInputPrompt);

    this.pickerInput = new TextareaRenderable(this.renderer, {
      id: "picker-input",
      flexGrow: 1,
      minHeight: 1,
      wrapMode: "none",
      showCursor: true,
      cursorStyle: { style: "block", blinking: true, color: COLORS.text },
      textColor: COLORS.text,
      focusable: true,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "left", action: "move-left" },
        { name: "right", action: "move-right" },
        { name: "home", action: "line-home" },
        { name: "end", action: "line-end" },
        { name: "backspace", action: "backspace" },
        { name: "delete", action: "delete" },
        { name: "a", ctrl: true, action: "line-home" },
        { name: "e", ctrl: true, action: "line-end" },
        { name: "u", ctrl: true, action: "delete-to-line-start" },
      ],
      onSubmit: () => {
        if (this.onPickerSubmitCallback) {
          this.onPickerSubmitCallback(this.pickerInput.editBuffer.getText());
        }
      },
      onContentChange: () => this.refreshPickerValidation(),
    });
    this.pickerInputBox.add(this.pickerInput);

    // Rainbow preview — sits inside the input box as a sibling of the
    // textarea. Visibility toggles between this and the textarea depending
    // on edit vs random mode.
    this.pickerRandomPreview = new TextRenderable(this.renderer, {
      id: "picker-random-preview",
      content: "",
      flexGrow: 1,
      visible: false,
    });
    this.pickerInputBox.add(this.pickerRandomPreview);

    this.pickerErrorText = new TextRenderable(this.renderer, {
      id: "picker-error",
      content: "",
      fg: COLORS.error,
      marginTop: 1,
      height: 1,
    });
    this.pickerOverlay.add(this.pickerErrorText);

    this.pickerKeyHints = new TextRenderable(this.renderer, {
      id: "picker-key-hints",
      content: "[Enter→use this]    [Tab→random]",
      fg: COLORS.textDim,
      marginTop: 2,
    });
    this.pickerOverlay.add(this.pickerKeyHints);

    this.pickerFooterText = new TextRenderable(this.renderer, {
      id: "picker-footer",
      content: "identity saved to ~/.config/void/",
      fg: COLORS.textDim,
      marginTop: 1,
    });
    this.pickerOverlay.add(this.pickerFooterText);

    // Apply the current accent and subscribe to future changes.
    this.applyAccent(getAccent());
    this.accentUnsubscribe = subscribeAccent((name) => this.applyAccent(name));
  }

  private applyAccent(_name: AccentName): void {
    // Re-render status line (picks up accent) and picker validation (if open).
    this.refreshStatusLine();
    this.refreshPickerValidation();
  }

  /**
   * Show the first-run picker. Empty input by default. Caller is responsible
   * for handling Tab → setPickerRandom + setPickerMode("random") to enter
   * the random-cycling state.
   */
  showPicker(): void {
    this.pickerInput.editBuffer.setText("");
    this.pickerErrorText.content = "";
    this.composeBox.visible = false;
    this.statusLine.visible = false;
    this.pickerOverlay.visible = true;
    this.setPickerMode("edit");
  }

  hidePicker(): void {
    this.pickerOverlay.visible = false;
    this.composeBox.visible = true;
    this.statusLine.visible = true;
    this.composeInput.focus();
  }

  /**
   * Toggle the picker between edit and random modes. The bordered input box
   * stays visible in both modes — only its inner content changes (textarea
   * in edit, rainbow preview in random).
   */
  setPickerMode(mode: "edit" | "random"): void {
    if (mode === "edit") {
      this.pickerInput.visible = true;
      this.pickerRandomPreview.visible = false;
      this.pickerKeyHints.content = "[Enter→use this]    [Tab→random]";
      this.pickerInput.focus();
      // Reapply validation-based @ color (cyan/white/red).
      this.refreshPickerValidation();
    } else {
      this.pickerInput.visible = false;
      this.pickerRandomPreview.visible = true;
      this.pickerKeyHints.content = "[Enter→keep]    [Tab→another]    [Esc→back]";
      // @ in dim while a random handle is being previewed.
      this.pickerInputPrompt.fg = COLORS.textDim;
    }
  }

  /** Update the rainbow preview text (does not change the textarea buffer). */
  setPickerRandom(handle: string): void {
    this.pickerRandomPreview.content = rainbowHandle(handle);
  }

  /** Set textarea content + focus it (used when transitioning random → edit). */
  setPickerInputText(text: string): void {
    this.pickerInput.editBuffer.setText(text);
    this.pickerInput.focus();
  }

  setPickerError(message: string): void {
    this.pickerErrorText.content = message;
  }

  onPickerSubmit(callback: (handle: string) => void): void {
    this.onPickerSubmitCallback = callback;
  }

  /**
   * Live-validate the picker textarea and update color + error text.
   *  - empty               → white, no error
   *  - valid chars typed   → cyan ("this is your callsign")
   *  - disallowed char     → red + reason
   *  - over 20 chars       → red + "too long"
   *
   * Length-too-short (1-2 chars) is intentionally NOT a live error — that
   * only fires when the user tries to submit. Real-time red is reserved for
   * states that can't be fixed by typing more.
   */
  private refreshPickerValidation(): void {
    const text = this.pickerInput.editBuffer.getText();

    // Hard-cap at 20 characters. Truncate any overflow and restore the
    // cursor to the end of the truncated text — `setText` alone would
    // reset the cursor to position 0, which makes the next keystroke
    // appear to "jump" to the start.
    if (text.length > 20) {
      this.pickerInput.editBuffer.setText(text.slice(0, 20));
      this.pickerInput.editBuffer.setCursorByOffset(20);
      return;
    }

    // TextareaRenderable has separate focused/unfocused text colors; while
    // the picker is open the input is always focused, so we set both — the
    // focused one is what's actually visible.
    const setColor = (color: RGBA): void => {
      this.pickerInput.textColor = color;
      this.pickerInput.focusedTextColor = color;
      this.pickerInputPrompt.fg = color;
    };

    if (text.length === 0) {
      setColor(COLORS.text);
      this.pickerErrorText.content = "";
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(text)) {
      setColor(COLORS.error);
      const reason = /\s/.test(text)
        ? "no spaces"
        : "letters, numbers, - and _ only";
      this.pickerErrorText.content = reason;
      return;
    }
    // Valid (including length 1-2 — too-short fires on submit only)
    setColor(RGBA.fromHex(ACCENT_PALETTE[getAccent()]));
    this.pickerErrorText.content = "";
  }

  setHandle(handle: string): void {
    this.state.handle = handle;
    this.refreshStatusLine();
  }

  setConnected(connected: boolean): void {
    this.state.connected = connected;
    this.refreshStatusLine();
  }

  setActiveCount(count: number): void {
    this.state.activeCount = count;
    this.refreshStatusLine();
  }

  setGhostMode(ghost: boolean): void {
    this.state.ghostMode = ghost;
    this.refreshStatusLine();
    this.composeInput.textColor = ghost ? COLORS.ghostBody : COLORS.text;
  }

  /** Read the current compose buffer text from the textarea. */
  getComposeText(): string {
    return this.composeInput.editBuffer.getText();
  }

  /** Clear the textarea buffer (used after a submit). */
  clearComposeText(): void {
    this.composeInput.editBuffer.setText("");
    this.refreshComposeCount();
  }

  /** Register a callback fired when the textarea's submit action triggers (Enter). */
  onComposeSubmit(callback: () => void): void {
    this.onComposeSubmitCallback = callback;
  }

  /** Register a callback fired on every textarea content change. */
  onComposeContentChange(callback: () => void): void {
    this.onComposeContentChangeCallback = callback;
  }

  /** Public accessor for the current handle (used by /config modal). */
  getHandle(): string | null {
    return this.state.handle;
  }

  /**
   * Switch the compose box's visual mode.
   *  - "normal"  : default border + text colour; status-line shows @handle (or ghost)
   *  - "command" : green border + green text; status-line shows green "COMMAND" block
   *  - "invalid" : red border + red text; status-line shows red "COMMAND" block
   */
  setComposeMode(mode: "normal" | "command" | "invalid"): void {
    this.state.composeMode = mode;

    if (mode === "normal") {
      this.composeBox.borderColor = COLORS.border;
      const baseColor = this.state.ghostMode ? COLORS.ghostBody : COLORS.text;
      this.composeInput.textColor = baseColor;
      this.composeInput.focusedTextColor = baseColor;
    } else {
      const color = mode === "command" ? COLORS.commandOk : COLORS.commandError;
      this.composeBox.borderColor = color;
      this.composeInput.textColor = color;
      this.composeInput.focusedTextColor = color;
    }
    // Any content change clears the prior rejection hint. The input handler
    // re-sets it when Enter is pressed on an invalid command.
    this.setComposeRejected(null);
    this.refreshStatusLine();
  }

  /**
   * Show or clear the inline rejection hint (e.g. "invalid command, use /help…").
   * Pass null to hide. The hint sits to the right of the COMMAND block in the status line.
   */
  setComposeRejected(message: string | null): void {
    if (message === null || message.length === 0) {
      this.statusHint.content = "";
      this.statusHint.visible = false;
      return;
    }
    this.statusHint.content = `— ${message} —`;
    this.statusHint.visible = true;
  }

  /** Show/hide the compose box (used by modals to take over the surface). */
  hideCompose(): void {
    this.composeBox.visible = false;
    this.composeInput.blur();
  }

  showCompose(): void {
    this.composeBox.visible = true;
    this.composeInput.focus();
  }

  destroy(): void {
    if (this.accentUnsubscribe) this.accentUnsubscribe();
    this.renderer?.destroy?.();
  }

  private refreshStatusLine(): void {
    const accentBg = RGBA.fromHex(ACCENT_PALETTE[getAccent()]);

    if (!this.state.connected) {
      this.identityTag.backgroundColor = COLORS.ghostTagBg;
      this.statusIdentity.fg = COLORS.ghostTagFg;
      const id = this.state.handle ? `@${this.state.handle}` : "void";
      this.statusIdentity.content = `${id} · disconnected`;
      this.statusCount.content = "";
      return;
    }
    // Command mode takes precedence over ghost / identity — they can't coexist.
    if (this.state.composeMode === "command") {
      this.identityTag.backgroundColor = COLORS.commandOk;
      this.statusIdentity.fg = RGBA.fromHex("#000000");
      this.statusIdentity.content = "COMMAND";
    } else if (this.state.composeMode === "invalid") {
      this.identityTag.backgroundColor = COLORS.commandError;
      this.statusIdentity.fg = RGBA.fromHex("#000000");
      this.statusIdentity.content = "COMMAND";
    } else if (this.state.ghostMode) {
      this.identityTag.backgroundColor = COLORS.ghostTagBg;
      this.statusIdentity.fg = COLORS.ghostTagFg;
      this.statusIdentity.content = "~ GHOST ~";
    } else {
      this.identityTag.backgroundColor = accentBg;
      this.statusIdentity.fg = COLORS.handleTagFg;
      this.statusIdentity.content = `@${this.state.handle ?? "?"}`;
    }
    this.statusCount.content = `${this.state.activeCount} in the void`;
  }

  private refreshComposeCount(): void {
    const text = this.getComposeText();
    if (text.length === 0) {
      this.composeCount.content = "";
      return;
    }
    const remaining = 280 - text.length;
    this.composeCount.content = String(remaining);
    this.composeCount.fg = remaining <= 10
      ? COLORS.error
      : remaining <= 50
      ? RGBA.fromHex("#c8b46b")
      : COLORS.textDim;
  }
}
