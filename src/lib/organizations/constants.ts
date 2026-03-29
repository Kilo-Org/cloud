export const TOPUP_AMOUNT_QUERY_STRING_KEY = 'topup-amount-usd';
export const TOPUP_CANCELED_QUERY_STRING_KEY = 'topup-canceled';
// Default daily usage limit for members when accepting invitations
export const DEFAULT_MEMBER_DAILY_LIMIT_USD = 25.0;
export const STRIPE_SUB_QUERY_STRING_KEY = 'subscription_session_id';

import type { BillingCycle, OrganizationPlan } from './organization-types';

// Per-seat monthly rate indexed by plan and billing cycle
export const SEAT_PRICING = {
  teams: { monthly: 18, annual: 15 },
  enterprise: { monthly: 72, annual: 60 },
} as const;

export function seatPrice(plan: OrganizationPlan, cycle: BillingCycle): number {
  return SEAT_PRICING[plan][cycle];
}

export function annualTotal(plan: OrganizationPlan): number {
  return SEAT_PRICING[plan].annual * 12;
}

// Legacy aliases — prefer seatPrice(plan, cycle) in new code
export const TEAM_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = SEAT_PRICING.teams.monthly;
export const TEAM_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = SEAT_PRICING.teams.annual;
export const TEAM_SEAT_PRICE_YEARLY_BILLED_ANNUALLY_USD = SEAT_PRICING.teams.annual * 12;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = SEAT_PRICING.enterprise.monthly;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = SEAT_PRICING.enterprise.annual;
export const ENTERPRISE_SEAT_PRICE_YEARLY_BILLED_ANNUALLY_USD = SEAT_PRICING.enterprise.annual * 12;
export const TEAM_SEAT_PRICE_MONTHLY_USD = SEAT_PRICING.teams.annual;
export const ENTERPRISE_SEAT_PRICE_MONTHLY_USD = SEAT_PRICING.enterprise.annual;

export const KILO_ORGANIZATION_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
