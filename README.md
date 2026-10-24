# sandroute

A sandbox for coding agents that serves many mostly idle tenants on one machine. It is a Rust library (`sandroute`), a static guest agent (`guest-agent`), and the benchmarks that measure it.

Most agent shell calls are `sed`, `grep`, `cat` and file edits. Those run in a light tier: a bubblewrap namespace with a seccomp allowlist, no VM, on the tenant's workspace. When a command needs a real machine, such as a compiler, a browser, git or the network, sandroute restores a microVM and sends it there. The VM is handed back after an idle window, and a VM that holds no state outside the workspace and `/tmp` is discarded rather than saved.

## How it routes

- The command line is parsed with tree-sitter-bash. Every command name in it is collected, including those inside `$(...)` and pipelines.
- If every name is on the light tier's list and the line touches only paths inside the workspace, it runs there.
- Anything else runs in the VM: unknown binaries, network clients, git, questions about the machine (`command -v`, `env`, `$PATH`) and absolute paths outside the workspace.
- The VM boots or restores on the first command that needs it. The workspace is host-authoritative: files are pushed in before a VM command and changes are pulled back after.

## Layout

- `src/router.rs`, `src/sandbox.rs`, `src/seccomp.rs`: routing and the light tier.
- `src/sandroute.rs`: the orchestrator (idle release, pinning while processes are alive, the file tools).
- `src/vmm.rs`: Firecracker and Cloud Hypervisor, snapshots, balloon. `src/cri.rs`: Kata and gVisor through containerd, used as comparison designs.
- `guest-agent/`: the static musl agent inside the VM. `scripts/build-rootfs.sh` builds the image; `scripts/net-setup.sh` creates the tap device (needs root once).
- `src/bin/tenants.rs`: the capacity benchmark. `src/bin/tiers.rs`: the cost of one command in each tier. `src/bin/report.rs`: a table of `bench/results`.

## Test

    cargo test
    cargo test --test vm_live -- --ignored   # boots real VMs, needs KVM and the assets in ~/fcassets

## Benchmarks

Results, method and caveats are in [docs/capacity.md](docs/capacity.md); the optimisations other providers use are in [docs/tricks.md](docs/tricks.md). The final numbers come from `bench/final/run.sh` on an otherwise idle machine.

    cargo run --release --bin tenants -- --design oxroute --tenants 64 --minutes 6
    cargo run --release --bin tiers
