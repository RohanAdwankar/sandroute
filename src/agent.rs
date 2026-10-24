//! Talks to the guest agent and keeps host directories and guest directories in step: the workspace, and optionally the guest's /tmp.
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileMsg {
    pub path: String,
    pub mode: u32,
    pub b64: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Report {
    #[serde(default)]
    pub changed: Vec<FileMsg>,
    #[serde(default)]
    pub deleted: Vec<String>,
    #[serde(default)]
    pub dirs: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ExecResponse {
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub code: i32,
    #[serde(flatten)]
    pub report: Report,
    #[serde(default)]
    pub scratch: Option<Report>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Busy {
    pub busy: bool,
    #[serde(default)]
    pub procs: Vec<Value>,
    #[serde(flatten)]
    pub report: Report,
    #[serde(default)]
    pub scratch: Option<Report>,
}

#[derive(Clone, Debug, Default)]
pub struct Manifest {
    /// path -> "mtimeNs:size"
    pub files: HashMap<String, String>,
    pub dirs: BTreeSet<String>,
    /// When this was taken. Anything modified at or after it cannot be trusted to differ.
    pub taken_ns: i128,
}

/// Never synced, matched by directory name at any depth. Copying these over vsock on every wake costs far more than they are worth: a
/// plain opencode workspace carries 3648 files of .opencode/node_modules, which is 73MB of base64 per wake. The guest skips the same
/// names, so neither side reports the other's copy as a change.
const SKIP: &[&str] = &["node_modules", ".git"];

fn now_ns() -> i128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i128).unwrap_or(0)
}

pub fn manifest(root: &Path) -> Manifest {
    let mut m = Manifest { taken_ns: now_ns() / 1_000_000 * 1_000_000, ..Default::default() };
    let Ok(base) = std::fs::canonicalize(root) else { return m };
    fn walk(dir: &Path, rel: &str, m: &mut Manifest) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let full = dir.join(&name);
            // Runtimes disagree about whether a symlink to a directory is a directory, so the decision is made by resolving the path
            // rather than by trusting its type. `dir` is always already canonical, so anything whose resolved form differs is a symlink or
            // escapes the workspace. Either way it is skipped, which is what the guest does.
            match std::fs::canonicalize(&full) {
                Ok(real) if real == full => {}
                _ => continue,
            }
            let Ok(md) = std::fs::metadata(&full) else { continue };
            if md.is_dir() {
                m.dirs.insert(r.clone());
                walk(&full, &r, m);
            } else if md.is_file() {
                // nanoseconds, not truncated milliseconds: a file rewritten to the same size inside one millisecond is otherwise
                // indistinguishable from the old one and never syncs
                m.files.insert(r, format!("{}:{}", md.mtime() as i128 * 1_000_000_000 + md.mtime_nsec() as i128, md.len()));
            }
        }
    }
    walk(&base, "", &mut m);
    m
}

/// A host directory kept in step with a guest directory, and what the guest is known to hold of it.
struct Area {
    dir: PathBuf,
    max_file_bytes: u64,
    synced: Manifest,
}

impl Area {
    fn new(dir: PathBuf, max_file_bytes: u64) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Area { dir, max_file_bytes, synced: Manifest::default() })
    }

    /// What changed on the host since the last sync, in the shape the guest's sync takes.
    fn changes(&mut self) -> Result<Value> {
        let now = manifest(&self.dir);
        let mut files = Vec::new();
        for (rel, sig) in &now.files {
            // Same size inside the same tick as the last sync looks identical, so trust the signature only for files that were already
            // settled when that sync was taken.
            let mtime: i128 = sig.split(':').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            if mtime < self.synced.taken_ns && self.synced.files.get(rel) == Some(sig) {
                continue;
            }
            let full = self.dir.join(rel);
            let Ok(md) = std::fs::symlink_metadata(&full) else { continue };
            if !md.is_file() {
                continue; // vanished, or no longer a regular file
            }
            if md.len() > self.max_file_bytes {
                bail!("{rel} is {}MiB, over the {}MiB sync limit; it is copied into the guest on every wake", md.len() / (1 << 20), self.max_file_bytes / (1 << 20));
            }
            files.push(json!({"path": rel, "mode": md.permissions().mode() & 0o777, "b64": STANDARD.encode(std::fs::read(&full)?)}));
        }
        let delete: Vec<&String> = self.synced.files.keys().filter(|r| !now.files.contains_key(*r)).collect();
        // directories carry no files, so nothing else would ever create them in the guest
        let dirs: Vec<&String> = now.dirs.iter().filter(|d| !self.synced.dirs.contains(*d)).collect();
        let out = json!({"files": files, "delete": delete, "dirs": dirs});
        self.synced = now;
        Ok(out)
    }

    /// Take whatever the guest reports and make the host match it.
    fn apply(&mut self, r: &Report) -> Result<()> {
        for rel in &r.deleted {
            let _ = std::fs::remove_file(self.dir.join(rel));
        }
        for rel in &r.dirs {
            std::fs::create_dir_all(self.dir.join(rel))?;
        }
        for f in &r.changed {
            let full = self.dir.join(&f.path);
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::write(&full, STANDARD.decode(&f.b64)?)?;
            std::fs::set_permissions(&full, std::fs::Permissions::from_mode(f.mode))?;
        }
        // what we just wrote is now identical on both sides
        self.synced = manifest(&self.dir);
        Ok(())
    }
}

struct Conn {
    r: BufReader<OwnedReadHalf>,
    w: OwnedWriteHalf,
}

/// Hash of the guest agent this host ships, so an image built from an older one is refused at connect.
pub fn expected_agent() -> String {
    Sha256::digest(include_bytes!("bin/guest_agent.rs"))[..6].iter().map(|b| format!("{b:02x}")).collect()
}

type ConflictFn = Box<dyn Fn(Vec<String>) + Send + Sync>;

pub struct AgentClient {
    conn: tokio::sync::Mutex<Conn>,
    closed: tokio::sync::watch::Sender<bool>,
    workspace: Arc<Mutex<Area>>,
    /// The guest's /tmp, kept on the host so a release that discards the guest loses nothing in it.
    scratch: Option<Arc<Mutex<Area>>>,
    on_conflict: Mutex<Option<ConflictFn>>,
}

#[derive(Default)]
pub struct OpenOptions {
    /// Hash of the agent this host ships. Set it and a stale image is refused at connect.
    pub expect_agent: Option<String>,
    /// Set the guest's wall clock from the host on connect. A restored guest is as far behind as the time since its snapshot was taken.
    pub sync_clock: bool,
    /// Whole files go over the wire base64'd, in one JSON line, on every wake. Past a point that is not a slow sync, it is a dead one.
    pub max_file_bytes: Option<u64>,
    pub scratch_dir: Option<PathBuf>,
}

impl AgentClient {
    pub async fn open(stream: UnixStream, workspace: &Path, o: OpenOptions) -> Result<Self> {
        let max = o.max_file_bytes.unwrap_or(64 << 20);
        let (r, w) = stream.into_split();
        let c = AgentClient {
            conn: tokio::sync::Mutex::new(Conn { r: BufReader::new(r), w }),
            closed: tokio::sync::watch::channel(false).0,
            workspace: Arc::new(Mutex::new(Area::new(workspace.to_path_buf(), max)?)),
            scratch: o.scratch_dir.map(|d| Area::new(d, max).map(|a| Arc::new(Mutex::new(a)))).transpose()?,
            on_conflict: Mutex::new(None),
        };
        let hello = c.request(json!({"op": "ping"})).await?;
        if let Some(want) = &o.expect_agent {
            if hello["agent"].as_str() != Some(want) {
                bail!("guest agent is {}, host ships {want}: rebuild the image with the current guest agent", hello["agent"].as_str().unwrap_or("of unknown vintage"));
            }
        }
        if o.sync_clock {
            c.request(json!({"op": "clock", "epoch": now_ns() as f64 / 1e9})).await?;
        }
        Ok(c)
    }

    /// Called with paths the guest kept its own version of.
    pub fn on_conflict(&self, f: impl Fn(Vec<String>) + Send + Sync + 'static) {
        *self.on_conflict.lock().unwrap() = Some(Box::new(f));
    }

    async fn request(&self, req: Value) -> Result<Value> {
        let mut rx = self.closed.subscribe();
        if *rx.borrow() {
            bail!("guest agent connection closed");
        }
        let mut conn = self.conn.lock().await;
        let io = async {
            conn.w.write_all(format!("{req}\n").as_bytes()).await?;
            let mut line = String::new();
            if conn.r.read_line(&mut line).await? == 0 {
                bail!("guest agent connection closed");
            }
            Ok::<_, anyhow::Error>(line)
        };
        let line = tokio::select! {
            r = io => r.inspect_err(|_| { let _ = self.closed.send(true); })?,
            _ = rx.changed() => bail!("guest agent connection closed"),
        };
        let v: Value = serde_json::from_str(&line)?;
        match v.get("error").and_then(Value::as_str) {
            Some(e) => Err(anyhow!("{e}")),
            None => Ok(v),
        }
    }

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
        tokio::task::spawn_blocking(f).await?
    }

    /// Push whatever changed on the host since the last sync.
    pub async fn push_changes(&self) -> Result<()> {
        let (ws, sc) = (self.workspace.clone(), self.scratch.clone());
        let (mut req, scratch) = Self::blocking(move || {
            let w = ws.lock().unwrap().changes()?;
            let s = sc.map(|s| s.lock().unwrap().changes()).transpose()?;
            Ok((w, s))
        })
        .await?;
        let empty = |c: &Value| ["files", "delete", "dirs"].iter().all(|k| c[*k].as_array().is_none_or(|a| a.is_empty()));
        if empty(&req) && scratch.as_ref().is_none_or(empty) {
            return Ok(());
        }
        req["op"] = json!("sync");
        if let Some(s) = scratch {
            req["scratch"] = s;
        }
        let r = self.request(req).await?;
        // The guest refuses a file it has moved on from itself. Its version arrives with the next report, so the host converges on it
        // rather than overwriting it.
        let conflicts: Vec<String> = r["conflicts"].as_array().map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default();
        if !conflicts.is_empty() {
            if let Some(f) = &*self.on_conflict.lock().unwrap() {
                f(conflicts);
            }
        }
        Ok(())
    }

    pub async fn exec(&self, cmd: &str, cwd: &str, env: Option<&std::collections::BTreeMap<String, String>>) -> Result<ExecResponse> {
        self.push_changes().await?;
        let r = self.request(json!({"op": "exec", "cmd": cmd, "cwd": cwd, "env": env})).await?;
        let r: ExecResponse = serde_json::from_value(r)?;
        self.apply(&r.report, r.scratch.as_ref()).await?;
        Ok(r)
    }

    async fn apply(&self, report: &Report, scratch: Option<&Report>) -> Result<()> {
        let (ws, sc, report, scratch) = (self.workspace.clone(), self.scratch.clone(), report.clone(), scratch.cloned());
        Self::blocking(move || {
            ws.lock().unwrap().apply(&report)?;
            if let (Some(a), Some(r)) = (sc, scratch) {
                a.lock().unwrap().apply(&r)?;
            }
            Ok(())
        })
        .await
    }

    /// What this guest holds that a release would lose and the host cannot rebuild.
    pub async fn state(&self) -> Result<(u64, Vec<String>)> {
        let v = self.request(json!({"op": "state"})).await?;
        Ok((v["files"].as_u64().unwrap_or(0), v["sample"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()))
    }

    /// Asks what is still running, and collects what it has written while it ran.
    pub async fn busy(&self) -> Result<Busy> {
        let b: Busy = serde_json::from_value(self.request(json!({"op": "busy"})).await?)?;
        self.apply(&b.report, b.scratch.as_ref()).await?;
        Ok(b)
    }

    /// Everything in flight fails, and so does anything asked afterwards.
    pub fn close(&self) {
        let _ = self.closed.send(true);
    }
}
