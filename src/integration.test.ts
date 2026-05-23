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

  it("blocks built-in `find` via the real loader in a project with no mise.toml", async () => {
    // Real-loader smoke test for the built-in universal-footgun
    // defaults. Exercises:
    //   - BUILTIN_POLICY merging when loadManifest returns no_manifest
    //   - per-pattern `redirect` plumbing through buildBlockReason
    //   - built-in source attribution in the block reason
    //   - PI_BASH_STEER_BUILTINS=on (implicit default)
    process.env.PI_BASH_STEER = "enforce";
    delete process.env.PI_BASH_STEER_BUILTINS;

    // mkdtemp — NO mise.toml written. Built-ins must fire anyway.
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "pi-bash-steer-integration-builtins-"),
    );
    const ctx = makeCtx(cwd);

    const eventBus = createEventBus();
    const result = await discoverAndLoadExtensions(
      [EXTENSION_ENTRY],
      cwd,
      await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-empty-agent-builtins-")),
      eventBus,
    );
    expect(result.errors).toEqual([]);
    const extension = result.extensions[0]!;

    await invokeHandlers(extension, "session_start", { reason: "startup" }, ctx);

    // `find .` is the headline acceptance case from the task description.
    const blockedFind = await invokeHandlers<{ block: boolean; reason: string }>(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "find . -name foo" } },
      ctx,
    );
    expect(blockedFind).toMatchObject({ block: true });
    expect(blockedFind?.reason).toContain("pi-bash-steer built-in (__builtins__find)");
    expect(blockedFind?.reason).toContain("pi's `find` tool");
    // Must NOT fall back to the broken `mise run __builtins__find` recipe.
    expect(blockedFind?.reason).not.toContain("mise run __builtins__find");

    // Recursive grep is the second headline case.
    const blockedGrep = await invokeHandlers<{ block: boolean; reason: string }>(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "grep -r TODO src/" } },
      ctx,
    );
    expect(blockedGrep).toMatchObject({ block: true });
    expect(blockedGrep?.reason).toContain("__builtins__grep_recursive");

    // Pipeline grep must still pass (regression guard for the design decision).
    const passedPipeGrep = await invokeHandlers(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "git status | grep modified" } },
      ctx,
    );
    expect(passedPipeGrep).toBeUndefined();

    // before_agent_start should emit universal hints but NOT a per-target
    // section for any __builtins__* target (we filter them).
    const startResult = await invokeHandlers<{ systemPrompt: string }>(
      extension,
      "before_agent_start",
      { systemPrompt: "BASE" },
      ctx,
    );
    expect(startResult?.systemPrompt).toContain("Bash tool-affinity hints (universal):");
    expect(startResult?.systemPrompt).not.toContain("__builtins__");
    expect(startResult?.systemPrompt).not.toContain("Verification guard addendum");
  });

  it("PI_BASH_STEER_BUILTINS=off restores pre-builtins passthrough via the real loader", async () => {
    // Acceptance criterion: with builtins disabled and no mise.toml,
    // the extension is a no-op on bash commands (today's behavior).
    process.env.PI_BASH_STEER = "enforce";
    process.env.PI_BASH_STEER_BUILTINS = "off";

    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "pi-bash-steer-integration-builtins-off-"),
    );
    const ctx = makeCtx(cwd);

    const eventBus = createEventBus();
    const result = await discoverAndLoadExtensions(
      [EXTENSION_ENTRY],
      cwd,
      await mkdtemp(
        path.join(os.tmpdir(), "pi-bash-steer-empty-agent-builtins-off-"),
      ),
      eventBus,
    );
    expect(result.errors).toEqual([]);
    const extension = result.extensions[0]!;

    await invokeHandlers(extension, "session_start", { reason: "startup" }, ctx);

    const passedFind = await invokeHandlers(
      extension,
      "tool_call",
      { toolName: "bash", input: { command: "find . -name foo" } },
      ctx,
    );
    expect(passedFind).toBeUndefined();

    // Reset env so subsequent tests aren't affected.
    delete process.env.PI_BASH_STEER_BUILTINS;
  });
});
