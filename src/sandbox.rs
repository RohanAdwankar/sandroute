//! A sandbox for commands that run on the host: a fresh set of namespaces per command.
//!
//! The light tier used to be a JavaScript interpreter inside the one process that serves every tenant, which is not a boundary a hostile
//! tenant can be held behind: a bug in the interpreter is a bug in the process holding everyone's workspace. This runs each command as
//! an ordinary native process instead, under bubblewrap, which needs no root:
//!
//!   own PID namespace     cannot see or signal anything else on the host
//!   no network            only a loopback that reaches nothing
//!   own mount namespace   the system is read-only, and the tenant's workspace is the only writable path and the only tenant data in sight
//!   own user namespace    no privilege outside the sandbox
//!   seccomp allowlist     about 300 system calls, no namespaces, sockets or tracing
//!   own cgroup (optional) memory and process limits per tenant
//!
//! One thing is not hidden: /proc/self/mountinfo names the host directory behind the workspace mount. That is the tenant's own directory,
//! never another's, but it means workspaces should live under a path that says nothing about the host.
//!
//! It is container-grade isolation, which is weaker than a VM: the command shares the host kernel, with a seccomp allowlist cutting what it
//! can ask of it. That is why it is only for commands that run fixed, audited utilities over a tenant's files; anything that runs code the
//! tenant wrote goes to the microVM.
use crate::{seccomp, spawn};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct SandboxOptions {
    pub workspace: PathBuf,
    /// Where the tenant sees its workspace. Defaults to its real path. Mounting every tenant's at the same place means a tenant learns
    /// nothing about the host's layout, and the same command line means the same thing in the sandbox as in the VM.
    pub mount_at: Option<String>,
    /// A cgroup v2 directory every command is placed in, for memory.max and pids.max.
    pub cgroup: Option<PathBuf>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl SandboxOptions {
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        SandboxOptions { workspace: workspace.into(), mount_at: None, cgroup: None, timeout: Duration::from_secs(60), max_output_bytes: 10 << 20 }
    }
    pub fn mount_at(mut self, at: &str) -> Self {
        self.mount_at = Some(at.to_string());
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SandboxResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub fn bwrap_args(workspace: &str, mount_at: &str, cwd: &str, env: &BTreeMap<String, String>) -> Vec<String> {
    let mut e: BTreeMap<String, String> = [("PATH", "/usr/bin:/bin"), ("HOME", mount_at), ("LANG", "C.UTF-8")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    e.extend(env.clone());
    let mut a: Vec<String> = [
        // the seccomp program arrives on descriptor 3; a nested user namespace, the usual way to reach kernel code that needs capabilities,
        // is switched off as well as filtered
        "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--seccomp", "3", "--die-with-parent", "--new-session", "--clearenv",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
        "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", workspace, mount_at, "--chdir", cwd,
    ].iter().map(|s| s.to_string()).collect();
    for (k, v) in e {
        a.extend(["--setenv".to_string(), k, v]);
    }
    a
}

#[derive(Clone)]
pub struct Sandbox {
    o: SandboxOptions,
}

impl Sandbox {
    pub fn new(o: SandboxOptions) -> Self {
        Sandbox { o }
    }

    pub async fn exec(&self, command: &str, cwd: Option<&str>, env: &BTreeMap<String, String>) -> SandboxResult {
        let ws = self.o.workspace.to_string_lossy();
        let at = self.o.mount_at.clone().unwrap_or_else(|| ws.to_string());
        let mut inner = vec!["bwrap".to_string()];
        inner.extend(bwrap_args(&ws, &at, cwd.unwrap_or(&at), env));
        inner.extend(["/usr/bin/bash".into(), "-c".into(), command.into()]);
        // Joining the cgroup has to happen before bwrap starts so everything it forks inherits it.
        let argv = match &self.o.cgroup {
            Some(cg) => [vec!["/usr/bin/sh".into(), "-c".into(), r#"echo $$ > "$1/cgroup.procs" && shift && exec "$@""#.into(), "sh".into(), cg.to_string_lossy().into_owned()], inner].concat(),
            None => inner,
        };
        let filter = match seccomp::open_filter() {
            Ok(f) => f,
            Err(e) => return SandboxResult { stdout: String::new(), stderr: e.to_string(), exit_code: 127 },
        };
        match spawn::run(&argv, self.o.timeout, self.o.max_output_bytes, Some(filter)).await {
            Err(e) => SandboxResult { stdout: String::new(), stderr: e.to_string(), exit_code: 127 },
            Ok(r) => {
                let stderr = if r.output_exceeded {
                    format!("{}\n[output limit exceeded]", r.stderr)
                } else if let Some(sig) = r.signal {
                    format!("{}\n[killed by {}]", r.stderr, spawn::signal_name(sig))
                } else {
                    r.stderr
                };
                SandboxResult { stdout: r.stdout, stderr, exit_code: r.code.unwrap_or(137) }
            }
        }
    }
}
