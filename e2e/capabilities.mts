// Does the VM actually deliver what the router promises?
//
// The router escalates a command because the in-process shell cannot serve it. That is
// only useful if the VM can. Live agent runs showed it often cannot: a model asked to
// build something reached for pip, apt and npm, and got "command not found" from the VM
// instead of from the shell -- no better off, one wake worse off.
//
// This is a gap list, so it fails while gaps remain. Fix the image, or trim the promise.
//   npx tsx e2e/capabilities.mts
import { mkdirSync, rmSync } from "node:fs";
import { ALWAYS_VM, MACHINE_QUERIES } from "../src/router.js";
import { FirecrackerVm } from "../src/index.js";

const A = process.env.SANDROUTE_ASSETS ?? "/home/rohan/fcassets";
const WS = "/home/rohan/cap-ws";
rmSync(WS, { recursive: true, force: true }); mkdirSync(WS, { recursive: true });

const vm = new FirecrackerVm({
  bin: `${A}/firecracker`, kernel: process.env.SANDROUTE_FC_KERNEL ?? `${A}/vmlinux-6.1.128`,
  rootfs: process.env.SANDROUTE_FC_ROOTFS ?? `${A}/rootfs.ext4`, snapshotDir: `${A}/snapcache`,
});
await vm.boot(WS);
const sh = async (cmd: string) => (await vm.exec(cmd, { cwd: WS })).stdout.trim();

const names = [...new Set([...ALWAYS_VM, ...MACHINE_QUERIES])].sort();
const found = new Set((await sh(`for c in ${names.join(" ")}; do command -v $c >/dev/null && echo $c; done`)).split("\n").filter(Boolean));
const missing = names.filter((n) => !found.has(n));

console.log("commands the router sends to the VM, and whether the VM has them\n");
for (const n of names) console.log(`  ${found.has(n) ? "✓" : "✗"} ${n}${ALWAYS_VM.has(n) ? "" : "   (machine query)"}`);

const net = [
  ["a network interface besides loopback", `ip -o link show | grep -cv ': lo:'`, (o: string) => o !== "0"],
  ["a default route", `ip route | grep -c default`, (o: string) => o !== "0"],
  ["a resolver config", `test -f /etc/resolv.conf && echo yes || echo no`, (o: string) => o === "yes"],
  ["DNS resolution", `python3 -c "import socket;socket.setdefaulttimeout(5);socket.gethostbyname('pypi.org');print('yes')" 2>/dev/null || echo no`, (o: string) => o === "yes"],
  ["outbound TCP", `python3 -c "import socket;socket.setdefaulttimeout(5);socket.create_connection(('1.1.1.1',443));print('yes')" 2>/dev/null || echo no`, (o: string) => o === "yes"],
] as const;

console.log("\nwhat an agent needs before it can install anything\n");
const netFails: string[] = [];
for (const [label, cmd, ok] of net) {
  const got = await sh(cmd);
  const pass = ok(got);
  if (!pass) netFails.push(label);
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
}
await vm.stop(); rmSync(WS, { recursive: true, force: true });

console.log(`\n${missing.length} of ${names.length} escalated commands are absent from the VM: ${missing.join(" ") || "none"}`);
console.log(`${netFails.length} of ${net.length} network prerequisites unmet`);
if (missing.length || netFails.length) {
  console.log("\nEach line above is a command the router promises the VM can serve and it cannot,");
  console.log("or a reason an agent's first instinct -- install the dependency -- dies.");
  process.exit(1);
}
