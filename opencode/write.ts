// Drop-in replacement for opencode's built-in write tool.
//
// Without this the harness writes straight to the host, and nothing holds it to the
// workspace -- which is most of an agent's file I/O sitting outside the sandbox. Served
// here by the same filesystem the in-process shell uses.
import { tool } from "@opencode-ai/plugin";
import { forWorkspace, trace } from "../shared.ts";

export default tool({
  description: "Writes a file to the project workspace, overwriting it if it exists.",
  args: {
    filePath: tool.schema.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: tool.schema.string().describe("The content to write to the file"),
  },
  async execute(args, ctx) {
    trace("write", args);
    await forWorkspace(ctx.directory).writeFile(args.filePath, args.content);
    ctx.metadata({ title: args.filePath, metadata: { tier: "inprocess" } });
    return `wrote ${args.content.length} bytes to ${args.filePath}`;
  },
});
