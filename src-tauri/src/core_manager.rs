use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    },
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};

use crate::{
    proxy::{release_laynet_system_proxy, set_system_proxy},
    tray::{sync_tray_visuals, TraySyncPayload},
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 宽松 Go 内存软上限：既防止长时间大流量后内存无限增长，又保证 600+ Mbps 满速吞吐零 GC 抖动
const CORE_GO_MEM_LIMIT: &str = "64MiB";

const DEFAULT_READY_TIMEOUT: Duration = Duration::from_millis(15_000);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(80);
const DEFAULT_MIXED_PORT: u16 = 7890;
const DEFAULT_CLASH_PORT: u16 = 9090;

const INTENT_NONE: u8 = 0;
const INTENT_APPLY: u8 = 1;
const INTENT_DISCONNECT: u8 = 2;
const INTENT_SHUTDOWN: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    ManualStop,
    ReloadReplace,
    Shutdown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreApplyRequest {
    pub config_json: String,
    pub sys_proxy: bool,
    pub tun_mode: bool,
    pub routing_mode: String,
    pub active_node: Option<String>,
    pub allow_rollback: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreApplyResult {
    /// "applied" | "rolled_back" | "failed" | "cancelled" | "superseded"
    pub status: String,
    pub config_path: Option<String>,
    /// "precheck" | "startup" | "readiness" | "proxy" | "rollback"
    pub failure_stage: Option<String>,
    pub error: Option<String>,
    pub rollback_error: Option<String>,
    pub running_after: bool,
}

impl CoreApplyResult {
    fn precheck_failed(error: String, running_after: bool) -> Self {
        Self {
            status: "failed".to_string(),
            config_path: None,
            failure_stage: Some("precheck".to_string()),
            error: Some(error),
            rollback_error: None,
            running_after,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProbeEndpoints {
    pub clash_api_addr: SocketAddr,
    pub mixed_addr: Option<SocketAddr>,
}

#[derive(Debug, Clone)]
pub struct CoreExitEvent {
    pub run_id: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
    pub command_line: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCoreRecord {
    pid: u32,
    exe_path: Option<String>,
    config_path: String,
    runtime_dir: String,
}

#[derive(Debug, Clone)]
struct CommittedSession {
    config_json: String,
    sys_proxy: bool,
    tun_mode: bool,
    routing_mode: String,
    active_node: Option<String>,
    endpoints: ProbeEndpoints,
}

pub trait ManagedProcessHandle: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn is_alive(&self) -> bool;
    fn terminate_and_wait(&mut self, timeout_ms: u32);
}

pub type StdioCallback = Arc<dyn Fn(u64, String) + Send + Sync>;
pub type ExitCallback = Arc<dyn Fn(CoreExitEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub enum PrecheckOutcome {
    Passed,
    Failed(String),
}

pub trait CoreDriver: Send + Sync {
    fn precheck_config(&self, config_path: &Path, runtime_dir: &Path) -> PrecheckOutcome;

    fn spawn_core(
        &self,
        run_id: u64,
        config_path: &Path,
        runtime_dir: &Path,
        on_stdio: StdioCallback,
        on_exit: ExitCallback,
    ) -> Result<Box<dyn ManagedProcessHandle>, String>;

    fn probe_ready(&self, endpoints: &ProbeEndpoints) -> bool;

    fn apply_proxy(&self, enable: bool, port: u16) -> Result<(), String>;

    fn release_proxy_if_owned(&self, port: u16);

    fn sync_ui(&self, snapshot: &TraySyncPayload, unexpected_exit: Option<&CoreExitEvent>);
}

struct ManagedCoreEntry {
    run_id: u64,
    pid: Option<u32>,
    handle: Option<Box<dyn ManagedProcessHandle>>,
    intentional_stop: Option<StopReason>,
    exited: bool,
    exit_reason: Option<String>,
}

struct CoreSessionState {
    next_run_id: u64,
    state_epoch: u64,
    active: Option<ManagedCoreEntry>,
    candidate: Option<ManagedCoreEntry>,
    last_committed: Option<CommittedSession>,
    desired_connected: bool,
    pending_exit_error: Option<String>,
    cold_start_consumed: bool,
    snapshot: TraySyncPayload,
    runtime_dir: Option<PathBuf>,
}

impl Default for CoreSessionState {
    fn default() -> Self {
        Self {
            next_run_id: 0,
            state_epoch: 0,
            active: None,
            candidate: None,
            last_committed: None,
            desired_connected: false,
            pending_exit_error: None,
            cold_start_consumed: false,
            snapshot: TraySyncPayload::default(),
            runtime_dir: None,
        }
    }
}

#[derive(Clone)]
pub struct CoreManager {
    session: Arc<Mutex<CoreSessionState>>,
    effect_lock: Arc<Mutex<()>>,
    op_lock: Arc<tauri::async_runtime::Mutex<()>>,
    intent_seq: Arc<AtomicU64>,
    latest_intent_kind: Arc<AtomicU8>,
    /// 前端完成整证指纹筛选前，托盘不得复用磁盘上的旧 running-config。
    cached_config_ready: Arc<AtomicBool>,
    reconnect_requested: Arc<AtomicBool>,
    ready_timeout: Duration,
    poll_interval: Duration,
}

impl Default for CoreManager {
    fn default() -> Self {
        Self {
            session: Arc::new(Mutex::new(CoreSessionState::default())),
            effect_lock: Arc::new(Mutex::new(())),
            op_lock: Arc::new(tauri::async_runtime::Mutex::new(())),
            intent_seq: Arc::new(AtomicU64::new(0)),
            latest_intent_kind: Arc::new(AtomicU8::new(INTENT_NONE)),
            cached_config_ready: Arc::new(AtomicBool::new(false)),
            reconnect_requested: Arc::new(AtomicBool::new(false)),
            ready_timeout: DEFAULT_READY_TIMEOUT,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }
}

pub struct LaunchContextSnapshot {
    pub is_cold_start: bool,
    pub core_running: bool,
    pub preferred_sys_proxy: bool,
    pub routing_mode: String,
    pub tun_mode: bool,
    pub pending_exit_error: Option<String>,
}

fn normalize_path_cmp(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').replace('/', "\\");
    trimmed
        .strip_prefix(r"\\?\")
        .unwrap_or(&trimmed)
        .to_ascii_lowercase()
}

fn contains_token_case_insensitive(haystack_lower: &str, token_lower: &str) -> bool {
    haystack_lower
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .any(|part| part == token_lower)
}

/// 严格验证一个进程是否确实属于 LayNet 遗留内核，避免误杀系统其他 `sing-box.exe` 或其他目录同名程序
pub fn is_verified_laynet_orphan(
    proc_info: &ProcessInfo,
    expected_exe_paths: &[PathBuf],
    runtime_dir: Option<&Path>,
    recorded_pid: Option<u32>,
    exclude_pids: &[u32],
) -> bool {
    if exclude_pids.contains(&proc_info.pid) || proc_info.pid == 0 {
        return false;
    }

    let name_lower = proc_info.name.trim().to_ascii_lowercase();
    let is_core_image = name_lower == "laynet-core.exe"
        || name_lower == "laynet-core-x86_64-pc-windows-msvc.exe";
    if !is_core_image {
        return false;
    }

    let cmd_lower = proc_info
        .command_line
        .as_deref()
        .map(normalize_path_cmp)
        .unwrap_or_default();
    let exe_norm = proc_info.exe_path.as_deref().map(normalize_path_cmp);

    let looks_like_check = contains_token_case_insensitive(&cmd_lower, "check");
    let looks_like_run = contains_token_case_insensitive(&cmd_lower, "run")
        && (contains_token_case_insensitive(&cmd_lower, "-c")
            || contains_token_case_insensitive(&cmd_lower, "--config"));

    let runtime_match = if !cmd_lower.is_empty() && !looks_like_check {
        let dir_match = runtime_dir
            .map(|dir| {
                let norm = normalize_path_cmp(&dir.to_string_lossy());
                !norm.is_empty() && cmd_lower.contains(&norm)
            })
            .unwrap_or(false);
        let laynet_cfg_match = cmd_lower.contains("com.lay00.net")
            && (cmd_lower.contains("running-config.json")
                || cmd_lower.contains("candidate-config-"));
        dir_match || laynet_cfg_match
    } else {
        false
    };

    let exe_match = exe_norm
        .as_deref()
        .map(|actual| {
            expected_exe_paths
                .iter()
                .map(|p| normalize_path_cmp(&p.to_string_lossy()))
                .any(|expected| !expected.is_empty() && actual == expected)
        })
        .unwrap_or(false)
        && looks_like_run;

    let pid_match = recorded_pid == Some(proc_info.pid) && !looks_like_check;

    runtime_match || exe_match || pid_match
}

pub fn parse_probe_endpoints(config_json: &str) -> ProbeEndpoints {
    let mut clash_api_addr =
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_CLASH_PORT);
    let mut mixed_addr = Some(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        DEFAULT_MIXED_PORT,
    ));

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(config_json) {
        if let Some(ctrl) = val
            .get("experimental")
            .and_then(|e| e.get("clash_api"))
            .and_then(|c| c.get("external_controller"))
            .and_then(|v| v.as_str())
        {
            if let Some(addr) = parse_loopback_socket_addr(ctrl, DEFAULT_CLASH_PORT) {
                clash_api_addr = addr;
            }
        }

        if let Some(inbounds) = val.get("inbounds").and_then(|v| v.as_array()) {
            let mixed = inbounds.iter().find(|item| {
                item.get("type").and_then(|t| t.as_str()) == Some("mixed")
            });
            if let Some(m) = mixed {
                if let Some(port) = m.get("listen_port").and_then(|p| p.as_u64()) {
                    if port > 0 && port <= u16::MAX as u64 {
                        let listen_ip = m
                            .get("listen")
                            .and_then(|l| l.as_str())
                            .and_then(|s| s.parse::<IpAddr>().ok())
                            .map(normalize_loopback_ip)
                            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
                        mixed_addr = Some(SocketAddr::new(listen_ip, port as u16));
                    }
                }
            } else {
                mixed_addr = None;
            }
        }
    }

    ProbeEndpoints {
        clash_api_addr,
        mixed_addr,
    }
}

fn normalize_loopback_ip(ip: IpAddr) -> IpAddr {
    if ip.is_unspecified() {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        ip
    }
}

fn parse_loopback_socket_addr(raw: &str, default_port: u16) -> Option<SocketAddr> {
    let trimmed = raw.trim();
    if let Ok(mut sock) = trimmed.parse::<SocketAddr>() {
        sock.set_ip(normalize_loopback_ip(sock.ip()));
        return Some(sock);
    }
    if let Some((_, port_str)) = trimmed.rsplit_once(':') {
        if let Ok(port) = port_str.parse::<u16>() {
            return Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
        }
    }
    Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), default_port))
}

pub fn probe_endpoints_live(endpoints: &ProbeEndpoints) -> bool {
    if !probe_clash_api_version(endpoints.clash_api_addr) {
        return false;
    }
    if let Some(mixed_addr) = endpoints.mixed_addr {
        if TcpStream::connect_timeout(&mixed_addr, Duration::from_millis(350)).is_err() {
            return false;
        }
    }
    true
}

fn probe_clash_api_version(addr: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(450)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));
    let req = format!(
        "GET /version HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        addr
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    if n == 0 {
        return false;
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

#[cfg(windows)]
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process_handle: HANDLE,
        process_information_class: u32,
        process_information: *mut std::ffi::c_void,
        process_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

#[cfg(windows)]
fn query_process_image_path(handle: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
    if ok != 0 && len > 0 {
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    } else {
        None
    }
}

#[cfg(windows)]
pub fn query_process_command_line(handle: HANDLE) -> Option<String> {
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    let mut buf = vec![0u8; 4096];
    let mut needed: u32 = 0;

    let mut status = unsafe {
        NtQueryInformationProcess(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr() as *mut _,
            buf.len() as u32,
            &mut needed,
        )
    };

    if status != 0 && needed > buf.len() as u32 && needed <= 1024 * 1024 {
        buf.resize(needed as usize + 32, 0);
        status = unsafe {
            NtQueryInformationProcess(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                &mut needed,
            )
        };
    }

    if status != 0 || buf.len() < std::mem::size_of::<UnicodeString>() {
        return None;
    }

    let us = unsafe { &*(buf.as_ptr() as *const UnicodeString) };
    if us.buffer.is_null() || us.length == 0 {
        return Some(String::new());
    }

    let base = buf.as_ptr() as usize;
    let end = base + buf.len();
    let ptr_addr = us.buffer as usize;
    let byte_len = us.length as usize;
    if ptr_addr < base || ptr_addr.saturating_add(byte_len) > end {
        return None;
    }

    let slice = unsafe { std::slice::from_raw_parts(us.buffer, byte_len / 2) };
    Some(String::from_utf16_lossy(slice))
}

#[cfg(windows)]
fn enumerate_core_candidate_processes() -> Vec<ProcessInfo> {
    let mut results = Vec::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return results;
    }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            let name_lower = name.to_ascii_lowercase();

            if name_lower == "laynet-core.exe"
                || name_lower == "laynet-core-x86_64-pc-windows-msvc.exe"
            {
                let pid = entry.th32ProcessID;
                let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
                let (exe_path, command_line) = if !handle.is_null() {
                    let exe = query_process_image_path(handle);
                    let cmd = query_process_command_line(handle);
                    unsafe { CloseHandle(handle) };
                    (exe, cmd)
                } else {
                    (None, None)
                };

                results.push(ProcessInfo {
                    pid,
                    name,
                    exe_path,
                    command_line,
                });
            }

            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe { CloseHandle(snapshot) };
    results
}

#[cfg(windows)]
fn is_pid_alive_os(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let wait_rc = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        wait_rc == WAIT_TIMEOUT
    }
}

#[cfg(not(windows))]
fn is_pid_alive_os(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
fn kill_pid_and_wait(pid: u32, timeout_ms: u32) {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            let _ = TerminateProcess(handle, 1);
            let wait_rc = WaitForSingleObject(handle, timeout_ms);
            CloseHandle(handle);
            if wait_rc != WAIT_TIMEOUT {
                return;
            }
        }
    }

    let pid_str = pid.to_string();
    let _ = std::process::Command::new("taskkill.exe")
        .args(["/F", "/PID", &pid_str, "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn kill_pid_and_wait(_pid: u32, _timeout_ms: u32) {}

struct TauriProcessHandle {
    pid: u32,
    child: Option<CommandChild>,
}

impl ManagedProcessHandle for TauriProcessHandle {
    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn is_alive(&self) -> bool {
        is_pid_alive_os(self.pid)
    }

    fn terminate_and_wait(&mut self, timeout_ms: u32) {
        #[cfg(windows)]
        let wait_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, self.pid) };

        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }

        #[cfg(windows)]
        {
            if !wait_handle.is_null() {
                let rc = unsafe { WaitForSingleObject(wait_handle, timeout_ms) };
                unsafe { CloseHandle(wait_handle) };
                if rc == WAIT_TIMEOUT {
                    kill_pid_and_wait(self.pid, timeout_ms);
                }
                return;
            }
        }

        if is_pid_alive_os(self.pid) {
            kill_pid_and_wait(self.pid, timeout_ms);
        }
    }
}

struct TauriCoreDriver {
    app: AppHandle,
}

impl CoreDriver for TauriCoreDriver {
    fn precheck_config(&self, config_path: &Path, runtime_dir: &Path) -> PrecheckOutcome {
        let config_str = config_path.to_string_lossy().to_string();
        let runtime_str = runtime_dir.to_string_lossy().to_string();
        let path_env = match std::env::var("PATH") {
            Ok(existing) => format!("{};{}", runtime_str, existing),
            Err(_) => runtime_str.clone(),
        };

        let sidecar = match self.app.shell().sidecar("laynet-core") {
            Ok(cmd) => cmd,
            Err(e) => {
                return PrecheckOutcome::Failed(format!("创建 laynet-core sidecar 失败: {}", e))
            }
        };

        let check_output = tauri::async_runtime::block_on(async move {
            sidecar
                .args(["check", "-c", &config_str, "-D", &runtime_str])
                .current_dir(runtime_dir)
                .env("PATH", &path_env)
                .output()
                .await
        });

        match check_output {
            Ok(out) if out.status.success() => PrecheckOutcome::Passed,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                PrecheckOutcome::Failed(if detail.is_empty() {
                    format!("配置校验未通过 (code: {:?})", out.status.code())
                } else {
                    format!("配置校验未通过: {}", detail)
                })
            }
            Err(e) => PrecheckOutcome::Failed(format!("执行 laynet-core 配置校验失败: {}", e)),
        }
    }

    fn spawn_core(
        &self,
        run_id: u64,
        config_path: &Path,
        runtime_dir: &Path,
        on_stdio: StdioCallback,
        on_exit: ExitCallback,
    ) -> Result<Box<dyn ManagedProcessHandle>, String> {
        let config_str = config_path.to_string_lossy().to_string();
        let runtime_str = runtime_dir.to_string_lossy().to_string();
        let path_env = match std::env::var("PATH") {
            Ok(existing) => format!("{};{}", runtime_str, existing),
            Err(_) => runtime_str.clone(),
        };

        let (mut rx, child) = self
            .app
            .shell()
            .sidecar("laynet-core")
            .map_err(|e| format!("创建 laynet-core sidecar 失败: {}", e))?
            .args(["run", "-c", &config_str, "-D", &runtime_str])
            .current_dir(runtime_dir)
            .env("PATH", &path_env)
            .env("GOMEMLIMIT", CORE_GO_MEM_LIMIT)
            .spawn()
            .map_err(|e| format!("启动 laynet-core 失败: {}", e))?;

        let pid = child.pid();

        tauri::async_runtime::spawn(async move {
            let mut last_err_line = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stderr(bytes) | CommandEvent::Stdout(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).trim().to_string();
                        if !line.is_empty() {
                            if line.contains("FATAL") || line.contains("ERROR") {
                                last_err_line = line.clone();
                            }
                            on_stdio(run_id, line);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let reason = if !last_err_line.is_empty() {
                            last_err_line.clone()
                        } else {
                            format!("laynet-core 已退出 (code: {:?})", payload.code)
                        };
                        on_exit(CoreExitEvent {
                            run_id,
                            reason,
                        });
                        break;
                    }
                    CommandEvent::Error(err) => {
                        last_err_line = err;
                    }
                    _ => {}
                }
            }
        });

        Ok(Box::new(TauriProcessHandle {
            pid,
            child: Some(child),
        }))
    }

    fn probe_ready(&self, endpoints: &ProbeEndpoints) -> bool {
        probe_endpoints_live(endpoints)
    }

    fn apply_proxy(&self, enable: bool, port: u16) -> Result<(), String> {
        set_system_proxy(enable, "127.0.0.1", port)
    }

    fn release_proxy_if_owned(&self, port: u16) {
        let _ = release_laynet_system_proxy(port);
    }

    fn sync_ui(&self, snapshot: &TraySyncPayload, unexpected_exit: Option<&CoreExitEvent>) {
        let _ = sync_tray_visuals(&self.app, snapshot);
        if let Some(exit) = unexpected_exit {
            if self.app.get_webview_window("main").is_some() {
                let _ = self.app.emit("core-exited", exit.reason.clone());
            }
        }
    }
}

fn candidate_config_path(runtime_dir: &Path, id: u64) -> PathBuf {
    runtime_dir.join(format!("candidate-config-{}.json", id))
}

fn running_config_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("running-config.json")
}

/// 升级后托盘无窗口重连只能使用「已按整证指纹策略生成」的缓存。
/// 旧文件没有该标记时必须拒绝，避免把丢掉 pinSHA256 的配置重新拉起来。
const SAVED_CONFIG_POLICY: &str = "cert-pin-v2";

fn config_policy_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("running-config.policy")
}

fn write_config_policy(runtime_dir: &Path) -> Result<(), String> {
    write_file_atomic(&config_policy_path(runtime_dir), SAVED_CONFIG_POLICY.as_bytes())
        .map_err(|e| format!("写入配置策略标记失败: {}", e))
}

fn saved_config_if_current(runtime_dir: &Path) -> Option<String> {
    let policy = fs::read_to_string(config_policy_path(runtime_dir)).ok()?;
    if policy.trim() != SAVED_CONFIG_POLICY {
        return None;
    }
    let config = fs::read_to_string(running_config_path(runtime_dir)).ok()?;
    if config.trim().is_empty() {
        return None;
    }
    Some(config)
}

fn saved_config_matches(runtime_dir: &Path, expected: &str) -> bool {
    saved_config_if_current(runtime_dir).as_deref() == Some(expected)
}

fn managed_record_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("managed-core.json")
}

fn write_file_atomic(target: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, content)
        .map_err(|e| format!("写入临时配置文件失败 ({:?}): {}", tmp, e))?;
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("提交配置文件失败 ({:?}): {}", target, e)
    })
}

fn write_managed_record(runtime_dir: &Path, pid: Option<u32>, config_path: &Path) {
    let Some(pid) = pid else { return };
    let exe_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("laynet-core.exe")))
        .map(|p| p.to_string_lossy().to_string());
    let rec = ManagedCoreRecord {
        pid,
        exe_path,
        config_path: config_path.to_string_lossy().to_string(),
        runtime_dir: runtime_dir.to_string_lossy().to_string(),
    };
    if let Ok(json) = serde_json::to_string(&rec) {
        let _ = fs::write(managed_record_path(runtime_dir), json);
    }
}

fn read_recorded_pid(runtime_dir: &Path) -> Option<u32> {
    let raw = fs::read_to_string(managed_record_path(runtime_dir)).ok()?;
    serde_json::from_str::<ManagedCoreRecord>(&raw)
        .ok()
        .map(|r| r.pid)
}

fn clear_managed_record(runtime_dir: &Path) {
    let _ = fs::remove_file(managed_record_path(runtime_dir));
}

fn expected_laynet_sidecar_paths(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("laynet-core.exe"));
            paths.push(dir.join("laynet-core-x86_64-pc-windows-msvc.exe"));
            if let Some(target_dir) = dir.parent() {
                if let Some(src_tauri_dir) = target_dir.parent() {
                    paths.push(
                        src_tauri_dir
                            .join("binaries")
                            .join("laynet-core-x86_64-pc-windows-msvc.exe"),
                    );
                }
            }
        }
    }
    if let Some(app) = app {
        if let Ok(res_dir) = app.path().resource_dir() {
            paths.push(res_dir.join("laynet-core.exe"));
            paths.push(res_dir.join("laynet-core-x86_64-pc-windows-msvc.exe"));
            paths.push(
                res_dir
                    .join("binaries")
                    .join("laynet-core-x86_64-pc-windows-msvc.exe"),
            );
        }
    }
    paths
}

impl CoreManager {
    #[cfg(test)]
    fn with_timeouts(ready_timeout: Duration, poll_interval: Duration) -> Self {
        Self {
            ready_timeout,
            poll_interval,
            ..Self::default()
        }
    }

    pub fn is_running(&self) -> bool {
        self.session
            .lock()
            .map(|guard| guard.active.is_some())
            .unwrap_or(false)
    }

    pub fn is_busy(&self) -> bool {
        self.session
            .lock()
            .map(|guard| guard.active.is_some() || guard.candidate.is_some())
            .unwrap_or(false)
    }

    pub fn get_snapshot(&self) -> TraySyncPayload {
        self.session
            .lock()
            .map(|g| g.snapshot.clone())
            .unwrap_or_default()
    }

    pub fn set_pending_exit_error(&self, err: String) {
        if let Ok(mut guard) = self.session.lock() {
            guard.pending_exit_error = Some(err);
            guard.cold_start_consumed = true;
        }
    }

    pub fn consume_launch_context(&self) -> LaunchContextSnapshot {
        let mut guard = match self.session.lock() {
            Ok(g) => g,
            Err(_) => {
                return LaunchContextSnapshot {
                    is_cold_start: true,
                    core_running: false,
                    preferred_sys_proxy: true,
                    routing_mode: "rule".to_string(),
                    tun_mode: false,
                    pending_exit_error: None,
                }
            }
        };

        let is_cold_start = !guard.cold_start_consumed;
        guard.cold_start_consumed = true;
        LaunchContextSnapshot {
            is_cold_start,
            core_running: guard.active.is_some(),
            preferred_sys_proxy: guard.snapshot.sys_proxy,
            routing_mode: guard.snapshot.routing_mode.clone(),
            tun_mode: guard.snapshot.tun_mode,
            pending_exit_error: guard.pending_exit_error.take(),
        }
    }

    pub fn sync_from_frontend(&self, app: &AppHandle, mut payload: TraySyncPayload) {
        let (snap_clone, my_epoch) = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            let actual_running = guard.active.is_some();
            payload.connected = actual_running;
            guard.snapshot = payload.clone();
            if let Some(ref mut committed) = guard.last_committed {
                if actual_running {
                    committed.sys_proxy = payload.sys_proxy;
                    committed.tun_mode = payload.tun_mode;
                    committed.routing_mode = payload.routing_mode.clone();
                    committed.active_node = payload.active_node.clone();
                }
            }
            guard.state_epoch += 1;
            (guard.snapshot.clone(), guard.state_epoch)
        };

        if let Ok(_effect) = self.effect_lock.lock() {
            if let Ok(guard) = self.session.lock() {
                if guard.state_epoch != my_epoch {
                    return;
                }
            }
            let _ = sync_tray_visuals(app, &snap_clone);
        }
    }

    pub fn update_headless_sys_proxy(&self, app: &AppHandle) -> Result<(), String> {
        let _effect = self.effect_lock.lock().map_err(|err| err.to_string())?;
        let mut session = self.session.lock().map_err(|err| err.to_string())?;
        let enable = !session.snapshot.sys_proxy;
        if session.active.is_some() {
            if enable {
                set_system_proxy(true, "127.0.0.1", DEFAULT_MIXED_PORT)
                    .map_err(|err| format!("系统代理接管失败: {}", err))?;
            } else {
                release_laynet_system_proxy(DEFAULT_MIXED_PORT)
                    .map_err(|err| format!("系统代理关闭失败: {}", err))?;
            }
            if let Some(committed) = session.last_committed.as_mut() {
                committed.sys_proxy = enable;
            }
        }
        session.cold_start_consumed = true;
        session.snapshot.sys_proxy = enable;
        session.state_epoch += 1;
        let snapshot = session.snapshot.clone();
        drop(session);
        sync_tray_visuals(app, &snapshot)
    }

    pub fn update_headless_routing_mode(&self, app: &AppHandle, mode: &str) {
        let (next_snap, my_epoch) = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            guard.cold_start_consumed = true;
            guard.snapshot.routing_mode = mode.to_string();
            let running = guard.active.is_some();
            if running {
                if let Some(ref mut committed) = guard.last_committed {
                    committed.routing_mode = mode.to_string();
                }
            }
            guard.state_epoch += 1;
            (guard.snapshot.clone(), guard.state_epoch)
        };

        if let Ok(_effect) = self.effect_lock.lock() {
            if let Ok(guard) = self.session.lock() {
                if guard.state_epoch != my_epoch {
                    return;
                }
            }
            let _ = sync_tray_visuals(app, &next_snap);
        }
    }

    /// 准备运行时工作目录，并确保 `wintun.dll` 部署到运行目录及可执行文件同目录
    pub fn prepare_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let base_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法获取应用本地数据目录: {}", e))?;
        let runtime_dir = base_dir.join("runtime");
        fs::create_dir_all(&runtime_dir)
            .map_err(|e| format!("创建运行时目录失败 ({:?}): {}", runtime_dir, e))?;

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(res_dir) = app.path().resource_dir() {
            candidates.push(res_dir.join("wintun.dll"));
            candidates.push(res_dir.join("binaries").join("wintun.dll"));
        }
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join("wintun.dll"));
                if let Some(target_dir) = exe_dir.parent() {
                    if let Some(src_tauri_dir) = target_dir.parent() {
                        candidates.push(src_tauri_dir.join("binaries").join("wintun.dll"));
                    }
                }
            }
        }

        if let Some(src_dll) = candidates.into_iter().find(|p| p.is_file()) {
            let dst_runtime_dll = runtime_dir.join("wintun.dll");
            let need_copy_runtime = match (fs::metadata(&src_dll), fs::metadata(&dst_runtime_dll)) {
                (Ok(s), Ok(d)) => s.len() != d.len(),
                (Ok(_), Err(_)) => true,
                _ => false,
            };
            if need_copy_runtime {
                let _ = fs::copy(&src_dll, &dst_runtime_dll);
            }

            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let dst_exe_dll = exe_dir.join("wintun.dll");
                    if !dst_exe_dll.is_file() {
                        let _ = fs::copy(&src_dll, &dst_exe_dll);
                    }
                }
            }
        }

        if let Some(mgr) = app.try_state::<CoreManager>() {
            if let Ok(mut guard) = mgr.session.lock() {
                guard.runtime_dir = Some(runtime_dir.clone());
            }
        }

        Ok(runtime_dir)
    }

    /// 仅清理经过路径/命令行/记录PID核实确属 LayNet 的遗留内核进程与临时候选文件
    pub fn cleanup_verified_orphans(app: Option<&AppHandle>, runtime_dir: Option<&Path>, exclude_pids: &[u32]) {
        #[cfg(windows)]
        {
            let recorded_pid = runtime_dir.and_then(read_recorded_pid);
            let expected_exes = expected_laynet_sidecar_paths(app);
            for proc_info in enumerate_core_candidate_processes() {
                if is_verified_laynet_orphan(
                    &proc_info,
                    &expected_exes,
                    runtime_dir,
                    recorded_pid,
                    exclude_pids,
                ) {
                    kill_pid_and_wait(proc_info.pid, 2500);
                }
            }
        }

        #[cfg(not(windows))]
        {
            let _ = (app, exclude_pids);
        }

        if let Some(dir) = runtime_dir {
            clear_managed_record(dir);
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("candidate-config-") && name_str.ends_with(".json") {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    /// 冷启动防断网清理（必须在单实例锁确立为唯一主实例之后、恢复连接之前执行）
    pub fn cold_start_cleanup(app: &AppHandle) {
        let runtime_dir = Self::prepare_runtime_dir(app).ok();
        Self::cleanup_verified_orphans(Some(app), runtime_dir.as_deref(), &[]);
        let _ = release_laynet_system_proxy(DEFAULT_MIXED_PORT);
    }

    /// 读取上次已提交、且带当前证书指纹策略标记的 `running-config.json`。
    /// 进程刚启动、或文件仍是升级前的无标记缓存时，托盘重连不能使用它。
    pub fn read_saved_config(app: &AppHandle) -> Option<String> {
        let core = app.state::<CoreManager>();
        if !core.cached_config_ready.load(Ordering::SeqCst) {
            return None;
        }
        let runtime_dir = Self::prepare_runtime_dir(app).ok()?;
        saved_config_if_current(&runtime_dir)
    }

    /// 前端确认证书指纹筛选后调用。
    /// 缓存策略由成功提交配置的路径写入，前端只负责开放读取或作废旧缓存。
    pub fn settle_cached_config(
        &self,
        app: &AppHandle,
        discard_saved: bool,
        expected: Option<&str>,
    ) {
        let Ok(_effect) = self.effect_lock.lock() else {
            return;
        };
        if discard_saved {
            self.cached_config_ready.store(false, Ordering::SeqCst);
            if let Ok(runtime_dir) = Self::prepare_runtime_dir(app) {
                let _ = fs::remove_file(config_policy_path(&runtime_dir));
                let _ = fs::remove_file(running_config_path(&runtime_dir));
            }
            return;
        }
        let ready = expected.is_some_and(|config| {
            Self::prepare_runtime_dir(app)
                .is_ok_and(|dir| saved_config_matches(&dir, config))
        });
        self.cached_config_ready.store(ready, Ordering::SeqCst);
    }

    pub fn request_frontend_reconnect(&self) {
        self.reconnect_requested.store(true, Ordering::SeqCst);
    }

    pub fn take_frontend_reconnect(&self) -> bool {
        self.reconnect_requested.swap(false, Ordering::SeqCst)
    }

    /// 停止本实例当前持有的受管进程，用于普通停止或应用退出/Panic 收尾
    pub fn stop_owned_processes(&self, reason: StopReason, app: Option<&AppHandle>) {
        if reason == StopReason::Shutdown {
            self.latest_intent_kind.store(INTENT_SHUTDOWN, Ordering::SeqCst);
        } else {
            self.latest_intent_kind.store(INTENT_DISCONNECT, Ordering::SeqCst);
        }
        self.intent_seq.fetch_add(1, Ordering::SeqCst);

        let (handles, runtime_dir) = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            let mut list: Vec<Box<dyn ManagedProcessHandle>> = Vec::new();
            if let Some(mut entry) = guard.active.take() {
                entry.intentional_stop = Some(reason);
                if let Some(h) = entry.handle.take() {
                    list.push(h);
                }
            }
            if let Some(mut entry) = guard.candidate.take() {
                entry.intentional_stop = Some(reason);
                if let Some(h) = entry.handle.take() {
                    list.push(h);
                }
            }
            guard.desired_connected = false;
            guard.snapshot.connected = false;
            guard.last_committed = None;
            guard.state_epoch += 1;
            (list, guard.runtime_dir.clone())
        };

        for mut handle in handles {
            handle.terminate_and_wait(3000);
        }
        if let Some(dir) = runtime_dir.as_deref() {
            clear_managed_record(dir);
        }
        if reason == StopReason::Shutdown {
            if let Some(a) = app {
                let _ = sync_tray_visuals(a, &self.get_snapshot());
            }
        }
    }

    /// 供 PanicHook 使用：优先终止本实例持有的进程并释放 LayNet 接管的代理
    pub fn panic_cleanup(&self) {
        let _ = release_laynet_system_proxy(DEFAULT_MIXED_PORT);
        let runtime_dir = self
            .session
            .lock()
            .ok()
            .and_then(|g| g.runtime_dir.clone());
        self.stop_owned_processes(StopReason::Shutdown, None);
        if let Some(dir) = runtime_dir.as_deref() {
            Self::cleanup_verified_orphans(None, Some(dir), &[]);
        }
    }

    pub async fn disconnect(&self, app: &AppHandle, is_shutdown: bool) {
        let driver = Arc::new(TauriCoreDriver { app: app.clone() });
        self.disconnect_with_driver(driver, is_shutdown).await;
    }

    pub async fn disconnect_with_driver(&self, driver: Arc<dyn CoreDriver>, is_shutdown: bool) {
        let kind = if is_shutdown {
            INTENT_SHUTDOWN
        } else {
            INTENT_DISCONNECT
        };
        let reason = if is_shutdown {
            StopReason::Shutdown
        } else {
            StopReason::ManualStop
        };

        self.latest_intent_kind.store(kind, Ordering::SeqCst);
        self.intent_seq.fetch_add(1, Ordering::SeqCst);

        let _op = self.op_lock.lock().await;

        let (handles, runtime_dir, snap_clone, my_epoch) = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            let mut list = Vec::new();
            if let Some(mut entry) = guard.active.take() {
                entry.intentional_stop = Some(reason);
                if let Some(h) = entry.handle.take() {
                    list.push(h);
                }
            }
            if let Some(mut entry) = guard.candidate.take() {
                entry.intentional_stop = Some(reason);
                if let Some(h) = entry.handle.take() {
                    list.push(h);
                }
            }
            guard.desired_connected = false;
            guard.snapshot.connected = false;
            guard.last_committed = None;
            guard.cold_start_consumed = true;
            guard.pending_exit_error = None;
            guard.state_epoch += 1;
            (
                list,
                guard.runtime_dir.clone(),
                guard.snapshot.clone(),
                guard.state_epoch,
            )
        };

        for mut h in handles {
            h.terminate_and_wait(3000);
        }
        if let Some(dir) = runtime_dir.as_deref() {
            clear_managed_record(dir);
        }

        let port = DEFAULT_MIXED_PORT;
        if let Ok(_effect) = self.effect_lock.lock() {
            if let Ok(guard) = self.session.lock() {
                if guard.state_epoch != my_epoch {
                    return;
                }
            }
            driver.release_proxy_if_owned(port);
            driver.sync_ui(&snap_clone, None);
        }
    }

    pub async fn apply_config(
        &self,
        app: &AppHandle,
        req: CoreApplyRequest,
    ) -> Result<CoreApplyResult, String> {
        let runtime_dir = match Self::prepare_runtime_dir(app) {
            Ok(dir) => dir,
            Err(err) => return Ok(CoreApplyResult::precheck_failed(err, self.is_running())),
        };
        let driver = Arc::new(TauriCoreDriver { app: app.clone() });
        let stdio_app = app.clone();
        let on_stdio_forward: StdioCallback = {
            let session = self.session.clone();
            Arc::new(move |run_id, line| {
                let is_current = session
                    .lock()
                    .map(|g| {
                        g.active.as_ref().map(|a| a.run_id) == Some(run_id)
                            || g.candidate.as_ref().map(|c| c.run_id) == Some(run_id)
                    })
                    .unwrap_or(false);
                if is_current && stdio_app.get_webview_window("main").is_some() {
                    let _ = stdio_app.emit("core-stdio", line);
                }
            })
        };
        Ok(self
            .apply_config_with_driver(&runtime_dir, driver, req, Some(on_stdio_forward))
            .await)
    }

    pub async fn apply_config_with_driver(
        &self,
        runtime_dir: &Path,
        driver: Arc<dyn CoreDriver>,
        req: CoreApplyRequest,
        extra_stdio: Option<StdioCallback>,
    ) -> CoreApplyResult {
        if let Err(e) = fs::create_dir_all(runtime_dir) {
            return CoreApplyResult::precheck_failed(
                format!("创建运行时目录失败: {}", e),
                self.is_running(),
            );
        }

        self.latest_intent_kind.store(INTENT_APPLY, Ordering::SeqCst);
        let my_intent = self.intent_seq.fetch_add(1, Ordering::SeqCst) + 1;

        let _op = self.op_lock.lock().await;

        if let Some(aborted) = self.check_aborted(my_intent) {
            return aborted;
        }

        {
            if let Ok(mut guard) = self.session.lock() {
                guard.runtime_dir = Some(runtime_dir.to_path_buf());
                guard.cold_start_consumed = true;
            }
        }

        let cand_path = candidate_config_path(runtime_dir, my_intent);
        if let Err(e) = fs::write(&cand_path, req.config_json.as_bytes()) {
            return CoreApplyResult::precheck_failed(
                format!("写入候选配置失败: {}", e),
                self.is_running(),
            );
        }

        // 1. 候选配置独立文件预检：预检期间旧内核、running-config.json、代理、遥测均不受影响
        let precheck_drv = driver.clone();
        let cand_for_check = cand_path.clone();
        let dir_for_check = runtime_dir.to_path_buf();
        let precheck = tauri::async_runtime::spawn_blocking(move || {
            precheck_drv.precheck_config(&cand_for_check, &dir_for_check)
        })
        .await
        .unwrap_or_else(|e| PrecheckOutcome::Failed(format!("预检任务异常: {}", e)));

        if let Some(aborted) = self.check_aborted(my_intent) {
            let _ = fs::remove_file(&cand_path);
            return aborted;
        }

        if let PrecheckOutcome::Failed(reason) = precheck {
            let _ = fs::remove_file(&cand_path);
            let still_running = self.is_running();
            if req.allow_rollback && still_running {
                return CoreApplyResult {
                    status: "rolled_back".to_string(),
                    config_path: Some(running_config_path(runtime_dir).to_string_lossy().to_string()),
                    failure_stage: Some("precheck".to_string()),
                    error: Some(format!("[预检失败] {}", reason)),
                    rollback_error: None,
                    running_after: true,
                };
            }
            return CoreApplyResult {
                status: "failed".to_string(),
                config_path: None,
                failure_stage: Some("precheck".to_string()),
                error: Some(format!("[预检失败] {}", reason)),
                rollback_error: None,
                running_after: still_running,
            };
        }

        // 2. 预检通过后准备切换进程：先保留上一份已提交配置作为回滚凭据
        let rollback_session = if req.allow_rollback {
            self.extract_rollback_session(runtime_dir)
        } else {
            None
        };

        // 停止上一轮受管内核（标记为 ReloadReplace，不释放系统代理，不触发异常退出）
        let old_handle = {
            let Ok(mut guard) = self.session.lock() else {
                let _ = fs::remove_file(&cand_path);
                return CoreApplyResult {
                    status: "failed".to_string(),
                    config_path: None,
                    failure_stage: Some("startup".to_string()),
                    error: Some("获取内核会话锁失败".to_string()),
                    rollback_error: None,
                    running_after: false,
                };
            };
            guard.active.take().and_then(|mut entry| {
                entry.intentional_stop = Some(StopReason::ReloadReplace);
                entry.handle.take()
            })
        };

        if let Some(mut h) = old_handle {
            h.terminate_and_wait(3000);
        }
        clear_managed_record(runtime_dir);

        if let Some(aborted) = self.check_aborted(my_intent) {
            let _ = fs::remove_file(&cand_path);
            self.cleanup_on_cancelled_switch(runtime_dir, &driver, my_intent);
            return aborted;
        }

        // 3. 启动候选进程并等待存活 + 9090/7890 就绪
        let endpoints = parse_probe_endpoints(&req.config_json);
        let cand_attempt = self
            .spawn_and_wait_ready(
                runtime_dir,
                &cand_path,
                &endpoints,
                &driver,
                my_intent,
                extra_stdio.clone(),
            )
            .await;

        if let Some(aborted) = self.check_aborted(my_intent) {
            let _ = fs::remove_file(&cand_path);
            self.cleanup_on_cancelled_switch(runtime_dir, &driver, my_intent);
            return aborted;
        }

        let committed = CommittedSession {
            config_json: req.config_json.clone(),
            sys_proxy: req.sys_proxy,
            tun_mode: req.tun_mode,
            routing_mode: req.routing_mode.clone(),
            active_node: req.active_node.clone(),
            endpoints,
        };

        let outcome = cand_attempt.and_then(|(run_id, pid)| {
            self.commit_candidate(runtime_dir, &driver, my_intent, run_id, pid, committed)
        });
        let _ = fs::remove_file(&cand_path);
        match outcome {
            Ok(()) => CoreApplyResult {
                status: "applied".to_string(),
                config_path: Some(running_config_path(runtime_dir).to_string_lossy().to_string()),
                failure_stage: None,
                error: None,
                rollback_error: None,
                running_after: true,
            },
            Err((stage, error)) => {
                self.abort_candidate(runtime_dir);
                self.attempt_rollback_or_fail(
                    runtime_dir,
                    &driver,
                    my_intent,
                    &stage,
                    error,
                    rollback_session,
                    &req,
                    extra_stdio,
                )
                .await
            }
        }
    }

    fn commit_candidate(
        &self,
        runtime_dir: &Path,
        driver: &Arc<dyn CoreDriver>,
        intent: u64,
        run_id: u64,
        pid: Option<u32>,
        committed: CommittedSession,
    ) -> Result<(), (String, String)> {
        let startup_error = |message: String| ("startup".to_string(), message);
        let _effect = self
            .effect_lock
            .lock()
            .map_err(|_| startup_error("获取系统状态锁失败".to_string()))?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| startup_error("获取会话锁失败".to_string()))?;
        if self.intent_seq.load(Ordering::SeqCst) != intent {
            return Err(("cancelled".to_string(), "操作已取消".to_string()));
        }

        let candidate = session
            .candidate
            .as_ref()
            .filter(|entry| entry.run_id == run_id)
            .ok_or_else(|| startup_error("候选内核已被清理".to_string()))?;
        let is_alive = || {
            !candidate.exited
                && candidate.handle.as_ref().is_some_and(|handle| handle.is_alive())
        };
        if !is_alive() {
            return Err(startup_error(candidate.exit_reason.clone()
                .unwrap_or_else(|| "候选内核在提交前退出".to_string())));
        }

        let port = committed
            .endpoints
            .mixed_addr
            .map(|addr| addr.port())
            .unwrap_or(DEFAULT_MIXED_PORT);
        if committed.sys_proxy {
            if let Err(error) = driver.apply_proxy(true, port) {
                driver.release_proxy_if_owned(port);
                return Err(("proxy".to_string(), format!("系统代理接管失败: {}", error)));
            }
        } else {
            driver.release_proxy_if_owned(port);
        }

        self.cached_config_ready.store(false, Ordering::SeqCst);
        if let Err(error) = fs::remove_file(config_policy_path(runtime_dir))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            driver.release_proxy_if_owned(port);
            return Err(startup_error(format!("作废上一份配置策略标记失败: {}", error)));
        }
        let running_path = running_config_path(runtime_dir);
        if let Err(error) = write_file_atomic(&running_path, committed.config_json.as_bytes()) {
            driver.release_proxy_if_owned(port);
            return Err(startup_error(error));
        }
        if !is_alive() || self.intent_seq.load(Ordering::SeqCst) != intent {
            driver.release_proxy_if_owned(port);
            return Err(startup_error("候选内核已退出或切换已取消".to_string()));
        }

        let cache_ready = write_config_policy(runtime_dir).is_ok();
        self.cached_config_ready.store(cache_ready, Ordering::SeqCst);
        write_managed_record(runtime_dir, pid, &running_path);
        session.active = session.candidate.take();
        session.desired_connected = true;
        session.pending_exit_error = None;
        let snapshot = TraySyncPayload {
            connected: true,
            sys_proxy: committed.sys_proxy,
            tun_mode: committed.tun_mode,
            routing_mode: committed.routing_mode.clone(),
            active_node: committed.active_node.clone(),
        };
        session.snapshot = snapshot.clone();
        session.last_committed = Some(committed);
        session.state_epoch += 1;
        drop(session);
        driver.sync_ui(&snapshot, None);
        Ok(())
    }

    async fn attempt_rollback_or_fail(
        &self,
        runtime_dir: &Path,
        driver: &Arc<dyn CoreDriver>,
        my_intent: u64,
        cand_stage: &str,
        cand_err: String,
        rollback_session: Option<CommittedSession>,
        req: &CoreApplyRequest,
        extra_stdio: Option<StdioCallback>,
    ) -> CoreApplyResult {
        if let Some(aborted) = self.check_aborted(my_intent) {
            self.cleanup_on_cancelled_switch(runtime_dir, driver, my_intent);
            return aborted;
        }

        if let Some(prev) = rollback_session {
            let cand_path = candidate_config_path(runtime_dir, my_intent);
            let rollback = match fs::write(&cand_path, prev.config_json.as_bytes()) {
                Ok(()) => self
                    .spawn_and_wait_ready(
                        runtime_dir,
                        &cand_path,
                        &prev.endpoints,
                        driver,
                        my_intent,
                        extra_stdio,
                    )
                    .await,
                Err(error) => Err(("rollback".to_string(), format!("写入回滚配置失败: {}", error))),
            };
            let preserve_sys_proxy = prev.sys_proxy;
            let rollback = rollback.and_then(|(run_id, pid)| {
                self.commit_candidate(runtime_dir, driver, my_intent, run_id, pid, prev)
            });
            let _ = fs::remove_file(&cand_path);
            if rollback.is_err() && let Some(aborted) = self.check_aborted(my_intent) {
                self.cleanup_on_cancelled_switch(runtime_dir, driver, my_intent);
                return aborted;
            }
            return match rollback {
                Ok(()) => CoreApplyResult {
                    status: "rolled_back".to_string(),
                    config_path: Some(running_config_path(runtime_dir).to_string_lossy().to_string()),
                    failure_stage: Some(cand_stage.to_string()),
                    error: Some(cand_err),
                    rollback_error: None,
                    running_after: true,
                },
                Err((_, error)) => {
                    self.finalize_total_failure(runtime_dir, driver, preserve_sys_proxy);
                    CoreApplyResult {
                        status: "failed".to_string(),
                        config_path: None,
                        failure_stage: Some("rollback".to_string()),
                        error: Some(cand_err),
                        rollback_error: Some(format!("[回滚失败] {}", error)),
                        running_after: false,
                    }
                }
            };
        }

        // 无旧配置或首次连接失败：清理并返回断开状态，同时保留用户的代理偏好
        self.finalize_total_failure(runtime_dir, driver, req.sys_proxy);
        CoreApplyResult {
            status: "failed".to_string(),
            config_path: None,
            failure_stage: Some(cand_stage.to_string()),
            error: Some(cand_err),
            rollback_error: None,
            running_after: false,
        }
    }

    fn finalize_total_failure(
        &self,
        runtime_dir: &Path,
        driver: &Arc<dyn CoreDriver>,
        preserve_sys_proxy: bool,
    ) {
        self.abort_candidate(runtime_dir);
        let (snap_clone, my_epoch) = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            guard.active = None;
            guard.candidate = None;
            guard.last_committed = None;
            guard.desired_connected = false;
            guard.snapshot.connected = false;
            guard.snapshot.sys_proxy = preserve_sys_proxy;
            guard.state_epoch += 1;
            (guard.snapshot.clone(), guard.state_epoch)
        };
        clear_managed_record(runtime_dir);
        if let Ok(_effect) = self.effect_lock.lock() {
            let same = self
                .session
                .lock()
                .map(|g| g.state_epoch == my_epoch)
                .unwrap_or(false);
            if same {
                driver.release_proxy_if_owned(DEFAULT_MIXED_PORT);
                driver.sync_ui(&snap_clone, None);
            }
        }
    }

    fn cleanup_on_cancelled_switch(
        &self,
        runtime_dir: &Path,
        driver: &Arc<dyn CoreDriver>,
        _my_intent: u64,
    ) {
        self.abort_candidate(runtime_dir);
        let kind = self.latest_intent_kind.load(Ordering::SeqCst);
        if kind == INTENT_DISCONNECT || kind == INTENT_SHUTDOWN {
            let (snap_clone, my_epoch) = {
                let Ok(mut guard) = self.session.lock() else {
                    return;
                };
                guard.active = None;
                guard.desired_connected = false;
                guard.snapshot.connected = false;
                guard.last_committed = None;
                guard.state_epoch += 1;
                (guard.snapshot.clone(), guard.state_epoch)
            };
            clear_managed_record(runtime_dir);
            if let Ok(_effect) = self.effect_lock.lock() {
                let same = self
                    .session
                    .lock()
                    .map(|g| g.state_epoch == my_epoch)
                    .unwrap_or(false);
                if same {
                    driver.release_proxy_if_owned(DEFAULT_MIXED_PORT);
                    driver.sync_ui(&snap_clone, None);
                }
            }
        }
    }

    fn abort_candidate(&self, runtime_dir: &Path) {
        let cand_handle = {
            let Ok(mut guard) = self.session.lock() else {
                return;
            };
            guard.candidate.take().and_then(|mut c| {
                c.intentional_stop = Some(StopReason::ManualStop);
                c.handle.take()
            })
        };
        if let Some(mut h) = cand_handle {
            h.terminate_and_wait(2500);
        }
        clear_managed_record(runtime_dir);
    }

    fn extract_rollback_session(&self, runtime_dir: &Path) -> Option<CommittedSession> {
        let guard = self.session.lock().ok()?;
        if let Some(committed) = guard.last_committed.clone() {
            return Some(committed);
        }
        if guard.active.is_some() {
            let cfg = fs::read_to_string(running_config_path(runtime_dir)).ok()?;
            let endpoints = parse_probe_endpoints(&cfg);
            return Some(CommittedSession {
                config_json: cfg,
                sys_proxy: guard.snapshot.sys_proxy,
                tun_mode: guard.snapshot.tun_mode,
                routing_mode: guard.snapshot.routing_mode.clone(),
                active_node: guard.snapshot.active_node.clone(),
                endpoints,
            });
        }
        None
    }

    fn check_aborted(&self, my_intent: u64) -> Option<CoreApplyResult> {
        if self.intent_seq.load(Ordering::SeqCst) == my_intent {
            return None;
        }
        Some(self.check_aborted_locked(my_intent).unwrap_or(CoreApplyResult {
            status: "superseded".to_string(),
            config_path: None,
            failure_stage: None,
            error: None,
            rollback_error: None,
            running_after: self.is_running(),
        }))
    }

    fn check_aborted_locked(&self, my_intent: u64) -> Option<CoreApplyResult> {
        if self.intent_seq.load(Ordering::SeqCst) == my_intent {
            return None;
        }
        let kind = self.latest_intent_kind.load(Ordering::SeqCst);
        let status = if kind == INTENT_DISCONNECT || kind == INTENT_SHUTDOWN {
            "cancelled"
        } else {
            "superseded"
        };
        Some(CoreApplyResult {
            status: status.to_string(),
            config_path: None,
            failure_stage: None,
            error: None,
            rollback_error: None,
            running_after: false,
        })
    }

    async fn spawn_and_wait_ready(
        &self,
        runtime_dir: &Path,
        config_path: &Path,
        endpoints: &ProbeEndpoints,
        driver: &Arc<dyn CoreDriver>,
        my_intent: u64,
        extra_stdio: Option<StdioCallback>,
    ) -> Result<(u64, Option<u32>), (String, String)> {
        let run_id = {
            let mut guard = self
                .session
                .lock()
                .map_err(|_| ("startup".to_string(), "获取会话锁失败".to_string()))?;
            guard.next_run_id += 1;
            let id = guard.next_run_id;
            guard.candidate = Some(ManagedCoreEntry {
                run_id: id,
                pid: None,
                handle: None,
                intentional_stop: None,
                exited: false,
                exit_reason: None,
            });
            id
        };

        let on_stdio: StdioCallback = if let Some(cb) = extra_stdio {
            cb
        } else {
            Arc::new(|_, _| {})
        };

        let session_for_exit = self.session.clone();
        let effect_for_exit = self.effect_lock.clone();
        let driver_for_exit = driver.clone();
        let runtime_for_exit = runtime_dir.to_path_buf();

        let on_exit: ExitCallback = Arc::new(move |ev: CoreExitEvent| {
            handle_core_exit_sync(
                &session_for_exit,
                &effect_for_exit,
                &driver_for_exit,
                &runtime_for_exit,
                ev,
            );
        });

        let spawned = driver.spawn_core(run_id, config_path, runtime_dir, on_stdio, on_exit);
        let handle = match spawned {
            Ok(h) => h,
            Err(e) => {
                if let Ok(mut guard) = self.session.lock() {
                    if guard.candidate.as_ref().map(|c| c.run_id) == Some(run_id) {
                        guard.candidate = None;
                    }
                }
                return Err(("startup".to_string(), format!("[启动失败] {}", e)));
            }
        };

        let pid = handle.pid();
        {
            if let Ok(mut guard) = self.session.lock() {
                if let Some(ref mut cand) = guard.candidate {
                    if cand.run_id == run_id {
                        cand.pid = pid;
                        cand.handle = Some(handle);
                    }
                }
            }
        }

        let deadline = Instant::now() + self.ready_timeout;
        loop {
            if self.intent_seq.load(Ordering::SeqCst) != my_intent {
                self.abort_candidate(runtime_dir);
                return Err(("cancelled".to_string(), "操作已取消".to_string()));
            }

            // 检查候选进程是否已触发 Terminated 或不再存活
            let early_exit_reason = {
                let guard = self
                    .session
                    .lock()
                    .map_err(|_| ("startup".to_string(), "获取会话锁失败".to_string()))?;
                match guard.candidate.as_ref() {
                    Some(c) if c.run_id == run_id => {
                        if c.exited {
                            Some(
                                c.exit_reason
                                    .clone()
                                    .unwrap_or_else(|| "候选内核已意外退出".to_string()),
                            )
                        } else if let Some(ref h) = c.handle {
                            if !h.is_alive() {
                                Some("候选内核启动后提前退出".to_string())
                            } else {
                                None
                            }
                        } else {
                            Some("候选进程句柄丢失".to_string())
                        }
                    }
                    _ => Some("候选进程已被清理".to_string()),
                }
            };

            if let Some(reason) = early_exit_reason {
                self.abort_candidate(runtime_dir);
                return Err(("startup".to_string(), format!("[启动失败] {}", reason)));
            }

            let drv = driver.clone();
            let ep = endpoints.clone();
            let ready = tauri::async_runtime::spawn_blocking(move || drv.probe_ready(&ep))
                .await
                .unwrap_or(false);

            if ready {
                if self.intent_seq.load(Ordering::SeqCst) != my_intent {
                    self.abort_candidate(runtime_dir);
                    return Err(("cancelled".to_string(), "操作已取消".to_string()));
                }

                // 二次确认：端口就绪后进程仍存活，排除被遗留/无关监听误导
                let still_alive = {
                    let guard = self
                        .session
                        .lock()
                        .map_err(|_| ("startup".to_string(), "获取会话锁失败".to_string()))?;
                    match guard.candidate.as_ref() {
                        Some(c) if c.run_id == run_id => {
                            !c.exited && c.handle.as_ref().map(|h| h.is_alive()).unwrap_or(false)
                        }
                        _ => false,
                    }
                };

                if still_alive {
                    return Ok((run_id, pid));
                }
                self.abort_candidate(runtime_dir);
                return Err((
                    "startup".to_string(),
                    "[启动失败] 候选内核在接口就绪瞬间退出".to_string(),
                ));
            }

            if Instant::now() >= deadline {
                self.abort_candidate(runtime_dir);
                return Err((
                    "readiness".to_string(),
                    "[就绪超时] 候选内核未能在规定时间内就绪 (Clash API / Mixed 端口不可达)"
                        .to_string(),
                ));
            }

            let interval = self.poll_interval;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(interval);
            })
            .await;
        }
    }
}

/// 退出归属判断与运行状态/代理/托盘同步在统一同步机制下原子协同执行，杜绝旧进程迟到事件覆盖新会话
fn handle_core_exit_sync(
    session: &Arc<Mutex<CoreSessionState>>,
    effect_lock: &Arc<Mutex<()>>,
    driver: &Arc<dyn CoreDriver>,
    runtime_dir: &Path,
    ev: CoreExitEvent,
) {
    let transition = {
        let Ok(mut guard) = session.lock() else {
            return;
        };

        // 1. 如果是等待就绪中的候选进程提前退出：仅标记 candidate 供等待循环立刻失败并回滚
        if let Some(ref mut cand) = guard.candidate {
            if cand.run_id == ev.run_id {
                cand.exited = true;
                cand.exit_reason = Some(ev.reason.clone());
                cand.handle = None;
                return;
            }
        }

        // 2. 只有当退出 run_id 确属当前激活中的这一轮内核，且不是主动停机/重载换进程时，才执行意外退出恢复
        let is_current_unexpected = match guard.active.as_ref() {
            Some(active) => active.run_id == ev.run_id && active.intentional_stop.is_none(),
            None => false,
        };

        if !is_current_unexpected {
            return;
        }

        // 清除当前进程句柄，更新运行态并保留用户下次连接的代理偏好 (snapshot.sys_proxy 等)
        guard.active = None;
        guard.desired_connected = false;
        guard.last_committed = None;
        guard.snapshot.connected = false;
        guard.cold_start_consumed = true;
        guard.pending_exit_error = Some(ev.reason.clone());
        guard.state_epoch += 1;

        let port = DEFAULT_MIXED_PORT;
        Some((guard.snapshot.clone(), guard.state_epoch, port))
    };

    let Some((snap_clone, my_epoch, port)) = transition else {
        return;
    };

    clear_managed_record(runtime_dir);

    if let Ok(_effect) = effect_lock.lock() {
        let still_current = session
            .lock()
            .map(|g| g.state_epoch == my_epoch)
            .unwrap_or(false);
        if !still_current {
            return;
        }

        driver.release_proxy_if_owned(port);
        driver.sync_ui(&snap_clone, Some(&ev));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::{self, Receiver, Sender};

    struct FakeHandle {
        pid: u32,
        alive: Arc<AtomicBool>,
        terminated: Arc<AtomicBool>,
        checks_until_exit: Option<AtomicU8>,
    }

    impl ManagedProcessHandle for FakeHandle {
        fn pid(&self) -> Option<u32> {
            Some(self.pid)
        }
        fn is_alive(&self) -> bool {
            if self
                .checks_until_exit
                .as_ref()
                .is_some_and(|checks| checks.fetch_sub(1, Ordering::SeqCst) == 1)
            {
                self.alive.store(false, Ordering::SeqCst);
            }
            self.alive.load(Ordering::SeqCst)
        }
        fn terminate_and_wait(&mut self, _timeout_ms: u32) {
            self.alive.store(false, Ordering::SeqCst);
            self.terminated.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct FakeDriver {
        state: Arc<Mutex<FakeDriverState>>,
    }

    struct FakeDriverState {
        precheck_results: VecDeque<PrecheckOutcome>,
        spawn_behaviors: VecDeque<SpawnBehavior>,
        probe_behaviors: VecDeque<Vec<bool>>,
        probe_gate: Option<(Sender<()>, Receiver<()>)>,
        proxy_enabled: bool,
        proxy_server: String,
        proxy_apply_log: Vec<(bool, u16)>,
        proxy_apply_error: Option<String>,
        proxy_release_calls: usize,
        ui_syncs: Vec<TraySyncPayload>,
        exit_events: Vec<CoreExitEvent>,
        exit_callbacks: Vec<(u64, ExitCallback, Arc<AtomicBool>)>,
        next_pid: u32,
    }

    enum SpawnBehavior {
        Success,
        ExitBeforeCommit,
        FailImmediate(String),
        CrashBeforeReady(String),
    }

    impl FakeDriver {
        fn new(proxy_enabled: bool, proxy_server: &str) -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeDriverState {
                    precheck_results: VecDeque::new(),
                    spawn_behaviors: VecDeque::new(),
                    probe_behaviors: VecDeque::new(),
                    probe_gate: None,
                    proxy_enabled,
                    proxy_server: proxy_server.to_string(),
                    proxy_apply_log: Vec::new(),
                    proxy_apply_error: None,
                    proxy_release_calls: 0,
                    ui_syncs: Vec::new(),
                    exit_events: Vec::new(),
                    exit_callbacks: Vec::new(),
                    next_pid: 1000,
                })),
            }
        }

        fn trigger_exit_for_index(&self, idx: usize, reason: &str) {
            let (run_id, cb, alive) = {
                let g = self.state.lock().unwrap();
                g.exit_callbacks[idx].clone()
            };
            alive.store(false, Ordering::SeqCst);
            cb(CoreExitEvent {
                run_id,
                reason: reason.to_string(),
            });
        }

        fn pause_next_probe(&self) -> (Receiver<()>, Sender<()>) {
            let (started, wait_for_start) = mpsc::channel();
            let (resume, wait_for_resume) = mpsc::channel();
            self.state.lock().unwrap().probe_gate = Some((started, wait_for_resume));
            (wait_for_start, resume)
        }
    }

    impl CoreDriver for FakeDriver {
        fn precheck_config(&self, _config_path: &Path, _runtime_dir: &Path) -> PrecheckOutcome {
            let mut g = self.state.lock().unwrap();
            g.precheck_results
                .pop_front()
                .unwrap_or(PrecheckOutcome::Passed)
        }

        fn spawn_core(
            &self,
            run_id: u64,
            _config_path: &Path,
            _runtime_dir: &Path,
            _on_stdio: StdioCallback,
            on_exit: ExitCallback,
        ) -> Result<Box<dyn ManagedProcessHandle>, String> {
            let mut g = self.state.lock().unwrap();
            let behavior = g
                .spawn_behaviors
                .pop_front()
                .unwrap_or(SpawnBehavior::Success);
            let pid = g.next_pid;
            g.next_pid += 1;

            match behavior {
                SpawnBehavior::FailImmediate(err) => Err(err),
                SpawnBehavior::CrashBeforeReady(reason) => {
                    let alive = Arc::new(AtomicBool::new(false));
                    let terminated = Arc::new(AtomicBool::new(false));
                    let cb_clone = on_exit.clone();
                    g.exit_callbacks.push((run_id, on_exit, alive.clone()));
                    std::thread::spawn(move || {
                        cb_clone(CoreExitEvent {
                            run_id,
                            reason,
                        });
                    });
                    Ok(Box::new(FakeHandle {
                        pid,
                        alive,
                        terminated,
                        checks_until_exit: None,
                    }))
                }
                SpawnBehavior::Success | SpawnBehavior::ExitBeforeCommit => {
                    let alive = Arc::new(AtomicBool::new(true));
                    let terminated = Arc::new(AtomicBool::new(false));
                    g.exit_callbacks.push((run_id, on_exit, alive.clone()));
                    Ok(Box::new(FakeHandle {
                        pid,
                        alive,
                        terminated,
                        checks_until_exit: matches!(behavior, SpawnBehavior::ExitBeforeCommit)
                            .then(|| AtomicU8::new(3)),
                    }))
                }
            }
        }

        fn probe_ready(&self, _endpoints: &ProbeEndpoints) -> bool {
            let mut g = self.state.lock().unwrap();
            if let Some((started, wait_for_resume)) = g.probe_gate.take() {
                drop(g);
                started.send(()).unwrap();
                return wait_for_resume.recv_timeout(Duration::from_secs(5)).is_ok();
            }
            if let Some(seq) = g.probe_behaviors.front_mut() {
                if !seq.is_empty() {
                    let res = seq.remove(0);
                    if seq.is_empty() {
                        g.probe_behaviors.pop_front();
                    }
                    return res;
                }
                g.probe_behaviors.pop_front();
            }
            true
        }

        fn apply_proxy(&self, enable: bool, port: u16) -> Result<(), String> {
            let mut g = self.state.lock().unwrap();
            g.proxy_apply_log.push((enable, port));
            if let Some(error) = g.proxy_apply_error.take() {
                return Err(error);
            }
            if enable {
                g.proxy_enabled = true;
                g.proxy_server = format!("127.0.0.1:{}", port);
            } else if g.proxy_enabled && g.proxy_server == format!("127.0.0.1:{}", port) {
                g.proxy_enabled = false;
            }
            Ok(())
        }

        fn release_proxy_if_owned(&self, port: u16) {
            let mut g = self.state.lock().unwrap();
            g.proxy_release_calls += 1;
            if g.proxy_enabled && g.proxy_server == format!("127.0.0.1:{}", port) {
                g.proxy_enabled = false;
            }
        }

        fn sync_ui(&self, snapshot: &TraySyncPayload, unexpected_exit: Option<&CoreExitEvent>) {
            let mut g = self.state.lock().unwrap();
            g.ui_syncs.push(snapshot.clone());
            if let Some(ev) = unexpected_exit {
                g.exit_events.push(ev.clone());
            }
        }
    }

    async fn resume_probe_after_intent<F: std::future::Future>(
        next_intent: F,
        resume: Sender<()>,
    ) -> F::Output {
        let mut next_intent = std::pin::pin!(next_intent);
        std::future::poll_fn(|cx| {
            assert!(next_intent.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        resume.send(()).unwrap();
        next_intent.await
    }

    fn temp_runtime_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "laynet-test-{}-{}",
            label,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_req(tag: &str, sys_proxy: bool, allow_rollback: bool) -> CoreApplyRequest {
        CoreApplyRequest {
            config_json: format!(
                "{{\"inbounds\":[{{\"type\":\"mixed\",\"tag\":\"mixed-in\",\"listen\":\"127.0.0.1\",\"listen_port\":7890}}],\"experimental\":{{\"clash_api\":{{\"external_controller\":\"127.0.0.1:9090\"}}}},\"_marker\":\"{}\"}}",
                tag
            ),
            sys_proxy,
            tun_mode: !sys_proxy,
            routing_mode: "rule".to_string(),
            active_node: Some(tag.to_string()),
            allow_rollback,
        }
    }

    #[test]
    fn orphan_verification_isolates_laynet_from_unrelated_processes() {
        let runtime_dir = PathBuf::from(r"C:\Users\demo\AppData\Local\com.lay00.net\runtime");
        let expected_exes = vec![PathBuf::from(r"C:\Program Files\LayNet\laynet-core.exe")];

        // 1. 合法 LayNet 残留（路径和 runtime 参数匹配）-> 应回收
        let real_orphan = ProcessInfo {
            pid: 2001,
            name: "laynet-core.exe".to_string(),
            exe_path: Some(r"C:\Program Files\LayNet\laynet-core.exe".to_string()),
            command_line: Some(
                r#""C:\Program Files\LayNet\laynet-core.exe" run -c "C:\Users\demo\AppData\Local\com.lay00.net\runtime\running-config.json""#
                    .to_string(),
            ),
        };
        assert!(is_verified_laynet_orphan(
            &real_orphan,
            &expected_exes,
            Some(&runtime_dir),
            None,
            &[]
        ));

        // 2. 系统其他 sing-box.exe -> 绝不误杀
        let other_sing_box = ProcessInfo {
            pid: 2002,
            name: "sing-box.exe".to_string(),
            exe_path: Some(r"D:\Tools\sing-box\sing-box.exe".to_string()),
            command_line: Some(r#"sing-box.exe run -c D:\Tools\sing-box\config.json"#.to_string()),
        };
        assert!(!is_verified_laynet_orphan(
            &other_sing_box,
            &expected_exes,
            Some(&runtime_dir),
            None,
            &[]
        ));

        // 3. 其他目录下的同名 laynet-core.exe 且参数不属于 LayNet -> 绝不误杀
        let foreign_core = ProcessInfo {
            pid: 2003,
            name: "laynet-core.exe".to_string(),
            exe_path: Some(r"D:\OtherApp\laynet-core.exe".to_string()),
            command_line: Some(r#"laynet-core.exe run -c D:\OtherApp\other.json"#.to_string()),
        };
        assert!(!is_verified_laynet_orphan(
            &foreign_core,
            &expected_exes,
            Some(&runtime_dir),
            None,
            &[]
        ));

        // 4. 当前受管 PID 在 exclude_pids 中 -> 绝不误杀
        assert!(!is_verified_laynet_orphan(
            &real_orphan,
            &expected_exes,
            Some(&runtime_dir),
            Some(2001),
            &[2001]
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_nt_query_command_line_works_on_current_process() {
        let pid = std::process::id();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!handle.is_null());
        let cmd = query_process_command_line(handle);
        unsafe { CloseHandle(handle) };
        let cmd_str = cmd.expect("NtQueryInformationProcess should read current command line");
        assert!(!cmd_str.is_empty());
    }

    #[test]
    fn probe_endpoints_live_validates_http_200_and_mixed_port() {
        let clash_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let clash_addr = clash_listener.local_addr().unwrap();
        let mixed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mixed_addr = mixed_listener.local_addr().unwrap();

        let t1 = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = clash_listener.accept() {
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
        });
        let t2 = std::thread::spawn(move || {
            let _ = mixed_listener.accept();
        });

        let ok = probe_endpoints_live(&ProbeEndpoints {
            clash_api_addr: clash_addr,
            mixed_addr: Some(mixed_addr),
        });
        let _ = t1.join();
        let _ = t2.join();
        assert!(ok);
    }

    #[test]
    fn item2_abnormal_exit_and_late_old_exit_isolation_and_proxy_preservation() {
        let dir = temp_runtime_dir("item2");
        let mgr = CoreManager::with_timeouts(Duration::from_millis(300), Duration::from_millis(10));
        let drv = Arc::new(FakeDriver::new(false, ""));

        // 第1轮连接：开启系统代理
        let res1 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("v1", true, false),
            None,
        ));
        assert_eq!(res1.status, "applied");
        assert!(drv.state.lock().unwrap().proxy_enabled);

        // 重载换进程到第2轮：第1轮旧进程被 ReloadReplace 停掉
        let res2 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("v2", true, true),
            None,
        ));
        assert_eq!(res2.status, "applied");

        // 模拟旧第1轮进程的 Terminated 迟到事件在新第2轮就绪之后才到达 -> 不得覆盖新会话与代理！
        drv.trigger_exit_for_index(0, "late old exit");
        assert!(mgr.is_running());
        assert!(drv.state.lock().unwrap().proxy_enabled);
        assert!(drv.state.lock().unwrap().exit_events.is_empty());

        // 模拟用户把系统代理切换到了其他软件 127.0.0.1:10809
        {
            let mut g = drv.state.lock().unwrap();
            g.proxy_enabled = true;
            g.proxy_server = "127.0.0.1:10809".to_string();
        }

        // 现在第2轮真实内核意外退出 -> 应清理连接与托盘，但绝不破坏用户的 127.0.0.1:10809，且保留下次连接的 sys_proxy 偏好
        drv.trigger_exit_for_index(1, "FATAL crash");
        assert!(!mgr.is_running());
        let g = drv.state.lock().unwrap();
        assert!(g.proxy_enabled);
        assert_eq!(g.proxy_server, "127.0.0.1:10809");
        assert_eq!(g.exit_events.len(), 1);
        let last_ui = g.ui_syncs.last().unwrap();
        assert!(!last_ui.connected);
        assert!(last_ui.sys_proxy); // 保留用户下次连接的代理偏好
        drop(g);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item3_precheck_failure_keeps_old_core_and_running_config() {
        let dir = temp_runtime_dir("item3-precheck");
        let mgr = CoreManager::with_timeouts(Duration::from_millis(300), Duration::from_millis(10));
        let drv = Arc::new(FakeDriver::new(false, ""));

        let res1 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("good-v1", true, false),
            None,
        ));
        assert_eq!(res1.status, "applied");
        let saved_before = fs::read_to_string(running_config_path(&dir)).unwrap();
        assert!(saved_before.contains("good-v1"));

        // 下一次候选配置预检失败 -> 旧进程（index 0）不应被停机、running-config.json 保持不变
        drv.state
            .lock()
            .unwrap()
            .precheck_results
            .push_back(PrecheckOutcome::Failed("syntax error".to_string()));
        let res2 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("bad-v2", false, true),
            None,
        ));
        assert_eq!(res2.status, "rolled_back");
        assert_eq!(res2.failure_stage.as_deref(), Some("precheck"));
        assert!(res2.running_after);
        assert_eq!(drv.state.lock().unwrap().exit_callbacks.len(), 1); // 仅启动过1次
        assert!(drv.state.lock().unwrap().proxy_enabled);
        let saved_after = fs::read_to_string(running_config_path(&dir)).unwrap();
        assert_eq!(saved_before, saved_after);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item3_startup_failure_rolls_back_and_both_failing_disconnects() {
        let dir = temp_runtime_dir("item3-rollback");
        let mgr = CoreManager::with_timeouts(Duration::from_millis(120), Duration::from_millis(10));
        let drv = Arc::new(FakeDriver::new(false, ""));

        // 1. 初始有效配置
        let ok1 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("stable-v1", true, false),
            None,
        ));
        assert_eq!(ok1.status, "applied");

        // 2. 候选预检通过，但候选启动崩溃 -> 触发回滚到 stable-v1 且恢复代理
        {
            let mut g = drv.state.lock().unwrap();
            g.precheck_results.push_back(PrecheckOutcome::Passed);
            g.spawn_behaviors
                .push_back(SpawnBehavior::CrashBeforeReady("port in use".to_string()));
            g.spawn_behaviors.push_back(SpawnBehavior::Success);
        }
        let rb = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("broken-v2", false, true),
            None,
        ));
        assert_eq!(rb.status, "rolled_back");
        assert_eq!(rb.failure_stage.as_deref(), Some("startup"));
        assert!(rb.running_after);
        assert!(mgr.is_running());
        assert!(drv.state.lock().unwrap().proxy_enabled);
        assert!(fs::read_to_string(running_config_path(&dir))
            .unwrap()
            .contains("stable-v1"));

        // 3. 候选一直未就绪（超时），且回滚也失败 -> 转断开、解除 LayNet 代理、报告阶段错误
        {
            let mut g = drv.state.lock().unwrap();
            g.precheck_results.push_back(PrecheckOutcome::Passed);
            g.spawn_behaviors.push_back(SpawnBehavior::Success); // candidate hangs
            g.probe_behaviors.push_back(vec![false; 25]); // candidate never ready
            g.spawn_behaviors
                .push_back(SpawnBehavior::FailImmediate("rollback spawn err".to_string()));
        }
        let fail = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("broken-v3", false, true),
            None,
        ));
        assert_eq!(fail.status, "failed");
        assert_eq!(fail.failure_stage.as_deref(), Some("rollback"));
        assert!(fail.error.as_deref().unwrap().contains("就绪超时"));
        assert!(fail.rollback_error.as_deref().unwrap().contains("回滚失败"));
        assert!(!fail.running_after);
        assert!(!mgr.is_running());
        assert!(!drv.state.lock().unwrap().proxy_enabled);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item3_concurrent_reload_cancelled_by_disconnect_never_reopens_proxy() {
        let dir = temp_runtime_dir("item3-cancel");
        let mgr = Arc::new(CoreManager::with_timeouts(
            Duration::from_millis(400),
            Duration::from_millis(10),
        ));
        let drv = Arc::new(FakeDriver::new(false, ""));

        // 先启动第1轮
        let ok1 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("v1", true, false),
            None,
        ));
        assert_eq!(ok1.status, "applied");

        let (probe_started, resume_probe) = drv.pause_next_probe();

        let mgr_reload = mgr.clone();
        let drv_reload = drv.clone();
        let dir_reload = dir.clone();
        let reload_handle = std::thread::spawn(move || {
            tauri::async_runtime::block_on(mgr_reload.apply_config_with_driver(
                &dir_reload,
                drv_reload,
                sample_req("v2", true, true),
                None,
            ))
        });

        probe_started.recv_timeout(Duration::from_secs(5)).unwrap();
        tauri::async_runtime::block_on(resume_probe_after_intent(
            mgr.disconnect_with_driver(drv.clone(), false),
            resume_probe,
        ));

        let reload_res = reload_handle.join().unwrap();
        assert_eq!(reload_res.status, "cancelled");
        assert!(!mgr.is_running());
        assert!(!drv.state.lock().unwrap().proxy_enabled);
        assert!(!mgr.get_snapshot().connected);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item2_abnormal_exit_when_proxy_originally_disabled_keeps_proxy_off_and_preserves_pref() {
        let dir = temp_runtime_dir("item2-noproxy");
        let mgr = CoreManager::with_timeouts(Duration::from_millis(200), Duration::from_millis(10));
        let drv = Arc::new(FakeDriver::new(false, ""));

        // 用户偏好系统代理关闭 (sys_proxy = false)
        let res = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("tun-only", false, false),
            None,
        ));
        assert_eq!(res.status, "applied");
        assert!(!drv.state.lock().unwrap().proxy_enabled);

        drv.trigger_exit_for_index(0, "unexpected signal");
        assert!(!mgr.is_running());
        let g = drv.state.lock().unwrap();
        assert!(!g.proxy_enabled);
        let last_ui = g.ui_syncs.last().unwrap();
        assert!(!last_ui.connected);
        assert!(!last_ui.sys_proxy);
        drop(g);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item3_consecutive_reloads_supersede_first_and_apply_second() {
        let dir = temp_runtime_dir("item3-two-reloads");
        let mgr = Arc::new(CoreManager::with_timeouts(
            Duration::from_millis(400),
            Duration::from_millis(10),
        ));
        let drv = Arc::new(FakeDriver::new(false, ""));

        let ok0 = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("base", true, false),
            None,
        ));
        assert_eq!(ok0.status, "applied");

        let (probe_started, resume_probe) = drv.pause_next_probe();

        let m1 = mgr.clone();
        let d1 = drv.clone();
        let dir1 = dir.clone();
        let t1 = std::thread::spawn(move || {
            tauri::async_runtime::block_on(m1.apply_config_with_driver(
                &dir1,
                d1,
                sample_req("edit-1", false, true),
                None,
            ))
        });

        probe_started.recv_timeout(Duration::from_secs(5)).unwrap();
        let r2 = tauri::async_runtime::block_on(resume_probe_after_intent(
            mgr.apply_config_with_driver(&dir, drv.clone(), sample_req("edit-2", true, true), None),
            resume_probe,
        ));
        let r1 = t1.join().unwrap();

        assert_eq!(r1.status, "superseded");
        assert_eq!(r2.status, "applied");
        assert!(mgr.is_running());
        assert!(drv.state.lock().unwrap().proxy_enabled);
        assert!(fs::read_to_string(running_config_path(&dir))
            .unwrap()
            .contains("edit-2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item3_initial_connect_failure_leaves_no_core_and_reports_stage() {
        let dir = temp_runtime_dir("item3-first-fail");
        let mgr = CoreManager::with_timeouts(Duration::from_millis(80), Duration::from_millis(10));
        let drv = Arc::new(FakeDriver::new(false, ""));

        {
            let mut g = drv.state.lock().unwrap();
            g.precheck_results.push_back(PrecheckOutcome::Passed);
            g.spawn_behaviors
                .push_back(SpawnBehavior::FailImmediate("missing binary".to_string()));
        }

        let res = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            drv.clone(),
            sample_req("first", true, false),
            None,
        ));
        assert_eq!(res.status, "failed");
        assert_eq!(res.failure_stage.as_deref(), Some("startup"));
        assert!(!res.running_after);
        assert!(!mgr.is_running());
        assert!(!drv.state.lock().unwrap().proxy_enabled);
        // 首次连接失败也应保留用户下次想用系统代理的偏好
        assert!(mgr.get_snapshot().sys_proxy);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_config_requires_current_policy() {
        let dir = std::env::temp_dir().join(format!(
            "laynet-policy-{}-{}",
            std::process::id(),
            SAVED_CONFIG_POLICY
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(running_config_path(&dir), "{\"legacy\":true}").unwrap();
        fs::write(config_policy_path(&dir), "cert-pin-v1").unwrap();
        assert!(saved_config_if_current(&dir).is_none());
        assert!(!saved_config_matches(&dir, "{\"legacy\":true}"));
        write_config_policy(&dir).unwrap();
        assert_eq!(
            saved_config_if_current(&dir).as_deref(),
            Some("{\"legacy\":true}")
        );
        assert!(saved_config_matches(&dir, "{\"legacy\":true}"));
        assert!(!saved_config_matches(&dir, "{\"fresh\":true}"));
        let _ = fs::remove_file(running_config_path(&dir));
        assert!(saved_config_if_current(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn core_exit_after_readiness_during_apply_or_rollback_does_not_enable_proxy() {
        let dir = temp_runtime_dir("exit-before-commit");
        let mgr = CoreManager::default();
        let driver = Arc::new(FakeDriver::new(false, ""));
        let apply = |label, allow_rollback| {
            tauri::async_runtime::block_on(mgr.apply_config_with_driver(
                &dir,
                driver.clone(),
                sample_req(label, true, allow_rollback),
                None,
            ))
        };
        driver.state.lock().unwrap().spawn_behaviors.push_back(SpawnBehavior::ExitBeforeCommit);
        let first = apply("first", false);
        assert_eq!(first.status, "failed");
        assert!(!mgr.is_running());
        assert!(driver.state.lock().unwrap().proxy_apply_log.is_empty());
        assert!(saved_config_if_current(&dir).is_none());

        assert_eq!(apply("previous", false).status, "applied");
        {
            let mut state = driver.state.lock().unwrap();
            state.proxy_apply_log.clear();
            state.spawn_behaviors.extend([
                SpawnBehavior::FailImmediate("candidate failed".to_string()),
                SpawnBehavior::ExitBeforeCommit,
            ]);
        }
        let result = apply("candidate", true);
        assert_eq!(result.status, "failed");
        assert_eq!(result.failure_stage.as_deref(), Some("rollback"));
        assert!(!mgr.is_running());
        let state = driver.state.lock().unwrap();
        assert!(!state.proxy_enabled);
        assert!(state.proxy_apply_log.is_empty());
        drop(state);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn proxy_apply_failure_reports_error_and_does_not_commit_startup() {
        let dir = temp_runtime_dir("proxy-apply-error");
        let mgr = CoreManager::default();
        let driver = Arc::new(FakeDriver::new(false, ""));
        driver.state.lock().unwrap().proxy_apply_error = Some("WinINet rejected change".to_string());
        let result = tauri::async_runtime::block_on(mgr.apply_config_with_driver(
            &dir,
            driver.clone(),
            sample_req("candidate", true, false),
            None,
        ));
        assert_eq!(result.status, "failed");
        assert_eq!(result.failure_stage.as_deref(), Some("proxy"));
        assert!(result.error.unwrap().contains("WinINet rejected change"));
        assert!(!mgr.is_running());
        assert!(!driver.state.lock().unwrap().proxy_enabled);
        assert!(saved_config_if_current(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
