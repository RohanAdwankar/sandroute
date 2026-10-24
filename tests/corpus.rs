//! The filter must not change what a command does. Every call the file-only tier served in the recorded agent sessions is replayed twice,
//! once under the filter and once without it, in two copies of the same project, and the exit code and output of each must match.
use sandroute::fileops::file_command;
use sandroute::router::{classify, known_for_sandbox, Tier};
use sandroute::sandbox::{bwrap_args, Sandbox, SandboxOptions};
use sandroute::{spawn, traces};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).unwrap(); }
    }
}

async fn unfiltered(ws: &Path, cmd: &str) -> (String, String, i32) {
    let mut args = bwrap_args(&ws.to_string_lossy(), "/work", "/work", &BTreeMap::new());
    for (flag, n) in [("--seccomp", 2), ("--disable-userns", 1)] {
        let i = args.iter().position(|a| a == flag).unwrap();
        args.drain(i..i + n);
    }
    let argv: Vec<String> = ["bwrap".to_string()].into_iter().chain(args).chain(["/usr/bin/bash".into(), "-c".into(), cmd.into()]).collect();
    let r = spawn::run(&argv, Duration::from_secs(60), 10 << 20, None).await.unwrap();
    (r.stdout, r.stderr, r.code.unwrap_or(137))
}

#[tokio::test]
async fn the_light_tier_behaves_the_same_with_and_without_the_filter_across_every_recorded_session() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let usable = Command::new("bwrap")
        .args(["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"])
        .output().map(|o| o.status.success()).unwrap_or(false);
    if !usable || !root.join("bench/traces").exists() {
        eprintln!("skipped: needs bubblewrap and the recorded sessions");
        return;
    }
    let (known, fixture) = (known_for_sandbox(), root.join("bench/fixtures/textstats"));
    let (mut calls, mut refused) = (0, 0);
    let mut diffs = Vec::new();
    for t in traces::load(&root.join("bench/traces")).unwrap() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        copy_dir(&fixture, a.path());
        copy_dir(&fixture, b.path());
        let sb = Sandbox::new(SandboxOptions::new(a.path()).mount_at("/work"));
        for c in &t.calls {
            let c = c.rewritten(&t.workspace);
            let cmd = if c.tool == "bash" {
                let command = c.args["command"].as_str().unwrap_or("").to_string();
                if classify(&known, &command, "/work").tier != Tier::InProcess {
                    continue;
                }
                command
            } else {
                match c.file_call() {
                    Some(f) => file_command(&f),
                    None => continue,
                }
            };
            let x = sb.exec(&cmd, None, &BTreeMap::new()).await;
            let (ys, ye, yc) = unfiltered(b.path(), &cmd).await;
            calls += 1;
            let bad = |s: &str| s.contains("Operation not permitted") || s.contains("Bad system call");
            if bad(&format!("{}{}", x.stderr, x.stdout)) && !bad(&format!("{ye}{ys}")) {
                refused += 1;
            }
            if x.exit_code != yc || x.stdout != ys {
                diffs.push(format!("{}: {}\n  filtered   {} {:?}\n  unfiltered {} {:?}", t.id, &cmd[..cmd.len().min(90)], x.exit_code, &x.stdout[..x.stdout.len().min(80)], yc, &ys[..ys.len().min(80)]));
            }
        }
    }
    eprintln!("{calls} calls replayed, {refused} refused by the filter");
    assert!(calls > 100, "only {calls} calls were replayed");
    assert_eq!(refused, 0, "a command was refused by the filter that the unfiltered sandbox ran");
    assert!(diffs.is_empty(), "{} of {calls} calls differ:\n{}", diffs.len(), diffs.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}
