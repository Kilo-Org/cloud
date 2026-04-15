import { readDb, sql } from '@/lib/drizzle';
import * as z from 'zod';

type GatewayErrorRates = { openrouter: number; vercel: number };

const REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_RATES: GatewayErrorRates = { openrouter: 0, vercel: 0 };

let cachedResult: GatewayErrorRates | null = null;
let lastRefreshAt = 0;
let refreshInFlight: Promise<GatewayErrorRates> | null = null;

async function fetchGatewayErrorRates(): Promise<GatewayErrorRates> {
  console.debug(`[getGatewayErrorRate] refreshing at ${new Date().toISOString()}`);
  const { rows } = await readDb.execute(sql`
      select
          mu.provider as "gateway",
          1.0 * count(*) filter(where mu.has_error = true) / count(*) as "errorRate"
      from microdollar_usage mu
      join microdollar_usage_metadata meta on mu.id = meta.id
      where true
          and mu.created_at >= now() - interval '10 minutes'
          and meta.is_user_byok = false
          and mu.provider in ('openrouter', 'vercel')
      group by mu.provider
  `);
  const parsed = z
    .array(
      z.object({
        gateway: z.string(),
        errorRate: z.coerce.number(),
      })
    )
    .parse(rows);
  return {
    openrouter: parsed.find(r => r.gateway === 'openrouter')?.errorRate ?? 0,
    vercel: parsed.find(r => r.gateway === 'vercel')?.errorRate ?? 0,
  };
}

async function refreshIfNeeded(): Promise<GatewayErrorRates> {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_INTERVAL_MS && cachedResult) {
    return cachedResult;
  }

  // If a refresh is already in-flight, wait for it rather than starting another
  if (refreshInFlight) {
    return cachedResult ?? refreshInFlight;
  }

  refreshInFlight = fetchGatewayErrorRates()
    .then(result => {
      cachedResult = result;
      lastRefreshAt = Date.now();
      return result;
    })
    .catch(e => {
      console.debug(`[getGatewayErrorRate] refresh error`, e);
      return cachedResult ?? DEFAULT_RATES;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  // If we have a stale cached result, return it immediately while refresh runs in background
  if (cachedResult) {
    return cachedResult;
  }

  // No cached result yet — must wait for the first fetch
  return refreshInFlight;
}

export async function getGatewayErrorRate(): Promise<GatewayErrorRates> {
  const start = performance.now();
  const result = await refreshIfNeeded();
  console.debug(`[getGatewayErrorRate] returned after ${performance.now() - start}ms`);
  return result;
}
