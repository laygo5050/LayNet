import type {
  NodeTransportConfig,
  ProxyNode,
} from "../types/proxy";

const SUPPORTED_SCHEMES = [
  "vless://",
  "hy2://",
  "hysteria2://",
  "ss://",
  "trojan://",
];

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * 解码 Base64 / Base64URL 字符串并按 UTF-8 还原文本（完美支持中文与国旗 Emoji）
 */
export function decodeBase64Utf8(input: string): string | null {
  const cleaned = input.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!cleaned || cleaned.length < 4) return null;
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + "=".repeat(padLen);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 将 Hysteria2 端口跳跃表达式（如 "20000-40000"、"443,20000-30000"、"20000:40000"）
 * 严格转换为 sing-box v1.14+ 要求的冒号分隔范围数组：["20000:40000"] 或 ["443:443", "20000:30000"]
 */
export function normalizeMportToSingBox(mportRaw: string): string[] {
  const result: string[] = [];
  const parts = mportRaw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d{1,5})\s*[-:]\s*(\d{1,5})$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start >= 1 && end <= 65535 && start <= end) {
        result.push(`${start}:${end}`);
      }
      continue;
    }
    const singleMatch = part.match(/^(\d{1,5})$/);
    if (singleMatch) {
      const p = Number(singleMatch[1]);
      if (p >= 1 && p <= 65535) {
        result.push(`${p}:${p}`);
      }
    }
  }
  return result;
}

/**
 * 解析通用传输层参数（ws / grpc / http）
 */
function parseTransport(params: URLSearchParams): NodeTransportConfig | undefined {
  const netType = (params.get("type") || params.get("net") || "tcp").toLowerCase();

  if (netType === "ws" || netType === "websocket" || netType === "httpupgrade") {
    let rawPath = safeDecodeURIComponent(params.get("path") || "/");
    let maxEarlyData: number | undefined;
    let earlyDataHeaderName: string | undefined;

    // 兼容常见 ?ed=2048 Early Data 写法并剥离出干净 path
    const edMatch = rawPath.match(/^(.*?)(?:\?|&)ed=(\d+)(.*)$/i);
    if (edMatch) {
      const prefix = edMatch[1] || "/";
      const suffix = edMatch[3] ? `?${edMatch[3].replace(/^[?&]/, "")}` : "";
      rawPath = prefix + suffix;
      maxEarlyData = Number(edMatch[2]);
      earlyDataHeaderName = "Sec-WebSocket-Protocol";
    }
    if (!rawPath.startsWith("/")) {
      rawPath = `/${rawPath}`;
    }

    const host = params.get("host") || undefined;
    return {
      type: "ws",
      path: rawPath,
      host,
      maxEarlyData,
      earlyDataHeaderName,
    };
  }

  if (netType === "grpc") {
    const serviceName = safeDecodeURIComponent(
      params.get("serviceName") || params.get("path") || "",
    ).replace(/^\//, "");
    return {
      type: "grpc",
      serviceName,
    };
  }

  if (netType === "http" || netType === "h2") {
    return {
      type: "http",
      path: safeDecodeURIComponent(params.get("path") || "/"),
      host: params.get("host") || undefined,
    };
  }

  return undefined;
}

function splitHostPort(hostPortStr: string, defaultPort = 443): {
  host: string;
  port: number;
  inlineMport?: string;
} | null {
  const trimmed = hostPortStr.trim();
  if (!trimmed) return null;

  // IPv6: [2001:db8::1]:443 或 [2001:db8::1]:20000-40000
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx === -1) return null;
    const host = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    if (!rest.startsWith(":")) {
      return { host, port: defaultPort };
    }
    const portSpec = rest.slice(1);
    if (/^\d+$/.test(portSpec)) {
      return { host, port: Number(portSpec) };
    }
    const firstNum = portSpec.match(/^(\d+)/);
    return {
      host,
      port: firstNum ? Number(firstNum[1]) : defaultPort,
      inlineMport: portSpec,
    };
  }

  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx === -1) {
    return { host: trimmed, port: defaultPort };
  }
  const host = trimmed.slice(0, colonIdx);
  const portSpec = trimmed.slice(colonIdx + 1);
  if (/^\d+$/.test(portSpec)) {
    return { host, port: Number(portSpec) };
  }
  const firstNum = portSpec.match(/^(\d+)/);
  return {
    host,
    port: firstNum ? Number(firstNum[1]) : defaultPort,
    inlineMport: portSpec,
  };
}

/**
 * 通用解析形如 scheme://userinfo@host:port/?query#hash 的链接（兼容非数字端口跳跃区间）
 */
function dissectStandardProxyUri(uri: string, defaultPort = 443): {
  userinfo: string;
  host: string;
  port: number;
  inlineMport?: string;
  params: URLSearchParams;
  remark: string;
} | null {
  const schemeIdx = uri.indexOf("://");
  if (schemeIdx === -1) return null;
  let rest = uri.slice(schemeIdx + 3);

  let remark = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    remark = safeDecodeURIComponent(rest.slice(hashIdx + 1)).trim();
    rest = rest.slice(0, hashIdx);
  }

  let queryStr = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    queryStr = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // 去除路径尾部斜杠
  const slashIdx = rest.indexOf("/");
  if (slashIdx !== -1) {
    rest = rest.slice(0, slashIdx);
  }

  const atIdx = rest.lastIndexOf("@");
  let userinfo = "";
  let hostPortPart = rest;
  if (atIdx !== -1) {
    userinfo = safeDecodeURIComponent(rest.slice(0, atIdx));
    hostPortPart = rest.slice(atIdx + 1);
  }

  const hp = splitHostPort(hostPortPart, defaultPort);
  if (!hp || !hp.host) return null;

  return {
    userinfo,
    host: hp.host,
    port: hp.port,
    inlineMport: hp.inlineMport,
    params: new URLSearchParams(queryStr),
    remark,
  };
}

function parseVlessUri(uri: string): ProxyNode | null {
  const parsed = dissectStandardProxyUri(uri, 443);
  if (!parsed || !parsed.userinfo) return null;

  const { userinfo: uuid, host, port, params, remark } = parsed;
  const security = (params.get("security") || "none").toLowerCase();
  const isReality = security === "reality" || Boolean(params.get("pbk"));
  const isTls = isReality || security === "tls" || security === "xtls";

  const sni = params.get("sni") || params.get("peer") || undefined;
  const fp = params.get("fp") || (isReality ? "chrome" : undefined);
  const flow = params.get("flow") || undefined;
  const packetEncoding = params.get("packetEncoding") || "xudp";
  const insecure =
    params.get("allowInsecure") === "1" ||
    params.get("allowInsecure") === "true" ||
    params.get("insecure") === "1" ||
    params.get("insecure") === "true";

  const alpnRaw = params.get("alpn");
  const alpn = alpnRaw
    ? safeDecodeURIComponent(alpnRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const transport = parseTransport(params);

  let reality: { publicKey: string; shortId: string } | undefined;
  if (isReality) {
    const publicKey = params.get("pbk") || "";
    if (!publicKey) return null;
    const shortId = params.get("sid") || "";
    reality = { publicKey, shortId };
  }

  const name = remark || `VLESS ${host}:${port}`;
  const id = makeId();
  return {
    id,
    tag: makeStableOutboundTag(id),
    name,
    protocol: "vless",
    server: host,
    serverPort: port,
    rawUri: uri,
    vless: {
      uuid,
      flow: transport ? undefined : flow,
      packetEncoding,
      tlsEnabled: isTls,
      serverName: sni || (isTls ? host : undefined),
      insecure: insecure || undefined,
      alpn,
      fingerprint: fp,
      reality,
      transport,
    },
  };
}

/**
 * 随包 sing-box 1.14 只能校验公钥指纹。Hysteria2 的 `pinSHA256` 是整张证书的 SHA-256，
 * 对应 sing-box 1.15 的 `certificate_sha256`，两种摘要不能互换。无法兑现时必须跳过节点。
 */
export const HYSTERIA2_CERT_PIN_SKIP_REASON =
  "Hysteria2 要求 pinSHA256 整张证书指纹，当前内置 sing-box 1.14 无法校验整证，且不能改用公钥指纹，已跳过该节点";

export type CertPinSkipEffect = "fallback-auto" | "stay-disconnected";

export function formatCertPinSkipSummary(
  count: number,
  effect?: CertPinSkipEffect,
): string {
  const base =
    count === 1
      ? HYSTERIA2_CERT_PIN_SKIP_REASON
      : `已跳过 ${count} 个 Hysteria2 节点：要求 pinSHA256 整张证书指纹，当前内核无法校验，且不能改用公钥指纹`;
  if (effect === "stay-disconnected") {
    return `${base}。没有其他可用节点，已保持断开`;
  }
  if (effect === "fallback-auto") {
    return `${base}。已回退到自动选择`;
  }
  return base;
}

/** 分享链接是否要求当前内核无法兑现的整证指纹。只认 Hysteria2 查询参数 `pinSHA256`。 */
export function shareUriRequiresUnsupportedCertPin(
  uri: string | null | undefined,
): boolean {
  if (!uri) return false;
  const trimmed = uri.trim();
  const schemeIdx = trimmed.indexOf("://");
  if (schemeIdx <= 0) return false;
  const scheme = trimmed.slice(0, schemeIdx).toLowerCase();
  if (scheme !== "hy2" && scheme !== "hysteria2") return false;

  let rest = trimmed.slice(schemeIdx + 3);
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
  const queryIdx = rest.indexOf("?");
  if (queryIdx === -1) return false;

  const params = new URLSearchParams(rest.slice(queryIdx + 1));
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === "pinsha256" && value.trim() !== "") {
      return true;
    }
  }
  return false;
}

export function omitUnsupportedCertPinNodes(nodes: ProxyNode[]): ProxyNode[] {
  return nodes.filter((node) => !shareUriRequiresUnsupportedCertPin(node.rawUri));
}

function parseHysteria2Uri(uri: string): ProxyNode | null {
  if (shareUriRequiresUnsupportedCertPin(uri)) return null;
  const parsed = dissectStandardProxyUri(uri, 443);
  if (!parsed) return null;

  const { userinfo, host, port, inlineMport, params, remark } = parsed;
  const password = userinfo || params.get("auth") || "";

  const mportRaw = [inlineMport, params.get("mport")]
    .filter(Boolean)
    .join(",");
  const serverPorts = mportRaw ? normalizeMportToSingBox(mportRaw) : undefined;

  const sni = params.get("sni") || params.get("peer") || host;
  const insecure =
    params.get("insecure") === "1" ||
    params.get("insecure") === "true" ||
    params.get("allowInsecure") === "1" ||
    params.get("allowInsecure") === "true";

  const obfsType = (params.get("obfs") || "").toLowerCase();
  const obfsPassword =
    obfsType === "salamander"
      ? params.get("obfs-password") || params.get("obfsParam") || ""
      : undefined;

  const alpnRaw = params.get("alpn");
  const alpn = alpnRaw
    ? safeDecodeURIComponent(alpnRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const upRaw = Number(params.get("upmbps") || params.get("up") || "");
  const downRaw = Number(params.get("downmbps") || params.get("down") || "");
  const upMbps = Number.isFinite(upRaw) && upRaw > 0 ? upRaw : undefined;
  const downMbps = Number.isFinite(downRaw) && downRaw > 0 ? downRaw : undefined;

  const name = remark || `HY2 ${host}:${port}`;
  const id = makeId();
  return {
    id,
    tag: makeStableOutboundTag(id),
    name,
    protocol: "hysteria2",
    server: host,
    serverPort: port,
    rawUri: uri,
    hysteria2: {
      password,
      serverPorts: serverPorts && serverPorts.length > 0 ? serverPorts : undefined,
      sni,
      insecure: insecure || undefined,
      alpn,
      obfsPassword,
      upMbps,
      downMbps,
    },
  };
}

function parseShadowsocksUri(uri: string): ProxyNode | null {
  let body = uri.slice("ss://".length).trim();
  let remark = "";
  const hashIdx = body.indexOf("#");
  if (hashIdx !== -1) {
    remark = safeDecodeURIComponent(body.slice(hashIdx + 1)).trim();
    body = body.slice(0, hashIdx);
  }

  let queryStr = "";
  const qIdx = body.indexOf("?");
  if (qIdx !== -1) {
    queryStr = body.slice(qIdx + 1);
    body = body.slice(0, qIdx);
  }
  body = body.replace(/\/$/, "");

  // 若整体不含 @，说明是 Legacy 全量 Base64 格式 ss://BASE64(method:password@host:port)
  if (!body.includes("@")) {
    const decodedAll = decodeBase64Utf8(body);
    if (!decodedAll || !decodedAll.includes("@")) return null;
    body = decodedAll.trim();
  }

  const atIdx = body.lastIndexOf("@");
  if (atIdx === -1) return null;
  let userPart = body.slice(0, atIdx);
  const hostPortPart = body.slice(atIdx + 1);

  if (!userPart.includes(":")) {
    const decodedUser = decodeBase64Utf8(userPart);
    if (decodedUser && decodedUser.includes(":")) {
      userPart = decodedUser;
    } else {
      userPart = safeDecodeURIComponent(userPart);
    }
  } else {
    userPart = safeDecodeURIComponent(userPart);
  }

  const colonIdx = userPart.indexOf(":");
  if (colonIdx === -1) return null;
  const method = userPart.slice(0, colonIdx).trim();
  const password = userPart.slice(colonIdx + 1);
  if (!method) return null;

  const hp = splitHostPort(hostPortPart, 8388);
  if (!hp || !hp.host) return null;

  const params = new URLSearchParams(queryStr);
  const pluginParam = params.get("plugin");
  let plugin: string | undefined;
  let pluginOpts: string | undefined;
  if (pluginParam) {
    const decodedPlugin = safeDecodeURIComponent(pluginParam);
    const semiIdx = decodedPlugin.indexOf(";");
    if (semiIdx !== -1) {
      plugin = decodedPlugin.slice(0, semiIdx);
      pluginOpts = decodedPlugin.slice(semiIdx + 1);
    } else {
      plugin = decodedPlugin;
    }
  }

  const name = remark || `SS ${hp.host}:${hp.port}`;
  const id = makeId();
  return {
    id,
    tag: makeStableOutboundTag(id),
    name,
    protocol: "shadowsocks",
    server: hp.host,
    serverPort: hp.port,
    rawUri: uri,
    shadowsocks: {
      method,
      password,
      plugin,
      pluginOpts,
    },
  };
}

function parseTrojanUri(uri: string): ProxyNode | null {
  const parsed = dissectStandardProxyUri(uri, 443);
  if (!parsed || !parsed.userinfo) return null;

  const { userinfo: password, host, port, params, remark } = parsed;
  const sni = params.get("sni") || params.get("peer") || host;
  const insecure =
    params.get("allowInsecure") === "1" ||
    params.get("allowInsecure") === "true" ||
    params.get("insecure") === "1" ||
    params.get("insecure") === "true";
  const fp = params.get("fp") || undefined;

  const alpnRaw = params.get("alpn");
  const alpn = alpnRaw
    ? safeDecodeURIComponent(alpnRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const transport = parseTransport(params);
  const name = remark || `Trojan ${host}:${port}`;
  const id = makeId();

  return {
    id,
    tag: makeStableOutboundTag(id),
    name,
    protocol: "trojan",
    server: host,
    serverPort: port,
    rawUri: uri,
    trojan: {
      password,
      sni,
      insecure: insecure || undefined,
      alpn,
      fingerprint: fp,
      transport,
    },
  };
}

export function parseSingleShareUri(rawLine: string): ProxyNode | null {
  const line = rawLine.trim();
  if (!line) return null;
  const lower = line.toLowerCase();
  if (lower.startsWith("vless://")) return parseVlessUri(line);
  if (lower.startsWith("hy2://") || lower.startsWith("hysteria2://")) {
    return parseHysteria2Uri(line);
  }
  if (lower.startsWith("ss://")) return parseShadowsocksUri(line);
  if (lower.startsWith("trojan://")) return parseTrojanUri(line);
  return null;
}

export interface SkippedShareLink {
  raw: string;
  reason: string;
}

export interface ParsedShareBatch {
  nodes: ProxyNode[];
  skipped: SkippedShareLink[];
}

/**
 * 批量解析分享链接或订阅文本，分别返回可用节点与跳过原因。
 * 要求整证指纹的 Hysteria2 节点不会进入可用列表，同批其余节点继续可用。
 */
export function parseShareBatch(
  rawText: string,
  subscriptionId?: string,
): ParsedShareBatch {
  const trimmed = rawText.trim();
  if (!trimmed) return { nodes: [], skipped: [] };

  let candidateText = trimmed;
  const hasDirectScheme = SUPPORTED_SCHEMES.some((s) =>
    trimmed.toLowerCase().includes(s),
  );

  if (!hasDirectScheme) {
    const decoded = decodeBase64Utf8(trimmed);
    if (
      decoded &&
      SUPPORTED_SCHEMES.some((s) => decoded.toLowerCase().includes(s))
    ) {
      candidateText = decoded;
    }
  }

  const lines = candidateText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  const nodes: ProxyNode[] = [];
  const skipped: SkippedShareLink[] = [];
  for (const line of lines) {
    if (shareUriRequiresUnsupportedCertPin(line)) {
      skipped.push({ raw: line, reason: HYSTERIA2_CERT_PIN_SKIP_REASON });
      continue;
    }
    const parsed = parseSingleShareUri(line);
    if (parsed) {
      if (subscriptionId) {
        parsed.subscriptionId = subscriptionId;
      }
      nodes.push(parsed);
    }
  }

  return { nodes: ensureUniqueTags(nodes), skipped };
}

/**
 * 批量智能解析剪贴板或订阅文本（自动识别多行分享链接与 Base64 订阅体）
 */
export function parseBatchSubscriptionContent(
  rawText: string,
  subscriptionId?: string,
): ProxyNode[] {
  return parseShareBatch(rawText, subscriptionId).nodes;
}

const RESERVED_OUTBOUND_TAGS = new Set([
  "proxy",
  "auto",
  "direct",
  "dns-direct",
  "dns-remote",
]);

/**
 * 基于稳定节点 ID 生成 sing-box / Clash 内部出站 tag，避免因备注重名、修改名称或排序变化导致 tag 漂移
 */
export function makeStableOutboundTag(id: string): string {
  const clean = id.trim();
  return clean.startsWith("node-") ? clean : `node-${clean}`;
}

function normalizeTransportForKey(t?: NodeTransportConfig) {
  if (!t) return null;
  return {
    type: t.type,
    path: t.path ?? "",
    host: t.host ?? "",
    serviceName: t.serviceName ?? "",
    maxEarlyData: t.maxEarlyData ?? null,
    earlyDataHeaderName: t.earlyDataHeaderName ?? "",
  };
}

/**
 * 计算同一订阅内用于识别节点身份的连接特征键（忽略备注显示名、延迟与内部 tag）
 */
export function getNodeConnectionKey(node: ProxyNode): string {
  const base = {
    protocol: node.protocol,
    server: node.server.trim().toLowerCase(),
    serverPort: node.serverPort,
  };

  if (node.protocol === "vless" && node.vless) {
    return JSON.stringify({
      ...base,
      uuid: node.vless.uuid,
      flow: node.vless.flow ?? "",
      packetEncoding: node.vless.packetEncoding ?? "",
      tlsEnabled: node.vless.tlsEnabled,
      serverName: node.vless.serverName ?? "",
      insecure: Boolean(node.vless.insecure),
      alpn: node.vless.alpn ?? [],
      fingerprint: node.vless.fingerprint ?? "",
      reality: node.vless.reality ?? null,
      transport: normalizeTransportForKey(node.vless.transport),
    });
  }

  if (node.protocol === "hysteria2" && node.hysteria2) {
    return JSON.stringify({
      ...base,
      password: node.hysteria2.password,
      serverPorts: node.hysteria2.serverPorts ?? [],
      hopInterval: node.hysteria2.hopInterval ?? "",
      sni: node.hysteria2.sni ?? "",
      insecure: Boolean(node.hysteria2.insecure),
      alpn: node.hysteria2.alpn ?? [],
      obfsPassword: node.hysteria2.obfsPassword ?? "",
    });
  }

  if (node.protocol === "shadowsocks" && node.shadowsocks) {
    return JSON.stringify({
      ...base,
      method: node.shadowsocks.method,
      password: node.shadowsocks.password,
      plugin: node.shadowsocks.plugin ?? "",
      pluginOpts: node.shadowsocks.pluginOpts ?? "",
    });
  }

  if (node.protocol === "trojan" && node.trojan) {
    return JSON.stringify({
      ...base,
      password: node.trojan.password,
      sni: node.trojan.sni ?? "",
      insecure: Boolean(node.trojan.insecure),
      alpn: node.trojan.alpn ?? [],
      fingerprint: node.trojan.fingerprint ?? "",
      transport: normalizeTransportForKey(node.trojan.transport),
    });
  }

  return JSON.stringify(base);
}

/**
 * 订阅刷新时在同一订阅内按连接特征匹配原节点并复用其稳定 ID（及内部 tag）
 */
export function matchSubscriptionNodeIds(
  existingSubNodes: ProxyNode[],
  parsedSubNodes: ProxyNode[],
): ProxyNode[] {
  const buckets = new Map<string, ProxyNode[]>();
  for (const prev of existingSubNodes) {
    const key = getNodeConnectionKey(prev);
    const list = buckets.get(key);
    if (list) {
      list.push(prev);
    } else {
      buckets.set(key, [prev]);
    }
  }

  return parsedSubNodes.map((next) => {
    const key = getNodeConnectionKey(next);
    const list = buckets.get(key);
    const matched = list?.shift();
    if (!matched) {
      return next;
    }
    return {
      ...next,
      id: matched.id,
      tag: makeStableOutboundTag(matched.id),
      latency: matched.latency,
    };
  });
}

/**
 * 为 UI / 托盘生成独立于内部 outbound tag 的可读显示名（仅在展示层对重名节点追加 `#2` 后缀）
 */
export function getNodeDisplayMap(nodes: ProxyNode[]): Map<string, string> {
  const used = new Set<string>(RESERVED_OUTBOUND_TAGS);
  const map = new Map<string, string>();
  for (const node of nodes) {
    const baseName = (node.name || `${node.protocol}-${node.server}`).trim();
    let label = baseName;
    let counter = 2;
    while (used.has(label)) {
      label = `${baseName} #${counter}`;
      counter++;
    }
    used.add(label);
    map.set(node.id, label);
  }
  return map;
}

/**
 * 根据内部 outbound tag 或节点 ID 还原可读节点名称（供界面、自动优选展示、连接透视与托盘使用）
 */
export function resolveNodeDisplayName(
  nodes: ProxyNode[],
  idOrTag: string | null | undefined,
): string | null {
  if (!idOrTag) return null;
  if (idOrTag === "auto") return "自动选择";
  if (idOrTag === "direct") return "direct";
  const matched = nodes.find((n) => n.id === idOrTag || n.tag === idOrTag);
  if (!matched) return idOrTag;
  return getNodeDisplayMap(nodes).get(matched.id) ?? matched.name;
}

/**
 * 确保所有节点的稳定 `id` 与内部 sing-box / Clash outbound `tag` 全局唯一且不与内置保留 tag 冲突
 */
export function ensureUniqueTags(nodes: ProxyNode[]): ProxyNode[] {
  const seenIds = new Set<string>(RESERVED_OUTBOUND_TAGS);
  const usedTags = new Set<string>(RESERVED_OUTBOUND_TAGS);

  return nodes.map((node) => {
    let id = typeof node.id === "string" ? node.id.trim() : "";
    if (!id || seenIds.has(id)) {
      do {
        id = makeId();
      } while (seenIds.has(id));
    }
    seenIds.add(id);

    let candidate = makeStableOutboundTag(id);
    let suffix = 2;
    while (usedTags.has(candidate)) {
      candidate = `${makeStableOutboundTag(id)}-${suffix}`;
      suffix++;
    }
    usedTags.add(candidate);

    return {
      ...node,
      id,
      tag: candidate,
    };
  });
}
