import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentClient } from "./agent-client.js";
import type { VmBackend, VmResult } from "./vm.js";

export interface FirecrackerOptions {
  /** Path to the firecracker binary. */
  bin?: string;
  /** Uncompressed vmlinux. */
  kernel: string;
  /**
   * ext4 image containing bash, python3 and guest/agent.py started at boot. Mounted
   * read-only, so its init must mount a tmpfs at the workspace path.
   */
  rootfs: string;
  vcpus?: number;
  memMiB?: number;
  /** Extra kernel args appended to the defaults. */
  bootArgs?: string;
  agentPort?: number;
  /** Pipe the guest console to this process. Off by default, and the only way to see why a boot failed. */
  console?: boolean;
  /**
   * Give the guest a network. It behaves like any other machine: it can reach the
   * internet and install what it needs, and it cannot reach the host.
   *
   * Needs a tap device, which needs CAP_NET_ADMIN, so it is set up once by an operator
   * rather than by sandroute -- see scripts/net-setup.sh. Left unset, the guest has
   * loopback only and an agent that reaches for a package manager is stuck.
   */
  network?: {
    /** Host tap device, e.g. "sr-tap0". */
    tap: string;
    /** Guest address with prefix, e.g. "172.16.0.2/30". */
    guestIp: string;
    /** The host end of the tap, e.g. "172.16.0.1". */
    gateway: string;
    /** Resolver the guest should use. Defaults to 1.1.1.1. */
    dns?: string;
    mac?: string;
  };
  /**
   * Keep a booted-and-ready snapshot here and restore from it instead of cold booting.
   * The first boot for a workspace primes it; every boot after that is a restore, which
   * is what makes releasing the VM mid-turn cheap enough to be worth doing.
   *
   * A snapshot is tied to one workspace path, because the guest agent's root arrives on
   * the kernel command line and is baked into the guest's memory.
   */
  snapshotDir?: string;
}

/** The ordered Firecracker API calls that configure and start a VM. Pure, so it can be tested without KVM. */
export function buildConfig(o: FirecrackerOptions, vsockPath: string, workspace: string): { path: string; body: unknown }[] {
  const port = o.agentPort ?? 5000;
  const net = o.network;
  const netArgs = net
    ? ` sandroute.ip=${net.guestIp} sandroute.gw=${net.gateway} sandroute.dns=${net.dns ?? "1.1.1.1"}`
    : "";
  const steps: { path: string; body: unknown }[] = [
    { path: "/boot-source", body: { kernel_image_path: o.kernel, boot_args: `console=ttyS0 reboot=k panic=1 pci=off sandroute.workspace=${workspace} sandroute.port=${port}${netArgs} ${o.bootArgs ?? ""}`.trim() } },
    // Read-only, for two reasons. A writable root means one image cannot back two VMs at
    // once, and restoring a snapshot over a backing file that a later VM has since written
    // corrupts the filesystem: the restored guest's cached ext4 metadata no longer matches
    // the disk. The guest is disposable and the host owns the workspace, so the image never
    // needs to be written -- the rootfs must mount a tmpfs at the workspace path instead.
    { path: "/drives/rootfs", body: { drive_id: "rootfs", path_on_host: o.rootfs, is_root_device: true, is_read_only: true } },
    { path: "/machine-config", body: { vcpu_count: o.vcpus ?? 2, mem_size_mib: o.memMiB ?? 1024 } },
    { path: "/vsock", body: { guest_cid: 3, uds_path: vsockPath } },
  ];
  if (net) {
    steps.push({ path: "/network-interfaces/eth0", body: { iface_id: "eth0", guest_mac: net.mac ?? "06:00:ac:10:00:02", host_dev_name: net.tap } });
  }
  steps.push({ path: "/actions", body: { action_type: "InstanceStart" } });
  return steps;
}

function get(sock: string, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: p, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode! < 300 ? resolve() : reject(new Error(`GET ${p}: ${res.statusCode}`))));
    });
    req.on("error", reject);
    req.end();
  });
}

function api(sock: string, p: string, body: unknown, method = "PUT"): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: p, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => (res.statusCode! < 300 ? resolve() : reject(new Error(`firecracker ${method} ${p}: ${res.statusCode} ${out}`))));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Firecracker exposes guest vsock as a host unix socket: connect, send "CONNECT <port>", expect "OK ...". */
export function vsockConnect(udsPath: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(udsPath);
    const fail = (e: Error) => { s.destroy(); reject(e); };
    // Until the guest agent binds the port, firecracker answers a CONNECT by closing
    // with no reply. Without this the promise never settles and boot() hangs on its
    // first attempt instead of retrying.
    const onClose = () => fail(new Error(`vsock port ${port} closed before the handshake`));
    s.once("error", fail);
    s.once("close", onClose);
    s.once("connect", () => s.write(`CONNECT ${port}\n`));
    s.once("data", (d) => {
      s.removeListener("close", onClose);
      s.removeListener("error", fail);
      if (d.toString().startsWith("OK")) resolve(s);
      else fail(new Error("vsock handshake: " + d.toString().trim()));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VSOCK_REL = "v.sock";

async function waitApi(sock: string, readOnly = false) {
  for (let i = 0; i < 200; i++) {
    try {
      if (readOnly) await get(sock, "/version");
      else await api(sock, "/machine-config", { vcpu_count: 1, mem_size_mib: 128 });
      return;
    } catch { await sleep(20); }
  }
  throw new Error("firecracker api never came up");
}

export class FirecrackerVm implements VmBackend {
  readonly name = "firecracker";
  private proc?: ChildProcess;
  private client?: AgentClient;
  private workspace = "";
  private dir = "";
  /** True when the last boot() restored a snapshot rather than cold booting. */
  lastBootWasRestore = false;

  constructor(private o: FirecrackerOptions) {}

  async boot(workspace: string): Promise<void> {
    this.workspace = workspace;
    const snap = this.snapPaths(workspace);
    if (snap && existsSync(snap.state) && existsSync(snap.mem)) {
      this.lastBootWasRestore = true;
      await this.restore(snap);
      await this.probeAgent();
      await this.openClient();
      return;
    }
    this.lastBootWasRestore = false;
    const apiSock = await this.coldBoot(workspace);
    if (snap) await this.prime(apiSock, snap);
    await this.openClient();
  }

  private snapPaths(workspace: string) {
    if (!this.o.snapshotDir) return undefined;
    // one snapshot per workspace path: the guest agent's root is baked into guest memory
    const key = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16);
    mkdirSync(this.o.snapshotDir, { recursive: true });
    return { state: path.join(this.o.snapshotDir, `${key}.state`), mem: path.join(this.o.snapshotDir, `${key}.mem`) };
  }

  /** firecracker binds the vsock socket relative to its cwd, so a relative uds_path in the
   * snapshot lets many restored VMs coexist instead of fighting over one absolute path. */
  private spawnFc(): string {
    this.dir = mkdtempSync(path.join(tmpdir(), "sandroute-fc-"));
    const apiSock = path.join(this.dir, "api.sock");
    this.proc = spawn(this.o.bin ?? "firecracker", ["--api-sock", apiSock], {
      cwd: this.dir,
      stdio: this.o.console ? ["ignore", "inherit", "inherit"] : "ignore",
    });
    return apiSock;
  }

  private async coldBoot(workspace: string): Promise<string> {
    const apiSock = this.spawnFc();
    await waitApi(apiSock);
    for (const step of buildConfig(this.o, VSOCK_REL, workspace)) await api(apiSock, step.path, step.body);
    await this.probeAgent();
    return apiSock;
  }

  private async prime(apiSock: string, snap: { state: string; mem: string }) {
    // Snapshot the guest while its workspace is still empty, so a restore is always a
    // clean machine. The host owns the workspace and re-pushes it on wake anyway.
    // There must be no live vsock connection: it does not survive the snapshot, and the
    // guest would come back holding a dead one. probeAgent() already closed its socket,
    // this just gives the agent a moment to get back to accept().
    await sleep(50);
    await api(apiSock, "/vm", { state: "Paused" }, "PATCH");
    await api(apiSock, "/snapshot/create", { snapshot_type: "Full", snapshot_path: snap.state, mem_file_path: snap.mem });
    await api(apiSock, "/vm", { state: "Resumed" }, "PATCH");
  }

  private async restore(snap: { state: string; mem: string }) {
    const apiSock = this.spawnFc();
    // GET, because firecracker refuses /snapshot/load once anything boot-specific is set
    await waitApi(apiSock, true);
    rmSync(path.join(this.dir, VSOCK_REL), { force: true });
    await api(apiSock, "/snapshot/load", {
      snapshot_path: snap.state,
      mem_backend: { backend_type: "File", backend_path: snap.mem },
      resume_vm: true,
    });
  }

  private get vsockPath() { return path.join(this.dir, VSOCK_REL); }

  /** Wait for the agent to answer, then hang up. Readiness only, no lasting connection. */
  private async probeAgent() {
    let lastErr: unknown;
    for (let i = 0; i < 300; i++) {
      try {
        const s = await vsockConnect(this.vsockPath, this.o.agentPort ?? 5000);
        s.destroy();
        return;
      } catch (e) { lastErr = e; await sleep(50); }
    }
    throw new Error("guest agent never came up: " + String(lastErr));
  }

  private async openClient() {
    this.client = new AgentClient(() => vsockConnect(this.vsockPath, this.o.agentPort ?? 5000), this.workspace);
    await this.client.open();
  }

  async exec(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<VmResult> {
    const r = await this.client!.exec(command, opts.cwd, opts.env);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  }

  busy() {
    return this.client!.busy();
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = undefined;
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
