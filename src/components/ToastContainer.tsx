import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-slate-900/92 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-white/95 dark:text-slate-900"
        >
          {t.type === "success" ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400 dark:text-emerald-600" />
          ) : t.type === "error" ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400 dark:text-rose-600" />
          ) : (
            <Info className="h-3.5 w-3.5 shrink-0 text-blue-400 dark:text-blue-600" />
          )}
          <span className="max-w-[340px] truncate">{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="ml-0.5 rounded-full p-0.5 opacity-60 hover:opacity-100 cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
