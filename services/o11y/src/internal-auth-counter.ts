import {
  INTERNAL_AUTH_OBSERVATION_EVENT,
  INTERNAL_CALLERS,
} from '@kilocode/worker-utils/internal-auth-observation';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { z } from 'zod';
import { readO11ySecret } from './secrets';

/**
 * Item 9 of the secrets design (section 9.4), read side. `notifications` and `usage-ingest` have no
 * Logpush, so their `kilo_internal_auth` counter lines also become Analytics Engine data points in
 * the shared `kilo_internal_auth` dataset. This Worker already has Logpush and the Analytics Engine
 * SQL credentials its alerting uses, so once a minute it reads one closed window and writes the
 * same line shape to the log, where Logpush ships it to Axiom beside every other receiver's lines.
 *
 * A data point can reach Analytics Engine after the minute it counts for, so the reader runs two
 * minutes behind: it reads the window `[T-3m, T-2m)` for the cron's own scheduled time `T` (not the
 * wall clock when the query happens to run), so a slow alerting pass can neither skip a window nor
 * read a different one. Points that arrive later than two minutes are lost — the accepted trade for
 * a reader with no watermark. Rows are grouped by the data point's own `index1` minute, the true
 * bucket start, and each line carries its `window`: a duplicated cron retry repeats a
 * `(window, minute, receiver, route, auth, caller)` row with a count that can only grow, so the
 * gate takes `max(count)` per that key and then sums over windows, which stays exact either way.
 */
export type InternalAuthCounterEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_AE_API_TOKEN: SecretsStoreSecret;
};

/** The shared dataset both writers use; the reader never names a second one. */
const DATASET = 'kilo_internal_auth';

/** The only receivers this reader covers, so no other writer can reach Axiom through it. */
const RECEIVERS = ['notifications', 'usage-ingest'] as const;

const RowSchema = z.object({
  receiver: z.enum(RECEIVERS),
  route: z.string().regex(/^[a-z][a-z_]{0,63}$/),
  auth: z.enum(['legacy_shared_secret', 'sts']),
  caller: z
    .string()
    .refine(value => value === 'unknown' || INTERNAL_CALLERS.includes(value), 'caller'),
  accepted: z.union([z.number(), z.string()]),
  minute: z.union([z.number(), z.string()]),
  window: z.union([z.number(), z.string()]),
});

/**
 * The closed window this run reads: the minute starting three minutes before the scheduled time.
 * Epoch seconds, always a minute boundary, so the SQL is a literal integer and the line's `window`
 * is the same value.
 */
function windowStartSeconds(scheduledTimeMs: number): number {
  const threeMinutesMs = 3 * 60_000;
  return (Math.floor((scheduledTimeMs - threeMinutesMs) / 60_000) * 60_000) / 1000;
}

function sqlFor(windowStart: number): string {
  return `
	SELECT
		blob1 AS receiver,
		blob2 AS route,
		blob3 AS auth,
		blob4 AS caller,
		SUM(_sample_interval * double1) AS accepted,
		toUInt32(index1) AS minute
	FROM ${DATASET}
	WHERE timestamp >= toDateTime(${windowStart})
		AND timestamp < toDateTime(${windowStart + 60})
	GROUP BY receiver, route, auth, caller, minute
`;
}

function log(event: string, fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event, ...fields }));
  } catch {
    // Dropped; alerting and the cron are unaffected.
  }
}

/**
 * Reads one closed window from Analytics Engine and writes one `kilo_internal_auth` line per row.
 * Never throws: a failure is reported as one fixed line and the cron continues.
 */
export async function summarizeInternalAuthCounter(
  env: InternalAuthCounterEnv,
  ctx?: SecretsExecutionContext,
  scheduledTimeMs: number = Date.now()
): Promise<void> {
  const window = windowStartSeconds(scheduledTimeMs);
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
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sqlFor(window) }
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
    const row = RowSchema.safeParse({ window, ...(raw as Record<string, unknown>) });
    if (!row.success) {
      log('o11y_internal_auth_summary_failed', { reason: 'row' });
      continue;
    }
    const count = Math.round(Number(row.data.accepted));
    const minute = Math.round(Number(row.data.minute));
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(minute)) continue;
    log(INTERNAL_AUTH_OBSERVATION_EVENT, {
      v: 1,
      source: 'analytics_engine',
      receiver: row.data.receiver,
      route: row.data.route,
      auth: row.data.auth,
      caller: row.data.caller,
      count,
      minute,
      window: row.data.window,
    });
  }
}
