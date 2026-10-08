// Build the ready-to-restore snapshot for a workspace ahead of time.
//
// Priming costs a cold boot plus a /snapshot/create -- about 4.4s -- and without this it
// lands on the first heavy command of a session. A service should do it before the agent
// starts, or ship the snapshot with the rootfs image.
//
//   npm run prewarm -- /path/to/workspace
import { mkdirSync } from "node:fs";
import { FirecrackerVm } from "../src/index.js";

const workspace = process.argv[2];
if (!workspace) { console.error("usage: npm run prewarm -- <workspace>"); process.exit(2); }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
const snapshotDir = need("SANDROUTE_FC_SNAPSHOT_DIR");
mkdirSync(workspace, { recursive: true });

const vm = new FirecrackerVm({
  bin: process.env.SANDROUTE_FC_BIN,
  kernel: need("SANDROUTE_FC_KERNEL"),
  rootfs: need("SANDROUTE_FC_ROOTFS"),
  snapshotDir,
});
const t = Date.now();
await vm.boot(workspace);
await vm.stop();
console.log(`${vm.lastBootWasRestore ? "already primed" : "primed"} in ${Date.now() - t}ms: ${snapshotDir} for ${workspace}`);

const t2 = Date.now();
const vm2 = new FirecrackerVm({ bin: process.env.SANDROUTE_FC_BIN, kernel: need("SANDROUTE_FC_KERNEL"), rootfs: need("SANDROUTE_FC_ROOTFS"), snapshotDir });
await vm2.boot(workspace);
console.log(`restore check: ${Date.now() - t2}ms, restore=${vm2.lastBootWasRestore}`);
await vm2.stop();
