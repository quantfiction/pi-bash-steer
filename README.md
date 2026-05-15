# pi-bash-steer

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
intercepts long-running bash invocations and steers agents toward
non-blocking alternatives — typically the `process()` tool provided by
[`@aliou/pi-processes`](https://github.com/aliou/pi-processes), or
faster native tools.

> **Status**: core implemented and tested (manifest loader + matcher +
> `tool_call` guard + `before_agent_start` prompt addendum +
> `PI_BASH_STEER` enforce/warn/off levels). Token-level matching and
> built-in universal-footgun defaults are on the roadmap.

> **History**: This package was previously named `pi-verify-guard`. The
> scope broadened beyond "verification commands" (preflight, test,
> build) to "any long-running bash invocation" — including universal
> footguns like `find`, `grep -r`, `tar` of large archives. The new
> name reflects the actual mission.

## Why

Agent workers repeatedly invoke long-running commands synchronously
from their bash tool. Pi's bash tool times out at 2–5 minutes; preflight
and full test runs take 5–30+ minutes; `find .` in a large repo with
unpruned `node_modules` can hang indefinitely. The result is
timeout-retry loops that waste hours per incident. Prose guidance in
`AGENTS.md` has not solved it over a 6-week window.

This extension makes the wrong path structurally impossible: a
`tool_call` listener reads the project's `mise.toml [commands_meta.*]`
manifest and blocks any bash command matching a target's
`unsafe_patterns`, returning a paste-ready `process({...})` recipe in
the block reason.

## Install

```sh
pi install npm:pi-bash-steer
```

## Configuration

The extension reads `mise.toml` from the session's `cwd`. Each target
that should be steered declares an `unsafe_patterns` array under
`[commands_meta.<target>]`:

```toml
[commands_meta.preflight]
requires_tmux = true
expected_duration = "30m"
unsafe_patterns = [
  "./scripts/preflight.sh",
  "scripts/preflight.sh",
  "bash scripts/preflight.sh",
]
```

A bash command from the agent whose `command` string contains any
`unsafe_patterns` entry is blocked; the block reason directs the agent
to the canonical `process({...})` invocation.

## Environment

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `PI_BASH_STEER` | `enforce` \| `warn` \| `off` | `enforce` | Global enforcement level. Read once at session start. |

## Status

Extension shipped with tested core behavior:

- `manifest-loader` + `matcher` for `mise.toml [commands_meta.*]`
- `tool_call` listener that blocks (or warns on) matching bash commands
- `before_agent_start` listener that injects a system-prompt addendum with
  active unsafe patterns and per-target `process({...})` guidance
- `PI_BASH_STEER` enforcement levels (`enforce` | `warn` | `off`)

## Composition with other extensions

pi-bash-steer owns one axis: **tool affinity** — redirecting inefficient
bash usage to the right tool in pi's available palette. It is not a
replacement for, and does not compete with, the other axes of the pi
bash-interception ecosystem. Stack them:

| Axis | Use | Composes with pi-bash-steer how |
|---|---|---|
| Process model | [`@aliou/pi-processes`](https://github.com/aliou/pi-processes) provides the `process()` tool | pi-bash-steer's block reasons reference `process({...})` directly; recommend installing both together |
| Safety | [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails) blocks dangerous commands (`rm -rf`, `sudo`, etc.) | Runs alongside; `tool_call` event listeners coexist. Dangerous-command blocks fire on their own contract; pi-bash-steer fires on its own. |
| Token cost | [`pi-lean-ctx`](https://github.com/yvgude/lean-ctx) compresses shell output | Runs downstream of pi-bash-steer at tool-execution time. No conflict. |
| Permission policy | [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) provides allow/ask/deny | Runs alongside; different concern (policy vs. tool routing). |
| Containment | `pi-sandbox`, `pi-container-sandbox`, `pi-gondolin`, etc. | Sandbox the runtime; pi-bash-steer still routes within it. |

pi-bash-steer never mutates `event.input.command`, so it composes cleanly
with extensions that inspect the original command verbatim.

## Roadmap

- **Strengthen prompt addendum** with universal tool-affinity hints:
  bash `find` → pi `find` / `code_search` / `rg --files`; bash `grep -r`
  → pi `grep` / `rg`; bash `cat` → pi `read`. Prose-level steering ships
  first, before enforcement.
- **Token-level matching** (replace substring `includes` with
  `shell-quote`-based argv tokenization) to remove false positives like
  `pnpm test:run -- single.test.ts` matching a broad `pnpm test:run`
  pattern, and to make command-name patterns like `find` enforceable
  without flooding the agent with false positives.
- **Built-in universal footgun defaults** — ship a default policy that
  covers `find`, `grep -r`, `tar` of large archives, etc., with
  redirects to `rg --files`, pi-native tools, and so on. Merges with
  the project's `mise.toml` policy.
- **Tool-palette detection** — introspect registered tools at
  `session_start` and tune redirect recipes to what's actually
  installed (e.g. only suggest `process({...})` if pi-processes is
  loaded).
- **Per-pattern redirect schema** — each `unsafe_patterns` entry can
  declare its own redirect target rather than always pointing at
  `mise run <target>`.

## License

MIT © quantfiction
