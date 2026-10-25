# sandroute

[![736 tenants on a 7 GiB laptop](docs/videos/timelapse-736.gif)](docs/videos/timelapse-736.mp4)

*736 agent tenants on one 7 GiB laptop, replayed from real sessions at 8x. Each tile is a sandbox, blue ran in the light sandbox and orange in a microVM. Click for the full-quality video.*

Sandroute is a sandbox for AI coding agents that serves many more tenants per machine than a microVM each. Commands that only touch files run in a locked-down light sandbox, and anything else runs in a Firecracker microVM that is restored from one shared snapshot, started only when a command needs it, and thrown away when it goes idle. On a 7 GiB laptop that holds 736 mostly idle agent tenants, where a plain microVM per tenant holds 48.

## Try it

You need an x86_64 Linux machine with KVM (any recent laptop or cloud VM that allows nested virtualization). The commands are for Debian or Ubuntu.

**1. Install the tools.**

```sh
sudo apt install bubblewrap e2fsprogs python3 curl git build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh        # Rust, then open a new shell
sudo usermod -aG kvm $USER                                              # access to /dev/kvm, then log out and in
```

**2. Get sandroute and build it.** `scripts/setup.sh` downloads Firecracker and a guest kernel and builds the VM image into `~/fcassets` (set `SANDROUTE_ASSETS` to put it elsewhere).

```sh
git clone https://github.com/RohanAdwankar/sandroute && cd sandroute
scripts/setup.sh
cargo build --release --examples --bins
```

**3. Start a sandbox from code.** This is `examples/quickstart.rs`; run it with `target/release/examples/quickstart`, or use sandroute from your own project with `sandroute = { git = "https://github.com/RohanAdwankar/sandroute" }`, `tokio` (features `full`) and `anyhow`.

```rust
use sandroute::Sandroute;

let sandbox = Sandroute::create().await?;                    // a fresh, isolated sandbox
sandbox.write_file("hello.py", "print('hi')").await?;        // files live in /work
let res = sandbox.run("python3 hello.py", None).await?;      // runs in a microVM, started on demand
println!("{} (exit {}, ran in {:?})", res.stdout.trim(), res.exit_code, res.tier);
let res = sandbox.run("cat hello.py", None).await?;          // only touches files: the light sandbox, no VM
sandbox.close().await?;                                      // stops the VM, deletes the workspace
```

```
hi (exit 0, ran in Vm)
print('hi') (exit 0, ran in Light)
```

**4. Give a coding agent a sandbox.** `sandroute-mcp` is an [MCP](https://modelcontextprotocol.io) server that gives an agent the six tools coding agents use (bash, read, write, edit, glob, grep), all running in a sandbox over the current directory. With [opencode](https://opencode.ai):

```sh
npm i -g opencode-ai          # or: curl -fsSL https://opencode.ai/install | bash
cd ~/my-project
cat > opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": { "sandroute": { "type": "local", "command": ["/path/to/sandroute/target/release/sandroute-mcp"] } },
  "tools": { "bash": false, "read": false, "write": false, "edit": false, "glob": false, "grep": false }
}
EOF
opencode mcp list             # sandroute: connected
opencode                      # the agent now works in /work, in the sandbox, and your project files change as it edits
```

The `tools` block turns off opencode's own tools, so every command and every file edit goes through the sandbox. Files the agent writes appear in your project directory; anything it installs or runs stays inside.

**5. Start a lot of sandboxes.** The usual way to show a sandbox API is to start a hundred at once, each writing a file and reading it back. Here is that job in sandroute (`examples/hundred.rs`):

```rust
async fn run_single_sandbox(idx: usize) -> anyhow::Result<()> {
    // Create an isolated sandbox
    let sandbox = Sandroute::create().await?;
    let random = format!("{idx}-{:x}", SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos());

    // Write a file inside the sandbox
    sandbox.write_file("random.txt", &random).await?;

    // Read it back with a command
    let res = sandbox.run("cat random.txt", None).await?;
    println!("Sandbox {idx}: {}", res.stdout.trim());
    sandbox.close().await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Spin up the sandboxes simultaneously
    let tasks: Vec<_> = (0..100).map(|i| tokio::spawn(run_single_sandbox(i))).collect();
    for t in tasks { t.await??; }
    Ok(())
}
```

And the same job in [microsandbox](https://github.com/superradcompany/microsandbox), another local microVM runtime (`bench/compare/microsandbox_hundred.py`), which starts a microVM per sandbox:

```python
async def run_single_sandbox(idx: int):
    # Spin up an isolated microVM asynchronously
    name = f"bench-{idx}-{uuid.uuid4().hex[:6]}"
    sandbox = await Sandbox.create(name, image="python", cpus=1, memory=256)
    try:
        random_str = uuid.uuid4().hex

        # Write file inside sandbox
        await sandbox.fs.write("/tmp/random.txt", random_str.encode())

        # Read or verify back
        res = await sandbox.exec("cat", ["/tmp/random.txt"])
        print(f"Sandbox {idx} ({name}): {res.stdout_text.strip()}")
    finally:
        await sandbox.stop_and_wait()
        await Sandbox.remove(name)

async def main():
    # Spin up 100 sandboxes simultaneously
    await asyncio.gather(*[run_single_sandbox(i) for i in range(100)])
```

Run them yourself:

```sh
target/release/examples/hundred 100        # sandroute: the read is a file command, so it runs in the light sandbox
target/release/examples/hundred 100 vm     # sandroute: the read runs in a microVM (python3 instead of cat)
target/release/examples/hundred 700 vm     # sandroute: 700 microVMs
uv run bench/compare/microsandbox_hundred.py 100    # microsandbox
```

On a 7 GiB laptop:

| | sandboxes | the read runs in | time | host memory used |
|---|---|---|---|---|
| sandroute | 100 | the light sandbox (`cat`) | 0.8 s | 23 MiB |
| sandroute | 100 | a microVM (`python3`) | 2.0 s | 242 MiB |
| microsandbox | 100 | a microVM (`cat`) | 8.6 s | 4.6 GiB |
| sandroute | 700 | a microVM (`python3`) | 18.5 s | 3.1 GiB |
| microsandbox | 130 | a microVM (`cat`) | out of memory, stopped | |

Past a hundred the difference shows. Both started with 130 sandboxes at once, recorded side by side:

[![130 sandboxes at once: microsandbox and sandroute](docs/videos/exhaustion-130.gif)](docs/videos/exhaustion-130.mp4)

*Microsandbox boots all 130 microVMs together, memory climbs to the limit before most have finished, and the run is stopped with 34 done. Sandroute finishes all 130 in 3.4 s.*

## The SDK

`Sandroute` is one sandbox. Everything is async (tokio) and returns `anyhow::Result`.

| | |
|---|---|
| `Sandroute::create()` | a sandbox with a fresh, empty workspace |
| `Sandroute::open(dir)` | a sandbox over an existing directory; the files appear at `/work`, and what the sandbox changes lands in `dir` |
| `run(command, cwd)` | run a shell command, returns a `RunResult` |
| `read_file`, `write_file`, `edit_file`, `glob`, `grep_files` | the file tools; they run in the light sandbox, never in a VM |
| `prewarm()` | start the VM now, when you know the next command will need one |
| `release()` | hand the VM back now instead of waiting for it to go idle |
| `close()` | stop everything and delete what `create` made; `open` never deletes your directory |

`RunResult` has `stdout`, `stderr`, `exit_code`, `tier` (`Tier::Light`, the light sandbox, or `Tier::Vm`), `reason` (why that tier), `booted` (this command started the VM) and `ms`.

**What decides where a command runs.** The command line is parsed. If every command in it is a file utility (`ls`, `cat`, `grep`, `sed`, `find` and the like) and it stays inside the workspace, it runs in the light sandbox: a fresh set of namespaces and a seccomp filter around the command, about 6 ms, no VM. Anything else (an interpreter, a compiler, `git`, a network client, `which`, a path outside the workspace) runs in a microVM. You never choose; `res.tier` and `res.reason` tell you what happened.

**The VM's life.** The first command that needs a VM starts one by restoring a snapshot taken once at setup, which takes tens of milliseconds and holds only the pages it touches (about 27 MiB). After five idle seconds the VM is released: killed if the guest holds nothing outside the workspace and `/tmp`, or snapshotted to disk if it does (a `pip install`, say). The next command that needs a VM restores it. The workspace is kept in step both ways around every VM command, so the light sandbox and the VM always see the same files.

**Isolation.** Every sandbox is its own microVM or its own set of namespaces with a seccomp filter (the Docker default profile's 299 system calls), so tenants cannot see each other or the host. The light sandbox has no network. Whether the guest has a network is set when the VM is built (`scripts/net-setup.sh`).

**More control.** `Sandroute::new(SandrouteOptions { .. })` takes your own VM backend (`MicroVm` with `VmOptions` for Firecracker or Cloud Hypervisor, or `CriVm` for Kata and gVisor), memory and vCPU sizes, the idle window, and the workspace path. The benchmarks in `src/bin/` are built on it.

## Benchmarks

How many tenants one machine serves, replaying 26 recorded agent sessions, is in [docs/capacity.md](docs/capacity.md); the tricks other providers use are in [docs/tricks.md](docs/tricks.md).

| design on a 7 GiB laptop | tenants held (p99 added latency under 1.5 s) |
|---|---|
| sandroute | 736 |
| microVM per tenant, restored from a shared snapshot, released when idle | 640 |
| the same, kept up | 176 |
| kill idle VMs and cold boot | 64 |
| microVM per tenant, cold booted, kept up | 48 |
| Kata Containers | 40 |

```sh
target/release/tenants --design oxroute --tenants 64 --minutes 6    # the capacity benchmark
target/release/tiers                                                  # what one command costs in each tier
uv run --with matplotlib --with seaborn --with pandas bench/charts.py out/   # the charts
bench/final/go.sh                                                     # the full run, about 4 hours, on an idle machine
```

## Test

```sh
cargo test                                # the router, sandbox, sync, orchestrator and a corpus of recorded commands
cargo test --test vm_live -- --ignored    # boots real VMs, needs KVM and the setup above
```
