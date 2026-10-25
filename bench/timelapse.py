# Renders a timelapse video of a run from its event log. Left: two large terminals, each following one active tenant. Middle: one tile per
# active tenant, in a grid that steps up and down in size with how many there are (blue: the last call ran in the light sandbox, orange:
# in a VM, outlined: it woke a VM). Right: cpu, memory, and counts so far.
# Run: uv run --with matplotlib --with numpy bench/timelapse.py RUN.events.jsonl OUT.mp4 [speed]
import json, math, subprocess, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

src, out = sys.argv[1], sys.argv[2]
SPEED, FPS = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0, 15
STEPS = [6, 12, 24, 48, 96, 192, 384, 768, 1536]  # tile counts the grid steps through
LIGHT, VM, INK, MUTED, BG, PANE, GRID = "#2a78d6", "#d9772b", "#e8e8e3", "#8c8b86", "#161614", "#1f1f1c", "#3a3a36"
MEM_TOTAL_GIB = 7.05

ev = [json.loads(l) for l in open(src)]
meta = next(e for e in ev if e["ev"] == "meta")
calls = sorted((e for e in ev if e["ev"] == "call"), key=lambda e: e["t_ms"])
turns = sorted((e for e in ev if e["ev"] == "turn"), key=lambda e: e["start_ms"])
vms = {e["t_ms"] // 1000: e["up"] for e in ev if e["ev"] == "vm"}
samples = [e["sample"] for e in ev if e["ev"] == "sample"]
ts = np.array([s["t"] for s in samples], dtype=float)
used = MEM_TOTAL_GIB - np.array([s["memAvailMiB"] for s in samples]) / 1024
cpu = np.array([s["cpuBusy"] for s in samples], dtype=float)
by_tenant = {}
for c in calls:
    by_tenant.setdefault(c["tenant"], []).append(c)
call_t = np.array([c["t_ms"] / 1000 for c in calls])
call_vm = np.cumsum([c["tier"] == "vm" for c in calls]); call_woke = np.cumsum([c["woke"] for c in calls])
end_s = max(ts.max(), max(t["end_ms"] for t in turns) / 1000)

def short(cmd):
    return (cmd.split("&&", 1)[1] if cmd.startswith("cd ") and "&&" in cmd else cmd).strip().replace("\n", " ")

fig = plt.figure(figsize=(12.8, 7.2), dpi=100, facecolor=BG)
big = fig.add_axes([0.02, 0.04, 0.23, 0.84]); big.set_xlim(0, 1); big.set_ylim(2, 0); big.axis("off")
panes = fig.add_axes([0.27, 0.04, 0.46, 0.84]); panes.axis("off")
ax_cpu = fig.add_axes([0.78, 0.71, 0.20, 0.17], facecolor=BG)
ax_ram = fig.add_axes([0.78, 0.45, 0.20, 0.17], facecolor=BG)
stats = fig.add_axes([0.78, 0.04, 0.20, 0.31]); stats.set_xlim(0, 1); stats.set_ylim(1, 0); stats.axis("off")
header = fig.text(0.02, 0.93, "", color=INK, fontsize=15, family="monospace", va="center")
for ax, title, ylim, y in ((ax_cpu, "cpu busy (%)", (0, 100), cpu), (ax_ram, "memory used (GiB)", (0, MEM_TOTAL_GIB), used)):
    ax.set_title(title, color=INK, fontsize=10, loc="left"); ax.set_xlim(0, end_s); ax.set_ylim(*ylim)
    ax.plot(ts, y, color=GRID, linewidth=1)
    ax.tick_params(colors=MUTED, labelsize=7)
    for side in ("top", "right"): ax.spines[side].set_visible(False)
    for side in ("left", "bottom"): ax.spines[side].set_color(GRID)
ax_ram.axhline(MEM_TOTAL_GIB, color=MUTED, linestyle="--", linewidth=0.8)
lines = [ax.plot([], [], color=INK, linewidth=1.6)[0] for ax in (ax_cpu, ax_ram)]
dots = [ax.plot([], [], "o", color=INK, markersize=4)[0] for ax in (ax_cpu, ax_ram)]
fig.text(0.02, 0.005, "tile = one active tenant   blue: light sandbox   orange: VM   bright outline: woke a VM   line + ring: the tenant in a terminal", color=MUTED, fontsize=9, family="monospace")

def text(ax, x, y, s, box=None, **kw):
    return ax.text(x, y, s, family="monospace", va="center", parse_math=False, **({"clip_path": box, "clip_on": True} if box else {}), **kw)

proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720", "-r", str(FPS), "-i", "-",
                         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], stdin=subprocess.PIPE)
n_frames = int(end_s * FPS / SPEED)
patches, slots, featured, cap_before = [], {}, [], None
for f in range(n_frames):
    t = f * SPEED / FPS
    active = [x["tenant"] for x in turns if x["start_ms"] / 1000 <= t <= x["end_ms"] / 1000]
    for p in patches: p.remove()
    patches = []
    # the middle: every active tenant gets a tile
    cap = next(s for s in STEPS if s >= len(active))
    cols = math.ceil(math.sqrt(cap * 0.97)); rows = math.ceil(cap / cols)
    panes.set_xlim(0, cols); panes.set_ylim(rows, 0)
    if cap != cap_before:
        slots.clear(); cap_before = cap
    for k in [k for k in slots if k not in active]: del slots[k]
    free = [i for i in range(cap) if i not in slots.values()]
    for k in active:
        if k not in slots: slots[k] = free.pop(0)
    for k, i in slots.items():
        r, c = divmod(i, cols)
        recent = [x for x in by_tenant.get(k, []) if x["t_ms"] / 1000 <= t][-1:]
        last = recent[0] if recent else None
        color = (VM if last["tier"] == "vm" else LIGHT) if last else GRID
        woke = bool(last and last["woke"] and t - last["t_ms"] / 1000 < 3)
        patches.append(panes.add_patch(Rectangle((c + 0.06, r + 0.06), 0.88, 0.88, facecolor=color, alpha=1.0 if woke else 0.6, edgecolor=INK if woke else "none", linewidth=1.5)))
    # the left: two large terminals, each following a tenant until its turn ends
    featured = [k for k in featured if k in active]
    newest = sorted(((max((x["t_ms"] for x in by_tenant.get(k, []) if x["t_ms"] / 1000 <= t), default=-1), k) for k in active), reverse=True)
    for _, k in newest:
        if len(featured) < 2 and k not in featured: featured.append(k)
    for j, k in enumerate(featured):
        recent = [x for x in by_tenant.get(k, []) if x["t_ms"] / 1000 <= t][-5:]
        edge = (VM if recent and recent[-1]["tier"] == "vm" else LIGHT) if recent else GRID
        box = big.add_patch(Rectangle((0.02, j + 0.02), 0.96, 0.96, facecolor=PANE, edgecolor=edge, linewidth=1.5)); patches.append(box)
        # a line from the terminal to the tile of the tenant it follows, and a ring around that tile
        if k in slots:
            r, c = divmod(slots[k], cols)
            patches.append(panes.add_patch(Rectangle((c + 0.02, r + 0.02), 0.96, 0.96, facecolor="none", edgecolor=edge, linewidth=2.5)))
            to_fig = fig.transFigure.inverted().transform
            a, b = to_fig(big.transData.transform((0.98, j + 0.5))), to_fig(panes.transData.transform((c, r + 0.5)))
            patches.append(fig.add_artist(Line2D([a[0], b[0]], [a[1], b[1]], color=edge, linewidth=1.2, alpha=0.8, transform=fig.transFigure)))
        patches.append(text(big, 0.06, j + 0.06, f"tenant {k}", box, color=MUTED, fontsize=8))
        y = j + 0.13
        for x in recent:
            patches.append(text(big, 0.06, y, ("$ " + short(x["cmd"]))[:38], box, color=VM if x["tier"] == "vm" else LIGHT, fontsize=7.5)); y += 0.052
            for line in (x["out"] or "").split("\n")[:2]:
                patches.append(text(big, 0.06, y, line[:38], box, color=INK, fontsize=7)); y += 0.052
            y += 0.02
    # the right: counts so far
    n = int(np.searchsorted(call_t, t, side="right"))
    up = vms.get(int(t), [])
    rows_ = [("active tenants", f"{len(active)} of {meta['tenants']}"), ("VMs up", f"{len(up)}"), ("calls so far", f"{n}"),
             ("  in the light sandbox", f"{n - int(call_vm[n - 1]) if n else 0}"), ("  in a VM", f"{int(call_vm[n - 1]) if n else 0}"), ("VM wakes", f"{int(call_woke[n - 1]) if n else 0}")]
    for j, (a, b) in enumerate(rows_):
        patches.append(text(stats, 0.0, 0.07 + j * 0.15, a, color=MUTED, fontsize=8.5))
        patches.append(text(stats, 1.0, 0.07 + j * 0.15, b, color=INK, fontsize=8.5, ha="right"))
    header.set_text(f"{meta['tenants']} tenants   t = {int(t // 60)}:{int(t % 60):02d}")
    m = ts <= t
    for ln, dt, y in zip(lines, dots, (cpu, used)):
        ln.set_data(ts[m], y[m])
        if m.any(): dt.set_data([ts[m][-1]], [y[m][-1]])
    fig.canvas.draw()
    proc.stdin.write(np.asarray(fig.canvas.buffer_rgba()).tobytes())
proc.stdin.close(); proc.wait()
