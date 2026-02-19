import { get } from '@vercel/edge-config';
import { getEnvVariable } from '@/lib/dotenvx';

const EDGE_CONFIG_KEY = 'ENABLE_UNIVERSAL_VERCEL_ROUTING';
const CACHE_TTL_MS = 15_000; // 15 seconds

type CachedValue = {
  value: boolean;
  fetchedAt: number;
};

let cached: CachedValue | null = null;

/**
 * Check whether universal Vercel routing is enabled via Edge Config.
 *
 * Uses an in-memory TTL cache (15 s) so the hot path almost never
 * hits Edge Config. Falls back to `false` on any error.
 */
export async function isUniversalVercelRoutingEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const value = await get<boolean>(EDGE_CONFIG_KEY);
    const resolved = value === true;
    cached = { value: resolved, fetchedAt: Date.now() };
    return resolved;
  } catch (error) {
    console.error('[edge-config] Failed to read ENABLE_UNIVERSAL_VERCEL_ROUTING:', error);
    // Keep serving the stale cached value if we have one
    if (cached) return cached.value;
    return false;
  }
}

/**
 * Update the ENABLE_UNIVERSAL_VERCEL_ROUTING flag in Vercel Edge Config.
 *
 * Uses the Vercel REST API (the `@vercel/edge-config` SDK is read-only).
 * Requires EDGE_CONFIG_ID and VERCEL_API_TOKEN env vars.
 */
export async function setUniversalVercelRouting(enabled: boolean): Promise<void> {
  const edgeConfigId = getEnvVariable('EDGE_CONFIG_ID');
  const vercelApiToken = getEnvVariable('VERCEL_API_TOKEN');
  const vercelTeamId = getEnvVariable('VERCEL_TEAM_ID');

  if (!edgeConfigId || !vercelApiToken) {
    throw new Error('EDGE_CONFIG_ID and VERCEL_API_TOKEN are required to update Edge Config');
  }

  const url = new URL(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`);
  if (vercelTeamId) {
    url.searchParams.set('teamId', vercelTeamId);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${vercelApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          operation: 'upsert',
          key: EDGE_CONFIG_KEY,
          value: enabled,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update Edge Config (${response.status}): ${body}`);
  }

  // Immediately update the local cache so subsequent reads reflect the change
  cached = { value: enabled, fetchedAt: Date.now() };
}

/** Exposed for testing only — resets the in-memory cache. */
export function _resetCacheForTesting(): void {
  cached = null;
}
