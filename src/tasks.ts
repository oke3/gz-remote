/**
 * Pure schtasks command builders + a parser for `schtasks /fo LIST` output.
 * Everything here is string-in/string-out so it can be tested without ssh.
 *
 * Quoting model: the remote command runs under the Windows OpenSSH default
 * shell (cmd.exe). The `/tr` value is wrapped in double quotes; embedded double
 * quotes inside it are escaped as `\"` which CommandLineToArgvW keeps literal,
 * so paths with spaces survive both registration and execution. Redirects like
 * `> log 2>&1` are stored INSIDE the action and only interpreted when the task
 * fires under its own `cmd /c`.
 */

import { TASK_START_TIME, UsageError, type CreateTaskOptions } from "./types.ts";

/** Task names must match [A-Za-z0-9_-]{1,32}; throws UsageError naming input. */
export function sanitizeTaskName(input: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input)) {
    throw new UsageError(
      `invalid task name "${input}": must be 1-32 chars of A-Z a-z 0-9 _ - (pattern [A-Za-z0-9_-]{1,32})`,
    );
  }
  return input;
}

/** Escape a string that will sit inside the quoted `/tr "..."` value. */
export function escapeNestedQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

/**
 * Build `schtasks /create /f /tn <name> /tr "cmd /c <innerAction>" /sc once /st <time>`.
 */
export function createTaskCommand(options: CreateTaskOptions): string {
  const startTime = options.startTime ?? TASK_START_TIME;
  if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
    throw new UsageError(`invalid start time "${startTime}": expected HH:MM`);
  }
  const tr = `"cmd /c ${escapeNestedQuotes(options.innerAction)}"`;
  return `schtasks /create /f /tn ${options.taskName} /tr ${tr} /sc once /st ${startTime}`;
}

export function runTaskCommand(taskName: string): string {
  return `schtasks /run /tn ${taskName}`;
}

export function endTaskCommand(taskName: string): string {
  return `schtasks /end /tn ${taskName}`;
}

export function deleteTaskCommand(taskName: string): string {
  return `schtasks /delete /tn ${taskName} /f`;
}

export function queryTaskCommand(taskName: string): string {
  return `schtasks /query /tn ${taskName} /fo LIST`;
}

/**
 * Extract the `Status:` value from `schtasks /fo LIST` output.
 * Returns e.g. "Running" / "Ready", or null when no Status line exists
 * (task not registered, localized or error output).
 */
export function parseTaskStatus(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*Status\s*:\s*(.*?)\s*$/i.exec(line);
    if (m && m[1] !== undefined && m[1].length > 0) return m[1];
  }
  return null;
}
