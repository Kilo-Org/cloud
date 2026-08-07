import 'server-only';

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { codingPlanCredentialFingerprint } from '@/lib/coding-plans/credential-fingerprint';
import {
  getCodingPlanValidationResult,
  type CodingPlanCredentialValidationInput,
  type CodingPlanCredentialValidationResult,
  validateCodingPlanCredential,
} from '@/lib/coding-plans/inventory-validation';
import { getCodingPlanPrice, isCodingPlanId, type CodingPlanId } from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import { coding_plan_key_inventory, coding_plan_subscriptions } from '@kilocode/db/schema';

export type ManualRevocationStatus = 'revocation_pending' | 'revocation_failed';

type InventoryCredentialValidator = (
  input: CodingPlanCredentialValidationInput
) => Promise<CodingPlanCredentialValidationResult | boolean>;

type ManualCredentialReplacementOptions = {
  validateCredential?: InventoryCredentialValidator;
};

export class ManualCredentialReplacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualCredentialReplacementError';
  }
}

function replacementError(message: string): ManualCredentialReplacementError {
  return new ManualCredentialReplacementError(message);
}

function databaseConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('constraint' in current && typeof current.constraint === 'string') {
      return current.constraint;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

export async function listManualCredentialRevocations(input: {
  planId?: CodingPlanId;
  status?: ManualRevocationStatus;
}): Promise<
  Array<{
    inventoryKeyId: string;
    planId: string;
    providerId: string;
    upstreamPlanId: string | null;
    status: ManualRevocationStatus;
    revocationRequestedAt: string | null;
    subscriptionExpiresAt: string | null;
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
      subscriptionExpiresAt: coding_plan_subscriptions.current_period_end,
      revokedAt: coding_plan_key_inventory.revoked_at,
      revocationAttemptCount: coding_plan_key_inventory.revocation_attempt_count,
      lastRevocationError: coding_plan_key_inventory.last_revocation_error,
      updatedAt: coding_plan_key_inventory.updated_at,
    })
    .from(coding_plan_key_inventory)
    .leftJoin(
      coding_plan_subscriptions,
      eq(coding_plan_subscriptions.key_inventory_id, coding_plan_key_inventory.id)
    )
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
    // BytePlus stores the admin-supplied username in this column. It is only
    // needed for server-side seat resolution and must never reach the admin UI.
    upstreamPlanId: row.providerId === 'byteplus-coding' ? null : row.upstreamPlanId,
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

export async function replaceManualCredentialRevocation(
  inventoryKeyId: string,
  apiKey: string,
  options: ManualCredentialReplacementOptions = {}
): Promise<void> {
  if (!BYOK_ENCRYPTION_KEY) {
    throw replacementError('BYOK encryption is not configured');
  }

  const [credential] = await db
    .select({
      planId: coding_plan_key_inventory.plan_id,
      providerId: coding_plan_key_inventory.provider_id,
      upstreamPlanId: coding_plan_key_inventory.upstream_plan_id,
      upstreamUsageId: coding_plan_key_inventory.upstream_usage_id,
      credentialFingerprint: coding_plan_key_inventory.credential_fingerprint,
    })
    .from(coding_plan_key_inventory)
    .where(
      and(
        eq(coding_plan_key_inventory.id, inventoryKeyId),
        inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed'])
      )
    )
    .limit(1);
  if (!credential) {
    throw replacementError('Credential is not eligible for replacement.');
  }
  if (!isCodingPlanId(credential.planId)) {
    throw replacementError('Credential has an unsupported Coding Plan ID.');
  }
  const plan = getCodingPlanPrice(credential.planId);
  if (!plan || plan.providerId !== credential.providerId) {
    throw replacementError('Credential has an unsupported Coding Plan provider.');
  }
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw replacementError(`A replacement ${plan.providerName} API key is required.`);
  }
  const replacementFingerprint = codingPlanCredentialFingerprint(normalizedApiKey);
  if (replacementFingerprint === credential.credentialFingerprint) {
    throw replacementError(
      `Replacement ${plan.providerName} credential must be different from the current credential.`
    );
  }

  const [duplicateCredential] = await db
    .select({ id: coding_plan_key_inventory.id })
    .from(coding_plan_key_inventory)
    .where(
      and(
        eq(coding_plan_key_inventory.credential_fingerprint, replacementFingerprint),
        ne(coding_plan_key_inventory.id, inventoryKeyId)
      )
    )
    .limit(1);
  if (duplicateCredential) {
    throw replacementError(
      `Replacement ${plan.providerName} credential is already present in inventory.`
    );
  }

  const validateCredential = options.validateCredential ?? validateCodingPlanCredential;
  const validationResult = getCodingPlanValidationResult(
    await validateCredential({
      apiKey: normalizedApiKey,
      planId: credential.planId,
      providerId: plan.providerId,
      upstreamPlanId: credential.upstreamPlanId,
    })
  );
  if (
    !validationResult.valid ||
    (plan.providerId === 'byteplus-coding' && !validationResult.upstreamUsageId)
  ) {
    throw replacementError(
      `Replacement ${plan.providerName} credential failed validation. Confirm plan access and supported model behavior, then try again.`
    );
  }

  let result: { rowCount?: number | null };
  try {
    result = await db
      .update(coding_plan_key_inventory)
      .set({
        status: 'available',
        encrypted_api_key: encryptApiKey(normalizedApiKey, BYOK_ENCRYPTION_KEY),
        credential_fingerprint: replacementFingerprint,
        upstream_usage_id:
          plan.providerId === 'byteplus-coding'
            ? validationResult.upstreamUsageId
            : credential.upstreamUsageId,
        assigned_to_user_id: null,
        assigned_at: null,
        revocation_requested_at: null,
        revoked_at: null,
        revocation_attempt_count: sql`${coding_plan_key_inventory.revocation_attempt_count} + 1`,
        last_revocation_error: null,
      })
      .where(
        and(
          eq(coding_plan_key_inventory.id, inventoryKeyId),
          inArray(coding_plan_key_inventory.status, ['revocation_pending', 'revocation_failed'])
        )
      );
  } catch (error) {
    if (databaseConstraint(error) === 'UQ_coding_plan_key_inv_provider_usage_id') {
      throw replacementError('The resolved BytePlus seat is already attached to inventory.');
    }
    throw replacementError('Unable to replace the credential due to a database error.');
  }

  if ((result.rowCount ?? 0) === 0) {
    throw replacementError('Credential is not eligible for replacement.');
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
