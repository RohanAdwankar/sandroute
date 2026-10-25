//! Recorded agent sessions: the calls an agent made and the time the model took between them. The benchmarks replay these, so every design
//! is measured against the same real behavior.
use crate::fileops::FileCall;
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct Call {
    pub tool: String,
    pub args: Value,
    /// how long the model took before making this call, when it was recorded
    pub think_ms: Option<u64>,
    /// the position in the recording, which names the call in the calibration file
    pub idx: usize,
}

#[derive(Clone, Debug)]
pub struct Trace {
    /// task and model
    pub id: String,
    /// where the recording was made; paths under it are rewritten to /work on replay
    pub workspace: String,
    pub calls: Vec<Call>,
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

impl Call {
    /// The call as a tenant at /work would make it.
    pub fn rewritten(&self, workspace: &str) -> Call {
        let args: Value = serde_json::from_str(&self.args.to_string().replace(workspace, "/work")).unwrap_or(Value::Null);
        Call { args, ..self.clone() }
    }

    /// A recording may touch a path outside the project, such as the agent's own skills directory. No tenant has that, so those calls cannot
    /// be replayed.
    pub fn in_project(&self, workspace: &str) -> bool {
        self.tool == "bash" || ["filePath", "path"].iter().find_map(|k| self.args.get(*k).and_then(Value::as_str)).is_none_or(|p| p.starts_with(workspace))
    }

    pub fn file_call(&self) -> Option<FileCall> {
        let a = &self.args;
        let n = |k: &str| a.get(k).and_then(Value::as_u64).map(|n| n as usize);
        Some(match self.tool.as_str() {
            "read" => FileCall::Read { file_path: text(a, "filePath")?, offset: n("offset"), limit: n("limit") },
            "write" => FileCall::Write { file_path: text(a, "filePath")?, content: text(a, "content")? },
            "edit" => FileCall::Edit { file_path: text(a, "filePath")?, old_string: text(a, "oldString")?, new_string: text(a, "newString")?, replace_all: a.get("replaceAll").and_then(Value::as_bool).unwrap_or(false) },
            "glob" => FileCall::Glob { pattern: text(a, "pattern")?, path: text(a, "path") },
            "grep" => FileCall::Grep { pattern: text(a, "pattern")?, path: text(a, "path"), include: text(a, "include") },
            _ => return None,
        })
    }
}

/// The sessions that ran to the end and made at least one call, with the calls that cannot be replayed left out.
pub fn load(dir: &Path) -> Result<Vec<Trace>> {
    let mut out = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(dir)?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json") && p.file_name().is_some_and(|n| n != "intrinsic.json")).collect();
    files.sort();
    for f in files {
        let r: Value = serde_json::from_str(&std::fs::read_to_string(&f)?)?;
        let calls: Vec<Call> = r["calls"].as_array().cloned().unwrap_or_default().into_iter().enumerate()
            .map(|(idx, c)| Call { tool: text(&c, "tool").unwrap_or_default(), args: c["args"].clone(), think_ms: c["thinkMs"].as_u64(), idx }).collect();
        if r["exit"].as_i64() != Some(0) || calls.is_empty() {
            continue;
        }
        let workspace = text(&r, "workspace").unwrap_or_default();
        let calls = calls.into_iter().filter(|c| c.in_project(&workspace)).collect();
        out.push(Trace { id: format!("{}/{}", text(&r, "task").unwrap_or_default(), text(&r, "model").unwrap_or_default()), workspace, calls });
    }
    Ok(out)
}
