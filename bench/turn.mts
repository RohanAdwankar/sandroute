// Is sandroute at parity on the latency the user feels, while actually cutting the
// compute bill? Two numbers, same turn, three configurations.
//
// A turn is tool calls separated by think gaps -- the time the agent spends waiting on
// the model. The gaps are where a session-long VM is allocated and doing nothing.
//
//   --baseline        agent runs inside the VM: every call is a local spawn in the guest,
//                     the VM is allocated for the whole turn. This is what sandroute has
//                     to beat on cost without losing on latency.
//   (default)         sandroute, VM kept once booted
//   --idle <ms>       sandroute, VM released after <ms> with no VM-tier command
//
//   --repeat <n>      a longer turn: the same work, n times over
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandroute, FirecrackerVm } from "../src/index.js";

const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const arg = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? Number(process.argv[i + 1]) : undefined; };
const idleMs = arg("--idle");
const repeat = arg("--repeat") ?? 1;
const baseline = process.argv.includes("--baseline");
const detail = process.argv.includes("--detail");
const WS = "/home/rohan/turn-ws";
const FILES = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(WS, { recursive: true, force: true });
for (let i = 0; i < FILES; i++) {
  const d = path.join(WS, `src/d${Math.floor(i / 50)}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `f${i}.ts`), `export const v${i} = "needle";\n` + "// pad\n".repeat(20));
}

// Light calls are the reading and editing an agent spends most of its calls on. Heavy
// calls cluster, the way a build or a test run does.
const L = (c: string, gap = 3000): [string, number] => [c, gap];
const base: [string, number][] = [
  L("ls src"), L("cat src/d0/f0.ts"), L("grep -rl needle src | head -5"),
  L("sed -i 's/needle/pin/' src/d0/f1.ts"), L("cat src/d0/f1.ts"),
  L("grep -c pin src/d0/f1.ts"),
  L("uname -r", 2000), L("python3 -c 'print(1+1)'", 2000), L("command -v bash", 4000),
  L("cat src/d0/f2.ts"), L("grep -rl needle src | wc -l"),
  L("sed -i 's/needle/pin/' src/d0/f3.ts"), L("cat src/d0/f3.ts"),
  L("ls src/d1"), L("grep -c pin src/d0/f3.ts"),
  L("python3 -c 'print(\"done\")'", 3000),
  L("cat src/d0/f4.ts"), L("ls src/d2"), L("grep -rl pin src | wc -l"), L("cat src/d0/f5.ts"),
];
// --heavy is a turn with real work in it: installing a dependency and running something
// that takes seconds rather than milliseconds. The light list answers "how much of a turn
// is the machine needed for"; this one answers whether that survives commands with weight.
const realWork: [string, number][] = [
  L("ls -la"),
  L(`cat > app.py <<'PY'\nimport requests\nprint("deps ok", requests.__name__)\nPY`),
  L("wc -l app.py"),
  L("python3 -m pip install --quiet --no-warn-script-location requests", 2000),
  L("python3 app.py", 2000),
  L("grep -c requests app.py"),
  L(`sed -i 's/deps ok/dependencies ok/' app.py`),
  L("python3 app.py", 2000),
  L("cat app.py"),
  L("python3 -c \"import requests;print(requests.get('https://pypi.org/simple/', timeout=20).status_code)\""),
];
const turn = Array.from({ length: repeat }, () => (process.argv.includes("--heavy") ? realWork : base)).flat();
turn[turn.length - 1] = [turn[turn.length - 1][0], 0];

const fcOpts = {
  bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`,
  vcpus: 2, memMiB: 1024, snapshotDir: `${A}/snapcache`,
  network: process.env.SANDROUTE_TAP
    ? { tap: process.env.SANDROUTE_TAP, guestIp: process.env.SANDROUTE_GUEST_IP ?? "172.16.0.2/30", gateway: process.env.SANDROUTE_GATEWAY ?? "172.16.0.1" }
    : undefined,
};

let label: string, turnMs: number, callMs: number[], allocMs: number, wakes = 0, wakeMs = 0, heavy = 0;
// A command that fails returns fast, so a broken configuration reads as a quick one.
const failures: string[] = [];
const tiers: string[] = [];

if (baseline) {
  label = "agent inside the VM (always-on)";
  const vm = new FirecrackerVm(fcOpts);
  await vm.boot(WS);
  await vm.exec("true", { cwd: WS }); // push the workspace in: the baseline would already have it
  // The whole turn runs as one guest script, so each call is a plain local spawn with no
  // vsock hop -- which is what it would be if the agent itself lived in here.
  const script = turn.map(([cmd, gap], i) => [
    "T=${EPOCHREALTIME/./}",
    // braces on their own lines, so a command carrying a heredoc survives
    `{\n${cmd}\n} >/dev/null 2>&1`,
    "RC=$?",
    "E=${EPOCHREALTIME/./}",
    `echo "T ${i} $((E-T))"`,
    `echo "X ${i} $RC"`,
    gap ? `sleep ${(gap / 1000).toFixed(3)}` : "",
  ].filter(Boolean).join("\n")).join("\n");
  const t0 = Date.now();
  const r = await vm.exec(script, { cwd: WS });
  turnMs = Date.now() - t0;
  callMs = r.stdout.trim().split("\n").filter((l) => l.startsWith("T ")).map((l) => Number(l.split(" ")[2]) / 1000);
  for (const l of r.stdout.trim().split("\n").filter((l) => l.startsWith("X "))) {
    const [, i, code] = l.split(" ");
    if (code !== "0") failures.push(`${turn[Number(i)][0].split("\n")[0].slice(0, 46)} -> exit ${code}`);
  }
  if (callMs.length !== turn.length) throw new Error(`expected ${turn.length} timings, got ${callMs.length}`);
  for (const _ of turn) tiers.push("guest");
  heavy = turn.length; // every call is served by the VM
  allocMs = turnMs;    // allocated for the whole turn, by definition
  await vm.stop();
} else {
  label = idleMs === undefined ? "sandroute, VM kept for the session" : `sandroute, ${idleMs}ms idle window`;
  const vm = new FirecrackerVm(fcOpts);
  const s = new Sandroute({ workspace: WS, vm, idleMs });
  await vm.boot(WS); await vm.stop(); // prime the snapshot outside the measurement
  callMs = [];
  const t0 = Date.now();
  for (const [cmd, gap] of turn) {
    const r = await s.run(cmd);
    if (r.exitCode !== 0) failures.push(`${cmd.split("\n")[0].slice(0, 46)} -> exit ${r.exitCode}`);
    callMs.push(r.ms);
    tiers.push(r.booted ? "vm+wake" : r.tier);
    if (r.tier === "vm") heavy++;
    if (r.booted) { wakes++; wakeMs += r.bootMs; }
    await sleep(gap);
  }
  turnMs = Date.now() - t0;
  await s.stop();
  allocMs = s.vmAllocatedMs;
}

if (detail) {
  console.log(`# ${label}`);
  turn.forEach(([cmd], i) => console.log(`  ${callMs[i].toFixed(1).padStart(7)}ms  ${tiers[i].padEnd(9)}  ${cmd}`));
  console.log();
}
const sum = callMs.reduce((a, b) => a + b, 0);
const sorted = [...callMs].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(JSON.stringify({
  config: label, baseline, idleMs: idleMs ?? null, repeat,
  calls: turn.length, vmCalls: heavy, wakes, wakeMs,
  turnMs,
  toolLatencyMs: Math.round(sum),
  p50Ms: +pct(0.5).toFixed(2), p95Ms: +pct(0.95).toFixed(2), maxMs: +Math.max(...callMs).toFixed(2),
  vmAllocatedMs: allocMs,
  vmAllocatedPct: +((allocMs / turnMs) * 100).toFixed(1),
  failures,
}, null, 2));
rmSync(WS, { recursive: true, force: true });
