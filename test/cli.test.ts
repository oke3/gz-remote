import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCli } from "../src/cli.ts";
import type { CliIo } from "../src/cli.ts";

interface TestIo {
  io: CliIo;
  out: () => string;
  err: () => string;
}

function makeIo(stdinText = ""): TestIo {
  const outBuffer: string[] = [];
  const errBuffer: string[] = [];
  return {
    io: {
      out: (text) => void outBuffer.push(text),
      err: (text) => void errBuffer.push(text),
      stdin: () => stdinText,
    },
    out: () => outBuffer.join(""),
    err: () => errBuffer.join(""),
  };
}

const tmpDir = mkdtempSync(join(tmpdir(), "ocr-cli-test-"));
const specPath = join(tmpDir, "spec.md");
writeFileSync(specPath, "# tiny spec\n");
const bigPromptPath = join(tmpDir, "big-prompt.md");
writeFileSync(bigPromptPath, `${"p".repeat(300)}\n`);

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("cli.ts usage + validation (exit code 2 paths)", () => {
  it("exits 2 and prints usage when invoked with no arguments", async () => {
    const t = makeIo();
    assert.equal(await runCli([], t.io), 2);
    assert.match(t.err(), /Usage:/);
  });

  it("--help exits 0 and documents every command on stdout", async () => {
    const t = makeIo();
    assert.equal(await runCli(["--help"], t.io), 0);
    for (const command of ["probe", "launch", "status", "serve", "sessions", "prompt"]) {
      assert.ok(t.out().includes(`ocr ${command}`), `usage missing ${command}`);
    }
    assert.equal(t.err(), "");
  });

  it("unknown commands exit 2 naming the offender", async () => {
    const t = makeIo();
    assert.equal(await runCli(["frobnicate"], t.io), 2);
    assert.match(t.err(), /unknown command "frobnicate"/);
  });

  it("probe without a host exits 2", async () => {
    const t = makeIo();
    assert.equal(await runCli(["probe"], t.io), 2);
    assert.match(t.err(), /<host>/);
  });

  it("probe rejects hosts with forbidden characters and echoes the input", async () => {
    const t = makeIo();
    assert.equal(await runCli(["probe", "bad;host"], t.io), 2);
    assert.match(t.err(), /bad;host/);
  });

  it("probe rejects surplus positional arguments", async () => {
    const t = makeIo();
    assert.equal(await runCli(["probe", "h", "extra"], t.io), 2);
    assert.match(t.err(), /exactly 1/);
  });

  it("launch without all three positionals exits 2", async () => {
    const t = makeIo();
    assert.equal(await runCli(["launch", "h"], t.io), 2);
    assert.match(t.err(), /remoteRepoDir/);
  });

  it("launch with a nonexistent local specFile exits 2 naming the file", async () => {
    const t = makeIo();
    const missing = join(tmpDir, "definitely-not-here.md");
    assert.equal(await runCli(["launch", "h", "C:\\repos\\x", missing], t.io), 2);
    assert.match(t.err(), /not found/);
    assert.ok(t.err().includes(missing));
  });

  it("launch rejects non-absolute remoteRepoDir values", async () => {
    const t = makeIo();
    assert.equal(await runCli(["launch", "h", "relative/repo", specPath], t.io), 2);
    assert.match(t.err(), /absolute/);
    assert.match(t.err(), /relative\/repo/);
  });

  it("launch rejects task names outside [A-Za-z0-9_-]{1,32}", async () => {
    const t = makeIo();
    assert.equal(
      await runCli(["launch", "h", "C:\\repos\\x", specPath, "--task-name", "bad name!"], t.io),
      2,
    );
    assert.match(t.err(), /bad name!/);
  });

  it("launch rejects an empty --model", async () => {
    const t = makeIo();
    assert.equal(await runCli(["launch", "h", "C:\\repos\\x", specPath, "--model", ""], t.io), 2);
    assert.match(t.err(),/--model/);
  });

  it("launch rejects surplus positionals", async () => {
    const t = makeIo();
    assert.equal(await runCli(["launch", "h", "C:\\repos\\x", specPath, "surplus"], t.io), 2);
    assert.match(t.err(), /surplus/);
  });

  it("status rejects a non-integer --tail", async () => {
    const t = makeIo();
    assert.equal(await runCli(["status", "h", "C:\\repos\\x", "--tail", "abc"], t.io), 2);
    assert.match(t.err(), /--tail/);
  });

  it("flags that need a value fail precisely when the value is missing", async () => {
    const t = makeIo();
    assert.equal(await runCli(["status", "h", "C:\\repos\\x", "--tail"], t.io), 2);
    assert.match(t.err(), /requires a value/);
  });

  it("serve without an action exits 2", async () => {
    const t = makeIo();
    assert.equal(await runCli(["serve", "h"], t.io), 2);
    assert.match(t.err(), /up\|down\|status|<up\|down\|status>/);
  });

  it("serve rejects unknown actions by name", async () => {
    const t = makeIo();
    assert.equal(await runCli(["serve", "h", "sideways"], t.io), 2);
    assert.match(t.err(), /sideways/);
  });

  it("serve rejects out-of-range ports naming the value", async () => {
    for (const badPort of ["0", "99999", "abc"]) {
      const t = makeIo();
      assert.equal(await runCli(["serve", "h", "--port", badPort, "up"], t.io), 2);
      assert.match(t.err(), new RegExp(badPort));
    }
  });

  it("sessions rejects non-http --url overrides before any network activity", async () => {
    const t = makeIo();
    assert.equal(await runCli(["sessions", "h", "--url", "ftp://x:4310"], t.io), 2);
    assert.match(t.err(), /ftp:\/\/x:4310/);
  });

  it("prompt without a session id or text source exits 2", async () => {
    const t = makeIo();
    assert.equal(await runCli(["prompt"], t.io), 2);
    assert.match(t.err(), /sessionId/);

    const t2 = makeIo();
    assert.equal(await runCli(["prompt", "ses_1"], t2.io), 2);
    assert.match(t2.err(), /textFile/);
  });

  it("prompt with a missing text file exits 2 naming the path", async () => {
    const t = makeIo();
    const missing = join(tmpDir, "missing-prompt.md");
    assert.equal(await runCli(["prompt", "ses_1", missing], t.io), 2);
    assert.ok(t.err().includes(missing));
  });

  it("refuses inline prompts over 250 chars unless --force is present", async () => {
    const t = makeIo();
    assert.equal(await runCli(["prompt", "ses_1", bigPromptPath], t.io), 2);
    assert.match(t.err(), /\blimit 250\b/);
    assert.match(t.err(), /--force/);
    assert.match(t.err(), /inside the repo/);
  });

  it("reads '-' prompts from injected stdin and applies the same size limit", async () => {
    const t = makeIo(`${"z".repeat(251)}\n`);
    assert.equal(await runCli(["prompt", "ses_1", "-"], t.io), 2);
    assert.match(t.err(), /\blimit 250\b/);
  });
});
