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
 * The `unsafe_patterns` field accepts two shapes per pattern entry:
 *
 *   unsafe_patterns = ["./scripts/preflight.sh"]
 *   unsafe_patterns = [{ pattern = "pnpm build", warning = "…" }]
 *
 * Both shapes are normalized to `{ pattern: string; warning?: string }`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export interface UnsafePattern {
  /** Substring that, when contained in a bash command string, triggers a block. */
  readonly pattern: string;
  /** Optional per-pattern warning the manifest author wants surfaced in the block reason. */
  readonly warning?: string;
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
      if (entry.length > 0) out.push({ pattern: entry });
      continue;
    }
    if (isRecord(entry)) {
      const pattern = entry["pattern"];
      if (typeof pattern !== "string" || pattern.length === 0) continue;
      const warning = stringOrUndefined(entry["warning"]);
      out.push(warning ? { pattern, warning } : { pattern });
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
