#!/bin/bash
# Clears what earlier pod runs left behind, then runs the whole final benchmark: every series at two seeds.
# It asks for sudo once, for the cleanup. Nothing else needs closing: idle programs cost the benchmark nothing, and run.sh waits for the
# machine to go quiet (load under 0.3) before it starts and says what is busy if it never does. About 4 hours at worst.
#
#   bench/final/go.sh
set -u
cd "$(dirname "$0")/../.."
sudo true || exit 1
sudo pkill -f 'containerd --confi[g]'                      # the old containerds, started before kata-vanilla was in the config
sleep 3
sudo rm -rf "$HOME"/tenant-run "$HOME"/tenant-run.stale-*  # root-owned files left by pods
SEEDS="1 2" bench/final/run.sh
