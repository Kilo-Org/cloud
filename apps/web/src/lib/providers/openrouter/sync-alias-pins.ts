import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  CustomRouterEntrySchema,
  MAX_ALIAS_PROMOTION_MODELS,
  type CustomRouterEntry,
  type CustomRouterServingPin,
} from '@kilocode/auto-routing-contracts';
import { LatestAliasTargetsConfigSchema, type LatestAliasTarget } from '@kilocode/db/schema-types';
import {
  latestAliasTargetsConfig,
  type LatestAliasTargets,
} from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  acquireAliasPromotion,
  releaseAliasPromotion,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { captureException } from '@sentry/nextjs';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { lockAliasPromotionExclusive } from '@/lib/auto-routing-custom-routers';

/** A move commits only while at least this much of the readiness lease remains. */
const LEASE_MARGIN_MS = 15_000;

const entriesSchema = z.array(CustomRouterEntrySchema);
const poolRowSchema = z.object({
  id: z.uuid(),
  base_router: z.string(),
  entries: entriesSchema,
});

type StableMove = { alias: string; previousTarget: string };

/**
 * The aliases whose stored stable target changes this cycle. The stored target is the alias's
 * authoritative previous target: a target that has since left the catalog still served
 * immediately before the move, so it stays a candidate and its pool keeps warning about the
 * retired target instead of silently following the new one.
 */
function stableMoves(
  previous: LatestAliasTargets,
  next: readonly LatestAliasTarget[]
): StableMove[] {
  const moves: StableMove[] = [];
  for (const entry of next) {
    const stored = previous.get(entry.alias);
    if (!stored || stored.target === entry.target) continue;
    moves.push({ alias: entry.alias, previousTarget: stored.target });
  }
  return moves;
}

function aliasTargetsIdentity(entries: readonly LatestAliasTarget[]): string {
  return JSON.stringify(
    [...entries].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
  );
}

type ReadinessFence = { ready: Set<string>; leaseUntil: number; release: () => Promise<void> };

async function clockMs(tx: DrizzleTransaction): Promise<number> {
  const result = await tx.execute(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`
  );
  return z.object({ now_ms: z.number() }).parse(result.rows[0]).now_ms;
}

/**
 * Takes the Worker's short readiness fence for every previous target and returns the ready
 * current-engine pairs. The same token covers every batch, and a retry never renews it, so all
 * batches read one stable registry snapshot. The caller must keep the fence until its database
 * transaction commits: releasing earlier would let the ready set change under the promotion.
 *
 * Returns null when another holder owns the fence, when the lease is already too close to expiry,
 * or when a read fails. An alias move then keeps the previous stable targets.
 */
async function readReadyPairs(models: readonly string[]): Promise<ReadinessFence | null> {
  const token = randomUUID();
  const ready = new Set<string>();
  let leaseUntil = 0;
  let held = false;
  const release = async () => {
    if (!held) return;
    held = false;
    await releaseAliasPromotion({ action: 'release', token }).catch((error: unknown) => {
      console.error('[sync-alias-pins] fence release failed; it expires on its own', error);
    });
  };
  try {
    for (let index = 0; index < models.length; index += MAX_ALIAS_PROMOTION_MODELS) {
      const batch = models.slice(index, index + MAX_ALIAS_PROMOTION_MODELS);
      const response = await acquireAliasPromotion({ action: 'acquire', token, models: batch });
      const body = response.body;
      if (response.status !== 200 || !('status' in body) || body.status !== 'held') {
        await release();
        return null;
      }
      held = true;
      leaseUntil = leaseUntil === 0 ? body.leaseUntil : Math.min(leaseUntil, body.leaseUntil);
      if (Date.now() + LEASE_MARGIN_MS > leaseUntil) {
        await release();
        return null;
      }
      for (const pair of body.ready) ready.add(`${pair.router}\u0000${pair.model}`);
    }
    if (!held) return null;
    return { ready, leaseUntil, release };
  } catch (error) {
    await release();
    console.error('[sync-alias-pins] readiness fence failed', error);
    captureException(error, { tags: { component: 'sync-alias-pins-fence' } });
    return null;
  }
}

/**
 * The entries after adding an observation for each entry whose alias moved and whose previous
 * target has a ready current-engine measurement. A link reuses a platform measurement and a
 * client-eval entry is measured per owner, so neither has a shared target to freeze. An existing
 * pin — confirmed or observed — is never rewritten.
 */
function pinMoves(
  entries: readonly CustomRouterEntry[],
  baseRouter: string,
  movesByAlias: ReadonlyMap<string, StableMove>,
  ready: ReadonlySet<string>,
  pinnedAt: string
): CustomRouterEntry[] | null {
  let changed = false;
  const next = entries.map(entry => {
    const move = movesByAlias.get(entry.model);
    if (!move || entry.kind !== 'gateway') return entry;
    if (entry.measuredAs !== undefined || isDirectByokModelId(entry.model)) return entry;
    if (entry.servingPin) return entry;
    if (!ready.has(`${baseRouter}\u0000${move.previousTarget}`)) return entry;
    const servingPin: CustomRouterServingPin = {
      model: move.previousTarget,
      pinnedAt,
      source: 'observed',
    };
    changed = true;
    return { ...entry, servingPin };
  });
  return changed ? next : null;
}

/**
 * Reads the pools that still hold one of the moved aliases. `@> ANY(...)` is the form the GIN
 * index serves; an `OR` chain of member checks plans as a scan.
 */
async function readCandidatePools(
  tx: DrizzleTransaction,
  aliases: readonly string[]
): Promise<z.infer<typeof poolRowSchema>[]> {
  const containments = aliases.map(alias => JSON.stringify([{ kind: 'gateway', model: alias }]));
  const result = await tx.execute(sql`
    SELECT id, base_router, entries
    FROM auto_routing_custom_routers
    WHERE entries @> ANY (${sql.param(containments)}::jsonb[])
  `);
  return z.array(poolRowSchema).parse(result.rows);
}

/**
 * Writes every observed pin and the new alias targets in one statement. `guard` reads the database
 * clock once and both data-changing CTEs share it, so the promotion either lands all of its work
 * inside the readiness deadline or writes nothing and the transaction rolls back.
 *
 * On PostgreSQL 17+ the enclosing transaction carries a matching `transaction_timeout`. On 16,
 * where that setting does not exist, the same guarantee holds from three bounds: this in-statement
 * deadline (evaluated as the statement runs, immediately before its writes), `statement_timeout`
 * and `lock_timeout` for a statement that runs long, and `idle_in_transaction_session_timeout` so
 * a client that stalls between the statement and its COMMIT is disconnected and the work rolled
 * back rather than committing late.
 */
async function commitPromotion(
  tx: DrizzleTransaction,
  params: {
    updates: { id: string; entries: CustomRouterEntry[] }[];
    aliases: readonly LatestAliasTarget[];
    deadlineMs: number | null;
  }
): Promise<{ pinned: number; written: boolean }> {
  const value = latestAliasTargetsConfig(params.aliases);
  const result = await tx.execute(sql`
    WITH guard AS MATERIALIZED (
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms
    ),
    patch AS (
      SELECT id, entries
      FROM jsonb_to_recordset(${JSON.stringify(params.updates)}::jsonb) AS rows(id uuid, entries jsonb)
    ),
    pinned AS (
      UPDATE auto_routing_custom_routers AS router
      SET entries = patch.entries
      FROM patch, guard
      WHERE router.id = patch.id
        AND (${params.deadlineMs}::float8 IS NULL OR guard.now_ms <= ${params.deadlineMs}::float8)
      RETURNING router.id
    ),
    stored AS (
      INSERT INTO ai_gateway_config (id, latest_alias_targets)
      SELECT 1, ${JSON.stringify(value)}::jsonb
      FROM guard
      WHERE (${params.deadlineMs}::float8 IS NULL OR guard.now_ms <= ${params.deadlineMs}::float8)
      ON CONFLICT (id) DO UPDATE SET latest_alias_targets = EXCLUDED.latest_alias_targets
      RETURNING 1 AS stored
    )
    SELECT (SELECT count(*) FROM pinned)::int AS pinned,
           (SELECT count(*) FROM stored)::int AS stored
  `);
  const row = z.object({ pinned: z.number(), stored: z.number() }).parse(result.rows[0]);
  return { pinned: row.pinned, written: row.stored === 1 };
}

/**
 * Commits the stored alias targets, with the concrete target each affected pool was already
 * serving when an alias moved. The observation is written in the move's own transaction, before
 * the target config changes, so a pool that never opens between another pool's shared measurement
 * and the move still serves the target it measured.
 *
 * The transaction takes the promotion lock exclusively and compares the stored targets against the
 * ones this run generated from. Any refusal — the readiness fence is held elsewhere, its lease is
 * near expiry, a readiness read fails, a pool writer or another sync moved the targets first —
 * writes nothing and keeps the previous stable targets, so serving never drifts and no pool gains
 * a history it did not have.
 */
export async function promoteAliasTargets(params: {
  next: readonly LatestAliasTarget[];
  previous: LatestAliasTargets;
}): Promise<{ written: boolean; observed: number }> {
  const moves = stableMoves(params.previous, params.next);
  const aliases = moves.map(move => move.alias);
  const movesByAlias = new Map(moves.map(move => [move.alias, move] as const));
  const previousTargets = [...new Set(moves.map(move => move.previousTarget))].sort();
  const fence = previousTargets.length > 0 ? await readReadyPairs(previousTargets) : null;
  if (previousTargets.length > 0 && !fence) return { written: false, observed: 0 };

  const expectedIdentity = aliasTargetsIdentity([...params.previous.values()]);
  try {
    const outcome = await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '10s'`));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '10s'`));
      // A stalled client between the writing statement and its COMMIT must not commit past the
      // deadline on PostgreSQL 16, which has no whole-transaction bound.
      await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '2s'`));
      await lockAliasPromotionExclusive(tx);

      const [current] = await tx
        .select({ config: ai_gateway_config.latest_alias_targets })
        .from(ai_gateway_config)
        .where(eq(ai_gateway_config.id, 1))
        .limit(1);
      const stored = current?.config ? LatestAliasTargetsConfigSchema.parse(current.config) : null;
      if (aliasTargetsIdentity(stored?.aliases ?? []) !== expectedIdentity) {
        throw new Error('stored alias targets changed under the promotion');
      }

      if (!fence) {
        const committed = await commitPromotion(tx, {
          updates: [],
          aliases: params.next,
          deadlineMs: null,
        });
        return committed.written ? 0 : null;
      }

      const before = await clockMs(tx);
      const deadline = fence.leaseUntil - LEASE_MARGIN_MS;
      if (before > deadline) return null;
      const setting = await tx.execute(
        sql`SELECT current_setting('transaction_timeout', true) AS setting`
      );
      if (z.object({ setting: z.string().nullable() }).parse(setting.rows[0]).setting) {
        const seconds = Math.max(1, Math.ceil((deadline - before) / 1000));
        await tx.execute(sql.raw(`SET LOCAL transaction_timeout = '${seconds}s'`));
      }

      const pinnedAt = new Date(before).toISOString();
      const updates = (await readCandidatePools(tx, aliases)).flatMap(row => {
        const entries = pinMoves(row.entries, row.base_router, movesByAlias, fence.ready, pinnedAt);
        return entries ? [{ id: row.id, entries }] : [];
      });
      const committed = await commitPromotion(tx, {
        updates,
        aliases: params.next,
        deadlineMs: deadline,
      });
      return committed.written ? committed.pinned : null;
    });
    return outcome === null
      ? { written: false, observed: 0 }
      : { written: true, observed: outcome };
  } catch (error) {
    console.warn(
      '[sync-alias-pins] promotion failed or outlived its readiness lease; keeping the previous targets',
      error
    );
    captureException(error, { tags: { component: 'sync-alias-pins-transaction' } });
    return { written: false, observed: 0 };
  } finally {
    await fence?.release();
  }
}
