import type { EnkryptScore } from '@kilocode/db/schema-types';

const syntheticMetrics = { risk_score: 0, safety_score: null } satisfies Partial<EnkryptScore>;
const syntheticUnreviewedProvider = 'fixture-provider';

export const ENKRYPT_SCORE_EXAMPLES = {
  status: 'success',
  data: {
    scores: [
      {
        model_name: 'gpt-oss-120b',
        provider: 'fireworks',
        source: 'OpenAI',
        ...syntheticMetrics,
      },
      {
        model_name: 'glm-4.5',
        provider: 'novita',
        source: 'zai-org',
        ...syntheticMetrics,
      },
      {
        model_name: 'Qwen3-8B',
        provider: 'openai_compatible',
        source: 'qwen',
        ...syntheticMetrics,
      },
      {
        model_name: 'gpt-5.1',
        provider: syntheticUnreviewedProvider,
        source: '',
        ...syntheticMetrics,
      },
      {
        model_name: 'gpt-5.2',
        provider: syntheticUnreviewedProvider,
        source: '',
        ...syntheticMetrics,
      },
      {
        model_name: 'gpt-5.5',
        provider: syntheticUnreviewedProvider,
        source: '',
        ...syntheticMetrics,
      },
      {
        model_name: 'gpt-5.4-2026-03-05',
        provider: syntheticUnreviewedProvider,
        source: '',
        ...syntheticMetrics,
      },
    ] satisfies EnkryptScore[],
  },
};
