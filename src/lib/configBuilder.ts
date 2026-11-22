import type {
  NodeTransportConfig,
  ProxyNode,
  RoutingMode,
} from "../types/proxy";
import { ensureUniqueTags, omitUnsupportedCertPinNodes } from "./uriParser";

export interface ParsedCustomRuleGroup {
  domainSuffixes: string[];
  processNames: string[];
}

/**
 * 内置五大 AI 套件（Antigravity / Cursor / Grok / ChatGPT & Codex / Claude）全服务强制代理清单：
 * - 进程规则位于 `ip_is_private -> direct` 之后，确保 IDE 本地 127.0.0.1 / localhost 通信直连不白屏，
 *   同时确保所有外网 API、认证、补全、自动更新进程 100% 强制走代理节点。
 * - 域名规则置顶于 `geosite-cn` / `geoip-cn` 与 `dns-direct` 之前，彻底杜绝 Google/Cloudflare/AI CDN
 *   被国内规则集误判直连或被国内 DNS 污染导致登录、风控校验或自动更新失败。
 */
export const AI_SUITE_FORCE_PROXY_PROCESSES = [
  // Antigravity (Google)
  "Antigravity.exe",
  "language_server.exe",
  "elevate.exe",
  "AntigravitySetup.exe",
  // Cursor
  "Cursor.exe",
  "cursor.exe",
  "cursor-agent.exe",
  "inno_updater.exe",
  "CursorSetup.exe",
  // Grok (xAI)
  "grok.exe",
  "Grok.exe",
  "grok-windows-x86_64.exe",
  "Grok Bot.exe",
  "GrokBot.exe",
  "agent.exe",
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
  // 登录人机校验、GitHub OAuth 与 IDE 插件市场（确保登录与验证 IP 与代理节点 100% 同源）
  "recaptcha.net",
  "hcaptcha.com",
  "challenges.cloudflare.com",
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
  "open-vsx.org",
  "visualstudio.com",
  "vsassets.io",
];

export interface BuildSingBoxConfigInput {
  nodes: ProxyNode[];
  selectedOutbound: string;
  routingMode: RoutingMode;
  tunMode: boolean;
  forceProxyText: string;
  forceDirectText: string;
  brutalDownMbps?: number;
  brutalUpMbps?: number;
  mixedPort?: number;
  clashApiPort?: number;
}

/**
 * 解析多行自定义规则文本：
 * - 以 `.exe` 结尾（忽略大小写，支持完整路径提取文件名）-> `process_name`
 * - 其余识别为域名后缀（自动剥离 URL 协议头、前导 `*.` 或 `.`）-> `domain_suffix`
 */
export function parseCustomRuleLines(text: string): ParsedCustomRuleGroup {
  const domainSet = new Set<string>();
  const processSet = new Set<string>();

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  for (const raw of lines) {
    if (/\.exe$/i.test(raw)) {
      const parts = raw.split(/[\\/]/);
      const exeName = parts[parts.length - 1]?.trim();
      if (exeName) {
        processSet.add(exeName);
      }
      continue;
    }

    let cleaned = raw.replace(/^[a-zA-Z]+:\/\//, "");
    cleaned = cleaned.split("/")[0]?.split(":")[0] ?? "";
    cleaned = cleaned.replace(/^\*\./, "").replace(/^\./, "").trim().toLowerCase();
    if (cleaned && !cleaned.includes(" ")) {
      domainSet.add(cleaned);
    }
  }

  return {
    domainSuffixes: Array.from(domainSet),
    processNames: Array.from(processSet),
  };
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

  // 解析用户自定义黑白名单
  const forceProxy = parseCustomRuleLines(input.forceProxyText);
  const forceDirect = parseCustomRuleLines(input.forceDirectText);

  // 双路防污染 DNS 规则（sing-box v1.14+ 带 type 标准格式）
  const dnsRules: Record<string, unknown>[] = [
    {
      clash_mode: "direct",
      server: "dns-direct",
    },
    {
      clash_mode: "global",
      server: "dns-remote",
    },
  ];

  if (forceDirect.domainSuffixes.length > 0) {
    dnsRules.push({
      domain_suffix: forceDirect.domainSuffixes,
      server: "dns-direct",
    });
  }
  if (forceProxy.domainSuffixes.length > 0) {
    dnsRules.push({
      domain_suffix: forceProxy.domainSuffixes,
      server: "dns-remote",
    });
  }
  // 置顶于 geosite-cn 之前：五大 AI 套件全部域名强制走代理 DoH 解析，杜绝 DNS 污染或解析至受阻节点
  dnsRules.push({
    domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
    server: "dns-remote",
  });
  dnsRules.push({
    rule_set: "geosite-cn",
    server: "dns-direct",
  });
  dnsRules.push({
    rule_set: "geosite-geolocation-!cn",
    server: "dns-remote",
  });

  // 路由规则合成：100ms 极速嗅探 + 本地回环绝对直连（保障 Antigravity Hub 与 OAuth 本地回调永不中断）
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
      domain: ["localhost"],
      domain_suffix: ["localhost", "local"],
      outbound: "direct",
    },
    {
      ip_is_private: true,
      outbound: "direct",
    },
    // TUN 模式下拦截浏览器 HTTP/3 (QUIC)，杜绝 QUIC-in-QUIC 套娃抖动，让浏览器 0ms 切回 HTTP/2 走 Hysteria2 Brutal
    ...(input.tunMode
      ? [
          {
            protocol: "quic",
            action: "reject",
          },
        ]
      : []),
    {
      clash_mode: "direct",
      outbound: "direct",
    },
    {
      clash_mode: "global",
      outbound: "proxy",
    },
  ];

  // 用户自定义：强制直连置顶
  if (forceDirect.processNames.length > 0) {
    routeRules.push({
      process_name: forceDirect.processNames,
      outbound: "direct",
    });
  }
  if (forceDirect.domainSuffixes.length > 0) {
    routeRules.push({
      domain_suffix: forceDirect.domainSuffixes,
      outbound: "direct",
    });
  }

  // 用户自定义：强制代理置顶
  if (forceProxy.processNames.length > 0) {
    routeRules.push({
      process_name: forceProxy.processNames,
      outbound: "proxy",
    });
  }
  if (forceProxy.domainSuffixes.length > 0) {
    routeRules.push({
      domain_suffix: forceProxy.domainSuffixes,
      outbound: "proxy",
    });
  }

  // 内置保护：Antigravity / Cursor / Grok / ChatGPT / Claude 全进程与全服务域名强制走代理（位于 geosite-cn 之上）
  routeRules.push({
    process_name: AI_SUITE_FORCE_PROXY_PROCESSES,
    outbound: "proxy",
  });
  routeRules.push({
    domain_suffix: AI_SUITE_FORCE_PROXY_DOMAINS,
    outbound: "proxy",
  });

  // 三级极速分流流水线：
  // 1) 国内域名内存直中 -> 0ms 直连
  // 2) 海外主流域名内存直中 -> 0ms 跳过本地 geoip-cn DNS 查询直发远端代理（砍掉 200~380ms 首包阻塞！）
  // 3) 纯 IP / 未知域名 -> geoip-cn 判定国内直连，其余走 final: "proxy"
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

  return {
    log: {
      level: "info",
      timestamp: true,
    },
    dns: {
      servers: [
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
          tag: "geosite-cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
          download_detour: "proxy",
        },
        {
          type: "remote",
          tag: "geosite-geolocation-!cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs",
          download_detour: "proxy",
        },
        {
          type: "remote",
          tag: "geoip-cn",
          format: "binary",
          url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
          download_detour: "proxy",
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
