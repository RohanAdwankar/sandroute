//! An MCP server over stdio that gives a coding agent a sandbox over the current directory: bash, read, write, edit, glob and grep, the six
//! tools agents use, run by sandroute. File commands run in a light sandbox, everything else in a microVM that is started on demand.
//! The project is mounted at /work inside, and paths the agent gives under the host directory are mapped there.
//!
//!   sandroute-mcp            (run from the project directory; an agent starts it)
use anyhow::Result;
use sandroute::Sandroute;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const INSTRUCTIONS: &str = "The project is at /work. Use these tools for everything: they run in an isolated sandbox over the project.";

fn tools() -> Value {
    let s = |desc: &str| json!({"type": "string", "description": desc});
    let tool = |name: &str, desc: &str, props: Value, required: Value| json!({"name": name, "description": desc, "inputSchema": {"type": "object", "properties": props, "required": required}});
    json!([
        tool("bash", "Run a shell command in the sandbox, in /work unless workdir is given.", json!({"command": s("the command"), "workdir": s("directory to run in")}), json!(["command"])),
        tool("read", "Read a file, or list a directory.", json!({"filePath": s("path"), "offset": {"type": "integer"}, "limit": {"type": "integer"}}), json!(["filePath"])),
        tool("write", "Write a file, creating directories as needed.", json!({"filePath": s("path"), "content": s("the whole file")}), json!(["filePath", "content"])),
        tool("edit", "Replace text in a file. oldString must match exactly once unless replaceAll is set.", json!({"filePath": s("path"), "oldString": s("text to replace"), "newString": s("replacement"), "replaceAll": {"type": "boolean"}}), json!(["filePath", "oldString", "newString"])),
        tool("glob", "Find files by name pattern.", json!({"pattern": s("for example **/*.py"), "path": s("directory to search")}), json!(["pattern"])),
        tool("grep", "Search file contents with a regular expression.", json!({"pattern": s("the regular expression"), "path": s("directory to search"), "include": s("file pattern such as *.py")}), json!(["pattern"])),
    ])
}

async fn call(sb: &Sandroute, host: &str, name: &str, args: &Value) -> Result<String> {
    // the agent sees its project at the host path in its prompt; inside the sandbox it is /work
    let st = |k: &str| args.get(k).and_then(Value::as_str).map(|v| v.replace(host, "/work"));
    let num = |k: &str| args.get(k).and_then(Value::as_u64).map(|n| n as usize);
    let need = |k: &str| st(k).ok_or_else(|| anyhow::anyhow!("missing {k}"));
    Ok(match name {
        "bash" => {
            let r = sb.run(&need("command")?, st("workdir").as_deref()).await?;
            let mut out = r.stdout;
            if !r.stderr.is_empty() { out += &r.stderr; }
            if r.exit_code != 0 { out += &format!("\n[exit {}]", r.exit_code); }
            out
        }
        "read" => sb.read_file(&need("filePath")?, num("offset"), num("limit")).await?,
        "write" => { sb.write_file(&need("filePath")?, &need("content")?).await?; "ok".into() }
        "edit" => format!("replaced {} occurrence(s)", sb.edit_file(&need("filePath")?, &need("oldString")?, &need("newString")?, args.get("replaceAll").and_then(Value::as_bool).unwrap_or(false)).await?),
        "glob" => sb.glob(&need("pattern")?, st("path").as_deref()).await?.join("\n"),
        "grep" => sb.grep_files(&need("pattern")?, st("path").as_deref(), st("include").as_deref()).await?.join("\n"),
        t => anyhow::bail!("unknown tool {t}"),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let host = std::env::current_dir()?.canonicalize()?.to_string_lossy().to_string();
    let sb = Sandroute::open(&host).await?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = req.get("id").cloned() else { continue }; // notifications get no reply
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion": req["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "sandroute", "version": env!("CARGO_PKG_VERSION")}, "instructions": INSTRUCTIONS}),
            "tools/list" => json!({"tools": tools()}),
            "tools/call" => match call(&sb, &host, req["params"]["name"].as_str().unwrap_or(""), &req["params"]["arguments"]).await {
                Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                Err(e) => json!({"content": [{"type": "text", "text": e.to_string()}], "isError": true}),
            },
            _ => json!({}),
        };
        out.write_all(format!("{}\n", json!({"jsonrpc": "2.0", "id": id, "result": result})).as_bytes()).await?;
        out.flush().await?;
    }
    sb.close().await
}
