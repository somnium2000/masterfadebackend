import net from "node:net";

const TRUSTED_INTERNAL_PROXY_ADDRESSES = new net.BlockList();
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
TRUSTED_INTERNAL_PROXY_ADDRESSES.addAddress("::1", "ipv6");

function normalizeIpAddress(address) {
  const normalized = String(address || "").trim();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

export function isTrustedImmediateProxy(address, hop) {
  if (hop !== 0) return false;
  const normalized = normalizeIpAddress(address);
  const version = net.isIP(normalized);
  if (version === 4) return TRUSTED_INTERNAL_PROXY_ADDRESSES.check(normalized, "ipv4");
  if (version === 6) return TRUSTED_INTERNAL_PROXY_ADDRESSES.check(normalized, "ipv6");
  return false;
}

export function buildTrustProxy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) {
    // AM: EasyPanel expone Traefik como unico salto interno; nunca confiar en saltos XFF adicionales.
    return isTrustedImmediateProxy;
  }
  return false;
}
