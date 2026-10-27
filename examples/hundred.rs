//! The same job as the E2B example of starting a hundred sandboxes at once, each writing a file and reading it back.
//!   cargo run --release --example hundred [count] [vm]
//! Reading the file back with `cat` runs in the light sandbox; with `vm` it runs in a microVM, as every command does in E2B.
use sandroute::Sandroute;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

async fn run_single_sandbox(idx: usize, vm: bool) -> anyhow::Result<()> {
    // Create an isolated sandbox
    let sandbox = Sandroute::create_with(1, 256).await?; // 1 vCPU and 256 MiB for the VM
    let random = format!("{idx}-{:x}", SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos());

    // Write a file inside the sandbox
    sandbox.write_file("random.txt", &random).await?;

    // Read it back with a command
    let res = sandbox.run(if vm { "python3 -c 'print(open(\"random.txt\").read())'" } else { "cat random.txt" }, None).await?;
    println!("Sandbox {idx}: {}", res.stdout.trim());
    sandbox.close().await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let count = std::env::args().nth(1).map_or(100, |n| n.parse().unwrap());
    let vm = std::env::args().nth(2).is_some_and(|a| a == "vm");
    let start = Instant::now();
    // Spin up the sandboxes simultaneously
    let tasks: Vec<_> = (0..count).map(|i| tokio::spawn(run_single_sandbox(i, vm))).collect();
    for t in tasks {
        t.await??;
    }
    eprintln!("{count} sandboxes in {:.1} s", start.elapsed().as_secs_f64());
    Ok(())
}
