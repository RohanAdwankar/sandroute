// The client of spawnd (spawnd/src/main.rs), which starts the sandboxed commands.
//
// A process started from node is a fork() of node, which copies the page tables of everything node
// holds, so a control plane with a few hundred MiB pays milliseconds of cpu per command. spawnd is a
// small process that starts them instead. Build it with `npm run spawnd`.
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const BIN = process.env.SANDROUTE_SPAWND ?? fileURLToPath(new URL("../spawnd/target/release/spawnd", import.meta.url));

export interface Ended { stdout: string; stderr: string; code: number | null; signal: string | null; error: string | null; outputExceeded: boolean }
interface Wire extends Omit<Ended, "signal"> { id: number; signal: number | null }

let proc: ChildProcess | undefined;
const pending = new Map<number, (e: Ended) => void>();
let next = 0;

const ref = (on: boolean) => { for (const h of [proc, proc?.stdin, proc?.stdout] as any[]) on ? h?.ref?.() : h?.unref?.(); };

function start(): ChildProcess {
  const p = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
  readline.createInterface({ input: p.stdout! }).on("line", (line) => {
    const { id, signal, ...r } = JSON.parse(line) as Wire;
    const done = pending.get(id);
    pending.delete(id);
    done?.({ ...r, signal: signal === null ? null : Object.entries(constants.signals).find(([, n]) => n === signal)?.[0] ?? `signal ${signal}` });
    if (!pending.size) ref(false);
  });
  // a helper that dies owes an answer to everything it was asked
  p.on("exit", () => {
    if (proc === p) proc = undefined;
    for (const [id, done] of pending) done({ stdout: "", stderr: "", code: null, signal: null, error: "spawnd exited", outputExceeded: false });
    pending.clear();
  });
  process.once("exit", () => p.kill());
  return p;
}

/** Run argv to completion, with a time limit and a cap on what it may print. fd3 is a file handed to it as descriptor 3. */
export function launch(argv: string[], o: { timeoutMs: number; maxOutput: number; fd3?: string }): Promise<Ended> {
  proc ??= start();
  return new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    ref(true);
    proc!.stdin!.write(JSON.stringify({ id, argv, timeoutMs: o.timeoutMs, maxOutput: o.maxOutput, fd3: o.fd3 }) + "\n");
  });
}
