import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AI_SUITE_FORCE_PROXY_DOMAINS,
  AI_SUITE_FORCE_PROXY_PROCESSES,
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
    # malformed entries should be silently ignored, never turned into domain_suffix
    999.1.1.1/24
    10.8.0.0/33
    2001:::1/64
    bad domain value
  `);

  assert.deepEqual(parsed.domains, ["api.exact.test"]);
  assert.deepEqual(parsed.domainSuffixes, ["openai.com", "example.org"]);
  assert.deepEqual(parsed.domainKeywords, ["corp-internal"]);
  assert.deepEqual(parsed.ipCidrs, [
    "8.8.8.8/32",
    "10.8.0.0/16",
    "2606:4700::1/128",
    "2606:4700::/32",
    "192.168.1.50/32",
    "2001:db8::1/128",
  ]);
  assert.deepEqual(parsed.processNames, ["Cursor.exe", "WeChat.exe"]);
  assert.equal(countCustomRules(parsed), 12);
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
});

test("buildSingBoxConfig wires four-stage pipeline, hosts/local DNS, cn-probe, and AI toggle", () => {
  const node = parseSingleShareUri("trojan://demo@node.example:443#Demo");
  assert.ok(node);

  const cfgEnabled = buildSingBoxConfig({
    nodes: [node],
    selectedOutbound: node.id,
    routingMode: "rule",
    tunMode: false,
    forceProxyText: "custom-proxy.test\n1.1.1.1\nfull:only.proxy.test",
    forceDirectText: "custom-direct.test\n10.8.0.0/16\nkeyword:intranet\nWeChat.exe",
    aiSuiteProxyEnabled: true,
  });

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

  // DNS rules must include hosts-check at top and cn-probe at bottom
  assert.equal(dns.rules[0]?.action, "evaluate");
  assert.equal(dns.rules[0]?.server, "dns-hosts");
  assert.equal(dns.rules[1]?.match_response, "hosts-check");
  assert.equal(dns.rules[1]?.response_rcode, "NOERROR");

  const cnProbeIdx = dns.rules.findIndex((r) => r.tag === "cn-probe");
  assert.ok(cnProbeIdx > 0);
  assert.equal(dns.rules[cnProbeIdx]?.server, "dns-direct");
  assert.equal(dns.rules[cnProbeIdx + 1]?.match_response, "cn-probe");
  assert.equal(dns.rules[cnProbeIdx + 1]?.rule_set, "geoip-cn");

  // Route order: forceDirect before forceProxy before AI before geosite-cn -> !cn -> geoip-cn -> resolve -> post-resolve geoip-cn
  const idxForceDirect = route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("custom-direct.test"),
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
  const idxTailResolve = route.rules.findIndex(
    (r, idx) => idx > idxGeositeNotCn && r.action === "resolve",
  );
  const idxPostResolveGeoip = route.rules.findIndex(
    (r, idx) => idx > idxTailResolve && r.rule_set === "geoip-cn",
  );

  assert.ok(idxForceDirect > 0);
  assert.ok(idxForceDirect < idxForceProxy);
  assert.ok(idxForceProxy < idxAiDomain);
  assert.ok(idxAiDomain < idxGeositeCn);
  assert.ok(idxGeositeCn < idxGeositeNotCn);
  assert.ok(idxGeositeNotCn < idxTailResolve);
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
  assert.ok(node);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laynet-core-check-"));
  try {
    for (const tunMode of [false, true]) {
      for (const aiSuiteProxyEnabled of [true, false]) {
        const cfg = buildSingBoxConfig({
          nodes: [node],
          selectedOutbound: node.id,
          routingMode: "rule",
          tunMode,
          forceProxyText: "openai.com\n1.1.1.1\n2606:4700::/32\nfull:api.example.com\ncursor.exe",
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
