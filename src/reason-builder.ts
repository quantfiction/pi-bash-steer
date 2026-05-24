import { BUILTIN_TARGET_PREFIX, isBuiltinTarget } from "./defaults.js";
import type { UnsafePatternRedirect } from "./manifest-loader.js";
import type { ToolPalette } from "./tool-palette.js";

interface BuildBlockReasonInput {
  readonly command: string;
  readonly target: string;
  readonly pattern: string;
  readonly warning?: string;
  readonly expectedDuration?: string;
  readonly redirect?: UnsafePatternRedirect;
  readonly palette: ToolPalette;
}

export function buildBlockReason(input: BuildBlockReasonInput): string {
  const durationNote = input.expectedDuration
    ? ` (expected duration ~${input.expectedDuration})`
    : "";
  const builtin = isBuiltinTarget(input.target);
  const sourceNote = builtin
    ? `pi-bash-steer built-in (${input.target})`
    : `mise.toml [commands_meta.${input.target}].unsafe_patterns`;
  const lines = [
    `Blocked: command matches ${sourceNote} entry ${JSON.stringify(input.pattern)}${durationNote}.`,
  ];

  if (input.warning) lines.push(input.warning);
  lines.push(
    input.redirect ? renderAuthoredRedirect(input.redirect, input.palette) : renderRedirect(input),
  );

  return lines.join("\n");
}

function renderAuthoredRedirect(redirect: UnsafePatternRedirect, palette: ToolPalette): string {
  if (typeof redirect === "string") return redirect;

  switch (redirect.kind) {
    case "process":
      if (palette.hasProcess) return `Use the active \`process\` tool:\n  ${redirect.recipe}`;
      return [
        "This pattern declares a process-tool redirect, but the `process` tool is not active in this session.",
        "Enable @aliou/pi-processes to use the intended recipe:",
        `  ${redirect.recipe}`,
      ].join("\n");
    case "tool":
      if (palette.activeToolNames.includes(redirect.tool)) {
        return `Use the active \`${redirect.tool}\` tool:\n  ${redirect.recipe}`;
      }
      if (palette.registeredToolNames.includes(redirect.tool)) {
        return [
          `This pattern declares a \`${redirect.tool}\` tool redirect, but that tool is not active in this session.`,
          "Enable the tool or choose an available alternative. Intended recipe:",
          `  ${redirect.recipe}`,
        ].join("\n");
      }
      return [
        `This pattern declares a \`${redirect.tool}\` tool redirect, but that tool is not available in this session.`,
        "Choose an available alternative. Intended recipe:",
        `  ${redirect.recipe}`,
      ].join("\n");
    case "shell":
      return `Use this shell alternative instead:\n  ${redirect.recipe}`;
    case "prose":
      return redirect.text;
  }
}

function renderRedirect(input: BuildBlockReasonInput): string {
  if (!isBuiltinTarget(input.target)) {
    return renderProcessModelRedirect({
      command: `mise run ${input.target}`,
      jobName: input.target,
      palette: input.palette,
    });
  }

  switch (input.target) {
    case `${BUILTIN_TARGET_PREFIX}find`:
      return renderFindRedirect(input.palette);
    case `${BUILTIN_TARGET_PREFIX}grep_recursive`:
      return renderGrepRecursiveRedirect(input.palette);
    case `${BUILTIN_TARGET_PREFIX}ls_R`:
      return renderLsRecursiveRedirect(input.palette);
    case `${BUILTIN_TARGET_PREFIX}du_root`:
      return renderDuRootRedirect(input.command, input.palette);
    case `${BUILTIN_TARGET_PREFIX}tar_create`:
    case `${BUILTIN_TARGET_PREFIX}pkg_install`:
    case `${BUILTIN_TARGET_PREFIX}docker_build`:
      return renderProcessModelRedirect({
        command: input.command,
        jobName: slugifyJobName(input.target.replace(BUILTIN_TARGET_PREFIX, "")),
        palette: input.palette,
      });
    default:
      return renderProcessModelRedirect({
        command: input.command,
        jobName: slugifyJobName(input.target.replace(BUILTIN_TARGET_PREFIX, "")),
        palette: input.palette,
      });
  }
}

function renderFindRedirect(palette: ToolPalette): string {
  const alternatives: string[] = [];
  if (palette.hasNativeFind) {
    alternatives.push("pi's `find` tool for glob-aware file discovery that respects .gitignore");
  }
  if (palette.hasRg) alternatives.push("`rg --files <glob>` for raw file enumeration");
  if (palette.hasFd) alternatives.push("`fd <pattern>` for fast file discovery");
  if (palette.hasCodeSearch) alternatives.push("`code_search` for semantic/exploratory queries");

  if (alternatives.length === 0) {
    return "Avoid broad bash `find` from repository roots. Narrow the search path/pattern and prune generated directories explicitly.";
  }
  return `Use ${joinAlternatives(alternatives)} instead of bash \`find\`.`;
}

function renderGrepRecursiveRedirect(palette: ToolPalette): string {
  const alternatives: string[] = [];
  if (palette.hasNativeGrep) {
    alternatives.push("pi's `grep` tool for bounded literal/regex search that respects .gitignore");
  }
  if (palette.hasRg) alternatives.push("`rg <pattern>` for shell-level recursive search");

  if (alternatives.length === 0) {
    return "Avoid recursive bash `grep` from broad roots. Scope the path tightly and prune generated directories explicitly.";
  }
  return `Use ${joinAlternatives(alternatives)} instead. Pipeline filtering (\`cmd | grep x\`) is unchanged — only recursive disk search is blocked.`;
}

function renderLsRecursiveRedirect(palette: ToolPalette): string {
  const alternatives: string[] = [];
  if (palette.hasRg) alternatives.push("`rg --files`");
  if (palette.hasFd) alternatives.push("`fd <pattern>`");
  if (palette.hasNativeFind) alternatives.push("pi's `find` tool with a glob pattern");

  if (alternatives.length === 0) {
    return "Avoid `ls -R`; it floods output and ignores .gitignore. Narrow the directory or use a scoped file-discovery command.";
  }
  return `Use ${joinAlternatives(alternatives)} instead of recursive \`ls -R\`.`;
}

function renderDuRootRedirect(command: string, palette: ToolPalette): string {
  const lines = ["Scope `du` to a specific directory, e.g. `du -sh ./node_modules`, instead of scanning `/` or the whole home directory."];
  const fallback = renderProcessModelFallback(command, "du-scan", palette);
  if (fallback) lines.push(`If you genuinely need the full scan, ${fallback}`);
  return lines.join("\n");
}

function renderProcessModelRedirect(input: {
  readonly command: string;
  readonly jobName: string;
  readonly palette: ToolPalette;
}): string {
  const fallback = renderProcessModelFallback(input.command, input.jobName, input.palette);
  return `Run this outside the synchronous bash tool. ${fallback}`;
}

function renderProcessModelFallback(
  command: string,
  jobName: string,
  palette: ToolPalette,
): string {
  const slug = slugifyJobName(jobName);
  if (palette.hasProcess) {
    return [
      "Use the active `process` tool:",
      `  process({ action: "start", name: ${JSON.stringify(slug)}, command: ${JSON.stringify(command)} })`,
      "Then poll with `process({ action: \"output\", id })` or `process({ action: \"logs\", id })`.",
    ].join("\n");
  }

  const logPath = `.pi-bash-steer/${slug}.log`;
  const exitPath = `.pi-bash-steer/${slug}.exit`;
  if (palette.hasTmux) {
    const session = `pi-bash-steer-${slug}`;
    return [
      "Use a tmux session plus log polling:",
      "```sh",
      "mkdir -p .pi-bash-steer",
      `tmux new-session -d -s ${shellQuote(session)} ${shellQuote(`${command} > ${logPath} 2>&1; echo $? > ${exitPath}`)}`,
      `tail -n 80 ${shellQuote(logPath)}`,
      `tmux has-session -t ${shellQuote(session)} || cat ${shellQuote(exitPath)}`,
      "```",
    ].join("\n");
  }

  return [
    "Use a background shell job plus log polling:",
    "```sh",
    "mkdir -p .pi-bash-steer",
    `(${command} > ${shellQuote(logPath)} 2>&1; echo $? > ${shellQuote(exitPath)}) &`,
    `tail -n 80 ${shellQuote(logPath)}`,
    "```",
  ].join("\n");
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

function joinAlternatives(alternatives: readonly string[]): string {
  if (alternatives.length === 1) return alternatives[0] ?? "";
  if (alternatives.length === 2) return `${alternatives[0]} or ${alternatives[1]}`;
  return `${alternatives.slice(0, -1).join(", ")}, or ${alternatives[alternatives.length - 1]}`;
}
