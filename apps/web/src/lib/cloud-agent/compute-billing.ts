import 'server-only';
import { computeMemberIdSql } from '@kilocode/worker-utils/compute-member';
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
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
    hasMore: rows.length > COMPUTE_CHARGE_PAGE_SIZE,
    payer:
      input.scope.type === 'personal'
        ? { type: 'user' as const, id: input.scope.userId }
        : { type: 'org' as const, id: input.scope.organizationId },
  };
}
