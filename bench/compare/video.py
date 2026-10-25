# Renders two recordings (bench/compare/record.py) side by side: for each, a tile per sandbox (grey until its command finished, then blue)
# next to memory and cpu through the run. The run that was stopped for running out of memory says so.
# Run: uv run --with matplotlib --with numpy bench/compare/video.py LEFT.jsonl "left name" RIGHT.jsonl "right name" OUT.mp4 [count] [speed]
import json, math, subprocess, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle

(lp, ln, rp, rn, out), rest = sys.argv[1:6], sys.argv[6:]
COUNT = int(rest[0]) if rest else 130
SPEED, FPS = float(rest[1]) if len(rest) > 1 else 0.4, 15
BLUE, ORANGE, INK, MUTED, BG, GRID = "#2a78d6", "#d9772b", "#e8e8e3", "#8c8b86", "#161614", "#3a3a36"
MEM_TOTAL, GUARD = 7.05, 0.3

def load(path):
    rows = [json.loads(l) for l in open(path)]
    s = [r for r in rows if "avail_mib" in r]
    return {"t": np.array([r["t"] for r in s]), "used": MEM_TOTAL - np.array([r["avail_mib"] for r in s]) / 1024,
            "cpu": np.array([r["cpu"] for r in s]), "vms": np.array([r["vms"] for r in s]),
            "done": sorted(r["t"] for r in rows if "done" in r), "killed": next((r["t"] for r in rows if r.get("killed")), None)}

runs = [(ln, load(lp)), (rn, load(rp))]
end = max(r["t"].max() for _, r in runs)
fig = plt.figure(figsize=(12.8, 7.2), dpi=100, facecolor=BG)
cols, rows_ = 13, math.ceil(COUNT / 13)
panels = []
for i, (name, r) in enumerate(runs):
    x0 = 0.02 + i * 0.50
    fig.text(x0, 0.93, name, color=INK, fontsize=16, family="monospace", va="center")
    tiles = fig.add_axes([x0, 0.30, 0.30, 0.58]); tiles.set_xlim(0, cols); tiles.set_ylim(rows_, 0); tiles.axis("off")
    stat = fig.text(x0, 0.255, "", color=INK, fontsize=10, family="monospace", va="center")
    charts = []
    for j, (title, key, ylim) in enumerate((("memory used (GiB)", "used", (0, MEM_TOTAL)), ("cpu busy (%)", "cpu", (0, 100)))):
        ax = fig.add_axes([x0 + 0.33, 0.58 - j * 0.30 + 0.0, 0.14, 0.24], facecolor=BG)
        ax.set_title(title, color=INK, fontsize=9, loc="left"); ax.set_xlim(0, end); ax.set_ylim(*ylim)
        ax.plot(r["t"], r[key], color=GRID, linewidth=1)
        if key == "used":
            ax.axhline(MEM_TOTAL, color=MUTED, linestyle="--", linewidth=0.8); ax.axhline(MEM_TOTAL - GUARD, color=ORANGE, linestyle=":", linewidth=0.8)
        ax.tick_params(colors=MUTED, labelsize=7)
        for side in ("top", "right"): ax.spines[side].set_visible(False)
        for side in ("left", "bottom"): ax.spines[side].set_color(GRID)
        charts.append((ax.plot([], [], color=INK, linewidth=1.6)[0], ax.plot([], [], "o", color=INK, markersize=4)[0], key))
    panels.append((r, tiles, stat, charts))
fig.text(0.02, 0.02, f"one tile per sandbox, {COUNT} started at once on a 7 GiB laptop: grey while starting, blue once its command has finished   dotted line: the run is stopped below 300 MiB free", color=MUTED, fontsize=8, family="monospace")

proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720", "-r", str(FPS), "-i", "-",
                         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], stdin=subprocess.PIPE)
patches = []
for f in range(int((end + 1.5) / SPEED * FPS)):
    t = min(f * SPEED / FPS, end)
    for p in patches: p.remove()
    patches = []
    for r, tiles, stat, charts in panels:
        done = int(np.searchsorted(r["done"], t, side="right"))
        for i in range(COUNT):
            rr, c = divmod(i, cols)
            patches.append(tiles.add_patch(Rectangle((c + 0.07, rr + 0.07), 0.86, 0.86, facecolor=BLUE if i < done else "#2a2a27", edgecolor="none")))
        k = int(np.searchsorted(r["t"], t, side="right")) - 1
        dead = r["killed"] is not None and t >= r["killed"]
        stat.set_text(f"finished {done}/{COUNT}   VMs {int(r['vms'][max(k, 0)])}" + ("   OUT OF MEMORY: stopped" if dead else ""))
        stat.set_color(ORANGE if dead else INK)
        m = r["t"] <= t
        for line, dot, key in charts:
            line.set_data(r["t"][m], r[key][m])
            if m.any(): dot.set_data([r["t"][m][-1]], [r[key][m][-1]])
    fig.canvas.draw()
    proc.stdin.write(np.asarray(fig.canvas.buffer_rgba()).tobytes())
proc.stdin.close(); proc.wait()
