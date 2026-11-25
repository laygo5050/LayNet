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
 * - 域名规则位于 `geosite-cn` 之上（防止带 `@cn` 标记的登录/更新 CDN 被误判直连掉登录）；
 * - 进程规则采用不区分大小写的 `process_path_regex` 并置于 `geosite-cn` / `geoip-cn` 之后，确保 IDE 内调用国内大模型 API、国内镜像源与国内公网机 0ms 直连，同时未知海外接口自动走代理。
 */
export const AI_SUITE_FORCE_PROXY_PROCESSES = [
  // Antigravity (Google)
  "Antigravity.exe",
  "AntigravitySetup.exe",
  // Cursor
  "Cursor.exe",
  "cursor-agent.exe",
  "CursorSetup.exe",
  // Grok (xAI)
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
  "claude-code.exe",
];

export const AI_SUITE_FORCE_PROXY_DOMAINS = [
  // Antigravity & Google AI / OAuth2 登录 / 自动更新 CDN（防止被 geosite-cn 误判直连导致更新掉登录）
  "antigravity.google",
  "ai.google",
  "labs.google",
  "notebooklm.google",
  "deepmind.google",
  "deepmind.com",
  "googleapis.com",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "ggpht.com",
  "gvt1.com",
  "gvt2.com",
  "gvt3.com",
  "withgoogle.com",
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
  "grok-sandbox.com",
  "grokusercontent.com",
  "x.ai",
  "xai.com",
  "x.com",
  "twitter.com",
  "twimg.com",
  "t.co",
  // ChatGPT / OpenAI / Codex / Sora / 实时语音 WebRTC & 登录认证
  "openai.com",
  "chatgpt.com",
  "chat.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "sora.com",
  "livekit.cloud",
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
  // Microsoft Copilot（防止被 geosite-cn 中的 bing.com @cn 误判直连锁区）
  "copilot.microsoft.com",
  "sydney.bing.com",
  "edgeservices.bing.com",
  // 登录人机校验、GitHub / Copilot 与 IDE 插件市场（精准限定扩展市场子域，不误伤企业 Azure DevOps）
  "recaptcha.net",
  "hcaptcha.com",
  "challenges.cloudflare.com",
  "github.com",
  "githubcopilot.com",
  "githubusercontent.com",
  "githubassets.com",
  "github.io",
  "ghcr.io",
  "github.dev",
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
  dnsLeakProtection?: boolean;
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
    /^[a-z0-9._-]+$/i.test(token) &&
    /[a-z0-9]/i.test(token) &&
    !token.startsWith("-") &&
    !token.endsWith("-") &&
    !token.includes("..")
  );
}

/**
 * 将 Windows 进程文件名列表转换为 sing-box v1.14+ 不区分大小写的 `process_path_regex`，
 * 解决原生 `process_name` 大小写敏感导致用户输入 `wechat.exe` 无法匹配 `WeChat.exe` 的痛点。
 */
export function buildProcessPathRegexes(processNames: string[]): string[] {
  const seen = new Set<string>();
  const regexes: string[] = [];
  for (const raw of processNames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regexes.push(`(?i)(^|[\\\\/])${escaped}$`);
  }
  return regexes;
}

/**
 * 解析多行自定义规则文本：
 * - 兼容 Clash 逗号规则（`DOMAIN-SUFFIX,xxx`、`DOMAIN,xxx`、`DOMAIN-KEYWORD,xxx`、`IP-CIDR,xxx`、`PROCESS-NAME,xxx`）
 * - 以 `.exe` 结尾（支持完整路径提取文件名）或 `process:` 前缀 -> `processNames`（按大小写不敏感去重）
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
  const processList: string[] = [];
  const seenProcessLower = new Set<string>();

  const addProcess = (rawProc: string) => {
    const parts = rawProc.split(/[\\/]/);
    const procName = parts[parts.length - 1]?.trim();
    if (!procName) return;
    const lower = procName.toLowerCase();
    if (seenProcessLower.has(lower)) return;
    seenProcessLower.add(lower);
    processList.push(procName);
  };

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  for (const raw of lines) {
    // 兼容 Clash 风格逗号规则，如 DOMAIN-SUFFIX,openai.com,Proxy 或 IP-CIDR,1.1.1.1/32,no-resolve
    const clashMatch = raw.match(
      /^(DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN|IP-CIDR6|IP-CIDR|PROCESS-NAME|DST-PORT|SRC-PORT|GEOIP|GEOSITE|MATCH)\s*,\s*([^,]*)(?:,.*)?$/i,
    );
    if (clashMatch) {
      const cKind = clashMatch[1]!.toUpperCase();
      const cBody = clashMatch[2]!.trim();
      if (!cBody) continue;
      if (cKind === "PROCESS-NAME") {
        addProcess(cBody);
      } else if (cKind === "IP-CIDR" || cKind === "IP-CIDR6") {
        const cidr = parseIpOrCidr(cBody);
        if (cidr && cidr !== "invalid") ipCidrSet.add(cidr);
      } else if (cKind === "DOMAIN-KEYWORD") {
        const kw = cBody.toLowerCase();
        if (kw && !kw.includes(" ") && !kw.includes(",")) domainKeywordSet.add(kw);
      } else if (cKind === "DOMAIN") {
        const dom = normalizeDomainToken(cBody);
        if (isValidDomainToken(dom)) exactDomainSet.add(dom);
      } else if (cKind === "DOMAIN-SUFFIX") {
        const dom = normalizeDomainToken(cBody);
        if (isValidDomainToken(dom)) domainSuffixSet.add(dom);
      }
      // 其余不支持的 Clash 规则类型（如 DST-PORT/MATCH）安全忽略，绝不误当作域名后缀
      continue;
    }

    const prefixMatch = raw.match(
      /^(full|domain|suffix|domain_suffix|keyword|domain_keyword|ip|cidr|ip-cidr|ip_cidr|process):(.+)$/i,
    );
    if (prefixMatch) {
      const kind = prefixMatch[1]!.toLowerCase();
      const body = prefixMatch[2]!.trim();
      if (!body) continue;

      if (kind === "process") {
        addProcess(body);
        continue;
      }
      if (kind === "ip" || kind === "cidr" || kind === "ip-cidr" || kind === "ip_cidr") {
        const cidr = parseIpOrCidr(body);
        if (cidr && cidr !== "invalid") ipCidrSet.add(cidr);
        continue;
      }
      if (kind === "keyword" || kind === "domain_keyword") {
        const kw = body.toLowerCase();
        if (kw && !kw.includes(" ") && !kw.includes(",")) domainKeywordSet.add(kw);
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
      addProcess(raw);
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
    processNames: processList,
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

  if (transport.type === "httpupgrade") {
    const out: Record<string, unknown> = {
      type: "httpupgrade",
      path: transport.path || "/",
    };
    if (transport.host) {
      out.host = transport.host;
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
  defaultBrutalDownMbps = 0,
  defaultBrutalUpMbps = 0,
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

function isRoutableAutoCandidate(server: string): boolean {
  const h = server.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (!h || h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") {
    return false;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return false;
  }
  return true;
}

/**
 * 严格遵循 sing-box v1.14+ 规范合成完整极速版 `running-config.json`
 */
export function buildSingBoxConfig(input: BuildSingBoxConfigInput): Record<string, unknown> {
  const mixedPort = input.mixedPort ?? 7890;
  const clashApiPort = input.clashApiPort ?? 9090;
  const brutalDown = input.brutalDownMbps ?? 0;
  const brutalUp = input.brutalUpMbps ?? 0;

  const normalizedNodes = ensureUniqueTags(
    omitUnsupportedCertPinNodes(input.nodes),
  );
  const nodeTags = normalizedNodes.map((n) => n.tag);
  const routableAutoTags = normalizedNodes
    .filter((n) => isRoutableAutoCandidate(n.server))
    .map((n) => n.tag);
  const autoCandidateTags =
    routableAutoTags.length > 0 ? routableAutoTags : nodeTags;
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

  if (autoCandidateTags.length > 0) {
    // 3m 低扰动自动择优，剔除机场顶部 127.0.0.1/0.0.0.0 等流量提示假节点，避免周期性高并发探测制造跳 Ping
    outbounds.push({
      type: "urltest",
      tag: "auto",
      outbounds: autoCandidateTags,
      url: "https://www.gstatic.com/generate_204",
      interval: "3m",
      tolerance: 50,
      idle_timeout: "30m",
    });
  }

  outbounds.push(...nodeOutbounds);
  outbounds.push({
    type: "direct",
    tag: "direct",
  });

  // 入站：固定本地 Mixed 端口 + 按需动态注入 LayTun 虚拟网卡（MTU 1480 适配国内 PPPoE 1492 防分片/黑洞）
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
      mtu: 1480,
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

  // 解析用户自定义黑白名单（支持 Clash 规则、域名后缀、精确域名、关键词、IPv4/IPv6 CIDR 与大小写不敏感 .exe 进程）
  const forceProxy = parseCustomRuleLines(input.forceProxyText);
  const forceDirect = parseCustomRuleLines(input.forceDirectText);
  const aiSuiteProxyEnabled = input.aiSuiteProxyEnabled ?? true;
  const dnsLeakProtection = input.dnsLeakProtection ?? true;

  const forceDirectDomainMatcher = buildDomainMatcherFields(forceDirect);
  const forceProxyDomainMatcher = buildDomainMatcherFields(forceProxy);
  const forceDirectProcessRegexes = buildProcessPathRegexes(forceDirect.processNames);
  const forceProxyProcessRegexes = buildProcessPathRegexes(forceProxy.processNames);
  const aiSuiteProcessRegexes = buildProcessPathRegexes(AI_SUITE_FORCE_PROXY_PROCESSES);

  // 多层防污染 DNS 规则（sing-box v1.14+ 标准格式）：
  // 1) 本机 hosts 内存 0ms 优先命中
  // 2) 私有/局域网域名走系统本地 DNS，不泄露到公网
  // 3) 全局直连 / 用户「强制直连」始终优先走国内 DNS（即使切到全局代理模式也尊重强制直连白名单）
  // 4) 用户「强制代理」与 AI 核心域名直达远程防污染 DoH
  // 5) 国内主流域名走 dns-direct，海外主流域名与 AI 进程兜底走 dns-remote
  // 6) DNS 防泄露开启时（默认）：未知尾部域名不向国内 DNS 探测，直接走 dns-remote（方案 A）；关闭时启用 500ms cn-probe 国内探测
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
  ];

  if (forceDirectProcessRegexes.length > 0) {
    dnsRules.push({
      process_path_regex: forceDirectProcessRegexes,
      server: "dns-direct",
    });
  }
  if (forceDirectDomainMatcher) {
    dnsRules.push({
      ...forceDirectDomainMatcher,
      server: "dns-direct",
    });
  }

  dnsRules.push({
    clash_mode: "global",
    server: "dns-remote",
  });

  if (forceProxyProcessRegexes.length > 0) {
    dnsRules.push({
      process_path_regex: forceProxyProcessRegexes,
      server: "dns-remote",
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
  if (aiSuiteProxyEnabled && aiSuiteProcessRegexes.length > 0) {
    dnsRules.push({
      process_path_regex: aiSuiteProcessRegexes,
      server: "dns-remote",
    });
  }
  if (!dnsLeakProtection) {
    dnsRules.push({
      action: "evaluate",
      server: "dns-direct",
      tag: "cn-probe",
      timeout: "500ms",
    });
    dnsRules.push({
      match_response: "cn-probe",
      rule_set: "geoip-cn",
      action: "respond",
    });
  }

  // 路由规则合成：30ms 本机极速嗅探 + 回环死锁保护 + 强制直连超越全局代理 + 国内/海外精准分流
  const routeRules: Record<string, unknown>[] = [
    {
      action: "sniff",
      timeout: "30ms",
    },
    {
      protocol: "dns",
      action: "hijack-dns",
    },
    {
      ip_cidr: ["127.0.0.0/8", "::1/128"],
      outbound: "direct",
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
      clash_mode: "direct",
      outbound: "direct",
    },
  ];

  // 用户自定义：强制直连置顶（冲突时高于强制代理，且在 Global 全局代理模式下依然保护网银/内网/微信直连）
  if (forceDirectProcessRegexes.length > 0) {
    routeRules.push({
      process_path_regex: forceDirectProcessRegexes,
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

  // 用户自定义显式代理网段（如异地组网 10.8.0.0/16）优先于通用 ip_is_private，其余局域网私网段一律直连
  if (forceProxy.ipCidrs.length > 0) {
    if (input.tunMode) {
      routeRules.push({
        ip_cidr: forceProxy.ipCidrs,
        protocol: "quic",
        port: 443,
        action: "reject",
      });
    }
    routeRules.push({
      ip_cidr: forceProxy.ipCidrs,
      outbound: "proxy",
    });
  }
  routeRules.push({
    ip_is_private: true,
    outbound: "direct",
  });

  // 全局代理模式（已保护回环、局域网与用户强制直连白名单）
  if (input.tunMode) {
    routeRules.push({
      clash_mode: "global",
      protocol: "quic",
      port: 443,
      action: "reject",
    });
  }
  routeRules.push({
    clash_mode: "global",
    outbound: "proxy",
  });

  // 用户自定义：强制代理（含 TUN 下对应流量的 QUIC 防套娃拦截）
  if (forceProxyProcessRegexes.length > 0) {
    if (input.tunMode) {
      routeRules.push({
        process_path_regex: forceProxyProcessRegexes,
        protocol: "quic",
        port: 443,
        action: "reject",
      });
    }
    routeRules.push({
      process_path_regex: forceProxyProcessRegexes,
      outbound: "proxy",
    });
  }
  if (forceProxyDomainMatcher) {
    if (input.tunMode) {
      routeRules.push({
        ...forceProxyDomainMatcher,
        protocol: "quic",
        port: 443,
        action: "reject",
      });
    }
    routeRules.push({
      ...forceProxyDomainMatcher,
      outbound: "proxy",
    });
  }

  // 内置 AI 核心服务域名优先走代理（位于 geosite-cn 之上，防止带 @cn 标记的认证/CDN 掉登录）
  if (aiSuiteProxyEnabled) {
    if (input.tunMode) {
      routeRules.push({
        domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
        protocol: "quic",
        port: 443,
        action: "reject",
      });
    }
    routeRules.push({
      domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
      outbound: "proxy",
    });
  }

  // 五级极速精准分流流水线：
  // 1) 国内主流域名内存直中 -> 0ms 直连（保留国内 B 站/抖音完整 HTTP/3 QUIC）
  // 2) TUN 模式下其余非国内 IP 的 UDP 443 QUIC 统一拒绝，促使海外流量零损耗回退 TCP
  // 3) 海外主流域名内存直中 -> 0ms 透传域名直发远端代理
  // 4) 纯国内 IP 直中 -> 0ms 直连
  // 5) AI 套件进程兜底海外未知域名走代理 + BitTorrent P2P 流量强制直连防封号/防跑流
  // 6) 未收录尾部未知域名 -> 显式 resolve，命中私网 / 国内 IP 走直连，其余走 final: "proxy"
  routeRules.push({
    rule_set: "geosite-cn",
    outbound: "direct",
  });

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

  routeRules.push({
    rule_set: "geosite-geolocation-!cn",
    outbound: "proxy",
  });
  routeRules.push({
    rule_set: "geoip-cn",
    outbound: "direct",
  });

  if (aiSuiteProxyEnabled && aiSuiteProcessRegexes.length > 0) {
    routeRules.push({
      process_path_regex: aiSuiteProcessRegexes,
      outbound: "proxy",
    });
  }

  routeRules.push({
    protocol: "bittorrent",
    outbound: "direct",
  });

  routeRules.push({
    action: "resolve",
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
    ip_is_private: true,
    outbound: "direct",
  });
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
