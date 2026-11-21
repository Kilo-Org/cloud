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
import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { lockAliasPromotionExclusive, lockPoolOwners } from '@/lib/auto-routing-custom-routers';
import type { CustomRouterOwner } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';

/** A move commits only while at least this much of the readiness lease remains. */
const LEASE_MARGIN_MS = 15_000;

const entriesSchema = z.array(CustomRouterEntrySchema);
const candidatePoolSchema = z.object({
  id: z.uuid(),
  base_router: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_id: z.string(),
  entries: entriesSchema,
});
type CandidatePool = z.infer<typeof candidatePoolSchema>;

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

/**
 * Names one stored alias-target set: order-independent, so a re-render of the same targets is the
 * same set. The promotion compares it to detect another run's move, and the snapshot write compares
 * it to refuse publishing a snapshot rendered from targets the database has since replaced.
 */
export function aliasTargetsIdentity(entries: readonly LatestAliasTarget[]): string {
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
 * The condition that finds every pool still holding one of `aliases`, in the one bound array the
 * caller passes.
 *
 * `@> ANY(...)` is the form the GIN index serves: on PostgreSQL 16.16 a promotion with two aliases
 * over 20,000 analyzed pools planned a Bitmap Index Scan on
 * `IDX_auto_routing_custom_routers_entries`, with the whole `ANY` predicate in its Index Cond. An
 * `OR` chain of member checks also uses that index, as a BitmapOr, so neither form scans; one bound
 * array keeps the statement a single round trip.
 */
export function candidatePoolCondition(aliases: readonly string[]): SQL {
  const containments = aliases.map(alias => JSON.stringify([{ kind: 'gateway', model: alias }]));
  return sql`entries @> ANY (${sql.param(containments)}::jsonb[])`;
}

/** The owners of the pools that still hold one of the moved aliases. */
async function readCandidateOwners(
  tx: DrizzleTransaction,
  aliases: readonly string[]
): Promise<CustomRouterOwner[]> {
  const result = await tx.execute(sql`
    SELECT owned_by_user_id, owned_by_organization_id
    FROM auto_routing_custom_routers
    WHERE ${candidatePoolCondition(aliases)}
    GROUP BY owned_by_user_id, owned_by_organization_id
  `);
  const rows = z
    .array(
      z.object({
        owned_by_user_id: z.string().nullable(),
        owned_by_organization_id: z.string().nullable(),
      })
    )
    .parse(result.rows);
  return rows.map(row => {
    if (row.owned_by_organization_id) {
      return { type: 'org' as const, id: row.owned_by_organization_id };
    }
    if (row.owned_by_user_id) return { type: 'user' as const, id: row.owned_by_user_id };
    throw new Error('A pool that holds a moved alias has no owner');
  });
}

function ownerKey(owner: CustomRouterOwner): string {
  return `${owner.type}\u0000${owner.id}`;
}

function rowOwner(row: CandidatePool): CustomRouterOwner {
  return { type: row.owner_type, id: row.owner_id };
}

/**
 * Takes every candidate pool's owner lock, then reads the candidate rows and proves each row's
 * owner was locked before it was read.
 *
 * A save from a deployed instance of the previous release takes that same lock, re-reads the pool
 * inside its transaction and stores what it read; without this, such a save could commit between
 * this read and the pin write and erase the pin. A pool created after the owners were discovered is
 * read but not covered, so the loop re-reads and retries with the new owners; after three passes it
 * refuses rather than pinning a row whose owner lock it does not hold.
 */
async function lockOwnersAndReadCandidates(
  tx: DrizzleTransaction,
  aliases: readonly string[]
): Promise<CandidatePool[]> {
  const locked = new Set<string>();
  for (let pass = 0; pass < 3; pass += 1) {
    const owners = await readCandidateOwners(tx, aliases);
    await lockPoolOwners(
      tx,
      owners.filter(owner => !locked.has(ownerKey(owner)))
    );
    for (const owner of owners) locked.add(ownerKey(owner));
    // Only rows whose owner lock this transaction already holds are covered. A pool created
    // between the discovery and this read is read again after its owner is locked, so no row is
    // pinned without being ordered against the writer that saves it.
    const rows = await readCandidatePools(tx, aliases);
    if (rows.every(row => locked.has(ownerKey(rowOwner(row))))) return rows;
  }
  throw new Error('the pools holding a moved alias kept changing under the promotion');
}

/**
 * Reads the pools that still hold one of the moved aliases, locking each row until the transaction
 * ends and reporting each row's owner so the caller can prove it holds that owner's lock.
 *
 * The row locks make this read-then-write pin atomic against a writer that takes none of the alias
 * promotion locks — an instance of the previous deploy during a rolling deploy rewrites the whole
 * `entries` document, so a pin computed from the version it replaced would silently revert that
 * edit. The caller also takes every candidate owner's `lockOwner` key, the same lock that instance
 * takes before it re-reads a pool, so neither side can overwrite the other.
 */
async function readCandidatePools(
  tx: DrizzleTransaction,
  aliases: readonly string[]
): Promise<CandidatePool[]> {
  const result = await tx.execute(sql`
    SELECT id,
           base_router,
           CASE WHEN owned_by_organization_id IS NULL THEN 'user' ELSE 'org' END AS owner_type,
           coalesce(owned_by_organization_id::text, owned_by_user_id) AS owner_id,
           entries
    FROM auto_routing_custom_routers
    WHERE ${candidatePoolCondition(aliases)}
    FOR UPDATE
  `);
  return z.array(candidatePoolSchema).parse(result.rows);
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
 * The targets a promotion leaves stored. A caller renders its snapshot from these, so the snapshot
 * names the target the database holds rather than one a competing run replaced meanwhile.
 */
export type AliasPromotionResult = {
  written: boolean;
  observed: number;
  /**
   * The stored targets under the same exclusive lock that would have written them: `next` when the
   * promotion committed, otherwise what another run left. Null only when the promotion could not
   * read them at all, so the caller must read the primary itself.
   */
  targets: readonly LatestAliasTarget[] | null;
};

/**
 * Commits the stored alias targets, with the concrete target each affected pool was already
 * serving when an alias moved. The observation is written in the move's own transaction, before
 * the target config changes, so a pool that never opens between another pool's shared measurement
 * and the move still serves the target it measured.
 *
 * The transaction takes the promotion lock exclusively and compares the stored targets against the
 * ones this run generated from. Any refusal — the readiness fence is held elsewhere, its lease is
 * near expiry, a readiness read fails, another sync moved the targets first — writes nothing and
 * keeps the previous stable targets, so serving never drifts and no pool gains a history it did
 * not have.
 */
export async function promoteAliasTargets(params: {
  next: readonly LatestAliasTarget[];
  previous: LatestAliasTargets;
}): Promise<AliasPromotionResult> {
  const moves = stableMoves(params.previous, params.next);
  const aliases = moves.map(move => move.alias);
  const movesByAlias = new Map(moves.map(move => [move.alias, move] as const));
  const previousTargets = [...new Set(moves.map(move => move.previousTarget))].sort();
  const fence = previousTargets.length > 0 ? await readReadyPairs(previousTargets) : null;
  if (previousTargets.length > 0 && !fence) {
    // Nothing was read under the lock yet; the caller reads the stored targets before publishing.
    return { written: false, observed: 0, targets: null };
  }

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
      const storedTargets = stored?.aliases ?? [];
      // Another sync committed first. Its targets are the ones the pool writers and this run's
      // snapshot must both name.
      if (aliasTargetsIdentity(storedTargets) !== expectedIdentity) {
        return { pinned: null, targets: storedTargets };
      }

      if (!fence) {
        const committed = await commitPromotion(tx, {
          updates: [],
          aliases: params.next,
          deadlineMs: null,
        });
        // A guard that withheld this write leaves the rows just read: `storedTargets`.
        return committed.written
          ? { pinned: 0, targets: params.next }
          : { pinned: null, targets: storedTargets };
      }

      const before = await clockMs(tx);
      const deadline = fence.leaseUntil - LEASE_MARGIN_MS;
      if (before > deadline) return { pinned: null, targets: storedTargets };
      const setting = await tx.execute(
        sql`SELECT current_setting('transaction_timeout', true) AS setting`
      );
      if (z.object({ setting: z.string().nullable() }).parse(setting.rows[0]).setting) {
        const seconds = Math.max(1, Math.ceil((deadline - before) / 1000));
        await tx.execute(sql.raw(`SET LOCAL transaction_timeout = '${seconds}s'`));
      }

      const pinnedAt = new Date(before).toISOString();
      // Take the same owner locks an ordinary save takes, then read the rows under them. This
      // orders the pin write against a deployed instance of the previous release, which re-reads a
      // pool under its owner lock and would otherwise save an `entries` document without the pin.
      const updates = (await lockOwnersAndReadCandidates(tx, aliases)).flatMap(row => {
        const entries = pinMoves(row.entries, row.base_router, movesByAlias, fence.ready, pinnedAt);
        return entries ? [{ id: row.id, entries }] : [];
      });
      const committed = await commitPromotion(tx, {
        updates,
        aliases: params.next,
        deadlineMs: deadline,
      });
      return committed.written
        ? { pinned: committed.pinned, targets: params.next }
        : { pinned: null, targets: storedTargets };
    });
    return outcome.pinned === null
      ? { written: false, observed: 0, targets: outcome.targets }
      : { written: true, observed: outcome.pinned, targets: outcome.targets };
  } catch (error) {
    console.warn(
      '[sync-alias-pins] promotion failed or outlived its readiness lease; keeping the previous targets',
      error
    );
    captureException(error, { tags: { component: 'sync-alias-pins-transaction' } });
    return { written: false, observed: 0, targets: null };
  } finally {
    await fence?.release();
  }
}
