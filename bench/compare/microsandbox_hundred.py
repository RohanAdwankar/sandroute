# /// script
# dependencies = ["microsandbox"]
# ///
# The E2B example of starting sandboxes at once, run against microsandbox (https://github.com/superradcompany/microsandbox), which runs locally.
#   uv run bench/compare/microsandbox_hundred.py 100
import asyncio
import sys
import time
import uuid
from microsandbox import Sandbox

async def run_single_sandbox(idx: int):
    # Spin up an isolated microVM asynchronously
    name = f"bench-{idx}-{uuid.uuid4().hex[:6]}"
    sandbox = await Sandbox.create(name, image="python", cpus=1, memory=256)
    try:
        random_str = uuid.uuid4().hex

        # Write file inside sandbox
        await sandbox.fs.write("/tmp/random.txt", random_str.encode())

        # Read or verify back
        res = await sandbox.exec("cat", ["/tmp/random.txt"])
        print(f"Sandbox {idx} ({name}): {res.stdout_text.strip()}")
    finally:
        await sandbox.stop_and_wait()
        await Sandbox.remove(name)

async def main():
    n = int(sys.argv[1])
    start = time.time()
    # Spin up n sandboxes simultaneously
    results = await asyncio.gather(*[run_single_sandbox(i) for i in range(n)], return_exceptions=True)
    errors = [r for r in results if isinstance(r, Exception)]
    print(f"{n} sandboxes in {time.time() - start:.1f} s, {len(errors)} errors", file=sys.stderr)
    for e in errors[:3]:
        print("error:", repr(e)[:200], file=sys.stderr)

if __name__ == "__main__":
    asyncio.run(main())
