import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandroute } from "../src/index.ts";
import type { VmBackend } from "../src/vm.ts";

class CountingVm implements VmBackend {
  name = "counting";
  boots = 0;
  async boot() { this.boots++; }
  async exec() { return { stdout: "vm\n", stderr: "", exitCode: 0 }; }
  async stop() {}
}

function setup() {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  writeFileSync(path.join(ws, "a.txt"), "hello world\n");
  const vm = new CountingVm();
  return { ws, vm, s: new Sandroute({ workspace: ws, vm }) };
}

test("in-process edits land on the real workspace and never boot the vm", async () => {
  const { ws, vm, s } = setup();
  const r = await s.run("sed -i 's/world/there/' a.txt");
  assert.equal(r.tier, "inprocess");
  assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "hello there\n");
  assert.equal(vm.boots, 0);
});

test("the vm boots once, on the first command that needs it", async () => {
  const { vm, s } = setup();
  const a = await s.run("chromium --version");
  const b = await s.run("npm test");
  assert.equal(a.booted, true);
  assert.equal(b.booted, false);
  assert.equal(vm.boots, 1);
});

test("git works in-process with no git binary", async () => {
  const { s } = setup();
  await s.run("git init");
  await s.run("git add .");
  const c = await s.run("git commit -m first");
  const log = await s.run("git log -n 1");
  assert.equal(c.tier, "inprocess");
  assert.match(log.stdout, /first/);
});
