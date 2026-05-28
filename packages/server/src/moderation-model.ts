import type { ModelRunner, Scores } from "./moderation.ts";

/**
 * Production model runner: a thin HTTP client to the Python GPU sidecar
 * (moderation_sidecar.py), which runs the toxicity classifier on the Jetson's
 * CUDA GPU. See that file for the wire contract.
 *
 * `initModeration()` in moderation.ts dynamically imports this module at startup
 * and installs the runner it returns. We do NOT health-check upfront: if the
 * sidecar isn't ready yet (it takes ~15s to load the model) or is down, each
 * call simply throws and `classify()` fails open. Moderation turns on
 * automatically once the sidecar starts answering — no bun restart needed.
 */
const SIDECAR_URL = process.env.VOID_MOD_URL ?? "http://127.0.0.1:8788";

// Backstop timeout on the fetch itself. classify()'s own timeout (≈200ms) fires
// first in normal operation; this just bounds a wedged socket.
const FETCH_TIMEOUT_MS = 2000;

export async function createModelRunner(): Promise<ModelRunner> {
  return async (text: string): Promise<Scores> => {
    const res = await fetch(`${SIDECAR_URL}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`moderation sidecar /classify -> ${res.status}`);
    const data = (await res.json()) as { scores?: Scores };
    if (!data.scores) throw new Error("moderation sidecar returned no scores");
    return data.scores;
  };
}
