/**
 * Built-in universal-footgun policy.
 *
 * Ships as a typed module (not a TOML asset) so:
 *   - `match_mode` and per-pattern `redirect` are compile-time checked,
 *   - there is no runtime FS read on activation,
 *   - ESM/pnpm/bundler asset-path resolution is a non-problem.
 *
 * The merge rule (see `mergePolicies` in `index.ts`):
 *   - Built-in targets live under the `__builtins__*` namespace so they
 *     cannot collide accidentally with real mise target names.
 *   - A project's `mise.toml [commands_meta.__builtins__find]` (or any
 *     other namespaced target) is treated as a deliberate override and
 *     replaces that specific built-in.
 *   - All non-colliding built-ins survive.
 *
 * Authoring rules for this file (enforced by `defaults.test.ts`):
 *   - Every pattern entry MUST carry a `redirect` so the block reason
 *     never falls back to `mise run __builtins__*` (which doesn't
 *     exist as a real mise target).
 *   - Short command names that would over-match as substrings (e.g.
 *     `find`) MUST use `matchMode: "command"`.
 *   - All targets MUST be namespaced `__builtins__*`.
 *
 * Deliberately excluded:
 *   - `cat <file>`: no reliable way to detect "large" from the command
 *     string. Universal prose hints in `prompt-addendum.ts` already
 *     cover it; blocking every `cat` would be too noisy.
 *   - Bare `grep` in command-mode: would match pipeline filters like
 *     `git status | grep modified`, which are correct usage. Only the
 *     recursive shape (`grep -r`, `grep -R`, `grep --recursive`) is
 *     the actual footgun.
 */

import type { ManifestPolicy } from "./manifest-loader.js";

export const BUILTIN_TARGET_PREFIX = "__builtins__";

const PROCESS_RECIPE = "Run via process({ action: \"start\", name: \"<job>\", command: \"<your-cmd>\" }) from @aliou/pi-processes; poll with process({ action: \"output\", id }).";

export const BUILTIN_POLICY: ManifestPolicy = {
  manifestPath: "<pi-bash-steer builtins>",
  targets: [
    {
      target: `${BUILTIN_TARGET_PREFIX}find`,
      unsafePatterns: [
        {
          pattern: "find",
          matchMode: "command",
          warning: "bash `find` is slow on large trees and ignores .gitignore.",
          redirect:
            "Use pi's `find` tool (glob-aware, respects .gitignore), `code_search` for semantic queries, or `rg --files <glob>` for raw file enumeration.",
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}grep_recursive`,
      unsafePatterns: [
        {
          pattern: "grep -r",
          matchMode: "substring",
          warning:
            "Recursive bash `grep` walks unpruned trees and ignores .gitignore.",
          redirect:
            "Use pi's `grep` tool or `rg <pattern>`. Pipeline filtering (`cmd | grep x`) is unchanged \u2014 only recursive disk search is blocked.",
        },
        {
          pattern: "grep -R",
          matchMode: "substring",
          warning:
            "Recursive bash `grep` walks unpruned trees and ignores .gitignore.",
          redirect:
            "Use pi's `grep` tool or `rg <pattern>`. Pipeline filtering (`cmd | grep x`) is unchanged \u2014 only recursive disk search is blocked.",
        },
        {
          pattern: "grep --recursive",
          matchMode: "substring",
          warning:
            "Recursive bash `grep` walks unpruned trees and ignores .gitignore.",
          redirect:
            "Use pi's `grep` tool or `rg <pattern>`. Pipeline filtering (`cmd | grep x`) is unchanged \u2014 only recursive disk search is blocked.",
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}ls_R`,
      unsafePatterns: [
        {
          pattern: "ls -R",
          matchMode: "substring",
          warning: "Recursive `ls -R` floods stdout and ignores .gitignore.",
          redirect:
            "Use `rg --files` (respects .gitignore) or pi's `find` tool with a glob pattern.",
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}tar_create`,
      unsafePatterns: [
        {
          pattern: "tar -c",
          matchMode: "substring",
          warning: "`tar` create mode is long-running on large trees.",
          redirect: PROCESS_RECIPE,
        },
        {
          pattern: "tar c",
          matchMode: "substring",
          warning: "`tar` create mode is long-running on large trees.",
          redirect: PROCESS_RECIPE,
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}du_root`,
      unsafePatterns: [
        {
          pattern: "du -sh /",
          matchMode: "substring",
          warning: "`du -sh /` scans the entire filesystem.",
          redirect:
            "Scope to a specific directory (e.g. `du -sh ./node_modules`) or run via process({...}) for unbounded scans.",
        },
        {
          pattern: "du -h /",
          matchMode: "substring",
          warning: "`du -h /` scans the entire filesystem.",
          redirect:
            "Scope to a specific directory (e.g. `du -h ./node_modules`) or run via process({...}) for unbounded scans.",
        },
        {
          pattern: "du -sh ~",
          matchMode: "substring",
          warning: "`du -sh ~` scans the entire home directory.",
          redirect:
            "Scope to a specific directory or run via process({...}) for unbounded scans.",
        },
        {
          pattern: "du -h ~",
          matchMode: "substring",
          warning: "`du -h ~` scans the entire home directory.",
          redirect:
            "Scope to a specific directory or run via process({...}) for unbounded scans.",
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}pkg_install`,
      unsafePatterns: [
        {
          pattern: "npm install",
          matchMode: "substring",
          warning: "Package install routinely exceeds the bash tool timeout.",
          redirect: PROCESS_RECIPE,
        },
        {
          pattern: "pnpm install",
          matchMode: "substring",
          warning: "Package install routinely exceeds the bash tool timeout.",
          redirect: PROCESS_RECIPE,
        },
        {
          pattern: "yarn install",
          matchMode: "substring",
          warning: "Package install routinely exceeds the bash tool timeout.",
          redirect: PROCESS_RECIPE,
        },
      ],
    },
    {
      target: `${BUILTIN_TARGET_PREFIX}docker_build`,
      unsafePatterns: [
        {
          pattern: "docker build",
          matchMode: "substring",
          warning: "`docker build` routinely exceeds the bash tool timeout.",
          redirect: PROCESS_RECIPE,
        },
      ],
    },
  ],
} as const;

/** Empty policy sentinel for disabled/missing branches. */
export const EMPTY_POLICY: ManifestPolicy = {
  manifestPath: "",
  targets: [],
} as const;

/**
 * Merge two policies. Project targets override built-in targets of the
 * same name (namespace-override rule). Order of survivors: built-ins
 * first (in declaration order), then project-only targets.
 *
 * Pure function; no mutation of either input.
 */
export function mergePolicies(
  builtins: ManifestPolicy,
  project: ManifestPolicy,
): ManifestPolicy {
  const projectByName = new Map(project.targets.map((t) => [t.target, t]));
  const merged: typeof builtins.targets[number][] = [];

  for (const builtin of builtins.targets) {
    const overriding = projectByName.get(builtin.target);
    merged.push(overriding ?? builtin);
    if (overriding) projectByName.delete(builtin.target);
  }
  for (const projectTarget of project.targets) {
    if (projectByName.has(projectTarget.target)) merged.push(projectTarget);
  }

  return {
    manifestPath: project.manifestPath || builtins.manifestPath,
    targets: merged,
  };
}

/** True iff the target name is in the built-in namespace. */
export function isBuiltinTarget(target: string): boolean {
  return target.startsWith(BUILTIN_TARGET_PREFIX);
}
