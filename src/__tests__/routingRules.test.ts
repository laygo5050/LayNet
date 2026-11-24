import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AI_SUITE_FORCE_PROXY_DOMAINS,
  AI_SUITE_FORCE_PROXY_PROCESSES,
  buildProcessPathRegexes,
  buildSingBoxConfig,
  countCustomRules,
  parseCustomRuleLines,
} from "../lib/configBuilder";
import { parseSingleShareUri } from "../lib/uriParser";
import { migratePersistedState } from "../store/useAppStore";

test("parseCustomRuleLines parses domains, prefixes, IPv4/IPv6 CIDR, and processes accurately", () => {
  const parsed = parseCustomRuleLines(`
    # comment line
    // another comment
    openai.com
    *.example.org
    full:api.exact.test
    keyword:corp-internal
    8.8.8.8
    10.8.0.0/16
    2606:4700::1
    2606:4700::/32
    http://192.168.1.50:8080/login
    https://[2001:db8::1]/path
    C:\\Program Files\\Cursor\\Cursor.exe
    process:WeChat.exe
    process:wechat.exe
    - DOMAIN-SUFFIX,claude.ai,Proxy
    DOMAIN,exact.clash.test
    DOMAIN-KEYWORD,clash-kw
    IP-CIDR,1.0.0.1/32,no-resolve
    PROCESS-NAME,Telegram.exe
    DST-PORT,443
    # malformed entries should be silently ignored, never turned into domain_suffix
    999.1.1.1/24
    10.8.0.0/33
    2001:::1/64
    bad domain value
    invalid,comma.domain
  `);

  assert.deepEqual(parsed.domains, ["api.exact.test", "exact.clash.test"]);
  assert.deepEqual(parsed.domainSuffixes, ["openai.com", "example.org", "claude.ai"]);
  assert.deepEqual(parsed.domainKeywords, ["corp-internal", "clash-kw"]);
  assert.deepEqual(parsed.ipCidrs, [
    "8.8.8.8/32",
    "10.8.0.0/16",
    "2606:4700::1/128",
    "2606:4700::/32",
    "192.168.1.50/32",
    "2001:db8::1/128",
    "1.0.0.1/32",
  ]);
  assert.deepEqual(parsed.processNames, ["Cursor.exe", "WeChat.exe", "Telegram.exe"]);
  assert.equal(countCustomRules(parsed), 17);
  assert.deepEqual(buildProcessPathRegexes(["WeChat.exe", "wechat.exe"]), [
    "(?i)(^|[\\\\/])WeChat\\.exe$",
  ]);
});

test("AI suite built-in lists exclude generic collision-prone processes and broad visualstudio.com", () => {
  const lowerProcs = AI_SUITE_FORCE_PROXY_PROCESSES.map((p) => p.toLowerCase());
  assert.ok(!lowerProcs.includes("agent.exe"));
  assert.ok(!lowerProcs.includes("inno_updater.exe"));
  assert.ok(!lowerProcs.includes("elevate.exe"));
  assert.ok(!lowerProcs.includes("language_server.exe"));
  assert.ok(lowerProcs.includes("antigravity.exe"));
  assert.ok(lowerProcs.includes("cursor.exe"));

  assert.ok(!AI_SUITE_FORCE_PROXY_DOMAINS.includes("visualstudio.com"));
  assert.ok(!AI_SUITE_FORCE_PROXY_DOMAINS.includes("vsassets.io"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("marketplace.visualstudio.com"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("gallerycdn.vsassets.io"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("grok-sandbox.com"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("grokusercontent.com"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("githubcopilot.com"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("livekit.cloud"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("copilot.microsoft.com"));
  assert.ok(AI_SUITE_FORCE_PROXY_DOMAINS.includes("ai.google"));
});

test("buildSingBoxConfig wires five-stage pipeline, hosts/local DNS, 500ms cn-probe, case-insensitive process regex, BT direct, and AI split", () => {
  const fakeInfoNode = parseSingleShareUri("trojan://info@127.0.0.1:1080#剩余流量100G")!;
  const node = parseSingleShareUri("trojan://demo@node.example:443#Demo");
  assert.ok(node);

  const cfgEnabled = buildSingBoxConfig({
    nodes: [fakeInfoNode, node],
    selectedOutbound: node.id,
    routingMode: "rule",
    tunMode: false,
    forceProxyText: "custom-proxy.test\n10.20.0.0/16\nfull:only.proxy.test\nTelegram.exe",
    forceDirectText: "custom-direct.test\n10.8.0.0/16\nkeyword:intranet\nWeChat.exe",
    aiSuiteProxyEnabled: true,
  });

  // Loopback fake info node is excluded from urltest auto group while real node remains
  const outbounds = cfgEnabled.outbounds as Array<Record<string, unknown>>;
  const autoGroup = outbounds.find((o) => o.tag === "auto")!;
  assert.deepEqual(autoGroup.outbounds, [node.tag]);
  assert.equal(autoGroup.interval, "3m");

  const dns = cfgEnabled.dns as {
    servers: Array<Record<string, unknown>>;
    rules: Array<Record<string, unknown>>;
    final: string;
    optimistic: boolean;
  };
  const route = cfgEnabled.route as {
    default_domain_resolver: string;
    auto_detect_interface: boolean;
    rules: Array<Record<string, unknown>>;
    rule_set: Array<Record<string, unknown>>;
    final: string;
  };

  assert.equal(dns.final, "dns-remote");
  assert.equal(dns.optimistic, true);
  assert.deepEqual(
    dns.servers.map((s) => s.tag),
    ["dns-hosts", "dns-local", "dns-direct", "dns-remote"],
  );
  assert.equal(route.default_domain_resolver, "dns-direct");
  assert.equal(route.auto_detect_interface, true);
  assert.equal(route.final, "proxy");
  assert.equal(route.rules[0]?.action, "sniff");
  assert.equal(route.rules[0]?.timeout, "30ms");

  // DNS rules: hosts-check -> forceDirect (including process regex) -> global -> forceProxy -> AI domains -> geosite-cn -> !cn -> AI process -> 500ms cn-probe
  assert.equal(dns.rules[0]?.action, "evaluate");
  assert.equal(dns.rules[0]?.server, "dns-hosts");
  assert.equal(dns.rules[1]?.match_response, "hosts-check");
  assert.equal(dns.rules[1]?.response_rcode, "NOERROR");

  const dnsIdxForceDirectProc = dns.rules.findIndex(
    (r) =>
      Array.isArray(r.process_path_regex) &&
      r.process_path_regex.some((p: string) => p.includes("WeChat")),
  );
  const dnsIdxGlobal = dns.rules.findIndex((r) => r.clash_mode === "global");
  const cnProbeIdx = dns.rules.findIndex((r) => r.tag === "cn-probe");
  assert.ok(dnsIdxForceDirectProc > 0);
  assert.ok(dnsIdxForceDirectProc < dnsIdxGlobal);
  assert.ok(cnProbeIdx > dnsIdxGlobal);
  assert.equal(dns.rules[cnProbeIdx]?.server, "dns-direct");
  assert.equal(dns.rules[cnProbeIdx]?.timeout, "500ms");
  assert.equal(dns.rules[cnProbeIdx + 1]?.match_response, "cn-probe");
  assert.equal(dns.rules[cnProbeIdx + 1]?.rule_set, "geoip-cn");

  // Route order: forceDirect -> forceProxy CIDR -> ip_is_private -> global -> forceProxy -> AI domains -> geosite-cn -> !cn -> geoip-cn -> AI processes -> bittorrent -> resolve -> post-resolve geoip-cn
  const idxForceDirect = route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("custom-direct.test"),
  );
  const idxForceProxyCidr = route.rules.findIndex(
    (r) => Array.isArray(r.ip_cidr) && r.ip_cidr.includes("10.20.0.0/16"),
  );
  const idxFirstPrivate = route.rules.findIndex((r) => r.ip_is_private === true);
  const idxGlobalMode = route.rules.findIndex(
    (r) => r.clash_mode === "global" && r.outbound === "proxy",
  );
  const idxForceProxy = route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("custom-proxy.test"),
  );
  const idxAiDomain = route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("openai.com"),
  );
  const idxGeositeCn = route.rules.findIndex((r) => r.rule_set === "geosite-cn");
  const idxGeositeNotCn = route.rules.findIndex(
    (r) => r.rule_set === "geosite-geolocation-!cn",
  );
  const idxPreResolveGeoipCn = route.rules.findIndex(
    (r, idx) => idx > idxGeositeNotCn && r.rule_set === "geoip-cn",
  );
  const idxAiProcess = route.rules.findIndex(
    (r) =>
      Array.isArray(r.process_path_regex) &&
      r.process_path_regex.some((p: string) => p.includes("Cursor")),
  );
  const idxBtDirect = route.rules.findIndex(
    (r) => r.protocol === "bittorrent" && r.outbound === "direct",
  );
  const idxTailResolve = route.rules.findIndex(
    (r, idx) => idx > idxGeositeNotCn && r.action === "resolve",
  );
  const idxPostResolveGeoip = route.rules.findIndex(
    (r, idx) => idx > idxTailResolve && r.rule_set === "geoip-cn",
  );

  assert.ok(idxForceDirect > 0);
  assert.ok(idxForceDirect < idxGlobalMode);
  assert.ok(idxForceProxyCidr < idxFirstPrivate);
  assert.ok(idxFirstPrivate < idxGlobalMode);
  assert.ok(idxGlobalMode < idxForceProxy);
  assert.ok(idxForceProxy < idxAiDomain);
  assert.ok(idxAiDomain < idxGeositeCn);
  assert.ok(idxGeositeCn < idxGeositeNotCn);
  assert.ok(idxGeositeNotCn < idxPreResolveGeoipCn);
  assert.ok(idxPreResolveGeoipCn < idxAiProcess);
  assert.ok(idxAiProcess < idxBtDirect);
  assert.ok(idxBtDirect < idxTailResolve);
  assert.ok(idxTailResolve < idxPostResolveGeoip);

  // Rule sets include geosite-private and explicit 3d update_interval
  assert.deepEqual(
    route.rule_set.map((rs) => rs.tag),
    ["geosite-private", "geosite-cn", "geosite-geolocation-!cn", "geoip-cn"],
  );
  for (const rs of route.rule_set) {
    assert.equal(rs.update_interval, "3d");
    assert.equal(rs.download_detour, "proxy");
  }

  // Disabling AI suite proxy removes both process and domain rules
  const cfgDisabled = buildSingBoxConfig({
    nodes: [node],
    selectedOutbound: node.id,
    routingMode: "rule",
    tunMode: false,
    forceProxyText: "",
    forceDirectText: "",
    aiSuiteProxyEnabled: false,
  });
  const disabledRouteRules = (cfgDisabled.route as { rules: Array<Record<string, unknown>> }).rules;
  const disabledDnsRules = (cfgDisabled.dns as { rules: Array<Record<string, unknown>> }).rules;
  assert.equal(
    disabledRouteRules.some(
      (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("openai.com"),
    ),
    false,
  );
  assert.equal(
    disabledDnsRules.some(
      (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("openai.com"),
    ),
    false,
  );
});

test("TUN mode QUIC reject stays after direct & forceDirect and skips domestic CN traffic", () => {
  const node = parseSingleShareUri("trojan://demo@node.example:443#Demo");
  assert.ok(node);

  const cfgTun = buildSingBoxConfig({
    nodes: [node],
    selectedOutbound: node.id,
    routingMode: "rule",
    tunMode: true,
    forceProxyText: "",
    forceDirectText: "bilibili.com",
  });
  const inbounds = cfgTun.inbounds as Array<Record<string, unknown>>;
  assert.equal(inbounds.find((i) => i.type === "tun")?.mtu, 1480);
  const rules = (cfgTun.route as { rules: Array<Record<string, unknown>> }).rules;
  const idxDirectMode = rules.findIndex((r) => r.clash_mode === "direct");
  const idxForceDirect = rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("bilibili.com"),
  );
  const idxRuleModeQuic = rules.findIndex(
    (r) => r.type === "logical" && r.mode === "and" && r.action === "reject",
  );
  assert.ok(idxDirectMode >= 0);
  assert.ok(idxForceDirect > idxDirectMode);
  assert.ok(idxRuleModeQuic > idxForceDirect);
});

test("migratePersistedState preserves explicit aiSuiteProxyEnabled and keeps default for legacy data", () => {
  const legacy = migratePersistedState({ routingMode: "rule" }, 2);
  assert.equal(legacy.aiSuiteProxyEnabled, undefined);

  const explicitFalse = migratePersistedState({ aiSuiteProxyEnabled: false }, 2);
  assert.equal(explicitFalse.aiSuiteProxyEnabled, false);
});

test("laynet-core check passes with zero errors and warnings for generated System Proxy and TUN configs", () => {
  const coreBin = path.resolve(
    process.cwd(),
    "src-tauri",
    "binaries",
    "laynet-core-x86_64-pc-windows-msvc.exe",
  );
  if (!fs.existsSync(coreBin)) return;

  const node = parseSingleShareUri(
    "hysteria2://secret@hy2.example:443/?sni=hy2.example&mport=20000-40000#HY2",
  );
  const huNode = parseSingleShareUri(
    "vless://11111111-1111-1111-1111-111111111111@hu.example:443?security=tls&type=httpupgrade&host=hu.example&path=/ws#VLESS-HU",
  );
  assert.ok(node && huNode);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laynet-core-check-"));
  try {
    for (const tunMode of [false, true]) {
      for (const aiSuiteProxyEnabled of [true, false]) {
        const cfg = buildSingBoxConfig({
          nodes: [node, huNode],
          selectedOutbound: node.id,
          routingMode: "rule",
          tunMode,
          forceProxyText: "DOMAIN-SUFFIX,openai.com\n1.1.1.1\n10.20.0.0/16\n2606:4700::/32\nfull:api.example.com\ncursor.exe",
          forceDirectText: "qq.com\n10.8.0.0/16\nkeyword:corp\nWeChat.exe",
          aiSuiteProxyEnabled,
        });
        const cfgPath = path.join(
          tmpDir,
          `sample-tun-${tunMode}-ai-${aiSuiteProxyEnabled}.json`,
        );
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        const output = execFileSync(coreBin, ["check", "-c", cfgPath, "-D", tmpDir], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.equal(output.trim(), "");
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
