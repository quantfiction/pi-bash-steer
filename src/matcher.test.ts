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
    {
      pattern: "./scripts/preflight.sh",
      matchMode: "substring",
      warning: "Use the background process recipe.",
    },
    { pattern: "bash scripts/preflight.sh", matchMode: "substring" },
  ],
};

const TEST_TARGET: TargetPolicy = {
  target: "test",
  expectedDuration: "5m",
  unsafePatterns: [
    { pattern: "pnpm test:run", matchMode: "substring" },
    { pattern: "pnpm test", matchMode: "substring" },
  ],
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
        matchMode: "substring",
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
    const a: TargetPolicy = {
      target: "first",
      unsafePatterns: [{ pattern: "pnpm test", matchMode: "substring" }],
    };
    const b: TargetPolicy = {
      target: "second",
      unsafePatterns: [{ pattern: "pnpm test", matchMode: "substring" }],
    };
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
      pattern: { pattern: "bash scripts/preflight.sh", matchMode: "substring" },
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
      unsafePatterns: [{ pattern: "make build 2>&1 | tee", matchMode: "substring" }],
    };
    expect(matchUnsafePattern("make build 2>&1 | tee log.txt", policy([target])).matched).toBe(
      true,
    );
    // The pipe character must not act as alternation.
    expect(matchUnsafePattern("make", policy([target])).matched).toBe(false);
    expect(matchUnsafePattern("tee", policy([target])).matched).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// Command-mode matching (shell-quote argv tokenization)
// ---------------------------------------------------------------------------
//
// Promotes the test.todo("matcher: consider token-level matching...") from
// the original substring-only contract. See matcher.ts header for the full
// tokenization contract and v1 limitations (bash -c / eval opacity, heredoc
// body opacity, parse-error fallback to substring).

const FIND_CMD: TargetPolicy = {
  target: "find",
  expectedDuration: "10m",
  unsafePatterns: [{ pattern: "find", matchMode: "command" }],
};

describe("matchUnsafePattern — command mode", () => {
  it("matches when the pattern is argv[0] of a simple invocation", () => {
    // Acceptance (a): `find . -name foo` matches command=find.
    const result = matchUnsafePattern("find . -name foo", policy([FIND_CMD]));
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.pattern.pattern).toBe("find");
  });

  it("does NOT match when the pattern only appears inside a filename argument", () => {
    // Acceptance (b): `cat findings.md` does NOT match command=find. This is
    // the entire reason command mode exists — substring would over-match.
    expect(matchUnsafePattern("cat findings.md", policy([FIND_CMD])).matched).toBe(false);
    expect(matchUnsafePattern("ls findings/", policy([FIND_CMD])).matched).toBe(false);
    expect(matchUnsafePattern("grep 'find' file.txt", policy([FIND_CMD])).matched).toBe(false);
    expect(matchUnsafePattern("npm run find-deps", policy([FIND_CMD])).matched).toBe(false);
  });

  it("walks pipeline elements so `cd dir && find .` still matches", () => {
    // Acceptance (c): pipeline elements are walked, not just the first cmd.
    expect(matchUnsafePattern("cd dir && find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("true || find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("echo hi; find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("ls | xargs grep x | find .", policy([FIND_CMD])).matched).toBe(
      true,
    );
  });

  it("skips env-var prefixes so `FOO=1 find .` still matches", () => {
    // Without env-prefix stripping this regresses to the Claude Code
    // bug anthropics/claude-code#34106 (BRANCH=$(git ...) bypasses
    // Bash(git:*) because the prefix is BRANCH=, not git).
    expect(matchUnsafePattern("FOO=1 find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("FOO=1 BAR=2 find .", policy([FIND_CMD])).matched).toBe(true);
  });

  it("skips process wrappers (timeout, time, nice, nohup, stdbuf, xargs)", () => {
    // Matches Claude Code's built-in wrapper list. Without this, a
    // benign `timeout 30 find .` would bypass the guard.
    expect(matchUnsafePattern("timeout 30 find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("time find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("nice find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("nohup find . &", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("stdbuf -oL find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("xargs find . -name foo", policy([FIND_CMD])).matched).toBe(true);
  });

  it("strips the basename of argv[0] so `/usr/bin/find` matches `command=find`", () => {
    expect(matchUnsafePattern("/usr/bin/find .", policy([FIND_CMD])).matched).toBe(true);
    expect(matchUnsafePattern("./find -name foo", policy([FIND_CMD])).matched).toBe(true);
  });

  it("is case-sensitive (FIND != find)", () => {
    // Aligns with the substring-mode case-sensitivity contract.
    expect(matchUnsafePattern("FIND .", policy([FIND_CMD])).matched).toBe(false);
  });

  it("does NOT match the inner command of `bash -c \"find ...\"` (documented v1 limitation)", () => {
    // Pins the documented limitation. shell-quote returns the inner string
    // opaquely; only the outer `bash` is observable as argv[0]. Manifest
    // authors who need to defend against this should add a `command=bash`
    // / `command=eval` rule, or use a substring pattern.
    expect(matchUnsafePattern('bash -c "find . -name x"', policy([FIND_CMD])).matched).toBe(
      false,
    );
    expect(matchUnsafePattern('eval "find . -name x"', policy([FIND_CMD])).matched).toBe(false);
    expect(matchUnsafePattern('sh -c "find . -name x"', policy([FIND_CMD])).matched).toBe(false);
  });

  it("detects argv[0] inside subshells `(cd /tmp && find .)`", () => {
    // The `(` op resets the pipeline-element boundary; the next bare
    // word becomes argv[0].
    expect(matchUnsafePattern("(cd /tmp && find .)", policy([FIND_CMD])).matched).toBe(true);
  });

  it("detects argv[0] inside command substitution `echo $(find .)`", () => {
    // shell-quote emits `$`, `(`, ..., `)`. The `(` resets atStart so
    // the inner `find` is reachable as a new argv[0].
    expect(matchUnsafePattern("echo $(find .)", policy([FIND_CMD])).matched).toBe(true);
  });

  it("detects argv[0] inside process substitution `cat <(find .)`", () => {
    expect(matchUnsafePattern("cat <(find .)", policy([FIND_CMD])).matched).toBe(true);
  });

  it("existing substring patterns continue to match alongside command patterns", () => {
    // Acceptance (d): backward compat for substring patterns.
    const mixed: ManifestPolicy = policy([FIND_CMD, PREFLIGHT, TEST_TARGET]);
    expect(matchUnsafePattern("./scripts/preflight.sh", mixed).matched).toBe(true);
    expect(matchUnsafePattern("pnpm test:run", mixed).matched).toBe(true);
    expect(matchUnsafePattern("find .", mixed).matched).toBe(true);
    expect(matchUnsafePattern("echo hello", mixed).matched).toBe(false);
  });

  it("falls back to substring on shell-quote parse failure (over-block bias preserved)", () => {
    // Construct a command shell-quote can't parse cleanly: unbalanced
    // quotes. The fallback path should still substring-match `find`.
    // If shell-quote learns to parse this, the test still passes via
    // the command-mode path.
    expect(matchUnsafePattern('find . -name "unterminated', policy([FIND_CMD])).matched).toBe(
      true,
    );
  });

  it("first-match-wins works across mixed-mode patterns", () => {
    // Cmd-mode `find` and substring `find` both fire on `find .`; the
    // first-declared target wins (parallels the substring-only test).
    const cmd: TargetPolicy = {
      target: "first",
      unsafePatterns: [{ pattern: "find", matchMode: "command" }],
    };
    const sub: TargetPolicy = {
      target: "second",
      unsafePatterns: [{ pattern: "find", matchMode: "substring" }],
    };
    const result = matchUnsafePattern("find .", policy([cmd, sub]));
    expect(result.matched && result.target).toBe("first");
  });

  describe("regex mode", () => {
    const GIT_COMMIT_ALL: TargetPolicy = {
      target: "git_broad_add",
      unsafePatterns: [
        { pattern: "git commit --all\\b", matchMode: "regex" },
      ],
    };

    it("matches when the regex anchor is satisfied", () => {
      expect(matchUnsafePattern("git commit --all", policy([GIT_COMMIT_ALL])).matched).toBe(true);
      expect(
        matchUnsafePattern("git commit --all -m 'wip'", policy([GIT_COMMIT_ALL])).matched,
      ).toBe(true);
    });

    it("does NOT match flag siblings sharing the substring prefix (the bug this mode fixes)", () => {
      // The whole point of regex mode: `--allow-empty*` are legitimate
      // flags whose substring collides with `--all`. \b anchors them out.
      expect(
        matchUnsafePattern("git commit --allow-empty", policy([GIT_COMMIT_ALL])).matched,
      ).toBe(false);
      expect(
        matchUnsafePattern(
          "git commit --allow-empty -F /tmp/msg.txt",
          policy([GIT_COMMIT_ALL]),
        ).matched,
      ).toBe(false);
      expect(
        matchUnsafePattern(
          "git commit --allow-empty-message -m ''",
          policy([GIT_COMMIT_ALL]),
        ).matched,
      ).toBe(false);
      expect(
        matchUnsafePattern("git commit --allow-empty-author", policy([GIT_COMMIT_ALL])).matched,
      ).toBe(false);
    });

    it("falls back to substring containment when the regex source is invalid", () => {
      // Unbalanced `[` is a SyntaxError in `new RegExp()`. The fallback
      // path should treat the source as a literal substring — preserving
      // the over-block bias (a manifest typo must not silently disable a
      // guard).
      const bad: TargetPolicy = {
        target: "bad",
        unsafePatterns: [{ pattern: "git commit [oops", matchMode: "regex" }],
      };
      expect(
        matchUnsafePattern("prefix git commit [oops suffix", policy([bad])).matched,
      ).toBe(true);
      expect(matchUnsafePattern("git commit -m 'fine'", policy([bad])).matched).toBe(false);
    });

    it("is case-sensitive by default (no `i` flag)", () => {
      // Authors who need case-insensitivity write the character class
      // explicitly. Documented in matcher.ts / manifest-loader.ts.
      expect(matchUnsafePattern("GIT COMMIT --all", policy([GIT_COMMIT_ALL])).matched).toBe(
        false,
      );
    });
  });

  // Documented limitations preserved as test.todo for future Q-G review.
  // The substring-only test.todo about token-level matching is now
  // PROMOTED — see the command-mode tests above.
  test.todo(
    "block reason: surface a per-target single-file escape-hatch recipe so over-blocked fast invocations have a clear next step",
  );
  test.todo(
    "command mode: optionally escalate `bash -c` / `eval` / `sh -c` to a configurable severity instead of silently passing through (requires manifest schema extension)",
  );
  test.todo(
    "command mode: optionally recurse into `bash -c \"...\"` inner-string by re-parsing the quoted argument (cost: extra parser pass; benefit: closes the runtime-string-eval bypass)",
  );
});
