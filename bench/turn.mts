// What fraction of a turn does the VM actually have to be allocated for?
//
// Replays a turn against a real Firecracker VM. A turn is tool calls separated by
// think gaps -- the time the agent spends waiting on the model, which is when a
// session-long VM is allocated and doing nothing. Run with --idle <ms> to release
// the VM during those gaps, or without to keep it for the whole turn.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandroute, FirecrackerVm } from "../src/index.js";

const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const idleArg = process.argv.indexOf("--idle");
const idleMs = idleArg > 0 ? Number(process.argv[idleArg + 1]) : undefined;
const repArg = process.argv.indexOf("--repeat");
const repeat = repArg > 0 ? Number(process.argv[repArg + 1]) : 1;
const WS = `/home/rohan/turn-ws`;
const FILES = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(WS, { recursive: true, force: true });
for (let i = 0; i < FILES; i++) {
  const d = path.join(WS, `src/d${Math.floor(i / 50)}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `f${i}.ts`), `export const v${i} = "needle";\n` + "// pad\n".repeat(20));
}

// A turn: [command, think gap after it]. Light calls are the reading and editing an
// agent spends most of its calls on; heavy calls cluster, the way a build or a test run
// does in practice.
const L = (c: string, gap = 3000): [string, number] => [c, gap];
const base: [string, number][] = [
  L("ls src"), L("cat src/d0/f0.ts"), L("grep -rl needle src | head -5"),
  L("sed -i 's/needle/pin/' src/d0/f1.ts"), L("cat src/d0/f1.ts"),
  L("grep -c pin src/d0/f1.ts"),
  // a heavy cluster: the agent reaches for the machine, iterates, then goes back to reading
  L("uname -r", 2000), L("python3 -c 'print(1+1)'", 2000), L("command -v bash", 4000),
  L("cat src/d0/f2.ts"), L("grep -rl needle src | wc -l"),
  L("sed -i 's/needle/pin/' src/d0/f3.ts"), L("cat src/d0/f3.ts"),
  L("ls src/d1"), L("grep -c pin src/d0/f3.ts"),
  // one more heavy call late in the turn
  L("python3 -c 'print(\"done\")'", 3000),
  L("cat src/d0/f4.ts"), L("ls src/d2"), L("grep -rl pin src | wc -l"), L("cat src/d0/f5.ts"),
];
// --repeat models a longer turn: the same work, more of it. The point of interest is
// whether the saving holds up as turns grow, since that is the direction they are going.
const turn = Array.from({ length: repeat }, () => base).flat();
turn[turn.length - 1] = [turn[turn.length - 1][0], 0];

const vm = new FirecrackerVm({
  bin: `${A}/firecracker`, kernel: `${A}/vmlinux-6.1.128`, rootfs: `${A}/rootfs.ext4`,
  vcpus: 2, memMiB: 1024, snapshotDir: `${A}/snapcache`,
});
const s = new Sandroute({ workspace: WS, vm, idleMs });

// prime the snapshot outside the measurement: in production this ships with the image
await vm.boot(WS); await vm.stop();

const t0 = Date.now();
let heavy = 0, wakes = 0, wakeMs = 0;
for (const [cmd, gap] of turn) {
  const r = await s.run(cmd);
  if (r.tier === "vm") heavy++;
  if (r.booted) { wakes++; wakeMs += r.bootMs; }
  console.log(`${String(Date.now() - t0).padStart(6)}ms  ${r.tier.padEnd(9)}${r.booted ? ` WAKE ${String(r.bootMs).padStart(4)}ms` : "          "}  ${String(r.ms).padStart(5)}ms  ${cmd.slice(0, 44)}`);
  await sleep(gap);
}
const turnMs = Date.now() - t0;
await s.stop();
const alloc = s.vmAllocatedMs;
console.log(`\nidle window      : ${idleMs === undefined ? "none (vm kept for the session)" : idleMs + "ms"}`);
console.log(`turn wall time   : ${turnMs}ms (repeat=${repeat})`);
console.log(`tool calls       : ${turn.length} (${heavy} to the vm)`);
console.log(`vm wakes         : ${wakes}, ${wakeMs}ms total (${wakes ? (wakeMs / wakes).toFixed(0) : 0}ms each)`);
console.log(`vm allocated     : ${alloc}ms = ${((alloc / turnMs) * 100).toFixed(1)}% of the turn`);
console.log(`always-on would  : ${turnMs}ms = 100%`);
console.log(`vm-seconds saved : ${(((turnMs - alloc) / turnMs) * 100).toFixed(1)}%`);
rmSync(WS, { recursive: true, force: true });
