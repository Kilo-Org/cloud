import 'server-only';

import {
  sanitizeServiceFeeAssessmentMetadata,
  toServiceFeeTimestamp,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@/lib/service-fees/assessments';
import {
  acquireOrganizationServiceFeeExemptionLock,
  normalizeOrganizationExemptionTimestamp,
  type ActiveOrganizationRef,
  type OrganizationServiceFeeExemptionRecord,
  type OrganizationServiceFeeExemptionStore,
} from '@/lib/service-fees/organization-exemptions';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  organization_service_fee_exemptions,
  organizations,
  stripe_service_fee_assessments,
  type NewStripeServiceFeeAssessment,
  type OrganizationServiceFeeExemption,
  type StripeServiceFeeAssessment,
} from '@kilocode/db/schema';
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';

export type ServiceFeeDbOrTx = typeof db | DrizzleTransaction;

export class ServiceFeeAssessmentKeyConflictError extends Error {
  readonly name = 'ServiceFeeAssessmentKeyConflictError';

  constructor(
    readonly assessmentKey: string,
    options?: { cause?: unknown }
  ) {
    super(`duplicate service fee assessment_key ${assessmentKey}`, options);
  }
}

export type ServiceFeeAssessmentPersistenceStore = ServiceFeeAssessmentStore & {
  findByStripeCheckoutSessionId(
    stripeCheckoutSessionId: string
  ): Promise<ServiceFeeAssessmentRecord | null>;
  findByStripeInvoiceId(stripeInvoiceId: string): Promise<ServiceFeeAssessmentRecord | null>;
  findByStripePaymentIntentId(
    stripePaymentIntentId: string
  ): Promise<ServiceFeeAssessmentRecord | null>;
  findByStripeChargeId(stripeChargeId: string): Promise<ServiceFeeAssessmentRecord | null>;
};

export function createServiceFeeAssessmentStore(
  dbOrTx: ServiceFeeDbOrTx
): ServiceFeeAssessmentPersistenceStore {
  const store: ServiceFeeAssessmentPersistenceStore = {
    async transact(fn) {
      return dbOrTx.transaction(async tx => fn(createServiceFeeAssessmentStore(tx)));
    },

    async findByAssessmentKey(assessmentKey) {
      if (!assessmentKey) return null;
      const [row] = await dbOrTx
        .select()
        .from(stripe_service_fee_assessments)
        .where(eq(stripe_service_fee_assessments.assessment_key, assessmentKey))
        .limit(1);
      return row ? toAssessmentRecord(row) : null;
    },

    async findByStripeCheckoutSessionId(stripeCheckoutSessionId) {
      return findAssessmentByNullableText(
        dbOrTx,
        stripe_service_fee_assessments.stripe_checkout_session_id,
        stripeCheckoutSessionId
      );
    },

    async findByStripeInvoiceId(stripeInvoiceId) {
      return findAssessmentByNullableText(
        dbOrTx,
        stripe_service_fee_assessments.stripe_invoice_id,
        stripeInvoiceId
      );
    },

    async findByStripePaymentIntentId(stripePaymentIntentId) {
      return findAssessmentByNullableText(
        dbOrTx,
        stripe_service_fee_assessments.stripe_payment_intent_id,
        stripePaymentIntentId
      );
    },

    async findByStripeChargeId(stripeChargeId) {
      return findAssessmentByNullableText(
        dbOrTx,
        stripe_service_fee_assessments.stripe_charge_id,
        stripeChargeId
      );
    },

    async insert(record) {
      const [row] = await dbOrTx
        .insert(stripe_service_fee_assessments)
        .values(toAssessmentInsert(record))
        .onConflictDoNothing({
          target: stripe_service_fee_assessments.assessment_key,
        })
        .returning();

      if (!row) {
        throw new ServiceFeeAssessmentKeyConflictError(record.assessmentKey);
      }

      return toAssessmentRecord(row);
    },

    async update(assessmentKey, patch) {
      const set = toAssessmentUpdate(patch);
      if (Object.keys(set).length === 0) {
        const existing = await store.findByAssessmentKey(assessmentKey);
        if (!existing) {
          throw new Error(`service fee assessment ${assessmentKey} was not found`);
        }
        return existing;
      }

      const [row] = await dbOrTx
        .update(stripe_service_fee_assessments)
        .set(set)
        .where(assessmentUpdateGuard(assessmentKey, patch))
        .returning();

      if (!row) {
        throw new Error(`service fee assessment ${assessmentKey} was not updated`);
      }

      return toAssessmentRecord(row);
    },
  };

  return store;
}

export function createOrganizationServiceFeeExemptionStore(
  dbOrTx: ServiceFeeDbOrTx
): OrganizationServiceFeeExemptionStore {
  const store: OrganizationServiceFeeExemptionStore = {
    async transact(fn) {
      return dbOrTx.transaction(async tx => fn(createOrganizationServiceFeeExemptionStore(tx)));
    },

    async lockOrganization(organizationId) {
      await acquireOrganizationServiceFeeExemptionLock(
        {
          execute: query => dbOrTx.execute(query as Parameters<ServiceFeeDbOrTx['execute']>[0]),
        },
        organizationId
      );
    },

    async findActiveOrganization(organizationId) {
      const [row] = await dbOrTx
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
        .limit(1);
      return row ? ({ id: row.id } satisfies ActiveOrganizationRef) : null;
    },

    async findAtOrBefore(organizationId, at) {
      const [row] = await dbOrTx
        .select()
        .from(organization_service_fee_exemptions)
        .where(
          and(
            eq(organization_service_fee_exemptions.organization_id, organizationId),
            lte(
              organization_service_fee_exemptions.created_at,
              normalizeOrganizationExemptionTimestamp(at)
            )
          )
        )
        .orderBy(
          desc(organization_service_fee_exemptions.created_at),
          desc(organization_service_fee_exemptions.id)
        )
        .limit(1);
      return row ? toExemptionRecord(row) : null;
    },

    async listNewestFirst(organizationId) {
      const rows = await dbOrTx
        .select()
        .from(organization_service_fee_exemptions)
        .where(eq(organization_service_fee_exemptions.organization_id, organizationId))
        .orderBy(
          desc(organization_service_fee_exemptions.created_at),
          desc(organization_service_fee_exemptions.id)
        );
      return rows.map(toExemptionRecord);
    },

    async getCurrent(organizationId) {
      const [row] = await dbOrTx
        .select()
        .from(organization_service_fee_exemptions)
        .where(eq(organization_service_fee_exemptions.organization_id, organizationId))
        .orderBy(
          desc(organization_service_fee_exemptions.created_at),
          desc(organization_service_fee_exemptions.id)
        )
        .limit(1);
      return row ? toExemptionRecord(row) : null;
    },

    async insert(record) {
      const [row] = await dbOrTx
        .insert(organization_service_fee_exemptions)
        .values({
          id: record.id,
          organization_id: record.organizationId,
          is_exempt: record.isExempt,
          reason: record.reason,
          changed_by_kilo_user_id: nullableText(record.changedByKiloUserId),
          created_at: record.createdAt,
        })
        .returning();

      if (!row) {
        throw new Error(`organization service fee exemption ${record.id} was not inserted`);
      }

      return toExemptionRecord(row);
    },
  };

  return store;
}

export function createDefaultServiceFeeAssessmentStore(): ServiceFeeAssessmentPersistenceStore {
  return createServiceFeeAssessmentStore(db);
}

export function createDefaultOrganizationServiceFeeExemptionStore(): OrganizationServiceFeeExemptionStore {
  return createOrganizationServiceFeeExemptionStore(db);
}

export function createServiceFeeStores(dbOrTx: ServiceFeeDbOrTx = db): {
  assessments: ServiceFeeAssessmentPersistenceStore;
  exemptions: OrganizationServiceFeeExemptionStore;
} {
  return {
    assessments: createServiceFeeAssessmentStore(dbOrTx),
    exemptions: createOrganizationServiceFeeExemptionStore(dbOrTx),
  };
}

function nullableText(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return value;
}

function toAssessmentRecord(row: StripeServiceFeeAssessment): ServiceFeeAssessmentRecord {
  return {
    assessmentKey: row.assessment_key,
    version: row.version,
    flow: row.flow,
    outcome: row.outcome,
    currency: row.currency,
    kiloUserId: row.kilo_user_id,
    organizationId: row.organization_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripeInvoiceId: row.stripe_invoice_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeChargeId: row.stripe_charge_id,
    stripeFeePriceId: row.stripe_fee_price_id,
    stripeCheckoutFeeLineItemId: row.stripe_checkout_fee_line_item_id,
    stripeInvoiceFeeLineItemId: row.stripe_invoice_fee_line_item_id,
    eligibilityCreatedAt: toServiceFeeTimestamp(row.eligibility_created_at),
    eligibleSubtotalMinor: row.eligible_subtotal_minor,
    expectedFeeMinor: row.expected_fee_minor,
    chargedFeeMinor: row.charged_fee_minor,
    grossPaidMinor: row.gross_paid_minor,
    settledProductMinor: row.settled_product_minor,
    settledAt: row.settled_at ? toServiceFeeTimestamp(row.settled_at) : null,
    refundedProductMinor: row.refunded_product_minor,
    refundedFeeMinor: row.refunded_fee_minor,
    refundedGrossMinor: row.refunded_gross_minor,
    disputedFeeMinor: row.disputed_fee_minor,
    exemptionId: row.exemption_id,
    failureCode: row.failure_code,
    metadata: sanitizeServiceFeeAssessmentMetadata(row.metadata),
    createdAt: toServiceFeeTimestamp(row.created_at),
    updatedAt: toServiceFeeTimestamp(row.updated_at),
  };
}

function toAssessmentInsert(record: ServiceFeeAssessmentRecord): NewStripeServiceFeeAssessment {
  return {
    assessment_key: record.assessmentKey,
    version: record.version,
    flow: record.flow,
    outcome: record.outcome,
    currency: record.currency,
    kilo_user_id: nullableText(record.kiloUserId),
    organization_id: nullableText(record.organizationId),
    stripe_customer_id: nullableText(record.stripeCustomerId),
    stripe_checkout_session_id: nullableText(record.stripeCheckoutSessionId),
    stripe_invoice_id: nullableText(record.stripeInvoiceId),
    stripe_payment_intent_id: nullableText(record.stripePaymentIntentId),
    stripe_charge_id: nullableText(record.stripeChargeId),
    stripe_fee_price_id: nullableText(record.stripeFeePriceId),
    stripe_checkout_fee_line_item_id: nullableText(record.stripeCheckoutFeeLineItemId),
    stripe_invoice_fee_line_item_id: nullableText(record.stripeInvoiceFeeLineItemId),
    eligibility_created_at: record.eligibilityCreatedAt,
    eligible_subtotal_minor: record.eligibleSubtotalMinor,
    expected_fee_minor: record.expectedFeeMinor,
    charged_fee_minor: record.chargedFeeMinor,
    gross_paid_minor: record.grossPaidMinor,
    settled_product_minor: record.settledProductMinor,
    settled_at: record.settledAt,
    refunded_product_minor: record.refundedProductMinor,
    refunded_fee_minor: record.refundedFeeMinor,
    refunded_gross_minor: record.refundedGrossMinor,
    disputed_fee_minor: record.disputedFeeMinor,
    exemption_id: nullableText(record.exemptionId),
    failure_code: nullableText(record.failureCode),
    metadata: sanitizeServiceFeeAssessmentMetadata(record.metadata),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function toAssessmentUpdate(
  patch: Partial<ServiceFeeAssessmentRecord>
): Partial<NewStripeServiceFeeAssessment> {
  const set: Partial<NewStripeServiceFeeAssessment> = {};

  if (patch.version !== undefined) set.version = patch.version;
  if (patch.flow !== undefined) set.flow = patch.flow;
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.currency !== undefined) set.currency = patch.currency;
  if (patch.kiloUserId !== undefined) set.kilo_user_id = nullableText(patch.kiloUserId);
  if (patch.organizationId !== undefined) {
    set.organization_id = nullableText(patch.organizationId);
  }
  if (patch.stripeCustomerId !== undefined) {
    set.stripe_customer_id = nullableText(patch.stripeCustomerId);
  }
  if (patch.stripeCheckoutSessionId !== undefined) {
    set.stripe_checkout_session_id = nullableText(patch.stripeCheckoutSessionId);
  }
  if (patch.stripeInvoiceId !== undefined) {
    set.stripe_invoice_id = nullableText(patch.stripeInvoiceId);
  }
  if (patch.stripePaymentIntentId !== undefined) {
    set.stripe_payment_intent_id = nullableText(patch.stripePaymentIntentId);
  }
  if (patch.stripeChargeId !== undefined) {
    set.stripe_charge_id = nullableText(patch.stripeChargeId);
  }
  if (patch.stripeFeePriceId !== undefined) {
    set.stripe_fee_price_id = nullableText(patch.stripeFeePriceId);
  }
  if (patch.stripeCheckoutFeeLineItemId !== undefined) {
    set.stripe_checkout_fee_line_item_id = nullableText(patch.stripeCheckoutFeeLineItemId);
  }
  if (patch.stripeInvoiceFeeLineItemId !== undefined) {
    set.stripe_invoice_fee_line_item_id = nullableText(patch.stripeInvoiceFeeLineItemId);
  }
  if (patch.eligibilityCreatedAt !== undefined) {
    set.eligibility_created_at = patch.eligibilityCreatedAt;
  }
  if (patch.eligibleSubtotalMinor !== undefined) {
    set.eligible_subtotal_minor = patch.eligibleSubtotalMinor;
  }
  if (patch.expectedFeeMinor !== undefined) set.expected_fee_minor = patch.expectedFeeMinor;
  if (patch.chargedFeeMinor !== undefined) set.charged_fee_minor = patch.chargedFeeMinor;
  if (patch.grossPaidMinor !== undefined) set.gross_paid_minor = patch.grossPaidMinor;
  if (patch.settledProductMinor !== undefined) {
    set.settled_product_minor = patch.settledProductMinor;
  }
  if (patch.settledAt !== undefined) set.settled_at = patch.settledAt;
  if (patch.refundedProductMinor !== undefined) {
    set.refunded_product_minor = patch.refundedProductMinor;
  }
  if (patch.refundedFeeMinor !== undefined) set.refunded_fee_minor = patch.refundedFeeMinor;
  if (patch.refundedGrossMinor !== undefined) set.refunded_gross_minor = patch.refundedGrossMinor;
  if (patch.disputedFeeMinor !== undefined) set.disputed_fee_minor = patch.disputedFeeMinor;
  if (patch.exemptionId !== undefined) {
    set.exemption_id = nullableText(patch.exemptionId);
  }
  if (patch.failureCode !== undefined) set.failure_code = nullableText(patch.failureCode);
  if (patch.metadata !== undefined) {
    set.metadata = sanitizeServiceFeeAssessmentMetadata(patch.metadata);
  }
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;

  return set;
}

function assessmentUpdateGuard(assessmentKey: string, patch: Partial<ServiceFeeAssessmentRecord>) {
  return and(
    eq(stripe_service_fee_assessments.assessment_key, assessmentKey),
    immutableTextGuard(
      stripe_service_fee_assessments.kilo_user_id,
      patch.kiloUserId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.organization_id,
      patch.organizationId,
      /* allowNullToValue */ false
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_customer_id,
      patch.stripeCustomerId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_checkout_session_id,
      patch.stripeCheckoutSessionId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_invoice_id,
      patch.stripeInvoiceId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_payment_intent_id,
      patch.stripePaymentIntentId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_charge_id,
      patch.stripeChargeId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_fee_price_id,
      patch.stripeFeePriceId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_checkout_fee_line_item_id,
      patch.stripeCheckoutFeeLineItemId,
      /* allowNullToValue */ true
    ),
    immutableTextGuard(
      stripe_service_fee_assessments.stripe_invoice_fee_line_item_id,
      patch.stripeInvoiceFeeLineItemId,
      /* allowNullToValue */ true
    )
  );
}

function immutableTextGuard(
  column:
    | typeof stripe_service_fee_assessments.kilo_user_id
    | typeof stripe_service_fee_assessments.organization_id
    | typeof stripe_service_fee_assessments.stripe_customer_id
    | typeof stripe_service_fee_assessments.stripe_checkout_session_id
    | typeof stripe_service_fee_assessments.stripe_invoice_id
    | typeof stripe_service_fee_assessments.stripe_payment_intent_id
    | typeof stripe_service_fee_assessments.stripe_charge_id
    | typeof stripe_service_fee_assessments.stripe_fee_price_id
    | typeof stripe_service_fee_assessments.stripe_checkout_fee_line_item_id
    | typeof stripe_service_fee_assessments.stripe_invoice_fee_line_item_id,
  incoming: string | null | undefined,
  allowNullToValue: boolean
) {
  if (incoming === undefined) return undefined;
  const value = nullableText(incoming);
  if (value === null) {
    return isNull(column);
  }
  if (allowNullToValue) {
    return or(isNull(column), eq(column, value));
  }
  return eq(column, value);
}

async function findAssessmentByNullableText(
  dbOrTx: ServiceFeeDbOrTx,
  column:
    | typeof stripe_service_fee_assessments.stripe_checkout_session_id
    | typeof stripe_service_fee_assessments.stripe_invoice_id
    | typeof stripe_service_fee_assessments.stripe_payment_intent_id
    | typeof stripe_service_fee_assessments.stripe_charge_id,
  value: string
): Promise<ServiceFeeAssessmentRecord | null> {
  const id = nullableText(value);
  if (!id) return null;
  const [row] = await dbOrTx
    .select()
    .from(stripe_service_fee_assessments)
    .where(eq(column, id))
    .limit(1);
  return row ? toAssessmentRecord(row) : null;
}

function toExemptionRecord(
  row: OrganizationServiceFeeExemption
): OrganizationServiceFeeExemptionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    isExempt: row.is_exempt,
    reason: row.reason,
    changedByKiloUserId: row.changed_by_kilo_user_id,
    createdAt: normalizeOrganizationExemptionTimestamp(row.created_at),
  };
}
