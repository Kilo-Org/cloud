import { readDb, sql } from '@/lib/drizzle';
import { unstable_cache } from 'next/cache';
import * as z from 'zod';

const getGatewayErrorRate_cached = unstable_cache(
  async () => {
    console.debug(`[getGatewayErrorRate_cached] refreshing at ${new Date().toISOString()}`);
    // Use EXISTS instead of JOIN to force a semi-join plan (PK lookup per row)
    // rather than hash-joining the entire microdollar_usage_metadata table.
    const { rows } = await readDb.execute(sql`
        select
            mu.provider as "gateway",
            1.0 * count(*) filter(where mu.has_error = true) / count(*) as "errorRate"
        from microdollar_usage mu
        where true
            and mu.created_at >= now() - interval '10 minutes'
            and mu.provider in ('openrouter', 'vercel')
            and exists (
                select 1 from microdollar_usage_metadata meta
                where meta.id = mu.id and meta.is_user_byok = false
            )
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
  { revalidate: 60 }
);

export async function getGatewayErrorRate() {
  const start = performance.now();
  try {
    const result = await getGatewayErrorRate_cached();
    console.debug(`[getGatewayErrorRate] query success after ${performance.now() - start}ms`);
    return {
      openrouter: result.find(r => r.gateway === 'openrouter')?.errorRate ?? 0,
      vercel: result.find(r => r.gateway === 'vercel')?.errorRate ?? 0,
    };
  } catch (e) {
    console.debug(`[getGatewayErrorRate] query error after ${performance.now() - start}ms`, e);
  }
  return {
    openrouter: 0,
    vercel: 0,
  };
}
