import { describe, it, expect, jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ models: unknown }>>>().mockResolvedValue([]);

jest.mock('@/lib/drizzle', () => ({
  readDb: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn(() => ({ limit: mockLimit })),
      })),
    })),
  },
}));
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

describe('mapModelIdToVercel', () => {
  describe('catalog aliases', () => {
    it('leaves an unresolved latest alias unchanged', async () => {
      await expect(mapModelIdToVercel('~anthropic/claude-sonnet-latest')).resolves.toBe(
        '~anthropic/claude-sonnet-latest'
      );
    });
  });

  describe('hardcoded OpenRouter → Vercel mapping', () => {
    it.each([
      ['mistralai/codestral-2508', 'mistral/codestral'],
      ['mistralai/devstral-2512', 'mistral/devstral-2'],
      ['mistralai/mistral-embed-2312', 'mistral/mistral-embed'],
      ['mistralai/codestral-embed-2505', 'mistral/codestral-embed'],
      ['mistralai/ministral-14b-2512', 'mistral/ministral-14b'],
      ['mistralai/ministral-3b-2512', 'mistral/ministral-3b'],
      ['mistralai/ministral-8b-2512', 'mistral/ministral-8b'],
      ['mistralai/mistral-large-2512', 'mistral/mistral-large-3'],
      ['mistralai/mistral-medium-3-5', 'mistral/mistral-medium-3.5'],
      ['mistralai/mistral-small-2603', 'mistral/mistral-small'],
      ['qwen/qwen3-14b', 'alibaba/qwen-3-14b'],
      ['qwen/qwen3-235b-a22b', 'alibaba/qwen-3-235b'],
      ['qwen/qwen3-30b-a3b', 'alibaba/qwen-3-30b'],
      ['qwen/qwen3-32b', 'alibaba/qwen-3-32b'],
      ['anthropic/claude-haiku-4-5', 'anthropic/claude-haiku-4.5'],
      ['anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'],
      ['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'],
      ['anthropic/claude-sonnet-5-20260630', 'anthropic/claude-sonnet-5'],
      ['claude-sonnet-4', 'anthropic/claude-sonnet-4'],
      ['claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5'],
      ['claude-sonnet-5', 'anthropic/claude-sonnet-5'],
      ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
      ['deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731'],
      ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
      ['gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite'],
      ['minimax-m2.5', 'minimax/minimax-m2.5'],
      ['minimax-m3', 'minimax/minimax-m3'],
      ['minimax/minimax-m2.5-20260211', 'minimax/minimax-m2.5'],
      ['kimi-k3', 'moonshotai/kimi-k3'],
      ['gpt-4.1-mini', 'openai/gpt-4.1-mini'],
      ['gpt-4o', 'openai/gpt-4o'],
      ['gpt-4o-mini', 'openai/gpt-4o-mini'],
      ['gpt-5.2', 'openai/gpt-5.2'],
      ['gpt-5.2-codex', 'openai/gpt-5.2-codex'],
      ['gpt-5.4', 'openai/gpt-5.4'],
      ['gpt-5.4-mini', 'openai/gpt-5.4-mini'],
      ['gpt-5.5', 'openai/gpt-5.5'],
      ['gpt-5.6-luna', 'openai/gpt-5.6-luna'],
      ['gpt-5.6-sol', 'openai/gpt-5.6-sol'],
      ['gpt-5.6-terra', 'openai/gpt-5.6-terra'],
      ['step-3.5-flash', 'stepfun/step-3.5-flash'],
      ['mimo-v2.5', 'xiaomi/mimo-v2.5'],
      ['glm-5.1', 'zai/glm-5.1'],
      ['glm-5.2', 'zai/glm-5.2'],
    ])('maps %s to %s', async (input, expected) => {
      await expect(mapModelIdToVercel(input)).resolves.toBe(expected);
    });

    it.each([
      ['gpt-4o-2024-08-06', 'gpt-4o-2024-08-06'],
      ['claude-fable-5', 'claude-fable-5'],
    ])('does not retain a mapping for %s', async (input, expected) => {
      await expect(mapModelIdToVercel(input)).resolves.toBe(expected);
    });
  });

  describe('first-party inference provider inference', () => {
    it('rewrites the anthropic/ prefix unchanged', async () => {
      await expect(mapModelIdToVercel('anthropic/claude-sonnet-4.5')).resolves.toBe(
        'anthropic/claude-sonnet-4.5'
      );
    });

    it('rewrites the mistralai/ prefix to mistral/', async () => {
      // not covered by the hardcoded mapping
      await expect(mapModelIdToVercel('mistralai/some-new-model')).resolves.toBe(
        'mistral/some-new-model'
      );
    });

    it('rewrites the qwen/ prefix to alibaba/', async () => {
      await expect(mapModelIdToVercel('qwen/some-new-qwen-model')).resolves.toBe(
        'alibaba/some-new-qwen-model'
      );
    });

    it('rewrites x-ai/ to spacexai/', async () => {
      await expect(mapModelIdToVercel('x-ai/some-new-grok')).resolves.toBe(
        'spacexai/some-new-grok'
      );
    });

    it('rewrites z-ai/ to zai/', async () => {
      await expect(mapModelIdToVercel('z-ai/glm-5.1')).resolves.toBe('zai/glm-5.1');
    });

    it('leaves gpt-oss models unchanged', async () => {
      await expect(mapModelIdToVercel('openai/gpt-oss-20b')).resolves.toBe('openai/gpt-oss-20b');
    });

    it('leaves the OpenRouter-only Poolside model unchanged', async () => {
      await expect(mapModelIdToVercel('poolside/laguna-s-2.1:free')).resolves.toBe(
        'poolside/laguna-s-2.1:free'
      );
    });

    it('leaves a model with an unknown provider prefix unchanged', async () => {
      await expect(mapModelIdToVercel('deepseek/deepseek-v3.2')).resolves.toBe(
        'deepseek/deepseek-v3.2'
      );
    });

    it('returns the model id as-is when it contains no slash', async () => {
      await expect(mapModelIdToVercel('some-model-without-slash')).resolves.toBe(
        'some-model-without-slash'
      );
    });
  });

  describe('kilo-exclusive models', () => {
    it('maps an exclusive flagged with vercel-routing to its internal id', async () => {
      // google/gemma-4-26b-a4b-it:free is registered in kiloExclusiveModels
      // with the 'vercel-routing' flag and internal_id 'google/gemma-4-26b-a4b-it'.
      await expect(mapModelIdToVercel('google/gemma-4-26b-a4b-it:free')).resolves.toBe(
        'google/gemma-4-26b-a4b-it'
      );
    });

    it('does not use internal_id for exclusives that are not vercel-routed', async () => {
      // claude_sonnet_4_6_stealth_model has gateway 'martian' and no
      // 'vercel-routing' flag, so the mapping must pass the public id through
      // the generic prefix rewrite instead of substituting internal_id.
      await expect(mapModelIdToVercel('stealth/claude-sonnet-4.6')).resolves.toBe(
        'stealth/claude-sonnet-4.6'
      );
    });

    it('does not use internal_id for disabled exclusives even when vercel-routed', async () => {
      // minimax_m25_free_model has the 'vercel-routing' flag but status
      // 'disabled', so it must not be substituted by internal_id and instead
      // pass the public id through the generic prefix rewrite.
      await expect(mapModelIdToVercel('minimax/minimax-m2.5:free')).resolves.toBe(
        'minimax/minimax-m2.5:free'
      );
    });
  });
});
