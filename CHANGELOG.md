# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-24

### Added

- `ocr probe <host>` — remote environment detection via PowerShell EncodedCommand.
- `ocr launch <host> <repoDir> <specFile>` — detached spec-driven opencode jobs via Windows
  scheduled tasks; spec copied in-repo as SPEC.md; tiny single-line prompt; BUILD START poll.
- `ocr status <host> <repoDir>` — one-shot snapshot: task state, log tail, git log, dirty count.
- `ocr serve <host> up|down|status` — serve-API lifecycle as scheduled task + port LISTEN check.
- `ocr sessions <host>` / `ocr prompt <id> <file|->` — serve-API listing and prompting with a
  250-char safety ceiling on inline prompts (`--force` overrides).
- Library primitives: `toEncodedCommand`, `buildSshArgs`/`runSsh`, `renderLauncher`,
  schtasks builders + status parser, serve client with injectable fetch.
- 108-case pure-construction test suite (no network, no filesystem side effects).
- Strict validation of schtasks `/st` times (e.g. rejects `25:99`).
