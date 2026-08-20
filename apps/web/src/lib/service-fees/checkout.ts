import 'server-only';

import { randomUUID } from 'node:crypto';

import type Stripe from 'stripe';

import {
  sendMissedServiceFeeAlert,
  type MissedServiceFeeAlertInput,
} from '@/lib/service-fees/alerts';
import {
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  prepareServiceFeeAssessmentDecision,
  settleServiceFeeAssessment,
  toServiceFeeTimestamp,
  upsertServiceFeeAssessment,
  type EffectiveExemptionLookup,
  type PreparedServiceFeeDecision,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
  type ServiceFeeStripeIds,
} from '@/lib/service-fees/assessments';
import { calculateServiceFeeMinor } from '@/lib/service-fees/calculation';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_DESCRIPTION,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import {
  buildServiceFeeCommercialMetadata,
  buildServiceFeeLineMetadata,
  isServiceFeeCheckoutLine,
} from '@/lib/service-fees/stripe-lines';
import {
  resolveServiceFeeTaxInput,
  type ServiceFeeTaxInput,
  type ServiceFeeTaxPrincipal,
  type StripePriceTaxReader,
} from '@/lib/service-fees/tax';
import {
  SERVICE_FEE_SUPPORTED_CURRENCY,
  type ServiceFeeCommercialMetadata,
  type ServiceFeeFlow,
  type ServiceFeeLineMetadata,
  type ServiceFeeOutcome,
} from '@/lib/service-fees/types';

export const SERVICE_FEE_ACTIVATION_BOUNDARY_WINDOW_SECONDS = 60;
export const KILO_OWNED_AUTO_TOP_UP_INVOICE_TYPES = ['auto-topup', 'org-auto-topup'] as const;

export const SERVICE_FEE_FAILURE_APPLICATION = 'fee_application_failed' as const;
export const SERVICE_FEE_FAILURE_ACTIVATION_BOUNDARY =
  'activation_boundary_replace_failed' as const;
export const SERVICE_FEE_FAILURE_MISSING_ASSESSMENT = 'missing_assessment' as const;
export const SERVICE_FEE_FAILURE_PRINCIPAL_UNTRUSTED = 'principal_untrusted' as const;

export type KiloOwnedAutoTopUpInvoiceType = (typeof KILO_OWNED_AUTO_TOP_UP_INVOICE_TYPES)[number];

export type CheckoutServiceFeeFlow =
  | 'personal_top_up'
  | 'organization_top_up'
  | 'personal_auto_top_up_setup'
  | 'organization_auto_top_up_setup'
  | 'personal_kilo_pass';

export type AutoTopUpInvoiceFlow = 'personal_auto_top_up' | 'organization_auto_top_up';

export type CheckoutSessionLike = {
  id: string;
  created: number;
  url?: string | null;
  line_items?: Pick<Stripe.ApiList<Stripe.LineItem>, 'data' | 'has_more'> | null;
};

export type CheckoutSessionCreateFn = (
  params: Stripe.Checkout.SessionCreateParams
) => Promise<CheckoutSessionLike>;

export type CheckoutLineItemListFn = (
  sessionId: string,
  params?: Stripe.Checkout.SessionListLineItemsParams
) => Promise<Pick<Stripe.ApiList<Stripe.LineItem>, 'data' | 'has_more'>>;

export type InvoiceItemCreateFn = (
  params: Stripe.InvoiceItemCreateParams
) => Promise<Pick<Stripe.InvoiceItem, 'id'>>;

export type TopUpPriceReader = {
  prices: {
    retrieve(
      id: string,
      params?: Stripe.PriceRetrieveParams
    ): Promise<Pick<Stripe.Price, 'id' | 'currency' | 'unit_amount' | 'tax_behavior'>>;
  };
};

export type ServiceFeeCheckoutDependencies = {
  store: ServiceFeeAssessmentStore;
  now?: Date;
  createAssessmentKey?: () => string;
  findEffectiveExemption?: EffectiveExemptionLookup;
  resolveTaxInput?: (params: {
    principal: ServiceFeeTaxPrincipal;
    stripe?: StripePriceTaxReader;
  }) => Promise<ServiceFeeTaxInput>;
  sendAlert?: (input: MissedServiceFeeAlertInput) => Promise<void>;
  stripe?: StripePriceTaxReader & Partial<TopUpPriceReader>;
  listCheckoutLineItems?: CheckoutLineItemListFn;
  expireCheckoutSession?: (sessionId: string) => Promise<unknown>;
  createInvoiceItem?: InvoiceItemCreateFn;
  retrieveCheckoutSessionCreated?: (paymentIntentId: string) => Promise<number | null>;
};

export type PreparedTopUpCheckoutFee = {
  assessmentKey: string;
  flow: CheckoutServiceFeeFlow;
  principalMinor: number;
  decision: PreparedServiceFeeDecision;
  outcome: ServiceFeeOutcome;
  expectedFeeMinor: number;
  checkoutLineItem?: Stripe.Checkout.SessionCreateParams.LineItem;
  commercialMetadata: ServiceFeeCommercialMetadata;
  failureCode?: string;
};

export type PreparedAutoTopUpInvoiceFee = {
  assessmentKey: string;
  flow: AutoTopUpInvoiceFlow;
  principalMinor: number;
  invoiceId: string;
  decision: PreparedServiceFeeDecision;
  outcome: ServiceFeeOutcome;
  expectedFeeMinor: number;
  feeInvoiceItem?: Stripe.InvoiceItemCreateParams;
  commercialMetadata: ServiceFeeCommercialMetadata;
  failureCode?: string;
};

export type TopUpSettlementResult = {
  principalMinor: number;
  chargedFeeMinor: number;
  grossPaidMinor: number;
  assessment: ServiceFeeAssessmentRecord | null;
  shouldCredit: boolean;
};

type FeeLineIdentity = {
  stripeCheckoutFeeLineItemId?: string;
  stripeFeePriceId?: string;
};

export function createCheckoutServiceFeeAssessmentKey(id: string = randomUUID()): string {
  return `checkout:${id}`;
}

export function createInvoiceServiceFeeAssessmentKey(invoiceId: string): string {
  return `invoice:${invoiceId}`;
}

export function isKiloOwnedAutoTopUpInvoice(
  invoice: Pick<Stripe.Invoice, 'metadata'> | { metadata?: Stripe.Metadata | null }
): boolean {
  const type = invoice.metadata?.type;
  return type === 'auto-topup' || type === 'org-auto-topup';
}

export function isWithinServiceFeeActivationBoundaryWindow(unixSeconds: number): boolean {
  return (
    Math.abs(unixSeconds - SERVICE_FEE_ACTIVATION_UNIX_SECONDS) <=
    SERVICE_FEE_ACTIVATION_BOUNDARY_WINDOW_SECONDS
  );
}

export function checkoutFeeDecisionDisagreesWithSessionCreated(params: {
  preparedOutcome: ServiceFeeOutcome;
  sessionCreatedUnixSeconds: number;
}): boolean {
  const sessionEligible = params.sessionCreatedUnixSeconds >= SERVICE_FEE_ACTIVATION_UNIX_SECONDS;
  if (params.preparedOutcome === 'pre_activation') {
    return sessionEligible;
  }
  if (params.preparedOutcome === 'pending') {
    return !sessionEligible;
  }
  return false;
}

export async function resolveFixedUsdPriceUnitAmount(params: {
  stripe: TopUpPriceReader;
  priceId: string;
}): Promise<number> {
  const price = await params.stripe.prices.retrieve(params.priceId);
  if (price.currency !== SERVICE_FEE_SUPPORTED_CURRENCY) {
    throw new Error(`top-up price ${params.priceId} must be usd, received ${price.currency}`);
  }
  if (typeof price.unit_amount !== 'number' || !Number.isSafeInteger(price.unit_amount)) {
    throw new Error(`top-up price ${params.priceId} must have a fixed usd unit_amount`);
  }
  if (price.unit_amount <= 0) {
    throw new Error(`top-up price ${params.priceId} unit_amount must be positive`);
  }
  return price.unit_amount;
}

export function buildTopUpServiceFeeCheckoutLineItem(params: {
  assessmentKey: string;
  feeMinor: number;
  taxInput: ServiceFeeTaxInput;
}): Stripe.Checkout.SessionCreateParams.LineItem {
  if (params.feeMinor <= 0) {
    throw new Error('positive service fee is required to build a checkout fee line');
  }

  const metadata = buildServiceFeeLineMetadata(params.assessmentKey);
  return {
    quantity: 1,
    price_data: {
      currency: SERVICE_FEE_SUPPORTED_CURRENCY,
      unit_amount: params.feeMinor,
      product_data: {
        name: SERVICE_FEE_DESCRIPTION,
        metadata,
      },
      ...(params.taxInput.taxBehavior ? { tax_behavior: params.taxInput.taxBehavior } : {}),
    },
  };
}

export function buildAutoTopUpServiceFeeInvoiceItem(params: {
  assessmentKey: string;
  invoiceId: string;
  customerId: string;
  feeMinor: number;
  taxInput: ServiceFeeTaxInput;
}): Stripe.InvoiceItemCreateParams {
  if (params.feeMinor <= 0) {
    throw new Error('positive service fee is required to build an invoice fee item');
  }

  return {
    customer: params.customerId,
    invoice: params.invoiceId,
    amount: params.feeMinor,
    currency: SERVICE_FEE_SUPPORTED_CURRENCY,
    description: SERVICE_FEE_DESCRIPTION,
    discountable: false,
    metadata: buildServiceFeeLineMetadata(params.assessmentKey),
    ...(params.taxInput.taxBehavior ? { tax_behavior: params.taxInput.taxBehavior } : {}),
  };
}

export function mergeServiceFeeCommercialMetadata(
  existing: Stripe.MetadataParam | null | undefined,
  commercial: ServiceFeeCommercialMetadata
): Stripe.MetadataParam {
  return {
    ...(existing ?? {}),
    ...commercial,
  };
}

export async function prepareTopUpCheckoutFee(params: {
  flow: CheckoutServiceFeeFlow;
  principalMinor: number;
  kiloUserId: string;
  organizationId?: string;
  stripeCustomerId?: string;
  taxPrincipal?: ServiceFeeTaxPrincipal;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<PreparedTopUpCheckoutFee> {
  const now = params.deps.now ?? new Date();
  const assessmentKey = (
    params.deps.createAssessmentKey ?? createCheckoutServiceFeeAssessmentKey
  )();
  const commercialMetadata = buildServiceFeeCommercialMetadata({
    assessmentKey,
    flow: params.flow,
    principalMinor: params.principalMinor,
    organizationId: params.organizationId,
  });

  try {
    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey,
        flow: params.flow,
        currency: SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt: now,
        eligibleSubtotalMinor: params.principalMinor,
        kiloUserId: params.kiloUserId,
        organizationId: params.organizationId,
        stripeCustomerId: params.stripeCustomerId,
      },
      { findEffectiveExemption: params.deps.findEffectiveExemption }
    );

    if (decision.outcome !== 'pending') {
      return {
        assessmentKey,
        flow: params.flow,
        principalMinor: params.principalMinor,
        decision,
        outcome: decision.outcome,
        expectedFeeMinor: decision.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const resolveTax = params.deps.resolveTaxInput ?? resolveServiceFeeTaxInput;
    const taxInput = await resolveTax({
      principal: params.taxPrincipal ?? { kind: 'inline' },
      stripe: params.deps.stripe,
    });

    return {
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      decision,
      outcome: 'pending',
      expectedFeeMinor: decision.expectedFeeMinor,
      checkoutLineItem: buildTopUpServiceFeeCheckoutLineItem({
        assessmentKey,
        feeMinor: decision.expectedFeeMinor,
        taxInput,
      }),
      commercialMetadata,
    };
  } catch (error) {
    const failureCode = failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION);
    const fallbackDecision = await safePrepareDecision({
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      stripeCustomerId: params.stripeCustomerId,
      now,
      findEffectiveExemption: params.deps.findEffectiveExemption,
    });
    return missedCheckoutPreparation({
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      decision: fallbackDecision,
      commercialMetadata,
      failureCode,
    });
  }
}

export async function createTopUpCheckoutSession(params: {
  prepared: PreparedTopUpCheckoutFee;
  buildSessionParams: (
    feeLineItem?: Stripe.Checkout.SessionCreateParams.LineItem
  ) => Stripe.Checkout.SessionCreateParams;
  createSession: CheckoutSessionCreateFn;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<CheckoutSessionLike> {
  const firstParams = params.buildSessionParams(params.prepared.checkoutLineItem);
  const firstSession = await params.createSession(firstParams);
  return finalizeTopUpCheckoutSession({
    prepared: params.prepared,
    session: firstSession,
    attemptUnixSeconds: Math.floor((params.deps.now ?? new Date()).getTime() / 1000),
    buildSessionParams: params.buildSessionParams,
    createSession: params.createSession,
    deps: params.deps,
  });
}

export async function persistTopUpCheckoutSession(params: {
  prepared: PreparedTopUpCheckoutFee;
  session: CheckoutSessionLike;
  deps: ServiceFeeCheckoutDependencies;
  replacementFailureCode?: string;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const identity = await resolveCheckoutFeeLineIdentity(params.session, params.deps);
  return persistPreparedAssessment({
    prepared: params.prepared,
    stripeIds: {
      stripeCustomerId: params.prepared.decision.stripeCustomerId,
      stripeCheckoutSessionId: params.session.id,
      ...identity,
    },
    eligibilityCreatedAt: new Date(params.session.created * 1000),
    deps: params.deps,
    replacementFailureCode: params.replacementFailureCode,
  });
}

export async function prepareAutoTopUpInvoiceFee(params: {
  flow: AutoTopUpInvoiceFlow;
  invoiceId: string;
  principalMinor: number;
  kiloUserId?: string;
  organizationId?: string;
  stripeCustomerId: string;
  invoiceCreated?: Date;
  taxPrincipal?: ServiceFeeTaxPrincipal;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<PreparedAutoTopUpInvoiceFee> {
  const now = params.invoiceCreated ?? params.deps.now ?? new Date();
  const assessmentKey = createInvoiceServiceFeeAssessmentKey(params.invoiceId);
  const commercialMetadata = buildServiceFeeCommercialMetadata({
    assessmentKey,
    flow: params.flow,
    principalMinor: params.principalMinor,
    organizationId: params.organizationId,
  });

  try {
    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey,
        flow: params.flow,
        currency: SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt: now,
        eligibleSubtotalMinor: params.principalMinor,
        kiloUserId: params.kiloUserId,
        organizationId: params.organizationId,
        stripeCustomerId: params.stripeCustomerId,
      },
      { findEffectiveExemption: params.deps.findEffectiveExemption }
    );

    if (decision.outcome !== 'pending') {
      await upsertServiceFeeAssessment({
        store: params.deps.store,
        decision,
        stripeIds: {
          stripeCustomerId: params.stripeCustomerId,
          stripeInvoiceId: params.invoiceId,
        },
        now,
      });
      return {
        assessmentKey,
        flow: params.flow,
        principalMinor: params.principalMinor,
        invoiceId: params.invoiceId,
        decision,
        outcome: decision.outcome,
        expectedFeeMinor: decision.expectedFeeMinor,
        commercialMetadata,
      };
    }

    const resolveTax = params.deps.resolveTaxInput ?? resolveServiceFeeTaxInput;
    const taxInput = await resolveTax({
      principal: params.taxPrincipal ?? { kind: 'inline' },
      stripe: params.deps.stripe,
    });

    await upsertServiceFeeAssessment({
      store: params.deps.store,
      decision,
      stripeIds: {
        stripeCustomerId: params.stripeCustomerId,
        stripeInvoiceId: params.invoiceId,
      },
      now,
    });

    return {
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      invoiceId: params.invoiceId,
      decision,
      outcome: 'pending',
      expectedFeeMinor: decision.expectedFeeMinor,
      feeInvoiceItem: buildAutoTopUpServiceFeeInvoiceItem({
        assessmentKey,
        invoiceId: params.invoiceId,
        customerId: params.stripeCustomerId,
        feeMinor: decision.expectedFeeMinor,
        taxInput,
      }),
      commercialMetadata,
    };
  } catch (error) {
    const failureCode = failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION);
    const fallbackDecision = await safePrepareDecision({
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      stripeCustomerId: params.stripeCustomerId,
      now,
      findEffectiveExemption: params.deps.findEffectiveExemption,
    });
    return persistMissedInvoicePreparation({
      assessmentKey,
      flow: params.flow,
      principalMinor: params.principalMinor,
      invoiceId: params.invoiceId,
      decision: fallbackDecision,
      commercialMetadata,
      stripeCustomerId: params.stripeCustomerId,
      failureCode,
      deps: params.deps,
      now,
    });
  }
}

export async function attachPreparedAutoTopUpInvoiceFee(params: {
  prepared: PreparedAutoTopUpInvoiceFee;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const now = params.deps.now ?? new Date();
  if (!params.prepared.feeInvoiceItem || params.prepared.outcome !== 'pending') {
    return params.deps.store.findByAssessmentKey(params.prepared.assessmentKey);
  }
  if (!params.deps.createInvoiceItem) {
    return persistMissedAfterPrepare({
      prepared: toCheckoutShaped(params.prepared),
      stripeIds: {
        stripeCustomerId: params.prepared.decision.stripeCustomerId,
        stripeInvoiceId: params.prepared.invoiceId,
      },
      deps: params.deps,
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
    });
  }

  try {
    const item = await params.deps.createInvoiceItem(params.prepared.feeInvoiceItem);
    return markServiceFeeAssessmentCharged({
      store: params.deps.store,
      assessmentKey: params.prepared.assessmentKey,
      chargedFeeMinor: params.prepared.expectedFeeMinor,
      stripeIds: {
        stripeCustomerId: params.prepared.decision.stripeCustomerId,
        stripeInvoiceId: params.prepared.invoiceId,
        stripeInvoiceFeeLineItemId: item.id,
      },
      now,
    });
  } catch (error) {
    return persistMissedAfterPrepare({
      prepared: toCheckoutShaped(params.prepared),
      stripeIds: {
        stripeCustomerId: params.prepared.decision.stripeCustomerId,
        stripeInvoiceId: params.prepared.invoiceId,
      },
      deps: params.deps,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
    });
  }
}

export async function settleTrustedTopUpCharge(params: {
  charge: Pick<Stripe.Charge, 'id' | 'amount' | 'created' | 'customer'>;
  paymentIntent: Pick<Stripe.PaymentIntent, 'id' | 'metadata' | 'customer'>;
  kiloUserId?: string;
  organizationId?: string;
  flowHint?: ServiceFeeFlow;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<TopUpSettlementResult> {
  const now = params.deps.now ?? new Date();
  const metadata = params.paymentIntent.metadata ?? {};
  const assessmentKey = nonempty(metadata.serviceFeeAssessmentKey);
  const metadataPrincipal = parseMinor(metadata.serviceFeePrincipalMinor);
  const amountCentsPrincipal = parseMinor(metadata.amountCents);
  const grossPaidMinor = params.charge.amount;

  if (assessmentKey) {
    const assessment = await params.deps.store.findByAssessmentKey(assessmentKey);
    if (!assessment) {
      await alertMissed({
        assessmentKey,
        flow: params.flowHint ?? inferFlowFromMetadata(metadata, params.organizationId),
        kiloUserId: params.kiloUserId,
        organizationId: params.organizationId,
        stripePaymentIntentId: params.paymentIntent.id,
        stripeChargeId: params.charge.id,
        eligibleSubtotalMinor: metadataPrincipal ?? 0,
        expectedFeeMinor: 0,
        failureCode: SERVICE_FEE_FAILURE_MISSING_ASSESSMENT,
        deps: params.deps,
      });
      const principalMinor = metadataPrincipal ?? amountCentsPrincipal;
      return {
        principalMinor: principalMinor ?? 0,
        chargedFeeMinor: 0,
        grossPaidMinor,
        assessment: null,
        shouldCredit: principalMinor != null,
      };
    }

    assertAssessmentMatchesCharge({
      assessment,
      paymentIntentId: params.paymentIntent.id,
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      principalMinor: metadataPrincipal ?? assessment.eligibleSubtotalMinor,
    });

    const principalMinor = metadataPrincipal ?? assessment.eligibleSubtotalMinor;
    const settled = await settleLoadedAssessment({
      assessment,
      principalMinor,
      chargedFeeMinor: observedTopUpChargedFeeMinor(assessment),
      grossPaidMinor,
      stripeIds: {
        stripePaymentIntentId: params.paymentIntent.id,
        stripeChargeId: params.charge.id,
        stripeCustomerId: customerId(params.charge.customer) ?? assessment.stripeCustomerId,
      },
      settledAt: unixToDate(params.charge.created) ?? now,
      deps: params.deps,
    });

    return {
      principalMinor,
      chargedFeeMinor: settled.chargedFeeMinor,
      grossPaidMinor: settled.grossPaidMinor,
      assessment: settled,
      shouldCredit: true,
    };
  }

  let sessionCreated: number | null = null;
  if (params.deps.retrieveCheckoutSessionCreated) {
    try {
      sessionCreated = await params.deps.retrieveCheckoutSessionCreated(params.paymentIntent.id);
    } catch {
      sessionCreated = null;
    }
  }
  const createdUnix = sessionCreated ?? null;
  const isLegacyPreActivation =
    createdUnix != null && createdUnix < SERVICE_FEE_ACTIVATION_UNIX_SECONDS;

  if (isLegacyPreActivation) {
    return {
      principalMinor: params.charge.amount,
      chargedFeeMinor: 0,
      grossPaidMinor,
      assessment: null,
      shouldCredit: true,
    };
  }

  const trustedPrincipal = metadataPrincipal ?? amountCentsPrincipal;
  if (trustedPrincipal != null) {
    if (createdUnix == null || createdUnix >= SERVICE_FEE_ACTIVATION_UNIX_SECONDS) {
      await alertMissed({
        assessmentKey: `missing:${params.paymentIntent.id}`,
        flow: params.flowHint ?? inferFlowFromMetadata(metadata, params.organizationId),
        kiloUserId: params.kiloUserId,
        organizationId: params.organizationId,
        stripePaymentIntentId: params.paymentIntent.id,
        stripeChargeId: params.charge.id,
        eligibleSubtotalMinor: trustedPrincipal,
        expectedFeeMinor: 0,
        failureCode: SERVICE_FEE_FAILURE_MISSING_ASSESSMENT,
        deps: params.deps,
      });
    }
    return {
      principalMinor: trustedPrincipal,
      chargedFeeMinor: 0,
      grossPaidMinor,
      assessment: null,
      shouldCredit: true,
    };
  }

  await alertMissed({
    assessmentKey: `untrusted:${params.paymentIntent.id}`,
    flow: params.flowHint ?? inferFlowFromMetadata(metadata, params.organizationId),
    kiloUserId: params.kiloUserId,
    organizationId: params.organizationId,
    stripePaymentIntentId: params.paymentIntent.id,
    stripeChargeId: params.charge.id,
    eligibleSubtotalMinor: params.charge.amount,
    expectedFeeMinor: 0,
    failureCode: SERVICE_FEE_FAILURE_PRINCIPAL_UNTRUSTED,
    deps: params.deps,
  });

  return {
    principalMinor: 0,
    chargedFeeMinor: 0,
    grossPaidMinor,
    assessment: null,
    shouldCredit: false,
  };
}

export async function settleTrustedAutoTopUpInvoice(params: {
  invoice: Pick<
    Stripe.Invoice,
    'id' | 'amount_paid' | 'created' | 'metadata' | 'status_transitions' | 'customer'
  >;
  chargeId: string;
  kiloUserId?: string;
  organizationId?: string;
  flow: AutoTopUpInvoiceFlow;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<TopUpSettlementResult> {
  const now = params.deps.now ?? new Date();
  const metadata = params.invoice.metadata ?? {};
  const assessmentKey =
    nonempty(metadata.serviceFeeAssessmentKey) ??
    (params.invoice.id ? createInvoiceServiceFeeAssessmentKey(params.invoice.id) : null);
  const metadataPrincipal = parseMinor(metadata.serviceFeePrincipalMinor);
  const grossPaidMinor = params.invoice.amount_paid;
  const paidAt =
    unixToDate(params.invoice.status_transitions?.paid_at) ??
    unixToDate(params.invoice.created) ??
    now;

  if (assessmentKey) {
    const assessment = await params.deps.store.findByAssessmentKey(assessmentKey);
    if (assessment) {
      const principalMinor = metadataPrincipal ?? assessment.eligibleSubtotalMinor;
      const settled = await settleLoadedAssessment({
        assessment,
        principalMinor,
        chargedFeeMinor: observedTopUpChargedFeeMinor(assessment),
        grossPaidMinor,
        stripeIds: {
          stripeInvoiceId: params.invoice.id,
          stripeChargeId: params.chargeId,
          stripeCustomerId: customerId(params.invoice.customer) ?? assessment.stripeCustomerId,
        },
        settledAt: paidAt,
        deps: params.deps,
      });
      return {
        principalMinor,
        chargedFeeMinor: settled.chargedFeeMinor,
        grossPaidMinor: settled.grossPaidMinor,
        assessment: settled,
        shouldCredit: true,
      };
    }
  }

  const invoiceCreated = params.invoice.created;
  if (invoiceCreated < SERVICE_FEE_ACTIVATION_UNIX_SECONDS) {
    return {
      principalMinor: params.invoice.amount_paid,
      chargedFeeMinor: 0,
      grossPaidMinor,
      assessment: null,
      shouldCredit: true,
    };
  }

  if (metadataPrincipal != null) {
    await alertMissed({
      assessmentKey: assessmentKey ?? `missing:${params.invoice.id}`,
      flow: params.flow,
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      stripeInvoiceId: params.invoice.id,
      stripeChargeId: params.chargeId,
      eligibleSubtotalMinor: metadataPrincipal,
      expectedFeeMinor: 0,
      failureCode: SERVICE_FEE_FAILURE_MISSING_ASSESSMENT,
      deps: params.deps,
    });
    return {
      principalMinor: metadataPrincipal,
      chargedFeeMinor: 0,
      grossPaidMinor,
      assessment: null,
      shouldCredit: true,
    };
  }

  await alertMissed({
    assessmentKey: assessmentKey ?? `untrusted:${params.invoice.id}`,
    flow: params.flow,
    kiloUserId: params.kiloUserId,
    organizationId: params.organizationId,
    stripeInvoiceId: params.invoice.id,
    stripeChargeId: params.chargeId,
    eligibleSubtotalMinor: params.invoice.amount_paid,
    expectedFeeMinor: 0,
    failureCode: SERVICE_FEE_FAILURE_PRINCIPAL_UNTRUSTED,
    deps: params.deps,
  });

  return {
    principalMinor: 0,
    chargedFeeMinor: 0,
    grossPaidMinor,
    assessment: null,
    shouldCredit: false,
  };
}

async function finalizeTopUpCheckoutSession(params: {
  prepared: PreparedTopUpCheckoutFee;
  session: CheckoutSessionLike;
  attemptUnixSeconds: number;
  buildSessionParams: (
    feeLineItem?: Stripe.Checkout.SessionCreateParams.LineItem
  ) => Stripe.Checkout.SessionCreateParams;
  createSession: CheckoutSessionCreateFn;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<CheckoutSessionLike> {
  const nearBoundary = isWithinServiceFeeActivationBoundaryWindow(params.attemptUnixSeconds);
  const disagrees = checkoutFeeDecisionDisagreesWithSessionCreated({
    preparedOutcome: params.prepared.outcome,
    sessionCreatedUnixSeconds: params.session.created,
  });

  if (!nearBoundary || !disagrees) {
    await persistTopUpCheckoutSession({
      prepared: params.prepared,
      session: params.session,
      deps: params.deps,
    });
    return params.session;
  }

  if (params.deps.expireCheckoutSession) {
    try {
      await params.deps.expireCheckoutSession(params.session.id);
    } catch {
      // Replacement still proceeds; the original session is abandoned.
    }
  }

  const replacementPrepared = await prepareReplacementForSessionCreated({
    original: params.prepared,
    sessionCreatedUnixSeconds: params.session.created,
    deps: params.deps,
  });
  const replacementSession = await params.createSession(
    params.buildSessionParams(replacementPrepared.checkoutLineItem)
  );

  const replacementDisagrees = checkoutFeeDecisionDisagreesWithSessionCreated({
    preparedOutcome: replacementPrepared.outcome,
    sessionCreatedUnixSeconds: replacementSession.created,
  });

  if (replacementDisagrees) {
    const failOpen = await prepareFailOpenReplacement({
      original: params.prepared,
      deps: params.deps,
    });
    if (params.deps.expireCheckoutSession) {
      try {
        await params.deps.expireCheckoutSession(replacementSession.id);
      } catch {
        // Continue with a principal-only session.
      }
    }
    const failOpenSession = await params.createSession(params.buildSessionParams(undefined));
    await persistTopUpCheckoutSession({
      prepared: failOpen,
      session: failOpenSession,
      deps: params.deps,
      replacementFailureCode: SERVICE_FEE_FAILURE_ACTIVATION_BOUNDARY,
    });
    return failOpenSession;
  }

  await persistTopUpCheckoutSession({
    prepared: replacementPrepared,
    session: replacementSession,
    deps: params.deps,
  });
  return replacementSession;
}

async function prepareReplacementForSessionCreated(params: {
  original: PreparedTopUpCheckoutFee;
  sessionCreatedUnixSeconds: number;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<PreparedTopUpCheckoutFee> {
  return prepareTopUpCheckoutFee({
    flow: params.original.flow,
    principalMinor: params.original.principalMinor,
    kiloUserId: params.original.decision.kiloUserId ?? '',
    organizationId: params.original.decision.organizationId ?? undefined,
    stripeCustomerId: params.original.decision.stripeCustomerId ?? undefined,
    deps: {
      ...params.deps,
      now: new Date(params.sessionCreatedUnixSeconds * 1000),
      createAssessmentKey: () => params.original.assessmentKey,
    },
  });
}

async function prepareFailOpenReplacement(params: {
  original: PreparedTopUpCheckoutFee;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<PreparedTopUpCheckoutFee> {
  return {
    ...params.original,
    outcome: 'missed',
    checkoutLineItem: undefined,
    failureCode: SERVICE_FEE_FAILURE_ACTIVATION_BOUNDARY,
  };
}

async function persistPreparedAssessment(params: {
  prepared: PreparedTopUpCheckoutFee;
  stripeIds: ServiceFeeStripeIds;
  eligibilityCreatedAt: Date;
  deps: ServiceFeeCheckoutDependencies;
  replacementFailureCode?: string;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const now = params.deps.now ?? new Date();
  const failureCode = params.replacementFailureCode ?? params.prepared.failureCode;

  try {
    const decision = {
      ...params.prepared.decision,
      eligibilityCreatedAt: toServiceFeeTimestamp(params.eligibilityCreatedAt),
    };
    const record = await upsertServiceFeeAssessment({
      store: params.deps.store,
      decision,
      stripeIds: params.stripeIds,
      now,
    });

    if (failureCode) {
      const missed = await markServiceFeeAssessmentMissed({
        store: params.deps.store,
        assessmentKey: params.prepared.assessmentKey,
        failureCode,
        stripeIds: params.stripeIds,
        now,
      });
      await alertForRecord(missed, params.deps);
      return missed;
    }

    if (
      params.prepared.outcome === 'pending' &&
      params.prepared.checkoutLineItem &&
      params.stripeIds.stripeCheckoutFeeLineItemId
    ) {
      return markServiceFeeAssessmentCharged({
        store: params.deps.store,
        assessmentKey: params.prepared.assessmentKey,
        chargedFeeMinor: 0,
        stripeIds: params.stripeIds,
        now,
      });
    }

    return record;
  } catch (error) {
    await alertMissed({
      assessmentKey: params.prepared.assessmentKey,
      flow: params.prepared.flow,
      kiloUserId: params.prepared.decision.kiloUserId,
      organizationId: params.prepared.decision.organizationId,
      stripeCheckoutSessionId: params.stripeIds.stripeCheckoutSessionId,
      eligibleSubtotalMinor: params.prepared.principalMinor,
      expectedFeeMinor: params.prepared.expectedFeeMinor,
      failureCode: failureCodeFromUnknown(error, SERVICE_FEE_FAILURE_APPLICATION),
      deps: params.deps,
    });
    return null;
  }
}

async function persistMissedAfterPrepare(params: {
  prepared: PreparedTopUpCheckoutFee;
  stripeIds: ServiceFeeStripeIds;
  deps: ServiceFeeCheckoutDependencies;
  failureCode: string;
}): Promise<ServiceFeeAssessmentRecord | null> {
  const now = params.deps.now ?? new Date();
  try {
    await upsertServiceFeeAssessment({
      store: params.deps.store,
      decision: params.prepared.decision,
      stripeIds: params.stripeIds,
      now,
    });
    const missed = await markServiceFeeAssessmentMissed({
      store: params.deps.store,
      assessmentKey: params.prepared.assessmentKey,
      failureCode: params.failureCode,
      stripeIds: params.stripeIds,
      now,
    });
    await alertForRecord(missed, params.deps);
    return missed;
  } catch (error) {
    await alertMissed({
      assessmentKey: params.prepared.assessmentKey,
      flow: params.prepared.decision.flow,
      kiloUserId: params.prepared.decision.kiloUserId,
      organizationId: params.prepared.decision.organizationId,
      stripeInvoiceId: params.stripeIds.stripeInvoiceId,
      eligibleSubtotalMinor: params.prepared.principalMinor,
      expectedFeeMinor: params.prepared.expectedFeeMinor,
      failureCode: failureCodeFromUnknown(error, params.failureCode),
      deps: params.deps,
    });
    return null;
  }
}

async function persistMissedInvoicePreparation(params: {
  assessmentKey: string;
  flow: AutoTopUpInvoiceFlow;
  principalMinor: number;
  invoiceId: string;
  decision: PreparedServiceFeeDecision;
  commercialMetadata: ServiceFeeCommercialMetadata;
  stripeCustomerId: string;
  failureCode: string;
  deps: ServiceFeeCheckoutDependencies;
  now: Date;
}): Promise<PreparedAutoTopUpInvoiceFee> {
  try {
    await upsertServiceFeeAssessment({
      store: params.deps.store,
      decision: params.decision,
      stripeIds: {
        stripeCustomerId: params.stripeCustomerId,
        stripeInvoiceId: params.invoiceId,
      },
      now: params.now,
    });
    if (params.decision.expectedFeeMinor > 0) {
      const missed = await markServiceFeeAssessmentMissed({
        store: params.deps.store,
        assessmentKey: params.assessmentKey,
        failureCode: params.failureCode,
        stripeIds: {
          stripeCustomerId: params.stripeCustomerId,
          stripeInvoiceId: params.invoiceId,
        },
        now: params.now,
      });
      await alertForRecord(missed, params.deps);
    }
  } catch (error) {
    await alertMissed({
      assessmentKey: params.assessmentKey,
      flow: params.flow,
      kiloUserId: params.decision.kiloUserId,
      organizationId: params.decision.organizationId,
      stripeInvoiceId: params.invoiceId,
      eligibleSubtotalMinor: params.principalMinor,
      expectedFeeMinor: params.decision.expectedFeeMinor,
      failureCode: failureCodeFromUnknown(error, params.failureCode),
      deps: params.deps,
    });
  }

  return {
    assessmentKey: params.assessmentKey,
    flow: params.flow,
    principalMinor: params.principalMinor,
    invoiceId: params.invoiceId,
    decision: params.decision,
    outcome: params.decision.expectedFeeMinor > 0 ? 'missed' : params.decision.outcome,
    expectedFeeMinor: params.decision.expectedFeeMinor,
    commercialMetadata: params.commercialMetadata,
    failureCode: params.failureCode,
  };
}

function missedCheckoutPreparation(params: {
  assessmentKey: string;
  flow: CheckoutServiceFeeFlow;
  principalMinor: number;
  decision: PreparedServiceFeeDecision;
  commercialMetadata: ServiceFeeCommercialMetadata;
  failureCode: string;
}): PreparedTopUpCheckoutFee {
  return {
    assessmentKey: params.assessmentKey,
    flow: params.flow,
    principalMinor: params.principalMinor,
    decision: params.decision,
    outcome: params.decision.expectedFeeMinor > 0 ? 'missed' : params.decision.outcome,
    expectedFeeMinor: params.decision.expectedFeeMinor,
    commercialMetadata: params.commercialMetadata,
    failureCode: params.decision.expectedFeeMinor > 0 ? params.failureCode : undefined,
  };
}

async function safePrepareDecision(params: {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  principalMinor: number;
  kiloUserId?: string;
  organizationId?: string;
  stripeCustomerId?: string;
  now: Date;
  findEffectiveExemption?: EffectiveExemptionLookup;
}): Promise<PreparedServiceFeeDecision> {
  try {
    return await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey: params.assessmentKey,
        flow: params.flow,
        currency: SERVICE_FEE_SUPPORTED_CURRENCY,
        eligibilityCreatedAt: params.now,
        eligibleSubtotalMinor: params.principalMinor,
        kiloUserId: params.kiloUserId,
        organizationId: params.organizationId,
        stripeCustomerId: params.stripeCustomerId,
      },
      { findEffectiveExemption: params.findEffectiveExemption }
    );
  } catch {
    const eligibleSubtotalMinor =
      Number.isSafeInteger(params.principalMinor) && params.principalMinor >= 0
        ? params.principalMinor
        : 0;
    const expectedFeeMinor = calculateServiceFeeMinor(eligibleSubtotalMinor);
    return {
      assessmentKey: params.assessmentKey,
      version: SERVICE_FEE_VERSION,
      flow: params.flow,
      outcome: expectedFeeMinor > 0 ? 'pending' : 'zero_rounded',
      currency: SERVICE_FEE_SUPPORTED_CURRENCY,
      kiloUserId: params.kiloUserId ?? null,
      organizationId: params.organizationId ?? null,
      stripeCustomerId: params.stripeCustomerId ?? null,
      eligibilityCreatedAt: params.now.toISOString(),
      eligibleSubtotalMinor,
      expectedFeeMinor,
      chargedFeeMinor: 0,
      exemptionId: null,
      failureCode: null,
      metadata: {},
    };
  }
}

async function resolveCheckoutFeeLineIdentity(
  session: CheckoutSessionLike,
  deps: ServiceFeeCheckoutDependencies
): Promise<FeeLineIdentity> {
  const fromEmbedded = identifyFeeLine(session.line_items?.data ?? []);
  if (fromEmbedded.stripeCheckoutFeeLineItemId) {
    return fromEmbedded;
  }
  if (!deps.listCheckoutLineItems) {
    return {};
  }
  try {
    const page = await deps.listCheckoutLineItems(session.id, {
      limit: 100,
      expand: ['data.price.product'],
    });
    return identifyFeeLine(page.data);
  } catch {
    return {};
  }
}

function identifyFeeLine(lines: readonly Stripe.LineItem[]): FeeLineIdentity {
  const feeLine = lines.find(line => isServiceFeeCheckoutLine(line));
  if (!feeLine) return {};
  const price = feeLine.price;
  return {
    stripeCheckoutFeeLineItemId: feeLine.id,
    stripeFeePriceId: typeof price === 'string' ? price : (price?.id ?? undefined),
  };
}

function hasTrustedTopUpFeeLineIdentity(assessment: ServiceFeeAssessmentRecord): boolean {
  return Boolean(
    assessment.stripeCheckoutFeeLineItemId ||
    assessment.stripeInvoiceFeeLineItemId ||
    assessment.stripeFeePriceId
  );
}

function observedTopUpChargedFeeMinor(assessment: ServiceFeeAssessmentRecord): number {
  if (assessment.outcome !== 'charged') return 0;
  if (assessment.chargedFeeMinor > 0) return assessment.chargedFeeMinor;
  if (hasTrustedTopUpFeeLineIdentity(assessment)) return assessment.expectedFeeMinor;
  return 0;
}

async function settleLoadedAssessment(params: {
  assessment: ServiceFeeAssessmentRecord;
  principalMinor: number;
  chargedFeeMinor: number;
  grossPaidMinor: number;
  stripeIds: ServiceFeeStripeIds;
  settledAt: Date;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<ServiceFeeAssessmentRecord> {
  let assessment = params.assessment;
  if (assessment.outcome === 'pending') {
    const trustedObservedFee =
      params.chargedFeeMinor > 0
        ? params.chargedFeeMinor
        : hasTrustedTopUpFeeLineIdentity(assessment)
          ? assessment.expectedFeeMinor
          : 0;
    if (trustedObservedFee > 0) {
      assessment = await markServiceFeeAssessmentCharged({
        store: params.deps.store,
        assessmentKey: assessment.assessmentKey,
        chargedFeeMinor: trustedObservedFee,
        stripeIds: params.stripeIds,
        now: params.deps.now,
      });
    } else if (assessment.expectedFeeMinor > 0) {
      assessment = await markServiceFeeAssessmentMissed({
        store: params.deps.store,
        assessmentKey: assessment.assessmentKey,
        failureCode: SERVICE_FEE_FAILURE_APPLICATION,
        stripeIds: params.stripeIds,
        now: params.deps.now,
      });
      await alertForRecord(assessment, params.deps);
    }
  }

  return settleServiceFeeAssessment({
    store: params.deps.store,
    assessmentKey: assessment.assessmentKey,
    settledAt: params.settledAt,
    settledProductMinor: params.principalMinor,
    grossPaidMinor: params.grossPaidMinor,
    chargedFeeMinor:
      assessment.outcome === 'charged' ? params.chargedFeeMinor || assessment.chargedFeeMinor : 0,
    stripeIds: params.stripeIds,
    now: params.deps.now,
  });
}

function assertAssessmentMatchesCharge(params: {
  assessment: ServiceFeeAssessmentRecord;
  paymentIntentId: string;
  kiloUserId?: string;
  organizationId?: string;
  principalMinor: number;
}): void {
  if (
    params.assessment.stripePaymentIntentId &&
    params.assessment.stripePaymentIntentId !== params.paymentIntentId
  ) {
    throw new Error(
      `service fee assessment ${params.assessment.assessmentKey} payment intent mismatch`
    );
  }
  if (params.organizationId && params.assessment.organizationId !== params.organizationId) {
    throw new Error(
      `service fee assessment ${params.assessment.assessmentKey} organization mismatch`
    );
  }
  if (
    params.kiloUserId &&
    params.assessment.kiloUserId &&
    params.assessment.kiloUserId !== params.kiloUserId
  ) {
    throw new Error(`service fee assessment ${params.assessment.assessmentKey} user mismatch`);
  }
  if (params.assessment.eligibleSubtotalMinor !== params.principalMinor) {
    throw new Error(`service fee assessment ${params.assessment.assessmentKey} principal mismatch`);
  }
}

function inferFlowFromMetadata(metadata: Stripe.Metadata, organizationId?: string): ServiceFeeFlow {
  const type = metadata.type;
  if (type === 'org-auto-topup-setup') return 'organization_auto_top_up_setup';
  if (type === 'auto-topup-setup') return 'personal_auto_top_up_setup';
  if (type === 'org-auto-topup') return 'organization_auto_top_up';
  if (type === 'auto-topup') return 'personal_auto_top_up';
  return organizationId ? 'organization_top_up' : 'personal_top_up';
}

function toCheckoutShaped(prepared: PreparedAutoTopUpInvoiceFee): PreparedTopUpCheckoutFee {
  return {
    assessmentKey: prepared.assessmentKey,
    flow: prepared.flow === 'organization_auto_top_up' ? 'organization_top_up' : 'personal_top_up',
    principalMinor: prepared.principalMinor,
    decision: prepared.decision,
    outcome: prepared.outcome,
    expectedFeeMinor: prepared.expectedFeeMinor,
    commercialMetadata: prepared.commercialMetadata,
    failureCode: prepared.failureCode,
  };
}

async function alertForRecord(
  record: ServiceFeeAssessmentRecord,
  deps: ServiceFeeCheckoutDependencies
): Promise<void> {
  await alertMissed({
    assessmentKey: record.assessmentKey,
    flow: record.flow,
    kiloUserId: record.kiloUserId,
    organizationId: record.organizationId,
    stripeCheckoutSessionId: record.stripeCheckoutSessionId,
    stripeInvoiceId: record.stripeInvoiceId,
    stripePaymentIntentId: record.stripePaymentIntentId,
    stripeChargeId: record.stripeChargeId,
    eligibleSubtotalMinor: record.eligibleSubtotalMinor,
    expectedFeeMinor: record.expectedFeeMinor,
    failureCode: record.failureCode ?? SERVICE_FEE_FAILURE_APPLICATION,
    deps,
  });
}

async function alertMissed(params: {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  kiloUserId?: string | null;
  organizationId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  failureCode: string;
  deps: ServiceFeeCheckoutDependencies;
}): Promise<void> {
  const sendAlert = params.deps.sendAlert ?? sendMissedServiceFeeAlert;
  await sendAlert({
    assessmentKey: params.assessmentKey,
    flow: params.flow,
    kiloUserId: params.kiloUserId,
    organizationId: params.organizationId,
    stripeCheckoutSessionId: params.stripeCheckoutSessionId,
    stripeInvoiceId: params.stripeInvoiceId,
    stripePaymentIntentId: params.stripePaymentIntentId,
    stripeChargeId: params.stripeChargeId,
    eligibleSubtotalMinor: params.eligibleSubtotalMinor,
    expectedFeeMinor: params.expectedFeeMinor,
    currency: SERVICE_FEE_SUPPORTED_CURRENCY,
    failureCode: params.failureCode,
    attemptedAt: params.deps.now ?? new Date(),
  });
}

function failureCodeFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,99}$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function nonempty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMinor(value: string | null | undefined): number | null {
  const raw = nonempty(value);
  if (!raw) return null;
  if (!/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function unixToDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function customerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && 'id' in customer) return customer.id;
  return null;
}

export type { ServiceFeeLineMetadata };
