export const CODING_PLAN_IDS = ['minimax-token-plan-plus'] as const;

export type CodingPlanId = (typeof CODING_PLAN_IDS)[number];
export type CodingPlanProviderId = 'minimax';

export type CodingPlanCatalogEntry = {
  planId: CodingPlanId;
  providerName: string;
  name: string;
  providerId: CodingPlanProviderId;
  costMicrodollars: number;
  billingPeriodDays: number;
};

export const CODING_PLAN_CATALOG = {
  'minimax-token-plan-plus': {
    planId: 'minimax-token-plan-plus',
    providerName: 'MiniMax',
    name: 'Token Plan Plus',
    providerId: 'minimax',
    costMicrodollars: 20_000_000,
    billingPeriodDays: 30,
  },
} satisfies Record<CodingPlanId, CodingPlanCatalogEntry>;

export function getCodingPlanCatalog(): CodingPlanCatalogEntry[] {
  return CODING_PLAN_IDS.map(planId => CODING_PLAN_CATALOG[planId]);
}

export function getCodingPlanPrice(planId: string): CodingPlanCatalogEntry | null {
  return isCodingPlanId(planId) ? CODING_PLAN_CATALOG[planId] : null;
}

export function isCodingPlanId(planId: string): planId is CodingPlanId {
  return CODING_PLAN_IDS.some(candidate => candidate === planId);
}
