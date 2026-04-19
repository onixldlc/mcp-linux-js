/**
 * Command validator — port of tumf/mcp-shell-server semantics.
 *
 * Rules:
 *   1. ALLOW_COMMANDS (alias: ALLOWED_COMMANDS) = comma-separated list, spaces trimmed.
 *   2. Empty/unset list → UNRESTRICTED mode (we warn loudly on boot).
 *   3. Command is argv: string[]. Shell operators `;`, `&&`, `||`, `|` may appear as
 *      *separate argv tokens* (NOT inside a string — we never shell-interpret).
 *   4. Split argv on those operator-tokens. Each resulting segment's head (argv[0])
 *      must be in the allowlist.
 *   5. Empty segment (e.g. `["ls", ";", ";", "cat"]`) → invalid.
 *   6. An operator appearing *inside* a single token (e.g. "ls;rm") is NOT split —
 *      because we pass argv directly to execve, `;` has no shell meaning. But we
 *      still reject if the head token itself contains an operator, as defense-in-depth.
 */

export const SHELL_OPERATORS: ReadonlySet<string> = new Set([";", "&&", "||", "|"]);
const OPERATOR_REGEX = /[;|&]/;

export interface AllowList {
  readonly unrestricted: boolean;
  readonly commands: ReadonlySet<string>;
}

export function loadAllowList(env: NodeJS.ProcessEnv = process.env): AllowList {
  const raw = env.ALLOW_COMMANDS ?? env.ALLOWED_COMMANDS ?? "";
  const commands = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  return { unrestricted: commands.size === 0, commands };
}

export interface ValidationOk {
  ok: true;
}
export interface ValidationErr {
  ok: false;
  error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Split argv on operator tokens. Returns array of segments (each a non-empty argv).
 * Returns null if any resulting segment would be empty (dangling operator).
 */
export function splitOnOperators(argv: readonly string[]): string[][] | null {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of argv) {
    if (SHELL_OPERATORS.has(tok)) {
      if (current.length === 0) return null;
      segments.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  if (current.length === 0) return null;
  segments.push(current);
  return segments;
}

export function validateCommand(
  argv: readonly string[],
  allow: AllowList
): ValidationResult {
  if (argv.length === 0) {
    return { ok: false, error: "Empty command" };
  }

  const segments = splitOnOperators(argv);
  if (segments === null) {
    return { ok: false, error: "Invalid shell operator placement (empty segment)" };
  }

  for (const seg of segments) {
    const head = seg[0];
    // Defense in depth: head must not itself contain shell operators.
    if (OPERATOR_REGEX.test(head)) {
      return { ok: false, error: `Command contains shell operator: ${head}` };
    }
    if (!allow.unrestricted && !allow.commands.has(head)) {
      return { ok: false, error: `Command not allowed: ${head}` };
    }
  }

  return { ok: true };
}
