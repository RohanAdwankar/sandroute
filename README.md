# sandroute

A bash tool for coding agents that stays in-process until a command needs a real machine.

Most agent shell calls are `sed`, `grep`, `cat` and `git clone`. Those run in-process on a shared workspace with no container and no VM. When a command needs a real machine, such as a browser or a compiler, sandroute boots a microVM once and sends it there.

## How it routes

- The command line is parsed. Every command name in it is collected, including those inside `$(...)` and pipelines.
- If every name is known to the in-process shell, the line runs in-process.
- If any name is a browser, toolchain, network client or unknown binary, the whole line runs in the VM.
- Questions about the machine (`command -v`, `which`, `env`, `$PATH`) and any absolute path outside the workspace also go to the VM. The in-process shell would answer about itself, and a real model concluded "chromium is not installed" from exactly that.
- `git clone`, `init`, `add`, `commit`, `status` and `log` run in-process with no git binary. Other git subcommands go to the VM.
- The VM boots on the first command that needs it, and is handed back after `idleMs` with no VM-tier command. The next one that needs it restores a snapshot.

The in-process tier is [just-bash](https://github.com/vercel-labs/just-bash) with the workspace mounted at its real path, so absolute paths in agent commands resolve.

## Spin-down

The question is whether routing can hold latency parity with an agent running inside the
VM while cutting what the VM costs. Measured on the same turn, 20 tool calls, 500-file
workspace, real Firecracker:

| config | tool latency | p50 | turn | VM allocated |
|---|---|---|---|---|
| agent inside the VM (baseline) | 150ms | 5.4ms | 56253ms | 100% |
| sandroute, VM kept for the session | 746ms | 18ms | +1.1% | 67.8% |
| sandroute, 2000ms idle window | 965ms | 18ms | +1.4% | 14.7% |
| sandroute, 500ms idle window | 979ms | 29ms | +1.5% | 4.2% |

Per tool call routing is 6x slower; per turn that is 1.5%, because tool execution was
never what the turn was waiting on. Of the 829ms, spin-down is only 233ms -- the rest is
the in-process tier losing to native `grep -r`. On a 175s turn the saving holds (14.3%
allocated, turn +1.2%) while lazy boot alone decays from 32.2% saved to 10.4%.

    npm run bench:turn -- --idle 2000 --repeat 3

The reasoning and the rest of the measurements are in
[docs/in-turn-spin-down.md](docs/in-turn-spin-down.md).

Priming a snapshot costs a cold boot plus a `/snapshot/create`, about 2.5-4.4s. Do it ahead
of a session rather than on a user's first heavy command:

    SANDROUTE_FC_KERNEL=... SANDROUTE_FC_ROOTFS=... SANDROUTE_FC_SNAPSHOT_DIR=... \
      npm run prewarm -- /path/to/workspace

## Use with opencode

Copy `opencode/shared.ts` to `<project>/.opencode/shared.ts`, and `bash.ts`, `read.ts`,
`write.ts` and `edit.ts` to `<project>/.opencode/tool/`. Each has the same name as a
built-in, so it overrides it; the shared module sits outside `tool/` because opencode
registers everything in there as a tool. Opencode itself is unmodified.

The file tools matter as much as bash. Left alone they write straight to the host with
nothing holding them to the workspace, and a live agent reaches for them constantly --
in two recorded runs the agent created its main source file with `write`, so the sandbox
never saw it. Routed here they go through the same filesystem the in-process shell uses,
so a path outside the workspace resolves into an empty in-memory filesystem instead of
the host, and symlinks out are refused.

## Test

    npm test          # router and runtime unit tests
    npx tsx e2e/run.mts   # opencode driving the tool against a scripted model

    npx tsx e2e/live.mts  # same, with a real free-tier model (opencode/big-pickle, no key)

The e2e run uses a scripted OpenAI-compatible server in place of a real model, so the sequence of commands is fixed. It checks the routing, not model behaviour.

## Firecracker backend

`FirecrackerVm` starts a Firecracker microVM, talks to a guest agent (`guest/agent.py`) over vsock, and keeps the workspace in step: before each VM command it pushes files that changed on the host, and after it pulls files the command changed. The workspace sits at the same absolute path in the guest.

Select it in the opencode tool with `SANDROUTE_VM=firecracker`, `SANDROUTE_FC_KERNEL` (vmlinux) and `SANDROUTE_FC_ROOTFS` (ext4 with bash, python3 and the agent started at boot with `--vsock-port 5000 --workspace <path from the sandroute.workspace kernel arg>`). Also `SANDROUTE_FC_SNAPSHOT_DIR` to restore from a snapshot instead of cold booting, `SANDROUTE_IDLE_MS` to release the VM when idle, and `SANDROUTE_FC_CONSOLE` to see the guest console.

## Status

- Tested: the router, the in-process git, the guest agent protocol and the file sync (agent run as a plain process on a unix socket), and the Firecracker API call sequence.
- Booted for real on a host with KVM, against kernel 6.1.128 from Firecracker's CI bucket and a hand-built ext4 rootfs: cold boot to agent ready 773ms, snapshot restore 11ms, later VM commands ~10ms, and the sync moved files both ways. Firecracker appends `root=/dev/vda rw` itself, so the default boot args need nothing added.
- There is no per-command latency to win by staying out of the VM. `bash -c` in the guest measured 1.24ms against 1.16ms on the host, and the in-process tier is 1.2-2.5ms. The win is VM-allocated seconds, not latency.
- A snapshot is tied to one workspace path, because the guest agent's root arrives on the kernel command line and is baked into guest memory.
- The guest is meant to behave like any other machine that happens to be isolated from the
  host: it reaches the internet, installs what it needs, and cannot reach the host. Pass
  `network` to `FirecrackerVm` after running `scripts/net-setup.sh` once as root -- a tap
  device needs CAP_NET_ADMIN, so sandroute cannot create one for itself. Without it the guest
  has loopback only, and an agent that hits a missing tool has no way to go and get it.
  `npx tsx e2e/capabilities.mts` reports which of the two it is.
- The networked path is written but **unverified end to end**: the machine it was built on
  has no root and restricts unprivileged user namespaces, so no tap could be created to test
  against. What is covered is the config sandroute sends and the guest-side setup; what is not
  is a packet actually leaving.
- The rootfs image is not built by this repo yet.
- `FirecrackerVm` spawns firecracker with `stdio: "ignore"`, so there is no way to see the guest console when a boot goes wrong.
- Sync compares mtime and size and sends whole files, so a large workspace is slow to push, and spin-down makes that a recurring cost: a VM-tier no-op is 1.7ms at 10 files, 9.4ms at 500 and 48.6ms at 3000. Sharing the workspace into the guest with virtio-fs would remove it and leave the wake at the 11ms restore.
- `HostProcessVm` is the default and is not isolated.
- A command that fails in-process is not retried in the VM.
