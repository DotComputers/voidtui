import { describe, expect, test, beforeEach } from "bun:test";

const { normalize, verdictFromScores, classify, setModelRunner, configureModeration, initModeration } =
  await import("../src/moderation.ts");

describe("normalize", () => {
  test("collapses a combining sequence to NFC composed form", () => {
    // "e" + combining acute (U+0301) → "é" (U+00E9)
    expect(normalize("é")).toBe("é");
  });

  test("leaves already-composed text unchanged", () => {
    expect(normalize("hello void")).toBe("hello void");
  });
});

describe("verdictFromScores", () => {
  const thresholds = { threat: 0.85, toxic: 0.97, insult: 0.98, identity_hate: 0.9 };

  test("blocks when a category meets its threshold", () => {
    expect(verdictFromScores({ threat: 0.9, toxic: 0.1 }, thresholds)).toEqual({
      blocked: true,
      category: "threat",
      score: 0.9,
    });
  });

  test("allows when every category is below threshold", () => {
    expect(verdictFromScores({ threat: 0.5, toxic: 0.5 }, thresholds).blocked).toBe(false);
  });

  test("reports the highest over-threshold category when several trip", () => {
    const v = verdictFromScores({ insult: 0.99, identity_hate: 0.95 }, thresholds);
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("insult");
    expect(v.score).toBe(0.99);
  });

  test("ignores categories with no configured threshold", () => {
    expect(verdictFromScores({ unknown_cat: 1.0 }, thresholds).blocked).toBe(false);
  });
});

describe("classify fail-open", () => {
  beforeEach(() => {
    configureModeration({ timeoutMs: 200, maxConcurrent: 4 });
    setModelRunner(null);
  });

  test("allows everything when no model runner is configured", async () => {
    expect((await classify("clearly awful text")).blocked).toBe(false);
  });

  test("fails open (allows) when the model runner throws", async () => {
    setModelRunner(async () => {
      throw new Error("model boom");
    });
    expect((await classify("anything")).blocked).toBe(false);
  });

  test("blocks when the runner returns over-threshold scores", async () => {
    setModelRunner(async () => ({ threat: 0.99 }));
    const v = await classify("die");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("threat");
  });

  test("normalizes input to NFC before handing it to the runner", async () => {
    let seen = "";
    setModelRunner(async (text) => {
      seen = text;
      return { toxic: 0 };
    });
    await classify("é");
    expect(seen).toBe("é");
  });
});

describe("classify timeout + concurrency", () => {
  beforeEach(() => {
    configureModeration({ timeoutMs: 200, maxConcurrent: 4 });
    setModelRunner(null);
  });

  test("fails open when the runner exceeds the timeout", async () => {
    configureModeration({ timeoutMs: 20 });
    setModelRunner(() => new Promise<Record<string, number>>(() => {})); // never resolves
    expect((await classify("anything")).blocked).toBe(false);
  });

  test("never runs more than maxConcurrent runner calls at once", async () => {
    configureModeration({ maxConcurrent: 2, timeoutMs: 5000 });
    let active = 0;
    let maxActive = 0;
    setModelRunner(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield repeatedly so overlapping calls would be observed if unbounded.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      active--;
      return { toxic: 0 };
    });
    await Promise.all([classify("a"), classify("b"), classify("c"), classify("d"), classify("e")]);
    expect(maxActive).toBe(2);
  });
});

describe("initModeration", () => {
  beforeEach(() => {
    configureModeration({ timeoutMs: 200, maxConcurrent: 4 });
    setModelRunner(null);
  });

  test("fails open when the loader throws", async () => {
    await initModeration(async () => {
      throw new Error("no model on this host");
    });
    expect((await classify("bad")).blocked).toBe(false);
  });

  test("installs the runner the loader returns", async () => {
    await initModeration(async () => ({
      createModelRunner: async () => async () => ({ threat: 0.99 }),
    }));
    expect((await classify("die")).blocked).toBe(true);
  });
});
