// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * The proven job recipe as data: `renderLauncher` is a pure function producing
 * the remote .ps1 that:
 *   a) Copy-Item <spec> into the repo dir as SPEC.md -Force
 *   b) Set-Location <repoDir>
 *   c) writes "=== BUILD START <timestamp> ===" to the log file (inside repo dir)
 *   d) runs `& opencode.cmd run -m <model> '<prompt>'` appending ALL output (*>>) to the log
 *   e) appends "=== EXITCODE=<n> <timestamp> ==="
 *
 * Also hosts the base64 upload-channel helpers used to push spec/launcher
 * content to the remote host over ssh stdin.
 */

import {
  DEFAULT_LAUNCH_PROMPT,
  UsageError,
  type LauncherOptions,
} from "./types.ts";
import { sanitizeTaskName } from "./tasks.ts";

/** Single-quote a PowerShell string literal ('' escapes an embedded '). */
export function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function defaultLogFileName(taskName: string): string {
  return `build-${taskName}.log`;
}

/**
 * Derive a sanitized scheduled-task name from a remote repo dir
 * (basename -> [A-Za-z0-9_-] only, max 32 chars). Never throws.
 */
export function deriveTaskName(remoteRepoDir: string): string {
  const base = remoteRepoDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "-");
  const collapsed = cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return collapsed.length > 0 ? collapsed : "ocr-job";
}

/**
 * Render the launcher .ps1 implementing steps (a)-(e) exactly.
 */
export function renderLauncher(options: LauncherOptions): string {
  const repoDir = options.repoDir;
  const specPath = options.specRemotePath;
  if (repoDir.length === 0) throw new UsageError('renderLauncher: repoDir must not be empty');
  if (specPath.length === 0) throw new UsageError('renderLauncher: specRemotePath must not be empty');
  if (options.model.length === 0) throw new UsageError('renderLauncher: model must not be empty');
  const taskName = sanitizeTaskName(options.taskName);

  const logFileName = options.logFileName !== undefined && options.logFileName.trim().length > 0
    ? options.logFileName.trim()
    : defaultLogFileName(taskName);
  const prompt = options.promptText ?? DEFAULT_LAUNCH_PROMPT;

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$repo = ${psSingleQuote(repoDir)}`,
    `$spec = ${psSingleQuote(specPath)}`,
    `$log  = Join-Path $repo ${psSingleQuote(logFileName)}`,
    // a) spec lands at the repo root as SPEC.md
    "Copy-Item -LiteralPath $spec -Destination (Join-Path $repo 'SPEC.md') -Force",
    // b)
    "Set-Location -LiteralPath $repo",
    // c)
    "$stamp = { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }",
    "Add-Content -LiteralPath $log -Value (\"=== BUILD START \" + (& $stamp) + \" ===\")",
    // d) all streams (*>>) appended to the log
    `& opencode.cmd run -m ${psSingleQuote(options.model)} ${psSingleQuote(prompt)} *>> $log`,
    "$ocrExit = $LASTEXITCODE",
    // e)
    "Add-Content -LiteralPath $log -Value (\"=== EXITCODE=$ocrExit \" + (& $stamp) + \" ===\")",
    "exit $ocrExit",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * Render the PowerShell receiver for the stdin upload channel: reads one line
 * of base64 from stdin and writes the decoded bytes to <remotePath>.
 */
export function renderUploadScript(remotePath: string): string {
  if (remotePath.length === 0) throw new UsageError('renderUploadScript: remotePath must not be empty');
  return [
    "$ocrLine = [Console]::In.ReadToEnd().Trim()",
    "$ocrBytes = [Convert]::FromBase64String($ocrLine)",
    `[IO.File]::WriteAllBytes(${psSingleQuote(remotePath)}, $ocrBytes)`,
    "Write-Output ('OCR_WROTE=' + $ocrBytes.Length)",
  ].join("\r\n");
}

/**
 * Render a PowerShell one-liner that reports whether the build log already
 * contains BUILD START (OCR_POLL=True/False).
 */
export function renderPollScript(logPath: string): string {
  const hit = `(Select-String -LiteralPath ${psSingleQuote(logPath)} -Pattern 'BUILD START' -Quiet) -eq $true`;
  return `Write-Output ('OCR_POLL=' + (${hit}))`;
}
