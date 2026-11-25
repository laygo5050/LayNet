use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::ptr::null_mut;
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_MULTI_SZ,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEnvInfo {
    pub windows_timezone: String,
    pub languages: Vec<String>,
    pub detected_browser: Option<String>,
}

pub fn validate_windows_timezone(tz: &str) -> Result<&str, String> {
    let trimmed = tz.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("无效的 Windows 时区标识".to_string());
    }
    let valid = trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'+' | b'-' | b'.' | b'_' | b'(' | b')' | b'/'));
    if !valid {
        return Err("时区名称包含非法字符".to_string());
    }
    Ok(trimmed)
}

pub fn validate_language_tag(tag: &str) -> Result<&str, String> {
    let trimmed = tag.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("无效的语言标签".to_string());
    }
    let mut parts = trimmed.split('-');
    let Some(primary) = parts.next() else {
        return Err("无效的语言标签".to_string());
    };
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(format!("无效的语言主标签: {}", trimmed));
    }
    let rest: Vec<&str> = parts.collect();
    if rest.len() > 3 {
        return Err(format!("无效的语言标签: {}", trimmed));
    }
    for sub in rest {
        if !(1..=8).contains(&sub.len()) || !sub.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(format!("无效的语言子标签: {}", trimmed));
        }
    }
    Ok(trimmed)
}

pub fn parse_reg_multi_sz(words: &[u16]) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let rel_end = words[start..].iter().position(|&c| c == 0);
        let end = match rel_end {
            Some(pos) => start + pos,
            None => words.len(),
        };
        if end == start {
            break;
        }
        let item = String::from_utf16_lossy(&words[start..end]).trim().to_string();
        if !item.is_empty() {
            out.push(item);
        }
        start = end + 1;
    }
    out
}

pub fn merge_browser_preferences_json(raw_json: &str, accept_languages: &str) -> String {
    let mut root = serde_json::from_str::<Value>(raw_json)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let mut intl_obj = root
        .get("intl")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(Map::new);

    intl_obj.insert(
        "accept_languages".to_string(),
        Value::String(accept_languages.to_string()),
    );
    intl_obj.insert(
        "selected_languages".to_string(),
        Value::String(accept_languages.to_string()),
    );
    root.insert("intl".to_string(), Value::Object(intl_obj));

    serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_languages_from_registry() -> Option<Vec<String>> {
    unsafe {
        let subkey = to_wide("Control Panel\\International\\User Profile");
        let val_name = to_wide("Languages");
        let mut hkey: HKEY = null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }
        let mut reg_type: u32 = 0;
        let mut size: u32 = 0;
        let query_rc = RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            null_mut(),
            &mut reg_type,
            null_mut(),
            &mut size,
        );
        if query_rc != 0 || size == 0 || reg_type != REG_MULTI_SZ {
            RegCloseKey(hkey);
            return None;
        }
        let word_len = (size as usize).div_ceil(2);
        let mut buf = vec![0u16; word_len + 1];
        let read_rc = RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            null_mut(),
            &mut reg_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(hkey);
        if read_rc != 0 {
            return None;
        }
        let actual_words = (size as usize) / 2;
        let parsed = parse_reg_multi_sz(&buf[..actual_words.min(buf.len())]);
        if parsed.is_empty() {
            None
        } else {
            Some(parsed)
        }
    }
}

fn read_windows_timezone() -> Result<String, String> {
    #[cfg(windows)]
    {
        let out = Command::new("tzutil.exe")
            .arg("/g")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("读取系统时区失败: {}", e))?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if msg.is_empty() {
                "tzutil 返回非零退出码".to_string()
            } else {
                msg
            });
        }
        let tz = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if tz.is_empty() {
            return Err("无法读取当前 Windows 时区".to_string());
        }
        Ok(tz)
    }
    #[cfg(not(windows))]
    {
        Ok("China Standard Time".to_string())
    }
}

fn read_windows_languages() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        if let Some(langs) = read_languages_from_registry() {
            return Ok(langs);
        }

        let out = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; foreach ($item in (Get-WinUserLanguageList)) { $item.LanguageTag }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("读取系统语言列表失败: {}", e))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "读取系统首选语言失败".to_string()
            } else {
                err
            });
        }

        let langs: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(langs)
    }
    #[cfg(not(windows))]
    {
        Ok(vec!["zh-Hans-CN".to_string()])
    }
}

pub fn detect_browser_binary() -> Option<(String, PathBuf)> {
    #[cfg(windows)]
    {
        let env_dirs = [
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            std::env::var_os("LocalAppData").map(PathBuf::from),
        ];

        for base in env_dirs.iter().flatten() {
            let chrome = base.join("Google").join("Chrome").join("Application").join("chrome.exe");
            if chrome.is_file() {
                return Some(("Chrome".to_string(), chrome));
            }
        }

        let edge_dirs = [
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            std::env::var_os("ProgramFiles").map(PathBuf::from),
        ];
        for base in edge_dirs.iter().flatten() {
            let edge = base.join("Microsoft").join("Edge").join("Application").join("msedge.exe");
            if edge.is_file() {
                return Some(("Edge".to_string(), edge));
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

pub fn get_system_env_info() -> Result<SystemEnvInfo, String> {
    let windows_timezone = read_windows_timezone()?;
    let languages = read_windows_languages()?;
    let detected_browser = detect_browser_binary().map(|(name, _)| name);
    Ok(SystemEnvInfo {
        windows_timezone,
        languages,
        detected_browser,
    })
}

pub fn set_windows_timezone(tz_id: &str) -> Result<(), String> {
    let validated = validate_windows_timezone(tz_id)?;
    #[cfg(windows)]
    {
        let out = Command::new("tzutil.exe")
            .args(["/s", validated])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("执行 tzutil 失败: {}", e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let combined = [stderr, stdout]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let lower = combined.to_ascii_lowercase();
            if lower.contains("denied")
                || lower.contains("privilege")
                || lower.contains("access")
                || combined.contains("拒绝")
                || combined.contains("权限")
            {
                return Err("修改系统时区需要管理员权限（请在设置页点击「获取权限」提权后重试）".to_string());
            }
            return Err(if combined.is_empty() {
                format!("修改系统时区失败（退出码 {:?}）", out.status.code())
            } else {
                format!("修改系统时区失败: {}", combined)
            });
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = validated;
        Ok(())
    }
}

pub fn build_set_languages_ps_script(validated: &[&str], exact_restore: bool) -> String {
    let first_tag = validated.first().copied().unwrap_or("en-US");
    if exact_restore {
        let ps_tags = validated
            .iter()
            .map(|t| format!("'{}'", t))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
             $OutputEncoding = [System.Text.Encoding]::UTF8\n\
             $ErrorActionPreference = 'Stop'\n\
             $targets = @({})\n\
             $current = Get-WinUserLanguageList\n\
             $next = New-WinUserLanguageList '{}'\n\
             $next.Clear()\n\
             $seen = @{{}}\n\
             foreach ($tag in $targets) {{\n\
               $key = $tag.ToLowerInvariant()\n\
               if ($seen.ContainsKey($key)) {{ continue }}\n\
               $seen[$key] = $true\n\
               $match = $null\n\
               foreach ($item in $current) {{\n\
                 if ($item.LanguageTag -ieq $tag) {{ $match = $item; break }}\n\
               }}\n\
               if ($null -ne $match) {{\n\
                 $next.Add($match)\n\
               }} else {{\n\
                 $created = New-WinUserLanguageList $tag\n\
                 if ($created.Count -gt 0) {{ $next.Add($created[0]) }}\n\
               }}\n\
             }}\n\
             if ($next.Count -gt 0) {{ Set-WinUserLanguageList $next -Force }}",
            ps_tags, first_tag
        )
    } else {
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
             $OutputEncoding = [System.Text.Encoding]::UTF8\n\
             $ErrorActionPreference = 'Stop'\n\
             $primary = '{}'\n\
             $current = Get-WinUserLanguageList\n\
             $next = New-WinUserLanguageList $primary\n\
             $next.Clear()\n\
             $match = $null\n\
             foreach ($item in $current) {{\n\
               if ($item.LanguageTag -ieq $primary) {{ $match = $item; break }}\n\
             }}\n\
             if ($null -ne $match) {{\n\
               $next.Add($match)\n\
             }} else {{\n\
               $created = New-WinUserLanguageList $primary\n\
               if ($created.Count -gt 0) {{ $next.Add($created[0]) }}\n\
             }}\n\
             foreach ($item in $current) {{\n\
               if ($item.LanguageTag -ine $primary) {{ $next.Add($item) }}\n\
             }}\n\
             if ($next.Count -gt 0) {{ Set-WinUserLanguageList $next -Force }}",
            first_tag
        )
    }
}

pub fn set_windows_languages(languages: &[String], exact_restore: bool) -> Result<Vec<String>, String> {
    if languages.is_empty() || languages.len() > 10 {
        return Err("语言列表数量无效（需为 1~10 项）".to_string());
    }
    let mut validated: Vec<&str> = Vec::with_capacity(languages.len());
    for raw in languages {
        validated.push(validate_language_tag(raw)?);
    }

    #[cfg(windows)]
    {
        let script = build_set_languages_ps_script(&validated, exact_restore);

        let out = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("执行语言修改脚本失败: {}", e))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "修改 Windows 首选语言失败".to_string()
            } else {
                format!("修改 Windows 首选语言失败: {}", err)
            });
        }

        read_windows_languages()
    }
    #[cfg(not(windows))]
    {
        Ok(validated.into_iter().map(str::to_string).collect())
    }
}

pub fn launch_localized_browser(
    profile_root: &Path,
    lang: &str,
    proxy_port: Option<u16>,
    url: Option<&str>,
) -> Result<String, String> {
    let valid_lang = validate_language_tag(lang)?;
    if let Some(u) = url {
        let lower = u.trim().to_ascii_lowercase();
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            return Err("仅支持 http:// 或 https:// 网址".to_string());
        }
    }

    let (browser_name, exe_path) = detect_browser_binary()
        .ok_or_else(|| "未检测到 Chrome 或 Microsoft Edge 浏览器".to_string())?;

    let profile_dir = profile_root.join("browser-profiles").join(valid_lang);
    let default_dir = profile_dir.join("Default");
    fs::create_dir_all(&default_dir)
        .map_err(|e| format!("创建隔离浏览器配置目录失败: {}", e))?;

    let primary_base = valid_lang.split('-').next().unwrap_or(valid_lang);
    let accept_langs = if primary_base.eq_ignore_ascii_case(valid_lang) {
        valid_lang.to_string()
    } else {
        format!("{},{}", valid_lang, primary_base)
    };

    let prefs_path = default_dir.join("Preferences");
    let raw_prefs = fs::read_to_string(&prefs_path).unwrap_or_default();
    let updated_prefs = merge_browser_preferences_json(&raw_prefs, &accept_langs);
    fs::write(&prefs_path, updated_prefs)
        .map_err(|e| format!("写入浏览器语言首选项失败: {}", e))?;

    let mut cmd = Command::new(&exe_path);
    cmd.arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg(format!("--lang={}", valid_lang))
        .arg("--no-first-run")
        .arg("--no-default-browser-check");
    if let Some(port) = proxy_port {
        cmd.arg(format!("--proxy-server=http://127.0.0.1:{}", port));
    }
    if let Some(u) = url {
        cmd.arg(u.trim());
    }

    cmd.spawn()
        .map_err(|e| format!("启动 {} 失败: {}", browser_name, e))?;

    Ok(browser_name)
}

pub fn fetch_text_via_proxy(url: &str, port: u16) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("仅支持 http:// 或 https:// 探测地址".to_string());
    }

    #[cfg(windows)]
    {
        let proxy_arg = format!("http://127.0.0.1:{}", port);
        let out = Command::new("curl.exe")
            .args([
                "-sSLg",
                "--fail",
                "--compressed",
                "--connect-timeout",
                "6",
                "--max-time",
                "10",
                "-A",
                "LayNet/0.1",
                "-x",
                &proxy_arg,
                "--",
                trimmed,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("调用代理探测请求失败: {}", e))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("代理探测返回错误码 {:?}", out.status.code())
            } else {
                err
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (trimmed, port);
        Err("当前平台未启用原生代理探测".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_windows_timezone_safely() {
        assert_eq!(
            validate_windows_timezone("Pacific Standard Time").unwrap(),
            "Pacific Standard Time"
        );
        assert_eq!(
            validate_windows_timezone("UTC+08").unwrap(),
            "UTC+08"
        );
        assert!(validate_windows_timezone("").is_err());
        assert!(validate_windows_timezone("Pacific;whoami").is_err());
        assert!(validate_windows_timezone("Pacific & calc").is_err());
    }

    #[test]
    fn validates_bcp47_language_tags_strictly() {
        assert_eq!(validate_language_tag("en-US").unwrap(), "en-US");
        assert_eq!(validate_language_tag("zh-Hans-CN").unwrap(), "zh-Hans-CN");
        assert_eq!(validate_language_tag("ja-JP").unwrap(), "ja-JP");
        assert!(validate_language_tag("").is_err());
        assert!(validate_language_tag("en-US;calc").is_err());
        assert!(validate_language_tag("1-US").is_err());
        assert!(validate_language_tag("en-US-x-y-z").is_err());
    }

    #[test]
    fn parses_reg_multi_sz_utf16_blocks() {
        let raw: Vec<u16> = "zh-Hans-CN\0en-US\0\0".encode_utf16().collect();
        assert_eq!(parse_reg_multi_sz(&raw), vec!["zh-Hans-CN", "en-US"]);

        let empty: Vec<u16> = vec![0, 0];
        assert!(parse_reg_multi_sz(&empty).is_empty());
    }

    #[test]
    fn merges_browser_preferences_preserving_existing_keys() {
        let existing = r#"{"browser":{"show_home_button":true},"intl":{"custom_flag":42}}"#;
        let updated = merge_browser_preferences_json(existing, "en-US,en");
        let parsed: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed["browser"]["show_home_button"], true);
        assert_eq!(parsed["intl"]["custom_flag"], 42);
        assert_eq!(parsed["intl"]["accept_languages"], "en-US,en");
        assert_eq!(parsed["intl"]["selected_languages"], "en-US,en");

        let fresh = merge_browser_preferences_json("not json", "ja-JP,ja");
        let parsed_fresh: Value = serde_json::from_str(&fresh).unwrap();
        assert_eq!(parsed_fresh["intl"]["accept_languages"], "ja-JP,ja");
        assert_eq!(parsed_fresh["intl"]["selected_languages"], "ja-JP,ja");
    }

    #[test]
    fn builds_safe_powershell_language_scripts_without_array_wrapping() {
        let promote = build_set_languages_ps_script(&["en-US"], false);
        assert!(promote.contains("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"));
        assert!(!promote.contains("@(Get-WinUserLanguageList)"));
        assert!(!promote.contains("@(New-WinUserLanguageList"));
        assert!(!promote.contains("Where-Object"));
        assert!(promote.contains("$primary = 'en-US'"));
        assert!(promote.contains("Set-WinUserLanguageList $next -Force"));

        let restore = build_set_languages_ps_script(&["zh-Hans-CN", "en-US"], true);
        assert!(restore.contains("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"));
        assert!(!restore.contains("@(Get-WinUserLanguageList)"));
        assert!(restore.contains("$targets = @('zh-Hans-CN', 'en-US')"));
        assert!(restore.contains("Set-WinUserLanguageList $next -Force"));
    }
}
