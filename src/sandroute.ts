import { appendFileSync } from "node:fs";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs, getCommandNames } from "just-bash";
import { gitCommand } from "./git.js";
import { HostProcessVm } from "./host-vm.js";
import { classify, type Decision } from "./router.js";
import type { VmBackend } from "./vm.js";

export interface SandrouteOptions {
  /** Real directory the agent works in. Mounted at the same path in-process and shared with the VM. */
  workspace: string;
  vm?: VmBackend;
  /** Append one JSON line per command with the routing decision. */
  logFile?: string;
  /**
   * Release the VM after this long with no VM-tier command, and bring it back on the next
   * one. Unset keeps it up for the whole session, which means one early heavy command
   * pays for the rest of the turn.
   */
  idleMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  tier: Decision["tier"];
  reason: string;
  /** True when this command is the one that booted the VM. */
  booted: boolean;
  /** Of `ms`, how much went on booting or waking the VM. */
  bootMs: number;
  ms: number;
}

export class Sandroute {
  readonly bash: Bash;
  readonly vm: VmBackend;
  private known: Set<string>;
  private vmUp = false;
  private vmBoot?: Promise<void>;
  private inFlight = 0;
  private idleTimer?: NodeJS.Timeout;
  /** Wall time the VM has been allocated, which is what a microVM actually costs. */
  private allocMs = 0;
  private allocSince?: number;
  bootCount = 0;
  releaseCount = 0;

  constructor(private opts: SandrouteOptions) {
    this.vm = opts.vm ?? new HostProcessVm();
    const fs = new MountableFs({
      base: new InMemoryFs(),
      mounts: [{ mountPoint: opts.workspace, filesystem: new ReadWriteFs({ root: opts.workspace }) }],
    });
    this.bash = new Bash({ fs, cwd: opts.workspace, customCommands: [gitCommand], network: { dangerouslyAllowFullInternetAccess: true } });
    this.known = new Set([...getCommandNames(), "curl", "git"]);
  }

  /** Wall time the VM has been allocated so far, counting any stretch still open. */
  get vmAllocatedMs(): number {
    return this.allocMs + (this.allocSince === undefined ? 0 : Date.now() - this.allocSince);
  }

  async run(command: string, cwd?: string): Promise<RunResult> {
    const t0 = Date.now();
    const d = classify(this.known, command, this.opts.workspace);
    let res: { stdout: string; stderr: string; exitCode: number };
    let booted = false;
    let bootMs = 0;
    if (d.tier === "inprocess") {
      res = await this.bash.exec(command, { cwd });
    } else {
      clearTimeout(this.idleTimer);
      this.inFlight++;
      try {
        if (!this.vmUp) {
          const tb = Date.now();
          this.vmBoot ??= this.vm.boot(this.opts.workspace).then(() => {
            this.vmUp = true;
            this.bootCount++;
            // the meter starts when firecracker starts, not when the command does
            this.allocSince = tb;
          });
          booted = true;
          await this.vmBoot;
          bootMs = Date.now() - tb;
        }
        res = await this.vm.exec(command, { cwd: cwd ?? this.opts.workspace });
      } finally {
        this.inFlight--;
        this.armIdle();
      }
    }
    const out: RunResult = { ...res, tier: d.tier, reason: d.reason, booted, bootMs, ms: Date.now() - t0 };
    if (this.opts.logFile)
      appendFileSync(this.opts.logFile, JSON.stringify({ t: new Date().toISOString(), command, tier: out.tier, reason: out.reason, booted, bootMs, ms: out.ms, exitCode: out.exitCode, vmAllocatedMs: this.vmAllocatedMs }) + "\n");
    return out;
  }

  private armIdle() {
    if (!this.opts.idleMs || !this.vmUp) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.release(), this.opts.idleMs);
    this.idleTimer.unref();
  }

  /**
   * Hand the VM back. The next VM-tier command brings one up again, which is cheap when
   * the backend restores a snapshot. Safe to call at any time: a command in flight keeps
   * the VM, and the idle timer re-arms when it finishes.
   */
  async release(): Promise<boolean> {
    clearTimeout(this.idleTimer);
    if (!this.vmUp || this.inFlight > 0) return false;
    this.vmUp = false;
    this.vmBoot = undefined;
    if (this.allocSince !== undefined) {
      this.allocMs += Date.now() - this.allocSince;
      this.allocSince = undefined;
    }
    this.releaseCount++;
    await this.vm.stop();
    return true;
  }

  async stop() {
    clearTimeout(this.idleTimer);
    if (this.vmUp) {
      if (this.allocSince !== undefined) {
        this.allocMs += Date.now() - this.allocSince;
        this.allocSince = undefined;
      }
      this.vmUp = false;
      await this.vm.stop();
    }
  }
}
