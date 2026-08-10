import { describe, it, expect } from '@jest/globals';
import {
  CLAUDE_FABLE_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID,
  GEMINI_PRO_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/google';
import { KIMI_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import {
  GPT_CURRENT_VERCEL_MODEL_ID,
  GPT_MINI_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/openai';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { GROK_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/xai';
import {
  CLAUDE_FABLE_LATEST_MODEL_ALIAS,
  CLAUDE_HAIKU_LATEST_MODEL_ALIAS,
  CLAUDE_OPUS_LATEST_MODEL_ALIAS,
  CLAUDE_SONNET_LATEST_MODEL_ALIAS,
  DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS,
  GEMINI_FLASH_LATEST_MODEL_ALIAS,
  GEMINI_PRO_LATEST_MODEL_ALIAS,
  GPT_LATEST_MODEL_ALIAS,
  GPT_MINI_LATEST_MODEL_ALIAS,
  GROK_LATEST_MODEL_ALIAS,
  KIMI_LATEST_MODEL_ALIAS,
  LATEST_MODEL_ALIASES,
} from '@/lib/ai-gateway/latest-model-aliases';

describe('mapModelIdToVercel', () => {
  describe('tilde-prefixed latest aliases', () => {
    it.each([
      [CLAUDE_FABLE_LATEST_MODEL_ALIAS, CLAUDE_FABLE_CURRENT_VERCEL_MODEL_ID],
      [CLAUDE_OPUS_LATEST_MODEL_ALIAS, CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID],
      [CLAUDE_SONNET_LATEST_MODEL_ALIAS, CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID],
      [CLAUDE_HAIKU_LATEST_MODEL_ALIAS, CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID],
      [GPT_LATEST_MODEL_ALIAS, GPT_CURRENT_VERCEL_MODEL_ID],
      [GPT_MINI_LATEST_MODEL_ALIAS, GPT_MINI_CURRENT_VERCEL_MODEL_ID],
      [KIMI_LATEST_MODEL_ALIAS, KIMI_CURRENT_VERCEL_MODEL_ID],
      [GEMINI_PRO_LATEST_MODEL_ALIAS, GEMINI_PRO_CURRENT_VERCEL_MODEL_ID],
      [GEMINI_FLASH_LATEST_MODEL_ALIAS, GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID],
      [GROK_LATEST_MODEL_ALIAS, GROK_CURRENT_VERCEL_MODEL_ID],
      [DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS, 'deepseek/deepseek-v4-flash-0731'],
    ])('maps %s to the current Vercel model id', (input, expected) => {
      expect(mapModelIdToVercel(input)).toBe(expected);
    });

    it('exports every latest alias in one list', () => {
      expect(LATEST_MODEL_ALIASES).toEqual([
        CLAUDE_FABLE_LATEST_MODEL_ALIAS,
        CLAUDE_OPUS_LATEST_MODEL_ALIAS,
        CLAUDE_SONNET_LATEST_MODEL_ALIAS,
        CLAUDE_HAIKU_LATEST_MODEL_ALIAS,
        GPT_LATEST_MODEL_ALIAS,
        GPT_MINI_LATEST_MODEL_ALIAS,
        KIMI_LATEST_MODEL_ALIAS,
        GEMINI_PRO_LATEST_MODEL_ALIAS,
        GEMINI_FLASH_LATEST_MODEL_ALIAS,
        GROK_LATEST_MODEL_ALIAS,
        DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS,
      ]);
    });

    it('does not map a latest alias that is missing the leading tilde', () => {
      expect(mapModelIdToVercel('deepseek/deepseek-v4-flash-latest')).toBe(
        'deepseek/deepseek-v4-flash-latest'
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
      ['mistralai/pixtral-large-2411', 'mistral/pixtral-large'],
      ['qwen/qwen3-14b', 'alibaba/qwen-3-14b'],
      ['qwen/qwen3-235b-a22b', 'alibaba/qwen-3-235b'],
      ['qwen/qwen3-30b-a3b', 'alibaba/qwen-3-30b'],
      ['qwen/qwen3-32b', 'alibaba/qwen-3-32b'],
    ])('maps %s to %s', (input, expected) => {
      expect(mapModelIdToVercel(input)).toBe(expected);
    });
  });

  describe('first-party inference provider inference', () => {
    it('rewrites the anthropic/ prefix unchanged', () => {
      expect(mapModelIdToVercel('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    });

    it('rewrites the mistralai/ prefix to mistral/', () => {
      // not covered by the hardcoded mapping
      expect(mapModelIdToVercel('mistralai/some-new-model')).toBe('mistral/some-new-model');
    });

    it('rewrites the qwen/ prefix to alibaba/', () => {
      expect(mapModelIdToVercel('qwen/some-new-qwen-model')).toBe('alibaba/some-new-qwen-model');
    });

    it('rewrites x-ai/ to xai/', () => {
      expect(mapModelIdToVercel('x-ai/some-new-grok')).toBe('xai/some-new-grok');
    });

    it('rewrites z-ai/ to zai/', () => {
      expect(mapModelIdToVercel('z-ai/glm-5.1')).toBe('zai/glm-5.1');
    });

    it('leaves gpt-oss models unchanged', () => {
      expect(mapModelIdToVercel('openai/gpt-oss-20b')).toBe('openai/gpt-oss-20b');
    });

    it('leaves the OpenRouter-only Poolside model unchanged', () => {
      expect(mapModelIdToVercel('poolside/laguna-s-2.1:free')).toBe('poolside/laguna-s-2.1:free');
    });

    it('leaves a model with an unknown provider prefix unchanged', () => {
      expect(mapModelIdToVercel('deepseek/deepseek-v3.2')).toBe('deepseek/deepseek-v3.2');
    });

    it('returns the model id as-is when it contains no slash', () => {
      expect(mapModelIdToVercel('some-model-without-slash')).toBe('some-model-without-slash');
    });
  });

  describe('kilo-exclusive models', () => {
    it('maps an exclusive flagged with vercel-routing to its internal id', () => {
      // google/gemma-4-26b-a4b-it:free is registered in kiloExclusiveModels
      // with the 'vercel-routing' flag and internal_id 'google/gemma-4-26b-a4b-it'.
      expect(mapModelIdToVercel('google/gemma-4-26b-a4b-it:free')).toBe(
        'google/gemma-4-26b-a4b-it'
      );
    });

    it('does not use internal_id for exclusives that are not vercel-routed', () => {
      // claude_sonnet_4_6_stealth_model has gateway 'martian' and no
      // 'vercel-routing' flag, so the mapping must pass the public id through
      // the generic prefix rewrite instead of substituting internal_id.
      expect(mapModelIdToVercel('stealth/claude-sonnet-4.6')).toBe('stealth/claude-sonnet-4.6');
    });

    it('does not use internal_id for disabled exclusives even when vercel-routed', () => {
      // minimax_m25_free_model has the 'vercel-routing' flag but status
      // 'disabled', so it must not be substituted by internal_id and instead
      // pass the public id through the generic prefix rewrite.
      expect(mapModelIdToVercel('minimax/minimax-m2.5:free')).toBe('minimax/minimax-m2.5:free');
    });
  });
});
