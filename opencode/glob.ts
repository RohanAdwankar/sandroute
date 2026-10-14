// Drop-in replacement for opencode's built-in glob tool. See write.ts for why.
import { tool } from "@opencode-ai/plugin";
import { forWorkspace } from "../shared.ts";

export default tool({
  description: "Finds files in the project workspace by name pattern.",
  args: {
    pattern: tool.schema.string().describe("The glob pattern to match files against"),
    path: tool.schema.string().optional().describe("The directory to search in. Defaults to the project directory."),
  },
  async execute(args, ctx) {
    const hits = await forWorkspace(ctx.directory).glob(args.pattern, args.path);
    ctx.metadata({ title: args.pattern, metadata: { tier: "inprocess", hits: hits.length } });
    return hits.join("\n") || "no matches";
  },
});
