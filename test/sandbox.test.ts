import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox } from "../src/sandbox.ts";
import { Sandroute } from "../src/sandroute.ts";

// These need bubblewrap and unprivileged user namespaces, which not every host allows.
const usable = spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"]).status === 0;
const opts = { skip: usable ? false : "bubblewrap is not usable here" };
const tenant = (secret?: string) => {
  const ws = mkdtempSync(path.join(tmpdir(), "tenant-"));
  if (secret) writeFileSync(path.join(ws, "secret.txt"), secret + "\n");
  return { ws, sb: new Sandbox({ workspace: ws }) };
};

test("a tenant sees its own workspace and no one else's", opts, async () => {
  const a = tenant("alpha-secret"), b = tenant("bravo-secret");
  const own = await a.sb.exec("cat secret.txt");
  assert.equal(own.stdout.trim(), "alpha-secret");
  // every way of naming the other tenant's files, including by guessing the path exactly
  for (const cmd of [`cat ${b.ws}/secret.txt`, `ls ${path.dirname(b.ws)}`, `find / -name secret.txt -not -path '${a.ws}/*' 2>/dev/null`]) {
    const r = await a.sb.exec(cmd);
    assert.ok(!(r.stdout + r.stderr).includes("bravo-secret"), `leaked through: ${cmd}`);
    assert.ok(!r.stdout.includes(path.basename(b.ws)), `the other workspace is visible through: ${cmd}`);
  }
});

test("a tenant cannot change anything outside its workspace", opts, async () => {
  const { ws, sb } = tenant();
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  for (const cmd of [`echo x > ${outside}/planted`, "echo x > /usr/planted", "echo x > /etc/planted"]) await sb.exec(cmd);
  assert.equal(existsSync(path.join(outside, "planted")), false);
  assert.equal(existsSync("/usr/planted"), false);
  await sb.exec("echo kept > inside.txt");
  assert.equal(readFileSync(path.join(ws, "inside.txt"), "utf8"), "kept\n", "its own workspace is writable");
  // scratch space exists but is private and gone after the command
  await sb.exec("echo x > /tmp/scratch");
  assert.equal((await sb.exec("ls /tmp")).stdout.trim(), "", "scratch must not persist between commands");
});

test("a tenant cannot see or signal the host's processes", opts, async () => {
  const { sb } = tenant();
  const host = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const seen = await sb.exec(`ls /proc | grep -c '^[0-9]'`);
    assert.ok(Number(seen.stdout.trim()) < 6, `a fresh process namespace has a handful of processes, saw ${seen.stdout.trim()}`);
    await sb.exec(`kill -9 ${host.pid}`);
    assert.equal(host.exitCode, null, "the host process must survive");
    assert.equal(process.kill(host.pid!, 0), true);
  } finally { host.kill(); }
});

test("a tenant has no network and none of the host's environment", opts, async () => {
  const { sb } = tenant();
  process.env.TENANT_TEST_SECRET = "from-the-host";
  const env = await sb.exec("env");
  assert.ok(!env.stdout.includes("from-the-host"), "the host environment must not leak in");
  const net = await sb.exec(`python3 -c "import socket;socket.setdefaulttimeout(3);socket.create_connection(('1.1.1.1',443))"`);
  assert.notEqual(net.exitCode, 0, "there must be nothing to connect to");
  delete process.env.TENANT_TEST_SECRET;
});

test("a runaway command is stopped and its output is bounded", opts, async () => {
  const { ws } = tenant();
  const quick = new Sandbox({ workspace: ws, timeoutMs: 400, maxOutputBytes: 4096 });
  const t = Date.now();
  const slow = await quick.exec("sleep 30");
  assert.ok(Date.now() - t < 5000 && slow.exitCode !== 0, "a command past its time is killed");
  const flood = await quick.exec("yes | head -c 10000000");
  assert.ok(flood.stdout.length < 100_000 && /output limit/.test(flood.stderr), "a flood of output is cut off");
});

test("the file tools run in the sandbox and never touch an interpreter", opts, async () => {
  const { ws, sb } = tenant();
  const s = new Sandroute({ workspace: ws, light: sb });
  assert.equal(s.bash, undefined, "no in-process interpreter is built");
  const tricky = `it's "quoted"\nsecond $HOME line \`x\`\n`;
  await s.writeFile("notes/a.txt", tricky);
  assert.equal(readFileSync(path.join(ws, "notes/a.txt"), "utf8"), tricky, "awkward content survives the trip");
  assert.equal(await s.readFile("notes/a.txt"), tricky);
  assert.equal(await s.readFile("notes/a.txt", { offset: 2, limit: 1 }), "second $HOME line `x`\n");
  assert.equal(await s.editFile("notes/a.txt", "second", "third"), 1);
  assert.match(readFileSync(path.join(ws, "notes/a.txt"), "utf8"), /third \$HOME/);
  await assert.rejects(() => s.editFile("notes/a.txt", "absent", "x"), /not found/);
  await assert.rejects(() => s.readFile("/etc/shadow"));
  assert.deepEqual((await s.glob("*.txt")).map((f) => path.basename(f)), ["a.txt"]);
  assert.deepEqual((await s.grepFiles("third")).map((f) => path.basename(f)), ["a.txt"]);
});

test("with a sandbox, commands that need a machine still go to it", opts, async () => {
  const { ws, sb } = tenant();
  const calls: string[] = [];
  const vm = { name: "spy", boot: async () => {}, stop: async () => {}, exec: async (c: string) => { calls.push(c); return { stdout: "", stderr: "", exitCode: 0 }; } };
  const s = new Sandroute({ workspace: ws, light: sb, vm });
  const light = await s.run("grep -c secret secret.txt || true");
  assert.equal(light.tier, "inprocess");
  for (const heavy of ["python3 -c 'print(1)'", "npm test", "curl https://example.com", "git clone https://example.com/x.git"]) {
    assert.equal((await s.run(heavy)).tier, "vm", heavy);
  }
  assert.equal(calls.length, 4);
  await s.stop();
});
