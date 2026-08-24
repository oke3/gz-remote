# opencode-remote

[![CI](https://github.com/oke3/opencode-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/oke3/opencode-remote/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-remote.svg)](https://www.npmjs.com/package/opencode-remote)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/opencode-remote.svg)](package.json)

Zero-dependency CLI + library for driving [opencode](https://github.com/sst/opencode) instances
on **remote machines over SSH** — detached job launches on Windows, a serve-API control plane,
and battle-tested workarounds for every headless failure mode.

Born from a real distributed build: an orchestrator on Linux, the worker on a Windows laptop,
the code committed on the far machine — this package is that pipeline, bottled.

## Contents

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [The launch recipe](#the-launch-recipe)
- [Headless pitfalls (and how ocr avoids them)](#headless-pitfalls-and-how-ocr-avoids-them)
- [Library API](#library-api)
- [Security](#security)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why

Driving an agent on another machine sounds like `ssh host "opencode run ..."` and then it
silently dies four different ways. Each of these was hit in production use:

- `start` / `Start-Process` detach **dies silently** over non-interactive SSH — not even the
  output redirect target gets created.
- Multi-line CLI arguments are **mangled at the npm `.cmd` shim boundary** (newlines split).
- Headless lanes **auto-reject permission prompts** (`external_directory`, etc.) — any file
  outside the project dir fails or hangs forever waiting for an approval nobody can give.
- Large inline prompts (~3 KB+) can **hang headless turns** outright.
- PowerShell quoting through bash → ssh → cmd → powershell eats `$_` and nested quotes.

`ocr` encodes the working answers: scheduled-task detachment, base64 EncodedCommand transport,
tiny prompts pointing at specs copied *inside* the repo, and one-command status snapshots.

## Install

Requires Node.js >= 22. SSH client available on `PATH`; key-based auth to the remote host
must already work (BatchMode — no password prompts).

```sh
npm install -g opencode-remote
```

From a checkout:

```sh
npm install && npm run build && node dist/cli.js --help
```

## Quick start

```sh
# 0. sanity: what's on the far machine?
ocr probe my-windows-box

# 1. bring up the serve API control plane (scheduled task "ocserve")
ocr serve my-windows-box up

# 2. launch a spec-driven build job, detached — survives disconnects
ocr launch my-windows-box 'F:\Projects\my-repo' ./SPEC.md --task-name build1

# 3. check on it anytime
ocr status my-windows-box 'F:\Projects\my-repo' --task build1

# 4. list sessions / send short follow-ups via the serve API
ocr sessions my-windows-box
ocr prompt ses_xxx followup.txt --url http://<host-ip>:4310
```

## CLI reference

```
ocr probe <host>
    Detect the remote environment: PowerShell version, execution policy,
    opencode path, git path, OS caption.

ocr launch <host> <remoteRepoDir> <specFile> [--task-name n] [--model m] [--log name]
    Upload specFile, register a scheduled task that copies it into the repo
    dir as SPEC.md and runs opencode headlessly against it (all output
    appended to the build log inside the repo dir). Polls (max 90s) until
    BUILD START appears in the log.
    Defaults: model=opencode/x-preview-f-free log=build-<task-name>.log

ocr status <host> <remoteRepoDir> [--task n] [--tail n]
    One-shot snapshot: scheduled-task state, last --tail log lines (default
    6, truncated to 220 chars), git log --oneline -5, changed-file count.

ocr serve <host> [--port p] <up|down|status>
    Manage the opencode serve API as scheduled task "ocserve"
    (default port 4310). status reports task state + port LISTENING.

ocr sessions <host> [--port p] [--json] [--url http://ip:port]
    List opencode sessions through the serve API (GET /api/session).

ocr prompt <sessionId> <textFile|-> [--url http://ip:port] [--force]
    POST {"prompt":{"text":...}} to /api/session/<id>/prompt. '-' reads
    stdin. Prompts over 250 chars are refused unless --force.
```

Exit codes: `0` success · `1` operation failure · `2` usage/validation error.

## The launch recipe

`ocr launch` generates and runs a PowerShell launcher implementing everything that matters:

1. Copy the spec into the repo as `SPEC.md` (**inside** the project — never triggers
   `external_directory` permission prompts).
2. `cd` into the repo; write a timestamped `BUILD START` line to the in-repo build log.
3. Run `opencode run -m <model>` with a **single-line prompt under 250 chars** that tells the
   agent to read `SPEC.md` itself.
4. Append all streams to the log, finish with `EXITCODE=<n>`.
5. Wrap all of it in a Windows **scheduled task** (`schtasks /create` + `/run`) so the job
   survives SSH disconnect — with `-ExecutionPolicy Bypass` so script policy never bites.

You monitor from afar with `ocr status`; the agent commits locally at milestones.

## Headless pitfalls (and how ocr avoids them)

| Pitfall | Symptom | ocr's answer |
| --- | --- | --- |
| `start`/`Start-Process` over SSH | Silent death, no output file created | Scheduled-task detachment |
| Execution policy | Script blocked before line 1 | `-ExecutionPolicy Bypass` |
| Multi-line args via `.cmd` shims | Prompt truncated/mangled at first newline | Single-line tiny prompt |
| Permission auto-reject headless | Tool hangs "running" forever | Spec lives in-repo (`SPEC.md`) |
| Large inline prompts (~3 KB+) | Turn starts, zero tokens ever arrive | 250-char prompt ceiling (`--force` to override) |
| PS quoting across bash→ssh→cmd→PS | `$_` eaten, pipes split | UTF-16LE base64 `EncodedCommand` transport |

## Library API

Every CLI capability is importable — build your own orchestration on the primitives:

```ts
import { toEncodedCommand } from "opencode-remote"; // PS script -> base64 UTF-16LE
import { buildSshArgs, runSsh } from "opencode-remote"; // hardened ssh exec
import { renderLauncher } from "opencode-remote"; // launcher .ps1 generation (pure fn)
import { buildCreateTaskArgs, parseTaskStatus } from "opencode-remote"; // schtasks
import { listSessions, postPrompt } from "opencode-remote"; // serve-API client
```

All argument builders are pure functions (fully unit-tested); `runSsh` always injects
`-o BatchMode=yes -o StrictHostKeyChecking=no` and enforces timeouts.

## Security

`ocr` executes commands on remote hosts over SSH and registers scheduled tasks there. It does
not manage credentials — set up key auth yourself. The serve API it drives is typically
unauthenticated; keep it on a private network (Tailscale/WireGuard). Suites/specs you launch
run with the remote user's privileges: only launch specs you trust.

## Development

```sh
npm install        # devDependencies only; runtime has zero dependencies
npm run typecheck  # strict tsc
npm test           # node:test — 108 pure-construction cases, no network
npm run build      # emit dist/
npm run smoke      # dist/cli.js --help
```

Layout: `src/types.ts`, `src/encoded.ts` (EncodedCommand), `src/ssh.ts`, `src/winprobe.ts`,
`src/launcher.ts`, `src/tasks.ts`, `src/serve.ts`, `src/cli.ts`. Tests construct commands and
parse outputs purely — no network, no `$HOME` access.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © oke3
