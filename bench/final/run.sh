#!/bin/bash
# The final capacity benchmark. Run it with nothing else on the machine: no editor, no agent, no
# other sessions. Anything else using the cpu moves a design's limit, so the script waits for a
# quiet machine, records what it was running on, and refuses to start otherwise.
#
#   bench/final/run.sh                       every series, 3 seeds, 6 minutes a run
#   SEEDS="1 2" ONLY="oxroute gvisor" bench/final/run.sh
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
CRICFG=$(bench/final/setup-cri.sh | tail -1)
CT="$HOME/kata/nerd/bin/crictl --config $CRICFG"

clean() {   # delete every pod, then wait for the memory to come back
  $CT pods -q | xargs -r -P 8 -I{} sh -c "$CT stopp {} >/dev/null 2>&1; $CT rmp {} >/dev/null 2>&1"
  for i in $(seq 60); do [ "$(pgrep -c cloud-hyperviso)" = 0 ] && [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -gt 5000 ] && return 0; sleep 2; done
  echo "memory did not recover after cleaning; stopping rather than measuring a dirty machine"; exit 1
}
trap clean EXIT

# ---- a quiet machine, and a record of it ----
for i in $(seq 90); do awk '{exit !($1 < 0.3)}' /proc/loadavg && break; sleep 10; done
awk '{exit !($1 < 0.3)}' /proc/loadavg || { echo "load stayed above 0.3 for 15 minutes; something else is running:"; ps -eo pcpu,rss,args --sort=-pcpu | head -8; exit 1; }
clean
{
  date -Is; uname -a; grep -m1 'model name' /proc/cpuinfo; echo "cores: $(nproc)"; grep -E 'MemTotal|MemAvailable|SwapTotal' /proc/meminfo
  echo "load: $(cat /proc/loadavg)"; echo "git: $(git rev-parse HEAD) $(git status --short | wc -l) uncommitted files"; echo "node: $(node --version)"
  ~/fcassets/firecracker --version | head -1; ls "$HOME/kata/root/opt/kata/bin/" >/dev/null && "$HOME/kata/root/opt/kata/bin/kata-runtime" --version 2>&1 | head -1
  "$HOME/gvisor/runsc" --version 2>&1 | head -1; "$HOME/kata/nerd/bin/containerd" --version
  echo "--- processes using cpu at the start"; ps -eo pcpu,rss,args --sort=-pcpu | head -8
} > "$OUT/environment.txt"
cp "$HOME"/kata/final/*.toml "$HOME"/kata/final/crictl.yaml "$HOME"/kata/final/cni.d/* "$OUT/configs/"
cp bench/tenants.mts bench/cri-vm.mts bench/final/run.sh "$OUT/configs/"
echo -e "series\tdesign\ttenants\tseed\tp99ms\tmet\taborted\tpeakcpu\tminavailMiB" > "$OUT/summary.tsv"

# series NAME "design flags" WINDOW_MS IDLE_MEAN "levels" [cri runtime]
series() {
  local name=$1 flags=$2 win=$3 idle=$4 levels=$5 rt=${6:-}
  [ -n "$ONLY" ] && [[ " $ONLY " != *" $name "* ]] && return
  echo "=== $name  ($flags, window ${win}ms, idle-mean ${idle}s)"
  local design bal=""; design=$(echo $flags | awk "{print \$2}"); [[ "$flags" == *--balloon* ]] && bal="-balloon"
  for n in $levels; do
    local pass=0 total=0
    for s in $SEEDS; do
      clean
      CRI_CONFIG=$CRICFG CRI_RUNTIME=$rt timeout 1500 npx tsx bench/tenants.mts $flags --tenants "$n" --minutes "$MINUTES" --idle-mean "$idle" --window "$win" --seed "$s" --out "$OUT/raw" 2>&1 | tail -1 | cut -c1-200
      local f="$OUT/raw/$design$bal-n$n-w$win-i$idle-s$s.json"
      if [ -f "$f" ]; then
        node -e 'const r=require(process.argv[1]);console.log([process.argv[2],r.design,r.tenants,r.seed,r.latencyMs.p99,r.slo.met,r.aborted??"",r.peak.cpuBusy,r.memAvailableMiB.min].join("\t"))' "$PWD/$f" "$name" >> "$OUT/summary.tsv"
        [ "$(node -e 'console.log(require(process.argv[1]).slo.met?1:0)' "$PWD/$f")" = 1 ] && pass=$((pass+1))
      fi
      total=$((total+1))
    done
    echo "--- $name $n: $pass of $total seeds met the target"
    [ $((pass*2)) -le "$total" ] && { echo "--- $name stops at $n"; break; }
  done
}

series kept          "--design kept"               30000 120 "96 112 128 144"
series kept-balloon  "--design kept --balloon"     30000 120 "128 144 160 176"
series suspend       "--design suspend"             5000 120 "352 384 416 432 448"
series oxroute       "--design oxroute"            30000 120 "480 512 544 576 608"
series gvisor        "--design gvisor"             30000 120 "128 160 176 192 208" runsc
series gvisor-cold   "--design gvisor-cold"        30000 120 "64 80 96 112 128" runsc
series kata          "--design kata"               30000 120 "32 40 48 52 56"
series kata-cold     "--design kata-cold"          30000 120 "32 40 48 56 64"
# a quieter population: a person away five minutes between tasks instead of two. The levels are
# guesses above the busy ones; a series that fails at its first level says its limit is lower.
series oxroute-quiet      "--design oxroute"       30000 300 "640 768 896 1024"
series suspend-quiet      "--design suspend"        5000 300 "448 512 576 640"
series gvisor-cold-quiet  "--design gvisor-cold"   30000 300 "128 160 192 224" runsc
series kata-cold-quiet    "--design kata-cold"     30000 300 "48 64 80 96"
echo "done; see $OUT/summary.tsv"
