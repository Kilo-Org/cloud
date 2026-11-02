import 'server-only';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { api_kind, enkrypt_usage, enkrypt_usage_decision } from '@kilocode/db/schema';
import type { EnkryptGuardrailApiKind, EnkryptGuardrailDecision } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { recordOrganizationConsumption } from '@kilocode/web-shared/lib/kilo-pass-org/consumption';
import {
  scheduleOrganizationLowBalanceAlert,
  scheduleOrganizationUsageAutoTopUp,
} from '@kilocode/web-shared/lib/organizations/organization-usage';

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

export type EnkryptGuardrailCharge = EnkryptGuardrailCall & {
  /** The request's wait for the verdict, on its final call only; see the ledger column. */
  addedLatencyMs: number | null;
};

export function enkryptCreditsToMicrodollars(creditsCost: number | null): number {
  if (creditsCost === null || !Number.isFinite(creditsCost) || creditsCost <= 0) return 0;
  return Math.round(creditsCost * MICRODOLLARS_PER_ENKRYPT_CREDIT);
}

/**
 * Writes the ledger row and debits the organization in one transaction, apart from inference
 * usage accounting. The debit is an atomic increment, so concurrent charges cannot lose updates,
 * and the ledger row's id is the consumption source id that makes a Kilo Pass debit idempotent.
 * Runs on the primary, so gateway callers must defer it with `after()`.
 */
export async function recordEnkryptGuardrailCharge(charge: EnkryptGuardrailCharge): Promise<void> {
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const chargedMicrodollars = enkryptCreditsToMicrodollars(charge.creditsCost);

  const organizationUsage = await db.transaction(async tx => {
    let [apiKind] = await tx
      .select({ id: api_kind.api_kind_id })
      .from(api_kind)
      .where(eq(api_kind.api_kind, charge.apiKind));
    if (!apiKind) {
      [apiKind] = await tx
        .insert(api_kind)
        .values({ api_kind: charge.apiKind })
        .onConflictDoNothing({ target: api_kind.api_kind })
        .returning({ id: api_kind.api_kind_id });
      if (!apiKind) {
        [apiKind] = await tx
          .select({ id: api_kind.api_kind_id })
          .from(api_kind)
          .where(eq(api_kind.api_kind, charge.apiKind));
      }
    }
    let [decision] = await tx
      .select({ id: enkrypt_usage_decision.decision_id })
      .from(enkrypt_usage_decision)
      .where(eq(enkrypt_usage_decision.decision, charge.decision));
    if (!decision) {
      [decision] = await tx
        .insert(enkrypt_usage_decision)
        .values({ decision: charge.decision })
        .onConflictDoNothing({ target: enkrypt_usage_decision.decision })
        .returning({ id: enkrypt_usage_decision.decision_id });
      if (!decision) {
        [decision] = await tx
          .select({ id: enkrypt_usage_decision.decision_id })
          .from(enkrypt_usage_decision)
          .where(eq(enkrypt_usage_decision.decision, charge.decision));
      }
    }
    if (!apiKind || !decision) throw new Error('Enkrypt usage lookup resolution failed');

    await tx.insert(enkrypt_usage).values({
      id,
      organization_id: charge.organizationId,
      kilo_user_id: charge.kiloUserId,
      session_id: charge.sessionId,
      api_kind_id: apiKind.id,
      decision_id: decision.id,
      enkrypt_credits_cost: charge.creditsCost,
      charged_microdollars: chargedMicrodollars,
      added_latency_ms: charge.addedLatencyMs,
      created_at: occurredAt,
    });
    if (chargedMicrodollars === 0) return null;
    const consumption = await recordOrganizationConsumption(tx, {
      organizationId: charge.organizationId,
      kiloUserId: charge.kiloUserId,
      amountMicrodollars: chargedMicrodollars,
      occurredAt,
      source: 'enkrypt-guardrail',
      sourceId: id,
    });
    return consumption.organizationUsage;
  });

  if (organizationUsage) {
    scheduleOrganizationLowBalanceAlert(charge.organizationId, organizationUsage);
    scheduleOrganizationUsageAutoTopUp(organizationUsage);
  }
}
