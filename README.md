# pi-verify-guard

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that blocks
direct invocation of long-running verification commands (lint, typecheck, test,
build, preflight) from the agent's bash tool, and redirects agents to the
`process()` tool provided by [`@aliou/pi-processes`](https://github.com/aliou/pi-processes).

> **Status**: core implemented and tested (manifest loader + matcher +
> `tool_call` guard + `before_agent_start` prompt addendum +
> `PI_VERIFY_GUARD` enforce/warn/off levels).
> See `docs/plans/agent-verification-infra/verification-as-first-class-action/ROUGH.md`
> in the MindHive repo for design.

## Why

Agent workers repeatedly invoke long verification commands synchronously from
their bash tool. Pi's bash tool times out at 2–5 minutes; preflight and full
test runs take 5–30+ minutes. The result is timeout-retry loops that waste
hours per incident. Prose guidance in `AGENTS.md` has not solved it over a
6-week window.

This extension makes the wrong path structurally impossible: a `tool_call`
listener reads the project's `mise.toml [commands_meta.*]` manifest and
blocks any bash command matching a target's `unsafe_patterns`, returning a
paste-ready `process({...})` recipe in the block reason.

## Install

```sh
pi install npm:pi-verify-guard
```

## Configuration

The extension reads `mise.toml` from the session's `cwd`. Each target that
should be guarded declares an `unsafe_patterns` array under
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
`unsafe_patterns` entry is blocked; the block reason directs the agent to the
canonical `process({...})` invocation.

## Environment

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `PI_VERIFY_GUARD` | `enforce` \| `warn` \| `off` | `enforce` | Global enforcement level. Read once at session start. |

## Status

Extension shipped with tested core behavior:

- `manifest-loader` + `matcher` for `mise.toml [commands_meta.*]`
- `tool_call` listener that blocks (or warns on) matching bash commands
- `before_agent_start` listener that injects a system-prompt addendum with
  active unsafe patterns and per-target `process({...})` guidance
- `PI_VERIFY_GUARD` enforcement levels (`enforce` | `warn` | `off`)

## License

MIT © quantfiction
