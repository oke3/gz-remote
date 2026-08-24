/**
 * Shared types + defaults for opencode-remote (`ocr`).
 * Zero runtime dependencies by contract.
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default opencode serve API port. */
export const DEFAULT_PORT = 4310;

/** Default model id used when `ocr launch --model` is not given. */
export const DEFAULT_MODEL = "opencode/x-preview-f-free";

/** Default wall-clock timeout for a single `ssh` invocation. */
export const DEFAULT_SSH_TIMEOUT_MS = 30_000;

/** How long `ocr launch` polls the build log for BUILD START before giving up. */
export const LAUNCH_POLL_TIMEOUT_MS = 90_000;

/** Poll interval while waiting for BUILD START. */
export const LAUNCH_POLL_INTERVAL_MS = 3_000;

/** Default number of log lines shown by `ocr status`. */
export const DEFAULT_TAIL_LINES = 6;

/** Each log line printed by `ocr status` is truncated to this many chars. */
export const LOG_LINE_TRUNCATE_CHARS = 220;

/** Inline prompts above this size are refused unless `--force` is passed. */
export const MAX_INLINE_PROMPT_CHARS = 250;

/** Scheduled-task name that owns the opencode serve API. */
export const SERVE_TASK_NAME = "ocserve";

/** `/st` start time used when registering one-shot scheduled tasks. */
export const TASK_START_TIME = "23:58";

/**
 * The proven job prompt sent to opencode on every `ocr launch`.
 */
export const DEFAULT_LAUNCH_PROMPT =
  "Read SPEC.md in the repo root and execute it fully. Work only inside this repo. " +
  "Commit locally at milestones as oke3 <oke3@users.noreply.github.com>; do NOT push.";

// ---------------------------------------------------------------------------
// Errors mapped to CLI exit codes
// ---------------------------------------------------------------------------

/** Usage / validation problem. CLI maps this to exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** An operation (ssh call, HTTP request, poll) failed. CLI maps this to exit code 1. */
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------

export interface SshResult {
  /** Process exit code; -1 when ssh could not be spawned or was killed. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunSshOptions {
  /** Wall-clock timeout in ms; also drives the ssh ConnectTimeout flag. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export interface ProbeResult {
  /** True when the OCR_PSVERSION marker was present (i.e. PowerShell answered). */
  windows: boolean;
  psVersion: string | null;
  executionPolicy: string | null;
  opencodePath: string | null;
  gitPath: string | null;
  osCaption: string | null;
}

// ---------------------------------------------------------------------------
// launcher
// ---------------------------------------------------------------------------

export interface LauncherOptions {
  /** Remote repo working directory (absolute-looking Windows path). */
  repoDir: string;
  /** Remote path the spec file was uploaded to; copied into repoDir as SPEC.md. */
  specRemotePath: string;
  /** Sanitized scheduled-task name; also feeds the default log file name. */
  taskName: string;
  /** Model override forwarded to `opencode.cmd run -m`. */
  model: string;
  /** Log file name inside repoDir. Default: `build-<taskName>.log`. */
  logFileName?: string;
  /** Prompt text. Default: {@link DEFAULT_LAUNCH_PROMPT}. */
  promptText?: string;
}

// ---------------------------------------------------------------------------
// schtasks
// ---------------------------------------------------------------------------

export interface CreateTaskOptions {
  taskName: string;
  /** Inner action executed under `cmd /c ...` when the task fires. */
  innerAction: string;
  /** `/st` value, default {@link TASK_START_TIME}. */
  startTime?: string;
}

// ---------------------------------------------------------------------------
// serve API
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string | null;
}

export interface PostPromptResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface ServeClientOptions {
  /** Injectable fetch implementation (tests stub this). */
  fetchImpl?: typeof fetch;
}
