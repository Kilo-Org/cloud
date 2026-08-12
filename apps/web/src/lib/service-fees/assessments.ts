import 'server-only';

import { randomUUID } from 'node:crypto';

import { calculateServiceFeeMinor } from '@/lib/service-fees/calculation';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import type { OrganizationServiceFeeExemptionHistoryRecord } from '@/lib/service-fees/organization-exemptions';
import {
  getServiceFeeOwner,
  isSupportedServiceFeeCurrency,
  type PrepareAssessmentInput,
  type ServiceFeeEligibility,
  type ServiceFeeFlow,
  type ServiceFeeOutcome,
} from '@/lib/service-fees/types';

export const SERVICE_FEE_TERMINAL_OMITTED_OUTCOMES = [
  'exempt',
  'pre_activation',
  'zero_rounded',
  'unsupported_currency',
] as const satisfies readonly ServiceFeeOutcome[];

export type ServiceFeeTerminalOmittedOutcome =
  (typeof SERVICE_FEE_TERMINAL_OMITTED_OUTCOMES)[number];

export type ServiceFeeAssessmentConflictReason =
  | 'owner'
  | 'flow'
  | 'currency'
  | 'eligible_subtotal'
  | 'expected_fee'
  | 'stripe_id'
  | 'illegal_transition'
  | 'pending_settlement'
  | 'non_monotonic_refund'
  | 'refund_exceeds_settled'
  | 'dispute_exceeds_settled'
  | 'invalid_failure_code'
  | 'invalid_amount';

export class ServiceFeeAssessmentConflictError extends Error {
  readonly name = 'ServiceFeeAssessmentConflictError';

  constructor(
    readonly assessmentKey: string,
    readonly reason: ServiceFeeAssessmentConflictReason,
    readonly field: string,
    readonly existing: unknown,
    readonly incoming: unknown,
    message?: string
  ) {
    super(message ?? `service fee assessment ${assessmentKey} conflict on ${field} (${reason})`);
  }
}

export type ServiceFeeAssessmentMetadata = {
  service_fee_rate_deviation?: true;
  refund_allocation_unresolved?: true;
};

const ALLOWED_METADATA_KEYS = new Set<keyof ServiceFeeAssessmentMetadata>([
  'service_fee_rate_deviation',
  'refund_allocation_unresolved',
]);

export type ServiceFeeStripeIds = {
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  stripeFeePriceId?: string | null;
  stripeCheckoutFeeLineItemId?: string | null;
  stripeInvoiceFeeLineItemId?: string | null;
};

const STRIPE_ID_FIELDS = [
  'stripeCustomerId',
  'stripeCheckoutSessionId',
  'stripeInvoiceId',
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeFeePriceId',
  'stripeCheckoutFeeLineItemId',
  'stripeInvoiceFeeLineItemId',
] as const satisfies readonly (keyof ServiceFeeStripeIds)[];

export type ServiceFeeAssessmentRecord = {
  id: string;
  assessmentKey: string;
  version: string;
  flow: ServiceFeeFlow;
  eligibility: ServiceFeeEligibility;
  outcome: ServiceFeeOutcome;
  currency: string;
  kiloUserId: string | null;
  organizationId: string | null;
  stripeCustomerId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeFeePriceId: string | null;
  stripeCheckoutFeeLineItemId: string | null;
  stripeInvoiceFeeLineItemId: string | null;
  eligibilityCreatedAt: string;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  chargedFeeMinor: number;
  grossPaidMinor: number;
  settledProductMinor: number;
  settledAt: string | null;
  refundedProductMinor: number;
  refundedFeeMinor: number;
  refundedGrossMinor: number;
  disputedProductMinor: number;
  disputedFeeMinor: number;
  exemptionHistoryId: string | null;
  failureCode: string | null;
  metadata: ServiceFeeAssessmentMetadata;
  createdAt: string;
  updatedAt: string;
};

/**
 * Drizzle-compatible transaction wrapper. `db.transaction` and an already-open
 * `tx` (whose `transaction` simply invokes the callback) both satisfy this.
 */
export type ServiceFeeAssessmentExecutor = {
  transaction: <T>(fn: (tx: ServiceFeeAssessmentExecutor) => Promise<T>) => Promise<T>;
};

export type ServiceFeeAssessmentStore = {
  transact<T>(fn: (store: ServiceFeeAssessmentStore) => Promise<T>): Promise<T>;
  findByAssessmentKey(assessmentKey: string): Promise<ServiceFeeAssessmentRecord | null>;
  insert(record: ServiceFeeAssessmentRecord): Promise<ServiceFeeAssessmentRecord>;
  update(
    assessmentKey: string,
    patch: Partial<ServiceFeeAssessmentRecord>
  ): Promise<ServiceFeeAssessmentRecord>;
};

export type EffectiveExemptionLookup = (
  organizationId: string,
  at: Date
) => Promise<Pick<OrganizationServiceFeeExemptionHistoryRecord, 'id' | 'isExempt'> | null>;

export type PreparedServiceFeeDecision = {
  assessmentKey: string;
  version: typeof SERVICE_FEE_VERSION;
  flow: ServiceFeeFlow;
  eligibility: ServiceFeeEligibility;
  outcome: Exclude<ServiceFeeOutcome, 'charged' | 'missed'>;
  currency: string;
  kiloUserId: string | null;
  organizationId: string | null;
  stripeCustomerId: string | null;
  eligibilityCreatedAt: string;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  chargedFeeMinor: 0;
  exemptionHistoryId: string | null;
  failureCode: null;
  metadata: ServiceFeeAssessmentMetadata;
};

const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const ISO_CURRENCY_PATTERN = /^[a-z]{3}$/;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertNonEmptyAssessmentKey(assessmentKey: string): void {
  if (typeof assessmentKey !== 'string' || assessmentKey.trim().length === 0) {
    throw new Error('assessmentKey must be a nonempty string');
  }
}

export function toServiceFeeTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('service fee timestamp is invalid');
  }
  return date.toISOString();
}

export function sanitizeServiceFeeAssessmentMetadata(
  metadata: Record<string, unknown> | ServiceFeeAssessmentMetadata | null | undefined
): ServiceFeeAssessmentMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const sanitized: ServiceFeeAssessmentMetadata = {};
  for (const key of ALLOWED_METADATA_KEYS) {
    if (metadata[key] === true) {
      sanitized[key] = true;
    }
  }
  return sanitized;
}

export function assertServiceFeeFailureCode(failureCode: string, assessmentKey = ''): string {
  const trimmed = failureCode.trim();
  if (!FAILURE_CODE_PATTERN.test(trimmed)) {
    throw new ServiceFeeAssessmentConflictError(
      assessmentKey,
      'invalid_failure_code',
      'failureCode',
      null,
      failureCode,
      'failure_code must be a stable nonempty internal code'
    );
  }
  return trimmed;
}

export function isServiceFeeTerminalOmittedOutcome(
  outcome: ServiceFeeOutcome
): outcome is ServiceFeeTerminalOmittedOutcome {
  return (SERVICE_FEE_TERMINAL_OMITTED_OUTCOMES as readonly string[]).includes(outcome);
}

export function canTransitionServiceFeeOutcome(
  from: ServiceFeeOutcome,
  to: ServiceFeeOutcome
): boolean {
  if (from === to) return true;
  if (from === 'pending') {
    return to === 'charged' || to === 'missed' || isServiceFeeTerminalOmittedOutcome(to);
  }
  return false;
}

function assertLegalOutcomeTransition(
  assessmentKey: string,
  from: ServiceFeeOutcome,
  to: ServiceFeeOutcome
): void {
  if (canTransitionServiceFeeOutcome(from, to)) return;
  throw new ServiceFeeAssessmentConflictError(
    assessmentKey,
    'illegal_transition',
    'outcome',
    from,
    to,
    `service fee assessment ${assessmentKey} cannot transition from ${from} to ${to}`
  );
}

function conflict(
  assessmentKey: string,
  reason: ServiceFeeAssessmentConflictReason,
  field: string,
  existing: unknown,
  incoming: unknown
): never {
  throw new ServiceFeeAssessmentConflictError(assessmentKey, reason, field, existing, incoming);
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

function enrichNullableString(
  assessmentKey: string,
  field: string,
  existing: string | null,
  incoming: string | null | undefined
): string | null {
  if (incoming === undefined || incoming === null || incoming === '') {
    return existing;
  }
  if (existing === null || existing === '') {
    return incoming;
  }
  if (existing === incoming) {
    return existing;
  }
  conflict(
    assessmentKey,
    field === 'kiloUserId' ? 'owner' : 'stripe_id',
    field,
    existing,
    incoming
  );
}

function mergeStripeIds(
  assessmentKey: string,
  existing: ServiceFeeAssessmentRecord,
  incoming: ServiceFeeStripeIds | undefined
): Pick<ServiceFeeAssessmentRecord, (typeof STRIPE_ID_FIELDS)[number]> {
  const merged = {
    stripeCustomerId: existing.stripeCustomerId,
    stripeCheckoutSessionId: existing.stripeCheckoutSessionId,
    stripeInvoiceId: existing.stripeInvoiceId,
    stripePaymentIntentId: existing.stripePaymentIntentId,
    stripeChargeId: existing.stripeChargeId,
    stripeFeePriceId: existing.stripeFeePriceId,
    stripeCheckoutFeeLineItemId: existing.stripeCheckoutFeeLineItemId,
    stripeInvoiceFeeLineItemId: existing.stripeInvoiceFeeLineItemId,
  };

  if (!incoming) return merged;

  for (const field of STRIPE_ID_FIELDS) {
    merged[field] = enrichNullableString(assessmentKey, field, existing[field], incoming[field]);
  }
  return merged;
}

function requireAssessment(
  assessmentKey: string,
  record: ServiceFeeAssessmentRecord | null
): ServiceFeeAssessmentRecord {
  if (!record) {
    throw new Error(`service fee assessment ${assessmentKey} was not found`);
  }
  return record;
}

export async function prepareServiceFeeAssessmentDecision(
  input: PrepareAssessmentInput,
  deps: { findEffectiveExemption?: EffectiveExemptionLookup } = {}
): Promise<PreparedServiceFeeDecision> {
  assertNonEmptyAssessmentKey(input.assessmentKey);
  assertNonNegativeSafeInteger(input.eligibleSubtotalMinor, 'eligibleSubtotalMinor');
  if (Number.isNaN(input.eligibilityCreatedAt.getTime())) {
    throw new Error('eligibilityCreatedAt is invalid');
  }

  const owner = getServiceFeeOwner(input.flow, input);
  const currency = normalizeCurrency(input.currency);
  const eligibilityCreatedAt = toServiceFeeTimestamp(input.eligibilityCreatedAt);
  const createdUnixSeconds = Math.floor(input.eligibilityCreatedAt.getTime() / 1000);
  const stripeCustomerId = input.stripeCustomerId?.trim() ? input.stripeCustomerId.trim() : null;
  const kiloUserId = owner.kind === 'personal' ? owner.kiloUserId : (owner.kiloUserId ?? null);
  const organizationId = owner.kind === 'organization' ? owner.organizationId : null;

  if (!ISO_CURRENCY_PATTERN.test(currency) || !isSupportedServiceFeeCurrency(currency)) {
    return {
      assessmentKey: input.assessmentKey,
      version: SERVICE_FEE_VERSION,
      flow: input.flow,
      eligibility: 'eligible',
      outcome: 'unsupported_currency',
      currency,
      kiloUserId,
      organizationId,
      stripeCustomerId,
      eligibilityCreatedAt,
      eligibleSubtotalMinor: 0,
      expectedFeeMinor: 0,
      chargedFeeMinor: 0,
      exemptionHistoryId: null,
      failureCode: null,
      metadata: {},
    };
  }

  let eligibility: ServiceFeeEligibility = 'eligible';
  let exemptionHistoryId: string | null = null;

  if (createdUnixSeconds < SERVICE_FEE_ACTIVATION_UNIX_SECONDS) {
    eligibility = 'pre_activation';
  } else if (owner.kind === 'organization') {
    const exemption = deps.findEffectiveExemption
      ? await deps.findEffectiveExemption(owner.organizationId, input.eligibilityCreatedAt)
      : null;
    if (exemption?.isExempt) {
      eligibility = 'exempt';
      exemptionHistoryId = exemption.id;
    }
  }

  const expectedFeeMinor = calculateServiceFeeMinor(input.eligibleSubtotalMinor);
  let outcome: PreparedServiceFeeDecision['outcome'] = 'pending';
  if (eligibility === 'pre_activation') {
    outcome = 'pre_activation';
  } else if (eligibility === 'exempt') {
    outcome = 'exempt';
  } else if (expectedFeeMinor === 0) {
    outcome = 'zero_rounded';
  }

  return {
    assessmentKey: input.assessmentKey,
    version: SERVICE_FEE_VERSION,
    flow: input.flow,
    eligibility,
    outcome,
    currency,
    kiloUserId,
    organizationId,
    stripeCustomerId,
    eligibilityCreatedAt,
    eligibleSubtotalMinor: input.eligibleSubtotalMinor,
    expectedFeeMinor,
    chargedFeeMinor: 0,
    exemptionHistoryId,
    failureCode: null,
    metadata: {},
  };
}

function assertImmutableFacts(
  existing: ServiceFeeAssessmentRecord,
  incoming: {
    flow: ServiceFeeFlow;
    currency: string;
    organizationId: string | null;
    eligibleSubtotalMinor: number;
    expectedFeeMinor: number;
  }
): void {
  if (existing.flow !== incoming.flow) {
    conflict(existing.assessmentKey, 'flow', 'flow', existing.flow, incoming.flow);
  }
  if (existing.currency !== incoming.currency) {
    conflict(existing.assessmentKey, 'currency', 'currency', existing.currency, incoming.currency);
  }
  if (existing.organizationId !== incoming.organizationId) {
    conflict(
      existing.assessmentKey,
      'owner',
      'organizationId',
      existing.organizationId,
      incoming.organizationId
    );
  }
  if (existing.eligibleSubtotalMinor !== incoming.eligibleSubtotalMinor) {
    conflict(
      existing.assessmentKey,
      'eligible_subtotal',
      'eligibleSubtotalMinor',
      existing.eligibleSubtotalMinor,
      incoming.eligibleSubtotalMinor
    );
  }
  if (existing.expectedFeeMinor !== incoming.expectedFeeMinor) {
    conflict(
      existing.assessmentKey,
      'expected_fee',
      'expectedFeeMinor',
      existing.expectedFeeMinor,
      incoming.expectedFeeMinor
    );
  }
}

function buildNewAssessmentRecord(params: {
  decision: PreparedServiceFeeDecision;
  stripeIds?: ServiceFeeStripeIds;
  now: Date;
}): ServiceFeeAssessmentRecord {
  const nowIso = toServiceFeeTimestamp(params.now);
  const stripeIds = params.stripeIds ?? {};
  return {
    id: randomUUID(),
    assessmentKey: params.decision.assessmentKey,
    version: params.decision.version,
    flow: params.decision.flow,
    eligibility: params.decision.eligibility,
    outcome: params.decision.outcome,
    currency: params.decision.currency,
    kiloUserId: params.decision.kiloUserId,
    organizationId: params.decision.organizationId,
    stripeCustomerId: stripeIds.stripeCustomerId ?? params.decision.stripeCustomerId,
    stripeCheckoutSessionId: stripeIds.stripeCheckoutSessionId ?? null,
    stripeInvoiceId: stripeIds.stripeInvoiceId ?? null,
    stripePaymentIntentId: stripeIds.stripePaymentIntentId ?? null,
    stripeChargeId: stripeIds.stripeChargeId ?? null,
    stripeFeePriceId: stripeIds.stripeFeePriceId ?? null,
    stripeCheckoutFeeLineItemId: stripeIds.stripeCheckoutFeeLineItemId ?? null,
    stripeInvoiceFeeLineItemId: stripeIds.stripeInvoiceFeeLineItemId ?? null,
    eligibilityCreatedAt: params.decision.eligibilityCreatedAt,
    eligibleSubtotalMinor: params.decision.eligibleSubtotalMinor,
    expectedFeeMinor: params.decision.expectedFeeMinor,
    chargedFeeMinor: 0,
    grossPaidMinor: 0,
    settledProductMinor: 0,
    settledAt: null,
    refundedProductMinor: 0,
    refundedFeeMinor: 0,
    refundedGrossMinor: 0,
    disputedProductMinor: 0,
    disputedFeeMinor: 0,
    exemptionHistoryId: params.decision.exemptionHistoryId,
    failureCode: null,
    metadata: sanitizeServiceFeeAssessmentMetadata(params.decision.metadata),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function upsertServiceFeeAssessment(params: {
  store: ServiceFeeAssessmentStore;
  decision: PreparedServiceFeeDecision;
  stripeIds?: ServiceFeeStripeIds;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  const now = params.now ?? new Date();

  return params.store.transact(async store => {
    const existing = await store.findByAssessmentKey(params.decision.assessmentKey);
    if (!existing) {
      try {
        return await store.insert(
          buildNewAssessmentRecord({
            decision: params.decision,
            stripeIds: params.stripeIds,
            now,
          })
        );
      } catch (error) {
        const raced = await store.findByAssessmentKey(params.decision.assessmentKey);
        if (!raced) throw error;
        return mergePreparedAssessment(store, raced, params.decision, params.stripeIds, now);
      }
    }

    return mergePreparedAssessment(store, existing, params.decision, params.stripeIds, now);
  });
}

async function mergePreparedAssessment(
  store: ServiceFeeAssessmentStore,
  existing: ServiceFeeAssessmentRecord,
  decision: PreparedServiceFeeDecision,
  stripeIds: ServiceFeeStripeIds | undefined,
  now: Date
): Promise<ServiceFeeAssessmentRecord> {
  assertImmutableFacts(existing, decision);

  if (existing.kiloUserId && decision.kiloUserId && existing.kiloUserId !== decision.kiloUserId) {
    conflict(
      existing.assessmentKey,
      'owner',
      'kiloUserId',
      existing.kiloUserId,
      decision.kiloUserId
    );
  }

  if (existing.eligibility !== decision.eligibility) {
    conflict(
      existing.assessmentKey,
      'illegal_transition',
      'eligibility',
      existing.eligibility,
      decision.eligibility
    );
  }
  if (existing.exemptionHistoryId !== decision.exemptionHistoryId) {
    conflict(
      existing.assessmentKey,
      'illegal_transition',
      'exemptionHistoryId',
      existing.exemptionHistoryId,
      decision.exemptionHistoryId
    );
  }

  if (existing.outcome !== decision.outcome) {
    assertLegalOutcomeTransition(existing.assessmentKey, existing.outcome, decision.outcome);
  }

  const mergedIds = mergeStripeIds(existing.assessmentKey, existing, {
    ...stripeIds,
    stripeCustomerId: stripeIds?.stripeCustomerId ?? decision.stripeCustomerId,
  });
  const kiloUserId = enrichNullableString(
    existing.assessmentKey,
    'kiloUserId',
    existing.kiloUserId,
    decision.kiloUserId
  );

  return store.update(existing.assessmentKey, {
    ...mergedIds,
    kiloUserId,
    outcome: existing.outcome === 'pending' ? decision.outcome : existing.outcome,
    updatedAt: toServiceFeeTimestamp(now),
  });
}

export async function markServiceFeeAssessmentCharged(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  chargedFeeMinor: number;
  stripeIds?: ServiceFeeStripeIds;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  assertNonNegativeSafeInteger(params.chargedFeeMinor, 'chargedFeeMinor');
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );

    if (existing.outcome === 'charged') {
      const attachmentRetryAfterSettlement =
        params.chargedFeeMinor === 0 && existing.settledAt !== null;
      if (existing.chargedFeeMinor !== params.chargedFeeMinor && !attachmentRetryAfterSettlement) {
        conflict(
          existing.assessmentKey,
          'expected_fee',
          'chargedFeeMinor',
          existing.chargedFeeMinor,
          params.chargedFeeMinor
        );
      }
      const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);
      return store.update(existing.assessmentKey, {
        ...mergedIds,
        updatedAt: nowIso,
      });
    }

    assertLegalOutcomeTransition(existing.assessmentKey, existing.outcome, 'charged');
    if (existing.expectedFeeMinor <= 0) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'invalid_amount',
        'expectedFeeMinor',
        existing.expectedFeeMinor,
        params.chargedFeeMinor,
        `service fee assessment ${existing.assessmentKey} cannot be charged without a positive expected fee`
      );
    }

    const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);
    return store.update(existing.assessmentKey, {
      ...mergedIds,
      outcome: 'charged',
      chargedFeeMinor: params.chargedFeeMinor,
      failureCode: null,
      updatedAt: nowIso,
    });
  });
}

export async function markServiceFeeAssessmentMissed(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  failureCode: string;
  stripeIds?: ServiceFeeStripeIds;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  const failureCode = assertServiceFeeFailureCode(params.failureCode, params.assessmentKey);
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );

    if (existing.outcome === 'missed') {
      const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);
      return store.update(existing.assessmentKey, {
        ...mergedIds,
        chargedFeeMinor: 0,
        failureCode: existing.failureCode ?? failureCode,
        updatedAt: nowIso,
      });
    }

    assertLegalOutcomeTransition(existing.assessmentKey, existing.outcome, 'missed');
    if (existing.expectedFeeMinor <= 0) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'invalid_amount',
        'expectedFeeMinor',
        existing.expectedFeeMinor,
        0,
        `service fee assessment ${existing.assessmentKey} cannot be missed without a positive expected fee`
      );
    }

    const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);
    return store.update(existing.assessmentKey, {
      ...mergedIds,
      outcome: 'missed',
      chargedFeeMinor: 0,
      failureCode,
      updatedAt: nowIso,
    });
  });
}

export async function linkServiceFeeAssessmentStripeIds(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  stripeIds: ServiceFeeStripeIds;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );
    const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);
    return store.update(existing.assessmentKey, {
      ...mergedIds,
      updatedAt: nowIso,
    });
  });
}

export async function settleServiceFeeAssessment(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  settledAt: Date | string;
  settledProductMinor: number;
  grossPaidMinor: number;
  chargedFeeMinor?: number;
  stripeIds?: ServiceFeeStripeIds;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  assertNonNegativeSafeInteger(params.settledProductMinor, 'settledProductMinor');
  assertNonNegativeSafeInteger(params.grossPaidMinor, 'grossPaidMinor');
  if (params.chargedFeeMinor !== undefined) {
    assertNonNegativeSafeInteger(params.chargedFeeMinor, 'chargedFeeMinor');
  }
  const settledAt = toServiceFeeTimestamp(params.settledAt);
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );

    if (existing.outcome === 'pending') {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'pending_settlement',
        'outcome',
        existing.outcome,
        'settled',
        `service fee assessment ${existing.assessmentKey} cannot settle while pending`
      );
    }

    const settledProductMinor = Math.min(
      params.settledProductMinor,
      existing.eligibleSubtotalMinor
    );
    const chargedFeeMinor =
      existing.outcome === 'charged' ? (params.chargedFeeMinor ?? existing.chargedFeeMinor) : 0;

    if (existing.outcome !== 'charged' && (params.chargedFeeMinor ?? 0) > 0) {
      conflict(
        existing.assessmentKey,
        'illegal_transition',
        'chargedFeeMinor',
        existing.chargedFeeMinor,
        params.chargedFeeMinor
      );
    }

    if (existing.outcome === 'charged' && chargedFeeMinor === 0 && settledProductMinor !== 0) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'invalid_amount',
        'chargedFeeMinor',
        existing.chargedFeeMinor,
        chargedFeeMinor,
        `service fee assessment ${existing.assessmentKey} charged fee may be zero only when settled product is zero`
      );
    }

    const mergedIds = mergeStripeIds(existing.assessmentKey, existing, params.stripeIds);

    if (existing.settledAt) {
      if (existing.settledProductMinor !== settledProductMinor) {
        conflict(
          existing.assessmentKey,
          'eligible_subtotal',
          'settledProductMinor',
          existing.settledProductMinor,
          settledProductMinor
        );
      }
      if (existing.grossPaidMinor !== params.grossPaidMinor) {
        conflict(
          existing.assessmentKey,
          'invalid_amount',
          'grossPaidMinor',
          existing.grossPaidMinor,
          params.grossPaidMinor
        );
      }
      if (existing.chargedFeeMinor !== chargedFeeMinor) {
        conflict(
          existing.assessmentKey,
          'expected_fee',
          'chargedFeeMinor',
          existing.chargedFeeMinor,
          chargedFeeMinor
        );
      }
      return store.update(existing.assessmentKey, {
        ...mergedIds,
        updatedAt: nowIso,
      });
    }

    return store.update(existing.assessmentKey, {
      ...mergedIds,
      chargedFeeMinor,
      settledProductMinor,
      grossPaidMinor: params.grossPaidMinor,
      settledAt,
      updatedAt: nowIso,
    });
  });
}

export async function observeServiceFeeAssessmentRefunds(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  refundedProductMinor: number;
  refundedFeeMinor: number;
  refundedGrossMinor?: number;
  unresolved?: boolean;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  assertNonNegativeSafeInteger(params.refundedProductMinor, 'refundedProductMinor');
  assertNonNegativeSafeInteger(params.refundedFeeMinor, 'refundedFeeMinor');
  if (params.refundedGrossMinor !== undefined) {
    assertNonNegativeSafeInteger(params.refundedGrossMinor, 'refundedGrossMinor');
  }
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );

    if (params.refundedProductMinor < existing.refundedProductMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'non_monotonic_refund',
        'refundedProductMinor',
        existing.refundedProductMinor,
        params.refundedProductMinor
      );
    }
    if (params.refundedFeeMinor < existing.refundedFeeMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'non_monotonic_refund',
        'refundedFeeMinor',
        existing.refundedFeeMinor,
        params.refundedFeeMinor
      );
    }
    if (
      params.refundedGrossMinor !== undefined &&
      params.refundedGrossMinor < existing.refundedGrossMinor
    ) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'non_monotonic_refund',
        'refundedGrossMinor',
        existing.refundedGrossMinor,
        params.refundedGrossMinor
      );
    }
    if (params.refundedProductMinor > existing.settledProductMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'refund_exceeds_settled',
        'refundedProductMinor',
        existing.settledProductMinor,
        params.refundedProductMinor
      );
    }
    if (params.refundedFeeMinor > existing.chargedFeeMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'refund_exceeds_settled',
        'refundedFeeMinor',
        existing.chargedFeeMinor,
        params.refundedFeeMinor
      );
    }

    const nextMetadata =
      params.unresolved === undefined
        ? undefined
        : sanitizeServiceFeeAssessmentMetadata(
            params.unresolved
              ? { ...existing.metadata, refund_allocation_unresolved: true }
              : Object.fromEntries(
                  Object.entries(existing.metadata).filter(
                    ([key]) => key !== 'refund_allocation_unresolved'
                  )
                )
          );

    return store.update(existing.assessmentKey, {
      refundedProductMinor: params.refundedProductMinor,
      refundedFeeMinor: params.refundedFeeMinor,
      refundedGrossMinor: params.refundedGrossMinor ?? existing.refundedGrossMinor,
      ...(nextMetadata === undefined ? {} : { metadata: nextMetadata }),
      updatedAt: nowIso,
    });
  });
}

export async function observeServiceFeeAssessmentDispute(params: {
  store: ServiceFeeAssessmentStore;
  assessmentKey: string;
  disputedProductMinor: number;
  disputedFeeMinor: number;
  now?: Date;
}): Promise<ServiceFeeAssessmentRecord> {
  assertNonEmptyAssessmentKey(params.assessmentKey);
  assertNonNegativeSafeInteger(params.disputedProductMinor, 'disputedProductMinor');
  assertNonNegativeSafeInteger(params.disputedFeeMinor, 'disputedFeeMinor');
  const nowIso = toServiceFeeTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    const existing = requireAssessment(
      params.assessmentKey,
      await store.findByAssessmentKey(params.assessmentKey)
    );

    if (params.disputedProductMinor > existing.settledProductMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'dispute_exceeds_settled',
        'disputedProductMinor',
        existing.settledProductMinor,
        params.disputedProductMinor
      );
    }
    if (params.disputedFeeMinor > existing.chargedFeeMinor) {
      throw new ServiceFeeAssessmentConflictError(
        existing.assessmentKey,
        'dispute_exceeds_settled',
        'disputedFeeMinor',
        existing.chargedFeeMinor,
        params.disputedFeeMinor
      );
    }

    return store.update(existing.assessmentKey, {
      disputedProductMinor: params.disputedProductMinor,
      disputedFeeMinor: params.disputedFeeMinor,
      updatedAt: nowIso,
    });
  });
}
