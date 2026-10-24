//! Runs a command to completion with a time limit and a cap on its output.
//!
//! A process started by fork() copies the page tables of the whole parent, so a control plane holding a few hundred MiB pays
//! milliseconds of cpu for every command. posix_spawn starts the child without that copy, and a file action hands it the seccomp
//! program as descriptor 3, where bwrap reads it from.
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{unix::AsyncFd, AsyncReadExt};
use tokio::net::unix::pipe::Receiver;

extern "C" {
    static environ: *const *mut libc::c_char;
}

pub struct Ended {
    pub stdout: String,
    pub stderr: String,
    /// the exit code, when it exited
    pub code: Option<i32>,
    /// the signal that ended it, when one did
    pub signal: Option<i32>,
    pub output_exceeded: bool,
}

pub fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP", 2 => "SIGINT", 6 => "SIGABRT", 9 => "SIGKILL", 11 => "SIGSEGV", 13 => "SIGPIPE", 14 => "SIGALRM", 15 => "SIGTERM", 31 => "SIGSYS",
        _ => return format!("signal {n}"),
    }
    .to_string()
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r < 0 { Err(io::Error::last_os_error()) } else { Ok(r) }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut f = [0; 2];
    cvt(unsafe { libc::pipe2(f.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) })?;
    Ok(unsafe { (OwnedFd::from_raw_fd(f[0]), OwnedFd::from_raw_fd(f[1])) })
}

/// Start argv with stdin on /dev/null, stdout and stderr on the given descriptors and, when asked, `fd3` as descriptor 3.
fn spawn(argv: &[String], stdout: RawFd, stderr: RawFd, fd3: Option<RawFd>) -> io::Result<libc::pid_t> {
    let args: Vec<CString> = argv.iter().map(|a| CString::new(a.as_bytes()).map_err(|_| io::Error::other("a NUL in an argument"))).collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr() as *mut _).collect();
    ptrs.push(std::ptr::null_mut());
    unsafe {
        let mut fa: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        libc::posix_spawn_file_actions_init(&mut fa);
        libc::posix_spawnattr_init(&mut attr);
        libc::posix_spawn_file_actions_addopen(&mut fa, 0, c"/dev/null".as_ptr(), libc::O_RDONLY, 0);
        libc::posix_spawn_file_actions_adddup2(&mut fa, stdout, 1);
        libc::posix_spawn_file_actions_adddup2(&mut fa, stderr, 2);
        if let Some(fd) = fd3 {
            libc::posix_spawn_file_actions_adddup2(&mut fa, fd, 3);
        }
        // a clean signal state, whatever this thread's was
        let (mut none, mut all): (libc::sigset_t, libc::sigset_t) = (std::mem::zeroed(), std::mem::zeroed());
        libc::sigemptyset(&mut none);
        libc::sigfillset(&mut all);
        libc::posix_spawnattr_setsigmask(&mut attr, &none);
        libc::posix_spawnattr_setsigdefault(&mut attr, &all);
        libc::posix_spawnattr_setflags(&mut attr, (libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF) as i16);
        let mut pid = 0;
        let r = libc::posix_spawnp(&mut pid, args[0].as_ptr(), &fa, &attr, ptrs.as_ptr(), environ);
        libc::posix_spawn_file_actions_destroy(&mut fa);
        libc::posix_spawnattr_destroy(&mut attr);
        if r != 0 { Err(io::Error::from_raw_os_error(r)) } else { Ok(pid) }
    }
}

/// Wait for a child to end without blocking a thread: a pidfd becomes readable when the process exits.
async fn reap(pid: libc::pid_t) -> io::Result<(Option<i32>, Option<i32>)> {
    let pidfd = cvt(unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int)?;
    // a pidfd is a plain descriptor that we own and that polls readable when the process exits
    let pidfd = unsafe { AsyncFd::register_with_interest(OwnedFd::from_raw_fd(pidfd), tokio::io::Interest::READABLE)? };
    let _ = pidfd.readable().await?;
    let mut status = 0;
    cvt(unsafe { libc::waitpid(pid, &mut status, 0) })?;
    Ok(if libc::WIFEXITED(status) { (Some(libc::WEXITSTATUS(status)), None) } else { (None, Some(libc::WTERMSIG(status))) })
}

pub async fn run(argv: &[String], timeout: Duration, max_output: usize, fd3: Option<OwnedFd>) -> io::Result<Ended> {
    let ((out_r, out_w), (err_r, err_w)) = (pipe()?, pipe()?);
    let pid = spawn(argv, out_w.as_raw_fd(), err_w.as_raw_fd(), fd3.as_ref().map(|f| f.as_raw_fd()))?;
    drop((out_w, err_w, fd3));
    let (total, exceeded) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let readers = [out_r, err_r].map(|fd| {
        let (total, exceeded, buf) = (total.clone(), exceeded.clone(), Arc::new(Mutex::new(Vec::new())));
        let b = buf.clone();
        let task = tokio::spawn(async move {
            let mut pipe = Receiver::from_owned_fd(fd).expect("a pipe");
            let mut chunk = [0u8; 65536];
            while let Ok(n) = pipe.read(&mut chunk).await {
                if n == 0 { break; }
                if total.fetch_add(n, Ordering::Relaxed) + n > max_output {
                    exceeded.store(true, Ordering::Relaxed);
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                    break;
                }
                b.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
        (task, buf)
    });
    let waiting = tokio::spawn(reap(pid));
    tokio::pin!(waiting);
    let ended = match tokio::time::timeout(timeout, &mut waiting).await {
        Ok(r) => r,
        Err(_) => {
            unsafe { libc::kill(pid, libc::SIGKILL) };
            (&mut waiting).await
        }
    };
    let (code, signal) = ended.map_err(io::Error::other)??;
    let [(t1, b1), (t2, b2)] = readers;
    // the pipes close with the process, but one held open by something it left behind must not hold this up
    let _ = tokio::time::timeout(Duration::from_secs(2), async { let _ = t1.await; let _ = t2.await; }).await;
    let text = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap()).into_owned();
    Ok(Ended { stdout: text(&b1), stderr: text(&b2), code, signal, output_exceeded: exceeded.load(Ordering::Relaxed) })
}
