import 'server-only';

import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { operation_ledgers, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

import { stopKiloClawStripeRenewal } from './stop-stripe-renewal';

const DOMAIN = 'admin_kiloclaw_stripe_renewals' as const;
const HEADER_INTENT = 'batch_header';
const ITEM_INTENT = 'batch_item';
const PREVIEW_LIFETIME_MS = 15 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 40 * 1000;
const MAX_ATTEMPTS = 3;
const WORK_BUDGET_MS = 45 * 1000;
const SETTLEMENT_RESERVE_MS = 5 * 1000;
const PAGE_SIZE = 500;
const FAILURE_LIMIT = 100;

export type StripeRenewalBatchActor = { id: string; email: string; name: string | null };

type HeaderResult = {
  type: 'header';
  state: 'preview' | 'running' | 'completed' | 'failed';
  actor: StripeRenewalBatchActor;
  initiator: StripeRenewalBatchActor;
  previewExpiresAt: string;
  startedAt?: string;
  retriedAt?: string;
  reason?: string;
};

type ItemResult = {
  type: 'item';
  stripeSubscriptionId: string;
  state: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  claimToken?: string;
  nextAttemptAt?: string;
  error?: string;
};

type BatchHeader = typeof operation_ledgers.$inferSelect & {
  resource_key: string;
  canonical_result: HeaderResult;
};
type BatchItem = typeof operation_ledgers.$inferSelect & {
  resource_key: string;
  canonical_result: ItemResult;
};

function headerKey(id: string) {
  return `kiloclaw-stripe-renewals:${id}`;
}

function itemKey(previewId: string, stripeSubscriptionId: string) {
  return `${headerKey(previewId)}:${stripeSubscriptionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHeader(row: typeof operation_ledgers.$inferSelect): BatchHeader | null {
  const value = row.canonical_result;
  if (
    !isRecord(value) ||
    value.type !== 'header' ||
    !['preview', 'running', 'completed', 'failed'].includes(String(value.state)) ||
    !isRecord(value.actor) ||
    typeof value.actor.id !== 'string' ||
    typeof value.actor.email !== 'string' ||
    (typeof value.actor.name !== 'string' && value.actor.name !== null) ||
    !isRecord(value.initiator) ||
    typeof value.initiator.id !== 'string' ||
    typeof value.initiator.email !== 'string' ||
    (typeof value.initiator.name !== 'string' && value.initiator.name !== null) ||
    typeof value.previewExpiresAt !== 'string' ||
    typeof row.resource_key !== 'string'
  ) {
    return null;
  }
  return row as BatchHeader;
}

function parseItem(row: typeof operation_ledgers.$inferSelect): BatchItem | null {
  const value = row.canonical_result;
  if (
    !isRecord(value) ||
    value.type !== 'item' ||
    typeof value.stripeSubscriptionId !== 'string' ||
    !['pending', 'processing', 'completed', 'failed'].includes(String(value.state)) ||
    typeof value.attempts !== 'number' ||
    typeof row.resource_key !== 'string'
  ) {
    return null;
  }
  return row as BatchItem;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function retryAt(attempt: number) {
  return new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** attempt)).toISOString();
}

async function lockBatch(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  await tx.execute(
    sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-kiloclaw-stripe-renewals', 0))`
  );
}

export async function createStripeRenewalBatchPreview(actor: StripeRenewalBatchActor) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString();
  const subscriptions: Array<{ userId: string; stripeSubscriptionId: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const page = await db
      .select({
        id: kiloclaw_subscriptions.id,
        userId: kiloclaw_subscriptions.user_id,
        stripeSubscriptionId: kiloclaw_subscriptions.stripe_subscription_id,
      })
      .from(kiloclaw_subscriptions)
      .where(
        cursor
          ? and(
              isNotNull(kiloclaw_subscriptions.stripe_subscription_id),
              gt(kiloclaw_subscriptions.id, cursor)
            )
          : isNotNull(kiloclaw_subscriptions.stripe_subscription_id)
      )
      .orderBy(asc(kiloclaw_subscriptions.id))
      .limit(PAGE_SIZE);
    subscriptions.push(
      ...page.flatMap(row =>
        row.stripeSubscriptionId
          ? [{ userId: row.userId, stripeSubscriptionId: row.stripeSubscriptionId }]
          : []
      )
    );
    if (page.length < PAGE_SIZE) break;
    cursor = page.at(-1)?.id ?? null;
  }

  await db.transaction(async tx => {
    await lockBatch(tx);
    await tx.insert(operation_ledgers).values({
      operation_key: headerKey(id),
      domain: DOMAIN,
      intent: HEADER_INTENT,
      kilo_user_id: actor.id,
      resource_key: id,
      taxonomy: 'safe-retry',
      status: 'admitted',
      canonical_result: {
        type: 'header',
        state: 'preview',
        actor,
        initiator: actor,
        previewExpiresAt: expiresAt,
      } satisfies HeaderResult,
      admitted_at: now.toISOString(),
      lease_expires_at: expiresAt,
      expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
    });
    for (let offset = 0; offset < subscriptions.length; offset += PAGE_SIZE) {
      const rows = subscriptions.slice(offset, offset + PAGE_SIZE);
      await tx.insert(operation_ledgers).values(
        rows.map(subscription => ({
          operation_key: itemKey(id, subscription.stripeSubscriptionId),
          domain: DOMAIN,
          intent: ITEM_INTENT,
          kilo_user_id: subscription.userId,
          resource_key: id,
          provider_ref: subscription.stripeSubscriptionId,
          taxonomy: 'safe-retry' as const,
          status: 'admitted',
          canonical_result: {
            type: 'item',
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            state: 'pending',
            attempts: 0,
          } satisfies ItemResult,
          admitted_at: now.toISOString(),
          lease_expires_at: now.toISOString(),
          expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
        }))
      );
    }
  });

  return { id, total: subscriptions.length };
}

export async function startStripeRenewalBatch(params: {
  previewId: string;
  actor: StripeRenewalBatchActor;
  reason: string;
}) {
  return db.transaction(async tx => {
    await lockBatch(tx);
    const [stored] = await tx
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, HEADER_INTENT),
          eq(operation_ledgers.resource_key, params.previewId),
          eq(operation_ledgers.kilo_user_id, params.actor.id)
        )
      )
      .for('update')
      .limit(1);
    const header = stored ? parseHeader(stored) : null;
    if (!header) throw new Error('Preview not found');
    if (
      header.canonical_result.state === 'preview' &&
      Date.parse(header.canonical_result.previewExpiresAt) < Date.now()
    ) {
      throw new Error('Preview has expired');
    }
    if (
      header.canonical_result.state === 'running' ||
      header.canonical_result.state === 'completed' ||
      header.canonical_result.state === 'failed'
    ) {
      return { id: params.previewId };
    }
    const running = await tx
      .select({ id: operation_ledgers.resource_key })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, HEADER_INTENT),
          eq(operation_ledgers.status, 'admitted'),
          sql`${operation_ledgers.canonical_result}->>'state' = 'running'`
        )
      )
      .limit(1);
    if (running[0]) throw new Error('Another Stripe renewal batch is already running');
    await tx
      .update(operation_ledgers)
      .set({
        canonical_result: {
          ...header.canonical_result,
          state: 'running',
          reason: params.reason,
          startedAt: new Date().toISOString(),
        },
        lease_expires_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
      })
      .where(eq(operation_ledgers.id, header.id));
    return { id: params.previewId };
  });
}

export async function retryStripeRenewalBatch(runId: string, actor: StripeRenewalBatchActor) {
  return db.transaction(async tx => {
    await lockBatch(tx);
    const [stored] = await tx
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.resource_key, runId),
          eq(operation_ledgers.intent, HEADER_INTENT)
        )
      )
      .for('update')
      .limit(1);
    const header = stored ? parseHeader(stored) : null;
    if (!header) throw new Error('Run not found');
    if (header.canonical_result.state === 'preview') {
      throw new Error('Preview has not been started');
    }
    if (header.canonical_result.state === 'running') return { id: runId };
    const active = await tx
      .select({ id: operation_ledgers.resource_key })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, HEADER_INTENT),
          sql`${operation_ledgers.canonical_result}->>'state' = 'running'`
        )
      )
      .limit(1);
    if (active[0] && active[0].id !== runId)
      throw new Error('Another Stripe renewal batch is already running');
    const failed = await tx
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, ITEM_INTENT),
          eq(operation_ledgers.resource_key, runId),
          eq(operation_ledgers.status, 'failed')
        )
      )
      .for('update');
    if (failed.length === 0) return { id: runId };
    for (const row of failed) {
      const item = parseItem(row);
      if (!item) continue;
      await tx
        .update(operation_ledgers)
        .set({
          status: 'admitted',
          settled_at: null,
          outcome_code: null,
          lease_expires_at: new Date().toISOString(),
          canonical_result: {
            ...item.canonical_result,
            state: 'pending',
            attempts: 0,
            error: undefined,
            nextAttemptAt: undefined,
            claimToken: undefined,
          },
        })
        .where(eq(operation_ledgers.id, item.id));
    }
    await tx
      .update(operation_ledgers)
      .set({
        status: 'admitted',
        settled_at: null,
        outcome_code: null,
        canonical_result: {
          ...header.canonical_result,
          state: 'running',
          actor,
          retriedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        },
      })
      .where(eq(operation_ledgers.id, header.id));
    return { id: runId };
  });
}

async function claimNextItem(header: BatchHeader) {
  return db.transaction(async tx => {
    await lockBatch(tx);
    const [current] = await tx
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, header.id))
      .for('update')
      .limit(1);
    const currentHeader = current ? parseHeader(current) : null;
    if (currentHeader?.canonical_result.state !== 'running') return null;
    const candidates = await tx
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, ITEM_INTENT),
          eq(operation_ledgers.resource_key, header.resource_key),
          eq(operation_ledgers.status, 'admitted'),
          sql`${operation_ledgers.lease_expires_at} <= now()`,
          sql`((${operation_ledgers.canonical_result}->>'nextAttemptAt') is null or (${operation_ledgers.canonical_result}->>'nextAttemptAt')::timestamptz <= now())`
        )
      )
      .orderBy(asc(operation_ledgers.admitted_at), asc(operation_ledgers.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const item = candidates[0] ? parseItem(candidates[0]) : null;
    if (!item) return null;
    if (item.canonical_result.attempts >= MAX_ATTEMPTS) {
      await tx
        .update(operation_ledgers)
        .set({
          status: 'failed',
          outcome_code: 'claim_lease_expired',
          settled_at: new Date().toISOString(),
          canonical_result: {
            ...item.canonical_result,
            state: 'failed',
            claimToken: undefined,
            error: 'Claim lease expired after the maximum number of attempts',
          },
        })
        .where(
          and(
            eq(operation_ledgers.id, item.id),
            eq(operation_ledgers.status, 'admitted'),
            sql`${operation_ledgers.lease_expires_at} <= now()`
          )
        );
      return { row: null, exhausted: true };
    }
    const claimToken = crypto.randomUUID();
    const claimed: ItemResult = {
      ...item.canonical_result,
      state: 'processing',
      attempts: item.canonical_result.attempts + 1,
      claimToken,
      nextAttemptAt: undefined,
    };
    const [updated] = await tx
      .update(operation_ledgers)
      .set({
        canonical_result: claimed,
        lease_expires_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
      })
      .where(
        and(
          eq(operation_ledgers.id, item.id),
          eq(operation_ledgers.status, 'admitted'),
          sql`${operation_ledgers.lease_expires_at} <= now()`
        )
      )
      .returning();
    return updated
      ? { row: parseItem(updated), claimToken, actor: currentHeader.canonical_result.actor }
      : null;
  });
}

async function settleClaim(params: {
  item: BatchItem;
  claimToken: string;
  outcome?: string;
  error?: string;
}) {
  const current = params.item.canonical_result;
  const terminal = params.error && current.attempts >= MAX_ATTEMPTS;
  const result: ItemResult = params.error
    ? terminal
      ? { ...current, state: 'failed', error: params.error, claimToken: undefined }
      : {
          ...current,
          state: 'pending',
          error: params.error,
          nextAttemptAt: retryAt(current.attempts),
          claimToken: undefined,
        }
    : { ...current, state: 'completed', claimToken: undefined, nextAttemptAt: undefined };
  await db
    .update(operation_ledgers)
    .set({
      status: terminal || !params.error ? (terminal ? 'failed' : 'completed') : 'admitted',
      outcome_code: params.outcome ?? (terminal ? 'failed' : null),
      settled_at: terminal || !params.error ? new Date().toISOString() : null,
      canonical_result: result,
      lease_expires_at:
        params.error && !terminal
          ? new Date().toISOString()
          : new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
    })
    .where(
      and(
        eq(operation_ledgers.id, params.item.id),
        eq(operation_ledgers.status, 'admitted'),
        sql`${operation_ledgers.canonical_result}->>'claimToken' = ${params.claimToken}`
      )
    );
}

async function finishIfSettled(header: BatchHeader) {
  await db.transaction(async tx => {
    await lockBatch(tx);
    const [stored] = await tx
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, header.id))
      .for('update')
      .limit(1);
    const current = stored ? parseHeader(stored) : null;
    if (!current || current.canonical_result.state !== 'running') return;
    const pending = await tx
      .select({ id: operation_ledgers.id })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, ITEM_INTENT),
          eq(operation_ledgers.resource_key, current.resource_key),
          eq(operation_ledgers.status, 'admitted')
        )
      )
      .limit(1);
    if (pending[0]) return;
    const failed = await tx
      .select({ id: operation_ledgers.id })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, ITEM_INTENT),
          eq(operation_ledgers.resource_key, current.resource_key),
          eq(operation_ledgers.status, 'failed')
        )
      )
      .limit(1);
    await tx
      .update(operation_ledgers)
      .set({
        status: failed[0] ? 'failed' : 'completed',
        settled_at: new Date().toISOString(),
        canonical_result: {
          ...current.canonical_result,
          state: failed[0] ? 'failed' : 'completed',
        },
      })
      .where(and(eq(operation_ledgers.id, current.id), eq(operation_ledgers.status, 'admitted')));
  });
}

export async function runStripeRenewalBatches() {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + WORK_BUDGET_MS;
  const effectDeadlineAtMs = deadlineAtMs - SETTLEMENT_RESERVE_MS;
  let processed = 0;
  while (Date.now() < effectDeadlineAtMs) {
    const headers = await db
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, DOMAIN),
          eq(operation_ledgers.intent, HEADER_INTENT),
          eq(operation_ledgers.status, 'admitted'),
          sql`${operation_ledgers.canonical_result}->>'state' = 'running'`
        )
      )
      .orderBy(asc(operation_ledgers.admitted_at))
      .limit(1);
    const header = headers[0] ? parseHeader(headers[0]) : null;
    if (!header) break;
    const claim = await claimNextItem(header);
    if (!claim?.row) {
      if (claim?.exhausted) continue;
      await finishIfSettled(header);
      break;
    }
    const item = claim.row;
    try {
      const outcome = await stopKiloClawStripeRenewal({
        stripeSubscriptionId: item.canonical_result.stripeSubscriptionId,
        actor: claim.actor,
        runId: header.resource_key,
        deadlineAtMs: Math.min(effectDeadlineAtMs, Date.now() + 20_000),
      });
      await settleClaim({ item, claimToken: claim.claimToken, outcome: outcome.outcome });
    } catch (error) {
      await settleClaim({ item, claimToken: claim.claimToken, error: errorMessage(error) });
    }
    processed += 1;
  }
  return { processed };
}

export async function getStripeRenewalBatchStatus() {
  const rows = await db
    .select()
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.domain, DOMAIN),
        eq(operation_ledgers.intent, HEADER_INTENT),
        sql`${operation_ledgers.canonical_result}->>'state' <> 'preview'`
      )
    )
    .orderBy(
      sql`case when ${operation_ledgers.canonical_result}->>'state' = 'running' then 0 else 1 end`,
      sql`coalesce(${operation_ledgers.canonical_result}->>'startedAt', ${operation_ledgers.admitted_at}::text) desc`
    )
    .limit(1);
  const header = rows[0] ? parseHeader(rows[0]) : null;
  if (!header) return { run: null };
  const scope = and(
    eq(operation_ledgers.domain, DOMAIN),
    eq(operation_ledgers.intent, ITEM_INTENT),
    eq(operation_ledgers.resource_key, header.resource_key)
  );
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      updated: sql<number>`count(*) filter (where ${operation_ledgers.status} = 'completed' and ${operation_ledgers.outcome_code} = 'updated')::int`,
      skipped: sql<number>`count(*) filter (where ${operation_ledgers.status} = 'completed' and ${operation_ledgers.outcome_code} <> 'updated')::int`,
      failed: sql<number>`count(*) filter (where ${operation_ledgers.status} = 'failed')::int`,
    })
    .from(operation_ledgers)
    .where(scope);
  const failedItems = await db
    .select()
    .from(operation_ledgers)
    .where(and(scope, eq(operation_ledgers.status, 'failed')))
    .orderBy(asc(operation_ledgers.admitted_at), asc(operation_ledgers.id))
    .limit(FAILURE_LIMIT);
  const failures = failedItems.flatMap(row => {
    const item = parseItem(row);
    return item
      ? [
          {
            stripeSubscriptionId: item.canonical_result.stripeSubscriptionId,
            error: item.canonical_result.error ?? 'Unknown failure',
          },
        ]
      : [];
  });
  const total = counts?.total ?? 0;
  const updated = counts?.updated ?? 0;
  const skipped = counts?.skipped ?? 0;
  const failed = counts?.failed ?? 0;
  return {
    run: {
      id: header.resource_key,
      status:
        header.canonical_result.state === 'running'
          ? 'running'
          : header.canonical_result.state === 'failed'
            ? 'failed'
            : 'completed',
      total,
      processed: updated + skipped + failed,
      updated,
      skipped,
      failed,
      failures,
    },
  };
}
