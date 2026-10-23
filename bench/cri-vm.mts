// A pod per tenant, driven through the Kubernetes CRI like any cluster would: crictl against a
// containerd that has a sandboxing runtime. With Kata the pod is a VM; with gVisor it is a
// userspace kernel. These are what someone running Kubernetes picks to hold hostile tenants
// apart. Neither has a snapshot to release a pod to, so the only way one gives memory back is
// to delete the pod, and the next command boots a new one.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VmBackend, VmResult } from "../src/vm.js";

const K = process.env.KATA_HOME ?? "/home/rohan/kata";
const image = process.env.KATA_IMAGE ?? "docker.io/library/python:3.13-slim";

const crictlConfig = process.env.CRI_CONFIG ?? `${K}/crictl.yaml`;
const runtime = process.env.CRI_RUNTIME;   // the containerd runtime handler; unset uses containerd's default
const crictl = (args: string[], timeoutMs = 90_000) => new Promise<VmResult>((resolve) =>
  execFile(`${K}/nerd/bin/crictl`, ["--config", crictlConfig, ...args], { timeout: timeoutMs, maxBuffer: 20 * 2 ** 20 },
    (err, stdout, stderr) => resolve({ stdout, stderr, exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0 })));

export class CriVm implements VmBackend {
  readonly name = `cri (${runtime ?? "default"})`;
  private pod?: string;
  private ctr?: string;
  private dir: string;
  private n = 0;

  constructor(private id: string, runDir: string) { this.dir = path.join(runDir, "kata", id); }

  async boot(workspace: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const gen = ++this.n, pod = path.join(this.dir, `pod${gen}.json`), ctr = path.join(this.dir, `ctr${gen}.json`);
    writeFileSync(pod, JSON.stringify({ metadata: { name: `t${this.id}-${gen}`, namespace: "b", uid: `${this.id}-${gen}-${process.pid}`, attempt: 1 }, log_directory: this.dir, linux: {} }));
    writeFileSync(ctr, JSON.stringify({ metadata: { name: "c" }, image: { image }, command: ["sleep", "infinity"], log_path: `c${gen}.log`,
      mounts: [{ host_path: workspace, container_path: "/work" }], linux: {} }));
    const p = await crictl(["runp", ...(runtime ? ["--runtime", runtime] : []), pod]);
    if (p.exitCode) throw new Error(`runp: ${p.stderr.trim().split("\n").pop()}`);
    this.pod = p.stdout.trim();
    const c = await crictl(["create", this.pod, ctr, pod]);
    if (c.exitCode) throw new Error(`create: ${c.stderr.trim().split("\n").pop()}`);
    this.ctr = c.stdout.trim();
    const s = await crictl(["start", this.ctr]);
    if (s.exitCode) throw new Error(`start: ${s.stderr.trim().split("\n").pop()}`);
  }

  exec(command: string, opts: { cwd: string }): Promise<VmResult> {
    return crictl(["exec", "--timeout", "60", this.ctr!, "bash", "-c", 'umask 000; cd "$0" && exec bash -c "$1"', opts.cwd, command], 65_000);
  }

  async stop(): Promise<void> {
    const pod = this.pod; this.pod = this.ctr = undefined;
    if (!pod) return;
    await crictl(["stopp", pod]); await crictl(["rmp", pod]);
  }
}
