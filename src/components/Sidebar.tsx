import {
  Gauge,
  Laptop,
  Moon,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import type { NavTab, ThemeMode } from "../types/proxy";

export function Sidebar() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const connected = useAppStore((s) => s.connected);
  const sysProxy = useAppStore((s) => s.sysProxy);
  const tunMode = useAppStore((s) => s.tunMode);
  const nodeCount = useAppStore((s) => s.nodes.length);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const isAdmin = useAppStore((s) => s.isAdmin);
  const setShowTunPrivilegeModal = useAppStore(
    (s) => s.setShowTunPrivilegeModal,
  );

  const cycleTheme = () => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length] ?? "system";
    setTheme(next);
  };

  const navItems: {
    id: NavTab;
    label: string;
    icon: typeof Gauge;
    badge?: number;
  }[] = [
    { id: "dashboard", label: "控制台", icon: Gauge },
    { id: "nodes", label: "节点库", icon: Server, badge: nodeCount },
    { id: "settings", label: "设置", icon: SlidersHorizontal },
  ];

  const statusDot = !connected
    ? "bg-slate-300 dark:bg-slate-600"
    : tunMode
      ? "bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.9)]"
      : sysProxy
        ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]"
        : "bg-blue-500";

  return (
    <aside className="flex h-full w-[72px] shrink-0 flex-col items-center justify-between py-4 pl-3 pr-1">
      {/* 极简圆角悬浮胶囊导航坞 */}
      <div className="flex h-full w-full flex-col items-center justify-between rounded-[28px] bg-white/90 py-4 shadow-[0_2px_16px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04] dark:bg-[#14171F]/90 dark:ring-white/[0.06]">
        {/* 品牌圆标 */}
        <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm dark:bg-white dark:text-slate-900">
          <Zap className="h-4.5 w-4.5 fill-current" />
          <span
            className={`absolute right-0 top-0 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#14171F] ${statusDot}`}
          />
        </div>

        {/* 中部圆形胶囊图标菜单 */}
        <nav className="flex flex-col items-center gap-2.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                title={item.label}
                className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 active:scale-95 cursor-pointer ${
                  active
                    ? "bg-blue-600 text-white shadow-md shadow-blue-600/25"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200"
                }`}
              >
                <Icon className="h-[19px] w-[19px]" strokeWidth={2.1} />
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold ${
                      active
                        ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                        : "bg-slate-200/90 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {item.badge > 99 ? "99" : item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* 底部极简圆形工具按钮 */}
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={cycleTheme}
            title={
              theme === "system"
                ? "跟随系统"
                : theme === "light"
                  ? "浅色模式"
                  : "深色模式"
            }
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200 cursor-pointer"
          >
            {theme === "light" ? (
              <Sun className="h-4 w-4" />
            ) : theme === "dark" ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Laptop className="h-4 w-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              if (!isAdmin) setShowTunPrivilegeModal(true);
            }}
            title={isAdmin ? "管理员权限已就绪" : "点击提权启用 TUN 模式"}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition active:scale-95 ${
              isAdmin
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/12 text-amber-500 hover:bg-amber-500/20 cursor-pointer"
            }`}
          >
            {isAdmin ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
