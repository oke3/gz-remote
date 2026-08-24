/**
 * Minimal zero-dependency client for the opencode serve API (global fetch).
 * `listSessions` hits GET /api/session; `postPrompt` posts
 * {"prompt":{"text":...}} to /api/session/<id>/prompt.
 * The fetch implementation is injectable so tests never touch the network.
 */

import {
  OperationError,
  type PostPromptResult,
  type ServeClientOptions,
  type SessionInfo,
} from "./types.ts";

function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function sessionApiUrl(baseUrl: string): string {
  assertHttpUrl(baseUrl);
  return joinBase(baseUrl, "/api/session");
}

export function promptApiUrl(baseUrl: string, sessionId: string): string {
  assertHttpUrl(baseUrl);
  if (sessionId.length === 0) throw new OperationError("sessionId must not be empty");
  return joinBase(baseUrl, `/api/session/${encodeURIComponent(sessionId)}/prompt`);
}

function assertHttpUrl(baseUrl: string): void {
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new OperationError(`invalid base URL "${baseUrl}": must start with http:// or https://`);
  }
}

/**
 * Map one raw /api/session entry to SessionInfo, tolerating the shapes seen in
 * the wild: {id,title,time:{created}}, {id,title,createdAt}, numeric ids, and
 * missing titles. Entries without a usable id are skipped.
 */
export function mapSession(raw: unknown): SessionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = rec["id"];
  if (typeof id !== "string" && typeof id !== "number") return null;
  const time = typeof rec["time"] === "object" && rec["time"] !== null
    ? (rec["time"] as Record<string, unknown>)
    : undefined;
  let createdAt: string | null = null;
  for (const candidate of [time?.["created"], rec["createdAt"], rec["created"]]) {
    if (typeof candidate === "string") {
      createdAt = candidate;
      break;
    }
    if (typeof candidate === "number") {
      createdAt = String(candidate);
      break;
    }
  }
  const title = typeof rec["title"] === "string" ? rec["title"] : "";
  return { id: String(id), title, createdAt };
}

/** GET <base>/api/session -> SessionInfo[]. Throws OperationError on non-2xx/bad payload. */
export async function listSessions(baseUrl: string, options: ServeClientOptions = {}): Promise<SessionInfo[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = sessionApiUrl(baseUrl);
  const res = await doFetch(url, { method: "GET" });
  if (!res.ok) {
    throw new OperationError(`listSessions failed: HTTP ${res.status} from ${url}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new OperationError(`listSessions failed: expected a JSON array from ${url}`);
  }
  const sessions: SessionInfo[] = [];
  for (const item of data) {
    const mapped = mapSession(item);
    if (mapped !== null) sessions.push(mapped);
  }
  return sessions;
}

/**
 * POST {"prompt":{"text":...}} to /api/session/<id>/prompt.
 * Returns {ok,status,body}; never throws for HTTP error statuses — callers
 * decide (the CLI reports precisely and exits 1).
 */
export async function postPrompt(
  baseUrl: string,
  sessionId: string,
  text: string,
  options: ServeClientOptions = {},
): Promise<PostPromptResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = promptApiUrl(baseUrl, sessionId);
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text } }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}
