import { isBuiltinTarget } from "./defaults.js";
import type { ManifestPolicy, TargetPolicy, UnsafePattern } from "./manifest-loader.js";
import type { ToolPalette } from "./tool-palette.js";

/**
 * Build a short system-prompt addendum that pre-empts unsafe bash usage.
 * Pure function: deterministic output from policy + runtime tool palette.
 *
 * Composition:
 *   1. Universal tool-affinity hints (always emitted) — steer the agent
 *      away from bash footguns using only tools/binaries detected in the
 *      current session.
 *   2. Per-target verification guidance (only when the manifest
 *      declares at least one project target) — names the target and the
 *      best available non-synchronous execution path.
 *
 * Universal hints come first so primacy bias favors the
 * always-applicable rules over the project-specific ones.
 */
export function buildPromptAddendum(policy: ManifestPolicy, palette: ToolPalette): string {
  const lines: string[] = [];
  lines.push(...renderUniversalHints(palette));

  // Built-in `__builtins__*` targets are deliberately filtered out:
  // their coverage is already described in the universal hints above,
  // and listing synthetic sections would balloon the system prompt
  // without telling the agent anything new. Block reasons still surface
  // palette-aware redirects at point-of-error.
  const projectTargets = policy.targets.filter((t) => !isBuiltinTarget(t.target));

  if (projectTargets.length > 0) {
    lines.push("");
    lines.push(renderProjectTargetIntro(palette));
    for (const target of projectTargets) {
      lines.push(renderTargetHeader(target));
      lines.push(...renderPatterns(target.unsafePatterns));
      if (target.unsafePatterns.some((pattern) => !pattern.redirect)) {
        lines.push(...renderTargetRecipe(target, palette));
      }
    }
  }

  return lines.join("\n");
}

/**
 * Universal bash → available-tool-affinity hints. Independent of any
 * project manifest. Cheap prose-level steering for footguns that have
 * better alternatives in this runtime's tool palette.
 */
function renderUniversalHints(palette: ToolPalette): string[] {
  const lines = ["Bash tool-affinity hints (universal):"];
  lines.push("Prefer available native/bounded tools over re-rolling them in bash.");

  const findAlternatives: string[] = [];
  if (palette.hasNativeFind) findAlternatives.push("the `find` tool");
  if (palette.hasRg) findAlternatives.push("`rg --files`");
  if (palette.hasFd) findAlternatives.push("`fd`");
  lines.push(
    `  - To find files by name/glob:      ${renderAvailableAlternative(findAlternatives, "narrow the path/pattern and prune generated directories explicitly")}.`,
  );
  lines.push("                                     Avoid broad bash `find` from repository roots.");

  const grepAlternatives: string[] = [];
  if (palette.hasNativeGrep) grepAlternatives.push("the `grep` tool");
  if (palette.hasRg) grepAlternatives.push("`rg <pattern>`");
  lines.push("  - To search file contents (literal/regex):");
  lines.push(
    `                                     ${renderAvailableAlternative(grepAlternatives, "scope recursive shell search tightly and prune generated directories explicitly")}.`,
  );
  lines.push("                                     Avoid bash `grep -r` / `grep ... -r`.");

  if (palette.hasCodeSearch) {
    lines.push('  - For exploratory/semantic search ("how does X work"):');
    lines.push("                                     use `code_search` rather than grep-blasting vague terms.");
  }

  if (palette.hasNativeRead) {
    lines.push("  - To read a file:                  use the `read` tool (bounded with offset/limit).");
    lines.push("                                     Avoid bash `cat <file>` (unbounded output).");
  }

  const treeAlternatives: string[] = [];
  if (palette.hasRg) treeAlternatives.push("`rg --files`");
  if (palette.hasFd) treeAlternatives.push("`fd`");
  if (palette.hasNativeFind) treeAlternatives.push("the `find` tool with a glob pattern");
  lines.push("  - To list a tree recursively:");
  lines.push(
    `                                     ${renderAvailableAlternative(treeAlternatives, "avoid recursive tree dumps; narrow the directory and output shape")}.`,
  );
  lines.push("                                     Avoid bash `ls -R` (pi `ls` is non-recursive).");

  return lines;
}

function renderProjectTargetIntro(palette: ToolPalette): string {
  if (palette.hasProcess) {
    return "Verification guard addendum: use process(...) for long-running targets listed in [commands_meta.*].";
  }
  if (palette.hasTmux) {
    return "Verification guard addendum: run long-running targets listed in [commands_meta.*] via tmux + log polling; do not run them synchronously through bash.";
  }
  return "Verification guard addendum: run long-running targets listed in [commands_meta.*] as background jobs with log polling; do not run them synchronously through bash.";
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
    if (pattern.redirect) lines.push(`      redirect: ${renderPatternRedirect(pattern.redirect)}`);
  }
  return lines;
}

function renderPatternRedirect(redirect: UnsafePattern["redirect"]): string {
  if (!redirect) return "";
  if (typeof redirect === "string") return redirect;
  switch (redirect.kind) {
    case "process":
    case "shell":
      return `${redirect.kind}: ${redirect.recipe}`;
    case "tool":
      return `tool:${redirect.tool}: ${redirect.recipe}`;
    case "prose":
      return `prose: ${redirect.text}`;
  }
}

function renderTargetRecipe(target: TargetPolicy, palette: ToolPalette): string[] {
  const command = `mise run ${target.target}`;
  if (palette.hasProcess) {
    return [
      `  process recipe: process({ action: "start", name: ${JSON.stringify(target.target)}, command: ${JSON.stringify(command)} })`,
    ];
  }

  const slug = slugifyJobName(target.target);
  const logPath = `.pi-bash-steer/${slug}.log`;
  const exitPath = `.pi-bash-steer/${slug}.exit`;

  if (palette.hasTmux) {
    const session = `pi-bash-steer-${slug}`;
    return [
      "  tmux recipe:",
      "    mkdir -p .pi-bash-steer",
      `    tmux new-session -d -s ${shellQuote(session)} ${shellQuote(`${command} > ${logPath} 2>&1; echo $? > ${exitPath}`)}`,
      `    tail -n 80 ${shellQuote(logPath)}`,
      `    tmux has-session -t ${shellQuote(session)} || cat ${shellQuote(exitPath)}`,
    ];
  }

  return [
    "  background recipe:",
    "    mkdir -p .pi-bash-steer",
    `    (${command} > ${shellQuote(logPath)} 2>&1; echo $? > ${shellQuote(exitPath)}) &`,
    `    tail -n 80 ${shellQuote(logPath)}`,
  ];
}

function renderAvailableAlternative(alternatives: readonly string[], fallback: string): string {
  if (alternatives.length === 0) return fallback;
  return `use ${joinAlternatives(alternatives)}`;
}

function joinAlternatives(alternatives: readonly string[]): string {
  if (alternatives.length === 1) return alternatives[0] ?? "";
  if (alternatives.length === 2) return `${alternatives[0]} or ${alternatives[1]}`;
  return `${alternatives.slice(0, -1).join(", ")}, or ${alternatives[alternatives.length - 1]}`;
}

function slugifyJobName(name: string): string {
  const slug = name
    .replace(/^_+|_+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.length > 0 ? slug : "job";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
