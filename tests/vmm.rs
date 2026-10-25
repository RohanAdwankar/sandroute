use sandroute::vmm::{build_ch_config, build_config, snapshot_paths, Network, VmOptions, Vmm};

fn fc() -> VmOptions {
    VmOptions::new(Vmm::Firecracker, "/k", "/r.ext4")
}

#[test]
fn firecracker_config_is_ordered_boot_source_drive_machine_vsock_then_start() {
    let steps = build_config(&fc(), "/v.sock", "/work");
    assert_eq!(steps.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["/boot-source", "/drives/rootfs", "/machine-config", "/vsock", "/actions"]);
    assert_eq!(steps.last().unwrap().1, serde_json::json!({"action_type": "InstanceStart"}));
    // a writable root cannot be shared by two VMs, and corrupts when a snapshot is restored over a backing file a later VM has written
    assert_eq!(steps[1].1["is_read_only"], true);
    assert!(!steps.iter().any(|s| s.0.starts_with("/network-interfaces")), "no nic unless asked for");
}

#[test]
fn a_configured_network_reaches_the_guest_as_a_nic_and_on_the_cmdline() {
    let mut o = fc();
    o.network = Some(Network { tap: "sr-tap0".into(), guest_ip: "172.16.0.2/30".into(), gateway: "172.16.0.1".into(), dns: None, mac: None });
    let steps = build_config(&o, "v.sock", "/work");
    assert_eq!(steps.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["/boot-source", "/drives/rootfs", "/machine-config", "/vsock", "/network-interfaces/eth0", "/actions"]);
    assert_eq!(steps[4].1, serde_json::json!({"iface_id": "eth0", "guest_mac": "06:00:ac:10:00:02", "host_dev_name": "sr-tap0"}));
    let args = steps[0].1["boot_args"].as_str().unwrap();
    assert!(args.contains("sandroute.ip=172.16.0.2/30 sandroute.gw=172.16.0.1 sandroute.dns=1.1.1.1"), "{args}");
}

#[test]
fn a_snapshot_is_not_reused_across_workspaces_or_across_rebuilt_images() {
    let d = tempfile::tempdir().unwrap();
    let (kernel, rootfs) = (d.path().join("vmlinux"), d.path().join("rootfs.ext4"));
    std::fs::write(&kernel, "k").unwrap();
    std::fs::write(&rootfs, "image one").unwrap();
    let opts = |mem: u32, vcpus: u32| {
        let mut o = VmOptions::new(Vmm::Firecracker, kernel.to_string_lossy(), rootfs.to_string_lossy());
        o.snapshot_dir = Some(d.path().join("snaps"));
        o.mem_mib = Some(mem);
        o.vcpus = Some(vcpus);
        o
    };
    let key = |ws: &str| snapshot_paths(&opts(1024, 2), ws).unwrap().0;
    let first = key("/work/one");
    assert_eq!(first, key("/work/one"), "the same inputs name the same snapshot");
    assert_ne!(first, key("/work/two"), "a different workspace gets its own");
    let sized = |m, v| snapshot_paths(&opts(m, v), "/work/one").unwrap().0;
    assert_ne!(sized(256, 1), sized(1024, 1), "a different amount of memory is a different machine");
    assert_ne!(sized(256, 1), sized(256, 2), "and so is a different number of cores");
    assert_eq!(sized(256, 1), sized(256, 1));
    // a rebuilt image: a different length, so a different signature whatever the clock says
    std::fs::write(&rootfs, "image two, rebuilt and a different length").unwrap();
    assert_ne!(first, key("/work/one"), "a rebuilt image must not restore a snapshot of the old one");
    let mut off = opts(1024, 2);
    off.snapshot_dir = None;
    assert!(snapshot_paths(&off, "/work/one").is_none(), "no snapshot dir, no snapshot");
}

#[test]
fn a_balloon_returns_freed_guest_memory_and_a_snapshot_taken_without_one_is_not_restored_with_one() {
    let mut o = fc();
    o.balloon = true;
    let steps = build_config(&o, "/v.sock", "/work");
    let at = |p: &str| steps.iter().position(|s| s.0 == p);
    assert!(at("/balloon").unwrap() < at("/actions").unwrap(), "the device is configured before the machine starts");
    assert!(!build_config(&fc(), "/v.sock", "/work").iter().any(|s| s.0 == "/balloon"));
    let d = tempfile::tempdir().unwrap();
    let key = |balloon: bool, args: Option<&str>| {
        let mut o = fc();
        o.snapshot_dir = Some(d.path().join("snaps"));
        o.balloon = balloon;
        o.boot_args = args.map(String::from);
        snapshot_paths(&o, "/work").unwrap().0
    };
    assert_ne!(key(true, None), key(false, None), "the device is part of the machine the snapshot describes");
    assert_ne!(key(false, Some("mitigations=off")), key(false, None), "so is the kernel command line, which is baked into the guest");
}

#[test]
fn the_cloud_hypervisor_config_keeps_a_uart_a_relative_vsock_path_and_a_balloon_only_when_asked_for() {
    let mut o = VmOptions::new(Vmm::CloudHypervisor, "/k", "/r.ext4");
    o.balloon = true;
    o.mem_mib = Some(256);
    o.vcpus = Some(1);
    let c = build_ch_config(&o, "/work").unwrap();
    assert_eq!(c["serial"]["mode"], "Null", "with no UART the guest blocks writing its console and the agent never comes up");
    assert_eq!(c["vsock"]["socket"], "v.sock", "relative, so many VMs restored from one snapshot do not share a socket");
    assert_eq!(c["memory"]["size"], 256u64 << 20);
    assert_eq!(c["balloon"], serde_json::json!({"size": 0, "deflate_on_oom": true, "free_page_reporting": true}));
    o.balloon = false;
    assert!(build_ch_config(&o, "/work").unwrap().get("balloon").is_none());
    o.network = Some(Network { tap: "t".into(), guest_ip: "1.1.1.2/30".into(), gateway: "1.1.1.1".into(), dns: None, mac: None });
    assert!(build_ch_config(&o, "/work").unwrap_err().to_string().contains("no network support"));
}
