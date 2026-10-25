use sandroute::known_commands::KNOWN;
use sandroute::router::{classify, Tier};
use std::collections::HashSet;

const WS: &str = "/work/proj";

fn known() -> HashSet<String> {
    KNOWN.iter().filter(|n| **n != "git" && **n != "curl").map(|n| n.to_string()).collect()
}
fn tier(c: &str) -> Tier {
    classify(&known(), c, WS).tier
}

#[test]
fn text_tools_stay_in_the_cheap_tier() {
    assert_eq!(tier("sed -i 's/a/b/' f.txt"), Tier::Light);
    assert_eq!(tier("cat a | grep b | sort | uniq -c"), Tier::Light);
    assert_eq!(tier("for f in *.txt; do wc -l $f; done"), Tier::Light);
}

#[test]
fn git_needs_the_machine() {
    // git needs the network and a real repository's tooling, which the file-only tier does not have
    assert_eq!(tier("git status"), Tier::Vm);
    assert_eq!(tier("git add . && git commit -m x"), Tier::Vm);
    assert_eq!(tier("git rebase main"), Tier::Vm);
}

#[test]
fn browsers_and_toolchains_go_to_the_vm() {
    assert_eq!(tier("chromium --headless --screenshot=a.png https://x"), Tier::Vm);
    assert_eq!(tier("npm install"), Tier::Vm);
    assert_eq!(tier("cargo build"), Tier::Vm);
}

#[test]
fn a_vm_command_anywhere_in_a_line_sends_the_whole_line_to_the_vm() {
    assert_eq!(tier("cat a.txt && chromium --version"), Tier::Vm);
    assert_eq!(tier("echo $(node -v)"), Tier::Vm);
}

#[test]
fn unknown_binaries_and_path_invoked_scripts_go_to_the_vm() {
    assert_eq!(tier("mytool --flag"), Tier::Vm);
    assert_eq!(tier("./build.sh"), Tier::Vm);
}

#[test]
fn questions_about_the_machine_go_to_the_vm_so_the_agent_gets_a_true_answer() {
    assert_eq!(tier("command -v chromium"), Tier::Vm);
    assert_eq!(tier("which node"), Tier::Vm);
    assert_eq!(tier("echo $PATH"), Tier::Vm);
    assert_eq!(tier("uname -a"), Tier::Vm);
}

#[test]
fn paths_outside_the_workspace_go_to_the_vm_and_paths_inside_do_not() {
    assert_eq!(tier("ls /usr/bin | grep chrom"), Tier::Vm);
    assert_eq!(tier("cat /tmp/out.json"), Tier::Vm);
    assert_eq!(tier(&format!("cat {WS}/a.txt")), Tier::Light);
    assert_eq!(tier("grep x f 2>/dev/null"), Tier::Light);
    assert_eq!(tier("sed 's/quick/slow/' a.txt"), Tier::Light);
}

#[test]
fn network_clients_go_to_the_vm() {
    assert_eq!(tier("curl -s https://example.com"), Tier::Vm);
}

#[test]
fn a_heredoc_body_is_data_not_shell() {
    // writing a file is writing a file, whatever is in it
    assert_eq!(tier("cat > page.py <<'PY'\nrows = \"<li>x</li>\"\nCONF = \"/etc/passwd\"\nPY"), Tier::Light);
    assert_eq!(tier("cat > a.sh <<'SH'\ngit rebase main\nexport PATH=/usr/bin\nSH"), Tier::Light);
    // an unquoted delimiter is still a heredoc
    assert_eq!(tier("cat > n.txt <<EOF\nsee /var/log/syslog\nEOF"), Tier::Light);
    // two heredocs on one line, bodies in order
    assert_eq!(tier("cat <<A > x && cat <<B > y\n/etc/one\nA\n/etc/two\nB"), Tier::Light);
    // and the shell around the heredoc is still read
    assert_eq!(tier("cat > f.txt <<'EOF' && cat /etc/hosts\njust text\nEOF"), Tier::Vm);
    assert_eq!(tier("cat /etc/hosts"), Tier::Vm);
}

#[test]
fn the_process_table_is_the_machines_whatever_the_cheap_tier_could_run() {
    // Declare the tier knows all of these and the answer must not change.
    let process = ["kill 123", "pkill -f worker", "pgrep node", "killall python3", "pidof sshd", "lsof -i :8080", "ss -ltn", "netstat -tlnp", "fuser 8080/tcp",
        "crontab -l", "systemctl status x", "service x restart", "uptime"];
    let mut claims_all = known();
    claims_all.extend(process.iter().map(|c| c.split(' ').next().unwrap().to_string()));
    for c in process {
        assert_eq!(classify(&claims_all, c, WS).tier, Tier::Vm, "{c}");
    }
}

#[test]
fn a_line_that_does_not_parse_goes_to_the_vm() {
    assert_eq!(tier("echo 'unterminated"), Tier::Vm);
}
