//! Summarise bench/results into one table, so the designs can be read side by side.
//!
//!   cargo run --release --bin report [design]
use serde_json::Value;

fn main() -> anyhow::Result<()> {
    let only = std::env::args().nth(1);
    let mut rs: Vec<Value> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/results"))?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok())
        .filter(|r: &Value| only.as_deref().is_none_or(|d| r["design"] == d))
        .collect();
    rs.sort_by(|a, b| (a["design"].as_str(), a["windowMs"].as_u64(), a["tenants"].as_u64()).cmp(&(b["design"].as_str(), b["windowMs"].as_u64(), b["tenants"].as_u64())));
    let cols = ["design", "tenants", "window", "duty", "calls", "p50", "p95", "p99", "VMs", "VM MiB", "disk GiB", "cpu avg/peak", "iowait", "wake/susp", "result"];
    let line = |c: Vec<String>| println!("{}", c.iter().enumerate().map(|(i, v)| format!("{v:>w$}", w = if i == 0 { 8 } else if i == 14 { 0 } else { 7 })).collect::<Vec<_>>().join("  "));
    line(cols.iter().map(|s| s.to_string()).collect());
    for r in rs {
        let s = |v: &Value| v.to_string().trim_matches('"').to_string();
        line(vec![s(&r["design"]), s(&r["tenants"]), if r["design"] == "kept" { "-".into() } else { format!("{}s", r["windowMs"].as_f64().unwrap_or(0.0) / 1000.0) },
            format!("{}%", (r["observedDutyCycle"].as_f64().unwrap_or(0.0) * 100.0).round()), s(&r["calls"]), s(&r["latencyMs"]["p50"]), s(&r["latencyMs"]["p95"]), s(&r["latencyMs"]["p99"]),
            s(&r["peak"]["microVMs"]), s(&r["peak"]["vmPssMiB"]), s(&r["peak"]["sessionsGiB"]), format!("{}/{}%", r["mean"]["cpuBusy"], r["peak"]["cpuBusy"]), format!("{}%", r["peak"]["iowait"]),
            format!("{}/{}", r["wakes"], r["suspends"]),
            if r["aborted"].is_string() { format!("ABORTED {}", s(&r["aborted"])) } else if r["slo"]["met"] == true { "met".into() } else { format!("missed{}", r["errors"].as_u64().filter(|e| *e > 0).map(|e| format!(" ({e} err)")).unwrap_or_default()) }]);
    }
    Ok(())
}
