import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { CodingPlanId } from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import { coding_plan_key_inventory } from '@kilocode/db/schema';

export type ManualRevocationStatus = 'revocation_pending' | 'revocation_failed';

export async function listManualCredentialRevocations(input: {
  planId?: CodingPlanId;
  status?: ManualRevocationStatus;
}): Promise<
  Array<{
    inventoryKeyId: string;
    planId: string;
    providerId: string;
    upstreamPlanId: string;
    status: ManualRevocationStatus;
    revocationRequestedAt: string | null;
    revokedAt: string | null;
    revocationAttemptCount: number;
    lastRevocationError: string | null;
    updatedAt: string;
  }>
> {
  const rows = await db
    .select({
      inventoryKeyId: coding_plan_key_inventory.id,
      planId: coding_plan_key_inventory.plan_id,
      providerId: coding_plan_key_inventory.provider_id,
      upstreamPlanId: coding_plan_key_inventory.upstream_plan_id,
      status: coding_plan_key_inventory.status,
      revocationRequestedAt: coding_plan_key_inventory.revocation_requested_at,
      revokedAt: coding_plan_key_inventory.revoked_at,
      revocationAttemptCount: coding_plan_key_inventory.revocation_attempt_count,
      lastRevocationError: coding_plan_key_inventory.last_revocation_error,
      updatedAt: coding_plan_key_inventory.updated_at,
    })
    .from(coding_plan_key_inventory)
    .where(
      and(
        input.status
          ? eq(coding_plan_key_inventory.status, input.status)
          : inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed']),
        input.planId ? eq(coding_plan_key_inventory.plan_id, input.planId) : undefined
      )
    )
    .orderBy(desc(coding_plan_key_inventory.revocation_requested_at));

  return rows.map(row => ({
    ...row,
    status: row.status === 'revocation_failed' ? 'revocation_failed' : 'revocation_pending',
  }));
}

export async function markCredentialManuallyRevoked(inventoryKeyId: string): Promise<void> {
  const result = await db
    .update(coding_plan_key_inventory)
    .set({
      status: 'revoked',
      encrypted_api_key: null,
      revoked_at: sql`now()`,
      revocation_attempt_count: sql`${coding_plan_key_inventory.revocation_attempt_count} + 1`,
      last_revocation_error: null,
    })
    .where(
      and(
        eq(coding_plan_key_inventory.id, inventoryKeyId),
        inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed'])
      )
    );

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Credential is not eligible for manual revocation completion.');
  }
}

export async function markCredentialManualRevocationFailed(
  inventoryKeyId: string,
  reason: string
): Promise<void> {
  const sanitizedReason = sanitizeManualFailureReason(reason);
  const result = await db
    .update(coding_plan_key_inventory)
    .set({
      status: 'revocation_failed',
      encrypted_api_key: null,
      revocation_attempt_count: sql`${coding_plan_key_inventory.revocation_attempt_count} + 1`,
      last_revocation_error: sanitizedReason,
    })
    .where(
      and(
        eq(coding_plan_key_inventory.id, inventoryKeyId),
        inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed'])
      )
    );

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Credential is not eligible for manual revocation failure recording.');
  }
}

export async function requeueManualCredentialRevocation(inventoryKeyId: string): Promise<void> {
  const result = await db
    .update(coding_plan_key_inventory)
    .set({
      status: 'revocation_pending',
      encrypted_api_key: null,
      revocation_requested_at: sql`now()`,
      last_revocation_error: null,
    })
    .where(
      and(
        eq(coding_plan_key_inventory.id, inventoryKeyId),
        inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed'])
      )
    );

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Credential is not eligible for manual revocation requeue.');
  }
}

function sanitizeManualFailureReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('A sanitized failure reason is required.');
  }

  return normalized
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 300);
}
