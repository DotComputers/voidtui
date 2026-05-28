export type Scores = Record<string, number>;
export type Verdict = { blocked: boolean; category: string; score: number };
export type ModelRunner = (text: string) => Promise<Scores>;

/**
 * Per-category block thresholds. A post is blocked if ANY category's score
 * meets or exceeds its threshold. Categories NOT listed here are ignored, even
 * if the model emits them.
 *
 * Calibrated against unitary/toxic-bert (Task 9). The model's `toxic`/`obscene`
 * categories fire hard on *friendly* profanity ("this is fucking awesome" ≈ 0.98),
 * and `insult` fires on mild rudeness — blocking on those would shadow-drop the
 * edgy-but-harmless voice The Void is for. So the floor is the three categories
 * that only light up for genuine harm: threats, severe toxicity, identity hate.
 * Conservative by design: a false positive is silently dropped with no recourse,
 * so we'd rather let a borderline post through than eat a legitimate one.
 */
const THRESHOLDS: Record<string, number> = {
  threat: 0.8,
  severe_toxic: 0.8,
  identity_hate: 0.8,
};

/** Unicode-NFC normalize before classification (the only adversarial hardening in v1). */
export function normalize(text: string): string {
  return text.normalize("NFC");
}

/**
 * Pure decision function. Blocked iff some category score >= its threshold.
 * When blocked, reports the highest-scoring over-threshold category (for the log).
 */
export function verdictFromScores(
  scores: Scores,
  thresholds: Record<string, number> = THRESHOLDS,
): Verdict {
  let blocked = false;
  let category = "";
  let score = 0;
  for (const [cat, s] of Object.entries(scores)) {
    const thr = thresholds[cat];
    if (thr !== undefined && s >= thr && s > score) {
      blocked = true;
      category = cat;
      score = s;
    }
  }
  return { blocked, category, score };
}

// ── Runtime state ──────────────────────────────────────────────────────────
let runModel: ModelRunner | null = null;
let timeoutMs = 200;
let maxConcurrent = 4;

/** Install the model runner. Pass null to disable (everything fails open). */
export function setModelRunner(fn: ModelRunner | null): void {
  runModel = fn;
}

/** Tune the timeout / concurrency bound. Used in production startup and tests. */
export function configureModeration(opts: { timeoutMs?: number; maxConcurrent?: number }): void {
  if (opts.timeoutMs !== undefined) timeoutMs = opts.timeoutMs;
  if (opts.maxConcurrent !== undefined) maxConcurrent = opts.maxConcurrent;
}

const ALLOW: Verdict = { blocked: false, category: "", score: 0 };

// ── Bounded concurrency (hand-off semaphore) ─────────────────────────────────
let inFlight = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < maxConcurrent) {
    inFlight++;
    return Promise.resolve();
  }
  // At capacity: wait. releaseSlot() hands a slot directly to us (no inc/dec).
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else inFlight--;
}

async function runBounded(fn: () => Promise<Scores>): Promise<Scores> {
  await acquireSlot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<Scores>((_, reject) => {
        timer = setTimeout(() => reject(new Error("moderation timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    releaseSlot();
  }
}

/**
 * Classify a post body. Never throws and never blocks the event loop on its own;
 * the runner does its work asynchronously. Fails open (returns ALLOW) when no
 * runner is set, the runner throws, or it exceeds the timeout. Concurrency is
 * bounded so a spike cannot spawn unlimited in-flight inferences.
 */
export async function classify(text: string): Promise<Verdict> {
  const runner = runModel;
  if (!runner) return ALLOW;
  try {
    const scores = await runBounded(() => runner(normalize(text)));
    return verdictFromScores(scores);
  } catch {
    return ALLOW;
  }
}

// ── Model loading ────────────────────────────────────────────────────────────
type ModelModule = { createModelRunner: () => Promise<ModelRunner> };
const MODEL_MODULE = "./moderation-model.ts";

/**
 * Attempt to load and install the real model runner. On any failure (module
 * missing, load error), logs and leaves the runner null so the server runs and
 * fails open. The importer is injectable for tests; production uses the default
 * dynamic import of moderation-model.ts (created in Task 9).
 */
export async function initModeration(
  importer: () => Promise<ModelModule> = () => import(MODEL_MODULE) as Promise<ModelModule>,
): Promise<void> {
  try {
    const mod = await importer();
    const runner = await mod.createModelRunner();
    setModelRunner(runner);
    console.log("[void] moderation model loaded");
  } catch (err) {
    setModelRunner(null);
    console.warn("[void] moderation model unavailable — failing open:", err);
  }
}
