//! Routes an agent's commands. A command that only touches files runs in the cheap sandbox on the host; one that needs a machine runs in a
//! microVM, which is released when idle and brought back on the next command.
use crate::fileops::{file_command, FileCall};
use crate::router::{classify, known_for_sandbox, Decision, Tier};
use crate::sandbox::{Sandbox, SandboxOptions};
use crate::vm::{Live, VmBackend};
use crate::vmm::{MicroVm, VmOptions, Vmm};
use anyhow::{anyhow, bail, Result};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct SandrouteOptions {
    /// Real directory the agent works in. Mounted in the sandbox and shared with the VM.
    pub workspace: PathBuf,
    pub vm: Arc<dyn VmBackend>,
    /// Append one JSON line per command with the routing decision.
    pub log_file: Option<PathBuf>,
    /// Release the VM after this long with no VM-tier command, and bring it back on the next one. Unset keeps it up for the whole session,
    /// which means one early heavy command pays for the rest of the turn.
    pub idle: Option<Duration>,
    /// Send every command to the VM, skipping the light tier. With `idle` this is the comparison the routing has to beat: a machine that
    /// is also released when idle, but where every command wakes it.
    pub all_in_vm: bool,
    /// The sandbox the light tier runs in, one native process per command. Required unless every command goes to the VM.
    pub light: Option<Sandbox>,
    /// The path the agent sees its workspace at, when that is not the real one. Commands, the file tools and the VM all use it, so a
    /// tenant's host layout never reaches it. Defaults to the real path.
    pub workspace_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub tier: Tier,
    pub reason: String,
    /// True when this command is the one that booted the VM.
    pub booted: bool,
    /// Of `ms`, how much went on booting or waking the VM.
    pub boot_ms: u64,
    pub ms: u64,
}

#[derive(Default)]
struct Life {
    up: bool,
}

#[derive(Default)]
struct Meter {
    alloc: Duration,
    since: Option<Instant>,
}

struct Core {
    o: SandrouteOptions,
    known: HashSet<String>,
    at: String,
    life: tokio::sync::Mutex<Life>,
    in_flight: AtomicUsize,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    meter: Mutex<Meter>,
    boot_count: AtomicU64,
    release_count: AtomicU64,
    pinned_count: AtomicU64,
    last_pinned: Mutex<Vec<(i64, String)>>,
    last_pinned_error: Mutex<Option<String>>,
    conflicts: Mutex<Vec<String>>,
}

#[derive(Clone)]
pub struct Sandroute {
    c: Arc<Core>,
    /// Scratch space this sandbox made for itself (session snapshots, and the workspace for `create`), removed by `close`.
    root: Option<PathBuf>,
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil date from days since the epoch
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let (y, doy) = (yoe + era * 400, doe - (365 * yoe + yoe / 4 - yoe / 100));
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

impl Core {
    fn log(&self, v: serde_json::Value) {
        if let Some(f) = &self.o.log_file {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(file, "{v}");
            }
        }
    }

    fn vm_allocated(&self) -> Duration {
        let m = self.meter.lock().unwrap();
        m.alloc + m.since.map(|s| s.elapsed()).unwrap_or_default()
    }

    fn close_meter(&self) {
        let mut m = self.meter.lock().unwrap();
        if let Some(s) = m.since.take() {
            m.alloc += s.elapsed();
        }
    }

    fn clear_timer(&self) {
        if let Some(t) = self.timer.lock().unwrap().take() {
            t.abort();
        }
    }
}

impl Sandroute {
    pub fn new(o: SandrouteOptions) -> Result<Self> {
        if o.light.is_none() && !o.all_in_vm {
            bail!("a light sandbox is required unless every command goes to the VM");
        }
        let at = o.workspace_path.clone().unwrap_or_else(|| o.workspace.to_string_lossy().to_string());
        let c = Arc::new(Core {
            known: known_for_sandbox(), at, life: Default::default(), in_flight: AtomicUsize::new(0), timer: Default::default(), meter: Default::default(),
            boot_count: AtomicU64::new(0), release_count: AtomicU64::new(0), pinned_count: AtomicU64::new(0), last_pinned: Default::default(),
            last_pinned_error: Default::default(), conflicts: Default::default(), o,
        });
        let weak = Arc::downgrade(&c);
        c.o.vm.on_conflict(Box::new(move |paths| {
            if let Some(c) = weak.upgrade() {
                c.log(json!({"t": now_iso(), "conflicts": paths}));
                c.conflicts.lock().unwrap().extend(paths);
            }
        }));
        Ok(Sandroute { c, root: None })
    }

    /// A sandbox with defaults, for trying it out: a fresh workspace, the light sandbox, and Firecracker VMs restored from one shared snapshot,
    /// from the kernel and image in `$SANDROUTE_ASSETS` (default `~/fcassets`, made by `scripts/setup.sh`). A VM is only started when a command
    /// needs one, and is released after five idle seconds. Call `close` when done.
    pub async fn create() -> Result<Self> {
        Self::create_with(1, 256).await
    }

    /// `create` with a VM of `cpus` vCPUs and `mem_mib` MiB of memory. Sandboxes of one size share one snapshot, so a new size boots once more.
    pub async fn create_with(cpus: u32, mem_mib: u32) -> Result<Self> {
        let root = tempfile::Builder::new().prefix("sandroute-").tempdir()?.keep();
        let workspace = root.join("work");
        std::fs::create_dir_all(&workspace)?;
        Self::build(workspace, root, cpus, mem_mib).await
    }

    /// The same, over a directory that already exists, such as a project. Its files are seen at `/work` inside the sandbox, `close` leaves
    /// them alone, and changes the sandbox makes land in the directory.
    pub async fn open(dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(dir, 1, 256).await
    }

    /// `open` with a VM of `cpus` vCPUs and `mem_mib` MiB of memory.
    pub async fn open_with(dir: impl AsRef<Path>, cpus: u32, mem_mib: u32) -> Result<Self> {
        let root = tempfile::Builder::new().prefix("sandroute-").tempdir()?.keep();
        Self::build(dir.as_ref().canonicalize()?, root, cpus, mem_mib).await
    }

    async fn build(workspace: PathBuf, root: PathBuf, cpus: u32, mem_mib: u32) -> Result<Self> {
        static PRIMED: std::sync::Mutex<Option<HashMap<(u32, u32), Arc<tokio::sync::OnceCell<()>>>>> = std::sync::Mutex::new(None);
        let assets = std::env::var("SANDROUTE_ASSETS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("fcassets"));
        let vm = |root: &Path| {
            let mut o = VmOptions::new(Vmm::Firecracker, assets.join("vmlinux-6.1.128").to_string_lossy(), assets.join("rootfs.ext4").to_string_lossy());
            o.bin = Some(assets.join("firecracker").to_string_lossy().into());
            o.vcpus = Some(cpus);
            o.mem_mib = Some(mem_mib);
            o.guest_workspace = Some("/work".into());
            o.snapshot_dir = Some(assets.join(format!("pristine-{cpus}c-{mem_mib}m")));
            o.session_dir = Some(root.join("sessions"));
            MicroVm::new(o)
        };
        // the first boot of a size writes its shared snapshot, so it happens once and the sandboxes of that size created meanwhile wait for it
        let primed = PRIMED.lock().unwrap().get_or_insert_with(HashMap::new).entry((cpus, mem_mib)).or_default().clone();
        primed.get_or_try_init(|| async {
            let prime = tempfile::Builder::new().prefix("sandroute-prime-").tempdir()?;
            let warm = vm(prime.path());
            warm.boot(&prime.path().join("work")).await?;
            warm.stop().await
        }).await?;
        let mut sandbox = Sandroute::new(SandrouteOptions {
            light: Some(Sandbox::new(SandboxOptions::new(&workspace).mount_at("/work"))),
            vm: Arc::new(vm(&root)), workspace, log_file: None, idle: Some(Duration::from_secs(5)), all_in_vm: false, workspace_path: Some("/work".into()),
        })?;
        sandbox.root = Some(root);
        Ok(sandbox)
    }

    /// Stop the VM if one is up and delete what `create` or `open` made for itself.
    pub async fn close(self) -> Result<()> {
        self.stop().await?;
        if let Some(root) = &self.root {
            std::fs::remove_dir_all(root)?;
        }
        Ok(())
    }

    pub fn vm(&self) -> &Arc<dyn VmBackend> {
        &self.c.o.vm
    }
    pub fn boot_count(&self) -> u64 {
        self.c.boot_count.load(Ordering::Relaxed)
    }
    pub fn release_count(&self) -> u64 {
        self.c.release_count.load(Ordering::Relaxed)
    }
    /// Times a release was refused because something was still alive in the VM.
    pub fn pinned_count(&self) -> u64 {
        self.c.pinned_count.load(Ordering::Relaxed)
    }
    /// What was still running the last time a release was refused.
    pub fn last_pinned(&self) -> Vec<(i64, String)> {
        self.c.last_pinned.lock().unwrap().clone()
    }
    /// Why the last release was refused, when the machine could not be asked.
    pub fn last_pinned_error(&self) -> Option<String> {
        self.c.last_pinned_error.lock().unwrap().clone()
    }
    /// Paths the guest kept its own version of because both sides had changed them.
    pub fn conflicts(&self) -> Vec<String> {
        self.c.conflicts.lock().unwrap().clone()
    }
    /// Wall time the VM has been allocated so far, counting any stretch still open: what a microVM actually costs.
    pub fn vm_allocated(&self) -> Duration {
        self.c.vm_allocated()
    }

    pub async fn run(&self, command: &str, cwd: Option<&str>) -> Result<RunResult> {
        let c = &self.c;
        let t0 = Instant::now();
        let d: Decision = if c.o.all_in_vm { Decision { tier: Tier::Vm, reason: "all commands run in the VM".into() } } else { classify(&c.known, command, &c.at) };
        let (mut booted, mut boot_ms) = (false, 0);
        let (stdout, stderr, exit_code);
        if d.tier == Tier::Light {
            let r = c.o.light.as_ref().expect("checked at construction").exec(command, cwd, &BTreeMap::new()).await;
            (stdout, stderr, exit_code) = (r.stdout, r.stderr, r.exit_code);
        } else {
            c.clear_timer();
            c.in_flight.fetch_add(1, Ordering::SeqCst);
            let r = async {
                (booted, boot_ms) = self.ensure_up().await?;
                c.o.vm.exec(command, cwd.unwrap_or(&c.at), None).await
            }
            .await;
            c.in_flight.fetch_sub(1, Ordering::SeqCst);
            self.arm_idle();
            let r = r?;
            (stdout, stderr, exit_code) = (r.stdout, r.stderr, r.exit_code);
        }
        let out = RunResult { stdout, stderr, exit_code, tier: d.tier, reason: d.reason, booted, boot_ms, ms: t0.elapsed().as_millis() as u64 };
        c.log(json!({"t": now_iso(), "command": command, "tier": out.tier.as_str(), "reason": out.reason, "booted": booted, "bootMs": boot_ms, "ms": out.ms,
            "exitCode": out.exit_code, "vmAllocatedMs": c.vm_allocated().as_millis() as u64}));
        Ok(out)
    }

    /// Bring the VM up if it is down. A release in progress finishes first: booting over it would run two machines for one session, and the
    /// old one's cleanup would take the new one down with it. The lifecycle lock is what makes both a boot and a release one at a time.
    async fn ensure_up(&self) -> Result<(bool, u64)> {
        let c = &self.c;
        let mut life = c.life.lock().await;
        if life.up {
            return Ok((false, 0));
        }
        let tb = Instant::now();
        // the meter starts when the machine starts, not when the command does
        c.meter.lock().unwrap().since = Some(tb);
        if let Err(e) = c.o.vm.boot(&c.o.workspace).await {
            c.meter.lock().unwrap().since = None;
            return Err(e);
        }
        life.up = true;
        c.boot_count.fetch_add(1, Ordering::Relaxed);
        Ok((true, tb.elapsed().as_millis() as u64))
    }

    /// A hint from the harness: a turn is starting and the agent will probably want the VM, so bring it up now, while the model is still
    /// thinking about its first command, and not when the command arrives. It costs a wake for a turn that never needs one, so it is for a
    /// harness that has reason to expect a VM.
    pub async fn prewarm(&self) -> Result<()> {
        self.c.clear_timer();
        self.c.in_flight.fetch_add(1, Ordering::SeqCst);
        let r = self.ensure_up().await;
        self.c.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.arm_idle();
        r.map(|_| ())
    }

    fn arm_idle(&self) {
        let Some(idle) = self.c.o.idle else { return };
        if self.c.in_flight.load(Ordering::SeqCst) > 0 {
            return;
        }
        self.c.clear_timer();
        let me = self.clone();
        let t = tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            // This task is the stored timer, and release() cancels the stored timer: detach first, or a release would cancel itself halfway.
            drop(me.c.timer.lock().unwrap().take());
            let _ = me.release().await;
        });
        *self.c.timer.lock().unwrap() = Some(t);
    }

    /// Hand the VM back. A harness that knows its agent's turn has ended calls this at once, instead of leaving the idle timer to find
    /// out. The next VM-tier command brings one up again, which is cheap when the backend restores a snapshot. Safe to call at any time:
    /// a command in flight keeps the VM, and the idle timer re-arms when it finishes.
    ///
    /// A command that backgrounds a server returns straight away, so an idle timer alone would kill it, and since the next wake restores a
    /// pristine snapshot, it would vanish without a trace. While anything is alive in there, the VM is pinned.
    pub async fn release(&self) -> Result<bool> {
        let c = &self.c;
        c.clear_timer();
        if c.in_flight.load(Ordering::SeqCst) > 0 {
            return Ok(false);
        }
        let mut life = c.life.lock().await;
        if !life.up || c.in_flight.load(Ordering::SeqCst) > 0 {
            return Ok(false);
        }
        let live = match c.o.vm.busy().await {
            Ok(l) => l,
            Err(e) => {
                // Cannot prove it is idle, so keep it, but a probe that always fails pins the VM forever, which looks exactly like a
                // machine that is legitimately busy.
                *c.last_pinned_error.lock().unwrap() = Some(e.to_string());
                c.log(json!({"t": now_iso(), "pinnedBy": "probe failed", "error": e.to_string()}));
                Some(Live { busy: true, procs: vec![] })
            }
        };
        if let Some(l) = live.filter(|l| l.busy) {
            c.pinned_count.fetch_add(1, Ordering::Relaxed);
            *c.last_pinned.lock().unwrap() = l.procs;
            drop(life);
            self.arm_idle(); // look again later
            return Ok(false);
        }
        if c.in_flight.load(Ordering::SeqCst) > 0 {
            return Ok(false); // a command arrived while we asked
        }
        life.up = false;
        c.close_meter();
        c.release_count.fetch_add(1, Ordering::Relaxed);
        // keep what the guest accumulated, if the backend can; a clean restore would drop it
        if !c.o.vm.suspend().await? {
            c.o.vm.stop().await?;
        }
        Ok(true)
    }

    pub async fn stop(&self) -> Result<()> {
        self.c.clear_timer();
        let mut life = self.c.life.lock().await;
        self.c.close_meter();
        life.up = false;
        // Whether or not it is up: a suspended session is a snapshot on disk, and ending the session is the only thing that deletes it.
        self.c.o.vm.stop().await
    }

    // ---- the file tools ------------------------------------------------------------------------------------------------------------

    /// The file tools are commands too, run wherever commands are: the sandbox, or the VM when every command goes there.
    async fn in_sandbox(&self, call: FileCall) -> Result<String> {
        let command = file_command(&call);
        let (stdout, stderr, code) = if self.c.o.all_in_vm {
            let r = self.run(&command, None).await?;
            (r.stdout, r.stderr, r.exit_code)
        } else {
            let r = self.c.o.light.as_ref().unwrap().exec(&command, None, &BTreeMap::new()).await;
            (r.stdout, r.stderr, r.exit_code)
        };
        if code != 0 {
            bail!("{}", if stderr.trim().is_empty() { format!("exit {code}") } else { stderr.trim().to_string() });
        }
        Ok(stdout)
    }

    fn resolve(&self, file: &str) -> String {
        if Path::new(file).is_absolute() { file.to_string() } else { Path::new(&self.c.at).join(file).to_string_lossy().to_string() }
    }

    /// File tools are still agent activity and belong in the log.
    async fn file_op<T>(&self, op: &str, file: &str, f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        let t0 = Instant::now();
        let r = f.await;
        self.c.log(json!({"t": now_iso(), "command": format!("{op} {file}"), "tier": "light", "reason": "file tool, served by the sandbox", "booted": false, "bootMs": 0,
            "ms": t0.elapsed().as_millis() as u64, "exitCode": if r.is_err() { 1 } else { 0 }, "vmAllocatedMs": self.c.vm_allocated().as_millis() as u64}));
        r
    }

    pub async fn read_file(&self, file: &str, offset: Option<usize>, limit: Option<usize>) -> Result<String> {
        self.file_op("read", file, self.in_sandbox(FileCall::Read { file_path: self.resolve(file), offset, limit })).await
    }

    pub async fn write_file(&self, file: &str, content: &str) -> Result<()> {
        self.file_op("write", file, self.in_sandbox(FileCall::Write { file_path: self.resolve(file), content: content.to_string() })).await.map(|_| ())
    }

    pub async fn edit_file(&self, file: &str, old_string: &str, new_string: &str, replace_all: bool) -> Result<usize> {
        let call = FileCall::Edit { file_path: self.resolve(file), old_string: old_string.to_string(), new_string: new_string.to_string(), replace_all };
        let out = self.file_op("edit", file, self.in_sandbox(call)).await?;
        out.trim().parse().map_err(|_| anyhow!("unexpected reply from the edit: {out}"))
    }

    pub async fn glob(&self, pattern: &str, dir: Option<&str>) -> Result<Vec<String>> {
        let call = FileCall::Glob { pattern: pattern.to_string(), path: dir.map(String::from) };
        Ok(self.run(&file_command(&call), None).await?.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    }

    pub async fn grep_files(&self, pattern: &str, dir: Option<&str>, include: Option<&str>) -> Result<Vec<String>> {
        let call = FileCall::Grep { pattern: pattern.to_string(), path: dir.map(String::from), include: include.map(String::from) };
        Ok(self.run(&file_command(&call), None).await?.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    }
}
