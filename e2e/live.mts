// Same harness as run.mts, but a real model decides the commands.
// Usage: npx tsx e2e/live.mts [model]   (default: opencode/big-pickle, a free-tier model)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const model = process.argv[2] ?? "opencode/big-pickle";
const ws = mkdtempSync("/tmp/claude-0/live-ws-");
const home = mkdtempSync("/tmp/claude-0/live-home-");
const log = path.join(ws, "sandroute.log");

writeFileSync(path.join(ws, "notes.txt"), "the quick brown fox\n");
writeFileSync(path.join(ws, "page.html"), `<body style="margin:0"><div style="height:600px;background:linear-gradient(90deg,#2b6,#26b);color:#fff;font:48px sans-serif;padding:40px">sandroute</div></body>`);
mkdirSync(path.join(ws, ".opencode/tool"), { recursive: true });
writeFileSync(path.join(ws, ".opencode/tool/bash.ts"), readFileSync(path.join(root, "opencode/bash.ts"), "utf8").replace("../src/index.ts", path.join(root, "src/index.ts")));
symlinkSync(path.join(root, "node_modules"), path.join(ws, "node_modules"));
writeFileSync(path.join(ws, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { "*": "allow" }, autoupdate: false }));

const prompt = `Do these in order using the bash tool, one command per step, then reply "done":
1. In notes.txt replace the word quick with slow.
2. Clone https://github.com/RohanAdwankar/oxdraw with --depth 1 and list its top-level files.
3. Take a screenshot of page.html with headless chromium (the command is chromium; use --no-sandbox) and save it as shot.png in the current directory.`;

const env = { ...process.env, PWD: ws, HOME: home, XDG_CONFIG_HOME: home + "/c", XDG_DATA_HOME: home + "/d", XDG_CACHE_HOME: home + "/k", SANDROUTE_LOG: log, PATH: path.join(root, "e2e/bin") + ":" + process.env.PATH };
const p = await new Promise<{ status: number | null; out: string }>((resolve) => {
  const c = spawn(path.join(root, "node_modules/.bin/opencode"), ["run", "-m", model, prompt], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => c.kill("SIGKILL"), Number(process.env.E2E_TIMEOUT ?? 300000));
  c.on("close", (status) => { clearTimeout(t); resolve({ status, out }); });
});
console.log("opencode exit", p.status, "model", model);
console.log(p.out.slice(-1200));
console.log("routing log:");
if (existsSync(log)) for (const l of readFileSync(log, "utf8").trim().split("\n")) { const j = JSON.parse(l); console.log(`${j.tier.padEnd(9)} ${j.booted ? "BOOT" : "    "} ${String(j.ms).padStart(5)}ms exit=${j.exitCode}  ${j.command.slice(0, 90)}`); }
else console.log("(none: the tool override never ran)");
console.log("notes.txt:", readFileSync(path.join(ws, "notes.txt"), "utf8").trim());
console.log("oxdraw cloned:", existsSync(path.join(ws, "oxdraw/Cargo.toml")));
console.log("shot.png:", existsSync(path.join(ws, "shot.png")));
console.log("workspace:", ws);
