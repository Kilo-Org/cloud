import { db, sql } from '@/lib/drizzle';
import { unstable_cache } from 'next/cache';
import * as z from 'zod';

const getGatewayErrorRate_cached = unstable_cache(
  async () => {
    console.debug(`[getGatewayErrorRate_cached] refreshing at ${new Date().toISOString()}`);
    const { rows } = await db.execute(sql`
        select
            provider as "gateway",
            1.0 * count(*) filter(where mu.has_error = true) / count(*) as "errorRate"
        from microdollar_usage_view
        where true
            and created_at >= now() - interval '10 minutes'
            and is_user_byok = false
            and provider in ('openrouter', 'vercel')
        group by provider
    `);
    return z
      .array(
        z.object({
          gateway: z.string(),
          errorRate: z.number(),
        })
      )
      .parse(rows);
  },
  undefined,
  { revalidate: 60 }
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
