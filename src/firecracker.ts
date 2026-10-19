import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  /** Refuse to sync a file larger than this. Defaults to 64MiB. */
  maxFileBytes?: number;
  /**
   * Where the workspace lives inside the guest, when that is not where it lives on the
   * host. Every tenant can then see /work while their host directories differ, which is
   * what lets one pristine snapshot serve all of them: the guest agent's root is baked
   * into the snapshot, so it is keyed by this path and not by the host's.
   */
  guestWorkspace?: string;
  /** Where suspended sessions are written. Defaults to snapshotDir. */
  sessionDir?: string;
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

/** Hash of the guest agent this build ships, so an image built from an older one is
 *  refused at connect rather than failing later in ways that look like anything else. */
const AGENT_VERSION = createHash("sha256")
  .update(readFileSync(new URL("../guest/agent.py", import.meta.url)))
  .digest("hex")
  .slice(0, 12);

/**
 * Where the ready-to-restore snapshot for a workspace lives, or undefined if snapshots
 * are off. Keyed by the workspace path, because the guest agent's root is baked into
 * guest memory, and by the kernel and rootfs, because the memory in a snapshot refers to
 * the image it was taken from -- restoring over a rebuilt image gives a guest whose
 * memory describes files that are no longer there.
 */
export function snapshotPaths(o: FirecrackerOptions, workspace: string): { state: string; mem: string } | undefined {
  if (!o.snapshotDir) return undefined;
  const h = createHash("sha256").update(path.resolve(workspace));
  for (const f of [o.kernel, o.rootfs]) {
    const st = statSync(f, { throwIfNoEntry: false });
    h.update(`${f}:${st ? `${st.size}:${Math.floor(st.mtimeMs)}` : "missing"}`);
  }
  // the machine is part of the snapshot: restoring one taken at a different size or core
  // count gives a guest whose memory map does not match the VM around it
  h.update(`machine:${o.vcpus ?? 2}:${o.memMiB ?? 1024}`);
  if (o.network) h.update(`net:${o.network.guestIp}:${o.network.gateway}`);
  const key = h.digest("hex").slice(0, 16);
  mkdirSync(o.snapshotDir, { recursive: true });
  return { state: path.join(o.snapshotDir, `${key}.state`), mem: path.join(o.snapshotDir, `${key}.mem`) };
}

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
  private guest = "";
  private dir = "";
  private apiSock = "";
  /** Snapshot of this session, written when it is suspended. Holds whatever the guest
   *  has accumulated -- installed packages, caches -- which the workspace does not cover. */
  private sessionSnap?: { state: string; mem: string };
  private sessionBase?: string;
  private sessionGen = 0;
  /** Releases that threw the machine away because it held nothing worth keeping. */
  discards = 0;
  /** True when the last boot() restored a snapshot rather than cold booting. */
  lastBootWasRestore = false;

  constructor(private o: FirecrackerOptions) {}

  async boot(workspace: string): Promise<void> {
    this.workspace = workspace;
    this.guest = this.o.guestWorkspace ?? workspace;
    if (this.sessionSnap) {
      // resume this session rather than start a clean one: anything installed is in here
      this.lastBootWasRestore = true;
      await this.restore(this.sessionSnap);
      await this.probeAgent();
      await this.openClient();
      return;
    }
    const snap = this.snapPaths(this.guest);
    if (snap && existsSync(snap.state) && existsSync(snap.mem)) {
      this.lastBootWasRestore = true;
      await this.restore(snap);
      await this.probeAgent();
      await this.openClient();
      return;
    }
    this.lastBootWasRestore = false;
    const apiSock = await this.coldBoot(this.guest);
    if (snap) await this.prime(apiSock, snap);
    await this.openClient();
  }

  private snapPaths(workspace: string) {
    return snapshotPaths(this.o, workspace);
  }

  /** firecracker binds the vsock socket relative to its cwd, so a relative uds_path in the
   * snapshot lets many restored VMs coexist instead of fighting over one absolute path. */
  private spawnFc(): string {
    this.dir = mkdtempSync(path.join(tmpdir(), "sandroute-fc-"));
    const apiSock = (this.apiSock = path.join(this.dir, "api.sock"));
    // setpriv execs into firecracker, so this is still its pid. The kernel then kills it when
    // this process dies, however it dies: a crashed control plane must not leak microVMs.
    this.proc = spawn("setpriv", ["--pdeathsig", "kill", this.o.bin ?? "firecracker", "--api-sock", apiSock], {
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
    this.client = new AgentClient(() => vsockConnect(this.vsockPath, this.o.agentPort ?? 5000), this.workspace, this.o.maxFileBytes);
    this.client.onConflict = (p) => this.onConflict?.(p);
    this.client.expectAgent = AGENT_VERSION;
    this.client.syncClock = true;
    await this.client.open();
  }

  async exec(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<VmResult> {
    const r = await this.client!.exec(command, opts.cwd, opts.env);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
  }

  busy() {
    return this.client!.busy();
  }

  onConflict?: (paths: string[]) => void;

  /**
   * Hand the machine back without losing what is in it. A pristine restore throws away
   * everything the guest accumulated -- an agent that installed a dependency would find
   * it gone -- so the session is written to its own snapshot and the next boot resumes
   * from there. fsync is skipped: this has to survive a release, not a host crash.
   */
  async suspend(): Promise<void> {
    if (!this.proc) return;
    // Nothing outside the workspace to keep: the workspace is the host's and is pushed back on
    // the next wake, so the machine can simply be thrown away. The next boot restores the
    // shared pristine snapshot, which costs no disk and writes nothing. Only a guest that has
    // installed or written something is worth the whole of its memory on disk.
    if (this.sessionSnap === undefined && (await this.client?.state().catch(() => undefined))?.files === 0) {
      this.discards++;
      await this.halt();
      return;
    }
    const dir = this.o.sessionDir ?? this.o.snapshotDir ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    // Two slots taken in turn. A VM restored from a file keeps it mapped, so writing the
    // next snapshot over the same file rewrites memory the guest may still read from it.
    this.sessionBase ??= path.join(dir, `session-${randomUUID()}`);
    this.sessionGen ^= 1;
    const base = { state: `${this.sessionBase}.${this.sessionGen}.state`, mem: `${this.sessionBase}.${this.sessionGen}.mem` };
    const previous = this.sessionSnap;
    // Hang up first. A vsock connection does not survive a snapshot, and a guest
    // restored while holding one comes back with a dead socket and never accepts again.
    this.client?.close();
    this.client = undefined;
    await sleep(50);
    await api(this.apiSock, "/vm", { state: "Paused" }, "PATCH");
    await api(this.apiSock, "/snapshot/create", {
      snapshot_type: "Full", snapshot_path: base.state, mem_file_path: base.mem, sync_snapshot_files: false,
    });
    this.sessionSnap = base;
    await this.halt();
    for (const f of [previous?.state, previous?.mem]) if (f) rmSync(f, { force: true });
  }

  async stop(): Promise<void> {
    await this.halt();
    for (const f of [this.sessionSnap?.state, this.sessionSnap?.mem]) if (f) rmSync(f, { force: true });
    this.sessionSnap = undefined;
  }

  /** Kill firecracker and wait for it to go: a tap is exclusive, so starting the next VM
   *  before this process has released its fd fails with "Resource busy". */
  private async halt(): Promise<void> {
    this.client?.close();
    this.client = undefined;
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null && !proc.killed) {
      const gone = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGKILL");
      await Promise.race([gone, sleep(2000)]);
    }
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
