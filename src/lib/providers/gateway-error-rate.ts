import { db, sql } from '@/lib/drizzle';
import { unstable_cache } from 'next/cache';
import * as z from 'zod';

const getGatewayErrorRate_cached = unstable_cache(
  async () => {
    console.debug(`[getGatewayErrorRate_cached] refreshing at ${new Date().toISOString()}`);
    const { rows } = await db.execute(sql`
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
    return z
      .array(
        z.object({
          gateway: z.string(),
          errorRate: z.coerce.number(),
        })
      )
      .parse(rows);
  },
  undefined,
  { revalidate: 600 }
);

export async function getGatewayErrorRate() {
  const start = performance.now();
  try {
    const result = await Promise.race([
      getGatewayErrorRate_cached(),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500)),
    ]);
    if (result === 'timeout') {
      console.debug(`[getGatewayErrorRate] query timeout after ${performance.now() - start}ms`);
      return {
        openrouter: 0,
        vercel: 0,
      };
    } else {
      console.debug(`[getGatewayErrorRate] query success after ${performance.now() - start}ms`);
      return {
        openrouter: result.find(r => r.gateway === 'openrouter')?.errorRate ?? 0,
        vercel: result.find(r => r.gateway === 'vercel')?.errorRate ?? 0,
      };
    }
  } catch (e) {
    console.debug(`[getGatewayErrorRate] query error after ${performance.now() - start}ms`, e);
  }
  return {
    openrouter: 0,
    vercel: 0,
  };
}
