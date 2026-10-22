# How many hostile tenants can one machine serve?

The claim to test: with sandroute, one machine serves more agent tenants than it does with the
best alternative sandbox. The tenants can be hostile to each other, and they behave the way people
use agents, which is mostly idle.

The short answer, on one machine and one workload: about 1.3 to 1.4 times as many as the best-tuned
alternative, and about 4.5 times as many as a microVM per tenant that is never released. The rest of
this says what that means, how it was measured, and what it does not show.

## What was compared

Three ways of giving each tenant a sandbox, all driven through the same `Sandroute` class so the
comparison is between designs and not between implementations.

**kept** is a Firecracker microVM per tenant, started up front and never released. It is the simple
thing, and every tenant is isolated by hardware virtualisation.

**suspend** is a microVM per tenant that is released after an idle window and restored on the next
command, with every command going to the VM. It is the strongest alternative that keeps every tenant
isolated by a VM, so it is the one the claim has to beat.

**oxroute** runs commands that only read, search and edit files as native processes inside a fresh
namespace sandbox with no VM at all, and uses a microVM only for commands that run code. The same
release as `suspend` applies to its VM.

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
| suspend, 5 second window | 416 (384 on two seeds) | 448, p99 4.7s | cpu, then memory |
| oxroute, 30 second window | 576 (two seeds, p99 1.2s and 1.4s) | 608, p99 3.1s | cpu |

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

E2B is the obvious comparison, and no measurement of it has been made. The `suspend` design above is
built from the same parts and approximates its approach: a Firecracker microVM per sandbox, restored from a
pre-booted template snapshot, and paused and resumed. It differs in ways that matter.

E2B's open-source infrastructure restores memory lazily through userfaultfd, layers copy-on-write block
devices, and pauses by writing memory and disk diffs against the template to object storage, so a pause
writes far less than the full memory file a guest that has to be kept costs here. It runs each sandbox in
its own cgroup and network namespace with a per-sandbox firewall, and a third-party comparison describes a
resume as taking about a second, which includes fetching from object storage when a node has no cached copy.
The benchmark here has none of the object storage, orchestrator, databases or firewall, so its restore
times, tens of milliseconds, are not comparable with a hosted service's.

A real comparison needs one of two things. Self-hosting E2B's infrastructure on comparable hardware, which
needs KVM, Postgres, Redis, ClickHouse and object storage and so a machine with more room than this one. Or
its hosted API, which can compare create and resume latency and price but not tenants per machine, since
the hardware is theirs. Until then the claim is against a microVM per tenant with snapshot pause and
resume, the design E2B and similar services use, and not against any of them.

Sources: [e2b-dev/infra](https://github.com/e2b-dev/infra),
[E2B snapshots](https://docs.e2b.dev/sandbox/snapshots),
[Fly.io on E2B](https://fly.io/learn/fly-vs-e2b/).

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
    npx tsx bench/report.mts
