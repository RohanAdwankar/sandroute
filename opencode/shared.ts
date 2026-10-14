// Shared by the tool overrides in opencode/. Lives outside .opencode/tool/ because
// opencode registers every file in that directory as a tool.
import { FirecrackerVm, Sandroute } from "../src/index.ts";

const runners = new Map<string, Sandroute>();

export function forWorkspace(dir: string) {
  let r = runners.get(dir);
  if (!r) {
    const vm =
      process.env.SANDROUTE_VM === "firecracker"
        ? new FirecrackerVm({ bin: process.env.SANDROUTE_FC_BIN, kernel: process.env.SANDROUTE_FC_KERNEL!, rootfs: process.env.SANDROUTE_FC_ROOTFS!, console: !!process.env.SANDROUTE_FC_CONSOLE, snapshotDir: process.env.SANDROUTE_FC_SNAPSHOT_DIR })
        : undefined; // default: the non-isolated host-process stand-in
    r = new Sandroute({ workspace: dir, vm, logFile: process.env.SANDROUTE_LOG, idleMs: process.env.SANDROUTE_IDLE_MS ? Number(process.env.SANDROUTE_IDLE_MS) : undefined });
    runners.set(dir, r);
  }
  return r;
}
