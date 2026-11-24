use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

#[cfg(windows)]
use std::ptr::{null, null_mut};

#[cfg(windows)]
use windows_sys::Win32::{
    Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_PER_CONNECTION_OPTION, INTERNET_OPTION_REFRESH,
        INTERNET_OPTION_SETTINGS_CHANGED, INTERNET_PER_CONN_FLAGS, INTERNET_PER_CONN_OPTIONW,
        INTERNET_PER_CONN_OPTIONW_0, INTERNET_PER_CONN_OPTION_LISTW,
        INTERNET_PER_CONN_PROXY_BYPASS, INTERNET_PER_CONN_PROXY_SERVER, PROXY_TYPE_DIRECT,
        PROXY_TYPE_PROXY,
    },
    System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ,
    },
    UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    },
};

/// 局域网与本地地址完整排除列表（覆盖 localhost、127.0.0.0/8、[::1]、10.0.0.0/8、100.64.0.0/10 CGNAT/Tailscale、169.254.0.0/16、172.16.0.0/12、192.168.0.0/16、常见局域网后缀及 <local>）
pub const PROXY_OVERRIDE: &str = concat!(
    "localhost;127.*;[::1];10.*;",
    "100.64.*;100.65.*;100.66.*;100.67.*;100.68.*;100.69.*;100.70.*;100.71.*;",
    "100.72.*;100.73.*;100.74.*;100.75.*;100.76.*;100.77.*;100.78.*;100.79.*;",
    "100.80.*;100.81.*;100.82.*;100.83.*;100.84.*;100.85.*;100.86.*;100.87.*;",
    "100.88.*;100.89.*;100.90.*;100.91.*;100.92.*;100.93.*;100.94.*;100.95.*;",
    "100.96.*;100.97.*;100.98.*;100.99.*;100.100.*;100.101.*;100.102.*;100.103.*;",
    "100.104.*;100.105.*;100.106.*;100.107.*;100.108.*;100.109.*;100.110.*;100.111.*;",
    "100.112.*;100.113.*;100.114.*;100.115.*;100.116.*;100.117.*;100.118.*;100.119.*;",
    "100.120.*;100.121.*;100.122.*;100.123.*;100.124.*;100.125.*;100.126.*;100.127.*;",
    "169.254.*;",
    "172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;",
    "172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;",
    "192.168.*;*.local;*.lan;*.home.arpa;*.internal;*.intranet;<local>"
);

/// 供 Antigravity 与终端工具读取的本地直连排除列表，防止本地 Hub、OAuth 回调与局域网服务走代理
const USER_NO_PROXY: &str = "localhost,127.0.0.1,::1,10.0.0.0/8,100.64.0.0/10,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,.local,.lan,.home.arpa";
const LEGACY_USER_NO_PROXY: &str = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const BACKUP_USER_NO_PROXY_KEY: &str = "LAYNET_PREV_NO_PROXY";

/// Grok Bot (Sand) 原生系统代理开关：设为 "1" 让其 Node 主/子进程跳过直连探测，动态跟随 Windows WinINet 系统代理
const GROK_BOT_PROXY_ENV_KEY: &str = "SAND_SYSTEM_PROXY";
const GROK_BOT_PROXY_ENV_VALUE: &str = "1";
const GROK_BOT_APPDATA_DIR: &str = "Grok Bot";
const GROK_BOT_PROXY_CONFIG_FILE: &str = "system-proxy.json";
const GROK_BOT_PROXY_CONFIG_CONTENT: &str = "{\"mode\":\"proxy\"}\n";

#[cfg(windows)]
const INTERNET_SETTINGS_PATH: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

#[cfg(windows)]
const USER_ENV_PATH: &str = "Environment";

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn notify_environment_change() {
    // 异步广播 WM_SETTINGCHANGE，彻底避免后台存在假死顶层窗口时阻塞主线程数秒
    let _ = std::thread::spawn(|| unsafe {
        let env_wide = to_wide("Environment");
        let mut result: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            env_wide.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            150,
            &mut result,
        );
    });
}

#[cfg(windows)]
unsafe fn read_reg_sz(hkey: HKEY, name: &str) -> Option<String> {
    let wname = to_wide(name);
    let mut reg_type: u32 = 0;
    let mut size: u32 = 0;
    if unsafe {
        RegQueryValueExW(
            hkey,
            wname.as_ptr(),
            null_mut(),
            &mut reg_type,
            null_mut(),
            &mut size,
        )
    } != 0
        || size == 0
    {
        return None;
    }
    let mut buf = vec![0u16; (size as usize / 2) + 1];
    if unsafe {
        RegQueryValueExW(
            hkey,
            wname.as_ptr(),
            null_mut(),
            &mut reg_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        )
    } != 0
    {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(windows)]
unsafe fn write_reg_sz(hkey: HKEY, name: &str, value: &str) {
    let wname = to_wide(name);
    let wval = to_wide(value);
    unsafe {
        RegSetValueExW(
            hkey,
            wname.as_ptr(),
            0,
            REG_SZ,
            wval.as_ptr() as *const u8,
            (wval.len() * 2) as u32,
        );
    }
}

/// 判断注册表中的 ProxyServer 是否仍属于 LayNet (`127.0.0.1:{port}` / `localhost:{port}`)
pub fn is_laynet_proxy_server(server: &str, expected_port: u16) -> bool {
    let trimmed = server.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return false;
    }

    let targets = [
        format!("127.0.0.1:{}", expected_port),
        format!("http://127.0.0.1:{}", expected_port),
        format!("localhost:{}", expected_port),
        format!("http://localhost:{}", expected_port),
    ];

    if targets.iter().any(|t| trimmed == *t) {
        return true;
    }

    if trimmed.contains('=') {
        let parts: Vec<&str> = trimmed
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !parts.is_empty()
            && parts.iter().all(|part| {
                part.split_once('=')
                    .map(|(_, addr)| targets.iter().any(|t| addr.trim() == t))
                    .unwrap_or(false)
            })
        {
            return true;
        }
    }

    false
}

pub fn is_laynet_env_value(value: &str, host: &str, port: u16) -> bool {
    let expected = format!("http://{}:{}", host, port).to_ascii_lowercase();
    value.trim().to_ascii_lowercase() == expected
}

/// 仅当 WinINet 系统代理当前处于开启状态且仍指向 LayNet 端口时才需要关闭 WinINet，避免误伤外部代理或原有直连/PAC设置
pub fn should_release_wininet_proxy(state: &SystemProxyState, expected_port: u16) -> bool {
    state.enabled && is_laynet_proxy_server(&state.server, expected_port)
}

pub struct MergedNoProxy {
    pub effective: String,
    pub backup_to_save: Option<String>,
}

/// 合并用户原有的自定义 NO_PROXY 条目并记录备份，防止开启系统代理时抹掉企业内网排除项
pub fn compute_merged_no_proxy(
    current: Option<&str>,
    existing_backup: Option<&str>,
) -> MergedNoProxy {
    let user_orig = existing_backup
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            current
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != USER_NO_PROXY && *s != LEGACY_USER_NO_PROXY)
        });

    let Some(orig) = user_orig else {
        return MergedNoProxy {
            effective: USER_NO_PROXY.to_string(),
            backup_to_save: None,
        };
    };

    let mut items: Vec<&str> = USER_NO_PROXY.split(',').collect();
    for part in orig.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !items.iter().any(|existing| existing.eq_ignore_ascii_case(part)) {
            items.push(part);
        }
    }

    MergedNoProxy {
        effective: items.join(","),
        backup_to_save: if existing_backup.is_some() {
            None
        } else {
            Some(orig.to_string())
        },
    }
}

/// 仅当用户尚未显式配置 `SAND_SYSTEM_PROXY`（缺失或空白）时写入 `"1"`，尊重用户手动设置的 `"0"` / `"direct"` / `"auto"`
pub fn should_write_sand_system_proxy(current: Option<&str>) -> bool {
    current.map(|v| v.trim().is_empty()).unwrap_or(true)
}

/// 仅当 LayNet 本次实际释放了自己的 `HTTP_PROXY`/`HTTPS_PROXY` 且 `SAND_SYSTEM_PROXY` 仍为 `"1"` 时清理，避免误删外部配置
pub fn should_delete_sand_system_proxy(
    laynet_proxy_env_removed: bool,
    current: Option<&str>,
) -> bool {
    laynet_proxy_env_removed
        && current
            .map(|v| v.trim() == GROK_BOT_PROXY_ENV_VALUE)
            .unwrap_or(false)
}

/// 若已安装 Grok Bot（存在 `%APPDATA%\Grok Bot` 目录）且尚未创建 `system-proxy.json`，
/// 自动原子补写 `{"mode":"proxy"}`；已有配置文件时不覆盖，未安装时不创建空目录。
pub fn ensure_grok_bot_system_proxy_config_in(appdata_dir: &Path) -> std::io::Result<bool> {
    let grok_dir = appdata_dir.join(GROK_BOT_APPDATA_DIR);
    if !grok_dir.is_dir() {
        return Ok(false);
    }

    let config_path = grok_dir.join(GROK_BOT_PROXY_CONFIG_FILE);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&config_path)
    {
        Ok(mut file) => {
            file.write_all(GROK_BOT_PROXY_CONFIG_CONTENT.as_bytes())?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

#[cfg(windows)]
fn ensure_grok_bot_system_proxy_config() {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let _ = ensure_grok_bot_system_proxy_config_in(Path::new(&appdata));
    }
}

/// 同步或清理当前用户环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `SAND_SYSTEM_PROXY`
fn sync_user_proxy_env(enable: bool, host: &str, port: u16) {
    #[cfg(windows)]
    unsafe {
        let subkey = to_wide(USER_ENV_PATH);
        let mut hkey: HKEY = null_mut();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_READ | KEY_SET_VALUE,
            &mut hkey,
        ) != 0
        {
            return;
        }

        let laynet_url = format!("http://{}:{}", host, port);
        if enable {
            write_reg_sz(hkey, "HTTP_PROXY", &laynet_url);
            write_reg_sz(hkey, "HTTPS_PROXY", &laynet_url);

            let cur_no_proxy = read_reg_sz(hkey, "NO_PROXY");
            let existing_backup = read_reg_sz(hkey, BACKUP_USER_NO_PROXY_KEY);
            let next_no_proxy = compute_merged_no_proxy(
                cur_no_proxy.as_deref(),
                existing_backup.as_deref(),
            );
            if let Some(to_backup) = next_no_proxy.backup_to_save {
                write_reg_sz(hkey, BACKUP_USER_NO_PROXY_KEY, &to_backup);
            }
            write_reg_sz(hkey, "NO_PROXY", &next_no_proxy.effective);

            let cur_sand = read_reg_sz(hkey, GROK_BOT_PROXY_ENV_KEY);
            if should_write_sand_system_proxy(cur_sand.as_deref()) {
                write_reg_sz(hkey, GROK_BOT_PROXY_ENV_KEY, GROK_BOT_PROXY_ENV_VALUE);
            }
            RegCloseKey(hkey);
            notify_environment_change();
        } else {
            let cur_http = read_reg_sz(hkey, "HTTP_PROXY");
            let cur_https = read_reg_sz(hkey, "HTTPS_PROXY");
            let mut changed = false;

            if cur_http
                .as_deref()
                .map(|v| is_laynet_env_value(v, host, port))
                .unwrap_or(false)
            {
                let w = to_wide("HTTP_PROXY");
                RegDeleteValueW(hkey, w.as_ptr());
                changed = true;
            }
            if cur_https
                .as_deref()
                .map(|v| is_laynet_env_value(v, host, port))
                .unwrap_or(false)
            {
                let w = to_wide("HTTPS_PROXY");
                RegDeleteValueW(hkey, w.as_ptr());
                changed = true;
            }
            let cur_no_proxy = read_reg_sz(hkey, "NO_PROXY");
            let saved_backup = read_reg_sz(hkey, BACKUP_USER_NO_PROXY_KEY);
            if let Some(orig) = saved_backup.as_deref().filter(|s| !s.trim().is_empty()) {
                if changed {
                    write_reg_sz(hkey, "NO_PROXY", orig);
                    let wb = to_wide(BACKUP_USER_NO_PROXY_KEY);
                    RegDeleteValueW(hkey, wb.as_ptr());
                }
            } else if changed
                && matches!(
                    cur_no_proxy.as_deref(),
                    Some(USER_NO_PROXY) | Some(LEGACY_USER_NO_PROXY)
                )
            {
                let w = to_wide("NO_PROXY");
                RegDeleteValueW(hkey, w.as_ptr());
            }
            let cur_sand = read_reg_sz(hkey, GROK_BOT_PROXY_ENV_KEY);
            if should_delete_sand_system_proxy(changed, cur_sand.as_deref()) {
                let w = to_wide(GROK_BOT_PROXY_ENV_KEY);
                RegDeleteValueW(hkey, w.as_ptr());
            }
            RegCloseKey(hkey);
            if changed {
                notify_environment_change();
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (enable, host, port);
    }
}

#[cfg(windows)]
unsafe fn apply_wininet_direct() -> Result<(), String> {
    let mut options = vec![INTERNET_PER_CONN_OPTIONW {
        dwOption: INTERNET_PER_CONN_FLAGS,
        Value: INTERNET_PER_CONN_OPTIONW_0 {
            dwValue: PROXY_TYPE_DIRECT,
        },
    }];

    let mut list = INTERNET_PER_CONN_OPTION_LISTW {
        dwSize: std::mem::size_of::<INTERNET_PER_CONN_OPTION_LISTW>() as u32,
        pszConnection: null_mut(),
        dwOptionCount: options.len() as u32,
        dwOptionError: 0,
        pOptions: options.as_mut_ptr(),
    };

    let ok = unsafe {
        InternetSetOptionW(
            null(),
            INTERNET_OPTION_PER_CONNECTION_OPTION,
            &mut list as *mut INTERNET_PER_CONN_OPTION_LISTW as *const _,
            list.dwSize,
        )
    };
    if ok == 0 {
        return Err("调用 WinInet INTERNET_OPTION_PER_CONNECTION_OPTION 释放系统代理失败".to_string());
    }

    unsafe {
        InternetSetOptionW(null(), INTERNET_OPTION_SETTINGS_CHANGED, null(), 0);
        InternetSetOptionW(null(), INTERNET_OPTION_REFRESH, null(), 0);
    }
    Ok(())
}

/// 仅当 LayNet 仍接管系统代理或环境变量时安全释放，不覆盖用户后续切换的外部代理
pub fn release_laynet_system_proxy(port: u16) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let state = get_system_proxy_state();
        let released_wininet = if should_release_wininet_proxy(&state, port) {
            unsafe { apply_wininet_direct()? };
            true
        } else {
            false
        };
        sync_user_proxy_env(false, "127.0.0.1", port);
        Ok(released_wininet)
    }

    #[cfg(not(windows))]
    {
        let _ = port;
        Ok(false)
    }
}

/// 通过 WinInet 官方 `INTERNET_OPTION_PER_CONNECTION_OPTION` 原子更新系统代理与 `DefaultConnectionSettings`
/// 彻底避免被其他代理软件残留在 `DefaultConnectionSettings` 中的旧端口覆盖回滚
pub fn set_system_proxy(enable: bool, host: &str, port: u16) -> Result<(), String> {
    if !enable {
        let _ = release_laynet_system_proxy(port)?;
        return Ok(());
    }

    #[cfg(windows)]
    unsafe {
        let server_str = format!("{}:{}", host, port);
        let mut server_wide = to_wide(&server_str);
        let mut bypass_wide = to_wide(PROXY_OVERRIDE);

        let mut options = vec![
            INTERNET_PER_CONN_OPTIONW {
                dwOption: INTERNET_PER_CONN_FLAGS,
                Value: INTERNET_PER_CONN_OPTIONW_0 {
                    dwValue: PROXY_TYPE_DIRECT | PROXY_TYPE_PROXY,
                },
            },
            INTERNET_PER_CONN_OPTIONW {
                dwOption: INTERNET_PER_CONN_PROXY_SERVER,
                Value: INTERNET_PER_CONN_OPTIONW_0 {
                    pszValue: server_wide.as_mut_ptr(),
                },
            },
            INTERNET_PER_CONN_OPTIONW {
                dwOption: INTERNET_PER_CONN_PROXY_BYPASS,
                Value: INTERNET_PER_CONN_OPTIONW_0 {
                    pszValue: bypass_wide.as_mut_ptr(),
                },
            },
        ];

        let mut list = INTERNET_PER_CONN_OPTION_LISTW {
            dwSize: std::mem::size_of::<INTERNET_PER_CONN_OPTION_LISTW>() as u32,
            pszConnection: null_mut(),
            dwOptionCount: options.len() as u32,
            dwOptionError: 0,
            pOptions: options.as_mut_ptr(),
        };

        let ok = InternetSetOptionW(
            null(),
            INTERNET_OPTION_PER_CONNECTION_OPTION,
            &mut list as *mut INTERNET_PER_CONN_OPTION_LISTW as *const _,
            list.dwSize,
        );
        if ok == 0 {
            return Err("调用 WinInet INTERNET_OPTION_PER_CONNECTION_OPTION 设置系统代理失败".to_string());
        }

        InternetSetOptionW(null(), INTERNET_OPTION_SETTINGS_CHANGED, null(), 0);
        InternetSetOptionW(null(), INTERNET_OPTION_REFRESH, null(), 0);

        sync_user_proxy_env(true, host, port);
        ensure_grok_bot_system_proxy_config();
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (enable, host, port);
        Ok(())
    }
}

/// 防断网守卫：仅释放仍由 LayNet 接管的系统代理与环境变量（用于冷启动、异常退出、正常退出与 PanicHook）
pub fn force_disable_system_proxy() {
    let _ = release_laynet_system_proxy(7890);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyState {
    pub enabled: bool,
    pub server: String,
}

/// 查询当前注册表 ProxyEnable 与 ProxyServer 状态（用于检测系统代理是否被其他软件篡改）
pub fn get_system_proxy_state() -> SystemProxyState {
    #[cfg(windows)]
    unsafe {
        let subkey = to_wide(INTERNET_SETTINGS_PATH);
        let mut hkey: HKEY = null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return SystemProxyState {
                enabled: false,
                server: String::new(),
            };
        }
        let enable_name = to_wide("ProxyEnable");
        let mut val: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let mut reg_type: u32 = 0;
        let rc = RegQueryValueExW(
            hkey,
            enable_name.as_ptr(),
            null_mut(),
            &mut reg_type,
            &mut val as *mut u32 as *mut u8,
            &mut size,
        );
        let server = read_reg_sz(hkey, "ProxyServer").unwrap_or_default();
        RegCloseKey(hkey);
        SystemProxyState {
            enabled: rc == 0 && val == 1,
            server,
        }
    }

    #[cfg(not(windows))]
    {
        SystemProxyState {
            enabled: false,
            server: String::new(),
        }
    }
}

/// 查询当前注册表 ProxyEnable 状态
pub fn get_system_proxy_enabled() -> bool {
    get_system_proxy_state().enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laynet_proxy_server_matching_respects_ownership() {
        assert!(is_laynet_proxy_server("127.0.0.1:7890", 7890));
        assert!(is_laynet_proxy_server(" http://127.0.0.1:7890 ", 7890));
        assert!(is_laynet_proxy_server("localhost:7890", 7890));
        assert!(is_laynet_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:7890",
            7890
        ));

        assert!(!is_laynet_proxy_server("", 7890));
        assert!(!is_laynet_proxy_server("127.0.0.1:10809", 7890));
        assert!(!is_laynet_proxy_server("proxy.corp.local:8080", 7890));
        assert!(!is_laynet_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:10809",
            7890
        ));
    }

    #[test]
    fn release_wininet_decision_handles_disabled_and_external_proxies() {
        assert!(should_release_wininet_proxy(
            &SystemProxyState {
                enabled: true,
                server: "127.0.0.1:7890".to_string(),
            },
            7890
        ));

        // 原本已关闭时不覆盖（例如直连或 PAC 模式）
        assert!(!should_release_wininet_proxy(
            &SystemProxyState {
                enabled: false,
                server: "127.0.0.1:7890".to_string(),
            },
            7890
        ));

        // 用户已切换到其他代理时不覆盖
        assert!(!should_release_wininet_proxy(
            &SystemProxyState {
                enabled: true,
                server: "127.0.0.1:10809".to_string(),
            },
            7890
        ));
    }

    #[test]
    fn laynet_env_value_checks_exact_url() {
        assert!(is_laynet_env_value("http://127.0.0.1:7890", "127.0.0.1", 7890));
        assert!(is_laynet_env_value("HTTP://127.0.0.1:7890", "127.0.0.1", 7890));
        assert!(!is_laynet_env_value("http://127.0.0.1:10809", "127.0.0.1", 7890));
    }

    #[test]
    fn proxy_override_covers_cgnat_lan_and_stays_within_wininet_limit() {
        assert!(PROXY_OVERRIDE.contains("100.64.*;"));
        assert!(PROXY_OVERRIDE.contains("100.127.*;"));
        assert!(PROXY_OVERRIDE.contains("169.254.*;"));
        assert!(PROXY_OVERRIDE.contains("[::1];"));
        assert!(PROXY_OVERRIDE.contains("*.local;"));
        assert!(PROXY_OVERRIDE.contains("<local>"));
        assert!(PROXY_OVERRIDE.len() < 1500);
    }

    #[test]
    fn compute_merged_no_proxy_preserves_and_deduplicates_user_custom_entries() {
        let fresh = compute_merged_no_proxy(None, None);
        assert_eq!(fresh.effective, USER_NO_PROXY);
        assert_eq!(fresh.backup_to_save, None);

        let custom = compute_merged_no_proxy(Some("corp.example.com, 10.99.0.0/16, localhost"), None);
        assert!(custom.effective.contains("corp.example.com"));
        assert!(custom.effective.contains("10.99.0.0/16"));
        assert_eq!(
            custom.backup_to_save.as_deref(),
            Some("corp.example.com, 10.99.0.0/16, localhost")
        );

        // 已有备份时重复启用不覆盖原始备份
        let repeat = compute_merged_no_proxy(
            Some(&custom.effective),
            Some("corp.example.com, 10.99.0.0/16, localhost"),
        );
        assert!(repeat.effective.contains("corp.example.com"));
        assert_eq!(repeat.backup_to_save, None);
    }

    #[test]
    fn sand_system_proxy_env_decisions_respect_user_override_and_ownership() {
        assert!(should_write_sand_system_proxy(None));
        assert!(should_write_sand_system_proxy(Some("")));
        assert!(should_write_sand_system_proxy(Some("   ")));
        assert!(!should_write_sand_system_proxy(Some("1")));
        assert!(!should_write_sand_system_proxy(Some("0")));
        assert!(!should_write_sand_system_proxy(Some("direct")));

        assert!(should_delete_sand_system_proxy(true, Some("1")));
        assert!(should_delete_sand_system_proxy(true, Some(" 1 ")));
        assert!(!should_delete_sand_system_proxy(false, Some("1")));
        assert!(!should_delete_sand_system_proxy(true, Some("0")));
        assert!(!should_delete_sand_system_proxy(true, None));
    }

    #[test]
    fn grok_bot_system_proxy_config_is_created_only_when_installed_and_absent() {
        let unique = format!(
            "laynet-grok-bot-proxy-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let temp_appdata = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&temp_appdata).unwrap();

        // 1) 未安装 Grok Bot（目录不存在）：不创建空目录，返回 Ok(false)
        assert!(!ensure_grok_bot_system_proxy_config_in(&temp_appdata).unwrap());
        assert!(!temp_appdata.join(GROK_BOT_APPDATA_DIR).exists());

        // 2) 已安装 Grok Bot 且无配置文件：创建 {"mode":"proxy"} 并返回 Ok(true)
        let grok_dir = temp_appdata.join(GROK_BOT_APPDATA_DIR);
        std::fs::create_dir_all(&grok_dir).unwrap();
        assert!(ensure_grok_bot_system_proxy_config_in(&temp_appdata).unwrap());
        let cfg_path = grok_dir.join(GROK_BOT_PROXY_CONFIG_FILE);
        assert_eq!(
            std::fs::read_to_string(&cfg_path).unwrap(),
            GROK_BOT_PROXY_CONFIG_CONTENT
        );

        // 3) 再次调用或用户已自定义为 direct：不覆盖现有文件，返回 Ok(false)
        std::fs::write(&cfg_path, "{\"mode\":\"direct\"}").unwrap();
        assert!(!ensure_grok_bot_system_proxy_config_in(&temp_appdata).unwrap());
        assert_eq!(
            std::fs::read_to_string(&cfg_path).unwrap(),
            "{\"mode\":\"direct\"}"
        );

        let _ = std::fs::remove_dir_all(&temp_appdata);
    }
}
