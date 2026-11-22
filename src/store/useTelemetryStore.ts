import { create } from "zustand";
import type {
  ClashConnection,
  CoreLogEntry,
  TrafficStats,
} from "../types/proxy";

export const TRAFFIC_HISTORY_LENGTH = 36;
export const MAX_LOG_ENTRIES = 250;

export function createEmptyTrafficHistory(): { up: number; down: number }[] {
  return Array.from({ length: TRAFFIC_HISTORY_LENGTH }, () => ({
    up: 0,
    down: 0,
  }));
}

export interface TelemetryState {
  traffic: TrafficStats;
  trafficHistory: { up: number; down: number }[];
  connections: ClashConnection[];
  logs: CoreLogEntry[];

  pushTrafficTick: (up: number, down: number, liveConnStream: boolean) => void;
  applyConnectionsSnapshot: (
    connections: ClashConnection[],
    uploadTotal: number,
    downloadTotal: number,
  ) => void;
  appendLogEntry: (entry: CoreLogEntry) => void;
  resetSessionTelemetry: () => void;
  clearLogs: () => void;
}

/**
 * 创建纯内存运行态遥测 Store（严禁挂载 persist 中间件，杜绝高频流量/连接/日志更新触发配置序列化与写盘）
 */
export function createTelemetryStore() {
  return create<TelemetryState>((set) => ({
    traffic: { up: 0, down: 0, upTotal: 0, downTotal: 0 },
    trafficHistory: createEmptyTrafficHistory(),
    connections: [],
    logs: [],

    pushTrafficTick: (up, down, liveConnStream) =>
      set((prev) => {
        const hist = prev.trafficHistory;
        return {
          traffic: {
            up,
            down,
            upTotal: liveConnStream
              ? prev.traffic.upTotal
              : prev.traffic.upTotal + up,
            downTotal: liveConnStream
              ? prev.traffic.downTotal
              : prev.traffic.downTotal + down,
          },
          trafficHistory: [
            ...(hist.length >= TRAFFIC_HISTORY_LENGTH
              ? hist.slice(hist.length - (TRAFFIC_HISTORY_LENGTH - 1))
              : hist),
            { up, down },
          ],
        };
      }),

    applyConnectionsSnapshot: (connections, uploadTotal, downloadTotal) =>
      set((prev) => ({
        connections,
        traffic: {
          ...prev.traffic,
          upTotal: uploadTotal,
          downTotal: downloadTotal,
        },
      })),

    appendLogEntry: (entry) =>
      set((prev) => ({
        logs:
          prev.logs.length >= MAX_LOG_ENTRIES
            ? [...prev.logs.slice(prev.logs.length - (MAX_LOG_ENTRIES - 1)), entry]
            : [...prev.logs, entry],
      })),

    resetSessionTelemetry: () =>
      set({
        traffic: { up: 0, down: 0, upTotal: 0, downTotal: 0 },
        trafficHistory: createEmptyTrafficHistory(),
        connections: [],
      }),

    clearLogs: () => set({ logs: [] }),
  }));
}

export const useTelemetryStore = createTelemetryStore();
