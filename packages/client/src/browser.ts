/**
 * Open a URL in the user's browser. Returns true on successful spawn,
 * false on any failure (caller falls back to the URL-display screen).
 */
export async function openExternal(url: string): Promise<boolean> {
  const candidates = resolveCandidates();
  for (const [cmd, args] of candidates) {
    try {
      const proc = Bun.spawn([cmd, ...args, url], {
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
      return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}

function resolveCandidates(): Array<[string, string[]]> {
  const list: Array<[string, string[]]> = [];
  const envBrowser = process.env.BROWSER;
  if (envBrowser) list.push([envBrowser, []]);

  switch (process.platform) {
    case "darwin":
      list.push(["open", []]);
      break;
    case "win32":
      list.push(["cmd", ["/c", "start", ""]]);
      break;
    default:
      list.push(["xdg-open", []]);
      break;
  }
  return list;
}
