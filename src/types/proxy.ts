export type ProxyProtocol = "vless" | "hysteria2" | "shadowsocks" | "trojan";

export type RoutingMode = "rule" | "global" | "direct";

export type ThemeMode = "system" | "light" | "dark";

export type NavTab = "dashboard" | "nodes" | "settings";

export interface NodeTransportConfig {
  type: "ws" | "grpc" | "http" | "httpupgrade";
  path?: string;
  host?: string;
  serviceName?: string;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
}

export interface VlessOptions {
  uuid: string;
  flow?: string;
  packetEncoding?: string;
  tlsEnabled: boolean;
  serverName?: string;
  insecure?: boolean;
  alpn?: string[];
  fingerprint?: string;
  reality?: {
    publicKey: string;
    shortId: string;
  };
  transport?: NodeTransportConfig;
}

export interface Hysteria2Options {
  password: string;
  serverPorts?: string[]; // sing-box 冒号格式，如 ["20000:40000"]
  hopInterval?: string;
  sni?: string;
  insecure?: boolean;
  alpn?: string[];
  obfsPassword?: string;
  upMbps?: number;
  downMbps?: number;
}

export interface ShadowsocksOptions {
  method: string;
  password: string;
  plugin?: string;
  pluginOpts?: string;
}

export interface TrojanOptions {
  password: string;
  sni?: string;
  insecure?: boolean;
  alpn?: string[];
  fingerprint?: string;
  transport?: NodeTransportConfig;
}

export interface ProxyNode {
  id: string;
  tag: string;
  name: string;
  protocol: ProxyProtocol;
  server: string;
  serverPort: number;
  rawUri: string;
  subscriptionId?: string;
  latency?: number; // undefined: 未测速, -1: 超时/失败, >0: HTTP 204 毫秒延迟
  testing?: boolean;
  vless?: VlessOptions;
  hysteria2?: Hysteria2Options;
  shadowsocks?: ShadowsocksOptions;
  trojan?: TrojanOptions;
}

export interface SubscriptionItem {
  id: string;
  name: string;
  url: string;
  updatedAt: number;
  nodeCount: number;
}

export interface TrafficStats {
  up: number;
  down: number;
  upTotal: number;
  downTotal: number;
}

export interface ClashConnectionMetadata {
  network: string;
  type: string;
  sourceIP: string;
  destinationIP: string;
  sourcePort: string;
  destinationPort: string;
  host: string;
  dnsMode?: string;
  processPath?: string;
  process?: string;
}

export interface ClashConnection {
  id: string;
  metadata: ClashConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface CoreLogEntry {
  id: number;
  time: string;
  type: "debug" | "info" | "warning" | "error";
  payload: string;
}

export interface ToastItem {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

export interface LaunchContext {
  silent: boolean;
  relaunchTun: boolean;
  isAdmin: boolean;
  sysProxyEnabled: boolean;
  preferredSysProxy: boolean;
  coreRunning: boolean;
  routingMode: string;
  tunMode: boolean;
  isColdStart: boolean;
  reconnectRequested?: boolean;
  pendingExitError?: string | null;
}

export interface CoreApplyRequest {
  configJson: string;
  sysProxy: boolean;
  tunMode: boolean;
  routingMode: RoutingMode;
  activeNode?: string | null;
  allowRollback: boolean;
}

export interface CoreApplyResult {
  status: "applied" | "rolled_back" | "failed" | "cancelled" | "superseded";
  configPath?: string | null;
  failureStage?: "precheck" | "startup" | "readiness" | "proxy" | "rollback" | null;
  error?: string | null;
  rollbackError?: string | null;
  runningAfter: boolean;
}
