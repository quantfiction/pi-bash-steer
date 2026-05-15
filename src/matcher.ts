/**
 * Pure command matcher.
 *
 * Given a bash command string and a loaded ManifestPolicy, decide whether
 * any target's `unsafe_patterns` substring is present in the command.
 *
 * Q-G resolution: regex/AST shell parsing is deferred. v1 uses literal
 * substring matching, mirroring the manifest author's stated intent — the
 * patterns ARE the substrings to match. AST parsing is a future
 * refinement if false-negatives surface in practice.
 *
 * Matching semantics:
 *   - Case-sensitive (shell commands are case-sensitive).
 *   - Pure substring containment (`String.prototype.includes`).
 *   - First match wins, in target-declaration order. Within a target,
 *     patterns are tested in declaration order.
 *
 * Returned as a discriminated union so the listener can `switch` on
 * `matched` with compiler-enforced exhaustiveness.
 */

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

export function matchUnsafePattern(command: string, policy: ManifestPolicy): MatchResult {
  if (command.length === 0) return { matched: false };
  for (const target of policy.targets) {
    for (const pattern of target.unsafePatterns) {
      if (command.includes(pattern.pattern)) {
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
