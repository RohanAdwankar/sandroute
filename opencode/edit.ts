// Drop-in replacement for opencode's built-in edit tool. See write.ts for why.
import { tool } from "@opencode-ai/plugin";
import { forWorkspace } from "../shared.ts";

export default tool({
  description: "Performs an exact string replacement in a file in the project workspace.",
  args: {
    filePath: tool.schema.string().describe("The absolute path to the file to modify"),
    oldString: tool.schema.string().describe("The text to replace"),
    newString: tool.schema.string().describe("The text to replace it with (must be different from oldString)"),
    replaceAll: tool.schema.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
  },
  async execute(args, ctx) {
    const n = await forWorkspace(ctx.directory).editFile(args.filePath, args.oldString, args.newString, args.replaceAll ?? false);
    ctx.metadata({ title: args.filePath, metadata: { tier: "inprocess" } });
    return `replaced ${n} occurrence${n === 1 ? "" : "s"} in ${args.filePath}`;
  },
});
