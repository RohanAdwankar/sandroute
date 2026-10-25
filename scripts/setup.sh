#!/bin/sh
# Everything sandroute needs besides the Rust code: Firecracker, a guest kernel, and the VM image, in $SANDROUTE_ASSETS (default ~/fcassets).
# Needs bubblewrap, e2fsprogs and python3 on the host, a Rust toolchain, and read-write access to /dev/kvm. Safe to run again.
set -eu
A=${SANDROUTE_ASSETS:-$HOME/fcassets}
FC=v1.17.0
KERNEL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/x86_64/vmlinux-6.1.128
cd "$(dirname "$0")/.."

for tool in bwrap mke2fs python3 cargo curl; do
  command -v "$tool" >/dev/null || { echo "missing $tool: on Debian or Ubuntu, sudo apt install bubblewrap e2fsprogs python3 curl, and rustup.rs for cargo"; exit 1; }
done
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "no access to /dev/kvm: sudo usermod -aG kvm \$USER, then log in again (and check your CPU has virtualization turned on)"; exit 1; }

mkdir -p "$A"
if [ ! -x "$A/firecracker" ]; then
  echo "downloading Firecracker $FC"
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FC/firecracker-$FC-x86_64.tgz" | tar -xz -C "$A"
  mv "$A"/release-$FC-x86_64/firecracker-$FC-x86_64 "$A/firecracker" && rm -rf "$A"/release-$FC-x86_64
fi
[ -f "$A/vmlinux-6.1.128" ] || { echo "downloading the guest kernel"; curl -fsSL -o "$A/vmlinux-6.1.128" "$KERNEL"; }

rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true   # the guest agent is a static binary
echo "building the VM image"
SANDROUTE_ASSETS="$A" scripts/build-rootfs.sh
echo "ready: $A"
