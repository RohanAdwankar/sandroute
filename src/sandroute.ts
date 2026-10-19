import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs, getCommandNames } from "just-bash";
import { fileCommand, type FileCall } from "./fileops.js";
import { gitCommand } from "./git.js";
import { HostProcessVm } from "./host-vm.js";
import { classify, type Decision } from "./router.js";
import type { Sandbox } from "./sandbox.js";
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
  /**
   * Send every command to the VM, skipping the in-process tier. With idleMs this is the
   * comparison the routing has to beat: a machine that is also released when idle, but
   * where every command wakes it.
   */
  allInVm?: boolean;
  /**
   * Run the light tier as native processes in this sandbox, one per command, instead of
   * in a JavaScript interpreter inside this process. Required when tenants can be hostile
   * to each other, and the interpreter is not built at all.
   */
  light?: Sandbox;
  /**
   * The path the agent sees its workspace at, when that is not the real one. Commands,
   * the file tools and the VM all use it, so a tenant's host layout never reaches it.
   * Defaults to the real path.
   */
  workspacePath?: string;
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
  readonly bash?: Bash;
  readonly vm: VmBackend;
  private known: Set<string>;
  private at: string;
  private vmUp = false;
  private vmBoot?: Promise<void>;
  private inFlight = 0;
  private idleTimer?: NodeJS.Timeout;
  /** What was still running the last time a release was refused. */
  lastPinned: { pid: number; comm: string }[] = [];
  /** Paths the guest kept its own version of because both sides had changed them. */
  conflicts: string[] = [];
  /** Why the last release was refused, when the machine could not be asked. */
  lastPinnedError?: string;
  /** Wall time the VM has been allocated, which is what a microVM actually costs. */
  private allocMs = 0;
  private allocSince?: number;
  bootCount = 0;
  releaseCount = 0;
  /** Times the idle timer fired but something was still alive in the VM. */
  pinnedCount = 0;

  constructor(private opts: SandrouteOptions) {
    this.vm = opts.vm ?? new HostProcessVm();
    this.at = opts.workspacePath ?? opts.workspace;
    if (!opts.light && !opts.allInVm) {
      const fs = new MountableFs({
        base: new InMemoryFs(),
        mounts: [{ mountPoint: opts.workspace, filesystem: new ReadWriteFs({ root: opts.workspace }) }],
      });
      this.bash = new Bash({ fs, cwd: opts.workspace, customCommands: [gitCommand], network: { dangerouslyAllowFullInternetAccess: true } });
    }
    this.vm.onConflict = (paths) => {
      this.conflicts.push(...paths);
      if (this.opts.logFile)
        appendFileSync(this.opts.logFile, JSON.stringify({ t: new Date().toISOString(), conflicts: paths }) + "\n");
    };
    // With a sandbox the commands that run are the host's own, so only those the host has
    // can be served there. git and curl need the network, which the sandbox does not have.
    this.known = opts.light
      ? new Set(getCommandNames().filter((n) => n !== "git" && n !== "curl" && existsSync(`/usr/bin/${n}`)))
      : new Set([...getCommandNames(), "curl", "git"]);
  }

  /** Wall time the VM has been allocated so far, counting any stretch still open. */
  get vmAllocatedMs(): number {
    return this.allocMs + (this.allocSince === undefined ? 0 : Date.now() - this.allocSince);
  }

  async run(command: string, cwd?: string): Promise<RunResult> {
    const t0 = Date.now();
    const d: Decision = this.opts.allInVm ? { tier: "vm", reason: "all commands run in the VM" } : classify(this.known, command, this.at);
    let res: { stdout: string; stderr: string; exitCode: number };
    let booted = false;
    let bootMs = 0;
    if (d.tier === "inprocess") {
      res = this.opts.light ? await this.opts.light.exec(command, cwd) : await this.bash!.exec(command, { cwd });
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
        res = await this.vm.exec(command, { cwd: cwd ?? this.at });
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

  /**
   * The file tools, served by the same filesystem the in-process shell uses. A harness
   * that writes and reads through its own tools would otherwise touch the host directly,
   * with nothing holding it to the workspace; going through MountableFs means a path
   * outside the workspace lands in the empty InMemoryFs, and symlinks out are refused,
   * exactly as they are for a command.
   */
  async readFile(file: string, opts: { offset?: number; limit?: number } = {}): Promise<string> {
    return this.fileOp("read", file, async () => {
      if (this.viaCommands) return this.inSandbox({ tool: "read", filePath: this.resolve(file), ...opts });
      const text = await this.bash!.fs.readFile(this.resolve(file), "utf8");
      if (opts.offset === undefined && opts.limit === undefined) return text;
      const from = Math.max(0, (opts.offset ?? 1) - 1);
      return text.split("\n").slice(from, from + (opts.limit ?? 2000)).join("\n");
    });
  }

  async writeFile(file: string, content: string): Promise<void> {
    await this.fileOp("write", file, async () => {
      const full = this.resolve(file);
      if (this.viaCommands) { await this.inSandbox({ tool: "write", filePath: full, content }); return; }
      const dir = path.dirname(full);
      if (dir && dir !== full) await this.bash!.fs.mkdir(dir, { recursive: true });
      await this.bash!.fs.writeFile(full, content);
    });
  }

  async editFile(file: string, oldString: string, newString: string, replaceAll = false): Promise<number> {
    return this.fileOp("edit", file, async () => {
      const full = this.resolve(file);
      if (this.viaCommands) return Number(await this.inSandbox({ tool: "edit", filePath: full, oldString, newString, replaceAll }));
      const before = await this.bash!.fs.readFile(full, "utf8");
      const hits = before.split(oldString).length - 1;
      if (hits === 0) throw new Error(`oldString not found in ${file}`);
      if (hits > 1 && !replaceAll) throw new Error(`oldString appears ${hits} times in ${file}; pass replaceAll`);
      await this.bash!.fs.writeFile(full, replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString));
      return replaceAll ? hits : 1;
    });
  }

  /** The file tools are commands too, run wherever commands are: the sandbox, or the VM
   *  when every command goes there. */
  private get viaCommands() {
    return !!(this.opts.light || this.opts.allInVm);
  }

  private async inSandbox(call: FileCall): Promise<string> {
    const r = this.opts.allInVm ? await this.run(fileCommand(call)) : await this.opts.light!.exec(fileCommand(call));
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
    return r.stdout;
  }

  /** Both search tools run through the in-process shell, so they see the workspace and
   *  nothing else, and the agent cannot enumerate the host by asking for a wider path. */
  async glob(pattern: string, dir?: string): Promise<string[]> {
    return (await this.run(fileCommand({ tool: "glob", pattern, path: dir }), dir)).stdout.split("\n").filter(Boolean);
  }

  async grepFiles(pattern: string, dir?: string, include?: string): Promise<string[]> {
    return (await this.run(fileCommand({ tool: "grep", pattern, path: dir, include }), dir)).stdout.split("\n").filter(Boolean);
  }

  private resolve(file: string) {
    return path.isAbsolute(file) ? file : path.join(this.at, file);
  }

  /** File tools are in-process by definition, but they are still agent activity and belong in the log. */
  private async fileOp<T>(op: string, file: string, run: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    let failed: string | undefined;
    try {
      return await run();
    } catch (e) {
      failed = (e as Error).message;
      throw e;
    } finally {
      if (this.opts.logFile)
        appendFileSync(this.opts.logFile, JSON.stringify({
          t: new Date().toISOString(), command: `${op} ${file}`, tier: "inprocess",
          reason: "file tool, served by the workspace filesystem", booted: false, bootMs: 0,
          ms: Date.now() - t0, exitCode: failed ? 1 : 0, vmAllocatedMs: this.vmAllocatedMs,
        }) + "\n");
    }
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
   *
   * A command that backgrounds a server returns straight away, so an idle timer alone
   * would kill it -- and since the next wake restores a pristine snapshot, it would
   * vanish without a trace. While anything is alive in there, the VM is pinned.
   */
  async release(): Promise<boolean> {
    clearTimeout(this.idleTimer);
    if (!this.vmUp || this.inFlight > 0) return false;
    if (this.vm.busy) {
      let live;
      try {
        live = await this.vm.busy();
      } catch (e) {
        // Cannot prove it is idle, so keep it -- but a probe that always fails pins the
        // VM forever, which looks exactly like a machine that is legitimately busy.
        this.lastPinnedError = (e as Error).message;
        if (this.opts.logFile)
          appendFileSync(this.opts.logFile, JSON.stringify({ t: new Date().toISOString(), pinnedBy: "probe failed", error: this.lastPinnedError }) + "\n");
        live = { busy: true, procs: [] };
      }
      if (live.busy) {
        this.pinnedCount++;
        this.lastPinned = live.procs;
        if (this.inFlight === 0 && this.vmUp) this.armIdle(); // look again later
        return false;
      }
    }
    if (!this.vmUp || this.inFlight > 0) return false; // a command arrived while we asked
    this.vmUp = false;
    this.vmBoot = undefined;
    if (this.allocSince !== undefined) {
      this.allocMs += Date.now() - this.allocSince;
      this.allocSince = undefined;
    }
    this.releaseCount++;
    // keep what the guest accumulated, if the backend can; a clean restore would drop it
    await (this.vm.suspend ? this.vm.suspend() : this.vm.stop());
    return true;
  }

  async stop() {
    clearTimeout(this.idleTimer);
    if (this.allocSince !== undefined) {
      this.allocMs += Date.now() - this.allocSince;
      this.allocSince = undefined;
    }
    this.vmUp = false;
    // Whether or not it is up: a suspended session is a snapshot on disk, and ending the
    // session is the only thing that deletes it.
    await this.vm.stop();
  }
}
