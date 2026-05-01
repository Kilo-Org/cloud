import { describe, it, expect } from '@jest/globals';
import {
  CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { GEMINI_PRO_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/google';
import { KIMI_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { GPT_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

describe('mapModelIdToVercel', () => {
  describe('tilde-prefixed latest aliases', () => {
    it.each([
      ['~anthropic/claude-opus-latest', CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID],
      ['~anthropic/claude-sonnet-latest', CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID],
      ['~anthropic/claude-haiku-latest', CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID],
      ['~openai/gpt-latest', GPT_CURRENT_VERCEL_MODEL_ID],
      ['~moonshotai/kimi-latest', KIMI_CURRENT_VERCEL_MODEL_ID],
      ['~google/gemini-pro-latest', GEMINI_PRO_CURRENT_VERCEL_MODEL_ID],
    ])('maps %s to the current Vercel model id', (input, expected) => {
      expect(mapModelIdToVercel(input, false)).toBe(expected);
    });

    it('does not map a latest alias that is missing the leading tilde', () => {
      expect(mapModelIdToVercel('anthropic/claude-opus-latest', false)).toBe(
        'anthropic/claude-opus-latest'
      );
    });
  });

  describe('hardcoded OpenRouter → Vercel mapping', () => {
    it.each([
      ['arcee-ai/trinity-large-preview:free', 'arcee-ai/trinity-large-preview'],
      ['mistralai/codestral-2508', 'mistral/codestral'],
      ['mistralai/devstral-2512', 'mistral/devstral-2'],
      ['mistralai/mistral-embed-2312', 'mistral/mistral-embed'],
      ['mistralai/codestral-embed-2505', 'mistral/codestral-embed'],
      ['mistralai/ministral-14b-2512', 'mistral/ministral-14b'],
      ['mistralai/ministral-3b-2512', 'mistral/ministral-3b'],
      ['mistralai/ministral-8b-2512', 'mistral/ministral-8b'],
      ['mistralai/mistral-large-2512', 'mistral/mistral-large-3'],
      ['mistralai/mistral-medium-3', 'mistral/mistral-medium'],
      ['mistralai/mistral-medium-3.1', 'mistral/mistral-medium'],
      ['mistralai/mistral-small-2603', 'mistral/mistral-small'],
      ['mistralai/pixtral-large-2411', 'mistral/pixtral-large'],
      ['qwen/qwen3-14b', 'alibaba/qwen-3-14b'],
      ['qwen/qwen3-235b-a22b', 'alibaba/qwen-3-235b'],
      ['qwen/qwen3-30b-a3b', 'alibaba/qwen-3-30b'],
      ['qwen/qwen3-32b', 'alibaba/qwen-3-32b'],
    ])('maps %s to %s', (input, expected) => {
      expect(mapModelIdToVercel(input, false)).toBe(expected);
    });
  });

  describe('grok reasoning/non-reasoning toggle', () => {
    it.each([
      ['x-ai/grok-4-fast', 'xai/grok-4-fast-reasoning'],
      ['x-ai/grok-4.1-fast', 'xai/grok-4.1-fast-reasoning'],
      ['x-ai/grok-4.20-beta', 'xai/grok-4.20-reasoning'],
    ])('maps %s to %s when reasoning is not explicitly disabled', (input, expected) => {
      expect(mapModelIdToVercel(input, false)).toBe(expected);
    });

    it.each([
      ['x-ai/grok-4-fast', 'xai/grok-4-fast-non-reasoning'],
      ['x-ai/grok-4.1-fast', 'xai/grok-4.1-fast-non-reasoning'],
      ['x-ai/grok-4.20-beta', 'xai/grok-4.20-non-reasoning'],
    ])('maps %s to %s when reasoning is explicitly disabled', (input, expected) => {
      expect(mapModelIdToVercel(input, true)).toBe(expected);
    });

    it('does not rewrite a mapped target that does not end with -reasoning', () => {
      expect(mapModelIdToVercel('mistralai/codestral-2508', true)).toBe('mistral/codestral');
    });
  });

  describe('first-party inference provider inference', () => {
    it('rewrites the anthropic/ prefix unchanged', () => {
      expect(mapModelIdToVercel('anthropic/claude-sonnet-4.5', false)).toBe(
        'anthropic/claude-sonnet-4.5'
      );
    });

    it('rewrites the mistralai/ prefix to mistral/', () => {
      // not covered by the hardcoded mapping
      expect(mapModelIdToVercel('mistralai/some-new-model', false)).toBe('mistral/some-new-model');
    });

    it('rewrites the qwen/ prefix to alibaba/', () => {
      expect(mapModelIdToVercel('qwen/some-new-qwen-model', false)).toBe(
        'alibaba/some-new-qwen-model'
      );
    });

    it('rewrites x-ai/ to xai/', () => {
      expect(mapModelIdToVercel('x-ai/some-new-grok', false)).toBe('xai/some-new-grok');
    });

    it('rewrites z-ai/ to zai/', () => {
      expect(mapModelIdToVercel('z-ai/glm-5.1', false)).toBe('zai/glm-5.1');
    });

    it('leaves gpt-oss models unchanged', () => {
      expect(mapModelIdToVercel('openai/gpt-oss-20b', false)).toBe('openai/gpt-oss-20b');
    });

    it('leaves a model with an unknown provider prefix unchanged', () => {
      expect(mapModelIdToVercel('deepseek/deepseek-v3.2', false)).toBe('deepseek/deepseek-v3.2');
    });

    it('returns the model id as-is when it contains no slash', () => {
      expect(mapModelIdToVercel('some-model-without-slash', false)).toBe(
        'some-model-without-slash'
      );
    });
  });

  describe('kilo-exclusive models', () => {
    it('maps a hidden openrouter-gateway exclusive to its internal id', () => {
      // google/gemma-4-26b-a4b-it:free is registered in kiloExclusiveModels
      // with gateway 'openrouter' and internal_id 'google/gemma-4-26b-a4b-it'.
      expect(mapModelIdToVercel('google/gemma-4-26b-a4b-it:free', false)).toBe(
        'google/gemma-4-26b-a4b-it'
      );
    });

    it('does not use internal_id for exclusives that are not routed via openrouter', () => {
      // x-ai/grok-code-fast-1:optimized:free has gateway 'martian',
      // so the mapping should pass the public id through the prefix rewrite.
      expect(mapModelIdToVercel('x-ai/grok-code-fast-1:optimized:free', false)).toBe(
        'xai/grok-code-fast-1:optimized:free'
      );
    });
  });
});
