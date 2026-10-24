#!/bin/bash
# Build an ext4 rootfs for the sandroute Firecracker backend without root:
# copy bash/python3/coreutils + their libs out of the host, add an init that
# starts guest/agent.py, then mke2fs -d (needs no loop mount).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERE="${SANDROUTE_ASSETS:-$HOME/fcassets}"
STAGE=$HERE/stage
IMG=$HERE/rootfs.ext4
AGENT="$REPO/guest/agent.py"
PYV=$(python3 -c "import sys; print(\"%d.%d\" % sys.version_info[:2])")

rm -rf "$STAGE"; mkdir -p "$STAGE"/{bin,sbin,usr/bin,usr/lib,usr/sbin,lib,lib64,proc,sys,dev,tmp,etc,root,var/log,overlay,.upper}
chmod 1777 "$STAGE/tmp"

BINS=(bash sh ls cat echo mkdir rmdir rm cp mv ln chmod chown sleep uname env printenv
      sed grep egrep fgrep awk head tail wc touch find sort uniq date dirname basename
      true false pwd id whoami hostname mount umount df du stat tr cut xargs tee kill ps
      readlink realpath mktemp seq tar gzip which chroot ip pgrep pkill nohup base64 diff sha256sum md5sum nproc python3 python$PYV)

copy() { # copy $1 to stage preserving its absolute path
  local src=$1 dst="$STAGE${1}"
  [ -e "$dst" ] && return 0
  mkdir -p "$(dirname "$dst")"
  cp -aL "$src" "$dst" 2>/dev/null || cp -a "$src" "$dst"
}

libs() { # print shared libs of $1
  ldd "$1" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^\//) print $i}'
}

for b in "${BINS[@]}"; do
  p=$(type -P "$b" 2>/dev/null) || continue
  [ -n "$p" ] || continue
  rp=$(readlink -f "$p")
  copy "$rp"
  # keep the name the scripts call it by
  [ "$rp" != "$p" ] && { mkdir -p "$STAGE$(dirname "$p")"; ln -sf "$rp" "$STAGE$p"; }
  for l in $(libs "$rp"); do copy "$l"; done
done

# python stdlib, including lib-dynload; drop test suites to keep the image small
mkdir -p "$STAGE/usr/lib/python$PYV"
tar -C /usr/lib \
  --exclude="python$PYV/test" --exclude="python$PYV/idlelib" \
  --exclude="python$PYV/tkinter" --exclude='__pycache__' \
  -cf - "python$PYV" | tar -C "$STAGE/usr/lib" -xf -
for so in "$STAGE/usr/lib/python$PYV"/lib-dynload/*.so; do
  for l in $(libs "$so"); do copy "$l"; done
done

# busybox-free /bin/sh -> bash
ln -sf /usr/bin/bash "$STAGE/bin/sh"
ln -sf /usr/bin/bash "$STAGE/bin/bash"
ln -sf /usr/bin/python$PYV "$STAGE/usr/bin/python3"

cp "$AGENT" "$STAGE/agent.py"; chmod 755 "$STAGE/agent.py"

# pip, so the guest starts out able to fetch what an agent asks for. The host has no pip
# either, so bootstrap it straight into the image's site-packages.
GETPIP=$(mktemp)
if curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$GETPIP"; then
  python3 "$GETPIP" --quiet --no-warn-script-location \
    --target "$STAGE/usr/lib/python$PYV/dist-packages" || echo "warning: pip bootstrap failed" >&2
fi
rm -f "$GETPIP"

# PEP 668's marker exists to stop you breaking a distro's package manager. The guest has
# no package manager to break and is thrown away after every turn, so an agent that runs
# pip install should get what it asked for rather than a lecture about virtualenvs.
rm -f "$STAGE/usr/lib/python$PYV/EXTERNALLY-MANAGED"

# Trust roots. Without them the guest has a working network and still cannot speak to
# anything over TLS, which is every package index there is.
CA=/etc/ssl/certs/ca-certificates.crt
if [ -f "$CA" ]; then
  mkdir -p "$STAGE/etc/ssl/certs" "$STAGE/usr/lib/ssl"
  cp "$CA" "$STAGE/etc/ssl/certs/ca-certificates.crt"
  ln -sf /etc/ssl/certs "$STAGE/usr/lib/ssl/certs"
  ln -sf /etc/ssl/certs/ca-certificates.crt "$STAGE/usr/lib/ssl/cert.pem"
else
  echo "warning: no CA bundle at $CA; TLS will fail in the guest" >&2
fi

printf 'root:x:0:0:root:/root:/bin/bash\n' > "$STAGE/etc/passwd"
printf 'root:x:0:\n'                       > "$STAGE/etc/group"
printf 'guest\n'                           > "$STAGE/etc/hostname"
printf '127.0.0.1 localhost guest\n'       > "$STAGE/etc/hosts"

cat > "$STAGE/sbin/init" <<'EOF'
#!/bin/bash
# PID 1. The image is mounted read-only so one copy can back many VMs and a restored
# snapshot can never disagree with the disk, so the writable root is a tmpfs overlay on
# top of it. Everything the guest writes, workspace included, lives in RAM and dies with
# the VM -- which is right, because the host owns the workspace and re-pushes it on wake.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin
mount -t proc proc /proc

ws=/workspace; port=5000; gip=; gw=; dns=
for a in $(cat /proc/cmdline); do
  case "$a" in
    sandroute.workspace=*) ws=${a#sandroute.workspace=} ;;
    sandroute.port=*)      port=${a#sandroute.port=} ;;
    sandroute.ip=*)        gip=${a#sandroute.ip=} ;;
    sandroute.gw=*)        gw=${a#sandroute.gw=} ;;
    sandroute.dns=*)       dns=${a#sandroute.dns=} ;;
  esac
done
echo "sandroute-init: workspace=$ws port=$port"

mount -t tmpfs -o size=75% tmpfs /overlay
mkdir -p /overlay/upper /overlay/work /overlay/root
mount -t overlay overlay -o lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work /overlay/root
R=/overlay/root
mount -t proc proc "$R/proc"
mount -t sysfs sysfs "$R/sys"
mount -t devtmpfs dev "$R/dev" 2>/dev/null
mount -t tmpfs tmpfs "$R/tmp"
# lets the agent see what this guest has changed, so a release can tell whether it holds anything
mount --bind /overlay/upper "$R/.upper"
mkdir -p "$R/dev/pts"
mount -t devpts devpts "$R/dev/pts"   # without this a guest process cannot open a terminal
mkdir -p "$R$ws"
hostname guest 2>/dev/null
ip link set lo up 2>/dev/null   # so a server the agent starts is reachable at 127.0.0.1
if [ -n "$gip" ]; then
  # an ordinary machine on a network: out to the world, no route back to the host
  ip addr add "$gip" dev eth0 2>/dev/null
  ip link set eth0 up 2>/dev/null
  [ -n "$gw" ] && ip route add default via "$gw" 2>/dev/null
  mkdir -p "$R/etc"
  echo "nameserver ${dns:-1.1.1.1}" > "$R/etc/resolv.conf"
  echo "sandroute-init: eth0 $gip via $gw, dns ${dns:-1.1.1.1}"
fi

while :; do
  chroot "$R" /usr/bin/python3 /agent.py --workspace "$ws" --vsock-port "$port" --upper /.upper --scratch /tmp
  echo "sandroute-init: agent exited $?, restarting"
  sleep 1
done
EOF
chmod 755 "$STAGE/sbin/init"
ln -sf /sbin/init "$STAGE/init"

echo "stage size: $(du -sh "$STAGE" | cut -f1)"
rm -f "$IMG"
mkfs.ext4 -q -F -L sandroute -d "$STAGE" -b 4096 "$IMG" 800M
echo "built $IMG ($(du -h "$IMG" | cut -f1))"
