// Scripted OpenAI-compatible server. It stands in for the model so the test is
// deterministic: it asks opencode to run a fixed list of bash commands, then stops.
import http from "node:http";

/** `thinkMs` holds each reply back, standing in for model latency -- which is most of a
 *  real turn, and the only reason a sandbox has any idle time to reclaim. */
export function startMock(commands: string[], thinkMs = 0, finalText = "All commands ran."): Promise<{ port: number; close: () => void; requests: number }> {
  const state = { port: 0, close: () => {}, requests: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      state.requests++;
      if (thinkMs) await new Promise((r) => setTimeout(r, thinkMs));
      const j = JSON.parse(body || "{}");
      const msgs: any[] = j.messages ?? [];
      const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
      const done = msgs.filter((m) => m.role === "tool").length;
      const chunk = (delta: any, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!hasTools || done >= commands.length) {
        res.write(chunk({ role: "assistant", content: hasTools ? finalText : "sandroute test" }));
        res.write(chunk({}, "stop"));
      } else {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: commands[done], description: `step ${done + 1}` }) } }] }));
        res.write(chunk({}, "tool_calls"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as any).port;
      state.close = () => server.close();
      resolve(state);
    }),
  );
}
