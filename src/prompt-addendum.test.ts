import { describe, expect, it } from "vitest";
import type { ManifestPolicy } from "./manifest-loader.js";
import { buildPromptAddendum } from "./prompt-addendum.js";

describe("buildPromptAddendum", () => {
  it("returns empty when there are zero targets", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [],
    };

    expect(buildPromptAddendum(policy)).toBe("");
  });

  it("renders one target with expected_duration and process recipe", () => {
    const policy: ManifestPolicy = {
      manifestPath: "/tmp/mise.toml",
      targets: [
        {
          target: "preflight",
          expectedDuration: "30m",
          gotchas: "run from repo root",
          unsafePatterns: [{ pattern: "./scripts/preflight.sh" }],
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
          unsafePatterns: [{ pattern: "pnpm lint" }],
        },
        {
          target: "test",
          unsafePatterns: [{ pattern: "pnpm test" }],
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
              pattern: "pnpm build",
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
