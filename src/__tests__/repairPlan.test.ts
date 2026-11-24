import assert from "node:assert/strict";
import test from "node:test";
import type { StateStorage } from "zustand/middleware";
import { measureNodeHttp204Delay } from "../lib/clashApi";
import {
  buildSingBoxConfig,
  resolveHy2CongestionControl,
} from "../lib/configBuilder";
import {
  formatCertPinSkipSummary,
  getNodeConnectionKey,
  getNodeDisplayMap,
  matchSubscriptionNodeIds,
  parseBatchSubscriptionContent,
  parseShareBatch,
  parseSingleShareUri,
  resolveNodeDisplayName,
  shareUriRequiresUnsupportedCertPin,
} from "../lib/uriParser";
import {
  createAppStore,
  migratePersistedState,
  PERSIST_STORAGE_KEY,
  type AppStoreDependencies,
  type TelemetryCallbacks,
} from "../store/useAppStore";
import type {
  ClashConnection,
  CoreApplyRequest,
  CoreApplyResult,
  CoreLogEntry,
  LaunchContext,
  ProxyNode,
  RoutingMode,
} from "../types/proxy";

class CountableMemoryStorage implements StateStorage {
  private map = new Map<string, string>();
  public getItemCount = 0;
  public setItemCount = 0;
  public removeItemCount = 0;

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.map.set(k, v);
      }
    }
  }

  getItem(name: string): string | null {
    this.getItemCount++;
    return this.map.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.setItemCount++;
    this.map.set(name, value);
  }

  removeItem(name: string): void {
    this.removeItemCount++;
    this.map.delete(name);
  }

  resetCounts(): void {
    this.getItemCount = 0;
    this.setItemCount = 0;
    this.removeItemCount = 0;
  }

  peekRaw(name: string): string | null {
    return this.map.get(name) ?? null;
  }
}

interface TestHarness {
  storage: CountableMemoryStorage;
  partializeCount: { count: number };
  eventHandlers: Map<string, Array<(payload: unknown) => void>>;
  telemetryCallbacks: TelemetryCallbacks[];
  trayUpdates: Array<{
    connected: boolean;
    sysProxy: boolean;
    tunMode: boolean;
    routingMode: RoutingMode;
    activeNode?: string;
    terminalShell?: "powershell" | "cmd";
  }>;
  proxyCalls: Array<{ enable: boolean; port: number }>;
  clashSwitches: Array<{ targetTag: string; selectorGroup?: string }>;
  applyCalls: CoreApplyRequest[];
  stopCalls: number;
  subBodies: Map<string, string>;
  failSubUrls: Set<string>;
  settleCalls: boolean[];
  setClipboard: (text: string) => void;
  setBeforeSubFetch: (fn: (() => Promise<void>) | null) => void;
  setMeasure: (
    fn: (nodeTag: string, timeout?: number) => Promise<number>,
  ) => void;
  setLaunchContext: (patch: Partial<LaunchContext>) => void;
  setApplyHandler: (
    fn: (req: CoreApplyRequest) => Promise<CoreApplyResult> | CoreApplyResult,
  ) => void;
  emitEvent: (name: string, payload: unknown) => void;
  deps: AppStoreDependencies;
}

function createHarness(
  initialStorage?: Record<string, string>,
  launchOverride?: Partial<LaunchContext>,
): TestHarness {
  const storage = new CountableMemoryStorage(initialStorage);
  const partializeCount = { count: 0 };
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const telemetryCallbacks: TelemetryCallbacks[] = [];
  const trayUpdates: TestHarness["trayUpdates"] = [];
  const proxyCalls: TestHarness["proxyCalls"] = [];
  const clashSwitches: TestHarness["clashSwitches"] = [];
  const applyCalls: CoreApplyRequest[] = [];
  const subBodies = new Map<string, string>();
  const failSubUrls = new Set<string>();
  const settleCalls: boolean[] = [];
  let clipboardText = "";
  let beforeSubFetch: (() => Promise<void>) | null = null;
  let measureImpl: (nodeTag: string, timeout?: number) => Promise<number> =
    async () => 42;
  let stopCalls = 0;

  let launchCtx: LaunchContext = {
    silent: false,
    relaunchTun: false,
    isAdmin: true,
    sysProxyEnabled: false,
    preferredSysProxy: true,
    coreRunning: false,
    routingMode: "rule",
    tunMode: false,
    isColdStart: true,
    pendingExitError: null,
    ...launchOverride,
  };

  let applyHandler: (
    req: CoreApplyRequest,
  ) => Promise<CoreApplyResult> | CoreApplyResult = () => ({
    status: "applied",
    configPath: "C:\\mock\\running-config.json",
    failureStage: null,
    error: null,
    rollbackError: null,
    runningAfter: true,
  });

  const harness: TestHarness = {
    storage,
    partializeCount,
    eventHandlers,
    telemetryCallbacks,
    trayUpdates,
    proxyCalls,
    clashSwitches,
    applyCalls,
    get stopCalls() {
      return stopCalls;
    },
    subBodies,
    failSubUrls,
    settleCalls,
    setClipboard: (text) => {
      clipboardText = text;
    },
    setBeforeSubFetch: (fn) => {
      beforeSubFetch = fn;
    },
    setMeasure: (fn) => {
      measureImpl = fn;
    },
    setLaunchContext: (patch) => {
      launchCtx = { ...launchCtx, ...patch };
    },
    setApplyHandler: (fn) => {
      applyHandler = fn;
    },
    emitEvent: (name, payload) => {
      const list = eventHandlers.get(name) ?? [];
      for (const h of list) {
        h(payload);
      }
    },
    deps: {
      storage,
      onPartialize: () => {
        partializeCount.count++;
      },
      createTelemetrySession: (cb) => {
        telemetryCallbacks.push(cb);
        return {
          configure: () => {},
          stop: () => {},
        };
      },
      getLaunchContext: async () => ({ ...launchCtx }),
      getAutostartStatus: async () => false,
      setAutostartStatus: async () => {},
      releaseWindowToTray: async () => {},
      applyLayNetCoreConfig: async (req) => {
        applyCalls.push(req);
        return applyHandler(req);
      },
      stopLayNetCore: async () => {
        stopCalls++;
      },
      setWindowsSystemProxy: async (enable, port = 7890) => {
        proxyCalls.push({ enable, port });
      },
      getSysProxyState: async () => ({
        enabled: true,
        server: "127.0.0.1:7890",
      }),
      checkAdminPrivilege: async () => launchCtx.isAdmin,
      elevateForTun: async () => {},
      syncTrayState: async (payload) => {
        trayUpdates.push(payload);
      },
      fetchSubscriptionText: async (url) => {
        if (beforeSubFetch) await beforeSubFetch();
        if (failSubUrls.has(url)) {
          throw new Error("offline");
        }
        const body = subBodies.get(url);
        if (body === undefined) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        return body;
      },
      readClipboardText: async () => clipboardText,
      writeClipboardText: async () => {},
      subscribeTauriEvent: async <T>(
        eventName: string,
        handler: (payload: T) => void,
      ) => {
        const list = eventHandlers.get(eventName) ?? [];
        const wrapped = (p: unknown) => handler(p as T);
        list.push(wrapped);
        eventHandlers.set(eventName, list);
        return () => {
          const cur = eventHandlers.get(eventName) ?? [];
          eventHandlers.set(
            eventName,
            cur.filter((fn) => fn !== wrapped),
          );
        };
      },
      fetchCurrentRoutingMode: async () => "rule",
      fetchConnectionsSnapshot: async () => ({
        connections: [],
        uploadTotal: 0,
        downloadTotal: 0,
      }),
      queryAutoWinnerNode: async () => null,
      switchClashOutbound: async (targetTag, selectorGroup) => {
        clashSwitches.push({ targetTag, selectorGroup });
      },
      patchClashRoutingMode: async () => {},
      measureNodeHttp204Delay: (nodeTag, timeout) =>
        measureImpl(nodeTag, timeout),
      settleCachedCoreConfig: async (discardSaved) => {
        settleCalls.push(discardSaved);
      },
      closeAllClashConnections: async () => {},
    },
  };

  return harness;
}

test("Item 2: core-exited updates UI/telemetry and preserves user sysProxy preference", async () => {
  const h = createHarness();
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore
      .getState()
      .importRawLinks("hy2://secret@a.example:443#HK");
    await app.useStore.getState().connectCore();
    assert.equal(app.useStore.getState().connected, true);
    assert.equal(app.useStore.getState().sysProxy, true);

    h.proxyCalls.length = 0;
    h.emitEvent("core-exited", "FATAL killed by pid");

    const st = app.useStore.getState();
    assert.equal(st.connected, false);
    assert.equal(st.connecting, false);
    assert.equal(st.sysProxy, true); // 保留用户下次连接的代理偏好
    assert.equal(h.proxyCalls.length, 0); // Rust 层已清理代理，前端不再盲目覆盖
    assert.equal(st.toasts.at(-1)?.type, "error");
    assert.match(st.toasts.at(-1)?.message ?? "", /FATAL killed by pid/);
  } finally {
    app.dispose();
  }
});

test("Item 2: reopening window after headless background crash stays disconnected without auto-reconnect", async () => {
  const persisted = JSON.stringify({
    state: {
      nodes: [parseSingleShareUri("trojan://demo@a.example:443#HK")!],
      subscriptions: [],
      selectedOutbound: "auto",
      routingMode: "rule",
      sysProxy: true,
      sysProxyBeforeTun: true,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
      theme: "system",
      terminalShell: "powershell",
      brutalDownMbps: 800,
      autoRestoreConnect: true,
      autoRefreshSubs: false,
      lastConnected: true,
      selectionMigrated: true,
    },
    version: 2,
  });

  const h = createHarness(
    { [PERSIST_STORAGE_KEY]: persisted },
    {
      isColdStart: false,
      coreRunning: false,
      preferredSysProxy: true,
      pendingExitError: "laynet-core crashed unexpectedly",
    },
  );
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();

    const st = app.useStore.getState();
    assert.equal(st.connected, false);
    assert.equal(st.lastConnected, false);
    assert.equal(st.sysProxy, true);
    assert.equal(h.applyCalls.length, 0); // 不应在打开窗口核对状态时擅自自动重连
    assert.equal(st.toasts.at(-1)?.type, "error");
    assert.match(st.toasts.at(-1)?.message ?? "", /crashed unexpectedly/);
    assert.equal(h.trayUpdates.at(-1)?.connected, false);
  } finally {
    app.dispose();
  }
});

test("Item 3: precheck failure and rollback failure protect callers from false success toasts and revert UI state", async () => {
  const h = createHarness();
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore
      .getState()
      .importRawLinks("hy2://secret@a.example:443#HK");
    await app.useStore.getState().connectCore();
    assert.equal(app.useStore.getState().connected, true);
    assert.equal(app.useStore.getState().tunMode, false);
    assert.equal(app.useStore.getState().sysProxy, true);

    const teleCountBefore = h.telemetryCallbacks.length;

    // 1. 候选预检失败 -> 保持连接、遥测不中断、TUN/代理状态回退、rulesDirty 保持、不弹出"已生效"
    h.setApplyHandler(() => ({
      status: "rolled_back",
      configPath: "C:\\mock\\running-config.json",
      failureStage: "precheck",
      error: "[预检失败] invalid domain suffix",
      rollbackError: null,
      runningAfter: true,
    }));

    app.useStore.getState().setForceProxyText("bad domain value");
    assert.equal(app.useStore.getState().rulesDirty, true);
    const rulesOk = await app.useStore.getState().applyCustomRules();
    assert.equal(rulesOk, false);
    assert.equal(app.useStore.getState().connected, true);
    assert.equal(app.useStore.getState().rulesDirty, true);
    assert.equal(h.telemetryCallbacks.length, teleCountBefore); // 预检失败不中断遥测
    assert.equal(app.useStore.getState().toasts.at(-1)?.type, "error");
    assert.doesNotMatch(
      app.useStore.getState().toasts.at(-1)?.message ?? "",
      /已置顶注入并生效/,
    );

    // 2. TUN 切换时候选启动/就绪失败但回滚成功 -> 恢复旧 TUN=false, sysProxy=true，并重建遥测
    h.setApplyHandler(() => ({
      status: "rolled_back",
      configPath: "C:\\mock\\running-config.json",
      failureStage: "readiness",
      error: "[就绪超时] TUN adapter failed",
      rollbackError: null,
      runningAfter: true,
    }));

    await app.useStore.getState().toggleTunMode();
    assert.equal(app.useStore.getState().connected, true);
    assert.equal(app.useStore.getState().tunMode, false);
    assert.equal(app.useStore.getState().sysProxy, true);
    assert.equal(h.telemetryCallbacks.length, teleCountBefore + 1); // 回滚切换了进程，恢复遥测
    assert.equal(app.useStore.getState().toasts.at(-1)?.type, "error");
    assert.doesNotMatch(
      app.useStore.getState().toasts.at(-1)?.message ?? "",
      /TUN 模式已开启/,
    );

    // 3. 节点连接参数编辑时若候选和回滚均失败 -> 转断开状态、保留阶段错误、回退节点参数
    const nodeId = app.useStore.getState().nodes[0].id;
    h.setApplyHandler(() => ({
      status: "failed",
      configPath: null,
      failureStage: "rollback",
      error: "[启动失败] port busy",
      rollbackError: "[回滚失败] core missing",
      runningAfter: false,
    }));

    await app.useStore
      .getState()
      .updateNodeConfig(nodeId, { name: "Broken-Name", mport: "30000-40000" });
    assert.equal(app.useStore.getState().connected, false);
    assert.equal(app.useStore.getState().nodes[0].name, "HK");
    assert.equal(
      app.useStore.getState().nodes[0].hysteria2?.serverPorts,
      undefined,
    );
    assert.equal(app.useStore.getState().toasts.at(-1)?.type, "error");
    assert.match(app.useStore.getState().toasts.at(-1)?.message ?? "", /启动失败/);
    assert.match(app.useStore.getState().toasts.at(-1)?.message ?? "", /回滚失败/);
  } finally {
    app.dispose();
  }
});

test("Item 3: concurrent reload cancelled by disconnect never re-enables connected state or telemetry", async () => {
  const h = createHarness();
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore
      .getState()
      .importRawLinks("hy2://secret@a.example:443#HK");
    await app.useStore.getState().connectCore();
    assert.equal(app.useStore.getState().connected, true);

    let resolvePendingReload!: (res: CoreApplyResult) => void;
    h.setApplyHandler(
      () =>
        new Promise<CoreApplyResult>((resolve) => {
          resolvePendingReload = resolve;
        }),
    );

    const teleCountBeforeReload = h.telemetryCallbacks.length;
    const reloadPromise = app.useStore.getState().reloadCoreConfig(false);

    // 重载尚未结束时用户主动断开
    await app.useStore.getState().disconnectCore();
    assert.equal(app.useStore.getState().connected, false);

    // 即使迟到的 IPC 回调返回 applied，也必须尊重最新断开操作
    resolvePendingReload({
      status: "applied",
      configPath: "C:\\mock\\running-config.json",
      failureStage: null,
      error: null,
      rollbackError: null,
      runningAfter: true,
    });
    const outcome = await reloadPromise;
    assert.equal(outcome, "cancelled");
    assert.equal(app.useStore.getState().connected, false);
    assert.equal(app.useStore.getState().connecting, false);
    assert.equal(h.telemetryCallbacks.length, teleCountBeforeReload);
    assert.equal(h.trayUpdates.at(-1)?.connected, false);
  } finally {
    app.dispose();
  }
});

test("Item 4: same-name nodes preserve selection across refresh, reverse sort, rename, restart, and fallback on delete", async () => {
  const h = createHarness();
  const subAUrl = "https://sub-a.example/list";
  const subBUrl = "https://sub-b.example/list";
  h.subBodies.set(subAUrl, "trojan://demo@a.example:443#HK");
  h.subBodies.set(subBUrl, "trojan://demo@b.example:443#HK");

  const app1 = createAppStore(h.deps);
  let idA = "";
  let tagA = "";

  try {
    await app1.useStore.getState().initializeApp();
    await app1.useStore.getState().addSubscription("SubA", subAUrl);
    await app1.useStore.getState().addSubscription("SubB", subBUrl);

    const nodes0 = app1.useStore.getState().nodes;
    assert.equal(nodes0.length, 2);
    const nodeA = nodes0.find((n) => n.server === "a.example")!;
    const nodeB = nodes0.find((n) => n.server === "b.example")!;
    idA = nodeA.id;
    tagA = nodeA.tag;

    // 展示名可独立包含重名后缀，而不影响稳定 ID / 内部 tag
    const disp0 = getNodeDisplayMap(nodes0);
    assert.equal(disp0.get(nodeA.id), "HK");
    assert.equal(disp0.get(nodeB.id), "HK #2");

    // 1. 选择 A 并连接
    await app1.useStore.getState().selectOutbound(idA);
    await app1.useStore.getState().connectCore();
    assert.equal(app1.useStore.getState().selectedOutbound, idA);

    const assertSelectionTargetsServerA = (store: ReturnType<typeof createAppStore>["useStore"]) => {
      const s = store.getState();
      assert.equal(s.selectedOutbound, idA);
      const selectedNode = s.nodes.find((n) => n.id === idA)!;
      assert.equal(selectedNode.tag, tagA);
      const cfg = buildSingBoxConfig({
        nodes: s.nodes,
        selectedOutbound: s.selectedOutbound,
        routingMode: s.routingMode,
        tunMode: s.tunMode,
        forceProxyText: s.forceProxyText,
        forceDirectText: s.forceDirectText,
      });
      const outbounds = cfg.outbounds as Array<Record<string, unknown>>;
      const selector = outbounds.find((o) => o.tag === "proxy")!;
      assert.equal(selector.default, tagA);
      const outboundA = outbounds.find((o) => o.tag === tagA)!;
      assert.equal(outboundA.server, "a.example");
    };

    assertSelectionTargetsServerA(app1.useStore);

    // 2. 刷新订阅 A（此时 B 在前，A 在后，且订阅服务端把备注改成了 #HK-Fresh）
    h.subBodies.set(subAUrl, "trojan://demo@a.example:443#HK-Fresh");
    const subAId = app1.useStore
      .getState()
      .subscriptions.find((s) => s.url === subAUrl)!.id;
    await app1.useStore.getState().refreshSubscription(subAId, true);
    assertSelectionTargetsServerA(app1.useStore);

    // 3. 反转排序
    const reversed = [...app1.useStore.getState().nodes].reverse();
    app1.useStore.setState({ nodes: reversed });
    assertSelectionTargetsServerA(app1.useStore);

    // 4. 修改显示名，并验证传入 Clash 的 tag 和托盘显示名正确
    await app1.useStore
      .getState()
      .updateNodeConfig(idA, { name: "HK-Custom" });
    assertSelectionTargetsServerA(app1.useStore);
    assert.equal(
      resolveNodeDisplayName(app1.useStore.getState().nodes, tagA),
      "HK-Custom",
    );
    assert.equal(h.trayUpdates.at(-1)?.activeNode, "HK-Custom");

    await app1.useStore.getState().selectOutbound(idA);
    assert.equal(h.clashSwitches.at(-1)?.targetTag, tagA);
  } finally {
    app1.dispose();
  }

  // 5. 模拟重启：从持久化存储重建 store，并再次验证选中 ID、Clash tag 和生成配置
  const h2 = createHarness({
    [PERSIST_STORAGE_KEY]: h.storage.peekRaw(PERSIST_STORAGE_KEY)!,
  });
  h2.subBodies.set(subAUrl, "trojan://other@other.example:443#Other");
  const app2 = createAppStore(h2.deps);
  try {
    app2.useStore.setState({ autoRefreshSubs: false });
    await app2.useStore.getState().initializeApp();
    assert.equal(app2.useStore.getState().selectedOutbound, idA);
    const cfg = buildSingBoxConfig({
      nodes: app2.useStore.getState().nodes,
      selectedOutbound: app2.useStore.getState().selectedOutbound,
      routingMode: "rule",
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
    });
    const outbounds = cfg.outbounds as Array<Record<string, unknown>>;
    assert.equal(outbounds.find((o) => o.tag === "proxy")?.default, tagA);
    assert.equal(outbounds.find((o) => o.tag === tagA)?.server, "a.example");

    // 6. 删除 A 后应自动回退到 auto
    await app2.useStore.getState().removeNode(idA);
    assert.equal(app2.useStore.getState().selectedOutbound, "auto");
  } finally {
    app2.dispose();
  }
});

test("Item 4: subscription matching distinguishes auth/transport parameters and isolates across subscriptions", () => {
  const [n1] = parseBatchSubscriptionContent(
    "vless://11111111-1111-1111-1111-111111111111@v.example:443?type=ws&path=/ws1#N1",
    "sub-a",
  );
  const [n2] = parseBatchSubscriptionContent(
    "vless://11111111-1111-1111-1111-111111111111@v.example:443?type=ws&path=/ws2#N1",
    "sub-a",
  );
  const [n1Renamed] = parseBatchSubscriptionContent(
    "vless://11111111-1111-1111-1111-111111111111@v.example:443?type=ws&path=/ws1#N1-Renamed",
    "sub-a",
  );

  assert.notEqual(getNodeConnectionKey(n1), getNodeConnectionKey(n2));
  assert.equal(getNodeConnectionKey(n1), getNodeConnectionKey(n1Renamed));

  const matchedSame = matchSubscriptionNodeIds([n1], [n1Renamed]);
  assert.equal(matchedSame[0].id, n1.id);

  const matchedDifferentTransport = matchSubscriptionNodeIds([n1], [n2]);
  assert.notEqual(matchedDifferentTransport[0].id, n1.id);
});

test("Item 4: legacy laynet-storage-v1 migration maps HK #2 accurately, handles ambiguity, and is idempotent", async () => {
  const legacyA: ProxyNode = {
    ...parseSingleShareUri("trojan://demo@a.example:443#HK")!,
    id: "legacy-id-a",
    tag: "HK",
    name: "HK",
  };
  const legacyB: ProxyNode = {
    ...parseSingleShareUri("trojan://demo@b.example:443#HK")!,
    id: "legacy-id-b",
    tag: "HK #2",
    name: "HK",
  };

  const legacyPayload = JSON.stringify({
    state: {
      nodes: [legacyA, legacyB],
      subscriptions: [],
      selectedOutbound: "HK #2",
      routingMode: "global",
      sysProxy: true,
      sysProxyBeforeTun: true,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
      theme: "dark",
      terminalShell: "cmd",
      brutalDownMbps: 1000,
      autoRestoreConnect: true,
      autoRefreshSubs: false,
      lastConnected: false,
    },
    version: 0,
  });

  const h = createHarness({ [PERSIST_STORAGE_KEY]: legacyPayload });
  const app1 = createAppStore(h.deps);
  try {
    await app1.useStore.getState().initializeApp();
    const s1 = app1.useStore.getState();
    assert.equal(s1.selectedOutbound, "legacy-id-b");
    assert.equal(s1.theme, "dark");
    assert.equal(s1.routingMode, "global");
    assert.equal(s1.terminalShell, "cmd");
    const cfg = buildSingBoxConfig({
      nodes: s1.nodes,
      selectedOutbound: s1.selectedOutbound,
      routingMode: s1.routingMode,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
    });
    const outbounds = cfg.outbounds as Array<Record<string, unknown>>;
    const selDefault = outbounds.find((o) => o.tag === "proxy")?.default;
    assert.equal(
      outbounds.find((o) => o.tag === selDefault)?.server,
      "b.example",
    );
  } finally {
    app1.dispose();
  }

  // 重复加载迁移后的数据应得到完全同一选择
  const migratedRaw = h.storage.peekRaw(PERSIST_STORAGE_KEY)!;
  const h2 = createHarness({ [PERSIST_STORAGE_KEY]: migratedRaw });
  const app2 = createAppStore(h2.deps);
  try {
    await app2.useStore.getState().initializeApp();
    assert.equal(app2.useStore.getState().selectedOutbound, "legacy-id-b");
  } finally {
    app2.dispose();
  }

  // 含歧义或缺失的旧 tag 回退到 auto，且保留内置选择
  const ambiguous = migratePersistedState(
    {
      nodes: [
        { ...legacyA, tag: "HK" },
        { ...legacyB, tag: "HK" },
      ],
      selectedOutbound: "HK",
    },
    0,
  );
  assert.equal(ambiguous.selectedOutbound, "auto");

  const missing = migratePersistedState(
    {
      nodes: [legacyA, legacyB],
      selectedOutbound: "HK #99",
    },
    0,
  );
  assert.equal(missing.selectedOutbound, "auto");

  const builtin = migratePersistedState(
    {
      nodes: [legacyA, legacyB],
      selectedOutbound: "direct",
    },
    0,
  );
  assert.equal(builtin.selectedOutbound, "direct");
});

test("Item 5: telemetry traffic/connections/logs trigger zero partialize and zero setItem writes while updating UI subscribers", async () => {
  const seedNodes = Array.from({ length: 40 }, (_, i) =>
    parseSingleShareUri(`trojan://demo@n${i}.example:443#Node-${i}`)!,
  );
  const selectedId = seedNodes[5].id;
  const seedPayload = JSON.stringify({
    state: {
      nodes: seedNodes,
      subscriptions: [
        {
          id: "sub-1",
          name: "LargeSub",
          url: "https://example.com/sub",
          updatedAt: 1000,
          nodeCount: 40,
        },
      ],
      selectedOutbound: selectedId,
      routingMode: "rule",
      sysProxy: true,
      sysProxyBeforeTun: true,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
      theme: "light",
      terminalShell: "powershell",
      brutalDownMbps: 800,
      autoRestoreConnect: false,
      autoRefreshSubs: false,
      lastConnected: false,
      selectionMigrated: true,
    },
    version: 2,
  });

  const h = createHarness({ [PERSIST_STORAGE_KEY]: seedPayload });
  const app = createAppStore(h.deps);

  try {
    await app.useStore.getState().initializeApp();
    await app.useStore.getState().connectCore();
    assert.equal(app.useStore.getState().connected, true);

    // 初始化和连接完成后清零存储与序列化计数
    h.storage.resetCounts();
    h.partializeCount.count = 0;

    let uiNotifications = 0;
    const unsub = app.telemetryStore.subscribe(() => {
      uiNotifications++;
    });

    const cb = h.telemetryCallbacks.at(-1)!;
    assert.ok(cb, "telemetry callbacks should be registered");

    // 1. 发送 10 次流量更新
    for (let i = 1; i <= 10; i++) {
      cb.onTraffic(i * 100, i * 500);
    }
    assert.equal(app.telemetryStore.getState().traffic.up, 1000);
    assert.equal(app.telemetryStore.getState().traffic.down, 5000);
    assert.equal(app.telemetryStore.getState().trafficHistory.length, 36);
    assert.equal(uiNotifications, 10);
    assert.equal(h.partializeCount.count, 0);
    assert.equal(h.storage.setItemCount, 0);

    // 2. 发送一批连接快照
    const mockConns: ClashConnection[] = [
      {
        id: "c1",
        metadata: {
          network: "tcp",
          type: "HTTP",
          sourceIP: "127.0.0.1",
          destinationIP: "1.1.1.1",
          sourcePort: "50000",
          destinationPort: "443",
          host: "example.com",
        },
        upload: 1024,
        download: 4096,
        start: "2026-11-22T00:00:00Z",
        chains: [seedNodes[5].tag, "proxy"],
        rule: "Match",
        rulePayload: "",
      },
    ];
    cb.onConnections(mockConns, 12345, 67890);
    assert.equal(app.telemetryStore.getState().connections.length, 1);
    assert.equal(app.telemetryStore.getState().traffic.upTotal, 12345);
    assert.equal(app.telemetryStore.getState().traffic.downTotal, 67890);
    assert.equal(h.partializeCount.count, 0);
    assert.equal(h.storage.setItemCount, 0);

    // 3. 发送一批日志（同时覆盖 WS onLog 与 core-stdio 事件，并验证 250 条上限）
    for (let i = 0; i < 200; i++) {
      const entry: CoreLogEntry = {
        id: i,
        time: "12:00:00",
        type: "info",
        payload: `ws log #${i}`,
      };
      cb.onLog(entry);
    }
    for (let i = 0; i < 80; i++) {
      h.emitEvent("core-stdio", `INFO stdio line #${i}`);
    }
    assert.equal(app.telemetryStore.getState().logs.length, 250);
    assert.equal(h.partializeCount.count, 0);
    assert.equal(h.storage.setItemCount, 0);

    unsub();

    // 4. 修改持久化配置（主题与节点）-> 确认触发持久化
    app.useStore.getState().setTheme("dark");
    assert.equal(h.partializeCount.count, 1);
    assert.equal(h.storage.setItemCount, 1);

    await app.useStore
      .getState()
      .updateNodeConfig(selectedId, { name: "Updated-Node-5" });
    assert.ok(h.partializeCount.count >= 2);
    assert.ok(h.storage.setItemCount >= 2);
  } finally {
    app.dispose();
  }

  // 5. 重建 store 后主题、节点、订阅和所选 ID 均恢复
  const rawAfter = h.storage.peekRaw(PERSIST_STORAGE_KEY)!;
  const hRebuilt = createHarness({ [PERSIST_STORAGE_KEY]: rawAfter });
  const rebuilt = createAppStore(hRebuilt.deps);
  try {
    await rebuilt.useStore.getState().initializeApp();
    const rs = rebuilt.useStore.getState();
    assert.equal(rs.theme, "dark");
    assert.equal(rs.selectedOutbound, selectedId);
    assert.equal(rs.subscriptions.length, 1);
    assert.equal(rs.subscriptions[0].name, "LargeSub");
    assert.equal(
      rs.nodes.find((n) => n.id === selectedId)?.name,
      "Updated-Node-5",
    );
  } finally {
    rebuilt.dispose();
  }
});

const PIN_URI =
  "hy2://pw@pin.example:443?insecure=1&pinSHA256=abcdEF0123456789abcdEF0123456789abcdEF01234=#Pinned";
const GOOD_HY2_URI = "hy2://pw@good.example:443#Good";

function toastText(messages: Array<{ message: string }>): string {
  return messages.map((item) => item.message).join("\n");
}

function pendingSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertServerAbsent(
  config: Record<string, unknown>,
  server: string,
): void {
  const outbounds = config.outbounds as Array<Record<string, unknown>>;
  assert.equal(
    outbounds.some((outbound) => outbound.server === server),
    false,
  );
  const tags = new Set(outbounds.map((outbound) => String(outbound.tag)));
  for (const group of outbounds) {
    if (group.tag !== "proxy" && group.tag !== "auto") continue;
    const members = (group.outbounds as string[] | undefined) ?? [];
    for (const member of members) {
      if (member === "auto" || member === "direct") continue;
      assert.equal(tags.has(member), true);
      assert.notEqual(
        outbounds.find((outbound) => outbound.tag === member)?.server,
        server,
      );
    }
  }
}

function persistedNodes(
  nodes: ProxyNode[],
  selectedOutbound: string,
  lastConnected = true,
): string {
  return JSON.stringify({
    state: {
      nodes,
      subscriptions: [],
      selectedOutbound,
      routingMode: "rule",
      sysProxy: true,
      sysProxyBeforeTun: true,
      tunMode: false,
      forceProxyText: "",
      forceDirectText: "",
      theme: "system",
      terminalShell: "powershell",
      brutalDownMbps: 800,
      autoRestoreConnect: true,
      autoRefreshSubs: false,
      lastConnected,
      selectionMigrated: true,
      certPinNotice: null,
    },
    version: 2,
  });
}

test("Bugfix 1: hysteria2 pinSHA256 is skipped while ordinary nodes stay usable", () => {
  assert.equal(parseSingleShareUri(PIN_URI), null);
  assert.equal(
    shareUriRequiresUnsupportedCertPin("hy2://pw@plain.example:443?pinSHA256="),
    false,
  );
  const insecure = parseSingleShareUri(
    "hy2://pw@plain.example:443?insecure=1#Plain",
  );
  assert.equal(insecure?.hysteria2?.insecure, true);

  const batch = parseShareBatch(
    btoa(`${PIN_URI}\n${GOOD_HY2_URI}`),
  );
  assert.equal(batch.nodes.length, 1);
  assert.equal(batch.nodes[0]?.server, "good.example");
  assert.equal(batch.skipped.length, 1);
  assert.match(batch.skipped[0]?.reason ?? "", /pinSHA256/);

  const leaked: ProxyNode = {
    id: "pinned-node",
    tag: "node-pinned-node",
    name: "Pinned",
    protocol: "hysteria2",
    server: "pin.example",
    serverPort: 443,
    rawUri: PIN_URI,
    hysteria2: { password: "pw", sni: "pin.example", insecure: true },
  };
  const good = batch.nodes[0]!;
  for (const tunMode of [false, true]) {
    const cfg = buildSingBoxConfig({
      nodes: [leaked, good],
      selectedOutbound: leaked.id,
      routingMode: "rule",
      tunMode,
      forceProxyText: "",
      forceDirectText: "",
    });
    assertServerAbsent(cfg, "pin.example");
    const outbounds = cfg.outbounds as Array<Record<string, unknown>>;
    assert.equal(
      outbounds.some((outbound) => outbound.server === "good.example"),
      true,
    );
    assert.equal(
      outbounds.find((outbound) => outbound.tag === "auto")?.interval,
      "3m",
    );
    assert.equal(
      outbounds.find((outbound) => outbound.tag === "proxy")?.default,
      "auto",
    );
  }
  assert.match(formatCertPinSkipSummary(1, "fallback-auto"), /自动选择/);
});

test("Bugfix 1: clipboard and subscription import skip the fingerprint node only", async () => {
  const mixed = `${PIN_URI}\n${GOOD_HY2_URI}`;
  const clipboard = createHarness();
  clipboard.setClipboard(mixed);
  const clipApp = createAppStore(clipboard.deps);
  try {
    await clipApp.useStore.getState().initializeApp();
    await clipApp.useStore.getState().importFromClipboard();
    const nodes = clipApp.useStore.getState().nodes;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.server, "good.example");
    assert.match(toastText(clipApp.useStore.getState().toasts), /pinSHA256/);
    assertServerAbsent(
      buildSingBoxConfig({
        nodes,
        selectedOutbound: "auto",
        routingMode: "rule",
        tunMode: false,
        forceProxyText: "",
        forceDirectText: "",
      }),
      "pin.example",
    );
  } finally {
    clipApp.dispose();
  }

  const subUrl = "https://example.com/mixed-sub";
  const subscription = createHarness();
  subscription.subBodies.set(subUrl, mixed);
  const subApp = createAppStore(subscription.deps);
  try {
    await subApp.useStore.getState().initializeApp();
    await subApp.useStore.getState().addSubscription("Mixed", subUrl);
    const state = subApp.useStore.getState();
    assert.equal(state.nodes.length, 1);
    assert.equal(state.nodes[0]?.server, "good.example");
    assert.equal(state.subscriptions[0]?.nodeCount, 1);
    assert.match(toastText(state.toasts), /pinSHA256/);
    assertServerAbsent(
      buildSingBoxConfig({
        nodes: state.nodes,
        selectedOutbound: state.selectedOutbound,
        routingMode: "rule",
        tunMode: true,
        forceProxyText: "",
        forceDirectText: "",
      }),
      "pin.example",
    );
  } finally {
    subApp.dispose();
  }
});

test("Bugfix 1: saved fingerprint node is removed before silent restore or tray reconnect", async () => {
  const good = parseSingleShareUri(GOOD_HY2_URI)!;
  const pinned: ProxyNode = {
    id: "pinned-node",
    tag: "node-pinned-node",
    name: "Pinned",
    protocol: "hysteria2",
    server: "pin.example",
    serverPort: 443,
    rawUri: PIN_URI,
    hysteria2: { password: "pw", sni: "pin.example", insecure: true },
  };
  const silent = createHarness(
    {
      [PERSIST_STORAGE_KEY]: persistedNodes(
        [pinned, good],
        pinned.id,
      ),
    },
    { silent: true },
  );
  const silentApp = createAppStore(silent.deps);
  try {
    await silentApp.useStore.getState().initializeApp();
    const state = silentApp.useStore.getState();
    assert.equal(state.connected, true);
    assert.equal(state.selectedOutbound, "auto");
    assert.deepEqual(
      state.nodes.map((node) => node.server),
      ["good.example"],
    );
    assert.equal(silent.settleCalls[0], true);
    assert.equal(silent.applyCalls.length, 1);
    assertServerAbsent(
      JSON.parse(silent.applyCalls[0]!.configJson) as Record<string, unknown>,
      "pin.example",
    );
    assert.match(state.certPinNotice ?? "", /自动选择/);
    const saved = JSON.parse(silent.storage.peekRaw(PERSIST_STORAGE_KEY)!) as {
      state: { nodes: ProxyNode[]; certPinNotice: string };
    };
    assert.equal(
      saved.state.nodes.some((node) => node.server === "pin.example"),
      false,
    );
  } finally {
    silentApp.dispose();
  }

  const reopened = createHarness(
    {
      [PERSIST_STORAGE_KEY]: silent.storage.peekRaw(PERSIST_STORAGE_KEY)!,
    },
    { silent: false, isColdStart: false, coreRunning: true },
  );
  const reopenedApp = createAppStore(reopened.deps);
  try {
    await reopenedApp.useStore.getState().initializeApp();
    assert.equal(reopenedApp.useStore.getState().connected, true);
    assert.equal(reopened.applyCalls.length, 0);
    assert.match(
      toastText(reopenedApp.useStore.getState().toasts),
      /pinSHA256/,
    );
    assert.equal(reopenedApp.useStore.getState().certPinNotice, null);
    assert.equal(
      reopenedApp.useStore
        .getState()
        .nodes.some((node) => shareUriRequiresUnsupportedCertPin(node.rawUri)),
      false,
    );
  } finally {
    reopenedApp.dispose();
  }

  const onlyPin = createHarness({
    [PERSIST_STORAGE_KEY]: persistedNodes([pinned], pinned.id),
  });
  const onlyApp = createAppStore(onlyPin.deps);
  try {
    await onlyApp.useStore.getState().initializeApp();
    assert.equal(onlyApp.useStore.getState().nodes.length, 0);
    assert.equal(onlyApp.useStore.getState().connected, false);
    assert.equal(onlyPin.applyCalls.length, 0);
    assert.equal(onlyPin.settleCalls.includes(true), true);
    assert.match(toastText(onlyApp.useStore.getState().toasts), /保持断开/);
  } finally {
    onlyApp.dispose();
  }
});

test("Bugfix 1: subscription changing to a cert pin drops the previous fingerprint-less node", async () => {
  const url = "https://example.com/hy2-sub";
  const h = createHarness();
  h.subBodies.set(url, GOOD_HY2_URI);
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore.getState().addSubscription("HY2", url);
    await app.useStore.getState().connectCore();
    const previousId = app.useStore.getState().nodes[0]!.id;
    await app.useStore.getState().selectOutbound(previousId);
    h.applyCalls.length = 0;
    h.settleCalls.length = 0;
    h.subBodies.set(url, PIN_URI);
    const subId = app.useStore.getState().subscriptions[0]!.id;
    await app.useStore.getState().refreshSubscription(subId, false);
    assert.equal(app.useStore.getState().nodes.length, 0);
    assert.equal(app.useStore.getState().connected, false);
    assert.equal(h.applyCalls.length, 0);
    assert.equal(h.settleCalls.includes(true), true);
    assert.match(toastText(app.useStore.getState().toasts), /pinSHA256/);
    assert.equal(app.useStore.getState().subscriptions[0]?.nodeCount, 0);
  } finally {
    app.dispose();
  }

  const mixed = createHarness();
  const mixedUrl = "https://example.com/mixed-refresh";
  mixed.subBodies.set(
    mixedUrl,
    `${GOOD_HY2_URI}\ntrojan://demo@keep.example:443#Keep`,
  );
  const mixedApp = createAppStore(mixed.deps);
  try {
    await mixedApp.useStore.getState().initializeApp();
    await mixedApp.useStore.getState().addSubscription("Mixed", mixedUrl);
    await mixedApp.useStore.getState().connectCore();
    const hy2 = mixedApp.useStore
      .getState()
      .nodes.find((node) => node.server === "good.example")!;
    await mixedApp.useStore.getState().selectOutbound(hy2.id);
    mixed.applyCalls.length = 0;
    mixed.subBodies.set(
      mixedUrl,
      `${PIN_URI}\ntrojan://demo@keep.example:443#Keep`,
    );
    const subId = mixedApp.useStore.getState().subscriptions[0]!.id;
    await mixedApp.useStore.getState().refreshSubscription(subId, false);
    const state = mixedApp.useStore.getState();
    assert.equal(state.connected, true);
    assert.equal(state.selectedOutbound, "auto");
    assert.equal(
      state.nodes.some((node) => node.server === "pin.example"),
      false,
    );
    assert.equal(
      state.nodes.some((node) => node.server === "good.example"),
      false,
    );
    assert.equal(
      state.nodes.some((node) => node.server === "keep.example"),
      true,
    );
    assert.equal(mixed.applyCalls.length, 1);
    assertServerAbsent(
      JSON.parse(mixed.applyCalls[0]!.configJson) as Record<string, unknown>,
      "pin.example",
    );
    assertServerAbsent(
      JSON.parse(mixed.applyCalls[0]!.configJson) as Record<string, unknown>,
      "good.example",
    );
  } finally {
    mixedApp.dispose();
  }
});

test("Bugfix 2: unchanged subscription refreshes do not reapply config", async () => {
  const urls = [
    "https://example.com/sub-a",
    "https://example.com/sub-b",
    "https://example.com/sub-c",
  ];
  const bodies = [
    "trojan://demo@a.example:443#A",
    "trojan://demo@b.example:443#B",
    "trojan://demo@c.example:443#C",
  ];
  const h = createHarness();
  urls.forEach((url, index) => h.subBodies.set(url, bodies[index]!));
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore.getState().addSubscription("A", urls[0]!);
    await app.useStore.getState().addSubscription("B", urls[1]!);
    await app.useStore.getState().addSubscription("C", urls[2]!);
    const beforeIds = app.useStore.getState().nodes.map((node) => node.id);
    const selected = beforeIds[1]!;
    await app.useStore.getState().selectOutbound(selected);
    await app.useStore.getState().connectCore();
    h.applyCalls.length = 0;

    await app.useStore.getState().refreshAllSubscriptions(true);
    assert.equal(h.applyCalls.length, 0);
    assert.deepEqual(
      app.useStore.getState().nodes.map((node) => node.id),
      beforeIds,
    );
    assert.equal(app.useStore.getState().selectedOutbound, selected);

    const subA = app.useStore
      .getState()
      .subscriptions.find((item) => item.name === "A")!;
    await app.useStore.getState().refreshSubscription(subA.id, true);
    assert.equal(h.applyCalls.length, 0);
    assert.deepEqual(
      app.useStore.getState().nodes.map((node) => node.id),
      beforeIds,
    );
    assert.equal(app.useStore.getState().selectedOutbound, selected);
    assert.equal(app.useStore.getState().connected, true);
  } finally {
    app.dispose();
  }
});

test("Bugfix 2: one batch apply updates successes and keeps a failed subscription", async () => {
  const urls = [
    "https://example.com/batch-a",
    "https://example.com/batch-b",
    "https://example.com/batch-c",
  ];
  const h = createHarness();
  h.subBodies.set(urls[0]!, "trojan://demo@a.example:443#A");
  h.subBodies.set(urls[1]!, "trojan://demo@b.example:443#B");
  h.subBodies.set(urls[2]!, "trojan://demo@c.example:443#C");
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore.getState().addSubscription("A", urls[0]!);
    await app.useStore.getState().addSubscription("B", urls[1]!);
    await app.useStore.getState().addSubscription("C", urls[2]!);
    await app.useStore.getState().connectCore();
    const kept = app.useStore
      .getState()
      .nodes.find((node) => node.server === "c.example")!;
    await app.useStore.getState().selectOutbound(kept.id);
    h.subBodies.set(urls[0]!, "trojan://demo@a-new.example:443#A");
    h.subBodies.set(urls[1]!, "trojan://demo@b-new.example:443#B");
    h.failSubUrls.add(urls[2]!);
    h.applyCalls.length = 0;
    await app.useStore.getState().refreshAllSubscriptions(false);
    assert.equal(h.applyCalls.length, 1);
    const servers = app.useStore.getState().nodes.map((node) => node.server);
    assert.deepEqual(servers, ["a-new.example", "b-new.example", "c.example"]);
    assert.equal(app.useStore.getState().selectedOutbound, kept.id);
    assert.match(toastText(app.useStore.getState().toasts), /刷新「C」失败/);
    const applied = JSON.parse(h.applyCalls[0]!.configJson) as {
      outbounds: Array<Record<string, unknown>>;
    };
    assert.equal(
      applied.outbounds.some((outbound) => outbound.server === "a-new.example"),
      true,
    );
    assert.equal(
      applied.outbounds.some((outbound) => outbound.server === "c.example"),
      true,
    );
    assert.equal(
      applied.outbounds.some((outbound) => outbound.server === "a.example"),
      false,
    );
  } finally {
    app.dispose();
  }
});

test("Bugfix 2: offline refresh does not start the core, and a deleted subscription is not restored", async () => {
  const url = "https://example.com/offline-sub";
  const offline = createHarness();
  offline.subBodies.set(url, "trojan://demo@offline.example:443#Off");
  const offlineApp = createAppStore(offline.deps);
  try {
    await offlineApp.useStore.getState().initializeApp();
    await offlineApp.useStore.getState().addSubscription("Off", url);
    const before = offlineApp.useStore.getState().nodes.map((node) => node.id);
    offline.failSubUrls.add(url);
    offline.applyCalls.length = 0;
    await offlineApp.useStore.getState().refreshAllSubscriptions(false);
    assert.equal(offline.applyCalls.length, 0);
    assert.equal(offlineApp.useStore.getState().connected, false);
    assert.deepEqual(
      offlineApp.useStore.getState().nodes.map((node) => node.id),
      before,
    );
    assert.match(toastText(offlineApp.useStore.getState().toasts), /失败/);
  } finally {
    offlineApp.dispose();
  }

  const deleting = createHarness();
  const deleteUrl = "https://example.com/delete-sub";
  deleting.subBodies.set(deleteUrl, "trojan://demo@gone.example:443#Gone");
  const deleteApp = createAppStore(deleting.deps);
  try {
    await deleteApp.useStore.getState().initializeApp();
    await deleteApp.useStore.getState().addSubscription("Gone", deleteUrl);
    let releaseFetch!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    deleting.setBeforeSubFetch(async () => {
      markEntered();
      await gate;
    });
    const pending = deleteApp.useStore.getState().refreshAllSubscriptions(true);
    await entered;
    const subId = deleteApp.useStore.getState().subscriptions[0]!.id;
    await deleteApp.useStore.getState().removeSubscription(subId);
    releaseFetch();
    await pending;
    assert.equal(deleteApp.useStore.getState().subscriptions.length, 0);
    assert.equal(deleteApp.useStore.getState().nodes.length, 0);
    assert.equal(deleting.applyCalls.length, 0);
  } finally {
    deleteApp.dispose();
  }
});

test("a late startup response cannot overwrite a completed subscription refresh", async () => {
  const url = "https://example.com/startup";
  const h = createHarness();
  const app = createAppStore(h.deps);
  try {
    h.subBodies.set(url, "trojan://demo@old.example:443#Old");
    await app.useStore.getState().addSubscription("Startup", url);
    app.useStore.setState({ lastConnected: true });
    h.subBodies.set(url, "trojan://demo@new.example:443#New");
    const firstApply = pendingSignal();
    const allowFirstApply = pendingSignal();
    const refresh = pendingSignal();
    h.setBeforeSubFetch(() => refresh.promise);
    h.setApplyHandler(async () => {
      if (h.applyCalls.length === 1) {
        firstApply.resolve();
        await allowFirstApply.promise;
      }
      return { status: "applied", runningAfter: true };
    });
    const initialized = app.useStore.getState().initializeApp();
    await firstApply.promise;
    const updated = pendingSignal();
    const unlisten = app.useStore.subscribe((state) => {
      if (state.nodes[0]?.server === "new.example") updated.resolve();
    });
    refresh.resolve();
    await updated.promise;
    unlisten();
    allowFirstApply.resolve();
    await initialized;
    assert.equal(app.useStore.getState().nodes[0]?.server, "new.example");
    assert.equal(app.useStore.getState().connected, true);
    assert.equal(h.applyCalls.length, 2);
    assert.match(h.applyCalls[0]!.configJson, /old\.example/);
    assert.match(h.applyCalls[1]!.configJson, /new\.example/);
  } finally {
    app.dispose();
  }
});

test("a tray reconnect without a reusable cache generates a config from current nodes", async () => {
  const h = createHarness(undefined, { isColdStart: false, reconnectRequested: true });
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().importRawLinks(
      `${PIN_URI}\ntrojan://demo@current.example:443#Current`,
    );
    await app.useStore.getState().initializeApp();
    assert.equal(h.applyCalls.length, 1);
    assert.match(h.applyCalls[0]!.configJson, /current\.example/);
    assert.doesNotMatch(h.applyCalls[0]!.configJson, /pinSHA256/);
    assert.equal(app.useStore.getState().connected, true);
  } finally {
    app.dispose();
  }
});

test("candidate write failure preserves the running connection and suppresses subscription success", async () => {
  const url = "https://example.com/precheck";
  const h = createHarness();
  h.subBodies.set(url, "trojan://demo@old.example:443#Old");
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().addSubscription("Precheck", url);
    await app.useStore.getState().connectCore();
    const telemetryCount = h.telemetryCallbacks.length;
    app.useStore.setState({ toasts: [] });
    h.subBodies.set(url, "trojan://demo@new.example:443#New");
    h.setApplyHandler(() => ({
      status: "failed",
      failureStage: "precheck",
      runningAfter: true,
      error: "写入候选配置失败",
    }));
    await app.useStore.getState().refreshSubscription(app.useStore.getState().subscriptions[0]!.id);
    const current = app.useStore.getState();
    assert.equal(current.connected, true);
    assert.equal(current.connecting, false);
    assert.equal(current.nodes[0]?.server, "old.example");
    assert.equal(h.telemetryCallbacks.length, telemetryCount);
    assert.match(toastText(current.toasts), /原连接仍在运行/);
    assert.doesNotMatch(toastText(current.toasts), /已更新/);
  } finally {
    app.dispose();
  }
});

test("a subscription refresh that rolls back reports failure without a success toast", async () => {
  const url = "https://example.com/rollback";
  const h = createHarness();
  h.subBodies.set(url, "trojan://demo@old.example:443#Old");
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().addSubscription("Rollback", url);
    await app.useStore.getState().connectCore();
    app.useStore.setState({ toasts: [] });
    h.subBodies.set(url, "trojan://demo@new.example:443#New");
    h.setApplyHandler(() => ({
      status: "rolled_back",
      failureStage: "startup",
      runningAfter: true,
      error: "新内核启动失败",
    }));
    await app.useStore.getState().refreshAllSubscriptions();
    const current = app.useStore.getState();
    assert.equal(current.connected, true);
    assert.equal(current.nodes[0]?.server, "old.example");
    assert.match(toastText(current.toasts), /已回滚/);
    assert.doesNotMatch(toastText(current.toasts), /已更新/);
  } finally {
    app.dispose();
  }
});

test("reopening the window does not revive a core that exits while restoring telemetry", async () => {
  const h = createHarness(undefined, { isColdStart: false, coreRunning: true });
  const started = pendingSignal();
  const completion = pendingSignal();
  h.deps.fetchCurrentRoutingMode = async () => {
    started.resolve();
    await completion.promise;
    return "rule";
  };
  const app = createAppStore(h.deps);
  try {
    const initialized = app.useStore.getState().initializeApp();
    await started.promise;
    h.emitEvent("core-exited", "stopped while reopening");
    completion.resolve();
    await initialized;
    assert.equal(app.useStore.getState().connected, false);
    assert.equal(h.telemetryCallbacks.length, 0);
    assert.equal(h.trayUpdates.at(-1)?.connected, false);
    assert.match(toastText(app.useStore.getState().toasts), /stopped while reopening/);
  } finally {
    app.dispose();
  }
});

test("Bugfix 3: manual delay probes once per node and keeps timeout plus sort order", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const script = [239, 240, 241];
    let scriptCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.match(url, /generate_204/);
      assert.match(url, /timeout=5000/);
      const delay = script[scriptCalls++];
      assert.equal(typeof delay, "number");
      return {
        ok: true,
        json: async () => ({ delay }),
      } as Response;
    }) as typeof fetch;
    assert.deepEqual(
      [
        await measureNodeHttp204Delay("node-a", 5000),
        await measureNodeHttp204Delay("node-b", 5000),
        await measureNodeHttp204Delay("node-c", 5000),
      ],
      [239, 240, 241],
    );
    assert.equal(scriptCalls, 3);

    let timeoutCalls = 0;
    globalThis.fetch = (async () => {
      timeoutCalls++;
      return { ok: false, json: async () => ({}) } as Response;
    }) as typeof fetch;
    assert.equal(await measureNodeHttp204Delay("node-timeout", 5000), -1);
    assert.equal(timeoutCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const h = createHarness();
  h.setMeasure(measureNodeHttp204Delay);
  const app = createAppStore(h.deps);
  const probes: string[] = [];
  try {
    await app.useStore.getState().initializeApp();
    await app.useStore.getState().importRawLinks(
      [
        "trojan://demo@delay-a.example:443#A",
        "trojan://demo@delay-b.example:443#B",
        "trojan://demo@delay-c.example:443#C",
      ].join("\n"),
    );
    await app.useStore.getState().connectCore();
    const nodes = app.useStore.getState().nodes;
    const plan = new Map<string, number>([
      [nodes[0]!.tag, 241],
      [nodes[1]!.tag, 239],
      [nodes[2]!.tag, 240],
    ]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      probes.push(url);
      assert.match(url, /generate_204/);
      assert.match(url, /timeout=5000/);
      const matched = [...plan.entries()].find(([tag]) =>
        decodeURIComponent(url).includes(tag),
      );
      assert.ok(matched);
      return {
        ok: true,
        json: async () => ({ delay: matched?.[1] }),
      } as Response;
    }) as typeof fetch;
    await app.useStore.getState().testAllNodesDelay();
    assert.equal(probes.length, nodes.length);
    const byServer = new Map(
      app.useStore.getState().nodes.map((node) => [node.server, node.latency]),
    );
    assert.equal(byServer.get("delay-a.example"), 241);
    assert.equal(byServer.get("delay-b.example"), 239);
    assert.equal(byServer.get("delay-c.example"), 240);
    assert.equal(
      app.useStore.getState().nodes.every((node) => node.testing !== true),
      true,
    );
    assert.equal(app.useStore.getState().batchTesting, false);

    app.useStore.getState().sortNodesByLatency();
    assert.deepEqual(
      app.useStore.getState().nodes.map((node) => node.latency),
      [239, 240, 241],
    );

    probes.length = 0;
    const timeoutNode = app.useStore
      .getState()
      .nodes.find((node) => node.server === "delay-b.example")!;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      probes.push(String(input));
      const url = decodeURIComponent(String(input));
      if (url.includes(timeoutNode.tag)) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ delay: 80 }) } as Response;
    }) as typeof fetch;
    await app.useStore.getState().testSingleNodeDelay(timeoutNode.id);
    assert.equal(probes.length, 1);
    assert.equal(
      app.useStore.getState().nodes.find((node) => node.id === timeoutNode.id)
        ?.latency,
      -1,
    );
    assert.equal(
      app.useStore.getState().nodes.find((node) => node.id === timeoutNode.id)
        ?.testing,
      false,
    );

    probes.length = 0;
    await app.useStore.getState().testAllNodesDelay();
    assert.equal(probes.length, 3);
    assert.equal(
      app.useStore.getState().nodes.every((node) => node.testing !== true),
      true,
    );
    const timedOut = app.useStore
      .getState()
      .nodes.find((node) => node.id === timeoutNode.id);
    assert.equal(timedOut?.latency, -1);
    assert.equal(
      app.useStore
        .getState()
        .nodes.filter((node) => node.id !== timeoutNode.id)
        .every((node) => node.latency === 80),
      true,
    );
    app.useStore.getState().sortNodesByLatency();
    const ordered = app.useStore.getState().nodes.map((node) => node.latency);
    assert.deepEqual(ordered, [80, 80, -1]);
  } finally {
    globalThis.fetch = originalFetch;
    app.dispose();
  }
});

test("HY2 bandwidth: node link params win over the global default; global 0 means BBR", () => {
  const withParams = parseSingleShareUri(
    "hy2://pw@1.2.3.4:443?sni=a.example&upmbps=60&downmbps=90#WithParams",
  );
  const noParams = parseSingleShareUri(
    "hy2://pw@1.2.3.4:443?sni=a.example#NoParams",
  );
  assert.ok(withParams && noParams);

  // 节点自带带宽：无论全局是 BBR 还是 800 档，都用节点 90/60
  for (const [gDown, gUp] of [
    [0, 0],
    [800, 100],
  ] as const) {
    assert.deepEqual(resolveHy2CongestionControl(withParams, gDown, gUp), {
      mode: "brutal",
      downMbps: 90,
      upMbps: 60,
      source: "node",
    });
  }

  // 节点未声明：跟随全局默认，0 → BBR
  assert.deepEqual(resolveHy2CongestionControl(noParams, 0, 0), { mode: "bbr" });
  assert.deepEqual(resolveHy2CongestionControl(noParams, 45, 20), {
    mode: "brutal",
    downMbps: 45,
    upMbps: 20,
    source: "global",
  });

  // 生成的配置与解析结果一致
  const cfg = buildSingBoxConfig({
    nodes: [withParams, noParams],
    selectedOutbound: "auto",
    routingMode: "rule",
    tunMode: false,
    forceProxyText: "",
    forceDirectText: "",
    brutalDownMbps: 0,
    brutalUpMbps: 0,
  }) as { outbounds: Array<Record<string, unknown>> };
  const hy2 = cfg.outbounds.filter((o) => o.type === "hysteria2");
  assert.equal(hy2.length, 2);
  const a = hy2.find((o) => o.tag === withParams.tag)!;
  const b = hy2.find((o) => o.tag === noParams.tag)!;
  assert.equal(a.down_mbps, 90);
  assert.equal(a.up_mbps, 60);
  assert.equal("down_mbps" in b, false);
  assert.equal("up_mbps" in b, false);
});

test("HY2 bandwidth: legacy persisted tier derives upload; explicit custom upload is kept", () => {
  const legacy300 = migratePersistedState({ nodes: [], brutalDownMbps: 300 }, 0);
  assert.equal(legacy300.brutalDownMbps, 300);
  assert.equal(legacy300.brutalUpMbps, 60);

  const legacyBbr = migratePersistedState({ nodes: [], brutalDownMbps: 0 }, 0);
  assert.equal(legacyBbr.brutalDownMbps, 0);
  assert.equal(legacyBbr.brutalUpMbps, 0);

  const custom = migratePersistedState(
    { nodes: [], brutalDownMbps: 90, brutalUpMbps: 60 },
    0,
  );
  assert.equal(custom.brutalDownMbps, 90);
  assert.equal(custom.brutalUpMbps, 60);
});

test("Five-dimension overhaul: protocol parser edge cases (httpupgrade, gun, ss %3D, slash password, unsupported transport)", () => {
  // 1. VLESS httpupgrade maps to native type: "httpupgrade", never "ws"
  const vlessHu = parseSingleShareUri(
    "vless://11111111-1111-1111-1111-111111111111@hu.example:443?security=tls&type=httpupgrade&host=cdn.hu.example&path=%2Fup%3Fed%3D2048#HU-Node",
  );
  assert.ok(vlessHu);
  assert.equal(vlessHu.vless?.transport?.type, "httpupgrade");
  assert.equal(vlessHu.vless?.transport?.path, "/up");
  assert.equal(vlessHu.vless?.transport?.host, "cdn.hu.example");

  const cfgHu = buildSingBoxConfig({
    nodes: [vlessHu],
    selectedOutbound: vlessHu.id,
    routingMode: "rule",
    tunMode: false,
    forceProxyText: "",
    forceDirectText: "",
  });
  const huOut = (cfgHu.outbounds as Array<Record<string, unknown>>).find(
    (o) => o.tag === vlessHu.tag,
  )!;
  assert.deepEqual(huOut.transport, {
    type: "httpupgrade",
    path: "/up",
    host: "cdn.hu.example",
  });

  // 2. type=gun maps to grpc
  const trojanGun = parseSingleShareUri(
    "trojan://secret@grpc.example:443?type=gun&serviceName=my-gun-svc#GunNode",
  );
  assert.ok(trojanGun);
  assert.equal(trojanGun.trojan?.transport?.type, "grpc");
  assert.equal(trojanGun.trojan?.transport?.serviceName, "my-gun-svc");

  // 3. Unsupported transports (xhttp / kcp) are rejected rather than silently downgraded to broken TCP
  assert.equal(
    parseSingleShareUri(
      "vless://11111111-1111-1111-1111-111111111111@x.example:443?security=tls&type=xhttp&path=/x#BadXhttp",
    ),
    null,
  );
  assert.equal(
    parseSingleShareUri("trojan://pw@k.example:443?type=kcp#BadKcp"),
    null,
  );

  // 4. Shadowsocks SIP002 with URL-encoded Base64 padding (%3D%3D) & legacy encoded Base64
  const rawCred = btoa("aes-256-gcm:p@ss:w0rd!"); // ends with ==
  const encodedCred = encodeURIComponent(rawCred);
  assert.match(encodedCred, /%3D/i);
  const ssSip002 = parseSingleShareUri(
    `ss://${encodedCred}@ss.example:8388#SS-Encoded`,
  );
  assert.ok(ssSip002);
  assert.equal(ssSip002.shadowsocks?.method, "aes-256-gcm");
  assert.equal(ssSip002.shadowsocks?.password, "p@ss:w0rd!");
  assert.equal(ssSip002.server, "ss.example");
  assert.equal(ssSip002.serverPort, 8388);

  // 5. Hysteria2 / Trojan password containing raw '/' does not truncate @host:port
  const hy2Slash = parseSingleShareUri(
    "hy2://base64/key+with/slashes@hy2.slash.example:8443/?sni=hy2.slash.example#SlashPW",
  );
  assert.ok(hy2Slash);
  assert.equal(hy2Slash.server, "hy2.slash.example");
  assert.equal(hy2Slash.serverPort, 8443);
  assert.equal(hy2Slash.hysteria2?.password, "base64/key+with/slashes");
});

test("Five-dimension overhaul: rename skips core restart, HY2 inline mport edit cleans rawUri, and TUN/SysProxy stay mutually exclusive", async () => {
  const h = createHarness();
  const app = createAppStore(h.deps);
  try {
    await app.useStore.getState().initializeApp();

    // Fresh store defaults to BBR (0 / 0) for undeclared HY2 nodes
    assert.equal(app.useStore.getState().brutalDownMbps, 0);
    assert.equal(app.useStore.getState().brutalUpMbps, 0);

    await app.useStore
      .getState()
      .importRawLinks("hy2://pw@1.2.3.4:20000-40000?sni=a.example#HY2-Hop");
    await app.useStore.getState().connectCore();
    assert.equal(app.useStore.getState().connected, true);

    const node0 = app.useStore.getState().nodes[0]!;
    assert.deepEqual(node0.hysteria2?.serverPorts, ["20000:40000"]);
    h.applyCalls.length = 0;

    // 1. Display-only rename triggers ZERO reloadCoreConfig (0 applyCalls) while updating tray
    await app.useStore.getState().selectOutbound(node0.id);
    await app.useStore.getState().updateNodeConfig(node0.id, {
      name: "HK-NoRestart",
      mport: "20000-40000",
    });
    assert.equal(h.applyCalls.length, 0);
    assert.equal(app.useStore.getState().nodes[0]?.name, "HK-NoRestart");
    assert.equal(h.trayUpdates.at(-1)?.activeNode, "HK-NoRestart");

    // 2. Clearing inline mport removes :20000-40000 from rawUri authority and reloads once
    await app.useStore.getState().updateNodeConfig(node0.id, {
      name: "HK-SinglePort",
      mport: "",
    });
    assert.equal(h.applyCalls.length, 1);
    const updated = app.useStore.getState().nodes[0]!;
    assert.equal(updated.hysteria2?.serverPorts, undefined);
    assert.doesNotMatch(updated.rawUri, /20000-40000/);
    assert.match(updated.rawUri, /1\.2\.3\.4:20000/);

    // 3. Enabling TUN disables SysProxy; clicking SysProxy while in TUN cleanly turns off TUN
    await app.useStore.getState().toggleTunMode();
    assert.equal(app.useStore.getState().tunMode, true);
    assert.equal(app.useStore.getState().sysProxy, false);

    await app.useStore.getState().toggleSysProxy();
    assert.equal(app.useStore.getState().tunMode, false);
    assert.equal(app.useStore.getState().sysProxy, true);

    // 4. Switching terminal shell syncs to Tray; duplicate non-fatal core-stdio suppressed when /logs WS active
    app.useStore.getState().setTerminalShell("cmd");
    assert.equal(h.trayUpdates.at(-1)?.terminalShell, "cmd");

    app.useStore.getState().setActiveTab("settings");
    app.useStore.getState().setSettingsSubTab("logs");
    app.useStore.getState().clearLogs();
    h.emitEvent("core-stdio", "WARN duplicate line from stdio");
    assert.equal(app.telemetryStore.getState().logs.length, 0);
    h.emitEvent("core-stdio", "FATAL unrecoverable panic");
    assert.equal(app.telemetryStore.getState().logs.length, 1);
  } finally {
    app.dispose();
  }
});
