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
 *   - Short command names that would over-match as substrings (e.g.
 *     `find`) MUST use `matchMode: "command"`.
 *   - All targets MUST be namespaced `__builtins__*`.
 *   - Built-in redirects are generated from the runtime tool palette in
 *     `reason-builder.ts`; do not hard-code `process(...)` here.
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
        },
        {
          pattern: "grep -R",
          matchMode: "substring",
          warning:
            "Recursive bash `grep` walks unpruned trees and ignores .gitignore.",
        },
        {
          pattern: "grep --recursive",
          matchMode: "substring",
          warning:
            "Recursive bash `grep` walks unpruned trees and ignores .gitignore.",
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
        },
        {
          pattern: "tar c",
          matchMode: "substring",
          warning: "`tar` create mode is long-running on large trees.",
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
        },
        {
          pattern: "du -h /",
          matchMode: "substring",
          warning: "`du -h /` scans the entire filesystem.",
        },
        {
          pattern: "du -sh ~",
          matchMode: "substring",
          warning: "`du -sh ~` scans the entire home directory.",
        },
        {
          pattern: "du -h ~",
          matchMode: "substring",
          warning: "`du -h ~` scans the entire home directory.",
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
        },
        {
          pattern: "pnpm install",
          matchMode: "substring",
          warning: "Package install routinely exceeds the bash tool timeout.",
        },
        {
          pattern: "yarn install",
          matchMode: "substring",
          warning: "Package install routinely exceeds the bash tool timeout.",
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
        },
      ],
    },
    {
      // Block broad-include git staging/commit shapes. Universal footgun
      // whenever a working tree is shared between concurrent agent
      // sessions (parallel workspaces, lifecycle worktree, operator
      // running multiple pi sessions in the same checkout): one
      // session's commit captures another session's unrelated working-
      // tree edits, both attributed to the wrong task. Prose
      // discipline ("explicit paths only") in repo AGENTS.md does not
      // hold under load.
      //
      // Deliberately excluded shape: `git add .` (single-dot path).
      // In substring mode it false-positives on legitimate explicit-
      // path commits like `git add ./services/web/src/app.tsx`. Wait
      // for flag-aware mode (roadmap) before adding it.
      //
      // Patterns use `matchMode: "regex"` with `\b` flag boundaries so
      // legitimate flag siblings (e.g. `git commit --allow-empty`,
      // `--allow-empty-message`, `--allow-empty-author`) do not
      // false-positive on the `--all` substring. Plain substring
      // matching shipped originally and was reported to block
      // `git commit --allow-empty` (a canonical idiom for empty marker
      // commits); the regex anchor is the minimum surface change that
      // fixes the FP without giving up the universal-footgun coverage.
      target: `${BUILTIN_TARGET_PREFIX}git_broad_add`,
      unsafePatterns: [
        {
          pattern: "git add -A\\b",
          matchMode: "regex",
          warning:
            "`git add -A` stages every change in the worktree, including unrelated edits from concurrent agent sessions. Stage explicit paths.",
        },
        {
          pattern: "git add --all\\b",
          matchMode: "regex",
          warning:
            "`git add --all` stages every change in the worktree, including unrelated edits from concurrent agent sessions. Stage explicit paths.",
        },
        {
          pattern: "git commit -a\\b",
          matchMode: "regex",
          warning:
            "`git commit -a` auto-stages every tracked file, including unrelated edits from concurrent agent sessions. Stage explicit paths first, then commit.",
        },
        {
          pattern: "git commit --all\\b",
          matchMode: "regex",
          warning:
            "`git commit --all` auto-stages every tracked file, including unrelated edits from concurrent agent sessions. Stage explicit paths first, then commit.",
        },
        {
          pattern: "git commit -am\\b",
          matchMode: "regex",
          warning:
            "`git commit -am` auto-stages every tracked file, including unrelated edits from concurrent agent sessions. Stage explicit paths first, then commit.",
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
