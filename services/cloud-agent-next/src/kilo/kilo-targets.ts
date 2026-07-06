import { DEFAULT_BACKEND_URL } from '../constants.js';

const DEFAULT_SESSION_INGEST_URL = 'https://ingest.kilosessions.ai';
const LOCAL_SANDBOX_HOSTNAME = 'host.docker.internal';

type KiloTargetEnv = {
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
  const match = token.match(/^(https?:\/\/[^:]+(?::\d+)?(?:\/[^:]*)?):/);
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

function normalizeSandboxTarget(value: string): string | null {
  if (/%(?:2f|5c)/i.test(value)) return null;
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
  userToken: string
): DerivedKiloSandboxTargets {
  const backendBaseUrl = normalizeSandboxTarget(
    env.KILOCODE_BACKEND_BASE_URL ?? DEFAULT_BACKEND_URL
  );
  if (!backendBaseUrl) return { success: false, reason: 'invalid_target' };

  const providerSource =
    providerBaseUrlEncodedInToken(userToken) ?? env.KILO_OPENROUTER_BASE ?? backendBaseUrl;
  const providerBaseUrl = normalizeSandboxTarget(providerSource);
  const sessionIngestBaseUrl = normalizeSandboxTarget(
    env.KILO_SESSION_INGEST_URL ?? DEFAULT_SESSION_INGEST_URL
  );
  if (!providerBaseUrl || !sessionIngestBaseUrl) {
    return { success: false, reason: 'invalid_target' };
  }

  return {
    success: true,
    targets: { backendBaseUrl, providerBaseUrl, sessionIngestBaseUrl },
  };
}
