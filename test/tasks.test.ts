import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTaskCommand,
  deleteTaskCommand,
  endTaskCommand,
  escapeNestedQuotes,
  parseTaskStatus,
  queryTaskCommand,
  runTaskCommand,
  sanitizeTaskName,
} from "../src/tasks.ts";
import { UsageError } from "../src/types.ts";

describe("tasks.ts name sanitization", () => {
  it("accepts names matching [A-Za-z0-9_-]{1,32}", () => {
    assert.equal(sanitizeTaskName("a-b_C9"), "a-b_C9");
    assert.equal(sanitizeTaskName("x"), "x");
    assert.equal(sanitizeTaskName("_".repeat(32)), "_".repeat(32));
  });

  it("rejects the empty name", () => {
    assert.throws(() => sanitizeTaskName(""), UsageError);
    assert.throws(() => sanitizeTaskName(""), /""/);
  });

  it("rejects names over 32 chars", () => {
    assert.throws(() => sanitizeTaskName("y".repeat(33)), UsageError);
    assert.throws(() => sanitizeTaskName("y".repeat(33)), /1-32/);
  });

  it("rejects names with spaces or shell metacharacters, naming the input", () => {
    const bad = "oc serve!";
    assert.throws(() => sanitizeTaskName(bad), (err: unknown) =>
      err instanceof UsageError && err.message.includes(bad),
    );
    assert.throws(() => sanitizeTaskName("a;b"), UsageError);
    assert.throws(() => sanitizeTaskName("task/name"), UsageError);
  });
});

describe("tasks.ts command builders", () => {
  const innerAction =
    'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\temp dir\\launcher.ps1" > "C:\\temp dir\\boot.log" 2>&1';

  it("createTaskCommand produces the proven one-shot registration", () => {
    const cmd = createTaskCommand({ taskName: "t1", innerAction });
    assert.ok(cmd.startsWith("schtasks /create /f /tn t1 "));
    assert.ok(cmd.includes("/sc once /st 23:58"));
    assert.ok(cmd.endsWith("/st 23:58"));
  });

  it("wraps the action in cmd /c inside the quoted /tr value", () => {
    const cmd = createTaskCommand({ taskName: "t1", innerAction });
    assert.ok(cmd.includes('/tr "cmd /c powershell'));
  });

  it("keeps nested double quotes escaped as backslash-quote", () => {
    const cmd = createTaskCommand({ taskName: "t1", innerAction });
    assert.ok(cmd.includes('\\"C:\\temp dir\\launcher.ps1\\"'));
  });

  it("preserves redirection characters inside the stored action", () => {
    const cmd = createTaskCommand({ taskName: "t1", innerAction });
    assert.ok(cmd.includes("> \\")); // '> "C:\...' survived
    assert.ok(cmd.includes("2>&1"));
  });

  it("honors a custom /st start time and rejects malformed ones", () => {
    const cmd = createTaskCommand({ taskName: "t1", innerAction, startTime: "02:15" });
    assert.ok(cmd.includes("/st 02:15"));
    assert.throws(
      () => createTaskCommand({ taskName: "t1", innerAction, startTime: "25:99" }),
      UsageError,
    );
  });

  it("run/end/delete/query builders are exact", () => {
    assert.equal(runTaskCommand("t1"), "schtasks /run /tn t1");
    assert.equal(endTaskCommand("t1"), "schtasks /end /tn t1");
    assert.equal(deleteTaskCommand("t1"), "schtasks /delete /tn t1 /f");
    assert.equal(queryTaskCommand("t1"), "schtasks /query /tn t1 /fo LIST");
  });

  it("escapeNestedQuotes only touches double quotes", () => {
    assert.equal(escapeNestedQuotes('a"b'), 'a\\"b');
    assert.equal(escapeNestedQuotes("a'b>c"), "a'b>c");
  });
});

describe("tasks.ts parseTaskStatus", () => {
  const runningOutput = [
    "",
    "Folder: \\",
    "HostName:      WINBOX",
    "TaskName:      \\t1",
    "Next Run Time: 8/24/2026 11:58:00 PM",
    "Status:        Running",
    "Logon Mode:    Interactive only",
    "",
  ].join("\r\n");

  const readyOutput = [
    "Folder: \\",
    "Status: Ready",
    "Last Run Time: Never",
  ].join("\n");

  it("parses Status Running from /fo LIST output", () => {
    assert.equal(parseTaskStatus(runningOutput), "Running");
  });

  it("parses Status Ready", () => {
    assert.equal(parseTaskStatus(readyOutput), "Ready");
  });

  it("returns null when the task is missing (error output has no Status line)", () => {
    assert.equal(parseTaskStatus("ERROR: The system cannot find the file specified."), null);
    assert.equal(parseTaskStatus(""), null);
  });

  it("matches STATUS case-insensitively and keeps the value verbatim", () => {
    assert.equal(parseTaskStatus("\tSTATUS :   running "), "running");
  });
});
