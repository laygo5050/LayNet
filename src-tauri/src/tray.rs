use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    core_manager::{CoreApplyRequest, CoreManager, StopReason},
    proxy::force_disable_system_proxy,
};

pub const TRAY_ID: &str = "laynet-main-tray";

/// 全局退出标记：仅当用户主动点击「彻底退出」或 UAC 提权重启时置 true，防止销毁 WebView2 窗口时误退应用
pub static APP_QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySyncPayload {
    pub connected: bool,
    pub sys_proxy: bool,
    pub tun_mode: bool,
    pub routing_mode: String,
    pub active_node: Option<String>,
    #[serde(default)]
    pub terminal_shell: Option<String>,
}

impl Default for TraySyncPayload {
    fn default() -> Self {
        Self {
            connected: false,
            sys_proxy: true,
            tun_mode: false,
            routing_mode: "rule".to_string(),
            active_node: None,
            terminal_shell: None,
        }
    }
}

#[derive(Clone, Copy)]
enum TrayBadgeKind {
    Disconnected,
    SysProxy,
    TunMode,
}

/// 动态渲染 32x32 抗锯齿三态托盘图标（未连接灰 / 系统代理翠蓝 / TUN 模式电光紫青）
fn build_tray_icon(kind: TrayBadgeKind) -> Image<'static> {
    let size: usize = 32;
    let mut rgba = vec![0u8; size * size * 4];

    let (bg_r, bg_g, bg_b, dot_r, dot_g, dot_b) = match kind {
        TrayBadgeKind::Disconnected => (100u8, 116u8, 139u8, 203u8, 213u8, 225u8),
        TrayBadgeKind::SysProxy => (37u8, 99u8, 235u8, 52u8, 211u8, 153u8),
        TrayBadgeKind::TunMode => (124u8, 58u8, 237u8, 34u8, 211u8, 238u8),
    };

    let center = 15.5f32;
    let outer_r = 13.5f32;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = (y * size + x) * 4;

            if dist <= outer_r + 0.8 {
                let alpha = ((outer_r + 0.8 - dist).clamp(0.0, 1.0) * 255.0) as u8;
                let in_l_vert = (10..=13).contains(&x) && (9..=22).contains(&y);
                let in_l_horiz = (10..=21).contains(&x) && (19..=22).contains(&y);

                let dot_dx = x as f32 - 21.5;
                let dot_dy = y as f32 - 10.5;
                let dot_dist = (dot_dx * dot_dx + dot_dy * dot_dy).sqrt();

                if dot_dist <= 3.6 {
                    rgba[idx] = dot_r;
                    rgba[idx + 1] = dot_g;
                    rgba[idx + 2] = dot_b;
                    rgba[idx + 3] = alpha;
                } else if in_l_vert || in_l_horiz {
                    rgba[idx] = 255;
                    rgba[idx + 1] = 255;
                    rgba[idx + 2] = 255;
                    rgba[idx + 3] = alpha;
                } else {
                    rgba[idx] = bg_r;
                    rgba[idx + 1] = bg_g;
                    rgba[idx + 2] = bg_b;
                    rgba[idx + 3] = alpha;
                }
            }
        }
    }

    Image::new_owned(rgba, size as u32, size as u32)
}

pub fn terminal_proxy_command_for(shell: Option<&str>) -> &'static str {
    if matches!(shell, Some(s) if s.eq_ignore_ascii_case("cmd")) {
        "set HTTP_PROXY=http://127.0.0.1:7890&& set HTTPS_PROXY=http://127.0.0.1:7890&& set ALL_PROXY=socks5://127.0.0.1:7890"
    } else {
        "$env:HTTP_PROXY=\"http://127.0.0.1:7890\"; $env:HTTPS_PROXY=\"http://127.0.0.1:7890\"; $env:ALL_PROXY=\"socks5://127.0.0.1:7890\""
    }
}

/// 零依赖极速本地 PATCH Clash API `/configs`（用于 WebView2 销毁状态下直接热切换规则/全局/直连模式）
fn patch_clash_mode_headless(mode: &str) -> bool {
    let addr: SocketAddr = "127.0.0.1:9090".parse().unwrap();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let body = format!("{{\"mode\":\"{}\"}}", mode);
    let req = format!(
        "PATCH /configs HTTP/1.1\r\nHost: 127.0.0.1:9090\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let resp = String::from_utf8_lossy(&buf[..n]);
            resp.starts_with("HTTP/1.1 20") || resp.starts_with("HTTP/1.0 20")
        }
        _ => false,
    }
}

fn build_tray_menu(
    app: &AppHandle,
    state: &TraySyncPayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, "show", "显示 LayNet 主界面", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    let conn_label = match (&state.connected, &state.active_node) {
        (true, Some(node)) if !node.is_empty() => format!("代理已连接 ({})", node),
        (true, _) => "代理已连接".to_string(),
        (false, _) => "启动代理连接".to_string(),
    };
    let toggle_connect = CheckMenuItem::with_id(
        app,
        "toggle-connect",
        conn_label,
        true,
        state.connected,
        None::<&str>,
    )?;
    let toggle_sysproxy = CheckMenuItem::with_id(
        app,
        "toggle-sysproxy",
        "系统代理 (127.0.0.1:7890)",
        true,
        state.connected && state.sys_proxy,
        None::<&str>,
    )?;
    let toggle_tun = CheckMenuItem::with_id(
        app,
        "toggle-tun",
        "TUN 虚拟网卡 (LayTun)",
        true,
        state.connected && state.tun_mode,
        None::<&str>,
    )?;

    let sep2 = PredefinedMenuItem::separator(app)?;
    let mode_rule = CheckMenuItem::with_id(
        app,
        "mode-rule",
        "分流: 规则模式 (Rule)",
        true,
        state.routing_mode == "rule",
        None::<&str>,
    )?;
    let mode_global = CheckMenuItem::with_id(
        app,
        "mode-global",
        "分流: 全局代理 (Global)",
        true,
        state.routing_mode == "global",
        None::<&str>,
    )?;
    let mode_direct = CheckMenuItem::with_id(
        app,
        "mode-direct",
        "分流: 全局直连 (Direct)",
        true,
        state.routing_mode == "direct",
        None::<&str>,
    )?;

    let sep3 = PredefinedMenuItem::separator(app)?;
    let copy_cmd = MenuItem::with_id(
        app,
        "copy-terminal-proxy",
        "复制终端代理命令",
        true,
        None::<&str>,
    )?;

    let sep4 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "彻底退出 LayNet", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show_item,
            &sep1,
            &toggle_connect,
            &toggle_sysproxy,
            &toggle_tun,
            &sep2,
            &mode_rule,
            &mode_global,
            &mode_direct,
            &sep3,
            &copy_cmd,
            &sep4,
            &quit_item,
        ],
    )
}

/// 唤醒或按需瞬时重建主窗口（配合销毁 WebView2 实现后台 ~35 MB 超轻驻留）
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    if let Some(win_cfg) = app.config().app.windows.first() {
        if let Ok(builder) = WebviewWindowBuilder::from_config(app, win_cfg) {
            if let Ok(win) = builder.build() {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

/// 处理托盘右键菜单动作（窗口存在时通知前端；WebView2 已销毁时直接在 Rust 层零唤醒原地执行）
fn handle_tray_action(app: &AppHandle, action: &str) {
    if app.get_webview_window("main").is_some() {
        let _ = app.emit("tray-action", action.to_string());
        return;
    }

    // 以下分支运行在「无 WebView2 极省内存后台态」
    match action {
        "toggle-connect" => {
            let core = app.state::<CoreManager>().inner().clone();
            if core.is_running() || core.is_busy() {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    core.disconnect(&app_clone, false).await;
                });
            } else if let Some(saved_cfg) = CoreManager::read_saved_config(app) {
                // 未经过前端证书指纹筛选的旧配置会在 read_saved_config 中被拒绝，并落到下方唤起窗口。
                let snap = core.get_snapshot();
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let req = CoreApplyRequest {
                        config_json: saved_cfg,
                        sys_proxy: snap.sys_proxy,
                        tun_mode: snap.tun_mode,
                        routing_mode: snap.routing_mode,
                        active_node: snap.active_node,
                        allow_rollback: false,
                    };
                    match core.apply_config(&app_clone, req).await {
                        Ok(res) if res.status == "applied" => {}
                        Ok(res) if res.status == "cancelled" || res.status == "superseded" => {}
                        Ok(res) => {
                            if let Some(err) = res.error {
                                core.set_pending_exit_error(err);
                            }
                            show_main_window(&app_clone);
                        }
                        Err(err) => {
                            core.set_pending_exit_error(err);
                            show_main_window(&app_clone);
                        }
                    }
                });
            } else {
                core.request_frontend_reconnect();
                show_main_window(app);
            }
        }
        "toggle-sysproxy" => {
            let core = app.state::<CoreManager>();
            let snap = core.get_snapshot();
            // 未连接或处于 TUN 模式时需重合成配置或明确状态，唤起主面板统一处理，杜绝双栈冲突或盲切
            if !core.is_running() || snap.tun_mode {
                show_main_window(app);
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let core = app.state::<CoreManager>();
                if let Err(err) = core.update_headless_sys_proxy(&app) {
                    core.set_pending_exit_error(err);
                    let window_app = app.clone();
                    let _ = app.run_on_main_thread(move || show_main_window(&window_app));
                }
            });
        }
        "mode-rule" | "mode-global" | "mode-direct" => {
            let mode = action.strip_prefix("mode-").unwrap_or("rule").to_string();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let core = app.state::<CoreManager>();
                if !core.is_running() || patch_clash_mode_headless(&mode) {
                    core.update_headless_routing_mode(&app, &mode);
                }
            });
        }
        "toggle-tun" => {
            // TUN 开关可能涉及管理员提权引导与配置重合成，唤起主面板处理
            show_main_window(app);
        }
        _ => {}
    }
}

pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let initial = TraySyncPayload::default();
    let menu = build_tray_menu(app, &initial)?;
    let icon = build_tray_icon(TrayBadgeKind::Disconnected);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("LayNet - 未连接")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => {
                    show_main_window(app);
                }
                "copy-terminal-proxy" => {
                    let shell = app
                        .try_state::<CoreManager>()
                        .and_then(|c| c.get_snapshot().terminal_shell);
                    let _ = app
                        .clipboard()
                        .write_text(terminal_proxy_command_for(shell.as_deref()));
                    if app.get_webview_window("main").is_some() {
                        let _ = app.emit("tray-action", "copied-terminal-proxy");
                    }
                }
                "quit" => {
                    APP_QUITTING.store(true, Ordering::SeqCst);
                    if let Some(core) = app.try_state::<CoreManager>() {
                        core.stop_owned_processes(StopReason::Shutdown, Some(app));
                    }
                    force_disable_system_proxy();
                    app.exit(0);
                }
                other => {
                    handle_tray_action(app, other);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn sync_tray_visuals(app: &AppHandle, payload: &TraySyncPayload) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    let (badge, status_text) = if payload.connected && payload.tun_mode {
        (TrayBadgeKind::TunMode, "LayNet · TUN 全局接管中")
    } else if payload.connected && payload.sys_proxy {
        (TrayBadgeKind::SysProxy, "LayNet · 系统代理开启")
    } else if payload.connected {
        (TrayBadgeKind::SysProxy, "LayNet · 内核已连接 (仅本地端口)")
    } else {
        (TrayBadgeKind::Disconnected, "LayNet · 未连接")
    };

    let _ = tray.set_icon(Some(build_tray_icon(badge)));
    let _ = tray.set_tooltip(Some(status_text));
    if let Ok(menu) = build_tray_menu(app, payload) {
        let _ = tray.set_menu(Some(menu));
    }

    Ok(())
}

pub fn sync_tray(app: &AppHandle, payload: &TraySyncPayload) -> Result<(), String> {
    if let Some(core) = app.try_state::<CoreManager>() {
        core.sync_from_frontend(app, payload.clone());
        return Ok(());
    }
    sync_tray_visuals(app, payload)
}
