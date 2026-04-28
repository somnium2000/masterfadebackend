function matchPattern(pattern, userAgent) {
  const match = pattern.exec(userAgent);
  return match?.[1] ? String(match[1]).trim() : null;
}

function detectBrowser(userAgent) {
  if (/edg\/([\d.]+)/i.test(userAgent)) {
    return { name: "Edge", version: matchPattern(/edg\/([\d.]+)/i, userAgent) };
  }
  if (/opr\/([\d.]+)/i.test(userAgent) || /opera\/([\d.]+)/i.test(userAgent)) {
    return { name: "Opera", version: matchPattern(/(?:opr|opera)\/([\d.]+)/i, userAgent) };
  }
  if (/chrome\/([\d.]+)/i.test(userAgent) && !/edg\//i.test(userAgent) && !/opr\//i.test(userAgent)) {
    return { name: "Chrome", version: matchPattern(/chrome\/([\d.]+)/i, userAgent) };
  }
  if (/firefox\/([\d.]+)/i.test(userAgent)) {
    return { name: "Firefox", version: matchPattern(/firefox\/([\d.]+)/i, userAgent) };
  }
  if (/version\/([\d.]+).*safari/i.test(userAgent) && !/chrome\//i.test(userAgent)) {
    return { name: "Safari", version: matchPattern(/version\/([\d.]+)/i, userAgent) };
  }
  return { name: "Navegador no identificado", version: null };
}

function detectOperatingSystem(userAgent) {
  if (/windows nt/i.test(userAgent)) return "Windows";
  if (/android/i.test(userAgent)) return "Android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
  if (/mac os x/i.test(userAgent)) return "macOS";
  if (/cros/i.test(userAgent)) return "Chrome OS";
  if (/linux/i.test(userAgent)) return "Linux";
  return "SO no identificado";
}

function detectDeviceType(userAgent) {
  if (/ipad|tablet/i.test(userAgent)) return "tablet";
  if (/mobile|iphone|android/i.test(userAgent)) return "movil";
  if (/bot|spider|crawler/i.test(userAgent)) return "bot";
  return "escritorio";
}

export function parseDeviceInfo(rawUserAgent) {
  const userAgent = String(rawUserAgent || "").trim();
  if (!userAgent || /lightmyrequest/i.test(userAgent)) {
    return {
      browser: "Dispositivo no identificado",
      browser_version: null,
      operating_system: "Dispositivo no identificado",
      device_type: "desconocido",
      summary: "Dispositivo no identificado",
    };
  }

  const browser = detectBrowser(userAgent);
  const operatingSystem = detectOperatingSystem(userAgent);
  const deviceType = detectDeviceType(userAgent);
  const browserLabel = browser.version ? `${browser.name} ${browser.version}` : browser.name;

  return {
    browser: browser.name,
    browser_version: browser.version,
    operating_system: operatingSystem,
    device_type: deviceType,
    summary: `${browserLabel} | ${operatingSystem} | ${deviceType}`,
  };
}

export function buildDeviceSummary(rawUserAgent) {
  return parseDeviceInfo(rawUserAgent).summary;
}
