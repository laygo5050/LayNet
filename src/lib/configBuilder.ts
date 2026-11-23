import type {
  NodeTransportConfig,
  ProxyNode,
  RoutingMode,
} from "../types/proxy";
import { ensureUniqueTags, omitUnsupportedCertPinNodes } from "./uriParser";

export interface ParsedCustomRuleGroup {
  domains: string[];
  domainSuffixes: string[];
  domainKeywords: string[];
  ipCidrs: string[];
  processNames: string[];
}

export function countCustomRules(group: ParsedCustomRuleGroup): number {
  return (
    group.domains.length +
    group.domainSuffixes.length +
    group.domainKeywords.length +
    group.ipCidrs.length +
    group.processNames.length
  );
}

/**
 * 本地 / 局域网私有域名后缀：优先经本机 hosts 与系统本地 DNS 解析，避免被发往公网 DNS 或代理节点。
 */
export const PRIVATE_LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "lan",
  "home.arpa",
  "internal",
  "intranet",
  "localdomain",
];

/**
 * 内置五大 AI 套件（Antigravity / Cursor / Grok / ChatGPT & Codex / Claude）加速清单：
 * - 已剔除 `agent.exe` / `inno_updater.exe` / `elevate.exe` / `language_server.exe` 等易与第三方软件碰撞的泛用进程名；
 * - 进程规则位于 `ip_is_private -> direct` 之后，确保本地 127.0.0.1 通信直连不白屏；
 * - 域名规则位于 `geosite-cn` 之前，可在自定义分流弹窗中按需一键开关。
 */
export const AI_SUITE_FORCE_PROXY_PROCESSES = [
  // Antigravity (Google)
  "Antigravity.exe",
  "AntigravitySetup.exe",
  // Cursor
  "Cursor.exe",
  "cursor.exe",
  "cursor-agent.exe",
  "CursorSetup.exe",
  // Grok (xAI)
  "grok.exe",
  "Grok.exe",
  "grok-windows-x86_64.exe",
  "Grok Bot.exe",
  "GrokBot.exe",
  // ChatGPT / OpenAI / Codex
  "ChatGPT.exe",
  "codex.exe",
  "codex-windows-sandbox-service.exe",
  "openai.exe",
  // Claude / Anthropic / Claude Code
  "Claude.exe",
  "claude.exe",
  "claude-code.exe",
];

export const AI_SUITE_FORCE_PROXY_DOMAINS = [
  // Antigravity & Google AI / OAuth2 登录 / 自动更新 CDN（防止被 geosite-cn 误判直连导致更新掉登录）
  "antigravity.google",
  "googleapis.com",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "gvt1.com",
  "gvt2.com",
  "gvt3.com",
  "withgoogle.com",
  "deepmind.com",
  "deepmind.google",
  "google.dev",
  "g.co",
  "pki.goog",
  "1e100.net",
  "accounts.youtube.com",
  "firebaseio.com",
  "firebaseapp.com",
  "web.app",
  "codeium.com",
  "codeiumdata.com",
  // Cursor (IDE / API / 插件市场 / 认证 / 更新)
  "cursor.sh",
  "cursor.com",
  "cursor.so",
  "cursor-cdn.com",
  "cursorapi.com",
  "cursor-aisearch.com",
  "anysphere.co",
  "anysphere.dev",
  "workos.com",
  "stytch.com",
  // Grok & xAI / X OAuth 登录
  "grok.com",
  "x.ai",
  "xai.com",
  "x.com",
  "twitter.com",
  "twimg.com",
  "t.co",
  // ChatGPT / OpenAI / Codex / Sora & 登录认证
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "sora.com",
  "openaicom.imgix.net",
  "auth0.com",
  "arkoselabs.com",
  "funcaptcha.com",
  "statsigapi.net",
  "featuregates.org",
  // Claude / Anthropic / Claude Code
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "claudeusercontent.com",
  "clau.de",
  // 登录人机校验、GitHub OAuth 与 IDE 插件市场（精准限定扩展市场子域，不误伤企业 Azure DevOps）
  "recaptcha.net",
  "hcaptcha.com",
  "challenges.cloudflare.com",
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
  "open-vsx.org",
  "marketplace.visualstudio.com",
  "gallerycdn.vsassets.io",
];

export interface BuildSingBoxConfigInput {
  nodes: ProxyNode[];
  selectedOutbound: string;
  routingMode: RoutingMode;
  tunMode: boolean;
  forceProxyText: string;
  forceDirectText: string;
  aiSuiteProxyEnabled?: boolean;
  brutalDownMbps?: number;
  brutalUpMbps?: number;
  mixedPort?: number;
  clashApiPort?: number;
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidIpv6(ip: string): boolean {
  if (!ip.includes(":")) return false;
  const doubleColons = ip.split("::");
  if (doubleColons.length > 2) return false;

  const isHexGroup = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);

  if (doubleColons.length === 2) {
    const left = doubleColons[0] ? doubleColons[0].split(":") : [];
    const right = doubleColons[1] ? doubleColons[1].split(":") : [];
    const lastRight = right[right.length - 1];
    let ipv4Mapped = false;
    if (lastRight && lastRight.includes(".")) {
      if (!isValidIpv4(lastRight)) return false;
      right.pop();
      ipv4Mapped = true;
    }
    if (!left.every(isHexGroup) || !right.every(isHexGroup)) return false;
    const totalGroups = left.length + right.length + (ipv4Mapped ? 2 : 0);
    return totalGroups < 8;
  }

  const groups = ip.split(":");
  const last = groups[groups.length - 1];
  let ipv4Mapped = false;
  if (last && last.includes(".")) {
    if (!isValidIpv4(last)) return false;
    groups.pop();
    ipv4Mapped = true;
  }
  if (!groups.every(isHexGroup)) return false;
  return groups.length + (ipv4Mapped ? 2 : 0) === 8;
}

/**
 * 尝试将单行规则解析为合法 IPv4/IPv6 CIDR；单 IP 自动补齐 `/32` 或 `/128`。
 * 返回 `null` 表示非 IP 格式；返回 `"invalid"` 表示明显是损坏的 IP/CIDR（应丢弃而非误当域名）。
 */
function parseIpOrCidr(raw: string): string | "invalid" | null {
  const trimmed = raw.trim().replace(/^\[(.+)\]$/, "$1");
  if (!trimmed || trimmed.includes(" ")) return null;

  const slashIdx = trimmed.indexOf("/");
  const addrPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const prefixPart = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1);

  if (/^\d+(?:\.\d+){3}$/.test(addrPart)) {
    if (!isValidIpv4(addrPart)) return "invalid";
    if (prefixPart === null) return `${addrPart}/32`;
    if (!/^\d{1,2}$/.test(prefixPart)) return "invalid";
    const prefix = Number(prefixPart);
    if (prefix < 0 || prefix > 32) return "invalid";
    return `${addrPart}/${prefix}`;
  }

  // IPv6：包含至少两个冒号，或者带前缀长度且只含 IPv6 字符
  if (addrPart.includes(":")) {
    const colonCount = (addrPart.match(/:/g) ?? []).length;
    if (colonCount >= 2 || (prefixPart !== null && /^[0-9a-fA-F:.]+$/.test(addrPart))) {
      if (!isValidIpv6(addrPart)) return "invalid";
      if (prefixPart === null) return `${addrPart.toLowerCase()}/128`;
      if (!/^\d{1,3}$/.test(prefixPart)) return "invalid";
      const prefix = Number(prefixPart);
      if (prefix < 0 || prefix > 128) return "invalid";
      return `${addrPart.toLowerCase()}/${prefix}`;
    }
  }

  return null;
}

function normalizeDomainToken(raw: string): string {
  let cleaned = raw.trim().replace(/^[a-zA-Z]+:\/\//, "");
  cleaned = cleaned.split("/")[0] ?? "";
  if (cleaned.startsWith("[")) {
    const endBracket = cleaned.indexOf("]");
    if (endBracket !== -1) {
      cleaned = cleaned.slice(1, endBracket);
    }
  } else {
    cleaned = cleaned.split(":")[0] ?? "";
  }
  cleaned = cleaned.replace(/^\*\./, "").replace(/^\./, "").trim().toLowerCase();
  return cleaned;
}

function isValidDomainToken(token: string): boolean {
  return (
    token.length > 0 &&
    !token.includes(" ") &&
    !token.includes("/") &&
    !token.includes(":")
  );
}

/**
 * 解析多行自定义规则文本：
 * - 以 `.exe` 结尾（支持完整路径提取文件名）或 `process:` 前缀 -> `process_name`
 * - IPv4 / IPv6 单 IP 或 CIDR（或 `ip:` / `cidr:` 前缀）-> `ip_cidr`（自动补全 `/32` 或 `/128`）
 * - `full:` / `domain:` 前缀 -> `domain`（精确匹配）
 * - `keyword:` / `domain_keyword:` 前缀 -> `domain_keyword`（关键字匹配）
 * - 其余（含 `suffix:` 前缀或 URL/通配符域名）-> `domain_suffix`（若 URL 主机为 IP 则自动归入 `ip_cidr`）
 */
export function parseCustomRuleLines(text: string): ParsedCustomRuleGroup {
  const exactDomainSet = new Set<string>();
  const domainSuffixSet = new Set<string>();
  const domainKeywordSet = new Set<string>();
  const ipCidrSet = new Set<string>();
  const processSet = new Set<string>();

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  for (const raw of lines) {
    const prefixMatch = raw.match(
      /^(full|domain|suffix|domain_suffix|keyword|domain_keyword|ip|cidr|ip-cidr|ip_cidr|process):(.+)$/i,
    );
    if (prefixMatch) {
      const kind = prefixMatch[1]!.toLowerCase();
      const body = prefixMatch[2]!.trim();
      if (!body) continue;

      if (kind === "process") {
        const parts = body.split(/[\\/]/);
        const procName = parts[parts.length - 1]?.trim();
        if (procName) processSet.add(procName);
        continue;
      }
      if (kind === "ip" || kind === "cidr" || kind === "ip-cidr" || kind === "ip_cidr") {
        const cidr = parseIpOrCidr(body);
        if (cidr && cidr !== "invalid") ipCidrSet.add(cidr);
        continue;
      }
      if (kind === "keyword" || kind === "domain_keyword") {
        const kw = body.toLowerCase();
        if (kw && !kw.includes(" ")) domainKeywordSet.add(kw);
        continue;
      }
      const dom = normalizeDomainToken(body);
      if (!isValidDomainToken(dom)) continue;
      if (kind === "full" || kind === "domain") {
        exactDomainSet.add(dom);
      } else {
        domainSuffixSet.add(dom);
      }
      continue;
    }

    if (/\.exe$/i.test(raw)) {
      const parts = raw.split(/[\\/]/);
      const exeName = parts[parts.length - 1]?.trim();
      if (exeName) {
        processSet.add(exeName);
      }
      continue;
    }

    const directCidr = parseIpOrCidr(raw);
    if (directCidr === "invalid") {
      continue;
    }
    if (directCidr) {
      ipCidrSet.add(directCidr);
      continue;
    }

    const cleaned = normalizeDomainToken(raw);
    if (!cleaned) continue;

    // 处理类似 http://192.168.1.10:8080/api 或 http://[2606:4700::1]/ 的 IP URL
    const hostCidr = parseIpOrCidr(cleaned);
    if (hostCidr === "invalid") continue;
    if (hostCidr) {
      ipCidrSet.add(hostCidr);
      continue;
    }

    if (isValidDomainToken(cleaned)) {
      domainSuffixSet.add(cleaned);
    }
  }

  return {
    domains: Array.from(exactDomainSet),
    domainSuffixes: Array.from(domainSuffixSet),
    domainKeywords: Array.from(domainKeywordSet),
    ipCidrs: Array.from(ipCidrSet),
    processNames: Array.from(processSet),
  };
}

function buildDomainMatcherFields(
  group: ParsedCustomRuleGroup,
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  if (group.domains.length > 0) fields.domain = group.domains;
  if (group.domainSuffixes.length > 0) fields.domain_suffix = group.domainSuffixes;
  if (group.domainKeywords.length > 0) fields.domain_keyword = group.domainKeywords;
  return Object.keys(fields).length > 0 ? fields : null;
}

function buildSingBoxTransport(
  transport?: NodeTransportConfig,
): Record<string, unknown> | undefined {
  if (!transport) return undefined;

  if (transport.type === "ws") {
    const out: Record<string, unknown> = {
      type: "ws",
      path: transport.path || "/",
    };
    if (transport.host) {
      out.headers = { Host: transport.host };
    }
    if (transport.maxEarlyData) {
      out.max_early_data = transport.maxEarlyData;
      out.early_data_header_name =
        transport.earlyDataHeaderName || "Sec-WebSocket-Protocol";
    }
    return out;
  }

  if (transport.type === "grpc") {
    return {
      type: "grpc",
      service_name: transport.serviceName || "",
    };
  }

  if (transport.type === "http") {
    const out: Record<string, unknown> = {
      type: "http",
      path: transport.path || "/",
    };
    if (transport.host) {
      out.host = transport.host
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
    }
    return out;
  }

  return undefined;
}

export type Hy2CongestionControl =
  | {
      mode: "brutal";
      downMbps: number;
      upMbps: number;
      /** node: 节点链接自带 upmbps/downmbps；global: 设置页的默认带宽 */
      source: "node" | "global";
    }
  | { mode: "bbr" };

/**
 * 解析 Hysteria2 节点最终生效的拥塞控制（配置生成与 UI 展示共用同一份逻辑）。
 * 节点链接自带的带宽优先；缺失的方向用全局默认值补齐；上下行任一 <= 0 时走 BBR。
 */
export function resolveHy2CongestionControl(
  node: ProxyNode,
  globalDownMbps: number,
  globalUpMbps: number,
): Hy2CongestionControl {
  const h = node.hysteria2;
  if (!h) return { mode: "bbr" };
  const fromNode = h.downMbps !== undefined || h.upMbps !== undefined;
  const downMbps = h.downMbps ?? globalDownMbps;
  const upMbps = h.upMbps ?? globalUpMbps;
  if (downMbps > 0 && upMbps > 0) {
    return {
      mode: "brutal",
      downMbps,
      upMbps,
      source: fromNode ? "node" : "global",
    };
  }
  return { mode: "bbr" };
}

export function nodeToSingBoxOutbound(
  node: ProxyNode,
  defaultBrutalDownMbps = 800,
  defaultBrutalUpMbps = 100,
): Record<string, unknown> {
  if (node.protocol === "vless" && node.vless) {
    const v = node.vless;
    const out: Record<string, unknown> = {
      type: "vless",
      tag: node.tag,
      server: node.server,
      server_port: node.serverPort,
      uuid: v.uuid,
      udp_fragment: true,
    };

    if (v.flow && !v.transport) {
      out.flow = v.flow;
    }
    if (v.packetEncoding) {
      out.packet_encoding = v.packetEncoding;
    }

    if (v.tlsEnabled) {
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: v.serverName || node.server,
      };
      if (v.insecure) {
        tls.insecure = true;
      }
      if (v.alpn && v.alpn.length > 0) {
        tls.alpn = v.alpn;
      }
      if (v.fingerprint || v.reality) {
        tls.utls = {
          enabled: true,
          fingerprint: v.fingerprint || "chrome",
        };
      }
      if (v.reality) {
        tls.reality = {
          enabled: true,
          public_key: v.reality.publicKey,
          short_id: v.reality.shortId,
        };
      }
      out.tls = tls;
    }

    const transport = buildSingBoxTransport(v.transport);
    if (transport) {
      out.transport = transport;
    }
    return out;
  }

  if (node.protocol === "hysteria2" && node.hysteria2) {
    const h = node.hysteria2;
    const out: Record<string, unknown> = {
      type: "hysteria2",
      tag: node.tag,
      server: node.server,
      password: h.password,
      udp_fragment: true,
    };

    if (h.serverPorts && h.serverPorts.length > 0) {
      out.server_ports = h.serverPorts;
      out.hop_interval = h.hopInterval || "30s";
    } else {
      out.server_port = node.serverPort;
    }

    // Hysteria2 拥塞控制：节点链接自带带宽优先，否则用全局默认带宽；两者都无效时走 BBR
    const cc = resolveHy2CongestionControl(
      node,
      defaultBrutalDownMbps,
      defaultBrutalUpMbps,
    );
    if (cc.mode === "brutal") {
      out.down_mbps = cc.downMbps;
      out.up_mbps = cc.upMbps;
    }

    if (h.obfsPassword !== undefined && h.obfsPassword !== "") {
      out.obfs = {
        type: "salamander",
        password: h.obfsPassword,
      };
    }

    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: h.sni || node.server,
    };
    if (h.insecure) {
      tls.insecure = true;
    }
    if (h.alpn && h.alpn.length > 0) {
      tls.alpn = h.alpn;
    }
    out.tls = tls;
    return out;
  }

  if (node.protocol === "shadowsocks" && node.shadowsocks) {
    const s = node.shadowsocks;
    const out: Record<string, unknown> = {
      type: "shadowsocks",
      tag: node.tag,
      server: node.server,
      server_port: node.serverPort,
      method: s.method,
      password: s.password,
      udp_fragment: true,
    };
    if (s.plugin) {
      out.plugin = s.plugin;
      if (s.pluginOpts) {
        out.plugin_opts = s.pluginOpts;
      }
    }
    return out;
  }

  if (node.protocol === "trojan" && node.trojan) {
    const t = node.trojan;
    const out: Record<string, unknown> = {
      type: "trojan",
      tag: node.tag,
      server: node.server,
      server_port: node.serverPort,
      password: t.password,
      udp_fragment: true,
    };

    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: t.sni || node.server,
    };
    if (t.insecure) {
      tls.insecure = true;
    }
    if (t.alpn && t.alpn.length > 0) {
      tls.alpn = t.alpn;
    }
    if (t.fingerprint) {
      tls.utls = {
        enabled: true,
        fingerprint: t.fingerprint,
      };
    }
    out.tls = tls;

    const transport = buildSingBoxTransport(t.transport);
    if (transport) {
      out.transport = transport;
    }
    return out;
  }

  return {
    type: "direct",
    tag: node.tag,
  };
}

/**
 * 将持久化选中的稳定节点 ID（或内置 "auto"/"direct"）解析为 sing-box / Clash selector 的内部 outbound tag
 */
export function resolveSelectedOutboundTag(
  nodes: ProxyNode[],
  selectedOutbound: string,
): string {
  const normalizedNodes = ensureUniqueTags(omitUnsupportedCertPinNodes(nodes));
  if (normalizedNodes.length === 0) return "direct";
  if (selectedOutbound === "auto" || selectedOutbound === "direct") {
    return selectedOutbound;
  }
  const matched = normalizedNodes.find(
    (n) => n.id === selectedOutbound || n.tag === selectedOutbound,
  );
  return matched ? matched.tag : "auto";
}

/**
 * 严格遵循 sing-box v1.14+ 规范合成完整极速版 `running-config.json`
 */
export function buildSingBoxConfig(input: BuildSingBoxConfigInput): Record<string, unknown> {
  const mixedPort = input.mixedPort ?? 7890;
  const clashApiPort = input.clashApiPort ?? 9090;
  const brutalDown = input.brutalDownMbps ?? 800;
  const brutalUp = input.brutalUpMbps ?? 100;

  const normalizedNodes = ensureUniqueTags(
    omitUnsupportedCertPinNodes(input.nodes),
  );
  const nodeTags = normalizedNodes.map((n) => n.tag);
  const nodeOutbounds = normalizedNodes.map((n) =>
    nodeToSingBoxOutbound(n, brutalDown, brutalUp),
  );

  const selectorCandidates =
    nodeTags.length > 0 ? ["auto", ...nodeTags, "direct"] : ["direct"];
  const resolvedTag = resolveSelectedOutboundTag(
    normalizedNodes,
    input.selectedOutbound,
  );
  const effectiveDefault = selectorCandidates.includes(resolvedTag)
    ? resolvedTag
    : selectorCandidates[0];

  const outbounds: Record<string, unknown>[] = [
    {
      type: "selector",
      tag: "proxy",
      outbounds: selectorCandidates,
      default: effectiveDefault,
      interrupt_exist_connections: true,
    },
  ];

  if (nodeTags.length > 0) {
    // 45s 高频轻量保活，防止家用光猫/运营商 CGNAT 回收 UDP 洞口导致跨洋 QUIC 重新握手卡顿
    outbounds.push({
      type: "urltest",
      tag: "auto",
      outbounds: nodeTags,
      url: "https://www.gstatic.com/generate_204",
      interval: "45s",
      tolerance: 50,
      idle_timeout: "30m",
    });
  }

  outbounds.push(...nodeOutbounds);
  outbounds.push({
    type: "direct",
    tag: "direct",
  });

  // 入站：固定本地 Mixed 端口 + 按需动态注入 LayTun 虚拟网卡
  const inbounds: Record<string, unknown>[] = [
    {
      type: "mixed",
      tag: "mixed-in",
      listen: "127.0.0.1",
      listen_port: mixedPort,
    },
  ];

  if (input.tunMode) {
    inbounds.push({
      type: "tun",
      tag: "tun-in",
      interface_name: "LayTun",
      address: ["198.18.0.1/30", "fdfe:dcba:9876::1/126"],
      mtu: 1500,
      auto_route: true,
      strict_route: true,
      stack: "system",
      route_exclude_address: [
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "fc00::/7",
        "fe80::/10",
        "::1/128",
      ],
    });
  }

  // 解析用户自定义黑白名单（支持域名后缀、精确域名、关键词、IPv4/IPv6 CIDR 与 .exe 进程）
  const forceProxy = parseCustomRuleLines(input.forceProxyText);
  const forceDirect = parseCustomRuleLines(input.forceDirectText);
  const aiSuiteProxyEnabled = input.aiSuiteProxyEnabled ?? true;

  const forceDirectDomainMatcher = buildDomainMatcherFields(forceDirect);
  const forceProxyDomainMatcher = buildDomainMatcherFields(forceProxy);

  // 多层防污染 DNS 规则（sing-box v1.14+ 标准格式）：
  // 1) 本机 hosts 内存 0ms 优先命中（让系统代理 / TUN 下 Windows hosts 均生效）
  // 2) 私有/局域网域名走系统本地 DNS，不泄露到公网 223.5.5.5 / 1.1.1.1
  // 3) 已知国内 / 海外 / 自定义 / AI 域名直达对应上游
  // 4) 未知尾部域名：经国内 DNS 探测（1.5s 超时防断网），仅当返回 IP 命中 geoip-cn 时采纳，否则丢弃防污染回退至 dns-remote
  const dnsRules: Record<string, unknown>[] = [
    {
      action: "evaluate",
      server: "dns-hosts",
      tag: "hosts-check",
    },
    {
      match_response: "hosts-check",
      response_rcode: "NOERROR",
      action: "respond",
    },
    {
      domain_suffix: PRIVATE_LOCAL_SUFFIXES,
      server: "dns-local",
    },
    {
      rule_set: "geosite-private",
      server: "dns-local",
    },
    {
      clash_mode: "direct",
      server: "dns-direct",
    },
    {
      clash_mode: "global",
      server: "dns-remote",
    },
  ];

  if (forceDirectDomainMatcher) {
    dnsRules.push({
      ...forceDirectDomainMatcher,
      server: "dns-direct",
    });
  }
  if (forceProxyDomainMatcher) {
    dnsRules.push({
      ...forceProxyDomainMatcher,
      server: "dns-remote",
    });
  }
  if (aiSuiteProxyEnabled) {
    dnsRules.push({
      domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
      server: "dns-remote",
    });
  }
  dnsRules.push({
    rule_set: "geosite-cn",
    server: "dns-direct",
  });
  dnsRules.push({
    rule_set: "geosite-geolocation-!cn",
    server: "dns-remote",
  });
  dnsRules.push({
    action: "evaluate",
    server: "dns-direct",
    tag: "cn-probe",
    timeout: "1.5s",
  });
  dnsRules.push({
    match_response: "cn-probe",
    rule_set: "geoip-cn",
    action: "respond",
  });

  // 路由规则合成：100ms 极速嗅探 + 本地/内网经 hosts/local 解析后绝对直连
  const routeRules: Record<string, unknown>[] = [
    {
      action: "sniff",
      timeout: "100ms",
    },
    {
      protocol: "dns",
      action: "hijack-dns",
    },
    {
      domain_suffix: PRIVATE_LOCAL_SUFFIXES,
      action: "resolve",
    },
    {
      rule_set: "geosite-private",
      action: "resolve",
    },
    {
      domain_suffix: PRIVATE_LOCAL_SUFFIXES,
      outbound: "direct",
    },
    {
      rule_set: "geosite-private",
      outbound: "direct",
    },
    {
      ip_is_private: true,
      outbound: "direct",
    },
    {
      clash_mode: "direct",
      outbound: "direct",
    },
    // TUN 全局代理模式：拦截 UDP 443 HTTP/3 (QUIC)，防止 QUIC-in-QUIC 套娃（直连模式不受影响）
    ...(input.tunMode
      ? [
          {
            clash_mode: "global",
            protocol: "quic",
            port: 443,
            action: "reject",
          },
        ]
      : []),
    {
      clash_mode: "global",
      outbound: "proxy",
    },
  ];

  // 用户自定义：强制直连置顶（冲突时始终优先于强制代理与内置规则）
  if (forceDirect.processNames.length > 0) {
    routeRules.push({
      process_name: forceDirect.processNames,
      outbound: "direct",
    });
  }
  if (forceDirectDomainMatcher) {
    routeRules.push({
      ...forceDirectDomainMatcher,
      outbound: "direct",
    });
  }
  if (forceDirect.ipCidrs.length > 0) {
    routeRules.push({
      ip_cidr: forceDirect.ipCidrs,
      outbound: "direct",
    });
  }

  // TUN 规则分流模式：仅拦截非国内目标的 UDP 443 HTTP/3 (QUIC)，国内直连站点与强制直连流量保留完整 QUIC
  if (input.tunMode) {
    routeRules.push({
      type: "logical",
      mode: "and",
      rules: [
        {
          protocol: "quic",
          port: 443,
        },
        {
          rule_set: ["geosite-cn", "geoip-cn"],
          invert: true,
        },
      ],
      action: "reject",
    });
  }

  // 用户自定义：强制代理置顶
  if (forceProxy.processNames.length > 0) {
    routeRules.push({
      process_name: forceProxy.processNames,
      outbound: "proxy",
    });
  }
  if (forceProxyDomainMatcher) {
    routeRules.push({
      ...forceProxyDomainMatcher,
      outbound: "proxy",
    });
  }
  if (forceProxy.ipCidrs.length > 0) {
    routeRules.push({
      ip_cidr: forceProxy.ipCidrs,
      outbound: "proxy",
    });
  }

  // 可开关内置保护：Antigravity / Cursor / Grok / ChatGPT / Claude 进程与服务域名强制代理（位于 geosite-cn 之上）
  if (aiSuiteProxyEnabled) {
    routeRules.push({
      process_name: AI_SUITE_FORCE_PROXY_PROCESSES,
      outbound: "proxy",
    });
    routeRules.push({
      domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
      outbound: "proxy",
    });
  }

  // 四级极速精准分流流水线：
  // 1) 国内主流域名内存直中 -> 0ms 直连
  // 2) 海外主流域名内存直中 -> 0ms 透传域名直发远端代理（零本地 DNS 阻塞，完整保留节点远端解锁）
  // 3) 纯国内 IP 直中 -> 0ms 直连
  // 4) 未收录尾部未知域名 -> 显式 resolve（hosts -> 国内探测 geoip-cn -> 防污染回退 1.1.1.1），
  //    命中内网 IP / 自定义 CIDR / geoip-cn 走直连，其余走 final: "proxy"
  routeRules.push({
    rule_set: "geosite-cn",
    outbound: "direct",
  });
  routeRules.push({
    rule_set: "geosite-geolocation-!cn",
    outbound: "proxy",
  });
  routeRules.push({
    rule_set: "geoip-cn",
    outbound: "direct",
  });
  routeRules.push({
    action: "resolve",
  });
  routeRules.push({
    ip_is_private: true,
    outbound: "direct",
  });
  if (forceDirect.ipCidrs.length > 0) {
    routeRules.push({
      ip_cidr: forceDirect.ipCidrs,
      outbound: "direct",
    });
  }
  if (forceProxy.ipCidrs.length > 0) {
    routeRules.push({
      ip_cidr: forceProxy.ipCidrs,
      outbound: "proxy",
    });
  }
  routeRules.push({
    rule_set: "geoip-cn",
    outbound: "direct",
  });

  return {
    log: {
      level: "info",
      timestamp: true,
    },
    dns: {
      servers: [
        {
          type: "hosts",
          tag: "dns-hosts",
          predefined: {
            localhost: ["127.0.0.1", "::1"],
          },
        },
        {
          type: "local",
          tag: "dns-local",
          prefer_go: true,
        },
        {
          type: "udp",
          tag: "dns-direct",
          server: "223.5.5.5",
        },
        {
          type: "https",
          tag: "dns-remote",
          server: "1.1.1.1",
          detour: "proxy",
        },
      ],
      rules: dnsRules,
      final: "dns-remote",
      strategy: "prefer_ipv4",
      optimistic: true,
    },
    inbounds,
    outbounds,
    route: {
      auto_detect_interface: true,
      default_domain_resolver: "dns-direct",
      rules: routeRules,
      rule_set: [
        {
          type: "remote",
          tag: "geosite-private",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-private.srs",
          download_detour: "proxy",
          update_interval: "3d",
        },
        {
          type: "remote",
          tag: "geosite-cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
          download_detour: "proxy",
          update_interval: "3d",
        },
        {
          type: "remote",
          tag: "geosite-geolocation-!cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs",
          download_detour: "proxy",
          update_interval: "3d",
        },
        {
          type: "remote",
          tag: "geoip-cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
          download_detour: "proxy",
          update_interval: "3d",
        },
      ],
      final: "proxy",
    },
    experimental: {
      cache_file: {
        enabled: true,
        path: "cache.db",
      },
      clash_api: {
        external_controller: `127.0.0.1:${clashApiPort}`,
        default_mode: input.routingMode,
      },
    },
  };
}
