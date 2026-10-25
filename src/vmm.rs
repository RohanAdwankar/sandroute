//! A microVM through Firecracker or Cloud Hypervisor, with the lifecycle written once: boot, prime a shared snapshot, restore from it,
//! release by throwing the machine away when it holds nothing worth keeping and by snapshotting it when it does.
//!
//! Cloud Hypervisor is the VMM Meta's Muse runs. It differs where it matters here: its devices are PCI, so the guest needs a kernel with
//! PCI (the Firecracker one is MMIO-only); its balloon does free page reporting too; and a snapshot is a directory, whose memory file a
//! restore can map copy on write, so many VMs can share one snapshot as they do with Firecracker.
use crate::agent::{expected_agent, AgentClient, OpenOptions};
use crate::vm::{Live, VmBackend, VmResult};
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vmm {
    Firecracker,
    CloudHypervisor,
}

/// Give the guest a network. It behaves like any other machine: it can reach the internet and install what it needs, and it cannot reach
/// the host. Needs a tap device, which needs CAP_NET_ADMIN, so it is set up once by an operator (scripts/net-setup.sh). Left unset, the
/// guest has loopback only and an agent that reaches for a package manager is stuck.
#[derive(Clone, Debug)]
pub struct Network {
    /// Host tap device, e.g. "sr-tap0".
    pub tap: String,
    /// Guest address with prefix, e.g. "172.16.0.2/30".
    pub guest_ip: String,
    /// The host end of the tap, e.g. "172.16.0.1".
    pub gateway: String,
    /// Resolver the guest should use. Defaults to 1.1.1.1.
    pub dns: Option<String>,
    pub mac: Option<String>,
}

#[derive(Clone, Debug)]
pub struct VmOptions {
    pub vmm: Vmm,
    /// Path to the VMM binary.
    pub bin: Option<String>,
    /// Uncompressed vmlinux.
    pub kernel: String,
    /// ext4 image containing bash and the guest agent started at boot. Mounted read-only, so its init must mount a tmpfs at the workspace path.
    pub rootfs: String,
    pub vcpus: Option<u32>,
    pub mem_mib: Option<u32>,
    /// Extra kernel args appended to the defaults.
    pub boot_args: Option<String>,
    pub agent_port: Option<u32>,
    /// Pipe the guest console to this process. Off by default, and the only way to see why a boot failed.
    pub console: bool,
    /// Refuse to sync a file larger than this. Defaults to 64MiB.
    pub max_file_bytes: Option<u64>,
    /// Where the workspace lives inside the guest, when that is not where it lives on the host. Every tenant can then see /work while
    /// their host directories differ, which is what lets one pristine snapshot serve all of them: the guest agent's root is baked into the
    /// snapshot, so it is keyed by this path and not by the host's.
    pub guest_workspace: Option<String>,
    /// Where suspended sessions are written. Defaults to snapshot_dir.
    pub session_dir: Option<PathBuf>,
    pub network: Option<Network>,
    /// Keep a booted-and-ready snapshot here and restore from it instead of cold booting. The first boot for a workspace primes it; every
    /// boot after that is a restore, which is what makes releasing the VM mid-turn cheap enough to be worth doing.
    pub snapshot_dir: Option<PathBuf>,
    /// Give memory the guest has freed back to the host as it frees it (virtio-balloon free page reporting), so a resident VM costs what it
    /// holds and not the most it has ever held. The device is part of the snapshot, so it is part of the snapshot's key.
    pub balloon: bool,
}

impl VmOptions {
    pub fn new(vmm: Vmm, kernel: impl Into<String>, rootfs: impl Into<String>) -> Self {
        VmOptions {
            vmm, bin: None, kernel: kernel.into(), rootfs: rootfs.into(), vcpus: None, mem_mib: None, boot_args: None, agent_port: None, console: false,
            max_file_bytes: None, guest_workspace: None, session_dir: None, network: None, snapshot_dir: None, balloon: false,
        }
    }
}

const VSOCK_REL: &str = "v.sock";
const V1: &str = "/api/v1";

/// The ordered Firecracker API calls that configure and start a VM. Pure, so it can be tested without KVM.
pub fn build_config(o: &VmOptions, vsock_path: &str, workspace: &str) -> Vec<(String, Value)> {
    let port = o.agent_port.unwrap_or(5000);
    let net_args = o.network.as_ref().map(|n| format!(" sandroute.ip={} sandroute.gw={} sandroute.dns={}", n.guest_ip, n.gateway, n.dns.as_deref().unwrap_or("1.1.1.1"))).unwrap_or_default();
    let boot_args = format!("console=ttyS0 reboot=k panic=1 pci=off sandroute.workspace={workspace} sandroute.port={port}{net_args} {}", o.boot_args.as_deref().unwrap_or("")).trim().to_string();
    let mut steps = vec![
        ("/boot-source".to_string(), json!({"kernel_image_path": o.kernel, "boot_args": boot_args})),
        // Read-only, for two reasons. A writable root means one image cannot back two VMs at once, and restoring a snapshot over a backing
        // file that a later VM has since written corrupts the filesystem: the restored guest's cached ext4 metadata no longer matches the
        // disk. The guest is disposable and the host owns the workspace, so the image never needs to be written; the rootfs must mount a
        // tmpfs at the workspace path instead.
        ("/drives/rootfs".to_string(), json!({"drive_id": "rootfs", "path_on_host": o.rootfs, "is_root_device": true, "is_read_only": true})),
        ("/machine-config".to_string(), json!({"vcpu_count": o.vcpus.unwrap_or(2), "mem_size_mib": o.mem_mib.unwrap_or(1024)})),
        ("/vsock".to_string(), json!({"guest_cid": 3, "uds_path": vsock_path})),
    ];
    if let Some(n) = &o.network {
        steps.push(("/network-interfaces/eth0".to_string(), json!({"iface_id": "eth0", "guest_mac": n.mac.as_deref().unwrap_or("06:00:ac:10:00:02"), "host_dev_name": n.tap})));
    }
    if o.balloon {
        steps.push(("/balloon".to_string(), json!({"amount_mib": 0, "deflate_on_oom": true, "free_page_reporting": true})));
    }
    steps.push(("/actions".to_string(), json!({"action_type": "InstanceStart"})));
    steps
}

/// The body of Cloud Hypervisor's vm.create. Pure, so it can be tested without KVM.
pub fn build_ch_config(o: &VmOptions, workspace: &str) -> Result<Value> {
    if o.network.is_some() {
        bail!("the Cloud Hypervisor backend has no network support yet");
    }
    let port = o.agent_port.unwrap_or(5000);
    let mut c = json!({
        "payload": {
            "kernel": o.kernel,
            "cmdline": format!("console=ttyS0 root=/dev/vda ro rootfstype=ext4 panic=1 sandroute.workspace={workspace} sandroute.port={port} {}", o.boot_args.as_deref().unwrap_or("")).trim(),
        },
        // read-only for the same reason as under Firecracker: one image backs every VM
        "disks": [{"path": o.rootfs, "readonly": true, "image_type": "Raw"}],
        "cpus": {"boot_vcpus": o.vcpus.unwrap_or(2), "max_vcpus": o.vcpus.unwrap_or(2)},
        "memory": {"size": o.mem_mib.unwrap_or(1024) as u64 * (1 << 20)},
        "vsock": {"cid": 3, "socket": VSOCK_REL},
        // not Off: with no UART the guest blocks writing its console and the agent never comes up
        "serial": {"mode": "Null"},
        "console": {"mode": "Off"},
    });
    if o.balloon {
        c["balloon"] = json!({"size": 0, "deflate_on_oom": true, "free_page_reporting": true});
    }
    Ok(c)
}

/// Where the ready-to-restore snapshot for a workspace lives, or None if snapshots are off. Keyed by the workspace path, because the guest
/// agent's root is baked into guest memory, and by the kernel and rootfs, because the memory in a snapshot refers to the image it was
/// taken from: restoring over a rebuilt image gives a guest whose memory describes files that are no longer there.
pub fn snapshot_paths(o: &VmOptions, workspace: &str) -> Option<(PathBuf, PathBuf)> {
    let dir = o.snapshot_dir.as_ref()?;
    let mut h = Sha256::new();
    h.update(std::path::absolute(workspace).unwrap_or_else(|_| PathBuf::from(workspace)).to_string_lossy().as_bytes());
    for f in [&o.kernel, &o.rootfs] {
        let sig = std::fs::metadata(f).ok().map(|m| {
            use std::os::unix::fs::MetadataExt;
            format!("{}:{}", m.len(), m.mtime() * 1000 + m.mtime_nsec() / 1_000_000)
        });
        h.update(format!("{f}:{}", sig.unwrap_or_else(|| "missing".into())));
    }
    // the machine is part of the snapshot: restoring one taken at a different size or core count gives a guest whose memory map does
    // not match the VM around it, and so is the kernel command line, which is baked into the guest
    h.update(format!("machine:{}:{}", o.vcpus.unwrap_or(2), o.mem_mib.unwrap_or(1024)));
    h.update(format!("vmm:{:?}", o.vmm));
    if o.balloon {
        h.update("balloon");
    }
    if let Some(b) = &o.boot_args {
        h.update(format!("args:{b}"));
    }
    if let Some(n) = &o.network {
        h.update(format!("net:{}:{}", n.guest_ip, n.gateway));
    }
    let key: String = h.finalize()[..8].iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir).ok()?;
    let state = dir.join(format!("{key}.state"));
    Some(snap_files_of(o.vmm, &state, &dir.join(format!("{key}.mem"))))
}

/// A Cloud Hypervisor snapshot is a directory, and its memory file is inside it.
fn snap_files_of(vmm: Vmm, state: &Path, mem: &Path) -> (PathBuf, PathBuf) {
    match vmm {
        Vmm::Firecracker => (state.to_path_buf(), mem.to_path_buf()),
        Vmm::CloudHypervisor => (state.to_path_buf(), state.join("memory-ranges")),
    }
}

/// One HTTP/1.1 request to a VMM's API over its unix socket. The reply is read by its Content-Length: the VMM does not always close the
/// connection when it has answered.
async fn api(sock: &Path, method: &str, path: &str, body: Option<&Value>) -> Result<()> {
    let mut s = BufReader::new(UnixStream::connect(sock).await?);
    let data = body.map(|b| b.to_string()).unwrap_or_default();
    s.get_mut().write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).as_bytes()).await?;
    let mut status_line = String::new();
    s.read_line(&mut status_line).await?;
    let status: u16 = status_line.split(' ').nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| anyhow!("vmm {method} {path}: no reply"))?;
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if s.read_line(&mut h).await? == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut reply = vec![0u8; len];
    s.read_exact(&mut reply).await?;
    if status >= 300 {
        bail!("vmm {method} {path}: {status} {}", String::from_utf8_lossy(&reply));
    }
    Ok(())
}

/// A guest's vsock is a host unix socket: connect, send "CONNECT <port>", expect "OK ...".
pub async fn vsock_connect(uds: &Path, port: u32) -> Result<UnixStream> {
    let mut s = UnixStream::connect(uds).await?;
    s.write_all(format!("CONNECT {port}\n").as_bytes()).await?;
    // Until the guest agent binds the port, the VMM answers a CONNECT by closing with no reply.
    let mut r = BufReader::new(s);
    let mut line = String::new();
    if r.read_line(&mut line).await? == 0 {
        bail!("vsock port {port} closed before the handshake");
    }
    if !line.starts_with("OK") {
        bail!("vsock handshake: {}", line.trim());
    }
    Ok(r.into_inner())
}

#[derive(Default)]
struct Inner {
    proc: Option<Child>,
    client: Option<Arc<AgentClient>>,
    workspace: PathBuf,
    guest: String,
    /// the VMM's working directory: its api socket and its vsock socket live here
    dir: PathBuf,
    api_sock: PathBuf,
    /// Snapshot of this session, written when it is suspended. Holds whatever the guest has accumulated (installed packages, caches),
    /// which the workspace does not cover.
    session_snap: Option<(PathBuf, PathBuf)>,
    session_base: Option<PathBuf>,
    session_gen: u8,
    scratch_root: Option<PathBuf>,
}

pub struct MicroVm {
    o: VmOptions,
    inner: tokio::sync::Mutex<Inner>,
    on_conflict: Arc<Mutex<Option<Box<dyn Fn(Vec<String>) + Send + Sync>>>>,
    /// Releases that threw the machine away because it held nothing worth keeping.
    pub discards: AtomicU64,
    /// True when the last boot() restored a snapshot rather than cold booting.
    pub last_boot_was_restore: std::sync::atomic::AtomicBool,
}

impl MicroVm {
    pub fn new(o: VmOptions) -> Self {
        MicroVm { o, inner: Default::default(), on_conflict: Default::default(), discards: AtomicU64::new(0), last_boot_was_restore: Default::default() }
    }

    fn vmm_bin(&self) -> String {
        self.o.bin.clone().unwrap_or_else(|| if self.o.vmm == Vmm::Firecracker { "firecracker" } else { "cloud-hypervisor" }.to_string())
    }

    /// The VMM binds the vsock socket relative to its cwd, so a relative path in the snapshot lets many restored VMs coexist instead of
    /// fighting over one absolute path.
    fn spawn_vmm(&self, i: &mut Inner) -> Result<()> {
        i.dir = tempfile::Builder::new().prefix("sandroute-vm-").tempdir()?.keep();
        i.api_sock = i.dir.join("api.sock");
        let flag = if self.o.vmm == Vmm::Firecracker { "--api-sock" } else { "--api-socket" };
        // setpriv execs into the VMM, so this is still its pid. The kernel then kills it when this process dies, however it dies: a
        // crashed control plane must not leak microVMs.
        let mut c = Command::new("setpriv");
        c.args(["--pdeathsig", "kill", &self.vmm_bin(), flag]).arg(&i.api_sock).current_dir(&i.dir).stdin(std::process::Stdio::null());
        if !self.o.console {
            c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
        i.proc = Some(c.spawn()?);
        Ok(())
    }

    async fn wait_vmm(&self, i: &Inner, read_only: bool) -> Result<()> {
        for _ in 0..200 {
            let r = match (self.o.vmm, read_only) {
                (Vmm::CloudHypervisor, _) => api(&i.api_sock, "GET", &format!("{V1}/vmm.ping"), None).await,
                (Vmm::Firecracker, true) => api(&i.api_sock, "GET", "/version", None).await,
                (Vmm::Firecracker, false) => api(&i.api_sock, "PUT", "/machine-config", Some(&json!({"vcpu_count": 1, "mem_size_mib": 128}))).await,
            };
            if r.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        bail!("{} api never came up", self.name())
    }

    async fn configure_and_start(&self, i: &Inner, workspace: &str) -> Result<()> {
        match self.o.vmm {
            Vmm::Firecracker => {
                for (path, body) in build_config(&self.o, VSOCK_REL, workspace) {
                    api(&i.api_sock, "PUT", &path, Some(&body)).await?;
                }
            }
            Vmm::CloudHypervisor => {
                api(&i.api_sock, "PUT", &format!("{V1}/vm.create"), Some(&build_ch_config(&self.o, workspace)?)).await?;
                api(&i.api_sock, "PUT", &format!("{V1}/vm.boot"), None).await?;
            }
        }
        Ok(())
    }

    async fn pause_and_snapshot(&self, i: &Inner, snap: &(PathBuf, PathBuf), sync: bool) -> Result<()> {
        match self.o.vmm {
            Vmm::Firecracker => {
                api(&i.api_sock, "PATCH", "/vm", Some(&json!({"state": "Paused"}))).await?;
                let mut body = json!({"snapshot_type": "Full", "snapshot_path": snap.0, "mem_file_path": snap.1});
                if !sync {
                    body["sync_snapshot_files"] = json!(false);
                }
                api(&i.api_sock, "PUT", "/snapshot/create", Some(&body)).await
            }
            Vmm::CloudHypervisor => {
                api(&i.api_sock, "PUT", &format!("{V1}/vm.pause"), None).await?;
                std::fs::create_dir_all(&snap.0)?;
                api(&i.api_sock, "PUT", &format!("{V1}/vm.snapshot"), Some(&json!({"destination_url": format!("file://{}", snap.0.display())}))).await
            }
        }
    }

    async fn resume(&self, i: &Inner) -> Result<()> {
        match self.o.vmm {
            Vmm::Firecracker => api(&i.api_sock, "PATCH", "/vm", Some(&json!({"state": "Resumed"}))).await,
            Vmm::CloudHypervisor => api(&i.api_sock, "PUT", &format!("{V1}/vm.resume"), None).await,
        }
    }

    async fn load(&self, i: &Inner, snap: &(PathBuf, PathBuf)) -> Result<()> {
        match self.o.vmm {
            Vmm::Firecracker => {
                api(&i.api_sock, "PUT", "/snapshot/load", Some(&json!({"snapshot_path": snap.0, "mem_backend": {"backend_type": "File", "backend_path": snap.1}, "resume_vm": true}))).await
            }
            Vmm::CloudHypervisor => {
                api(&i.api_sock, "PUT", &format!("{V1}/vm.restore"), Some(&json!({"source_url": format!("file://{}", snap.0.display()), "memory_restore_mode": "CopyOnWrite"}))).await?;
                api(&i.api_sock, "PUT", &format!("{V1}/vm.resume"), None).await
            }
        }
    }

    async fn cold_boot(&self, i: &mut Inner, guest: &str) -> Result<()> {
        self.spawn_vmm(i)?;
        self.wait_vmm(i, false).await?;
        self.configure_and_start(i, guest).await?;
        self.probe_agent(i).await
    }

    /// Snapshot the guest while its workspace is still empty, so a restore is always a clean machine. The host owns the workspace and
    /// re-pushes it on wake anyway. There must be no live vsock connection: it does not survive the snapshot, and the guest would come
    /// back holding a dead one. probe_agent() already closed its socket, this just gives the agent a moment to get back to accept().
    async fn prime(&self, i: &Inner, snap: &(PathBuf, PathBuf)) -> Result<()> {
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.pause_and_snapshot(i, snap, true).await?;
        self.resume(i).await
    }

    async fn restore(&self, i: &mut Inner, snap: &(PathBuf, PathBuf)) -> Result<()> {
        self.spawn_vmm(i)?;
        self.wait_vmm(i, true).await?;
        let _ = std::fs::remove_file(i.dir.join(VSOCK_REL));
        self.load(i, snap).await
    }

    /// Wait for the agent to answer, then hang up. Readiness only, no lasting connection.
    async fn probe_agent(&self, i: &Inner) -> Result<()> {
        let mut last = anyhow!("no attempt");
        for _ in 0..300 {
            match vsock_connect(&i.dir.join(VSOCK_REL), self.o.agent_port.unwrap_or(5000)).await {
                Ok(_) => return Ok(()),
                Err(e) => {
                    last = e;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
        bail!("guest agent never came up: {last}")
    }

    /// Where the host keeps the guest's /tmp, so releasing the guest does not lose it.
    fn scratch_dir(&self, i: &mut Inner) -> PathBuf {
        i.scratch_root
            .get_or_insert_with(|| {
                let base = self.o.session_dir.clone().unwrap_or_else(|| tempfile::Builder::new().prefix("sandroute-scratch-").tempdir().map(|d| d.keep()).unwrap_or_else(|_| std::env::temp_dir()));
                base.join("scratch")
            })
            .clone()
    }

    async fn open_client(&self, i: &mut Inner) -> Result<()> {
        let stream = vsock_connect(&i.dir.join(VSOCK_REL), self.o.agent_port.unwrap_or(5000)).await?;
        let opts = OpenOptions { expect_agent: Some(expected_agent()), sync_clock: true, max_file_bytes: self.o.max_file_bytes, scratch_dir: Some(self.scratch_dir(i)) };
        let client = AgentClient::open(stream, &i.workspace, opts).await?;
        let cb = self.on_conflict.clone();
        client.on_conflict(move |p| {
            if let Some(f) = &*cb.lock().unwrap() {
                f(p)
            }
        });
        i.client = Some(Arc::new(client));
        Ok(())
    }

    /// Kill the VMM and wait for it to go: a tap is exclusive, so starting the next VM before this process has released its fd fails with
    /// "Resource busy".
    async fn halt(&self, i: &mut Inner) {
        if let Some(c) = i.client.take() {
            c.close();
        }
        if let Some(mut p) = i.proc.take() {
            let _ = p.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), p.wait()).await;
        }
        if !i.dir.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&i.dir);
        }
    }

    fn snap_paths(&self, guest: &str) -> Option<(PathBuf, PathBuf)> {
        snapshot_paths(&self.o, guest)
    }

    fn client(i: &Inner) -> Result<Arc<AgentClient>> {
        i.client.clone().ok_or_else(|| anyhow!("the machine is not up"))
    }
}

#[async_trait]
impl VmBackend for MicroVm {
    fn name(&self) -> String {
        if self.o.vmm == Vmm::Firecracker { "firecracker" } else { "cloud-hypervisor" }.to_string()
    }

    async fn boot(&self, workspace: &Path) -> Result<()> {
        let mut i = self.inner.lock().await;
        i.workspace = workspace.to_path_buf();
        let guest = self.o.guest_workspace.clone().unwrap_or_else(|| workspace.to_string_lossy().to_string());
        i.guest = guest.clone();
        let restore_from = match i.session_snap.clone() {
            // resume this session rather than start a clean one: anything installed is in here
            Some(s) => Some(s),
            None => self.snap_paths(&guest).filter(|(state, mem)| state.exists() && mem.exists()),
        };
        if let Some(snap) = restore_from {
            self.last_boot_was_restore.store(true, Ordering::Relaxed);
            self.restore(&mut i, &snap).await?;
            self.probe_agent(&i).await?;
            return self.open_client(&mut i).await;
        }
        self.last_boot_was_restore.store(false, Ordering::Relaxed);
        self.cold_boot(&mut i, &guest).await?;
        if let Some(snap) = self.snap_paths(&guest) {
            self.prime(&i, &snap).await?;
        }
        self.open_client(&mut i).await
    }

    async fn exec(&self, command: &str, cwd: &str, env: Option<&BTreeMap<String, String>>) -> Result<VmResult> {
        let client = Self::client(&*self.inner.lock().await)?;
        let r = client.exec(command, cwd, env).await?;
        Ok(VmResult { stdout: r.stdout, stderr: r.stderr, exit_code: r.code })
    }

    async fn busy(&self) -> Result<Option<Live>> {
        let client = Self::client(&*self.inner.lock().await)?;
        let b = client.busy().await?;
        Ok(Some(Live { busy: b.busy, procs: b.procs.iter().map(|p| (p["pid"].as_i64().unwrap_or(0), p["comm"].as_str().unwrap_or("").to_string())).collect() }))
    }

    fn on_conflict(&self, f: Box<dyn Fn(Vec<String>) + Send + Sync>) {
        *self.on_conflict.lock().unwrap() = Some(f);
    }

    /// Hand the machine back without losing what is in it. A pristine restore throws away everything the guest accumulated (an agent that
    /// installed a dependency would find it gone), so the session is written to its own snapshot and the next boot resumes from there.
    async fn suspend(&self) -> Result<bool> {
        let mut i = self.inner.lock().await;
        if i.proc.is_none() {
            return Ok(true);
        }
        // Nothing outside the workspace to keep: the workspace and the guest's scratch space are the host's and are pushed back on the
        // next wake, so the machine can simply be thrown away. The next boot restores the shared pristine snapshot, which costs no disk
        // and writes nothing. Only a guest that has installed or written something is worth the whole of its memory on disk.
        if i.session_snap.is_none() {
            if let Some(c) = &i.client {
                if matches!(c.state().await, Ok((0, _))) {
                    self.discards.fetch_add(1, Ordering::Relaxed);
                    self.halt(&mut i).await;
                    return Ok(true);
                }
            }
        }
        let dir = self.o.session_dir.clone().or_else(|| self.o.snapshot_dir.clone()).unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&dir)?;
        // Two slots taken in turn. A VM restored from a file keeps it mapped, so writing the next snapshot over the same file rewrites
        // memory the guest may still read from it.
        let base = i.session_base.get_or_insert_with(|| dir.join(format!("session-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)))).clone();
        i.session_gen ^= 1;
        let named = |ext: &str| PathBuf::from(format!("{}.{}.{ext}", base.display(), i.session_gen));
        let next = snap_files_of(self.o.vmm, &named("state"), &named("mem"));
        let previous = i.session_snap.clone();
        // Hang up first. A vsock connection does not survive a snapshot, and a guest restored while holding one comes back with a dead
        // socket and never accepts again.
        if let Some(c) = i.client.take() {
            c.close();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.pause_and_snapshot(&i, &next, false).await?;
        i.session_snap = Some(next);
        self.halt(&mut i).await;
        for f in previous.into_iter().flat_map(|(a, b)| [a, b]) {
            let _ = std::fs::remove_dir_all(&f).or_else(|_| std::fs::remove_file(&f));
        }
        Ok(true)
    }

    fn clear_scratch(&self) {
        if let Ok(i) = self.inner.try_lock() {
            if let Some(root) = &i.scratch_root {
                for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
                    let p = e.path();
                    let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
                }
            }
        }
    }

    async fn stop(&self) -> Result<()> {
        let mut i = self.inner.lock().await;
        self.halt(&mut i).await;
        for f in i.session_snap.take().into_iter().flat_map(|(a, b)| [a, b]) {
            let _ = std::fs::remove_dir_all(&f).or_else(|_| std::fs::remove_file(&f));
        }
        if let Some(root) = i.scratch_root.take() {
            let _ = std::fs::remove_dir_all(if self.o.session_dir.is_some() { root } else { root.parent().map(Path::to_path_buf).unwrap_or(root) });
        }
        Ok(())
    }
}
