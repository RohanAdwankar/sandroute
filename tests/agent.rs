//! The guest agent runs here as a plain process on a unix socket, with its own directory standing in for the guest disk. This exercises
//! the protocol and the file sync, not the VM.
use sandroute::agent::{expected_agent, manifest, AgentClient, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

struct Rig {
    host: tempfile::TempDir,
    guest: tempfile::TempDir,
    client: AgentClient,
    agent: Child,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.client.close();
        let _ = self.agent.kill();
        let _ = self.agent.wait();
    }
}

/// The guest agent is its own crate, so the tests build it once and run the binary.
fn agent_bin() -> PathBuf {
    static BUILT: std::sync::Once = std::sync::Once::new();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    BUILT.call_once(|| assert!(Command::new("cargo").args(["build", "-q", "-p", "guest-agent"]).current_dir(&root).status().unwrap().success()));
    root.join("target/debug/guest-agent")
}

async fn rig_with(agent_args: &[String], opts: OpenOptions) -> Rig {
    let host = tempfile::tempdir().unwrap();
    let guest = tempfile::tempdir().unwrap();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock = sock_dir.path().join("a.sock");
    let mut agent = Command::new(agent_bin())
        .args(["--workspace".as_ref(), guest.path().as_os_str(), "--unix".as_ref(), sock.as_os_str()])
        .args(agent_args)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // "agent ready" once it is listening
    let mut out = std::io::BufReader::new(agent.stdout.take().unwrap());
    let mut line = String::new();
    std::io::BufRead::read_line(&mut out, &mut line).unwrap();
    std::mem::forget(sock_dir);
    let stream = UnixStream::connect(&sock).await.unwrap();
    let client = AgentClient::open(stream, host.path(), opts).await.unwrap();
    Rig { host, guest, client, agent }
}

async fn rig() -> Rig {
    rig_with(&[], OpenOptions::default()).await
}

fn p(d: &tempfile::TempDir, rel: &str) -> PathBuf {
    d.path().join(rel)
}
fn read(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).unwrap()
}
fn guest_cwd(r: &Rig) -> String {
    r.guest.path().to_string_lossy().to_string()
}

#[tokio::test]
async fn host_files_are_visible_in_the_guest_and_guest_writes_come_back() {
    let r = rig().await;
    std::fs::write(p(&r.host, "in.txt"), "from host\n").unwrap();
    let out = r.client.exec("cat in.txt && echo from guest > out.txt", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "from host\n");
    assert_eq!(read(p(&r.host, "out.txt")), "from guest\n");
}

#[tokio::test]
async fn only_changed_files_are_pushed_on_later_calls_and_deletes_propagate_both_ways() {
    let r = rig().await;
    std::fs::write(p(&r.host, "a.txt"), "1").unwrap();
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    std::fs::write(p(&r.host, "a.txt"), "22").unwrap(); // edited between VM calls
    std::fs::create_dir(p(&r.host, "sub")).unwrap();
    std::fs::write(p(&r.host, "sub/b.txt"), "b").unwrap();
    let out = r.client.exec("cat a.txt sub/b.txt; rm a.txt", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(out.stdout, "22b");
    assert!(!p(&r.host, "a.txt").exists(), "a guest delete reached the host");
}

#[tokio::test]
async fn exit_codes_and_stderr_come_through() {
    let r = rig().await;
    let out = r.client.exec("echo oops >&2; exit 3", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(out.code, 3);
    assert_eq!(out.stderr, "oops\n");
}

#[test]
fn the_manifest_never_follows_a_symlink_out_of_the_workspace() {
    let (ws, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::write(outside.path().join("secret.txt"), "not the agent's to see\n").unwrap();
    std::fs::write(ws.path().join("a.txt"), "mine\n").unwrap();
    std::fs::create_dir_all(ws.path().join("sub")).unwrap();
    std::fs::write(ws.path().join("sub/b.txt"), "also mine\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), ws.path().join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), ws.path().join("peek.txt")).unwrap();
    let mut files: Vec<String> = manifest(ws.path()).files.into_keys().collect();
    files.sort();
    assert_eq!(files, ["a.txt", "sub/b.txt"]);
}

#[test]
fn the_manifest_skips_node_modules_and_git_wherever_they_appear() {
    let ws = tempfile::tempdir().unwrap();
    for d in [".opencode/node_modules/pkg", ".git/objects", "node_modules_old"] {
        std::fs::create_dir_all(ws.path().join(d)).unwrap();
    }
    std::fs::write(ws.path().join(".opencode/node_modules/pkg/index.js"), "dep\n").unwrap();
    std::fs::write(ws.path().join(".git/objects/abc"), "blob\n").unwrap();
    std::fs::write(ws.path().join("node_modules_old/keep.txt"), "not a dep dir\n").unwrap();
    std::fs::write(ws.path().join("a.txt"), "mine\n").unwrap();
    let mut files: Vec<String> = manifest(ws.path()).files.into_keys().collect();
    files.sort();
    assert_eq!(files, ["a.txt", "node_modules_old/keep.txt"]);
}

#[tokio::test]
async fn a_guest_that_dies_mid_request_does_not_leave_the_caller_waiting() {
    let mut r = rig().await;
    let cwd = guest_cwd(&r);
    let client = Arc::new(std::mem::replace(&mut r.client, dummy_closed().await));
    let c2 = client.clone();
    let slow = tokio::spawn(async move { c2.exec("sleep 30", &cwd, None).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = r.agent.kill(); // the guest goes away while the command is still running
    let err = slow.await.unwrap().unwrap_err().to_string();
    assert!(err.contains("closed"), "{err}");
    // and anything asked afterwards fails rather than hanging
    let err = client.exec("true", "/", None).await.unwrap_err().to_string();
    assert!(err.contains("closed"), "{err}");
}

/// a client whose connection is already gone, to stand in a Rig whose real client has been taken out
async fn dummy_closed() -> AgentClient {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("d.sock");
    let l = UnixListener::bind(&sock).unwrap();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut line = String::new();
        BufReader::new(&mut s).read_line(&mut line).await.unwrap();
        s.write_all(b"{\"ok\":true}\n").await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });
    AgentClient::open(UnixStream::connect(&sock).await.unwrap(), dir.path(), OpenOptions::default()).await.unwrap()
}

#[tokio::test]
async fn an_empty_directory_reaches_the_guest_and_one_the_guest_makes_comes_back() {
    let r = rig().await;
    std::fs::create_dir_all(p(&r.host, "dist/nested")).unwrap();
    let out = r.client.exec("test -d dist/nested && mkdir -p out/made && echo yes", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(out.stdout.trim(), "yes", "a directory with no files in it must still exist in the guest");
    assert!(p(&r.host, "out/made").exists(), "and one the guest creates must come back");
}

#[tokio::test]
async fn a_same_size_rewrite_the_signature_cannot_distinguish_is_still_seen() {
    let r = rig().await;
    // Pin the timestamp so both versions carry an identical mtime and size: what a filesystem with coarse timestamps does on its own, and
    // what clock skew does to any of them. The signature is then useless and only the unsettled check saves it.
    let f = p(&r.host, "f.txt");
    let stamp = std::time::SystemTime::now() + Duration::from_secs(1);
    let pin = |f: &Path| std::fs::File::options().write(true).open(f).unwrap().set_modified(stamp).unwrap();
    std::fs::write(&f, "aaaa").unwrap();
    pin(&f);
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    std::fs::write(&f, "bbbb").unwrap();
    pin(&f);
    assert_eq!(r.client.exec("cat f.txt", &guest_cwd(&r), None).await.unwrap().stdout, "bbbb");
}

#[tokio::test]
async fn the_guests_scratch_space_is_kept_on_the_host_and_comes_back_when_the_guest_is_replaced() {
    let (gscratch, hscratch) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::write(gscratch.path().join("from-the-image"), "put there by the image, not by a tenant").unwrap();
    let g = gscratch.path().to_string_lossy().to_string();
    {
        let first = rig_with(&["--scratch".into(), g.clone()], OpenOptions { scratch_dir: Some(hscratch.path().to_path_buf()), ..Default::default() }).await;
        first.client.exec(&format!("echo draft > {g}/note.txt; mkdir -p {g}/sub && echo deep > {g}/sub/x"), &guest_cwd(&first), None).await.unwrap();
        assert_eq!(read(hscratch.path().join("note.txt")), "draft\n", "a file the guest wrote in scratch reaches the host");
        assert_eq!(read(hscratch.path().join("sub/x")), "deep\n");
        assert!(!hscratch.path().join("from-the-image").exists(), "what the image put there is not the host's to hold");
    }
    // the guest is thrown away and a clean one starts; the host's copy is all that is left of its scratch space
    let fresh = tempfile::tempdir().unwrap();
    let f = fresh.path().to_string_lossy().to_string();
    let second = rig_with(&["--scratch".into(), f.clone()], OpenOptions { scratch_dir: Some(hscratch.path().to_path_buf()), ..Default::default() }).await;
    let out = second.client.exec(&format!("cat {f}/note.txt {f}/sub/x"), &guest_cwd(&second), None).await.unwrap();
    assert_eq!(out.stdout, "draft\ndeep\n", "the new guest has what the old one wrote");
    std::fs::remove_file(hscratch.path().join("note.txt")).unwrap();
    assert!(!second.client.exec(&format!("ls {f}"), &guest_cwd(&second), None).await.unwrap().stdout.contains("note.txt"), "and a delete on the host reaches it");
}

#[tokio::test]
async fn a_file_too_large_to_copy_fails_by_name_instead_of_dying_inside_the_sync() {
    let r = rig_with(&[], OpenOptions { max_file_bytes: Some(1024), ..Default::default() }).await;
    std::fs::write(p(&r.host, "fixture.bin"), vec![0u8; 4096]).unwrap();
    let err = r.client.exec("true", &guest_cwd(&r), None).await.unwrap_err().to_string();
    assert!(err.contains("fixture.bin is 0MiB, over the 0MiB sync limit"), "{err}");
}

#[tokio::test]
async fn what_a_background_process_writes_comes_back_on_the_next_command() {
    let r = rig().await;
    std::fs::write(p(&r.host, "config.txt"), "from host\n").unwrap();
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    // whatever the agent leaves running writes between commands, not during one
    r.client.exec("nohup sh -c 'echo line >> out.log; echo from-the-job > config.txt' >/dev/null 2>&1 &", &guest_cwd(&r), None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(read(p(&r.host, "out.log")), "line\n");
    assert_eq!(read(p(&r.host, "config.txt")), "from-the-job\n", "the host must not keep a version the guest has moved past");
}

#[tokio::test]
async fn a_file_both_sides_changed_keeps_the_guests_version_and_says_so() {
    let r = rig().await;
    let f = "shared.txt";
    std::fs::write(p(&r.host, f), "original\n").unwrap();
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let s2 = seen.clone();
    r.client.on_conflict(move |c| s2.lock().unwrap().push(c));
    // the guest moves it on out of band, the host edits the version it still believes in
    std::fs::write(p(&r.guest, f), "from the guest\n").unwrap();
    std::fs::write(p(&r.host, f), "from the host\n").unwrap();
    r.client.exec("true", &guest_cwd(&r), None).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![vec![f.to_string()]], "the host must be told its write did not land");
    assert_eq!(read(p(&r.guest, f)), "from the guest\n", "the guest keeps its own");
    assert_eq!(read(p(&r.host, f)), "from the guest\n", "and the host converges on it");
}

#[tokio::test]
async fn a_pinned_vm_hands_over_what_it_has_written_while_it_runs() {
    let r = rig().await;
    r.client.exec("nohup sh -c 'sleep 0.3; echo served > late.txt; sleep 5' >/dev/null 2>&1 &", &guest_cwd(&r), None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let b = r.client.busy().await.unwrap(); // the idle timer's probe, nothing else
    assert!(b.busy, "something is still running in there");
    assert_eq!(read(p(&r.host, "late.txt")), "served\n", "the probe collects what it wrote, without any command being run");
}

/// A stub guest, because the point is the handshake and not the agent: it answers every line with what `reply` says.
async fn stub(sock: &Path, reply: &'static str, asked: Arc<Mutex<Vec<serde_json::Value>>>) {
    let l = UnixListener::bind(sock).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let asked = asked.clone();
            tokio::spawn(async move {
                let (r, mut w) = s.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    asked.lock().unwrap().push(serde_json::from_str(&line).unwrap());
                    if w.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}

#[tokio::test]
async fn a_guest_built_from_a_different_agent_is_refused_at_connect() {
    let dir = tempfile::tempdir().unwrap();
    for (n, (reply, why)) in [(r#"{"ok":true,"agent":"0000deadbeef"}"#, "an image built from a different agent"), (r#"{"ok":true}"#, "an image too old to say which agent it carries")].into_iter().enumerate() {
        let sock = dir.path().join(format!("a{n}.sock"));
        stub(&sock, reply, Arc::default()).await;
        let err = AgentClient::open(UnixStream::connect(&sock).await.unwrap(), dir.path(), OpenOptions { expect_agent: Some("feedfacecafe".into()), ..Default::default() }).await.err().expect(why);
        assert!(err.to_string().contains("rebuild the image"), "{why}: {err}");
    }
}

#[tokio::test]
async fn the_host_sets_the_guests_clock_from_its_own_when_connecting() {
    // A restored guest is as far behind as the time since its snapshot, so the host has to tell it what time it is.
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("a.sock");
    let asked = Arc::new(Mutex::new(Vec::new()));
    stub(&sock, r#"{"ok":true,"agent":"x"}"#, asked.clone()).await;
    AgentClient::open(UnixStream::connect(&sock).await.unwrap(), dir.path(), OpenOptions { sync_clock: true, ..Default::default() }).await.unwrap();
    let asked = asked.lock().unwrap();
    let clock = asked.iter().find(|r| r["op"] == "clock").expect("the clock was set");
    let skew = (clock["epoch"].as_f64().unwrap() - std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64()).abs();
    assert!(skew < 5.0, "the epoch it was given is the host's now");
    assert_eq!(asked[0]["op"], "ping");
}

#[tokio::test]
async fn a_guest_reports_state_only_for_what_a_release_would_lose_and_the_host_cannot_rebuild() {
    // upper stands in for the directory where the guest's changes to its image land, and scratch for the throwaway space that is the host's too.
    // The workspace is inside upper, as it is in the real guest, because the whole of the guest's writable root is there.
    let (upper, scratch) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::create_dir_all(upper.path().join("usr/lib/py/__pycache__")).unwrap();
    std::fs::write(upper.path().join("usr/lib/py/__pycache__/mod.pyc"), "bytecode").unwrap();
    let r = rig_with(
        &["--upper".into(), upper.path().to_string_lossy().into(), "--scratch".into(), scratch.path().to_string_lossy().into()],
        OpenOptions { scratch_dir: Some(tempfile::tempdir().unwrap().keep()), ..Default::default() },
    )
    .await;
    let rel = r.guest.path().strip_prefix("/").unwrap();
    std::fs::create_dir_all(upper.path().join(rel)).unwrap();
    std::fs::write(upper.path().join(rel).join("mine.txt"), "the workspace is the host's").unwrap();
    assert_eq!(r.client.state().await.unwrap().0, 0, "caches and the workspace are not state");

    std::fs::create_dir_all(upper.path().join("usr/local/lib/pkg")).unwrap();
    std::fs::write(upper.path().join("usr/local/lib/pkg/mod.py"), "an installed package").unwrap();
    let (n, sample) = r.client.state().await.unwrap();
    assert_eq!(n, 1, "something written outside the workspace is");
    assert_eq!(sample, [upper.path().join("usr/local/lib/pkg/mod.py").to_string_lossy().to_string()]);

    std::fs::remove_dir_all(upper.path().join("usr/local")).unwrap();
    assert_eq!(r.client.state().await.unwrap().0, 0, "and it stops counting once it is gone");
    std::fs::write(scratch.path().join("note.txt"), "scratch space is kept on the host, so a release loses nothing in it").unwrap();
    assert_eq!(r.client.state().await.unwrap().0, 0, "scratch space is the host's too, so it is not state");
}

#[test]
fn the_agent_hash_names_the_source_both_sides_were_built_from() {
    assert_eq!(expected_agent().len(), 12);
}
