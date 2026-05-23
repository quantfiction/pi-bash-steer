import { describe, expect, it } from "vitest";
import type { ManifestPolicy } from "./manifest-loader.js";
import { buildPromptAddendum } from "./prompt-addendum.js";

describe("buildPromptAddendum", () => {
  it("emits universal tool-affinity hints when there are zero targets", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [],
    };

    const output = buildPromptAddendum(policy);

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
    expect(output).toContain("`code_search` if available");
    expect(output).toContain("rg --files");

    // No per-target block when there are zero targets.
    expect(output).not.toContain("[commands_meta.");
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

    const output = buildPromptAddendum(policy);

    const universalIdx = output.indexOf("Bash tool-affinity hints (universal):");
    const perTargetIdx = output.indexOf("[commands_meta.preflight]");

    expect(universalIdx).toBeGreaterThanOrEqual(0);
    expect(perTargetIdx).toBeGreaterThan(universalIdx);
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

    const output = buildPromptAddendum(policy);

    expect(output).toContain("[commands_meta.preflight]");
    expect(output).toContain("expected_duration=30m");
    expect(output).toContain("\"./scripts/preflight.sh\"");
    expect(output).toContain('process({ action: "start", name: "preflight", command: "mise run preflight" })');
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

    const output = buildPromptAddendum(policy);

    expect(output).toContain("[commands_meta.lint]");
    expect(output).toContain("[commands_meta.test]");
    expect(output).toContain('name: "lint"');
    expect(output).toContain('name: "test"');
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

    const output = buildPromptAddendum(policy);

    expect(output).toContain("warning: This frequently exceeds shell tool timeout.");
  });
});
