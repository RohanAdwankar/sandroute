// A seccomp filter for the file-only tier, assembled here because bwrap takes a compiled BPF program on a
// file descriptor and nothing else in the tree needs libseccomp. The policy is an allowlist (see
// seccomp-policy.ts); anything else fails with EPERM, so a command that needs more breaks loudly and
// can be looked at, and a program on another architecture, or using the x32 ABI, is killed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALLOWED, NR } from "./seccomp-policy.js";

const AUDIT_ARCH_X86_64 = 0xc000003e;
const RET_ALLOW = 0x7fff0000, RET_KILL_PROCESS = 0x80000000;
const errno = (e: number) => 0x00050000 | e;
const EPERM = 1, ENOSYS = 38;
// the namespace flags of clone: CLONE_NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET
const CLONE_NS_FLAGS = 0x7e020000;
// seccomp_data: nr at 0, arch at 4, then the arguments, 8 bytes each from 16
const OFF_NR = 0, OFF_ARCH = 4, OFF_ARG0 = 16;

type Insn = [code: number, jt: number, jf: number, k: number];
const LD = (off: number): Insn => [0x20, 0, 0, off];                      // BPF_LD | BPF_W | BPF_ABS
const JEQ = (k: number, jt: number, jf: number): Insn => [0x15, jt, jf, k];  // BPF_JMP | BPF_JEQ | BPF_K
const JSET = (k: number, jt: number, jf: number): Insn => [0x45, jt, jf, k]; // BPF_JMP | BPF_JSET | BPF_K
const RET = (k: number): Insn => [0x06, 0, 0, k];

// the calls nearly every command makes, first, because the program is a linear scan
const HOT = ["read", "write", "openat", "close", "fstat", "newfstatat", "mmap", "munmap", "mprotect", "brk", "rt_sigaction", "rt_sigprocmask",
  "pread64", "getdents64", "lseek", "ioctl", "access", "faccessat2", "futex", "exit_group", "execve", "statx", "getrandom", "fcntl", "dup2", "pipe2", "wait4"];

export function buildFilter(): Buffer {
  const order = [...HOT.filter((n) => n in ALLOWED), ...Object.keys(ALLOWED).filter((n) => !HOT.includes(n))];
  const p: Insn[] = [
    LD(OFF_ARCH), JEQ(AUDIT_ARCH_X86_64, 1, 0), RET(RET_KILL_PROCESS),
    LD(OFF_NR),
    // clone is allowed without namespace flags; clone3 says it does not exist, which is what makes libc fall back to clone
    JEQ(NR.clone3, 0, 1), RET(errno(ENOSYS)),
    JEQ(NR.clone, 0, 4), LD(OFF_ARG0), JSET(CLONE_NS_FLAGS, 1, 0), RET(RET_ALLOW), RET(errno(EPERM)),
  ];
  // the clone block loaded the flags, so the number has to be loaded again before the scan
  p.push(LD(OFF_NR));
  for (const n of order) p.push(JEQ(ALLOWED[n], 0, 1), RET(RET_ALLOW));
  p.push(RET(errno(EPERM)));
  const b = Buffer.alloc(p.length * 8);
  p.forEach(([code, jt, jf, k], i) => { b.writeUInt16LE(code, i * 8); b.writeUInt8(jt, i * 8 + 2); b.writeUInt8(jf, i * 8 + 3); b.writeUInt32LE(k >>> 0, i * 8 + 4); });
  return b;
}

let file: string | undefined;
/** The filter on disk, written once per process, for bwrap to read from a descriptor. */
export function filterFile(): string {
  if (!file) {
    const dir = mkdtempSync(path.join(tmpdir(), "sandroute-seccomp-"));
    file = path.join(dir, "filter.bpf");
    writeFileSync(file, buildFilter(), { mode: 0o600 });
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return file;
}
