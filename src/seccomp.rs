//! A seccomp filter for the file-only tier, assembled here because bwrap takes a compiled BPF program on a file descriptor and nothing
//! else needs libseccomp. The policy is an allowlist (seccomp_policy.rs); anything else fails with EPERM, so a command that needs more
//! breaks loudly and can be looked at, and a program on another architecture, or using the x32 ABI, is killed.
use crate::seccomp_policy::{ALLOWED, NR_CLONE, NR_CLONE3};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::OnceLock;

const AUDIT_ARCH_X86_64: u32 = 0xc000003e;
const RET_ALLOW: u32 = 0x7fff0000;
const RET_KILL_PROCESS: u32 = 0x80000000;
const fn errno(e: u32) -> u32 {
    0x00050000 | e
}
const EPERM: u32 = 1;
const ENOSYS: u32 = 38;
/// the namespace flags of clone: CLONE_NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET
const CLONE_NS_FLAGS: u32 = 0x7e020000;
// seccomp_data: nr at 0, arch at 4, then the arguments, 8 bytes each from 16
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;

#[derive(Clone, Copy)]
struct Insn(u16, u8, u8, u32);
const fn ld(off: u32) -> Insn {
    Insn(0x20, 0, 0, off) // BPF_LD | BPF_W | BPF_ABS
}
const fn jeq(k: u32, jt: u8, jf: u8) -> Insn {
    Insn(0x15, jt, jf, k) // BPF_JMP | BPF_JEQ | BPF_K
}
const fn jset(k: u32, jt: u8, jf: u8) -> Insn {
    Insn(0x45, jt, jf, k) // BPF_JMP | BPF_JSET | BPF_K
}
const fn ret(k: u32) -> Insn {
    Insn(0x06, 0, 0, k)
}

/// the calls nearly every command makes, first, because the program is a linear scan
const HOT: &[&str] = &[
    "read", "write", "openat", "close", "fstat", "newfstatat", "mmap", "munmap", "mprotect", "brk", "rt_sigaction", "rt_sigprocmask", "pread64",
    "getdents64", "lseek", "ioctl", "access", "faccessat2", "futex", "exit_group", "execve", "statx", "getrandom", "fcntl", "dup2", "pipe2", "wait4",
];

pub fn build_filter() -> Vec<u8> {
    let nr_of = |n: &str| ALLOWED.iter().find(|(name, _)| *name == n).map(|(_, nr)| *nr);
    let mut order: Vec<u32> = HOT.iter().filter_map(|n| nr_of(n)).collect();
    order.extend(ALLOWED.iter().filter(|(n, _)| !HOT.contains(n)).map(|(_, nr)| *nr));
    let mut p = vec![
        ld(OFF_ARCH), jeq(AUDIT_ARCH_X86_64, 1, 0), ret(RET_KILL_PROCESS),
        ld(OFF_NR),
        // clone is allowed without namespace flags; clone3 says it does not exist, which is what makes libc fall back to clone
        jeq(NR_CLONE3, 0, 1), ret(errno(ENOSYS)),
        jeq(NR_CLONE, 0, 4), ld(OFF_ARG0), jset(CLONE_NS_FLAGS, 1, 0), ret(RET_ALLOW), ret(errno(EPERM)),
        // the clone block loaded the flags, so the number has to be loaded again before the scan
        ld(OFF_NR),
    ];
    for nr in order {
        p.push(jeq(nr, 0, 1));
        p.push(ret(RET_ALLOW));
    }
    p.push(ret(errno(EPERM)));
    let mut b = Vec::with_capacity(p.len() * 8);
    for Insn(code, jt, jf, k) in p {
        b.extend_from_slice(&code.to_le_bytes());
        b.push(jt);
        b.push(jf);
        b.extend_from_slice(&k.to_le_bytes());
    }
    b
}

/// The filter as an anonymous file. Each command gets its own open description of it, because bwrap reads it from the descriptor's
/// position and commands run at the same time.
pub fn open_filter() -> std::io::Result<OwnedFd> {
    static MEM: OnceLock<OwnedFd> = OnceLock::new();
    let mem = MEM.get_or_init(|| unsafe {
        let fd = libc::memfd_create(c"sandroute-seccomp".as_ptr(), libc::MFD_CLOEXEC);
        assert!(fd >= 0, "memfd_create: {}", std::io::Error::last_os_error());
        let f = OwnedFd::from_raw_fd(fd);
        let b = build_filter();
        assert_eq!(libc::write(fd, b.as_ptr().cast(), b.len()), b.len() as isize);
        f
    });
    let fd = unsafe { libc::open(format!("/proc/self/fd/{}\0", mem.as_raw_fd()).as_ptr().cast(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
}
