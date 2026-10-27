#!/bin/bash
# The final capacity benchmark. Run it with nothing else on the machine: no editor, no agent, no
# other sessions. Anything else using the cpu moves a design's limit, so the script waits for a
# quiet machine, records what it was running on, and refuses to start otherwise.
#
#   SEEDS="1 2" bench/final/run.sh                 every series, about 4 hours; ONLY="oxroute kata" picks some
#
# Each series steps up through its levels. A level is run once per seed, and the series stops at the
# first level where most seeds fail the target (p99 added latency under 1500 ms, no errors, no
# out-of-memory abort). Results, the environment and the configs land in bench/results/final/<time>/.
# Every run is the same command; the lines below are the whole recipe.
set -u
cd "$(dirname "$0")/../.."
SEEDS=${SEEDS:-"1 2 3"}; MINUTES=${MINUTES:-6}; ONLY=${ONLY:-}
OUT=bench/results/final/$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT/configs"
exec > >(tee -a "$OUT/log.txt") 2>&1
cargo build --release --quiet -p sandroute-bench || exit 1
CRICFG=$(bench/final/setup-cri.sh | tail -1)
CT="$HOME/kata/nerd/bin/crictl --config $CRICFG"
[ -n "$ONLY" ] && [[ " $ONLY " != *" kata-vanilla "* ]] || $CT info 2>/dev/null | grep -q kata-vanilla || { echo "the running containerd has an older config; stop it (sudo pkill -f 'final/containerd.toml') and run again"; exit 1; }

clean() {   # delete every pod, then wait for the memory to come back
  $CT pods -q | xargs -r -P 8 -I{} sh -c "$CT stopp {} >/dev/null 2>&1; $CT rmp {} >/dev/null 2>&1"
  for i in $(seq 60); do [ "$(pgrep -c cloud-hyperviso)" = 0 ] && [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -gt 5000 ] && return 0; sleep 2; done
  echo "memory did not recover after cleaning; stopping rather than measuring a dirty machine"; exit 1
}
trap clean EXIT

# ---- a quiet machine, and a record of it ----
for i in $(seq 90); do awk '{exit !($1 < 0.3)}' /proc/loadavg && break; sleep 10; done
awk '{exit !($1 < 0.3)}' /proc/loadavg || { echo "load stayed above 0.3 for 15 minutes; something else is running:"; ps -eo pcpu,rss,comm --sort=-pcpu | head -8; exit 1; }
clean
{
  date -Is; uname -a; grep -m1 'model name' /proc/cpuinfo; echo "cores: $(nproc)"; grep -E 'MemTotal|MemAvailable|SwapTotal' /proc/meminfo
  echo "load: $(cat /proc/loadavg)"; echo "git: $(git rev-parse HEAD) $(git status --short | wc -l) uncommitted files"; echo "rustc: $(rustc --version)"
  ~/fcassets/firecracker --version | head -1; ls "$HOME/kata/root/opt/kata/bin/" >/dev/null && "$HOME/kata/root/opt/kata/bin/kata-runtime" --version 2>&1 | head -1
  "$HOME/gvisor/runsc" --version 2>&1 | head -1; "$HOME/kata/nerd/bin/containerd" --version
  echo "--- processes using cpu at the start"; ps -eo pcpu,rss,comm --sort=-pcpu | head -8
} > "$OUT/environment.txt"
cp "$HOME"/kata/final/*.toml "$HOME"/kata/final/crictl.yaml "$HOME"/kata/final/cni.d/* "$OUT/configs/"
cp bench/src/bin/tenants.rs bench/src/cri.rs bench/final/run.sh "$OUT/configs/"
echo -e "series\tdesign\ttenants\tseed\tp99ms\tmet\taborted\tpeakcpu\tminavailMiB" > "$OUT/summary.tsv"

# series NAME "design flags" WINDOW_MS IDLE_MEAN "levels" [cri runtime]
series() {
  local name=$1 flags=$2 win=$3 idle=$4 levels=$5 rt=${6:-}
  [ -n "$ONLY" ] && [[ " $ONLY " != *" $name "* ]] && return
  echo "=== $name  ($flags, window ${win}ms, idle-mean ${idle}s)"
  for n in $levels; do
    local pass=0 total=0
    for s in $SEEDS; do
      clean
      CRI_CONFIG=$CRICFG CRI_RUNTIME=$rt timeout 1500 target/release/tenants $flags --tenants "$n" --minutes "$MINUTES" --idle-mean "$idle" --window "$win" --seed "$s" --out "$OUT/raw" --name "$name-n$n-s$s" 2>&1 | tail -1 | cut -c1-200
      local f="$OUT/raw/$name-n$n-s$s.json"
      if [ -f "$f" ]; then
        jq -r --arg n "$name" '[$n,.design,.tenants,.seed,.latencyMs.p99,.slo.met,.aborted//"",.peak.cpuBusy,.memAvailableMiB.min]|@tsv' "$f" >> "$OUT/summary.tsv"
        [ "$(jq '.slo.met' "$f")" = true ] && pass=$((pass+1))
      fi
      total=$((total+1))
    done
    echo "--- $name $n: $pass of $total seeds met the target"
    [ $((pass*2)) -le "$total" ] && { echo "--- $name stops at $n"; break; }
  done
}

# two tenant counts per series, one just under and one just over where the earlier rough runs stopped
series oxroute       "--design oxroute"            30000 120 "672 704 736"
series suspend       "--design suspend"             5000 120 "576 640 704"
series kept          "--design kept"               30000 120 "160 176 192"
series gvisor-cold   "--design gvisor-cold"        30000 120 "80 112" runsc
series kata          "--design kata"               30000 120 "40 56"
# the same VMMs set up the way the products in the earlier posts are described, to see what the setup is worth.
# Claude Code's guest size is not known, so its series uses the default size; Muse is Cloud Hypervisor at 2 vCPU and 8 GiB.
series fc-vanilla         "--design kept --no-snapshot"                      30000 120 "48 64"
series fc-claude          "--design reclaim --no-snapshot"                   30000 120 "64 96"
series ch-muse            "--design kept --vmm cloud-hypervisor --no-snapshot --vcpus 2 --mem 8192 --balloon" 30000 120 "16 32"
series kata-vanilla       "--design kata"                                    30000 120 "32 48" kata-vanilla
echo "done; see $OUT/summary.tsv"
