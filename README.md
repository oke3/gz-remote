# opencode-remote (`ocr`)

Drive opencode instances on REMOTE machines over SSH: detached Windows task launches,
PowerShell EncodedCommand transport, tiny-prompt/in-repo-spec job launches, and an
opencode serve-API control plane.

Zero runtime dependencies. TypeScript strict, ESM only, Node >= 22.

## Install / build

```
npm install
npm run build        # emit dist/ (bin: dist/cli.js)
```

## CLI

```
ocr probe <host>
ocr launch <host> <remoteRepoDir> <specFile> [--task-name n] [--model m] [--log name]
ocr status <host> <remoteRepoDir> [--task n] [--tail n]
ocr serve <host> [--port 4310] <up|down|status>
ocr sessions <host> [--port 4310] [--json] [--url http://ip:port]
ocr prompt <sessionId> <textFile|-> [--url http://ip:port] [--force]
```

Exit codes: `0` success, `1` operation failure, `2` usage/validation error.

## Development

```
npm run typecheck    # tsc --noEmit over src + test
npm test             # node --test test/*.test.ts (native TS type-stripping)
npm run build && npm run smoke   # tsc emit; node dist/cli.js --help
```

Tests never touch the network or ssh: all remote commands are tested as constructed
strings/argv. The serve client is exercised through an injected fetch stub.
