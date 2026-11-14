import 'server-only';
import { computeMemberIdSql } from '@kilocode/worker-utils/compute-member';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  kilocode_users,
} from '@kilocode/db/schema';
import type { db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import { CLOUD_AGENT_CONTAINER_SKUS } from '@kilocode/worker-utils/cloud-agent-compute';

type Database = typeof defaultDb;
export const COMPUTE_CHARGE_PAGE_SIZE = 100;
export const COMPUTE_CHARGE_MAX_PAGE = 20;
export const SESSION_COMPUTE_RUN_LIMIT = 10;

export async function readComputeRates(database: Database) {
  const rows = await database
    .select({
      skuId: cloud_billing_sku.id,
      rateCentsPerSecond: cloud_billing_sku.rate_cents_per_unit,
      available: cloud_billing_sku.accepts_new_usage,
    })
    .from(cloud_billing_sku)
    .where(
      and(
        inArray(cloud_billing_sku.id, Object.values(CLOUD_AGENT_CONTAINER_SKUS)),
        eq(cloud_billing_sku.unit, 'second')
      )
    );
  return Object.entries(CLOUD_AGENT_CONTAINER_SKUS).map(([instance, skuId]) => {
    const row = rows.find(row => row.skuId === skuId);
    return {
      instance,
      skuId,
      hourlyUsd: row === undefined ? null : Number(row.rateCentsPerSecond) * 36,
      available: row?.available ?? false,
    };
  });
}

export const computeChargeMemberId = computeMemberIdSql({
  actorType: container_usage_interval.actor_type,
  actorId: container_usage_interval.actor_id,
  metadata: container_usage_interval.metadata,
});

/** A sandbox is shared by the chats of a worktree, not billed separately per chat. */
export async function readSessionComputeCharges(
  database: Database,
  input: { kiloSessionId: string; userId: string; organizationId: string | null }
) {
  const scope = and(
    eq(cli_sessions_v2.kilo_user_id, input.userId),
    input.organizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : eq(cli_sessions_v2.organization_id, input.organizationId)
  );
  const [session] = await database
    .select({
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
    })
    .from(cli_sessions_v2)
    .where(and(scope, eq(cli_sessions_v2.session_id, input.kiloSessionId)))
    .limit(1);
  if (!session?.cloudAgentSessionId) return null;

  const sessions = database
    .select({ id: cli_sessions_v2.cloud_agent_session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        scope,
        session.worktreeId === null
          ? eq(cli_sessions_v2.cloud_agent_session_id, session.cloudAgentSessionId)
          : eq(cli_sessions_v2.cloud_agent_worktree_id, session.worktreeId)
      )
    );
  const interval = container_usage_interval;
  const charge = compute_usage_charge;
  const chargedRuns = database
    .select({
      id: interval.id,
      startedAt: interval.started_at,
      stoppedAt: interval.stopped_at,
      status: interval.status,
      skuId: interval.cloud_billing_sku_id,
      rateCentsPerSecond:
        sql<number>`coalesce(${interval.rate_cents_per_unit}, max(${charge.rate_cents_per_unit}))::double precision`.as(
          'rate_cents_per_second'
        ),
      seconds: sql<number>`sum(${charge.quantity})::double precision`.as('seconds'),
      amountMicrodollars: sql<number>`sum(${charge.amount_microdollars})::double precision`.as(
        'amount_microdollars'
      ),
    })
    .from(interval)
    .innerJoin(container_usage_segment, eq(container_usage_segment.interval_id, interval.id))
    .innerJoin(
      charge,
      and(
        eq(charge.usage_source, 'container_usage_segment'),
        eq(charge.usage_source_id, container_usage_segment.idempotency_key)
      )
    )
    .where(
      and(
        inArray(interval.session_id, sessions),
        input.organizationId === null
          ? eq(charge.user_id, input.userId)
          : and(
              eq(charge.organization_id, input.organizationId),
              eq(computeChargeMemberId, input.userId)
            )
      )
    )
    .groupBy(interval.id)
    .as('charged_runs');

  // One snapshot keeps the listed runs and the earlier-runs remainder reconciled with the total.
  const { total, runs } = await database.transaction(
    async tx => {
      const [total] = await tx
        .select({
          amountMicrodollars: sql<number>`coalesce(sum(${chargedRuns.amountMicrodollars}), 0)::double precision`,
          seconds: sql<number>`coalesce(sum(${chargedRuns.seconds}), 0)::double precision`,
          runCount: sql<number>`count(*)::integer`,
        })
        .from(chargedRuns);
      const runs = await tx
        .select()
        .from(chargedRuns)
        .orderBy(desc(chargedRuns.startedAt), desc(chargedRuns.id))
        .limit(SESSION_COMPUTE_RUN_LIMIT);
      return { total, runs };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );

  const totalAmount = total?.amountMicrodollars ?? 0;
  const totalSeconds = total?.seconds ?? 0;
  const earlierCount = (total?.runCount ?? 0) - runs.length;
  return {
    amountMicrodollars: totalAmount,
    seconds: totalSeconds,
    scope: session.worktreeId === null ? ('session' as const) : ('workspace' as const),
    runs: runs.map(run => ({
      startedAt: new Date(run.startedAt).toISOString(),
      stoppedAt: run.stoppedAt === null ? null : new Date(run.stoppedAt).toISOString(),
      running: run.status === 'open',
      instance: containerInstanceForSku(run.skuId),
      rateCentsPerSecond: run.rateCentsPerSecond,
      seconds: run.seconds,
      amountMicrodollars: run.amountMicrodollars,
    })),
    earlierRuns:
      earlierCount > 0
        ? {
            count: earlierCount,
            seconds: totalSeconds - runs.reduce((sum, run) => sum + run.seconds, 0),
            amountMicrodollars:
              totalAmount - runs.reduce((sum, run) => sum + run.amountMicrodollars, 0),
          }
        : null,
  };
}

export function containerInstanceForSku(skuId: string) {
  const entry = Object.entries(CLOUD_AGENT_CONTAINER_SKUS).find(([, id]) => id === skuId);
  return entry ? (entry[0] as keyof typeof CLOUD_AGENT_CONTAINER_SKUS) : null;
}

export async function readComputeCharges(
  database: Database,
  input: {
    scope:
      | { type: 'personal'; userId: string }
      | { type: 'organization'; organizationId: string; memberId?: string };
    startDate: string;
    endDate: string;
    groupBy: 'day' | 'session';
    page: number;
  }
) {
  const charge = compute_usage_charge;
  const interval = container_usage_interval;
  const dayBucket = sql<string>`to_char(${charge.created_at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const day = input.groupBy === 'day' ? dayBucket : sql<string>`min(${dayBucket})`;
  const sessionId =
    input.groupBy === 'session' ? interval.session_id : sql<string | null>`NULL::text`;
  const conditions: SQL[] = [
    gte(charge.created_at, input.startDate),
    lt(charge.created_at, input.endDate),
  ];
  if (input.scope.type === 'personal') {
    conditions.push(eq(charge.user_id, input.scope.userId));
  } else {
    conditions.push(eq(charge.organization_id, input.scope.organizationId));
    if (input.scope.memberId !== undefined)
      conditions.push(eq(computeChargeMemberId, input.scope.memberId));
  }
  const rows = await database
    .select({
      day,
      sessionId,
      memberId: computeChargeMemberId,
      memberName: kilocode_users.google_user_name,
      skuId: charge.cloud_billing_sku_id,
      skuName: cloud_billing_sku.name,
      rateCentsPerSecond: sql<number>`${charge.rate_cents_per_unit}::double precision`,
      seconds: sql<number>`sum(${charge.quantity})::double precision`,
      amountMicrodollars: sql<number>`sum(${charge.amount_microdollars})::double precision`,
    })
    .from(charge)
    .innerJoin(cloud_billing_sku, eq(cloud_billing_sku.id, charge.cloud_billing_sku_id))
    .leftJoin(
      container_usage_segment,
      and(
        eq(charge.usage_source, 'container_usage_segment'),
        eq(charge.usage_source_id, container_usage_segment.idempotency_key)
      )
    )
    .leftJoin(interval, eq(container_usage_segment.interval_id, interval.id))
    .leftJoin(kilocode_users, eq(kilocode_users.id, computeChargeMemberId))
    .where(and(...conditions))
    .groupBy(
      ...(input.groupBy === 'day' ? [dayBucket] : []),
      sessionId,
      computeChargeMemberId,
      kilocode_users.google_user_name,
      charge.cloud_billing_sku_id,
      cloud_billing_sku.name,
      charge.rate_cents_per_unit
    )
    .orderBy(
      desc(day),
      asc(sessionId),
      asc(computeChargeMemberId),
      asc(charge.cloud_billing_sku_id),
      asc(charge.rate_cents_per_unit)
    )
    .limit(COMPUTE_CHARGE_PAGE_SIZE + 1)
    .offset(input.page * COMPUTE_CHARGE_PAGE_SIZE);
  return {
    rows: rows.slice(0, COMPUTE_CHARGE_PAGE_SIZE),
    hasMore: input.page < COMPUTE_CHARGE_MAX_PAGE && rows.length > COMPUTE_CHARGE_PAGE_SIZE,
    truncated: input.page === COMPUTE_CHARGE_MAX_PAGE && rows.length > COMPUTE_CHARGE_PAGE_SIZE,
    payer:
      input.scope.type === 'personal'
        ? { type: 'user' as const, id: input.scope.userId }
        : { type: 'org' as const, id: input.scope.organizationId },
  };
}
