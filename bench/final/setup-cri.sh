#!/bin/sh
# Writes the configs the pod designs (kata, gvisor) run under and starts the containerd that serves
# them, so a run does not depend on whatever was left running. Needs ~/kata (Kata static release,
# nerdctl-full and crictl) and ~/gvisor (the runsc release); both are plain downloads, no root.
# Root is needed once for the vhost modules and the sudoers entry (see the write-up), and the
# containerd below is started with sudo, which that entry allows for this binary only.
set -eu
K=${KATA_HOME:-$HOME/kata}; G=${GVISOR_HOME:-$HOME/gvisor}; F=$K/final
mkdir -p "$F/run" "$F/cni.d"
# Kata's own defaults, pointed at the unpacked release, with a 256 MiB guest like the Firecracker VMs and free page reporting on, as Muse has
sed "s#/opt/kata#$K/root/opt/kata#g; s/^default_memory = .*/default_memory = 256/; s/^reclaim_guest_freed_memory = false/reclaim_guest_freed_memory = true/" "$K/root/opt/kata/share/defaults/kata-containers/configuration-clh.toml" > "$F/kata-clh.toml"
# and Kata exactly as shipped (2 GiB guest, no free page reporting), for the vanilla series
sed "s#/opt/kata#$K/root/opt/kata#g" "$K/root/opt/kata/share/defaults/kata-containers/configuration-clh.toml" > "$F/kata-vanilla-clh.toml"
printf 'binary_name = "%s/runsc"\n[runsc_config]\n  platform = "systrap"\n' "$G" > "$F/runsc.toml"
echo '{"cniVersion":"1.0.0","name":"kata-bridge","plugins":[{"type":"bridge","bridge":"kata0","isGateway":true,"ipMasq":false,"ipam":{"type":"host-local","ranges":[[{"subnet":"10.89.0.0/16"}]]}}]}' > "$F/cni.d/10-bridge.conflist"
cat > "$F/containerd.toml" <<EOT
version = 3
root = "$F/data/root"
state = "$F/data/state"
[grpc]
  address = "$F/run/c.sock"
  uid = $(id -u)
  gid = $(id -g)
[plugins.'io.containerd.cri.v1.runtime'.containerd]
  default_runtime_name = "kata"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  runtime_path = "$K/root/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata.options]
    ConfigPath = "$F/kata-clh.toml"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata-vanilla]
  runtime_type = "io.containerd.kata.v2"
  runtime_path = "$K/root/opt/kata/bin/containerd-shim-kata-v2"
  privileged_without_host_devices = true
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata-vanilla.options]
    ConfigPath = "$F/kata-vanilla-clh.toml"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
  runtime_path = "$G/containerd-shim-runsc-v1"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc.options]
    TypeUrl = "io.containerd.runsc.v1.options"
    ConfigPath = "$F/runsc.toml"
[plugins.'io.containerd.cri.v1.runtime'.cni]
  bin_dirs = ["$K/nerd/libexec/cni"]
  conf_dir = "$F/cni.d"
EOT
printf 'runtime-endpoint: unix://%s/run/c.sock\nimage-endpoint: unix://%s/run/c.sock\ntimeout: 60\n' "$F" "$F" > "$F/crictl.yaml"
CT="$K/nerd/bin/crictl --config $F/crictl.yaml"
if ! $CT version >/dev/null 2>&1; then
  rm -f "$F/run/c.sock" "$F/run/c.sock.ttrpc"
  (setsid sudo -n "$K/nerd/bin/containerd" --config "$F/containerd.toml" > "$F/containerd.log" 2>&1 &)
  for i in $(seq 30); do $CT version >/dev/null 2>&1 && break; sleep 1; done
fi
$CT pull docker.io/library/python:3.13-slim >/dev/null
echo "$F/crictl.yaml"
