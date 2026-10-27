# The recordings behind the level videos

Each `levelN.events.jsonl.gz` is the event log of one 6 minute run (`gunzip` it, then `uv run --with matplotlib --with numpy bench/timelapse.py levelN.events.jsonl out.mp4 8` draws the video). `levelN.json.gz` is that run's summary. Every run is seed 1, idle mean 120 s, and was recorded with `--events`.

```
level1   --design kept --no-snapshot       --tenants 48  --window 30000
level2   --design reclaim --no-snapshot    --tenants 64  --window 30000
level3   --design suspend                  --tenants 576 --window 5000
level4   --design oxroute (now sandroute)  --tenants 736 --window 30000   recorded on Oct 25, the others on Oct 26
```

Level 3 is recorded at 576 tenants, not 640. Two recordings at 640 missed the 1.5 s target (`level3-n640-seed*-missed.json.gz`, p99 2,079 ms and 1,599 ms). Reruns of the benchmark without `--events` on Oct 27 explain why: 640 failed all three seeds (p99 2.1 to 2.4 s) in `final/20261027-034447`, 576 passed all three, and 608 passed 3 of 3 in a first run and 1 of 3 in a second, so Level 3's limit is between 576 and 640 and moves with the state of the machine. The first 608 run's raw files were deleted by mistake; only its log survives, in `final/20261027-043613/log.txt`. Level 4 at 736 passed all three seeds in `final/20261027-050333`.
