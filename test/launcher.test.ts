import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultLogFileName,
  deriveTaskName,
  psSingleQuote,
  renderLauncher,
  renderPollScript,
  renderUploadScript,
} from "../src/launcher.ts";
import { DEFAULT_LAUNCH_PROMPT, UsageError } from "../src/types.ts";

function render(overrides: Partial<Parameters<typeof renderLauncher>[0]> = {}): string {
  return renderLauncher({
    repoDir: "C:\\repos\\my app",
    specRemotePath: "C:\\Users\\o m\\AppData\\Local\\Temp\\ocr-t1\\spec.md",
    taskName: "t1",
    model: "vendor/m-1",
    ...overrides,
  });
}

describe("launcher.ts rendering", () => {
  it("copies the uploaded spec into the repo dir as SPEC.md -Force", () => {
    assert.ok(
      render().includes("Copy-Item -LiteralPath $spec -Destination (Join-Path $repo 'SPEC.md') -Force"),
    );
  });

  it("keeps repo paths with spaces intact inside single quotes", () => {
    assert.ok(render().includes("$repo = 'C:\\repos\\my app'"));
    assert.ok(render().includes("Set-Location -LiteralPath $repo"));
  });

  it("writes the BUILD START marker with a runtime timestamp", () => {
    const script = render();
    assert.ok(script.includes('"=== BUILD START "'));
    assert.ok(script.includes("Get-Date -Format"));
  });

  it("appends the EXITCODE marker using $LASTEXITCODE", () => {
    const script = render();
    assert.ok(script.includes("$ocrExit = $LASTEXITCODE"));
    assert.ok(script.includes('"=== EXITCODE=$ocrExit "'));
  });

  it("quotes the model override for -m", () => {
    assert.ok(render({ model: "opencode/x-preview-f-free" }).includes("-m 'opencode/x-preview-f-free'"));
    assert.ok(render().includes("-m 'vendor/m-1'"));
  });

  it("embeds the default prompt verbatim", () => {
    assert.ok(render().includes(DEFAULT_LAUNCH_PROMPT));
    assert.ok(render().includes("oke3@users.noreply.github.com"));
  });

  it("doubles embedded apostrophes in the prompt (PowerShell escaping)", () => {
    const script = render({ promptText: "it's fine" });
    assert.ok(script.includes("'it''s fine'"));
    assert.ok(!script.includes("'it's fine'"));
  });

  it("appends ALL output streams to the log (*>>)", () => {
    assert.ok(render().includes("*>> $log"));
  });

  it("runs opencode.cmd headlessly with run -m <model>", () => {
    assert.ok(render().includes("& opencode.cmd run -m 'vendor/m-1'"));
  });

  it("defaults the log file to build-<taskName>.log inside the repo dir", () => {
    const script = render();
    assert.ok(script.includes(defaultLogFileName("t1")));
    assert.ok(script.includes("Join-Path $repo 'build-t1.log'"));
  });

  it("honors a custom --log file name", () => {
    assert.ok(render({ logFileName: "custom job.log" }).includes("Join-Path $repo 'custom job.log'"));
  });

  it("rejects task names violating [A-Za-z0-9_-]{1,32}", () => {
    assert.throws(() => render({ taskName: "bad name!" }), UsageError);
  });

  it("rejects empty repoDir and empty model", () => {
    assert.throws(() => render({ repoDir: "" }), UsageError);
    assert.throws(() => render({ model: "" }), UsageError);
  });

  it("uses CRLF line endings throughout", () => {
    const script = render();
    assert.ok(script.includes("\r\n"));
    assert.ok(!script.replace(/\r\n/g, "").includes("\n"));
  });
});

describe("launcher.ts upload + poll helpers", () => {
  it("renderUploadScript decodes one base64 stdin line to bytes on disk", () => {
    const script = renderUploadScript("C:\\temp dir\\spec.md");
    assert.ok(script.includes("[Console]::In.ReadToEnd()"));
    assert.ok(script.includes("[Convert]::FromBase64String"));
    assert.ok(script.includes("[IO.File]::WriteAllBytes('C:\\temp dir\\spec.md'"));
    assert.ok(script.includes("OCR_WROTE="));
  });

  it("renderUploadScript doubles apostrophes in remote paths", () => {
    const script = renderUploadScript("C:\\o'brien\\x.md");
    assert.ok(script.includes("'C:\\o''brien\\x.md'"));
  });

  it("renderUploadScript rejects an empty remote path", () => {
    assert.throws(() => renderUploadScript(""), UsageError);
  });

  it("renderPollScript searches the log for BUILD START and reports OCR_POLL", () => {
    const script = renderPollScript("C:\\repos\\p\\build-t.log");
    assert.ok(script.includes("Select-String -LiteralPath 'C:\\repos\\p\\build-t.log'"));
    assert.ok(script.includes("-Pattern 'BUILD START'"));
    assert.ok(script.includes("OCR_POLL="));
  });
});

describe("launcher.ts pure utilities", () => {
  it("psSingleQuote doubles single quotes only", () => {
    assert.equal(psSingleQuote("plain"), "'plain'");
    assert.equal(psSingleQuote("a'b"), "'a''b'");
  });

  it("deriveTaskName takes the sanitized basename", () => {
    assert.equal(deriveTaskName("C:\\repos\\my app"), "my-app");
    assert.equal(deriveTaskName("\\\\srv\\share\\proj.one"), "proj-one");
  });

  it("deriveTaskName truncates to 32 chars and never returns empty", () => {
    const long = deriveTaskName("C:\\" + "x".repeat(50));
    assert.ok(long.length <= 32);
    assert.match(long, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(deriveTaskName("C:\\???"), "ocr-job");
  });
});
