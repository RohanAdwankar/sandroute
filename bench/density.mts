// What does one session cost while it sits there?
//
// The in-process tier buys nothing per command -- a microVM spawns processes at host
// speed. What it buys is sessions that never need a machine at all, so the question worth
// measuring is what a session occupies, not how fast a command runs.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandroute, FirecrackerVm } from "../src/index.js";

const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const mib = (kb: number) => kb / 1024;
const rssOf = (pid: number) => {
  const s = readFileSync(`/proc/${pid}/status`, "utf8");
  const g = (k: string) => Number(/^\s*(\d+)/.exec(s.split(`${k}:`)[1] ?? "")?.[1] ?? 0);
  return { rss: mib(g("VmRSS")), virt: mib(g("VmSize")) };
};
const fcPids = () => execSync("pgrep -x firecracker || true").toString().trim().split("\n").filter(Boolean).map(Number);

const ws = "/home/rohan/densws";
rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
for (let i = 0; i < 200; i++) writeFileSync(path.join(ws, `f${i}.ts`), `export const v${i} = 1;\n`);

const before = rssOf(process.pid).rss;
const light = new Sandroute({ workspace: ws });
await light.run("grep -rl 'v1' . | head -3");          // load the interpreter and touch the fs
const afterLight = rssOf(process.pid).rss;
const perSession = afterLight - before;
console.log(`host process, one in-process session : ${(afterLight - before).toFixed(1)} MiB added (process total ${afterLight.toFixed(0)} MiB)`);

const vm = new FirecrackerVm({
  bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`,
  vcpus: 2, memMiB: 1024, snapshotDir: `${A}/snapcache`,
  network: process.env.SANDROUTE_TAP
    ? { tap: process.env.SANDROUTE_TAP, guestIp: process.env.SANDROUTE_GUEST_IP ?? "172.16.0.2/30", gateway: process.env.SANDROUTE_GATEWAY ?? "172.16.0.1" }
    : undefined,
});
await vm.boot(ws);
const pid = fcPids()[0];
const step = async (label: string, cmd?: string) => {
  if (cmd) await vm.exec(cmd, { cwd: ws });
  const { rss } = rssOf(pid);
  console.log(`  ${label.padEnd(38)} ${rss.toFixed(0)} MiB`);
  return rss;
};
console.log("\nthe same session in a microVM:");
const booted = await step("restored");
const installed = process.env.SANDROUTE_TAP
  ? await step("after installing a dependency", "python3 -m pip install --quiet --no-warn-script-location requests")
  : booted;
const peak = await step("after a 200MiB allocation", 'python3 -c "x=bytearray(200*1024*1024); print(len(x))"');
const after = await step("after that process exited", "true");
await vm.stop();
rmSync(ws, { recursive: true, force: true });

console.log(`\nGuest memory is never handed back: ${after.toFixed(0)} MiB still resident after the`);
console.log("process that allocated it exited. A VM holds its high-water mark for its whole life,");
console.log("so releasing it is the only way to get that back.\n");
for (const [label, perVm] of [["idle", booted], ["after an install", installed], ["after a peak", after]] as const) {
  const line = [16, 64, 256].map((gb) => {
    const host = gb * 1024;
    return `${gb}GiB: ${Math.floor(host / perVm)} vs ${Math.floor(host / perSession)}`;
  }).join("   ");
  console.log(`  a VM each ${label.padEnd(17)} ${line}`);
}
console.log("\n  (sessions per host: one VM each, versus one only when a session needs it)");
