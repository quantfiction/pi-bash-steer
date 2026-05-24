import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findManifest, loadManifest } from "./manifest-loader.js";

/**
 * Tests for the manifest loader.
 *
 * Real-filesystem boundary: per testing-principles "mock at boundaries",
 * the filesystem is the boundary, so these tests use `mkdtemp` and write
 * real `mise.toml` files rather than mocking `fs`. Tradeoff: ~10ms slower
 * per test; in exchange we exercise the actual `findManifest` upward
 * walk, the actual `smol-toml` parser, and the actual TOML grammar.
 *
 * Invariant under test (loader contract): the loader NEVER throws into
 * its caller. Every error must be translated into a tagged
 * `ManifestLoadResult.status` so the tool_call listener can fail-safe
 * to passthrough.
 */

const createdDirs: string[] = [];

async function makeTempDir(prefix = "pi-bash-steer-loader-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function writeManifest(dir: string, contents: string): Promise<string> {
  const p = path.join(dir, "mise.toml");
  await writeFile(p, contents, "utf8");
  return p;
}

afterAll(async () => {
  // tempdirs are auto-cleaned by the OS; no aggressive rm needed.
  // Kept as a hook in case CI restricts /tmp.
  createdDirs.length = 0;
});

describe("findManifest", () => {
  it("returns the manifest path when it exists in the starting directory", async () => {
    const dir = await makeTempDir();
    const manifestPath = await writeManifest(dir, "");
    await expect(findManifest(dir)).resolves.toBe(manifestPath);
  });

  it("walks upward to find a manifest in an ancestor directory", async () => {
    // Catches: regression to "check cwd only" — the loader must walk
    // upward because pi sessions can be started from subdirectories.
    const root = await makeTempDir();
    const manifestPath = await writeManifest(root, "");
    const nested = path.join(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    await expect(findManifest(nested)).resolves.toBe(manifestPath);
  });

  it("returns null when no manifest exists up to the filesystem root", async () => {
    // Searching from a directory with no mise.toml above must terminate,
    // not loop forever. Tests the "parent === current" base case.
    const dir = await makeTempDir();
    await expect(findManifest(dir)).resolves.toBeNull();
  });
});

describe("loadManifest", () => {
  it("returns status='no_manifest' when nothing is found above the start dir", async () => {
    // Fail-safe path: tool_call listener treats this as passthrough.
    // Catches: regression that throws instead of returning a tag.
    const dir = await makeTempDir();
    const result = await loadManifest(dir);
    expect(result.status).toBe("no_manifest");
    if (result.status === "no_manifest") {
      expect(result.searchedFrom).toBe(path.resolve(dir));
    }
  });

  it("returns status='error' (not throw) on malformed TOML", async () => {
    // Critical invariant: the loader translates parse failures into a
    // tag, not an exception. Catches: regression to letting smol-toml's
    // SyntaxError propagate, which would crash the tool_call listener
    // and break passthrough.
    const dir = await makeTempDir();
    await writeManifest(dir, "this is = not valid [toml");
    const result = await loadManifest(dir);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("parse failed");
      expect(result.manifestPath).toBe(path.join(dir, "mise.toml"));
    }
  });

  it("returns status='empty' when TOML is valid but lacks [commands_meta.*]", async () => {
    // Distinguishes "well-formed but nothing to guard" from "broken
    // manifest". Both fail-safe to passthrough but produce different
    // UI notifications.
    const dir = await makeTempDir();
    await writeManifest(dir, `[tasks]\nbuild = "echo build"\n`);
    const result = await loadManifest(dir);
    expect(result.status).toBe("empty");
  });

  it("returns status='empty' when [commands_meta.*] tables exist but contain no unsafe_patterns", async () => {
    // A target declared without unsafe_patterns is not a guard target —
    // it's just metadata. Loader must skip it.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.build]\nexpected_duration = "5m"\ngotchas = "needs node 20"\n`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("empty");
  });

  it("normalizes string-shape unsafe_patterns entries to {pattern}", async () => {
    // Shape contract: `unsafe_patterns = ["foo"]` becomes
    // `[{ pattern: "foo" }]`. Catches: regression where the listener
    // expects `entry.pattern` but gets a bare string.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.preflight]\nunsafe_patterns = ["./scripts/preflight.sh"]\n`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.policy.targets).toHaveLength(1);
      const [t] = result.policy.targets;
      expect(t).toBeDefined();
      expect(t!.target).toBe("preflight");
      expect(t!.unsafePatterns).toEqual([
        { pattern: "./scripts/preflight.sh", matchMode: "substring" },
      ]);
    }
  });

  it("normalizes object-shape entries with warning to {pattern, warning}", async () => {
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.preflight]
unsafe_patterns = [
  { pattern = "./scripts/preflight.sh", warning = "Use the background recipe." },
]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        {
          pattern: "./scripts/preflight.sh",
          matchMode: "substring",
          warning: "Use the background recipe.",
        },
      ]);
    }
  });

  it("parses match_mode = \"command\" on object entries", async () => {
    // Wiring contract: the matcher relies on this field to switch from
    // substring containment to argv[0] tokenization. If the loader
    // silently drops or mistypes it, command-mode patterns regress to
    // substring matching and the `find` / `findings.md` over-match
    // returns.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.find]
unsafe_patterns = [
  { pattern = "find", match_mode = "command" },
  { pattern = "grep", match_mode = "command", warning = "Use code_search." },
]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        { pattern: "find", matchMode: "command" },
        { pattern: "grep", matchMode: "command", warning: "Use code_search." },
      ]);
    }
  });

  it("normalizes per-pattern redirect descriptors", async () => {
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.search]
unsafe_patterns = [
  { pattern = "find", match_mode = "command", redirect = { kind = "tool", tool = "code_search", recipe = 'code_search({ query: "..." })' } },
  { pattern = "./scripts/preflight.sh", redirect = { kind = "process", recipe = 'process({ action: "start", name: "preflight", command: "mise run preflight" })' } },
  { pattern = "grep -r", redirect = { kind = "shell", recipe = "rg <pattern> <path>" } },
  { pattern = "cat huge.log", redirect = { kind = "prose", text = "Read only the relevant slice." } },
]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        {
          pattern: "find",
          matchMode: "command",
          redirect: { kind: "tool", tool: "code_search", recipe: 'code_search({ query: "..." })' },
        },
        {
          pattern: "./scripts/preflight.sh",
          matchMode: "substring",
          redirect: {
            kind: "process",
            recipe: 'process({ action: "start", name: "preflight", command: "mise run preflight" })',
          },
        },
        {
          pattern: "grep -r",
          matchMode: "substring",
          redirect: { kind: "shell", recipe: "rg <pattern> <path>" },
        },
        {
          pattern: "cat huge.log",
          matchMode: "substring",
          redirect: { kind: "prose", text: "Read only the relevant slice." },
        },
      ]);
    }
  });

  it("preserves legacy string redirects verbatim", async () => {
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.lint]
unsafe_patterns = [{ pattern = "pnpm lint", redirect = "CUSTOM_REDIRECT" }]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        {
          pattern: "pnpm lint",
          matchMode: "substring",
          redirect: "CUSTOM_REDIRECT",
        },
      ]);
    }
  });

  it("falls back to substring on unknown match_mode value (typo must not silently disable guard)", async () => {
    // Catches: a manifest typo like match_mode = "commands" silently
    // disabling the argv[0] check. Safer to over-block via substring
    // than to fail open.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.find]
unsafe_patterns = [{ pattern = "find", match_mode = "commands" }]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([{ pattern: "find", matchMode: "substring" }]);
    }
  });

  it("supports mixed string and object entries in the same array", async () => {
    // Real-world manifests grow incrementally; some entries have
    // warnings, most don't. Both shapes must coexist.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.test]
unsafe_patterns = [
  "pnpm test",
  { pattern = "pnpm test:run", warning = "Use process()" },
  "bash scripts/test.sh",
]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        { pattern: "pnpm test", matchMode: "substring" },
        { pattern: "pnpm test:run", matchMode: "substring", warning: "Use process()" },
        { pattern: "bash scripts/test.sh", matchMode: "substring" },
      ]);
    }
  });

  it("drops empty-string pattern entries and object entries missing the pattern field", async () => {
    // Defensive normalization. Empty patterns would substring-match
    // every command and silently turn the guard into a deny-all.
    // Catches: regression that lets them through.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.preflight]
unsafe_patterns = [
  "",
  { warning = "no pattern field" },
  { pattern = "" },
  "./scripts/preflight.sh",
]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.unsafePatterns).toEqual([
        { pattern: "./scripts/preflight.sh", matchMode: "substring" },
      ]);
    }
  });

  it("carries expected_duration and gotchas through to the policy", async () => {
    // Wiring contract: these fields end up in the block reason. If
    // they don't carry, the agent loses the duration hint.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.preflight]
expected_duration = "30m"
gotchas = "must run from repo root"
unsafe_patterns = ["./scripts/preflight.sh"]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const [t] = result.policy.targets;
      expect(t!.expectedDuration).toBe("30m");
      expect(t!.gotchas).toBe("must run from repo root");
    }
  });

  it("preserves multiple targets in declaration order", async () => {
    // First-match-wins in the matcher depends on declaration order.
    // The loader must not sort or hash-reorder targets.
    const dir = await makeTempDir();
    await writeManifest(
      dir,
      `[commands_meta.preflight]
unsafe_patterns = ["./scripts/preflight.sh"]

[commands_meta.test]
unsafe_patterns = ["pnpm test"]

[commands_meta.build]
unsafe_patterns = ["pnpm build"]
`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.policy.targets.map((t) => t.target)).toEqual([
        "preflight",
        "test",
        "build",
      ]);
    }
  });

  it("returns the absolute manifest path in the ok policy", async () => {
    const dir = await makeTempDir();
    const manifestPath = await writeManifest(
      dir,
      `[commands_meta.x]\nunsafe_patterns = ["x"]\n`,
    );
    const result = await loadManifest(dir);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.policy.manifestPath).toBe(manifestPath);
      expect(path.isAbsolute(result.policy.manifestPath)).toBe(true);
    }
  });
});
