mod core_manager;
mod privilege;
mod proxy;
mod tray;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::{
    core_manager::{CoreApplyRequest, CoreApplyResult, CoreManager, StopReason},
    privilege::{is_admin, request_uac_relaunch, wait_for_parent_exit},
    proxy::{
        force_disable_system_proxy, get_system_proxy_enabled, get_system_proxy_state,
        set_system_proxy, SystemProxyState,
    },
    tray::{init_tray, show_main_window, sync_tray, TraySyncPayload, APP_QUITTING},
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct LaunchFlags {
    pub silent: AtomicBool,
    pub relaunch_tun: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    pub silent: bool,
    pub relaunch_tun: bool,
    pub is_admin: bool,
    pub sys_proxy_enabled: bool,
    pub preferred_sys_proxy: bool,
    pub core_running: bool,
    pub routing_mode: String,
    pub tun_mode: bool,
    pub is_cold_start: bool,
    pub reconnect_requested: bool,
    pub pending_exit_error: Option<String>,
}

/// 统一防断网清理守卫（仅释放 LayNet 接管的系统代理 + 终止本实例持有的 laynet-core 进程）
fn emergency_cleanup(core: Option<&CoreManager>, app: Option<&AppHandle>) {
    if let Some(mgr) = core {
        mgr.stop_owned_processes(StopReason::Shutdown, app);
    }
    force_disable_system_proxy();
}

/// 安装全局 Rust PanicHook 防断网守卫（仅在取得单实例主进程资格后注册）
fn install_panic_guard(core: CoreManager) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        core.panic_cleanup();
        default_hook(info);
    }));
}

#[tauri::command]
fn get_launch_context(
    flags: tauri::State<'_, LaunchFlags>,
    core: tauri::State<'_, CoreManager>,
) -> LaunchContext {
    let silent = flags.silent.swap(false, Ordering::SeqCst);
    let relaunch_tun = flags.relaunch_tun.swap(false, Ordering::SeqCst);
    let snap = core.consume_launch_context();

    LaunchContext {
        silent,
        relaunch_tun,
        is_admin: is_admin(),
        sys_proxy_enabled: get_system_proxy_enabled(),
        preferred_sys_proxy: snap.preferred_sys_proxy,
        core_running: snap.core_running,
        routing_mode: snap.routing_mode,
        tun_mode: snap.tun_mode,
        is_cold_start: snap.is_cold_start,
        reconnect_requested: core.take_frontend_reconnect(),
        pending_exit_error: snap.pending_exit_error,
    }
}

#[tauri::command]
async fn apply_core_config(
    app: AppHandle,
    core: tauri::State<'_, CoreManager>,
    request: CoreApplyRequest,
) -> Result<CoreApplyResult, String> {
    core.apply_config(&app, request).await
}

#[tauri::command]
async fn disconnect_laynet_core(
    app: AppHandle,
    core: tauri::State<'_, CoreManager>,
) -> Result<(), String> {
    core.disconnect(&app, false).await;
    Ok(())
}

#[tauri::command]
async fn set_sys_proxy(enable: bool, port: Option<u16>) -> Result<(), String> {
    let target_port = port.unwrap_or(7890);
    tauri::async_runtime::spawn_blocking(move || {
        set_system_proxy(enable, "127.0.0.1", target_port)
    })
    .await
    .map_err(|e| format!("切换系统代理任务异常: {}", e))?
}

#[tauri::command]
fn get_sys_proxy_state() -> SystemProxyState {
    get_system_proxy_state()
}

#[tauri::command]
fn check_admin_privilege() -> bool {
    is_admin()
}

#[tauri::command]
fn elevate_for_tun(app: AppHandle, core: tauri::State<'_, CoreManager>) -> Result<(), String> {
    let my_pid = std::process::id();
    let launch_args = vec![
        "--relaunch-tun".to_string(),
        format!("--wait-pid={}", my_pid),
    ];
    request_uac_relaunch(&launch_args)?;
    APP_QUITTING.store(true, Ordering::SeqCst);
    emergency_cleanup(Some(&core), Some(&app));
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn sync_tray_state(app: AppHandle, payload: TraySyncPayload) -> Result<(), String> {
    sync_tray(&app, &payload)
}

/// 前端筛完 Hysteria2 整证指纹后，才允许托盘重连复用缓存。
/// `discard_saved` 为真时删除旧文件，避免升级后的静默恢复或无窗口重连绕过检查。
#[tauri::command]
async fn settle_cached_core_config(
    app: AppHandle,
    core: tauri::State<'_, CoreManager>,
    discard_saved: bool,
    expected_config: Option<String>,
) -> Result<(), String> {
    core.settle_cached_config(&app, discard_saved, expected_config.as_deref());
    Ok(())
}

/// 静默启动恢复连接完成后主动销毁 WebView2 窗口，释放全部前端渲染内存
#[tauri::command]
fn release_window_to_tray(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.destroy();
    }
}

/// 纯文本 HTTP 读取通道（仅用于绕过 WebView CORS 拉取远程订阅原始文本，绝不解析节点内容）
/// 内核连接中优先走本地代理端口拉取被墙订阅，若当前节点全失效则自动回退直连救活订阅；禁用 glob 通配符支持 IPv6/花括号 URL
#[tauri::command]
async fn fetch_raw_text(
    core: tauri::State<'_, CoreManager>,
    url: String,
) -> Result<String, String> {
    let trimmed = url.trim().to_string();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("仅支持 http:// 或 https:// 订阅地址".to_string());
    }
    let use_local_proxy = core.is_running();

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let run_curl = |via_proxy: bool| -> Result<String, String> {
                let mut cmd = std::process::Command::new("curl.exe");
                cmd.args([
                    "-sSLg",
                    "--fail",
                    "--compressed",
                    "--connect-timeout",
                    "6",
                    "--max-time",
                    "14",
                    "-A",
                    "LayNet/0.1 (sing-box; clash.meta)",
                ]);
                if via_proxy {
                    cmd.args(["-x", "http://127.0.0.1:7890"]);
                } else {
                    cmd.args(["--noproxy", "*"]);
                }
                cmd.args(["--", &trimmed]);
                cmd.creation_flags(CREATE_NO_WINDOW);

                let out = cmd
                    .output()
                    .map_err(|e| format!("调用系统网络请求失败: {}", e))?;
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    return Err(if err.is_empty() {
                        format!("HTTP 请求返回错误码 {:?}", out.status.code())
                    } else {
                        err
                    });
                }
                Ok(String::from_utf8_lossy(&out.stdout).to_string())
            };

            if use_local_proxy {
                match run_curl(true) {
                    Ok(body) => Ok(body),
                    Err(_proxy_err) => run_curl(false)
                        .map_err(|direct_err| format!("订阅拉取失败: {}", direct_err)),
                }
            } else {
                run_curl(false).map_err(|e| format!("订阅拉取失败: {}", e))
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (trimmed, use_local_proxy);
            Err("当前平台未启用原生拉取通道".to_string())
        }
    })
    .await
    .map_err(|e| format!("异步任务执行异常: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let is_silent = args.iter().any(|a| a == "--silent");
    let is_relaunch_tun = args.iter().any(|a| a == "--relaunch-tun");
    let wait_pid: Option<u32> = args
        .iter()
        .find_map(|a| a.strip_prefix("--wait-pid="))
        .and_then(|v| v.parse::<u32>().ok());

    // 若为 UAC 提权重启，精确等待旧非管理员进程完全退出并释放 single-instance 锁
    if let Some(pid) = wait_pid {
        wait_for_parent_exit(pid, 8000);
    } else if is_relaunch_tun {
        std::thread::sleep(Duration::from_millis(1200));
    }

    // 注意：冷启动代理与孤儿清理、PanicHook 注册严禁放在单实例锁之前！
    // 否则二次唤起时会误杀首实例内核并断开系统代理。
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CoreManager::default())
        .manage(LaunchFlags {
            silent: AtomicBool::new(is_silent),
            relaunch_tun: AtomicBool::new(is_relaunch_tun),
        })
        .setup(move |app| {
            let handle = app.handle();
            // 已成为唯一主实例且尚未恢复任何连接：此时注册 PanicHook 并执行冷启动残留清理
            install_panic_guard(handle.state::<CoreManager>().inner().clone());
            CoreManager::cold_start_cleanup(handle);
            init_tray(handle)?;

            if is_silent {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点击窗口右上角 × 时直接销毁 WebView2 渲染窗口以彻底释放 ~200MB 内存，
            // 同时通过 ExitRequested 的 prevent_exit 保持 Rust 托盘与 laynet-core 全速驻留后台
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.destroy();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_context,
            apply_core_config,
            disconnect_laynet_core,
            set_sys_proxy,
            get_sys_proxy_state,
            check_admin_privilege,
            elevate_for_tun,
            sync_tray_state,
            settle_cached_core_config,
            release_window_to_tray,
            fetch_raw_text,
        ])
        .build(tauri::generate_context!())
        .expect("构建 LayNet 应用实例失败");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // 非主动退出（即最后一个 WebView2 窗口被销毁缩入托盘）时阻止进程退出
            if code.is_none() && !APP_QUITTING.load(Ordering::SeqCst) {
                api.prevent_exit();
                return;
            }
            let core = app_handle.try_state::<CoreManager>();
            emergency_cleanup(core.as_deref(), Some(app_handle));
        }
        RunEvent::Exit => {
            let core = app_handle.try_state::<CoreManager>();
            emergency_cleanup(core.as_deref(), Some(app_handle));
        }
        _ => {}
    });
}
