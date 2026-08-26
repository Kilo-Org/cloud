import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Liveness for tunnel services, which listen on no local port.
 *
 * A tunnel's supervisor can die while its `cloudflared` children keep serving
 * (they get reparented), so the pane says "idle" while the public URL still
 * answers. Each tunnel script writes the URL it captured into an env file —
 * that captured URL, not the pane, is the honest source of truth.
 */

type TunnelUrlSource = {
  /** Repo-relative env file the tunnel script writes on capture. */
  file: string;
  key: string;
};

// Keys must match what dev/local/scripts/start-*tunnel*.ts write.
const TUNNEL_URL_SOURCES: Record<string, TunnelUrlSource> = {
  'cloud-agent-public-tunnels': {
    file: 'services/cloud-agent-next/.dev.vars',
    key: 'WORKER_URL',
  },
  'kiloclaw-tunnel': {
    file: 'services/kiloclaw/.dev.vars',
    key: 'BACKEND_API_URL',
  },
  'app-builder-tunnel': {
    file: 'apps/web/.env.development.local',
    key: 'APP_BUILDER_URL',
  },
  'bitbucket-webhook-tunnel': {
    file: 'apps/web/.env.development.local',
    key: 'BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL',
  },
};

/** Read `key` from dotenv-style text. Later assignments win, comments do not. */
function readEnvValueFromText(content: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    value = trimmed.slice(key.length + 1).replace(/^["']|["']$/g, '');
  }
  return value === '' ? undefined : value;
}

// A local host proves nothing about a tunnel: kiloclaw-tunnel writes
// `BACKEND_API_URL=http://localhost:<nextjs-port>` in docker-local mode, and
// that port answers because *nextjs* is up. Only a public host is evidence.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', '0.0.0.0']);

function isPublicUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return !LOCAL_HOSTS.has(hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function readCapturedTunnelUrl(repoRoot: string, serviceName: string): string | undefined {
  const source = TUNNEL_URL_SOURCES[serviceName];
  if (!source) return undefined;
  try {
    const url = readEnvValueFromText(
      fs.readFileSync(path.join(repoRoot, source.file), 'utf-8'),
      source.key
    );
    return url !== undefined && isPublicUrl(url) ? url : undefined;
  } catch {
    return undefined; // env file not written yet — the tunnel never captured a URL
  }
}

function healthCheckUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/health`;
  return parsed.href;
}

/**
 * Whether the captured URL still serves. A quick tunnel whose `cloudflared`
 * exited keeps resolving but the Cloudflare edge answers 502/530, so any 5xx
 * counts as down. Probe `/health` so workers that implement it return 200;
 * 404/405 from a live origin still counts as up.
 */
async function isTunnelUrlServing(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(healthCheckUrl(url), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Portless status: a captured public URL is the source of truth. cloudflared
 * stays in the pane tree while it retries a hostname that no longer resolves,
 * so process-alive alone would report a dead tunnel as up.
 */
async function isPortlessServiceHealthy(
  repoRoot: string,
  serviceName: string,
  paneAlive: boolean,
  timeoutMs = 2000
): Promise<boolean> {
  const url = readCapturedTunnelUrl(repoRoot, serviceName);
  if (url !== undefined) return isTunnelUrlServing(url, timeoutMs);
  return paneAlive;
}

export {
  isPortlessServiceHealthy,
  isPublicUrl,
  isTunnelUrlServing,
  readCapturedTunnelUrl,
  readEnvValueFromText,
  TUNNEL_URL_SOURCES,
};
export type { TunnelUrlSource };
