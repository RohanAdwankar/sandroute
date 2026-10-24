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
//   seccomp allowlist     about 300 system calls, no namespaces, sockets or tracing
//   own cgroup (optional) memory and process limits per tenant
//
// One thing is not hidden: /proc/self/mountinfo names the host directory behind the
// workspace mount. That is the tenant's own directory, never another's, but it means
// workspaces should live under a path that says nothing about the host.
//
// It is container-grade isolation, which is weaker than a VM: the command shares the host
// kernel, with a seccomp allowlist cutting what it can ask of it to about 300 system calls. That is why it is only for commands that run fixed, audited utilities over a
// tenant's files; anything that runs code the tenant wrote goes to the microVM.
import { filterFile } from "./seccomp.js";
import { launch } from "./spawnd.js";

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
    // the seccomp program arrives on descriptor 3 (see exec); a nested user namespace, the usual way to
    // reach kernel code that needs capabilities, is switched off as well as filtered
    "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--seccomp", "3", "--die-with-parent", "--new-session", "--clearenv",
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

  async exec(command: string, cwd?: string, env?: Record<string, string>): Promise<SandboxResult> {
    const at = this.o.mountAt ?? this.o.workspace;
    const inner = ["bwrap", ...bwrapArgs(this.o.workspace, at, cwd ?? at, env), "/usr/bin/bash", "-c", command];
    // Joining the cgroup has to happen before bwrap starts so everything it forks inherits it.
    const argv = this.o.cgroup ? ["/usr/bin/sh", "-c", 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"', "sh", this.o.cgroup, ...inner] : inner;
    const r = await launch(argv, { timeoutMs: this.o.timeoutMs ?? 60_000, maxOutput: this.o.maxOutputBytes ?? 10 * 2 ** 20, fd3: filterFile() });
    if (r.error) return { stdout: r.stdout, stderr: r.error, exitCode: 127 };
    const stderr = r.outputExceeded ? r.stderr + "\n[output limit exceeded]" : r.signal ? r.stderr + `\n[killed by ${r.signal}]` : r.stderr;
    return { stdout: r.stdout, stderr, exitCode: r.code ?? 137 };
  }
}
