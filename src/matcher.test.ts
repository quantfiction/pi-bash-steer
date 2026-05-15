import { describe, expect, it, test } from "vitest";
import type { ManifestPolicy, TargetPolicy } from "./manifest-loader.js";
import { matchUnsafePattern } from "./matcher.js";

/**
 * Tests for the pure `matchUnsafePattern` function.
 *
 * Per the matcher.ts doc-comment (Q-G): v1 deliberately uses literal
 * substring matching via `String.prototype.includes`. AST/regex shell
 * parsing is deferred. These tests pin that contract.
 *
 * Cost-asymmetry rationale: a false negative (missed block on a 30-min
 * preflight) burns 5–30 minutes via timeout-retry. A false positive
 * (over-block on a fast invocation) costs ~5–15 seconds of process()
 * indirection. The substring matcher's over-block bias is correctly
 * aligned with that asymmetry; do not "fix" it without re-doing the
 * cost analysis.
 */

function policy(targets: TargetPolicy[]): ManifestPolicy {
  return { manifestPath: "/tmp/mise.toml", targets };
}

const PREFLIGHT: TargetPolicy = {
  target: "preflight",
  expectedDuration: "30m",
  gotchas: "run from repo root",
  unsafePatterns: [
    { pattern: "./scripts/preflight.sh", warning: "Use the background process recipe." },
    { pattern: "bash scripts/preflight.sh" },
  ],
};

const TEST_TARGET: TargetPolicy = {
  target: "test",
  expectedDuration: "5m",
  unsafePatterns: [{ pattern: "pnpm test:run" }, { pattern: "pnpm test" }],
};

describe("matchUnsafePattern", () => {
  it("returns matched=false on empty command (defensive early-return)", () => {
    // Catches: future refactor that drops the empty-string guard and
    // accidentally matches a zero-length policy entry against everything.
    expect(matchUnsafePattern("", policy([PREFLIGHT]))).toEqual({ matched: false });
  });

  it("returns matched=false when policy has no targets", () => {
    // Catches: regression where a manifest with empty commands_meta
    // somehow gets treated as a wildcard.
    expect(matchUnsafePattern("rm -rf /", policy([]))).toEqual({ matched: false });
  });

  it("returns matched=false when no pattern is a substring of the command", () => {
    expect(matchUnsafePattern("ls -la", policy([PREFLIGHT, TEST_TARGET]))).toEqual({
      matched: false,
    });
  });

  it("matches a literal pattern and carries through target metadata", () => {
    // Catches: wiring bug where expectedDuration / pattern.warning /
    // gotchas don't reach the listener (block reason would lose the
    // human-readable hint).
    const result = matchUnsafePattern("./scripts/preflight.sh", policy([PREFLIGHT]));
    expect(result).toEqual({
      matched: true,
      target: "preflight",
      pattern: {
        pattern: "./scripts/preflight.sh",
        warning: "Use the background process recipe.",
      },
      expectedDuration: "30m",
      gotchas: "run from repo root",
    });
  });

  it("matches by substring containment, not equality (pipes / cwd-chains / redirects)", () => {
    // Catches: regression to equality / startsWith matching, which
    // would let agents bypass the guard by piping (`cmd | tee log`),
    // chaining (`cd dir && cmd`), or redirecting (`cmd > out`).
    const p = policy([TEST_TARGET]);
    expect(matchUnsafePattern("cd packages/web && pnpm test:run", p).matched).toBe(true);
    expect(matchUnsafePattern("pnpm test:run | tee out.log", p).matched).toBe(true);
    expect(matchUnsafePattern("pnpm test:run > /tmp/out 2>&1", p).matched).toBe(true);
    expect(matchUnsafePattern("FOO=1 pnpm test:run", p).matched).toBe(true);
  });

  it("matches single-file invocations too (documented over-block — see test.todo below)", () => {
    // Catches: a future "smarter" matcher quietly changing this
    // contract. The cost analysis (false-positive ~10s vs
    // false-negative ~10min) says over-blocking is intentional. If
    // someone changes this, they must also change the test AND the
    // matcher.ts Q-G doc-comment.
    const result = matchUnsafePattern(
      "pnpm test:run -- packages/web/src/foo.test.ts",
      policy([TEST_TARGET]),
    );
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.pattern.pattern).toBe("pnpm test:run");
  });

  it("first-match-wins across targets in declaration order", () => {
    // Both targets contain "pnpm test" as a substring. The first
    // declared target must win — establishes deterministic block
    // reason for manifests with overlapping patterns.
    const a: TargetPolicy = { target: "first", unsafePatterns: [{ pattern: "pnpm test" }] };
    const b: TargetPolicy = { target: "second", unsafePatterns: [{ pattern: "pnpm test" }] };
    const result = matchUnsafePattern("pnpm test", policy([a, b]));
    expect(result.matched && result.target).toBe("first");
  });

  it("first-match-wins across patterns within a target", () => {
    // "pnpm test:run" appears before "pnpm test" in TEST_TARGET.
    // The more-specific pattern must win for "pnpm test:run" input.
    const result = matchUnsafePattern("pnpm test:run", policy([TEST_TARGET]));
    expect(result.matched && result.pattern.pattern).toBe("pnpm test:run");
  });

  it("falls through to the second pattern if the first doesn't match", () => {
    const result = matchUnsafePattern("pnpm test --filter=web", policy([TEST_TARGET]));
    // "pnpm test:run" doesn't match this command; "pnpm test" does.
    expect(result.matched && result.pattern.pattern).toBe("pnpm test");
  });

  it("is case-sensitive (shell commands are case-sensitive)", () => {
    // matcher.ts doc-comment claims case-sensitive. Pin it.
    // Catches: someone "helpfully" adding .toLowerCase() to be lenient.
    expect(matchUnsafePattern("PNPM TEST", policy([TEST_TARGET]))).toEqual({ matched: false });
    expect(matchUnsafePattern("./Scripts/Preflight.sh", policy([PREFLIGHT]))).toEqual({
      matched: false,
    });
  });

  it("returns the pattern object without a warning field when none was authored", () => {
    // Catches: regression that fabricates a warning string when the
    // manifest author left it absent, polluting the block reason.
    const result = matchUnsafePattern("bash scripts/preflight.sh", policy([PREFLIGHT]));
    expect(result).toEqual({
      matched: true,
      target: "preflight",
      pattern: { pattern: "bash scripts/preflight.sh" },
      expectedDuration: "30m",
      gotchas: "run from repo root",
    });
  });

  it("treats patterns containing special-looking shell characters as literals", () => {
    // The matcher must not silently treat `|` or `*` as regex/glob.
    // Authors writing literal `2>&1` style patterns get exactly that
    // semantics.
    const target: TargetPolicy = {
      target: "weird",
      unsafePatterns: [{ pattern: "make build 2>&1 | tee" }],
    };
    expect(matchUnsafePattern("make build 2>&1 | tee log.txt", policy([target])).matched).toBe(
      true,
    );
    // The pipe character must not act as alternation.
    expect(matchUnsafePattern("make", policy([target])).matched).toBe(false);
    expect(matchUnsafePattern("tee", policy([target])).matched).toBe(false);
  });

  // Known limitations — documented breadcrumbs for future design review.
  // These are NOT bugs; they are the deliberate Q-G design tradeoff.
  test.todo(
    "matcher: consider token-level matching (shell-quote / mvdan-sh) once false-positive friction is measured in real sessions",
  );
  test.todo(
    "block reason: surface a per-target single-file escape-hatch recipe so over-blocked fast invocations have a clear next step",
  );
});
