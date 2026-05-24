import { describe, expect, it } from "vitest";
import { buildBlockReason } from "./reason-builder.js";
import type { ToolPalette } from "./tool-palette.js";

const BASE_PALETTE: ToolPalette = {
  registeredToolNames: ["bash"],
  activeToolNames: ["bash"],
  hasProcess: false,
  hasCodeSearch: false,
  hasNativeFind: false,
  hasNativeGrep: false,
  hasNativeRead: false,
  hasRg: false,
  hasFd: false,
  hasTmux: false,
};

function palette(overrides: Partial<ToolPalette>): ToolPalette {
  return { ...BASE_PALETTE, ...overrides };
}

describe("buildBlockReason", () => {
  it("does not prefer process for bash find even when process exists", () => {
    const reason = buildBlockReason({
      command: "find . -name foo",
      target: "__builtins__find",
      pattern: "find",
      palette: palette({ hasProcess: true, hasNativeFind: true }),
    });

    expect(reason).toContain("pi's `find` tool");
    expect(reason).not.toContain("process({");
  });

  it("uses shell-level alternatives for find when native find is unavailable", () => {
    const reason = buildBlockReason({
      command: "find . -name foo",
      target: "__builtins__find",
      pattern: "find",
      palette: palette({ hasRg: true }),
    });

    expect(reason).toContain("`rg --files <glob>`");
    expect(reason).not.toContain("pi's `find` tool");
    expect(reason).not.toContain("process({");
  });

  it("uses process for project targets when process is active", () => {
    const reason = buildBlockReason({
      command: "./scripts/preflight.sh",
      target: "preflight",
      pattern: "./scripts/preflight.sh",
      palette: palette({ hasProcess: true }),
    });

    expect(reason).toContain('process({ action: "start", name: "preflight", command: "mise run preflight" })');
  });

  it("falls back to tmux for project targets when process is unavailable", () => {
    const reason = buildBlockReason({
      command: "./scripts/preflight.sh",
      target: "preflight",
      pattern: "./scripts/preflight.sh",
      palette: palette({ hasTmux: true }),
    });

    expect(reason).toContain("tmux new-session");
    expect(reason).toContain(".pi-bash-steer/preflight.log");
    expect(reason).not.toContain("process({");
  });

  it("falls back to background shell polling when process and tmux are unavailable", () => {
    const reason = buildBlockReason({
      command: "pnpm install",
      target: "__builtins__pkg_install",
      pattern: "pnpm install",
      palette: BASE_PALETTE,
    });

    expect(reason).toContain("background shell job plus log polling");
    expect(reason).toContain(".pi-bash-steer/pkg-install.log");
    expect(reason).not.toContain("process({");
    expect(reason).not.toContain("tmux new-session");
  });

  it("keeps legacy string redirects verbatim", () => {
    const reason = buildBlockReason({
      command: "pnpm lint",
      target: "lint",
      pattern: "pnpm lint",
      redirect: "CUSTOM_REDIRECT",
      palette: palette({ hasProcess: true }),
    });

    expect(reason).toContain("CUSTOM_REDIRECT");
    expect(reason).not.toContain("process({");
  });

  it("renders process redirect descriptors", () => {
    const reason = buildBlockReason({
      command: "./scripts/preflight.sh",
      target: "preflight",
      pattern: "./scripts/preflight.sh",
      redirect: {
        kind: "process",
        recipe: 'process({ action: "start", name: "preflight", command: "mise run preflight" })',
      },
      palette: palette({ hasProcess: true }),
    });

    expect(reason).toContain("Use the active `process` tool");
    expect(reason).toContain('process({ action: "start", name: "preflight", command: "mise run preflight" })');
    expect(reason).not.toContain("tmux new-session");
  });

  it("renders tool redirect descriptors and checks active tool availability", () => {
    const reason = buildBlockReason({
      command: "find . -name package.json",
      target: "search",
      pattern: "find",
      redirect: {
        kind: "tool",
        tool: "code_search",
        recipe: 'code_search({ query: "package manifests" })',
      },
      palette: palette({
        registeredToolNames: ["bash", "code_search"],
        activeToolNames: ["bash", "code_search"],
        hasCodeSearch: true,
      }),
    });

    expect(reason).toContain("Use the active `code_search` tool");
    expect(reason).toContain('code_search({ query: "package manifests" })');
  });

  it("warns when a tool redirect descriptor names an unavailable tool", () => {
    const reason = buildBlockReason({
      command: "find . -name package.json",
      target: "search",
      pattern: "find",
      redirect: {
        kind: "tool",
        tool: "code_search",
        recipe: 'code_search({ query: "package manifests" })',
      },
      palette: BASE_PALETTE,
    });

    expect(reason).toContain("`code_search` tool redirect");
    expect(reason).toContain("not available");
    expect(reason).toContain('code_search({ query: "package manifests" })');
  });

  it("renders shell redirect descriptors", () => {
    const reason = buildBlockReason({
      command: "grep -r TODO .",
      target: "search",
      pattern: "grep -r",
      redirect: { kind: "shell", recipe: "rg TODO ." },
      palette: BASE_PALETTE,
    });

    expect(reason).toContain("Use this shell alternative instead");
    expect(reason).toContain("rg TODO .");
    expect(reason).not.toContain("process({");
  });

  it("renders prose redirect descriptors", () => {
    const reason = buildBlockReason({
      command: "cat huge.log",
      target: "read-log",
      pattern: "cat huge.log",
      redirect: { kind: "prose", text: "Read only the relevant slice with the bounded read tool." },
      palette: palette({ hasNativeRead: true }),
    });

    expect(reason).toContain("Read only the relevant slice with the bounded read tool.");
    expect(reason).not.toContain("process({");
  });

  it("makes du scope-first and process second", () => {
    const reason = buildBlockReason({
      command: "du -sh /",
      target: "__builtins__du_root",
      pattern: "du -sh /",
      palette: palette({ hasProcess: true }),
    });

    expect(reason).toContain("Scope `du` to a specific directory");
    expect(reason).toContain("If you genuinely need the full scan");
    expect(reason).toContain("process({");
  });
});
