#[cfg(windows)]
use std::ptr::null_mut;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    UI::Shell::{IsUserAnAdmin, ShellExecuteW},
    UI::WindowsAndMessaging::SW_SHOWNORMAL,
};

#[allow(dead_code)]
pub const SERVICE_NAME: &str = "LayNetService";

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 检测当前进程是否拥有管理员权限（创建 LayTun Wintun 虚拟网卡必需）
pub fn is_admin() -> bool {
    #[cfg(windows)]
    unsafe {
        IsUserAnAdmin() != 0
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// 精确等待旧非管理员进程完全退出并释放 single-instance 互斥锁，彻底杜绝 UAC 提权重启撞锁闪退
pub fn wait_for_parent_exit(pid: u32, timeout_ms: u32) {
    #[cfg(windows)]
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            let _ = WaitForSingleObject(handle, timeout_ms);
            CloseHandle(handle);
        }
        // 给 Windows 释放命名互斥体与托盘句柄留出安全余量
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    #[cfg(not(windows))]
    {
        let _ = (pid, timeout_ms);
    }
}

/// 通过 UAC (`runas`) 请求管理员提权重新拉起 LayNet 并传入当前 PID 供新进程精确等待
pub fn request_uac_relaunch(extra_args: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        let exe = std::env::current_exe().map_err(|e| format!("无法获取当前程序路径: {}", e))?;
        let exe_str = exe.to_string_lossy().to_string();
        let dir_str = exe
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let verb = to_wide("runas");
        let file = to_wide(&exe_str);
        let params = to_wide(&extra_args.join(" "));
        let dir = to_wide(&dir_str);

        let result = ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            dir.as_ptr(),
            SW_SHOWNORMAL,
        );

        if (result as isize) <= 32 {
            return Err("用户取消了 UAC 管理员提权请求或系统拒绝拉起".to_string());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = extra_args;
        Ok(())
    }
}
