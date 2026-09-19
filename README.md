# gz-remote

> Your AI agent is on your laptop. Your code is on a server. Bridge them.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Ground Zero LLC](https://img.shields.io/badge/Built%20by-Ground%20Zero%20LLC-purple)](https://github.com/oke3)
[![npm](https://img.shields.io/npm/v/@ground-zero-llc/gz-remote)](https://www.npmjs.com/package/@ground-zero-llc/gz-remote)
[![CI](https://github.com/oke3/gz-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/oke3/gz-remote/actions)

Zero-dependency CLI + library for driving [opencode](https://github.com/sst/opencode) instances
on **remote machines over SSH** — detached job launches on Windows, a serve-API control plane,
and battle-tested workarounds for every headless failure mode.

Born from a real distributed build: an orchestrator on Linux, the worker on a Windows laptop,
the code committed on the far machine — this package is that pipeline, bottled.

---

## Why

Driving an agent on another machine sounds like `ssh host "opencode run ..."` and then it
silently dies four different ways:

| Pitfall | Symptom |
|---------|---------|
| `start` / `Start-Process` over SSH | Silent death, no output file created |
| Multi-line CLI args via `.cmd` shims | Prompt truncated/mangled at first newline |
| Headless permission auto-reject | Tool hangs "running" forever |
| Large inline prompts (~3 KB+) | Turn starts, zero tokens ever arrive |
| PowerShell quoting across bash→ssh→cmd→PS | `$_` eaten, pipes split |

`ocr` encodes the working answers: scheduled-task detachment, base64 EncodedCommand transport,
tiny prompts pointing at specs copied *inside* the repo, and one-command status snapshots.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  LOCAL (Linux/macOS/WSL)                                │
│  ┌─────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │  ocr    │─▶│ ssh      │─▶│ Remote PowerShell via  │  │
│  │  CLI /  │  │ child    │  │ -EncodedCommand        │  │
│  │  Library│  └──────────┘  └───────────────────────┘  │
│  └────┬────┘             ┌──────────────────────────┐  │
│       │                  │ serve-API HTTP client     │  │
│       │                  └──────────────────────────┘  │
└───────┼────────────────────────────────────────────────┘
        │ SSH (key-based, BatchMode)
        ▼
┌─────────────────────────────────────────────────────────┐
│  REMOTE (Windows)                                       │
│  ┌──────────────────┐  ┌────────────────────────────┐   │
│  │ Scheduled Task   │  │ opencode serve API (:4310) │   │
│  │ (schtasks)       │  │ GET  /api/session          │   │
│  │ ┌──────────────┐ │  │ POST /api/session/{id}/... │   │
│  │ │ launcher.ps1 │ │  └────────────────────────────┘   │
│  │ │ • Copy spec  │ │  ┌────────────────────────────┐   │
│  │ │ • Run agent  │ │  │ Repo directory              │   │
│  │ │ • Append log │ │  │ ├── SPEC.md (uploaded)      │   │
│  │ └──────────────┘ │  │ ├── build-<task>.log        │   │
│  └──────────────────┘  │ └── source files             │   │
│                        └────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### How It Works

1. **Probe** — `ocr probe <host>` detects the remote environment (PowerShell, opencode, git).
2. **Upload** — Spec file and launcher script pushed via base64-over-stdin (no `scp`, no quoting issues).
3. **Detach** — A Windows scheduled task fires the launcher independently of the SSH session.
4. **Launch** — The launcher copies `SPEC.md` into the repo root (avoiding permission prompts),
   then runs `opencode run` with a single-line prompt under 250 chars.
5. **Monitor** — `ocr status` polls the build log, task state, and git status in one shot.

---

## Quick Start

```sh
npm install -g @ground-zero-llc/gz-remote

# 0. Sanity check: what's on the far machine?
ocr probe my-windows-box

# 1. Bring up the serve API (scheduled task "ocserve")
ocr serve my-windows-box up

# 2. Launch a spec-driven build job — survives disconnects
ocr launch my-windows-box 'F:\Projects\my-repo' ./SPEC.md --task-name build1

# 3. Check on it anytime
ocr status my-windows-box 'F:\Projects\my-repo' --task build1

# 4. List sessions / send follow-ups via the serve API
ocr sessions my-windows-box
ocr prompt ses_xxx followup.txt --url http://<host-ip>:4310
```

Requires Node.js >= 22. SSH key-based auth to the remote host must already work (BatchMode).

---

## Feature Highlights

### Zero Dependencies
Runtime has **zero npm dependencies**. Every argument builder is a pure function. No supply-chain surface.

### Base64 EncodedCommand Transport
PowerShell scripts travel via `powershell -EncodedCommand <base64>` (UTF-16LE). Eliminates all
quoting issues across the bash→ssh→cmd→PowerShell chain.

### Scheduled-Task Detachment
Jobs launch via `schtasks /create` + `/run`, surviving SSH disconnects. Wraps in `cmd /c` with
`-ExecutionPolicy Bypass`.

### 250-Char Prompt Ceiling
Large inline prompts hang headless turns. `ocr` sends a tiny prompt pointing to `SPEC.md` in
the repo root. Override with `--force`.

### Serve API Control Plane
`ocr serve up` starts opencode's HTTP API as a persistent scheduled task for multi-turn
orchestration.

---

## CLI Reference

```
ocr probe <host>
    Detect remote environment: PowerShell version, execution policy,
    opencode path, git path, OS caption.

ocr launch <host> <remoteRepoDir> <specFile> [--task-name n] [--model m] [--log name]
    Upload specFile, register a scheduled task that copies it into the repo
    dir as SPEC.md and runs opencode headlessly against it. Polls (max 90s)
    until BUILD START appears in the log.
    Defaults: model=opencode/x-preview-f-free  log=build-<task-name>.log

ocr status <host> <remoteRepoDir> [--task n] [--tail n]
    One-shot snapshot: scheduled-task state, last --tail log lines (default 6,
    truncated to 220 chars), git log --oneline -5, changed-file count.

ocr serve <host> [--port p] <up|down|status>
    Manage the opencode serve API as scheduled task "ocserve" (default port 4310).

ocr sessions <host> [--port p] [--json] [--url http://ip:port]
    List opencode sessions through the serve API (GET /api/session).

ocr prompt <sessionId> <textFile|-> [--url http://ip:port] [--force]
    POST {"prompt":{"text":...}} to /api/session/<id>/prompt. '-' reads
    stdin. Prompts over 250 chars refused unless --force.
```

Exit codes: `0` success · `1` operation failure · `2` usage/validation error.

---

## Library API

Every CLI capability is importable:

```ts
import { toEncodedCommand, encodedCommandInvocation } from "gz-remote";   // PS → base64
import { buildSshArgs, runSsh, runSshWithInput } from "gz-remote";       // hardened SSH
import { renderLauncher, renderUploadScript } from "gz-remote";          // launcher gen
import { createTaskCommand, parseTaskStatus } from "gz-remote";          // schtasks
import { listSessions, postPrompt } from "gz-remote";                    // serve API
import { deriveTaskName, sanitizeTaskName } from "gz-remote";            // task naming
import { UsageError, OperationError, DEFAULT_MODEL } from "gz-remote";   // types + defaults
```

---

## Windows Support

`ocr` is purpose-built for Windows remote hosts running OpenSSH + PowerShell:

- **Execution Policy** — `-ExecutionPolicy Bypass` so script policy never blocks.
- **Detached Execution** — Scheduled tasks instead of `Start-Process`, which dies silently over SSH.
- **Quoting** — UTF-16LE base64 `EncodedCommand` eliminates all quoting issues.
- **Spec Placement** — Copied into repo root as `SPEC.md`, avoiding permission prompts.
- **Log Appending** — All agent output captured in a build log inside the repo directory.

---

## Security

`ocr` executes commands on remote hosts over SSH and registers scheduled tasks there. It does
not manage credentials — set up key auth yourself. The serve API is typically unauthenticated;
keep it on a private network (Tailscale/WireGuard). Launch only specs you trust.

---

## Development

```sh
npm install        # devDependencies only; runtime has zero dependencies
npm run typecheck  # strict tsc
npm test           # node:test — 108 pure-construction cases, no network
npm run build      # emit dist/
npm run smoke      # dist/cli.js --help
```

Source: `src/types.ts`, `src/encoded.ts`, `src/ssh.ts`, `src/winprobe.ts`, `src/launcher.ts`,
`src/tasks.ts`, `src/serve.ts`, `src/cli.ts`. Tests construct commands and parse outputs
purely — no network, no `$HOME` access.

---

## Related Projects

| Project | What It Does |
|---------|-------------|
| [gz-sessions](https://github.com/oke3/gz-sessions) | Persistent cross-session memory for AI agents |
| [gz-codemap](https://github.com/oke3/gz-codemap) | Scan codebases → auto-generate project config |
| [gz-modelrouter](https://github.com/oke3/gz-modelrouter) | Intelligent LLM cost router — save 40-70% on bills |
| [gz-bench](https://github.com/oke3/gz-bench) | Standardized benchmark harness for AI coding agents |
| [gz-context-engine](https://github.com/oke3/gz-context-engine) | Production-grade RAG context engine |

---

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Enterprise Support

Need this customized for your infrastructure? We offer:

- **Integration consulting** — Wire gz-remote into your remote development setup
- **Custom configuration** — Task-specific rules, models, and workflows for your team
- **Managed deployment** — We host and maintain your instance
- **Training workshops** — Hands-on sessions for your engineering team

[Book a 30-min call](https://www.grndxero.com/brief) · [See pricing](https://www.grndxero.com/pricing)

---

MIT — Ground Zero LLC

---

Built by [Ground Zero LLC](https://github.com/oke3) — AI infrastructure for the agentic age.
