#!/bin/sh
# Read-only. Dumps what is visible from inside a sandbox about how its VM is configured, for filling in
# the setup of a box we do not control (Claude Code, Instinct, Muse). Prints to stdout; touches nothing.
#   sh probe-box.sh > box.txt 2>&1
s() { echo; echo "### $*"; }
r() { s "$*"; sh -c "$*" 2>&1 | head -${LINES_MAX:-60}; }
r 'date -u; uname -a; cat /proc/cmdline'
r 'systemd-detect-virt; cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name /sys/class/dmi/id/bios_version'
r 'nproc; lscpu'
r 'grep -E "MemTotal|MemFree|MemAvailable|Cached|AnonPages|Slab|Hugepage|HugePages|Swap|Balloon" /proc/meminfo; free -m'
r 'cat /sys/kernel/mm/transparent_hugepage/enabled /sys/kernel/mm/ksm/run /proc/sys/vm/swappiness /proc/sys/vm/overcommit_memory'
r 'for d in /sys/bus/virtio/devices/*; do echo "$d $(cat $d/device) $(cat $d/features | cut -c1-40) $(basename $(readlink $d/driver 2>/dev/null))"; done'
r 'ls /sys/module/virtio_balloon/parameters /sys/module/page_reporting/parameters 2>&1; cat /sys/module/page_reporting/parameters/* 2>&1'
r 'lsblk -o NAME,SIZE,RO,TYPE,MOUNTPOINT,ROTA,SCHED 2>&1; for b in /sys/block/*; do echo "$b $(cat $b/queue/scheduler 2>/dev/null) nr=$(cat $b/queue/nr_requests 2>/dev/null) mq=$(ls $b/mq 2>/dev/null | wc -l)"; done'
r 'mount | grep -v -E "cgroup|proc|sysfs|devpts|mqueue"'
r 'df -hT | grep -v tmpfs'
r 'ip -br addr 2>&1; ip route 2>&1; cat /etc/resolv.conf 2>&1; for n in /sys/class/net/*; do echo "$n $(cat $n/mtu) queues=$(ls $n/queues | wc -l)"; done'
r 'cat /proc/sys/kernel/random/boot_id /proc/uptime /proc/loadavg; cat /sys/devices/system/clocksource/clocksource0/current_clocksource'
r 'dmesg 2>&1 | grep -i -E "hypervisor|kvm|virtio|balloon|pvh|e820|Memory:|clocksource|hugepage|swiotlb|Command line|Booting|Linux version" | head -40'
r 'ls /sys/devices/system/cpu/vulnerabilities 2>&1 | head -20; grep -H . /sys/devices/system/cpu/vulnerabilities/* 2>&1 | head -20'
r 'ps -eo pid,ppid,rss,pcpu,comm --sort=-rss | head -25'
r 'systemctl list-units --type=service --state=running --no-pager 2>&1 | head -40'
r 'cat /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io 2>&1'
r 'zcat /proc/config.gz 2>/dev/null | grep -E "CONFIG_(PCI|VIRTIO|PAGE_REPORTING|BALLOON|HUGETLB|TRANSPARENT|KSM|ZSWAP|MEMCG|NUMA|SMP|HZ|PREEMPT)[A-Z_]*=" | head -40'
r 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.high 2>&1; cat /proc/self/cgroup'
r 'which firecracker cloud-hypervisor qemu-system-x86_64 crosvm 2>&1; ls /run 2>&1 | head -30'
