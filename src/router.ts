import { BashTransformPipeline, CommandCollectorPlugin } from "just-bash";

export type Tier = "inprocess" | "vm";

export interface Decision {
  tier: Tier;
  reason: string;
}

/** Commands that always need a real machine, even if something in-process could fake them. */
export const ALWAYS_VM = new Set([
  "chromium", "chromium-browser", "google-chrome", "chrome", "firefox",
  "playwright", "puppeteer", "docker", "podman", "qemu-system-x86_64",
  "gcc", "g++", "cc", "clang", "make", "cmake", "cargo", "rustc", "go",
  "npm", "npx", "pnpm", "yarn", "bun", "node", "deno", "pip", "pip3",
  "python", "python3", "uv", "apt", "apt-get", "sudo", "ffmpeg", "convert",
]);

/** git subcommands the in-process git implements. Everything else goes to the machine. */
export const INPROCESS_GIT = new Set(["clone", "init", "status", "add", "commit", "log"]);

const GIT_RE = /(?:^|[\s;&|(`])git\s+(?:-C\s+\S+\s+)?([A-Za-z-]+)/g;

const collector = new BashTransformPipeline().use(new CommandCollectorPlugin());

/** Shell builtins the interpreter handles itself and the registry does not list. */
const BUILTINS = new Set([
  "cd", "export", "unset", "set", "shift", "source", ".", "eval", "exit", "return",
  "local", "read", "test", "[", "[[", ":", "type", "command", "declare", "wait",
  "trap", "break", "continue", "let", "pushd", "popd", "dirs", "getopts", "readonly",
]);

export function classify(known: Set<string>, command: string): Decision {
  let names: string[];
  try {
    names = collector.transform(command).metadata.commands;
  } catch (e) {
    return { tier: "vm", reason: `unparseable in-process: ${(e as Error).message.split("\n")[0]}` };
  }

  for (const name of names) {
    if (name.includes("/")) return { tier: "vm", reason: `path-invoked binary ${name}` };
    if (ALWAYS_VM.has(name)) return { tier: "vm", reason: `${name} needs a real machine` };
  }

  for (const m of command.matchAll(GIT_RE)) {
    if (!INPROCESS_GIT.has(m[1])) return { tier: "vm", reason: `git ${m[1]} not implemented in-process` };
  }

  for (const name of names) {
    if (!known.has(name) && !BUILTINS.has(name)) return { tier: "vm", reason: `${name} unknown to the in-process shell` };
  }

  return { tier: "inprocess", reason: names.length ? `all commands in-process: ${[...new Set(names)].join(" ")}` : "no commands" };
}
