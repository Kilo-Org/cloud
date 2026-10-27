import { randomUUID } from 'node:crypto';
import { enkrypt_guardrail_scan_log, type NewEnkryptGuardrailScanLog } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { recordOrganizationConsumption } from '@kilocode/web-shared/lib/kilo-pass-org/consumption';
import { scheduleOrganizationLowBalanceAlert } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  estimateEnkryptCredits,
  MAX_SCAN_TEXT_CHARS,
  type EnkryptDetectOutcome,
  type ScanDirection,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/enkrypt-detect';

/**
 * PLACEHOLDER: the price Kilo charges per Enkrypt guardrail credit. Replace with
 * the contracted Enkrypt rate (plus any margin) before enabling for customers.
 */
export const ENKRYPT_CREDIT_PRICE_MICRODOLLARS = 100;

export type EnkryptScanCharge = {
  enkryptCredits: number | null;
  estimated: boolean;
  costMicrodollars: number;
};

/**
 * Charges only for successful scans, using Enkrypt's reported cost when present.
 * Enkrypt does not charge for rejected requests such as a 402. The charge never
 * exceeds the documented maximum for the direction's detectors, so a malformed
 * header cannot debit an arbitrary amount; the reported credits are still stored.
 */
export function computeEnkryptScanCharge(
  outcome: Pick<EnkryptDetectOutcome, 'httpStatus' | 'creditsCost'>,
  direction: ScanDirection,
  textChars: number
): EnkryptScanCharge {
  const succeeded =
    outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300;
  if (!succeeded) {
    return { enkryptCredits: outcome.creditsCost, estimated: false, costMicrodollars: 0 };
  }
  const estimated = outcome.creditsCost === null;
  const enkryptCredits = outcome.creditsCost ?? estimateEnkryptCredits(direction, textChars);
  const billedCredits = Math.min(
    enkryptCredits,
    estimateEnkryptCredits(direction, MAX_SCAN_TEXT_CHARS)
  );
  return {
    enkryptCredits,
    estimated,
    costMicrodollars: billedCredits * ENKRYPT_CREDIT_PRICE_MICRODOLLARS,
  };
}

export type EnkryptGuardrailScanRecord = Omit<
  NewEnkryptGuardrailScanLog,
  'id' | 'created_at' | 'charged_to_balance'
>;

/** Writes the scan row and its organization debit atomically, like `recordExaUsage`. */
export async function recordEnkryptGuardrailScan(scan: EnkryptGuardrailScanRecord): Promise<void> {
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const charged = scan.cost_microdollars > 0;

  const organizationUsage = await db.transaction(async tx => {
    await tx.insert(enkrypt_guardrail_scan_log).values({
      ...scan,
      id,
      created_at: occurredAt,
      charged_to_balance: charged,
    });
    if (!charged) return null;
    const result = await recordOrganizationConsumption(tx, {
      organizationId: scan.organization_id,
      kiloUserId: scan.kilo_user_id,
      amountMicrodollars: scan.cost_microdollars,
      occurredAt,
      source: 'enkrypt-guardrails',
      sourceId: id,
    });
    return result.organizationUsage;
  });

  if (organizationUsage) {
    scheduleOrganizationLowBalanceAlert(scan.organization_id, organizationUsage);
  }
}
