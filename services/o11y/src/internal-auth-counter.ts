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
 * Exactly one closed minute per run, so a receiver's row is emitted once: the window starts at the
 * previous minute boundary and ends at the current one. A duplicated cron run can emit that minute
 * twice; the gate reads `max(count)` per (minute, receiver, route, auth, caller) for these two
 * receivers, which stays exact either way.
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
});

const SQL = `
	SELECT
		blob1 AS receiver,
		blob2 AS route,
		blob3 AS auth,
		blob4 AS caller,
		SUM(_sample_interval * double1) AS accepted,
		toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '1' MINUTE)) AS minute
	FROM ${DATASET}
	WHERE timestamp >= toStartOfInterval(NOW() - INTERVAL '1' MINUTE, INTERVAL '1' MINUTE)
		AND timestamp < toStartOfInterval(NOW(), INTERVAL '1' MINUTE)
	GROUP BY receiver, route, auth, caller, minute
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
    });
  }
}
