// A demo of unmodified opencode doing an ordinary job inside the sandbox.
//
// opencode is the real binary and knows nothing about any of this -- it just calls its
// bash tool, which has been overridden by opencode/bash.ts.
//
// A real model picks every command. There is deliberately no scripted mode: a demo whose
// point is "watch what actually happens" cannot have the commands chosen in advance, and
// a fixed list reads as an agent deciding when it is nothing of the sort. Scripting
// belongs in e2e/run.mts, which is a routing test, and bench/turn.mts, which is a
// benchmark -- both need a fixed workload, and neither pretends to be an agent.
//
//   npm run demo                      opencode/big-pickle, free, no key
//   DEMO_MODEL=opencode/x npm run demo
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const ws = mkdtempSync(path.join(tmpdir(), "todo-"));
const home = mkdtempSync(path.join(tmpdir(), "demo-home-"));
const log = path.join(ws, "sandroute.log");

const C = { dim: "\x1b[38;5;245m", ink: "\x1b[38;5;252m", blue: "\x1b[38;5;75m",
            amber: "\x1b[38;5;215m", green: "\x1b[38;5;114m", red: "\x1b[38;5;203m",
            bold: "\x1b[1m", off: "\x1b[0m" };
let t0 = Date.now();
const stamp = () => `${C.dim}${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${C.off}`;
const say = (s = "") => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

writeFileSync(path.join(ws, "README.md"), "# scratch\n\nnothing here yet\n");
// The kind of note a real repo carries. The guest has no network, so without saying so a
// model burns its turn trying to pip install something.
writeFileSync(path.join(ws, "AGENTS.md"),
  "# notes for agents\n\n" +
  "- Python 3 standard library only. The sandbox has no network, so nothing can be installed.\n" +
  "- Use the bash tool for everything, one command per step.\n");
mkdirSync(path.join(ws, ".opencode/tool"), { recursive: true });
writeFileSync(path.join(ws, ".opencode/tool/bash.ts"),
  readFileSync(path.join(root, "opencode/bash.ts"), "utf8").replace("../src/index.ts", path.join(root, "src/index.ts")));
symlinkSync(path.join(root, "node_modules"), path.join(ws, "node_modules"));

const APP = `import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "todos.json")

def load():
    return json.load(open(STORE)) if os.path.exists(STORE) else []

def save(items):
    json.dump(items, open(STORE, "w"), indent=2)

def serve(port):
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            rows = "".join("<li>%s</li>" % t["text"] for t in load())
            page = ("<h1>todo</h1><ul>%s</ul>" % rows).encode()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
        def log_message(self, *a):
            pass
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()

cmd = sys.argv[1]
if cmd == "add":
    items = load(); items.append({"text": sys.argv[2]}); save(items)
    print("added:", sys.argv[2])
elif cmd == "list":
    for i, t in enumerate(load(), 1):
        print("%d. %s" % (i, t["text"]))
elif cmd == "serve":
    serve(int(sys.argv[2]))`;

// Only the bash tool is routed through sandroute -- opencode's own write/read/edit tools
// touch the host directly -- so the prompt asks for bash. That is a real limit of the
// current design, not a stage direction.
const PROMPT = "make me a little todo app in todo.py, put a couple of things in it, then serve it on port 8099. use the bash tool for everything, one command per step.";
const MODEL = process.env.DEMO_MODEL ?? "opencode/big-pickle";
writeFileSync(path.join(ws, "opencode.json"), JSON.stringify(
  { $schema: "https://opencode.ai/config.json", permission: { "*": "allow" }, autoupdate: false }, null, 2));

say(`${C.bold}${C.ink}sandroute${C.off} ${C.dim}— unmodified opencode, routed between an in-process shell and a Firecracker microVM${C.off}`);
say(`${C.dim}700ms idle window · opencode ${execFileSync(path.join(root, "node_modules/.bin/opencode"), ["--version"]).toString().trim()} · live model ${MODEL}, which chooses every command below${C.off}`);
say();
{
  const { FirecrackerVm } = await import("../src/index.js");
  const warm = new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`,
    rootfs: `${A}/rootfs.ext4`, snapshotDir: `${A}/snapcache` });
  const t = Date.now();
  await warm.boot(ws); await warm.stop();
  say(`${C.dim}snapshot primed in ${((Date.now() - t) / 1000).toFixed(1)}s — once, ahead of the session${C.off}`);
}
say();
say(`${C.bold}${C.green}> ${PROMPT}${C.off}`);
say();

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

const show = (cmd: string) => {
  const ls = cmd.split("\n");
  return ls.length > 1 ? `${ls[0]} … (${ls.length} lines)` : ls[0].slice(0, 62);
};
let seen = 0;
const tail = setInterval(() => {
  if (!existsSync(log)) return;
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  for (const l of lines.slice(seen)) {
    const j = JSON.parse(l);
    if (seen === 0 && lines.indexOf(l) === 0) t0 = Date.now() - j.ms;
    const tier = j.tier === "vm"
      ? `${C.amber}vm${j.booted ? ` wake ${j.bootMs}ms` : "        "}${C.off}`
      : `${C.blue}in-process${C.off}`;
    say(`${stamp()} ${tier}  ${String(j.ms).padStart(4)}ms  ${C.ink}${show(j.command)}${C.off}`);
    say(`        ${C.dim}${j.reason}${C.off}`);
  }
  seen = lines.length;
}, 60);

const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  PWD: ws, HOME: home, XDG_CONFIG_HOME: home + "/c", XDG_DATA_HOME: home + "/d", XDG_CACHE_HOME: home + "/k",
  SANDROUTE_LOG: log, SANDROUTE_VM: "firecracker", SANDROUTE_IDLE_MS: "700",
  SANDROUTE_FC_BIN: `${A}/firecracker`, SANDROUTE_FC_KERNEL: `${A}/vmlinux-6.1.128`,
  SANDROUTE_FC_ROOTFS: `${A}/rootfs.ext4`, SANDROUTE_FC_SNAPSHOT_DIR: `${A}/snapcache` };

let reply = "";
const status = await new Promise<number | null>((resolve) => {
  const c = spawn(path.join(root, "node_modules/.bin/opencode"),
    ["run", "-m", MODEL, PROMPT], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
  const kill = setTimeout(() => c.kill("SIGKILL"), 420000);
  c.on("close", () => clearTimeout(kill));
  c.stdout.on("data", (d) => (reply += d));
  c.on("close", resolve);
});
await sleep(2400);
clearInterval(tail); clearInterval(watch);

const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const vm = entries.filter((e) => e.tier === "vm").length;
const alloc = Math.max(...entries.map((e) => e.vmAllocatedMs));
// measured across the tool calls themselves, so a model that stalls or a kill does not
// get counted as turn time
const first = entries[0], lastEntry = entries[entries.length - 1];
const turn = Date.parse(lastEntry.t) - (Date.parse(first.t) - first.ms) + 2400;
say();
const last = reply.trim().split("\n").filter(Boolean).pop() ?? "";
say(`${C.ink}${last.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 86)}${C.off}`);
say();
say(`${C.dim}${"─".repeat(86)}${C.off}`);
say(`${C.bold}opencode exited ${status === null ? "on a timeout" : status}${C.off}  ${C.dim}·${C.off}  ${entries.length} tool calls, ${vm} of them needed the machine`);
say(`${C.green}the microVM was allocated ${((alloc / turn) * 100).toFixed(0)}% of the turn${C.off} ${C.dim}(${(alloc / 1000).toFixed(1)}s of ${(turn / 1000).toFixed(1)}s) — always-on would be 100%${C.off}`);
if (vmUp()) say(`${C.amber}it is still up now${C.off} ${C.dim}— something is running in there, so releasing it would kill it${C.off}`);
// the guest wrote this file; the host has it because the sync brought it back
if (existsSync(path.join(ws, "todos.json")))
  say(`${C.dim}todos.json, on the host:${C.off} ${C.ink}${readFileSync(path.join(ws, "todos.json"), "utf8").replace(/\s+/g, " ").trim().slice(0, 74)}${C.off}`);
say(`${C.dim}workspace: ${ws}${C.off}`);
