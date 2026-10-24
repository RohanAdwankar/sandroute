#!/bin/bash
# Clears what earlier pod runs left behind, then runs the whole final benchmark: the headline designs at two seeds, then the other setups at one.
# It asks for sudo once, for the cleanup. Nothing else needs closing: idle programs cost the benchmark nothing, and run.sh waits for the
# machine to go quiet (load under 0.3) before it starts and says what is busy if it never does. About 3.5 hours at worst.
#
#   bench/final/go.sh
set -u
cd "$(dirname "$0")/../.."
sudo true || exit 1
sudo pkill -f 'containerd --confi[g]'                      # the old containerds, started before kata-vanilla was in the config
sleep 3
sudo rm -rf "$HOME"/tenant-run "$HOME"/tenant-run.stale-*  # root-owned files left by pods
SEEDS="1 2" ONLY="oxroute suspend kept gvisor-cold kata" bench/final/run.sh
SEEDS="1" ONLY="fc-vanilla fc-claude ch-muse kata-vanilla" bench/final/run.sh
