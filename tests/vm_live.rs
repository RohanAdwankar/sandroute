//! Against real microVMs, so they need KVM, Firecracker or Cloud Hypervisor, and the image from scripts/build-rootfs.sh.
//!   cargo test --test vm_live -- --ignored
use sandroute::vm::VmBackend;
use sandroute::vmm::{MicroVm, VmOptions, Vmm};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap())
}

fn options(vmm: Vmm, snapshots: &std::path::Path, sessions: &std::path::Path) -> VmOptions {
    let assets = std::env::var("SANDROUTE_ASSETS").map(PathBuf::from).unwrap_or_else(|_| home().join("fcassets"));
    let kata = home().join("kata/root/opt/kata");
    let mut o = match vmm {
        Vmm::Firecracker => {
            let mut o = VmOptions::new(vmm, assets.join("vmlinux-6.1.128").to_string_lossy(), assets.join("rootfs.ext4").to_string_lossy());
            o.bin = Some(assets.join("firecracker").to_string_lossy().into());
            o
        }
        Vmm::CloudHypervisor => {
            // Cloud Hypervisor needs a guest kernel with PCI, which the Firecracker one is built without
            let mut o = VmOptions::new(vmm, kata.join("share/kata-containers/vmlinux.container").to_string_lossy(), assets.join("rootfs.ext4").to_string_lossy());
            o.bin = Some(kata.join("bin/cloud-hypervisor").to_string_lossy().into());
            o
        }
    };
    o.vcpus = Some(1);
    o.mem_mib = Some(256);
    o.guest_workspace = Some("/work".into());
    o.snapshot_dir = Some(snapshots.to_path_buf());
    o.session_dir = Some(sessions.to_path_buf());
    o.balloon = true;
    o
}

async fn scratch_survives_a_release(vmm: Vmm) {
    let (ws, snaps, sessions) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let vm = MicroVm::new(options(vmm, snaps.path(), sessions.path()));
    vm.boot(ws.path()).await.unwrap();
    assert!(!vm.last_boot_was_restore.load(Ordering::Relaxed), "the first boot primes the snapshot");
    let r = vm.exec("python3 -c \"open('/tmp/note.txt','w').write('kept across a release')\"; mkdir -p /tmp/d && echo deep > /tmp/d/x; echo hi > /work/in.txt; id -u", "/work", None).await.unwrap();
    assert_eq!((r.exit_code, r.stdout.trim()), (0, "0"), "{}", r.stderr);
    assert_eq!(std::fs::read_to_string(ws.path().join("in.txt")).unwrap(), "hi\n", "the workspace came back");
    assert!(vm.suspend().await.unwrap());
    assert_eq!(vm.discards.load(Ordering::Relaxed), 1, "a guest holding only scratch files is thrown away, not snapshotted");
    vm.boot(ws.path()).await.unwrap();
    assert!(vm.last_boot_was_restore.load(Ordering::Relaxed), "the second boot restores the shared snapshot");
    let r = vm.exec("cat /tmp/note.txt /tmp/d/x /work/in.txt", "/work", None).await.unwrap();
    assert_eq!(r.stdout, "kept across a releasedeep\nhi\n", "{}", r.stderr);
    vm.clear_scratch();
    let r = vm.exec("ls /tmp/note.txt 2>&1 | head -1", "/work", None).await.unwrap();
    assert!(r.stdout.contains("No such file"), "{}", r.stdout);
    vm.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "needs KVM and Firecracker"]
async fn firecracker_scratch_survives_a_release() {
    scratch_survives_a_release(Vmm::Firecracker).await;
}

#[tokio::test]
#[ignore = "needs KVM and Cloud Hypervisor"]
async fn cloud_hypervisor_scratch_survives_a_release() {
    scratch_survives_a_release(Vmm::CloudHypervisor).await;
}
