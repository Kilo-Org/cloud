import { beforeAll, describe, it, expect } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  mapModelIdToVercel,
  mapResolvedModelIdToVercel,
  mapResolvedModelIdToVercelWithoutOverrides,
  mapVercelModelIdToOpenRouter,
  readVercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';

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

    it('rewrites the bytedance-seed/ prefix to bytedance/', async () => {
      await expect(mapModelIdToVercel('bytedance-seed/seed-1.6')).resolves.toBe(
        'bytedance/seed-1.6'
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

  it('maps the auto small free model to the paid model', async () => {
    await expect(mapModelIdToVercel(AUTO_SMALL_TARGET_MODELS.free)).resolves.toBe(
      AUTO_SMALL_TARGET_MODELS.paid
    );
  });
});

describe('mapVercelModelIdToOpenRouter', () => {
  const overrideMap = new Map(overrides.map(o => [o.openrouter_model_id, o.vercel_model_id]));

  it.each([
    ['bytedance/seed-1.8', 'bytedance-seed/seed-1.8'],
    ['mistral/mistral-large-4', 'mistralai/mistral-large-4'],
    ['alibaba/qwen3.5-flash', 'qwen/qwen3.5-flash'],
    ['spacexai/grok-4.20-reasoning', 'x-ai/grok-4.20-reasoning'],
    ['zai/glm-5.3-fast', 'z-ai/glm-5.3-fast'],
  ])('reverses the prefix of %s to %s', (vercelModelId, expected) => {
    expect(mapVercelModelIdToOpenRouter(vercelModelId, new Map())).toBe(expected);
  });

  it('leaves an unmapped prefix and an id without a slash unchanged', () => {
    expect(mapVercelModelIdToOpenRouter('amazon/nova-pro', new Map())).toBe('amazon/nova-pro');
    expect(mapVercelModelIdToOpenRouter('some-model', new Map())).toBe('some-model');
  });

  it('prefers the OpenRouter id of an override', () => {
    expect(mapVercelModelIdToOpenRouter('alibaba/qwen-3-14b', overrideMap)).toBe('qwen/qwen3-14b');
    expect(mapVercelModelIdToOpenRouter('meta/muse-wonder-1.0', overrideMap)).toBe(
      'meta/muse-wonder'
    );
  });

  it('returns undefined when an override sends the reversed id to another Vercel model', () => {
    expect(
      mapVercelModelIdToOpenRouter('alibaba/qwen-max', new Map([['qwen/qwen-max', 'other/model']]))
    ).toBeUndefined();
  });

  it('returns undefined when the forward prefix rewrite cannot produce the id', () => {
    expect(mapVercelModelIdToOpenRouter('x-ai/grok-4', new Map())).toBeUndefined();
  });

  it.each(['bytedance/seed-1.8', 'alibaba/qwen-3-14b', 'openai/gpt-5-fast', 'zai/glm-5.3-fast'])(
    'round-trips %s through mapResolvedModelIdToVercel',
    vercelModelId => {
      const openRouterModelId = mapVercelModelIdToOpenRouter(vercelModelId, overrideMap);
      expect(openRouterModelId).toBeDefined();
      expect(mapResolvedModelIdToVercel(openRouterModelId ?? '', overrideMap)).toBe(vercelModelId);
    }
  );
});
