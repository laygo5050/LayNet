import { useEffect } from "react";
import "./App.css";
import { DashboardView } from "./components/DashboardView";
import { NodesView } from "./components/NodesView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { ToastContainer } from "./components/ToastContainer";
import { TunPrivilegeModal } from "./components/TunPrivilegeModal";
import { useAppStore } from "./store/useAppStore";

const ENGINE_CONFIG_REV = 2;

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const theme = useAppStore((s) => s.theme);
  const connected = useAppStore((s) => s.connected);
  const connecting = useAppStore((s) => s.connecting);
  const initializeApp = useAppStore((s) => s.initializeApp);
  const reloadCoreConfig = useAppStore((s) => s.reloadCoreConfig);
  const setWindowVisible = useAppStore((s) => s.setWindowVisible);

  useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  // 窗口最小化或切到后台不可见时自动暂停 WebSocket 推送，降低 CPU 与内存占用
  useEffect(() => {
    const onVisChange = () => {
      setWindowVisible(!document.hidden);
    };
    onVisChange();
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [setWindowVisible]);

  useEffect(() => {
    const win = window as unknown as { __LAYNET_ENGINE_REV__?: number };
    if (!connected) {
      win.__LAYNET_ENGINE_REV__ = ENGINE_CONFIG_REV;
      return;
    }
    if (!connecting && win.__LAYNET_ENGINE_REV__ !== ENGINE_CONFIG_REV) {
      win.__LAYNET_ENGINE_REV__ = ENGINE_CONFIG_REV;
      void reloadCoreConfig(true);
    }
  }, [connected, connecting, reloadCoreConfig]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const isDark =
        theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", isDark);
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  return (
    <div
      onContextMenu={(e) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
        }
      }}
      className="flex h-screen w-screen overflow-hidden bg-[#F4F5F8] text-slate-900 dark:bg-[#0B0D11] dark:text-slate-100"
    >
      <Sidebar />

      <main className="min-w-0 flex-1 overflow-hidden">
        {activeTab === "dashboard" && <DashboardView />}
        {activeTab === "nodes" && <NodesView />}
        {activeTab === "settings" && <SettingsView />}
      </main>

      <TunPrivilegeModal />
      <ToastContainer />
    </div>
  );
}
