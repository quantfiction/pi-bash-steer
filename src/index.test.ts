import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piBashSteer from "./index.js";

type Handler = (event: Record<string, unknown>, ctx: TestContext) => unknown | Promise<unknown>;

interface TestContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: ReturnType<typeof vi.fn>;
  };
}

function createPiHarness(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((eventName: string, handler: Handler) => {
      const existing = handlers.get(eventName) ?? [];
      existing.push(handler);
      handlers.set(eventName, existing);
    }),
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

function getOnlyHandler(handlers: Map<string, Handler[]>, eventName: string): Handler {
  const eventHandlers = handlers.get(eventName) ?? [];
  expect(eventHandlers).toHaveLength(1);
  const handler = eventHandlers[0];
  if (!handler) throw new Error(`No handler registered for ${eventName}`);
  return handler;
}

function createContext(cwd: string): TestContext {
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
  };
}

async function createManifestDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-"));
  await writeFile(
    path.join(dir, "mise.toml"),
    `[commands_meta.preflight]
expected_duration = "30m"
unsafe_patterns = [
  { pattern = "./scripts/preflight.sh", warning = "Use the background process recipe." },
]
`,
    "utf8",
  );
  return dir;
}

async function createEmptyManifestDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-empty-"));
  await writeFile(path.join(dir, "mise.toml"), "[tasks]\nnoop = \"echo ok\"\n", "utf8");
  return dir;
}

const originalBashSteer = process.env.PI_BASH_STEER;

afterEach(() => {
  if (originalBashSteer === undefined) {
    delete process.env.PI_BASH_STEER;
  } else {
    process.env.PI_BASH_STEER = originalBashSteer;
  }
  vi.restoreAllMocks();
});

describe("piBashSteer", () => {
  it("does not register a tool_call listener when PI_BASH_STEER=off", async () => {
    process.env.PI_BASH_STEER = "off";
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);

    expect(handlers.get("tool_call")).toBeUndefined();
    expect(handlers.get("before_agent_start")).toBeUndefined();
    const sessionStart = getOnlyHandler(handlers, "session_start");
    const ctx = createContext(process.cwd());

    await sessionStart({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "pi-bash-steer: PI_BASH_STEER=off; bash steering disabled for this session",
      "warning",
    );
  });

  it("injects a before_agent_start prompt addendum when a manifest is loaded", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "before_agent_start")(
      { systemPrompt: "BASE" },
      ctx,
    );

    expect(result).toEqual({
      systemPrompt: expect.stringContaining("BASE\n\nVerification guard addendum"),
    });
    expect(result).toEqual({
      systemPrompt: expect.stringContaining("[commands_meta.preflight] expected_duration=30m"),
    });
    expect(result).toEqual({
      systemPrompt: expect.stringContaining('process({ action: "start", name: "preflight", command: "mise run preflight" })'),
    });
  });

  it("does not inject prompt addendum when manifest is absent", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    const ctx = createContext(process.cwd());
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "before_agent_start")(
      { systemPrompt: "BASE" },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("does not inject prompt addendum when manifest has no guarded targets", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createEmptyManifestDir();
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "before_agent_start")(
      { systemPrompt: "BASE" },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("warns and allows matching bash commands when PI_BASH_STEER=warn", async () => {
    process.env.PI_BASH_STEER = "warn";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "pi-bash-steer: PI_BASH_STEER=warn; matching commands will warn but run",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Blocked: command matches"), "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Use the background process recipe."),
      "warning",
    );
  });

  it("blocks matching bash commands when PI_BASH_STEER=enforce", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Blocked: command matches"),
    });
  });

  it("uses the activation-time level even if PI_BASH_STEER mutates later", async () => {
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piBashSteer(pi);
    process.env.PI_BASH_STEER = "off";

    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);
    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Blocked: command matches"),
    });
  });

  // ---- Passthrough / fail-safe paths ----
  //
  // The guard's correctness invariant: if anything about the session is
  // unexpected (no manifest, non-bash tool, missing command), the
  // listener must return undefined so the tool call proceeds normally.
  // A regression here would silently block agents in projects that
  // don't have a mise.toml, which is the worst possible UX.

  it("passes through bash tool_call when no manifest was found at session_start", async () => {
    // Bug this catches: cachedPolicy stays null when loadManifest
    // returns no_manifest, but a future refactor accidentally drops the
    // null-check and dereferences it, throwing into the listener.
    process.env.PI_BASH_STEER = "enforce";
    const { pi, handlers } = createPiHarness();
    await piBashSteer(pi);

    // session_start in a directory with no mise.toml above it.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-bash-steer-no-manifest-"));
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("passes through tool_call for non-bash tools even when a manifest is loaded", async () => {
    // Bug this catches: the listener applies the matcher to every
    // tool, blocking e.g. `read` calls that happen to contain a
    // matching substring in their path argument.
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();
    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "read", input: { path: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("passes through bash tool_call when input.command is missing or non-string", async () => {
    // Bug this catches: throwing on missing/non-string command would
    // crash the listener and break passthrough for malformed events.
    process.env.PI_BASH_STEER = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();
    await piBashSteer(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const handler = getOnlyHandler(handlers, "tool_call");
    expect(await handler({ toolName: "bash", input: {} }, ctx)).toBeUndefined();
    expect(await handler({ toolName: "bash", input: { command: 123 } }, ctx)).toBeUndefined();
    expect(await handler({ toolName: "bash" }, ctx)).toBeUndefined();
  });

  it("re-loads the manifest on a second session_start (cache reset)", async () => {
    // Bug this catches: pi can replay session_start with reason "new"
    // or "resume" within the same extension instance. If the cache
    // isn't reset, stale policy leaks between sessions — including
    // leaking guards into projects that have no manifest.
    process.env.PI_BASH_STEER = "enforce";
    const guardedCwd = await createManifestDir();
    const unguardedCwd = await mkdtemp(
      path.join(os.tmpdir(), "pi-bash-steer-second-session-"),
    );
    const { pi, handlers } = createPiHarness();
    await piBashSteer(pi);
    const sessionStart = getOnlyHandler(handlers, "session_start");
    const toolCall = getOnlyHandler(handlers, "tool_call");

    // First session: guarded.
    const ctx1 = createContext(guardedCwd);
    await sessionStart({}, ctx1);
    const blocked = await toolCall(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx1,
    );
    expect(blocked).toMatchObject({ block: true });

    // Second session in a manifest-less cwd: must passthrough, not
    // re-use the stale policy from the first session.
    const ctx2 = createContext(unguardedCwd);
    await sessionStart({}, ctx2);
    const passed = await toolCall(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx2,
    );
    expect(passed).toBeUndefined();
  });
});
