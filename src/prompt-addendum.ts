import type { ManifestPolicy, TargetPolicy, UnsafePattern } from "./manifest-loader.js";

/**
 * Build a short system-prompt addendum that pre-empts unsafe bash usage.
 * Pure function: deterministic output from policy input.
 */
export function buildPromptAddendum(policy: ManifestPolicy): string {
  if (policy.targets.length === 0) return "";

  const lines = [
    "Verification guard addendum: use process(...) for long-running targets listed in [commands_meta.*].",
  ];

  for (const target of policy.targets) {
    lines.push(renderTargetHeader(target));
    lines.push(...renderPatterns(target.unsafePatterns));
    lines.push(
      `  process recipe: process({ action: \"start\", name: ${JSON.stringify(target.target)}, command: \"mise run ${target.target}\" })`,
    );
  }

  return lines.join("\n");
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
