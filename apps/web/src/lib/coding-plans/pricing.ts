import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';

export const CODING_PLAN_IDS = [
  'minimax-token-plan-plus',
  'minimax-token-plan-max',
  'minimax-token-plan-ultra',
  'byteplus-coding-plan-team-lite',
] as const;
export const CODING_PLAN_PROVIDER_IDS = ['minimax', 'byteplus-coding'] as const;

export type CodingPlanId = (typeof CODING_PLAN_IDS)[number];
export type CodingPlanProviderId = (typeof CODING_PLAN_PROVIDER_IDS)[number];

export type CodingPlanCatalogEntry = {
  planId: CodingPlanId;
  providerName: string;
  name: string;
  providerId: CodingPlanProviderId;
  coveredModelIds: readonly string[];
  costMicrodollars: number;
  billingPeriodDays: number;
  features: readonly string[];
};

const MINIMAX_COMMON_FEATURES = [
  'Kilo automatically configures MiniMax in your BYOK settings.',
  'Full access to the MiniMax model family (M3, M2.7, image, speech, music).',
  '1M context window for long documents and large codebases.',
  'Native multimodal understanding: image and video input.',
  'Access the web search MCP.',
  'Text, image, speech, and music share one quota.',
] as const;

function minimaxFeatures(tokenCopy: string, agentCopy: string): readonly string[] {
  const [setup, ...remaining] = MINIMAX_COMMON_FEATURES;
  return [setup, tokenCopy, ...remaining.slice(0, 3), agentCopy, ...remaining.slice(3)];
}

export const CODING_PLAN_CATALOG = {
  'minimax-token-plan-plus': {
    planId: 'minimax-token-plan-plus',
    providerName: 'MiniMax',
    name: 'Token Plan Plus',
    providerId: 'minimax',
    coveredModelIds: [MINIMAX_CURRENT_MODEL_ID],
    costMicrodollars: 20_000_000,
    billingPeriodDays: 30,
    features: minimaxFeatures('~1.7B tokens per month of M3 usage.', 'Run 3-4 concurrent agents.'),
  },
  'minimax-token-plan-max': {
    planId: 'minimax-token-plan-max',
    providerName: 'MiniMax',
    name: 'Token Plan Max',
    providerId: 'minimax',
    coveredModelIds: [MINIMAX_CURRENT_MODEL_ID],
    costMicrodollars: 50_000_000,
    billingPeriodDays: 30,
    features: minimaxFeatures('~5.1B tokens per month of M3 usage.', 'Run 4-5 concurrent agents.'),
  },
  'minimax-token-plan-ultra': {
    planId: 'minimax-token-plan-ultra',
    providerName: 'MiniMax',
    name: 'Token Plan Ultra',
    providerId: 'minimax',
    coveredModelIds: [MINIMAX_CURRENT_MODEL_ID],
    costMicrodollars: 120_000_000,
    billingPeriodDays: 30,
    features: minimaxFeatures('~12.5B tokens per month of M3 usage.', 'Run 6-7 concurrent agents.'),
  },
  'byteplus-coding-plan-team-lite': {
    planId: 'byteplus-coding-plan-team-lite',
    providerName: 'BytePlus',
    name: 'Coding Plan Lite',
    providerId: 'byteplus-coding',
    coveredModelIds: [
      'byteplus-coding/dola-seed-2.0-pro',
      'byteplus-coding/dola-seed-2.0-lite',
      'byteplus-coding/dola-seed-2.0-code',
      'byteplus-coding/bytedance-seed-code',
      'byteplus-coding/kimi-k2.5',
      'byteplus-coding/glm-5.1',
      'byteplus-coding/glm-5.2',
      'byteplus-coding/deepseek-v4-flash',
      'byteplus-coding/deepseek-v4-pro',
      'byteplus-coding/gpt-oss-120b',
    ],
    costMicrodollars: 20_000_000,
    billingPeriodDays: 30,
    features: [
      'Kilo automatically configures BytePlus in your BYOK settings.',
      'For moderate-intensity development use.',
      'Approximately 1,900 requests every 5 hours, 12,000 requests per week, and 24,000 requests per 30-day subscription period.',
      'Access to the approved BytePlus coding model set.',
      'Supported models share one plan quota; one prompt can use multiple model requests.',
    ],
  },
} satisfies Record<CodingPlanId, CodingPlanCatalogEntry>;

export function getCodingPlanCatalog(): CodingPlanCatalogEntry[] {
  return CODING_PLAN_IDS.map(planId => CODING_PLAN_CATALOG[planId]);
}

export function getCodingPlanPrice(planId: string): CodingPlanCatalogEntry | null {
  return isCodingPlanId(planId) ? CODING_PLAN_CATALOG[planId] : null;
}

export function getCodingPlansForProvider(providerId: string): CodingPlanCatalogEntry[] {
  return getCodingPlanCatalog().filter(plan => plan.providerId === providerId);
}

export function isCodingPlanId(planId: string): planId is CodingPlanId {
  return CODING_PLAN_IDS.some(candidate => candidate === planId);
}

export function hasCodingPlanForModel(providerId: string, modelId: string): boolean {
  return getCodingPlanCatalog().some(
    plan => plan.providerId === providerId && plan.coveredModelIds.includes(modelId)
  );
}

export function isMonthlyCodingPlan(planId?: string): boolean {
  return planId ? getCodingPlanPrice(planId)?.billingPeriodDays === 30 : false;
}
