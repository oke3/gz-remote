#!/usr/bin/env node
/**
 * ocr — drive opencode instances on REMOTE machines over SSH.
 * Zero-dependency CLI: argv wiring, usage text, exit codes.
 * Exit codes: 0 success · 1 operation failure · 2 usage/validation error.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodedCommandInvocation } from "./encoded.ts";
import {
  defaultLogFileName,
  deriveTaskName,
  psSingleQuote,
  renderLauncher,
  renderPollScript,
  renderUploadScript,
} from "./launcher.ts";
import {
  listSessions,
  postPrompt,
} from "./serve.ts";
import { assertSshOk, runSsh, runSshWithInput, validateHost } from "./ssh.ts";
import {
  createTaskCommand,
  deleteTaskCommand,
  endTaskCommand,
  parseTaskStatus,
  queryTaskCommand,
  runTaskCommand,
  sanitizeTaskName,
} from "./tasks.ts";
import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TAIL_LINES,
  LAUNCH_POLL_INTERVAL_MS,
  LAUNCH_POLL_TIMEOUT_MS,
  LOG_LINE_TRUNCATE_CHARS,
  MAX_INLINE_PROMPT_CHARS,
  OperationError,
  SERVE_TASK_NAME,
  UsageError,
} from "./types.ts";
import { parseProbeOutput, renderProbeScript } from "./winprobe.ts";

// ---------------------------------------------------------------------------
// IO abstraction (tests inject collectors)
// ---------------------------------------------------------------------------

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Read all of stdin (used by `ocr prompt <id> -`). */
  stdin(): string;
}

export const nodeIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  stdin: () => readFileSync(0, "utf8"),
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const USAGE = `ocr — drive opencode instances on remote machines over SSH

Usage:
  ocr probe <host>
      Detect the remote environment: PowerShell version, execution policy,
      opencode path, git path, OS caption.

  ocr launch <host> <remoteRepoDir> <specFile> [--task-name n] [--model m] [--log name]
      Upload specFile, register a scheduled task that copies it into the repo
      dir as SPEC.md and runs opencode headlessly against it (all output
      appended to the build log inside the repo dir). Polls (max 90s) until
      BUILD START appears in the log.
      Defaults: model=${DEFAULT_MODEL} log=build-<task-name>.log

  ocr status <host> <remoteRepoDir> [--task n] [--tail n]
      One-shot snapshot: scheduled-task state, last --tail log lines (default
      ${DEFAULT_TAIL_LINES}, truncated to ${LOG_LINE_TRUNCATE_CHARS} chars), git log --oneline -5, changed-file count.

  ocr serve <host> [--port p] <up|down|status>
      Manage the opencode serve API as scheduled task "${SERVE_TASK_NAME}"
      (default port ${DEFAULT_PORT}). status reports task state + port LISTENING.

  ocr sessions <host> [--port p] [--json] [--url http://ip:port]
      List opencode sessions through the serve API (GET /api/session).

  ocr prompt <sessionId> <textFile|-> [--url http://ip:port] [--force]
      POST {"prompt":{"text":...}} to /api/session/<id>/prompt. '-' reads
      stdin. Prompts over ${MAX_INLINE_PROMPT_CHARS} chars are refused unless --force (large inline
      prompts hang headless turns — point the agent at an in-repo file instead).

Exit codes: 0 success, 1 operation failure, 2 usage/validation error.
`;

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set(["--task-name", "--model", "--log", "--task", "--tail", "--port", "--url"]);
const BOOL_FLAGS = new Set(["--json", "--force"]);

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) break;
    if (VALUE_FLAGS.has(token)) {
      const next = tokens[i + 1];
      if (next === undefined) {
        throw new UsageError(`flag ${token} requires a value`);
      }
      values.set(token, next);
      i++;
    } else if (BOOL_FLAGS.has(token)) {
      bools.add(token);
    } else if (token.startsWith("--")) {
      throw new UsageError(`unknown flag "${token}"`);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, values, bools };
}

function requirePositional(args: ParsedArgs, index: number, name: string, command: string): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new UsageError(`${command} requires <${name}> (missing: ${name})`);
  }
  return value;
}

function rejectExtraPositionals(args: ParsedArgs, command: string, count: number): void {
  if (args.positionals.length > count) {
    const extra = args.positionals.slice(count).join(" ");
    throw new UsageError(`${command} takes exactly ${count} positional argument(s), got extra: "${extra}"`);
  }
}

function parseIntFlag(value: string, flag: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`invalid ${flag} value "${value}": must be an integer between ${min} and ${max}`);
  }
  return n;
}

function parsePortFlag(args: ParsedArgs): number {
  const raw = args.values.get("--port") ?? String(DEFAULT_PORT);
  return parseIntFlag(raw, "--port", 1, 65535);
}

function assertBaseUrl(url: string): string {
  if (!/^https?:\/\//.test(url)) {
    throw new UsageError(`invalid --url value "${url}": must start with http:// or https://`);
  }
  return url;
}

function assertAbsoluteRemotePath(path: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)) {
    throw new UsageError(
      `remoteRepoDir "${path}" does not look absolute: need a drive letter (C:\\repo), UNC (\\\\server\\share) or leading /`,
    );
  }
}

function joinRemotePath(dir: string, leaf: string): string {
  return `${dir.replace(/[\\/]+$/, "")}\\${leaf}`;
}

function trimStderr(stderr: string): string {
  return stderr.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Upload text to a remote path via the base64-over-stdin channel; verify byte count. */
async function uploadTextFile(
  host: string,
  remotePath: string,
  content: string,
  what: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  const script = encodedCommandInvocation(renderUploadScript(remotePath));
  const result = await runSshWithInput(host, script, `${bytes.toString("base64")}\n`, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new OperationError(
      `uploading ${what} to "${remotePath}" on "${host}" failed: ssh exited ${result.code}` +
        (trimStderr(result.stderr) ? ` — ${trimStderr(result.stderr)}` : ""),
    );
  }
  const marker = `OCR_WROTE=${bytes.length}`;
  if (!result.stdout.includes(marker)) {
    throw new OperationError(
      `uploading ${what} to "${remotePath}" on "${host}" failed: expected marker ${marker}, got "${result.stdout.trim() || "(none)"}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdProbe(args: ParsedArgs, io: CliIo): Promise<number> {
  const host = requirePositional(args, 0, "host", "probe");
  rejectExtraPositionals(args, "probe", 1);
  validateHost(host);

  const result = await runSsh(host, encodedCommandInvocation(renderProbeScript()), { timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new OperationError(
      `probe failed on "${host}": ssh exited ${result.code}` +
        (trimStderr(result.stderr) ? ` — ${trimStderr(result.stderr)}` : ""),
    );
  }
  const probe = parseProbeOutput(result.stdout);
  if (!probe.windows) {
    throw new OperationError(
      `probe failed on "${host}": no OCR_PSVERSION marker in output — the remote did not answer as Windows PowerShell (is OpenSSH + PowerShell available there?)`,
    );
  }

  io.out(`host:              ${host}`);
  io.out(`os:                ${probe.osCaption ?? "(unknown)"}`);
  io.out(`powershell:        v${probe.psVersion ?? "?"}`);
  io.out(`execution policy:  ${probe.executionPolicy ?? "(unknown)"}`);
  io.out(
    probe.opencodePath !== null
      ? `opencode:          ${probe.opencodePath}`
      : "opencode:          NOT FOUND on PATH",
  );
  io.out(
    probe.gitPath !== null
      ? `git:               ${probe.gitPath}`
      : "git:               NOT FOUND on PATH",
  );
  return 0;
}

async function cmdLaunch(args: ParsedArgs, io: CliIo): Promise<number> {
  const host = requirePositional(args, 0, "host", "launch");
  const repoDir = requirePositional(args, 1, "remoteRepoDir", "launch");
  const specFile = requirePositional(args, 2, "specFile", "launch");
  rejectExtraPositionals(args, "launch", 3);
  validateHost(host);
  assertAbsoluteRemotePath(repoDir);
  if (!existsSync(specFile)) {
    throw new UsageError(`spec file not found: "${specFile}"`);
  }
  if (!statSync(specFile).isFile()) {
    throw new UsageError(`spec file is not a regular file: "${specFile}"`);
  }
  const taskNameRaw = args.values.get("--task-name") ?? deriveTaskName(repoDir);
  const taskName = sanitizeTaskName(taskNameRaw);
  const model = args.values.get("--model");
  if (model !== undefined && model.trim().length === 0) {
    throw new UsageError('invalid --model value "": model must not be empty');
  }
  const effectiveModel = model?.trim() ?? DEFAULT_MODEL;
  const logFileName = args.values.get("--log") ?? defaultLogFileName(taskName);

  // 1) discover remote temp dir
  const tempResult = await runSsh(host, "echo %TEMP%", { timeoutMs: 15_000 });
  assertSshOk(tempResult, host, "TEMP discovery (%TEMP%)");
  const tempDir = tempResult.stdout.trim().replaceAll('"', "").replace(/[\\/]+$/, "");
  if (tempDir.length === 0) {
    throw new OperationError(`could not determine %TEMP% on "${host}": output was empty`);
  }

  // 2) working dir + artifact paths
  const workDir = joinRemotePath(tempDir, `ocr-${taskName}`);
  const specRemotePath = joinRemotePath(workDir, "spec.md");
  const launcherRemotePath = joinRemotePath(workDir, "launcher.ps1");
  const bootLogPath = joinRemotePath(workDir, "boot.log");
  const logPath = joinRemotePath(repoDir, logFileName);

  // 3) mkdir workdir
  const mkdirScript = `New-Item -ItemType Directory -Force -Path ${psSingleQuote(workDir)} | Out-Null`;
  assertSshOk(await runSsh(host, encodedCommandInvocation(mkdirScript)), host, `mkdir ${workDir}`);

  // 4) upload spec (step a's source)
  const specBytes = readFileSync(specFile);
  await uploadTextFile(host, specRemotePath, specBytes.toString("utf8"), "spec file");

  // 5) render + upload launcher (steps a-e)
  const launcherText = renderLauncher({
    repoDir,
    specRemotePath,
    taskName,
    model: effectiveModel,
    logFileName,
  });
  await uploadTextFile(host, launcherRemotePath, launcherText, "launcher script");

  // 6) create scheduled task
  const innerAction =
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${launcherRemotePath}" > "${bootLogPath}" 2>&1`;
  assertSshOk(
    await runSsh(host, createTaskCommand({ taskName, innerAction })),
    host,
    `schtasks /create (${taskName})`,
  );

  // 7) fire it detached
  assertSshOk(await runSsh(host, runTaskCommand(taskName)), host, `schtasks /run (${taskName})`);

  // 8) poll for BUILD START
  io.out(
    `task "${taskName}" fired on ${host}; polling ${logPath} for BUILD START (max ${Math.round(LAUNCH_POLL_TIMEOUT_MS / 1000)}s)...`,
  );
  const deadline = Date.now() + LAUNCH_POLL_TIMEOUT_MS;
  for (;;) {
    await sleep(LAUNCH_POLL_INTERVAL_MS);
    const poll = await runSsh(host, encodedCommandInvocation(renderPollScript(logPath)), { timeoutMs: 15_000 });
    if (poll.code === 0 && poll.stdout.includes("OCR_POLL=True")) break;
    if (Date.now() >= deadline) {
      throw new OperationError(
        `timed out after ${Math.round(LAUNCH_POLL_TIMEOUT_MS / 1000)}s waiting for BUILD START in "${logPath}" on "${host}". ` +
          `Inspect boot log "${bootLogPath}" and run: schtasks /query /tn ${taskName} /fo LIST /v`,
      );
    }
  }
  io.out(`BUILD START detected in ${logPath}.`);
  io.out(`Follow up with: ocr status ${host} ${repoDir} --task ${taskName}`);
  return 0;
}

async function cmdStatus(args: ParsedArgs, io: CliIo): Promise<number> {
  const host = requirePositional(args, 0, "host", "status");
  const repoDir = requirePositional(args, 1, "remoteRepoDir", "status");
  rejectExtraPositionals(args, "status", 2);
  validateHost(host);
  const tailRaw = args.values.get("--tail") ?? String(DEFAULT_TAIL_LINES);
  const tail = parseIntFlag(tailRaw, "--tail", 1, Number.MAX_SAFE_INTEGER);
  const taskName = sanitizeTaskName(args.values.get("--task") ?? deriveTaskName(repoDir));
  const logPath = joinRemotePath(repoDir, defaultLogFileName(taskName));

  const script = [
    "$ErrorActionPreference = 'Continue'",
    "Write-Output 'OCR_SECTION=TASK'",
    `schtasks /query /tn ${taskName} /fo LIST | Select-String -Pattern 'Status'`,
    "Write-Output 'OCR_SECTION=LOG'",
    `Get-Content -LiteralPath ${psSingleQuote(logPath)} -Tail ${tail} | ForEach-Object { $t = [string]$_; if ($t.Length -gt ${LOG_LINE_TRUNCATE_CHARS}) { $t.Substring(0, ${LOG_LINE_TRUNCATE_CHARS}) } else { $t } }`,
    "Write-Output 'OCR_SECTION=GIT'",
    `git -C ${psSingleQuote(repoDir)} --no-pager log --oneline -5`,
    "Write-Output 'OCR_SECTION=CHANGES'",
    `$ocrChanges = @(git -C ${psSingleQuote(repoDir)} status -s).Count`,
    'Write-Output ("OCR_CHANGED=" + $ocrChanges)',
  ].join("\r\n");

  const result = await runSsh(host, encodedCommandInvocation(script));
  if (result.code !== 0) {
    throw new OperationError(
      `status failed on "${host}": ssh exited ${result.code}` +
        (trimStderr(result.stderr) ? ` — ${trimStderr(result.stderr)}` : ""),
    );
  }

  const sections = new Map<string, string[]>([
    ["TASK", []],
    ["LOG", []],
    ["GIT", []],
    ["CHANGES", []],
  ]);
  let current: string | null = null;
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const section = /^OCR_SECTION=(\w+)$/.exec(rawLine.trim());
    if (section && section[1] !== undefined) {
      current = section[1];
      continue;
    }
    if (current !== null && sections.has(current)) {
      sections.get(current)?.push(rawLine);
    }
  }
  const changedMatch = /OCR_CHANGED=(\d+)/.exec(sections.get("CHANGES")?.join("\n") ?? "");
  const taskState = parseTaskStatus(sections.get("TASK")?.join("\n") ?? "");

  io.out(`== task ${taskName} ==`);
  io.out(`state: ${taskState ?? "(no Status line — task likely not registered)"}`);
  io.out("");
  io.out(`== last ${tail} log line(s) of ${logPath} (max ${LOG_LINE_TRUNCATE_CHARS} chars each) ==`);
  for (const line of sections.get("LOG") ?? []) io.out(line);
  io.out("");
  io.out("== git log --oneline -5 ==");
  for (const line of sections.get("GIT") ?? []) io.out(line);
  io.out("");
  io.out(`== changed files ==`);
  io.out(`count: ${changedMatch?.[1] ?? "(unknown)"}`);
  return 0;
}

async function cmdServe(args: ParsedArgs, io: CliIo): Promise<number> {
  const host = requirePositional(args, 0, "host", "serve");
  const action = requirePositional(args, 1, "<up|down|status>", "serve");
  rejectExtraPositionals(args, "serve", 2);
  validateHost(host);
  if (action !== "up" && action !== "down" && action !== "status") {
    throw new UsageError(`invalid serve action "${action}": expected up, down or status`);
  }
  const port = parsePortFlag(args);

  if (action === "up") {
    const innerAction = `opencode.cmd serve --hostname 0.0.0.0 --port ${port}`;
    assertSshOk(
      await runSsh(host, createTaskCommand({ taskName: SERVE_TASK_NAME, innerAction })),
      host,
      `schtasks /create (${SERVE_TASK_NAME})`,
    );
    assertSshOk(
      await runSsh(host, runTaskCommand(SERVE_TASK_NAME)),
      host,
      `schtasks /run (${SERVE_TASK_NAME})`,
    );
    io.out(`task "${SERVE_TASK_NAME}" created and started on ${host}: opencode.cmd serve --hostname 0.0.0.0 --port ${port}`);
    io.out(`Check with: ocr serve ${host} --port ${port} status`);
    return 0;
  }

  if (action === "down") {
    const endResult = await runSsh(host, endTaskCommand(SERVE_TASK_NAME));
    const deleteResult = await runSsh(host, deleteTaskCommand(SERVE_TASK_NAME));
    if (deleteResult.code !== 0 && endResult.code !== 0) {
      throw new OperationError(
        `stopping task "${SERVE_TASK_NAME}" on "${host}" failed: /end exited ${endResult.code}` +
          (trimStderr(endResult.stderr) ? ` (${trimStderr(endResult.stderr)})` : "") +
          `, /delete exited ${deleteResult.code}` +
          (trimStderr(deleteResult.stderr) ? ` (${trimStderr(deleteResult.stderr)})` : ""),
      );
    }
    io.out(`task "${SERVE_TASK_NAME}" stopped${deleteResult.code === 0 ? " and deleted" : ""} on ${host}.`);
    return 0;
  }

  // status
  const query = await runSsh(host, queryTaskCommand(SERVE_TASK_NAME));
  const taskState = query.code === 0 ? parseTaskStatus(query.stdout) : null;
  const listenScript =
    `$ocrListen = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
    "Write-Output ('OCR_LISTEN=' + ($null -ne $ocrListen))";
  const listen = await runSsh(host, encodedCommandInvocation(listenScript));
  const listening = listen.code === 0 && listen.stdout.includes("OCR_LISTEN=True");

  io.out(`host:            ${host}`);
  io.out(
    `task ${SERVE_TASK_NAME}:   ${taskState ?? `(not registered — schtasks exited ${query.code})`}`,
  );
  io.out(`port ${port}:          ${listening ? "LISTENING" : "NOT listening"}`);
  if (listen.code !== 0) {
    io.out(`(listen check failed: ssh exited ${listen.code}${trimStderr(listen.stderr) ? ` — ${trimStderr(listen.stderr)}` : ""})`);
  }
  io.out(
    taskState === "Running" && listening
      ? "verdict:         RUNNING"
      : "verdict:         NOT fully running",
  );
  return 0;
}

async function cmdSessions(args: ParsedArgs, io: CliIo): Promise<number> {
  const host = requirePositional(args, 0, "host", "sessions");
  rejectExtraPositionals(args, "sessions", 1);
  validateHost(host);
  const port = parsePortFlag(args);
  const urlOverride = args.values.get("--url");
  const baseUrl = urlOverride !== undefined ? assertBaseUrl(urlOverride) : `http://${host}:${port}`;

  let sessions;
  try {
    sessions = await listSessions(baseUrl);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (err instanceof OperationError) throw err;
    throw new OperationError(
      `listing sessions from ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (args.bools.has("--json")) {
    io.out(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    io.out("(no sessions)");
    return 0;
  }
  const idWidth = Math.max("ID".length, ...sessions.map((s) => s.id.length));
  const titleWidth = Math.max("TITLE".length, ...sessions.map((s) => s.title.length));
  const row = (id: string, title: string, created: string): string =>
    `${id.padEnd(idWidth)}  ${title.padEnd(titleWidth)}  ${created}`;
  io.out(row("ID", "TITLE", "CREATED"));
  for (const s of sessions) {
    const created = (s.createdAt ?? "").replace("T", " ").slice(0, 19);
    io.out(row(s.id, s.title, created));
  }
  return 0;
}

async function cmdPrompt(args: ParsedArgs, io: CliIo): Promise<number> {
  const sessionId = requirePositional(args, 0, "sessionId", "prompt");
  const fileArg = requirePositional(args, 1, "textFile|-", "prompt");
  rejectExtraPositionals(args, "prompt", 2);
  if (sessionId.trim().length === 0) {
    throw new UsageError('prompt requires a non-empty <sessionId>, got ""');
  }
  const urlOverride = args.values.get("--url");
  const baseUrl = urlOverride !== undefined ? assertBaseUrl(urlOverride) : `http://127.0.0.1:${DEFAULT_PORT}`;

  let text: string;
  if (fileArg === "-") {
    let raw: string;
    try {
      raw = io.stdin();
    } catch (err) {
      throw new OperationError(`failed reading prompt text from stdin: ${err instanceof Error ? err.message : String(err)}`);
    }
    text = raw.replace(/\r?\n$/, "");
  } else {
    if (!existsSync(fileArg)) {
      throw new UsageError(`prompt text file not found: "${fileArg}"`);
    }
    if (!statSync(fileArg).isFile()) {
      throw new UsageError(`prompt text path is not a regular file: "${fileArg}"`);
    }
    text = readFileSync(fileArg, "utf8").replace(/\r?\n$/, "");
  }

  const charCount = [...text].length;
  if (charCount > MAX_INLINE_PROMPT_CHARS && !args.bools.has("--force")) {
    throw new UsageError(
      `inline prompt is ${charCount} chars (limit ${MAX_INLINE_PROMPT_CHARS}): large inline prompts hang headless turns. ` +
        "Write the prompt into a file inside the repo and point the agent at it instead, or pass --force to send anyway.",
    );
  }

  let result;
  try {
    result = await postPrompt(baseUrl, sessionId, text);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new OperationError(
      `posting prompt to ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!result.ok) {
    const bodyText = result.body === null ? "" : ` — body: ${JSON.stringify(result.body).slice(0, 300)}`;
    io.err(`ocr: prompt POST failed: HTTP ${result.status}${bodyText}\n`);
    return 1;
  }
  io.out(`posted ${charCount} chars to session ${sessionId} (HTTP ${result.status})`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run the CLI against argv (without argv[0]/argv[1]); returns the exit code. */
export async function runCli(argv: string[], io: CliIo = nodeIo): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.out(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case "probe":
        return await cmdProbe(parseArgs(argv.slice(1)), io);
      case "launch":
        return await cmdLaunch(parseArgs(argv.slice(1)), io);
      case "status":
        return await cmdStatus(parseArgs(argv.slice(1)), io);
      case "serve":
        return await cmdServe(parseArgs(argv.slice(1)), io);
      case "sessions":
        return await cmdSessions(parseArgs(argv.slice(1)), io);
      case "prompt":
        return await cmdPrompt(parseArgs(argv.slice(1)), io);
      default: {
        io.err(`ocr: unknown command "${command}"\n\n${USAGE}`);
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`ocr: ${err.message}\n`);
      return 2;
    }
    if (err instanceof OperationError) {
      io.err(`ocr: ${err.message}\n`);
      return 1;
    }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    io.err(`ocr: unexpected error: ${detail}\n`);
    return 1;
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
