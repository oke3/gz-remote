// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * All remote access goes through `ssh <host> <remoteCmd>` using child_process.
 * BatchMode + StrictHostKeyChecking are ALWAYS injected; a configurable timeout
 * drives both the process kill timer and the ssh ConnectTimeout flag.
 *
 * Hosts are validated against /^[A-Za-z0-9._-]+$/ so no metacharacter can ever
 * reach a shell (we never spawn through one anyway, but defense in depth).
 */

import { spawn } from "node:child_process";
import {
  DEFAULT_SSH_TIMEOUT_MS,
  OperationError,
  UsageError,
  type RunSshOptions,
  type SshResult,
} from "./types.ts";

const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Validate and return the host; throws UsageError naming the exact bad input. */
export function validateHost(host: string): string {
  if (host.length === 0) {
    throw new UsageError("host must not be empty");
  }
  if (!HOST_PATTERN.test(host)) {
    throw new UsageError(
      `invalid ssh host "${host}": hosts may only contain A-Z a-z 0-9 . _ - (pattern [^A-Za-z0-9._-] is rejected)`,
    );
  }
  return host;
}

export function baseSshFlags(): string[] {
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no"];
}

/**
 * Build the full argv for spawning ssh: flags, host, then the remote command
 * as ONE argv element (never re-parsed by a local shell).
 */
export function buildSshArgs(host: string, remoteCmd: string, options: RunSshOptions = {}): string[] {
  validateHost(host);
  const timeoutMs = resolveTimeout(options);
  const connectTimeoutS = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    ...baseSshFlags(),
    "-o",
    `ConnectTimeout=${connectTimeoutS}`,
    host,
    remoteCmd,
  ];
}

function resolveTimeout(options: RunSshOptions): number {
  const t = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  if (!Number.isFinite(t) || t <= 0) {
    throw new UsageError(`invalid timeoutMs ${String(t)}: must be a positive finite number`);
  }
  return t;
}

async function runSshProcess(
  host: string,
  remoteCmd: string,
  options: RunSshOptions,
  stdinPayload?: string,
): Promise<SshResult> {
  const args = buildSshArgs(host, remoteCmd, options);
  const timeoutMs = resolveTimeout(options);
  return await new Promise<SshResult>((resolve) => {
    const child = spawn("ssh", args, {
      stdio: stdinPayload === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (stdinPayload !== undefined) {
      child.stdin?.end(stdinPayload);
    }
    child.on("error", (err: Error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${stderr ? "\n" : ""}ssh spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run an ssh command and always resolve with {code, stdout, stderr}. */
export async function runSsh(host: string, remoteCmd: string, options: RunSshOptions = {}): Promise<SshResult> {
  return await runSshProcess(host, remoteCmd, options);
}

/**
 * Run an ssh command with a payload piped to the remote stdin ("stdin redirect"
 * upload channel). The payload should be small-ish (a single base64 line).
 */
export async function runSshWithInput(
  host: string,
  remoteCmd: string,
  stdinPayload: string,
  options: RunSshOptions = {},
): Promise<SshResult> {
  return await runSshProcess(host, remoteCmd, options, stdinPayload);
}

/**
 * Assert a successful ssh round trip or throw an OperationError that names the
 * host, the intent, the exit code and stderr.
 */
export function assertSshOk(result: SshResult, host: string, what: string): SshResult {
  if (result.code !== 0) {
    throw new OperationError(
      `${what} failed on host "${host}": ssh exited ${result.code}` +
        (result.stderr.trim() ? ` — ${result.stderr.trim()}` : ""),
    );
  }
  return result;
}
