# The optimisation ladder: tenants held after each step, and the factor each step gave. Final-run numbers (two seeds, both passed).
# Run: uv run --with matplotlib bench/ladder-chart.py OUT.png
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

steps = [
    ("1. A VM per tenant, kept up", 48),
    ("2. Kill idle VMs, cold boot on the next command", 64),
    ("3. Boot once, restore every VM from one snapshot, kept up", 176),
    ("4. Release idle VMs, discard the ones that hold nothing", 640),
    ("5. Run file commands in a light sandbox instead (oxroute)", 736),
]
ACCENT, GRAY, INK, MUTED = "#2a78d6", "#b9b8b0", "#0b0b0b", "#52514e"
fig, ax = plt.subplots(figsize=(9.5, 4.4), dpi=160)
fig.patch.set_facecolor("#fcfcfb"); ax.set_facecolor("#fcfcfb")
ys = list(range(len(steps)))[::-1]
prev = None
for y, (label, n) in zip(ys, steps):
    ax.barh(y, n, height=0.55, color=ACCENT if n == steps[-1][1] else GRAY)
    note = f"{n}" + (f"   x{n / prev:.1f}" if prev else "")
    ax.text(n + 10, y, note, va="center", fontsize=10, color=INK)
    prev = n
ax.set_yticks(ys); ax.set_yticklabels([s[0] for s in steps], fontsize=9.5, color=INK)
ax.tick_params(axis="y", length=0); ax.tick_params(axis="x", colors=MUTED, labelsize=9)
ax.set_xlim(0, 860)
ax.xaxis.grid(True, color="#e6e5df", linewidth=0.8); ax.set_axisbelow(True)
for side in ("top", "right", "left", "bottom"): ax.spines[side].set_visible(False)
fig.text(0.02, 0.95, "Each step, and what it bought", fontsize=13, fontweight="bold", color=INK, ha="left")
fig.text(0.02, 0.905, "tenants one 7 GiB machine serves with p99 added latency under 1.5 s, replaying real agent sessions", fontsize=9.5, color=MUTED, ha="left")
fig.text(0.02, 0.025, "Final run on an idle machine, two seeds; a design holds N tenants if both seeds passed at N.", fontsize=8, color=MUTED, ha="left", va="bottom")
fig.subplots_adjust(left=0.50, right=0.97, top=0.85, bottom=0.14)
fig.savefig(sys.argv[1])
