// Record real agent sessions, so the multi-tenant benchmark replays what agents actually
// do rather than what I imagine they do.
//
// Each task is given to a real model through the real opencode, with every tool routed
// through sandroute. What is kept is the sequence of calls, in full, and the time the model
// spent thinking between them -- the latter is what makes a tenant idle.
//
//   npx tsx bench/collect.mts [--models a,b] [--tasks x,y]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const arg = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1].split(",") : undefined; };
const tasks: { id: string; prompt: string }[] = JSON.parse(readFileSync(path.join(root, "bench/tasks.json"), "utf8"));
const models = arg("--models") ?? ["nemotron-3-ultra-free", "mimo-v2.6-flash-free", "big-pickle", "longcat-2.5-preview-free"];
const only = arg("--tasks");
const out = path.join(root, "bench/traces");
mkdirSync(out, { recursive: true });

async function once(task: { id: string; prompt: string }, model: string) {
  const ws = mkdtempSync(path.join(tmpdir(), "trace-ws-")), home = mkdtempSync(path.join(tmpdir(), "trace-home-"));
  // The workspace is the project and nothing else. Everything of ours -- the routing tools,
  // opencode's config, the logs -- lives outside it, because an agent explores what it is
  // given and a recording full of our own plumbing is not how anyone's project looks.
  cpSync(path.join(root, "bench/fixtures/textstats"), ws, { recursive: true });
  const cfg = path.join(home, "c/opencode");
  mkdirSync(path.join(cfg, "tool"), { recursive: true });
  writeFileSync(path.join(cfg, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { "*": "allow" }, autoupdate: false }));
  const abs = (f: string) => readFileSync(path.join(root, f), "utf8").replace("../src/index.ts", path.join(root, "src/index.ts"));
  writeFileSync(path.join(cfg, "shared.ts"), abs("opencode/shared.ts"));
  for (const t of ["bash", "read", "write", "edit", "glob", "grep"]) writeFileSync(path.join(cfg, `tool/${t}.ts`), abs(`opencode/${t}.ts`));
  symlinkSync(path.join(root, "node_modules"), path.join(cfg, "node_modules"));
  const log = path.join(home, "sandroute.log"), trace = path.join(home, "trace.jsonl");
  const env = { ...process.env, PWD: ws, HOME: home, XDG_CONFIG_HOME: home + "/c", XDG_DATA_HOME: home + "/d", XDG_CACHE_HOME: home + "/k",
    SANDROUTE_LOG: log, SANDROUTE_TRACE: trace, SANDROUTE_VM: "firecracker", SANDROUTE_IDLE_MS: "700", SANDROUTE_TAP: "sr-tap0",
    SANDROUTE_FC_BIN: `${A}/firecracker`, SANDROUTE_FC_KERNEL: `${A}/vmlinux-6.1.128`, SANDROUTE_FC_ROOTFS: `${A}/rootfs.ext4`, SANDROUTE_FC_SNAPSHOT_DIR: `${A}/snapcache` };
  const t0 = Date.now();
  const code = await new Promise<number | null>((resolve) => {
    const c = spawn(path.join(root, "node_modules/.bin/opencode"), ["run", "-m", `opencode/${model}`, task.prompt], { cwd: ws, env, stdio: "ignore" });
    const k = setTimeout(() => c.kill("SIGKILL"), 180000);
    c.on("close", (x) => { clearTimeout(k); resolve(x); });
  });
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const tr = lines(trace), lg = lines(log).filter((l) => l.command);
  // the trace and the routing log hold one entry per call, in the same order
  const calls = tr.map((c, i) => ({
    tool: c.tool, args: c.args,
    thinkMs: i === 0 ? null : c.t - (tr[i - 1].t + (lg[i - 1]?.ms ?? 0)),
    origMs: lg[i]?.ms ?? null, origTier: lg[i]?.tier ?? null,
  }));
  const rec = { task: task.id, prompt: task.prompt, model, exit: code, wallMs: Date.now() - t0, workspace: ws, calls };
  // a turn that stalled or errored is not how a person uses an agent, so it is not kept
  if (code === 0 && calls.length > 0) writeFileSync(path.join(out, `${task.id}__${model}.json`), JSON.stringify(rec, null, 1));
  const vm = calls.filter((c) => c.origTier === "vm").length;
  console.log(`${task.id.padEnd(9)} ${model.padEnd(26)} exit=${String(code).padEnd(4)} ${(rec.wallMs / 1000).toFixed(0).padStart(4)}s  ${String(calls.length).padStart(2)} calls, ${vm} needed the machine${code === 0 ? "" : "   (discarded)"}`);
  return calls.length;
}

for (const task of tasks) {
  if (only && !only.includes(task.id)) continue;
  for (const model of models) {
    if (existsSync(path.join(out, `${task.id}__${model}.json`))) continue;   // already recorded
    // the free tier throws server errors now and then; a run that failed at once is retried
    const t = Date.now();
    if ((await once(task, model)) === 0 && Date.now() - t < 60000) { await new Promise((r) => setTimeout(r, 5000)); await once(task, model); }
  }
}
