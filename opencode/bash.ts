// Drop-in replacement for opencode's built-in bash tool.
// Copy to <project>/.opencode/tool/bash.ts. Same name, so it overrides the built-in.
import { tool } from "@opencode-ai/plugin";
import { Sandroute } from "../src/index.ts";

const runners = new Map<string, Sandroute>();

function forWorkspace(dir: string) {
  let r = runners.get(dir);
  if (!r) {
    r = new Sandroute({ workspace: dir, logFile: process.env.SANDROUTE_LOG });
    runners.set(dir, r);
  }
  return r;
}

export default tool({
  description:
    "Executes a bash command in the project directory. Commands run in-process where possible and in a microVM when they need a real machine.",
  args: {
    command: tool.schema.string().describe("The command to execute"),
    timeout: tool.schema.number().optional().describe("Optional timeout in milliseconds"),
    workdir: tool.schema.string().optional().describe("Working directory, defaults to the project directory"),
    description: tool.schema.string().optional().describe("Short description of what the command does"),
  },
  async execute(args, ctx) {
    const r = await forWorkspace(ctx.directory).run(args.command, args.workdir);
    ctx.metadata({ title: args.description ?? args.command, metadata: { tier: r.tier, reason: r.reason } });
    const out = r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "");
    return r.exitCode === 0 ? out : `${out}\n[exit ${r.exitCode}]`;
  },
});
