import { ShieldAlert, Sparkles, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";

export function TunPrivilegeModal() {
  const show = useAppStore((s) => s.showTunPrivilegeModal);
  const setShow = useAppStore((s) => s.setShowTunPrivilegeModal);
  const confirmElevateForTun = useAppStore((s) => s.confirmElevateForTun);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-xs">
      <div className="w-[360px] rounded-[28px] bg-white p-6 shadow-2xl ring-1 ring-black/[0.05] dark:bg-[#161922] dark:ring-white/[0.08]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-500/12 text-violet-600 dark:text-violet-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                需要管理员权限
              </h3>
              <p className="text-[11px] text-slate-400">
                创建 LayTun 全局虚拟网卡
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShow(false)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          TUN 模式将接管系统全部三层网络流量，需通过 Windows 管理员授权重启后自动生效。
          {import.meta.env.DEV && (
            <span className="mt-1.5 block text-[11px] text-amber-600 dark:text-amber-400">
              当前处于开发模式（tauri dev）：退出旧进程会同时停止 Vite 服务，请使用管理员终端运行{" "}
              <code className="font-mono">pnpm tauri dev</code> 或使用正式打包版测试一键提权。
            </span>
          )}
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setShow(false)}
            className="rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-200/80 active:scale-95 dark:bg-white/[0.06] dark:text-slate-300 dark:hover:bg-white/[0.1] cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void confirmElevateForTun()}
            className="flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-violet-600/25 transition hover:bg-violet-500 active:scale-95 cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>提权并开启</span>
          </button>
        </div>
      </div>
    </div>
  );
}
