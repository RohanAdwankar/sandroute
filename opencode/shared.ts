// Shared by the tool overrides in opencode/. Lives outside .opencode/tool/ because
// opencode registers every file in that directory as a tool.
import { appendFileSync } from "node:fs";
import { FirecrackerVm, Sandroute } from "../src/index.ts";

const runners = new Map<string, Sandroute>();

export function forWorkspace(dir: string) {
  let r = runners.get(dir);
  if (!r) {
    const vm =
      process.env.SANDROUTE_VM === "firecracker"
        ? new FirecrackerVm({ bin: process.env.SANDROUTE_FC_BIN, kernel: process.env.SANDROUTE_FC_KERNEL!, rootfs: process.env.SANDROUTE_FC_ROOTFS!, console: !!process.env.SANDROUTE_FC_CONSOLE, snapshotDir: process.env.SANDROUTE_FC_SNAPSHOT_DIR,
            network: process.env.SANDROUTE_TAP ? { tap: process.env.SANDROUTE_TAP, guestIp: process.env.SANDROUTE_GUEST_IP ?? "172.16.0.2/30", gateway: process.env.SANDROUTE_GATEWAY ?? "172.16.0.1" } : undefined })
        : undefined; // default: the non-isolated host-process stand-in
    r = new Sandroute({ workspace: dir, vm, logFile: process.env.SANDROUTE_LOG, idleMs: process.env.SANDROUTE_IDLE_MS ? Number(process.env.SANDROUTE_IDLE_MS) : undefined });
    runners.set(dir, r);
  }
  return r;
}

/**
 * Record what the agent asked for, in full, so a session can be replayed against other
 * sandboxes. The routing log keeps only a summary: a write there is a path, and replaying
 * it needs the content.
 */
export function trace(tool: string, args: unknown) {
  if (process.env.SANDROUTE_TRACE) appendFileSync(process.env.SANDROUTE_TRACE, JSON.stringify({ t: Date.now(), tool, args }) + "\n");
}
