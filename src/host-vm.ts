import { spawn } from "node:child_process";
import type { VmBackend, VmResult } from "./vm.js";

/**
 * Stand-in for a real microVM, for machines without KVM.
 * It runs commands as host processes against the same workspace and models
 * boot cost with a delay. It is NOT isolated. It exists so the router can be
 * tested end to end anywhere.
 */
export class HostProcessVm implements VmBackend {
  readonly name = "host-process (stand-in, not isolated)";
  constructor(private bootMs = 0) {}

  async boot(): Promise<void> {
    if (this.bootMs > 0) await new Promise((r) => setTimeout(r, this.bootMs));
  }

  exec(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<VmResult> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      child.on("error", (e) => resolve({ stdout, stderr: String(e), exitCode: 127 }));
    });
  }

  async stop(): Promise<void> {}
}
