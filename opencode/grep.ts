// Drop-in replacement for opencode's built-in grep tool. See write.ts for why.
import { tool } from "@opencode-ai/plugin";
import { forWorkspace, trace } from "../shared.ts";

export default tool({
  description: "Finds files in the project workspace whose contents match a pattern.",
  args: {
    pattern: tool.schema.string().describe("The regex pattern to search for in file contents"),
    path: tool.schema.string().optional().describe("The directory to search in. Defaults to the project directory."),
    include: tool.schema.string().optional().describe('File pattern to include in the search (e.g. "*.js")'),
  },
  async execute(args, ctx) {
    trace("grep", args);
    const hits = await forWorkspace(ctx.directory).grepFiles(args.pattern, args.path, args.include);
    ctx.metadata({ title: args.pattern, metadata: { tier: "inprocess", hits: hits.length } });
    return hits.join("\n") || "no matches";
  },
});
