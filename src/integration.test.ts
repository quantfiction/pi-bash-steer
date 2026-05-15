import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createEventBus,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-coding-agent";

/**
 * Real-loader integration smoke test.
 *
 * Unlike `index.test.ts` (which uses a hand-rolled `vi.fn()` `pi.on`
 * harness), this test wires the extension through the real
 * `discoverAndLoadExtensions` from `@earendil-works/pi-coding-agent` —
 * the same code path pi itself uses to load extensions in production.
 * The extension factory is loaded via jiti from our published source
 * file (`src/index.ts`).
 *
 * What this catches that the hand-rolled tests don't:
 *   - Contract drift: if the pi runtime changes how it invokes
 *     `pi.on(event, handler)` or what shape it stores in
 *     `extension.handlers`, this test fails fast on upgrade.
 *   - Module-resolution / TS-loader breakage: if our `src/index.ts`
 *     stops being loadable as a pi extension (bad TSConfig, missing
 *     default export, syntax pi's loader rejects), only this test
 *     surfaces it.
 *   - Activation gating: the real loader uses `runtime.assertActive()`
 *     guards while invoking the factory.
 *
 * Scope: ONE end-to-end smoke test for the block path. The
 * fine-grained behavior matrix lives in `index.test.ts`.
 */

interface MinimalCtx {
  cwd: string;
  hasUI: boolean;
  ui: { notify: (msg: string, type?: string) => void };
}

function makeCtx(cwd: string): MinimalCtx {
  return { cwd, hasUI: true, ui: { notify: () => {} } };
}

async function makeGuardedProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-integration-"));
  await writeFile(
    path.join(dir, "mise.toml"),
    `[commands_meta.preflight]
expected_duration = "30m"
unsafe_patterns = [
  { pattern = "./scripts/preflight.sh", warning = "Use the background recipe." },
]
`,
    "utf8",
  );
  return dir;
}

async function invokeHandlers<T = unknown>(
  extension: Extension,
  event: string,
  payload: Record<string, unknown>,
  ctx: MinimalCtx,
): Promise<T | undefined> {
  const list = extension.handlers.get(event) ?? [];
  let last: T | undefined;
  for (const handler of list) {
    // Real loader stores HandlerFn = (event, ctx) => unknown | Promise<unknown>.
    // We invoke them in registration order to mirror runner.dispatch().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    last = (await (handler as any)(payload, ctx)) as T | undefined;
  }
  return last;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ENTRY = path.resolve(HERE, "index.ts");

describe("integration: real loader + piBashSteer", () => {
  it("registers session_start / before_agent_start / tool_call handlers via the real loader and blocks a matching bash command", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await makeGuardedProject();
    const ctx = makeCtx(cwd);

    const eventBus = createEventBus();

    // The real loader: discovers + jiti-compiles + invokes the factory
    // with a real ExtensionAPI, captures registrations into a real
    // Extension object, applies activation gating via
    // runtime.assertActive().
    const result = await discoverAndLoadExtensions(
      [EXTENSION_ENTRY],
      cwd,
      // agentDir: point at a tempdir so the loader doesn't pull in any
      // globally-installed extensions on the developer's machine.
      await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-empty-agent-")),
      eventBus,
    );
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const extension = result.extensions[0]!;

    // Contract: the three listeners we care about must be present.
    // If pi renames an event or changes the registration API, this
    // assertion catches the drift before the extension ships.
    expect(extension.handlers.get("session_start")?.length ?? 0).toBeGreaterThan(0);
    expect(extension.handlers.get("before_agent_start")?.length ?? 0).toBeGreaterThan(0);
    expect(extension.handlers.get("tool_call")?.length ?? 0).toBeGreaterThan(0);

    // Drive the lifecycle: session_start populates the cache.
    await invokeHandlers(extension, "session_start", { reason: "startup" }, ctx);

    // before_agent_start must inject the addendum.
    const startResult = await invokeHandlers<{ systemPrompt: string }>(
      extension,
      "before_agent_start",
      { systemPrompt: "BASE" },
      ctx,
    );
    expect(startResult?.systemPrompt).toContain("Verification guard addendum");
    expect(startResult?.systemPrompt).toContain("[commands_meta.preflight]");

    // tool_call on the guarded pattern must produce a block result.
    const blocked = await invokeHandlers<{ block: boolean; reason: string }>(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );
    expect(blocked).toMatchObject({
      block: true,
      reason: expect.stringContaining("Blocked: command matches"),
    });
    expect(blocked?.reason).toContain("Use the background recipe.");
    expect(blocked?.reason).toContain('command: "mise run preflight"');

    // tool_call on a benign command passes through.
    const passed = await invokeHandlers(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "ls -la" } },
      ctx,
    );
    expect(passed).toBeUndefined();
  });
});
