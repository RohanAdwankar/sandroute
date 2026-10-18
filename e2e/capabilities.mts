// Can the guest behave like an ordinary machine?
//
// Not having cargo preinstalled is not a problem -- no fresh VM does, and an agent that
// needs it installs it. What makes a missing tool terminal rather than a detour is having
// no way to go and get it, so this checks reachability, and lists what is already present
// only as context for how far an agent gets before it has to.
//
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
  network: process.env.SANDROUTE_TAP
    ? { tap: process.env.SANDROUTE_TAP, guestIp: process.env.SANDROUTE_GUEST_IP ?? "172.16.0.2/30", gateway: process.env.SANDROUTE_GATEWAY ?? "172.16.0.1" }
    : undefined,
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
  ["trusted TLS", `python3 -c "import urllib.request as u;u.urlopen('https://pypi.org/simple/',timeout=20);print('yes')" 2>/dev/null || echo no`, (o: string) => o === "yes"],
  ["installing a package", `python3 -m pip install --quiet --no-warn-script-location --disable-pip-version-check six >/dev/null 2>&1 && python3 -c "import six;print('yes')" || echo no`, (o: string) => o === "yes"],
  ["the host stays unreachable", `python3 -c "
import socket;socket.setdefaulttimeout(4)
try: socket.create_connection(('${process.env.SANDROUTE_GATEWAY ?? "172.16.0.1"}',22)); print('no')
except Exception: print('yes')"`, (o: string) => o === "yes"],
] as const;

console.log("\nwhich it can only do if the guest has a network:\n");
const netFails: string[] = [];
for (const [label, cmd, ok] of net) {
  const got = await sh(cmd);
  const pass = ok(got);
  if (!pass) netFails.push(label);
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
}
await vm.stop(); rmSync(WS, { recursive: true, force: true });

if (netFails.length) {
  console.log(`\n${netFails.length} of ${net.length} unmet. Without these the guest is not an ordinary machine:`);
  console.log("an agent that hits a missing tool cannot go and get it, and is simply stuck.");
  console.log("Run scripts/net-setup.sh once as root, then pass `network` to FirecrackerVm.");
  process.exit(1);
}
console.log("\nThe guest can reach the network, so a missing tool is a detour, not a wall.");
