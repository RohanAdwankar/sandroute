// Does the path virtualisation hold up on real VMs?
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { FirecrackerVm } from "../src/firecracker.js";
const A = "/home/rohan/fcassets", base = `${A}/vmcheck`;
rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });
const mk = (name: string) => {
  const ws = `${base}/ws-${name}`; mkdirSync(ws, { recursive: true }); writeFileSync(`${ws}/who.txt`, name + "\n");
  return { ws, vm: new FirecrackerVm({ bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`,
    vcpus: 1, memMiB: 256, snapshotDir: `${base}/pristine`, sessionDir: `${base}/sessions-${name}`, guestWorkspace: "/work" }) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prime = mk("prime"); await prime.vm.boot(prime.ws); await prime.vm.stop();     // the one shared pristine snapshot
const a = mk("alpha"), b = mk("bravo");
const t = Date.now();
await Promise.all([a.vm.boot(a.ws), b.vm.boot(b.ws)]);
console.log(`two tenants booted together in ${Date.now() - t}ms, restore=${a.vm.lastBootWasRestore}/${b.vm.lastBootWasRestore}`);
console.log("alpha sees:", (await a.vm.exec("cat /work/who.txt", { cwd: "/work" })).stdout.trim(), "  bravo sees:", (await b.vm.exec("cat /work/who.txt", { cwd: "/work" })).stdout.trim());
console.log("pristine snapshots on disk:", readdirSync(`${base}/pristine`).filter((f) => f.endsWith(".mem")).length, "(one, shared)");
await a.vm.exec("echo kept-in-guest > /root/marker", { cwd: "/work" });
for (let i = 1; i <= 4; i++) {
  await a.vm.suspend();
  const slots = readdirSync(`${base}/sessions-alpha`).filter((f) => f.endsWith(".mem")).length;
  await a.vm.boot(a.ws);
  const r = await a.vm.exec("cat /root/marker && cat /work/who.txt", { cwd: "/work" });
  console.log(`cycle ${i}: ${slots} session slot on disk at rest, state after resume: ${JSON.stringify(r.stdout.trim().replace("\n", " + "))}`);
}
await a.vm.stop(); await b.vm.stop(); rmSync(base, { recursive: true, force: true });
