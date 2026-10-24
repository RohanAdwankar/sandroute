# What the Claude Code box actually is

Findings from probing a live Claude Code (web/mobile) session's VM directly, over a
reverse shell dialed out through [ws-term](https://github.com/RohanAdwankar/ws-term). Every
claim below names the exact command that produced it, so it can be re-checked rather than
trusted. "Confirmed" means a command produced unambiguous evidence; "open" means the
evidence is suggestive but has a plausible innocent explanation that wasn't ruled out.

This complements `tricks.md`, which only cites the facts relevant to a specific
capacity trick. This file is the primary findings, and the "Applying this" section at the
end is what actually matters for sandroute.

## Identity

- Kernel: `6.18.44-fc-v153 (builder@sandboxing) (gcc (GCC) 15.3.0, GNU ld 2.46)`. No
  `/proc/version_signature` (every Ubuntu kernel has one), so this is not an Ubuntu build —
  Ubuntu is only the userspace (`Ubuntu 24.04.5 LTS` in `/etc/os-release`). Confirmed.
- Cold boot (this session): `Run /process_api as init process` at 1.82s into boot. The
  platforms post's "~430ms to init" figure was from an earlier probe; this run was slower.
  Confirmed, but noisy across runs.
- `process_api` is PID 1, a Rust binary, started with
  `rdinit=/process_api -- --firecracker-init --addr 0.0.0.0:2024 --block-local-connections
  --control-vsock-port 5001 --listen-vsock-port 2024 --log-vsock-port 5002`. Confirmed.
- 4 vCPU (Xeon, KVM, no hyperthreading), 16 GiB RAM, no swap. Confirmed
  (`nproc`, `/proc/meminfo`).

## Disk: a 256 GiB filesystem with a ~30 GiB hard cap

`/dev/vda` is ext4, 256 GiB, mounted `discard,no_prefetch_block_bitmaps,resv_strict,
resuid=65534,resgid=65534`. `df` agrees it's 256 GiB; `stat -f` on `/` shows only ~30 GiB
actually available (it was ~14 GiB in an earlier probe of the same box, weeks apart — the
cap is tunable without rebuilding the image).

`resv_strict` is not a mainline Linux mount option — checked against `torvalds/linux` and
all of public GitHub, zero hits outside our own notes. Confirmed custom.

**Why it exists:** the agent runs as `uid=0` inside the VM — real root, not a user
namespace (no `userns` remap visible; contrast with Muse below). Stock ext4's reserved-block
quota is enforced by checking `capable(CAP_SYS_RESOURCE)`, which real root always has
(`fs/ext4/balloc.c`, `ext4_has_free_clusters`), so a quota enforced only by reservation does
nothing against a root tenant. `resv_strict` almost certainly removes that `capable()`
bypass, which is the only way a disk cap can mean anything once the tenant is root.
Confirmed mechanism; the "why root" framing is reasoned, not from any Anthropic source.

**Why root at all:** reasoned, not confirmed. A coding agent needs `apt install`, arbitrary
file writes, and other things that don't compose well with a precise permission policy
chosen in advance. The actual isolation boundary is the VM, so there's nothing gained by
also restricting the user inside it — an escaped-from-Unix-permissions agent is still stuck
in one disposable microVM either way.

## Memory: cgroups are real, and scoped more narrowly than "a sandbox"

`/proc/self/cgroup` shows a classic cgroup v1 layout (nine separate numbered hierarchies,
not one unified v2 tree). Of those nine controllers, exactly one —
`memory` — has a path reaching past `/`:

```
4:memory:/process_api/<uuid>/claude-code-bash
```

Every other controller (`cpu`, `cpuset`, `pids`, `blkio`, `devices`, `freezer`) sits at the
shared root. `devices.list` for the root reads `a *:* rwm` — unrestricted.

**The UUID is per tool call, not per command or per session.** Confirmed by direct
comparison: two separate `setsid`-launched reverse shells (two separate Bash tool
invocations) got two different UUIDs. Two commands run inside *one* live shell got the
same UUID both times. A `setsid nohup ... &` detaches from its originating call's
lifecycle but keeps the cgroup it was born into — a long-lived background process stays
tagged to the tool call that spawned it, for as long as it lives.

So: this mechanism looks built for per-call memory accounting/limiting, not general
sandboxing. CPU, process count, and device access are unscoped.

**What this rules out:** cgroup v1 cannot attach the network-egress eBPF hook
(`BPF_CGROUP_INET_EGRESS`) the way v2 can — that hook needs the unified hierarchy. `/sys/fs/bpf`
is mounted but empty (nothing pinned, though a program can be attached without being
pinned). `Seccomp: 0` for our process. So nothing *inside the guest* that we can see
explains how network egress gets enforced — the mechanism, whatever it is, is unlikely to
be cgroup-based given the v1 architecture, and it isn't netfilter either (below).

## Network: no netfilter, SNI-shaped filtering, proxy rarely reachable

`iptables -L` and `-t nat` both show every chain `ACCEPT`, zero packets, nothing loaded.
Confirmed: egress is not enforced by netfilter rules inside the guest.

`https_proxy=http://127.0.0.1:34683` is set, with a long `no_proxy` allowlist (
`api.anthropic.com`, package registries, private ranges, `*.svc.cluster.local`, etc). A CA
cert trusted by the system exists at `/root/.ccr/agent-proxy-ca.crt` /
`/etc/ssl/certs/ccr-agent-proxy.pem`, and `/opt/node-tools/node_modules/` carries a Node
proxying toolkit (`http-proxy`, `proxy-from-env`, `pac-proxy-agent`) — the proxy, when it's
there, is plausibly a Node process, not a C/Go binary.

**The proxy port was closed in 3 of 3 samples, hours apart.** `127.0.0.1:34683` refused
every connection attempt across three separate sessions on two different days. Whatever it's
for, it is not a steadily-running local service — more likely spun up only transiently, or
vestigial for the path we were testing.

**Raw TCP, arbitrary ports:** `/dev/tcp` connects (no curl, no proxy env, no DNS lookup —
pure `connect()`) to `1.1.1.1` and `8.8.8.8` on **port 53 failed**; the same two addresses on
**port 443 succeeded**, along with a third address (`example.com`'s resolved IP). So port 53
is closed (plausibly just "TCP/53 isn't forwarded," unrelated to policy — DNS is UDP), and
raw TCP to arbitrary public IPs on 443 is *not* blocked at the connect() level. Confirmed.

**But a TLS handshake on that same open port behaves differently depending on SNI — this is
the one clean, controlled result:**

```
# same IP, same port, nothing else different
curl -sk https://172.66.147.243/                                        → http=000  time=2.23s
curl -sk --resolve example.com:443:172.66.147.243 https://example.com/  → http=200  time=0.32s
```

TCP connects fine either way (confirmed separately). With no SNI, the TLS exchange fails.
With `example.com`'s real SNI, over the identical IP and port, it succeeds fast. The only
variable is the ClientHello's SNI field, which is sent in cleartext — reading it needs no
MITM, no broken TLS, just inspection of one plaintext field. This is consistent with
SNI-based filtering sitting on the path, almost certainly host-side rather than in the
guest, since nothing in the guest (no netfilter, no BPF we can find, cgroup v1 can't do the
hook) explains it. Confirmed behavior; host-side-vs-somewhere-else is inferred, not proven —
we have no visibility past the guest's own NIC.

## Muse, for contrast (from the earlier investigation)

Stock kernel (`7.0.0-26-generic`, confirmed not custom). Root inside its `htch-runtime`
container is a **user namespace** (`uid=0` in-container, real host uid `131072`), plus
`NoNewPrivs` and seccomp filters. A namespaced root has no `CAP_SYS_RESOURCE` against a
filesystem it doesn't own, so the stock ext4 reservation would just work — no `resv_strict`
needed. It also ships a dedicated 100 GiB LUKS2 volume for user data rather than a
reservation trick on a bigger filesystem. Different architecture, same underlying problem,
solved without a kernel patch — because the privilege model is different from the start.

## Applying this to sandroute

1. **Persist a disk, never memory, on release.** This is the biggest one and is now
   *confirmed*, not inferred: Claude Code's reclaim path keeps one writable disk per tenant
   and kills the processes, nothing more. Our released design caps out at 416 tenants
   because it snapshots memory (11-13 GiB written at the limit). Give each tenant a small
   sparse writable disk and "release" becomes "kill the VM" — no memory snapshot needed at
   all. Worth checking whether our Firecracker version can point a drive at a per-tenant
   file after loading a shared snapshot; if not, this forces a cold boot per release instead
   of a restore, which is its own tradeoff to measure.
2. **Size tenant disks to the quota directly.** We don't need `resv_strict` — our tenants
   aren't root inside a user namespace the way Muse's are, but we also don't need a single
   giant shared filesystem. A sparse per-tenant file (`truncate -s <quota>`) with `discard`
   gets the same thin-provisioning property with zero kernel changes.
3. **Memory-only per-task cgroups are cheap and we don't have them at all.** Claude Code's
   version is one cgroup per tool call, memory-scoped only — not a general sandbox, just
   accounting/limiting. We could add the same for free: one memory cgroup per tenant task,
   nothing else, gives real per-task memory numbers instead of reading them off `ps`.
4. **Don't copy the egress design as-is.** It appears to live outside the guest (no visible
   in-guest enforcement) and depends on SNI inspection that only works because TLS SNI is
   unencrypted — a client using encrypted ClientHello (ECH) or not sending SNI at all (our
   raw-IP test) would need a different check. If sandroute ever needs real egress control
   for untrusted tenants, host-side enforcement (not relying on the guest at all) is the
   validated shape; SNI-only filtering is a known-incomplete one.
5. **The `mitigations=` boot flags aren't worth copying here.** Covered already in
   `tricks.md`'s mitigation-vectors section — our guest kernel predates that syntax and the
   CPU isn't exposed to the bugs they're guarding against anyway.

## Open questions

- Whether the SNI-filtering result generalizes (one IP, one controlled pair) or was
  specific to that destination.
- What, concretely, enforces it — host-side is the best-supported guess but isn't proven;
  we have no way to see past the guest's own NIC from inside it.
- Whether `127.0.0.1:34683` is ever actually live during a real model turn, or whether that
  env var is vestigial for the code path being exercised here.
