# Architecture

One tool call in, routed either to a bash interpreter running in-process or to a Firecracker
microVM that is handed back when idle.

```mermaid
flowchart TB
  subgraph HOST["one host process (opencode / bun) — today this process is the entire trust boundary"]
    direction TB
    AG["opencode agent"] --> TOOL["bash tool override<br/><code>opencode/tool/bash.ts</code>"]
    TOOL --> SR["<code>Sandroute.run()</code>"]
    SR --> CL{"<code>classify()</code><br/>src/router.ts"}

    CL -->|"all names known<br/>to just-bash"| IP
    CL -->|"browser · toolchain · unknown binary<br/>machine questions · outside paths"| VM

    subgraph IP["in-process tier — just-bash"]
      direction TB
      BASH["a bash interpreter in JS<br/>no fork, no exec, no VM"]
      MF["MountableFs<br/>base: InMemoryFs — outside the workspace<br/>resolves here, and it is empty<br/>mount: workspace → ReadWriteFs(root)<br/>symlinks blocked, realpath-checked, fail-closed"]
      GIT["git clone/init/add/commit/status/log<br/>via isomorphic-git"]
      BASH --- MF --- GIT
    end

    subgraph VM["VM tier — VmBackend"]
      direction TB
      IDLE["idle timer → release() → vm.stop()<br/>counts vmAllocatedMs"]
      AC["AgentClient — the host owns the workspace,<br/>so every VM command reconciles it<br/>pushChanges: manifest diff on mtime:size<br/>exec: changed[] / deleted[] pulled back"]
      BOOT["boot(): snapshot present → /snapshot/load (16ms)<br/>otherwise → cold boot, then prime one (1016+1480ms)"]
      IDLE --- AC --- BOOT
    end
  end

  subgraph HOSTFS["host, outside the process"]
    direction LR
    WS["workspace on host disk<br/><i>the authoritative copy</i>"]
    SNAP["snapshot cache<br/>sha256(ws).state / .mem<br/><i>a pristine guest: booted,<br/>agent listening, workspace empty</i>"]
    FC["firecracker process, one per VM<br/>cwd = per-VM tmpdir<br/>uds_path &quot;v.sock&quot; — relative, so<br/>restored VMs don't collide"]
    RO["rootfs.ext4 — read-only<br/><i>one image shared by every VM;<br/>writable + snapshots corrupts ext4</i>"]
    SNAP --> FC
    RO --> FC
  end

  subgraph GUEST["guest microVM — kernel 6.1.128, 2 vCPU, 1 GiB — killed on release, restored pristine"]
    direction LR
    INIT["/sbin/init (PID 1)<br/>tmpfs → /overlay<br/>overlayfs lower=/ (ro image), upper=tmpfs<br/>chroot → python3 /agent.py<br/><i>writable root entirely in RAM</i>"]
    GWS["workspace on tmpfs<br/><i>same absolute path as the host,<br/>so absolute paths resolve.<br/>dies with the VM</i>"]
    AP["agent.py on vsock:5000<br/>one JSON object per line<br/>ping · sync · exec<br/><i>walks the tree before and after<br/>exec to find what changed</i>"]
    INIT --> AP
    AP --- GWS
  end

  IP -->|"reads / writes directly"| WS
  VM -->|"spawn + HTTP on api.sock"| FC
  VM -.->|"vsock on the host UDS:<br/>connect, send CONNECT 5000, expect OK"| AP
  WS <-.->|"sync push / pull"| GWS
```

Measured on one bare-metal KVM host. Turn latency against an agent running inside the VM:
**+1.4%**. VM allocated: **100% → 4.2%** at a 500ms idle window.

## Routing rules

| command shape | tier | why |
|---|---|---|
| every name known to just-bash | in-process | nothing needs a machine |
| browser, toolchain, network client, unknown binary | VM | just-bash cannot run it |
| `command -v`, `which`, `env`, `$PATH` | VM | the in-process shell would answer about itself |
| absolute path outside the workspace | VM | only the VM can see it |
| `git clone/init/add/commit/status/log` | in-process | isomorphic-git, no git binary |
| any other `git` subcommand | VM | not implemented in-process |

## Invariants

- **The host owns the workspace.** The guest copy is pushed in on every VM command and dies
  with the VM, which is what makes the guest disposable and the snapshot reusable.
- **Never hand a live VM to a second tenant.** Pooling is only safe as kill-and-restore from
  the pristine snapshot; the read-only image means there is no persistence path either way.
- **The rootfs is never written.** A writable root drive cannot be shared by concurrent VMs,
  and restoring a snapshot over a backing file a later VM has written corrupts the filesystem.
