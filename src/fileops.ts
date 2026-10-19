// The file tools as shell commands, so any sandbox that can run a command can serve them.
//
// Content travels inside the command as base64 rather than on stdin: the guest agent takes a
// command string and nothing else, and a command string behaves the same in every sandbox.

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const b64 = (s: string) => Buffer.from(s).toString("base64");

export type FileCall =
  | { tool: "read"; filePath: string; offset?: number; limit?: number }
  | { tool: "write"; filePath: string; content: string }
  | { tool: "edit"; filePath: string; oldString: string; newString: string; replaceAll?: boolean }
  | { tool: "glob"; pattern: string; path?: string }
  | { tool: "grep"; pattern: string; path?: string; include?: string };

const EDIT = `import sys, json, base64
a = json.loads(base64.b64decode(sys.argv[1]))
s = open(a["f"], encoding="utf-8").read()
n = s.count(a["o"])
if n == 0: sys.exit("oldString not found in " + a["f"])
if n > 1 and not a["all"]: sys.exit("oldString appears %d times in %s; pass replaceAll" % (n, a["f"]))
open(a["f"], "w", encoding="utf-8").write(s.replace(a["o"], a["n"]) if a["all"] else s.replace(a["o"], a["n"], 1))
print(n if a["all"] else 1)`;

export function fileCommand(c: FileCall): string {
  switch (c.tool) {
    case "read": {
      // the built-in read tool lists a directory, and agents ask it to constantly
      const body = c.offset === undefined && c.limit === undefined
        ? `cat -- ${q(c.filePath)}`
        : `sed -n '${Math.max(1, c.offset ?? 1)},${Math.max(1, c.offset ?? 1) + (c.limit ?? 2000) - 1}p' ${q(c.filePath)}`;
      return `if [ -d ${q(c.filePath)} ]; then ls -1Ap -- ${q(c.filePath)}; else ${body}; fi`;
    }
    case "write":
      return `mkdir -p "$(dirname -- ${q(c.filePath)})" && printf %s ${q(b64(c.content))} | base64 -d > ${q(c.filePath)}`;
    case "edit":
      return `python3 -c ${q(EDIT)} ${q(b64(JSON.stringify({ f: c.filePath, o: c.oldString, n: c.newString, all: !!c.replaceAll })))}`;
    case "glob":
      return `find ${q(c.path ?? ".")} -type f -name ${q(c.pattern)}`;
    case "grep":
      return c.include
        ? `find ${q(c.path ?? ".")} -type f -name ${q(c.include)} -exec grep -l -e ${q(c.pattern)} {} +`
        : `grep -rl -e ${q(c.pattern)} ${q(c.path ?? ".")}`;
  }
}
