//! What a hostile tenant would try, one thing at a time. Each probe is a small C program that makes one system call and prints what came
//! back. They run inside the sandbox, and the ones that would reach kernel code a tenant has no business reaching must fail. A few also run
//! in a sandbox with the filter taken off, so a probe that fails for some other reason cannot pass for a filter that is doing nothing.
use sandroute::sandbox::{bwrap_args, Sandbox, SandboxOptions};
use sandroute::spawn;
use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

const C: &str = r#"
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#define TRY(name, expr) if (!strcmp(argv[1], name)) { long r = (expr); printf("ret=%ld errno=%d\n", r, r == -1 ? errno : 0); return 0; }
int main(int argc, char **argv) {
  char buf[256] = {0};
  TRY("unshare_user", unshare(CLONE_NEWUSER))
  TRY("unshare_mount", unshare(CLONE_NEWNS))
  TRY("unshare_net", unshare(CLONE_NEWNET))
  TRY("clone_newuser", syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0))
  TRY("clone3", syscall(SYS_clone3, 0, 0))
  TRY("setns", syscall(SYS_setns, 0, 0))
  TRY("mount", mount("none", "/tmp", "tmpfs", 0, 0))
  TRY("pivot_root", syscall(SYS_pivot_root, "/tmp", "/tmp"))
  TRY("chroot", chroot("/tmp"))
  TRY("ptrace_traceme", ptrace(PTRACE_TRACEME, 0, 0, 0))
  TRY("ptrace_attach_parent", ptrace(PTRACE_ATTACH, getppid(), 0, 0))
  TRY("process_vm_readv", syscall(SYS_process_vm_readv, getppid(), 0, 0, 0, 0, 0))
  TRY("bpf", syscall(SYS_bpf, 0, buf, sizeof buf))
  TRY("perf_event_open", syscall(SYS_perf_event_open, buf, 0, -1, -1, 0))
  TRY("io_uring_setup", syscall(SYS_io_uring_setup, 8, buf))
  TRY("keyctl", syscall(SYS_keyctl, 0, 0, 0, 0, 0))
  TRY("add_key", syscall(SYS_add_key, "user", "x", "y", 1, -1))
  TRY("userfaultfd", syscall(SYS_userfaultfd, 0))
  TRY("open_by_handle_at", syscall(SYS_open_by_handle_at, -1, buf, 0))
  TRY("memfd_create", syscall(SYS_memfd_create, "x", 0))
  TRY("socket_inet", socket(AF_INET, SOCK_STREAM, 0))
  TRY("socket_netlink", socket(AF_NETLINK, SOCK_RAW, 0))
  TRY("socket_packet", socket(AF_PACKET, SOCK_RAW, 0))
  TRY("socket_unix", socket(AF_UNIX, SOCK_STREAM, 0))
  TRY("reboot", syscall(SYS_reboot, 0, 0, 0, 0))
  TRY("sethostname", sethostname("x", 1))
  TRY("settimeofday", syscall(SYS_settimeofday, 0, 0))
  TRY("init_module", syscall(SYS_init_module, buf, 0, ""))
  TRY("kexec_load", syscall(SYS_kexec_load, 0, 0, 0, 0))
  TRY("swapon", syscall(SYS_swapon, "/tmp", 0))
  TRY("personality", syscall(SYS_personality, 0x0400000))
  TRY("x32_write", syscall(SYS_write | 0x40000000, 1, "x", 1))
  if (!strcmp(argv[1], "int80")) { long r; __asm__ volatile("movl $4, %%eax; movl $1, %%ebx; int $0x80" : "=a"(r) :: "ebx"); printf("survived ret=%ld\n", r); return 0; }
  return 2;
}
"#;

const EPERM: i64 = 1;
const ENOSYS: i64 = 38;

fn usable() -> bool {
    let ok = |c: &mut Command| c.output().map(|o| o.status.success()).unwrap_or(false);
    ok(Command::new("bwrap").args(["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"]))
        && ok(Command::new("gcc").arg("--version"))
}

struct Rig {
    ws: tempfile::TempDir,
    sb: Sandbox,
}

fn rig() -> Option<Rig> {
    if !usable() {
        eprintln!("skipped: needs bubblewrap, user namespaces and gcc");
        return None;
    }
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("probe.c"), C).unwrap();
    assert!(Command::new("gcc").args(["-O0", "-w", "-o"]).arg(ws.path().join("probe")).arg(ws.path().join("probe.c")).status().unwrap().success());
    let sb = Sandbox::new(SandboxOptions::new(ws.path()).mount_at("/work"));
    Some(Rig { ws, sb })
}

/// the same sandbox without the seccomp program and without the nested-namespace switch
async fn plain(ws: &std::path::Path, cmd: &str) -> String {
    let mut args = bwrap_args(&ws.to_string_lossy(), "/work", "/work", &BTreeMap::new());
    for (flag, n) in [("--seccomp", 2), ("--disable-userns", 1)] {
        let i = args.iter().position(|a| a == flag).unwrap();
        args.drain(i..i + n);
    }
    let argv: Vec<String> = ["bwrap".to_string()].into_iter().chain(args).chain(["/usr/bin/bash".into(), "-c".into(), cmd.into()]).collect();
    spawn::run(&argv, Duration::from_secs(30), 1 << 20, None).await.unwrap().stdout
}

fn parse(out: &str) -> Option<(i64, i64)> {
    let r = out.split("ret=").nth(1)?;
    let (ret, rest) = r.split_once(' ')?;
    Some((ret.parse().ok()?, rest.trim().strip_prefix("errno=")?.parse().ok()?))
}

async fn probe(sb: &Sandbox, name: &str) -> (Option<(i64, i64)>, String) {
    let r = sb.exec(&format!("./probe {name}"), None, &BTreeMap::new()).await;
    (parse(&r.stdout), format!("{}{}", r.stdout, r.stderr))
}

#[tokio::test]
async fn calls_that_reach_kernel_code_a_tenant_has_no_use_for_fail_with_eperm() {
    let Some(r) = rig() else { return };
    for name in ["unshare_user", "unshare_mount", "unshare_net", "clone_newuser", "setns", "mount", "pivot_root", "chroot", "ptrace_traceme", "ptrace_attach_parent",
        "process_vm_readv", "bpf", "perf_event_open", "io_uring_setup", "keyctl", "add_key", "userfaultfd", "open_by_handle_at", "memfd_create", "reboot",
        "sethostname", "settimeofday", "init_module", "kexec_load", "swapon", "personality"] {
        let (got, out) = probe(&r.sb, name).await;
        assert_eq!(got, Some((-1, EPERM)), "{name} was not refused: {out}");
    }
}

#[tokio::test]
async fn a_tenant_cannot_open_sockets_of_any_kind() {
    let Some(r) = rig() else { return };
    for name in ["socket_inet", "socket_netlink", "socket_packet", "socket_unix"] {
        let (got, out) = probe(&r.sb, name).await;
        assert_eq!(got, Some((-1, EPERM)), "{name} was not refused: {out}");
    }
}

#[tokio::test]
async fn the_filter_is_what_refuses_them_the_same_probes_succeed_without_it() {
    let Some(r) = rig() else { return };
    // each of these succeeds when only namespaces stand in the way, so a pass above is the filter's doing
    let mut ok = Vec::new();
    for name in ["unshare_user", "ptrace_traceme", "memfd_create", "socket_unix"] {
        let out = plain(r.ws.path(), &format!("./probe {name}")).await;
        if matches!(parse(&out), Some((ret, _)) if ret != -1) {
            ok.push(name);
        }
    }
    ok.sort();
    assert_eq!(ok, ["memfd_create", "ptrace_traceme", "socket_unix", "unshare_user"], "the unfiltered controls did not behave as expected, so the tests above prove nothing");
}

#[tokio::test]
async fn the_escapes_through_the_abi_fail_x32_numbers_are_refused_and_32_bit_calls_end_the_process() {
    let Some(r) = rig() else { return };
    let (x32, out) = probe(&r.sb, "x32_write").await;
    assert_eq!(x32, Some((-1, EPERM)), "{out}");
    // where the host runs 32-bit programs at all, int 0x80 must end the process, not return
    let control = plain(r.ws.path(), "./probe int80").await;
    let filtered = r.sb.exec("./probe int80", None, &BTreeMap::new()).await;
    if control.contains("survived") {
        assert!(!filtered.stdout.contains("survived"), "a 32-bit system call went through: {}", filtered.stdout);
        assert_eq!(filtered.exit_code, 159, "the process should have been killed by SIGSYS");
    }
}

#[tokio::test]
async fn clone3_reports_it_does_not_exist_so_libc_falls_back_and_an_ordinary_fork_works() {
    let Some(r) = rig() else { return };
    let (c3, out) = probe(&r.sb, "clone3").await;
    assert_eq!(c3, Some((-1, ENOSYS)), "{out}");
    let fork = r.sb.exec("bash -c 'echo a & wait; echo b'", None, &BTreeMap::new()).await;
    assert_eq!(fork.stdout.split_whitespace().collect::<Vec<_>>().join(" "), "a b");
}

#[tokio::test]
async fn the_process_holds_no_privilege_and_cannot_gain_any() {
    let Some(r) = rig() else { return };
    let s = r.sb.exec("grep -E '^(NoNewPrivs|Seccomp|CapEff|CapBnd|CapAmb):' /proc/self/status", None, &BTreeMap::new()).await.stdout;
    let field = |k: &str| s.lines().find(|l| l.starts_with(k)).map(|l| l.split_whitespace().nth(1).unwrap_or("").to_string()).unwrap_or_default();
    assert_eq!(field("NoNewPrivs:"), "1");
    assert_eq!(field("Seccomp:"), "2");
    for k in ["CapEff:", "CapBnd:", "CapAmb:"] {
        assert!(field(k).chars().all(|c| c == '0') && !field(k).is_empty(), "{k} is not empty: {s}");
    }
}

#[tokio::test]
async fn nothing_of_the_host_is_there_to_reach_no_sysfs_no_devices_no_secrets_a_read_only_proc_sys() {
    let Some(r) = rig() else { return };
    let out = r.sb.exec("test -e /sys/class && echo present || echo absent; ls /dev | tr '\\n' ' '; echo; ls /root /home /etc/shadow /var 2>&1 | head -3; echo 1 > /proc/sys/kernel/hostname 2>&1; echo $?", None, &BTreeMap::new()).await.stdout;
    let lines: Vec<&str> = out.trim().split('\n').collect();
    assert_eq!(lines[0], "absent", "sysfs is visible");
    for d in ["mem", "kmem", "kmsg", "kvm", "sda", "vda", "nvme0n1", "fuse", "net"] {
        assert!(!lines[1].split(' ').any(|x| x == d), "/dev/{d} is visible: {}", lines[1]);
    }
    assert!(lines[2].contains("No such file") || lines[2].contains("cannot access"), "host directories are visible: {}", lines[2]);
    assert_ne!(lines[lines.len() - 1], "0", "a write to /proc/sys succeeded");
}
