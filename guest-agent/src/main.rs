//! Guest agent. Runs inside the microVM and serves one host over vsock.
//!
//! Protocol: one JSON object per line in each direction.
//!   {"op":"ping"}                                   -> {"ok":true,"agent":"<hash of this file>"}
//!   {"op":"clock","epoch":secs}                     -> {"ok":true}
//!   {"op":"sync","files":[{path,mode,b64}],"delete":[path],"dirs":[path],"scratch":{...}}  -> {"ok":true,"conflicts":[path]}
//!   {"op":"exec","cmd":str,"cwd":str,"env":{}}      -> {"stdout","stderr","code","changed":[{path,mode,b64}],"deleted":[path],"dirs":[path],"scratch":{...}}
//!   {"op":"busy"}                                   -> {"busy":bool,"procs":[...],changed,deleted,dirs}
//!   {"op":"state"}                                  -> {"files":n,"sample":[path]}
//! Every reply that can carry files reports what differs from the host's copy, whenever it changed, so work by a process the agent left
//! running is not lost between commands. Paths are relative to the area's root. The workspace lives at the same absolute path in the
//! guest as on the host. A second area, the guest's scratch directory, travels the same way under the key "scratch".
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The host ships this file and the image carries a build of it. An image built from an older one answers a protocol the host no
/// longer speaks, and the failures that follow look like anything but a stale build, so say which copy this is and let the host object.
fn version() -> String {
    let d = Sha256::digest(include_bytes!("main.rs"));
    d[..6].iter().map(|b| format!("{b:02x}")).collect()
}

/// must match SKIP in the host's manifest
const EXCLUDE_DIRS: &[&str] = &["node_modules", ".git"];

type Sig = (i64, u64); // mtime in ns, size
type Snap = (HashMap<String, Sig>, BTreeSet<String>);

fn snapshot(root: &Path) -> Snap {
    fn walk(dir: &Path, rel: &Path, files: &mut HashMap<String, Sig>, dirs: &mut BTreeSet<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(md) = fs::symlink_metadata(e.path()) else { continue };
            let r = rel.join(&name);
            if md.is_dir() {
                if EXCLUDE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                dirs.insert(r.to_string_lossy().to_string());
                walk(&e.path(), &r, files, dirs);
            } else if md.is_file() {
                files.insert(r.to_string_lossy().to_string(), (md.mtime() * 1_000_000_000 + md.mtime_nsec(), md.len()));
            }
        }
    }
    let (mut files, mut dirs) = (HashMap::new(), BTreeSet::new());
    walk(root, Path::new(""), &mut files, &mut dirs);
    (files, dirs)
}

fn read_file(root: &Path, rel: &str) -> Value {
    let full = root.join(rel);
    let data = fs::read(&full).unwrap_or_default();
    json!({"path": rel, "mode": fs::metadata(&full).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o644), "b64": STANDARD.encode(data)})
}

/// A path under root, lexically: an escape through `..` is an error.
fn safe(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            std::path::Component::Normal(n) => out.push(n),
            std::path::Component::ParentDir => {
                if !out.pop() || !out.starts_with(root) {
                    return Err(format!("path escapes workspace: {rel}"));
                }
            }
            _ => {}
        }
    }
    if out.starts_with(root) { Ok(out) } else { Err(format!("path escapes workspace: {rel}")) }
}

/// A directory the host keeps in step with the guest, and what the host is known to hold of it.
///
/// Diffing a command against what the host holds rather than against the directory as it stood when the command started is what makes
/// writes by anything the agent left running (a cron, a dev server, a build watcher) visible at all: those land between commands, so a
/// before and after pair taken around one command cannot see them.
struct Area {
    root: PathBuf,
    synced: Snap,
}

impl Area {
    fn new(root: PathBuf, synced: Snap) -> Self {
        Area { root, synced }
    }

    /// Everything that differs from what the host holds, and reset the mark. This is the only report the host gets, so it has to cover
    /// changes made at any time, not only during a command.
    fn drift(&mut self) -> Value {
        let (before, before_dirs) = std::mem::take(&mut self.synced);
        let after = snapshot(&self.root);
        let changed: Vec<Value> = after.0.iter().filter(|(r, v)| before.get(*r) != Some(v)).map(|(r, _)| read_file(&self.root, r)).collect();
        let deleted: Vec<&String> = before.keys().filter(|r| !after.0.contains_key(*r)).collect();
        let dirs: Vec<&String> = after.1.difference(&before_dirs).collect();
        let out = json!({"changed": changed, "deleted": deleted, "dirs": dirs});
        self.synced = after;
        out
    }

    /// Take what the host changed, and return the paths this side refused to overwrite.
    fn sync(&mut self, req: &Value) -> Vec<String> {
        let held = std::mem::take(&mut self.synced).0;
        let mut conflicts = Vec::new();
        let list = |k: &str| req.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        for rel in list("delete") {
            if let Ok(p) = safe(&self.root, rel.as_str().unwrap_or("")) {
                let _ = fs::remove_file(p);
            }
        }
        for rel in list("dirs") {
            if let Ok(p) = safe(&self.root, rel.as_str().unwrap_or("")) {
                let _ = fs::create_dir_all(p);
            }
        }
        for f in list("files") {
            let rel = f["path"].as_str().unwrap_or("");
            let Ok(full) = safe(&self.root, rel) else { continue };
            // the guest moved this on too, so the host's copy is not an update but a competing version. The side with something running
            // wins, and says so.
            if let Ok(md) = fs::symlink_metadata(&full) {
                if md.is_file() && held.get(rel) != Some(&(md.mtime() * 1_000_000_000 + md.mtime_nsec(), md.len())) {
                    conflicts.push(rel.to_string());
                    continue;
                }
            }
            if let Some(parent) = full.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let data = STANDARD.decode(f["b64"].as_str().unwrap_or("")).unwrap_or_default();
            if fs::write(&full, data).is_ok() {
                let _ = fs::set_permissions(&full, fs::Permissions::from_mode(f["mode"].as_u64().unwrap_or(0o644) as u32));
            }
        }
        let (mut held_now, dirs_now) = snapshot(&self.root);
        // A file we refused still differs from what the host has, so it must stay marked as ours to report, otherwise the refusal is
        // silent and the two never converge.
        for rel in &conflicts {
            held_now.remove(rel);
        }
        self.synced = (held_now, dirs_now);
        conflicts
    }
}

struct Agent {
    root: PathBuf,
    upper: Option<PathBuf>,
    workspace: Area,
    scratch: Option<Area>,
    /// what was already in the upper layer when the agent started, which the pristine snapshot holds
    baseline: HashMap<String, Sig>,
}

impl Agent {
    /// Everything in the guest that a release could lose, as path -> (mtime, size). The workspace and scratch space are the host's and
    /// are pushed back on every wake, and bytecode caches regenerate, so none of them counts. What is left is real: a package installed,
    /// a file written outside the workspace, a file removed from the image.
    fn entries(&self) -> HashMap<String, Sig> {
        let mut out = HashMap::new();
        let Some(upper) = &self.upper else { return out };
        let ws = self.root.strip_prefix("/").unwrap_or(&self.root).to_path_buf();
        fn walk(base: &Path, dir: &Path, ws: &Path, out: &mut HashMap<String, Sig>) {
            let Ok(rd) = fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let Ok(md) = fs::symlink_metadata(e.path()) else { continue };
                if md.is_dir() {
                    let rel = e.path().strip_prefix(base).unwrap_or(Path::new("")).to_path_buf();
                    if e.file_name() == "__pycache__" || rel == ws {
                        continue;
                    }
                    walk(base, &e.path(), ws, out);
                } else {
                    out.insert(e.path().to_string_lossy().to_string(), (md.mtime() * 1_000_000_000 + md.mtime_nsec(), md.len()));
                }
            }
        }
        walk(upper, upper, &ws, &mut out);
        out
    }

    fn local_state(&self) -> Value {
        let mut changed: Vec<String> = self.entries().into_iter().filter(|(p, v)| self.baseline.get(p) != Some(v)).map(|(p, _)| p).collect();
        changed.sort();
        json!({"files": changed.len(), "sample": changed.iter().take(5).collect::<Vec<_>>()})
    }

    fn drift(&mut self) -> Value {
        let mut out = self.workspace.drift();
        if let Some(s) = &mut self.scratch {
            out["scratch"] = s.drift();
        }
        out
    }

    /// Processes in the guest that the agent did not spawn for the request in hand. A command that backgrounds a server returns immediately,
    /// so "no command running" is not the same as "nothing running". The host has to know the difference before it kills the VM, because
    /// the next wake restores a pristine snapshot and anything still in here would vanish without a trace. Only userspace descendants of
    /// init count: kernel threads hang off kthreadd (pid 2), and the agent's own ancestor chain is its own doing.
    fn live_processes(&self) -> Vec<Value> {
        let ppid = |pid: i32| -> Option<i32> {
            let s = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            s[s.rfind(") ")? + 2..].split(' ').nth(1)?.parse().ok()
        };
        let mut mine = std::collections::HashSet::new();
        let mut pid = std::process::id() as i32;
        while pid > 1 && mine.insert(pid) {
            match ppid(pid) {
                Some(p) => pid = p,
                None => break,
            }
        }
        let mut out = Vec::new();
        for e in fs::read_dir("/proc").into_iter().flatten().flatten() {
            let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else { continue };
            if pid <= 1 || mine.contains(&pid) {
                continue;
            }
            match fs::read(format!("/proc/{pid}/cmdline")) {
                Ok(c) if c.iter().any(|b| *b != 0) => {}
                _ => continue, // kernel thread: no userspace at all
            }
            let (mut walk, mut seen) = (pid, std::collections::HashSet::new());
            while walk > 1 && seen.insert(walk) {
                match ppid(walk) {
                    Some(p) => walk = p,
                    None => break,
                }
            }
            if walk != 1 {
                continue; // rooted at kthreadd, or gone: not something the agent started
            }
            if let Ok(comm) = fs::read_to_string(format!("/proc/{pid}/comm")) {
                out.push(json!({"pid": pid, "comm": comm.trim()}));
            }
        }
        out
    }

    fn handle(&mut self, req: &Value) -> Value {
        match req["op"].as_str().unwrap_or("") {
            "ping" => json!({"ok": true, "agent": version()}),
            "clock" => {
                // A snapshot restore leaves the guest's wall clock where it was when the snapshot was taken, and it stays that far behind.
                // Anything scheduled by the clock, every file timestamp, and TLS certificate validity all depend on it being right.
                let epoch = req["epoch"].as_f64().unwrap_or(0.0);
                let ts = libc::timespec { tv_sec: epoch as i64, tv_nsec: ((epoch.fract()) * 1e9) as i64 };
                unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &ts) };
                json!({"ok": true})
            }
            "state" => self.local_state(),
            "busy" => {
                let procs = self.live_processes();
                // whatever is still running has been writing; hand that over while reporting it, so a pinned VM does not drift further
                // from the host the longer it runs
                let mut out = self.drift();
                out["busy"] = json!(!procs.is_empty());
                out["procs"] = json!(procs);
                out
            }
            "sync" => {
                let mut conflicts = self.workspace.sync(req);
                if let Some(s) = &mut self.scratch {
                    conflicts.extend(s.sync(req.get("scratch").unwrap_or(&Value::Null)).into_iter().map(|c| format!("scratch:{c}")));
                }
                json!({"ok": true, "conflicts": conflicts})
            }
            "exec" => {
                let cwd = req["cwd"].as_str().map(PathBuf::from).unwrap_or_else(|| self.root.clone());
                let mut cmd = Command::new("bash");
                cmd.arg("-c").arg(req["cmd"].as_str().unwrap_or("")).current_dir(cwd);
                if let Some(env) = req["env"].as_object() {
                    for (k, v) in env {
                        cmd.env(k, v.as_str().unwrap_or(""));
                    }
                }
                let out = cmd.output();
                let mut r = self.drift();
                match out {
                    Ok(o) => {
                        r["stdout"] = json!(String::from_utf8_lossy(&o.stdout));
                        r["stderr"] = json!(String::from_utf8_lossy(&o.stderr));
                        use std::os::unix::process::ExitStatusExt;
                        r["code"] = json!(o.status.code().unwrap_or_else(|| -o.status.signal().unwrap_or(1)));
                    }
                    Err(e) => {
                        r["stdout"] = json!("");
                        r["stderr"] = json!(e.to_string());
                        r["code"] = json!(127);
                    }
                }
                r
            }
            other => json!({"error": format!("unknown op {other}")}),
        }
    }
}

fn serve(conn: impl std::io::Read + Write + Clone, agent: &mut Agent) {
    let mut w = conn.clone();
    for line in BufReader::new(conn).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(&line) {
            Ok(req) => agent.handle(&req),
            Err(e) => json!({"error": e.to_string()}),
        };
        if writeln!(w, "{resp}").and_then(|_| w.flush()).is_err() {
            break;
        }
    }
}

/// A connection that is one descriptor, readable and writable from two handles.
#[derive(Clone)]
struct Conn(std::sync::Arc<fs::File>);
impl std::io::Read for Conn {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        (&*self.0).read(b)
    }
}
impl Write for Conn {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        (&*self.0).write(b)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn main() {
    let (mut workspace, mut port, mut unix, mut upper, mut scratch) = (None, None, None, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let v = args.next();
        match a.as_str() {
            "--workspace" => workspace = v,
            "--vsock-port" => port = v.and_then(|p| p.parse::<u32>().ok()),
            "--unix" => unix = v,
            "--upper" => upper = v,
            "--scratch" => scratch = v,
            _ => {}
        }
    }
    let root = PathBuf::from(workspace.expect("--workspace"));
    let _ = fs::create_dir_all(&root);
    let root = fs::canonicalize(&root).unwrap_or(root);
    let mut agent = Agent {
        workspace: Area::new(root.clone(), Default::default()),
        scratch: scratch.map(|s| {
            let p = PathBuf::from(s);
            // whatever is in it now was put there by the image, not by a tenant, and is not the host's to hold
            let held = snapshot(&p);
            Area::new(p, held)
        }),
        upper: upper.map(PathBuf::from),
        baseline: HashMap::new(),
        root,
    };
    agent.baseline = agent.entries();
    let listener = unsafe {
        if let Some(port) = port {
            let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
            assert!(fd >= 0, "vsock socket: {}", std::io::Error::last_os_error());
            let mut addr: libc::sockaddr_vm = std::mem::zeroed();
            addr.svm_family = libc::AF_VSOCK as _;
            addr.svm_port = port;
            addr.svm_cid = libc::VMADDR_CID_ANY;
            assert_eq!(libc::bind(fd, (&addr as *const libc::sockaddr_vm).cast(), std::mem::size_of::<libc::sockaddr_vm>() as u32), 0, "bind: {}", std::io::Error::last_os_error());
            assert_eq!(libc::listen(fd, 1), 0);
            fd
        } else {
            let path = unix.expect("--unix or --vsock-port");
            let _ = fs::remove_file(&path);
            let l = std::os::unix::net::UnixListener::bind(path).expect("bind");
            std::os::fd::IntoRawFd::into_raw_fd(l)
        }
    };
    println!("agent ready");
    let _ = std::io::stdout().flush();
    loop {
        // close-on-exec, or every command the agent starts would inherit the connection and keep it open after the agent is gone
        let c = unsafe { libc::accept4(listener, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
        if c < 0 {
            continue;
        }
        let conn = Conn(std::sync::Arc::new(unsafe { fs::File::from_raw_fd(c) }));
        serve(conn, &mut agent);
    }
}

