import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.js";
import { loadManifest, type ManifestPolicy } from "./manifest-loader.js";
import { matchUnsafePattern } from "./matcher.js";
import { buildPromptAddendum } from "./prompt-addendum.js";

/**
 * pi-verify-guard extension entry point.
 *
 * Scope of this module (per the "Implement extension core" task):
 *   1. Register a `session_start` listener that loads and caches the
 *      project's `mise.toml [commands_meta.*]` manifest once per session.
 *   2. Read PI_VERIFY_GUARD once at extension activation.
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
export default async function piVerifyGuard(pi: ExtensionAPI): Promise<void> {
  const guardLevel = readConfig(process.env);

  // Session-scoped manifest cache. Loaded once at session_start; never
  // re-read mid-session. A fresh pi session picks up manifest edits.
  let cachedPolicy: ManifestPolicy | null = null;

  pi.on("session_start", async (_event, ctx) => {
    cachedPolicy = null;
    if (guardLevel === "off") {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-verify-guard: PI_VERIFY_GUARD=off; verification guard disabled for this session",
          "warning",
        );
      }
      return;
    }

    if (guardLevel === "warn" && ctx.hasUI) {
      ctx.ui.notify(
        "pi-verify-guard: PI_VERIFY_GUARD=warn; matching commands will warn but run",
        "warning",
      );
    }

    const result = await loadManifest(ctx.cwd);
    switch (result.status) {
      case "ok":
        cachedPolicy = result.policy;
        if (ctx.hasUI) {
          const targetNames = result.policy.targets.map((t) => t.target).join(", ");
          ctx.ui.notify(
            `pi-verify-guard: ${result.policy.targets.length} target(s) guarded (${targetNames})`,
            "info",
          );
        }
        return;
      case "no_manifest":
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-verify-guard: no mise.toml found above ${result.searchedFrom}; passing through`,
            "info",
          );
        }
        return;
      case "empty":
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-verify-guard: ${result.manifestPath} has no [commands_meta.*] with unsafe_patterns; passing through`,
            "info",
          );
        }
        return;
      case "error":
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-verify-guard: manifest load error (${result.message}); passing through`,
            "warning",
          );
        }
        return;
    }
  });

  if (guardLevel !== "off") {
    pi.on("before_agent_start", async (event) => {
      if (cachedPolicy === null) return; // fail-safe passthrough

      const addendum = buildPromptAddendum(cachedPolicy);
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
): string {
  const durationNote = expectedDuration ? ` (expected duration ~${expectedDuration})` : "";
  const lines = [
    `Blocked: command matches mise.toml [commands_meta.${target}].unsafe_patterns entry ${JSON.stringify(pattern)}${durationNote}.`,
  ];
  if (warning) lines.push(warning);
  lines.push(
    "Run this as a background process instead. Use the `process` tool from @aliou/pi-processes:",
    `  process({ action: "start", name: ${JSON.stringify(target)}, command: "mise run ${target}" })`,
    "Then poll with `process({ action: \"output\", id })` or `process({ action: \"logs\", id })`.",
  );
  return lines.join("\n");
}
