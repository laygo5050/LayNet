import {
  Ban,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { extractProcessName, formatBytes } from "../lib/formatters";
import { getNodeDisplayMap, resolveNodeDisplayName } from "../lib/uriParser";
import { useAppStore } from "../store/useAppStore";
import { useTelemetryStore } from "../store/useTelemetryStore";

const BRUTAL_PRESETS = [
  {
    label: "BBR",
    down: 0,
    up: 0,
    title: "BBR 自适应拥塞控制（推荐默认）：自动适配物理带宽，不抢占光猫上行队列",
  },
  { label: "200M", down: 200, up: 30, title: "Brutal ↓200 / ↑30 Mbps（适配 200M~300M 家宽）" },
  { label: "500M", down: 500, up: 50, title: "Brutal ↓500 / ↑50 Mbps（适配 500M~1000M 家宽）" },
  { label: "1000M", down: 1000, up: 100, title: "Brutal ↓1000 / ↑100 Mbps（适配千兆对称/专线）" },
] as const;

export function SettingsView() {
  const connected = useAppStore((s) => s.connected);
  const connecting = useAppStore((s) => s.connecting);
  const autostartEnabled = useAppStore((s) => s.autostartEnabled);
  const toggleAutostart = useAppStore((s) => s.toggleAutostart);
  const autoRestoreConnect = useAppStore((s) => s.autoRestoreConnect);
  const setAutoRestoreConnect = useAppStore((s) => s.setAutoRestoreConnect);
  const autoRefreshSubs = useAppStore((s) => s.autoRefreshSubs);
  const setAutoRefreshSubs = useAppStore((s) => s.setAutoRefreshSubs);
  const dnsLeakProtection = useAppStore((s) => s.dnsLeakProtection);
  const setDnsLeakProtection = useAppStore((s) => s.setDnsLeakProtection);
  const brutalDownMbps = useAppStore((s) => s.brutalDownMbps);
  const brutalUpMbps = useAppStore((s) => s.brutalUpMbps);
  const setBrutalBandwidth = useAppStore((s) => s.setBrutalBandwidth);
  const [customOpen, setCustomOpen] = useState(false);
  const [draftDown, setDraftDown] = useState("");
  const [draftUp, setDraftUp] = useState("");
  const activePreset =
    BRUTAL_PRESETS.find((p) =>
      p.down === 0
        ? brutalDownMbps <= 0 || brutalUpMbps <= 0
        : p.down === brutalDownMbps && p.up === brutalUpMbps,
    )?.label ?? null;

  const isAdmin = useAppStore((s) => s.isAdmin);
  const setShowTunPrivilegeModal = useAppStore(
    (s) => s.setShowTunPrivilegeModal,
  );

  const nodes = useAppStore((s) => s.nodes);
  const connections = useTelemetryStore((s) => s.connections);
  const closeAllConnections = useAppStore((s) => s.closeAllConnections);
  const logs = useTelemetryStore((s) => s.logs);
  const clearLogs = useAppStore((s) => s.clearLogs);
  const panelTab = useAppStore((s) => s.settingsSubTab);
  const setPanelTab = useAppStore((s) => s.setSettingsSubTab);

  const [filterText, setFilterText] = useState("");
  const [logLevel, setLogLevel] = useState<"all" | "info" | "warning" | "error">(
    "all",
  );

  const displayMap = useMemo(() => getNodeDisplayMap(nodes), [nodes]);

  const filteredConnections = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter((c) => {
      const proc = extractProcessName(
        c.metadata.processPath,
        c.metadata.process,
      ).toLowerCase();
      const target = (
        c.metadata.host ||
        c.metadata.destinationIP ||
        ""
      ).toLowerCase();
      const rule = `${c.rule} ${c.rulePayload}`.toLowerCase();
      const chainLabels = c.chains
        .map((ch) => resolveNodeDisplayName(nodes, ch, displayMap) ?? ch)
        .join(" ")
        .toLowerCase();
      const rawChain = c.chains.join(" ").toLowerCase();
      return (
        proc.includes(q) ||
        target.includes(q) ||
        rule.includes(q) ||
        chainLabels.includes(q) ||
        rawChain.includes(q)
      );
    });
  }, [connections, filterText, nodes, displayMap]);

  const filteredLogs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return logs.filter((l) => {
      if (logLevel !== "all" && l.type !== logLevel) return false;
      if (q && !l.payload.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, logLevel, filterText]);

  return (
    <div className="flex h-full flex-col gap-3 p-4 pl-3 overflow-hidden">
      {/* 上半区：极简圆角开关卡片组 */}
      <div className="grid grid-cols-5 gap-2">
        <button
          type="button"
          onClick={() => void toggleAutostart()}
          className="flex items-center justify-between rounded-[22px] bg-white px-3 py-3 text-left ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <span className="whitespace-nowrap text-xs font-semibold text-slate-800 dark:text-slate-100">
            开机自启
          </span>
          <div
            className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
              autostartEnabled ? "bg-blue-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full bg-white shadow-2xs transition-transform ${
                autostartEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setAutoRestoreConnect(!autoRestoreConnect)}
          title="打开软件或开机静默启动时，自动恢复上次的连接状态"
          className="flex items-center justify-between rounded-[22px] bg-white px-3 py-3 text-left ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <span className="whitespace-nowrap text-xs font-semibold text-slate-800 dark:text-slate-100">
            启动自连
          </span>
          <div
            className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
              autoRestoreConnect ? "bg-blue-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full bg-white shadow-2xs transition-transform ${
                autoRestoreConnect ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setAutoRefreshSubs(!autoRefreshSubs)}
          className="flex items-center justify-between rounded-[22px] bg-white px-3 py-3 text-left ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <span className="whitespace-nowrap text-xs font-semibold text-slate-800 dark:text-slate-100">
            静默更订阅
          </span>
          <div
            className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
              autoRefreshSubs ? "bg-blue-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full bg-white shadow-2xs transition-transform ${
                autoRefreshSubs ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </div>
        </button>

        <button
          type="button"
          disabled={connecting}
          onClick={() => void setDnsLeakProtection(!dnsLeakProtection)}
          title="开启后未知域名仅经代理走远程 DoH 解析，不向国内 DNS 探测；常用国内站与冷门国内 IP 仍自动直连"
          className="flex items-center justify-between rounded-[22px] bg-white px-3 py-3 text-left ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] disabled:opacity-50 dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <span className="whitespace-nowrap text-xs font-semibold text-slate-800 dark:text-slate-100">
            DNS防泄露
          </span>
          <div
            className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
              dnsLeakProtection ? "bg-blue-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full bg-white shadow-2xs transition-transform ${
                dnsLeakProtection ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            if (!isAdmin) setShowTunPrivilegeModal(true);
          }}
          className="flex items-center justify-between rounded-[22px] bg-white px-3 py-3 text-left ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <span className="whitespace-nowrap text-xs font-semibold text-slate-800 dark:text-slate-100">
            {isAdmin ? "管理员就绪" : "获取权限"}
          </span>
          {isAdmin ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
          )}
        </button>
      </div>

      {/* HY2 默认带宽：仅对链接未声明 upmbps/downmbps 的节点生效 */}
      <div className="flex flex-col gap-1.5 rounded-[22px] bg-white px-4 py-1.5 ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
        <div className="flex items-center justify-between">
          <span
            className="text-[11px] font-medium text-slate-500 dark:text-slate-400"
            title="链接自带 upmbps/downmbps 的节点始终按链接参数走 Brutal，不受此处影响"
          >
            HY2 默认带宽
            <span className="ml-1.5 text-[10px] text-slate-400 dark:text-slate-500">
              仅对未声明带宽的节点生效
            </span>
          </span>
          <div className="flex items-center gap-1 rounded-full bg-[#F4F5F8] p-0.5 dark:bg-white/[0.06]">
            {BRUTAL_PRESETS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                title={opt.title}
                onClick={() => {
                  setCustomOpen(false);
                  void setBrutalBandwidth(opt.down, opt.up);
                }}
                className={`rounded-full px-3 py-0.5 text-[11px] font-semibold transition cursor-pointer ${
                  !customOpen && activePreset === opt.label
                    ? "bg-slate-900 text-white shadow-2xs dark:bg-blue-600"
                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              title="按你宽带 / 节点的实际带宽填写"
              onClick={() => {
                setDraftDown(String(brutalDownMbps > 0 ? brutalDownMbps : ""));
                setDraftUp(String(brutalUpMbps > 0 ? brutalUpMbps : ""));
                setCustomOpen(true);
              }}
              className={`rounded-full px-3 py-0.5 text-[11px] font-semibold transition cursor-pointer ${
                customOpen || activePreset === null
                  ? "bg-slate-900 text-white shadow-2xs dark:bg-blue-600"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400"
              }`}
            >
              {activePreset === null && !customOpen
                ? `↓${brutalDownMbps}/↑${brutalUpMbps}`
                : "自定义"}
            </button>
          </div>
        </div>

        {customOpen && (
          <form
            className="flex items-center justify-end gap-2 pb-1"
            onSubmit={(e) => {
              e.preventDefault();
              const down = Number(draftDown);
              const up = Number(draftUp);
              if (!(down > 0 && up > 0)) return;
              setCustomOpen(false);
              void setBrutalBandwidth(down, up);
            }}
          >
            <label className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
              下行
              <input
                type="number"
                min={1}
                max={10000}
                value={draftDown}
                onChange={(e) => setDraftDown(e.target.value)}
                placeholder="90"
                autoFocus
                className="w-16 rounded-full bg-[#F4F5F8] px-2.5 py-0.5 text-right font-mono text-[11px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/35 dark:bg-white/[0.06] dark:text-slate-200"
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
              上行
              <input
                type="number"
                min={1}
                max={10000}
                value={draftUp}
                onChange={(e) => setDraftUp(e.target.value)}
                placeholder="60"
                className="w-16 rounded-full bg-[#F4F5F8] px-2.5 py-0.5 text-right font-mono text-[11px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/35 dark:bg-white/[0.06] dark:text-slate-200"
              />
            </label>
            <span className="text-[10px] text-slate-400">Mbps</span>
            <button
              type="submit"
              disabled={!(Number(draftDown) > 0 && Number(draftUp) > 0)}
              className="rounded-full bg-slate-900 px-3 py-0.5 text-[11px] font-semibold text-white transition disabled:opacity-35 dark:bg-blue-600 cursor-pointer"
            >
              应用
            </button>
            <button
              type="button"
              onClick={() => setCustomOpen(false)}
              className="rounded-full px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-800 dark:text-slate-400 cursor-pointer"
            >
              取消
            </button>
          </form>
        )}
      </div>

      {/* 下半区：大圆角实时连接与日志卡片 */}
      <div className="flex min-h-0 flex-1 flex-col rounded-[26px] bg-white overflow-hidden shadow-[0_2px_16px_rgba(15,23,42,0.03)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
        {/* 顶栏胶囊切换与圆角搜索 */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-1 rounded-full bg-[#F4F5F8] p-1 dark:bg-white/[0.06]">
            <button
              type="button"
              onClick={() => setPanelTab("connections")}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition cursor-pointer ${
                panelTab === "connections"
                  ? "bg-white text-slate-900 shadow-2xs dark:bg-white/15 dark:text-white"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400"
              }`}
            >
              连接 {connections.length > 0 ? `· ${connections.length}` : ""}
            </button>
            <button
              type="button"
              onClick={() => setPanelTab("logs")}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition cursor-pointer ${
                panelTab === "logs"
                  ? "bg-white text-slate-900 shadow-2xs dark:bg-white/15 dark:text-white"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400"
              }`}
            >
              日志
            </button>
          </div>

          <div className="flex items-center gap-2">
            {panelTab === "logs" && (
              <div className="flex rounded-full bg-[#F4F5F8] p-0.5 text-[10px] font-semibold dark:bg-white/[0.06]">
                {(["all", "info", "warning", "error"] as const).map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    onClick={() => setLogLevel(lv)}
                    className={`rounded-full px-2.5 py-0.5 uppercase transition cursor-pointer ${
                      logLevel === lv
                        ? "bg-white text-slate-900 shadow-2xs dark:bg-white/15 dark:text-white"
                        : "text-slate-400"
                    }`}
                  >
                    {lv === "all" ? "全部" : lv}
                  </button>
                ))}
              </div>
            )}

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="搜索..."
                className="w-40 rounded-full bg-[#F4F5F8] py-1.5 pl-8 pr-3 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/35 dark:bg-white/[0.06] dark:text-slate-200"
              />
            </div>

            {panelTab === "connections" ? (
              <button
                type="button"
                disabled={!connected || connections.length === 0}
                onClick={() => void closeAllConnections()}
                title="断开全部连接"
                className="flex h-7.5 w-7.5 items-center justify-center rounded-full bg-[#F4F5F8] text-slate-500 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-35 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                <Ban className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={clearLogs}
                title="清空日志"
                className="flex h-7.5 w-7.5 items-center justify-center rounded-full bg-[#F4F5F8] text-slate-500 transition hover:bg-rose-50 hover:text-rose-500 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 内容区 */}
        {panelTab === "connections" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!connected ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                开启连接后实时显示分流明细
              </div>
            ) : filteredConnections.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                暂无活跃连接
              </div>
            ) : (
              <div className="space-y-1 px-1">
                {filteredConnections.map((conn) => {
                  const proc = extractProcessName(
                    conn.metadata.processPath,
                    conn.metadata.process,
                  );
                  const host =
                    conn.metadata.host || conn.metadata.destinationIP;
                  const target = `${host}:${conn.metadata.destinationPort}`;
                  const rawOutbound = conn.chains[0] || "direct";
                  const finalOutbound =
                    resolveNodeDisplayName(nodes, rawOutbound, displayMap) ??
                    rawOutbound;
                  const isDirect =
                    rawOutbound.toLowerCase() === "direct" ||
                    conn.chains.some((c) => c.toLowerCase() === "direct");
                  const ruleText = conn.rulePayload || conn.rule || "final";

                  return (
                    <div
                      key={conn.id}
                      className="flex items-center justify-between gap-2 rounded-full px-3 py-1.5 text-[11px] transition hover:bg-[#F6F7FA] dark:hover:bg-white/[0.04]"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0 rounded-full bg-[#F4F5F8] px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:bg-white/[0.07] dark:text-slate-300">
                          {proc}
                        </span>
                        <span
                          className="truncate font-mono text-slate-700 dark:text-slate-200"
                          title={target}
                        >
                          {target}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className="max-w-[130px] truncate font-mono text-[10px] text-slate-400"
                          title={`${conn.rule}(${conn.rulePayload})`}
                        >
                          {ruleText}
                        </span>

                        <span
                          className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            isDirect
                              ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                              : "bg-blue-500/12 text-blue-600 dark:text-blue-400"
                          }`}
                        >
                          {isDirect ? "直连" : finalOutbound}
                        </span>

                        <span className="w-14 text-right font-mono text-[10px] tabular-nums text-slate-400">
                          {formatBytes(conn.download + conn.upload)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 font-mono text-[11px] space-y-1">
            {filteredLogs.length === 0 ? (
              <div className="flex h-full items-center justify-center font-sans text-xs text-slate-400">
                暂无日志
              </div>
            ) : (
              filteredLogs.map((log) => {
                const badgeClass =
                  log.type === "error"
                    ? "bg-rose-500/12 text-rose-600 dark:text-rose-400"
                    : log.type === "warning"
                      ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                      : "bg-blue-500/10 text-blue-600 dark:text-blue-400";
                return (
                  <div
                    key={log.id}
                    className="flex items-start gap-2 rounded-xl px-2 py-1 hover:bg-[#F6F7FA] dark:hover:bg-white/[0.04]"
                  >
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {log.time}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.2 text-[9px] font-bold uppercase ${badgeClass}`}
                    >
                      {log.type}
                    </span>
                    <span className="break-all text-slate-600 dark:text-slate-300">
                      {log.payload}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
