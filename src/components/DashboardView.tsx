import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Compass,
  Copy,
  Globe,
  ListFilter,
  Loader2,
  Network,
  Power,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { countCustomRules, parseCustomRuleLines } from "../lib/configBuilder";
import { formatBytes, formatSpeed } from "../lib/formatters";
import { getNodeDisplayMap, resolveNodeDisplayName } from "../lib/uriParser";
import { useAppStore } from "../store/useAppStore";
import { useTelemetryStore } from "../store/useTelemetryStore";
import type { RoutingMode } from "../types/proxy";
import { EnvCheckModal } from "./EnvCheckModal";

/**
 * 极简圆滑 SVG 实时速率曲线图（零第三方图表依赖）
 */
function buildSmoothPath(
  values: number[],
  width: number,
  height: number,
  maxVal: number,
  padTop = 10,
  padBottom = 4,
): { linePath: string; areaPath: string } {
  const usableH = height - padTop - padBottom;
  const count = Math.max(values.length, 2);
  const stepX = width / (count - 1);

  const pts = values.map((v, idx) => {
    const ratio = maxVal > 0 ? Math.min(v / maxVal, 1) : 0;
    const x = idx * stepX;
    const y = padTop + usableH * (1 - ratio);
    return { x, y };
  });

  if (pts.length === 0) {
    return { linePath: "", areaPath: "" };
  }

  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const midX = ((prev.x + curr.x) / 2).toFixed(1);
    d += ` C ${midX} ${prev.y.toFixed(1)}, ${midX} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
  }

  const last = pts[pts.length - 1];
  const area = `${d} L ${last.x.toFixed(1)} ${height} L ${pts[0].x.toFixed(1)} ${height} Z`;
  return { linePath: d, areaPath: area };
}

export function DashboardView() {
  const connected = useAppStore((s) => s.connected);
  const connecting = useAppStore((s) => s.connecting);
  const toggleConnection = useAppStore((s) => s.toggleConnection);
  const nodes = useAppStore((s) => s.nodes);
  const selectedOutbound = useAppStore((s) => s.selectedOutbound);
  const autoWinnerNode = useAppStore((s) => s.autoWinnerNode);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setSettingsSubTab = useAppStore((s) => s.setSettingsSubTab);

  const routingMode = useAppStore((s) => s.routingMode);
  const setRoutingMode = useAppStore((s) => s.setRoutingMode);

  const sysProxy = useAppStore((s) => s.sysProxy);
  const toggleSysProxy = useAppStore((s) => s.toggleSysProxy);
  const proxyHijackedBy = useAppStore((s) => s.proxyHijackedBy);
  const reclaimSystemProxy = useAppStore((s) => s.reclaimSystemProxy);
  const tunMode = useAppStore((s) => s.tunMode);
  const toggleTunMode = useAppStore((s) => s.toggleTunMode);

  const terminalShell = useAppStore((s) => s.terminalShell);
  const setTerminalShell = useAppStore((s) => s.setTerminalShell);
  const copyTerminalProxy = useAppStore((s) => s.copyTerminalProxy);

  const forceProxyText = useAppStore((s) => s.forceProxyText);
  const setForceProxyText = useAppStore((s) => s.setForceProxyText);
  const forceDirectText = useAppStore((s) => s.forceDirectText);
  const setForceDirectText = useAppStore((s) => s.setForceDirectText);
  const aiSuiteProxyEnabled = useAppStore((s) => s.aiSuiteProxyEnabled);
  const setAiSuiteProxyEnabled = useAppStore((s) => s.setAiSuiteProxyEnabled);
  const rulesDirty = useAppStore((s) => s.rulesDirty);
  const applyCustomRules = useAppStore((s) => s.applyCustomRules);
  const systemEnvBackup = useAppStore((s) => s.systemEnvBackup);

  const traffic = useTelemetryStore((s) => s.traffic);
  const trafficHistory = useTelemetryStore((s) => s.trafficHistory);
  const connCount = useTelemetryStore((s) => s.connections.length);

  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showEnvModal, setShowEnvModal] = useState(false);

  const proxyRuleCount = useMemo(
    () => countCustomRules(parseCustomRuleLines(forceProxyText)),
    [forceProxyText],
  );

  const directRuleCount = useMemo(
    () => countCustomRules(parseCustomRuleLines(forceDirectText)),
    [forceDirectText],
  );

  const totalCustomRules = proxyRuleCount + directRuleCount;

  const displayMap = useMemo(() => getNodeDisplayMap(nodes), [nodes]);

  const activeNodeDisplay = useMemo(() => {
    if (nodes.length === 0) return "添加节点";
    if (selectedOutbound === "auto") {
      const winnerLabel = resolveNodeDisplayName(
        nodes,
        autoWinnerNode,
        displayMap,
      );
      return winnerLabel ? `自动 · ${winnerLabel}` : "自动选择";
    }
    if (selectedOutbound === "direct") {
      return "直连模式";
    }
    return displayMap.get(selectedOutbound) ?? "自动选择";
  }, [nodes, selectedOutbound, autoWinnerNode, displayMap]);

  const activeLatency = useMemo(() => {
    if (selectedOutbound === "auto") {
      if (!autoWinnerNode) return undefined;
      return nodes.find(
        (n) => n.tag === autoWinnerNode || n.id === autoWinnerNode,
      )?.latency;
    }
    return nodes.find(
      (n) => n.id === selectedOutbound || n.tag === selectedOutbound,
    )?.latency;
  }, [nodes, selectedOutbound, autoWinnerNode]);

  const sparkData = useMemo(() => {
    const hist =
      trafficHistory && trafficHistory.length >= 2
        ? trafficHistory
        : Array.from({ length: 36 }, () => ({ up: 0, down: 0 }));
    const peak = Math.max(
      ...hist.map((h) => Math.max(h.down, h.up)),
      0,
    );
    const scaleMax = Math.max(peak * 1.2, 32 * 1024);
    const down = buildSmoothPath(
      hist.map((h) => h.down),
      360,
      110,
      scaleMax,
    );
    const up = buildSmoothPath(
      hist.map((h) => h.up),
      360,
      110,
      scaleMax,
    );
    return { down, up, peak };
  }, [trafficHistory]);

  const modes: { id: RoutingMode; label: string }[] = [
    { id: "rule", label: "规则分流" },
    { id: "global", label: "全局代理" },
    { id: "direct", label: "全局直连" },
  ];

  const handleSaveRules = async () => {
    const applied = await applyCustomRules();
    if (applied) {
      setShowRulesModal(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4 pl-3 overflow-hidden">
      {/* 1. 顶部对称双栏 Bento 主区（左：居中雕塑感电源卡片；右：实时速率波形卡片，彻底消除留白断层） */}
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
        {/* 左侧主控圆心卡 (5列) */}
        <div className="col-span-5 flex flex-col items-center justify-center rounded-[28px] bg-white px-5 py-5 text-center shadow-[0_2px_18px_rgba(15,23,42,0.03)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
          <div className="relative flex items-center justify-center">
            {connected && (
              <span
                className={`absolute h-[94px] w-[94px] rounded-full opacity-20 blur-md ${
                  tunMode ? "bg-violet-500" : "bg-blue-500"
                }`}
              />
            )}
            <button
              type="button"
              disabled={connecting}
              onClick={() => void toggleConnection()}
              className={`relative flex h-[78px] w-[78px] items-center justify-center rounded-full transition-all duration-200 active:scale-95 cursor-pointer ${
                connecting
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                  : connected
                    ? tunMode
                      ? "bg-violet-600 text-white shadow-lg shadow-violet-600/35 hover:bg-violet-500"
                      : "bg-blue-600 text-white shadow-lg shadow-blue-600/35 hover:bg-blue-500"
                    : "bg-[#F2F4F8] text-slate-400 hover:bg-slate-200/80 hover:text-slate-600 dark:bg-white/[0.07] dark:text-slate-300 dark:hover:bg-white/[0.12]"
              }`}
            >
              {connecting ? (
                <Loader2 className="h-8 w-8 animate-spin" />
              ) : (
                <Power className="h-8 w-8" strokeWidth={2.2} />
              )}
            </button>
          </div>

          <div className="mt-4 flex items-center justify-center gap-2">
            <span className="text-[16px] font-bold tracking-tight text-slate-900 dark:text-white">
              {connecting
                ? "正在连接..."
                : connected
                  ? tunMode
                    ? "TUN 已连接"
                    : sysProxy
                      ? "已连接"
                      : "内核运行中"
                  : "未连接"}
            </span>
            {connected && (
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  tunMode
                    ? "bg-violet-500/12 text-violet-600 dark:text-violet-300"
                    : "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300"
                }`}
              >
                {tunMode ? "LayTun" : "7890"}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setActiveTab("nodes")}
            className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#F4F5F8] px-3.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-200/75 active:scale-[0.98] dark:bg-white/[0.06] dark:text-slate-300 dark:hover:bg-white/[0.1] cursor-pointer"
          >
            <span className="truncate">{activeNodeDisplay}</span>
            {activeLatency !== undefined && activeLatency > 0 && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                {activeLatency}ms
              </span>
            )}
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-45" />
          </button>
        </div>

        {/* 右侧实时流量与曲线卡 (7列) */}
        <div className="col-span-7 flex min-h-0 flex-col justify-between rounded-[28px] bg-white p-4 shadow-[0_2px_18px_rgba(15,23,42,0.03)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
          {/* 顶部速率数值胶囊 */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-5">
              <div className="tabular-nums">
                <div className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
                  <ArrowDown className="h-3.5 w-3.5 text-emerald-500" />
                  <span>下载</span>
                </div>
                <div className="mt-0.5 text-[15px] font-bold text-slate-900 dark:text-white">
                  {formatSpeed(traffic.down)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {formatBytes(traffic.downTotal)}
                </div>
              </div>

              <div className="h-9 w-px bg-slate-100 dark:bg-white/[0.06]" />

              <div className="tabular-nums">
                <div className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
                  <ArrowUp className="h-3.5 w-3.5 text-blue-500" />
                  <span>上传</span>
                </div>
                <div className="mt-0.5 text-[15px] font-bold text-slate-900 dark:text-white">
                  {formatSpeed(traffic.up)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {formatBytes(traffic.upTotal)}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setSettingsSubTab("connections");
                setActiveTab("settings");
              }}
              className="flex items-center gap-1 rounded-full bg-[#F4F5F8] px-2.5 py-1 text-[10px] font-semibold text-slate-500 transition hover:bg-slate-200/75 hover:text-slate-800 dark:bg-white/[0.06] dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer"
            >
              <Activity className="h-3 w-3 text-blue-500" />
              <span>{connected ? `${connCount} 连接` : "待机"}</span>
            </button>
          </div>

          {/* 底部实时速率平滑曲线画布 */}
          <div className="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-[20px] bg-[#F6F7FA] px-2 pt-2 dark:bg-white/[0.03]">
            {sparkData.peak > 0 && (
              <span className="pointer-events-none absolute right-2.5 top-2 font-mono text-[10px] text-slate-400/80">
                峰值 {formatSpeed(sparkData.peak)}
              </span>
            )}
            <svg
              viewBox="0 0 360 110"
              preserveAspectRatio="none"
              className="h-full w-full"
            >
              <defs>
                <linearGradient id="laynetDownGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10B981" stopOpacity="0.26" />
                  <stop offset="100%" stopColor="#10B981" stopOpacity="0.01" />
                </linearGradient>
                <linearGradient id="laynetUpGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              <line
                x1="0"
                y1="38"
                x2="360"
                y2="38"
                stroke="currentColor"
                strokeDasharray="3 4"
                className="text-slate-300/50 dark:text-white/[0.06]"
              />
              <line
                x1="0"
                y1="74"
                x2="360"
                y2="74"
                stroke="currentColor"
                strokeDasharray="3 4"
                className="text-slate-300/50 dark:text-white/[0.06]"
              />

              {/* 上传面积与曲线 */}
              <path d={sparkData.up.areaPath} fill="url(#laynetUpGrad)" />
              <path
                d={sparkData.up.linePath}
                fill="none"
                stroke="#3B82F6"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeOpacity="0.75"
              />

              {/* 下载面积与曲线 */}
              <path d={sparkData.down.areaPath} fill="url(#laynetDownGrad)" />
              <path
                d={sparkData.down.linePath}
                fill="none"
                stroke="#10B981"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* 系统代理被外部软件篡改时的极简胶囊提醒（正常态完全隐藏，零占位） */}
      {proxyHijackedBy && (
        <div className="flex items-center justify-between rounded-full bg-amber-50 px-4 py-1.5 text-xs text-amber-800 ring-1 ring-amber-400/35 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-500/30">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="truncate font-medium">
              系统代理被外部修改（当前：{proxyHijackedBy}）
            </span>
          </div>
          <button
            type="button"
            onClick={() => void reclaimSystemProxy()}
            className="ml-2 flex shrink-0 items-center gap-1 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-600 active:scale-95 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            <span>一键恢复</span>
          </button>
        </div>
      )}

      {/* 2. 全圆角三档分流胶囊滑块 */}
      <div className="grid grid-cols-3 gap-1.5 rounded-full bg-white p-1.5 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
        {modes.map((m) => {
          const active = routingMode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => void setRoutingMode(m.id)}
              className={`rounded-full py-2 text-xs font-semibold transition-all duration-200 active:scale-[0.98] cursor-pointer ${
                active
                  ? "bg-slate-900 text-white shadow-xs dark:bg-blue-600 dark:text-white"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* 3. 流量接管三件套 */}
      <div className="grid grid-cols-3 gap-3">
        {/* 系统代理 */}
        <div
          onClick={() => void toggleSysProxy()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") void toggleSysProxy();
          }}
          className="flex items-center justify-between rounded-[24px] bg-white px-4 py-3 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                sysProxy
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400"
              }`}
            >
              <Globe className="h-4 w-4" />
            </div>
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
              系统代理
            </span>
          </div>

          <div
            className={`h-5.5 w-10 rounded-full p-0.5 transition-colors ${
              sysProxy ? "bg-blue-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4.5 w-4.5 rounded-full bg-white shadow-xs transition-transform duration-200 ${
                sysProxy ? "translate-x-4.5" : "translate-x-0"
              }`}
            />
          </div>
        </div>

        {/* TUN 模式 */}
        <div
          onClick={() => void toggleTunMode()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") void toggleTunMode();
          }}
          className="flex items-center justify-between rounded-[24px] bg-white px-4 py-3 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] transition hover:ring-black/[0.08] active:scale-[0.99] dark:bg-[#14171F] dark:ring-white/[0.06] cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                tunMode
                  ? "bg-violet-600 text-white"
                  : "bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400"
              }`}
            >
              <Network className="h-4 w-4" />
            </div>
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
              TUN 模式
            </span>
          </div>

          <div
            className={`h-5.5 w-10 rounded-full p-0.5 transition-colors ${
              tunMode ? "bg-violet-600" : "bg-slate-200 dark:bg-white/[0.12]"
            }`}
          >
            <div
              className={`h-4.5 w-4.5 rounded-full bg-white shadow-xs transition-transform duration-200 ${
                tunMode ? "translate-x-4.5" : "translate-x-0"
              }`}
            />
          </div>
        </div>

        {/* 终端代理复制 */}
        <div className="flex items-center justify-between rounded-[24px] bg-white px-3.5 py-3 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
          <button
            type="button"
            onClick={() => void copyTerminalProxy()}
            className="group flex flex-1 items-center gap-2.5 text-left active:scale-[0.98] cursor-pointer"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition group-hover:bg-slate-900 group-hover:text-white dark:bg-white/[0.06] dark:text-slate-300 dark:group-hover:bg-blue-600">
              <Terminal className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <span>终端命令</span>
              <Copy className="h-3 w-3 opacity-45" />
            </div>
          </button>

          <div className="flex rounded-full bg-slate-100 p-0.5 text-[10px] font-semibold dark:bg-white/[0.06]">
            {(["powershell", "cmd"] as const).map((sh) => (
              <button
                key={sh}
                type="button"
                onClick={() => setTerminalShell(sh)}
                className={`rounded-full px-2 py-0.5 transition cursor-pointer ${
                  terminalShell === sh
                    ? "bg-white text-slate-900 shadow-2xs dark:bg-white/15 dark:text-white"
                    : "text-slate-400"
                }`}
              >
                {sh === "powershell" ? "PS" : "CMD"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 底部双胶囊工具条：自定义分流规则 + 环境一致性检测 */}
      <div className="grid grid-cols-12 gap-3">
        <button
          type="button"
          onClick={() => setShowRulesModal(true)}
          className="col-span-7 flex items-center justify-between rounded-full bg-white px-4 py-2.5 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] transition hover:ring-black/[0.09] active:scale-[0.995] dark:bg-[#14171F] dark:ring-white/[0.06] dark:hover:ring-white/[0.12] cursor-pointer"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
              <ListFilter className="h-3.5 w-3.5" />
            </div>
            <span className="shrink-0 text-xs font-semibold text-slate-800 dark:text-slate-100">
              自定义分流规则
            </span>
            {totalCustomRules > 0 ? (
              <div className="flex items-center gap-1.5 overflow-hidden">
                {proxyRuleCount > 0 && (
                  <span className="shrink-0 rounded-full bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                    代理 {proxyRuleCount}
                  </span>
                )}
                {directRuleCount > 0 && (
                  <span className="shrink-0 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    直连 {directRuleCount}
                  </span>
                )}
              </div>
            ) : (
              <span className="truncate text-[11px] text-slate-400">
                {aiSuiteProxyEnabled ? "智能分流 · AI 加速" : "默认智能分流"}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-slate-400">
            <span>{rulesDirty ? "待应用" : "编辑"}</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setShowEnvModal(true)}
          className="col-span-5 flex items-center justify-between rounded-full bg-white px-4 py-2.5 shadow-[0_2px_12px_rgba(15,23,42,0.02)] ring-1 ring-black/[0.04] transition hover:ring-black/[0.09] active:scale-[0.995] dark:bg-[#14171F] dark:ring-white/[0.06] dark:hover:ring-white/[0.12] cursor-pointer"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
              <Compass className="h-3.5 w-3.5" />
            </div>
            <span className="shrink-0 text-xs font-semibold text-slate-800 dark:text-slate-100">
              环境检测
            </span>
            {systemEnvBackup ? (
              <span className="truncate rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                已修改 · 可还原
              </span>
            ) : (
              <span className="truncate text-[11px] text-slate-400">
                时区 / 语言
              </span>
            )}
          </div>

          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        </button>
      </div>

      <EnvCheckModal
        open={showEnvModal}
        onClose={() => setShowEnvModal(false)}
      />

      {/* 按需弹出的圆角自定义分流编辑窗 */}
      {showRulesModal && (
        <div
          onClick={() => setShowRulesModal(false)}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-[440px] w-[600px] flex-col rounded-[28px] bg-white p-5 shadow-2xl ring-1 ring-black/[0.05] dark:bg-[#161922] dark:ring-white/[0.08]"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  自定义分流
                </h3>
                <span className="text-[11px] text-slate-400">
                  支持域名、CIDR、Clash 语法、.exe 进程（忽略大小写；非系统代理应用需开 TUN）· 直连优先
                </span>
              </div>

              <button
                type="button"
                onClick={() => setShowRulesModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
              <div className="flex min-h-0 flex-col rounded-[20px] bg-[#F6F7FA] p-3 dark:bg-white/[0.04]">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    强制代理
                  </span>
                  {proxyRuleCount > 0 && (
                    <span className="rounded-full bg-blue-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                      {proxyRuleCount}
                    </span>
                  )}
                </div>
                <textarea
                  value={forceProxyText}
                  onChange={(e) => setForceProxyText(e.target.value)}
                  spellCheck={false}
                  placeholder={"openai.com\n1.1.1.1/32\nfull:api.example.com\ncursor.exe"}
                  className="min-h-0 flex-1 resize-none bg-transparent px-1 font-mono text-xs leading-relaxed text-slate-800 placeholder:text-slate-400/60 focus:outline-none dark:text-slate-200 dark:placeholder:text-slate-600"
                />
              </div>

              <div className="flex min-h-0 flex-col rounded-[20px] bg-[#F6F7FA] p-3 dark:bg-white/[0.04]">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    强制直连
                  </span>
                  {directRuleCount > 0 && (
                    <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                      {directRuleCount}
                    </span>
                  )}
                </div>
                <textarea
                  value={forceDirectText}
                  onChange={(e) => setForceDirectText(e.target.value)}
                  spellCheck={false}
                  placeholder={"qq.com\n10.8.0.0/16\nkeyword:corp\nWeChat.exe"}
                  className="min-h-0 flex-1 resize-none bg-transparent px-1 font-mono text-xs leading-relaxed text-slate-800 placeholder:text-slate-400/60 focus:outline-none dark:text-slate-200 dark:placeholder:text-slate-600"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setAiSuiteProxyEnabled(!aiSuiteProxyEnabled)}
              className="mt-3 flex items-center justify-between rounded-[18px] bg-[#F6F7FA] px-3.5 py-2 text-left transition hover:bg-slate-200/60 dark:bg-white/[0.04] dark:hover:bg-white/[0.07] cursor-pointer"
            >
              <div className="min-w-0 pr-3">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  内置 AI 套件加速
                </div>
                <div className="truncate text-[10px] text-slate-400">
                  AI 核心域名强制代理防掉登录 · 专属进程访问国内直连、海外自动代理
                </div>
              </div>
              <div
                className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
                  aiSuiteProxyEnabled
                    ? "bg-blue-600"
                    : "bg-slate-200 dark:bg-white/[0.12]"
                }`}
              >
                <div
                  className={`h-4 w-4 rounded-full bg-white shadow-2xs transition-transform ${
                    aiSuiteProxyEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </button>

            <div className="mt-3.5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRulesModal(false)}
                className="rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-200/80 active:scale-95 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => void handleSaveRules()}
                className="flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-500 active:scale-95 cursor-pointer"
              >
                <Check className="h-3.5 w-3.5" />
                <span>{rulesDirty ? "保存并生效" : "保存"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
