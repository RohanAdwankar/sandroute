// How many tenants can one machine serve, when the tenants behave like people?
//
// People are mostly away. A tenant is idle for minutes, hands the agent a task, and the agent
// works for a while: a few tool calls separated by the seconds the model takes to think. This
// replays that. Each task is a real recorded agent session (see collect.mts): the same calls
// and the same think times, against a workspace that starts as the same small project.
//
// Three ways to give each tenant a sandbox, all through the same Sandroute class:
//   kept      a microVM per tenant, booted up front and never released. The simple thing.
//   suspend   a microVM per tenant, snapshotted to disk after an idle window and restored on
//             the next command. The strongest alternative that keeps every tenant isolated.
//   oxroute   fixed utilities run in a per-command namespace sandbox with no VM at all, and a
//             microVM only for the commands that need one, suspended the same way.
//
//   npx tsx bench/tenants.mts --design oxroute --tenants 64 --minutes 6
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FirecrackerVm } from "../src/firecracker.js";
import { Sandbox } from "../src/sandbox.js";
import { Sandroute } from "../src/sandroute.js";

const arg = (f: string, d: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const design = arg("--design", "oxroute") as "kept" | "suspend" | "oxroute";
const N = Number(arg("--tenants", "16"));
const minutes = Number(arg("--minutes", "6"));
const idleMean = Number(arg("--idle-mean", "120"));        // seconds a person is away between tasks
const windowMs = Number(arg("--window", "30000"));         // how long a microVM sits idle before it is suspended
const memMiB = Number(arg("--mem", "256"));
const seed = Number(arg("--seed", "1"));
const tracesDir = arg("--traces", path.resolve(import.meta.dirname, "traces"));
const sloP99 = Number(arg("--slo-p99", "1500"));          // ms
const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const RUN = "/home/rohan/tenant-run";
const pristineDir = `${A}/pristine-tenants`;
const fixture = path.resolve(import.meta.dirname, "fixtures/textstats");

// ---- the people ---------------------------------------------------------------------------
const rng = (() => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
// away times are long-tailed: mostly a minute or two, sometimes much longer
const awaySec = () => { const sigma = 0.8; return Math.exp(Math.log(idleMean) - (sigma * sigma) / 2 + sigma * normal()); };

type Call = { tool: string; args: any; thinkMs: number | null; idx: number };
type Trace = { id: string; workspace: string; calls: Call[] };
const traces: Trace[] = readdirSync(tracesDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(tracesDir, f), "utf8")))
  .filter((r) => r.exit === 0 && r.calls.length > 0).map((r) => ({ id: `${r.task}/${r.model}`, workspace: r.workspace, calls: r.calls.map((c: any, idx: number) => ({ tool: c.tool, args: c.args, thinkMs: c.thinkMs, idx })) }));
// A recording may touch a path outside the project, such as the agent's own skills directory.
// No tenant has that, so those calls cannot be replayed and are left out.
const inProject = (t: Trace, c: Call) => c.tool === "bash" || !(typeof (c.args.filePath ?? c.args.path) === "string") || String(c.args.filePath ?? c.args.path).startsWith(t.workspace);
for (const t of traces) t.calls = t.calls.filter((c) => inProject(t, c));
if (!traces.length) throw new Error(`no usable traces in ${tracesDir}`);
const rewrite = (t: Trace, c: Call): Call => ({ ...c, args: JSON.parse(JSON.stringify(c.args).replaceAll(t.workspace, "/work")) });
const medianThink = (t: Trace) => { const x = t.calls.map((c) => c.thinkMs).filter((v): v is number => v !== null).sort((a, b) => a - b); return x.length ? x[Math.floor(x.length / 2)] : 3000; };

// ---- the sandboxes ------------------------------------------------------------------------
rmSync(RUN, { recursive: true, force: true }); mkdirSync(`${RUN}/tenants`, { recursive: true });
const vmFor = (i: number) => new FirecrackerVm({
  bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`, vcpus: 1, memMiB,
  snapshotDir: `${pristineDir}`, sessionDir: `${RUN}/sessions/${i}`, guestWorkspace: "/work",
});
function sandboxFor(i: number, ws: string): Sandroute {
  const common = { workspace: ws, workspacePath: "/work", vm: vmFor(i) };
  if (design === "oxroute") return new Sandroute({ ...common, idleMs: windowMs, light: new Sandbox({ workspace: ws, mountAt: "/work" }) });
  return new Sandroute({ ...common, allInVm: true, idleMs: design === "suspend" ? windowMs : undefined });
}

// ---- what is measured ---------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const meminfo = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(readFileSync("/proc/meminfo", "utf8"))![1]) / 1024;
// Only this run's own microVMs: the machine may be running others, and they are not ours to count.
const ownChildren = (name: string) => readdirSync("/proc").filter((p) => /^\d+$/.test(p) && (() => {
  try {
    const stat = readFileSync(`/proc/${p}/stat`, "utf8");
    return stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) === name && Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === process.pid;
  } catch { return false; }
})());
const pss = (pid: string) => { try { return Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))![1]) / 1024; } catch { return 0; } };
// CPU a process has used so far, in clock ticks, so the sampler can say who is using the machine
const ticks = (pid: string | number) => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8"); const r = f.slice(f.lastIndexOf(")") + 2).split(" "); return Number(r[11]) + Number(r[12]); } catch { return 0; } };
const cpuNow = () => readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1, 9).map(Number);
const dirBytes = (d: string): number => { if (!existsSync(d)) return 0; let n = 0; for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : statSync(p).blocks * 512; } return n; };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

type Rec = { tenant: number; tool: string; tier: string; ms: number; woke: boolean; err?: string; at: number; ownMs: number };

// How long each call takes with nothing else going on, found by --calibrate. A command can be
// slow because it is: an agent waiting on something runs a sleep, and that wait is the same
// under every design. What a design adds is the time above this, so that is what is judged.
const intrinsicFile = path.join(tracesDir, "intrinsic.json");
const intrinsic: Record<string, number> = existsSync(intrinsicFile) ? JSON.parse(readFileSync(intrinsicFile, "utf8")) : {};
const recs: Rec[] = [];
const samples: any[] = [];
let activeTurns = 0, aborted: string | undefined, stopping = false;
const turns: number[] = [];

async function perform(s: Sandroute, c: Call): Promise<string> {
  const a = c.args;
  switch (c.tool) {
    case "bash": return (await s.run(a.command, a.workdir)).tier;
    case "read": await s.readFile(a.filePath, { offset: a.offset, limit: a.limit }); break;
    case "write": await s.writeFile(a.filePath, a.content); break;
    case "edit": await s.editFile(a.filePath, a.oldString, a.newString, a.replaceAll); break;
    case "glob": await s.glob(a.pattern, a.path); break;
    case "grep": await s.grepFiles(a.pattern, a.path, a.include); break;
    default: throw new Error(`unknown tool ${c.tool}`);
  }
  return design === "oxroute" ? "inprocess" : "vm";
}

// A recorded task assumes the project as it was when recording began, so each task starts from
// a fresh copy. The platform does this on the host, for every design alike; a microVM's copy
// catches up through the ordinary sync.
const fresh = (ws: string) => { for (const e of readdirSync(ws)) rmSync(path.join(ws, e), { recursive: true, force: true }); cpSync(fixture, ws, { recursive: true }); };

async function tenant(i: number, s: Sandroute, endAt: number, ws: string) {
  const until = (ms: number) => sleep(Math.max(0, Math.min(ms, endAt - Date.now())));   // nobody sleeps past the end
  await until(rng() * idleMean * 1000);                       // tenants do not all start together
  while (!stopping && Date.now() < endAt) {
    const t = traces[Math.floor(rng() * traces.length)];
    fresh(ws);
    const t0 = Date.now();
    activeTurns++;
    for (let k = 0; k < t.calls.length && !stopping; k++) {
      const c = rewrite(t, t.calls[k]);
      await sleep(Math.min(60000, Math.max(200, c.thinkMs ?? medianThink(t))));   // the model thinking
      const boots = s.bootCount, a = Date.now();
      let tier = "?", err: string | undefined;
      try { tier = await Promise.race([perform(s, c), sleep(60000).then(() => { throw new Error("timed out after 60s"); })]); }
      catch (e) { err = (e as Error).message.split("\n")[0].slice(0, 100); }
      recs.push({ tenant: i, tool: c.tool, tier, ms: Date.now() - a, woke: s.bootCount > boots, err, at: Math.round((a - startedAt) / 1000), ownMs: intrinsic[`${t.id}#${c.idx}`] ?? 0 });
    }
    activeTurns--;
    turns.push(Date.now() - t0);
    await until(awaySec() * 1000);                            // the person is away
  }
}

// ---- run ----------------------------------------------------------------------------------
const baseMem = meminfo("MemAvailable");
let startedAt = Date.now();
if (!existsSync(`${pristineDir}`) || !readdirSync(pristineDir).some((f) => f.endsWith(".mem"))) {
  const warm = vmFor(-1); await warm.boot(`${RUN}/tenants/warm`).catch(() => {}); await warm.stop();
}
const sbs: Sandroute[] = [];
for (let i = 0; i < N; i++) {
  const ws = `${RUN}/tenants/t${i}`; cpSync(fixture, ws, { recursive: true });
  sbs.push(sandboxFor(i, ws));
}
if (design === "kept") for (let i = 0; i < N; i += 8) await Promise.all(sbs.slice(i, i + 8).map((s) => s.run("true")));   // every tenant's machine is up from the start

if (process.argv.includes("--calibrate")) {
  // one tenant, no think time, no one else: the cost of the calls themselves
  const found: Record<string, number> = {};
  for (const t of traces) {
    fresh(`${RUN}/tenants/t0`);
    for (const call of t.calls) {
      const a = Date.now();
      try { await perform(sbs[0], rewrite(t, call)); } catch { /* a failed call still has a duration */ }
      found[`${t.id}#${call.idx}`] = Date.now() - a;
    }
  }
  writeFileSync(intrinsicFile, JSON.stringify(found, null, 1));
  const v = Object.values(found).sort((x, y) => x - y);
  console.log(`calibrated ${v.length} calls: median ${v[Math.floor(v.length / 2)]}ms, p95 ${v[Math.floor(v.length * 0.95)]}ms, longest ${v[v.length - 1]}ms`);
  await sbs[0].stop(); rmSync(RUN, { recursive: true, force: true }); process.exit(0);
}

startedAt = Date.now();
const endAt = startedAt + minutes * 60_000;
let prevCpu = cpuNow(), prevSelf = ticks(process.pid), prevFc = new Map<string, number>();
const sampler = setInterval(() => {
  const cpu = cpuNow(), d = cpu.map((v, k) => v - prevCpu[k]), tot = d.reduce((a, b) => a + b, 0) || 1; prevCpu = cpu;
  const fc = ownChildren("firecracker");
  // percent of one core, for this harness and for its microVMs (those still alive)
  const self = ticks(process.pid), selfPct = self - prevSelf; prevSelf = self;
  let fcPct = 0; const nowFc = new Map<string, number>(); for (const p of fc) { const t = ticks(p); nowFc.set(p, t); fcPct += t - (prevFc.get(p) ?? t); } prevFc = nowFc;
  const free = meminfo("MemAvailable"), diskFree = (() => { const f = statfsSync(RUN); return (f.bavail * f.bsize) / 2 ** 30; })();
  const row = { t: Math.round((Date.now() - startedAt) / 1000), memAvailMiB: Math.round(free), fcCount: fc.length, fcPssMiB: Math.round(fc.reduce((a, p) => a + pss(p), 0)),
    cpuBusy: +(100 * (1 - (d[3] + d[4]) / tot)).toFixed(1), harnessCore: selfPct, microVMCores: +(fcPct / 100).toFixed(2), iowait: +(100 * d[4] / tot).toFixed(1), load1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
    diskFreeGiB: +diskFree.toFixed(1), sessionsGiB: +(dirBytes(`${RUN}/sessions`) / 2 ** 30).toFixed(2), active: activeTurns };
  samples.push(row);
  if (!aborted && (free < 300 || diskFree < 6)) { aborted = free < 300 ? `memory: ${Math.round(free)} MiB left` : `disk: ${diskFree.toFixed(1)} GiB left`; stopping = true; }
}, 1000);

await Promise.all(sbs.map((s, i) => tenant(i, s, endAt, `${RUN}/tenants/t${i}`)));
clearInterval(sampler);
const wall = (Date.now() - startedAt) / 1000;
await Promise.all(sbs.map((s) => s.stop()));
const leftover = ownChildren("firecracker").length;

// ---- report -------------------------------------------------------------------------------
// Some calls are slow because the command is: an agent waiting on something runs a sleep, and
// that wait is the same under every design. A latency target is judged on the calls the original
// agent saw finish in under a second, so what it measures is the sandbox and not the command.
const lat = recs.map((r) => Math.max(0, r.ms - r.ownMs)), woke = recs.filter((r) => r.woke).map((r) => Math.max(0, r.ms - r.ownMs)), errs = recs.filter((r) => r.err);
const max = (k: string) => Math.max(...samples.map((s) => s[k]), 0);
const mean = (k: string) => samples.length ? samples.reduce((a, s) => a + s[k], 0) / samples.length : 0;
const result = {
  design, tenants: N, minutes, idleMeanSec: idleMean, windowMs, memMiB, seed, wallSec: Math.round(wall), aborted: aborted ?? null,
  turns: turns.length, calls: recs.length, errors: errs.length, errorSample: [...new Set(errs.map((e) => `${e.tool}: ${e.err}`))].slice(0, 5),
  observedDutyCycle: +(turns.reduce((a, b) => a + b, 0) / 1000 / (N * wall)).toFixed(3),
  // what the design added to each call: its time less the same call's calibrated time
  latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: Math.max(...lat, 0), calls: lat.length },
  callsThatWokeAVm: { n: woke.length, p50: pct(woke, 0.5), p95: pct(woke, 0.95), p99: pct(woke, 0.99) },
  slowest: [...recs].sort((a, b) => (b.ms - b.ownMs) - (a.ms - a.ownMs)).slice(0, 6).map((r) => ({ addedMs: r.ms - r.ownMs, ms: r.ms, tool: r.tool, tier: r.tier, wokeAVm: r.woke, tenant: r.tenant, atSec: r.at })),
  tiers: Object.fromEntries([...new Set(recs.map((r) => r.tier))].map((t) => [t, recs.filter((r) => r.tier === t).length])),
  wakes: sbs.reduce((a, s) => a + s.bootCount, 0), suspends: sbs.reduce((a, s) => a + s.releaseCount, 0),
  peak: { microVMs: max("fcCount"), vmPssMiB: max("fcPssMiB"), activeTurns: max("active"), sessionsGiB: max("sessionsGiB"), cpuBusy: max("cpuBusy"), iowait: max("iowait"), load1: max("load1") },
  mean: { microVMs: +mean("fcCount").toFixed(1), harnessPctOfACore: Math.round(mean("harnessCore")), microVMCores: +mean("microVMCores").toFixed(2), vmPssMiB: Math.round(mean("fcPssMiB")), cpuBusy: +mean("cpuBusy").toFixed(1) },
  memAvailableMiB: { start: Math.round(baseMem), min: Math.min(...samples.map((s) => s.memAvailMiB)) },
  leakedMicroVMs: leftover,
  slo: { p99Ms: sloP99, met: !aborted && errs.every((e) => !/firecracker|guest agent|vsock|timed out/.test(e.err ?? "")) && pct(lat, 0.99) <= sloP99 },
};
mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
const name = `${design}-n${N}-w${windowMs}-i${idleMean}-s${seed}`;
writeFileSync(path.join(import.meta.dirname, "results", `${name}.json`), JSON.stringify({ ...result, samples }, null, 1));
console.log(`${name.padEnd(30)} calls ${String(result.calls).padStart(4)}  p50 ${String(result.latencyMs.p50).padStart(4)}  p95 ${String(result.latencyMs.p95).padStart(5)}  p99 ${String(result.latencyMs.p99).padStart(5)}ms  ` +
  `VMs peak ${String(result.peak.microVMs).padStart(3)} (${result.peak.vmPssMiB} MiB)  disk ${result.peak.sessionsGiB} GiB  cpu ${result.mean.cpuBusy}%/${result.peak.cpuBusy}%  err ${result.errors}  ${result.slo.met ? "SLO met" : aborted ? `ABORTED ${aborted}` : "SLO missed"}`);
rmSync(RUN, { recursive: true, force: true });
