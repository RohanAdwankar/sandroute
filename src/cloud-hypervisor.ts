// The same lifecycle as the Firecracker backend, driven through Cloud Hypervisor's REST API.
//
// Cloud Hypervisor is the VMM Meta's Muse runs. It differs where it matters here: its devices
// are PCI, so the guest needs a kernel with PCI (the Firecracker one is MMIO-only); its balloon
// does free page reporting too; and a snapshot is a directory, whose memory file a restore can
// map copy on write, so many VMs can share one snapshot as they do with Firecracker.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { FirecrackerVm, VSOCK_REL, api, get, sleep, type FirecrackerOptions } from "./firecracker.js";

const V1 = "/api/v1";

/** The body of vm.create. Pure, so it can be tested without KVM. */
export function buildChConfig(o: FirecrackerOptions, workspace: string): unknown {
  if (o.network) throw new Error("the Cloud Hypervisor backend has no network support yet");
  const port = o.agentPort ?? 5000;
  return {
    payload: {
      kernel: o.kernel,
      cmdline: `console=ttyS0 root=/dev/vda ro rootfstype=ext4 panic=1 sandroute.workspace=${workspace} sandroute.port=${port} ${o.bootArgs ?? ""}`.trim(),
    },
    // read-only for the same reason as under Firecracker: one image backs every VM
    disks: [{ path: o.rootfs, readonly: true, image_type: "Raw" }],
    cpus: { boot_vcpus: o.vcpus ?? 2, max_vcpus: o.vcpus ?? 2 },
    memory: { size: (o.memMiB ?? 1024) * 2 ** 20 },
    vsock: { cid: 3, socket: VSOCK_REL },
    serial: { mode: "Null" },   // not Off: with no UART the guest blocks writing its console
    console: { mode: "Off" },
    ...(o.balloon ? { balloon: { size: 0, deflate_on_oom: true, free_page_reporting: true } } : {}),
  };
}

export class CloudHypervisorVm extends FirecrackerVm {
  override readonly name = "cloud-hypervisor";

  protected override vmmCommand(apiSock: string): string[] {
    return [this.o.bin ?? "cloud-hypervisor", "--api-socket", apiSock];
  }

  protected override async waitVmm(sock: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try { await get(sock, `${V1}/vmm.ping`); return; } catch { await sleep(20); }
    }
    throw new Error("cloud-hypervisor api never came up");
  }

  protected override async configureAndStart(apiSock: string, workspace: string): Promise<void> {
    await api(apiSock, `${V1}/vm.create`, buildChConfig(this.o, workspace));
    await api(apiSock, `${V1}/vm.boot`);
  }

  /** A snapshot is a directory; its memory file is inside it. */
  protected override snapFiles(base: string) {
    return { state: `${base}.state`, mem: path.join(`${base}.state`, "memory-ranges") };
  }

  protected override snapPaths(workspace: string) {
    const s = super.snapPaths(workspace);
    return s && { state: s.state, mem: path.join(s.state, "memory-ranges") };
  }

  protected override async pauseAndSnapshot(snap: { state: string; mem: string }): Promise<void> {
    await api(this.apiSock, `${V1}/vm.pause`);
    mkdirSync(snap.state, { recursive: true });
    await api(this.apiSock, `${V1}/vm.snapshot`, { destination_url: `file://${snap.state}` });
  }

  protected override async resume(): Promise<void> {
    await api(this.apiSock, `${V1}/vm.resume`);
  }

  protected override async load(apiSock: string, snap: { state: string; mem: string }): Promise<void> {
    await api(apiSock, `${V1}/vm.restore`, { source_url: `file://${snap.state}`, memory_restore_mode: "CopyOnWrite" });
    await api(apiSock, `${V1}/vm.resume`);
  }
}

