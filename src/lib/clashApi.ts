import type {
  ClashConnection,
  CoreLogEntry,
  RoutingMode,
} from "../types/proxy";

const CLASH_HTTP_BASE = "http://127.0.0.1:9090";
const CLASH_WS_BASE = "ws://127.0.0.1:9090";
const GENERATE_204_URL = "https://www.gstatic.com/generate_204";

/**
 * 等待 laynet-core 的 Clash API (127.0.0.1:9090) 就绪
 */
export async function waitForClashApiReady(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 600);
      const res = await fetch(`${CLASH_HTTP_BASE}/version`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // 继续轮询等待启动完成
    }
    await new Promise((r) => setTimeout(r, 140));
  }
  return false;
}

/**
 * 毫秒级热切换 proxy 选择组当前出站节点
 */
export async function switchClashOutbound(
  targetTag: string,
  selectorGroup = "proxy",
): Promise<void> {
  const res = await fetch(
    `${CLASH_HTTP_BASE}/proxies/${encodeURIComponent(selectorGroup)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: targetTag }),
    },
  );
  if (!res.ok) {
    throw new Error(`切换节点失败 (HTTP ${res.status})`);
  }
}

/**
 * 无感热切换三档分流模式（Rule / Global / Direct），无需重启 laynet-core
 */
export async function patchClashRoutingMode(mode: RoutingMode): Promise<void> {
  const res = await fetch(`${CLASH_HTTP_BASE}/configs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    throw new Error(`热切换分流模式失败 (HTTP ${res.status})`);
  }
}

/**
 * 读取当前运行中内核的实际分流模式（用于从托盘重建窗口时无感同步）
 */
export async function fetchCurrentRoutingMode(): Promise<RoutingMode | null> {
  try {
    const res = await fetch(`${CLASH_HTTP_BASE}/configs`);
    if (!res.ok) return null;
    const data = (await res.json()) as { mode?: string };
    const m = (data.mode || "").toLowerCase();
    if (m === "rule" || m === "global" || m === "direct") {
      return m;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 单次拉取当前连接与累计流量快照（用于重建窗口时零延迟恢复累计值，无需常开 /connections WS）
 */
export async function fetchConnectionsSnapshot(): Promise<{
  connections: ClashConnection[];
  uploadTotal: number;
  downloadTotal: number;
} | null> {
  try {
    const res = await fetch(`${CLASH_HTTP_BASE}/connections`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      connections?: ClashConnection[] | null;
      uploadTotal?: number;
      downloadTotal?: number;
    };
    return {
      connections: data.connections ?? [],
      uploadTotal: data.uploadTotal ?? 0,
      downloadTotal: data.downloadTotal ?? 0,
    };
  } catch {
    return null;
  }
}

async function singleHttp204Probe(
  nodeTag: string,
  timeout: number,
): Promise<number> {
  const url = `${CLASH_HTTP_BASE}/proxies/${encodeURIComponent(
    nodeTag,
  )}/delay?url=${encodeURIComponent(GENERATE_204_URL)}&timeout=${timeout}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout + 800);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return -1;
    const data = (await res.json()) as { delay?: number };
    return typeof data.delay === "number" && data.delay > 0 ? data.delay : -1;
  } catch {
    return -1;
  }
}

/**
 * 手动 HTTP 204 真连接延迟（严禁 ICMP Ping）。
 * 每个节点只探测一次，使用相同目标与超时，结果可直接比较。
 * 自动优选组的 urltest 策略不经过这里。
 */
export async function measureNodeHttp204Delay(
  nodeTag: string,
  timeout = 5000,
): Promise<number> {
  return singleHttp204Probe(nodeTag, timeout);
}

/**
 * 查询 `auto` (urltest) 当前自动择优命中的真实节点名
 */
export async function queryAutoWinnerNode(): Promise<string | null> {
  try {
    const res = await fetch(`${CLASH_HTTP_BASE}/proxies/auto`);
    if (!res.ok) return null;
    const data = (await res.json()) as { now?: string };
    return data.now || null;
  } catch {
    return null;
  }
}

/**
 * 一键关闭当前全部活跃连接
 */
export async function closeAllClashConnections(): Promise<void> {
  try {
    await fetch(`${CLASH_HTTP_BASE}/connections`, { method: "DELETE" });
  } catch {
    // 忽略关闭异常
  }
}

export interface ClashStreamCallbacks {
  onTraffic: (up: number, down: number) => void;
  onConnections: (
    connections: ClashConnection[],
    uploadTotal: number,
    downloadTotal: number,
  ) => void;
  onLog: (entry: CoreLogEntry) => void;
}

/**
 * 按需开关式 Clash API 三路 WebSocket 管理器：
 * - /traffic 仅在前台窗口可见时开启
 * - /connections 仅在打开「设置 -> 连接」时开启
 * - /logs 仅在打开「设置 -> 日志」时开启
 */
export class ClashTelemetrySession {
  private trafficEnabled = false;
  private connEnabled = false;
  private logEnabled = false;

  private trafficWs: WebSocket | null = null;
  private connWs: WebSocket | null = null;
  private logWs: WebSocket | null = null;

  private trafficTimer: ReturnType<typeof setTimeout> | null = null;
  private connTimer: ReturnType<typeof setTimeout> | null = null;
  private logTimer: ReturnType<typeof setTimeout> | null = null;

  private logSeq = 1;
  private callbacks: ClashStreamCallbacks;

  constructor(callbacks: ClashStreamCallbacks) {
    this.callbacks = callbacks;
  }

  configure(opts: { traffic: boolean; connections: boolean; logs: boolean }): void {
    this.setTrafficEnabled(opts.traffic);
    this.setConnectionsEnabled(opts.connections);
    this.setLogsEnabled(opts.logs);
  }

  stop(): void {
    this.configure({ traffic: false, connections: false, logs: false });
  }

  private safeClose(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private setTrafficEnabled(enable: boolean): void {
    if (this.trafficEnabled === enable) return;
    this.trafficEnabled = enable;
    if (!enable) {
      if (this.trafficTimer) clearTimeout(this.trafficTimer);
      this.trafficTimer = null;
      this.safeClose(this.trafficWs);
      this.trafficWs = null;
      return;
    }
    this.connectTraffic();
  }

  private setConnectionsEnabled(enable: boolean): void {
    if (this.connEnabled === enable) return;
    this.connEnabled = enable;
    if (!enable) {
      if (this.connTimer) clearTimeout(this.connTimer);
      this.connTimer = null;
      this.safeClose(this.connWs);
      this.connWs = null;
      return;
    }
    this.connectConnections();
  }

  private setLogsEnabled(enable: boolean): void {
    if (this.logEnabled === enable) return;
    this.logEnabled = enable;
    if (!enable) {
      if (this.logTimer) clearTimeout(this.logTimer);
      this.logTimer = null;
      this.safeClose(this.logWs);
      this.logWs = null;
      return;
    }
    this.connectLogs();
  }

  private connectTraffic(): void {
    if (!this.trafficEnabled) return;
    this.safeClose(this.trafficWs);
    try {
      const ws = new WebSocket(`${CLASH_WS_BASE}/traffic`);
      this.trafficWs = ws;
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as {
            up?: number;
            down?: number;
          };
          this.callbacks.onTraffic(parsed.up ?? 0, parsed.down ?? 0);
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (!this.trafficEnabled) return;
        this.trafficTimer = setTimeout(() => this.connectTraffic(), 1500);
      };
    } catch {
      if (this.trafficEnabled) {
        this.trafficTimer = setTimeout(() => this.connectTraffic(), 1500);
      }
    }
  }

  private connectConnections(): void {
    if (!this.connEnabled) return;
    this.safeClose(this.connWs);
    try {
      const ws = new WebSocket(`${CLASH_WS_BASE}/connections`);
      this.connWs = ws;
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as {
            connections?: ClashConnection[] | null;
            uploadTotal?: number;
            downloadTotal?: number;
          };
          this.callbacks.onConnections(
            parsed.connections ?? [],
            parsed.uploadTotal ?? 0,
            parsed.downloadTotal ?? 0,
          );
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (!this.connEnabled) return;
        this.connTimer = setTimeout(() => this.connectConnections(), 1500);
      };
    } catch {
      if (this.connEnabled) {
        this.connTimer = setTimeout(() => this.connectConnections(), 1500);
      }
    }
  }

  private connectLogs(): void {
    if (!this.logEnabled) return;
    this.safeClose(this.logWs);
    try {
      const ws = new WebSocket(`${CLASH_WS_BASE}/logs?level=info`);
      this.logWs = ws;
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as {
            type?: "debug" | "info" | "warning" | "error";
            payload?: string;
          };
          if (!parsed.payload) return;
          const time = new Date().toTimeString().slice(0, 8);
          this.callbacks.onLog({
            id: this.logSeq++,
            time,
            type: parsed.type ?? "info",
            payload: parsed.payload,
          });
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (!this.logEnabled) return;
        this.logTimer = setTimeout(() => this.connectLogs(), 1500);
      };
    } catch {
      if (this.logEnabled) {
        this.logTimer = setTimeout(() => this.connectLogs(), 1500);
      }
    }
  }
}
