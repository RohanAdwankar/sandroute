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
tier runs in a namespace sandbox with no system call filter, which is weaker than gVisor. Running that
tier under gVisor instead is a design choice the numbers here do not cover.

The balloon (virtio-balloon free page reporting, `--balloon`) hands back guest memory as the guest frees it:
a VM that allocated 120 MB and freed it dropped from 184 MiB to 64 MiB in three seconds. It moves the kept
design from 128 to about 150 tenants, because a resident VM holds less after a command that allocated. It does
not move `suspend` or `oxroute`, which run out of cpu first.

How firm these numbers are. They were taken while other work was running on the machine, including this
write-up's own tooling, and the limits of the cpu-bound designs moved from run to run: `oxroute` passed 576 twice
and then missed 592 and 608 on later runs. Treat each limit as good to about five percent. The final numbers
come from `bench/final/run.sh`, which runs every series on an otherwise idle machine with three seeds and
records the machine, the versions and the configs next to the results.

What this does not say. Kata here is untuned: no VM templating, no memory ballooning or free page
reporting, and `crictl exec` starts a process per command, which adds tens of milliseconds to every call
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

Muse: a Cloud Hypervisor microVM with 2 vCPU and 8 GB allocated, holding a systemd-nspawn container, Postgres and
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
