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
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  tier: Decision["tier"];
  reason: string;
  /** True when this command is the one that booted the VM. */
  booted: boolean;
  ms: number;
}

export class Sandroute {
  readonly bash: Bash;
  readonly vm: VmBackend;
  private known: Set<string>;
  private vmUp = false;
  private vmBoot?: Promise<void>;
  bootCount = 0;

  constructor(private opts: SandrouteOptions) {
    this.vm = opts.vm ?? new HostProcessVm();
    const fs = new MountableFs({
      base: new InMemoryFs(),
      mounts: [{ mountPoint: opts.workspace, filesystem: new ReadWriteFs({ root: opts.workspace }) }],
    });
    this.bash = new Bash({ fs, cwd: opts.workspace, customCommands: [gitCommand], network: { dangerouslyAllowFullInternetAccess: true } });
    this.known = new Set([...getCommandNames(), "curl", "git"]);
  }

  async run(command: string, cwd?: string): Promise<RunResult> {
    const t0 = Date.now();
    const d = classify(this.known, command);
    let res: { stdout: string; stderr: string; exitCode: number };
    let booted = false;
    if (d.tier === "inprocess") {
      res = await this.bash.exec(command, { cwd });
    } else {
      if (!this.vmUp) {
        this.vmBoot ??= this.vm.boot(this.opts.workspace).then(() => {
          this.vmUp = true;
          this.bootCount++;
        });
        booted = true;
        await this.vmBoot;
      }
      res = await this.vm.exec(command, { cwd: cwd ?? this.opts.workspace });
    }
    const out: RunResult = { ...res, tier: d.tier, reason: d.reason, booted, ms: Date.now() - t0 };
    if (this.opts.logFile)
      appendFileSync(this.opts.logFile, JSON.stringify({ t: new Date().toISOString(), command, tier: out.tier, reason: out.reason, booted, ms: out.ms, exitCode: out.exitCode }) + "\n");
    return out;
  }

  async stop() {
    if (this.vmUp) await this.vm.stop();
  }
}
