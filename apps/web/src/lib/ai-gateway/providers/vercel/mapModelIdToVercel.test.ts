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

describe('mapModelIdToVercel', () => {
  describe('tilde-prefixed latest aliases', () => {
    it.each([
      ['~anthropic/claude-fable-latest', CLAUDE_FABLE_CURRENT_VERCEL_MODEL_ID],
      ['~anthropic/claude-opus-latest', CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID],
      ['~anthropic/claude-sonnet-latest', CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID],
      ['~anthropic/claude-haiku-latest', CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID],
      ['~openai/gpt-latest', GPT_CURRENT_VERCEL_MODEL_ID],
      ['~openai/gpt-mini-latest', GPT_MINI_CURRENT_VERCEL_MODEL_ID],
      ['~moonshotai/kimi-latest', KIMI_CURRENT_VERCEL_MODEL_ID],
      ['~google/gemini-pro-latest', GEMINI_PRO_CURRENT_VERCEL_MODEL_ID],
      ['~google/gemini-flash-latest', GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID],
      ['~x-ai/grok-latest', GROK_CURRENT_VERCEL_MODEL_ID],
    ])('maps %s to the current Vercel model id', (input, expected) => {
      expect(mapModelIdToVercel(input)).toBe(expected);
    });

    it('does not map a latest alias that is missing the leading tilde', () => {
      expect(mapModelIdToVercel('anthropic/claude-opus-latest')).toBe(
        'anthropic/claude-opus-latest'
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

    it('leaves a model with an unknown provider prefix unchanged', () => {
      expect(mapModelIdToVercel('deepseek/deepseek-v3.2')).toBe('deepseek/deepseek-v3.2');
    });

    it('returns the model id as-is when it contains no slash', () => {
      expect(mapModelIdToVercel('some-model-without-slash')).toBe('some-model-without-slash');
    });
  });

  describe('kilo-exclusive models', () => {
    it('maps a Vercel-exclusive model to its internal id', () => {
      expect(mapModelIdToVercel('meta/muse-spark-1.1')).toBe('meta/muse-spark-1.1');
    });

    it('maps an exclusive flagged with vercel-routing to its internal id', () => {
      // google/gemma-4-26b-a4b-it:free is registered in kiloExclusiveModels
      // with the 'vercel-routing' flag and internal_id 'google/gemma-4-26b-a4b-it'.
      expect(mapModelIdToVercel('google/gemma-4-26b-a4b-it:free')).toBe(
        'google/gemma-4-26b-a4b-it'
      );
    });

    it('does not use internal_id for exclusives that are not vercel-routed', () => {
      // claude_sonnet_clawsetup_model has gateway 'openrouter' and no
      // 'vercel-routing' flag, so the mapping must pass the public id through
      // the generic prefix rewrite instead of substituting internal_id.
      expect(mapModelIdToVercel('anthropic/claude-sonnet-4.6:clawsetup')).toBe(
        'anthropic/claude-sonnet-4.6:clawsetup'
      );
    });

    it('does not use internal_id for disabled exclusives even when vercel-routed', () => {
      // minimax_m25_free_model has the 'vercel-routing' flag but status
      // 'disabled', so it must not be substituted by internal_id and instead
      // pass the public id through the generic prefix rewrite.
      expect(mapModelIdToVercel('minimax/minimax-m2.5:free')).toBe('minimax/minimax-m2.5:free');
    });
  });
});
