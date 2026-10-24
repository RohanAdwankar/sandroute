# How many hostile tenants can one machine serve?

The claim to test: with sandroute, one machine serves more agent tenants than it does with the
best alternative sandbox. The tenants can be hostile to each other, and they behave the way people
use agents, which is mostly idle.

The short answer, on one machine and one workload: about 1.3 to 1.4 times as many as the best-tuned
alternative, and about 4.5 times as many as a microVM per tenant that is never released. The rest of
this says what that means, how it was measured, and what it does not show.

## What was compared

Seven ways of giving each tenant a sandbox, all driven through the same `Sandroute` class so the
comparison is between designs and not between implementations.

**kept** is a Firecracker microVM per tenant, started up front and never released. It is the simple
thing, and every tenant is isolated by hardware virtualisation.

**suspend** is a microVM per tenant that is released after an idle window and restored on the next
command, with every command going to the VM. It is the strongest alternative that keeps every tenant
isolated by a VM, so it is the one the claim has to beat.

**oxroute** runs commands that only read, search and edit files as native processes inside a fresh
namespace sandbox with no VM at all, and uses a microVM only for commands that run code. The same
release as `suspend` applies to its VM.

**kata** is a Kata Containers pod per tenant, driven through the Kubernetes CRI (`crictl` against
containerd with Kata 4.3.1 as its runtime, Cloud Hypervisor as the VMM, virtio-fs for the workspace),
kept up for the whole run. Kata is what a Kubernetes operator picks to hold hostile tenants apart, since a
plain pod shares the host kernel. Each pod's guest has 1 vCPU and 256 MiB, like the Firecracker VMs.

**kata-cold** is the same, but a pod is deleted after the idle window and the next command boots a new
one. Kata has no snapshot to release a pod to, so deleting it is the only way it gives memory back.

**gvisor** is a gVisor (`runsc`, systrap platform) pod per tenant through the same CRI path as `kata`,
kept up. gVisor puts a userspace kernel between the tenant and the host, so there is no VM and no guest
kernel to pay memory for. It is the other standard way to hold hostile tenants apart, and it is how
several hosted sandboxes are built. **gvisor-cold** deletes the pod after the idle window like `kata-cold`.

Both released designs use the same release, which matters. A release that writes the VM's whole memory
to disk is expensive, and it was the first thing to fail (see below). A guest that holds nothing worth
keeping is now thrown away instead: the workspace belongs to the host and is pushed back on every wake,
caches regenerate, and a running process already blocks a release, so what a snapshot protects is state
the guest holds outside the workspace, such as an installed package. With none of that, the next wake
restores the shared pristine snapshot and nothing is written. The agent measures this rather than
looking at what commands ran, so there is no list of commands that do or do not leave state.

## Why the light tier is not an interpreter any more

The light tier used to be a JavaScript interpreter inside the one process that serves every tenant. That
is not a boundary a hostile tenant can be held behind, because a bug in the interpreter is a bug in the
process holding everyone's workspace. Each light command is now an ordinary native process under
bubblewrap, which needs no root: its own PID namespace, no network, a read-only system, and only that
tenant's workspace visible and writable. Nothing is held for an idle tenant, and the tests assert the
isolation properties and were each checked to fail when the sandbox was weakened.

It is container-grade isolation, which is weaker than a VM because the command shares the host kernel.
That is why only fixed utilities run there; code a tenant wrote still goes to a microVM. The
`oxroute` extra tenants are therefore bought partly with a weaker boundary for the commands it handles
on the host, and that trade should be weighed against the numbers below. One thing is not hidden:
`/proc/self/mountinfo` names the host directory behind the workspace mount, which is the tenant's own
and never another's.

### The system call filter

The namespaces hide the host from the tenant. They do not limit what the tenant may ask the kernel, and the kernel
is where a container escape lives. The tier now also runs under a seccomp allowlist of 299 system calls, taken from
Docker's default profile (the most reviewed list there is) and cut further: no namespaces, so no `unshare`, `setns`
or `clone` with a namespace flag; no `mount`, `ptrace`, `bpf`, `io_uring`, `keyctl`, `perf_event_open` or
`userfaultfd`; no sockets of any kind; no `memfd_create`. `clone3` answers "does not exist" so libc falls back to
`clone`. A program on another architecture or using the x32 ABI is refused or killed. Capabilities are dropped, no new
privileges can be gained, and nested user namespaces are switched off as well as filtered.

What backs this up. `test/escape.test.ts` runs a probe for each of those calls from inside the sandbox and each must
fail with EPERM; four of them also run with the filter off and must succeed there, so a pass cannot come from a probe
that fails for another reason. It also checks that a 32-bit `int 0x80` call is killed, that the process holds no
capabilities and cannot gain privilege, and that no sysfs, devices or host directories are visible.
`test/seccomp-corpus.test.ts` replays all 223 light-tier calls from the recorded sessions with and without the
filter: identical output and exit codes, none refused. The filter adds about 0.4 ms to a command of about 7.5 ms,
measured here with the filtered command run through Node and the unfiltered one through `spawnSync`, so some of that
is the harness. Replaying oxroute at 576 tenants with and without the filter, on the same machine and seeds, the filtered
runs were not worse: p99 2.8 s on both seeds against 4.5 s and 4.1 s unfiltered. All four missed the target, where
576 passed on earlier days, so the machine itself ran slower that day, which is why these numbers are rough and the
final run on an idle machine is the one to trust. These are tests of the filter doing what it was written to do. They are not an outside review, and
they do not cover the tenant's kernel attack surface through the 299 calls that remain.

## The tenants

Twenty-six real opencode sessions were recorded: eight ordinary tasks on a small Python project (explain
the repo, fix a failing test, add a function and a test, rename something, add type hints, write a README
section, list the TODOs, add a command line entry point), each given to up to three of opencode's free
models with every tool routed through sandroute. A tenant alternates between being away and handing the
agent a task. The away time is long-tailed with a mean of two minutes, a task is a recorded session
replayed with its own think times between calls, and each task starts from a fresh copy of the project.
Of 304 recorded calls, 80 of the 136 shell commands ran code, and 18 of the 26 turns ran code at some
point. Tenants were mid-task about 24% of the time.

The target is a p99 of 1.5 seconds added to a call, with no errors. "Added" is the call's time less the
time the same call takes with nothing else going on, found once by calibration. Without that the target
was dominated by commands that sleep, which take the same time under every design, so it measured the
commands and not the sandbox.

## Results

At the same number of tenants and the same 30 second window, `oxroute` keeps far fewer VMs resident.

| tenants | VMs held, suspend | VMs held, oxroute | VM memory, suspend | VM memory, oxroute |
|---|---|---|---|---|
| 64 | 24 | 16 | 602 MiB | 326 MiB |
| 128 | 49 | 30 | 1374 MiB | 692 MiB |
| 256 | 98 | 60 | 2365 MiB | 1206 MiB |

Where each design stops, with the best window found for each. A design "passes" if its p99 stays under
1.5 seconds with no errors and the machine does not run out of memory.

| design | passes up to | fails at | what runs out |
|---|---|---|---|
| kept | 128 (two seeds) | 160, aborted with 289 MiB free | memory |
| kept, with a balloon | 144 to 160 (160 passed on one seed and ran out of memory on another) | 176 and 192, out of memory | memory |
| suspend, 5 second window | 416 (two seeds, p99 0.86s and 1.28s) | 432, p99 13.6s; 448, p99 4.7s with or without a balloon | cpu and disk |
| oxroute, 30 second window | 576 (two seeds, p99 1.2s and 1.4s) | 592, p99 2.7s; 608, p99 3.1s, 2.0s, and 1.9s with a balloon | cpu |

Kata on the same machine, the same recorded sessions and the same target:

| design | passes up to | fails at | what runs out |
|---|---|---|---|
| kata | 48 to 52 (52 passed once and ran out of memory while starting once; 48 passed on two seeds and ran out of memory while starting on a third) | 56, out of memory while starting | memory |
| kata-cold, 30 second window | 48 (p99 1.25s) | 64, p99 1.85s | boot cost: every wake boots a VM |
| gvisor | 192 (two seeds, p99 1.31s and 1.38s; 200 passed once at 1.48s) | 208, out of memory while starting | cpu, then memory |
| gvisor-cold, 30 second window | 96 (p99 0.76s) | 128, p99 2.7s | cpu: creating pods costs more than it saves |

The best Kata result is about 50 tenants. `oxroute` passed 576, so roughly eleven times as many. A kept Kata
pod costs about 150 MiB of host memory by the drop in available memory (the sum of process RSS overstates
it), against 30 to 40 MiB for a Firecracker VM restored from a shared snapshot. `kata-cold` frees the
memory of idle tenants but pays a VM boot, 0.75 seconds with the image cached, on the first command of every
turn, which is why its p99 sits near the 1.5 second target from 48 tenants on.

gVisor is a much closer competitor than Kata. A kept pod costs about 40 MiB of host memory, close to a
Firecracker VM restored from a shared snapshot, and it boots in under 200 ms. It reached 192 tenants with
the cpu at 100% and p99 near the target (the median call rose from 50 ms to 170 ms as the cpu saturated),
so the limit is the cpu and not memory. It still sits below the snapshot design, `suspend`, at 416, and
`oxroute` at 576. Deleting idle gVisor pods does not help: the cost of creating them under load brings the
limit down to 96.

Isolation is not the same across these. Kata and Firecracker put a hardware virtualisation boundary
between tenants. gVisor reimplements the kernel in userspace and passes only a small set of system calls
to the host, which is a smaller attack surface than a shared kernel but not a VM. `oxroute`'s file-only
tier runs in a namespace sandbox with a seccomp allowlist of about 300 system calls. That is a smaller surface than a bare
container and still a shared kernel, so weaker than gVisor. Running that tier under gVisor instead is a design choice the
numbers here do not cover.

The balloon (virtio-balloon free page reporting, `--balloon`) hands back guest memory as the guest frees it:
a VM that allocated 120 MB and freed it dropped from 184 MiB to 64 MiB in three seconds. It moves the kept
design from 128 to about 150 tenants, because a resident VM holds less after a command that allocated. It does
not move `suspend` or `oxroute`, which run out of cpu first.

How firm these numbers are. They were taken while other work was running on the machine, including this
write-up's own tooling, and the limits of the cpu-bound designs moved from run to run: `oxroute` passed 576 twice
and then missed 592 and 608 on later runs. Treat each limit as good to about five percent. The final numbers
come from `bench/final/run.sh`, which runs every series on an otherwise idle machine with three seeds and
records the machine, the versions and the configs next to the results.

What this does not say. The Kata numbers above were taken with Kata's default of no free page reporting, so
they are not Muse's setup: Muse runs Cloud Hypervisor with a balloon that returns freed pages. With it on, a pod
that allocated and freed 150 MB drops from 259 MiB back to 161 MiB, and stays at 259 MiB with it off. The final run
(`bench/final/setup-cri.sh`) turns it on. Two other settings were tried on the idle cost of eight pods, which is about 154 MiB each: a 128 MiB guest
was worse (186 MiB), and virtio-fs with no cache would not boot a pod. Most of that cost is the guest kernel and
agent, which Kata boots fresh for every pod; Firecracker restores from a shared snapshot instead, and Kata does not
use Cloud Hypervisor's snapshots. Kata is also untuned in other ways: no VM templating, and `crictl exec` starts a process per command, which adds tens of milliseconds to every call
(`p50` 50 to 80 ms, against a few ms for the vsock agent). The calibration that sets each call's own time
was taken under Firecracker and is shared, so that per call cost counts against Kata. And the isolation is
not the same: Kata puts every command in a VM, while `oxroute` runs the fixed-utility tier in a namespace
sandbox that shares the host kernel. The ratio holds for this workload, where most commands only read and
edit files.

The machine has 4 cores and 7 GiB. Each microVM is 256 MiB and they share one pristine snapshot, which
is why a resident VM costs only about 30 to 40 MiB.

## What it took to get a fair comparison

The first sweep said something different, and the difference is the useful part. With a release that
wrote a tenant's full memory to disk, both released designs collapsed on disk bandwidth: at 64 tenants
the pure-VM design spent 333 of 477 seconds with the disk saturated and its wake calls waited a p95 of
23 seconds behind snapshots, and at 128 it wrote 48 GiB and filled the disk. That would have shown
`oxroute` winning by a wide margin, and it would have been a comparison against a design nobody would
run. Releasing a guest that holds nothing worth keeping by discarding it removed the collapse for both.

My first tuned comparison then gave the alternative a 30 second window and claimed 1.7 times. A shorter
window rescues it, because it is memory-bound and a short window frees memory sooner: at 384 tenants
the 30 second window gave a borderline p99 and the 5 second window gave 456ms. `oxroute` is cpu-bound
and does not benefit, since a shorter window means more wakes. Each design now has the window that suits
it, and the ratio is 1.3 to 1.4.

## How this relates to E2B

E2B is the obvious comparison, and no measurement of it has been made. The Kata results above are the
measured comparison against a hardened-container design. The `suspend` design above is
built from the same parts and approximates its approach: a Firecracker microVM per sandbox, restored from a
pre-booted template snapshot, and paused and resumed. It differs in ways that matter.

E2B's open-source infrastructure restores memory lazily through userfaultfd, layers copy-on-write block
devices, and pauses by writing memory and disk diffs against the template to object storage, so a pause
writes far less than the full memory file a guest that has to be kept costs here. It runs each sandbox in
its own cgroup and network namespace with a per-sandbox firewall, and a third-party comparison describes a
resume as taking about a second, which includes fetching from object storage when a node has no cached copy.
The benchmark here has none of the object storage, orchestrator, databases or firewall, so its restore
times, tens of milliseconds, are not comparable with a hosted service's.

A real comparison needs one of two things. Self-hosting E2B's infrastructure on comparable hardware. Its
[local development guide](https://github.com/e2b-dev/infra/blob/main/DEV-LOCAL.md) asks for 8 GB of RAM at
least (16 recommended, with huge pages reserving about 4 GB), root, KVM, Postgres, Redis and ClickHouse. The
services build and the three databases run without root on this 7 GiB machine, and the orchestrator needs
root for NBD, huge pages and TAP devices. It was not run, because the memory left after E2B's own
processes would decide the result. Or
its hosted API, which can compare create and resume latency and price but not tenants per machine, since
the hardware is theirs. Until then the claim is against a microVM per tenant with snapshot pause and
resume, the design E2B and similar services use, and not against any of them.

Sources: [e2b-dev/infra](https://github.com/e2b-dev/infra),
[E2B snapshots](https://docs.e2b.dev/sandbox/snapshots),
[Fly.io on E2B](https://fly.io/learn/fly-vs-e2b/).

## What the public documentation claims

The Firecracker paper (Agache et al., NSDI 2020, the AWS Lambda one) says: "Modern commodity servers contain up to 1TB of RAM, while
Lambda functions use as little as 128MB, requiring up to 8000 functions on a server to fill the RAM (or more due to soft allocation)", and
"We have tested memory and CPU oversubscription ratios of over 20x, and run in production with ratios as high as 10x, with no issues." It
measures a VMM overhead of about 3MB for Firecracker, 13MB for Cloud Hypervisor and 131MB for QEMU, and claims under 5MB and a boot under
125 ms. Those are the figures that can be checked against the paper itself. A demonstration of 4000 microVMs on a 72 vCPU, 512 GB host
is reported by LWN and is not in the paper. The other products named here (E2B, Modal, Daytona, Vercel, Fly) publish pricing and
timeouts, not a tenants-per-host figure.

Stated as tenants per GiB, Lambda's slots are 8000 per 1000 GiB at 128 MB, so about 8 a GiB before oversubscription and about 78 at the
10x production ratio (my arithmetic; the paper does not state it as a density). On this 7.05 GiB machine, with each tenant counted
at its 256 MiB guest: `oxroute` holds 576 tenants, which is 82 a GiB and an oversubscription of 20x; `suspend` holds 416, 59 a GiB and
15x; the kept Firecracker design 128, 18 a GiB and 4.5x; Kata about 50, 7 a GiB and 1.8x. gVisor has no fixed guest size and holds 192, 27 a
GiB. So the Firecracker designs here are inside the range the paper says was tested and above the ratio it says ran in production.
The comparison is loose: Lambda functions are short and bursty, these tenants are agent sessions replayed from real recordings.

## Getting oxroute toward 1000 tenants

At its limit (576 to 608 tenants) oxroute is not short of memory, with 800 MiB or more free. The calls that fail the target are the ones
that wake a VM: about 1400 wakes a run, median 210 ms and p99 3.2 s, with cpu peaking at 95% and disk wait at 65 to 80% on a 2 core
machine. Two cheap changes were tried (rough, one seed):

A 128 MiB guest halved the session snapshots on disk (7.8 GiB against 15 to 18) and did not help: 640 tenants missed at p99 4.1 s, so the
limit is cpu and not what a snapshot writes. A quieter population did: with people away 5 minutes between tasks instead of 2, 768
tenants pass at p99 0.5 s and 30% cpu, and 1000 miss at p99 4.1 s with cpu at 98% and 13.8 GiB of snapshots. So the limit with that
population is between 768 and 1000. Reaching 1000 on this machine needs either a quieter population or fewer VM wakes, for example by
running code in a cheaper middle tier than a VM.

## Setting the same VMMs up the way the products do

`bench/tenants.mts` takes `--vmm cloud-hypervisor` (a backend in `src/cloud-hypervisor.ts`, a subclass of the Firecracker one),
`--vcpus`, `--mem`, `--balloon` and `--no-snapshot` (cold boot every VM), and the designs `reclaim` (kill an idle VM, cold boot the
next) and the existing `kept` and `suspend`. That is enough to express the setups the earlier posts describe: Claude Code reclaims
an idle VM and keeps its disk, Instinct (E2B) is 2 vCPU and 1.9 GB with snapshot resume, and Muse is Cloud Hypervisor at 2 vCPU and
8 GB with a balloon. `bench/final/run.sh` has a series for each.

Cloud Hypervisor needs a guest kernel with PCI, which the Firecracker kernel is built without, so it boots Kata's 6.18 kernel with the
same root image and the same guest agent. Its snapshot is a directory, and `memory_restore_mode=CopyOnWrite` lets many VMs share one,
as Firecracker does: two VMs restored from one snapshot held 14 MiB each. A VM restored from a shared snapshot costs far less than one
cold booted. Eight tenants, idle: about 37 MiB each restored under Firecracker and 52 under Cloud Hypervisor, against about 123 and 167
cold booted. These footprints are from smoke tests, not the final run.

### Where the time goes at oxroute's limit, and why so many guests hold state

Profiling one 576-tenant run (mean over the run, 4 hardware threads): 6% user, 19% system, 16% inside the VMs, 18% waiting on disk
and 41% idle. In the busiest third of the samples (above 85% busy) disk wait is 34%, system 26%, guest 24% and user 7%. The kernel's
pressure counters say tasks were stalled on I/O 28% of the time on average (83% at the worst moment) and on memory 12% (49% at worst).
So at the limit the machine is waiting on disk and short of memory more than it is short of CPU, and the harness process itself spends
more time in the kernel (1430 against 607 percent-seconds of user time) than in its own code.

Most of that disk work is one cause. Replaying each recorded session once through a single oxroute tenant and asking the guest what it
holds that the workspace does not: 1 of the 18 sessions that touch a VM leaves anything, one scratch file in `/tmp`. A guest with any
such file cannot be thrown away, so every later release of that tenant writes a full 256 MiB memory snapshot, and that tenant stays that way
for the run. With 576 tenants picking sessions at random, about 11% hit that session at least once, which is about 65 tenants and about 16 GiB,
the 15 to 18 GiB of snapshots seen at the limit. A scratch file is cheap to keep as a file. Keeping it as a memory snapshot is the expensive way.

What changed. The guest's `/tmp` is now kept on the host the way the workspace is: the guest agent syncs it as a second area, the host holds
the files while the guest is released, and a new task clears them. A guest that wrote only to `/tmp` holds no state, so it is thrown away on release and
restored from the shared snapshot, which writes nothing. Memory snapshots are left for what only the guest has, such as installed packages.
Replaying oxroute at 576 tenants, same seed, same machine, the same day: before, five runs had p99 of 2.8, 3.3, 4.0, 4.3 and 4.5 s and 15 to 18 GiB
of snapshots on disk; after, p99 1.19 s, p95 374 ms against 700 to 1100, and no snapshots at all. The limit moved but did not vanish: 640 tenants
missed twice (p99 1.6 and 2.9 s), 672 and 704 missed worse, all with the cpu at 98%. What is left at the limit is cpu, as the profile suggested once the
disk wait was gone. The machine was slower this day than the earlier ones, when 576 passed under the old code, so the ratio of the two
(about three times lower p99 at 576) is the figure to trust, and the final run on an idle machine will give the absolute limit.

### Would a Rust port help?

Not as a port of the control plane, as far as these runs go, but one piece of it matters a great deal. At 576 tenants the harness process used 161 of the
910 cpu-seconds the machine spent, 50 of them in JavaScript. A V8 profile of it shows the main thread idle 63% of the time, with `spawn` at 17% and
`readFileSync` at 10%, and the harness's own logic around 2%. There is little JavaScript to speed up.

`spawn` is the finding. Node starts a process with fork(), which copies the page tables of the whole parent, so the price of every launch grows with how
much Node holds: 0.5 ms of cpu at 64 MiB, 5.8 ms at 390 MiB and 12.7 ms at 860 MiB, against about 0.25 ms and no measurable cpu in a Rust process at any of those
sizes, which uses posix_spawn. A control plane serving hundreds of tenants holds hundreds of MiB, and each light command pays that. `spawnd` is a small Rust
helper (`spawnd/`, built with `npm run spawnd`) that starts the sandboxed commands for the host process and reports how they ended. A command costs 6.9 ms and
about 0.3 ms of Node cpu whatever Node's size, where Node's own spawn took 18 ms at 320 MiB and 30 ms at 800 MiB.

On the same workload, oxroute used 656 cpu-seconds for 17,450 calls before (37.6 ms a call) and 560 for 19,340 calls with it (29 ms a call), 23% less per
call, with the harness's own system time down from 111 s to 64 s. At 640 tenants p99 went from 1.6 and 2.9 s to 0.9 and 2.3 s on two seeds, so the limit moved
up a little but not past 704, which still missed (5.1 s). All 64 tests pass through the helper, including the escape probes and the replay of every recorded command.

### A harness that tells the sandbox what it knows

An agent harness knows two things the sandbox only guesses at: that a turn has ended (the person is away, for minutes) and that one is about to start.
`Sandroute.release()` already existed; `prewarm()` is new. Replaying oxroute at 640 tenants, two seeds each, with the harness sending one signal at a time:

At the end of a turn it releases the VM at once, where the idle timer would wait 30 seconds. Mean resident VMs went from 150 to about 80, the lowest free memory
from 0.9 to 1.5 GB up to 3.5 to 3.7 GB, and the number of wakes did not change (1519 to 1526 and 1520 to 1475), because the next command is minutes away either way. p99
was 1.07 and 1.56 s against 0.91 and 2.27 s without it, which is within what these runs vary, and the cpu spent was the same. So the signal halves the memory the VMs hold
and costs nothing, but it does not raise the limit here, since the limit is cpu. It matters wherever memory is the limit instead, which is a bigger guest or a host with less room.

At the start of a turn it wakes the VM while the model is still thinking, so the first command does not wait. Without knowing which turns need a VM, this made things worse:
wakes rose from 1520 to 2200, cpu spent rose by about 20%, and p99 was 1.9 and 3.1 s. About a third of the recorded sessions never touch a VM, so a blind wake is wasted
work and the cpu is what is short. It would need a prediction of which turns will want one, such as the kind of task or the last turn's behaviour, and none was tried.

### What the Claude Code box showed

A probe inside a Claude Code box (kept out of the repo, since the log holds an access token) found a custom `6.18.44-fc-v153`
Firecracker kernel built with PCI, 4 vCPU and 16 GiB with no swap, a balloon with free page reporting (in 2 MiB chunks,
`page_reporting_order=9`), transparent hugepages on madvise and no hugepages, and a 256 GiB ext4 disk of which about 30 GiB
is usable. The kernel brings up only 3.2 of the 16 GiB at boot (`deferred_init=lazy`), so the host does not have to back it all.
The one wake observed was a cold boot, with a new boot id, onto a disk that had kept `/tmp`. That is one observation: the kernel
has VMGENID built in, so it could be restored from a snapshot, and this boot does not show whether it ever is.

The idea that follows is to keep a disk per tenant, kill the VM when idle and cold boot it on the next command, which writes no
memory snapshots. Tried here, at 576 tenants with every other setting the same, oxroute as it stands held 239 VMs at its peak
(CPU-bound, p99 4.3 s that day) and the cold boot variant ran out of memory with 78 VMs resident. A VM cold booted costs about
123 MiB against about 37 for one restored from the shared snapshot, so what is saved in snapshot writes is lost in memory.
Cold booting suits a host with room to spare, as Claude Code's evidently is, and not a 7 GiB laptop.

## What one command costs in each tier

The same command, run 60 times in each place, in a project of 300 small files (`bench/tiers.mts`; medians, with 95th percentiles for the slowest of the three):

| command | host, nothing around it | light sandbox | Firecracker, warm |
|---|---|---|---|
| `ls` | 4.7 ms | 6.5 ms | 11.6 ms (p95 22.6) |
| `cat` a file | 4.5 ms | 6.2 ms | 11.3 ms |
| `grep -rn` over 300 files | 5.0 ms | 7.2 ms | 13.4 ms (p95 27.1) |
| `find` and sort | 6.0 ms | 7.5 ms | 14.3 ms |
| `python3` start | 12.5 ms | 13.9 ms | 18.0 ms |
| `python3`, 85 ms of cpu | 84.0 ms | 85.7 ms | 89.7 ms |

The light sandbox adds about 1.7 ms to a command: bubblewrap building the namespaces and the seccomp program. A warm VM adds about 6 to 7 ms, which is the vsock round trip plus
the sync (the host walks the workspace and reports changes before the command, and the guest reports back after it) and shows in the p95 when a sync has something to carry. The
compute inside the VM is close to native: 85 ms of cpu took 89.7 ms, about 5% more. So the VM's cost is the fixed price of getting a command in and out, a few milliseconds, which is
why a command that only reads files is worth keeping out of it. A wake, meaning a released VM restored from the shared snapshot and then running one command through the whole
path, takes about 95 ms (p95 102). One run on this machine, with nothing else on it; the final run on an idle machine may differ a little.

## Compared with the sandboxes in the earlier posts

The two earlier posts on this blog measured three products from the inside: Claude Code, Instinct (E2B) and
Meta's Muse. What they report about each box, next to what is used here.

Claude Code: a Firecracker microVM with a custom 6.18 kernel and a Rust process as PID 1, one writable 256 GB
disk that outlives the VM and read-only shared disks for the harness. The host wakes it over vsock when a message
arrives (430 ms to init, 6.4 s to the harness) and reclaims it when idle by destroying the processes and keeping
the disk. The post did not record its cpu or memory. That reclaim is the same idea as the discard release here:
the durable state lives outside the guest, so an idle guest is thrown away.

Instinct: a Firecracker microVM from E2B with 2 vCPU, 1.9 GB of RAM and 29 GB of disk, running a full Ubuntu 22.04
desktop, up in about 1.3 s, with a timeout and either a cold boot or a snapshot resume. The snapshot resume is
the `suspend` design here.

Muse: a Cloud Hypervisor microVM (the `kata` designs here also use Cloud Hypervisor, with the root filesystem over
virtio-fs and no balloon in the committed runs, where Muse uses block disks and a balloon) with 2 vCPU and 8 GB allocated, holding a systemd-nspawn container, Postgres and
local models, kept up per user. A balloon with free page reporting returns freed pages, so an idle one costs its
working set of about 2 GB and not 8. It is the same technique as `--balloon` here. A new one takes about 40 s to
become ready, so they are pre-booted.

This work: a Firecracker microVM with 1 vCPU and 256 MiB, restored from one shared snapshot, released after an
idle window by snapshot or by discard, and for commands that only read and edit files, no VM at all.

If each tenant were held resident the way those products describe, the 5.8 GiB this machine has free would fit
about three of Instinct's (1.9 GB) or Muse's (2.1 GB working set) boxes. That is arithmetic on the figures in the
posts and not a run of their software. It also is not a fair reading of them: their boxes carry the agent harness,
a desktop, a database and models, and here the agent loop and the model live outside the VM, so the box only
runs commands. The 256 MiB guest is one of the untested choices (see above), and a larger guest is what a heavier
box would force.

What the products share with this work is the lifecycle: durable state outside the guest, an idle guest reclaimed
by the host, memory handed back by a balloon. What differs is how small the guest is allowed to be, which is the
number that decides how many fit.

## What this does not show

- One machine, four cores. The ceilings are cpu and memory on this box and scale with it, but the ratio
  between designs has only been measured here.
- One small Python project and free models. Sixty-nine percent of the turns ran code, which is a lot, and
  a population that mostly reads and edits would have far fewer VMs under `oxroute` and a larger
  advantage, while one that builds heavily would dirty much more memory per VM and narrow it.
- Most points are a single seed, and verdicts at the edges are noisy: the alternative at 384 tenants with
  a 30 second window missed on one seed and passed on another.
- The benchmark microVMs have no network, because there is one network tap on this machine. Giving every
  tenant a network is a cost all VM-based designs pay equally.
- A 24% duty cycle. A quieter population raises every ceiling; the ratio at lower activity has not been
  measured.
- The light tier's isolation is weaker than a VM's, as above.

## What was wrong along the way

Several of my own results were wrong before they were right, and the documents that carried them are
corrected here. The corpus commit says 11% of calls and 10 of 26 turns needed a machine; the figures
were read from a routing log that stops lining up with the trace, and the true ones are 80 of 136 shell
commands and 18 of 26 turns. An earlier density claim of 4x and 12x more sessions per host left the
harness out of both sides and holds only if sessions share one harness process. Building the benchmark
also found and fixed a command arriving during a suspend booting a second machine for the same session,
session snapshots colliding on file names and overwriting a mapped file, a killed process orphaning its
microVM, a snapshot cache key that ignored the VM's size, a session ending while suspended leaking its
snapshot, and the read tool failing on a directory.

## Reproducing it

    scripts/build-rootfs.sh
    npx tsx bench/collect.mts                 # record sessions, needs opencode and its free tier
    npx tsx bench/tenants.mts --calibrate --design kept --tenants 1
    npx tsx bench/tenants.mts --design oxroute --tenants 256 --minutes 6 --idle-mean 120 --window 30000
    npx tsx bench/tenants.mts --design kata --tenants 48 --minutes 6 --idle-mean 120   # needs containerd with Kata, see bench/cri-vm.mts
    CRI_CONFIG=... CRI_RUNTIME=runsc npx tsx bench/tenants.mts --design gvisor --tenants 192 --minutes 6 --idle-mean 120
    npx tsx bench/report.mts
