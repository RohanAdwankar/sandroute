#!/bin/sh
# Give sandroute's microVMs a network. Run once per host, as root.
#
# A tap device needs CAP_NET_ADMIN, so sandroute cannot make one for itself. The guest
# comes out of this able to reach the internet like any other machine, and unable to
# reach the host: egress is forwarded and NATed, anything addressed to the host is
# dropped.
#
#   sudo scripts/net-setup.sh [tap] [host-ip/prefix] [uplink]
#   sudo scripts/net-setup.sh --down [tap]
set -eu

if [ "${1:-}" = "--down" ]; then
  TAP=${2:-sr-tap0}
  ip link del "$TAP" 2>/dev/null || true
  echo "removed $TAP (NAT rules left in place; they are harmless without it)"
  exit 0
fi

TAP=${1:-sr-tap0}
HOST_IP=${2:-172.16.0.1/30}
UPLINK=${3:-$(ip route show default | awk '{print $5; exit}')}
OWNER=${SUDO_USER:-$(id -un)}

[ "$(id -u)" = 0 ] || { echo "needs root: a tap device requires CAP_NET_ADMIN" >&2; exit 1; }
[ -n "$UPLINK" ] || { echo "no default route found; pass the uplink interface explicitly" >&2; exit 1; }

ip link show "$TAP" >/dev/null 2>&1 || ip tuntap add dev "$TAP" mode tap user "$OWNER"
ip addr show dev "$TAP" | grep -q "${HOST_IP%%/*}" || ip addr add "$HOST_IP" dev "$TAP"
ip link set "$TAP" up
sysctl -qw net.ipv4.ip_forward=1

add() { iptables -C "$@" 2>/dev/null || iptables -A "$@"; }
add FORWARD -i "$TAP" -o "$UPLINK" -j ACCEPT
add FORWARD -i "$UPLINK" -o "$TAP" -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -C POSTROUTING -o "$UPLINK" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -o "$UPLINK" -j MASQUERADE
# the whole point: out to the world, never in to the host
add INPUT -i "$TAP" -j DROP

echo "$TAP is up, owned by $OWNER, NATed via $UPLINK."
echo "Give sandroute:  network: { tap: \"$TAP\", guestIp: \"172.16.0.2/30\", gateway: \"${HOST_IP%%/*}\" }"
