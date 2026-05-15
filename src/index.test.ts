import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piVerifyGuard from "./index.js";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-verify-guard-"));
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

const originalVerifyGuard = process.env.PI_VERIFY_GUARD;

afterEach(() => {
  if (originalVerifyGuard === undefined) {
    delete process.env.PI_VERIFY_GUARD;
  } else {
    process.env.PI_VERIFY_GUARD = originalVerifyGuard;
  }
  vi.restoreAllMocks();
});

describe("piVerifyGuard", () => {
  it("does not register a tool_call listener when PI_VERIFY_GUARD=off", async () => {
    process.env.PI_VERIFY_GUARD = "off";
    const { pi, handlers } = createPiHarness();

    await piVerifyGuard(pi);

    expect(handlers.get("tool_call")).toBeUndefined();
    const sessionStart = getOnlyHandler(handlers, "session_start");
    const ctx = createContext(process.cwd());

    await sessionStart({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "pi-verify-guard: PI_VERIFY_GUARD=off; verification guard disabled for this session",
      "warning",
    );
  });

  it("warns and allows matching bash commands when PI_VERIFY_GUARD=warn", async () => {
    process.env.PI_VERIFY_GUARD = "warn";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piVerifyGuard(pi);
    const ctx = createContext(cwd);
    await getOnlyHandler(handlers, "session_start")({}, ctx);

    const result = await getOnlyHandler(handlers, "tool_call")(
      { toolName: "bash", input: { command: "./scripts/preflight.sh" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "pi-verify-guard: PI_VERIFY_GUARD=warn; matching commands will warn but run",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Blocked: command matches"), "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Use the background process recipe."),
      "warning",
    );
  });

  it("blocks matching bash commands when PI_VERIFY_GUARD=enforce", async () => {
    process.env.PI_VERIFY_GUARD = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piVerifyGuard(pi);
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

  it("uses the activation-time level even if PI_VERIFY_GUARD mutates later", async () => {
    process.env.PI_VERIFY_GUARD = "enforce";
    const cwd = await createManifestDir();
    const { pi, handlers } = createPiHarness();

    await piVerifyGuard(pi);
    process.env.PI_VERIFY_GUARD = "off";

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
});
