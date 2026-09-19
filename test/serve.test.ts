// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listSessions, mapSession, postPrompt, promptApiUrl, sessionApiUrl } from "../src/serve.ts";
import { OperationError } from "../src/types.ts";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

interface FetchStub {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

function stubFetch(response: { ok?: boolean; status?: number; json?: unknown; jsonThrows?: boolean }): FetchStub {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => {
        if (response.jsonThrows === true) throw new Error("not json");
        return response.json;
      },
    } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("serve.ts listSessions", () => {
  it("GETs <base>/api/session trimming a trailing slash on the base URL", async () => {
    const stub = stubFetch({ json: [] });
    await listSessions("http://10.0.0.5:4310/", { fetchImpl: stub.fetchImpl });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.url, "http://10.0.0.5:4310/api/session");
    assert.equal(stub.calls[0]?.init?.method, "GET");
  });

  it("leaves base URLs without trailing slash unchanged", async () => {
    const stub = stubFetch({ json: [] });
    await listSessions("http://h:4310", { fetchImpl: stub.fetchImpl });
    assert.equal(stub.calls[0]?.url, "http://h:4310/api/session");
  });

  it("maps id/title/createdAt from time.created payloads", async () => {
    const stub = stubFetch({
      json: [{ id: "ses_1", title: "Fix bug", time: { created: "2026-08-24T09:30:00Z" } }],
    });
    const sessions = await listSessions("http://h:4310", { fetchImpl: stub.fetchImpl });
    assert.deepEqual(sessions, [{ id: "ses_1", title: "Fix bug", createdAt: "2026-08-24T09:30:00Z" }]);
  });

  it("tolerates alternative shapes: numeric ids, createdAt/created fallbacks, no title", async () => {
    const sessions = [
      { id: 42, title: "n", createdAt: "c1" },
      { id: "ses_2", created: "c2" },
      { id: "ses_3" },
    ].map((raw) => mapSession(raw));
    assert.deepEqual(sessions[0], { id: "42", title: "n", createdAt: "c1" });
    assert.deepEqual(sessions[1], { id: "ses_2", title: "", createdAt: "c2" });
    assert.deepEqual(sessions[2], { id: "ses_3", title: "", createdAt: null });
  });

  it("skips entries without a usable id", async () => {
    const stub = stubFetch({ json: [{ title: "no id" }, { id: "keep" }] });
    const sessions = await listSessions("http://h:4310", { fetchImpl: stub.fetchImpl });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "keep");
  });

  it("passes through an empty array", async () => {
    const stub = stubFetch({ json: [] });
    assert.deepEqual(await listSessions("http://h:4310", { fetchImpl: stub.fetchImpl }), []);
  });

  it("throws OperationError naming the HTTP status for non-2xx responses", async () => {
    const stub = stubFetch({ ok: false, status: 500, json: {} });
    await assert.rejects(
      listSessions("http://h:4310", { fetchImpl: stub.fetchImpl }),
      (err: unknown) => err instanceof OperationError && /HTTP 500/.test((err as Error).message),
    );
  });

  it("throws OperationError when payload is not a JSON array", async () => {
    const stub = stubFetch({ json: { oops: true } });
    await assert.rejects(listSessions("http://h:4310", { fetchImpl: stub.fetchImpl }), OperationError);
  });

  it("sessionApiUrl rejects non-http bases", () => {
    assert.throws(() => sessionApiUrl("ftp://h:4310"), OperationError);
    assert.throws(() => sessionApiUrl("h:4310"), OperationError);
  });
});

describe("serve.ts postPrompt", () => {
  it("POSTs exact JSON body with content-type to /api/session/<id>/prompt", async () => {
    const stub = stubFetch({ json: { ok: true } });
    await postPrompt("http://127.0.0.1:4310/", "ses_9", "abc", { fetchImpl: stub.fetchImpl });
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call?.url, "http://127.0.0.1:4310/api/session/ses_9/prompt");
    assert.equal(call?.init?.method, "POST");
    const headers = call?.init?.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(call?.init?.body, JSON.stringify({ prompt: { text: "abc" } }));
  });

  it("returns ok/status/body parsed from JSON on success", async () => {
    const stub = stubFetch({ json: { assistant: "hi" } });
    const result = await postPrompt("http://h:4310", "s1", "hello", { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, { ok: true, status: 200, body: { assistant: "hi" } });
  });

  it("does NOT throw on HTTP error statuses — returns ok:false with status + body", async () => {
    const stub = stubFetch({ ok: false, status: 503, json: { error: "busy" } });
    const result = await postPrompt("http://h:4310", "s1", "hello", { fetchImpl: stub.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "busy" });
  });

  it("survives non-JSON bodies (body becomes null)", async () => {
    const stub = stubFetch({ jsonThrows: true });
    const result = await postPrompt("http://h:4310", "s1", "hello", { fetchImpl: stub.fetchImpl });
    assert.equal(result.body, null);
  });

  it("percent-encodes session ids containing special characters", async () => {
    assert.equal(promptApiUrl("http://h:4310", "a/b c"), "http://h:4310/api/session/a%2Fb%20c/prompt");
  });

  it("rejects empty session ids", () => {
    assert.throws(() => promptApiUrl("http://h:4310", ""), OperationError);
  });
});
