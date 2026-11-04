import 'server-only';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { api_kind, enkrypt_usage, enkrypt_usage_decision } from '@kilocode/db/schema';
import type { EnkryptGuardrailApiKind, EnkryptGuardrailDecision } from '@kilocode/db/schema-types';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import { recordOrganizationConsumption } from '@kilocode/web-shared/lib/kilo-pass-org/consumption';
import {
  scheduleOrganizationLowBalanceAlert,
  scheduleOrganizationUsageAutoTopUp,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { recordEnkryptUsageInPrimaryRegion } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region';
import type {
  EnkryptUsageWrite,
  EnkryptUsageWriteResponse,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';

/**
 * PLACEHOLDER: Enkrypt documents Guardrails credits only as a monthly plan allowance, with no price
 * per credit, so Kilo's rate is not known yet. Replace this before the guardrail is enabled for any
 * organization that is not an internal test organization.
 */
export const MICRODOLLARS_PER_ENKRYPT_CREDIT = 100;

export type EnkryptGuardrailCall = {
  organizationId: string;
  kiloUserId: string;
  sessionId: string | null;
  apiKind: EnkryptGuardrailApiKind;
  decision: EnkryptGuardrailDecision;
  /** Enkrypt's `X-Enkrypt-Credits-Cost` header, or null when the call returned none. */
  creditsCost: number | null;
};

export type EnkryptUsageRecord = EnkryptGuardrailCall & {
  /** The request's wait for the verdict, on one call per request only; see the ledger column. */
  addedLatencyMs: number | null;
};

export function enkryptCreditsToMicrodollars(creditsCost: number | null): number {
  if (creditsCost === null || !Number.isFinite(creditsCost) || creditsCost <= 0) return 0;
  return Math.round(creditsCost * MICRODOLLARS_PER_ENKRYPT_CREDIT);
}

/**
 * In a US region the write is handed to Frankfurt, next to the primary, so its transaction neither
 * pays cross-region round trips nor holds a primary pool connection for them. A failed handoff
 * falls back to a local write; the usage id makes a repeated delivery a no-op. Gateway callers must
 * defer it with `after()`.
 */
export async function recordEnkryptUsage(usageRecord: EnkryptUsageRecord): Promise<void> {
  const usageWrite: EnkryptUsageWrite = {
    ...usageRecord,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
  if (isUSRegion() && (await recordEnkryptUsageInPrimaryRegion(usageWrite))) return;
  await recordEnkryptUsageLocally(usageWrite);
}

/**
 * Writes the ledger row and debits the organization in one transaction, apart from inference
 * usage accounting. The debit is an atomic increment, so concurrent debits cannot lose updates,
 * and the ledger row's id is the consumption source id that makes a Kilo Pass debit idempotent.
 * A ledger row that already exists means this record was delivered before, so nothing is debited.
 * Runs on the primary; gateway code calls `recordEnkryptUsage` instead.
 */
export async function recordEnkryptUsageLocally(
  usageWrite: EnkryptUsageWrite
): Promise<EnkryptUsageWriteResponse['status']> {
  const { id, occurredAt } = usageWrite;
  const chargedMicrodollars = enkryptCreditsToMicrodollars(usageWrite.creditsCost);

  const outcome = await db.transaction(async tx => {
    let [apiKind] = await tx
      .select({ id: api_kind.api_kind_id })
      .from(api_kind)
      .where(eq(api_kind.api_kind, usageWrite.apiKind));
    if (!apiKind) {
      [apiKind] = await tx
        .insert(api_kind)
        .values({ api_kind: usageWrite.apiKind })
        .onConflictDoNothing({ target: api_kind.api_kind })
        .returning({ id: api_kind.api_kind_id });
      if (!apiKind) {
        [apiKind] = await tx
          .select({ id: api_kind.api_kind_id })
          .from(api_kind)
          .where(eq(api_kind.api_kind, usageWrite.apiKind));
      }
    }
    let [decision] = await tx
      .select({ id: enkrypt_usage_decision.decision_id })
      .from(enkrypt_usage_decision)
      .where(eq(enkrypt_usage_decision.decision, usageWrite.decision));
    if (!decision) {
      [decision] = await tx
        .insert(enkrypt_usage_decision)
        .values({ decision: usageWrite.decision })
        .onConflictDoNothing({ target: enkrypt_usage_decision.decision })
        .returning({ id: enkrypt_usage_decision.decision_id });
      if (!decision) {
        [decision] = await tx
          .select({ id: enkrypt_usage_decision.decision_id })
          .from(enkrypt_usage_decision)
          .where(eq(enkrypt_usage_decision.decision, usageWrite.decision));
      }
    }
    if (!apiKind || !decision) throw new Error('Enkrypt usage lookup resolution failed');

    const [inserted] = await tx
      .insert(enkrypt_usage)
      .values({
        id,
        organization_id: usageWrite.organizationId,
        kilo_user_id: usageWrite.kiloUserId,
        session_id: usageWrite.sessionId,
        api_kind_id: apiKind.id,
        decision_id: decision.id,
        enkrypt_credits_cost: usageWrite.creditsCost,
        charged_microdollars: chargedMicrodollars,
        added_latency_ms: usageWrite.addedLatencyMs,
        created_at: occurredAt,
      })
      .onConflictDoNothing({ target: [enkrypt_usage.id, enkrypt_usage.created_at] })
      .returning({ id: enkrypt_usage.id });
    if (!inserted) return { status: 'duplicate' as const, organizationUsage: null };
    if (chargedMicrodollars === 0) return { status: 'recorded' as const, organizationUsage: null };
    const consumption = await recordOrganizationConsumption(tx, {
      organizationId: usageWrite.organizationId,
      kiloUserId: usageWrite.kiloUserId,
      amountMicrodollars: chargedMicrodollars,
      occurredAt,
      source: 'enkrypt-guardrail',
      sourceId: id,
    });
    return { status: 'recorded' as const, organizationUsage: consumption.organizationUsage };
  });

  if (outcome.organizationUsage) {
    scheduleOrganizationLowBalanceAlert(usageWrite.organizationId, outcome.organizationUsage);
    scheduleOrganizationUsageAutoTopUp(outcome.organizationUsage);
  }
  return outcome.status;
}
