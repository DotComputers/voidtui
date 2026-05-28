import { describe, expect, test } from "bun:test";

process.env.VOID_DB = ":memory:";

const { recordModerationDrop, getModerationDrops, purgeModerationText } = await import(
  "../src/store.ts"
);

describe("moderation_log writer/reader", () => {
  test("recordModerationDrop persists a row retrievable via getModerationDrops", () => {
    recordModerationDrop({
      id: "m1",
      pubkey: "p".repeat(64),
      category: "threat",
      score: 0.9,
      body: "bad text",
      created_at: Date.now(),
    });
    const row = getModerationDrops().find((r) => r.id === "m1")!;
    expect(row).toBeDefined();
    expect(row.category).toBe("threat");
    expect(row.score).toBe(0.9);
    expect(row.body).toBe("bad text");
    expect(row.pubkey).toBe("p".repeat(64));
  });
});

describe("purgeModerationText", () => {
  test("nulls body older than the cutoff but keeps the rest of the row", () => {
    const day = 24 * 60 * 60 * 1000;
    recordModerationDrop({
      id: "old-row",
      pubkey: "q".repeat(64),
      category: "toxic",
      score: 0.99,
      body: "old secret text",
      created_at: Date.now() - 2 * day,
    });
    recordModerationDrop({
      id: "new-row",
      pubkey: "q".repeat(64),
      category: "toxic",
      score: 0.99,
      body: "fresh text",
      created_at: Date.now(),
    });

    const scrubbed = purgeModerationText(day);
    expect(scrubbed).toBe(1);

    const rows = getModerationDrops();
    const oldRow = rows.find((r) => r.id === "old-row")!;
    expect(oldRow.body).toBeNull();
    expect(oldRow.category).toBe("toxic"); // metadata survives
    expect(oldRow.score).toBe(0.99);
    expect(rows.find((r) => r.id === "new-row")!.body).toBe("fresh text");
  });
});
