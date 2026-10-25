# Renders a timelapse video of a run from its event log: terminal panes for the tenants that are active (blue border: the call ran in the
# light sandbox, orange: in a VM, thick orange: the call woke a VM), and RAM and cpu through the run on the right.
# Run: uv run --with matplotlib --with numpy bench/timelapse.py RUN.events.jsonl OUT.mp4 [speed]
import json, subprocess, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle

src, out = sys.argv[1], sys.argv[2]
SPEED, FPS = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0, 15
COLS, ROWS = 6, 4
LIGHT, VM, INK, MUTED, BG, PANE = "#2a78d6", "#d9772b", "#e8e8e3", "#8c8b86", "#161614", "#1f1f1c"
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
end_s = max(ts.max(), max(t["end_ms"] for t in turns) / 1000)

fig = plt.figure(figsize=(12.8, 7.2), dpi=100, facecolor=BG)
panes = fig.add_axes([0.02, 0.04, 0.66, 0.84]); panes.set_xlim(0, COLS); panes.set_ylim(ROWS, 0); panes.axis("off")
ax_ram = fig.add_axes([0.74, 0.55, 0.24, 0.33], facecolor=BG)
ax_cpu = fig.add_axes([0.74, 0.12, 0.24, 0.33], facecolor=BG)
header = fig.text(0.02, 0.93, "", color=INK, fontsize=15, family="monospace", va="center")
for ax, title, ylim, y in ((ax_ram, "memory used (GiB)", (0, MEM_TOTAL_GIB), used), (ax_cpu, "cpu busy (%)", (0, 100), cpu)):
    ax.set_title(title, color=INK, fontsize=11, loc="left"); ax.set_xlim(0, end_s); ax.set_ylim(*ylim)
    ax.plot(ts, y, color="#3a3a36", linewidth=1)
    ax.tick_params(colors=MUTED, labelsize=8)
    for side in ("top", "right"): ax.spines[side].set_visible(False)
    for side in ("left", "bottom"): ax.spines[side].set_color("#3a3a36")
ax_ram.axhline(MEM_TOTAL_GIB, color=MUTED, linestyle="--", linewidth=0.8)
ram_line, = ax_ram.plot([], [], color=INK, linewidth=1.6); cpu_line, = ax_cpu.plot([], [], color=INK, linewidth=1.6)
ram_dot, = ax_ram.plot([], [], "o", color=INK, markersize=4); cpu_dot, = ax_cpu.plot([], [], "o", color=INK, markersize=4)
fig.text(0.74, 0.04, "blue: light sandbox     orange: VM", color=MUTED, fontsize=9, family="monospace")

slots = {}  # tenant -> pane index, kept while the tenant is active so the layout does not shuffle
proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1280x720", "-r", str(FPS), "-i", "-",
                         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], stdin=subprocess.PIPE)
n_frames = int(end_s * FPS / SPEED)
patches = []
for f in range(n_frames):
    t = f * SPEED / FPS
    active = [x["tenant"] for x in turns if x["start_ms"] / 1000 <= t <= x["end_ms"] / 1000]
    for k in [k for k in slots if k not in active]: del slots[k]
    free = [i for i in range(COLS * ROWS) if i not in slots.values()]
    for k in active:
        if k not in slots and free: slots[k] = free.pop(0)
    for p in patches: p.remove()
    patches = []
    for k, i in slots.items():
        r, c = divmod(i, COLS)
        recent = [x for x in by_tenant.get(k, []) if x["t_ms"] / 1000 <= t][-3:]
        last = recent[-1] if recent else None
        edge = (VM if last["tier"] == "vm" else LIGHT) if last else "#3a3a36"
        box = panes.add_patch(Rectangle((c + 0.03, r + 0.04), 0.94, 0.92, facecolor=PANE, edgecolor=edge, linewidth=3 if last and last["woke"] and t - last["t_ms"] / 1000 < 3 else 1.2))
        patches.append(box)
        def put(x, y, text, **kw):  # text never leaves its pane
            patches.append(panes.text(x, y, text, family="monospace", va="center", clip_path=box, clip_on=True, **kw))
        put(c + 0.06, r + 0.13, f"tenant {k}", color=MUTED, fontsize=7)
        y = r + 0.27
        for x in recent:
            put(c + 0.06, y, ("$ " + (x["cmd"].split("&&", 1)[1] if x["cmd"].startswith("cd ") and "&&" in x["cmd"] else x["cmd"]).strip().replace("\n", " "))[:23], color=VM if x["tier"] == "vm" else LIGHT, fontsize=7); y += 0.12
            for line in (x["out"] or "").split("\n")[:1]:
                put(c + 0.06, y, line[:24], color=INK, fontsize=6.5); y += 0.12
    up = vms.get(int(t), [])
    header.set_text(f"{meta['tenants']} tenants   active {len(active):>3}   VMs up {len(up):>3}   t = {int(t // 60)}:{int(t % 60):02d}")
    m = ts <= t
    ram_line.set_data(ts[m], used[m]); cpu_line.set_data(ts[m], cpu[m])
    if m.any(): ram_dot.set_data([ts[m][-1]], [used[m][-1]]); cpu_dot.set_data([ts[m][-1]], [cpu[m][-1]])
    fig.canvas.draw()
    proc.stdin.write(np.asarray(fig.canvas.buffer_rgba()).tobytes())
proc.stdin.close(); proc.wait()
