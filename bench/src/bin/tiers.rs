//! What one command costs in each place it can run: on the host with nothing around it, in the light sandbox, in a warm Firecracker VM, and
//! through a wake. Medians and 95th percentiles of 60 runs each; the project has 300 small files so find and grep have work to do.
//!
//!   cargo run --release --bin tiers
use anyhow::Result;
use sandroute::sandbox::{Sandbox, SandboxOptions};
use sandroute::sandroute::{Sandroute, SandrouteOptions};
use sandroute::vm::VmBackend;
use sandroute::vmm::{MicroVm, VmOptions, Vmm};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

const CMDS: [(&str, &str); 6] = [
    ("ls", "ls"),
    ("cat a file", "cat textstats.py"),
    ("grep -rn across 300 files", "grep -rn 'def fn1' pkg | wc -l"),
    ("find and sort", "find pkg -name '*.py' | sort | tail -3"),
    ("python startup", "python3 -c 'print(1)'"),
    ("python, 85 ms of cpu", "python3 -c 'sum(i*i for i in range(2_000_000))'"),
];
const N: usize = 60;

fn pct(xs: &[f64], p: f64) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s[(s.len() - 1).min((s.len() as f64 * p) as usize)]
}

fn vm(a: &Path, session: &str) -> MicroVm {
    let mut o = VmOptions::new(Vmm::Firecracker, a.join("vmlinux-6.1.128").to_string_lossy(), a.join("rootfs.ext4").to_string_lossy());
    o.bin = Some(a.join("firecracker").to_string_lossy().into());
    o.snapshot_dir = Some(a.join("pristine-tenants"));
    o.session_dir = Some(PathBuf::from(session));
    o.guest_workspace = Some("/work".into());
    MicroVm::new(o)
}

async fn time<F: std::future::Future<Output = ()>>(f: impl Fn() -> F) -> Vec<f64> {
    let mut out = vec![];
    for _ in 0..N {
        let t = Instant::now();
        f().await;
        out.push(t.elapsed().as_secs_f64() * 1e3);
    }
    out
}

#[tokio::main]
async fn main() -> Result<()> {
    let a = PathBuf::from(std::env::var("SANDROUTE_ASSETS").unwrap_or_else(|_| format!("{}/fcassets", std::env::var("HOME").unwrap_or_default())));
    let ws = tempfile::tempdir()?;
    let w = ws.path();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/textstats");
    anyhow::ensure!(std::process::Command::new("cp").arg("-r").arg(format!("{}/.", fixture.display())).arg(w).status()?.success());
    // a project with enough files for find and grep to have something to do
    for i in 0..300 {
        std::fs::create_dir_all(w.join(format!("pkg/m{}", i % 20)))?;
        std::fs::write(w.join(format!("pkg/m{}/f{i}.py", i % 20)), format!("def fn{i}(x):\n    return x * {i}\n").repeat(20))?;
    }
    let sb = Sandbox::new(SandboxOptions::new(w).mount_at("/work"));
    let (v, none) = (vm(&a, "/tmp/tiers-s"), BTreeMap::new());
    let t0 = Instant::now();
    v.boot(w).await?;
    let first_boot = t0.elapsed().as_millis();
    let (native, light, in_vm) = (
        |c: &str| { let c = c.to_string(); let w = w.to_path_buf(); async move { let _ = tokio::process::Command::new("bash").args(["-c", &c]).current_dir(w).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await; } },
        |c: &str| { let (c, sb) = (c.to_string(), &sb); async move { sb.exec(&c, None, &BTreeMap::new()).await; } },
        |c: &str| { let (c, v, e) = (c.to_string(), &v, &none); async move { let _ = v.exec(&c, "/work", Some(e)).await; } },
    );
    native("true").await; light("true").await; in_vm("true").await; // warm everything
    println!("median ms per command (p95 in brackets)");
    println!("{:<28} {:<16} {:<16} {:<18}", "command", "host native", "light sandbox", "firecracker (warm)");
    for (name, c) in CMDS {
        let cell = |x: Vec<f64>| format!("{:<16}", format!("{:.1} ({:.1})", pct(&x, 0.5), pct(&x, 0.95)));
        println!("{name:<28} {} {} {}", cell(time(|| native(c)).await), cell(time(|| light(c)).await), cell(time(|| in_vm(c)).await));
    }
    v.stop().await?;
    // a wake: release a VM that holds nothing, then run one command, through the whole Sandroute path
    let s = Sandroute::new(SandrouteOptions { workspace: w.to_path_buf(), vm: Arc::new(vm(&a, "/tmp/tiers-s2")), log_file: None, idle: None, all_in_vm: false, light: Some(sb.clone()), workspace_path: Some("/work".into()) })?;
    let mut wakes = vec![];
    for i in 0..25 {
        let t = Instant::now();
        let r = s.run("python3 -c 'print(1)'", None).await?;
        wakes.push(t.elapsed().as_secs_f64() * 1e3);
        anyhow::ensure!(i > 0 || r.booted, "expected a boot");
        s.release().await?;
    }
    println!("\nwake: release the VM, then run 'python3 -c print(1)' (restore + sync + command): median {:.0} ms, p95 {:.0} ms; the first restore, with its snapshot already primed, {first_boot} ms", pct(&wakes[1..], 0.5), pct(&wakes[1..], 0.95));
    s.stop().await
}
