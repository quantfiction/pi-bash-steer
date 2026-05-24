/**
 * Pure manifest loader.
 *
 * Walks up from a starting directory to find the nearest `mise.toml`,
 * parses it, and normalizes the `[commands_meta.<target>]` blocks into
 * a typed policy. The loader never throws into a tool_call return path —
 * all I/O and parse errors are caught here and translated to a tagged
 * "no usable manifest" result.
 *
 * Substrate:
 *   - smol-toml (current / maintained TOML parser, Q-B resolution)
 *   - manifest schema: `mise.toml` lines 50–86 (MindHive)
 *
 * The `unsafe_patterns` field accepts a bare-string shape plus object
 * entries with optional warnings, match modes, and per-pattern redirects:
 *
 *   unsafe_patterns = ["./scripts/preflight.sh"]
 *   unsafe_patterns = [{ pattern = "pnpm build", warning = "…" }]
 *   unsafe_patterns = [{ pattern = "find", match_mode = "command" }]
 *   unsafe_patterns = [{ pattern = "grep -r", redirect = { kind = "shell", recipe = "rg <pattern> <path>" } }]
 *
 * Bare-string entries default to `matchMode = "substring"` for backward
 * compatibility and receive the default target-level redirect at block time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * How a pattern's `pattern` string is compared against an incoming bash
 * command.
 *
 *   - "substring": literal `String.prototype.includes` containment. v1
 *     default. Safe for multi-token patterns like `./scripts/preflight.sh`
 *     or `pnpm test:run` where the substring uniquely identifies the
 *     unsafe invocation.
 *   - "command": pattern is a bare command name (e.g. `find`, `grep`)
 *     and matches when it appears as argv[0] of any pipeline element
 *     after env-prefix and wrapper stripping. Use this for short command
 *     names whose substring would over-match (`find` in `findings.md`).
 *     See matcher.ts for the full tokenization contract and limitations.
 */
export type MatchMode = "substring" | "command";
export type RedirectKind = "process" | "tool" | "shell" | "prose";

export type RedirectDescriptor =
  | { readonly kind: "process"; readonly recipe: string }
  | { readonly kind: "tool"; readonly tool: string; readonly recipe: string }
  | { readonly kind: "shell"; readonly recipe: string }
  | { readonly kind: "prose"; readonly text: string };

export type UnsafePatternRedirect = string | RedirectDescriptor;

export interface UnsafePattern {
  /** Substring or command name compared against the bash command per `matchMode`. */
  readonly pattern: string;
  /** Comparison mode. Defaults to "substring" for backward compatibility. */
  readonly matchMode: MatchMode;
  /** Optional per-pattern warning the manifest author wants surfaced in the block reason. */
  readonly warning?: string;
  /**
   * Optional per-pattern redirect. String redirects are legacy free-form
   * prose. Object redirects are normalized descriptors interpreted by
   * the block-reason builder.
   */
  readonly redirect?: UnsafePatternRedirect;
}

export interface TargetPolicy {
  /** Manifest target name, e.g. "preflight", "build". */
  readonly target: string;
  readonly unsafePatterns: readonly UnsafePattern[];
  /** Optional human-friendly expected duration, e.g. "30m". */
  readonly expectedDuration?: string;
  /** Optional gotchas note from the manifest. */
  readonly gotchas?: string;
}

export interface ManifestPolicy {
  /** Absolute path to the mise.toml that produced this policy. */
  readonly manifestPath: string;
  readonly targets: readonly TargetPolicy[];
}

export type ManifestLoadResult =
  | { readonly status: "ok"; readonly policy: ManifestPolicy }
  | { readonly status: "no_manifest"; readonly searchedFrom: string }
  | { readonly status: "empty"; readonly manifestPath: string }
  | { readonly status: "error"; readonly manifestPath?: string; readonly message: string };

/**
 * Walk from `startDir` upward until a `mise.toml` is found or filesystem root is reached.
 * Returns the absolute path or `null`.
 */
export async function findManifest(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  // Bound the walk: filesystem root has parent === itself.
  // Defensive cap at 64 levels to avoid pathological symlink loops.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(current, "mise.toml");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not present — keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Load and normalize the manifest. Pure with respect to its inputs;
 * the only side effect is reading the discovered file.
 */
export async function loadManifest(startDir: string): Promise<ManifestLoadResult> {
  const manifestPath = await findManifest(startDir);
  if (!manifestPath) return { status: "no_manifest", searchedFrom: path.resolve(startDir) };

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    return { status: "error", manifestPath, message: `read failed: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    return { status: "error", manifestPath, message: `parse failed: ${(err as Error).message}` };
  }

  const targets = normalizeCommandsMeta(parsed);
  if (targets.length === 0) return { status: "empty", manifestPath };

  return { status: "ok", policy: { manifestPath, targets } };
}

function normalizeCommandsMeta(parsed: unknown): TargetPolicy[] {
  if (!isRecord(parsed)) return [];
  const commandsMeta = parsed["commands_meta"];
  if (!isRecord(commandsMeta)) return [];

  const out: TargetPolicy[] = [];
  for (const [target, value] of Object.entries(commandsMeta)) {
    if (!isRecord(value)) continue;
    const patterns = normalizeUnsafePatterns(value["unsafe_patterns"]);
    if (patterns.length === 0) continue;
    out.push({
      target,
      unsafePatterns: patterns,
      expectedDuration: stringOrUndefined(value["expected_duration"]),
      gotchas: stringOrUndefined(value["gotchas"]),
    });
  }
  return out;
}

function normalizeUnsafePatterns(value: unknown): UnsafePattern[] {
  if (!Array.isArray(value)) return [];
  const out: UnsafePattern[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push({ pattern: entry, matchMode: "substring" });
      continue;
    }
    if (isRecord(entry)) {
      const pattern = entry["pattern"];
      if (typeof pattern !== "string" || pattern.length === 0) continue;
      const matchMode = normalizeMatchMode(entry["match_mode"]);
      const warning = stringOrUndefined(entry["warning"]);
      const redirect = normalizeRedirect(entry["redirect"]);
      const built: UnsafePattern = { pattern, matchMode };
      out.push({
        ...built,
        ...(warning ? { warning } : {}),
        ...(redirect ? { redirect } : {}),
      });
    }
  }
  return out;
}

/**
 * Normalize the manifest's `match_mode` field. Unknown values fall back to
 * "substring" (the safe default) rather than rejecting the pattern — a
 * typo in the manifest must not silently disable a guard.
 */
function normalizeMatchMode(value: unknown): MatchMode {
  return value === "command" ? "command" : "substring";
}

function normalizeRedirect(value: unknown): UnsafePatternRedirect | undefined {
  const legacy = stringOrUndefined(value);
  if (legacy) return legacy;
  if (!isRecord(value)) return undefined;

  const kind = value["kind"];
  if (!isRedirectKind(kind)) return undefined;

  switch (kind) {
    case "process":
    case "shell": {
      const recipe = stringOrUndefined(value["recipe"]);
      return recipe ? { kind, recipe } : undefined;
    }
    case "tool": {
      const tool = stringOrUndefined(value["tool"]);
      const recipe = stringOrUndefined(value["recipe"]);
      return tool && recipe ? { kind, tool, recipe } : undefined;
    }
    case "prose": {
      const text = stringOrUndefined(value["text"]) ?? stringOrUndefined(value["recipe"]);
      return text ? { kind, text } : undefined;
    }
  }
}

function isRedirectKind(value: unknown): value is RedirectKind {
  return value === "process" || value === "tool" || value === "shell" || value === "prose";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
