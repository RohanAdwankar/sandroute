import { mkdirSync, readFileSync, lstatSync, realpathSync, statSync, writeFileSync, chmodSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

export interface FileMsg { path: string; mode: number; b64: string }
export interface Report { changed: FileMsg[]; deleted: string[]; dirs?: string[] }
export interface ExecResponse extends Report { stdout: string; stderr: string; code: number; scratch?: Report }

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

/** A host directory kept in step with a guest directory, and what the guest is known to hold of it. */
class Area {
  synced: Manifest = { files: new Map(), dirs: new Set(), takenNs: 0n };

  /** Whole files go over the wire base64'd, in one JSON line, on every wake. Past a point
   *  that is not a slow sync, it is a dead one: node cannot hold a string over ~512MB. */
  constructor(readonly dir: string, private maxFileBytes: number) { mkdirSync(dir, { recursive: true }); }

  /** What changed on the host since the last sync, in the shape the guest's sync takes. */
  changes() {
    const now = manifest(this.dir);
    const files: FileMsg[] = [];
    for (const [rel, sig] of now.files) {
      // Same size inside the same tick as the last sync looks identical, so trust the
      // signature only for files that were already settled when that sync was taken.
      const settled = BigInt(sig.split(":")[0]) < this.synced.takenNs;
      if (settled && this.synced.files.get(rel) === sig) continue;
      const full = path.join(this.dir, rel);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue; // vanished, or no longer a regular file
      if (st.size > this.maxFileBytes)
        throw new Error(`${rel} is ${(st.size / 2 ** 20).toFixed(0)}MiB, over the ${(this.maxFileBytes / 2 ** 20).toFixed(0)}MiB sync limit; it is copied into the guest on every wake`);
      files.push({ path: rel, mode: st.mode & 0o777, b64: readFileSync(full).toString("base64") });
    }
    const del = [...this.synced.files.keys()].filter((r) => !now.files.has(r));
    // directories carry no files, so nothing else would ever create them in the guest
    const dirs = [...now.dirs].filter((d) => !this.synced.dirs.has(d));
    this.synced = now;
    return { files, delete: del, dirs };
  }

  /** Take whatever the guest reports and make the host match it. */
  apply(r: Report) {
    for (const rel of r.deleted) rmSync(path.join(this.dir, rel), { force: true });
    for (const rel of r.dirs ?? []) mkdirSync(path.join(this.dir, rel), { recursive: true });
    for (const f of r.changed) {
      const full = path.join(this.dir, f.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(f.b64, "base64"));
      chmodSync(full, f.mode);
    }
    // what we just wrote is now identical on both sides
    this.synced = manifest(this.dir);
  }
}

/** Talks to the guest agent and keeps the host workspace and the guest workspace in step. */
export class AgentClient {
  private sock!: net.Socket;
  private rl!: readline.Interface;
  private pending: { resolve(line: string): void; reject(e: Error): void }[] = [];
  private dead?: Error;
  private workspace: Area;
  /** The guest's /tmp, kept on the host so a release that discards the guest loses nothing in it. */
  private scratch?: Area;

  constructor(private connect: () => Promise<net.Socket>, workspace: string, maxFileBytes = 64 * 1024 * 1024, scratchDir?: string) {
    this.workspace = new Area(workspace, maxFileBytes);
    if (scratchDir) this.scratch = new Area(scratchDir, maxFileBytes);
  }

  /** Called with paths the guest kept its own version of. */
  onConflict?: (paths: string[]) => void;
  /** Hash of the agent this host ships. Set it and a stale image is refused at connect. */
  expectAgent?: string;
  /** Set the guest's wall clock from the host on connect. A restored guest is as far
   *  behind as the time since its snapshot was taken, and needs root to be corrected. */
  syncClock = false;

  async open() {
    this.sock = await this.connect();
    this.rl = readline.createInterface({ input: this.sock });
    this.rl.on("line", (l) => this.pending.shift()?.resolve(l));
    // A guest that dies owes an answer to everything already asked. Without this the
    // caller waits on a reply that is never coming, which hangs the agent outright.
    this.sock.on("error", (e) => this.fail(e));
    this.sock.on("close", () => this.fail(new Error("guest agent connection closed")));
    const hello = await this.request({ op: "ping" });
    if (this.expectAgent && hello.agent !== this.expectAgent)
      throw new Error(`guest agent is ${hello.agent ?? "of unknown vintage"}, host ships ${this.expectAgent}: rebuild the image from guest/agent.py`);
    if (this.syncClock) await this.request({ op: "clock", epoch: Date.now() / 1000 });
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
    const ws = this.workspace.changes(), sc = this.scratch?.changes();
    const empty = (c: { files: unknown[]; delete: unknown[]; dirs: unknown[] }) => !c.files.length && !c.delete.length && !c.dirs.length;
    if (empty(ws) && (!sc || empty(sc))) return;
    const r = await this.request({ op: "sync", ...ws, ...(sc ? { scratch: sc } : {}) });
    // The guest refuses a file it has moved on from itself. Its version arrives with the
    // next report, so the host converges on it rather than overwriting it.
    if (r.conflicts?.length) this.onConflict?.(r.conflicts);
  }

  async exec(cmd: string, cwd: string, env?: Record<string, string>): Promise<ExecResponse> {
    await this.pushChanges();
    const r: ExecResponse = await this.request({ op: "exec", cmd, cwd, env });
    this.apply(r);
    return r;
  }

  private apply(r: ExecResponse | (Report & { scratch?: Report })) {
    this.workspace.apply(r);
    if (r.scratch) this.scratch?.apply(r.scratch);
  }

  /** What this guest holds that a release would lose and the host cannot rebuild. */
  state(): Promise<{ files: number; sample: string[] }> {
    return this.request({ op: "state" });
  }

  /** Asks what is still running, and collects what it has written while it ran. */
  async busy(): Promise<{ busy: boolean; procs: { pid: number; comm: string }[] }> {
    const r = await this.request({ op: "busy" });
    this.apply(r);
    return r;
  }

  close() {
    this.fail(new Error("agent client closed"));
    this.rl?.close();
    this.sock?.destroy();
  }
}
