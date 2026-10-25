//! How many tenants can one machine serve, when the tenants behave like people?
//!
//! People are mostly away. A tenant is idle for minutes, hands the agent a task, and the agent works for a while: a few tool calls separated
//! by the seconds the model takes to think. This replays that. Each task is a real recorded agent session: the same calls and the same think
//! times, against a workspace that starts as the same small project.
//!
//! Ways to give each tenant a sandbox, all through the same Sandroute type:
//!   kept       a microVM per tenant, booted up front and never released. The simple thing.
//!   suspend    a microVM per tenant, snapshotted or thrown away after an idle window and restored on the next command.
//!   reclaim    a microVM per tenant killed after an idle window and cold booted on the next command, as Claude Code is described to work.
//!   oxroute    commands that only touch files run in a namespace sandbox with no VM, and a microVM only for the rest, released the same way.
//!   kata, gvisor            a pod per tenant through the Kubernetes CRI, kept up.
//!   kata-cold, gvisor-cold  the same, but a pod is deleted after the idle window and the next command boots a new one.
//!
//!   cargo run --release --bin tenants -- --design oxroute --tenants 64 --minutes 6
use anyhow::Result;
use sandroute::cri::{CriOptions, CriVm};
use sandroute::sandbox::{Sandbox, SandboxOptions};
use sandroute::sandroute::{Sandroute, SandrouteOptions};
use sandroute::traces::{self, Call, Trace};
use sandroute::vm::{KillOnRelease, VmBackend};
use sandroute::vmm::{MicroVm, VmOptions, Vmm};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Rng(Mutex<u32>);
impl Rng {
    /// mulberry32
    fn next(&self) -> f64 {
        let mut a = self.0.lock().unwrap();
        *a = a.wrapping_add(0x6d2b79f5);
        let mut t = (*a ^ (*a >> 15)).wrapping_mul(1 | *a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    fn normal(&self) -> f64 {
        (-2.0 * (1.0 - self.next()).ln()).sqrt() * (2.0 * std::f64::consts::PI * self.next()).cos()
    }
}

struct Rec {
    tenant: usize,
    tool: String,
    tier: String,
    ms: u64,
    woke: bool,
    err: Option<String>,
    at: u64,
    at_ms: u64,
    label: String,
    out: String,
    own_ms: u64,
}

struct Cfg {
    design: String,
    is_cri: bool,
    n: usize,
    minutes: u64,
    idle_mean: f64,
    window: Duration,
    mem: u32,
    vmm: Vmm,
    vcpus: u32,
    no_snapshot: bool,
    kill_on_release: bool,
    hint_start: bool,
    hint_end: bool,
    balloon: bool,
    seed: u32,
    slo_p99: u64,
    run: PathBuf,
    assets: PathBuf,
    fixture: PathBuf,
}

fn arg(name: &str, default: &str) -> String {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned().unwrap_or_else(|| default.to_string())
}
fn flag(name: &str) -> bool {
    std::env::args().any(|x| x == name)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type()?.is_dir() { copy_dir(&src, &dst)? } else { std::fs::copy(&src, &dst)?; }
    }
    Ok(())
}

/// A recorded task assumes the project as it was when recording began, so each task starts from a fresh copy. The platform does this on the
/// host, for every design alike; a microVM's copy catches up through the ordinary sync.
fn fresh(ws: &Path, fixture: &Path) -> Result<()> {
    for e in std::fs::read_dir(ws)?.flatten() {
        let p = e.path();
        let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
    }
    copy_dir(fixture, ws)
}

fn vm_options(c: &Cfg, i: i64) -> VmOptions {
    let ch = c.vmm == Vmm::CloudHypervisor;
    // Cloud Hypervisor needs PCI in the guest kernel, which the Firecracker one is built without, so it uses Kata's
    let kata = PathBuf::from(std::env::var("KATA_HOME").unwrap_or_else(|_| format!("{}/kata", std::env::var("HOME").unwrap_or_default()))).join("root/opt/kata");
    let (bin, kernel) = if ch {
        (kata.join("bin/cloud-hypervisor"), kata.join("share/kata-containers/vmlinux.container"))
    } else {
        (c.assets.join("firecracker"), c.assets.join("vmlinux-6.1.128"))
    };
    let mut o = VmOptions::new(c.vmm, kernel.to_string_lossy(), c.assets.join("rootfs.ext4").to_string_lossy());
    o.bin = Some(bin.to_string_lossy().into());
    o.vcpus = Some(c.vcpus);
    o.mem_mib = Some(c.mem);
    o.balloon = c.balloon;
    o.boot_args = c.balloon.then(|| "page_reporting.page_reporting_order=3".to_string());
    o.snapshot_dir = (!c.no_snapshot).then(|| c.assets.join(if ch { "pristine-tenants-ch" } else { "pristine-tenants" }));
    o.session_dir = Some(c.run.join(format!("sessions/{i}")));
    o.guest_workspace = Some("/work".into());
    o
}

fn sandbox_for(c: &Cfg, i: usize, ws: &Path) -> Result<Sandroute> {
    let (all_in_vm, idle, light): (bool, Option<Duration>, Option<Sandbox>) = match c.design.as_str() {
        "oxroute" => (false, Some(c.window), Some(Sandbox::new(SandboxOptions::new(ws).mount_at("/work")))),
        "kept" | "kata" | "gvisor" => (true, None, None),
        _ => (true, Some(c.window), None),
    };
    let vm: Arc<dyn VmBackend> = if c.is_cri {
        Arc::new(CriVm::new(CriOptions::from_env(), &i.to_string(), &c.run))
    } else if c.design == "reclaim" || c.kill_on_release {
        // a VM without suspend is killed on release, which is what reclaim is
        Arc::new(KillOnRelease(MicroVm::new(vm_options(c, i as i64))))
    } else {
        Arc::new(MicroVm::new(vm_options(c, i as i64)))
    };
    Sandroute::new(SandrouteOptions { workspace: ws.to_path_buf(), vm, log_file: None, idle, all_in_vm, light, workspace_path: Some("/work".into()) })
}

/// Runs one recorded call and returns where it ran, a short description of it, and the start of what it printed.
async fn perform(c: &Cfg, s: &Sandroute, call: &Call) -> Result<(String, String, String)> {
    let a = &call.args;
    let st = |k: &str| a.get(k).and_then(Value::as_str);
    let num = |k: &str| a.get(k).and_then(Value::as_u64).map(|n| n as usize);
    let mut out = String::new();
    match call.tool.as_str() {
        "bash" => {
            let r = s.run(st("command").unwrap_or(""), st("workdir")).await?;
            return Ok((r.tier.as_str().to_string(), st("command").unwrap_or("").to_string(), head(&r.stdout)));
        }
        "read" => out = head(&s.read_file(st("filePath").unwrap_or(""), num("offset"), num("limit")).await?),
        "write" => s.write_file(st("filePath").unwrap_or(""), st("content").unwrap_or("")).await?,
        "edit" => drop(s.edit_file(st("filePath").unwrap_or(""), st("oldString").unwrap_or(""), st("newString").unwrap_or(""), a.get("replaceAll").and_then(Value::as_bool).unwrap_or(false)).await?),
        "glob" => drop(s.glob(st("pattern").unwrap_or(""), st("path")).await?),
        "grep" => drop(s.grep_files(st("pattern").unwrap_or(""), st("path"), st("include")).await?),
        t => anyhow::bail!("unknown tool {t}"),
    }
    let label = format!("{} {}", call.tool, st("filePath").or(st("pattern")).unwrap_or(""));
    Ok((if c.design == "oxroute" { "light" } else { "vm" }.to_string(), label, out))
}

fn head(s: &str) -> String {
    s.lines().take(2).collect::<Vec<_>>().join("\n").chars().take(160).collect()
}

fn pct(xs: &[u64], p: f64) -> u64 {
    if xs.is_empty() { return 0; }
    let mut s = xs.to_vec();
    s.sort_unstable();
    s[(s.len() - 1).min((s.len() as f64 * p) as usize)]
}

// ---- what is measured ---------------------------------------------------------------------------------------------------------------

fn meminfo(k: &str) -> f64 {
    std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| t.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())).unwrap_or(0.0) / 1024.0
}
fn comm(p: &str) -> String {
    std::fs::read_to_string(format!("/proc/{p}/comm")).map(|s| s.trim().to_string()).unwrap_or_default()
}
fn proc_ids() -> Vec<String> {
    std::fs::read_dir("/proc").into_iter().flatten().flatten().filter_map(|e| e.file_name().to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())).map(String::from)).collect()
}
fn stat_fields(p: &str) -> Vec<String> {
    let f = std::fs::read_to_string(format!("/proc/{p}/stat")).unwrap_or_default();
    f.rfind(')').map(|i| f[i + 2..].split(' ').map(String::from).collect()).unwrap_or_default()
}
fn ticks(p: &str) -> u64 {
    let r = stat_fields(p);
    r.get(11).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) + r.get(12).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
}
fn kb(p: &str, file: &str, key: &str) -> f64 {
    std::fs::read_to_string(format!("/proc/{p}/{file}")).ok().and_then(|t| t.lines().find(|l| l.starts_with(key)).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())).unwrap_or(0.0) / 1024.0
}
fn dir_bytes(d: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| match e.metadata() { Ok(m) if m.is_dir() => dir_bytes(&e.path()), Ok(m) => m.blocks() * 512, _ => 0 }).sum()
}

/// The processes that are this run's own VMs and pods. A microVM is a child of this process; a pod is several root-owned processes, so for
/// those only RSS is readable and the machine's available memory is the number to trust.
fn vm_procs(c: &Cfg) -> Vec<String> {
    let me = std::process::id().to_string();
    proc_ids().into_iter().filter(|p| {
        let name = comm(p);
        if c.design.starts_with("gvisor") {
            name.contains("runsc") || name.contains("gvisor") || std::fs::read(format!("/proc/{p}/cmdline")).map(|b| String::from_utf8_lossy(&b).contains("runsc")).unwrap_or(false)
        } else if c.is_cri {
            ["cloud-hyperviso", "virtiofsd", "containerd-shim"].contains(&name.as_str())
        } else {
            name == if c.vmm == Vmm::Firecracker { "firecracker" } else { "cloud-hyperviso" } && stat_fields(p).get(1).map(|v| v == &me).unwrap_or(false)
        }
    }).collect()
}
fn vm_count(c: &Cfg, ps: &[String]) -> usize {
    if !c.is_cri { return ps.len(); }
    ps.iter().filter(|p| comm(p) == if c.design.starts_with("gvisor") { "containerd-shim" } else { "cloud-hyperviso" }).count()
}

#[derive(Default)]
struct Prev {
    cpu: Vec<f64>,
    self_ticks: u64,
    fc: HashMap<String, u64>,
    pss: f64,
    sessions: f64,
    n: u64,
}

fn cpu_now() -> Vec<f64> {
    std::fs::read_to_string("/proc/stat").unwrap_or_default().lines().next().unwrap_or("").split_whitespace().skip(1).take(8).filter_map(|v| v.parse().ok()).collect()
}

fn sample(c: &Cfg, prev: &mut Prev, started: Instant, active: i64) -> Value {
    let cpu = cpu_now();
    let d: Vec<f64> = cpu.iter().zip(prev.cpu.iter().chain(std::iter::repeat(&0.0))).map(|(a, b)| a - b).collect();
    let tot = d.iter().sum::<f64>().max(1.0);
    prev.cpu = cpu;
    let me = std::process::id().to_string();
    let fc = vm_procs(c);
    let self_t = ticks(&me);
    let self_pct = self_t.saturating_sub(prev.self_ticks);
    prev.self_ticks = self_t;
    let mut fc_pct = 0.0;
    let mut now_fc = HashMap::new();
    for p in &fc {
        let t = ticks(p);
        fc_pct += t.saturating_sub(*prev.fc.get(p).unwrap_or(&t)) as f64;
        now_fc.insert(p.clone(), t);
    }
    prev.fc = now_fc;
    // memory per process is read every few seconds: reading hundreds of smaps_rollup files a second is itself a load on the machine
    if prev.n % 5 == 0 {
        prev.pss = fc.iter().map(|p| if c.is_cri { kb(p, "status", "VmRSS") } else { kb(p, "smaps_rollup", "Pss:") }).sum();
        prev.sessions = dir_bytes(&c.run.join("sessions")) as f64 / (1u64 << 30) as f64;
    }
    prev.n += 1;
    let disk_free = nix_free_gib(&c.run);
    let g = |i: usize| d.get(i).copied().unwrap_or(0.0);
    json!({"t": started.elapsed().as_secs(), "memAvailMiB": meminfo("MemAvailable:").round(), "fcCount": vm_count(c, &fc), "fcPssMiB": prev.pss.round(),
        "cpuBusy": round1(100.0 * (1.0 - (g(3) + g(4)) / tot)), "harnessCore": self_pct, "microVMCores": round2(fc_pct / 100.0), "iowait": round1(100.0 * g(4) / tot),
        "load1": std::fs::read_to_string("/proc/loadavg").ok().and_then(|s| s.split(' ').next()?.parse::<f64>().ok()).unwrap_or(0.0),
        "diskFreeGiB": round1(disk_free), "sessionsGiB": round2(prev.sessions), "active": active})
}
fn round1(x: f64) -> f64 { (x * 10.0).round() / 10.0 }
fn round2(x: f64) -> f64 { (x * 100.0).round() / 100.0 }
fn nix_free_gib(p: &Path) -> f64 {
    let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).unwrap();
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 { return f64::MAX; }
    s.f_bavail as f64 * s.f_frsize as f64 / (1u64 << 30) as f64
}

struct Ctx {
    cfg: Cfg,
    rng: Rng,
    traces: Vec<Trace>,
    intrinsic: HashMap<String, u64>,
    recs: Mutex<Vec<Rec>>,
    turns: Mutex<Vec<u64>>,
    active: AtomicI64,
    stopping: AtomicBool,
    started: Mutex<Instant>,
    events: Mutex<Vec<Value>>,
}

impl Ctx {
    fn away_sec(&self) -> f64 {
        let sigma = 0.8;
        (self.cfg.idle_mean.ln() - sigma * sigma / 2.0 + sigma * self.rng.normal()).exp() // long-tailed: mostly a minute or two, sometimes much longer
    }
    fn median_think(t: &Trace) -> u64 {
        let mut x: Vec<u64> = t.calls.iter().filter_map(|c| c.think_ms).collect();
        x.sort_unstable();
        x.get(x.len() / 2).copied().unwrap_or(3000)
    }
}

async fn tenant(ctx: Arc<Ctx>, i: usize, s: Sandroute, end_at: Instant, ws: PathBuf) {
    let until = |ms: f64| tokio::time::sleep(Duration::from_millis(ms.max(0.0).min(end_at.saturating_duration_since(Instant::now()).as_millis() as f64) as u64)); // nobody sleeps past the end
    until(ctx.rng.next() * ctx.cfg.idle_mean * 1000.0).await; // tenants do not all start together
    while !ctx.stopping.load(Ordering::Relaxed) && Instant::now() < end_at {
        let t = &ctx.traces[(ctx.rng.next() * ctx.traces.len() as f64) as usize];
        if let Err(e) = fresh(&ws, &ctx.cfg.fixture) {
            eprintln!("tenant {i}: resetting the workspace failed: {e}");
        }
        s.vm().clear_scratch(); // a new task is a new session: the host forgets the last one's /tmp as well
        if ctx.cfg.hint_start {
            let s = s.clone();
            tokio::spawn(async move { let _ = s.prewarm().await; });
        }
        let t0 = Instant::now();
        ctx.active.fetch_add(1, Ordering::Relaxed);
        for call in &t.calls {
            if ctx.stopping.load(Ordering::Relaxed) { break; }
            let call = call.rewritten(&t.workspace);
            tokio::time::sleep(Duration::from_millis(call.think_ms.unwrap_or_else(|| Ctx::median_think(t)).clamp(200, 60000))).await; // the model thinking
            let boots = s.boot_count();
            let a = Instant::now();
            let (mut tier, mut label, mut out, mut err) = ("?".to_string(), String::new(), String::new(), None);
            match tokio::time::timeout(Duration::from_secs(60), perform(&ctx.cfg, &s, &call)).await {
                Ok(Ok(x)) => (tier, label, out) = x,
                Ok(Err(e)) => err = Some(e.to_string().lines().next().unwrap_or("").chars().take(100).collect()),
                Err(_) => err = Some("timed out after 60s".into()),
            }
            let started = *ctx.started.lock().unwrap();
            ctx.recs.lock().unwrap().push(Rec { tenant: i, tool: call.tool.clone(), tier, ms: a.elapsed().as_millis() as u64, woke: s.boot_count() > boots, err,
                at: a.duration_since(started).as_secs(), at_ms: a.duration_since(started).as_millis() as u64, label, out, own_ms: *ctx.intrinsic.get(&format!("{}#{}", t.id, call.idx)).unwrap_or(&0) });
        }
        ctx.active.fetch_sub(1, Ordering::Relaxed);
        if ctx.cfg.hint_end {
            let _ = s.release().await;
        }
        let begun = t0.duration_since(*ctx.started.lock().unwrap()).as_millis() as u64;
        ctx.events.lock().unwrap().push(json!({"ev": "turn", "tenant": i, "start_ms": begun, "end_ms": begun + t0.elapsed().as_millis() as u64, "task": t.id}));
        ctx.turns.lock().unwrap().push(t0.elapsed().as_millis() as u64);
        until(ctx.away_sec() * 1000.0).await; // the person is away
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let home = std::env::var("HOME").unwrap_or_default();
    let design = arg("--design", "oxroute");
    let cfg = Cfg {
        is_cri: design.starts_with("kata") || design.starts_with("gvisor"),
        n: arg("--tenants", "16").parse()?,
        minutes: arg("--minutes", "6").parse()?,
        idle_mean: arg("--idle-mean", "120").parse()?,
        window: Duration::from_millis(arg("--window", "30000").parse()?),
        mem: arg("--mem", "256").parse()?,
        vmm: if arg("--vmm", "firecracker") == "cloud-hypervisor" { Vmm::CloudHypervisor } else { Vmm::Firecracker },
        vcpus: arg("--vcpus", "1").parse()?,
        no_snapshot: flag("--no-snapshot"),
        kill_on_release: flag("--kill-on-release"),
        hint_start: flag("--hint-start"),
        hint_end: flag("--hint-end"),
        balloon: flag("--balloon"),
        seed: arg("--seed", "1").parse()?,
        slo_p99: arg("--slo-p99", "1500").parse()?,
        run: PathBuf::from(&home).join(format!("tenant-run-{}", std::process::id())), // one directory per run, so two runs cannot delete each other's workspaces
        assets: std::env::var("SANDROUTE_ASSETS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(&home).join("fcassets")),
        fixture: root.join("bench/fixtures/textstats"),
        design,
    };
    let traces_dir = PathBuf::from(arg("--traces", &root.join("bench/traces").to_string_lossy()));
    let out_dir = PathBuf::from(arg("--out", &root.join("bench/results").to_string_lossy()));
    let traces = traces::load(&traces_dir)?;
    anyhow::ensure!(!traces.is_empty(), "no usable traces in {}", traces_dir.display());
    let intrinsic_file = traces_dir.join("intrinsic.json");
    // How long each call takes with nothing else going on, found by --calibrate. A command can be slow because it is: an agent waiting on
    // something runs a sleep, and that wait is the same under every design. What a design adds is the time above this.
    let intrinsic: HashMap<String, u64> = std::fs::read_to_string(&intrinsic_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();

    if cfg.run.exists() {
        std::fs::remove_dir_all(&cfg.run).map_err(|e| anyhow::anyhow!("cannot clear {} (leftovers owned by root from a pod run?): {e}", cfg.run.display()))?;
    }
    std::fs::create_dir_all(cfg.run.join("tenants"))?;
    let base_mem = meminfo("MemAvailable:");
    // prime the shared snapshot once, so the tenants do not all do it at the same time
    if !cfg.is_cri && !cfg.no_snapshot {
        let warm = MicroVm::new(vm_options(&cfg, -1));
        let ws = cfg.run.join("tenants/warm");
        std::fs::create_dir_all(&ws)?;
        let _ = warm.boot(&ws).await;
        warm.stop().await?;
    }
    let mut sbs = Vec::new();
    for i in 0..cfg.n {
        let ws = cfg.run.join(format!("tenants/t{i}"));
        copy_dir(&cfg.fixture, &ws)?;
        sbs.push(sandbox_for(&cfg, i, &ws)?);
    }
    // every tenant's machine is up from the start
    if matches!(cfg.design.as_str(), "kept" | "kata" | "gvisor") {
        for chunk in sbs.chunks(8) {
            futures_join(chunk.iter().cloned().map(|s| async move { let _ = s.run("true", None).await; })).await;
        }
    }
    let ctx = Arc::new(Ctx { cfg, rng: Rng(Mutex::new(arg("--seed", "1").parse()?)), traces, intrinsic, recs: Default::default(), turns: Default::default(), active: AtomicI64::new(0), stopping: AtomicBool::new(false), started: Mutex::new(Instant::now()), events: Default::default() });
    let c = &ctx.cfg;

    if flag("--calibrate") {
        // one tenant, no think time, no one else: the cost of the calls themselves
        let mut found = serde_json::Map::new();
        for t in &ctx.traces {
            fresh(&c.run.join("tenants/t0"), &c.fixture)?;
            for call in &t.calls {
                let a = Instant::now();
                let _ = perform(c, &sbs[0], &call.rewritten(&t.workspace)).await; // a failed call still has a duration
                found.insert(format!("{}#{}", t.id, call.idx), json!(a.elapsed().as_millis() as u64));
            }
        }
        std::fs::write(&intrinsic_file, serde_json::to_string_pretty(&found)?)?;
        let mut v: Vec<u64> = found.values().filter_map(Value::as_u64).collect();
        v.sort_unstable();
        println!("calibrated {} calls: median {}ms, p95 {}ms, longest {}ms", v.len(), v[v.len() / 2], v[v.len() * 95 / 100], v[v.len() - 1]);
        sbs[0].stop().await?;
        let _ = std::fs::remove_dir_all(&c.run);
        return Ok(());
    }

    let started = Instant::now();
    *ctx.started.lock().unwrap() = started;
    let end_at = started + Duration::from_secs(c.minutes * 60);
    let samples: Arc<Mutex<Vec<Value>>> = Default::default();
    let aborted: Arc<Mutex<Option<String>>> = Default::default();
    let sampler = {
        let (ctx, samples, aborted, sbs) = (ctx.clone(), samples.clone(), aborted.clone(), sbs.clone());
        tokio::spawn(async move {
            let prev = Arc::new(Mutex::new(Prev::default()));
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let (ctx2, prev2, active) = (ctx.clone(), prev.clone(), ctx.active.load(Ordering::Relaxed));
                let row = tokio::task::spawn_blocking(move || sample(&ctx2.cfg, &mut prev2.lock().unwrap(), started, active)).await.unwrap();
                let (free, disk) = (row["memAvailMiB"].as_f64().unwrap_or(0.0), row["diskFreeGiB"].as_f64().unwrap_or(f64::MAX));
                if flag("--events") {
                    // which tenants hold a VM right now: it was woken more often than it was released
                    let up: Vec<usize> = sbs.iter().enumerate().filter(|(_, s)| s.boot_count() > s.release_count()).map(|(i, _)| i).collect();
                    ctx.events.lock().unwrap().push(json!({"ev": "vm", "t_ms": started.elapsed().as_millis() as u64, "up": up}));
                }
                samples.lock().unwrap().push(row);
                let mut ab = aborted.lock().unwrap();
                if ab.is_none() && (free < 300.0 || disk < 6.0) {
                    *ab = Some(if free < 300.0 { format!("memory: {} MiB left", free as i64) } else { format!("disk: {disk:.1} GiB left") });
                    ctx.stopping.store(true, Ordering::Relaxed);
                }
            }
        })
    };
    let tasks: Vec<_> = sbs.iter().cloned().enumerate().map(|(i, s)| tokio::spawn(tenant(ctx.clone(), i, s, end_at, c.run.join(format!("tenants/t{i}"))))).collect();
    for t in tasks { let _ = t.await; }
    sampler.abort();
    let wall = started.elapsed().as_secs_f64();
    for chunk in sbs.chunks(64) { futures_join(chunk.iter().cloned().map(|s| async move { let _ = s.stop().await; })).await; }
    let leftover = vm_count(c, &vm_procs(c));

    // CPU this process used, and what everything it started and waited for used (the VMs, the sandboxed commands)
    let usage = |who| unsafe { let mut u: libc::rusage = std::mem::zeroed(); libc::getrusage(who, &mut u); let s = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6; (round1(s(u.ru_utime)), round1(s(u.ru_stime))) };
    let (own, kids) = (usage(libc::RUSAGE_SELF), usage(libc::RUSAGE_CHILDREN));

    // ---- report -------------------------------------------------------------------------------------------------------------------
    // A latency target is judged on what the design added to each call: its time less the same call's calibrated time.
    let recs = ctx.recs.lock().unwrap();
    let lat: Vec<u64> = recs.iter().map(|r| r.ms.saturating_sub(r.own_ms)).collect();
    let woke: Vec<u64> = recs.iter().filter(|r| r.woke).map(|r| r.ms.saturating_sub(r.own_ms)).collect();
    let errs: Vec<&Rec> = recs.iter().filter(|r| r.err.is_some()).collect();
    let samples = samples.lock().unwrap();
    let col = |k: &str| samples.iter().map(|s| s[k].as_f64().unwrap_or(0.0)).collect::<Vec<_>>();
    let max = |k: &str| col(k).into_iter().fold(0.0, f64::max);
    let mean = |k: &str| { let v = col(k); if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 } };
    let turns = ctx.turns.lock().unwrap();
    let mut slowest: Vec<&Rec> = recs.iter().collect();
    slowest.sort_by_key(|r| std::cmp::Reverse(r.ms.saturating_sub(r.own_ms)));
    let mut tiers = serde_json::Map::new();
    for r in recs.iter() { *tiers.entry(r.tier.clone()).or_insert(json!(0)) = json!(tiers.get(&r.tier).and_then(Value::as_u64).unwrap_or(0) + 1); }
    let aborted = aborted.lock().unwrap().clone();
    let p99 = pct(&lat, 0.99);
    let met = aborted.is_none() && errs.is_empty() && p99 <= c.slo_p99;
    let wakes: u64 = sbs.iter().map(|s| s.boot_count()).sum();
    let suspends: u64 = sbs.iter().map(|s| s.release_count()).sum();
    let result = json!({
        "design": c.design, "vmm": format!("{:?}", c.vmm).to_lowercase(), "vcpus": c.vcpus, "noSnapshot": c.no_snapshot, "killOnRelease": c.kill_on_release, "hintStart": c.hint_start, "hintEnd": c.hint_end,
        "tenants": c.n, "minutes": c.minutes, "idleMeanSec": c.idle_mean, "windowMs": c.window.as_millis() as u64, "memMiB": c.mem, "seed": c.seed, "wallSec": wall.round(), "aborted": aborted,
        "turns": turns.len(), "calls": recs.len(), "errors": errs.len(),
        "errorSample": errs.iter().map(|e| format!("{}: {}", e.tool, e.err.as_deref().unwrap_or(""))).collect::<std::collections::BTreeSet<_>>().into_iter().take(5).collect::<Vec<_>>(),
        "observedDutyCycle": round3(turns.iter().sum::<u64>() as f64 / 1000.0 / (c.n as f64 * wall)),
        "latencyMs": {"p50": pct(&lat, 0.5), "p95": pct(&lat, 0.95), "p99": p99, "max": lat.iter().max().copied().unwrap_or(0), "calls": lat.len()},
        "callsThatWokeAVm": {"n": woke.len(), "p50": pct(&woke, 0.5), "p95": pct(&woke, 0.95), "p99": pct(&woke, 0.99)},
        "slowest": slowest.iter().take(6).map(|r| json!({"addedMs": r.ms.saturating_sub(r.own_ms), "ms": r.ms, "tool": r.tool, "tier": r.tier, "wokeAVm": r.woke, "tenant": r.tenant, "atSec": r.at})).collect::<Vec<_>>(),
        "tiers": tiers, "wakes": wakes, "suspends": suspends,
        "peak": {"microVMs": max("fcCount"), "vmPssMiB": max("fcPssMiB"), "activeTurns": max("active"), "sessionsGiB": max("sessionsGiB"), "cpuBusy": max("cpuBusy"), "iowait": max("iowait"), "load1": max("load1")},
        "mean": {"microVMs": round1(mean("fcCount")), "harnessPctOfACore": mean("harnessCore").round(), "microVMCores": round2(mean("microVMCores")), "vmPssMiB": mean("fcPssMiB").round(), "cpuBusy": round1(mean("cpuBusy"))},
        "memAvailableMiB": {"start": base_mem.round(), "min": col("memAvailMiB").into_iter().fold(f64::MAX, f64::min)},
        "cpuSeconds": {"harnessUser": own.0, "harnessSystem": own.1, "childrenUser": kids.0, "childrenSystem": kids.1},
        "leakedMicroVMs": leftover, "slo": {"p99Ms": c.slo_p99, "met": met},
    });
    if flag("--events") {
        let mut lines = vec![json!({"ev": "meta", "design": c.design, "tenants": c.n, "minutes": c.minutes, "seed": c.seed, "windowMs": c.window.as_millis() as u64})];
        lines.extend(recs.iter().map(|r| json!({"ev": "call", "tenant": r.tenant, "t_ms": r.at_ms, "ms": r.ms, "tool": r.tool, "tier": r.tier, "woke": r.woke, "cmd": r.label, "out": r.out, "err": r.err})));
        lines.extend(ctx.events.lock().unwrap().iter().cloned());
        lines.extend(samples.iter().map(|s| json!({"ev": "sample", "sample": s})));
        std::fs::create_dir_all(&out_dir)?;
        std::fs::write(out_dir.join(format!("{}.events.jsonl", arg("--name", "run"))), lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n"))?;
    }
    let default_name = format!("{}{}-n{}-w{}-i{}-s{}", c.design, if c.balloon { "-balloon" } else { "" }, c.n, c.window.as_millis(), c.idle_mean, c.seed);
    let name = arg("--name", &default_name);
    std::fs::create_dir_all(&out_dir)?;
    let mut full = result.clone();
    full["samples"] = json!(*samples);
    std::fs::write(out_dir.join(format!("{name}.json")), serde_json::to_string_pretty(&full)?)?;
    let r = &result;
    println!("{name:<30} calls {:>4}  p50 {:>4}  p95 {:>5}  p99 {:>5}ms  VMs peak {:>3} ({} MiB)  disk {} GiB  cpu {}%/{}%  err {}  {}",
        r["calls"], r["latencyMs"]["p50"], r["latencyMs"]["p95"], r["latencyMs"]["p99"], r["peak"]["microVMs"], r["peak"]["vmPssMiB"], r["peak"]["sessionsGiB"], r["mean"]["cpuBusy"], r["peak"]["cpuBusy"], r["errors"],
        if met { "SLO met".to_string() } else if let Some(a) = &aborted { format!("ABORTED {a}") } else { "SLO missed".to_string() });
    let _ = std::fs::remove_dir_all(&ctx.cfg.run);
    Ok(())
}

fn round3(x: f64) -> f64 { (x * 1000.0).round() / 1000.0 }

/// Run the futures together and wait for all of them.
async fn futures_join<F: std::future::Future<Output = ()> + Send + 'static>(fs: impl Iterator<Item = F>) {
    let hs: Vec<_> = fs.map(tokio::spawn).collect();
    for h in hs { let _ = h.await; }
}
