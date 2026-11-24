import {
  ArrowUpDown,
  Check,
  ClipboardPaste,
  Copy,
  Gauge,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../lib/formatters";
import { resolveHy2CongestionControl } from "../lib/configBuilder";
import { writeClipboardText } from "../lib/tauriBridge";
import { getNodeDisplayMap, resolveNodeDisplayName } from "../lib/uriParser";
import { useAppStore } from "../store/useAppStore";
import type { ProxyNode } from "../types/proxy";

function getNodeBadge(node: ProxyNode): { label: string; color: string } {
  if (node.protocol === "vless") {
    if (node.vless?.reality) {
      return {
        label: "REALITY",
        color:
          "bg-indigo-500/12 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300",
      };
    }
    return {
      label: "VLESS",
      color:
        "bg-blue-500/12 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300",
    };
  }
  if (node.protocol === "hysteria2") {
    return {
      label: "HY2",
      color:
        "bg-violet-500/12 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300",
    };
  }
  if (node.protocol === "shadowsocks") {
    return {
      label: "SS",
      color:
        "bg-cyan-500/12 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300",
    };
  }
  return {
    label: "TROJAN",
    color:
      "bg-amber-500/12 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  };
}

function formatMportForDisplay(ports?: string[]): string {
  if (!ports || ports.length === 0) return "";
  return ports
    .map((p) => {
      const [a, b] = p.split(":");
      return a && b && a === b ? a : p.replace(":", "-");
    })
    .join(",");
}

export function NodesView() {
  const nodes = useAppStore((s) => s.nodes);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const selectedOutbound = useAppStore((s) => s.selectedOutbound);
  const autoWinnerNode = useAppStore((s) => s.autoWinnerNode);
  const batchTesting = useAppStore((s) => s.batchTesting);

  const selectOutbound = useAppStore((s) => s.selectOutbound);
  const importFromClipboard = useAppStore((s) => s.importFromClipboard);
  const importRawLinks = useAppStore((s) => s.importRawLinks);
  const updateNodeConfig = useAppStore((s) => s.updateNodeConfig);
  const sortNodesByLatency = useAppStore((s) => s.sortNodesByLatency);
  const removeNode = useAppStore((s) => s.removeNode);
  const clearAllNodes = useAppStore((s) => s.clearAllNodes);
  const addSubscription = useAppStore((s) => s.addSubscription);
  const refreshSubscription = useAppStore((s) => s.refreshSubscription);
  const refreshAllSubscriptions = useAppStore((s) => s.refreshAllSubscriptions);
  const removeSubscription = useAppStore((s) => s.removeSubscription);
  const testSingleNodeDelay = useAppStore((s) => s.testSingleNodeDelay);
  const testAllNodesDelay = useAppStore((s) => s.testAllNodesDelay);
  const pushToast = useAppStore((s) => s.pushToast);
  const brutalDownMbps = useAppStore((s) => s.brutalDownMbps);
  const brutalUpMbps = useAppStore((s) => s.brutalUpMbps);

  const [showSubDrawer, setShowSubDrawer] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [subName, setSubName] = useState("");
  const [subUrl, setSubUrl] = useState("");
  const [subLoading, setSubLoading] = useState(false);
  const [manualText, setManualText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  // 节点快速编辑弹窗状态
  const [editingNode, setEditingNode] = useState<ProxyNode | null>(null);
  const [editName, setEditName] = useState("");
  const [editDownMbps, setEditDownMbps] = useState("");
  const [editUpMbps, setEditUpMbps] = useState("");
  const [editMport, setEditMport] = useState("");

  const openEditModal = (node: ProxyNode) => {
    setEditingNode(node);
    setEditName(node.name);
    setEditDownMbps(
      node.hysteria2?.downMbps ? String(node.hysteria2.downMbps) : "",
    );
    setEditUpMbps(node.hysteria2?.upMbps ? String(node.hysteria2.upMbps) : "");
    setEditMport(formatMportForDisplay(node.hysteria2?.serverPorts));
  };

  const handleSaveEdit = async () => {
    if (!editingNode) return;
    const downNum = Number(editDownMbps);
    const upNum = Number(editUpMbps);
    const targetId = editingNode.id;
    setEditingNode(null);
    await updateNodeConfig(targetId, {
      name: editName,
      downMbps: Number.isFinite(downNum) && downNum > 0 ? downNum : undefined,
      upMbps: Number.isFinite(upNum) && upNum > 0 ? upNum : undefined,
      mport: editMport,
    });
  };

  const handleAddSub = async () => {
    if (!subUrl.trim() || subLoading) return;
    setSubLoading(true);
    try {
      await addSubscription(subName, subUrl);
      setSubName("");
      setSubUrl("");
    } finally {
      setSubLoading(false);
    }
  };

  const displayMap = useMemo(() => getNodeDisplayMap(nodes), [nodes]);
  const autoWinnerDisplay = useMemo(
    () => resolveNodeDisplayName(nodes, autoWinnerNode, displayMap),
    [nodes, autoWinnerNode, displayMap],
  );
  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((node) => {
      const label = (displayMap.get(node.id) ?? node.name).toLowerCase();
      return (
        label.includes(q) ||
        node.server.toLowerCase().includes(q) ||
        node.protocol.toLowerCase().includes(q)
      );
    });
  }, [nodes, searchQuery, displayMap]);

  const handleManualImport = async () => {
    const count = await importRawLinks(manualText);
    if (count > 0) {
      pushToast("success", `成功导入 ${count} 个节点`);
      setManualText("");
      setShowManualModal(false);
    } else if (count === 0) {
      pushToast("error", "未识别到有效节点");
    } else if (count === -1) {
      setShowManualModal(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4 pl-3 overflow-hidden">
      {/* 顶部全胶囊工具栏 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void importFromClipboard()}
            className="flex items-center gap-1.5 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-slate-800 active:scale-95 dark:bg-blue-600 dark:hover:bg-blue-500 cursor-pointer"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>导入剪贴板</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSubDrawer((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition active:scale-95 cursor-pointer ${
              showSubDrawer
                ? "bg-blue-600 text-white shadow-xs"
                : "bg-white text-slate-600 ring-1 ring-black/[0.05] hover:bg-slate-50 dark:bg-[#14171F] dark:text-slate-300 dark:ring-white/[0.06]"
            }`}
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>
              订阅{subscriptions.length > 0 ? ` · ${subscriptions.length}` : ""}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setShowManualModal(true)}
            className="flex items-center gap-1 rounded-full bg-white px-3.5 py-2 text-xs font-medium text-slate-600 ring-1 ring-black/[0.05] transition hover:bg-slate-50 active:scale-95 dark:bg-[#14171F] dark:text-slate-300 dark:ring-white/[0.06] cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>粘贴</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {nodes.length > 0 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="筛选节点..."
                className="w-28 rounded-full bg-white py-2 pl-7.5 pr-6 text-xs text-slate-700 ring-1 ring-black/[0.05] transition focus:w-36 focus:outline-none focus:ring-2 focus:ring-blue-500/35 dark:bg-[#14171F] dark:text-slate-200 dark:ring-white/[0.06]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={batchTesting || nodes.length === 0}
            onClick={() => void testAllNodesDelay()}
            className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-xs font-semibold text-emerald-600 ring-1 ring-black/[0.05] transition hover:bg-emerald-50/60 active:scale-95 disabled:opacity-45 dark:bg-[#14171F] dark:text-emerald-400 dark:ring-white/[0.06] cursor-pointer"
          >
            {batchTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Gauge className="h-3.5 w-3.5" />
            )}
            <span>测速</span>
          </button>

          {nodes.length > 1 && (
            <button
              type="button"
              onClick={sortNodesByLatency}
              title="按延迟由低到高排序"
              className="flex items-center gap-1 rounded-full bg-white px-3 py-2 text-xs font-medium text-slate-600 ring-1 ring-black/[0.05] transition hover:bg-slate-50 active:scale-95 dark:bg-[#14171F] dark:text-slate-300 dark:ring-white/[0.06] cursor-pointer"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              <span>排序</span>
            </button>
          )}

          {nodes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                setConfirmClear(false);
                void clearAllNodes();
              }}
              title={
                confirmClear
                  ? "再次点击确认清空全部节点与订阅"
                  : "清空全部节点与订阅"
              }
              className={`flex items-center justify-center rounded-full transition active:scale-95 cursor-pointer ${
                confirmClear
                  ? "bg-rose-600 px-3 py-2 text-xs font-semibold text-white shadow-xs hover:bg-rose-500"
                  : "h-8.5 w-8.5 bg-white text-slate-400 ring-1 ring-black/[0.05] hover:bg-rose-50 hover:text-rose-500 dark:bg-[#14171F] dark:ring-white/[0.06] dark:hover:bg-rose-950/30"
              }`}
            >
              {confirmClear ? (
                <span>确认清空</span>
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* 圆角订阅管理抽屉 */}
      {showSubDrawer && (
        <div className="rounded-[24px] bg-white p-3.5 shadow-[0_2px_16px_rgba(15,23,42,0.03)] ring-1 ring-black/[0.04] dark:bg-[#14171F] dark:ring-white/[0.06]">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={subName}
              onChange={(e) => setSubName(e.target.value)}
              placeholder="名称"
              className="w-24 rounded-full bg-[#F4F5F8] px-3.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
            />
            <input
              type="url"
              value={subUrl}
              onChange={(e) => setSubUrl(e.target.value)}
              placeholder="https:// 订阅链接"
              className="flex-1 rounded-full bg-[#F4F5F8] px-3.5 py-1.5 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
            />
            <button
              type="button"
              disabled={subLoading || !subUrl.trim()}
              onClick={() => void handleAddSub()}
              className="flex items-center gap-1 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 active:scale-95 disabled:opacity-45 cursor-pointer"
            >
              {subLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span>保存</span>
            </button>
            {subscriptions.length > 0 && (
              <button
                type="button"
                onClick={() => void refreshAllSubscriptions(false)}
                title="全部更新"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F4F5F8] text-slate-500 hover:text-slate-800 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {subscriptions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5 max-h-14 overflow-y-auto">
              {subscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center gap-1.5 rounded-full bg-[#F4F5F8] px-3 py-1 text-[11px] dark:bg-white/[0.05]"
                >
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    {sub.name}
                  </span>
                  <span className="rounded-full bg-blue-500/12 px-1.5 font-mono text-[10px] text-blue-600 dark:text-blue-300">
                    {sub.nodeCount}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {formatRelativeTime(sub.updatedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshSubscription(sub.id, false)}
                    className="rounded-full p-0.5 text-slate-400 hover:text-blue-500 cursor-pointer"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeSubscription(sub.id)}
                    className="rounded-full p-0.5 text-slate-400 hover:text-rose-500 cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 节点卡片列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 space-y-2">
        {/* 置顶自动选择卡片 */}
        <div
          onClick={() => void selectOutbound("auto")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") void selectOutbound("auto");
          }}
          className={`flex items-center justify-between rounded-[22px] px-4 py-3 transition-all cursor-pointer ${
            selectedOutbound === "auto"
              ? "bg-white ring-2 ring-blue-600 shadow-xs dark:bg-[#14171F] dark:ring-blue-500"
              : "bg-white ring-1 ring-black/[0.04] hover:ring-black/[0.09] dark:bg-[#14171F] dark:ring-white/[0.06]"
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full ${
                selectedOutbound === "auto"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400"
              }`}
            >
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                自动选择
              </div>
              <div className="text-[11px] text-slate-400">
                {autoWinnerDisplay
                  ? `当前最优 · ${autoWinnerDisplay}`
                  : "智能切换最低延迟节点"}
              </div>
            </div>
          </div>

          {selectedOutbound === "auto" && (
            <span className="flex h-5.5 w-5.5 items-center justify-center rounded-full bg-blue-600 text-white">
              <Check className="h-3 w-3" strokeWidth={2.5} />
            </span>
          )}
        </div>

        {/* 空状态 */}
        {nodes.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-[26px] bg-white/60 text-center ring-1 ring-black/[0.03] dark:bg-[#14171F]/50 dark:ring-white/[0.04]">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-white/[0.05]">
              <ClipboardPaste className="h-5 w-5" />
            </div>
            <p className="mt-3 text-xs font-semibold text-slate-600 dark:text-slate-300">
              还没有节点
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              复制分享链接或订阅后，点击左上角「导入剪贴板」
            </p>
          </div>
        ) : filteredNodes.length === 0 ? (
          <div className="flex h-44 flex-col items-center justify-center rounded-[26px] bg-white/60 text-center ring-1 ring-black/[0.03] dark:bg-[#14171F]/50 dark:ring-white/[0.04]">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              未找到匹配「{searchQuery}」的节点
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {filteredNodes.map((node) => {
              const badge = getNodeBadge(node);
              const isSelected = selectedOutbound === node.id;
              const displayName = displayMap.get(node.id) ?? node.name;

              const latencyPill = (() => {
                if (node.testing) {
                  return (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                  );
                }
                if (node.latency === undefined) {
                  return (
                    <span className="text-[10px] text-slate-400">测速</span>
                  );
                }
                if (node.latency < 0) {
                  return (
                    <span className="text-[10px] font-semibold text-rose-500">
                      超时
                    </span>
                  );
                }
                const color =
                  node.latency < 160
                    ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                    : node.latency < 380
                      ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                      : "bg-orange-500/12 text-orange-600 dark:text-orange-400";
                return (
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${color}`}
                  >
                    {node.latency}ms
                  </span>
                );
              })();

              return (
                <div
                  key={node.id}
                  onClick={() => void selectOutbound(node.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void selectOutbound(node.id);
                  }}
                  className={`group flex items-center justify-between rounded-[22px] px-4 py-3 transition-all cursor-pointer ${
                    isSelected
                      ? "bg-white ring-2 ring-blue-600 shadow-xs dark:bg-[#14171F] dark:ring-blue-500"
                      : "bg-white ring-1 ring-black/[0.04] hover:ring-black/[0.09] dark:bg-[#14171F] dark:ring-white/[0.06]"
                  }`}
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold ${badge.color}`}
                      >
                        {badge.label}
                      </span>
                      <span className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {displayName}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-slate-400">
                      {node.server}:{node.serverPort}
                      {node.hysteria2?.serverPorts?.length
                        ? ` · 跳跃`
                        : ""}
                      {node.protocol === "hysteria2" &&
                        (() => {
                          const cc = resolveHy2CongestionControl(
                            node,
                            brutalDownMbps,
                            brutalUpMbps,
                          );
                          return cc.mode === "brutal" ? (
                            <span
                              title={
                                cc.source === "node"
                                  ? "Brutal 拥塞控制，带宽来自节点链接"
                                  : "Brutal 拥塞控制，带宽来自设置页「HY2 默认带宽」"
                              }
                            >
                              {` · ↓${cc.downMbps}/↑${cc.upMbps}M`}
                            </span>
                          ) : (
                            <span title="BBR 自适应拥塞控制">{" · BBR"}</span>
                          );
                        })()}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void testSingleNodeDelay(node.id);
                      }}
                      title="测试延迟"
                      className="rounded-full px-1.5 py-1 transition hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
                    >
                      {latencyPill}
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditModal(node);
                      }}
                      title="编辑节点参数"
                      className="hidden h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 group-hover:flex dark:hover:bg-white/[0.08] dark:hover:text-slate-200 cursor-pointer"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void writeClipboardText(node.rawUri)
                          .then(() => pushToast("success", "已复制链接"))
                          .catch(() => pushToast("error", "复制链接失败"));
                      }}
                      title="复制链接"
                      className="hidden h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 group-hover:flex dark:hover:bg-white/[0.08] dark:hover:text-slate-200 cursor-pointer"
                    >
                      <Copy className="h-3 w-3" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeNode(node.id);
                      }}
                      title="删除"
                      className="hidden h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-rose-50 hover:text-rose-500 group-hover:flex dark:hover:bg-rose-950/40 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 圆角粘贴弹窗 */}
      {showManualModal && (
        <div
          onClick={() => setShowManualModal(false)}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[440px] rounded-[28px] bg-white p-5 shadow-2xl ring-1 ring-black/[0.05] dark:bg-[#161922] dark:ring-white/[0.08]"
          >
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              粘贴节点或订阅内容
            </h3>
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder={
                "vless://...\nhy2://...\nss://...\ntrojan://...\n或 Base64 订阅文本"
              }
              className="mt-3 w-full rounded-[20px] bg-[#F4F5F8] p-3 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.05] dark:text-slate-200"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowManualModal(false)}
                className="rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-200/80 active:scale-95 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleManualImport()}
                className="rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 active:scale-95 cursor-pointer"
              >
                导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 节点快速编辑圆角弹窗 */}
      {editingNode && (
        <div
          onClick={() => setEditingNode(null)}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[380px] rounded-[28px] bg-white p-5 shadow-2xl ring-1 ring-black/[0.05] dark:bg-[#161922] dark:ring-white/[0.08]"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                编辑节点
              </h3>
              <button
                type="button"
                onClick={() => setEditingNode(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3.5 space-y-3">
              <div>
                <label className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  备注名称
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-full bg-[#F4F5F8] px-3.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
                />
              </div>

              {editingNode.protocol === "hysteria2" && (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        下行限速 (Mbps)
                      </label>
                      <input
                        type="number"
                        min={0}
                        placeholder="留空用全局"
                        value={editDownMbps}
                        onChange={(e) => setEditDownMbps(e.target.value)}
                        className="w-full rounded-full bg-[#F4F5F8] px-3.5 py-2 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        上行限速 (Mbps)
                      </label>
                      <input
                        type="number"
                        min={0}
                        placeholder="留空用全局"
                        value={editUpMbps}
                        onChange={(e) => setEditUpMbps(e.target.value)}
                        className="w-full rounded-full bg-[#F4F5F8] px-3.5 py-2 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      端口跳跃 (mport，如 20000-50000)
                    </label>
                    <input
                      type="text"
                      placeholder="留空使用单端口"
                      value={editMport}
                      onChange={(e) => setEditMport(e.target.value)}
                      className="w-full rounded-full bg-[#F4F5F8] px-3.5 py-2 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:bg-white/[0.06] dark:text-slate-100"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingNode(null)}
                className="rounded-full bg-slate-100 px-4 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-200/80 active:scale-95 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                className="flex items-center gap-1 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 active:scale-95 cursor-pointer"
              >
                <Check className="h-3.5 w-3.5" />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
