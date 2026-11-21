import {
  ALIAS_PROMOTION_LEASE_MS,
  AUTO_ROUTERS,
  type AliasPromotionAcquireResponse,
  type AliasPromotionReadyPair,
  type AutoRouter,
} from '@kilocode/auto-routing-contracts';
import { ALIAS_READINESS_DB_NOW_MS_SQL, ALIAS_READINESS_LEASE_ID } from './alias-readiness-lease';

export { ALIAS_READINESS_LEASE_ID };

/**
 * Dedicated lease row of `scheduler_dispatch_lock`. Rows 1-3 belong to dispatch passes, run
 * initialization and a deploy's intent; this fence owns row 4, so neither side waits on the
 * other's token. No migration: the table already allows any integer id. The row id and the
 * database-clock expression come from `src/alias-readiness-lease.ts`, which the ready-publication
 * guard also reads, so the writer and every deferred publication agree on one clock.
 */

/** SQLite's own clock in epoch milliseconds, so a Worker isolate's clock never decides a lease. */
const DB_NOW_MS = ALIAS_READINESS_DB_NOW_MS_SQL;

/**
 * Takes row 4 for the fixed lease window. The database clock decides both the conflict and the
 * new expiry. A retry of the same token while its lease is live returns that lease unchanged; the
 * same token after expiry is refused, because an attempt whose fence lapsed must not resume under
 * the token it minted. Only another token (or a released row) may take an expired lease.
 */
export const ACQUIRE_ALIAS_PROMOTION_LEASE_SQL = `
  INSERT INTO scheduler_dispatch_lock (id, token, lease_until)
  VALUES (${ALIAS_READINESS_LEASE_ID}, ?1, ${DB_NOW_MS} + ${ALIAS_PROMOTION_LEASE_MS})
  ON CONFLICT (id) DO UPDATE SET
    token = excluded.token,
    lease_until = CASE
      WHEN scheduler_dispatch_lock.token = excluded.token
        AND scheduler_dispatch_lock.lease_until > ${DB_NOW_MS}
      THEN scheduler_dispatch_lock.lease_until
      ELSE excluded.lease_until
    END
  WHERE (scheduler_dispatch_lock.lease_until > ${DB_NOW_MS}
      AND scheduler_dispatch_lock.token = excluded.token)
    OR (scheduler_dispatch_lock.lease_until <= ${DB_NOW_MS}
      AND scheduler_dispatch_lock.token IS NOT excluded.token)
  RETURNING token, lease_until
`;

/** Releases only the caller's own token; another holder's fence is never cleared. */
export const RELEASE_ALIAS_PROMOTION_LEASE_SQL = `
  UPDATE scheduler_dispatch_lock SET token = NULL, lease_until = 0
  WHERE id = ${ALIAS_READINESS_LEASE_ID} AND token = ?1
`;

/**
 * Ready, currently measured registry pairs among the asked concrete ids. `?1` is a JSON array of
 * those ids and `?2` a JSON array of each base router's live engine identity and repetition count.
 * Readiness comes from the registry alone: no catalog and no network, so a target the catalog has
 * since retired still reports the measurement that exists for it.
 */
export const ALIAS_PROMOTION_READY_PAIRS_SQL = `
  SELECT DISTINCT profile.router, profile.model
  FROM benchmark_profiles AS profile
  WHERE profile.status = 'ready'
    AND profile.run_id IS NOT NULL
    AND profile.model IN (SELECT wanted.value FROM json_each(?1) AS wanted)
    AND EXISTS (
      SELECT 1 FROM json_each(?2) AS current
      WHERE json_extract(current.value, '$.router') = profile.router
        AND json_extract(current.value, '$.engine_identity') = profile.engine_identity
        AND json_extract(current.value, '$.repetitions') = profile.repetitions
    )
  ORDER BY profile.router, profile.model
`;

type AliasPromotionRow = {
  token?: unknown;
  lease_until?: unknown;
  router?: unknown;
  model?: unknown;
};

/**
 * The live measurement identity of each base router: the engine the deployed dataset and grading
 * produce, and the decider repetition count that identity was measured with. `ready` means ready
 * under exactly this pair, so a row measured by an older engine never reports as promoted.
 */
export type AliasPromotionProfileIdentity = {
  router: AutoRouter;
  engine_identity: string;
  repetitions: number;
};

function isAutoRouter(value: unknown): value is AutoRouter {
  return AUTO_ROUTERS.some(router => router === value);
}

function readyPairs(rows: readonly AliasPromotionRow[]): AliasPromotionReadyPair[] {
  return rows.flatMap(row =>
    isAutoRouter(row.router) && typeof row.model === 'string'
      ? [{ router: row.router, model: row.model }]
      : []
  );
}

/**
 * One D1 batch: the lease write and the readiness read commit or fail together, so a holder never
 * reads readiness under a fence it does not own. A busy fence answers `busy` and its readiness read
 * is discarded — the caller must not act on readiness without holding the lease.
 */
export async function acquireAliasPromotionLease(
  db: D1Database,
  token: string,
  models: readonly string[],
  currentIdentities: readonly AliasPromotionProfileIdentity[]
): Promise<AliasPromotionAcquireResponse> {
  const wanted = JSON.stringify([...new Set(models)]);
  const current = JSON.stringify(currentIdentities);
  const [leaseResult, readyResult] = await db.batch<AliasPromotionRow>([
    db.prepare(ACQUIRE_ALIAS_PROMOTION_LEASE_SQL).bind(token),
    db.prepare(ALIAS_PROMOTION_READY_PAIRS_SQL).bind(wanted, current),
  ]);
  const lease = leaseResult?.results[0];
  if (!lease || typeof lease.lease_until !== 'number') return { status: 'busy' };
  return {
    status: 'held',
    leaseUntil: lease.lease_until,
    ready: readyPairs(readyResult?.results ?? []),
  };
}

export async function releaseAliasPromotionLease(db: D1Database, token: string): Promise<void> {
  await db.prepare(RELEASE_ALIAS_PROMOTION_LEASE_SQL).bind(token).run();
}
