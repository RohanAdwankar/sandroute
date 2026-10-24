// Starts sandboxed commands for the host process and reports how they ended.
//
// Node starts a process with fork(), which copies the page tables of the whole parent, so a control
// plane holding a few hundred MiB pays milliseconds of cpu for every command it launches. This is a
// small process that does only that: one JSON request per line on stdin, one JSON response per line
// on stdout. It exits when stdin closes, and the sandboxes it started die with it.
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Deserialize)]
struct Request {
    id: u64,
    argv: Vec<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: u64,
    #[serde(rename = "maxOutput")]
    max_output: usize,
    /// a file to hand the command as descriptor 3, which is where bwrap reads its seccomp program from
    fd3: Option<String>,
}

#[derive(Serialize)]
struct Response {
    id: u64,
    stdout: String,
    stderr: String,
    code: Option<i32>,
    signal: Option<i32>,
    /// the command could not be started at all
    error: Option<String>,
    #[serde(rename = "outputExceeded")]
    output_exceeded: bool,
}

fn run(req: &Request) -> Response {
    let mut resp = Response { id: req.id, stdout: String::new(), stderr: String::new(), code: None, signal: None, error: None, output_exceeded: false };
    let fd3 = match req.fd3.as_ref().map(File::open).transpose() {
        Ok(f) => f,
        Err(e) => { resp.error = Some(e.to_string()); return resp; }
    };
    let mut cmd = Command::new(&req.argv[0]);
    cmd.args(&req.argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(f) = &fd3 {
        let raw = f.as_raw_fd();
        // runs in the child between fork and exec, and only makes system calls. When the file already is
        // descriptor 3, dup2 does nothing and leaves it close-on-exec, so that flag is cleared instead.
        unsafe {
            cmd.pre_exec(move || {
                let r = if raw == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(raw, 3) };
                if r < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
            });
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => { resp.error = Some(e.to_string()); return resp; }
    };
    drop(fd3);
    let pid = child.id() as i32;
    let total = Arc::new(Mutex::new(0usize));
    let exceeded = Arc::new(Mutex::new(false));
    let reader = |mut pipe: Box<dyn Read + Send>| {
        let (total, exceeded, cap) = (total.clone(), exceeded.clone(), req.max_output);
        std::thread::spawn(move || {
            let (mut out, mut buf) = (Vec::new(), [0u8; 65536]);
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 { break; }
                let mut t = total.lock().unwrap();
                *t += n;
                if *t > cap { *exceeded.lock().unwrap() = true; unsafe { libc::kill(pid, libc::SIGKILL); } break; }
                out.extend_from_slice(&buf[..n]);
            }
            out
        })
    };
    let so = reader(Box::new(child.stdout.take().unwrap()));
    let se = reader(Box::new(child.stderr.take().unwrap()));
    let (tx, rx) = channel();
    std::thread::spawn(move || { let _ = tx.send(child.wait()); });
    let status = match rx.recv_timeout(Duration::from_millis(req.timeout_ms)) {
        Ok(s) => s,
        Err(RecvTimeoutError::Timeout) => { unsafe { libc::kill(pid, libc::SIGKILL); } rx.recv().unwrap() }
        Err(RecvTimeoutError::Disconnected) => unreachable!(),
    };
    resp.stdout = String::from_utf8_lossy(&so.join().unwrap_or_default()).into_owned();
    resp.stderr = String::from_utf8_lossy(&se.join().unwrap_or_default()).into_owned();
    match status {
        Ok(s) => { resp.code = s.code(); resp.signal = s.signal(); }
        Err(e) => resp.error = Some(e.to_string()),
    }
    resp.output_exceeded = *exceeded.lock().unwrap();
    resp
}

fn main() {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let Ok(req) = serde_json::from_str::<Request>(&line) else { continue };
        let out = out.clone();
        std::thread::spawn(move || {
            let r = serde_json::to_string(&run(&req)).unwrap();
            let mut o = out.lock().unwrap();
            let _ = writeln!(o, "{r}");
            let _ = o.flush();
        });
    }
}
