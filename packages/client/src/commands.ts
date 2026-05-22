export const COMMAND_NAMES = ["help", "config", "donate", "merch", "quit"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export type Classification =
  | { kind: "not-command" }
  | { kind: "incomplete" }
  | { kind: "valid"; command: CommandName }
  | { kind: "invalid" };

/**
 * Classify a compose-input string for command mode.
 *
 * Rules:
 *   - empty, or first char is not '/' → not-command
 *   - "/" alone, OR text after '/' is a non-empty prefix of some COMMAND_NAMES → incomplete
 *   - text after '/' exactly matches a COMMAND_NAMES entry → valid
 *   - otherwise → invalid
 *
 * Strict prefix matching is case-sensitive. v0.1 commands take no arguments.
 */
export function classifyInput(input: string): Classification {
  if (input.length === 0 || input[0] !== "/") return { kind: "not-command" };

  const rest = input.slice(1);
  if (rest.length === 0) return { kind: "incomplete" };

  for (const name of COMMAND_NAMES) {
    if (rest === name) return { kind: "valid", command: name };
  }
  for (const name of COMMAND_NAMES) {
    if (name.startsWith(rest)) return { kind: "incomplete" };
  }
  return { kind: "invalid" };
}
