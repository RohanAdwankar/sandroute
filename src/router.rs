//! Decides, for one shell command line, whether the file-only tier can run it or it needs a machine.
use fancy_regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// the cheap tier: a namespace sandbox on the host
    Light,
    Vm,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Light => "light",
            Tier::Vm => "vm",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub tier: Tier,
    pub reason: String,
}

fn vm(reason: String) -> Decision {
    Decision { tier: Tier::Vm, reason }
}

/// Commands that always need a real machine.
const ALWAYS_VM: &[&str] = &[
    "chromium", "chromium-browser", "google-chrome", "chrome", "firefox", "playwright", "puppeteer", "docker", "podman", "qemu-system-x86_64",
    "gcc", "g++", "cc", "clang", "make", "cmake", "cargo", "rustc", "go", "npm", "npx", "pnpm", "yarn", "bun", "node", "deno", "pip", "pip3",
    "python", "python3", "uv", "apt", "apt-get", "sudo", "ffmpeg", "convert",
];

/// Commands whose answer describes the machine, not the workspace, so asking the cheap tier would give a false answer. Network
/// clients go to the VM too: the VM is where egress policy belongs. The process table and what schedules against it live in
/// the machine and nowhere else, whatever a shell might claim to implement.
const MACHINE_QUERIES: &[&str] = &[
    "which", "command", "type", "hash", "env", "printenv", "uname", "id", "whoami", "hostname", "nproc", "df", "free", "ps", "top", "lscpu",
    "curl", "wget", "ssh", "scp", "kill", "pkill", "pgrep", "killall", "pidof", "lsof", "ss", "netstat", "fuser", "crontab", "systemctl",
    "service", "uptime",
];

/// Shell builtins, which no registry lists.
const BUILTINS: &[&str] = &[
    "cd", "export", "unset", "set", "shift", "source", ".", "eval", "exit", "return", "local", "read", "test", "[", "[[", ":", "type", "command",
    "declare", "wait", "trap", "break", "continue", "let", "pushd", "popd", "dirs", "getopts", "readonly",
];

const DEV_OK: &[&str] = &["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"];

/// What the file-only tier may run: the known utilities that exist on this host. git and curl need the network, which the sandbox lacks.
pub fn known_for_sandbox() -> HashSet<String> {
    crate::known_commands::KNOWN
        .iter()
        .filter(|n| **n != "git" && **n != "curl" && std::path::Path::new(&format!("/usr/bin/{n}")).exists())
        .map(|n| n.to_string())
        .collect()
}

fn heredoc_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1"#).unwrap())
}

/// Walk the lines of a command, calling `line` for each ordinary line and `delimiter` for the closing line of each heredoc; the body
/// lines in between are skipped.
fn heredoc_lines<'a>(command: &'a str, mut line: impl FnMut(&'a str), mut delimiter: impl FnMut(&'a str)) {
    let lines: Vec<&str> = command.split('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        i += 1;
        line(l);
        for caps in heredoc_re().captures_iter(l).flatten() {
            let delim = caps.get(2).unwrap().as_str();
            while i < lines.len() && lines[i].trim() != delim {
                i += 1;
            }
            if i < lines.len() {
                delimiter(lines[i]);
                i += 1;
            }
        }
    }
}

/// Blank out heredoc bodies. They are data the agent is writing, not shell: an app that contains "</li>" or a config mentioning /etc is
/// not a reason to boot a VM. This is for the text scans below; the closing delimiter is kept.
pub fn strip_heredocs(command: &str) -> String {
    if !command.contains("<<") {
        return command.to_string();
    }
    let out = std::cell::RefCell::new(Vec::new());
    heredoc_lines(command, |l| out.borrow_mut().push(l), |d| out.borrow_mut().push(d));
    let joined = out.into_inner().join("\n");
    joined
}

/// The command with each heredoc turned into a plain redirect and its body and delimiter dropped, which is what the shell parser reads:
/// it does not parse a line with two heredocs on it.
fn without_heredocs(command: &str) -> String {
    if !command.contains("<<") {
        return command.to_string();
    }
    let out = std::cell::RefCell::new(Vec::new());
    heredoc_lines(command, |l| out.borrow_mut().push(heredoc_re().replace_all(l, "< /dev/null").into_owned()), |_| {});
    let joined = out.into_inner().join("\n");
    joined
}

/// The first absolute path in the text that is not inside the workspace. A path is not preceded by a word character, dot, tilde,
/// dollar, slash or dash, so URLs and sed's s/a/b/ do not match.
fn outside_workspace(command: &str, workspace: &str) -> Option<String> {
    let b: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < b.len() {
        let after_ok = i == 0 || !(b[i - 1].is_alphanumeric() || b[i - 1] == '_' || ".~$/-".contains(b[i - 1]));
        if b[i] == '/' && after_ok && b.get(i + 1).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.') {
            let mut j = i + 1;
            while j < b.len() && !b[j].is_whitespace() && !";|&<>()'\"`".contains(b[j]) {
                j += 1;
            }
            let p: String = b[i..j].iter().collect();
            let p = p.trim_end_matches([',', ':']);
            let inside = p == workspace || p.starts_with(&format!("{workspace}/"));
            if !DEV_OK.contains(&p) && !inside {
                return Some(p.to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// The name of every command the line runs, anywhere in it: pipelines, substitutions, loops. None when the line does not parse.
pub fn command_names(command: &str) -> Option<Vec<String>> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_bash::LANGUAGE.into()).ok()?;
    let command = &without_heredocs(command);
    let tree = parser.parse(command, None)?;
    if tree.root_node().has_error() {
        return None;
    }
    let (mut names, mut stack) = (Vec::new(), vec![tree.root_node()]);
    while let Some(n) = stack.pop() {
        if n.kind() == "command_name" {
            names.push(command[n.byte_range()].to_string());
        }
        let mut c = n.walk();
        stack.extend(n.children(&mut c));
    }
    names.reverse();
    Some(names)
}

pub fn classify(known: &HashSet<String>, command: &str, workspace: &str) -> Decision {
    let Some(names) = command_names(command) else {
        return vm("unparseable".to_string());
    };
    for name in &names {
        if name.contains('/') {
            return vm(format!("path-invoked binary {name}"));
        }
        if ALWAYS_VM.contains(&name.as_str()) {
            return vm(format!("{name} needs a real machine"));
        }
        if MACHINE_QUERIES.contains(&name.as_str()) {
            return vm(format!("{name} asks about the machine, not the workspace"));
        }
    }
    let shell = strip_heredocs(command);
    if let Some(outside) = outside_workspace(&shell, workspace) {
        return vm(format!("{outside} is outside the workspace, which only the VM can see"));
    }
    static PATH_RE: OnceLock<Regex> = OnceLock::new();
    if PATH_RE.get_or_init(|| Regex::new(r"\$\{?PATH\b").unwrap()).is_match(&shell).unwrap_or(false) {
        return vm("reads the machine's PATH".to_string());
    }
    for name in &names {
        if !known.contains(name) && !BUILTINS.contains(&name.as_str()) {
            return vm(format!("{name} is not one of the utilities the file-only tier runs"));
        }
    }
    let mut seen = Vec::new();
    for n in &names {
        if !seen.contains(n) {
            seen.push(n.clone());
        }
    }
    Decision {
        tier: Tier::Light,
        reason: if seen.is_empty() { "no commands".to_string() } else { format!("all commands in-process: {}", seen.join(" ")) },
    }
}
