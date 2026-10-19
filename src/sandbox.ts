// A sandbox for commands that run on the host: a fresh set of namespaces per command.
//
// The in-process tier used to be a JavaScript interpreter inside the process that serves
// every tenant, which is not a boundary a hostile tenant can be held behind: a bug in the
// interpreter is a bug in the one process holding everyone's workspace. This runs each
// command as an ordinary native process instead, under bubblewrap, which needs no root.
//
//   own PID namespace     cannot see or signal anything else on the host
//   no network            only a loopback that reaches nothing
//   own mount namespace   the system is read-only, and the tenant's workspace is the only
//                         writable path and the only tenant data in sight
//   own user namespace    no privilege outside the sandbox
//   own cgroup (optional) memory and process limits per tenant
//
// One thing is not hidden: /proc/self/mountinfo names the host directory behind the
// workspace mount. That is the tenant's own directory, never another's, but it means
// workspaces should live under a path that says nothing about the host.
//
// It is container-grade isolation, which is weaker than a VM: the command shares the host
// kernel. That is why it is only for commands that run fixed, audited utilities over a
// tenant's files; anything that runs code the tenant wrote goes to the microVM.
import { spawn } from "node:child_process";

export interface SandboxOptions {
  workspace: string;
  /**
   * Where the tenant sees its workspace. Defaults to its real path. Mounting every
   * tenant's at the same place means a tenant learns nothing about the host's layout, and
   * the same command line means the same thing in the sandbox as in the VM.
   */
  mountAt?: string;
  /** A cgroup v2 directory every command is placed in, for memory.max and pids.max. */
  cgroup?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function bwrapArgs(workspace: string, mountAt: string, cwd: string, env: Record<string, string> = {}): string[] {
  const e = { PATH: "/usr/bin:/bin", HOME: mountAt, LANG: "C.UTF-8", ...env };
  return [
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, mountAt, "--chdir", cwd,
    ...Object.entries(e).flatMap(([k, v]) => ["--setenv", k, v]),
  ];
}

export class Sandbox {
  constructor(private o: SandboxOptions) {}

  exec(command: string, cwd?: string, env?: Record<string, string>): Promise<SandboxResult> {
    const at = this.o.mountAt ?? this.o.workspace;
    const inner = ["bwrap", ...bwrapArgs(this.o.workspace, at, cwd ?? at, env), "/usr/bin/bash", "-c", command];
    // Joining the cgroup has to happen before bwrap starts so everything it forks inherits it.
    const argv = this.o.cgroup
      ? ["/usr/bin/sh", ["-c", 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"', "sh", this.o.cgroup, ...inner]] as const
      : [inner[0], inner.slice(1)] as const;
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv[1] as string[], { stdio: ["ignore", "pipe", "pipe"] });
      const cap = this.o.maxOutputBytes ?? 10 * 2 ** 20;
      let stdout = "", stderr = "", over = false;
      const take = (into: "o" | "e") => (d: Buffer) => {
        if (stdout.length + stderr.length > cap) { over = true; child.kill("SIGKILL"); return; }
        if (into === "o") stdout += d; else stderr += d;
      };
      child.stdout.on("data", take("o"));
      child.stderr.on("data", take("e"));
      const timer = setTimeout(() => child.kill("SIGKILL"), this.o.timeoutMs ?? 60_000);
      child.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: String(e), exitCode: 127 }); });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: over ? stderr + "\n[output limit exceeded]" : sig ? stderr + `\n[killed by ${sig}]` : stderr, exitCode: code ?? 137 });
      });
    });
  }
}
