import { mkdirSync, readFileSync, lstatSync, realpathSync, statSync, writeFileSync, chmodSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

export interface FileMsg { path: string; mode: number; b64: string }
export interface ExecResponse { stdout: string; stderr: string; code: number; changed: FileMsg[]; deleted: string[]; dirs?: string[] }

type Manifest = {
  files: Map<string, string>; // path -> "mtimeNs:size"
  dirs: Set<string>;
  /** When this was taken. Anything modified at or after it cannot be trusted to differ. */
  takenNs: bigint;
};

/**
 * Never synced, matched by directory name at any depth. Copying these over vsock on every
 * wake costs far more than they are worth: a plain opencode workspace carries 3648 files
 * of .opencode/node_modules, which is 73MB of base64 per wake. The guest skips the same
 * names, so neither side reports the other's copy as a change.
 */
const SKIP = new Set(["node_modules", ".git"]);

export function manifest(root: string): Manifest {
  const m: Manifest = { files: new Map(), dirs: new Set(), takenNs: process.hrtime.bigint() && BigInt(Date.now()) * 1000000n };
  const base = realpathSync(root);
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // Runtimes disagree about whether a symlink to a directory is a directory -- bun
      // reports one as a real directory, and not even consistently -- so the decision is
      // made by resolving the path rather than by trusting its type. `dir` is always
      // already canonical, so anything whose resolved form differs is a symlink or
      // escapes the workspace. Either way it is skipped, which is what the guest does.
      let real: string;
      try { real = realpathSync(full); } catch { continue; }
      if (real !== full) continue;
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) { m.dirs.add(r); walk(full, r); }
      // nanoseconds, not truncated milliseconds: a file rewritten to the same size inside
      // one millisecond is otherwise indistinguishable from the old one and never syncs
      else if (st.isFile()) m.files.set(r, `${statSync(full, { bigint: true }).mtimeNs}:${st.size}`);
    }
  };
  walk(base, "");
  return m;
}

/** Talks to the guest agent and keeps the host workspace and the guest workspace in step. */
export class AgentClient {
  private sock!: net.Socket;
  private rl!: readline.Interface;
  private pending: { resolve(line: string): void; reject(e: Error): void }[] = [];
  private dead?: Error;
  /** What the guest is known to hold. */
  private synced: Manifest = { files: new Map(), dirs: new Set(), takenNs: 0n };

  /** Whole files go over the wire base64'd, in one JSON line, on every wake. Past a point
   *  that is not a slow sync, it is a dead one: node cannot hold a string over ~512MB. */
  constructor(private connect: () => Promise<net.Socket>, private workspace: string, private maxFileBytes = 64 * 1024 * 1024) {}

  async open() {
    this.sock = await this.connect();
    this.rl = readline.createInterface({ input: this.sock });
    this.rl.on("line", (l) => this.pending.shift()?.resolve(l));
    // A guest that dies owes an answer to everything already asked. Without this the
    // caller waits on a reply that is never coming, which hangs the agent outright.
    this.sock.on("error", (e) => this.fail(e));
    this.sock.on("close", () => this.fail(new Error("guest agent connection closed")));
    await this.request({ op: "ping" });
  }

  private fail(e: Error) {
    this.dead ??= e;
    const owed = this.pending;
    this.pending = [];
    for (const p of owed) p.reject(e);
  }

  private request(obj: unknown): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.push({
        resolve: (l) => {
          const r = JSON.parse(l);
          r.error ? reject(new Error(r.error)) : resolve(r);
        },
        reject,
      });
      this.sock.write(JSON.stringify(obj) + "\n");
    });
  }

  /** Push whatever changed on the host since the last sync. */
  async pushChanges() {
    const now = manifest(this.workspace);
    const files: FileMsg[] = [];
    for (const [rel, sig] of now.files) {
      // Same size inside the same tick as the last sync looks identical, so trust the
      // signature only for files that were already settled when that sync was taken.
      const settled = BigInt(sig.split(":")[0]) < this.synced.takenNs;
      if (settled && this.synced.files.get(rel) === sig) continue;
      const full = path.join(this.workspace, rel);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue; // vanished, or no longer a regular file
      if (st.size > this.maxFileBytes)
        throw new Error(`${rel} is ${(st.size / 2 ** 20).toFixed(0)}MiB, over the ${(this.maxFileBytes / 2 ** 20).toFixed(0)}MiB sync limit; the workspace is copied into the guest on every wake`);
      files.push({ path: rel, mode: st.mode & 0o777, b64: readFileSync(full).toString("base64") });
    }
    const del = [...this.synced.files.keys()].filter((r) => !now.files.has(r));
    // directories carry no files, so nothing else would ever create them in the guest
    const dirs = [...now.dirs].filter((d) => !this.synced.dirs.has(d));
    if (files.length || del.length || dirs.length) await this.request({ op: "sync", files, delete: del, dirs });
    this.synced = now;
  }

  async exec(cmd: string, cwd: string, env?: Record<string, string>): Promise<ExecResponse> {
    await this.pushChanges();
    const r: ExecResponse = await this.request({ op: "exec", cmd, cwd, env });
    for (const rel of r.deleted) rmSync(path.join(this.workspace, rel), { force: true });
    for (const rel of r.dirs ?? []) mkdirSync(path.join(this.workspace, rel), { recursive: true });
    for (const f of r.changed) {
      const full = path.join(this.workspace, f.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(f.b64, "base64"));
      chmodSync(full, f.mode);
    }
    // what we just wrote is now identical on both sides
    this.synced = manifest(this.workspace);
    return r;
  }

  /** No workspace sync: this asks about the machine, not about files. */
  busy(): Promise<{ busy: boolean; procs: { pid: number; comm: string }[] }> {
    return this.request({ op: "busy" });
  }

  close() {
    this.fail(new Error("agent client closed"));
    this.rl?.close();
    this.sock?.destroy();
  }
}
