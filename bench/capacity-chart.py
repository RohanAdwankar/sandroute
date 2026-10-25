# The capacity chart for the write-up. Run: uv run --with matplotlib bench/capacity-chart.py OUT.png
# Values are from the final run (bench/results/final/*/summary.tsv, two seeds). The bar is the highest tenant count where both
# seeds passed, the diamond the highest where any single run passed. The limit lies between the bar and the next count tried.
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# (label, both seeds passed, best single pass)
rows = [
    ("oxroute", 736, 736),
    ("Firecracker, snapshot on idle", 640, 640),
    ("Firecracker, kept up", 176, 176),
    ("gVisor, pod deleted when idle", 80, 112),
    ("Claude Code style: kill idle, cold boot", 64, 64),
    ("Firecracker, cold boot, kept up", 48, 48),
    ("Kata, pod kept up", 40, 40),
    ("Muse style: Cloud Hypervisor, 8 GiB", 16, 16),
]
ACCENT, GRAY, INK, MUTED = "#2a78d6", "#b9b8b0", "#0b0b0b", "#52514e"
fig, ax = plt.subplots(figsize=(9, 4.6), dpi=160)
fig.patch.set_facecolor("#fcfcfb"); ax.set_facecolor("#fcfcfb")
ys = list(range(len(rows)))[::-1]
for y, (label, conf, best) in zip(ys, rows):
    ax.barh(y, conf, height=0.55, color=ACCENT if label == "oxroute" else GRAY)
    if best > conf:
        ax.plot([best], [y], marker="D", markersize=6, color=INK, markeredgecolor="#fcfcfb", markeredgewidth=1.5, linestyle="none")
    ax.text(max(conf, best) + 9, y, f"{conf}", va="center", fontsize=10, color=INK)
ax.set_yticks(ys); ax.set_yticklabels([r[0] for r in rows], fontsize=10, color=INK)
ax.tick_params(axis="y", length=0); ax.tick_params(axis="x", colors=MUTED, labelsize=9)
ax.set_xlim(0, 820)
ax.xaxis.grid(True, color="#e6e5df", linewidth=0.8); ax.set_axisbelow(True)
for side in ("top", "right", "left", "bottom"): ax.spines[side].set_visible(False)
fig.text(0.02, 0.95, "Tenants one 7 GiB machine serves", fontsize=13, fontweight="bold", color=INK, ha="left")
fig.text(0.02, 0.905, "with p99 added latency under 1.5 s, replaying real agent sessions where tenants are mostly idle", fontsize=9.5, color=MUTED, ha="left")
fig.text(0.02, 0.025, "Final run on an idle machine, two seeds. Bar: highest count where both seeds passed. Diamond: highest where any single run passed.\nThe limit lies between the bar and the next count tried. Kata was not tried between 40 and 56.",
         fontsize=8, color=MUTED, ha="left", va="bottom")
fig.subplots_adjust(left=0.36, right=0.97, top=0.85, bottom=0.2)
fig.savefig(sys.argv[1])
