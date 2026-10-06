#!/usr/bin/env python3
"""Guest agent. Runs inside the microVM and serves one host over vsock.

Protocol: one JSON object per line in each direction.
  {"op":"ping"}                                   -> {"ok":true}
  {"op":"sync","files":[{path,mode,b64}],"delete":[path]}   -> {"ok":true}
  {"op":"exec","cmd":str,"cwd":str,"env":{}}      -> {"stdout","stderr","code","changed":[{path,mode,b64}],"deleted":[path]}
Paths are relative to the workspace root. The workspace lives at the same absolute path in the guest as on the host.
"""
import argparse, base64, json, os, socket, subprocess, sys

EXCLUDE_DIRS = {"node_modules/.cache"}


def snapshot(root):
    snap = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            if any(rel.startswith(e) for e in EXCLUDE_DIRS):
                continue
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            snap[rel] = (st.st_mtime_ns, st.st_size)
    return snap


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


def handle(root, req):
    op = req.get("op")
    if op == "ping":
        return {"ok": True}
    if op == "sync":
        for rel in req.get("delete", []):
            try:
                os.remove(safe(root, rel))
            except FileNotFoundError:
                pass
        for f in req.get("files", []):
            full = safe(root, f["path"])
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as out:
                out.write(base64.b64decode(f["b64"]))
            os.chmod(full, f.get("mode", 0o644))
        return {"ok": True}
    if op == "exec":
        before = snapshot(root)
        env = dict(os.environ)
        env.update(req.get("env") or {})
        cwd = req.get("cwd") or root
        p = subprocess.run(["bash", "-c", req["cmd"]], cwd=cwd, env=env, capture_output=True)
        after = snapshot(root)
        changed = [read_file(root, r) for r, v in after.items() if before.get(r) != v]
        deleted = [r for r in before if r not in after]
        return {
            "stdout": p.stdout.decode("utf-8", "replace"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "code": p.returncode,
            "changed": changed,
            "deleted": deleted,
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
