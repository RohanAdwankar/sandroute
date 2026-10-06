import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentClient } from "./agent-client.js";
import type { VmBackend, VmResult } from "./vm.js";

export interface FirecrackerOptions {
  /** Path to the firecracker binary. */
  bin?: string;
  /** Uncompressed vmlinux. */
  kernel: string;
  /** ext4 image containing bash, python3 and guest/agent.py started at boot. */
  rootfs: string;
  vcpus?: number;
  memMiB?: number;
  /** Extra kernel args appended to the defaults. */
  bootArgs?: string;
  agentPort?: number;
}

/** The ordered Firecracker API calls that configure and start a VM. Pure, so it can be tested without KVM. */
export function buildConfig(o: FirecrackerOptions, vsockPath: string, workspace: string): { path: string; body: unknown }[] {
  const port = o.agentPort ?? 5000;
  return [
    { path: "/boot-source", body: { kernel_image_path: o.kernel, boot_args: `console=ttyS0 reboot=k panic=1 pci=off sandroute.workspace=${workspace} sandroute.port=${port} ${o.bootArgs ?? ""}`.trim() } },
    { path: "/drives/rootfs", body: { drive_id: "rootfs", path_on_host: o.rootfs, is_root_device: true, is_read_only: false } },
    { path: "/machine-config", body: { vcpu_count: o.vcpus ?? 2, mem_size_mib: o.memMiB ?? 1024 } },
    { path: "/vsock", body: { guest_cid: 3, uds_path: vsockPath } },
    { path: "/actions", body: { action_type: "InstanceStart" } },
  ];
}

function api(sock: string, p: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: p, method: "PUT", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => (res.statusCode! < 300 ? resolve() : reject(new Error(`firecracker ${p}: ${res.statusCode} ${out}`))));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Firecracker exposes guest vsock as a host unix socket: connect, send "CONNECT <port>", expect "OK ...". */
export function vsockConnect(udsPath: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(udsPath);
    s.once("error", reject);
    s.once("connect", () => s.write(`CONNECT ${port}\n`));
    s.once("data", (d) => {
      if (d.toString().startsWith("OK")) resolve(s);
      else reject(new Error("vsock handshake: " + d.toString().trim()));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FirecrackerVm implements VmBackend {
  readonly name = "firecracker";
  private proc?: ChildProcess;
  private client?: AgentClient;
  private workspace = "";

  constructor(private o: FirecrackerOptions) {}

  async boot(workspace: string): Promise<void> {
    this.workspace = workspace;
    const dir = mkdtempSync(path.join(tmpdir(), "sandroute-fc-"));
    const apiSock = path.join(dir, "api.sock");
    const vsock = path.join(dir, "v.sock");
    this.proc = spawn(this.o.bin ?? "firecracker", ["--api-sock", apiSock], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try { await api(apiSock, "/machine-config", { vcpu_count: 1, mem_size_mib: 128 }); break; } catch { await sleep(50); }
    }
    for (const step of buildConfig(this.o, vsock, workspace)) await api(apiSock, step.path, step.body);
    // the guest agent needs a moment after InstanceStart
    let lastErr: unknown;
    for (let i = 0; i < 100; i++) {
      try {
        this.client = new AgentClient(() => vsockConnect(vsock, this.o.agentPort ?? 5000), workspace);
        await this.client.open();
        return;
      } catch (e) { lastErr = e; await sleep(100); }
    }
    throw new Error("guest agent never came up: " + String(lastErr));
  }

  async exec(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<VmResult> {
    const r = await this.client!.exec(command, opts.cwd, opts.env);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.proc?.kill("SIGKILL");
  }
}
