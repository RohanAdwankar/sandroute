// Summarise bench/results into one table per design, so the designs can be read side by side.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "results");
const rs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
const only = process.argv[2];
const rows = rs.filter((r) => !only || r.design === only).sort((a, b) => a.design.localeCompare(b.design) || a.windowMs - b.windowMs || a.tenants - b.tenants);
const cols = ["design", "tenants", "window", "duty", "calls", "p50", "p95", "p99", "VMs", "VM MiB", "disk GiB", "cpu avg/peak", "iowait", "wake/susp", "result"];
const line = (c: (string | number)[]) => console.log(c.map((v, i) => String(v).padStart(i === 0 ? 8 : i === 14 ? 0 : 7)).join("  "));
line(cols);
for (const r of rows) {
  line([r.design, r.tenants, r.design === "kept" ? "-" : r.windowMs / 1000 + "s", Math.round(r.observedDutyCycle * 100) + "%", r.calls,
    r.latencyMs.p50, r.latencyMs.p95, r.latencyMs.p99, r.peak.microVMs, r.peak.vmPssMiB, r.peak.sessionsGiB,
    `${r.mean.cpuBusy}/${r.peak.cpuBusy}%`, r.peak.iowait + "%", `${r.wakes}/${r.suspends}`,
    r.aborted ? `ABORTED ${r.aborted}` : r.slo.met ? "met" : `missed${r.errors ? ` (${r.errors} err)` : ""}`]);
}
