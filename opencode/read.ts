// Drop-in replacement for opencode's built-in read tool. See write.ts for why.
import { tool } from "@opencode-ai/plugin";
import { forWorkspace } from "../shared.ts";

export default tool({
  description: "Reads a file from the project workspace.",
  args: {
    filePath: tool.schema.string().describe("The absolute path to the file to read"),
    offset: tool.schema.number().optional().describe("The line number to start reading from (1-indexed)"),
    limit: tool.schema.number().optional().describe("The maximum number of lines to read (defaults to 2000)"),
  },
  async execute(args, ctx) {
    const text = await forWorkspace(ctx.directory).readFile(args.filePath, { offset: args.offset, limit: args.limit });
    ctx.metadata({ title: args.filePath, metadata: { tier: "inprocess" } });
    return text;
  },
});
