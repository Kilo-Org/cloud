import 'server-only';

import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  api_kind,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_detector,
  enkrypt_usage_guardrail,
} from '@kilocode/db/schema';
import type {
  EnkryptDetectorId,
  EnkryptGuardrailApiKind,
  EnkryptGuardrailDecision,
  EnkryptGuardrailDirection,
} from '@kilocode/db/schema-types';
import { db, isUSRegion, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { recordOrganizationConsumption } from '@kilocode/web-shared/lib/kilo-pass-org/consumption';
import {
  scheduleOrganizationLowBalanceAlert,
  scheduleOrganizationUsageAutoTopUp,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { recordEnkryptUsageInPrimaryRegion } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-primary-region';
import type {
  EnkryptUsageWrite,
  EnkryptUsageWriteInput,
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
  microdollarUsageId?: string;
  apiKind: EnkryptGuardrailApiKind;
  decision: EnkryptGuardrailDecision;
  /** Enkrypt's `X-Enkrypt-Credits-Cost` header, or null when the call returned none. */
  creditsCost: number | null;
  /**
   * The detectors that fired on this call, blocking or log-only. A log-only detection is an
   * `allowed` call with detectors here.
   */
  detectorsFired?: EnkryptDetectorId[];
};

export type EnkryptUsageRecord = EnkryptGuardrailCall & {
  /** The request's wait for the verdict, on one call per request only; see the ledger column. */
  addedLatencyMs: number | null;
  /** Defaults to the input guardrail. */
  guardrail?: EnkryptGuardrailDirection;
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
  const { guardrail = 'input', detectorsFired = [], ...call } = usageRecord;
  const [firstDetector, ...otherDetectors] = detectorsFired;
  const usageWrite: EnkryptUsageWriteInput = {
    ...call,
    // Input calls and calls without a detection omit these fields, so a web app deployed before
    // them still accepts the write.
    ...(guardrail === 'output' ? { guardrail } : {}),
    ...(firstDetector ? { detectorsFired: [firstDetector, ...otherDetectors] } : {}),
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
  if (isUSRegion() && (await recordEnkryptUsageInPrimaryRegion(usageWrite))) return;
  await recordEnkryptUsageLocally({ ...usageWrite, guardrail });
}

/**
 * The id of a lookup value, inserting it when it is new. A concurrent insert of the same value
 * makes the insert return nothing, so the value is read again.
 */
async function lookupId(
  select: () => Promise<{ id: number }[]>,
  insert: () => Promise<{ id: number }[]>
): Promise<number> {
  const [row] = await select();
  if (row) return row.id;
  const [inserted] = await insert();
  if (inserted) return inserted.id;
  const [concurrent] = await select();
  if (!concurrent) throw new Error('Enkrypt usage lookup resolution failed');
  return concurrent.id;
}

/**
 * The lookup ids of the detectors, in their order, inserting the new ones. An insert that conflicts
 * with a concurrent one waits for it, so reading again afterwards finds every detector. New
 * detectors are inserted sorted, so concurrent inserts of the same detectors cannot deadlock.
 */
async function detectorIds(
  tx: DrizzleTransaction,
  detectors: readonly EnkryptDetectorId[]
): Promise<number[]> {
  const select = () =>
    tx
      .select({ id: enkrypt_usage_detector.detector_id, detector: enkrypt_usage_detector.detector })
      .from(enkrypt_usage_detector)
      .where(inArray(enkrypt_usage_detector.detector, [...detectors]));
  const distinct = [...new Set(detectors)].sort();
  let rows = await select();
  if (rows.length < distinct.length) {
    await tx
      .insert(enkrypt_usage_detector)
      .values(distinct.map(detector => ({ detector })))
      .onConflictDoNothing({ target: enkrypt_usage_detector.detector });
    rows = await select();
  }
  const ids = new Map(rows.map(row => [row.detector, row.id]));
  return detectors.map(detector => {
    const id = ids.get(detector);
    if (id === undefined) throw new Error('Enkrypt usage detector lookup resolution failed');
    return id;
  });
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
    const apiKindId = await lookupId(
      () =>
        tx
          .select({ id: api_kind.api_kind_id })
          .from(api_kind)
          .where(eq(api_kind.api_kind, usageWrite.apiKind)),
      () =>
        tx
          .insert(api_kind)
          .values({ api_kind: usageWrite.apiKind })
          .onConflictDoNothing({ target: api_kind.api_kind })
          .returning({ id: api_kind.api_kind_id })
    );
    const decisionId = await lookupId(
      () =>
        tx
          .select({ id: enkrypt_usage_decision.decision_id })
          .from(enkrypt_usage_decision)
          .where(eq(enkrypt_usage_decision.decision, usageWrite.decision)),
      () =>
        tx
          .insert(enkrypt_usage_decision)
          .values({ decision: usageWrite.decision })
          .onConflictDoNothing({ target: enkrypt_usage_decision.decision })
          .returning({ id: enkrypt_usage_decision.decision_id })
    );
    const guardrailId = await lookupId(
      () =>
        tx
          .select({ id: enkrypt_usage_guardrail.guardrail_id })
          .from(enkrypt_usage_guardrail)
          .where(eq(enkrypt_usage_guardrail.guardrail, usageWrite.guardrail)),
      () =>
        tx
          .insert(enkrypt_usage_guardrail)
          .values({ guardrail: usageWrite.guardrail })
          .onConflictDoNothing({ target: enkrypt_usage_guardrail.guardrail })
          .returning({ id: enkrypt_usage_guardrail.guardrail_id })
    );
    const firedDetectorIds = usageWrite.detectorsFired?.length
      ? await detectorIds(tx, usageWrite.detectorsFired)
      : null;

    const [inserted] = await tx
      .insert(enkrypt_usage)
      .values({
        id,
        organization_id: usageWrite.organizationId,
        kilo_user_id: usageWrite.kiloUserId,
        session_id: usageWrite.sessionId,
        microdollar_usage_id: usageWrite.microdollarUsageId ?? null,
        api_kind_id: apiKindId,
        decision_id: decisionId,
        enkrypt_credits_cost: usageWrite.creditsCost,
        charged_microdollars: chargedMicrodollars,
        added_latency_ms: usageWrite.addedLatencyMs,
        guardrail_id: guardrailId,
        fired_detector_ids: firedDetectorIds,
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
