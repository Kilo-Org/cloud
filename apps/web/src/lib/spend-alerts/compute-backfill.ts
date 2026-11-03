import 'server-only';

import { sql } from 'drizzle-orm';
import { compute_usage_charge } from '@kilocode/db/schema';
import type { db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import { rollupWindowStart, sweepHourlyBuckets } from './sweep';

/** Rebuild affected payers separately so locks are released between scopes. */
export async function backfillComputeSpendAlerts(
  database: typeof defaultDb,
  now = new Date(),
  options: { afterScope?: string; onProgress?: (scope: string) => void } = {}
) {
  const from = rollupWindowStart(now, 720);
  let cursor = options.afterScope ?? '';
  let rebuiltScopes = 0;
  for (;;) {
    const scopes = await database.execute<{ scope_key: string }>(sql`
      WITH scopes AS (
        SELECT DISTINCT CASE
          WHEN ${compute_usage_charge.organization_id} IS NULL
            THEN 'user:' || ${compute_usage_charge.user_id}
          ELSE 'org:' || ${compute_usage_charge.organization_id}
        END AS scope_key
        FROM ${compute_usage_charge}
        WHERE ${compute_usage_charge.created_at} >= ${from}
          AND ${compute_usage_charge.created_at} <= ${now}
      )
      SELECT scope_key FROM scopes WHERE scope_key > ${cursor}
      ORDER BY scope_key LIMIT 100
    `);
    if (scopes.rows.length === 0) break;
    for (const { scope_key: scopeKey } of scopes.rows) {
      await sweepHourlyBuckets(database, { lookbackHours: 720, now, scopeKey });
      rebuiltScopes += 1;
      cursor = scopeKey;
      options.onProgress?.(cursor);
    }
  }
  return { rebuiltScopes, afterScope: cursor };
}
