import { mkdirSync, readFileSync, lstatSync, realpathSync, statSync, writeFileSync, chmodSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

export interface FileMsg { path: string; mode: number; b64: string }
export interface ExecResponse { stdout: string; stderr: string; code: number; changed: FileMsg[]; deleted: string[] }

type Manifest = Map<string, string>; // relative path -> "mtimeMs:size"

/**
 * Never synced, matched by directory name at any depth. Copying these over vsock on every
 * wake costs far more than they are worth: a plain opencode workspace carries 3648 files
 * of .opencode/node_modules, which is 73MB of base64 per wake. The guest skips the same
 * names, so neither side reports the other's copy as a change.
 */
const SKIP = new Set(["node_modules", ".git"]);

export function manifest(root: string): Manifest {
  const m: Manifest = new Map();
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
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) m.set(r, `${Math.floor(st.mtimeMs)}:${st.size}`);
    }
  };
  walk(base, "");
  return m;
}

/** Talks to the guest agent and keeps the host workspace and the guest workspace in step. */
export class AgentClient {
  private sock!: net.Socket;
  private rl!: readline.Interface;
  private pending: ((line: string) => void)[] = [];
  /** What the guest is known to hold. */
  private synced: Manifest = new Map();

  constructor(private connect: () => Promise<net.Socket>, private workspace: string) {}

  async open() {
    this.sock = await this.connect();
    this.rl = readline.createInterface({ input: this.sock });
    this.rl.on("line", (l) => this.pending.shift()?.(l));
    await this.request({ op: "ping" });
  }

  private request(obj: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.push((l) => {
        const r = JSON.parse(l);
        r.error ? reject(new Error(r.error)) : resolve(r);
      });
      this.sock.write(JSON.stringify(obj) + "\n");
    });
  }

  /** Push whatever changed on the host since the last sync. */
  async pushChanges() {
    const now = manifest(this.workspace);
    const files: FileMsg[] = [];
    for (const [rel, sig] of now) {
      if (this.synced.get(rel) === sig) continue;
      const full = path.join(this.workspace, rel);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue; // vanished, or no longer a regular file
      files.push({ path: rel, mode: st.mode & 0o777, b64: readFileSync(full).toString("base64") });
    }
    const del = [...this.synced.keys()].filter((r) => !now.has(r));
    if (files.length || del.length) await this.request({ op: "sync", files, delete: del });
    this.synced = now;
  }

  async exec(cmd: string, cwd: string, env?: Record<string, string>): Promise<ExecResponse> {
    await this.pushChanges();
    const r: ExecResponse = await this.request({ op: "exec", cmd, cwd, env });
    for (const rel of r.deleted) rmSync(path.join(this.workspace, rel), { force: true });
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
    this.rl?.close();
    this.sock?.destroy();
  }
}
