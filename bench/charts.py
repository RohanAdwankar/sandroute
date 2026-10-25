# The three charts for the write-up, from the final run's raw results (bench/results/final/*/raw).
# Run: uv run --with matplotlib --with seaborn --with pandas bench/charts.py OUT_DIR
import glob, json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

# (label, series, tenants held: both seeds passed)
DESIGNS = [
    ("oxroute", "oxroute", 736),
    ("snapshot, released when idle", "suspend", 640),
    ("snapshot, kept up", "kept", 176),
    ("gVisor, deleted when idle", "gvisor-cold", 80),
    ("kill idle, cold boot", "fc-claude", 64),
    ("cold boot, kept up", "fc-vanilla", 48),
    ("Kata", "kata", 40),
    ("Cloud Hypervisor, 8 GiB", "ch-muse", 16),
]
LADDER = [("kept up", 48), ("kill idle", 64), ("snapshot", 176), ("release and discard", 640), ("oxroute", 736)]
# the look of the demo GIFs: near-black background, light text, monospace, blue for the light sandbox and orange for a VM
BG, INK, MUTED, GRID, BLUE, ORANGE, BAR = "#161614", "#e8e8e3", "#8c8b86", "#3a3a36", "#2a78d6", "#d9772b", "#55544f"
sns.set_theme(style="whitegrid", context="notebook", rc={
    "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG, "axes.edgecolor": GRID, "grid.color": GRID,
    "text.color": INK, "axes.titlecolor": INK, "axes.labelcolor": MUTED, "xtick.color": MUTED, "ytick.color": INK,
    "font.family": "monospace", "font.monospace": ["DejaVu Sans Mono"], "patch.edgecolor": BG, "legend.facecolor": BG, "legend.edgecolor": GRID, "legend.labelcolor": INK})
out = sys.argv[1]

def latency(series, n):
    fs = sorted(glob.glob(f"bench/results/final/*/raw/{series}-n{n}-s*.json"))
    fs = [f for f in fs if f.split("/")[3] == fs[-1].split("/")[3]]  # the newest run that has it
    rs = [json.load(open(f))["latencyMs"] for f in fs]
    return {k: sum(r[k] for r in rs) / len(rs) for k in ("p50", "p95", "p99")}

def bars(ax, order, values, colors):
    sns.barplot(x=values, y=order, hue=order, palette=colors, legend=False, ax=ax)
    for c in ax.containers:
        ax.bar_label(c, padding=3)
    ax.set_xlabel("tenants"); ax.set_ylabel("")
    sns.despine(left=True, bottom=True)

# capacity
fig, ax = plt.subplots(figsize=(8, 4))
labels = [d[0] for d in DESIGNS]
bars(ax, labels, [d[2] for d in DESIGNS], {l: BLUE if l == "oxroute" else BAR for l in labels})
ax.set_title("Tenants held at p99 added latency under 1.5 s")
fig.tight_layout(); fig.savefig(f"{out}/virt-capacity.png", dpi=160); plt.close(fig)

# ladder
fig, ax = plt.subplots(figsize=(8, 3.6))
names = [f"{i + 1}. {s[0]}" for i, s in enumerate(LADDER)]
bars(ax, names, [s[1] for s in LADDER], {l: BLUE if l.endswith("oxroute") else BAR for l in names})
ax.set_title("Tenants held after each step")
fig.tight_layout(); fig.savefig(f"{out}/virt-ladder.png", dpi=160); plt.close(fig)

# latency
rows = [{"design": label, "percentile": k, "ms": v} for label, series, n in DESIGNS for k, v in latency(series, n).items()]
fig, ax = plt.subplots(figsize=(9, 4.6))
sns.barplot(data=pd.DataFrame(rows), x="design", y="ms", hue="percentile", palette=["#24466f", BLUE, "#8cb9f2"], ax=ax)
ax.set_yscale("log"); ax.axhline(1500, color=ORANGE, linestyle="--", linewidth=1.2, label="1.5 s target")
ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), title="percentile")
ax.set_xlabel(""); ax.set_ylabel("added latency (ms)")
ax.set_title("Latency added to a call, at each design's limit")
plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
sns.despine(); fig.tight_layout(); fig.savefig(f"{out}/virt-latency.png", dpi=160, bbox_inches="tight"); plt.close(fig)
