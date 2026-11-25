import { create, type StateCreator, type StoreApi, type UseBoundStore } from "zustand";
import { type StateStorage } from "zustand/middleware";
import {
  ClashTelemetrySession,
  closeAllClashConnections,
  fetchConnectionsSnapshot,
  fetchCurrentRoutingMode,
  measureNodeHttp204Delay,
  patchClashRoutingMode,
  queryAutoWinnerNode,
  switchClashOutbound,
} from "../lib/clashApi";
import {
  buildSingBoxConfig,
  resolveSelectedOutboundTag,
} from "../lib/configBuilder";
import {
  applyLayNetCoreConfig,
  buildTerminalProxyCommand,
  checkAdminPrivilege,
  elevateForTun,
  fetchSubscriptionText,
  getAutostartStatus,
  getLaunchContext,
  getSysProxyState,
  readClipboardText,
  releaseWindowToTray,
  setAutostartStatus,
  settleCachedCoreConfig,
  setWindowsSystemProxy,
  stopLayNetCore,
  subscribeTauriEvent,
  syncTrayState,
  writeClipboardText,
} from "../lib/tauriBridge";
import {
  ensureUniqueTags,
  formatCertPinSkipSummary,
  getNodeDisplayMap,
  makeNodeId,
  makeStableOutboundTag,
  matchSubscriptionNodeIds,
  normalizeMportToSingBox,
  omitUnsupportedCertPinNodes,
  parseShareBatch,
  rebuildHysteria2RawUri,
  RESERVED_OUTBOUND_TAGS,
  resolveNodeDisplayName,
  shareUriRequiresUnsupportedCertPin,
  type CertPinSkipEffect,
  type SkippedShareLink,
} from "../lib/uriParser";
import type {
  ClashConnection,
  CoreApplyRequest,
  CoreApplyResult,
  CoreLogEntry,
  LaunchContext,
  NavTab,
  ProxyNode,
  RoutingMode,
  SubscriptionItem,
  SystemEnvBackup,
  ThemeMode,
  ToastItem,
} from "../types/proxy";
import {
  createTelemetryStore,
  useTelemetryStore,
  type TelemetryState,
} from "./useTelemetryStore";

export const PERSIST_STORAGE_KEY = "laynet-storage-v1";
export const PERSIST_SCHEMA_VERSION = 2;

export interface PersistedAppState {
  nodes: ProxyNode[];
  subscriptions: SubscriptionItem[];
  selectedOutbound: string;
  routingMode: RoutingMode;
  sysProxy: boolean;
  sysProxyBeforeTun: boolean;
  tunMode: boolean;
  forceProxyText: string;
  forceDirectText: string;
  aiSuiteProxyEnabled: boolean;
  dnsLeakProtection: boolean;
  theme: ThemeMode;
  terminalShell: "powershell" | "cmd";
  /** 未声明带宽的 HY2 节点使用的默认下行 Mbps；0 = BBR */
  brutalDownMbps: number;
  /** 未声明带宽的 HY2 节点使用的默认上行 Mbps；0 = BBR */
  brutalUpMbps: number;
  autoRestoreConnect: boolean;
  autoRefreshSubs: boolean;
  lastConnected: boolean;
  selectionMigrated: boolean;
  certPinNotice: string | null;
  systemEnvBackup: SystemEnvBackup | null;
}

const PERSISTED_KEYS: (keyof PersistedAppState)[] = [
  "nodes",
  "subscriptions",
  "selectedOutbound",
  "routingMode",
  "sysProxy",
  "sysProxyBeforeTun",
  "tunMode",
  "forceProxyText",
  "forceDirectText",
  "aiSuiteProxyEnabled",
  "dnsLeakProtection",
  "theme",
  "terminalShell",
  "brutalDownMbps",
  "brutalUpMbps",
  "autoRestoreConnect",
  "autoRefreshSubs",
  "lastConnected",
  "selectionMigrated",
  "certPinNotice",
  "systemEnvBackup",
];

interface EffectiveRuntimeSnapshot {
  nodes: ProxyNode[];
  subscriptions: SubscriptionItem[];
  selectedOutbound: string;
  routingMode: RoutingMode;
  sysProxy: boolean;
  sysProxyBeforeTun: boolean;
  tunMode: boolean;
  forceProxyText: string;
  forceDirectText: string;
  aiSuiteProxyEnabled: boolean;
  dnsLeakProtection: boolean;
  brutalDownMbps: number;
  brutalUpMbps: number;
}

export interface TelemetrySessionLike {
  configure: (opts: {
    traffic: boolean;
    connections: boolean;
    logs: boolean;
  }) => void;
  stop: () => void;
}

export interface TelemetryCallbacks {
  onTraffic: (up: number, down: number) => void;
  onConnections: (
    connections: ClashConnection[],
    uploadTotal: number,
    downloadTotal: number,
  ) => void;
  onLog: (entry: CoreLogEntry) => void;
}

export type ReloadOutcomeStatus =
  | "applied"
  | "rolled_back"
  | "failed"
  | "cancelled"
  | "superseded";

export interface AppStoreDependencies {
  storage?: StateStorage | null;
  telemetryStore?: UseBoundStore<StoreApi<TelemetryState>>;
  onPartialize?: (persisted: PersistedAppState) => void;
  createTelemetrySession?: (
    callbacks: TelemetryCallbacks,
  ) => TelemetrySessionLike;
  getLaunchContext?: () => Promise<LaunchContext>;
  getAutostartStatus?: () => Promise<boolean>;
  setAutostartStatus?: (enable: boolean) => Promise<void>;
  releaseWindowToTray?: () => Promise<void>;
  applyLayNetCoreConfig?: (request: CoreApplyRequest) => Promise<CoreApplyResult>;
  stopLayNetCore?: () => Promise<void>;
  setWindowsSystemProxy?: (enable: boolean, port?: number) => Promise<void>;
  getSysProxyState?: () => Promise<{ enabled: boolean; server: string }>;
  checkAdminPrivilege?: () => Promise<boolean>;
  elevateForTun?: () => Promise<void>;
  syncTrayState?: (payload: {
    connected: boolean;
    sysProxy: boolean;
    tunMode: boolean;
    routingMode: RoutingMode;
    activeNode?: string;
    terminalShell?: "powershell" | "cmd";
  }) => Promise<void>;
  fetchSubscriptionText?: (url: string) => Promise<string>;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (text: string) => Promise<void>;
  subscribeTauriEvent?: <T>(
    eventName: string,
    handler: (payload: T) => void,
  ) => Promise<() => void>;
  fetchCurrentRoutingMode?: () => Promise<RoutingMode | null>;
  fetchConnectionsSnapshot?: () => Promise<{
    connections: ClashConnection[];
    uploadTotal: number;
    downloadTotal: number;
  } | null>;
  queryAutoWinnerNode?: () => Promise<string | null>;
  switchClashOutbound?: (
    targetTag: string,
    selectorGroup?: string,
  ) => Promise<void>;
  patchClashRoutingMode?: (mode: RoutingMode) => Promise<void>;
  measureNodeHttp204Delay?: (
    nodeTag: string,
    timeout?: number,
  ) => Promise<number>;
  closeAllClashConnections?: () => Promise<void>;
  settleCachedCoreConfig?: (discardSaved: boolean, expectedConfig?: string) => Promise<void>;
}

export interface AppState extends PersistedAppState {
  // 运行时瞬态（非遥测控制态）
  activeTab: NavTab;
  settingsSubTab: "connections" | "logs";
  windowVisible: boolean;
  connected: boolean;
  connecting: boolean;
  rulesDirty: boolean;
  autoWinnerNode: string | null;
  isAdmin: boolean;
  autostartEnabled: boolean;
  showTunPrivilegeModal: boolean;
  proxyHijackedBy: string | null;
  batchTesting: boolean;
  toasts: ToastItem[];
  certPinPurged: boolean;

  // Actions
  setActiveTab: (tab: NavTab) => void;
  setSettingsSubTab: (sub: "connections" | "logs") => void;
  setWindowVisible: (visible: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setTerminalShell: (shell: "powershell" | "cmd") => void;
  pushToast: (type: ToastItem["type"], message: string) => void;
  dismissToast: (id: string) => void;
  setShowTunPrivilegeModal: (show: boolean) => void;

  initializeApp: () => Promise<void>;
  connectCore: () => Promise<void>;
  disconnectCore: () => Promise<void>;
  toggleConnection: () => Promise<void>;
  reloadCoreConfig: (
    silentToast?: boolean,
    allowRollback?: boolean,
  ) => Promise<ReloadOutcomeStatus>;

  toggleSysProxy: () => Promise<void>;
  reclaimSystemProxy: () => Promise<void>;
  toggleTunMode: () => Promise<void>;
  confirmElevateForTun: () => Promise<void>;
  copyTerminalProxy: () => Promise<void>;

  setRoutingMode: (mode: RoutingMode) => Promise<void>;
  selectOutbound: (idOrBuiltin: string) => Promise<void>;
  setForceProxyText: (val: string) => void;
  setForceDirectText: (val: string) => void;
  setAiSuiteProxyEnabled: (val: boolean) => void;
  applyCustomRules: () => Promise<boolean>;

  importFromClipboard: () => Promise<void>;
  importRawLinks: (text: string) => Promise<number>;
  updateNodeConfig: (
    id: string,
    patch: {
      name: string;
      downMbps?: number;
      upMbps?: number;
      mport?: string;
    },
  ) => Promise<void>;
  sortNodesByLatency: () => void;
  removeNode: (id: string) => Promise<void>;
  clearAllNodes: (keepSubscriptions?: boolean) => Promise<void>;

  addSubscription: (name: string, url: string) => Promise<void>;
  refreshSubscription: (id: string, silent?: boolean) => Promise<void>;
  refreshAllSubscriptions: (silent?: boolean) => Promise<void>;
  removeSubscription: (id: string) => Promise<void>;

  testSingleNodeDelay: (idOrTag: string) => Promise<void>;
  testAllNodesDelay: () => Promise<void>;

  toggleAutostart: () => Promise<void>;
  /** 设置未声明带宽的 HY2 节点的默认带宽；任一为 0 即走 BBR */
  setBrutalBandwidth: (downMbps: number, upMbps: number) => Promise<void>;
  setDnsLeakProtection: (val: boolean) => Promise<void>;
  setSystemEnvBackup: (backup: SystemEnvBackup | null) => void;
  setAutoRestoreConnect: (val: boolean) => void;
  setAutoRefreshSubs: (val: boolean) => void;
  closeAllConnections: () => Promise<void>;
  clearLogs: () => void;
}

/** 带宽输入归一化：非法 / 负数 → 0（BBR），上限 10000 Mbps，取整 */
function sanitizeMbps(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(10000, Math.round(n));
}

/** 旧版本只存了下行档位：800/1000 → 上行 100，300 → 上行 60，0 → BBR */
function legacyBrutalUpFor(down: number): number {
  if (down <= 0) return 0;
  if (down >= 800) return 100;
  if (down >= 300) return 60;
  return Math.max(1, Math.round(down * 0.6));
}

/**
 * 保留原始 tag，仅规范化节点 ID 唯一性（用于旧版本持久化数据在重排 tag 前精确查找原节点）
 */
function normalizeNodeIdsPreserveTags(rawNodes: ProxyNode[]): ProxyNode[] {
  const seen = new Set<string>(RESERVED_OUTBOUND_TAGS);
  return rawNodes.map((node) => {
    let id = typeof node?.id === "string" ? node.id.trim() : "";
    if (!id || seen.has(id)) {
      do {
        id = makeNodeId();
      } while (seen.has(id));
    }
    seen.add(id);
    return {
      ...node,
      id,
    };
  });
}

function normalizeRoutingMode(
  raw: unknown,
  fallback: RoutingMode = "rule",
): RoutingMode {
  const val = typeof raw === "string" ? raw.toLowerCase() : "";
  if (val === "rule" || val === "global" || val === "direct") {
    return val;
  }
  return fallback;
}

/**
 * 幂等的持久化数据迁移：
 * - 旧版（version < 2 且未标记 selectionMigrated）在重排 tag 之前，用原 `selectedOutbound` 匹配唯一原节点并保留其稳定 ID；
 * - 若旧标签缺失或匹配到多个同名同 tag 节点导致含义不唯一，回退到 `"auto"`；
 * - 保留内置 `"auto"` / `"direct"` 选择及全部用户设置；重复加载已迁移数据保证产生完全一致的选择。
 */
export interface MigratePersistedResult extends Partial<PersistedAppState> {
  certPinPurged: boolean;
}

export function migratePersistedState(
  rawState: unknown,
  persistedVersion?: number,
): MigratePersistedResult {
  if (!rawState || typeof rawState !== "object") {
    return { certPinPurged: false };
  }

  const raw = rawState as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? (raw.nodes as ProxyNode[]) : [];
  const idNodes = normalizeNodeIdsPreserveTags(rawNodes);
  const skippedPinNodes = idNodes.filter((node) =>
    shareUriRequiresUnsupportedCertPin(node.rawUri),
  );
  const keptNodes = idNodes.filter(
    (node) => !shareUriRequiresUnsupportedCertPin(node.rawUri),
  );
  const certPinPurged = skippedPinNodes.length > 0;

  const needsLegacyTagMigration =
    (typeof persistedVersion !== "number" ||
      persistedVersion < PERSIST_SCHEMA_VERSION) &&
    raw.selectionMigrated !== true;

  const oldSelected =
    typeof raw.selectedOutbound === "string" ? raw.selectedOutbound : "auto";

  let nextSelected = "auto";
  if (oldSelected === "auto" || oldSelected === "direct") {
    nextSelected = oldSelected;
  } else if (needsLegacyTagMigration) {
    const matches = keptNodes.filter(
      (n) => typeof n.tag === "string" && n.tag === oldSelected,
    );
    if (matches.length === 1 && matches[0]) {
      nextSelected = matches[0].id;
    } else {
      nextSelected = "auto";
    }
  } else {
    nextSelected = keptNodes.some((n) => n.id === oldSelected)
      ? oldSelected
      : "auto";
  }

  const normalizedNodes = ensureUniqueTags(
    keptNodes.map((n) => ({ ...n, testing: false })),
  );

  if (
    nextSelected !== "auto" &&
    nextSelected !== "direct" &&
    !normalizedNodes.some((n) => n.id === nextSelected)
  ) {
    nextSelected = "auto";
  }

  const migrated: Partial<PersistedAppState> = {
    nodes: normalizedNodes,
    selectedOutbound: nextSelected,
    selectionMigrated: true,
  };

  if (Array.isArray(raw.subscriptions)) {
    migrated.subscriptions = raw.subscriptions as SubscriptionItem[];
  }
  if (raw.routingMode !== undefined) {
    migrated.routingMode = normalizeRoutingMode(raw.routingMode);
  }
  if (typeof raw.sysProxy === "boolean") migrated.sysProxy = raw.sysProxy;
  if (typeof raw.sysProxyBeforeTun === "boolean") {
    migrated.sysProxyBeforeTun = raw.sysProxyBeforeTun;
  }
  if (typeof raw.tunMode === "boolean") migrated.tunMode = raw.tunMode;
  if (typeof raw.forceProxyText === "string") {
    migrated.forceProxyText = raw.forceProxyText;
  }
  if (typeof raw.forceDirectText === "string") {
    migrated.forceDirectText = raw.forceDirectText;
  }
  if (typeof raw.aiSuiteProxyEnabled === "boolean") {
    migrated.aiSuiteProxyEnabled = raw.aiSuiteProxyEnabled;
  }
  if (typeof raw.dnsLeakProtection === "boolean") {
    migrated.dnsLeakProtection = raw.dnsLeakProtection;
  }
  if (raw.theme === "system" || raw.theme === "light" || raw.theme === "dark") {
    migrated.theme = raw.theme;
  }
  if (raw.terminalShell === "powershell" || raw.terminalShell === "cmd") {
    migrated.terminalShell = raw.terminalShell;
  }
  if (typeof raw.brutalDownMbps === "number") {
    migrated.brutalDownMbps = sanitizeMbps(raw.brutalDownMbps);
  }
  if (typeof raw.brutalUpMbps === "number") {
    migrated.brutalUpMbps = sanitizeMbps(raw.brutalUpMbps);
  } else if (typeof raw.brutalDownMbps === "number") {
    // 旧版本只存下行档位，上行由档位推导
    migrated.brutalUpMbps = legacyBrutalUpFor(sanitizeMbps(raw.brutalDownMbps));
  }
  if (typeof raw.autoRestoreConnect === "boolean") {
    migrated.autoRestoreConnect = raw.autoRestoreConnect;
  }
  if (typeof raw.autoRefreshSubs === "boolean") {
    migrated.autoRefreshSubs = raw.autoRefreshSubs;
  }
  if (certPinPurged && normalizedNodes.length === 0) {
    migrated.lastConnected = false;
  } else if (typeof raw.lastConnected === "boolean") {
    migrated.lastConnected = raw.lastConnected;
  }

  if (raw.systemEnvBackup && typeof raw.systemEnvBackup === "object") {
    const b = raw.systemEnvBackup as Record<string, unknown>;
    const tz =
      typeof b.windowsTimezone === "string" ? b.windowsTimezone.trim() : "";
    const langs = Array.isArray(b.languages)
      ? b.languages.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
    if (tz && langs.length > 0) {
      migrated.systemEnvBackup = {
        windowsTimezone: tz,
        languages: langs,
        savedAt:
          typeof b.savedAt === "number" && Number.isFinite(b.savedAt)
            ? b.savedAt
            : Date.now(),
      };
    }
  } else if (raw.systemEnvBackup === null) {
    migrated.systemEnvBackup = null;
  }

  const savedNotice =
    typeof raw.certPinNotice === "string" && raw.certPinNotice.trim()
      ? raw.certPinNotice
      : null;
  if (certPinPurged) {
    const stayedDisconnected = normalizedNodes.length === 0;
    const selectedWasSkipped = skippedPinNodes.some(
      (node) => node.id === oldSelected || node.tag === oldSelected,
    );
    const effect: CertPinSkipEffect | undefined = stayedDisconnected
      ? "stay-disconnected"
      : selectedWasSkipped && oldSelected !== "auto" && oldSelected !== "direct"
        ? "fallback-auto"
        : undefined;
    migrated.certPinNotice = formatCertPinSkipSummary(
      skippedPinNodes.length,
      effect,
    );
  } else {
    migrated.certPinNotice = savedNotice;
  }

  return { ...migrated, certPinPurged };
}

export function extractPersistedAppState(state: AppState): PersistedAppState {
  return {
    nodes: state.nodes,
    subscriptions: state.subscriptions,
    selectedOutbound: state.selectedOutbound,
    routingMode: state.routingMode,
    sysProxy: state.sysProxy,
    sysProxyBeforeTun: state.sysProxyBeforeTun,
    tunMode: state.tunMode,
    forceProxyText: state.forceProxyText,
    forceDirectText: state.forceDirectText,
    aiSuiteProxyEnabled: state.aiSuiteProxyEnabled,
    dnsLeakProtection: state.dnsLeakProtection,
    theme: state.theme,
    terminalShell: state.terminalShell,
    brutalDownMbps: state.brutalDownMbps,
    brutalUpMbps: state.brutalUpMbps,
    autoRestoreConnect: state.autoRestoreConnect,
    autoRefreshSubs: state.autoRefreshSubs,
    lastConnected: state.lastConnected,
    selectionMigrated: state.selectionMigrated,
    certPinNotice: state.certPinNotice,
    systemEnvBackup: state.systemEnvBackup,
  };
}

function defaultBrowserStorage(): StateStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

function hasPersistedChanges(
  prev: Partial<PersistedAppState> | null,
  next: AppState,
): boolean {
  if (!prev) return true;
  for (const key of PERSISTED_KEYS) {
    if (!Object.is(prev[key], next[key])) {
      return true;
    }
  }
  return false;
}

function capturePersistedRefs(state: AppState): PersistedAppState {
  return extractPersistedAppState(state);
}

function captureEffectiveSnapshot(state: AppState): EffectiveRuntimeSnapshot {
  return {
    nodes: state.nodes,
    subscriptions: state.subscriptions,
    selectedOutbound: state.selectedOutbound,
    routingMode: state.routingMode,
    sysProxy: state.sysProxy,
    sysProxyBeforeTun: state.sysProxyBeforeTun,
    tunMode: state.tunMode,
    forceProxyText: state.forceProxyText,
    forceDirectText: state.forceDirectText,
    aiSuiteProxyEnabled: state.aiSuiteProxyEnabled,
    dnsLeakProtection: state.dnsLeakProtection,
    brutalDownMbps: state.brutalDownMbps,
    brutalUpMbps: state.brutalUpMbps,
  };
}

function isSelectionValid(nodes: ProxyNode[], selectedOutbound: string): boolean {
  if (selectedOutbound === "auto" || selectedOutbound === "direct") return true;
  return nodes.some((n) => n.id === selectedOutbound);
}

function isSameEffectiveNodesAndTags(nodes: ProxyNode[]): boolean {
  const seen = new Set<string>(RESERVED_OUTBOUND_TAGS);
  for (const n of nodes) {
    if (n.testing) return false;
    if (!n.id || seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.tag !== makeStableOutboundTag(n.id)) return false;
  }
  return true;
}

/**
 * 带字段级引用变更检测的持久化中间件：
 * 仅当 PERSISTED_KEYS 中任一持久化字段实际发生变更时，才调用 partialize + JSON.stringify + storage.setItem；
 * 所有运行态/遥测字段更新 0 序列化、0 写盘。
 */
function createSelectivePersist(
  creator: StateCreator<AppState>,
  options: {
    name: string;
    version: number;
    storage: StateStorage | null;
    partialize: (state: AppState) => PersistedAppState;
  },
): StateCreator<AppState> {
  return (set, get, api) => {
    let lastPersisted: PersistedAppState | null = null;
    let hydrated = false;

    const writeIfPersistedChanged = (force = false) => {
      if (!options.storage) return;
      const current = get();
      if (!force && !hasPersistedChanges(lastPersisted, current)) {
        return;
      }
      const persisted = options.partialize(current);
      lastPersisted = persisted;
      const serialized = JSON.stringify({
        state: persisted,
        version: options.version,
      });
      void Promise.resolve(options.storage.setItem(options.name, serialized));
    };

    const guardedSet: typeof set = (partial, replace) => {
      if (replace === true) {
        set(partial as AppState, true);
      } else {
        set(partial as Parameters<typeof set>[0]);
      }
      writeIfPersistedChanged(false);
    };

    const rawSetState = api.setState;
    api.setState = ((partial, replace) => {
      if (replace === true) {
        rawSetState(partial as AppState, true);
      } else {
        rawSetState(partial as Parameters<typeof rawSetState>[0]);
      }
      writeIfPersistedChanged(false);
    }) as typeof api.setState;

    const initialState = creator(guardedSet, get, api);
    let syncHydratedState = initialState;

    const applyHydratedRaw = (rawStr: string | null) => {
      hydrated = true;
      if (!rawStr) {
        lastPersisted = capturePersistedRefs(get() ?? initialState);
        return;
      }
      try {
        const parsed = JSON.parse(rawStr) as {
          state?: unknown;
          version?: number;
        };
        const rawVersion =
          typeof parsed?.version === "number" ? parsed.version : undefined;
        const rawInner =
          parsed && typeof parsed === "object" && "state" in parsed
            ? parsed.state
            : parsed;
        const migrated = migratePersistedState(rawInner, rawVersion);
        const cur = get() ?? initialState;
        const merged = { ...cur, ...migrated };
        syncHydratedState = merged;
        if (get()) {
          rawSetState(merged, true);
        }
        lastPersisted = capturePersistedRefs(merged);

        const rawObj =
          rawInner && typeof rawInner === "object"
            ? (rawInner as Record<string, unknown>)
            : {};
        if (
          rawVersion !== options.version ||
          rawObj.selectionMigrated !== true ||
          migrated.certPinPurged
        ) {
          writeIfPersistedChanged(true);
        }
      } catch {
        lastPersisted = capturePersistedRefs(get() ?? initialState);
      }
    };

    if (options.storage) {
      const maybePromise = options.storage.getItem(options.name);
      if (
        maybePromise &&
        typeof (maybePromise as Promise<string | null>).then === "function"
      ) {
        void (maybePromise as Promise<string | null>).then(applyHydratedRaw);
      } else {
        applyHydratedRaw(maybePromise as string | null);
      }
    } else {
      hydrated = true;
      lastPersisted = capturePersistedRefs(initialState);
    }

    (api as StoreApi<AppState> & { hasHydrated?: () => boolean }).hasHydrated =
      () => hydrated;

    return syncHydratedState;
  };
}

export interface CreatedAppStore {
  useStore: UseBoundStore<StoreApi<AppState>>;
  telemetryStore: UseBoundStore<StoreApi<TelemetryState>>;
  dispose: () => void;
}

interface PreparedSubscriptionUpdate {
  id: string;
  name: string;
  status: "ready" | "failed" | "empty" | "dropped";
  error?: string;
  parsedNodes: ProxyNode[];
  skipped: SkippedShareLink[];
}

/**
 * 用订阅的新节点替换原订阅节点，并保持其余节点与仍存在节点的显示顺序。
 * 新节点插在该订阅原有节点块的末尾。
 */
function mergeSubscriptionNodes(
  nodes: ProxyNode[],
  updates: Map<string, ProxyNode[]>,
): ProxyNode[] {
  const incomingById = new Map<string, Map<string, ProxyNode>>();
  const previousIds = new Map<string, Set<string>>();
  for (const [subscriptionId, list] of updates) {
    incomingById.set(
      subscriptionId,
      new Map(list.map((node) => [node.id, node])),
    );
  }
  for (const node of nodes) {
    if (!node.subscriptionId || !updates.has(node.subscriptionId)) continue;
    const known = previousIds.get(node.subscriptionId) ?? new Set<string>();
    known.add(node.id);
    previousIds.set(node.subscriptionId, known);
  }

  const next: ProxyNode[] = [];
  const appended = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node) continue;
    const subscriptionId = node.subscriptionId;
    const incoming = subscriptionId
      ? incomingById.get(subscriptionId)
      : undefined;
    if (!incoming || !subscriptionId) {
      next.push(node);
      continue;
    }
    const updated = incoming.get(node.id);
    if (updated) next.push(updated);
    const isLastOfSubscription = !nodes
      .slice(index + 1)
      .some((candidate) => candidate.subscriptionId === subscriptionId);
    if (isLastOfSubscription && !appended.has(subscriptionId)) {
      const known = previousIds.get(subscriptionId) ?? new Set<string>();
      const fresh = (updates.get(subscriptionId) ?? []).filter(
        (candidate) => !known.has(candidate.id),
      );
      next.push(...fresh);
      appended.add(subscriptionId);
    }
  }
  for (const [subscriptionId, list] of updates) {
    if (!appended.has(subscriptionId)) next.push(...list);
  }
  return next;
}

export function createAppStore(deps: AppStoreDependencies = {}): CreatedAppStore {
  const storage =
    deps.storage !== undefined ? deps.storage : defaultBrowserStorage();
  const telemetryStore = deps.telemetryStore ?? createTelemetryStore();

  const resolveDeps = {
    createTelemetrySession:
      deps.createTelemetrySession ??
      ((cb: TelemetryCallbacks) => new ClashTelemetrySession(cb)),
    getLaunchContext: deps.getLaunchContext ?? getLaunchContext,
    getAutostartStatus: deps.getAutostartStatus ?? getAutostartStatus,
    setAutostartStatus: deps.setAutostartStatus ?? setAutostartStatus,
    releaseWindowToTray: deps.releaseWindowToTray ?? releaseWindowToTray,
    applyLayNetCoreConfig:
      deps.applyLayNetCoreConfig ?? applyLayNetCoreConfig,
    stopLayNetCore: deps.stopLayNetCore ?? stopLayNetCore,
    setWindowsSystemProxy: deps.setWindowsSystemProxy ?? setWindowsSystemProxy,
    getSysProxyState: deps.getSysProxyState ?? getSysProxyState,
    checkAdminPrivilege: deps.checkAdminPrivilege ?? checkAdminPrivilege,
    elevateForTun: deps.elevateForTun ?? elevateForTun,
    syncTrayState: deps.syncTrayState ?? syncTrayState,
    fetchSubscriptionText: deps.fetchSubscriptionText ?? fetchSubscriptionText,
    readClipboardText: deps.readClipboardText ?? readClipboardText,
    writeClipboardText: deps.writeClipboardText ?? writeClipboardText,
    subscribeTauriEvent: deps.subscribeTauriEvent ?? subscribeTauriEvent,
    fetchCurrentRoutingMode:
      deps.fetchCurrentRoutingMode ?? fetchCurrentRoutingMode,
    fetchConnectionsSnapshot:
      deps.fetchConnectionsSnapshot ?? fetchConnectionsSnapshot,
    queryAutoWinnerNode: deps.queryAutoWinnerNode ?? queryAutoWinnerNode,
    switchClashOutbound: deps.switchClashOutbound ?? switchClashOutbound,
    patchClashRoutingMode:
      deps.patchClashRoutingMode ?? patchClashRoutingMode,
    measureNodeHttp204Delay:
      deps.measureNodeHttp204Delay ?? measureNodeHttp204Delay,
    closeAllClashConnections:
      deps.closeAllClashConnections ?? closeAllClashConnections,
    settleCachedCoreConfig:
      deps.settleCachedCoreConfig ?? settleCachedCoreConfig,
  };

  let telemetrySession: TelemetrySessionLike | null = null;
  let autoWinnerTimer: ReturnType<typeof setInterval> | null = null;
  let initializedOnce = false;
  let lifecycleEpoch = 0;
  let refreshChain: Promise<unknown> = Promise.resolve();
  let lastEffectiveSnapshot: EffectiveRuntimeSnapshot | null = null;
  const unlistenFns: (() => void)[] = [];

  function stopTelemetryAndTimers() {
    if (telemetrySession) {
      telemetrySession.stop();
      telemetrySession = null;
    }
    if (autoWinnerTimer) {
      clearInterval(autoWinnerTimer);
      autoWinnerTimer = null;
    }
  }

  const creator: StateCreator<AppState> = (set, get) => {
    const syncTray = () => {
      const s = get();
      const displayMap = getNodeDisplayMap(s.nodes);
      const displayNode =
        s.selectedOutbound === "auto"
          ? s.autoWinnerNode
            ? `auto → ${resolveNodeDisplayName(s.nodes, s.autoWinnerNode, displayMap) ?? s.autoWinnerNode}`
            : "auto"
          : s.selectedOutbound === "direct"
            ? "direct"
            : (displayMap.get(s.selectedOutbound) ?? "auto");

      void resolveDeps.syncTrayState({
        connected: s.connected,
        sysProxy: s.connected && s.sysProxy,
        tunMode: s.connected && s.tunMode,
        routingMode: s.routingMode,
        activeNode: displayNode,
        terminalShell: s.terminalShell,
      });
    };

    const syncTelemetryStreams = () => {
      if (!telemetrySession) return;
      const s = get();
      if (!s.connected || !s.windowVisible) {
        telemetrySession.configure({
          traffic: false,
          connections: false,
          logs: false,
        });
        return;
      }
      telemetrySession.configure({
        traffic: true,
        connections:
          s.activeTab === "settings" && s.settingsSubTab === "connections",
        logs: s.activeTab === "settings" && s.settingsSubTab === "logs",
      });
    };

    const startTelemetry = () => {
      stopTelemetryAndTimers();
      telemetrySession = resolveDeps.createTelemetrySession({
        onTraffic: (up, down) => {
          const st = get();
          const liveConnStream =
            st.activeTab === "settings" && st.settingsSubTab === "connections";
          telemetryStore.getState().pushTrafficTick(up, down, liveConnStream);
        },
        onConnections: (connections, uploadTotal, downloadTotal) => {
          telemetryStore
            .getState()
            .applyConnectionsSnapshot(connections, uploadTotal, downloadTotal);
        },
        onLog: (entry) => {
          telemetryStore.getState().appendLogEntry(entry);
        },
      });
      syncTelemetryStreams();

      void resolveDeps.fetchConnectionsSnapshot().then((snap) => {
        if (!snap || !get().connected) return;
        telemetryStore
          .getState()
          .applyConnectionsSnapshot(
            snap.connections,
            snap.uploadTotal,
            snap.downloadTotal,
          );
      });

      const refreshWinnerAndGuard = async (periodicTick = false) => {
        const st = get();
        if (!st.connected || !st.windowVisible) return;

        const winner = await resolveDeps.queryAutoWinnerNode();
        if (winner && winner !== get().autoWinnerNode) {
          set({ autoWinnerNode: winner });
          syncTray();
        }

        // 在控制台可见且未常开 /connections WS 时，按 4s 节拍同步一次活跃连接快照，避免控制台连接数冻结为 0
        if (periodicTick) {
          const cur = get();
          const liveConnWs =
            cur.activeTab === "settings" && cur.settingsSubTab === "connections";
          if (cur.connected && cur.windowVisible && !liveConnWs && cur.activeTab === "dashboard") {
            const snap = await resolveDeps.fetchConnectionsSnapshot();
            if (snap && get().connected) {
              telemetryStore
                .getState()
                .applyConnectionsSnapshot(
                  snap.connections,
                  snap.uploadTotal,
                  snap.downloadTotal,
                );
            }
          }
        }

        const latest = get();
        if (latest.sysProxy && !latest.tunMode) {
          const reg = await resolveDeps.getSysProxyState();
          let hijacked: string | null = null;
          if (!reg.enabled) {
            hijacked = "已关闭";
          } else if (reg.server.trim().toLowerCase() !== "127.0.0.1:7890") {
            hijacked = reg.server.trim() || "未知端口";
          }
          if (hijacked !== get().proxyHijackedBy) {
            set({ proxyHijackedBy: hijacked });
          }
        } else if (get().proxyHijackedBy !== null) {
          set({ proxyHijackedBy: null });
        }
      };

      void refreshWinnerAndGuard(false);
      autoWinnerTimer = setInterval(() => {
        void refreshWinnerAndGuard(true);
      }, 4000);
    };

    const buildConfigPayload = (state: AppState) => {
      const usableNodes = omitUnsupportedCertPinNodes(state.nodes);
      const normalizedNodes = isSameEffectiveNodesAndTags(usableNodes)
        ? usableNodes
        : ensureUniqueTags(usableNodes);
      const validSelection = isSelectionValid(
        normalizedNodes,
        state.selectedOutbound,
      )
        ? state.selectedOutbound
        : "auto";
      const brutalDown = state.brutalDownMbps ?? 0;
      const brutalUp = state.brutalUpMbps ?? legacyBrutalUpFor(brutalDown);
      const configObj = buildSingBoxConfig({
        nodes: normalizedNodes,
        selectedOutbound: validSelection,
        routingMode: state.routingMode,
        tunMode: state.tunMode,
        forceProxyText: state.forceProxyText,
        forceDirectText: state.forceDirectText,
        aiSuiteProxyEnabled: state.aiSuiteProxyEnabled,
        dnsLeakProtection: state.dnsLeakProtection,
        brutalDownMbps: brutalDown,
        brutalUpMbps: brutalUp,
      });
      const displayMap = getNodeDisplayMap(normalizedNodes);
      const activeNodeDisplay =
        validSelection === "auto"
          ? get().autoWinnerNode
            ? `auto → ${resolveNodeDisplayName(normalizedNodes, get().autoWinnerNode, displayMap) ?? get().autoWinnerNode}`
            : "auto"
          : validSelection === "direct"
            ? "direct"
            : (displayMap.get(validSelection) ?? "auto");

      return {
        normalizedNodes,
        validSelection,
        configJson: JSON.stringify(configObj, null, 2),
        activeNodeDisplay,
      };
    };

    const revertUncommittedConfigFields = (includeRulesText = false) => {
      if (!lastEffectiveSnapshot) return;
      const snap = lastEffectiveSnapshot;
      set((cur) => ({
        nodes: snap.nodes,
        subscriptions: snap.subscriptions,
        selectedOutbound: snap.selectedOutbound,
        routingMode: snap.routingMode,
        sysProxy: snap.sysProxy,
        sysProxyBeforeTun: snap.sysProxyBeforeTun,
        tunMode: snap.tunMode,
        dnsLeakProtection: snap.dnsLeakProtection,
        brutalDownMbps: snap.brutalDownMbps,
        brutalUpMbps: snap.brutalUpMbps,
        ...(includeRulesText
          ? {
              forceProxyText: snap.forceProxyText,
              forceDirectText: snap.forceDirectText,
              aiSuiteProxyEnabled: snap.aiSuiteProxyEnabled,
              rulesDirty: false,
            }
          : {
              rulesDirty:
                cur.forceProxyText !== snap.forceProxyText ||
                cur.forceDirectText !== snap.forceDirectText ||
                cur.aiSuiteProxyEnabled !== snap.aiSuiteProxyEnabled,
            }),
      }));
    };

    const dropUnsupportedCertPinNodes = (announce: boolean): boolean => {
      const current = get().nodes;
      const skipped = current.filter((node) =>
        shareUriRequiresUnsupportedCertPin(node.rawUri),
      );
      if (skipped.length === 0) return current.length > 0;
      const usable = omitUnsupportedCertPinNodes(current);
      const previous = get().selectedOutbound;
      const nextSelected = isSelectionValid(usable, previous) ? previous : "auto";
      const stayedDisconnected = usable.length === 0;
      const effect: CertPinSkipEffect | undefined = stayedDisconnected
        ? "stay-disconnected"
        : nextSelected === "auto" &&
            previous !== "auto" &&
            previous !== "direct"
          ? "fallback-auto"
          : undefined;
      set({
        nodes: ensureUniqueTags(usable),
        selectedOutbound: nextSelected,
        ...(stayedDisconnected ? { lastConnected: false } : {}),
      });
      if (announce) {
        get().pushToast(
          "error",
          formatCertPinSkipSummary(skipped.length, effect),
        );
      }
      return usable.length > 0;
    };

    const enqueueRefresh = <T>(task: () => Promise<T>): Promise<T> => {
      const run = refreshChain.then(task, task);
      refreshChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const pullSubscriptionUpdate = async (
      sub: SubscriptionItem,
    ): Promise<PreparedSubscriptionUpdate> => {
      const stillThere = () =>
        get().subscriptions.some((item) => item.id === sub.id);
      if (!stillThere()) {
        return {
          id: sub.id,
          name: sub.name,
          status: "dropped",
          parsedNodes: [],
          skipped: [],
        };
      }
      try {
        const body = await resolveDeps.fetchSubscriptionText(sub.url);
        if (!stillThere()) {
          return {
            id: sub.id,
            name: sub.name,
            status: "dropped",
            parsedNodes: [],
            skipped: [],
          };
        }
        const batch = parseShareBatch(body, sub.id);
        if (!stillThere()) {
          return {
            id: sub.id,
            name: sub.name,
            status: "dropped",
            parsedNodes: [],
            skipped: batch.skipped,
          };
        }
        if (batch.nodes.length === 0 && batch.skipped.length === 0) {
          return {
            id: sub.id,
            name: sub.name,
            status: "empty",
            parsedNodes: [],
            skipped: [],
          };
        }
        return {
          id: sub.id,
          name: sub.name,
          status: "ready",
          parsedNodes: batch.nodes,
          skipped: batch.skipped,
        };
      } catch (err) {
        if (!stillThere()) {
          return {
            id: sub.id,
            name: sub.name,
            status: "dropped",
            parsedNodes: [],
            skipped: [],
          };
        }
        return {
          id: sub.id,
          name: sub.name,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          parsedNodes: [],
          skipped: [],
        };
      }
    };

    const commitSubscriptionUpdates = async (
      results: PreparedSubscriptionUpdate[],
      silent: boolean,
    ) => {
      const liveIds = new Set(get().subscriptions.map((item) => item.id));
      const applicable = results.filter(
        (result) => result.status === "ready" && liveIds.has(result.id),
      );
      const updates = new Map<string, ProxyNode[]>();
      for (const result of applicable) {
        const existing = get().nodes.filter(
          (node) => node.subscriptionId === result.id,
        );
        updates.set(
          result.id,
          matchSubscriptionNodeIds(existing, result.parsedNodes),
        );
      }

      const reportRefreshProblems = () => {
        if (silent) return;
        for (const result of results) {
          if (!liveIds.has(result.id)) continue;
          if (result.status === "empty") {
            get().pushToast("error", `订阅「${result.name}」返回节点为空`);
          } else if (result.status === "failed") {
            get().pushToast(
              "error",
              `刷新「${result.name}」失败${result.error ? `: ${result.error}` : ""}`,
            );
          }
        }
      };

      if (updates.size === 0) {
        reportRefreshProblems();
        return;
      }

      const beforeIds = get().nodes.map((node) => node.id);
      const beforeSelected = get().selectedOutbound;
      const wasConnected = get().connected;
      const beforeJson = buildConfigPayload(get()).configJson;
      const merged = ensureUniqueTags(
        mergeSubscriptionNodes(get().nodes, updates),
      );
      const nextSelected = isSelectionValid(merged, beforeSelected)
        ? beforeSelected
        : "auto";
      const updatedAt = Date.now();
      const nextSubscriptions = get().subscriptions.map((item) => {
        const update = updates.get(item.id);
        if (!update) return item;
        return { ...item, updatedAt, nodeCount: update.length };
      });
      set({
        nodes: merged,
        selectedOutbound: nextSelected,
        subscriptions: nextSubscriptions,
      });

      const afterIds = new Set(get().nodes.map((node) => node.id));
      const removedCount = beforeIds.filter((id) => !afterIds.has(id)).length;
      const pinSkipped = results.reduce(
        (sum, result) => sum + result.skipped.length,
        0,
      );
      const pinDropped = pinSkipped > 0 && removedCount > 0;
      const stayedDisconnected = get().nodes.length === 0;
      const fellBack =
        nextSelected === "auto" &&
        beforeSelected !== "auto" &&
        beforeSelected !== "direct";
      if (pinSkipped > 0) {
        const effect: CertPinSkipEffect | undefined = stayedDisconnected
          ? "stay-disconnected"
          : fellBack
            ? "fallback-auto"
            : undefined;
        get().pushToast("error", formatCertPinSkipSummary(pinSkipped, effect));
      }

      const configChanged =
        buildConfigPayload(get()).configJson !== beforeJson;
      if (pinDropped && !wasConnected && get().connecting) {
        await get().disconnectCore();
      }
      if (pinDropped || (configChanged && !wasConnected && !get().connecting)) {
        await resolveDeps.settleCachedCoreConfig(true);
      }

      if (wasConnected && configChanged) {
        if (get().nodes.length === 0) {
          await get().disconnectCore();
        } else {
          const status = await get().reloadCoreConfig(true, !pinDropped);
          if (status !== "applied") {
            if (pinDropped && status !== "cancelled" && status !== "superseded") {
              set({
                nodes: merged,
                selectedOutbound: nextSelected,
                subscriptions: nextSubscriptions,
                lastConnected: false,
              });
              if (get().connected) await get().disconnectCore();
              await resolveDeps.settleCachedCoreConfig(true);
            }
            reportRefreshProblems();
            return;
          }
        }
      } else if (wasConnected && lastEffectiveSnapshot) {
        const current = get();
        lastEffectiveSnapshot.nodes = current.nodes;
        lastEffectiveSnapshot.subscriptions = current.subscriptions;
        lastEffectiveSnapshot.selectedOutbound = current.selectedOutbound;
        syncTray();
      } else {
        syncTray();
      }

      if (!silent && !(pinDropped && stayedDisconnected)) {
        if (results.length === 1 && applicable.length === 1) {
          const only = applicable[0];
          if (only) {
            get().pushToast(
              "success",
              `已更新「${only.name}」(${updates.get(only.id)?.length ?? 0} 节点)`,
            );
          }
        } else if (applicable.length > 0) {
          get().pushToast("success", `已更新 ${applicable.length} 个订阅`);
        }
      }
      reportRefreshProblems();
    };

    return {
      nodes: [],
      subscriptions: [],
      selectedOutbound: "auto",
      routingMode: "rule",
      sysProxy: true,
      sysProxyBeforeTun: true,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
      aiSuiteProxyEnabled: true,
      dnsLeakProtection: true,
      theme: "system",
      terminalShell: "powershell",
      brutalDownMbps: 0,
      brutalUpMbps: 0,
      autoRestoreConnect: true,
      autoRefreshSubs: true,
      lastConnected: false,
      selectionMigrated: true,
      certPinNotice: null,
      systemEnvBackup: null,

      activeTab: "dashboard",
      settingsSubTab: "connections",
      windowVisible: true,
      connected: false,
      connecting: false,
      rulesDirty: false,
      autoWinnerNode: null,
      isAdmin: false,
      autostartEnabled: false,
      showTunPrivilegeModal: false,
      proxyHijackedBy: null,
      batchTesting: false,
      toasts: [],
      certPinPurged: false,

      setActiveTab: (tab) => {
        set({ activeTab: tab });
        syncTelemetryStreams();
      },
      setSettingsSubTab: (sub) => {
        set({ settingsSubTab: sub });
        syncTelemetryStreams();
      },
      setWindowVisible: (visible) => {
        set({ windowVisible: visible });
        syncTelemetryStreams();
      },
      setTheme: (theme) => set({ theme }),
      setTerminalShell: (terminalShell) => {
        set({ terminalShell });
        syncTray();
      },

      pushToast: (type, message) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((s) => ({
          toasts: [...s.toasts.slice(-3), { id, type, message }],
        }));
        setTimeout(() => {
          get().dismissToast(id);
        }, 3200);
      },

      dismissToast: (id) =>
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      setShowTunPrivilegeModal: (show) => set({ showTunPrivilegeModal: show }),

      initializeApp: async () => {
        if (initializedOnce) return;
        initializedOnce = true;

        const curState = get();
        if (
          !isSameEffectiveNodesAndTags(curState.nodes) ||
          !isSelectionValid(curState.nodes, curState.selectedOutbound)
        ) {
          const normalized = ensureUniqueTags(
            curState.nodes.map((n) => (n.testing ? { ...n, testing: false } : n)),
          );
          set({
            nodes: normalized,
            selectedOutbound: isSelectionValid(
              normalized,
              curState.selectedOutbound,
            )
              ? curState.selectedOutbound
              : "auto",
          });
        }

        const [ctx, autostart] = await Promise.all([
          resolveDeps.getLaunchContext(),
          resolveDeps.getAutostartStatus(),
        ]);

        const purgedCertPins = get().certPinPurged;
        try {
          await resolveDeps.settleCachedCoreConfig(
            purgedCertPins,
            buildConfigPayload(get()).configJson,
          );
        } catch {
          // 缓存结算失败时不阻断启动；无策略标记的旧文件仍不能被托盘重连复用
        }
        if (purgedCertPins) {
          set({ certPinPurged: false });
        }
        const pinNotice = get().certPinNotice;
        if (pinNotice) {
          get().pushToast("error", pinNotice);
          if (!ctx.silent) {
            set({ certPinNotice: null });
          }
        }

        set({
          isAdmin: ctx.isAdmin,
          autostartEnabled: autostart,
        });

        const unlistenTray = await resolveDeps.subscribeTauriEvent<string>(
          "tray-action",
          (action) => {
            const st = get();
            if (action === "toggle-connect") void st.toggleConnection();
            else if (action === "toggle-sysproxy") void st.toggleSysProxy();
            else if (action === "toggle-tun") void st.toggleTunMode();
            else if (action === "mode-rule") void st.setRoutingMode("rule");
            else if (action === "mode-global") void st.setRoutingMode("global");
            else if (action === "mode-direct") void st.setRoutingMode("direct");
            else if (action === "copied-terminal-proxy") {
              st.pushToast("success", "已复制终端代理环境变量命令");
            }
          },
        );
        unlistenFns.push(unlistenTray);

        // Rust 层已完成进程归属判断、句柄清理、LayNet 代理释放与托盘同步；前端只需同步显示与遥测并保留代理偏好
        let attachingToCore = ctx.coreRunning;
        const unlistenExited = await resolveDeps.subscribeTauriEvent<string>(
          "core-exited",
          (reason) => {
            if (!attachingToCore && !get().connected && !get().connecting) return;
            attachingToCore = false;
            lifecycleEpoch++;
            stopTelemetryAndTimers();
            lastEffectiveSnapshot = null;
            telemetryStore.getState().resetSessionTelemetry();
            set({
              connected: false,
              connecting: false,
              lastConnected: false,
              autoWinnerNode: null,
              proxyHijackedBy: null,
            });
            syncTray();
            get().pushToast("error", `内核已停止: ${reason}`);
          },
        );
        unlistenFns.push(unlistenExited);

        const unlistenStdio = await resolveDeps.subscribeTauriEvent<string>(
          "core-stdio",
          (line) => {
            const lower = line.toLowerCase();
            const isFatal = lower.includes("fatal");
            const st = get();
            const liveLogWs =
              st.connected &&
              st.windowVisible &&
              st.activeTab === "settings" &&
              st.settingsSubTab === "logs";
            // 当 /logs WebSocket 已激活时，跳过非致命 stdio 行，防止同一条内核日志重复渲染两遍
            if (liveLogWs && !isFatal) return;

            const now = new Date().toTimeString().slice(0, 8);
            const type: CoreLogEntry["type"] =
              lower.includes("error") || isFatal
                ? "error"
                : lower.includes("warn")
                  ? "warning"
                  : "info";
            telemetryStore.getState().appendLogEntry({
              id: Date.now() + Math.random(),
              time: now,
              type,
              payload: line,
            });
          },
        );
        unlistenFns.push(unlistenStdio);

        // 场景 0: 从托盘重新唤醒销毁后的 WebView2 窗口且内核仍在运行
        if (ctx.coreRunning) {
          const [liveMode, snap, winner] = await Promise.all([
            resolveDeps.fetchCurrentRoutingMode(),
            resolveDeps.fetchConnectionsSnapshot(),
            resolveDeps.queryAutoWinnerNode(),
          ]);
          if (!attachingToCore) return;
          attachingToCore = false;
          const nextMode =
            liveMode ?? normalizeRoutingMode(ctx.routingMode, get().routingMode);
          const nextSysProxy = ctx.isColdStart
            ? get().sysProxy
            : ctx.preferredSysProxy;
          set({
            connected: true,
            connecting: false,
            lastConnected: true,
            sysProxy: nextSysProxy,
            tunMode: ctx.tunMode,
            routingMode: nextMode,
            autoWinnerNode: winner,
          });
          lastEffectiveSnapshot = captureEffectiveSnapshot(get());
          if (snap) {
            telemetryStore
              .getState()
              .applyConnectionsSnapshot(
                snap.connections,
                snap.uploadTotal,
                snap.downloadTotal,
              );
          }
          startTelemetry();
          syncTray();
          if (ctx.pendingExitError) {
            get().pushToast("error", ctx.pendingExitError);
          }
          return;
        }

        if (ctx.reconnectRequested) {
          await get().connectCore();
          return;
        }

        // 场景 0b: 非冷启动（从托盘重新打开窗口），且内核在后台已断开或异常退出 -> 保持与托盘一致的断开态，不意外重连
        if (!ctx.isColdStart) {
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
            sysProxy: ctx.preferredSysProxy,
            tunMode: ctx.tunMode,
            routingMode: normalizeRoutingMode(ctx.routingMode, get().routingMode),
            autoWinnerNode: null,
            proxyHijackedBy: null,
          });
          telemetryStore.getState().resetSessionTelemetry();
          syncTray();
          if (ctx.pendingExitError) {
            get().pushToast("error", `内核已停止: ${ctx.pendingExitError}`);
          }
          return;
        }

        // 真正冷启动流程
        syncTray();

        const startupRefresh = get().autoRefreshSubs && get().subscriptions.length > 0
          ? get().refreshAllSubscriptions(true)
          : undefined;

        if (ctx.relaunchTun && ctx.isAdmin) {
          await startupRefresh;
          set({
            sysProxyBeforeTun: get().sysProxy || get().sysProxyBeforeTun,
            tunMode: true,
            sysProxy: false,
          });
          if (get().nodes.length > 0) {
            await get().connectCore();
          } else {
            get().pushToast(
              "success",
              "已获取管理员权限，导入节点后即可使用 TUN 模式",
            );
          }
          return;
        }

        if (
          (ctx.silent || get().autoRestoreConnect) &&
          get().lastConnected &&
          get().nodes.length > 0
        ) {
          if (get().tunMode && !ctx.isAdmin) {
            set({ tunMode: false });
          }
          await get().connectCore();
        }

        if (ctx.silent) {
          await startupRefresh;
          await resolveDeps.releaseWindowToTray();
        }
      },

      connectCore: async () => {
        const state = get();
        if (state.connected || state.connecting) return;

        const hadNodes = state.nodes.length > 0;
        if (!dropUnsupportedCertPinNodes(true)) {
          set({ activeTab: "nodes" });
          if (!hadNodes) {
            state.pushToast("info", "节点库为空，请先剪贴板导入节点或添加订阅");
          } else {
            await resolveDeps.settleCachedCoreConfig(true);
          }
          return;
        }

        if (state.tunMode) {
          const adminNow = await resolveDeps.checkAdminPrivilege();
          set({ isAdmin: adminNow });
          if (!adminNow) {
            set({ showTunPrivilegeModal: true });
            return;
          }
        }

        const myEpoch = ++lifecycleEpoch;
        set({ connecting: true });

        try {
          let res: CoreApplyResult;
          while (true) {
            const current = get();
            const payload = buildConfigPayload(current);
            if (payload.normalizedNodes.length === 0) {
              await get().disconnectCore();
              return;
            }

            res = await resolveDeps.applyLayNetCoreConfig({
              configJson: payload.configJson,
              sysProxy: current.sysProxy,
              tunMode: current.tunMode,
              routingMode: current.routingMode,
              activeNode: payload.activeNodeDisplay,
              allowRollback: false,
            });

            if (
              myEpoch !== lifecycleEpoch ||
              res.status === "cancelled" ||
              res.status === "superseded"
            ) {
              return;
            }

            const latest = get();
            const latestPayload = buildConfigPayload(latest);
            if (
              latestPayload.configJson !== payload.configJson ||
              latest.sysProxy !== current.sysProxy
            ) {
              continue;
            }
            if (res.status !== "applied") break;

            set({
              nodes: latestPayload.normalizedNodes,
              selectedOutbound: latestPayload.validSelection,
              connected: true,
              connecting: false,
              rulesDirty: false,
              lastConnected: true,
            });
            lastEffectiveSnapshot = captureEffectiveSnapshot(get());
            startTelemetry();
            syncTray();
            latest.pushToast(
              "success",
              latest.tunMode
                ? "LayNet 已连接 · LayTun 全局三层接管生效"
                : latest.sysProxy
                  ? "LayNet 已连接 · 系统代理 (127.0.0.1:7890) 已接管"
                  : "LayNet 内核已启动 (本地端口 127.0.0.1:7890)",
            );
            return;
          }

          if (res.runningAfter) {
            await resolveDeps.stopLayNetCore();
            if (myEpoch !== lifecycleEpoch) return;
          }
          stopTelemetryAndTimers();
          lastEffectiveSnapshot = null;
          telemetryStore.getState().resetSessionTelemetry();
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
          });
          syncTray();
          const msg = res.error || "连接失败";
          get().pushToast("error", msg);
        } catch (err) {
          if (myEpoch !== lifecycleEpoch) return;
          stopTelemetryAndTimers();
          lastEffectiveSnapshot = null;
          await resolveDeps.stopLayNetCore();
          telemetryStore.getState().resetSessionTelemetry();
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
          });
          syncTray();
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", msg);
        }
      },

      disconnectCore: async () => {
        lifecycleEpoch++;
        stopTelemetryAndTimers();
        lastEffectiveSnapshot = null;
        try {
          await resolveDeps.stopLayNetCore();
        } finally {
          telemetryStore.getState().resetSessionTelemetry();
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
            autoWinnerNode: null,
            proxyHijackedBy: null,
          });
          syncTray();
          get().pushToast("info", "已断开连接并复位系统网络代理");
        }
      },

      toggleConnection: async () => {
        if (get().connected) {
          await get().disconnectCore();
        } else {
          await get().connectCore();
        }
      },

      reloadCoreConfig: async (silentToast = false, allowRollback = true) => {
        if (!get().connected) return "failed";
        if (!dropUnsupportedCertPinNodes(true)) {
          await resolveDeps.settleCachedCoreConfig(true);
          await get().disconnectCore();
          return "failed";
        }

        const s = get();
        const myEpoch = ++lifecycleEpoch;
        set({ connecting: true });

        try {
          const { normalizedNodes, validSelection, configJson, activeNodeDisplay } =
            buildConfigPayload(s);

          const res = await resolveDeps.applyLayNetCoreConfig({
            configJson,
            sysProxy: s.sysProxy,
            tunMode: s.tunMode,
            routingMode: s.routingMode,
            activeNode: activeNodeDisplay,
            allowRollback,
          });

          if (myEpoch !== lifecycleEpoch) {
            return "cancelled";
          }
          if (res.status === "cancelled" || res.status === "superseded") {
            return res.status;
          }

          if (res.status === "applied") {
            const latest = get();
            set({
              ...(latest.nodes !== normalizedNodes
                ? { nodes: normalizedNodes }
                : {}),
              ...(latest.selectedOutbound !== validSelection
                ? { selectedOutbound: validSelection }
                : {}),
              connected: true,
              connecting: false,
              rulesDirty: false,
              proxyHijackedBy: null,
            });
            lastEffectiveSnapshot = captureEffectiveSnapshot(get());
            startTelemetry();
            syncTray();
            if (!silentToast) {
              get().pushToast("success", "运行配置已热重载生效");
            }
            return "applied";
          }

          if (res.runningAfter) {
            if (allowRollback) revertUncommittedConfigFields(false);
            set({
              connected: true,
              connecting: false,
              proxyHijackedBy: null,
            });
            if (res.failureStage !== "precheck" || !telemetrySession) {
              startTelemetry();
            }
            syncTray();
            const detail = res.error || "未知错误";
            get().pushToast("error", res.status === "rolled_back"
              ? `新配置切换失败（${detail}），已回滚至上一生效配置`
              : `新配置应用失败（${detail}），原连接仍在运行`);
            return res.status;
          }

          // 候选与回滚均失败：转断开并释放 LayNet 代理
          stopTelemetryAndTimers();
          telemetryStore.getState().resetSessionTelemetry();
          if (allowRollback) revertUncommittedConfigFields(false);
          lastEffectiveSnapshot = null;
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
            autoWinnerNode: null,
            proxyHijackedBy: null,
          });
          syncTray();
          const detail = [res.error, res.rollbackError]
            .filter(Boolean)
            .join("；");
          get().pushToast(
            "error",
            detail || "重载配置失败且回滚失败，已断开连接",
          );
          return "failed";
        } catch (err) {
          if (myEpoch !== lifecycleEpoch) return "cancelled";
          stopTelemetryAndTimers();
          telemetryStore.getState().resetSessionTelemetry();
          if (allowRollback) revertUncommittedConfigFields(false);
          lastEffectiveSnapshot = null;
          set({
            connected: false,
            connecting: false,
            lastConnected: false,
            autoWinnerNode: null,
            proxyHijackedBy: null,
          });
          syncTray();
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", `重载配置失败: ${msg}`);
          return "failed";
        }
      },

      toggleSysProxy: async () => {
        const cur = get();
        // TUN 模式激活时开启系统代理：自动关闭 TUN 并切回系统代理模式，杜绝双栈套娃与托盘状态冲突
        if (cur.tunMode) {
          set({
            tunMode: false,
            sysProxy: true,
            sysProxyBeforeTun: true,
            proxyHijackedBy: null,
          });
          if (get().connected) {
            const status = await get().reloadCoreConfig(true);
            if (status === "applied") {
              get().pushToast(
                "success",
                "已关闭 TUN 并切换为系统代理 (127.0.0.1:7890)",
              );
            }
          } else {
            syncTray();
          }
          return;
        }

        const next = !cur.sysProxy;
        set({
          sysProxy: next,
          sysProxyBeforeTun: next,
          proxyHijackedBy: null,
        });
        if (get().connected) {
          try {
            await resolveDeps.setWindowsSystemProxy(next, 7890);
            if (lastEffectiveSnapshot) {
              lastEffectiveSnapshot.sysProxy = next;
              lastEffectiveSnapshot.sysProxyBeforeTun = next;
            }
            syncTray();
            get().pushToast(
              "success",
              next ? "系统代理已开启 (127.0.0.1:7890)" : "系统代理已关闭",
            );
          } catch (err) {
            set({ sysProxy: !next, sysProxyBeforeTun: !next });
            const msg = err instanceof Error ? err.message : String(err);
            get().pushToast("error", msg);
          }
        } else {
          syncTray();
        }
      },

      reclaimSystemProxy: async () => {
        try {
          await resolveDeps.setWindowsSystemProxy(true, 7890);
          set({ sysProxy: true, proxyHijackedBy: null });
          if (lastEffectiveSnapshot) {
            lastEffectiveSnapshot.sysProxy = true;
          }
          syncTray();
          get().pushToast("success", "已重新接管系统代理 (127.0.0.1:7890)");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", `恢复系统代理失败: ${msg}`);
        }
      },

      toggleTunMode: async () => {
        const next = !get().tunMode;
        if (next) {
          const adminNow = await resolveDeps.checkAdminPrivilege();
          set({ isAdmin: adminNow });
          if (!adminNow) {
            set({ showTunPrivilegeModal: true });
            return;
          }
          set({
            sysProxyBeforeTun: get().sysProxy,
            tunMode: true,
            sysProxy: false,
            proxyHijackedBy: null,
          });
        } else {
          const restoreSys = get().sysProxyBeforeTun;
          set({
            tunMode: false,
            sysProxy: restoreSys,
            proxyHijackedBy: null,
          });
        }

        if (get().connected) {
          const status = await get().reloadCoreConfig(true);
          if (status === "applied") {
            get().pushToast(
              "success",
              next
                ? "TUN 模式已开启 · 已自动暂停系统代理并防 QUIC 套娃"
                : get().sysProxy
                  ? "TUN 模式已关闭 · 已自动恢复系统代理"
                  : "TUN 模式已关闭",
            );
          }
        } else {
          syncTray();
        }
      },

      confirmElevateForTun: async () => {
        set({ showTunPrivilegeModal: false });
        const prev = {
          sysProxyBeforeTun: get().sysProxyBeforeTun,
          tunMode: get().tunMode,
          sysProxy: get().sysProxy,
          lastConnected: get().lastConnected,
        };
        try {
          set({
            sysProxyBeforeTun: get().sysProxy,
            tunMode: true,
            sysProxy: false,
            lastConnected: true,
          });
          await resolveDeps.elevateForTun();
        } catch (err) {
          set(prev);
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", msg);
        }
      },

      copyTerminalProxy: async () => {
        const shell = get().terminalShell;
        const cmd = buildTerminalProxyCommand(shell);
        try {
          await resolveDeps.writeClipboardText(cmd);
          get().pushToast(
            "success",
            `已复制 ${shell === "powershell" ? "PowerShell" : "CMD"} 终端代理命令`,
          );
        } catch {
          get().pushToast("error", "写入系统剪贴板失败");
        }
      },

      setRoutingMode: async (mode) => {
        const prev = get().routingMode;
        if (prev === mode) return;
        set({ routingMode: mode });
        if (get().connected) {
          try {
            await resolveDeps.patchClashRoutingMode(mode);
            if (lastEffectiveSnapshot) {
              lastEffectiveSnapshot.routingMode = mode;
            }
            syncTray();
            const label =
              mode === "rule"
                ? "规则分流 (Rule)"
                : mode === "global"
                  ? "全局代理 (Global)"
                  : "全局直连 (Direct)";
            get().pushToast("success", `已无感切换至 ${label}`);
          } catch (err) {
            set({ routingMode: prev });
            const msg = err instanceof Error ? err.message : String(err);
            get().pushToast("error", msg);
          }
        } else {
          syncTray();
        }
      },

      selectOutbound: async (idOrBuiltin) => {
        const prev = get().selectedOutbound;
        const nodes = get().nodes;
        const targetTag = resolveSelectedOutboundTag(nodes, idOrBuiltin);
        const resolvedSelection =
          idOrBuiltin === "auto" || idOrBuiltin === "direct"
            ? idOrBuiltin
            : (nodes.find((n) => n.id === idOrBuiltin || n.tag === idOrBuiltin)
                ?.id ?? "auto");

        set({ selectedOutbound: resolvedSelection });
        if (get().connected) {
          try {
            await resolveDeps.switchClashOutbound(targetTag, "proxy");
            if (lastEffectiveSnapshot) {
              lastEffectiveSnapshot.selectedOutbound = resolvedSelection;
            }
            syncTray();
          } catch (err) {
            set({ selectedOutbound: prev });
            const msg = err instanceof Error ? err.message : String(err);
            get().pushToast("error", msg);
          }
        } else {
          syncTray();
        }
      },

      setForceProxyText: (val) =>
        set((s) => ({ forceProxyText: val, rulesDirty: s.connected })),

      setForceDirectText: (val) =>
        set((s) => ({ forceDirectText: val, rulesDirty: s.connected })),

      setAiSuiteProxyEnabled: (val) =>
        set((s) => ({ aiSuiteProxyEnabled: val, rulesDirty: s.connected })),

      applyCustomRules: async () => {
        if (get().connected) {
          if (!get().rulesDirty) {
            get().pushToast("info", "分流规则未发生变更");
            return true;
          }
          const status = await get().reloadCoreConfig(true);
          if (status === "applied") {
            get().pushToast("success", "自定义黑白名单规则已置顶注入并生效");
            return true;
          }
          return false;
        } else {
          set({ rulesDirty: false });
          get().pushToast("success", "自定义分流规则已保存，启动连接时自动注入");
          return true;
        }
      },

      importRawLinks: async (text) => {
        const batch = parseShareBatch(text);
        if (batch.nodes.length === 0) {
          if (batch.skipped.length > 0) {
            get().pushToast(
              "error",
              formatCertPinSkipSummary(batch.skipped.length),
            );
            return -2;
          }
          return 0;
        }

        const existingUris = new Set(get().nodes.map((n) => n.rawUri));
        const fresh = batch.nodes.filter((n) => !existingUris.has(n.rawUri));
        if (fresh.length > 0) {
          set({ nodes: ensureUniqueTags([...get().nodes, ...fresh]) });
          if (get().connected) {
            const status = await get().reloadCoreConfig(true);
            if (status !== "applied") return -1;
          }
        }
        if (batch.skipped.length > 0) {
          get().pushToast(
            "error",
            formatCertPinSkipSummary(batch.skipped.length),
          );
        }
        return fresh.length > 0 ? fresh.length : batch.nodes.length;
      },

      importFromClipboard: async () => {
        try {
          const text = await resolveDeps.readClipboardText();
          if (!text || !text.trim()) {
            get().pushToast("info", "剪贴板为空，请先复制分享链接或 Base64 订阅内容");
            return;
          }
          const trimmed = text.trim();
          if (/^https?:\/\/\S+$/i.test(trimmed) && !trimmed.includes("\n")) {
            const hostName = (() => {
              try {
                return new URL(trimmed).hostname;
              } catch {
                return "远程订阅";
              }
            })();
            await get().addSubscription(hostName, trimmed);
            return;
          }

          const count = await get().importRawLinks(trimmed);
          if (count === -2 || count === -1) return;
          if (count === 0) {
            get().pushToast(
              "error",
              "未识别到有效节点（支持 vless / hy2 / hysteria2 / ss / trojan 及 Base64）",
            );
          } else if (count > 0) {
            get().pushToast("success", `成功导入 ${count} 个节点`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", `读取剪贴板失败: ${msg}`);
        }
      },

      updateNodeConfig: async (id, patch) => {
        const prevTarget = get().nodes.find((n) => n.id === id);
        if (!prevTarget) return;

        const wasConnected = get().connected;
        const beforeConfigJson = wasConnected
          ? buildConfigPayload(get()).configJson
          : "";

        const cleanName = patch.name.trim() || prevTarget.name;
        const updatedList = get().nodes.map((node) => {
          if (node.id !== id) return node;
          const nextNode = { ...node, name: cleanName };

          if (node.protocol === "hysteria2" && node.hysteria2) {
            const serverPorts =
              patch.mport && patch.mport.trim()
                ? normalizeMportToSingBox(patch.mport)
                : undefined;
            const downMbps =
              patch.downMbps && patch.downMbps > 0 ? patch.downMbps : undefined;
            const upMbps =
              patch.upMbps && patch.upMbps > 0 ? patch.upMbps : undefined;

            nextNode.hysteria2 = {
              ...node.hysteria2,
              downMbps,
              upMbps,
              serverPorts:
                serverPorts && serverPorts.length > 0 ? serverPorts : undefined,
            };
            nextNode.rawUri = rebuildHysteria2RawUri(node, {
              name: cleanName,
              mport: patch.mport,
              downMbps,
              upMbps,
            });
          } else {
            const hashIdx = nextNode.rawUri.indexOf("#");
            const baseUri =
              hashIdx === -1 ? nextNode.rawUri : nextNode.rawUri.slice(0, hashIdx);
            nextNode.rawUri = `${baseUri}#${encodeURIComponent(cleanName)}`;
          }

          return nextNode;
        });

        const normalized = ensureUniqueTags(updatedList);
        set({ nodes: normalized });
        if (wasConnected) {
          const afterConfigJson = buildConfigPayload(get()).configJson;
          // 仅修改节点显示名称时，底层 outbound 配置零变化，无需杀进程重启内核断流
          if (afterConfigJson === beforeConfigJson) {
            if (lastEffectiveSnapshot) {
              lastEffectiveSnapshot.nodes = normalized;
            }
            syncTray();
            get().pushToast("success", "节点名称已更新");
            return;
          }
          const status = await get().reloadCoreConfig(true);
          if (status === "applied") {
            get().pushToast("success", "节点参数已保存并重载生效");
          }
        } else {
          syncTray();
          get().pushToast("success", "节点参数已保存");
        }
      },

      sortNodesByLatency: () => {
        const sorted = [...get().nodes].sort((a, b) => {
          const rank = (lat?: number) => {
            if (lat !== undefined && lat > 0) return lat;
            if (lat === undefined) return 999_998;
            return 999_999;
          };
          return rank(a.latency) - rank(b.latency);
        });
        set({ nodes: sorted });
        if (lastEffectiveSnapshot) {
          lastEffectiveSnapshot.nodes = sorted;
        }
        get().pushToast("success", "已按延迟由低到高排序");
      },

      removeNode: async (id) => {
        const remaining = ensureUniqueTags(
          get().nodes.filter((n) => n.id !== id),
        );
        const nextSelected =
          get().selectedOutbound === id ? "auto" : get().selectedOutbound;
        set({ nodes: remaining, selectedOutbound: nextSelected });
        if (get().connected) {
          if (remaining.length === 0) {
            await get().disconnectCore();
          } else {
            await get().reloadCoreConfig(true);
          }
        } else {
          syncTray();
        }
      },

      clearAllNodes: async (keepSubscriptions = false) => {
        if (keepSubscriptions) {
          const subNodeIds = new Set(
            get()
              .nodes.filter((n) => Boolean(n.subscriptionId))
              .map((n) => n.id),
          );
          const remaining = ensureUniqueTags(
            get().nodes.filter((n) => subNodeIds.has(n.id)),
          );
          const nextSelected = isSelectionValid(
            remaining,
            get().selectedOutbound,
          )
            ? get().selectedOutbound
            : "auto";
          set({ nodes: remaining, selectedOutbound: nextSelected });
          if (get().connected) {
            if (remaining.length === 0) {
              await get().disconnectCore();
            } else {
              await get().reloadCoreConfig(true);
            }
          } else {
            syncTray();
          }
          get().pushToast("info", "已清空手动导入节点（订阅已保留）");
          return;
        }
        set({ nodes: [], subscriptions: [], selectedOutbound: "auto" });
        if (get().connected) {
          await get().disconnectCore();
        } else {
          syncTray();
          get().pushToast("info", "已清空全部节点与订阅");
        }
      },

      addSubscription: async (name, url) => {
        const cleanUrl = url.trim();
        if (!/^https?:\/\//i.test(cleanUrl)) {
          get().pushToast("error", "请输入合法的 http:// 或 https:// 订阅地址");
          return;
        }
        const subId = `sub-${makeNodeId()}`;
        const label =
          name.trim() ||
          (() => {
            try {
              return new URL(cleanUrl).hostname;
            } catch {
              return "远程订阅";
            }
          })();

        try {
          const body = await resolveDeps.fetchSubscriptionText(cleanUrl);
          const batch = parseShareBatch(body, subId);
          if (batch.nodes.length === 0) {
            get().pushToast(
              "error",
              batch.skipped.length > 0
                ? formatCertPinSkipSummary(batch.skipped.length)
                : "订阅拉取成功，但未解析出任何受支持的节点",
            );
            return;
          }
          const merged = ensureUniqueTags([...get().nodes, ...batch.nodes]);
          const newSub: SubscriptionItem = {
            id: subId,
            name: label,
            url: cleanUrl,
            updatedAt: Date.now(),
            nodeCount: batch.nodes.length,
          };
          set((s) => ({
            subscriptions: [...s.subscriptions, newSub],
            nodes: merged,
          }));
          if (get().connected) {
            const status = await get().reloadCoreConfig(true);
            if (status !== "applied") {
              return;
            }
          }
          const skipNote =
            batch.skipped.length > 0
              ? `。${formatCertPinSkipSummary(batch.skipped.length)}`
              : "";
          get().pushToast(
            "success",
            `订阅「${label}」拉取成功，共 ${batch.nodes.length} 个节点${skipNote}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", `拉取订阅失败: ${msg}`);
        }
      },

      refreshSubscription: async (id, silent = false) => {
        await enqueueRefresh(async () => {
          const sub = get().subscriptions.find((item) => item.id === id);
          if (!sub) return;
          const result = await pullSubscriptionUpdate(sub);
          await commitSubscriptionUpdates([result], silent);
        });
      },

      refreshAllSubscriptions: async (silent = false) => {
        await enqueueRefresh(async () => {
          const subs = get().subscriptions.slice();
          const results = await Promise.all(
            subs.map((sub) => pullSubscriptionUpdate(sub)),
          );
          await commitSubscriptionUpdates(results, silent);
        });
      },

      removeSubscription: async (id) => {
        const remainingNodes = ensureUniqueTags(
          get().nodes.filter((n) => n.subscriptionId !== id),
        );
        set((s) => ({
          subscriptions: s.subscriptions.filter((sub) => sub.id !== id),
          nodes: remainingNodes,
          selectedOutbound: isSelectionValid(remainingNodes, s.selectedOutbound)
            ? s.selectedOutbound
            : "auto",
        }));
        if (get().connected) {
          if (remainingNodes.length === 0) {
            await get().disconnectCore();
          } else {
            await get().reloadCoreConfig(true);
          }
        } else {
          syncTray();
        }
      },

      testSingleNodeDelay: async (idOrTag) => {
        if (!get().connected) {
          await get().connectCore();
          if (!get().connected) return;
        }
        const target = get().nodes.find(
          (n) => n.id === idOrTag || n.tag === idOrTag,
        );
        if (!target) return;

        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === target.id ? { ...n, testing: true } : n,
          ),
        }));
        let delay = -1;
        try {
          delay = await resolveDeps.measureNodeHttp204Delay(target.tag, 5000);
        } catch {
          delay = -1;
        }
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === target.id ? { ...n, latency: delay, testing: false } : n,
          ),
        }));
        if (lastEffectiveSnapshot) {
          lastEffectiveSnapshot.nodes = get().nodes;
        }
      },

      testAllNodesDelay: async () => {
        if (get().batchTesting) return;
        if (get().nodes.length === 0) {
          get().pushToast("info", "暂无可测速节点");
          return;
        }
        if (!get().connected) {
          await get().connectCore();
          if (!get().connected) return;
        }

        set((s) => ({
          batchTesting: true,
          nodes: s.nodes.map((n) => ({ ...n, testing: true })),
        }));

        const targets = get().nodes.map((n) => ({ id: n.id, tag: n.tag }));
        const concurrency = 6;
        let cursor = 0;

        const worker = async () => {
          while (cursor < targets.length) {
            const idx = cursor++;
            const item = targets[idx];
            if (!item) continue;
            let delay = -1;
            try {
              delay = await resolveDeps.measureNodeHttp204Delay(item.tag, 5000);
            } catch {
              delay = -1;
            }
            set((s) => ({
              nodes: s.nodes.map((n) =>
                n.id === item.id ? { ...n, latency: delay, testing: false } : n,
              ),
            }));
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, targets.length) }, () =>
            worker(),
          ),
        );

        const winner = await resolveDeps.queryAutoWinnerNode();
        set({
          batchTesting: false,
          autoWinnerNode: winner ?? get().autoWinnerNode,
        });
        if (lastEffectiveSnapshot) {
          lastEffectiveSnapshot.nodes = get().nodes;
        }
        syncTray();
        get().pushToast("success", "HTTP 204 真连接延迟测速完成");
      },

      toggleAutostart: async () => {
        const next = !get().autostartEnabled;
        try {
          await resolveDeps.setAutostartStatus(next);
          set({ autostartEnabled: next });
          get().pushToast(
            "success",
            next ? "已开启开机静默自启 (--silent)" : "已关闭开机自启",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          get().pushToast("error", `修改开机自启失败: ${msg}`);
        }
      },

      setBrutalBandwidth: async (downMbps, upMbps) => {
        const down = sanitizeMbps(downMbps);
        const up = sanitizeMbps(upMbps);
        const useBbr = down <= 0 || up <= 0;
        set({
          brutalDownMbps: useBbr ? 0 : down,
          brutalUpMbps: useBbr ? 0 : up,
        });
        if (get().connected) {
          const status = await get().reloadCoreConfig(true);
          if (status === "applied") {
            get().pushToast(
              "success",
              useBbr
                ? "未声明带宽的 HY2 节点改用 BBR（链接自带带宽的节点不受影响）"
                : `未声明带宽的 HY2 节点默认 Brutal ↓${down} / ↑${up} Mbps`,
            );
          }
        }
      },

      setDnsLeakProtection: async (val) => {
        if (get().dnsLeakProtection === val) return;
        set({ dnsLeakProtection: val });
        if (get().connected) {
          const status = await get().reloadCoreConfig(true);
          if (status === "applied") {
            get().pushToast(
              "success",
              val
                ? "DNS 防泄露已开启（未知域名仅经代理解析）"
                : "DNS 防泄露已关闭（恢复未知域名国内探测）",
            );
          }
        } else {
          get().pushToast(
            "success",
            val ? "DNS 防泄露已开启，连接时生效" : "DNS 防泄露已关闭",
          );
        }
      },

      setSystemEnvBackup: (backup) => set({ systemEnvBackup: backup }),

      setAutoRestoreConnect: (val) => set({ autoRestoreConnect: val }),
      setAutoRefreshSubs: (val) => set({ autoRefreshSubs: val }),

      closeAllConnections: async () => {
        await resolveDeps.closeAllClashConnections();
        get().pushToast("info", "已清理当前全部活跃连接");
      },

      clearLogs: () => telemetryStore.getState().clearLogs(),
    };
  };

  const useStore = create<AppState>()(
    createSelectivePersist(creator, {
      name: PERSIST_STORAGE_KEY,
      version: PERSIST_SCHEMA_VERSION,
      storage,
      partialize: (state) => {
        const persisted = extractPersistedAppState(state);
        deps.onPartialize?.(persisted);
        return persisted;
      },
    }),
  );

  const dispose = () => {
    stopTelemetryAndTimers();
    while (unlistenFns.length > 0) {
      const fn = unlistenFns.pop();
      fn?.();
    }
  };

  return { useStore, telemetryStore, dispose };
}

const defaultCreated = createAppStore({
  telemetryStore: useTelemetryStore,
});

export const useAppStore = defaultCreated.useStore;
