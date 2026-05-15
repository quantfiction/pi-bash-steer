import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-verify-guard extension entry point.
 *
 * This is a skeleton; real listener wiring (manifest-loader, matcher,
 * reason-builder, prompt-addendum, config, listeners) lands in follow-up
 * tasks per `docs/plans/agent-verification-infra/verification-as-first-class-action/ROUGH.md`.
 */
export default async function piVerifyGuard(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.notify("pi-verify-guard: skeleton loaded (no enforcement yet)", "info");
  });
}
