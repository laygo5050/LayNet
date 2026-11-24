import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  readText as readClipboardPlugin,
  writeText as writeClipboardPlugin,
} from "@tauri-apps/plugin-clipboard-manager";
import type {
  CoreApplyRequest,
  CoreApplyResult,
  LaunchContext,
  RoutingMode,
} from "../types/proxy";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getLaunchContext(): Promise<LaunchContext> {
  if (!isTauriRuntime()) {
    return {
      silent: false,
      relaunchTun: false,
      isAdmin: false,
      sysProxyEnabled: false,
      preferredSysProxy: true,
      coreRunning: false,
      routingMode: "rule",
      tunMode: false,
      isColdStart: true,
      pendingExitError: null,
    };
  }
  return invoke<LaunchContext>("get_launch_context");
}

/**
 * 前端完成证书指纹筛选后，才允许托盘复用磁盘上的 running-config。
 * `discardSaved` 为真时先删除旧配置，避免升级后的静默恢复或无窗口重连绕过检查。
 */
export async function settleCachedCoreConfig(
  discardSaved: boolean,
  expectedConfig?: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("settle_cached_core_config", { discardSaved, expectedConfig });
}

export async function releaseWindowToTray(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("release_window_to_tray");
  } catch {
    // ignore
  }
}

export async function applyLayNetCoreConfig(
  request: CoreApplyRequest,
): Promise<CoreApplyResult> {
  if (!isTauriRuntime()) {
    throw new Error("当前处于纯浏览器预览环境，请在 Tauri 桌面环境中启动内核");
  }
  return invoke<CoreApplyResult>("apply_core_config", { request });
}

export async function stopLayNetCore(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("disconnect_laynet_core");
}

export async function setWindowsSystemProxy(
  enable: boolean,
  port = 7890,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_sys_proxy", { enable, port });
}

export async function getSysProxyState(): Promise<{
  enabled: boolean;
  server: string;
}> {
  if (!isTauriRuntime()) {
    return { enabled: false, server: "" };
  }
  try {
    return await invoke<{ enabled: boolean; server: string }>(
      "get_sys_proxy_state",
    );
  } catch {
    return { enabled: false, server: "" };
  }
}

export async function checkAdminPrivilege(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("check_admin_privilege");
}

export async function elevateForTun(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("非桌面环境不支持 UAC 提权");
  }
  await invoke("elevate_for_tun");
}

export async function syncTrayState(payload: {
  connected: boolean;
  sysProxy: boolean;
  tunMode: boolean;
  routingMode: RoutingMode;
  activeNode?: string;
  terminalShell?: "powershell" | "cmd";
}): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("sync_tray_state", { payload });
  } catch {
    // ignore tray sync error
  }
}

export async function fetchSubscriptionText(url: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("fetch_raw_text", { url });
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      return await readClipboardPlugin();
    } catch {
      // fallback to browser API
    }
  }
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await writeClipboardPlugin(text);
      return;
    } catch {
      // fallback to browser API
    }
  }
  await navigator.clipboard.writeText(text);
}

export async function getAutostartStatus(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    return await isAutostartEnabled();
  } catch {
    return false;
  }
}

export async function setAutostartStatus(enable: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  if (enable) {
    await enableAutostart();
  } else {
    await disableAutostart();
  }
}

export async function subscribeTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return listen<T>(eventName, (ev) => handler(ev.payload));
}

export function buildTerminalProxyCommand(shell: "powershell" | "cmd" = "powershell"): string {
  if (shell === "cmd") {
    return 'set HTTP_PROXY=http://127.0.0.1:7890&& set HTTPS_PROXY=http://127.0.0.1:7890&& set ALL_PROXY=socks5://127.0.0.1:7890';
  }
  return '$env:HTTP_PROXY="http://127.0.0.1:7890"; $env:HTTPS_PROXY="http://127.0.0.1:7890"; $env:ALL_PROXY="socks5://127.0.0.1:7890"';
}
