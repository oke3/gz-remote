import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSshArgs, validateHost } from "../src/ssh.ts";
import { UsageError } from "../src/types.ts";

const CMD = "powershell -NoProfile -NonInteractive -EncodedCommand QUJD";

describe("ssh.ts argument construction", () => {
  it("always injects BatchMode=yes exactly once", () => {
    const args = buildSshArgs("host-a", CMD);
    assert.equal(args.filter((a) => a === "-o").length >= 2, true);
    assert.equal(args.filter((a) => a === "BatchMode=yes").length, 1);
  });

  it("always injects StrictHostKeyChecking=no exactly once", () => {
    const args = buildSshArgs("host-a", CMD);
    assert.equal(args.filter((a) => a === "StrictHostKeyChecking=no").length, 1);
  });

  it("places host second-to-last and the remote command last, verbatim", () => {
    const args = buildSshArgs("host-a", CMD);
    assert.equal(args[args.length - 1], CMD);
    assert.equal(args[args.length - 2], "host-a");
  });

  it("accepts plain hostnames, IPs, dashes, dots, underscores", () => {
    for (const host of ["my-host.example.com", "10.1.2.3", "win_box_1", "localhost"]) {
      assert.equal(validateHost(host), host);
      assert.ok(buildSshArgs(host, CMD).includes(host));
    }
  });

  it("derives ConnectTimeout seconds from timeoutMs (5000 -> 5)", () => {
    const args = buildSshArgs("h", CMD, { timeoutMs: 5000 });
    assert.ok(args.includes("ConnectTimeout=5"));
  });

  it("floors ConnectTimeout at 1 second for tiny timeouts (50ms -> 1)", () => {
    const args = buildSshArgs("h", CMD, { timeoutMs: 50 });
    assert.ok(args.includes("ConnectTimeout=1"));
  });

  it("uses the default 30s ConnectTimeout when no timeout is given", () => {
    const args = buildSshArgs("h", CMD);
    assert.ok(args.includes(`ConnectTimeout=${Math.ceil(30_000 / 1000)}`));
  });

  it("rejects the empty host", () => {
    assert.throws(() => validateHost(""), UsageError);
    assert.throws(() => validateHost(""), /empty/);
  });

  const evilHosts = [
    "bad host",
    "h;rm -rf /",
    "user@host",
    "host$(calc)",
    "host&whoami",
    'host"|id',
    "host\nname",
    "höst",
    "host/x",
  ];
  for (const host of evilHosts) {
    it(`rejects hostile host ${JSON.stringify(host)} matching [^A-Za-z0-9._-]`, () => {
      assert.throws(() => validateHost(host), UsageError);
      assert.throws(() => validateHost(host), new RegExp(host.slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }

  it("buildSshArgs validates the host before returning anything", () => {
    assert.throws(() => buildSshArgs("bad;host", CMD), UsageError);
  });
});
