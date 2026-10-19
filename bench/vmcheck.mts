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

// ---- a release only writes a snapshot when the guest holds something worth keeping ----
{
  rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });
  const prime = mk("prime"); await prime.vm.boot(prime.ws); await prime.vm.stop();
  const files = (n: string) => { try { return readdirSync(`${base}/sessions-${n}`).filter((f) => f.endsWith(".mem")).length; } catch { return 0; } };
  const bare = mk("bare"), kept = mk("kept");
  await Promise.all([bare.vm.boot(bare.ws), kept.vm.boot(kept.ws)]);
  // the ordinary work of an agent: run some python, write inside the workspace
  for (const t of [bare, kept]) await t.vm.exec(`python3 -c "import unittest, json; open('/work/out.txt','w').write('made in the guest')"`, { cwd: "/work" });
  await kept.vm.exec("mkdir -p /usr/local/lib/pkg && echo installed > /usr/local/lib/pkg/mod.py", { cwd: "/work" });
  const t0 = Date.now(); await bare.vm.suspend(); const dropMs = Date.now() - t0;
  const t1 = Date.now(); await kept.vm.suspend(); const keepMs = Date.now() - t1;
  console.log(`\nstateless guest: released in ${dropMs}ms, discarded=${bare.vm.discards}, snapshot files on disk ${files("bare")}`);
  console.log(`guest with an installed file: released in ${keepMs}ms, discarded=${kept.vm.discards}, snapshot files on disk ${files("kept")}`);
  const t2 = Date.now(); await bare.vm.boot(bare.ws);
  const r = await bare.vm.exec("cat /work/who.txt; cat /work/out.txt", { cwd: "/work" });
  console.log(`woke the discarded one in ${Date.now() - t2}ms, workspace intact: ${JSON.stringify(r.stdout.replace("\n", " + "))}`);
  await kept.vm.boot(kept.ws);
  console.log("the kept one still has its file:", JSON.stringify((await kept.vm.exec("cat /usr/local/lib/pkg/mod.py", { cwd: "/work" })).stdout.trim()));
  await bare.vm.stop(); await kept.vm.stop(); rmSync(base, { recursive: true, force: true });
}
