//! A pod per tenant, driven through the Kubernetes CRI like any cluster would: crictl against a containerd that has a sandboxing runtime.
//! With Kata the pod is a VM; with gVisor it is a userspace kernel. These are what someone running Kubernetes picks to hold hostile tenants
//! apart. Neither has a snapshot to release a pod to, so the only way one gives memory back is to delete the pod, and the next command boots a
//! new one.
use sandroute::vm::{VmBackend, VmResult};
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct CriOptions {
    /// the Kata install, where crictl and the default config live
    pub home: PathBuf,
    /// crictl's config, naming the containerd socket
    pub config: PathBuf,
    /// the containerd runtime handler; None uses containerd's default
    pub runtime: Option<String>,
    pub image: String,
}

impl CriOptions {
    pub fn from_env() -> Self {
        let home = PathBuf::from(std::env::var("KATA_HOME").unwrap_or_else(|_| format!("{}/kata", std::env::var("HOME").unwrap_or_default())));
        CriOptions {
            config: std::env::var("CRI_CONFIG").map(PathBuf::from).unwrap_or_else(|_| home.join("crictl.yaml")),
            runtime: std::env::var("CRI_RUNTIME").ok().filter(|r| !r.is_empty()),
            image: std::env::var("KATA_IMAGE").unwrap_or_else(|_| "docker.io/library/python:3.13-slim".into()),
            home,
        }
    }
}

pub struct CriVm {
    o: CriOptions,
    id: String,
    dir: PathBuf,
    state: tokio::sync::Mutex<(Option<(String, String)>, u32)>, // pod and container ids, boot count
}

impl CriVm {
    pub fn new(o: CriOptions, id: &str, run_dir: &Path) -> Self {
        CriVm { o, id: id.to_string(), dir: run_dir.join("cri").join(id), state: Default::default() }
    }

    async fn crictl(&self, args: &[&str]) -> Result<(String, String, bool)> {
        let out = Command::new(self.o.home.join("nerd/bin/crictl")).arg("--config").arg(&self.o.config).args(args).output().await?;
        Ok((String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned(), out.status.success()))
    }

    async fn step(&self, what: &str, args: &[&str]) -> Result<String> {
        let (out, err, ok) = self.crictl(args).await?;
        if !ok {
            bail!("{what}: {}", err.trim().lines().last().unwrap_or(""));
        }
        Ok(out.trim().to_string())
    }
}

#[async_trait]
impl VmBackend for CriVm {
    fn name(&self) -> String {
        format!("cri ({})", self.o.runtime.as_deref().unwrap_or("default"))
    }

    async fn boot(&self, workspace: &Path) -> Result<()> {
        let mut st = self.state.lock().await;
        st.1 += 1;
        let gen = st.1;
        std::fs::create_dir_all(&self.dir)?;
        let (pod, ctr) = (self.dir.join(format!("pod{gen}.json")), self.dir.join(format!("ctr{gen}.json")));
        let uid = format!("{}-{gen}-{}", self.id, std::process::id());
        std::fs::write(&pod, json!({"metadata": {"name": format!("t{}-{gen}", self.id), "namespace": "b", "uid": uid, "attempt": 1}, "log_directory": self.dir, "linux": {}}).to_string())?;
        std::fs::write(&ctr, json!({"metadata": {"name": "c"}, "image": {"image": self.o.image}, "command": ["sleep", "infinity"], "log_path": format!("c{gen}.log"),
            "mounts": [{"host_path": workspace, "container_path": "/work"}], "linux": {}}).to_string())?;
        let (p, c) = (pod.to_string_lossy(), ctr.to_string_lossy());
        let mut runp = vec!["runp"];
        if let Some(r) = &self.o.runtime {
            runp.extend(["--runtime", r]);
        }
        runp.push(&p);
        let pod_id = self.step("runp", &runp).await?;
        let ctr_id = self.step("create", &["create", &pod_id, &c, &p]).await?;
        self.step("start", &["start", &ctr_id]).await?;
        st.0 = Some((pod_id, ctr_id));
        Ok(())
    }

    async fn exec(&self, command: &str, cwd: &str, _env: Option<&BTreeMap<String, String>>) -> Result<VmResult> {
        let ctr = self.state.lock().await.0.as_ref().map(|(_, c)| c.clone()).ok_or_else(|| anyhow!("the pod is not up"))?;
        // umask 000 so that whatever the guest creates in the shared workspace stays deletable by the host user
        let out = Command::new(self.o.home.join("nerd/bin/crictl")).arg("--config").arg(&self.o.config)
            .args(["exec", "--timeout", "60", &ctr, "bash", "-c", "umask 000; cd \"$0\" && exec bash -c \"$1\"", cwd, command]).output().await?;
        Ok(VmResult { stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned(), exit_code: out.status.code().unwrap_or(1) })
    }

    async fn stop(&self) -> Result<()> {
        if let Some((pod, _)) = self.state.lock().await.0.take() {
            self.crictl(&["stopp", &pod]).await?;
            self.crictl(&["rmp", &pod]).await?;
        }
        Ok(())
    }
}
