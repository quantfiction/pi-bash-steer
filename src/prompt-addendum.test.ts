import { describe, expect, it } from "vitest";
import type { ManifestPolicy } from "./manifest-loader.js";
import { buildPromptAddendum } from "./prompt-addendum.js";
import type { ToolPalette } from "./tool-palette.js";

const FULL_PALETTE: ToolPalette = {
  registeredToolNames: ["bash", "code_search", "find", "grep", "process", "read"],
  activeToolNames: ["bash", "code_search", "find", "grep", "process", "read"],
  hasProcess: true,
  hasCodeSearch: true,
  hasNativeFind: true,
  hasNativeGrep: true,
  hasNativeRead: true,
  hasRg: true,
  hasFd: true,
  hasTmux: true,
};

describe("buildPromptAddendum", () => {
  it("emits universal tool-affinity hints when there are zero targets", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    // Header present.
    expect(output).toContain("Bash tool-affinity hints (universal):");

    // Each universal anti-pattern is named.
    expect(output).toContain("bash `find`");
    expect(output).toContain("bash `grep -r`");
    expect(output).toContain("bash `cat <file>`");
    expect(output).toContain("bash `ls -R`");
    expect(output).toContain("grep-blasting vague terms");

    // Each preferred alternative is named.
    expect(output).toContain("`find` tool");
    expect(output).toContain("`grep` tool");
    expect(output).toContain("`read` tool");
    expect(output).toContain("`code_search`");
    expect(output).toContain("rg --files");

    // No per-target block when there are zero targets.
    expect(output).not.toContain("[commands_meta.");
  });

  it("omits unavailable tools from universal hints", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [],
    };
    const output = buildPromptAddendum(policy, {
      ...FULL_PALETTE,
      activeToolNames: ["bash"],
      hasProcess: false,
      hasCodeSearch: false,
      hasNativeFind: false,
      hasNativeGrep: false,
      hasNativeRead: false,
      hasRg: true,
      hasFd: false,
    });

    expect(output).toContain("`rg --files`");
    expect(output).toContain("`rg <pattern>`");
    expect(output).not.toContain("`code_search`");
    expect(output).not.toContain("the `find` tool");
    expect(output).not.toContain("the `grep` tool");
    expect(output).not.toContain("the `read` tool");
    expect(output).not.toContain("process(");
  });

  it("emits universal hints before per-target sections", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "preflight",
          unsafePatterns: [{ pattern: "./scripts/preflight.sh", matchMode: "substring" }],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    const universalIdx = output.indexOf("Bash tool-affinity hints (universal):");
    const perTargetIdx = output.indexOf("[commands_meta.preflight]");

    expect(universalIdx).toBeGreaterThanOrEqual(0);
    expect(perTargetIdx).toBeGreaterThan(universalIdx);
  });

  it("renders tmux recipe for a target when process is unavailable", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "preflight",
          unsafePatterns: [{ pattern: "./scripts/preflight.sh", matchMode: "substring" }],
        },
      ],
    };

    const output = buildPromptAddendum(policy, {
      ...FULL_PALETTE,
      hasProcess: false,
      hasTmux: true,
    });

    expect(output).toContain("tmux recipe:");
    expect(output).toContain("tmux new-session");
    expect(output).not.toContain("process recipe:");
  });

  it("renders one target with expected_duration and process recipe", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "preflight",
          expectedDuration: "30m",
          gotchas: "run from repo root",
          unsafePatterns: [{ pattern: "./scripts/preflight.sh", matchMode: "substring" }],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("[commands_meta.preflight]");
    expect(output).toContain("expected_duration=30m");
    expect(output).toContain("\"./scripts/preflight.sh\"");
    expect(output).toContain('process({ action: "start", name: "preflight", command: "mise run preflight" })');
  });

  it("renders per-pattern redirects and omits default target recipe when every pattern has its own redirect", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "search",
          unsafePatterns: [
            {
              pattern: "find",
              matchMode: "command",
              redirect: {
                kind: "tool",
                tool: "code_search",
                recipe: 'code_search({ query: "..." })',
              },
            },
            {
              pattern: "grep -r",
              matchMode: "substring",
              redirect: { kind: "shell", recipe: "rg <pattern> <path>" },
            },
          ],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("[commands_meta.search]");
    expect(output).toContain('redirect: tool:code_search: code_search({ query: "..." })');
    expect(output).toContain("redirect: shell: rg <pattern> <path>");
    expect(output).not.toContain("mise run search");
  });

  it("renders multiple targets", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "lint",
          unsafePatterns: [{ pattern: "pnpm lint", matchMode: "substring" }],
        },
        {
          target: "test",
          unsafePatterns: [{ pattern: "pnpm test", matchMode: "substring" }],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("[commands_meta.lint]");
    expect(output).toContain("[commands_meta.test]");
    expect(output).toContain('name: "lint"');
    expect(output).toContain('name: "test"');
  });

  it("filters out __builtins__* targets from per-target rendering", () => {
    // Built-ins are surfaced via universal hints + block-time redirect.
    // Listing 7+ synthetic targets in every system prompt would bloat
    // the addendum without telling the agent anything new.
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "__builtins__find",
          unsafePatterns: [
            { pattern: "find", matchMode: "command", redirect: "use pi find" },
          ],
        },
        {
          target: "preflight",
          unsafePatterns: [
            { pattern: "./scripts/preflight.sh", matchMode: "substring" },
          ],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("[commands_meta.preflight]");
    expect(output).not.toContain("__builtins__");
  });

  it("omits the per-target block entirely if only built-in targets are present", () => {
    const policy: ManifestPolicy = {
      manifestPath: "<pi-bash-steer builtins>",
      targets: [
        {
          target: "__builtins__find",
          unsafePatterns: [
            { pattern: "find", matchMode: "command", redirect: "use pi find" },
          ],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("Bash tool-affinity hints (universal):");
    expect(output).not.toContain("Verification guard addendum");
    expect(output).not.toContain("__builtins__");
  });

  it("includes per-pattern warnings", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "build",
          unsafePatterns: [
            {
              pattern: "pnpm build", matchMode: "substring",
              warning: "This frequently exceeds shell tool timeout.",
            },
          ],
        },
      ],
    };

    const output = buildPromptAddendum(policy, FULL_PALETTE);

    expect(output).toContain("warning: This frequently exceeds shell tool timeout.");
  });
});
