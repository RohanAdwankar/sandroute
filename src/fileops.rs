//! The file tools as shell commands, so any sandbox that can run a command can serve them.
//!
//! Content travels inside the command as base64 rather than on stdin: the guest agent takes a command string and nothing else, and a
//! command string behaves the same in every sandbox.
use base64::{engine::general_purpose::STANDARD, Engine};

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
fn b64(s: &str) -> String {
    STANDARD.encode(s)
}

#[derive(Clone, Debug)]
pub enum FileCall {
    Read { file_path: String, offset: Option<usize>, limit: Option<usize> },
    Write { file_path: String, content: String },
    Edit { file_path: String, old_string: String, new_string: String, replace_all: bool },
    Glob { pattern: String, path: Option<String> },
    Grep { pattern: String, path: Option<String>, include: Option<String> },
}

const EDIT: &str = r#"import sys, json, base64
a = json.loads(base64.b64decode(sys.argv[1]))
s = open(a["f"], encoding="utf-8").read()
n = s.count(a["o"])
if n == 0: sys.exit("oldString not found in " + a["f"])
if n > 1 and not a["all"]: sys.exit("oldString appears %d times in %s; pass replaceAll" % (n, a["f"]))
open(a["f"], "w", encoding="utf-8").write(s.replace(a["o"], a["n"]) if a["all"] else s.replace(a["o"], a["n"], 1))
print(n if a["all"] else 1)"#;

pub fn file_command(c: &FileCall) -> String {
    match c {
        FileCall::Read { file_path, offset, limit } => {
            // the built-in read tool lists a directory, and agents ask it to constantly
            let body = if offset.is_none() && limit.is_none() {
                format!("cat -- {}", q(file_path))
            } else {
                let from = offset.unwrap_or(1).max(1);
                format!("sed -n '{},{}p' {}", from, from + limit.unwrap_or(2000) - 1, q(file_path))
            };
            format!("if [ -d {p} ]; then ls -1Ap -- {p}; else {body}; fi", p = q(file_path))
        }
        FileCall::Write { file_path, content } => {
            format!("mkdir -p \"$(dirname -- {p})\" && printf %s {c} | base64 -d > {p}", p = q(file_path), c = q(&b64(content)))
        }
        FileCall::Edit { file_path, old_string, new_string, replace_all } => {
            let args = serde_json::json!({ "f": file_path, "o": old_string, "n": new_string, "all": replace_all });
            format!("python3 -c {} {}", q(EDIT), q(&b64(&args.to_string())))
        }
        FileCall::Glob { pattern, path } => format!("find {} -type f -name {}", q(path.as_deref().unwrap_or(".")), q(pattern)),
        FileCall::Grep { pattern, path, include } => match include {
            Some(inc) => format!("find {} -type f -name {} -exec grep -l -e {} {{}} +", q(path.as_deref().unwrap_or(".")), q(inc), q(pattern)),
            None => format!("grep -rl -e {} {}", q(pattern), q(path.as_deref().unwrap_or("."))),
        },
    }
}
