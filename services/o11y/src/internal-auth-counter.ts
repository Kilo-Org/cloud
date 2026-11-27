import { INTERNAL_AUTH_OBSERVATION_EVENT } from '@kilocode/worker-utils/internal-auth-observation';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { z } from 'zod';
import { readO11ySecret } from './secrets';

/**
 * Item 9 of the secrets design (section 9.4), read side. `notifications` and `usage-ingest` have no
 * Logpush, so their `kilo_internal_auth` counter lines also become Analytics Engine data points in
 * the shared `kilo_internal_auth` dataset. This Worker already has Logpush and the Analytics Engine
 * SQL credentials its alerting uses, so once a minute it reads the closed minute and writes the
 * same line shape to the log, where Logpush ships it to Axiom beside every other receiver's lines.
 *
 * A data point can reach Analytics Engine after the minute it counts for, so the reader runs one
 * minute behind and groups by the point's own `index1` minute (the true bucket start) rather than by
 * arrival time. It reads the window `[now-3m, now-2m)` once, so a point that arrives later than two
 * minutes is lost — the accepted trade for a query that never needs a watermark. A duplicated cron
 * run emits the same `window` again; the gate takes `max(count)` per
 * `(window, minute, receiver, route, auth, caller)` and then sums over windows, which stays exact.
 */
export type InternalAuthCounterEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_AE_API_TOKEN: SecretsStoreSecret;
};

/** The shared dataset both writers use; the reader never names a second one. */
const DATASET = 'kilo_internal_auth';

const RowSchema = z.object({
  receiver: z.string(),
  route: z.string(),
  auth: z.string(),
  caller: z.string(),
  accepted: z.union([z.number(), z.string()]),
  minute: z.union([z.number(), z.string()]),
  window: z.union([z.number(), z.string()]),
});

const SQL = `
	SELECT
		blob1 AS receiver,
		blob2 AS route,
		blob3 AS auth,
		blob4 AS caller,
		SUM(_sample_interval * double1) AS accepted,
		toUInt64OrZero(index1) AS minute,
		toUnixTimestamp(toStartOfInterval(NOW() - INTERVAL '3' MINUTE, INTERVAL '1' MINUTE)) AS window
	FROM ${DATASET}
	WHERE timestamp >= toStartOfInterval(NOW() - INTERVAL '3' MINUTE, INTERVAL '1' MINUTE)
		AND timestamp < toStartOfInterval(NOW() - INTERVAL '2' MINUTE, INTERVAL '1' MINUTE)
	GROUP BY receiver, route, auth, caller, minute, window
`;

function log(event: string, fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event, ...fields }));
  } catch {
    // Dropped; alerting and the cron are unaffected.
  }
}

/**
 * Reads the closed minute from Analytics Engine and writes one `kilo_internal_auth` line per row.
 * Never throws: a failure is reported as one fixed line and the cron continues.
 */
export async function summarizeInternalAuthCounter(
  env: InternalAuthCounterEnv,
  ctx?: SecretsExecutionContext
): Promise<void> {
  let token: string;
  try {
    token = await readO11ySecret(env, 'O11Y_CF_AE_API_TOKEN', ctx);
  } catch {
    log('o11y_internal_auth_summary_failed', { reason: 'token' });
    return;
  }
  let rows: unknown[];
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: SQL }
    );
    if (!response.ok) {
      log('o11y_internal_auth_summary_failed', { reason: 'query', status: response.status });
      return;
    }
    const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(await response.json());
    if (!parsed.success) {
      log('o11y_internal_auth_summary_failed', { reason: 'shape' });
      return;
    }
    rows = parsed.data.data;
  } catch {
    log('o11y_internal_auth_summary_failed', { reason: 'fetch' });
    return;
  }

  for (const raw of rows) {
    const row = RowSchema.safeParse(raw);
    if (!row.success) {
      log('o11y_internal_auth_summary_failed', { reason: 'row' });
      continue;
    }
    const count = Math.round(Number(row.data.accepted));
    const minute = Math.round(Number(row.data.minute));
    const window = Math.round(Number(row.data.window));
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(minute)) continue;
    if (!Number.isFinite(window)) continue;
    log(INTERNAL_AUTH_OBSERVATION_EVENT, {
      v: 1,
      source: 'analytics_engine',
      receiver: row.data.receiver,
      route: row.data.route,
      auth: row.data.auth,
      caller: row.data.caller,
      count,
      minute,
      window,
    });
  }
}
