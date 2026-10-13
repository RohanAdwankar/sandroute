// A demo of unmodified opencode running inside the sandbox.
//
// opencode is the real binary and knows nothing about any of this -- it just calls its
// bash tool, which has been overridden by opencode/bash.ts. This narrates what the
// router does with each call, and watches the host for the microVM coming and going.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../e2e/mock-llm.mts";

const root = path.resolve(import.meta.dirname, "..");
const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const ws = mkdtempSync(path.join(tmpdir(), "demo-ws-"));
const home = mkdtempSync(path.join(tmpdir(), "demo-home-"));
const log = path.join(ws, "sandroute.log");

const C = { dim: "\x1b[38;5;245m", ink: "\x1b[38;5;252m", blue: "\x1b[38;5;75m",
            amber: "\x1b[38;5;215m", green: "\x1b[38;5;114m", red: "\x1b[38;5;203m",
            bold: "\x1b[1m", off: "\x1b[0m" };
let t0 = Date.now();
const stamp = () => `${C.dim}${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${C.off}`;
const say = (s = "") => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

writeFileSync(path.join(ws, "notes.txt"), "the quick brown fox\n");
for (let i = 0; i < 400; i++) {
  const d = path.join(ws, `src/d${Math.floor(i / 40)}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `f${i}.ts`), `export const v${i} = "needle";\n`);
}
mkdirSync(path.join(ws, ".opencode/tool"), { recursive: true });
writeFileSync(path.join(ws, ".opencode/tool/bash.ts"),
  readFileSync(path.join(root, "opencode/bash.ts"), "utf8").replace("../src/index.ts", path.join(root, "src/index.ts")));
symlinkSync(path.join(root, "node_modules"), path.join(ws, "node_modules"));

const commands = [
  "cat notes.txt",                                       // light
  "grep -rl needle src | head -3",                       // light
  "uname -r",                                            // needs a machine -> VM wakes
  "python3 -c 'print(\"this ran inside the microvm\")'",  // VM
  // the agent goes back to reading and editing. the VM has nothing to do, so it goes away
  "sed -i 's/quick/slow/' notes.txt && cat notes.txt",   // light
  "cat src/d0/f1.ts",                                    // light
  "grep -c needle src/d0/f2.ts",                         // light
  "python3 -c 'print(\"and the microvm came back\")'",    // VM wakes again
  // now the agent leaves something running. the VM must not be taken away
  "nohup python3 -m http.server 8099 >/dev/null 2>&1 & echo server started",
  "python3 -c \"import urllib.request as u; print('the server answers HTTP', u.urlopen('http://127.0.0.1:8099/',timeout=3).status)\"",
];
const THINK = 1500;
const mock = await startMock(commands, THINK);
writeFileSync(path.join(ws, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  model: "mock/scripted", small_model: "mock/scripted",
  provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "mock",
    options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "x" },
    models: { scripted: { name: "scripted", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  permission: { "*": "allow" }, autoupdate: false,
}, null, 2));

say(`${C.bold}${C.ink}sandroute${C.off} ${C.dim}— unmodified opencode, routed between an in-process shell and a Firecracker microVM${C.off}`);
say(`${C.dim}400-file workspace · ${THINK}ms of model latency between calls · 700ms idle window · opencode ${execFileSync(path.join(root, "node_modules/.bin/opencode"), ["--version"]).toString().trim()}${C.off}`);
say();

// Prime the snapshot before the clock starts. In production this ships with the image;
// paying for it here would just be measuring a cold boot.
{
  const { FirecrackerVm } = await import("../src/index.js");
  const warm = new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`,
    rootfs: `${A}/rootfs.ext4`, snapshotDir: `${A}/snapcache` });
  const t = Date.now();
  await warm.boot(ws); await warm.stop();
  say(`${C.dim}snapshot primed in ${Date.now() - t}ms (done once, ahead of the session)${C.off}`);
  say(`${C.dim}starting opencode…${C.off}`);
  say();
}

const vmUp = () => { try { return execFileSync("pgrep", ["-c", "-x", "firecracker"]).toString().trim() !== "0"; } catch { return false; } };
let wasUp = false;
const watch = setInterval(() => {
  const up = vmUp();
  if (up !== wasUp) {
    wasUp = up;
    say(up ? `${stamp()} ${C.amber}${C.bold}▲ microVM up${C.off}`
           : `${stamp()} ${C.green}${C.bold}▼ microVM released${C.off} ${C.dim}— nothing left running in it${C.off}`);
  }
}, 60);

let seen = 0;
const tail = setInterval(() => {
  if (!existsSync(log)) return;
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  for (const l of lines.slice(seen)) {
    const j = JSON.parse(l);
    if (seen === 0 && lines.indexOf(l) === 0) t0 = Date.now() - j.ms;  // clock starts at the first tool call
    const tier = j.tier === "vm"
      ? `${C.amber}vm${j.booted ? ` wake ${j.bootMs}ms` : "        "}${C.off}`
      : `${C.blue}in-process${C.off}`;
    say(`${stamp()} ${tier}  ${String(j.ms).padStart(4)}ms  ${C.ink}${j.command.slice(0, 58)}${C.off}`);
    say(`        ${C.dim}${j.reason}${C.off}`);
  }
  seen = lines.length;
}, 60);

const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  PWD: ws, HOME: home, XDG_CONFIG_HOME: home + "/c", XDG_DATA_HOME: home + "/d", XDG_CACHE_HOME: home + "/k",
  SANDROUTE_LOG: log, SANDROUTE_VM: "firecracker", SANDROUTE_IDLE_MS: "700",
  SANDROUTE_FC_BIN: `${A}/firecracker`, SANDROUTE_FC_KERNEL: `${A}/vmlinux-6.1.128`,
  SANDROUTE_FC_ROOTFS: `${A}/rootfs.ext4`, SANDROUTE_FC_SNAPSHOT_DIR: `${A}/snapcache` };

const status = await new Promise<number | null>((resolve) => {
  const c = spawn(path.join(root, "node_modules/.bin/opencode"),
    ["run", "-m", "mock/scripted", "work through the steps"], { cwd: ws, env, stdio: ["ignore", "ignore", "ignore"] });
  c.on("close", resolve);
});
await sleep(3200);   // let the idle window prove it keeps the VM for the server
clearInterval(tail); clearInterval(watch);
mock.close();

const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const vm = entries.filter((e) => e.tier === "vm").length;
const alloc = Math.max(...entries.map((e) => e.vmAllocatedMs));
const turn = Date.now() - t0;
say();
say(`${C.dim}${"─".repeat(78)}${C.off}`);
say(`${C.bold}opencode exited ${status}${C.off}   ${C.dim}·${C.off}   ${entries.length} tool calls, ${vm} needed the machine`);
say(`${C.green}the microVM was allocated ${((alloc / turn) * 100).toFixed(1)}% of the turn${C.off} ${C.dim}(${(alloc/1000).toFixed(1)}s of ${(turn/1000).toFixed(1)}s) — always-on would be 100%${C.off}`);
say(`${C.amber}it is still up right now${C.off} ${C.dim}— a server is running in there, so releasing it would kill it${C.off}`);
say(`${C.dim}workspace: ${ws}${C.off}`);
