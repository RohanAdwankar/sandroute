use anyhow::{anyhow, Result};
use async_trait::async_trait;
use sandroute::router::Tier;
use sandroute::sandbox::{Sandbox, SandboxOptions};
use sandroute::sandroute::{Sandroute, SandrouteOptions};
use sandroute::vm::{Live, VmBackend, VmResult};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A machine that counts what is done to it, and can be told to behave badly.
#[derive(Default)]
struct FakeVm {
    boots: AtomicU64,
    stops: AtomicU64,
    execs: AtomicU64,
    suspends: AtomicU64,
    can_suspend: AtomicBool,
    probe: Mutex<Option<Result<Vec<(i64, String)>, String>>>, // None: no probe
    exec_delay_ms: AtomicU64,
    suspend_delay_ms: AtomicU64,
    up: AtomicBool,
    transitions: AtomicUsize,
    overlapped: AtomicUsize,
}

impl FakeVm {
    fn n(&self, f: &AtomicU64) -> u64 {
        f.load(Ordering::SeqCst)
    }
    async fn transition(&self, ms: u64) {
        if self.transitions.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlapped.fetch_add(1, Ordering::SeqCst);
        }
        tokio::time::sleep(Duration::from_millis(ms)).await;
        self.transitions.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl VmBackend for FakeVm {
    fn name(&self) -> String {
        "fake".into()
    }
    async fn boot(&self, _w: &Path) -> Result<()> {
        self.transition(10).await;
        self.boots.fetch_add(1, Ordering::SeqCst);
        self.up.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn exec(&self, _c: &str, _cwd: &str, _e: Option<&BTreeMap<String, String>>) -> Result<VmResult> {
        if !self.up.load(Ordering::SeqCst) {
            return Err(anyhow!("exec on a machine that is not up"));
        }
        self.execs.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(self.exec_delay_ms.load(Ordering::SeqCst))).await;
        Ok(VmResult { stdout: "vm\n".into(), stderr: String::new(), exit_code: 0 })
    }
    async fn busy(&self) -> Result<Option<Live>> {
        match &*self.probe.lock().unwrap() {
            None => Ok(None),
            Some(Ok(procs)) => Ok(Some(Live { busy: !procs.is_empty(), procs: procs.clone() })),
            Some(Err(e)) => Err(anyhow!("{e}")),
        }
    }
    async fn suspend(&self) -> Result<bool> {
        if !self.can_suspend.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.suspends.fetch_add(1, Ordering::SeqCst);
        self.transition(self.suspend_delay_ms.load(Ordering::SeqCst)).await;
        self.up.store(false, Ordering::SeqCst);
        Ok(true)
    }
    async fn stop(&self) -> Result<()> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.up.store(false, Ordering::SeqCst);
        Ok(())
    }
}

fn usable() -> bool {
    Command::new("bwrap")
        .args(["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct Rig {
    ws: tempfile::TempDir,
    vm: Arc<FakeVm>,
    s: Sandroute,
}

fn rig(idle_ms: Option<u64>, tweak: impl FnOnce(&FakeVm)) -> Option<Rig> {
    if !usable() {
        eprintln!("skipped: bubblewrap is not usable here");
        return None;
    }
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("a.txt"), "hello world\n").unwrap();
    let vm = Arc::new(FakeVm::default());
    tweak(&vm);
    let s = Sandroute::new(SandrouteOptions {
        workspace: ws.path().to_path_buf(),
        vm: vm.clone(),
        log_file: None,
        idle: idle_ms.map(Duration::from_millis),
        all_in_vm: false,
        light: Some(Sandbox::new(SandboxOptions::new(ws.path()))),
        workspace_path: None,
    })
    .unwrap();
    Some(Rig { ws, vm, s })
}

async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[tokio::test]
async fn the_vm_boots_once_on_the_first_command_that_needs_it() {
    let Some(r) = rig(None, |_| {}) else { return };
    let a = r.s.run("chromium --version", None).await.unwrap();
    let b = r.s.run("npm test", None).await.unwrap();
    assert!(a.booted);
    assert!(!b.booted);
    assert_eq!(r.vm.n(&r.vm.boots), 1);
}

#[tokio::test]
async fn commands_that_only_touch_files_never_boot_the_vm() {
    let Some(r) = rig(None, |_| {}) else { return };
    let out = r.s.run("grep -c hello a.txt", None).await.unwrap();
    assert_eq!(out.tier, Tier::Light);
    assert_eq!(out.stdout.trim(), "1");
    assert_eq!(r.vm.n(&r.vm.boots), 0);
}

#[tokio::test]
async fn a_harness_hint_wakes_the_vm_ahead_of_the_first_command_and_releases_it_the_moment_a_turn_ends() {
    let Some(r) = rig(Some(60_000), |_| {}) else { return }; // a window so long that only the hint can release it
    r.s.prewarm().await.unwrap();
    assert_eq!(r.vm.n(&r.vm.boots), 1, "the machine is up before any command");
    let out = r.s.run("python3 -c 'print(1)'", None).await.unwrap();
    assert!(!out.booted, "so the first command does not pay for the wake");
    assert_eq!(r.vm.n(&r.vm.boots), 1);
    assert!(r.s.release().await.unwrap(), "the end of the turn releases it without waiting for the timer");
    assert_eq!(r.vm.n(&r.vm.stops), 1);
    r.s.prewarm().await.unwrap();
    assert_eq!(r.vm.n(&r.vm.boots), 2, "and the next turn wakes it again");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn an_idle_vm_is_released_and_the_next_heavy_command_brings_it_back() {
    let Some(r) = rig(Some(60), |_| {}) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    assert_eq!(r.vm.n(&r.vm.boots), 1);
    settle(150).await;
    assert_eq!(r.vm.n(&r.vm.stops), 1, "idle vm should have been handed back");
    assert_eq!(r.s.release_count(), 1);
    let again = r.s.run("chromium --version", None).await.unwrap();
    assert!(again.booted, "the next heavy command boots a fresh vm");
    assert_eq!(r.vm.n(&r.vm.boots), 2);
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn light_commands_do_not_keep_the_vm_alive() {
    let Some(r) = rig(Some(60), |_| {}) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    for _ in 0..4 {
        r.s.run("cat a.txt", None).await.unwrap();
        settle(40).await;
    }
    assert_eq!(r.vm.n(&r.vm.stops), 1, "the idle timer should not be reset by light work");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn vm_allocated_time_covers_only_the_stretches_the_vm_was_up() {
    let Some(r) = rig(Some(60), |_| {}) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    settle(150).await;
    let after = r.s.vm_allocated();
    assert!(after >= Duration::from_millis(60) && after < Duration::from_millis(160), "expected about 60 to 140ms, got {after:?}");
    settle(100).await;
    assert_eq!(r.s.vm_allocated(), after, "a released vm must not keep accruing");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn the_vm_is_kept_while_a_command_is_in_flight() {
    let Some(r) = rig(Some(20), |v| v.exec_delay_ms.store(200, Ordering::SeqCst)) else { return };
    let s = r.s.clone();
    let p = tokio::spawn(async move { s.run("chromium --version", None).await });
    settle(100).await;
    assert!(!r.s.release().await.unwrap(), "release must refuse while a command is running");
    p.await.unwrap().unwrap();
    assert_eq!(r.vm.n(&r.vm.stops), 0);
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn a_vm_with_a_background_process_is_pinned_not_killed() {
    let Some(r) = rig(Some(40), |v| *v.probe.lock().unwrap() = Some(Ok(vec![(42, "node".into())]))) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    settle(200).await;
    assert_eq!(r.vm.n(&r.vm.stops), 0, "a backgrounded server must survive the idle timer");
    assert!(r.s.pinned_count() >= 1, "the refusal should be counted");
    assert_eq!(r.s.last_pinned(), vec![(42, "node".to_string())]);
    // once it exits, the next sweep lets the vm go
    *r.vm.probe.lock().unwrap() = Some(Ok(vec![]));
    settle(200).await;
    assert_eq!(r.vm.n(&r.vm.stops), 1, "a quiescent vm should be released");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn a_backend_that_cannot_answer_busy_keeps_the_vm_and_says_why() {
    let Some(r) = rig(Some(40), |v| *v.probe.lock().unwrap() = Some(Err("vsock gone".into()))) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    settle(200).await;
    assert_eq!(r.vm.n(&r.vm.stops), 0, "unprovable idleness must not count as idle");
    assert!(r.s.last_pinned_error().unwrap_or_default().contains("vsock gone"), "a probe that always fails pins forever and must not look like a busy machine");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn a_backend_with_no_busy_probe_still_releases_on_the_timer() {
    let Some(r) = rig(Some(40), |_| {}) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    settle(200).await;
    assert_eq!(r.vm.n(&r.vm.stops), 1);
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn a_backend_that_can_suspend_is_suspended_not_stopped() {
    let Some(r) = rig(Some(40), |v| v.can_suspend.store(true, Ordering::SeqCst)) else { return };
    r.s.run("chromium --version", None).await.unwrap();
    settle(200).await;
    assert_eq!(r.vm.n(&r.vm.suspends), 1, "releasing must keep what the machine accumulated");
    assert_eq!(r.vm.n(&r.vm.stops), 0, "a clean stop would throw it away");
    r.s.stop().await.unwrap();
    assert_eq!(r.vm.n(&r.vm.stops), 1, "ending the session deletes what was saved, even though the vm was already handed back");
}

#[tokio::test]
async fn a_command_that_arrives_while_the_vm_is_being_suspended_waits_for_it() {
    // Booting while a suspend is still writing the snapshot gives two machines for one session: the new one is killed by the old one's
    // cleanup, and the command fails.
    let Some(r) = rig(Some(30), |v| {
        v.can_suspend.store(true, Ordering::SeqCst);
        v.suspend_delay_ms.store(120, Ordering::SeqCst);
    }) else { return };
    for round in 0..4 {
        assert_eq!(r.s.run("chromium --version", None).await.unwrap().exit_code, 0);
        while r.s.release_count() <= round {
            settle(5).await; // the idle timer has fired and the suspend has begun
        }
        settle(20).await; // and is partway through writing
        assert_eq!(r.s.run("chromium --version", None).await.unwrap().exit_code, 0, "the command must wait, then run");
    }
    assert_eq!(r.vm.overlapped.load(Ordering::SeqCst), 0, "a boot must never overlap a suspend");
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn with_a_sandbox_commands_that_need_a_machine_still_go_to_it() {
    let Some(r) = rig(None, |_| {}) else { return };
    let light = r.s.run("grep -c secret a.txt || true", None).await.unwrap();
    assert_eq!(light.tier, Tier::Light);
    for heavy in ["python3 -c 'print(1)'", "npm test", "curl https://example.com", "git clone https://example.com/x.git"] {
        assert_eq!(r.s.run(heavy, None).await.unwrap().tier, Tier::Vm, "{heavy}");
    }
    assert_eq!(r.vm.n(&r.vm.execs), 4);
    r.s.stop().await.unwrap();
}

#[tokio::test]
async fn the_file_tools_run_in_the_sandbox() {
    let Some(r) = rig(None, |_| {}) else { return };
    let ws = r.ws.path();
    let tricky = "it's \"quoted\"\nsecond $HOME line `x`\n";
    r.s.write_file("notes/a.txt", tricky).await.unwrap();
    assert_eq!(std::fs::read_to_string(ws.join("notes/a.txt")).unwrap(), tricky, "awkward content survives the trip");
    assert_eq!(r.s.read_file("notes/a.txt", None, None).await.unwrap(), tricky);
    assert_eq!(r.s.read_file("notes/a.txt", Some(2), Some(1)).await.unwrap(), "second $HOME line `x`\n");
    assert_eq!(r.s.edit_file("notes/a.txt", "second", "third", false).await.unwrap(), 1);
    assert!(std::fs::read_to_string(ws.join("notes/a.txt")).unwrap().contains("third $HOME"));
    assert!(r.s.edit_file("notes/a.txt", "absent", "x", false).await.unwrap_err().to_string().contains("not found"));
    assert!(r.s.read_file("/etc/shadow", None, None).await.is_err());
    // reading a directory lists it, as the built-in tool does, with directories marked
    std::fs::create_dir_all(ws.join("notes/sub")).unwrap();
    let mut listed: Vec<String> = r.s.read_file("notes", None, None).await.unwrap().trim().split('\n').map(String::from).collect();
    listed.sort();
    assert_eq!(listed, ["a.txt", "sub/"]);
    let base = |v: Vec<String>| v.into_iter().map(|f| f.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(base(r.s.glob("*.txt", Some("notes")).await.unwrap()), ["a.txt"]);
    assert_eq!(base(r.s.grep_files("third", Some("notes"), None).await.unwrap()), ["a.txt"]);
}

#[tokio::test]
async fn the_search_tools_see_the_workspace_and_nothing_outside_it() {
    let Some(r) = rig(None, |_| {}) else { return };
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.ts"), "needle\n").unwrap();
    std::fs::create_dir_all(r.ws.path().join("src")).unwrap();
    std::fs::write(r.ws.path().join("src/a.ts"), "needle\n").unwrap();
    std::fs::write(r.ws.path().join("src/b.txt"), "needle\n").unwrap();
    let base = |v: Vec<String>| v.into_iter().map(|f| f.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(base(r.s.glob("*.ts", None).await.unwrap()), ["a.ts"]);
    assert_eq!(base(r.s.grep_files("needle", None, Some("*.ts")).await.unwrap()), ["a.ts"]);
    assert_eq!(r.vm.n(&r.vm.execs), 0, "searching the workspace never leaves the host");
    // outside the workspace the light tier must not answer: it is escalated, and what the VM can see is the VM's business
    r.s.glob("*.ts", Some(&outside.path().to_string_lossy())).await.unwrap();
    r.s.grep_files("needle", Some(&outside.path().to_string_lossy()), None).await.unwrap();
    assert_eq!(r.vm.n(&r.vm.execs), 2, "a path outside the workspace is escalated, not served here");
}

#[tokio::test]
async fn no_command_reads_a_host_file_outside_the_workspace_however_the_path_is_built() {
    let Some(r) = rig(None, |_| {}) else { return };
    let outside = tempfile::tempdir().unwrap();
    let secret = format!("s3cret-{}", std::process::id());
    std::fs::write(outside.path().join("keep.txt"), format!("{secret}\n")).unwrap();
    let target = outside.path().join("keep.txt").to_string_lossy().to_string();
    let o = outside.path().to_string_lossy().to_string();
    // The router reads the command text, so any path it cannot see statically is a way past it. These are examples of that, not the list:
    // what has to hold is that the filesystem underneath refuses regardless of which tier the router picked.
    use base64::{engine::general_purpose::STANDARD, Engine};
    let rel = pathdiff(&target, &r.ws.path().to_string_lossy());
    for cmd in [
        format!("cat {target}"),
        format!("P={target}; cat $P"),
        format!("eval \"cat {target}\""),
        format!("cat $(echo {target})"),
        format!("c=cat; $c {target}"),
        format!("echo {} | base64 -d | sh", STANDARD.encode(format!("cat {target}"))),
        format!("cat {rel}"),
        format!("cd {o} && cat keep.txt"),
    ] {
        let out = r.s.run(&cmd, None).await.unwrap();
        assert!(!format!("{}{}", out.stdout, out.stderr).contains(&secret), "leaked through: {cmd}");
    }
}

/// a relative path from `from` to `to`, both absolute
fn pathdiff(to: &str, from: &str) -> String {
    let (t, f): (Vec<&str>, Vec<&str>) = (to.split('/').collect(), from.split('/').collect());
    let common = t.iter().zip(&f).take_while(|(a, b)| a == b).count();
    [vec![".."; f.len() - common], t[common..].to_vec()].concat().join("/")
}

#[tokio::test]
async fn the_router_and_the_file_tools_use_the_path_the_agent_sees() {
    if !usable() {
        return;
    }
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("secret.txt"), "seen\n").unwrap();
    let vm = Arc::new(FakeVm::default());
    let s = Sandroute::new(SandrouteOptions {
        workspace: ws.path().to_path_buf(),
        vm: vm.clone(),
        log_file: None,
        idle: None,
        all_in_vm: false,
        light: Some(Sandbox::new(SandboxOptions::new(ws.path()).mount_at("/work"))),
        workspace_path: Some("/work".into()),
    })
    .unwrap();
    let out = s.run("cat /work/secret.txt", None).await.unwrap();
    assert_eq!(out.tier, Tier::Light, "a path under the agent's workspace is not outside it");
    assert_eq!(out.stdout.trim(), "seen");
    s.write_file("out/new.txt", "hello\n").await.unwrap();
    assert_eq!(std::fs::read_to_string(ws.path().join("out/new.txt")).unwrap(), "hello\n", "a relative path lands in the real workspace");
    assert_eq!(s.read_file("/work/out/new.txt", None, None).await.unwrap(), "hello\n");
    assert_eq!(s.run("cat /etc/hostname", None).await.unwrap().tier, Tier::Vm, "anything else is still outside");
}

#[test]
fn a_light_sandbox_is_required_unless_every_command_goes_to_the_vm() {
    let ws = tempfile::tempdir().unwrap();
    let make = |all_in_vm, light: Option<Sandbox>| Sandroute::new(SandrouteOptions { workspace: ws.path().into(), vm: Arc::new(FakeVm::default()), log_file: None, idle: None, all_in_vm, light, workspace_path: None });
    assert!(make(false, None).is_err());
    assert!(make(true, None).is_ok());
}
