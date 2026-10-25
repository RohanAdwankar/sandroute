//! The heavy tier. Anything the file-only tier cannot do runs here. The workspace is shared with the light tier, so an implementation only
//! has to make the workspace directory visible inside the machine.
use anyhow::Result;
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct VmResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Clone, Debug, Default)]
pub struct Live {
    pub busy: bool,
    pub procs: Vec<(i64, String)>,
}

#[async_trait]
pub trait VmBackend: Send + Sync {
    fn name(&self) -> String;
    /// Boot the machine. Called when the machine is down and a command needs it.
    async fn boot(&self, workspace: &Path) -> Result<()>;
    async fn exec(&self, command: &str, cwd: &str, env: Option<&BTreeMap<String, String>>) -> Result<VmResult>;
    /// Anything still alive in the machine that no command is waiting on: a server the agent backgrounded, a cron. None when the
    /// backend cannot tell, and the VM is released on the idle timer alone.
    async fn busy(&self) -> Result<Option<Live>> {
        Ok(None)
    }
    /// Called with paths the machine kept its own version of because both sides had changed them since the last exchange; the machine's
    /// version wins, and the workspace converges on it.
    fn on_conflict(&self, _f: Box<dyn Fn(Vec<String>) + Send + Sync>) {}
    /// Hand the machine back but keep what is in it, so the next boot resumes rather than starts clean. False when the backend cannot,
    /// and the machine is stopped instead, which loses anything the guest held that the workspace does not cover.
    async fn suspend(&self) -> Result<bool> {
        Ok(false)
    }
    /// A new task starts: forget the machine's scratch space, which the host keeps while the machine is released.
    fn clear_scratch(&self) {}
    /// Destroy the machine and anything saved from it, whether it is up or suspended.
    async fn stop(&self) -> Result<()>;
}

/// A backend that is released by being killed: nothing is written and the next wake is a cold boot, which is how Claude Code is seen to
/// behave. Wraps any backend and takes away its suspend.
pub struct KillOnRelease<V>(pub V);

#[async_trait]
impl<V: VmBackend> VmBackend for KillOnRelease<V> {
    fn name(&self) -> String {
        format!("{} (killed on release)", self.0.name())
    }
    async fn boot(&self, w: &Path) -> Result<()> {
        self.0.boot(w).await
    }
    async fn exec(&self, c: &str, cwd: &str, env: Option<&BTreeMap<String, String>>) -> Result<VmResult> {
        self.0.exec(c, cwd, env).await
    }
    async fn busy(&self) -> Result<Option<Live>> {
        self.0.busy().await
    }
    fn on_conflict(&self, f: Box<dyn Fn(Vec<String>) + Send + Sync>) {
        self.0.on_conflict(f)
    }
    fn clear_scratch(&self) {
        self.0.clear_scratch()
    }
    async fn stop(&self) -> Result<()> {
        self.0.stop().await
    }
}
