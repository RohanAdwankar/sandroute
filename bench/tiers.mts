// What one command costs in each place it can run: on the host with nothing around it, in the light sandbox, in a warm Firecracker VM, and
// through a wake. Medians and 95th percentiles of 60 runs each; the project has 300 small files so find and grep have work to do.
//   npx tsx bench/tiers.mts
import { FirecrackerVm } from "/home/rohan/sandroute/src/firecracker.ts";
import { Sandbox } from "/home/rohan/sandroute/src/sandbox.ts";
import { Sandroute } from "/home/rohan/sandroute/src/sandroute.ts";
import { spawnSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
const A = "/home/rohan/fcassets", fixture = "/home/rohan/sandroute/bench/fixtures/textstats";
const ws = mkdtempSync("/tmp/tiers-"); cpSync(fixture, ws, { recursive: true });
// a project with enough files for find and grep to have something to do
for (let i = 0; i < 300; i++) { mkdirSync(`${ws}/pkg/m${i % 20}`, { recursive: true }); writeFileSync(`${ws}/pkg/m${i % 20}/f${i}.py`, `def fn${i}(x):\n    return x * ${i}\n`.repeat(20)); }
const CMDS: Record<string, string> = {
  "ls": "ls",
  "cat a file": "cat textstats.py",
  "grep -rn across 300 files": "grep -rn 'def fn1' pkg | wc -l",
  "find and sort": "find pkg -name '*.py' | sort | tail -3",
  "python startup": "python3 -c 'print(1)'",
  "python, 85 ms of cpu": "python3 -c 'sum(i*i for i in range(2_000_000))'",
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const N = 60;
const native = (c: string) => new Promise<void>((r) => { const p = spawn("bash", ["-c", c], { cwd: ws, stdio: "ignore" }); p.on("close", () => r()); });
const sb = new Sandbox({ workspace: ws, mountAt: "/work" });
const light = (c: string) => sb.exec(c).then(() => {});
const vm = new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`, vcpus: 1, memMiB: 256, snapshotDir: `${A}/pristine-tenants`, sessionDir: "/tmp/tiers-s", guestWorkspace: "/work" });
const t0 = Date.now(); await vm.boot(ws); const firstBoot = Date.now() - t0;
const inVm = (c: string) => vm.exec(c, { cwd: "/work" }).then(() => {});
async function time(f: (c: string) => Promise<void>, c: string) { const out: number[] = []; for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); await f(c); out.push(Number(process.hrtime.bigint() - t) / 1e6); } return out; }
await inVm("true"); for (const f of [native, light, inVm]) await f("true");   // warm everything
console.log("median ms per command (p95 in brackets)");
console.log("command".padEnd(28), "host native".padEnd(16), "light sandbox".padEnd(16), "firecracker (warm)".padEnd(18));
for (const [name, c] of Object.entries(CMDS)) {
  const row: string[] = [];
  for (const f of [native, light, inVm]) { const x = await time(f, c); row.push(`${pct(x, .5).toFixed(1)} (${pct(x, .95).toFixed(1)})`.padEnd(16)); }
  console.log(name.padEnd(28), ...row);
}
await vm.stop();
// a wake: release a VM that holds nothing, then run one command, through the whole Sandroute path
const wakes: number[] = [], lightAfter: number[] = [];
const vm2 = new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`, vcpus: 1, memMiB: 256, snapshotDir: `${A}/pristine-tenants`, sessionDir: "/tmp/tiers-s2", guestWorkspace: "/work" });
const s = new Sandroute({ workspace: ws, workspacePath: "/work", vm: vm2, light: new Sandbox({ workspace: ws, mountAt: "/work" }) });
for (let i = 0; i < 25; i++) {
  let t = process.hrtime.bigint(); const r = await s.run("python3 -c 'print(1)'"); wakes.push(Number(process.hrtime.bigint() - t) / 1e6);
  if (i === 0 && !r.booted) throw new Error("expected a boot");
  await s.release();
}
console.log(`\nwake: release the VM, then run 'python3 -c print(1)' (restore + sync + command): median ${pct(wakes.slice(1), .5).toFixed(0)} ms, p95 ${pct(wakes.slice(1), .95).toFixed(0)} ms; the first restore, with its snapshot already primed, ${firstBoot} ms`);
await s.stop(); rmSync(ws, { recursive: true, force: true });
process.exit(0);
