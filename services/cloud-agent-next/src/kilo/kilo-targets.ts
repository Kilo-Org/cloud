import { DEFAULT_BACKEND_URL } from '../constants.js';

const DEFAULT_SESSION_INGEST_URL = 'https://ingest.kilosessions.ai';
const LOCAL_SANDBOX_HOSTNAME = 'host.docker.internal';
const TOKEN_PROVIDER_URL = /^(https?:\/\/[^:]+(?::\d+)?(?:\/[^:]*)?):/;

export type KiloTargetEnv = {
  KILOCODE_BACKEND_BASE_URL?: string;
  KILO_OPENROUTER_BASE?: string;
  KILO_SESSION_INGEST_URL?: string;
};

export type KiloSandboxTargets = {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
};

export type DerivedKiloSandboxTargets =
  | {
      success: true;
      targets: KiloSandboxTargets;
    }
  | { success: false; reason: 'invalid_target' };

export function providerBaseUrlEncodedInToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const match = token.match(TOKEN_PROVIDER_URL);
  if (!match?.[1]) return undefined;
  try {
    return new URL(match[1]).toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function backendUrlForSandbox(workerBackendUrl: string): string {
  try {
    const url = new URL(workerBackendUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = LOCAL_SANDBOX_HOSTNAME;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return workerBackendUrl;
  }
}

function hasUnsafeTargetEncoding(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (
      decoded.includes('\\') ||
      /%(?:2f|5c)/i.test(decoded) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?=\/|[?#]|$)/i.test(decoded) ||
      [...decoded].some(character => {
        const code = character.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
      })
    ) {
      return true;
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}

function isValidHttpsSandboxTarget(value: string): boolean {
  if (hasUnsafeTargetEncoding(value)) return false;
  const rawTarget = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(value);
  if (!rawTarget?.[1] || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(rawTarget[1])) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.includes('//') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname === LOCAL_SANDBOX_HOSTNAME
  ) {
    return false;
  }

  const labels = url.hostname.split('.');
  return (
    url.hostname.length <= 253 &&
    labels.length > 1 &&
    labels.some(label => !/^\d+$/.test(label)) &&
    labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

function normalizeSandboxTarget(value: string, requireHttps = false): string | null {
  if (/%(?:2f|5c)/i.test(value)) return null;
  if (requireHttps && !isValidHttpsSandboxTarget(value)) return null;
  let url: URL;
  try {
    url = new URL(backendUrlForSandbox(value));
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const localHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', LOCAL_SANDBOX_HOSTNAME].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) return null;
  url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

export function deriveKiloSandboxTargets(
  env: KiloTargetEnv,
  userToken: string,
  options?: { requireHttps?: boolean }
): DerivedKiloSandboxTargets {
  const requireHttps = options?.requireHttps === true;
  const backendBaseUrl = normalizeSandboxTarget(
    env.KILOCODE_BACKEND_BASE_URL ?? DEFAULT_BACKEND_URL,
    requireHttps
  );
  if (!backendBaseUrl) return { success: false, reason: 'invalid_target' };

  const rawTokenProviderSource = TOKEN_PROVIDER_URL.exec(userToken)?.[1];
  if (
    requireHttps &&
    rawTokenProviderSource &&
    !isValidHttpsSandboxTarget(rawTokenProviderSource)
  ) {
    return { success: false, reason: 'invalid_target' };
  }
  const encodedProviderSource = providerBaseUrlEncodedInToken(userToken);
  const providerSource =
    (requireHttps && encodedProviderSource ? rawTokenProviderSource : encodedProviderSource) ??
    env.KILO_OPENROUTER_BASE ??
    backendBaseUrl;
  const providerBaseUrl = normalizeSandboxTarget(providerSource, requireHttps);
  const sessionIngestBaseUrl = normalizeSandboxTarget(
    env.KILO_SESSION_INGEST_URL ?? DEFAULT_SESSION_INGEST_URL,
    requireHttps
  );
  if (!providerBaseUrl || !sessionIngestBaseUrl) {
    return { success: false, reason: 'invalid_target' };
  }

  return {
    success: true,
    targets: { backendBaseUrl, providerBaseUrl, sessionIngestBaseUrl },
  };
}
