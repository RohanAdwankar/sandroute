//! The snippet from the README: a sandbox, a file, a command in a microVM, a command in the light sandbox.
//!   cargo run --release --example quickstart
use sandroute::Sandroute;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let sandbox = Sandroute::create().await?;                    // a fresh, isolated sandbox: 1 vCPU, 256 MiB (create_with sets both)
    sandbox.write_file("hello.py", "print('hi')").await?;        // files live in /work
    let res = sandbox.run("python3 hello.py", None).await?;      // runs in a microVM, started on demand
    println!("{} (exit {}, ran in {:?})", res.stdout.trim(), res.exit_code, res.tier);
    let res = sandbox.run("cat hello.py", None).await?;          // only touches files: the light sandbox, no VM
    println!("{} (exit {}, ran in {:?})", res.stdout.trim(), res.exit_code, res.tier);
    sandbox.close().await?;                                      // stops the VM, deletes the workspace
    Ok(())
}
