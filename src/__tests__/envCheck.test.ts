import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEnvConsistency,
  normalizeLanguageTag,
  parseGeoProviderResponse,
  probeProxyGeo,
  resolveWindowsTimezoneForIana,
} from "../lib/envCheck";
import { migratePersistedState } from "../store/useAppStore";

test("normalizeLanguageTag normalizes Windows script subtags and standard BCP-47 casing", () => {
  assert.equal(normalizeLanguageTag("zh-Hans-CN"), "zh-CN");
  assert.equal(normalizeLanguageTag("zh-Hant-TW"), "zh-TW");
  assert.equal(normalizeLanguageTag("zh-Hant-HK"), "zh-HK");
  assert.equal(normalizeLanguageTag("zh-Hans-SG"), "zh-SG");
  assert.equal(normalizeLanguageTag("en_us"), "en-US");
  assert.equal(normalizeLanguageTag("JA-jp"), "ja-JP");
});

test("parseGeoProviderResponse handles ipwho.is, ipapi.co, ipinfo.io and rejects malformed payloads", () => {
  const ipwho = parseGeoProviderResponse(
    "ipwho.is",
    JSON.stringify({
      success: true,
      ip: "67.200.126.96",
      country: "United States",
      country_code: "us",
      region: "California",
      city: "Los Angeles",
      timezone: { id: "America/Los_Angeles" },
    }),
  );
  assert.deepEqual(ipwho, {
    ip: "67.200.126.96",
    countryCode: "US",
    countryName: "United States",
    region: "California",
    city: "Los Angeles",
    ianaTimezone: "America/Los_Angeles",
    provider: "ipwho.is",
  });

  assert.equal(
    parseGeoProviderResponse("ipwho.is", JSON.stringify({ success: false })),
    null,
  );

  const ipapi = parseGeoProviderResponse(
    "ipapi.co",
    JSON.stringify({
      ip: "1.2.3.4",
      country_code: "JP",
      country_name: "Japan",
      region: "Tokyo",
      city: "Tokyo",
      timezone: "Asia/Tokyo",
    }),
  );
  assert.equal(ipapi?.countryCode, "JP");
  assert.equal(ipapi?.ianaTimezone, "Asia/Tokyo");
  assert.equal(ipapi?.provider, "ipapi.co");

  const ipinfo = parseGeoProviderResponse(
    "ipinfo.io",
    JSON.stringify({
      ip: "8.8.8.8",
      country: "SG",
      region: "Singapore",
      city: "Singapore",
      timezone: "Asia/Singapore",
    }),
  );
  assert.equal(ipinfo?.countryCode, "SG");
  assert.equal(ipinfo?.ianaTimezone, "Asia/Singapore");
  assert.equal(ipinfo?.provider, "ipinfo.io");

  assert.equal(parseGeoProviderResponse("ipinfo.io", "not-json"), null);
});

test("probeProxyGeo falls back to secondary providers when primary fails", async () => {
  const calls: string[] = [];
  const result = await probeProxyGeo(async (url) => {
    calls.push(url);
    if (url.includes("ipwho.is")) {
      throw new Error("rate limited");
    }
    if (url.includes("ipapi.co")) {
      return JSON.stringify({ error: true });
    }
    return JSON.stringify({
      ip: "104.22.194.83",
      country: "US",
      region: "California",
      city: "Los Angeles",
      timezone: "America/Los_Angeles",
    });
  });

  assert.equal(calls.length, 3);
  assert.equal(result.provider, "ipinfo.io");
  assert.equal(result.countryCode, "US");
  assert.equal(result.ianaTimezone, "America/Los_Angeles");
});

test("evaluateEnvConsistency compares proxy region against Windows timezone and language", () => {
  assert.equal(
    resolveWindowsTimezoneForIana("America/Los_Angeles"),
    "Pacific Standard Time",
  );

  const usGeo = {
    ip: "67.200.126.96",
    countryCode: "US",
    countryName: "United States",
    city: "Los Angeles",
    ianaTimezone: "America/Los_Angeles",
    provider: "ipwho.is",
  };

  // China PC vs US proxy -> both mismatch
  const mismatchReport = evaluateEnvConsistency(usGeo, {
    windowsTimezone: "China Standard Time",
    languages: ["zh-Hans-CN", "en-US"],
    detectedBrowser: "Chrome",
  });
  assert.equal(mismatchReport.targetWindowsTimezone, "Pacific Standard Time");
  assert.equal(mismatchReport.timezoneMatch, false);
  assert.equal(mismatchReport.recommendedLanguage, "en-US");
  assert.equal(mismatchReport.languageMatch, false);

  // After fix -> both match
  const matchedReport = evaluateEnvConsistency(usGeo, {
    windowsTimezone: "Pacific Standard Time",
    languages: ["en-US", "zh-Hans-CN"],
    detectedBrowser: "Chrome",
  });
  assert.equal(matchedReport.timezoneMatch, true);
  assert.equal(matchedReport.languageMatch, true);

  // Singapore proxy vs China PC -> both mismatch
  const sgReport = evaluateEnvConsistency(
    {
      ip: "13.212.1.1",
      countryCode: "SG",
      countryName: "Singapore",
      ianaTimezone: "Asia/Singapore",
      provider: "ipwho.is",
    },
    {
      windowsTimezone: "China Standard Time",
      languages: ["zh-Hans-CN"],
      detectedBrowser: "Edge",
    },
  );
  assert.equal(sgReport.targetWindowsTimezone, "Singapore Standard Time");
  assert.equal(sgReport.timezoneMatch, false);
  assert.equal(sgReport.recommendedLanguage, "en-SG");
  assert.equal(sgReport.languageMatch, false);

  // Taiwan PC vs Taiwan proxy -> both match
  const twReport = evaluateEnvConsistency(
    {
      ip: "114.32.1.1",
      countryCode: "TW",
      countryName: "Taiwan",
      ianaTimezone: "Asia/Taipei",
      provider: "ipwho.is",
    },
    {
      windowsTimezone: "Taipei Standard Time",
      languages: ["zh-Hant-TW"],
      detectedBrowser: null,
    },
  );
  assert.equal(twReport.timezoneMatch, true);
  assert.equal(twReport.languageMatch, true);
});

test("migratePersistedState preserves valid systemEnvBackup and discards invalid backup objects", () => {
  const valid = migratePersistedState(
    {
      systemEnvBackup: {
        windowsTimezone: "China Standard Time",
        languages: ["zh-Hans-CN", "en-US"],
        savedAt: 1700000000000,
      },
    },
    2,
  );
  assert.deepEqual(valid.systemEnvBackup, {
    windowsTimezone: "China Standard Time",
    languages: ["zh-Hans-CN", "en-US"],
    savedAt: 1700000000000,
  });

  const invalid = migratePersistedState(
    {
      systemEnvBackup: {
        windowsTimezone: "",
        languages: [],
      },
    },
    2,
  );
  assert.equal(invalid.systemEnvBackup, undefined);
});
