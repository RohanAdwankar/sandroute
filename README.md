# sandroute

A bash tool for coding agents that stays in-process until a command needs a real machine.

Most agent shell calls are `sed`, `grep`, `cat` and `git clone`. Those run in-process on a shared workspace with no container and no VM. When a command needs a real machine, such as a browser or a compiler, sandroute boots a microVM once and sends it there.

## How it routes

- The command line is parsed. Every command name in it is collected, including those inside `$(...)` and pipelines.
- If every name is known to the in-process shell, the line runs in-process.
- If any name is a browser, toolchain, network client or unknown binary, the whole line runs in the VM.
- Questions about the machine (`command -v`, `which`, `env`, `$PATH`) and any absolute path outside the workspace also go to the VM. The in-process shell would answer about itself, and a real model concluded "chromium is not installed" from exactly that.
- `git clone`, `init`, `add`, `commit`, `status` and `log` run in-process with no git binary. Other git subcommands go to the VM.
- The VM boots on the first command that needs it and stays up.

The in-process tier is [just-bash](https://github.com/vercel-labs/just-bash) with the workspace mounted at its real path, so absolute paths in agent commands resolve.

## Use with opencode

Copy `opencode/bash.ts` to `<project>/.opencode/tool/bash.ts`. It has the same name as the built-in, so it overrides it. Opencode itself is unmodified.

## Test

    npm test          # router and runtime unit tests
    npx tsx e2e/run.mts   # opencode driving the tool against a scripted model

    npx tsx e2e/live.mts  # same, with a real free-tier model (opencode/big-pickle, no key)

The e2e run uses a scripted OpenAI-compatible server in place of a real model, so the sequence of commands is fixed. It checks the routing, not model behaviour.

## Firecracker backend

`FirecrackerVm` starts a Firecracker microVM, talks to a guest agent (`guest/agent.py`) over vsock, and keeps the workspace in step: before each VM command it pushes files that changed on the host, and after it pulls files the command changed. The workspace sits at the same absolute path in the guest.

Select it in the opencode tool with `SANDROUTE_VM=firecracker`, `SANDROUTE_FC_KERNEL` (vmlinux) and `SANDROUTE_FC_ROOTFS` (ext4 with bash, python3 and the agent started at boot with `--vsock-port 5000 --workspace <path from the sandroute.workspace kernel arg>`).

## Status

- Tested: the router, the in-process git, the guest agent protocol and the file sync (agent run as a plain process on a unix socket), and the Firecracker API call sequence.
- Not tested: booting a real microVM. It needs KVM, which the development machine lacked. The vsock handshake and the boot sequence follow Firecracker's documented API and have never run.
- The rootfs image is not built by this repo yet, and the guest has no network, so `npm install` or `apt` in the VM cannot reach the internet.
- Sync compares mtime and size and sends whole files, so a large workspace is slow to push.
- `HostProcessVm` is the default and is not isolated.
- A command that fails in-process is not retried in the VM.
