import { spawn } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { startMock } from "./mock-llm.mts";

const root = path.resolve(import.meta.dirname, "..");
const ws = mkdtempSync("/tmp/claude-0/e2e-ws-");
const home = mkdtempSync("/tmp/claude-0/e2e-home-");
const log = path.join(ws, "sandroute.log");

writeFileSync(path.join(ws, "notes.txt"), "the quick brown fox\n");
writeFileSync(path.join(ws, "page.html"), `<body style="margin:0;background:#fff"><div style="height:600px;background:linear-gradient(90deg,#2b6,#26b);color:#fff;font:48px sans-serif;padding:40px">sandroute</div></body>`);
mkdirSync(path.join(ws, ".opencode/tool"), { recursive: true });
cpSync(path.join(root, "opencode/bash.ts"), path.join(ws, ".opencode/tool/bash.ts"));
// the tool imports ../src relative to .opencode/tool, so point it at the repo
writeFileSync(path.join(ws, ".opencode/tool/bash.ts"), readFileSync(path.join(root, "opencode/bash.ts"), "utf8").replace("../src/index.ts", path.join(root, "src/index.ts")));
// let the tool resolve @opencode-ai/plugin without a network install
symlinkSync(path.join(root, "node_modules"), path.join(ws, "node_modules"));

const commands = [
  "sed -i 's/quick/slow/' notes.txt && cat notes.txt",
  "git clone --depth 1 https://github.com/RohanAdwankar/oxdraw && ls oxdraw | head -3",
  "grep -c fox notes.txt",
  `chromium --headless --no-sandbox --disable-gpu --screenshot=${ws}/shot.png --window-size=800,600 file://${ws}/page.html`,
  "ls -l shot.png",
];
const mock = await startMock(commands);
writeFileSync(path.join(ws, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  model: "mock/scripted",
  small_model: "mock/scripted",
  provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "mock", options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "x" }, models: { scripted: { name: "scripted", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  permission: { "*": "allow" },
  autoupdate: false,
}, null, 2));

const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PWD: ws, HOME: home, XDG_CONFIG_HOME: home + "/c", XDG_DATA_HOME: home + "/d", XDG_CACHE_HOME: home + "/k", SANDROUTE_LOG: log, PATH: path.join(root, "e2e/bin") + ":" + process.env.PATH };
const opencode = path.join(root, "node_modules/.bin/opencode");
// async spawn: the mock server lives in this process and must keep serving
const p = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn(opencode, ["run", ...(process.env.E2E_DEBUG ? ["--print-logs", "--log-level", "DEBUG"] : []), "-m", "mock/scripted", "run the steps"], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => (stdout += d));
  c.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => c.kill("SIGKILL"), Number(process.env.E2E_TIMEOUT ?? 240000));
  c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
mock.close();
console.log("opencode exit", p.status, "mock requests", mock.requests);
if (p.status !== 0 || process.env.E2E_DEBUG) console.log(p.stdout.slice(-2500), p.stderr.slice(-2500));

console.log("\nrouting log:");
if (existsSync(log)) for (const l of readFileSync(log, "utf8").trim().split("\n")) { const j = JSON.parse(l); console.log(`${j.tier.padEnd(9)} ${j.booted ? "BOOT" : "    "} ${String(j.ms).padStart(5)}ms exit=${j.exitCode}  ${j.command.slice(0, 70)}`); }
else console.log("(no log: tool override never ran)");
console.log("\nnotes.txt:", readFileSync(path.join(ws, "notes.txt"), "utf8").trim());
console.log("oxdraw cloned:", existsSync(path.join(ws, "oxdraw/Cargo.toml")));
console.log("shot.png bytes:", existsSync(path.join(ws, "shot.png")) ? statSync(path.join(ws, "shot.png")).size : "missing");
console.log("workspace:", ws);
