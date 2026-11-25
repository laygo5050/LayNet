import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Languages,
  Loader2,
  RefreshCw,
  RotateCcw,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { evaluateEnvConsistency, probeProxyGeo } from "../lib/envCheck";
import {
  getSystemEnvInfo,
  launchLocalizedBrowser,
  setSystemLanguages,
  setSystemTimezone,
} from "../lib/tauriBridge";
import { useAppStore } from "../store/useAppStore";
import type { EnvCheckReport, SystemEnvInfo } from "../types/proxy";

interface EnvCheckModalProps {
  open: boolean;
  onClose: () => void;
}

export function EnvCheckModal({ open, onClose }: EnvCheckModalProps) {
  const connected = useAppStore((s) => s.connected);
  const systemEnvBackup = useAppStore((s) => s.systemEnvBackup);
  const setSystemEnvBackup = useAppStore((s) => s.setSystemEnvBackup);
  const pushToast = useAppStore((s) => s.pushToast);

  const [checking, setChecking] = useState(false);
  const [busyAction, setBusyAction] = useState<
    null | "fix-all" | "fix-tz" | "fix-lang" | "restore" | "browser"
  >(null);
  const [localEnv, setLocalEnv] = useState<SystemEnvInfo | null>(null);
  const [report, setReport] = useState<EnvCheckReport | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setErrorMsg(null);
    try {
      const env = await getSystemEnvInfo();
      setLocalEnv(env);
      if (!connected) {
        setReport(null);
        return;
      }
      const geo = await probeProxyGeo();
      setReport(evaluateEnvConsistency(geo, env));
    } catch (err) {
      setReport(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [connected]);

  useEffect(() => {
    if (!open) return;
    void runCheck();
  }, [open, runCheck]);

  if (!open) return null;

  const refreshLocalAfterMutation = async (
    nextLocal: SystemEnvInfo,
    currentReport: EnvCheckReport | null,
  ) => {
    setLocalEnv(nextLocal);
    if (currentReport) {
      setReport(evaluateEnvConsistency(currentReport.proxyGeo, nextLocal));
    }
  };

  const applyFix = async (mode: "fix-all" | "fix-tz" | "fix-lang") => {
    if (!report) return;
    const needTz =
      (mode === "fix-all" || mode === "fix-tz") &&
      !report.timezoneMatch &&
      Boolean(report.targetWindowsTimezone);
    const needLang =
      (mode === "fix-all" || mode === "fix-lang") && !report.languageMatch;

    if (!needTz && !needLang) {
      pushToast("info", "当前已与代理地区一致，无需修复");
      return;
    }

    setBusyAction(mode);
    try {
      const baseline = localEnv ?? (await getSystemEnvInfo());
      let mutated = false;
      const errors: string[] = [];

      if (needTz && report.targetWindowsTimezone) {
        try {
          await setSystemTimezone(report.targetWindowsTimezone);
          mutated = true;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (needLang) {
        try {
          await setSystemLanguages([report.recommendedLanguage], false);
          mutated = true;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (mutated && !systemEnvBackup) {
        setSystemEnvBackup({
          windowsTimezone: baseline.windowsTimezone,
          languages: baseline.languages,
          savedAt: Date.now(),
        });
      }

      const updatedLocal = await getSystemEnvInfo();
      await refreshLocalAfterMutation(updatedLocal, report);

      if (errors.length === 0) {
        pushToast(
          "success",
          mode === "fix-tz"
            ? `系统时区已切换为 ${report.targetWindowsTimezone}`
            : mode === "fix-lang"
              ? `系统首选语言已设为 ${report.recommendedLanguage}`
              : "时区与首选语言已一键对齐代理地区",
        );
      } else if (mutated) {
        pushToast("error", `部分修复成功，但有错误：${errors.join("；")}`);
      } else {
        pushToast("error", errors.join("；"));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestore = async () => {
    if (!systemEnvBackup) return;
    setBusyAction("restore");
    try {
      const errors: string[] = [];
      const current = localEnv ?? (await getSystemEnvInfo());

      if (
        current.windowsTimezone.trim().toLowerCase() !==
        systemEnvBackup.windowsTimezone.trim().toLowerCase()
      ) {
        try {
          await setSystemTimezone(systemEnvBackup.windowsTimezone);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (systemEnvBackup.languages.length > 0) {
        try {
          await setSystemLanguages(systemEnvBackup.languages, true);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      const updatedLocal = await getSystemEnvInfo();
      await refreshLocalAfterMutation(updatedLocal, report);

      if (errors.length === 0) {
        setSystemEnvBackup(null);
        pushToast("success", "已还原修复前的系统时区与语言设置");
      } else {
        pushToast("error", `还原未完全成功：${errors.join("；")}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleLaunchBrowser = async () => {
    if (!report) return;
    setBusyAction("browser");
    try {
      const browserName = await launchLocalizedBrowser(
        report.recommendedLanguage,
        "https://whoer.net/",
      );
      pushToast(
        "success",
        `已启动 ${report.recommendedLanguage} 隔离 ${browserName} 窗口`,
      );
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const allMatched = Boolean(
    report && report.timezoneMatch && report.languageMatch,
  );
  const canFixAny = Boolean(
    report &&
      ((!report.timezoneMatch && report.targetWindowsTimezone) ||
        !report.languageMatch),
  );
  const browserLabel = localEnv?.detectedBrowser ?? "浏览器";
  const locationText = report
    ? [report.proxyGeo.countryName, report.proxyGeo.region, report.proxyGeo.city]
        .filter((part, idx, arr) => Boolean(part) && arr.indexOf(part) === idx)
        .join(" · ")
    : "";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-[620px] max-w-[92vw] flex-col rounded-[28px] bg-white p-5 shadow-2xl ring-1 ring-black/[0.05] dark:bg-[#161922] dark:ring-white/[0.08]"
      >
        {/* 顶栏 */}
        <div className="mb-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              代理环境一致性检测
            </h3>
            {report && !checking && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                  allMatched
                    ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                }`}
              >
                {allMatched ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                <span>{allMatched ? "全部一致" : "存在不一致"}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={checking || busyAction !== null}
              onClick={() => void runCheck()}
              className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-200/80 disabled:opacity-45 dark:bg-white/[0.06] dark:text-slate-300 cursor-pointer"
            >
              <RefreshCw
                className={`h-3 w-3 ${checking ? "animate-spin" : ""}`}
              />
              <span>{checking ? "检测中" : "重新检测"}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 代理出口信息条 */}
        {!connected ? (
          <div className="mb-3 flex items-center gap-2.5 rounded-[20px] bg-[#F6F7FA] px-4 py-3 text-xs text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
            <Globe className="h-4 w-4 shrink-0 text-slate-400" />
            <span>
              当前未连接代理节点，请先点击连接后再检测出口 IP 所在地区。
            </span>
          </div>
        ) : checking && !report ? (
          <div className="mb-3 flex items-center gap-2.5 rounded-[20px] bg-[#F6F7FA] px-4 py-3 text-xs text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
            <span>正在经由本地代理探测出口 IP 所在地区与时区...</span>
          </div>
        ) : errorMsg ? (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-[20px] bg-rose-50 px-4 py-3 text-xs text-rose-700 ring-1 ring-rose-500/20 dark:bg-rose-950/30 dark:text-rose-300">
            <span className="truncate">{errorMsg}</span>
            <button
              type="button"
              onClick={() => void runCheck()}
              className="shrink-0 rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-rose-500 cursor-pointer"
            >
              重试
            </button>
          </div>
        ) : report ? (
          <div className="mb-3 flex items-center justify-between rounded-[20px] bg-[#F6F7FA] px-4 py-2.5 dark:bg-white/[0.04]">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600/12 text-blue-600 dark:text-blue-400">
                <Globe className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                    {report.proxyGeo.ip}
                  </span>
                  <span className="rounded-full bg-slate-200/80 px-2 py-0.2 font-mono text-[10px] font-semibold text-slate-600 dark:bg-white/[0.08] dark:text-slate-300">
                    {report.proxyGeo.countryCode}
                  </span>
                </div>
                <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {locationText || "未知地区"}
                </div>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-white px-2.5 py-1 font-mono text-[10px] text-slate-400 ring-1 ring-black/[0.04] dark:bg-white/[0.05] dark:ring-white/[0.06]">
              via {report.proxyGeo.provider}
            </span>
          </div>
        ) : null}

        {/* 时区 & 语言双列对比卡 */}
        <div className="grid grid-cols-2 gap-3">
          {/* 时区卡 */}
          <div className="flex flex-col justify-between rounded-[22px] bg-[#F6F7FA] p-3.5 dark:bg-white/[0.04]">
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <Clock className="h-3.5 w-3.5 text-blue-500" />
                  <span>系统时区</span>
                </div>
                {report && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      report.timezoneMatch
                        ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {report.timezoneMatch ? "一致" : "不一致"}
                  </span>
                )}
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">本机当前</span>
                  <span className="truncate font-mono font-medium text-slate-700 dark:text-slate-200">
                    {localEnv?.windowsTimezone ?? "读取中..."}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">代理目标</span>
                  <span className="truncate font-mono font-medium text-slate-700 dark:text-slate-200">
                    {report
                      ? report.targetWindowsTimezone ??
                        `${report.proxyGeo.ianaTimezone} (未映射)`
                      : "—"}
                  </span>
                </div>
                {report && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">IANA</span>
                    <span className="truncate font-mono text-[10px] text-slate-400">
                      {report.proxyGeo.ianaTimezone}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {report && !report.timezoneMatch && report.targetWindowsTimezone && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void applyFix("fix-tz")}
                className="mt-3 flex w-full items-center justify-center gap-1 rounded-full bg-white py-1.5 text-[11px] font-semibold text-slate-700 ring-1 ring-black/[0.06] transition hover:bg-slate-100 disabled:opacity-45 dark:bg-white/[0.08] dark:text-slate-200 dark:ring-white/[0.08] cursor-pointer"
              >
                {busyAction === "fix-tz" && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                <span>仅修时区</span>
              </button>
            )}
          </div>

          {/* 语言卡 */}
          <div className="flex flex-col justify-between rounded-[22px] bg-[#F6F7FA] p-3.5 dark:bg-white/[0.04]">
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <Languages className="h-3.5 w-3.5 text-violet-500" />
                  <span>系统首选语言</span>
                </div>
                {report && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      report.languageMatch
                        ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {report.languageMatch ? "一致" : "不一致"}
                  </span>
                )}
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">本机首选</span>
                  <span className="truncate font-mono font-medium text-slate-700 dark:text-slate-200">
                    {localEnv?.languages[0] ?? "读取中..."}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">代理推荐</span>
                  <span className="truncate font-mono font-medium text-slate-700 dark:text-slate-200">
                    {report
                      ? `${report.recommendedLanguage} (${report.recommendedLanguageLabel})`
                      : "—"}
                  </span>
                </div>
                {localEnv && localEnv.languages.length > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">语言顺序</span>
                    <span className="truncate font-mono text-[10px] text-slate-400">
                      {localEnv.languages.join(" › ")}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {report && !report.languageMatch && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void applyFix("fix-lang")}
                className="mt-3 flex w-full items-center justify-center gap-1 rounded-full bg-white py-1.5 text-[11px] font-semibold text-slate-700 ring-1 ring-black/[0.06] transition hover:bg-slate-100 disabled:opacity-45 dark:bg-white/[0.08] dark:text-slate-200 dark:ring-white/[0.08] cursor-pointer"
              >
                {busyAction === "fix-lang" && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                <span>仅修语言</span>
              </button>
            )}
          </div>
        </div>

        {/* 说明提示 */}
        <p className="mt-3 px-1 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          提示：调整 Windows 首选语言会保留现有输入法且无需重启；若需浏览器网页里的{" "}
          <span className="font-mono">navigator.language</span>{" "}
          立即匹配节点地区且不影响日常配置，请点击下方「启动隔离浏览器」。
        </p>

        {/* 底部操作栏 */}
        <div className="mt-4 flex items-center justify-between gap-2">
          <div>
            {systemEnvBackup && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleRestore()}
                title={`还原至：${systemEnvBackup.windowsTimezone} / ${systemEnvBackup.languages.join(", ")}`}
                className="flex items-center gap-1.5 rounded-full bg-amber-500/12 px-3.5 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-500/20 disabled:opacity-45 dark:text-amber-300 cursor-pointer"
              >
                {busyAction === "restore" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                <span>一键还原</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {report && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleLaunchBrowser()}
                className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-200/80 disabled:opacity-45 dark:bg-white/[0.08] dark:text-slate-200 cursor-pointer"
              >
                {busyAction === "browser" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                <span>
                  按 {report.recommendedLanguage} 启动{browserLabel}
                </span>
              </button>
            )}

            <button
              type="button"
              disabled={!canFixAny || busyAction !== null || checking}
              onClick={() => void applyFix("fix-all")}
              className="flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-500 active:scale-95 disabled:opacity-40 cursor-pointer"
            >
              {busyAction === "fix-all" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5" />
              )}
              <span>{allMatched ? "已一致" : "一键修复"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
