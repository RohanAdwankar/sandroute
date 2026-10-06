import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentClient } from "../src/agent-client.ts";
import { buildConfig } from "../src/firecracker.ts";

// The guest agent runs here as a plain process on a unix socket, with its own directory
// standing in for the guest disk. This exercises the protocol and the file sync, not the VM.
async function rig() {
  const host = mkdtempSync(path.join(tmpdir(), "host-"));
  const guest = mkdtempSync(path.join(tmpdir(), "guest-"));
  const sock = path.join(mkdtempSync(path.join(tmpdir(), "sock-")), "a.sock");
  const agent: ChildProcess = spawn("python3", ["-I", "guest/agent.py", "--workspace", guest, "--unix", sock], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => agent.stdout!.once("data", () => r()));
  const client = new AgentClient(() => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), host);
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
});
