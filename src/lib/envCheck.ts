import type {
  EnvCheckReport,
  ProxyGeoInfo,
  SystemEnvInfo,
} from "../types/proxy";
import { fetchTextViaProxy } from "./tauriBridge";

export const IANA_TO_WINDOWS_TZ: Record<string, string> = {
  // UTC / GMT
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
  "Atlantic/Reykjavik": "Greenwich Standard Time",

  // Americas — US & Canada
  "America/New_York": "Eastern Standard Time",
  "America/Detroit": "Eastern Standard Time",
  "America/Toronto": "Eastern Standard Time",
  "America/Montreal": "Eastern Standard Time",
  "America/Indiana/Indianapolis": "US Eastern Standard Time",
  "America/Chicago": "Central Standard Time",
  "America/Winnipeg": "Central Standard Time",
  "America/Mexico_City": "Central Standard Time (Mexico)",
  "America/Monterrey": "Central Standard Time (Mexico)",
  "America/Denver": "Mountain Standard Time",
  "America/Edmonton": "Mountain Standard Time",
  "America/Phoenix": "US Mountain Standard Time",
  "America/Los_Angeles": "Pacific Standard Time",
  "America/Vancouver": "Pacific Standard Time",
  "America/Tijuana": "Pacific Standard Time (Mexico)",
  "America/Anchorage": "Alaskan Standard Time",
  "Pacific/Honolulu": "Hawaiian Standard Time",
  "America/Halifax": "Atlantic Standard Time",
  "America/St_Johns": "Newfoundland Standard Time",

  // Americas — Latin America
  "America/Bogota": "SA Pacific Standard Time",
  "America/Lima": "SA Pacific Standard Time",
  "America/Santiago": "Pacific SA Standard Time",
  "America/Argentina/Buenos_Aires": "Argentina Standard Time",
  "America/Sao_Paulo": "E. South America Standard Time",
  "America/Caracas": "Venezuela Standard Time",

  // Europe
  "Europe/London": "GMT Standard Time",
  "Europe/Dublin": "GMT Standard Time",
  "Europe/Lisbon": "GMT Standard Time",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Brussels": "Romance Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/Copenhagen": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Frankfurt": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/Zurich": "W. Europe Standard Time",
  "Europe/Vienna": "W. Europe Standard Time",
  "Europe/Rome": "W. Europe Standard Time",
  "Europe/Stockholm": "W. Europe Standard Time",
  "Europe/Oslo": "W. Europe Standard Time",
  "Europe/Luxembourg": "W. Europe Standard Time",
  "Europe/Warsaw": "Central European Standard Time",
  "Europe/Prague": "Central Europe Standard Time",
  "Europe/Budapest": "Central Europe Standard Time",
  "Europe/Helsinki": "FLE Standard Time",
  "Europe/Kiev": "FLE Standard Time",
  "Europe/Kyiv": "FLE Standard Time",
  "Europe/Bucharest": "GTB Standard Time",
  "Europe/Athens": "GTB Standard Time",
  "Europe/Sofia": "FLE Standard Time",
  "Europe/Istanbul": "Turkey Standard Time",
  "Europe/Moscow": "Russian Standard Time",

  // Asia — East & Southeast
  "Asia/Shanghai": "China Standard Time",
  "Asia/Chongqing": "China Standard Time",
  "Asia/Harbin": "China Standard Time",
  "Asia/Urumqi": "China Standard Time",
  "Asia/Hong_Kong": "China Standard Time",
  "Asia/Macau": "China Standard Time",
  "Asia/Taipei": "Taipei Standard Time",
  "Asia/Tokyo": "Tokyo Standard Time",
  "Asia/Seoul": "Korea Standard Time",
  "Asia/Singapore": "Singapore Standard Time",
  "Asia/Kuala_Lumpur": "Singapore Standard Time",
  "Asia/Manila": "Singapore Standard Time",
  "Asia/Bangkok": "SE Asia Standard Time",
  "Asia/Ho_Chi_Minh": "SE Asia Standard Time",
  "Asia/Jakarta": "SE Asia Standard Time",
  "Asia/Phnom_Penh": "SE Asia Standard Time",

  // Asia — South & Central & Middle East
  "Asia/Kolkata": "India Standard Time",
  "Asia/Calcutta": "India Standard Time",
  "Asia/Dhaka": "Bangladesh Standard Time",
  "Asia/Karachi": "Pakistan Standard Time",
  "Asia/Almaty": "West Asia Standard Time",
  "Asia/Tashkent": "West Asia Standard Time",
  "Asia/Dubai": "Arabian Standard Time",
  "Asia/Muscat": "Arabian Standard Time",
  "Asia/Riyadh": "Arab Standard Time",
  "Asia/Jerusalem": "Israel Standard Time",
  "Asia/Tel_Aviv": "Israel Standard Time",

  // Oceania & Africa
  "Australia/Sydney": "AUS Eastern Standard Time",
  "Australia/Melbourne": "AUS Eastern Standard Time",
  "Australia/Brisbane": "E. Australia Standard Time",
  "Australia/Adelaide": "Cen. Australia Standard Time",
  "Australia/Perth": "W. Australia Standard Time",
  "Pacific/Auckland": "New Zealand Standard Time",
  "Africa/Johannesburg": "South Africa Standard Time",
  "Africa/Cairo": "Egypt Standard Time",
  "Africa/Lagos": "W. Central Africa Standard Time",
};

const COUNTRY_LANGUAGE_MAP: Record<
  string,
  { primary: string; label: string; accepted: string[] }
> = {
  US: { primary: "en-US", label: "英语 (美国)", accepted: ["en-US", "en"] },
  GB: { primary: "en-GB", label: "英语 (英国)", accepted: ["en-GB", "en"] },
  CA: { primary: "en-CA", label: "英语 (加拿大)", accepted: ["en-CA", "fr-CA", "en"] },
  AU: { primary: "en-AU", label: "英语 (澳大利亚)", accepted: ["en-AU", "en"] },
  NZ: { primary: "en-NZ", label: "英语 (新西兰)", accepted: ["en-NZ", "en"] },
  IE: { primary: "en-IE", label: "英语 (爱尔兰)", accepted: ["en-IE", "en"] },
  SG: { primary: "en-SG", label: "英语 (新加坡)", accepted: ["en-SG", "zh-SG", "en"] },
  HK: { primary: "zh-HK", label: "繁体中文 (香港)", accepted: ["zh-HK", "en-HK"] },
  MO: { primary: "zh-MO", label: "繁体中文 (澳门)", accepted: ["zh-MO", "pt-MO"] },
  TW: { primary: "zh-TW", label: "繁体中文 (台湾)", accepted: ["zh-TW"] },
  CN: { primary: "zh-CN", label: "简体中文 (中国)", accepted: ["zh-CN"] },
  JP: { primary: "ja-JP", label: "日语 (日本)", accepted: ["ja-JP", "ja"] },
  KR: { primary: "ko-KR", label: "韩语 (韩国)", accepted: ["ko-KR", "ko"] },
  DE: { primary: "de-DE", label: "德语 (德国)", accepted: ["de-DE", "de"] },
  AT: { primary: "de-AT", label: "德语 (奥地利)", accepted: ["de-AT", "de"] },
  CH: { primary: "de-CH", label: "德语 (瑞士)", accepted: ["de-CH", "fr-CH", "it-CH", "de"] },
  FR: { primary: "fr-FR", label: "法语 (法国)", accepted: ["fr-FR", "fr"] },
  NL: { primary: "nl-NL", label: "荷兰语 (荷兰)", accepted: ["nl-NL", "nl"] },
  BE: { primary: "nl-BE", label: "荷兰语/法语 (比利时)", accepted: ["nl-BE", "fr-BE", "nl", "fr"] },
  ES: { primary: "es-ES", label: "西班牙语 (西班牙)", accepted: ["es-ES", "es"] },
  IT: { primary: "it-IT", label: "意大利语 (意大利)", accepted: ["it-IT", "it"] },
  PT: { primary: "pt-PT", label: "葡萄牙语 (葡萄牙)", accepted: ["pt-PT", "pt"] },
  BR: { primary: "pt-BR", label: "葡萄牙语 (巴西)", accepted: ["pt-BR", "pt"] },
  MX: { primary: "es-MX", label: "西班牙语 (墨西哥)", accepted: ["es-MX", "es"] },
  AR: { primary: "es-AR", label: "西班牙语 (阿根廷)", accepted: ["es-AR", "es"] },
  RU: { primary: "ru-RU", label: "俄语 (俄罗斯)", accepted: ["ru-RU", "ru"] },
  UA: { primary: "uk-UA", label: "乌克兰语 (乌克兰)", accepted: ["uk-UA", "uk"] },
  PL: { primary: "pl-PL", label: "波兰语 (波兰)", accepted: ["pl-PL", "pl"] },
  SE: { primary: "sv-SE", label: "瑞典语 (瑞典)", accepted: ["sv-SE", "sv"] },
  NO: { primary: "nb-NO", label: "挪威语 (挪威)", accepted: ["nb-NO", "nn-NO", "no"] },
  FI: { primary: "fi-FI", label: "芬兰语 (芬兰)", accepted: ["fi-FI", "fi"] },
  DK: { primary: "da-DK", label: "丹麦语 (丹麦)", accepted: ["da-DK", "da"] },
  TR: { primary: "tr-TR", label: "土耳其语 (土耳其)", accepted: ["tr-TR", "tr"] },
  IN: { primary: "en-IN", label: "英语 (印度)", accepted: ["en-IN", "hi-IN", "en"] },
  TH: { primary: "th-TH", label: "泰语 (泰国)", accepted: ["th-TH", "th"] },
  VN: { primary: "vi-VN", label: "越南语 (越南)", accepted: ["vi-VN", "vi"] },
  MY: { primary: "ms-MY", label: "马来语 (马来西亚)", accepted: ["ms-MY", "en-MY"] },
  ID: { primary: "id-ID", label: "印尼语 (印度尼西亚)", accepted: ["id-ID", "id"] },
  PH: { primary: "en-PH", label: "英语 (菲律宾)", accepted: ["en-PH", "fil-PH", "en"] },
  AE: { primary: "ar-AE", label: "阿拉伯语 (阿联酋)", accepted: ["ar-AE", "ar"] },
  IL: { primary: "he-IL", label: "希伯来语 (以色列)", accepted: ["he-IL", "he"] },
  ZA: { primary: "en-ZA", label: "英语 (南非)", accepted: ["en-ZA", "en"] },
};

const DEFAULT_LANGUAGE_ENTRY = {
  primary: "en-US",
  label: "英语 (美国)",
  accepted: ["en-US", "en"],
};

export function normalizeLanguageTag(tag: string): string {
  const parts = tag
    .trim()
    .replace(/_/g, "-")
    .split("-")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";

  const primary = parts[0]!.toLowerCase();
  const second = parts[1];
  const third = parts[2];

  // 合并 Windows 常见 Script 子标签（如 zh-Hans-CN -> zh-CN, zh-Hant-TW -> zh-TW）
  if (
    primary === "zh" &&
    second &&
    (second.toLowerCase() === "hans" || second.toLowerCase() === "hant")
  ) {
    if (third && third.length === 2) {
      return `zh-${third.toUpperCase()}`;
    }
    return second.toLowerCase() === "hant" ? "zh-TW" : "zh-CN";
  }

  return parts
    .map((part, idx) => {
      if (idx === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) {
        return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join("-");
}

export function resolveWindowsTimezoneForIana(ianaTimezone: string): string | null {
  const trimmed = ianaTimezone.trim();
  if (!trimmed) return null;
  if (IANA_TO_WINDOWS_TZ[trimmed]) {
    return IANA_TO_WINDOWS_TZ[trimmed]!;
  }
  const lower = trimmed.toLowerCase();
  for (const [key, val] of Object.entries(IANA_TO_WINDOWS_TZ)) {
    if (key.toLowerCase() === lower) {
      return val;
    }
  }
  return null;
}

export function resolveLanguageProfileForCountry(countryCode: string): {
  primary: string;
  label: string;
  accepted: string[];
} {
  const code = countryCode.trim().toUpperCase();
  return COUNTRY_LANGUAGE_MAP[code] ?? DEFAULT_LANGUAGE_ENTRY;
}

export function evaluateEnvConsistency(
  proxyGeo: ProxyGeoInfo,
  localEnv: SystemEnvInfo,
): EnvCheckReport {
  const targetWindowsTimezone = resolveWindowsTimezoneForIana(
    proxyGeo.ianaTimezone,
  );
  const timezoneMatch =
    targetWindowsTimezone !== null &&
    localEnv.windowsTimezone.trim().toLowerCase() ===
      targetWindowsTimezone.trim().toLowerCase();

  const langProfile = resolveLanguageProfileForCountry(proxyGeo.countryCode);
  const localPrimaryRaw = localEnv.languages[0] ?? "";
  const localPrimaryNormalized = normalizeLanguageTag(localPrimaryRaw);
  const acceptedNormalized = langProfile.accepted.map(normalizeLanguageTag);
  const languageMatch =
    localPrimaryNormalized !== "" &&
    acceptedNormalized.some(
      (acc) => acc.toLowerCase() === localPrimaryNormalized.toLowerCase(),
    );

  return {
    proxyGeo,
    localEnv,
    targetWindowsTimezone,
    timezoneMatch,
    recommendedLanguage: langProfile.primary,
    recommendedLanguageLabel: langProfile.label,
    acceptedLanguages: langProfile.accepted,
    localPrimaryLanguage: localPrimaryRaw || "未设置",
    languageMatch,
  };
}

export type GeoProviderName = "ipwho.is" | "ipapi.co" | "ipinfo.io";

export function parseGeoProviderResponse(
  provider: GeoProviderName,
  rawJson: string,
): ProxyGeoInfo | null {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (provider === "ipwho.is") {
    if (data.success === false) return null;
    const ip = typeof data.ip === "string" ? data.ip.trim() : "";
    const countryCode =
      typeof data.country_code === "string" ? data.country_code.trim().toUpperCase() : "";
    const countryName =
      typeof data.country === "string" ? data.country.trim() : countryCode;
    const tzObj =
      data.timezone && typeof data.timezone === "object"
        ? (data.timezone as Record<string, unknown>)
        : null;
    const ianaTimezone =
      tzObj && typeof tzObj.id === "string" ? tzObj.id.trim() : "";
    if (!ip || !countryCode || !ianaTimezone) return null;
    return {
      ip,
      countryCode,
      countryName,
      region: typeof data.region === "string" ? data.region.trim() : undefined,
      city: typeof data.city === "string" ? data.city.trim() : undefined,
      ianaTimezone,
      provider,
    };
  }

  if (provider === "ipapi.co") {
    if (data.error === true) return null;
    const ip = typeof data.ip === "string" ? data.ip.trim() : "";
    const countryCode =
      typeof data.country_code === "string"
        ? data.country_code.trim().toUpperCase()
        : typeof data.country === "string"
          ? data.country.trim().toUpperCase()
          : "";
    const countryName =
      typeof data.country_name === "string"
        ? data.country_name.trim()
        : countryCode;
    const ianaTimezone =
      typeof data.timezone === "string" ? data.timezone.trim() : "";
    if (!ip || !countryCode || !ianaTimezone) return null;
    return {
      ip,
      countryCode,
      countryName,
      region: typeof data.region === "string" ? data.region.trim() : undefined,
      city: typeof data.city === "string" ? data.city.trim() : undefined,
      ianaTimezone,
      provider,
    };
  }

  // ipinfo.io
  const ip = typeof data.ip === "string" ? data.ip.trim() : "";
  const countryCode =
    typeof data.country === "string" ? data.country.trim().toUpperCase() : "";
  const ianaTimezone =
    typeof data.timezone === "string" ? data.timezone.trim() : "";
  if (!ip || !countryCode || !ianaTimezone) return null;
  return {
    ip,
    countryCode,
    countryName: countryCode,
    region: typeof data.region === "string" ? data.region.trim() : undefined,
    city: typeof data.city === "string" ? data.city.trim() : undefined,
    ianaTimezone,
    provider,
  };
}

const GEO_PROVIDERS: ReadonlyArray<{
  name: GeoProviderName;
  url: string;
}> = [
  { name: "ipwho.is", url: "https://ipwho.is/" },
  { name: "ipapi.co", url: "https://ipapi.co/json/" },
  { name: "ipinfo.io", url: "https://ipinfo.io/json" },
];

export async function probeProxyGeo(
  fetcher: (url: string) => Promise<string> = fetchTextViaProxy,
): Promise<ProxyGeoInfo> {
  const errors: string[] = [];
  for (const p of GEO_PROVIDERS) {
    try {
      const body = await fetcher(p.url);
      const parsed = parseGeoProviderResponse(p.name, body);
      if (parsed) {
        return parsed;
      }
      errors.push(`${p.name}: 返回格式无效`);
    } catch (err) {
      errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `无法通过代理探测出口 IP 地区（${errors.join("；")}）`,
  );
}
