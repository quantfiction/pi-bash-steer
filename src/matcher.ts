/**
 * Pure command matcher.
 *
 * Given a bash command string and a loaded ManifestPolicy, decide whether
 * any target's `unsafe_patterns` entry should fire.
 *
 * Two match modes are supported per pattern (see `MatchMode` in
 * manifest-loader.ts):
 *
 *   1. "substring" (default, v1 behavior): literal `String.prototype.includes`.
 *      Authors write the unique substring of the unsafe invocation
 *      (`./scripts/preflight.sh`, `pnpm test:run`) and the matcher does
 *      plain containment. This is correct for multi-token patterns where
 *      the substring uniquely identifies the unsafe shape.
 *
 *   2. "command": pattern is a bare command name (e.g. `find`, `grep`)
 *      and matches when it appears as argv[0] of any pipeline element
 *      after env-prefix and wrapper stripping. This is needed for short
 *      command names whose substring would over-match
 *      (`find` appears in `findings.md`, `npm run find-deps`, etc).
 *
 *   3. "regex": pattern is a JavaScript regex source string (no
 *      delimiters, no flags). Compiled with `new RegExp(pattern)` and
 *      tested against the raw command. Use this when substring would
 *      false-positive on flag prefixes — e.g. `git commit --all\b`
 *      blocks `git commit --all` and `git commit --all -m "x"` but
 *      not `git commit --allow-empty`. Invalid regex sources fall back
 *      to substring containment (preserves the cost-asymmetric bias
 *      toward over-blocking; a manifest typo cannot silently disable
 *      a guard).
 *
 * Tokenization contract (command mode):
 *   - Parsing via `shell-quote` (pure JS, no native deps, sync).
 *   - Pipeline element boundaries: `&&`, `||`, `|`, `|&`, `;`, `&`, and
 *     the subshell / process-substitution ops `(`, `)`, `<(`, `>(`.
 *     After any of these, the next bare word is considered a new argv[0].
 *   - Env-var prefixes (`FOO=1 cmd`) are skipped: at argv[0] position, a
 *     token matching `^[A-Za-z_][A-Za-z0-9_]*=` is consumed and the next
 *     bare word becomes argv[0] instead.
 *   - Process wrappers `timeout`, `time`, `nice`, `nohup`, `stdbuf` are
 *     skipped along with any subsequent flag-shaped (`-x`, `--x`) or
 *     numeric/duration tokens (`30`, `30s`); the next command-shaped
 *     token becomes argv[0]. This matches the common `timeout 30 cmd`
 *     and `nice -n 10 cmd` shapes.
 *   - Bare `xargs` (no flags) is also skipped — `xargs grep x` matches
 *     a `command=grep` pattern. `xargs -n1 grep x` keeps `xargs` as
 *     argv[0] because the flag indicates explicit configuration; this
 *     matches Claude Code's documented behavior for `xargs`.
 *   - The basename of argv[0] is compared (so `/usr/bin/find` matches
 *     `command=find`).
 *
 * Known limitations (v1 — deliberate, documented for future Q-G review):
 *   - `bash -c "find . -name x"` / `eval "..."` / `sh -c "..."`: shell-quote
 *     returns the inner string opaquely. Only the outer command (`bash`,
 *     `eval`, `sh`) is observable. Manifest authors who need to defend
 *     against this should add `command=bash` / `command=eval` rules, or
 *     rely on substring patterns covering the inner string.
 *   - Heredocs are tokenized as words; the heredoc body is not parsed.
 *   - On `shell-quote` parse error, command-mode falls back to substring
 *     match for that pattern. This preserves the existing cost-asymmetric
 *     bias toward over-blocking.
 *
 * Returned as a discriminated union so the listener can `switch` on
 * `matched` with compiler-enforced exhaustiveness.
 */

import { parse as shellParse } from "shell-quote";
import type { ManifestPolicy, UnsafePattern } from "./manifest-loader.js";

export type MatchResult =
  | {
      readonly matched: true;
      readonly target: string;
      readonly pattern: UnsafePattern;
      readonly expectedDuration?: string;
      readonly gotchas?: string;
    }
  | { readonly matched: false };

const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Operators that begin a fresh pipeline element — the next bare word is a new argv[0]. */
const PIPELINE_OPS: ReadonlySet<string> = new Set([
  "&&",
  "||",
  "|",
  "|&",
  ";",
  "&",
  "(",
  ")",
  "<(",
  ">(",
]);

/** Process wrappers that consume flag/numeric tokens after their name (`timeout 30 cmd`). */
const FLAG_CONSUMING_WRAPPERS: ReadonlySet<string> = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
]);

function looksLikeFlagOrDuration(tok: string): boolean {
  if (tok.startsWith("-")) return true;
  // Numeric duration: `30`, `30s`, `1.5m`, `0.1`.
  if (/^[0-9]+(\.[0-9]+)?[smhd]?$/.test(tok)) return true;
  return false;
}

type ShellToken = ReturnType<typeof shellParse>[number];

function isOp(tok: ShellToken): tok is { op: string } {
  return typeof tok === "object" && tok !== null && "op" in tok;
}

/**
 * Split the shell-quote token stream into pipeline-element token arrays.
 * Pipeline boundaries are the ops in `PIPELINE_OPS`. Redirect ops (`>`,
 * `2>`, etc.) and their target tokens stay inside the current element —
 * they never appear at argv[0] position so they don't affect matching.
 */
function splitIntoElements(tokens: readonly ShellToken[]): ShellToken[][] {
  const elements: ShellToken[][] = [[]];
  for (const tok of tokens) {
    if (isOp(tok) && PIPELINE_OPS.has(tok.op)) {
      elements.push([]);
      continue;
    }
    elements[elements.length - 1]!.push(tok);
  }
  return elements.filter((el) => el.length > 0);
}

/**
 * Extract the argv[0] basename from a single pipeline-element token array.
 * Returns `null` if the element has no recognizable command word.
 */
function elementArgv0(element: readonly ShellToken[]): string | null {
  let i = 0;

  // Step 1: skip leading env-var assignments (`FOO=1 BAR=2 cmd`).
  while (i < element.length) {
    const tok = element[i]!;
    if (typeof tok !== "string") break;
    if (!ENV_PREFIX_RE.test(tok)) break;
    i++;
  }

  // Step 2: peek the candidate command word, looping through wrapper layers.
  while (i < element.length) {
    const tok = element[i]!;
    if (typeof tok !== "string") {
      // Non-string token at argv[0] position (redirect op, etc.) — skip it.
      i++;
      continue;
    }
    const name = basename(tok);

    // Bare `xargs` (no flags) is stripped; `xargs grep x` matches command=grep.
    if (name === "xargs") {
      const next = element[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        i++;
        continue;
      }
      return name;
    }

    if (FLAG_CONSUMING_WRAPPERS.has(name)) {
      // Skip wrapper + subsequent flag-shaped or numeric/duration tokens.
      i++;
      while (i < element.length) {
        const peek = element[i];
        if (typeof peek !== "string") {
          i++;
          continue;
        }
        if (looksLikeFlagOrDuration(peek)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    return name;
  }
  return null;
}

/**
 * Walk the shell-quote token stream and return the basename of argv[0] for
 * every pipeline element discovered. Returns `null` if shell-quote fails to
 * parse (caller should fall back to substring matching).
 */
function extractCommandNames(command: string): readonly string[] | null {
  let tokens: readonly ShellToken[];
  try {
    tokens = shellParse(command);
  } catch {
    return null;
  }
  const elements = splitIntoElements(tokens);
  const names: string[] = [];
  for (const el of elements) {
    const name = elementArgv0(el);
    if (name !== null) names.push(name);
  }
  return names;
}

function basename(p: string): string {
  // Strip both POSIX and Windows separators — manifests may target either.
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function patternMatches(command: string, pattern: UnsafePattern): boolean {
  if (pattern.matchMode === "command") {
    const names = extractCommandNames(command);
    if (names === null) {
      // Parse failure — fall back to substring to preserve over-block bias.
      return command.includes(pattern.pattern);
    }
    return names.includes(pattern.pattern);
  }
  if (pattern.matchMode === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(pattern.pattern);
    } catch {
      // Invalid regex source — fall back to substring to preserve
      // over-block bias (a manifest typo must not silently disable a guard).
      return command.includes(pattern.pattern);
    }
    return re.test(command);
  }
  // substring mode (default)
  return command.includes(pattern.pattern);
}

export function matchUnsafePattern(command: string, policy: ManifestPolicy): MatchResult {
  if (command.length === 0) return { matched: false };
  for (const target of policy.targets) {
    for (const pattern of target.unsafePatterns) {
      if (patternMatches(command, pattern)) {
        return {
          matched: true,
          target: target.target,
          pattern,
          expectedDuration: target.expectedDuration,
          gotchas: target.gotchas,
        };
      }
    }
  }
  return { matched: false };
}
