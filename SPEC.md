# opencode-remote (`ocr`) — v0.1 Build Spec

Build a zero-dependency CLI + library for driving opencode instances on REMOTE machines over SSH.
It packages battle-tested patterns for distributed agent orchestration: detached Windows task
launches, PowerShell EncodedCommand transport, tiny-prompt/in-repo-spec job launches, and an
opencode serve-API control plane.

## Stack & rules

- TypeScript strict mode, ESM only, Node >= 22 (tests use native `node --test` with TS
  type-stripping; no transpile step for tests).
- **Zero runtime dependencies.** devDependencies limited to `typescript` + `@types/node`.
- All remote access via `ssh <host> ...` using `child_process` with flags:
  `-o BatchMode=yes -o StrictHostKeyChecking=no` plus a configurable timeout.
- No network calls in tests. Test ssh command/argument CONSTRUCTION purely (string assertions).
- Exit codes: 0 success, 1 operation failure, 2 usage/validation error.
- Precise errors everywhere: name the exact bad input and why.

## CLI

Binary name: `ocr` (bin -> dist/cli.js). Commands:

1. `ocr probe <host>`
   Detects remote environment. On Windows hosts runs PowerShell via EncodedCommand probe:
   PS version, execution policy, opencode path (Get-Command opencode), git path, uname-style OS
   caption. On failure prints a precise reason and exits 1.

2. `ocr launch <host> <remoteRepoDir> <specFile> [--task-name n] [--model m] [--log name]`
   The proven job recipe:
   - Validate: host non-empty, remoteRepoDir absolute-looking, specFile exists locally,
     model default `opencode/x-preview-f-free`, task-name sanitized `[A-Za-z0-9_-]{1,32}`.
   - Generate a launcher .ps1 implementing EXACTLY this sequence:
     a) `Copy-Item <spec>` into the repo dir as `SPEC.md -Force`
     b) `Set-Location <repoDir>`
     c) write `=== BUILD START <timestamp> ===` to log file (inside repo dir)
     d) run `& opencode.cmd run -m <model> 'Read SPEC.md in the repo root and execute it fully.
        Work only inside this repo. Commit locally at milestones as oke3
        <oke3@users.noreply.github.com>; do NOT push.'` appending all output (*>>) to the log
     e) append `=== EXITCODE=<n> <timestamp> ===`
   - Upload launcher via stdin redirect or temp file, then create + run a scheduled task:
     `schtasks /create /f /tn <task> /tr "cmd /c powershell -NoProfile -ExecutionPolicy Bypass
     -File <launcher> > <boot.log> 2>&1" /sc once /st 23:58` then `schtasks /run /tn <task>`.
   - Poll (max 90s) until the build log contains BUILD START; report success/failure precisely.

3. `ocr status <host> <remoteRepoDir> [--task n] [--tail n]`
   One-shot snapshot via a single EncodedCommand: scheduled task status, last `--tail` (default 6)
   log lines truncated to 220 chars each, `git log --oneline -5`, changed-file count
   (`git status -s | measure`). Human-readable plain text.

4. `ocr serve <host> [--port 4310] <up|down|status>`
   Manage the opencode serve API as scheduled task `ocserve`:
   - up: create/run task running `opencode.cmd serve --hostname 0.0.0.0 --port <p>`
   - status: task state + HTTP health probe of `http://127.0.0.1:<port>/api/project` is NOT
     possible remotely; instead verify task Running + port LISTENING via PowerShell
     `Get-NetTCPConnection -LocalPort <p> -State Listen`.

5. `ocr sessions <host> [--port 4310] [--json]`
   List opencode sessions through the serve API from the LOCAL machine:
   `GET http://<host-ip>:<port>/api/session` — but host here must be reachable; accept
   `--url http://ip:port` override. Print id/title/created table or JSON.

6. `ocr prompt <sessionId> <textFile|-> [--url ...] [--force]`
   POST `{"prompt":{"text":...}}` to `/api/session/<id>/prompt`. If text exceeds 250 chars and
   `--force` absent: refuse with explanation (large inline prompts hang headless turns — point
   the agent at an in-repo file instead). Reads stdin when arg is `-`.

## Library modules (src/)

- `types.ts` — shared types + defaults (ports, timeouts, model id).
- `encoded.ts` — `toEncodedCommand(script: string): string` (UTF-16LE base64) + tests.
- `ssh.ts` — `buildSshArgs(host, remoteCmd)` and `runSsh(host, cmd, {timeoutMs})` returning
  `{code, stdout, stderr}`; BatchMode flags always injected.
- `winprobe.ts` — environment probe script template + result parser.
- `launcher.ts` — `renderLauncher(opts): string` producing the .ps1 from step 2 (pure function,
  heavily unit-tested: escaping of paths with spaces, quoting of prompt, timestamp injection).
- `tasks.ts` — schtasks command builders (create/run/end/query/status parse) as pure functions +
  a parser for `schtasks /fo list` output.
- `serve.ts` — minimal fetch client: `listSessions(baseUrl)`, `postPrompt(baseUrl, id, text)`,
  both returning typed results, no deps (global fetch).
- `cli.ts` — argv wiring, usage text, exit codes.

## Tests (test/*.test.ts)

Target >= 40 test cases total. Cover: encoded.ts round-trips (ascii, unicode, newlines),
launcher rendering (path escaping incl. spaces, model override, prompt integrity),
tasks parsers (Running/Ready/missing), ssh arg construction (flags always present, no shell
injection through host names — reject hosts matching `[^A-Za-z0-9._-]`),
serve client against a stubbed fetch (inject fetch impl), CLI usage/validation errors exit 2.

## Quality gates (all must pass before commit)

```
npm run typecheck   # tsc --noEmit over src AND test configs
npm test            # node --test test/*.test.ts
npm run build       # tsc emit; then smoke-test: node dist/cli.js --help exits 0
```

Commit at milestones (feat: scaffold, feat: commands, test: suite, chore: metadata) authored as
`oke3 <oke3@users.noreply.github.com>`. Do NOT push. Do NOT add badges you cannot verify;
README may stay minimal — a separate docs pass happens after review.
