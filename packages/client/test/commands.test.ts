import { describe, expect, test } from "bun:test";
import {
  COMMAND_NAMES,
  classifyInput,
  type CommandName,
} from "../src/commands.ts";

describe("COMMAND_NAMES", () => {
  test("v0.1 commands present including /update", () => {
    const expected: CommandName[] = ["help", "config", "donate", "merch", "quit", "update"];
    expect(COMMAND_NAMES).toEqual(expected);
  });
});

describe("classifyInput", () => {
  test("empty or non-slash returns 'not-command'", () => {
    expect(classifyInput("")).toEqual({ kind: "not-command" });
    expect(classifyInput("hello")).toEqual({ kind: "not-command" });
    expect(classifyInput(" /help")).toEqual({ kind: "not-command" });
  });

  test("'/' alone is 'incomplete'", () => {
    expect(classifyInput("/")).toEqual({ kind: "incomplete" });
  });

  test("prefix of a command is 'incomplete'", () => {
    expect(classifyInput("/h")).toEqual({ kind: "incomplete" });
    expect(classifyInput("/conf")).toEqual({ kind: "incomplete" });
    expect(classifyInput("/qui")).toEqual({ kind: "incomplete" });
  });

  test("exact match is 'valid'", () => {
    expect(classifyInput("/help")).toEqual({ kind: "valid", command: "help" });
    expect(classifyInput("/config")).toEqual({ kind: "valid", command: "config" });
    expect(classifyInput("/donate")).toEqual({ kind: "valid", command: "donate" });
    expect(classifyInput("/merch")).toEqual({ kind: "valid", command: "merch" });
    expect(classifyInput("/quit")).toEqual({ kind: "valid", command: "quit" });
    expect(classifyInput("/update")).toEqual({ kind: "valid", command: "update" });
  });

  test("/up is incomplete", () => {
    expect(classifyInput("/up")).toEqual({ kind: "incomplete" });
  });

  test("non-prefix + non-match is 'invalid'", () => {
    expect(classifyInput("/foo")).toEqual({ kind: "invalid" });
    expect(classifyInput("/helpx")).toEqual({ kind: "invalid" });
    expect(classifyInput("/help foo")).toEqual({ kind: "invalid" });
    expect(classifyInput("/HELP")).toEqual({ kind: "invalid" });
  });
});
