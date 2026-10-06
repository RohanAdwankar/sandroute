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

## Status

- The VM tier is an interface. The only backend so far is `HostProcessVm`, a stand-in that runs host processes and is not isolated. A Firecracker backend needs KVM and has not been written.
- Once a VM is up, files written in-process are visible to it only because the stand-in shares the host disk. A real microVM needs a sync step.
- A command that fails in-process is not retried in the VM.
