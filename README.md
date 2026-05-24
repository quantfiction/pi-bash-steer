# pi-bash-steer

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
intercepts long-running bash invocations and steers agents toward the
best available alternative for the current session — pi-native tools,
fast shell-level search/listing primitives, `process()` from
[`@aliou/pi-processes`](https://github.com/aliou/pi-processes), or a
shell-level background fallback.

> **Status**: core implemented and tested (manifest loader + matcher
> with `substring` and `command` match modes + `tool_call` guard +
> `before_agent_start` prompt addendum + `PI_BASH_STEER`
> enforce/warn/off levels + built-in universal-footgun defaults +
> per-pattern `redirect` schema + runtime tool-palette detection).

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
`unsafe_patterns`, returning a palette-aware redirect in the block
reason. Tool-affinity footguns like `find .` and `grep -r` steer to
better search/listing primitives; genuinely long-running commands steer
to `process()` when active, then tmux/log polling, then a plain
background/log fallback.

## Install

```sh
pi install git:github.com/quantfiction/pi-bash-steer
```

Or pin to a tag:

```sh
pi install git:github.com/quantfiction/pi-bash-steer@v0.1.0
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

[commands_meta.build]
unsafe_patterns = [
  { pattern = "pnpm build", warning = "Frequently exceeds shell timeout.",
    redirect = { kind = "process", recipe = 'process({ action: "start", name: "build", command: "pnpm build" })' } },
]

[commands_meta.search]
unsafe_patterns = [
  { pattern = "find", match_mode = "command",
    redirect = { kind = "tool", tool = "code_search", recipe = 'code_search({ query: "..." })' } },
  { pattern = "grep -r",
    redirect = { kind = "shell", recipe = "rg <pattern> <path>" } },
]
```

A bash command from the agent whose `command` string contains any
`unsafe_patterns` entry is blocked; the block reason directs the agent
to the generated palette-aware redirect, or to the pattern's own
structured `redirect` descriptor. Legacy string redirects are still
accepted and rendered verbatim.

### Per-pattern fields

| Field | Required | Purpose |
|---|---|---|
| `pattern` | yes | The literal string compared against the bash command per `match_mode`. |
| `match_mode` | no (default `substring`) | `substring` or `command`. See below. |
| `warning` | no | Short prose surfaced in the block reason. |
| `redirect` | no | Custom redirect descriptor that replaces the default `mise run <target>` recipe in the block reason. Legacy string redirects are still accepted as free-form prose. |

Redirect descriptors support four `kind` values:

| Kind | Required fields | Purpose |
|---|---|---|
| `process` | `recipe` | Recommend the `process` tool / @aliou/pi-processes for long-running work. If `process` is inactive, the block reason says so and still shows the intended recipe. |
| `tool` | `tool`, `recipe` | Recommend a pi-native tool such as `read`, `find`, `grep`, `ls`, or `code_search`. The block reason checks whether the named tool is active/registered in the current session. |
| `shell` | `recipe` | Recommend a different shell command, e.g. `rg`, `fd`, or a narrow project script. |
| `prose` | `text` | Free-form guidance only, with no executable recipe. |

### Match modes

Each pattern is compared in one of two modes (`match_mode` on object
entries; bare-string entries default to `substring`):

| Mode | Comparison | When to use |
|---|---|---|
| `substring` (default) | `String.prototype.includes` containment | Multi-token patterns where the substring uniquely identifies the unsafe shape (`./scripts/preflight.sh`, `pnpm test:run`). Catches pipes, redirects, `cd dir && cmd`, env prefixes for free. |
| `command` | argv[0] basename of any pipeline element, with env-prefix and wrapper stripping (shell-quote tokenization) | Short command names whose substring would over-match (`find` appears in `findings.md`, `npm run find-deps`, etc). |

Command mode handles `cd dir && find .`, `FOO=1 find`, `timeout 30 find`,
`nice -n 10 find`, `xargs find`, `(cd /tmp && find .)`, `echo $(find .)`,
and `cat <(find .)`. It does **not** see inside `bash -c "find ..."` or
`eval "..."` (runtime string evaluation is opaque to single-pass
parsing); add a `command=bash` rule or a substring pattern if you need
to defend against that shape. See `src/matcher.ts` for the full
contract.

## Built-in universal-footgun defaults

The extension ships a built-in policy that blocks the bash footguns
that are universal across projects — it fires even when there is no
`mise.toml`. The full list lives in [`src/defaults.ts`](src/defaults.ts).

| Target (namespaced) | Patterns | Redirect |
|---|---|---|
| `__builtins__find` | `find` (command mode) | pi `find` if active; else `rg --files`; else `fd`; else scoped/pruned shell prose |
| `__builtins__grep_recursive` | `grep -r`, `grep -R`, `grep --recursive` | pi `grep` if active; else `rg <pattern>`; else scoped/pruned shell prose |
| `__builtins__ls_R` | `ls -R` | `rg --files`; else `fd`; else pi `find`; else scoped prose |
| `__builtins__tar_create` | `tar -c`, `tar c` | `process()` if active; else tmux + log polling; else background job + log polling |
| `__builtins__du_root` | `du -sh /`, `du -h /`, `du -sh ~`, `du -h ~` | scope the path first; for genuine full scans, `process()`/tmux/background fallback if available |
| `__builtins__pkg_install` | `npm install`, `pnpm install`, `yarn install` | `process()` if active; else tmux + log polling; else background job + log polling |
| `__builtins__docker_build` | `docker build` | `process()` if active; else tmux + log polling; else background job + log polling |

Pipeline grep (`cmd | grep x`) is **not** blocked — only the recursive
on-disk shape is the actual footgun. Bare `cat` is also not blocked
(no reliable way to detect "large file" from the command string); it is
steered through the universal prose hints only.

### Overriding a built-in

Declare the same `__builtins__*` target in your project's `mise.toml`:

```toml
# Replace the built-in `find` recipe with a project-specific one.
[commands_meta.__builtins__find]
unsafe_patterns = [
  { pattern = "find", match_mode = "command",
    redirect = "Use `./scripts/fast-find.sh` — it prunes node_modules and .git." },
]
```

The project entry replaces the built-in target wholesale. All other
built-ins survive. To disable a single built-in without providing a
replacement, set its `unsafe_patterns` to `[]`.

To opt out of *all* built-ins at the session level, see
`PI_BASH_STEER_BUILTINS` below.

## Environment

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `PI_BASH_STEER` | `enforce` \| `warn` \| `off` | `enforce` | Global enforcement level. Read once at session start. |
| `PI_BASH_STEER_BUILTINS` | `on` \| `off` | `on` | Wholesale opt-out for built-in universal-footgun defaults. With `off`, only the project's `mise.toml [commands_meta.*]` patterns fire — identical to pre-builtins behavior. Read once at extension activation. |

## Status

Extension shipped with tested core behavior:

- `manifest-loader` + `matcher` for `mise.toml [commands_meta.*]`,
  with `substring` (default) and `command` (shell-quote argv
  tokenization) match modes per pattern
- `tool_call` listener that blocks (or warns on) matching bash commands
- `before_agent_start` listener that injects a system-prompt addendum with
  active unsafe patterns and per-target palette-aware guidance
- Universal tool-affinity hints in the addendum (independent of
  `[commands_meta.*]`) steering bash `find` / `grep -r` / `cat` /
  `ls -R` and vague semantic queries only toward tools/binaries that
  are actually active or detected in the current session. Fires even in
  projects without a `mise.toml`.
- Built-in universal-footgun defaults (`find`, `grep -r`, `ls -R`,
  `tar -c`, `du -sh /`, `npm/pnpm/yarn install`, `docker build`)
  that *block* the footgun shapes, not just steer in prose. Merge
  with the project's `mise.toml`; namespace-override on collision;
  wholesale opt-out via `PI_BASH_STEER_BUILTINS=off`.
- Per-pattern `redirect` schema field — each `unsafe_patterns` entry
  can carry its own redirect recipe instead of the generated
  palette-aware default.
- Runtime tool-palette detection at `session_start`: active pi tools
  (`process`, `code_search`, `find`, `grep`, `read`) plus bounded shell
  probes for `rg`, `fd`/`fdfind`, and `tmux`.
- `PI_BASH_STEER` enforcement levels (`enforce` | `warn` | `off`)

## Composition with other extensions

pi-bash-steer owns one axis: **tool affinity** — redirecting inefficient
bash usage to the right tool in pi's available palette. It is not a
replacement for, and does not compete with, the other axes of the pi
bash-interception ecosystem. Stack them:

| Axis | Use | Composes with pi-bash-steer how |
|---|---|---|
| Process model | [`@aliou/pi-processes`](https://github.com/aliou/pi-processes) provides the `process()` tool | pi-bash-steer's process-model block reasons reference `process({...})` when the tool is active; otherwise they fall back to tmux/log polling or background/log polling |
| Safety | [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails) blocks dangerous commands (`rm -rf`, `sudo`, etc.) | Runs alongside; `tool_call` event listeners coexist. Dangerous-command blocks fire on their own contract; pi-bash-steer fires on its own. |
| Token cost | [`pi-lean-ctx`](https://github.com/yvgude/lean-ctx) compresses shell output | Runs downstream of pi-bash-steer at tool-execution time. No conflict. |
| Permission policy | [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) provides allow/ask/deny | Runs alongside; different concern (policy vs. tool routing). |
| Containment | `pi-sandbox`, `pi-container-sandbox`, `pi-gondolin`, etc. | Sandbox the runtime; pi-bash-steer still routes within it. |

pi-bash-steer never mutates `event.input.command`, so it composes cleanly
with extensions that inspect the original command verbatim.

## Roadmap

- **Flag-aware matching** — a third `match_mode` that understands
  flag/positional structure so rules like "block `grep` only when no
  pipeline upstream is present" can be expressed without substring
  approximations.
- **`.pi/bash-steer.toml` override file** — deferred (YAGNI). For now,
  built-in overrides live in the project's `mise.toml` under
  `[commands_meta.__builtins__*]`.

## License

MIT © quantfiction
