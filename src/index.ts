import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBuiltinsConfig, readConfig } from "./config.js";
import {
  BUILTIN_POLICY,
  EMPTY_POLICY,
  isBuiltinTarget,
  mergePolicies,
} from "./defaults.js";
import { loadManifest, type ManifestPolicy } from "./manifest-loader.js";
import { matchUnsafePattern } from "./matcher.js";
import { buildPromptAddendum } from "./prompt-addendum.js";

/**
 * pi-bash-steer extension entry point.
 *
 * Scope of this module (per the "Implement extension core" task):
 *   1. Register a `session_start` listener that loads and caches the
 *      project's `mise.toml [commands_meta.*]` manifest once per session.
 *   2. Read PI_BASH_STEER once at extension activation.
 *   3. Register a `tool_call` listener on the bash tool unless the guard is
 *      disabled. In enforce mode, matched commands block. In warn mode,
 *      matched commands notify and run.
 *
 * Out of scope for this task (future modules):
 *   - `reason-builder` with a paste-ready process({...}) recipe per target
 *
 * Resolved ROUGH open questions:
 *   - Q-A: manifest field name is `unsafe_patterns` under `[commands_meta.<target>]`.
 *   - Q-B: TOML parser is `smol-toml`.
 *   - Q-C: block reason is "<per-pattern warning if present> + canonical
 *     process({...}) recommendation".
 *   - Q-G: substring matcher; AST deferred.
 *
 * Behavioral guarantees:
 *   - Fail-safe: any error loading or parsing the manifest, or the
 *     absence of `mise.toml` / `[commands_meta.*]`, results in passthrough.
 *   - Never mutate `event.input.command`. Per the pi 0.74 extensions
 *     contract, mutations propagate silently to downstream handlers and
 *     hide the original command from audit; we block instead.
 */
export default async function piBashSteer(pi: ExtensionAPI): Promise<void> {
  const guardLevel = readConfig(process.env);
  const builtinsLevel = readBuiltinsConfig(process.env);

  // Session-scoped manifest cache. Loaded once at session_start; never
  // re-read mid-session. A fresh pi session picks up manifest edits.
  // Holds the *merged* policy (built-ins + project mise.toml).
  let cachedPolicy: ManifestPolicy | null = null;

  const builtinPolicy = builtinsLevel === "on" ? BUILTIN_POLICY : EMPTY_POLICY;

  pi.on("session_start", async (_event, ctx) => {
    cachedPolicy = null;
    if (guardLevel === "off") {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-bash-steer: PI_BASH_STEER=off; bash steering disabled for this session",
          "warning",
        );
      }
      return;
    }

    if (guardLevel === "warn" && ctx.hasUI) {
      ctx.ui.notify(
        "pi-bash-steer: PI_BASH_STEER=warn; matching commands will warn but run",
        "warning",
      );
    }

    const result = await loadManifest(ctx.cwd);
    const projectPolicy = result.status === "ok" ? result.policy : EMPTY_POLICY;
    const merged = mergePolicies(builtinPolicy, projectPolicy);

    // Set the cache regardless of project-manifest presence so built-ins
    // fire in manifest-less projects. If both built-ins and project are
    // empty, cachedPolicy ends up with zero targets and the tool_call
    // listener short-circuits naturally.
    cachedPolicy = merged.targets.length > 0 ? merged : null;

    if (!ctx.hasUI) return;

    const builtinCount = merged.targets.filter((t) => isBuiltinTarget(t.target)).length;
    const projectCount = merged.targets.length - builtinCount;

    switch (result.status) {
      case "ok": {
        const targetNames = merged.targets.map((t) => t.target).join(", ");
        ctx.ui.notify(
          `pi-bash-steer: ${merged.targets.length} target(s) steered (${projectCount} project + ${builtinCount} built-in) [${targetNames}]`,
          "info",
        );
        return;
      }
      case "no_manifest":
        if (builtinCount > 0) {
          ctx.ui.notify(
            `pi-bash-steer: no mise.toml found above ${result.searchedFrom}; ${builtinCount} built-in target(s) active`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `pi-bash-steer: no mise.toml found above ${result.searchedFrom} and built-ins disabled; passing through`,
            "info",
          );
        }
        return;
      case "empty":
        if (builtinCount > 0) {
          ctx.ui.notify(
            `pi-bash-steer: ${result.manifestPath} has no [commands_meta.*] with unsafe_patterns; ${builtinCount} built-in target(s) active`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `pi-bash-steer: ${result.manifestPath} has no [commands_meta.*] with unsafe_patterns and built-ins disabled; passing through`,
            "info",
          );
        }
        return;
      case "error":
        ctx.ui.notify(
          `pi-bash-steer: manifest load error (${result.message}); ${builtinCount} built-in target(s) active`,
          "warning",
        );
        return;
    }
  });

  if (guardLevel !== "off") {
    pi.on("before_agent_start", async (event) => {
      // Universal tool-affinity hints fire regardless of whether the
      // project has a mise.toml — they are not gated on cachedPolicy.
      // Per-target sections layer on top when a manifest is loaded.
      const policy = cachedPolicy ?? { manifestPath: "", targets: [] };
      const addendum = buildPromptAddendum(policy);
      if (addendum.length === 0) return; // defensive no-op

      return {
        systemPrompt: `${event.systemPrompt}\n\n${addendum}`,
      };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      if (cachedPolicy === null) return; // fail-safe passthrough

      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (command.length === 0) return;

      const match = matchUnsafePattern(command, cachedPolicy);
      if (!match.matched) return;

      const reason = buildBlockReason(
        match.target,
        match.pattern.pattern,
        match.pattern.warning,
        match.expectedDuration,
        match.pattern.redirect,
      );
      if (guardLevel === "warn") {
        if (ctx.hasUI) ctx.ui.notify(reason, "warning");
        return;
      }

      return { block: true, reason };
    });
  }
}

/**
 * Compose the block reason. Per Q-C, surface the per-pattern warning
 * (if the manifest author provided one) followed by the canonical
 * background-process recipe from `@aliou/pi-processes`.
 *
 * Kept inline (not extracted to `reason-builder.ts`) to keep this task
 * self-contained; the dedicated module lands in a follow-up that also
 * computes a paste-ready `process({...})` invocation per target.
 */
function buildBlockReason(
  target: string,
  pattern: string,
  warning: string | undefined,
  expectedDuration: string | undefined,
  redirect: string | undefined,
): string {
  const durationNote = expectedDuration ? ` (expected duration ~${expectedDuration})` : "";
  const builtin = isBuiltinTarget(target);
  const sourceNote = builtin
    ? `pi-bash-steer built-in (${target})`
    : `mise.toml [commands_meta.${target}].unsafe_patterns`;
  const lines = [
    `Blocked: command matches ${sourceNote} entry ${JSON.stringify(pattern)}${durationNote}.`,
  ];
  if (warning) lines.push(warning);
  if (redirect) {
    // Per-pattern redirect overrides the default mise recipe — used by
    // built-ins (which have no mise target) and by manifest authors
    // who want a custom recipe per pattern.
    lines.push(redirect);
  } else {
    lines.push(
      "Run this as a background process instead. Use the `process` tool from @aliou/pi-processes:",
      `  process({ action: "start", name: ${JSON.stringify(target)}, command: "mise run ${target}" })`,
      "Then poll with `process({ action: \"output\", id })` or `process({ action: \"logs\", id })`.",
    );
  }
  return lines.join("\n");
}
