import { isIP } from "node:net";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

const DEFAULT_LOCAL_SUFFIXES = [".local", ".internal", ".localhost"];

export interface SafeUrlOptions {
  allowHosts?: string[];
  allowSubdomainsOf?: string[];
  requireHttps?: boolean;
}

export function assertSafePublicUrl(
  rawUrl: string,
  options: SafeUrlOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  if (options.requireHttps && parsed.protocol !== "https:") {
    throw new Error(`HTTPS is required: ${rawUrl}`);
  }

  if (parsed.port) {
    throw new Error(`Custom ports are not allowed: ${parsed.port}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("Credentials in URL are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  if (options.allowHosts?.length && !options.allowHosts.includes(hostname)) {
    throw new Error(`Host is not allowlisted: ${hostname}`);
  }

  if (
    options.allowSubdomainsOf?.length &&
    !options.allowSubdomainsOf.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new Error(`Host is outside allowed domains: ${hostname}`);
  }

  return parsed;
}

function isBlockedHostname(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) {
    return true;
  }

  if (DEFAULT_LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return isPrivateIpv4(hostname);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(hostname);
  }

  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

const rateLimitChains = new Map<string, Promise<number>>();

export async function waitForRateLimit(
  scope: string,
  minIntervalMs: number,
): Promise<void> {
  if (minIntervalMs <= 0) {
    return;
  }

  const previous = rateLimitChains.get(scope) ?? Promise.resolve(0);

  const next = previous.then(async (lastAt) => {
    const now = Date.now();
    const waitMs = Math.max(0, lastAt + minIntervalMs - now);

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    return Date.now();
  });

  rateLimitChains.set(
    scope,
    next.catch(() => Date.now()),
  );

  await next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
