import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox, bwrapArgs } from "../src/sandbox.ts";

// What a hostile tenant would try, one thing at a time. Each probe is a small C program that makes one
// system call and prints what came back. They run inside the sandbox, and the ones that would reach
// kernel code a tenant has no business reaching must fail. A few also run in a sandbox with the filter
// taken off, so a probe that fails for some other reason cannot pass for a filter that is doing nothing.
const have = (c: string[]) => spawnSync(c[0], c.slice(1)).status === 0;
const usable = have(["bwrap", "--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"]) && have(["gcc", "--version"]);
const opts = { skip: usable ? false : "needs bubblewrap, user namespaces and gcc" };

const C = String.raw`
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
  TRY("clone_plain_fork", syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0) == 0 ? (_exit(0), 0) : 0)
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
`;

function rig() {
  const ws = mkdtempSync(path.join(tmpdir(), "escape-"));
  const src = path.join(ws, "probe.c");
  writeFileSync(src, C);
  const r = spawnSync("gcc", ["-O0", "-o", path.join(ws, "probe"), src, "-w"]);
  assert.equal(r.status, 0, String(r.stderr));
  chmodSync(path.join(ws, "probe"), 0o755);
  return { ws, sb: new Sandbox({ workspace: ws, mountAt: "/work" }) };
}

// the same sandbox without the seccomp program and without the nested-namespace switch
function plain(ws: string, cmd: string) {
  const args = bwrapArgs(ws, "/work", "/work");
  const drop = (flag: string, n: number) => { const i = args.indexOf(flag); if (i >= 0) args.splice(i, n); };
  drop("--seccomp", 2); drop("--disable-userns", 1);
  return spawnSync("bwrap", [...args, "/usr/bin/bash", "-c", cmd], { encoding: "utf8" });
}

const probe = async (sb: Sandbox, name: string) => {
  const r = await sb.exec(`./probe ${name}`);
  const m = /ret=(-?\d+) errno=(\d+)/.exec(r.stdout);
  return { ret: m ? Number(m[1]) : null, errno: m ? Number(m[2]) : null, exit: r.exitCode, out: r.stdout + r.stderr };
};
const EPERM = 1, ENOSYS = 38;

test("calls that reach kernel code a tenant has no use for fail with EPERM", opts, async () => {
  const { sb } = rig();
  for (const name of ["unshare_user", "unshare_mount", "unshare_net", "clone_newuser", "setns", "mount", "pivot_root", "chroot",
    "ptrace_traceme", "ptrace_attach_parent", "process_vm_readv", "bpf", "perf_event_open", "io_uring_setup", "keyctl", "add_key",
    "userfaultfd", "open_by_handle_at", "memfd_create", "reboot", "sethostname", "settimeofday", "init_module", "kexec_load", "swapon", "personality"]) {
    const r = await probe(sb, name);
    assert.deepEqual([r.ret, r.errno], [-1, EPERM], `${name} was not refused: ${r.out}`);
  }
});

test("a tenant cannot open sockets of any kind", opts, async () => {
  const { sb } = rig();
  for (const name of ["socket_inet", "socket_netlink", "socket_packet", "socket_unix"]) {
    const r = await probe(sb, name);
    assert.deepEqual([r.ret, r.errno], [-1, EPERM], `${name} was not refused: ${r.out}`);
  }
});

test("the filter is what refuses them: the same probes succeed in a sandbox without it", opts, () => {
  const { ws } = rig();
  // each of these succeeds when only namespaces stand in the way, so a pass above is the filter's doing
  const ok: string[] = [];
  for (const name of ["unshare_user", "ptrace_traceme", "memfd_create", "socket_unix"]) {
    const r = plain(ws, `./probe ${name}`);
    if (/ret=(?!-1)\d+/.test(r.stdout)) ok.push(name);
  }
  assert.deepEqual(ok.sort(), ["memfd_create", "ptrace_traceme", "socket_unix", "unshare_user"], "the unfiltered controls did not behave as expected, so the tests above prove nothing");
});

test("the escapes through the ABI fail: x32 numbers are refused and 32-bit calls end the process", opts, async () => {
  const { sb } = rig();
  const x32 = await probe(sb, "x32_write");
  assert.deepEqual([x32.ret, x32.errno], [-1, EPERM], x32.out);
  const compat = await sb.exec("./probe int80");
  assert.ok(!compat.stdout.includes("survived") || /ret=-/.test(compat.stdout), `a 32-bit system call went through: ${compat.stdout}`);
});

test("clone3 reports it does not exist so libc falls back, and an ordinary fork works", opts, async () => {
  const { sb } = rig();
  const c3 = await probe(sb, "clone3");
  assert.deepEqual([c3.ret, c3.errno], [-1, ENOSYS], c3.out);
  const fork = await sb.exec("bash -c 'echo a & wait; echo b'");
  assert.equal(fork.stdout.replace(/\s+/g, " ").trim(), "a b");
});

test("the process holds no privilege and cannot gain any", opts, async () => {
  const { sb } = rig();
  const s = (await sb.exec("grep -E '^(NoNewPrivs|Seccomp|CapEff|CapBnd|CapAmb):' /proc/self/status")).stdout;
  assert.match(s, /NoNewPrivs:\s+1/);
  assert.match(s, /Seccomp:\s+2/);
  for (const k of ["CapEff", "CapBnd", "CapAmb"]) assert.match(s, new RegExp(`${k}:\\s+0+\\b`), `${k} is not empty`);
});

test("nothing of the host is there to reach: no sysfs, no devices, no secrets, a read-only /proc/sys", opts, async () => {
  const { sb } = rig();
  const r = await sb.exec("test -e /sys/class && echo present || echo absent; ls /dev | tr '\\n' ' '; ls /root /home /etc/shadow /var 2>&1 | head -3; echo 1 > /proc/sys/kernel/hostname 2>&1; echo $?");
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], "absent", "sysfs is visible");
  for (const d of ["mem", "kmem", "kmsg", "kvm", "sda", "vda", "nvme0n1", "fuse", "net"]) assert.ok(!lines[1].split(" ").includes(d), `/dev/${d} is visible: ${lines[1]}`);
  assert.ok(/No such file|cannot access/.test(lines[2]), `host directories are visible: ${lines[2]}`);
  assert.notEqual(lines[lines.length - 1], "0", "a write to /proc/sys succeeded");
});
