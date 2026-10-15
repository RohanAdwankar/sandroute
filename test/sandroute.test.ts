import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandroute } from "../src/index.ts";
import type { VmBackend } from "../src/vm.ts";

class CountingVm implements VmBackend {
  name = "counting";
  boots = 0;
  stops = 0;
  execs = 0;
  async boot() { this.boots++; }
  async exec() { this.execs++; return { stdout: "vm\n", stderr: "", exitCode: 0 }; }
  async stop() { this.stops++; }
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an idle vm is released and the next heavy command brings it back", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new CountingVm();
  const s = new Sandroute({ workspace: ws, vm, idleMs: 60 });
  await s.run("chromium --version");
  assert.equal(vm.boots, 1);
  await settle(150);
  assert.equal(vm.stops, 1, "idle vm should have been handed back");
  assert.equal(s.releaseCount, 1);
  const again = await s.run("chromium --version");
  assert.equal(again.booted, true, "the next heavy command boots a fresh vm");
  assert.equal(vm.boots, 2);
  await s.stop();
});

test("in-process commands do not keep the vm alive", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  writeFileSync(path.join(ws, "a.txt"), "hello\n");
  const vm = new CountingVm();
  const s = new Sandroute({ workspace: ws, vm, idleMs: 60 });
  await s.run("chromium --version");
  for (let i = 0; i < 4; i++) { await s.run("cat a.txt"); await settle(40); }
  assert.equal(vm.stops, 1, "the idle timer should not be reset by in-process work");
  await s.stop();
});

test("vm allocated time covers only the stretches the vm was up", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new CountingVm();
  const s = new Sandroute({ workspace: ws, vm, idleMs: 60 });
  await s.run("chromium --version");
  await settle(150);
  const afterRelease = s.vmAllocatedMs;
  assert.ok(afterRelease >= 60 && afterRelease < 140, `expected ~60-140ms, got ${afterRelease}`);
  await settle(100);
  assert.equal(s.vmAllocatedMs, afterRelease, "a released vm must not keep accruing");
  await s.stop();
});

test("the vm is kept while a command is in flight", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new CountingVm();
  vm.exec = async () => { await settle(200); return { stdout: "", stderr: "", exitCode: 0 }; };
  const s = new Sandroute({ workspace: ws, vm, idleMs: 20 });
  const p = s.run("chromium --version");
  await settle(100);
  assert.equal(await s.release(), false, "release must refuse while a command is running");
  await p;
  assert.equal(vm.stops, 0);
  await s.stop();
});

class BusyVm extends CountingVm {
  procs: { pid: number; comm: string }[] = [];
  async busy() { return { busy: this.procs.length > 0, procs: this.procs }; }
}

test("a vm with a background process is pinned, not killed", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new BusyVm();
  vm.procs = [{ pid: 42, comm: "node" }];
  const s = new Sandroute({ workspace: ws, vm, idleMs: 40 });
  await s.run("chromium --version");
  await settle(200);
  assert.equal(vm.stops, 0, "a backgrounded server must survive the idle timer");
  assert.ok(s.pinnedCount >= 1, "the refusal should be counted");
  assert.deepEqual(s.lastPinned, [{ pid: 42, comm: "node" }]);
  // once it exits, the next sweep lets the vm go
  vm.procs = [];
  await settle(200);
  assert.equal(vm.stops, 1, "a quiescent vm should be released");
  await s.stop();
});

test("a backend that cannot answer busy keeps the vm", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new BusyVm();
  vm.busy = async () => { throw new Error("vsock gone"); };
  const s = new Sandroute({ workspace: ws, vm, idleMs: 40 });
  await s.run("chromium --version");
  await settle(200);
  assert.equal(vm.stops, 0, "unprovable idleness must not count as idle");
  await s.stop();
});

test("a backend with no busy probe still releases on the timer", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const vm = new CountingVm();
  const s = new Sandroute({ workspace: ws, vm, idleMs: 40 });
  await s.run("chromium --version");
  await settle(200);
  assert.equal(vm.stops, 1);
  await s.stop();
});

test("the file tools are held to the workspace", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "not the agent's to see\n");
  const s = new Sandroute({ workspace: ws, vm: new CountingVm() });

  await s.writeFile("notes/todo.md", "- one\n");
  assert.equal(readFileSync(path.join(ws, "notes/todo.md"), "utf8"), "- one\n");
  assert.equal(await s.readFile("notes/todo.md"), "- one\n");

  await s.editFile("notes/todo.md", "one", "two");
  assert.equal(readFileSync(path.join(ws, "notes/todo.md"), "utf8"), "- two\n");

  // a path outside the workspace resolves into the empty in-memory fs, not the host
  await assert.rejects(() => s.readFile(path.join(outside, "secret.txt")));
  await assert.rejects(() => s.readFile("/etc/passwd"));

  // and writing outside must not reach the host either
  await s.writeFile(path.join(outside, "planted.txt"), "x").catch(() => {});
  assert.equal(existsSync(path.join(outside, "planted.txt")), false, "a write outside the workspace must not land on the host");
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "not the agent's to see\n");
});

test("the search tools see the workspace and nothing outside it", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  writeFileSync(path.join(outside, "secret.ts"), "needle\n");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  writeFileSync(path.join(ws, "src/a.ts"), "needle\n");
  writeFileSync(path.join(ws, "src/b.txt"), "needle\n");
  const vm = new CountingVm();
  const s = new Sandroute({ workspace: ws, vm });

  assert.deepEqual((await s.glob("*.ts")).map((f) => f.replace(/.*\//, "")), ["a.ts"]);
  assert.deepEqual((await s.grepFiles("needle", undefined, "*.ts")).map((f) => f.replace(/.*\//, "")), ["a.ts"]);
  assert.equal(vm.execs, 0, "searching the workspace never leaves the process");

  // outside the workspace the in-process shell must not answer: it is escalated, and what
  // the VM can see is the VM's business
  await s.glob("*.ts", outside);
  await s.grepFiles("needle", outside);
  assert.equal(vm.execs, 2, "a path outside the workspace is escalated, not served here");
});

test("no command reads a host file outside the workspace, however the path is built", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sr-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  const secret = "s3cret-" + Math.random().toString(36).slice(2);
  writeFileSync(path.join(outside, "keep.txt"), secret + "\n");
  const target = path.join(outside, "keep.txt");
  const vm = new CountingVm(); // stands in for the machine, and knows nothing of the host
  const s = new Sandroute({ workspace: ws, vm });

  // The router reads the command text, so any path it cannot see statically is a way
  // past it. These are examples of that, not the list: what has to hold is that the
  // filesystem underneath refuses regardless of which tier the router picked.
  for (const cmd of [
    `cat ${target}`,
    `P=${target}; cat $P`,
    `eval "cat ${target}"`,
    `cat $(echo ${target})`,
    `c=cat; $c ${target}`,
    `echo ${Buffer.from(`cat ${target}`).toString("base64")} | base64 -d | sh`,
    `cat ${path.relative(ws, target)}`,
    `cd ${outside} && cat keep.txt`,
  ]) {
    const r = await s.run(cmd);
    assert.ok(!(r.stdout + r.stderr).includes(secret), `leaked through: ${cmd}`);
  }
});
