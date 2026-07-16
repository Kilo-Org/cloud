import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import type { OwnerTopSpendDriver } from './spend-repository';
import { isCodingPlanSuggestionEligible } from './suggestion-eligibility';

const minimumSpendMicrodollars = 50_000_000;
const coveredDriver = {
  category: 'variable',
  source: 'ai_gateway',
  productKey: 'cli',
  featureKey: 'messages',
  modelOrPlanKey: MINIMAX_CURRENT_MODEL_ID,
  providerKey: 'minimax',
  actorUserId: 'user-1',
  totalMicrodollars: minimumSpendMicrodollars,
  spendRecordCount: 1,
} satisfies OwnerTopSpendDriver;

describe('Coding Plan suggestion eligibility', () => {
  test('allows personal usage of a model covered by a Coding Plan', () => {
    expect(
      isCodingPlanSuggestionEligible(
        { type: 'user', id: 'user-1' },
        coveredDriver,
        minimumSpendMicrodollars
      )
    ).toBe(true);
  });

  test('rejects organization-owned usage', () => {
    expect(
      isCodingPlanSuggestionEligible(
        { type: 'organization', id: '00000000-0000-0000-0000-000000000001' },
        coveredDriver,
        minimumSpendMicrodollars
      )
    ).toBe(false);
  });

  test.each([
    ['anthropic', 'anthropic/claude-opus-4.8'],
    ['openai', 'openai/gpt-5.4'],
    ['minimax', 'minimax/minimax-unsupported'],
  ])('rejects unsupported provider/model %s %s', (providerKey, modelOrPlanKey) => {
    expect(
      isCodingPlanSuggestionEligible(
        { type: 'user', id: 'user-1' },
        { ...coveredDriver, providerKey, modelOrPlanKey },
        minimumSpendMicrodollars
      )
    ).toBe(false);
  });

  test('rejects scheduled spend', () => {
    expect(
      isCodingPlanSuggestionEligible(
        { type: 'user', id: 'user-1' },
        { ...coveredDriver, category: 'scheduled' },
        minimumSpendMicrodollars
      )
    ).toBe(false);
  });
});
