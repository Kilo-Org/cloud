import 'server-only';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
} from '@kilocode/db/schema';
import type { db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { fetchWithinBudget } from '@/lib/bounded-service-fetch';

type BillingOwner = { type: 'user' | 'org'; id: string };

export async function isCodeReviewComputeBillingEnabled(owner: BillingOwner): Promise<boolean> {
  const baseUrl = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');
  if (!baseUrl) throw new Error('Cloud Agent billing status is unavailable');
  const response = await fetchWithinBudget(
    `${baseUrl}/internal/code-review/billing/${owner.type}/${encodeURIComponent(owner.id)}`,
    { headers: { 'x-internal-api-key': INTERNAL_API_SECRET }, cache: 'no-store' }
  );
  if (!response.ok) throw new Error('Cloud Agent billing status is unavailable');
  return z.object({ enabled: z.boolean() }).parse(await response.json()).enabled;
}

export async function readCodeReviewContainerCost(
  database: typeof defaultDb,
  owner: BillingOwner,
  sessionIds: string[]
): Promise<number | null> {
  if (sessionIds.length === 0) return null;
  const [result] = await database
    .select({
      amount: sql<
        number | null
      >`sum(${compute_usage_charge.amount_microdollars})::double precision`,
    })
    .from(container_usage_interval)
    .innerJoin(
      container_usage_segment,
      eq(container_usage_segment.interval_id, container_usage_interval.id)
    )
    .innerJoin(
      compute_usage_charge,
      and(
        eq(compute_usage_charge.usage_source, 'container_usage_segment'),
        eq(compute_usage_charge.usage_source_id, container_usage_segment.idempotency_key)
      )
    )
    .where(
      and(
        inArray(container_usage_interval.session_id, sessionIds),
        owner.type === 'org'
          ? eq(compute_usage_charge.organization_id, owner.id)
          : eq(compute_usage_charge.user_id, owner.id)
      )
    );
  return result?.amount ?? null;
}
