import type Stripe from 'stripe';

import type {
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';

export const SERVICE_FEE_FLOWS = [
  'personal_top_up',
  'organization_top_up',
  'personal_auto_top_up_setup',
  'organization_auto_top_up_setup',
  'personal_auto_top_up',
  'organization_auto_top_up',
  'personal_kilo_pass',
  'organization_kilo_pass',
] as const;

export type ServiceFeeFlow = (typeof SERVICE_FEE_FLOWS)[number];

export const PERSONAL_SERVICE_FEE_FLOWS = [
  'personal_top_up',
  'personal_auto_top_up_setup',
  'personal_auto_top_up',
  'personal_kilo_pass',
] as const satisfies readonly ServiceFeeFlow[];

export type PersonalServiceFeeFlow = (typeof PERSONAL_SERVICE_FEE_FLOWS)[number];

export const ORGANIZATION_SERVICE_FEE_FLOWS = [
  'organization_top_up',
  'organization_auto_top_up_setup',
  'organization_auto_top_up',
  'organization_kilo_pass',
] as const satisfies readonly ServiceFeeFlow[];

export type OrganizationServiceFeeFlow = (typeof ORGANIZATION_SERVICE_FEE_FLOWS)[number];

export const SERVICE_FEE_OUTCOMES = [
  'pending',
  'charged',
  'exempt',
  'pre_activation',
  'zero_rounded',
  'unsupported_currency',
  'missed',
] as const;

export type ServiceFeeOutcome = (typeof SERVICE_FEE_OUTCOMES)[number];

export const SERVICE_FEE_ELIGIBILITIES = ['eligible', 'exempt', 'pre_activation'] as const;

export type ServiceFeeEligibility = (typeof SERVICE_FEE_ELIGIBILITIES)[number];

export const SERVICE_FEE_OWNER_KINDS = ['personal', 'organization'] as const;

export type ServiceFeeOwnerKind = (typeof SERVICE_FEE_OWNER_KINDS)[number];

export type ServiceFeePersonalOwner = {
  kind: 'personal';
  kiloUserId: string;
};

export type ServiceFeeOrganizationOwner = {
  kind: 'organization';
  organizationId: string;
  kiloUserId?: string;
};

export type ServiceFeeOwner = ServiceFeePersonalOwner | ServiceFeeOrganizationOwner;

export const SERVICE_FEE_SUPPORTED_CURRENCY = 'usd';

export type ServiceFeeSupportedCurrency = typeof SERVICE_FEE_SUPPORTED_CURRENCY;

export type ServiceFeeLineMetadata = {
  type: typeof SERVICE_FEE_METADATA_TYPE;
  serviceFeeVersion: typeof SERVICE_FEE_VERSION;
  serviceFeeAssessmentKey: string;
  serviceFeeRateBasisPoints: `${typeof SERVICE_FEE_RATE_BASIS_POINTS}`;
};

export type ServiceFeeCommercialMetadata = {
  serviceFeeAssessmentKey: string;
  serviceFeeVersion: typeof SERVICE_FEE_VERSION;
  serviceFeeFlow: ServiceFeeFlow;
  serviceFeePrincipalMinor?: string;
  serviceFeeOrganizationId?: string;
};

export type PrepareAssessmentInput = {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  currency: string;
  eligibilityCreatedAt: Date;
  eligibleSubtotalMinor: number;
  kiloUserId?: string;
  organizationId?: string;
  stripeCustomerId?: string;
};

export type FeeApplicationResult = {
  assessmentId: string | null;
  assessmentKey: string;
  outcome: ServiceFeeOutcome;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  chargedFeeMinor: number;
  checkoutLineItem?: Stripe.Checkout.SessionCreateParams.LineItem;
};

export type CalculateCumulativeFeeRefundInput = {
  originalProductMinor: number;
  originalFeeMinor: number;
  cumulativeProductRefundMinor: number;
};

const PERSONAL_SERVICE_FEE_FLOW_SET = new Set<string>(PERSONAL_SERVICE_FEE_FLOWS);
const ORGANIZATION_SERVICE_FEE_FLOW_SET = new Set<string>(ORGANIZATION_SERVICE_FEE_FLOWS);

export function isServiceFeeFlow(value: string): value is ServiceFeeFlow {
  return (SERVICE_FEE_FLOWS as readonly string[]).includes(value);
}

export function isServiceFeeOutcome(value: string): value is ServiceFeeOutcome {
  return (SERVICE_FEE_OUTCOMES as readonly string[]).includes(value);
}

export function isServiceFeeEligibility(value: string): value is ServiceFeeEligibility {
  return (SERVICE_FEE_ELIGIBILITIES as readonly string[]).includes(value);
}

export function isPersonalServiceFeeFlow(flow: ServiceFeeFlow): flow is PersonalServiceFeeFlow {
  return PERSONAL_SERVICE_FEE_FLOW_SET.has(flow);
}

export function isOrganizationServiceFeeFlow(
  flow: ServiceFeeFlow
): flow is OrganizationServiceFeeFlow {
  return ORGANIZATION_SERVICE_FEE_FLOW_SET.has(flow);
}

export function isSupportedServiceFeeCurrency(
  currency: string
): currency is ServiceFeeSupportedCurrency {
  return currency === SERVICE_FEE_SUPPORTED_CURRENCY;
}

export function getServiceFeeOwnerKind(flow: ServiceFeeFlow): ServiceFeeOwnerKind {
  return isOrganizationServiceFeeFlow(flow) ? 'organization' : 'personal';
}

export function getServiceFeeOwner(
  flow: ServiceFeeFlow,
  input: Pick<PrepareAssessmentInput, 'kiloUserId' | 'organizationId'>
): ServiceFeeOwner {
  if (isOrganizationServiceFeeFlow(flow)) {
    if (!input.organizationId) {
      throw new Error(`organization service-fee flow ${flow} requires organizationId`);
    }
    return input.kiloUserId
      ? {
          kind: 'organization',
          organizationId: input.organizationId,
          kiloUserId: input.kiloUserId,
        }
      : { kind: 'organization', organizationId: input.organizationId };
  }

  if (!input.kiloUserId) {
    throw new Error(`personal service-fee flow ${flow} requires kiloUserId`);
  }
  if (input.organizationId) {
    throw new Error(`personal service-fee flow ${flow} forbids organizationId`);
  }
  return { kind: 'personal', kiloUserId: input.kiloUserId };
}
