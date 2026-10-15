#!/usr/bin/env python3
"""Guest agent. Runs inside the microVM and serves one host over vsock.

Protocol: one JSON object per line in each direction.
  {"op":"ping"}                                   -> {"ok":true}
  {"op":"sync","files":[{path,mode,b64}],"delete":[path],"dirs":[path]}  -> {"ok":true}
  {"op":"exec","cmd":str,"cwd":str,"env":{}}      -> {"stdout","stderr","code","changed":[{path,mode,b64}],"deleted":[path]}
  {"op":"busy"}                                   -> {"busy":bool,"procs":[{pid,comm}]}
Paths are relative to the workspace root. The workspace lives at the same absolute path in the guest as on the host.
"""
import argparse, base64, json, os, socket, subprocess, sys

EXCLUDE_DIRS = {"node_modules", ".git"}  # must match SKIP in agent-client.ts

# What the host is known to hold. Diffing a command against this rather than against the
# workspace as it stood when the command started is what makes writes by anything the
# agent left running -- a cron, a dev server, a build watcher -- visible at all: those
# land between commands, so a before/after pair taken around one command cannot see them.
SYNCED = ({}, set())


def snapshot(root):
    """Files by signature, plus every directory: a directory holding no files is invisible
    to a file-only walk, so it would never reach the other side."""
    snap, dirs = {}, set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir != ".":
            dirs.add(rel_dir)
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            snap[rel] = (st.st_mtime_ns, st.st_size)
    return snap, dirs


def read_file(root, rel):
    full = os.path.join(root, rel)
    with open(full, "rb") as f:
        data = f.read()
    return {"path": rel, "mode": os.stat(full).st_mode & 0o777, "b64": base64.b64encode(data).decode()}


def safe(root, rel):
    full = os.path.normpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path escapes workspace: " + rel)
    return full


def _ppid(pid):
    with open("/proc/%d/stat" % pid) as f:
        return int(f.read().rsplit(") ", 1)[1].split()[1])


def live_processes():
    """Processes in the guest that the agent did not spawn for the request in hand.

    A command that backgrounds a server returns immediately, so "no command running"
    is not the same as "nothing running". The host has to know the difference before
    it kills the VM, because the next wake restores a pristine snapshot and anything
    still in here would vanish without a trace.

    Only userspace descendants of init count. Kernel threads and the kernel's usermode
    helpers hang off kthreadd (pid 2) and are not the agent's doing; the agent's own
    ancestor chain is its own doing.
    """
    mine = set()
    pid = os.getpid()
    while pid > 1 and pid not in mine:
        mine.add(pid)
        try:
            pid = _ppid(pid)
        except (OSError, IndexError, ValueError):
            break

    out = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid <= 1 or pid in mine:
            continue
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                if not f.read().strip(b"\x00"):
                    continue  # kernel thread: no userspace at all
            walk, seen = pid, set()
            while walk > 1 and walk not in seen:
                seen.add(walk)
                walk = _ppid(walk)
            if walk != 1:
                continue  # rooted at kthreadd, or gone: not something the agent started
            with open("/proc/%d/comm" % pid) as f:
                out.append({"pid": pid, "comm": f.read().strip()})
        except (OSError, IndexError, ValueError):  # exited while we were looking
            continue
    return out


def handle(root, req):
    op = req.get("op")
    if op == "ping":
        return {"ok": True}
    if op == "busy":
        procs = live_processes()
        return {"busy": bool(procs), "procs": procs}
    global SYNCED
    if op == "sync":
        for rel in req.get("delete", []):
            try:
                os.remove(safe(root, rel))
            except FileNotFoundError:
                pass
        for rel in req.get("dirs", []):
            os.makedirs(safe(root, rel), exist_ok=True)
        for f in req.get("files", []):
            full = safe(root, f["path"])
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as out:
                out.write(base64.b64decode(f["b64"]))
            os.chmod(full, f.get("mode", 0o644))
        SYNCED = snapshot(root)
        return {"ok": True}
    if op == "exec":
        before, before_dirs = SYNCED
        env = dict(os.environ)
        env.update(req.get("env") or {})
        cwd = req.get("cwd") or root
        p = subprocess.run(["bash", "-c", req["cmd"]], cwd=cwd, env=env, capture_output=True)
        after, after_dirs = snapshot(root)
        SYNCED = (after, after_dirs)
        changed = [read_file(root, r) for r, v in after.items() if before.get(r) != v]
        deleted = [r for r in before if r not in after]
        return {
            "stdout": p.stdout.decode("utf-8", "replace"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "code": p.returncode,
            "changed": changed,
            "deleted": deleted,
            "dirs": sorted(after_dirs - before_dirs),
        }
    return {"error": "unknown op " + str(op)}


def serve(conn, root):
    f = conn.makefile("rwb")
    for line in f:
        if not line.strip():
            continue
        try:
            resp = handle(root, json.loads(line))
        except Exception as e:  # keep the agent alive on any request error
            resp = {"error": str(e)}
        f.write((json.dumps(resp) + "\n").encode())
        f.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--vsock-port", type=int)
    ap.add_argument("--unix")
    a = ap.parse_args()
    root = os.path.normpath(a.workspace)
    os.makedirs(root, exist_ok=True)
    if a.vsock_port:
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        s.bind((socket.VMADDR_CID_ANY, a.vsock_port))
    else:
        if os.path.exists(a.unix):
            os.remove(a.unix)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(a.unix)
    s.listen(1)
    print("agent ready", flush=True)
    while True:
        conn, _ = s.accept()
        with conn:
            serve(conn, root)


if __name__ == "__main__":
    main()
