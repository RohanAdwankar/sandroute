//! These need bubblewrap and unprivileged user namespaces, which not every host allows.
use sandroute::sandbox::{Sandbox, SandboxOptions};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn usable() -> bool {
    Command::new("bwrap")
        .args(["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct Tenant {
    ws: tempfile::TempDir,
    sb: Sandbox,
}

fn tenant(secret: Option<&str>) -> Option<Tenant> {
    if !usable() {
        eprintln!("skipped: bubblewrap is not usable here");
        return None;
    }
    let ws = tempfile::tempdir().unwrap();
    if let Some(s) = secret {
        std::fs::write(ws.path().join("secret.txt"), format!("{s}\n")).unwrap();
    }
    let sb = Sandbox::new(SandboxOptions::new(ws.path()));
    Some(Tenant { ws, sb })
}

async fn sh(sb: &Sandbox, cmd: &str) -> sandroute::sandbox::SandboxResult {
    sb.exec(cmd, None, &BTreeMap::new()).await
}

#[tokio::test]
async fn a_tenant_sees_its_own_workspace_and_no_one_elses() {
    let (Some(a), Some(b)) = (tenant(Some("alpha-secret")), tenant(Some("bravo-secret"))) else { return };
    assert_eq!(sh(&a.sb, "cat secret.txt").await.stdout.trim(), "alpha-secret");
    // every way of naming the other tenant's files, including by guessing the path exactly
    let other = b.ws.path().to_string_lossy().to_string();
    let a_ws = a.ws.path().to_string_lossy().to_string();
    let parent = Path::new(&other).parent().unwrap().to_string_lossy().to_string();
    for cmd in [format!("cat {other}/secret.txt"), format!("ls {parent}"), format!("find / -name secret.txt -not -path '{a_ws}/*' 2>/dev/null")] {
        let r = sh(&a.sb, &cmd).await;
        assert!(!format!("{}{}", r.stdout, r.stderr).contains("bravo-secret"), "leaked through: {cmd}");
        assert!(!r.stdout.contains(Path::new(&other).file_name().unwrap().to_str().unwrap()), "the other workspace is visible through: {cmd}");
    }
}

#[tokio::test]
async fn a_tenant_cannot_change_anything_outside_its_workspace() {
    let Some(t) = tenant(None) else { return };
    let outside = tempfile::tempdir().unwrap();
    for cmd in [format!("echo x > {}/planted", outside.path().display()), "echo x > /usr/planted".to_string(), "echo x > /etc/planted".to_string()] {
        sh(&t.sb, &cmd).await;
    }
    assert!(!outside.path().join("planted").exists());
    assert!(!Path::new("/usr/planted").exists());
    sh(&t.sb, "echo kept > inside.txt").await;
    assert_eq!(std::fs::read_to_string(t.ws.path().join("inside.txt")).unwrap(), "kept\n", "its own workspace is writable");
    // scratch space exists but is private and gone after the command
    sh(&t.sb, "echo x > /tmp/scratch").await;
    assert_eq!(sh(&t.sb, "ls /tmp").await.stdout.trim(), "", "scratch must not persist between commands");
}

#[tokio::test]
async fn a_tenant_cannot_see_or_signal_the_hosts_processes() {
    let Some(t) = tenant(None) else { return };
    let mut host = Command::new("sleep").arg("30").stdout(Stdio::null()).spawn().unwrap();
    let seen = sh(&t.sb, "ls /proc | grep -c '^[0-9]'").await;
    let n: i32 = seen.stdout.trim().parse().unwrap();
    assert!(n < 6, "a fresh process namespace has a handful of processes, saw {n}");
    sh(&t.sb, &format!("kill -9 {}", host.id())).await;
    assert!(host.try_wait().unwrap().is_none(), "the host process must survive");
    host.kill().unwrap();
}

#[tokio::test]
async fn a_tenant_has_no_network_and_none_of_the_hosts_environment() {
    let Some(t) = tenant(None) else { return };
    std::env::set_var("TENANT_TEST_SECRET", "from-the-host");
    let env = sh(&t.sb, "env").await;
    assert!(!env.stdout.contains("from-the-host"), "the host environment must not leak in");
    let net = sh(&t.sb, r#"python3 -c "import socket;socket.setdefaulttimeout(3);socket.create_connection(('1.1.1.1',443))""#).await;
    assert_ne!(net.exit_code, 0, "there must be nothing to connect to");
    std::env::remove_var("TENANT_TEST_SECRET");
}

#[tokio::test]
async fn a_runaway_command_is_stopped_and_its_output_is_bounded() {
    let Some(t) = tenant(None) else { return };
    let mut o = SandboxOptions::new(t.ws.path());
    o.timeout = Duration::from_millis(400);
    o.max_output_bytes = 4096;
    let quick = Sandbox::new(o);
    let start = Instant::now();
    let slow = sh(&quick, "sleep 30").await;
    assert!(start.elapsed() < Duration::from_secs(5) && slow.exit_code != 0, "a command past its time is killed");
    let flood = sh(&quick, "yes | head -c 10000000").await;
    assert!(flood.stdout.len() < 100_000 && flood.stderr.contains("output limit"), "a flood of output is cut off");
}

#[tokio::test]
async fn every_tenant_sees_its_workspace_at_the_same_path_whatever_the_hosts_layout() {
    let (Some(a), Some(b)) = (tenant(Some("alpha-secret")), tenant(Some("bravo-secret"))) else { return };
    let sa = Sandbox::new(SandboxOptions::new(a.ws.path()).mount_at("/work"));
    let sb = Sandbox::new(SandboxOptions::new(b.ws.path()).mount_at("/work"));
    assert_eq!(sh(&sa, "cat /work/secret.txt").await.stdout.trim(), "alpha-secret");
    assert_eq!(sh(&sb, "cat /work/secret.txt").await.stdout.trim(), "bravo-secret", "the same path means each tenant's own files");
    assert_eq!(sh(&sa, "pwd").await.stdout.trim(), "/work", "commands start in the mount point");
    // the environment and the working directory do not reveal where the workspace really is
    for cmd in ["env", "pwd -P"] {
        let r = sh(&sa, cmd).await;
        assert!(!format!("{}{}", r.stdout, r.stderr).contains(a.ws.path().to_str().unwrap()), "the host path leaked through: {cmd}");
    }
    // /proc/self/mountinfo still names the source of the bind mount, which is the tenant's own directory and nothing else's. So host
    // workspaces belong under a path that says nothing, and what has to hold is that no tenant can learn another's.
    let mounts = sh(&sa, "cat /proc/self/mountinfo").await;
    assert!(!mounts.stdout.contains(b.ws.path().file_name().unwrap().to_str().unwrap()), "another tenant's directory is not visible in the mount table");
}
