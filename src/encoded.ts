// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * PowerShell EncodedCommand transport: UTF-16LE bytes wrapped in base64.
 * This is how arbitrary multi-line scripts travel through `ssh <host> powershell ...`
 * without quoting hell.
 */

/** Encode a PowerShell script for `-EncodedCommand` (UTF-16LE base64). */
export function toEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Inverse of {@link toEncodedCommand}; used by tests and debugging. */
export function fromEncodedCommand(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le");
}

/** Wrap a PowerShell script in a ready-to-run `powershell -EncodedCommand ...` line. */
export function encodedCommandInvocation(script: string, exe = "powershell"): string {
  return `${exe} -NoProfile -NonInteractive -EncodedCommand ${toEncodedCommand(script)}`;
}
