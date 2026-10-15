import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentClient } from "../src/agent-client.ts";
import { buildConfig, snapshotPaths } from "../src/firecracker.ts";
import { manifest } from "../src/agent-client.ts";

// The guest agent runs here as a plain process on a unix socket, with its own directory
// standing in for the guest disk. This exercises the protocol and the file sync, not the VM.
async function rig(maxFileBytes?: number) {
  const host = mkdtempSync(path.join(tmpdir(), "host-"));
  const guest = mkdtempSync(path.join(tmpdir(), "guest-"));
  const sock = path.join(mkdtempSync(path.join(tmpdir(), "sock-")), "a.sock");
  const agent: ChildProcess = spawn("python3", ["-I", "guest/agent.py", "--workspace", guest, "--unix", sock], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => agent.stdout!.once("data", () => r()));
  const client = new AgentClient(() => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), host, maxFileBytes);
  await client.open();
  return { host, guest, client, done: () => { client.close(); agent.kill(); } };
}

test("host files are visible in the guest, and guest writes come back", async () => {
  const { host, guest, client, done } = await rig();
  try {
    writeFileSync(path.join(host, "in.txt"), "from host\n");
    const r = await client.exec(`cat in.txt && echo from guest > out.txt`, guest);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "from host\n");
    assert.equal(readFileSync(path.join(host, "out.txt"), "utf8"), "from guest\n");
  } finally { done(); }
});

test("only changed files are pushed on later calls, and deletes propagate both ways", async () => {
  const { host, guest, client, done } = await rig();
  try {
    writeFileSync(path.join(host, "a.txt"), "1");
    await client.exec("true", guest);
    writeFileSync(path.join(host, "a.txt"), "22");        // edited in-process between VM calls
    mkdirSync(path.join(host, "sub"));
    writeFileSync(path.join(host, "sub/b.txt"), "b");
    const r = await client.exec("cat a.txt sub/b.txt; rm a.txt", guest);
    assert.equal(r.stdout, "22b");
    assert.equal(existsSync(path.join(host, "a.txt")), false); // guest delete reached the host
  } finally { done(); }
});

test("exit codes and stderr come through", async () => {
  const { guest, client, done } = await rig();
  try {
    const r = await client.exec("echo oops >&2; exit 3", guest);
    assert.equal(r.code, 3);
    assert.equal(r.stderr, "oops\n");
  } finally { done(); }
});

test("firecracker config is ordered boot-source, drive, machine, vsock, then start", () => {
  const steps = buildConfig({ kernel: "/k", rootfs: "/r.ext4" }, "/v.sock", "/work");
  assert.deepEqual(steps.map((s) => s.path), ["/boot-source", "/drives/rootfs", "/machine-config", "/vsock", "/actions"]);
  assert.deepEqual(steps.at(-1)!.body, { action_type: "InstanceStart" });
  // a writable root cannot be shared by two VMs, and corrupts when a snapshot is restored
  // over a backing file a later VM has written
  assert.equal((steps[1].body as { is_read_only: boolean }).is_read_only, true);
  assert.ok(!steps.some((s) => s.path.startsWith("/network-interfaces")), "no nic unless asked for");
});

test("the manifest never follows a symlink out of the workspace", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "not the agent's to see\n");
  writeFileSync(path.join(ws, "a.txt"), "mine\n");
  mkdirSync(path.join(ws, "sub"), { recursive: true });
  writeFileSync(path.join(ws, "sub/b.txt"), "also mine\n");
  symlinkSync(outside, path.join(ws, "escape"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "peek.txt"));
  assert.deepEqual([...manifest(ws).files.keys()].sort(), ["a.txt", "sub/b.txt"]);
});

test("the manifest skips node_modules and .git wherever they appear", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "ws-"));
  mkdirSync(path.join(ws, ".opencode/node_modules/pkg"), { recursive: true });
  mkdirSync(path.join(ws, ".git/objects"), { recursive: true });
  mkdirSync(path.join(ws, "node_modules_old"), { recursive: true });
  writeFileSync(path.join(ws, ".opencode/node_modules/pkg/index.js"), "dep\n");
  writeFileSync(path.join(ws, ".git/objects/abc"), "blob\n");
  writeFileSync(path.join(ws, "node_modules_old/keep.txt"), "not a dep dir\n");
  writeFileSync(path.join(ws, "a.txt"), "mine\n");
  assert.deepEqual([...manifest(ws).files.keys()].sort(), ["a.txt", "node_modules_old/keep.txt"]);
});

test("a configured network reaches the guest as a nic and on the cmdline", () => {
  const steps = buildConfig(
    { kernel: "/k", rootfs: "/r.ext4", network: { tap: "sr-tap0", guestIp: "172.16.0.2/30", gateway: "172.16.0.1" } },
    "v.sock", "/work",
  );
  assert.deepEqual(steps.map((s) => s.path),
    ["/boot-source", "/drives/rootfs", "/machine-config", "/vsock", "/network-interfaces/eth0", "/actions"]);
  assert.deepEqual(steps[4].body, { iface_id: "eth0", guest_mac: "06:00:ac:10:00:02", host_dev_name: "sr-tap0" });
  const args = (steps[0].body as { boot_args: string }).boot_args;
  assert.match(args, /sandroute\.ip=172\.16\.0\.2\/30 sandroute\.gw=172\.16\.0\.1 sandroute\.dns=1\.1\.1\.1/);
});

test("a guest that dies mid-request does not leave the caller waiting", async () => {
  const { guest, client, done } = await rig();
  try {
    const slow = client.exec("sleep 30", guest);
    await new Promise((r) => setTimeout(r, 200));
    done(); // the guest goes away while the command is still running
    await assert.rejects(slow, /closed/);
    // and anything asked afterwards fails rather than hanging
    await assert.rejects(client.exec("true", guest), /closed/);
  } finally { done(); }
});

test("an empty directory reaches the guest, and one the guest makes comes back", async () => {
  const { host, guest, client, done } = await rig();
  try {
    mkdirSync(path.join(host, "dist/nested"), { recursive: true });
    const r = await client.exec("test -d dist/nested && mkdir -p out/made && echo yes", guest);
    assert.equal(r.stdout.trim(), "yes", "a directory with no files in it must still exist in the guest");
    assert.ok(existsSync(path.join(host, "out/made")), "and one the guest creates must come back");
  } finally { done(); }
});

test("a same-size rewrite the signature cannot distinguish is still seen", async () => {
  const { host, guest, client, done } = await rig();
  try {
    // Pin the timestamp so both versions carry an identical mtime and size: what a
    // filesystem with coarse timestamps does on its own, and what clock skew does to any
    // of them. The signature is then useless and only the unsettled check saves it.
    const f = path.join(host, "f.txt");
    const stamp = Date.now() / 1000 + 1;
    writeFileSync(f, "aaaa");
    utimesSync(f, stamp, stamp);
    await client.exec("true", guest);
    writeFileSync(f, "bbbb");
    utimesSync(f, stamp, stamp);
    assert.equal((await client.exec("cat f.txt", guest)).stdout, "bbbb");
  } finally { done(); }
});

test("a snapshot is not reused across workspaces or across rebuilt images", () => {
  const d = mkdtempSync(path.join(tmpdir(), "snapkey-"));
  const kernel = path.join(d, "vmlinux"), rootfs = path.join(d, "rootfs.ext4");
  writeFileSync(kernel, "k");
  writeFileSync(rootfs, "image one");
  const key = (ws: string) => snapshotPaths({ kernel, rootfs, snapshotDir: path.join(d, "snaps") }, ws)!.state;

  const first = key("/work/one");
  assert.equal(first, key("/work/one"), "the same inputs name the same snapshot");
  assert.notEqual(first, key("/work/two"), "a different workspace gets its own");

  writeFileSync(rootfs, "image two, rebuilt and a different length");
  assert.notEqual(first, key("/work/one"), "a rebuilt image must not restore a snapshot of the old one");

  assert.equal(snapshotPaths({ kernel, rootfs }, "/work/one"), undefined, "no snapshot dir, no snapshot");
});

test("a file too large to copy fails by name instead of dying inside the sync", async () => {
  const { host, guest, client, done } = await rig(1024);
  try {
    writeFileSync(path.join(host, "fixture.bin"), Buffer.alloc(4096));
    await assert.rejects(client.exec("true", guest), /fixture\.bin is 0MiB, over the 0MiB sync limit/);
  } finally { done(); }
});
