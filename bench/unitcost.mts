// What does one suspended tenant cost, and how does suspending scale?
//
// The strongest alternative to routing is a microVM per tenant that is snapshotted to disk
// when idle. It holds no RAM while idle, so what bounds it is the disk each snapshot takes
// and the CPU and bandwidth spent writing and reading them. This prices both.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { FirecrackerVm } from "../src/firecracker.js";

const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const base = `${A}/uc`;
const mk = (i: number) => {
  const ws = `/home/rohan/uc-ws-${i}`; rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  return { ws, vm: new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`, vcpus: 1, memMiB: 512, snapshotDir: `${base}/s${i}` }) };
};
const ms = async (f: () => Promise<unknown>) => { const t = process.hrtime.bigint(); await f(); return Number(process.hrtime.bigint() - t) / 1e6; };
const du = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("session-")).map((f) => { const s = statSync(path.join(dir, f)); return { f, apparent: s.size / 2 ** 20, onDisk: (s.blocks * 512) / 2 ** 20 }; });
const evict = (dir: string) => { for (const f of readdirSync(dir)) execFileSync("python3", ["-c", "import os,sys;fd=os.open(sys.argv[1],os.O_RDONLY);os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)", path.join(dir, f)]); };

// one tenant, in detail
const one = mk(0);
await one.vm.boot(one.ws);
await one.vm.exec(`python3 -c "x=bytearray(60*1024*1024); print(len(x))"`, { cwd: one.ws });   // some real working set
const suspend = await ms(() => one.vm.suspend());
const files = du(`${base}/s0`);
console.log(`suspend, one tenant                : ${suspend.toFixed(0)}ms`);
for (const f of files) console.log(`  ${f.f.slice(-9).padStart(9)}  apparent ${f.apparent.toFixed(0)} MiB, actually on disk ${f.onDisk.toFixed(0)} MiB`);
const warm = await ms(async () => { await one.vm.boot(one.ws); await one.vm.exec("true", { cwd: one.ws }); });
console.log(`resume, page cache warm            : ${warm.toFixed(0)}ms to first command`);
await one.vm.suspend();
evict(`${base}/s0`);
const cold = await ms(async () => { await one.vm.boot(one.ws); await one.vm.exec("true", { cwd: one.ws }); });
console.log(`resume, snapshot evicted from cache: ${cold.toFixed(0)}ms to first command`);
await one.vm.stop();

// several at once: what four cores do to suspend and resume
for (const k of [1, 2, 4, 8]) {
  const ts = Array.from({ length: k }, (_, i) => mk(i + 1));
  await Promise.all(ts.map(async (t) => { await t.vm.boot(t.ws); await t.vm.exec(`python3 -c "x=bytearray(60*1024*1024)"`, { cwd: t.ws }); }));
  const sWall = await ms(() => Promise.all(ts.map((t) => t.vm.suspend())));
  const rWall = await ms(() => Promise.all(ts.map(async (t) => { await t.vm.boot(t.ws); await t.vm.exec("true", { cwd: t.ws }); })));
  console.log(`${String(k).padStart(2)} at once: suspend all ${sWall.toFixed(0).padStart(5)}ms (${(sWall).toFixed(0)}ms for the slowest), resume all ${rWall.toFixed(0).padStart(5)}ms`);
  await Promise.all(ts.map((t) => t.vm.stop()));
  for (const t of ts) rmSync(t.ws, { recursive: true, force: true });
}
rmSync(base, { recursive: true, force: true });
