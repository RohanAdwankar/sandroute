# Latency added to a call, per design, at the highest tenant count where both seeds passed.
# Run: uv run --with matplotlib bench/latency-chart.py OUT.png
# Reads bench/results/final/*/raw. Each row is p50, p95 and p99 (mean of the two seeds) joined by a line; the dashed line is the 1.5 s target.
import glob, json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# (label, series name in the raw file names, tenants)
rows = [
    ("oxroute", "oxroute", 736),
    ("Firecracker, snapshot on idle", "suspend", 640),
    ("Firecracker, kept up", "kept", 176),
    ("gVisor, pod deleted when idle", "gvisor-cold", 80),
    ("Claude Code style: kill idle, cold boot", "fc-claude", 64),
    ("Firecracker, cold boot, kept up", "fc-vanilla", 48),
    ("Kata, pod kept up", "kata", 40),
    ("Muse style: Cloud Hypervisor, 8 GiB", "ch-muse", 16),
]
def load(series, n):
    fs = sorted(glob.glob(f"bench/results/final/*/raw/{series}-n{n}-s*.json"))
    fs = [f for f in fs if f.split("/")[3] == fs[-1].split("/")[3]]  # the newest run that has it
    assert len(fs) == 2, (series, n, fs)
    rs = [json.load(open(f))["latencyMs"] for f in fs]
    return [sum(r[k] for r in rs) / 2 for k in ("p50", "p95", "p99")]
ACCENT, INK, MUTED = "#2a78d6", "#0b0b0b", "#52514e"
SHADES = ["#a9c9f0", "#5b97dd", "#1c5aa8"]  # p50, p95, p99: one hue, light to dark
fig, ax = plt.subplots(figsize=(9.5, 4.8), dpi=160)
fig.patch.set_facecolor("#fcfcfb"); ax.set_facecolor("#fcfcfb")
ys = list(range(len(rows)))[::-1]
for y, (label, series, n) in zip(ys, rows):
    v = [max(x, 2.5) for x in load(series, n)]
    ax.plot([v[0], v[2]], [y, y], color="#d6d5cf", linewidth=2, zorder=1, solid_capstyle="round")
    for x, c in zip(v, SHADES):
        ax.plot([x], [y], marker="o", markersize=8, color=c, markeredgecolor="#fcfcfb", markeredgewidth=1.5, linestyle="none", zorder=3)
    ax.text(v[2] * 1.25, y, f"p99 {v[2]:.0f} ms", va="center", fontsize=9, color=INK, zorder=4, bbox=dict(facecolor="#fcfcfb", edgecolor="none", pad=1.5))
ax.axvline(1500, color=MUTED, linestyle=(0, (4, 3)), linewidth=1)
ax.text(1500, len(rows) - 0.35, "target 1.5 s", ha="center", va="bottom", fontsize=8.5, color=MUTED)
ax.set_xscale("log"); ax.set_xlim(2, 6000)
ax.set_xticks([10, 100, 1000]); ax.set_xticklabels(["10 ms", "100 ms", "1 s"])
ax.set_yticks(ys); ax.set_yticklabels([f"{r[0]} ({r[2]})" for r in rows], fontsize=9.5, color=INK)
ax.tick_params(axis="y", length=0); ax.tick_params(axis="x", colors=MUTED, labelsize=9)
ax.xaxis.grid(True, color="#e6e5df", linewidth=0.8); ax.set_axisbelow(True)
for side in ("top", "right", "left", "bottom"): ax.spines[side].set_visible(False)
for i, (name, c) in enumerate(zip(("p50", "p95", "p99"), SHADES)):
    ax.plot([], [], marker="o", markersize=8, color=c, linestyle="none", label=name)
ax.legend(loc="upper center", frameon=False, fontsize=9, ncol=3, handletextpad=0.2, columnspacing=1.5, bbox_to_anchor=(0.5, -0.07))
fig.text(0.02, 0.95, "Latency added to a call, at each design's limit", fontsize=13, fontweight="bold", color=INK, ha="left")
fig.text(0.02, 0.905, "tenant count in brackets; added latency is a call's time less the same call's time with one tenant on the machine", fontsize=9.5, color=MUTED, ha="left")
fig.text(0.02, 0.025, "Final run on an idle machine; each point is the mean of two seeds at the highest tenant count where both seeds passed.", fontsize=8, color=MUTED, ha="left", va="bottom")
fig.subplots_adjust(left=0.38, right=0.97, top=0.85, bottom=0.2)
fig.savefig(sys.argv[1])
