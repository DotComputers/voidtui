/**
 * Terminal-theme detection.
 *
 * Most modern terminals (iTerm2, Terminal.app, Ghostty, kitty, alacritty,
 * wezterm) respond to the `OSC 11` escape sequence with their actual
 * background color. We use that to decide whether to render a dark theme
 * (light text) or a light theme (dark text).
 *
 * Must be called BEFORE the TUI renderer initializes — once OpenTUI takes
 * over stdin in raw mode, our query response would be swallowed.
 *
 * Returns null if detection fails or times out, so the caller can pick a
 * sane default (we default to dark in that case).
 */

export type DetectedTheme = "dark" | "light";

const DEFAULT_TIMEOUT_MS = 100;

/** Query the terminal for its background color. Returns 'dark' / 'light' / null. */
export async function detectTerminalBackground(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DetectedTheme | null> {
  // Need a real TTY on both ends to do the query.
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;

  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  if (typeof stdin.setRawMode !== "function") return null;

  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();

  try {
    return await new Promise<DetectedTheme | null>((resolve) => {
      let buffer = "";

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("binary");
        // OSC responses terminate with BEL (\x07) or ST (ESC + \).
        if (buffer.includes("\x07") || buffer.includes("\x1b\\")) {
          cleanup();
          resolve(parseOsc11(buffer));
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);

      const cleanup = (): void => {
        stdin.off("data", onData);
        clearTimeout(timer);
      };

      stdin.on("data", onData);
      // Send the query: ESC ] 11 ; ? BEL
      process.stdout.write("\x1b]11;?\x07");
    });
  } finally {
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
  }
}

/**
 * Parse an OSC 11 response and return whether it represents a dark or light
 * background. Returns null on unparseable input.
 *
 * Response shapes observed:
 *   ESC ]11;rgb:RRRR/GGGG/BBBB BEL    (most common; 16-bit values, 4 hex digits)
 *   ESC ]11;rgb:RR/GG/BB BEL          (8-bit, 2 hex digits)
 *   ESC ]11;rgb:R/G/B BEL             (4-bit, single hex digit)
 */
export function parseOsc11(response: string): DetectedTheme | null {
  const match = response.match(/]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
  if (!match) return null;
  const [, rHex, gHex, bHex] = match;
  if (!rHex || !gHex || !bHex) return null;

  // Each component can be 1–4 hex digits. Normalize to 0–1.
  const norm = (hex: string): number => {
    const max = 16 ** hex.length - 1;
    return parseInt(hex, 16) / max;
  };
  const r = norm(rHex);
  const g = norm(gHex);
  const b = norm(bHex);

  // Relative luminance (WCAG-ish; skipping sRGB gamma for our coarse binary
  // decision — overshoots slightly toward "light" on mid-gray, which is the
  // safer error: we'd rather wrongly use dark text on a mid-gray bg than
  // light text on a near-white one).
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? "light" : "dark";
}
