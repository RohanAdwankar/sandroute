import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCommandNames } from "just-bash";
import { fileCommand, type FileCall } from "../src/fileops.ts";
import { classify } from "../src/router.ts";
import { Sandbox, bwrapArgs } from "../src/sandbox.ts";

// The filter must not change what a command does. Every call the file-only tier served in the recorded
// agent sessions is replayed twice, once under the filter and once without it, in two copies of the same
// project, and the exit code and output of each must match.
const usable = spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true"]).status === 0;
const dir = path.resolve(import.meta.dirname, "../bench/traces");
const fixture = path.resolve(import.meta.dirname, "../bench/fixtures/textstats");
const opts = { skip: usable && existsSync(dir) ? false : "needs bubblewrap and the recorded sessions" };
const known = new Set(getCommandNames().filter((n) => n !== "git" && n !== "curl" && existsSync(`/usr/bin/${n}`)));

test("the file-only tier behaves the same with and without the filter, across every recorded session", opts, async (t) => {
  const filtered = (ws: string) => new Sandbox({ workspace: ws, mountAt: "/work" });
  const unfiltered = (ws: string, cmd: string) => {
    const args = bwrapArgs(ws, "/work", "/work");
    for (const [f, n] of [["--seccomp", 2], ["--disable-userns", 1]] as const) args.splice(args.indexOf(f), n);
    const r = spawnSync("bwrap", [...args, "/usr/bin/bash", "-c", cmd], { encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 137 };
  };
  let calls = 0, refused = 0;
  const diffs: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "intrinsic.json")) {
    const t = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    if (t.exit !== 0) continue;
    const a = mkdtempSync(path.join(tmpdir(), "corpus-a-")), b = mkdtempSync(path.join(tmpdir(), "corpus-b-"));
    for (const w of [a, b]) cpSync(fixture, w, { recursive: true });
    const sb = filtered(a);
    for (const c of t.calls) {
      const args = JSON.parse(JSON.stringify(c.args).replaceAll(t.workspace, "/work"));
      const p = String(args.filePath ?? args.path ?? "");
      if (p && c.tool !== "bash" && !p.startsWith("/work")) continue;   // outside the project: not replayable
      let cmd: string;
      if (c.tool === "bash") {
        if (classify(known, args.command, "/work").tier !== "inprocess") continue;
        cmd = args.command;
      } else cmd = fileCommand({ tool: c.tool, ...args } as FileCall);
      const x = await sb.exec(cmd), y = unfiltered(b, cmd);
      calls++;
      if (/Operation not permitted|Bad system call/.test(x.stderr + x.stdout) && !/Operation not permitted|Bad system call/.test(y.stderr + y.stdout)) refused++;
      if (x.exitCode !== y.exitCode || x.stdout !== y.stdout) diffs.push(`${f}: ${cmd.slice(0, 90)}\n  filtered   ${x.exitCode} ${JSON.stringify(x.stdout.slice(0, 80))} ${JSON.stringify(x.stderr.slice(0, 80))}\n  unfiltered ${y.exitCode} ${JSON.stringify(y.stdout.slice(0, 80))}`);
    }
  }
  t.diagnostic(`${calls} calls replayed, ${refused} refused by the filter`);
  assert.ok(calls > 100, `only ${calls} calls were replayed`);
  assert.equal(refused, 0, "a command was refused by the filter that the unfiltered sandbox ran");
  assert.deepEqual(diffs, [], `${diffs.length} of ${calls} calls differ:\n${diffs.slice(0, 5).join("\n")}`);
});
