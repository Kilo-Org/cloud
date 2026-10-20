import { beforeAll, describe, it, expect } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  mapModelIdToVercel,
  mapResolvedModelIdToVercelWithoutOverrides,
  readVercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

const overrides = [
  { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/muse-wonder-1.0' },
  { openrouter_model_id: 'gpt-4o', vercel_model_id: 'openai/gpt-4o' },
  { openrouter_model_id: 'qwen/qwen3-14b', vercel_model_id: 'alibaba/qwen-3-14b' },
];

beforeAll(async () => {
  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({ vercel_model_id_overrides: { overrides } });
});

describe('mapModelIdToVercel', () => {
  describe('catalog aliases', () => {
    it('leaves an unresolved latest alias unchanged', async () => {
      await expect(mapModelIdToVercel('~anthropic/claude-sonnet-latest')).resolves.toBe(
        '~anthropic/claude-sonnet-latest'
      );
    });
  });

  describe('model ID overrides', () => {
    it('reads the stored overrides', async () => {
      expect(await readVercelModelIdOverrides()).toEqual(
        new Map(overrides.map(o => [o.openrouter_model_id, o.vercel_model_id]))
      );
    });

    it.each(overrides.map(o => [o.openrouter_model_id, o.vercel_model_id]))(
      'maps %s to %s',
      async (input, expected) => {
        await expect(mapModelIdToVercel(input)).resolves.toBe(expected);
      }
    );

    it('takes precedence over the built-in prefix rewrite', async () => {
      expect(mapResolvedModelIdToVercelWithoutOverrides('qwen/qwen3-14b')).toBe(
        'alibaba/qwen3-14b'
      );
      await expect(mapModelIdToVercel('qwen/qwen3-14b')).resolves.toBe('alibaba/qwen-3-14b');
    });

    it('falls back to the built-in rules for models without an override', async () => {
      await expect(mapModelIdToVercel('gpt-4o-mini')).resolves.toBe('gpt-4o-mini');
    });
  });

  describe('model prefix mapping', () => {
    it('leaves the anthropic/ prefix unchanged', async () => {
      await expect(mapModelIdToVercel('anthropic/claude-sonnet-4.5')).resolves.toBe(
        'anthropic/claude-sonnet-4.5'
      );
    });

    it('rewrites the mistralai/ prefix to mistral/', async () => {
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

    it('maps the Vercel-served Glyph Cluster stealth model to its gateway id', async () => {
      await expect(mapModelIdToVercel('stealth/glyph-cluster')).resolves.toBe(
        'stealth/glyph-cluster'
      );
    });

    it('maps the Vercel-served Reflection Beam free model to its gateway id', async () => {
      await expect(mapModelIdToVercel('reflection/beam-free')).resolves.toBe(
        'reflection/beam-free'
      );
    });
  });
});
