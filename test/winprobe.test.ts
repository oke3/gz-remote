// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProbeOutput, renderProbeScript } from "../src/winprobe.ts";

const FULL_OUTPUT = [
  "Last login: Mon Aug 24 09:00:00 2026 from 10.0.0.1",
  "OCR_PSVERSION=7.4.1",
  "OCR_EXECUTIONPOLICY=Bypass",
  "OCR_OPENCODE=C:\\npm-global\\opencode.cmd",
  "OCR_GITPATH=C:\\Program Files\\Git\\cmd\\git.exe",
  "OCR_OSCAPTION=Microsoft Windows 11 Pro",
].join("\r\n");

describe("winprobe.ts", () => {
  it("script asks for opencode via Get-Command", () => {
    assert.ok(renderProbeScript().includes("(Get-Command opencode"));
  });

  it("script asks for execution policy and OS caption", () => {
    const script = renderProbeScript();
    assert.ok(script.includes("Get-ExecutionPolicy"));
    assert.ok(script.includes("Win32_OperatingSystem"));
    assert.ok(script.includes("git.exe"));
  });

  it("script emits all five OCR_ markers", () => {
    const script = renderProbeScript();
    for (const key of ["PSVERSION", "EXECUTIONPOLICY", "OPENCODE", "GITPATH", "OSCAPTION"]) {
      assert.ok(script.includes(`"OCR_${key}="`), `missing OCR_${key}`);
    }
  });

  it("parses a full probe answer into a windows ProbeResult", () => {
    const probe = parseProbeOutput(FULL_OUTPUT);
    assert.equal(probe.windows, true);
    assert.equal(probe.psVersion, "7.4.1");
    assert.equal(probe.executionPolicy, "Bypass");
    assert.equal(probe.opencodePath, "C:\\npm-global\\opencode.cmd");
    assert.equal(probe.gitPath, "C:\\Program Files\\Git\\cmd\\git.exe");
    assert.equal(probe.osCaption, "Microsoft Windows 11 Pro");
  });

  it("treats missing optional markers as null", () => {
    const probe = parseProbeOutput("OCR_PSVERSION=5.1.26200.9021\r\nOCR_OPENCODE=\r\n");
    assert.equal(probe.windows, true);
    assert.equal(probe.psVersion, "5.1.26200.9021");
    assert.equal(probe.opencodePath, null);
    assert.equal(probe.executionPolicy, null);
    assert.equal(probe.gitPath, null);
    assert.equal(probe.osCaption, null);
  });

  it("reports windows=false when PowerShell never answered", () => {
    const probe = parseProbeOutput("bash: powershell: command not found\nsome noise without marker");
    assert.equal(probe.windows, false);
    assert.equal(probe.psVersion, null);
  });

  it("ignores unrelated lines and non-OCR keys", () => {
    const probe = parseProbeOutput("PATH=C:\\something\r\nrandom=text\r\nOCR_PSVERSION=7.0.0\r\n=");
    assert.equal(probe.windows, true);
    assert.ok(!("PATH" in probe));
    assert.equal(probe.psVersion, "7.0.0");
  });

  it("keeps '=' inside values intact", () => {
    const probe = parseProbeOutput("OCR_OSCAPTION=Weird=OS=Caption");
    assert.equal(probe.osCaption, "Weird=OS=Caption");
  });

  it("first duplicate marker wins (echoed command lines ignored)", () => {
    const probe = parseProbeOutput("OCR_PSVERSION=7.4.1\r\nOCR_PSVERSION=0.0.0");
    assert.equal(probe.psVersion, "7.4.1");
  });
});
