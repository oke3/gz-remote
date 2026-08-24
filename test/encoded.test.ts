import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodedCommandInvocation, fromEncodedCommand, toEncodedCommand } from "../src/encoded.ts";

describe("encoded.ts", () => {
  it("round-trips ascii", () => {
    const script = "Write-Output 'hello world'";
    assert.equal(fromEncodedCommand(toEncodedCommand(script)), script);
  });

  it("round-trips unicode (emoji, CJK, accents)", () => {
    const script = "Write-Output 'héllo 世界 🚀'";
    assert.equal(fromEncodedCommand(toEncodedCommand(script)), script);
  });

  it("round-trips newlines including CRLF and LF mixes", () => {
    const script = "line1\r\nline2\nline3\r\n\r\nline5";
    assert.equal(fromEncodedCommand(toEncodedCommand(script)), script);
  });

  it("round-trips tabs and trailing whitespace", () => {
    const script = "\ta b\t \t ";
    assert.equal(fromEncodedCommand(toEncodedCommand(script)), script);
  });

  it("encodes the empty string to empty base64", () => {
    assert.equal(toEncodedCommand(""), "");
    assert.equal(fromEncodedCommand(""), "");
  });

  it("produces the known UTF-16LE base64 vector for 'hi'", () => {
    // 'hi' -> bytes 68 00 69 00 -> base64 'aABpAA=='
    assert.equal(toEncodedCommand("hi"), "aABpAA==");
  });

  it("survives double quotes and dollar signs meant for PowerShell", () => {
    const script = '$v = "a `$b"; Write-Output $v';
    assert.equal(fromEncodedCommand(toEncodedCommand(script)), script);
  });

  it("encodedCommandInvocation wraps payload for powershell -EncodedCommand", () => {
    const invocation = encodedCommandInvocation("Write-Output 1");
    const prefix = "powershell -NoProfile -NonInteractive -EncodedCommand ";
    assert.ok(invocation.startsWith(prefix), `unexpected invocation: ${invocation}`);
    const payload = invocation.slice(prefix.length);
    assert.ok(!payload.includes(" "), "payload must be a single token");
    assert.equal(fromEncodedCommand(payload), "Write-Output 1");
  });
});
