# Runs a command that starts many sandboxes and records, ten times a second, how much memory and cpu the machine uses and how many VMs
# exist, plus the moment each "Sandbox N" line is printed. Stops the command, like the capacity benchmark does, if free memory falls
# under GUARD MiB. Python buffers its output when it writes to a pipe, so run Python programs with PYTHONUNBUFFERED=1 or the "Sandbox N"
# lines all arrive at exit. Writes JSON lines: {"t", "avail_mib", "cpu", "vms"}, {"t", "done"}, and {"t", "killed"} or {"t", "exit"}.
#   uv run bench/compare/record.py OUT.jsonl "libkrun VM" -- uv run bench/compare/microsandbox_hundred.py 130
import json, os, signal, subprocess, sys, threading, time

out, vm_name = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
GUARD = 300

def avail():
    for l in open("/proc/meminfo"):
        if l.startswith("MemAvailable:"):
            return int(l.split()[1]) // 1024

def cpu():
    v = [float(x) for x in open("/proc/stat").readline().split()[1:9]]
    return sum(v), v[3] + v[4]

def vms():
    n = 0
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                n += open(f"/proc/{p}/comm").read().strip() == vm_name
            except OSError:
                pass
    return n

lines = []
t0 = time.time()
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
def reader():
    for l in proc.stdout:
        if l.startswith("Sandbox"):
            lines.append({"t": round(time.time() - t0, 2), "done": int(l.split()[1].rstrip(":"))})
threading.Thread(target=reader, daemon=True).start()

rows, prev, killed = [], cpu(), None
while proc.poll() is None:
    time.sleep(0.1)
    cur = cpu(); a = avail()
    busy = 100 * (1 - (cur[1] - prev[1]) / max(cur[0] - prev[0], 1)); prev = cur
    rows.append({"t": round(time.time() - t0, 2), "avail_mib": a, "cpu": round(busy, 1), "vms": vms()})
    if a < GUARD:
        killed = rows[-1]["t"]
        os.killpg(proc.pid, signal.SIGKILL)
        subprocess.run(["pkill", "-KILL", "-x", vm_name.split()[0] + (" VM" if " " in vm_name else "")])
        break
# keep sampling for a moment so the recovery shows
for _ in range(20):
    time.sleep(0.1); cur = cpu()
    busy = 100 * (1 - (cur[1] - prev[1]) / max(cur[0] - prev[0], 1)); prev = cur
    rows.append({"t": round(time.time() - t0, 2), "avail_mib": avail(), "cpu": round(busy, 1), "vms": vms()})
with open(out, "w") as f:
    for r in rows + lines + [{"t": killed, "killed": True} if killed else {"t": rows[-21]["t"], "exit": proc.returncode}]:
        f.write(json.dumps(r) + "\n")
