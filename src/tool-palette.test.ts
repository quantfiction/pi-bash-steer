import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { detectToolPalette } from "./tool-palette.js";

function createPi(options: {
  activeToolNames: readonly string[];
  registeredToolNames?: readonly string[];
  commandExists?: readonly string[];
}): ExtensionAPI {
  const registeredToolNames = options.registeredToolNames ?? options.activeToolNames;
  const commandExists = new Set(options.commandExists ?? []);
  return {
    getActiveTools: vi.fn(() => [...options.activeToolNames]),
    getAllTools: vi.fn(() =>
      registeredToolNames.map((name) => ({
        name,
        description: `${name} tool`,
        parameters: {},
        sourceInfo: { source: "test" },
      })),
    ),
    exec: vi.fn(async (_command: string, args: string[]) => {
      const shellCommand = args.join(" ");
      const found = [...commandExists].some((name) =>
        shellCommand.includes(`command -v ${name}`),
      );
      return { stdout: "", stderr: "", code: found ? 0 : 1, killed: false };
    }),
  } as unknown as ExtensionAPI;
}

describe("detectToolPalette", () => {
  it("uses active tools for callable-tool booleans", async () => {
    const palette = await detectToolPalette(
      createPi({
        registeredToolNames: ["bash", "process", "code_search", "find", "grep", "read"],
        activeToolNames: ["bash", "find", "grep", "read"],
      }),
    );

    expect(palette.registeredToolNames).toContain("process");
    expect(palette.hasProcess).toBe(false);
    expect(palette.hasCodeSearch).toBe(false);
    expect(palette.hasNativeFind).toBe(true);
    expect(palette.hasNativeGrep).toBe(true);
    expect(palette.hasNativeRead).toBe(true);
  });

  it("detects process and code_search when they are active", async () => {
    const palette = await detectToolPalette(
      createPi({ activeToolNames: ["bash", "process", "code_search"] }),
    );

    expect(palette.hasProcess).toBe(true);
    expect(palette.hasCodeSearch).toBe(true);
  });

  it("probes shell-level fallbacks", async () => {
    const palette = await detectToolPalette(
      createPi({ activeToolNames: ["bash"], commandExists: ["rg", "tmux"] }),
    );

    expect(palette.hasRg).toBe(true);
    expect(palette.hasFd).toBe(false);
    expect(palette.hasTmux).toBe(true);
  });

  it("treats fdfind as fd fallback", async () => {
    const palette = await detectToolPalette(
      createPi({ activeToolNames: ["bash"], commandExists: ["fdfind"] }),
    );

    expect(palette.hasFd).toBe(true);
  });

  it("fails closed when runtime tool APIs throw", async () => {
    const pi = {
      getActiveTools: vi.fn(() => {
        throw new Error("not bound");
      }),
      getAllTools: vi.fn(() => {
        throw new Error("not bound");
      }),
      exec: vi.fn(async () => {
        throw new Error("not bound");
      }),
    } as unknown as ExtensionAPI;

    const palette = await detectToolPalette(pi);

    expect(palette.activeToolNames).toEqual([]);
    expect(palette.registeredToolNames).toEqual([]);
    expect(palette.hasProcess).toBe(false);
    expect(palette.hasRg).toBe(false);
    expect(palette.hasTmux).toBe(false);
  });
});
