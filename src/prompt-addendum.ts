import { isBuiltinTarget } from "./defaults.js";
import type { ManifestPolicy, TargetPolicy, UnsafePattern } from "./manifest-loader.js";

/**
 * Build a short system-prompt addendum that pre-empts unsafe bash usage.
 * Pure function: deterministic output from policy input.
 *
 * Composition:
 *   1. Universal tool-affinity hints (always emitted) — steer the agent
 *      away from bash footguns that have pi-native or rg-based
 *      alternatives. Independent of the project's [commands_meta.*].
 *   2. Per-target verification guidance (only when the manifest
 *      declares at least one target) — names the target and the
 *      paste-ready `process({...})` recipe.
 *
 * Universal hints come first so primacy bias favors the
 * always-applicable rules over the project-specific ones.
 */
export function buildPromptAddendum(policy: ManifestPolicy): string {
  const lines: string[] = [];
  lines.push(...renderUniversalHints());

  // Built-in `__builtins__*` targets are deliberately filtered out:
  // their coverage is already described in the universal hints above,
  // and listing 7+ synthetic sections would balloon the system prompt
  // without telling the agent anything new. Block reasons still surface
  // the per-pattern redirect at point-of-error.
  const projectTargets = policy.targets.filter((t) => !isBuiltinTarget(t.target));

  if (projectTargets.length > 0) {
    lines.push("");
    lines.push(
      "Verification guard addendum: use process(...) for long-running targets listed in [commands_meta.*].",
    );
    for (const target of projectTargets) {
      lines.push(renderTargetHeader(target));
      lines.push(...renderPatterns(target.unsafePatterns));
      lines.push(
        `  process recipe: process({ action: \"start\", name: ${JSON.stringify(target.target)}, command: \"mise run ${target.target}\" })`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Universal bash → pi-native tool-affinity hints. Independent of any
 * project manifest. Cheap prose-level steering for footguns that have
 * better alternatives in pi's tool palette.
 *
 * `code_search` is included conditionally ("if available") rather than
 * runtime-detected; the agent self-resolves based on its tool list.
 * Runtime tool-palette detection is a separate roadmap item.
 */
function renderUniversalHints(): string[] {
  return [
    "Bash tool-affinity hints (universal):",
    "Prefer pi's native tools over re-rolling them in bash. They are faster,",
    "bounded, and respect .gitignore.",
    "  - To find files by name/glob:      use the `find` tool or `rg --files`.",
    "                                     Avoid bash `find` (slow; ignores .gitignore).",
    "  - To search file contents (literal/regex):",
    "                                     use the `grep` tool or `rg`.",
    "                                     Avoid bash `grep -r` / `grep ... -r`.",
    '  - For exploratory/semantic search ("how does X work"):',
    "                                     prefer `code_search` if available; else `grep`/`rg`.",
    "                                     Avoid grep-blasting vague terms across the repo.",
    "  - To read a file:                  use the `read` tool (bounded with offset/limit).",
    "                                     Avoid bash `cat <file>` (unbounded output).",
    "  - To list a tree recursively:      use `rg --files` (or bash `find` as fallback).",
    "                                     Avoid bash `ls -R` (pi `ls` is non-recursive).",
  ];
}

function renderTargetHeader(target: TargetPolicy): string {
  const duration = target.expectedDuration ? ` expected_duration=${target.expectedDuration}` : "";
  return `- [commands_meta.${target.target}]${duration}`;
}

function renderPatterns(patterns: readonly UnsafePattern[]): string[] {
  const lines = ["  unsafe_patterns:"];
  for (const pattern of patterns) {
    lines.push(`    - ${JSON.stringify(pattern.pattern)}`);
    if (pattern.warning) lines.push(`      warning: ${pattern.warning}`);
  }
  return lines;
}
